// robots.txt parser + matcher — RFC 9309 with Google's documented interpretation (R-A2-1, R-1.1-2/3).
//  - one group per agent: the most specific matching user-agent token; same-token groups merged (E-1.1-5)
//  - user-agent and field names case-insensitive; paths case-sensitive (E-1.1-11)
//  - longest match wins; on equal length, the least restrictive (Allow) wins
//  - * wildcard, $ end anchor; only user-agent/allow/disallow/sitemap are acted on
//  - bytes beyond th.robots_max_bytes ignored; BOM stripped; invalid lines ignored, never fatal

const SUPPORTED = new Set(['user-agent', 'allow', 'disallow', 'sitemap']);
const UNSUPPORTED_BY_GOOGLE = new Set(['crawl-delay', 'noindex', 'nofollow', 'host', 'clean-param', 'request-rate', 'visit-time']);

export function parseRobots(buffer, { maxBytes = 512000 } = {}) {
  let buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''), 'utf8');
  const oversize = buf.length > maxBytes;
  if (oversize) buf = buf.subarray(0, maxBytes);
  let hadBom = false;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    buf = buf.subarray(3);
    hadBom = true;
  }
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const encodingIssue = decoded.includes('�'); // E-1.1-7 ROBOTS_ENCODING

  const lines = decoded.split(/\r\n|\r|\n/);
  const groups = []; // { agents: [], rules: [], unsupported: [], content_signals: [], line_no }
  const sitemaps = [];
  const comments = [];
  const lineClasses = [];
  let current = null;
  let lastWasAgent = false;

  lines.forEach((rawLine, idx) => {
    const line_no = idx + 1;
    const hashAt = rawLine.indexOf('#');
    if (hashAt !== -1) comments.push({ line_no, text: rawLine.slice(hashAt + 1).trim() });
    const line = (hashAt === -1 ? rawLine : rawLine.slice(0, hashAt)).trim();
    if (!line) return;
    const colon = line.indexOf(':');
    if (colon <= 0) {
      lineClasses.push({ line_no, raw: rawLine, class: 'IGNORED_MALFORMED' });
      lastWasAgent = false;
      return;
    }
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], unsupported: [], content_signals: [], line_no };
        groups.push(current);
      }
      current.agents.push(value);
      lastWasAgent = true;
      lineClasses.push({ line_no, raw: rawLine, class: 'VALID', field });
      return;
    }
    lastWasAgent = false;

    if (field === 'sitemap') {
      sitemaps.push({ value, line_no }); // file-level, any position (R-A2-5)
      lineClasses.push({ line_no, raw: rawLine, class: 'VALID', field });
      return;
    }
    if (field === 'allow' || field === 'disallow') {
      if (!current) {
        lineClasses.push({ line_no, raw: rawLine, class: 'IGNORED_MALFORMED', note: 'rule before any user-agent' });
        return;
      }
      current.rules.push({ type: field, path: value, line_no });
      lineClasses.push({ line_no, raw: rawLine, class: 'VALID', field });
      return;
    }
    if (field === 'content-signal') {
      const signals = {};
      for (const part of value.split(',')) {
        const [k, v] = part.split('=').map((s) => (s || '').trim().toLowerCase());
        if (k) signals[k] = v;
      }
      (current ? current.content_signals : (groups.__fileSignals ||= [])).push({ line_no, raw: value, signals });
      lineClasses.push({ line_no, raw: rawLine, class: 'VALID', field, note: 'Content-Signal declaration (advisory)' });
      return;
    }
    if (UNSUPPORTED_BY_GOOGLE.has(field)) {
      if (current) current.unsupported.push({ field, value, line_no });
      lineClasses.push({ line_no, raw: rawLine, class: 'UNSUPPORTED_BY_GOOGLE', field });
      return;
    }
    lineClasses.push({ line_no, raw: rawLine, class: 'IGNORED_UNKNOWN_FIELD', field });
  });

  // Merge groups declaring the same token (E-1.1-5). A token maps to the union of its groups' rules.
  const byToken = new Map();
  for (const g of groups) {
    for (const a of g.agents) {
      const token = agentToken(a);
      if (!token) continue;
      if (!byToken.has(token)) byToken.set(token, { token, rules: [], unsupported: [], content_signals: [], line_nos: [] });
      const t = byToken.get(token);
      t.rules.push(...g.rules);
      t.unsupported.push(...g.unsupported);
      t.content_signals.push(...g.content_signals);
      t.line_nos.push(g.line_no);
    }
  }

  return {
    groups,
    byToken,
    sitemaps,
    comments,
    lineClasses,
    fileContentSignals: groups.__fileSignals || [],
    oversize,
    hadBom,
    encodingIssue,
    bytes: buffer?.length ?? 0,
    validGroupCount: groups.filter((g) => g.agents.length).length,
  };
}

