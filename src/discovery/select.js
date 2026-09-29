// A.4 — Page-type classification (R-A4-2) and coverage-first selection (R-A4-3), Min 1 / Max 10.
// Deterministic (F-A4-1): identical discovery input ⇒ byte-identical sample.
import { typesOf, buildGraph, parseBlock } from '../parse/jsonld.js';

export const SLATE = [
  'homepage', 'service_main', 'service_secondary', 'product_main', 'pricing',
  'category', 'blog_article', 'blog_template_alt', 'author', 'about',
];
const RANK = Object.fromEntries(SLATE.map((t, i) => [t, i + 1]));

const RE = {
  pricing: /(^|\/)(pricing|plans|packages|subscribe)(\/|$|[-_.])/i,
  about: /(^|\/)(about|about-us|who-we-are|company|our-story|brand-story)(\/|$)/i,
  author: /\/(author|authors|team|people|contributor|contributors)(\/|$)/i,
  blogPrefix: /^\/(blog|news|insights|resources|articles)\/[^/]+/i,
  product: /\/(product|products|item|p)\//i,
  service: /\/(service|services|solutions|what-we-do|features|platform|use-cases)(\/|$)/i,
  pricingLex: /\b(pricing|prices|plans?|packages)\b/i,
  aboutH1: /^(about|who we are|our story|our company|meet the team)/i,
  serviceLex: /\b(services?|solutions?|features?|platform|products?|what we do|use cases?)\b/i,
  currency: /(?:[$€£¥₹]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:USD|EUR|GBP|INR|AUD|CAD)\b)/g,
  addToCart: /add[\s-]to[\s-](cart|bag|basket)|buy now/i,
  sku: /\b(sku|variant|select size|choose (a )?size|colou?r:)/i,
  byline: /\b(by|written by|author:?)\s+[A-Z][a-z]+/,
  date: /\b(19|20)\d{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+(19|20)\d{2}\b/i,
};
// E-A4-8 — login-gated pages are not public retrieval surfaces. Infrastructure endpoints
// (/cdn-cgi/, /wp-json/, feeds) are excluded on the same basis: they are not pages a reader reaches.
export const GATED = /\/(dashboard|account|my-account|login|log-in|signin|sign-in|signup|sign-up|register|cart|checkout|admin|wp-admin|wp-login\.php|cdn-cgi|wp-json|wp-content|wp-includes|xmlrpc\.php|feed)(\/|$|\?)/i;

function jsonldTypes(facts) {
  if (!facts) return { types: new Set(), graph: null };
  const blocks = facts.jsonld.map((b) => parseBlock(b.raw)).filter((b) => b.value !== undefined);
  const graph = buildGraph(blocks);
  const types = new Set();
  for (const n of graph.nodes) typesOf(n.node).forEach((t) => types.add(t));
  return { types, graph };
}

/**
 * Evaluate classification signals for one candidate. Returns { qualifies: {type → signals}, alt }.
 * c = { url, path, signature, facts, nav_anchor, nav_index, groupsBySig, saturatedParents }
 */
