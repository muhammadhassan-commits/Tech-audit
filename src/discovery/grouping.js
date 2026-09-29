// A.3 — URL pattern grouping. Pure and deterministic (F-A3-1): the same URL list always yields
// the same signatures. No fuzzy merging (R-A3-8).

// ISO 639-1 language codes (R-A3-1 LOCALE classification).
export const ISO639_1 = new Set(
  ('aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu').split(' '),
);

// Page-type lexicon (R-A4-2) — root slugs matching it stay individually addressable (E-A3-1).
export const PAGE_TYPE_LEXICON = new Set([
  'pricing', 'plans', 'packages', 'subscribe', 'about', 'about-us', 'who-we-are', 'company', 'our-story', 'brand-story',
  'author', 'authors', 'team', 'people', 'contributor', 'contributors', 'blog', 'news', 'insights', 'resources', 'articles',
  'product', 'products', 'item', 'p', 'service', 'services', 'solutions', 'what-we-do', 'features', 'platform', 'use-cases', 'contact', 'contact-us',
]);

const RE_NUMERIC = /^[0-9]+$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RE_HASH = /^[0-9a-f]{8,}$/i;
const RE_YEAR = /^(19|20)[0-9]{2}$/;
const RE_MONTH = /^(0?[1-9]|1[0-2])$/;
const RE_DAY = /^(0?[1-9]|[12][0-9]|3[01])$/;
const RE_LOCALE = /^[a-z]{2}(-[a-z]{2})?$/i;

export function classifySegment(seg, i, prev) {
  if (RE_UUID.test(seg)) return 'UUID';
  if (prev === 'YEAR' && (RE_MONTH.test(seg) || RE_DAY.test(seg))) return 'DATE';
  if (prev === 'DATE' && RE_DAY.test(seg)) return 'DATE';
  if (RE_YEAR.test(seg)) return 'YEAR'; // a 4-digit year is NUMERIC for replacement purposes
  if (RE_NUMERIC.test(seg)) return 'NUMERIC';
  if (RE_HASH.test(seg)) return 'HASH';
  if (i === 0 && RE_LOCALE.test(seg) && ISO639_1.has(seg.slice(0, 2).toLowerCase())) return 'LOCALE';
  return 'SLUG';
}

function splitExt(seg) {
  const m = /^(.*?)(\.[a-z0-9]{1,5})$/i.exec(seg);
  return m && m[1] ? { stem: m[1], ext: m[2] } : { stem: seg, ext: '' };
}

function pathSegments(url) {
  const u = new URL(url);
  const p = u.pathname.replace(/^\/+|\/+$/g, '');
  return p ? p.split('/') : [];
}

/**
 * Compute signatures for a URL list. Returns Map(url → { signature, depth, locale, segments }).
 */
export function computeSignatures(urls, { slugCollapseMin = 2 } = {}) {
  const sorted = [...new Set(urls)].sort();
  const pre = [];
  for (const url of sorted) {
    const segs = pathSegments(url);
    let prevClass = null;
    const classes = segs.map((s, i) => {
      const c = classifySegment(decodeURIComponent(safe(s)), i, prevClass);
      prevClass = c;
      return c;
    });
    const tokens = segs.map((s, i) => {
      const c = classes[i];
      if (['NUMERIC', 'UUID', 'HASH', 'DATE', 'YEAR', 'LOCALE'].includes(c)) {
        const { ext } = splitExt(s);
        return `*${c === 'LOCALE' ? '' : ext}`;
      }
      return s;
    });
    pre.push({ url, segs, classes, tokens, locale: classes[0] === 'LOCALE' ? segs[0].toLowerCase() : null });
  }
  // Step 4: count distinct final-slug values per parent prefix.
  const distinct = new Map();
  for (const p of pre) {
    if (!p.segs.length) continue;
    const last = p.segs.length - 1;
    if (p.classes[last] !== 'SLUG') continue;
    const prefix = p.tokens.slice(0, last).join('/');
    if (!distinct.has(prefix)) distinct.set(prefix, new Set());
    distinct.get(prefix).add(p.segs[last]);
  }
  const out = new Map();
  for (const p of pre) {
    const tokens = [...p.tokens];
    const last = p.segs.length - 1;
    if (last >= 0 && p.classes[last] === 'SLUG') {
      const prefix = tokens.slice(0, last).join('/');
      const isRoot = last === 0 || (last === 1 && p.classes[0] === 'LOCALE');
      const exempt = isRoot && PAGE_TYPE_LEXICON.has(p.segs[last].toLowerCase()); // E-A3-1
      // A final slug that follows an identifier segment is the label half of an ID-bearing URL
      // (/product/12345/red-shoe → /product/*/*, the checklist's own worked example), so it
      // collapses without waiting for a second observed value. Every other final slug follows
      // R-A3-1 step 4: collapse only once the parent prefix has ≥ slug_collapse_min distinct values.
      const afterIdentifier = last > 0 && ['NUMERIC', 'UUID', 'HASH', 'DATE', 'YEAR'].includes(p.classes[last - 1]);
      if (!exempt && (afterIdentifier || (distinct.get(prefix)?.size || 0) >= slugCollapseMin)) {
        tokens[last] = `*${splitExt(p.segs[last]).ext}`; // R-A3-3 extensions preserved
      }
    }
    out.set(p.url, { signature: '/' + tokens.join('/'), depth: p.segs.length, locale: p.locale, segments: p.segs });
  }
  return out;
}

