// JSON-LD extraction and graph handling (R-3.1-2/3/4/12/13, B-3.1-1).

/** Strict parse; on failure a lenient repair is attempted and the fault is named (B-3.1-1). */
export function parseBlock(raw) {
  const text = String(raw || '').trim().replace(/^<!--|-->$/g, '').trim();
  if (!text) return { ok: false, empty: true, error: 'EMPTY_BLOCK' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    const faults = [];
    let t = text;
    const steps = [
      ['trailing commas', (s) => s.replace(/,\s*([}\]])/g, '$1')],
      ['unescaped newlines in strings', (s) => s.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/gs, (m) => m.replace(/\r?\n/g, '\\n'))],
      ['HTML entities', (s) => s.replace(/&quot;/g, '\\"').replace(/&amp;/g, '&').replace(/&#39;/g, "'")],
      ['single quotes', (s) => s.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner) => `"${inner.replace(/"/g, '\\"')}"`)],
      ['comments', (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')],
    ];
    for (const [name, fn] of steps) {
      const next = fn(t);
      if (next !== t) {
        faults.push(name);
        t = next;
        try {
          return { ok: false, lenient: true, value: JSON.parse(t), error: e.message, faults };
        } catch {
          /* continue repairing */
        }
      }
    }
    return { ok: false, lenient: false, error: e.message, faults };
  }
}

function asArray(v) {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

export function typesOf(node) {
  return asArray(node?.['@type']).map((t) => String(t).replace(/^https?:\/\/schema\.org\//, ''));
}

/** Flatten @graph / top-level arrays / nested nodes into a node list (R-3.1-3). */
export function flatten(values) {
  const nodes = [];
  const seen = new Set();
  const walk = (v, depth, parentKey) => {
    if (depth > 12 || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1, parentKey));
    if (seen.has(v)) return;
    seen.add(v);
    if (v['@graph']) walk(v['@graph'], depth + 1, '@graph');
    if (v['@type']) nodes.push({ node: v, nested: depth > 1 && parentKey !== '@graph', parentKey });
    for (const [k, val] of Object.entries(v)) {
      if (k === '@graph' || k === '@context') continue;
      if (val && typeof val === 'object') walk(val, depth + 1, k);
    }
  };
  for (const v of values) walk(v, 0, null);
  return nodes;
}

/**
 * Build the page graph from all parsed blocks.
 *
 * Nodes that share an @id are the same entity in JSON-LD, and a graph commonly splits one entity
 * across blocks — a full declaration in one place, an augmentation carrying a single extra property
 * in another. They are merged into one node here, so a required-field check sees the entity as a
 * publisher does rather than reporting fields as missing from a fragment that never carried them.
 */
export function buildGraph(blocks) {
  const values = blocks.filter((b) => b.value !== undefined).map((b) => b.value);
  const raw = flatten(values);
  const byId = new Map();
  for (const n of raw) {
    const id = n.node['@id'];
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(n);
  }
  const merged = new Map(); // @id → merged node object
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    // The most complete declaration wins on conflict; the others contribute only absent properties.
    const ordered = [...group].sort((a, b) => Object.keys(b.node).length - Object.keys(a.node).length);
    const target = { ...ordered[0].node };
    for (const other of ordered.slice(1)) {
      for (const [k, v] of Object.entries(other.node)) if (!(k in target)) target[k] = v;
    }
    merged.set(id, target);
  }
  const seenId = new Set();
  const nodes = [];
  for (const n of raw) {
    const id = n.node['@id'];
    if (id && merged.has(id)) {
      if (seenId.has(id)) continue; // the merged entity is emitted once
      seenId.add(id);
      // Keep the least-nested occurrence's position, since that is where the entity is declared.
      const shallowest = byId.get(id).reduce((a, x) => (a.nested && !x.nested ? x : a));
      nodes.push({ ...shallowest, node: merged.get(id), merged_from: byId.get(id).length });
      continue;
    }
    nodes.push(n);
  }
  const ids = new Map();
  for (const n of nodes) {
    const id = n.node['@id'];
    if (id) {
      if (!ids.has(id)) ids.set(id, []);
      ids.get(id).push(n.node);
    }
  }
  return { nodes, ids };
}

/** @id references used as property values must resolve within the page graph (R-3.1-4). */
export function danglingRefs(graph, fields = ['publisher', 'isPartOf', 'about', 'author', 'provider', 'brand', 'worksFor', 'breadcrumb', 'mainEntityOfPage', 'primaryImageOfPage', 'mainEntity']) {
  const out = [];
  for (const { node } of graph.nodes) {
    for (const f of fields) {
      for (const v of asArray(node[f])) {
        if (v && typeof v === 'object' && v['@id'] && Object.keys(v).length === 1) {
          if (!graph.ids.has(v['@id'])) out.push({ from: node['@id'] || typesOf(node).join('/'), field: f, ref: v['@id'] });
        }
      }
    }
  }
  return out;
}

/** Resolve a property path like "priceSpecification.price" on a node; `a|b` alternatives. */
export function hasField(node, spec) {
  return spec.split('|').some((alt) => {
    let cur = node;
    for (const part of alt.split('.')) {
      if (cur == null) return false;
      if (Array.isArray(cur)) cur = cur[0];
      cur = cur?.[part];
    }
    if (cur == null) return false;
    if (typeof cur === 'string') return cur.trim().length > 0;
    if (Array.isArray(cur)) return cur.length > 0;
    return true;
  });
}

/** schema.org property names are case-sensitive lowerCamel (R-3.1-12). */
export function invalidCasing(node) {
  const bad = [];
  for (const k of Object.keys(node)) {
    if (k.startsWith('@')) continue;
    if (/^[A-Z]/.test(k)) bad.push(k);
  }
  return bad;
}

const PLACEHOLDER_VALUE = /^(0{5}|0{3,}[-\s]?0*|x{3,}|lorem ipsum.*|todo|tbd|your[_ -].*|example\.com|https?:\/\/(www\.)?example\.(com|org)\S*|placeholder|n\/a|123-456-7890|\+?1?[-\s]?555[-\s]?\d{3,4}.*)$/i;

/** Placeholder values (R-3.1-13). */
export function placeholderValues(node, path = '') {
  const out = [];
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('@')) continue;
    if (typeof v === 'string') {
      if (PLACEHOLDER_VALUE.test(v.trim()) || /YOUR_|<REQUIRED/.test(v)) out.push({ field: path + k, value: v });
      if ((k === 'postalCode' && /^0+$/.test(v)) || (k === 'telephone' && /^0{3,}/.test(v.replace(/\D/g, '')))) out.push({ field: path + k, value: v });
    } else if (v && typeof v === 'object' && !Array.isArray(v) && !v['@type']) {
      out.push(...placeholderValues(v, `${path}${k}.`));
    }
  }
  return out;
}

export function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s.trim());
}

export { asArray };
