// Module A (P2) — link harvesting (A.1), robots intersection (A.2), grouping (A.3), selection (A.4).
import { extractFacts, hasClientRenderingSignature } from '../parse/html.js';
import { bodyText } from '../net/http.js';
import { normalizeUrl, pathOf, originOf, hostOf, isSameSite } from '../parse/url.js';
import { buildGroups, depthGroups, computeSignatures, ISO639_1 } from './grouping.js';
import { classify, selectPages, sampleQuality, SLATE, GATED } from './select.js';

const HTML_SITEMAP_PATHS = ['/sitemap', '/sitemap.html', '/site-map', '/sitemap-page'];
const COMMON_PATHS = ['/about', '/about-us', '/pricing', '/plans', '/blog', '/news', '/services', '/products', '/contact'];
const TYPE_PROBES = {
  pricing: ['/pricing', '/plans'],
  about: ['/about', '/about-us'],
  blog_article: ['/blog'],
  author: ['/authors', '/author', '/team'],
  service_main: ['/services', '/solutions'],
  product_main: ['/products', '/shop'],
};

function abort(code) {
  return Object.assign(new Error(code), { code, __abort: true });
}

/**
 * Fetch, classify and return operator-supplied URLs (E-A4-9): honoured verbatim, bypassing scoring.
 * Off-origin entries are recorded and skipped — the audit never leaves canonical_origin (F-A1-3).
 */
async function loadOperatorPages(ctx, disc, sigOf = () => null, saturatedParents = new Set()) {
  const { http, cfg } = ctx;
  const pages = [];
  for (const raw of cfg.operator_urls || []) {
    const u = normalizeUrl(String(raw).trim(), ctx.canonicalOrigin);
    if (!u) continue;
    if (!isSameSite(u, ctx.canonicalOrigin)) {
      disc.content_on_external_host.push(hostOf(u));
      continue;
    }
    if (pages.some((p) => p.url === u)) continue;
    const rec = await http.fetch(u, { budgetClass: 'primary', exempt: true });
    const f = extractFacts(bodyText(rec), rec.final_url, ctx.canonicalOrigin);
    pages.push({
      url: u,
      depth: depth(u),
      discovery_method: 'OPERATOR_SUPPLIED',
      status: rec.status,
      facts: f,
      robots_googlebot: ctx.robotsAllowed('googlebot', u).verdict,
      classification: classify({ url: u, path: new URL(u).pathname, facts: f, signature: sigOf(u) }, { signatureOf: sigOf, saturatedParents }),
    });
  }
  if (pages.length) disc.discovery_methods_used.add('OPERATOR_SUPPLIED');
  return pages;
}