/** Normalise a user-agent line value to its product token (case-insensitive). */
export function agentToken(v) {
  const t = String(v || '').trim().toLowerCase();
  if (!t) return null;
  if (t === '*') return '*';
  const m = /^[a-z0-9_-]+/.exec(t);
  return m ? m[0] : null;
}

/**
 * Select the single effective group for an agent (R-A2-1): the most specific token that
 * matches the agent name. Falls back to '*'. Returns null when no group applies (E-A2-4).
 */
export function selectGroup(parsed, agentName) {
  const name = String(agentName).toLowerCase();
  let best = null;
  for (const [token, g] of parsed.byToken) {
    if (token === '*') continue;
    if (name === token || name.startsWith(token + '-')) {
      // Longest (most specific) matching token wins. An exact match always beats a prefix.
      const score = name === token ? 10000 + token.length : token.length;
      if (!best || score > best.score) best = { score, group: g };
    }
  }
  if (best) return best.group;
  return parsed.byToken.get('*') || null;
}

function patternToRegex(pattern) {
  let p = encodePattern(pattern);
  const anchored = p.endsWith('$');
  if (anchored) p = p.slice(0, -1);
  const re = p
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + re + (anchored ? '$' : ''));
}

// Percent-encode characters in a pattern the same way a URL path would carry them.
function encodePattern(p) {
  return p.replace(/[^\x21-\x7e]/g, (c) => encodeURIComponent(c)).replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
}

/**
 * Evaluate a path(+query) for an agent.
 * Returns { verdict: 'ALLOWED'|'DISALLOWED', explicit: 'ALLOW'|'DISALLOW'|null, rule, token }.
 * explicit=null means NO_RULE (allowed by absence — R-5.1-2 three-state distinction).
 */
export function evaluate(parsed, agentName, pathAndQuery) {
  if (!parsed) return { verdict: 'ALLOWED', explicit: null, rule: null, token: null };
  const path = pathAndQuery || '/';
  if (path === '/robots.txt') return { verdict: 'ALLOWED', explicit: null, rule: null, token: null, note: 'robots.txt always allowed' };
  const group = selectGroup(parsed, agentName);
  if (!group) return { verdict: 'ALLOWED', explicit: null, rule: null, token: null };
  let best = null;
  for (const r of group.rules) {
    if (r.path === '') continue; // E-A2-2 empty Disallow = allow everything (no-op)
    const re = patternToRegex(r.path);
    if (!re.test(path)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.type === 'allow' && best.rule.type === 'disallow')) {
      best = { len, rule: r };
    }
  }
  if (!best) return { verdict: 'ALLOWED', explicit: null, rule: null, token: group.token };
  return {
    verdict: best.rule.type === 'allow' ? 'ALLOWED' : 'DISALLOWED',
    explicit: best.rule.type === 'allow' ? 'ALLOW' : 'DISALLOW',
    rule: best.rule,
    token: group.token,
  };
}

/** Tolerant scan for unparseable bodies (B-1.1-3): feeds discovery and C-1.2 only, never upgrades status. */
export function tolerantScan(text) {
  const sitemaps = [];
  const disallows = [];
  for (const m of String(text).matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)) sitemaps.push({ value: m[1] });
  for (const m of String(text).matchAll(/^\s*disallow\s*:\s*(\S*)/gim)) disallows.push(m[1]);
  return { sitemaps, disallows };
}

export function disallowPrefixes(parsed) {
  const out = new Set();
  for (const g of parsed.byToken.values()) {
    for (const r of g.rules) if (r.type === 'disallow' && r.path) out.add(r.path.split('*')[0].replace(/\$$/, ''));
  }
  return [...out].filter(Boolean).sort();
}
