// Site-name detection and brand-suffix normalisation shared by C-2.1 / C-2.3 / C-6.2 (R-2.1-4, B-2.1-4).
import { parseBlock, buildGraph, typesOf } from '../parse/jsonld.js';
import { collapse, decodeEntities } from '../parse/text.js';

const DELIMS = /\s+[|\-–—·:]\s+/;

export function detectSiteName(ctx) {
  if (ctx.derived.siteName !== undefined) return ctx.derived.siteName;
  const hp = ctx.homepage?.rawFacts;
  let name = hp?.og?.['og:site_name'] || null;
  if (!name && hp) {
    const g = buildGraph(hp.jsonld.map((b) => parseBlock(b.raw)).filter((b) => b.value !== undefined));
    const ws = g.nodes.find((n) => typesOf(n.node).includes('WebSite'))?.node;
    name = ws?.name || null;
  }
  if (!name) {
    // B-2.1-4 — most common trailing fragment across sampled titles
    const counts = new Map();
    for (const p of ctx.pages) {
      const t = p.rawFacts?.titles[0]?.text;
      if (!t) continue;
      const parts = collapse(decodeEntities(t)).split(DELIMS);
      if (parts.length > 1) {
        const last = parts[parts.length - 1].trim();
        counts.set(last, (counts.get(last) || 0) + 1);
      }
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best && best[1] >= 2) name = best[0];
  }
  ctx.derived.siteName = name ? collapse(String(name)) : null;
  return ctx.derived.siteName;
}

export function normName(s) {
  return collapse(decodeEntities(String(s || '')))
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .trim();
}

/** Collapse whitespace, decode entities, strip a trailing brand suffix matching the site name. */
export function normaliseTitle(title, siteName) {
  let t = collapse(decodeEntities(String(title || '')));
  if (siteName) {
    const parts = t.split(DELIMS);
    if (parts.length > 1) {
      const last = parts[parts.length - 1];
      const first = parts[0];
      if (normName(last) === normName(siteName)) t = parts.slice(0, -1).join(' - ');
      else if (normName(first) === normName(siteName)) t = parts.slice(1).join(' - ');
    }
  }
  return t
    .replace(/\s*[-–—|]\s*page\s+\d+\s*$/i, '') // E-2.1-5 pagination suffix
    .toLowerCase()
    .trim();
}