function safe(s) {
  try {
    decodeURIComponent(s);
    return s;
  } catch {
    return s.replace(/%/g, '%25');
  }
}

/**
 * Build groups from discovered URL records [{ url, discovery_method, has_query }].
 * Applies the saturation cap (R-A3-6) — members beyond the cap are counted, not stored for fetching.
 */
export function buildGroups(records, cfg) {
  const sigs = computeSignatures(records.map((r) => r.url), { slugCollapseMin: cfg.group.slug_collapse_min });
  const groups = new Map();
  const sortedRecords = [...records].sort((a, b) => a.url.localeCompare(b.url));
  for (const r of sortedRecords) {
    const s = sigs.get(r.url);
    if (!s) continue;
    let g = groups.get(s.signature);
    if (!g) {
      g = {
        signature: s.signature,
        member_count: 0,
        true_member_count: 0,
        members: [],
        depth: s.depth,
        first_seen_at: r.first_seen_at || null,
        example_url: r.url,
        discovery_methods: new Set(),
        locale_variants: new Set(),
        query_members: 0,
        saturated: false,
      };
      groups.set(s.signature, g);
    }
    g.true_member_count++;
    g.member_count = Math.min(g.true_member_count, cfg.group.saturation_cap);
    if (g.members.length < 50) g.members.push(r.url); // R-A3-5 stored cap 50
    g.discovery_methods.add(r.discovery_method || 'homepage_link');
    if (s.locale) g.locale_variants.add(s.locale);
    if (r.has_query) g.query_members++;
    g.depth = Math.min(g.depth, s.depth);
    if (g.true_member_count >= cfg.group.saturation_cap) g.saturated = true;
  }
  const flags = [];
  let list = [...groups.values()].map((g) => ({
    ...g,
    discovery_methods: [...g.discovery_methods].sort(),
    locale_variants: [...g.locale_variants].sort(),
    query_driven: g.true_member_count > 0 && g.query_members / g.true_member_count > 0.6, // R-A3-2
  }));
  if (list.length > cfg.group.max_groups) {
    // C-A3-c: keep the 200 with the highest member_count, then shallowest depth.
    list.sort((a, b) => b.true_member_count - a.true_member_count || a.depth - b.depth || a.signature.localeCompare(b.signature));
    list = list.slice(0, cfg.group.max_groups);
    flags.push('GROUP_EXPLOSION');
  }
  const total = list.reduce((a, g) => a + g.true_member_count, 0);
  if (list.some((g) => total > 0 && g.true_member_count / total > 0.8) && list.length > 1) flags.push('GROUP_DOMINANCE');
  if (list.some((g) => g.query_driven)) flags.push('QUERY_DRIVEN_GROUP');
  return { groups: list, signatures: sigs, flags };
}

/** B-A3-3 — depth-based grouping fallback when signatures do not collapse at all. */
export function depthGroups(records) {
  const groups = new Map();
  for (const r of [...records].sort((a, b) => a.url.localeCompare(b.url))) {
    const d = pathSegments(r.url).length;
    const sig = `depth:${d}`;
    if (!groups.has(sig)) groups.set(sig, { signature: sig, member_count: 0, true_member_count: 0, members: [], depth: d, example_url: r.url, discovery_methods: [], locale_variants: [], saturated: false });
    const g = groups.get(sig);
    g.true_member_count++;
    g.member_count = g.true_member_count;
    if (g.members.length < 50) g.members.push(r.url);
  }
  return [...groups.values()];
}