export async function runDiscovery(ctx) {
  const { http, renderer, cfg } = ctx;
  const flags = ctx.flags;
  const disc = {
    links_harvested: 0,
    groups: [],
    robots_blocked_candidates: [],
    auditor_blocked_only: [],
    external_links: [],
    js_only_links: [],
    fetch_count: 0,
    unresponsive_urls: [],
    budget_class_applied: 'primary (sampled pages) / secondary (discovery)',
    caps_hit: [],
    discovery_methods_used: new Set(['homepage_link']),
    robots_declared_folders: ctx.derived.robotsDisallowFolders || [],
    gated_excluded: [],
    content_on_external_host: [],
  };
  ctx.discovery = disc;
  let fetches = 0;

  // ── Homepage acquisition (primary budget; RENDERED always for the homepage — R-FETCH-3a) ──
  ctx.emit('fetch', { url: ctx.homepageUrl, purpose: 'homepage RAW' });
  const hpRaw = await http.fetch(ctx.homepageUrl, { budgetClass: 'primary', exempt: ctx.cfg.operator_urls?.includes(ctx.homepageUrl) });
  const hpHtml = bodyText(hpRaw);
  let hpRen = null;
  if (hpRaw.terminal !== 'BLOCKED_BY_ROBOTS_FOR_AUDITOR' && hpRaw.elapsed_ms + cfg.render.budget_ms <= cfg.net.url_budget_ms) {
    ctx.emit('fetch', { url: ctx.homepageUrl, purpose: 'homepage RENDERED' });
    hpRen = await renderer.render(hpRaw.final_url || ctx.homepageUrl);
    if (hpRen.error && hpRaw.status >= 200 && hpRaw.status < 300) {
      // B-A0-3 — RENDERED fails but RAW succeeds: raw-only for this run.
      if (hpRen.error.code !== 'RENDER_UNAVAILABLE') flags.add('RENDER_FAILED_HOMEPAGE');
      cfg.cap.render_js = false;
    }
  }
  if (!hpHtml.trim() && (!hpRen || hpRen.error || !hpRen.html?.trim())) {
    if (hpRaw.status >= 200 && hpRaw.status < 300) throw abort('EMPTY_HOMEPAGE'); // F-A0-2
  }
  const hpFinal = hpRaw.final_url || ctx.homepageUrl;
  const rawFacts = extractFacts(hpHtml, hpFinal, ctx.canonicalOrigin);
  const renFacts = hpRen && !hpRen.error ? extractFacts(hpRen.html, hpRen.final_url || hpFinal, ctx.canonicalOrigin) : null;
  ctx.derived.homepageAcq = { raw: hpRaw, rendered: hpRen, rawFacts, renFacts, html: hpHtml };

  // E-A0-5 consent wall / E-A0-6 placeholder
  if (/consent|cookie/i.test(rawFacts.mainText.slice(0, 400)) && rawFacts.mainText.split(/\s+/).length < 80 && renFacts && renFacts.mainText.length > rawFacts.mainText.length * 3) flags.add('CONSENT_WALL_RAW');

  // ── Operator-only mode: audit exactly the URLs supplied, skipping discovery ──
  // When the operator names the pages, sampling has nothing to decide. Discovery is skipped, and
  // the homepage is included only if it was named.
  if (cfg.operator_urls_only && cfg.operator_urls?.length) {
    const pages = await loadOperatorPages(ctx, disc);
    if (!pages.length) throw abort('NO_SELECTABLE_PAGES');
    ctx.target.site_shape = 'multi_page';
    ctx.target.is_multilingual = false;
    disc.discovery_methods_used = [...disc.discovery_methods_used];
    disc.groups = [];
    disc.fetch_count = http.fetchCount;
    flags.add('OPERATOR_URLS_ONLY');
    const capped = pages.slice(0, 10);
    if (pages.length > 10) disc.caps_hit.push('OPERATOR_URLS_CAPPED');
    ctx.sample = {
      quality: sampleQuality(capped),
      pages: capped.map((p) => ({
        url: p.url,
        page_type: Object.keys(p.classification?.qualifies || {})[0]?.replace(/^service$/, 'service_main') || 'other',
        alt_types: Object.keys(p.classification?.qualifies || {}),
        pattern_signature: new URL(p.url).pathname,
        group_member_count: 1,
        discovery_method: 'OPERATOR_SUPPLIED',
        selection_reason: 'supplied by the operator; discovery skipped (E-A4-9)',
        score_breakdown: {},
        flags: [],
      })),
      page_type_absent: [],
    };
    ctx.emit('sample', { quality: ctx.sample.quality, pages: ctx.sample.pages.map((p) => ({ url: p.url, page_type: p.page_type })) });
    return;
  }

  // ── A.1 link harvesting ───────────────────────────────────────────────
  const harvest = (facts) => facts.links.filter((l) => !l.discard);
  const rawLinks = harvest(rawFacts);
  const renLinks = renFacts ? harvest(renFacts) : [];
  const rawSet = new Set(rawLinks.filter((l) => l.same_site).map((l) => l.resolved));
  const renSet = new Set(renLinks.filter((l) => l.same_site).map((l) => l.resolved));
  disc.js_only_links = [...renSet].filter((u) => !rawSet.has(u)).sort(); // R-A1-2
  disc.external_links = [...new Set([...rawLinks, ...renLinks].filter((l) => !l.same_site).map((l) => l.resolved))].sort().slice(0, 200);
  const allHomeLinks = [...rawLinks, ...renLinks];
  disc.links_harvested = allHomeLinks.length;
  if (allHomeLinks.length > cfg.discovery.max_links_per_page) disc.caps_hit.push('MAX_LINKS_PER_PAGE');

  // R-A0-6 site_shape — zero same-origin links whose path differs from /.
  const rootPath = pathOf(ctx.rootUrl);
  const nonRoot = [...new Set([...rawSet, ...renSet])].filter((u) => {
    const p = new URL(u).pathname;
    return p !== '/' && p !== new URL(hpFinal).pathname;
  });
  let siteShape = nonRoot.length ? 'multi_page' : 'single_page';
  const nonAnchorNav = rawFacts.$('nav [onclick], nav button, [role=navigation] [onclick], nav [role=link]').length > 0 && !rawLinks.some((l) => l.zone === 'nav');
  if (siteShape === 'single_page' && nonAnchorNav) {
    siteShape = 'multi_page'; // C-A1-d
    flags.add('NON_ANCHOR_NAVIGATION');
  }
  if (!rawSet.size && renSet.size) flags.add('NAV_REQUIRES_JS'); // C-A1-c
  ctx.target.site_shape = siteShape;
  const words = rawFacts.mainText.split(/\s+/).filter(Boolean).length;
  if (words < 50 && !nonRoot.length && /coming soon|under construction|launching soon/i.test(rawFacts.bodyText)) flags.add('SITE_PLACEHOLDER');

  // Primary-nav positions for service ranking (R-A4-2)
  const navIndex = new Map();
  let ni = 0;
  for (const l of [...rawLinks, ...renLinks]) {
    if (!l.same_site || !['nav', 'header'].includes(l.zone)) continue;
    if (!navIndex.has(l.resolved)) navIndex.set(l.resolved, { index: ni++, anchor: l.anchor });
  }

  // Candidate registry
  const cands = new Map(); // url → { url, discovery_method, one_click, has_query, facts, record }
  const addCand = (url, method, extra = {}) => {
    if (!url || !isSameSite(url, ctx.canonicalOrigin)) return;
    if (!cands.has(url)) cands.set(url, { url, discovery_method: method, one_click: false, has_query: url.includes('?'), ...extra });
    else Object.assign(cands.get(url), Object.fromEntries(Object.entries(extra).filter(([, v]) => v)));
  };
  for (const u of [...rawSet, ...renSet].sort()) addCand(u, 'homepage_link', { one_click: true });

  // Language prefixes (R-A0-7 discovery signal)
  const langPrefixes = new Set();
  // A two-letter first segment only signals a locale when it is a real ISO 639-1 language code.
  // Paths like /ai/ or /vs/ are ordinary sections, and counting them would declare a monolingual
  // site multilingual — which would then report missing hreflang that is not in fact required.
  const noteLang = (u) => {
    const seg = (new URL(u).pathname.split('/')[1] || '').toLowerCase();
    if (!/^[a-z]{2}(-[a-z]{2})?$/.test(seg)) return;
    if (!ISO639_1.has(seg.slice(0, 2))) return;
    langPrefixes.add(seg);
  };

  if (siteShape === 'single_page') {
    // R-A1-6 — page set is exactly [homepage]; discovery ends here. Operator-supplied URLs are
    // still honoured: they were named explicitly and must not be dropped by the shape detection.
    const extra = await loadOperatorPages(ctx, disc);
    return finishSingle(ctx, disc, { hpRaw, hpRen, rawFacts, renFacts, extra });
  }

  // ── Backup ladder when < 3 same-origin URLs (B-A1-1…B-A1-5) ─────────────────
  const fetchPage = async (url, method) => {
    if (fetches >= cfg.discovery.max_fetches) {
      if (!disc.caps_hit.includes('DISCOVERY_CAP_REACHED')) disc.caps_hit.push('DISCOVERY_CAP_REACHED');
      return null;
    }
    fetches++;
    ctx.emit('fetch', { url, purpose: `discovery (${method})` });
    const rec = await http.fetch(url, { budgetClass: 'secondary' });
    if (rec.not_responding) disc.unresponsive_urls.push({ url, http_status: rec.status, stall_stage: rec.stall_stage, elapsed_ms: rec.elapsed_ms });
    return rec;
  };
  const harvestFrom = (rec, method) => {
    if (!rec || !(rec.status >= 200 && rec.status < 300)) return null;
    const f = extractFacts(bodyText(rec), rec.final_url, ctx.canonicalOrigin);
    for (const l of f.links) if (!l.discard && l.same_site) addCand(l.resolved, method);
    return f;
  };

  if (cands.size < 3) {
    for (const p of HTML_SITEMAP_PATHS) {
      const rec = await fetchPage(`${ctx.canonicalOrigin}${p}`, 'html_sitemap');
      if (harvestFrom(rec, 'html_sitemap')) disc.discovery_methods_used.add('html_sitemap');
    }
  }
  if (cands.size < 3) {
    for (const c of [...cands.values()].slice(0, 20)) {
      const rec = await fetchPage(c.url, 'depth2_crawl');
      c.record = rec;
      c.facts = harvestFrom(rec, 'depth2_crawl');
    }
    disc.discovery_methods_used.add('depth2_crawl');
  }
  if (cands.size < 3) {
    for (const p of COMMON_PATHS) {
      const u = `${ctx.canonicalOrigin}${p}`;
      if (cands.has(u)) continue;
      const rec = await fetchPage(u, 'PATH_PROBE');
      if (rec && rec.status >= 200 && rec.status < 300 && originOf(rec.final_url) === ctx.canonicalOrigin) {
        addCand(normalizeUrl(rec.final_url), 'PATH_PROBE');
        disc.discovery_methods_used.add('PATH_PROBE');
      }
    }
  }
  if (cands.size < 3 && cfg.cap.commoncrawl) {
    const cc = await commonCrawlUrls(ctx);
    for (const u of cc) addCand(u, 'COMMON_CRAWL');
    if (cc.length) {
      disc.discovery_methods_used.add('COMMON_CRAWL');
      disc.common_crawl_caveat = 'URLs from a third-party crawl snapshot; may include removed pages.';
    }
  }

  // ── A.2 robots intersection ─────────────────────────────────────────
  for (const c of cands.values()) {
    noteLang(c.url);
    const gb = ctx.robotsAllowed('googlebot', c.url);
    const aud = ctx.robotsAllowed(ctx.auditorToken, c.url);
    c.robots_googlebot = gb.verdict;
    c.robots_auditor = aud.verdict;
    if (gb.verdict === 'DISALLOWED') disc.robots_blocked_candidates.push(c.url);
    else if (aud.verdict === 'DISALLOWED') disc.auditor_blocked_only.push(c.url);
    if (GATED.test(new URL(c.url).pathname)) disc.gated_excluded.push(c.url);
  }

  // ── A.3 grouping + A.4 candidate classification ───────────────────────────
  let grouped = buildGroups([...cands.values()], cfg);
  // Candidate fetch for classification: coverage first (1 per group), then a second member.
  const fetchable = (c) => c.robots_googlebot !== 'DISALLOWED' && c.robots_auditor !== 'DISALLOWED' && !GATED.test(new URL(c.url).pathname);
  const byGroup = (g) => g.members.map((u) => cands.get(u)).filter(Boolean).filter(fetchable).sort((a, b) => depth(a.url) - depth(b.url) || (b.one_click - a.one_click) || a.url.localeCompare(b.url));
  const orderedGroups = [...grouped.groups].filter((g) => g.signature !== '/').sort((a, b) => b.true_member_count - a.true_member_count || a.depth - b.depth || a.signature.localeCompare(b.signature));
  for (const round of [0, 1]) {
    for (const g of orderedGroups) {
      const list = byGroup(g);
      const c = list[round];
      if (!c || c.record) continue;
      const rec = await fetchPage(c.url, c.discovery_method);
      if (!rec) break;
      c.record = rec;
      c.facts = harvestFrom(rec, 'depth2_crawl'); // "follow links for a while": members are counted, not fetched
      ctx.checkDeadline?.();
    }
  }
  grouped = buildGroups([...cands.values()], cfg);
  for (const c of cands.values()) noteLang(c.url);
  if (grouped.groups.length === cands.size && cands.size > 6) {
    // B-A3-3 — no collapsing at all → depth-based grouping.
    grouped = { groups: depthGroups([...cands.values()]), signatures: computeSignatures([...cands.keys()]), flags: ['GROUPING_DEGRADED_TO_DEPTH'] };
    flags.add('GROUPING_DEGRADED_TO_DEPTH');
  }
  grouped.flags.forEach((f) => flags.add(f));
  if (disc.caps_hit.includes('DISCOVERY_CAP_REACHED')) flags.add('DISCOVERY_CAP_REACHED');

  const sigOf = (u) => grouped.signatures.get(u)?.signature || null;
  const saturatedParents = new Set(grouped.groups.filter((g) => g.saturated).map((g) => g.signature.replace(/\/\*.*$/, '')));
  const classCtx = { signatureOf: sigOf, saturatedParents };

  // B-A4-1 — targeted path probes for slate types with no qualifying candidate.
  const qualifyingTypes = new Set();
  for (const c of cands.values()) {
    if (!c.facts) continue;
    c.classification = classify({ ...c, path: new URL(c.url).pathname, signature: sigOf(c.url), nav_anchor: navIndex.get(c.url)?.anchor }, classCtx);
    for (const t of Object.keys(c.classification.qualifies)) qualifyingTypes.add(t === 'service' ? 'service_main' : t);
  }
  for (const [type, paths] of Object.entries(TYPE_PROBES)) {
    if (qualifyingTypes.has(type)) continue;
    for (const p of paths) {
      const u = `${ctx.canonicalOrigin}${p}`;
      if (cands.has(u)) continue;
      if (ctx.robotsAllowed(ctx.auditorToken, u).verdict === 'DISALLOWED') continue;
      const rec = await fetchPage(u, 'PATH_PROBE');
      if (rec && rec.status >= 200 && rec.status < 300 && originOf(rec.final_url) === ctx.canonicalOrigin) {
        const fu = normalizeUrl(rec.final_url);
        addCand(fu, 'PATH_PROBE');
        const c = cands.get(fu);
        c.record = rec;
        c.facts = extractFacts(bodyText(rec), rec.final_url, ctx.canonicalOrigin);
        c.robots_googlebot = ctx.robotsAllowed('googlebot', fu).verdict;
        c.robots_auditor = ctx.robotsAllowed(ctx.auditorToken, fu).verdict;
        disc.discovery_methods_used.add('PATH_PROBE');
        break;
      }
    }
  }
  grouped = grouped.flags.includes('GROUPING_DEGRADED_TO_DEPTH') ? grouped : buildGroups([...cands.values()], cfg);
  const sigOf2 = (u) => grouped.signatures.get(u)?.signature || null;

  // Final classification of every fetched candidate.
  const homepageCand = {
    url: normalizeUrl(hpFinal),
    depth: 0,
    one_click: true,
    isHomepage: true,
    discovery_method: 'seed',
    status: hpRaw.status,
    facts: rawFacts,
    robots_googlebot: ctx.robotsAllowed('googlebot', hpFinal).verdict,
    signature: '/',
  };
  homepageCand.classification = classify({ ...homepageCand, path: '/', isHomepage: true }, { signatureOf: sigOf2, saturatedParents });
  const hpNorm = homepageCand.url;

  const groups = grouped.groups.map((g) => {
    const members = g.members.filter((u) => u !== hpNorm && u !== ctx.rootUrl);
    const candidates = members
      .map((u) => cands.get(u))
      .filter((c) => c && c.facts && c.record)
      .map((c) => {
        const f = c.facts;
        const noindexRaw = f.metaRobots.some((m) => /noindex|none/i.test(m.content) && ['robots', 'googlebot'].includes(m.name)) || /noindex/i.test(String(c.record.headers?.['x-robots-tag'] || ''));
        const canon = f.canonicals.find((x) => x.in_head)?.href;
        const canonAbs = canon ? normalizeUrl(canon, c.record.final_url) : null;
        return {
          url: c.url,
          depth: depth(c.url),
          one_click: c.one_click,
          discovery_method: c.discovery_method,
          status: c.record.status,
          facts: f,
          robots_googlebot: c.robots_googlebot,
          noindex_raw: noindexRaw,
          canonical_cross: !!canonAbs && canonAbs !== normalizeUrl(c.record.final_url),
          nav_index: navIndex.get(c.url)?.index,
          signature: g.signature,
          classification: c.classification || classify({ ...c, path: new URL(c.url).pathname, signature: g.signature, nav_anchor: navIndex.get(c.url)?.anchor }, { signatureOf: sigOf2, saturatedParents }),
        };
      });
    return { ...g, candidates };
  });
  homepageCand.group = groups.find((g) => g.signature === '/') || { signature: '/', true_member_count: 1 };

  // Operator-supplied URLs (E-A4-9)
  const operatorPages = await loadOperatorPages(ctx, disc, sigOf2, saturatedParents);

  const sel = selectPages({ homepage: homepageCand, groups: groups.filter((g) => g.signature !== '/'), operatorPages, cap: 10 });
  if (sel.selected.length === 0) throw abort('NO_SELECTABLE_PAGES'); // C-A4-e
  if (sel.selected.length > 10) throw new Error('F-A4-2: more than 10 pages selected'); // ERROR, never WARN

  // R-A0-7 multilingual detection (discovery-time signals; C-3.2 re-evaluates across the sample)
  const mlSignals = [];
  if (rawFacts.hreflang.length || renFacts?.hreflang.length) mlSignals.push('hreflang link in head');
  if (/hreflang=/i.test(String(hpRaw.headers?.link || ''))) mlSignals.push('Link header hreflang');
  if (langPrefixes.size >= 2) mlSignals.push(`language path prefixes: ${[...langPrefixes].join(', ')}`);
  ctx.target.multilingual_signals = mlSignals;
  ctx.target.is_multilingual = mlSignals.length > 0;
  ctx.derived.langPrefixes = [...langPrefixes];
  if (/(\/product\/|\/shop\/|\/cart)/.test([...cands.keys()].join(' '))) ctx.target.has_ecommerce_shape = true; // informational only

  // Record discovery output (Appendix B)
  disc.groups = grouped.groups.map((g) => ({
    signature: g.signature,
    member_count: g.member_count,
    true_member_count: g.true_member_count,
    saturated: g.saturated,
    example_url: g.example_url,
    depth: g.depth,
    discovery_methods: g.discovery_methods,
    locale_variants: g.locale_variants,
  }));
  disc.fetch_count = http.fetchCount;
  disc.discovery_methods_used = [...disc.discovery_methods_used];
  disc.excluded = sel.excluded;
  if (disc.discovery_methods_used.length === 1 && sel.selected.length === 1) flags.add('DISCOVERY_DEGRADED');

  ctx.sample = {
    quality: sampleQuality(sel.selected),
    pages: sel.selected,
    page_type_absent: sel.page_type_absent,
  };
  if (sel.selected.some((s) => s.score_breakdown?.noindex || s.score_breakdown?.canonicalised)) flags.add('SAMPLE_INCLUDES_NONINDEXABLE');
  ctx.emit('sample', { quality: ctx.sample.quality, pages: sel.selected.map((p) => ({ url: p.url, page_type: p.page_type })) });
}