export function classify(c, ctx) {
  const path = c.path;
  const f = c.facts;
  const { types, graph } = jsonldTypes(f);
  const h1 = f?.headings.find((h) => h.level === 1)?.text || '';
  const title = f?.titles[0]?.text || '';
  const text = f?.mainText || '';
  const q = {};
  const add = (type, tier, signal) => {
    (q[type] ||= { t1: [], t2: [] })[tier === 1 ? 't1' : 't2'].push(signal);
  };

  if (path === '/' || c.isHomepage) add('homepage', 1, 'path=/');

  // pricing
  if (RE.pricing.test(path)) add('pricing', 1, 'path lexeme');
  if (types.has('Offer') || types.has('AggregateOffer') || types.has('PriceSpecification') || types.has('UnitPriceSpecification')) add('pricing', 1, 'Offer/PriceSpecification JSON-LD');
  if ((text.match(RE.currency) || []).length >= 3) add('pricing', 1, '≥3 currency-formatted prices');
  if (RE.pricingLex.test(title) || RE.pricingLex.test(h1)) add('pricing', 2, 'title/H1 pricing lexeme');

  // about
  if (RE.about.test(path)) add('about', 1, 'path lexeme');
  if (types.has('AboutPage')) add('about', 1, 'AboutPage JSON-LD');
  if (RE.aboutH1.test(h1)) add('about', 2, 'H1 about lexeme');

  // author
  if (RE.author.test(path)) add('author', 1, 'path lexeme');
  if (types.has('ProfilePage') || (graph && graph.nodes.some((n) => !n.nested && typesOf(n.node).includes('Person') && !graph.nodes.some((m) => typesOf(m.node).some((t) => /Article|BlogPosting/.test(t)))))) add('author', 1, 'ProfilePage / standalone Person JSON-LD');

  // blog article
  if (['Article', 'BlogPosting', 'NewsArticle'].some((t) => types.has(t))) add('blog_article', 1, 'Article/BlogPosting/NewsArticle JSON-LD');
  if (String(f?.og?.['og:type'] || '').toLowerCase() === 'article') add('blog_article', 1, 'og:type=article');
  if (RE.blogPrefix.test(path) && !/\/(page|tag|category|author)\//i.test(path)) add('blog_article', 1, 'blog-prefix path with slug leaf');
  if (f && (RE.date.test(text.slice(0, 3000)) || f.timeEls.length) && (RE.byline.test(text.slice(0, 3000)) || f.og['article:author'])) add('blog_article', 2, 'visible date + byline');

  // category
  if (f) {
    const bySig = new Map();
    for (const l of f.links) {
      if (!l.resolved || !l.same_site) continue;
      const sig = ctx.signatureOf(l.resolved);
      if (!sig || sig === c.signature) continue;
      if (!bySig.has(sig)) bySig.set(sig, new Set());
      bySig.get(sig).add(l.resolved);
    }
    if ([...bySig.values()].some((s) => s.size >= 8)) add('category', 1, '≥8 links sharing one pattern_signature');
  }
  if (types.has('CollectionPage') || types.has('ItemList')) add('category', 1, 'CollectionPage/ItemList JSON-LD');
  if (ctx.saturatedParents?.has(path.replace(/\/$/, ''))) add('category', 2, 'parent prefix of a saturated group');
  if (f && f.links.some((l) => l.rel.includes('next') || /[?&/]page[=/]\d/.test(l.href || ''))) add('category', 2, 'pagination controls');

  // product
  const productNode = graph?.nodes.find((n) => typesOf(n.node).includes('Product') && n.node.offers);
  if (productNode) add('product_main', 1, 'Product JSON-LD with offers');
  if (RE.product.test(path)) add('product_main', 1, 'path lexeme');
  if (RE.addToCart.test(text)) add('product_main', 1, 'add-to-cart control');
  if (RE.sku.test(text)) add('product_main', 2, 'SKU/variant selector');

  // service
  if (RE.service.test(path)) add('service', 1, 'path lexeme');
  if (types.has('Service')) add('service', 1, 'Service JSON-LD');
  if (c.nav_anchor && RE.serviceLex.test(c.nav_anchor)) add('service', 2, 'primary-nav link with service-lexicon anchor');

  const qualifies = {};
  for (const [type, s] of Object.entries(q)) {
    const ok = type === 'homepage' ? s.t1.length >= 1 : s.t1.length >= 2 || (s.t1.length >= 1 && s.t2.length >= 1);
    if (ok) qualifies[type] = [...s.t1, ...s.t2];
  }
  return { qualifies, signals: q, types: [...types] };
}

/** R-A4-4 within-group score. */
export function scoreCandidate(c, groupMinDepth) {
  const b = {};
  if (c.depth === groupMinDepth) b.depth = 3;
  if (c.one_click) b.one_click = 2;
  if (c.schemaTypes?.some((t) => ['Article', 'BlogPosting', 'NewsArticle', 'Product', 'Service', 'Offer'].includes(t))) b.schema = 2;
  if (c.longestText) b.text = 1;
  if (c.robots_googlebot === 'DISALLOWED') b.robots_blocked = -5;
  if (c.status != null && (c.status < 200 || c.status >= 300)) b.non_2xx = -4;
  if (c.noindex_raw) b.noindex = -3;
  if (c.canonical_cross) b.canonicalised = -2;
  return { total: Object.values(b).reduce((a, v) => a + v, 0), breakdown: b };
}

/**
 * Coverage-first selection. `groups` = [{ signature, member_count, true_member_count, depth, candidates: [c] }]
 * Each candidate c: { url, depth, one_click, facts, status, robots_googlebot, noindex_raw, canonical_cross,
 *   classification, discovery_method, nav_index }
 */
export function selectPages({ homepage, groups, operatorPages = [], cap = 10 }) {
  const selected = [];
  const filled = new Set();
  const used = new Set();
  const groupUsed = new Map();
  const excluded = { robots_blocked: [], non_2xx: [], off_origin: [], gated: [] };

  const take = (c, type, reason, group) => {
    selected.push({
      url: c.url,
      page_type: type,
      alt_types: Object.keys(c.classification?.qualifies || {}).filter((t) => normType(t) !== type && t !== 'service'),
      pattern_signature: group?.signature ?? c.signature,
      group_member_count: group?.true_member_count ?? 1,
      discovery_method: c.discovery_method,
      selection_reason: reason,
      score_breakdown: c.score?.breakdown || {},
      classification_signals: c.classification?.qualifies?.[type === 'service_main' || type === 'service_secondary' ? 'service' : type] || [],
      flags: [],
    });
    used.add(c.url);
    if (type !== 'other') filled.add(type);
    if (group) groupUsed.set(group.signature, (groupUsed.get(group.signature) || 0) + 1);
  };

  // 1. Homepage — always included when reachable, never substituted.
  if (homepage && isSelectable(homepage)) take(homepage, 'homepage', 'homepage (rank 1, always included)', homepage.group);

  // Operator-supplied URLs (E-A4-9) — honoured verbatim, bypass scoring, still classified, obey the cap.
  for (const c of operatorPages) {
    if (selected.length >= cap) break;
    if (used.has(c.url)) continue;
    const t = bestUnfilledType(c, filled, null) || 'other';
    take(c, t, 'operator supplied (E-A4-9)', null);
  }

  // Prepare candidates per group (selectable only — R-A4-5).
  const ordered = [...groups].sort((a, b) => b.true_member_count - a.true_member_count || a.depth - b.depth || a.signature.localeCompare(b.signature));
  for (const g of ordered) {
    const minDepth = Math.min(...g.candidates.map((c) => c.depth));
    const longest = Math.max(0, ...g.candidates.map((c) => c.facts?.mainText.length || 0));
    for (const c of g.candidates) {
      c.longestText = longest > 0 && (c.facts?.mainText.length || 0) === longest;
      c.schemaTypes = c.classification?.types || [];
      c.score = scoreCandidate(c, minDepth);
    }
    g.selectable = g.candidates
      .filter((c) => {
        if (GATED.test(new URL(c.url).pathname)) return excluded.gated.push(c.url), false;
        if (c.robots_googlebot === 'DISALLOWED') return excluded.robots_blocked.push(c.url), false;
        if (c.status != null && (c.status < 200 || c.status >= 300)) return excluded.non_2xx.push(c.url), false;
        return true;
      })
      .sort((a, b) => b.score.total - a.score.total || a.url.localeCompare(b.url));
  }

  // Service ranking by primary-nav position (R-A4-2): first = service_main, second = service_secondary.
  const serviceCands = ordered
    .flatMap((g) => g.selectable.map((c) => ({ c, g })))
    .filter(({ c }) => c.classification?.qualifies?.service)
    .sort((a, b) => (a.c.nav_index ?? 9999) - (b.c.nav_index ?? 9999) || a.c.url.localeCompare(b.c.url));
  const serviceMainUrl = serviceCands[0]?.c.url;
  const serviceMainGroup = serviceCands[0]?.g.signature;
  const serviceSecondary = serviceCands.find(({ g }) => g.signature !== serviceMainGroup) || serviceCands[1];
  const serviceSecondaryUrl = serviceSecondary?.c.url;

  const typeFor = (c, g) => {
    const q = c.classification?.qualifies || {};
    const opts = [];
    for (const t of SLATE) {
      if (filled.has(t)) continue;
      if (t === 'homepage') continue;
      if (t === 'service_main' && q.service && c.url === serviceMainUrl) opts.push(t);
      else if (t === 'service_secondary' && q.service && c.url === serviceSecondaryUrl && filled.has('service_main')) opts.push(t);
      else if (t === 'blog_template_alt' && q.blog_article && filled.has('blog_article') && !selected.some((s) => s.page_type === 'blog_article' && s.pattern_signature === g.signature)) opts.push(t);
      else if (t !== 'service_main' && t !== 'service_secondary' && t !== 'blog_template_alt' && q[t]) opts.push(t);
    }
    return opts[0] || null;
  };

  // 2a. One page per group, preferring candidates that fill an unfilled slate slot.
  for (const g of ordered) {
    if (selected.length >= cap) break;
    if (groupUsed.get(g.signature)) continue;
    let pick = null;
    let type = null;
    for (const c of g.selectable) {
      if (used.has(c.url)) continue;
      const t = typeFor(c, g);
      if (t) {
        pick = c;
        type = t;
        break;
      }
    }
    if (pick) take(pick, type, `best-scoring qualifying candidate in group; fills rank-${RANK[type]} slot (${type})`, g);
  }
  // 2b. Remaining groups contribute one page each (type 'other' when no slot fits) until the cap.
  for (const g of ordered) {
    if (selected.length >= cap) break;
    if (groupUsed.get(g.signature)) continue;
    const c = g.selectable.find((x) => !used.has(x.url));
    if (!c) continue;
    const t = typeFor(c, g) || 'other';
    take(c, t, t === 'other' ? 'one page per group (coverage-first); qualifies for no unfilled slate type' : `fills rank-${RANK[t]} slot`, g);
  }
  // 3. Every group has contributed once — second picks from the largest groups, unfilled types only.
  if (selected.length < cap) {
    for (const g of ordered) {
      if (selected.length >= cap) break;
      for (const c of g.selectable) {
        if (selected.length >= cap) break;
        if (used.has(c.url)) continue;
        const t = typeFor(c, g);
        if (!t) continue;
        if (t === 'blog_template_alt') continue; // E-A4-4: never a second post of the same template
        take(c, t, `second pick after all groups covered (R-A4-3 step 3); fills ${t}`, g);
      }
    }
  }

  // R-A4-8 — the reason is per type: CAP_REACHED only where a qualifying candidate existed but no
  // slot remained. An absent type is not a site failure by itself.
  const qualifyingFor = (t) => {
    const key = t.startsWith('service') ? 'service' : t === 'blog_template_alt' ? 'blog_article' : t;
    return ordered.some((g) => (g.selectable || []).some((c) => c.classification?.qualifies?.[key]));
  };
  const page_type_absent = SLATE.filter((t) => !filled.has(t)).map((t) => {
    const hadCandidate = qualifyingFor(t);
    return {
      page_type: t,
      reason: hadCandidate && selected.length >= cap ? 'CAP_REACHED' : 'NO_QUALIFYING_CANDIDATE',
      note: hadCandidate ? null : 'No discovered page met the evidence bar for this type (R-A4-2). A short sample is preferable to a mislabelled one (B-A4-2).',
    };
  });
  return { selected: selected.slice(0, cap), page_type_absent, excluded };
}

function normType(t) {
  return t === 'service' ? 'service_main' : t;
}

function isSelectable(c) {
  if (c.robots_googlebot === 'DISALLOWED') return false;
  if (c.status != null && (c.status < 200 || c.status >= 300)) return false;
  return true;
}

function bestUnfilledType(c, filled) {
  const q = c.classification?.qualifies || {};
  for (const t of SLATE) {
    if (filled.has(t)) continue;
    const key = t.startsWith('service') ? 'service' : t === 'blog_template_alt' ? null : t;
    if (key && q[key]) return t;
  }
  return null;
}

export function sampleQuality(selected) {
  const n = selected.length;
  const types = new Set(selected.map((s) => s.page_type).filter((t) => t !== 'other'));
  if (n === 0) return 'NONE';
  if (n === 1) return 'SINGLE';
  if (n <= 3) return 'MINIMAL';
  if (n >= 10 && types.size >= 6) return 'FULL';
  return 'PARTIAL';
}