function finishSingle(ctx, disc, { hpRaw, extra = [] }) {
  disc.discovery_methods_used = [...disc.discovery_methods_used];
  disc.groups = [{ signature: '/', member_count: 1, true_member_count: 1, saturated: false, example_url: ctx.homepageUrl, depth: 0, discovery_methods: ['seed'] }];
  disc.fetch_count = ctx.http.fetchCount;
  ctx.flags.add('SINGLE_PAGE_SITE');
  ctx.target.is_multilingual = false;
  const url = normalizeUrl(hpRaw.final_url || ctx.homepageUrl);
  const pages = [{ url, page_type: 'homepage', alt_types: [], pattern_signature: '/', group_member_count: 1, discovery_method: 'seed', selection_reason: 'single-page site (R-A1-6)', score_breakdown: {}, flags: [] }];
  for (const p of extra.slice(0, 9)) {
    if (p.url === url) continue;
    pages.push({ url: p.url, page_type: 'other', alt_types: [], pattern_signature: new URL(p.url).pathname, group_member_count: 1, discovery_method: 'OPERATOR_SUPPLIED', selection_reason: 'supplied by the operator (E-A4-9)', score_breakdown: {}, flags: [] });
  }
  ctx.sample = {
    quality: sampleQuality(pages),
    pages,
    page_type_absent: SLATE.filter((t) => t !== 'homepage').map((t) => ({ page_type: t, reason: 'NO_QUALIFYING_CANDIDATE' })),
  };
  ctx.emit('sample', { quality: ctx.sample.quality, pages: pages.map((p) => ({ url: p.url, page_type: p.page_type })) });
}

function depth(url) {
  return new URL(url).pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).length;
}

/** B-A1-4 — Common Crawl CDX index (discovery only; THIRD_PARTY). */
async function commonCrawlUrls(ctx) {
  try {
    const host = hostOf(ctx.canonicalOrigin);
    const info = await fetch('https://index.commoncrawl.org/collinfo.json', { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    const api = info?.[0]?.['cdx-api'];
    if (!api) return [];
    const q = `${api}?url=${encodeURIComponent(host)}&matchType=domain&output=json&fl=url,status&limit=300`;
    const text = await fetch(q, { signal: AbortSignal.timeout(10000) }).then((r) => r.text());
    const out = new Set();
    for (const line of text.split('\n')) {
      try {
        const j = JSON.parse(line);
        if (j.status !== '200') continue;
        const u = normalizeUrl(j.url);
        if (u && isSameSite(u, ctx.canonicalOrigin)) out.add(u.split('#')[0]);
      } catch {
        /* skip malformed CDX line */
      }
    }
    return [...out].sort().slice(0, 200);
  } catch {
    return [];
  }
}
