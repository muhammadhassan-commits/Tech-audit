// C-2.4 — Internal Links (page + site · RAW and RENDERED). Hard NOT_APPLICABLE for single-page sites.
import { ResultBuilder, ev } from '../engine/result.js';
import { forEachPage, hasRendered, domEv, matchesAny } from './_util.js';

// rel tokens that are crawl directives; everything else (noopener, noreferrer, external…) is not.
const CRAWL_REL = new Set(['nofollow', 'sponsored', 'ugc']);

const GENERIC = /^(click here|read more|learn more|here|this|more|link|download|continue|details|see more|view more|find out more|more info|mehr|leer más|en savoir plus|lire la suite|weiterlesen|saiba mais)$/i;

function contextual(f) {
  return f.links.filter((l) => !l.discard && l.same_site && l.in_main && !l.in_breadcrumb && l.zone === 'body');
}

export async function run(ctx) {
  if (ctx.target.site_shape === 'single_page') {
    const b = new ResultBuilder(ctx, 'C-2.4', { scope: 'site', target_url: ctx.canonicalOrigin });
    b.notApplicable('SINGLE_PAGE_SITE', 'Single-page website — internal links are ignored per the checklist (R-2.4-1). No sub-findings.');
    return [b.build()];
  }
  if (ctx.sample.quality === 'SINGLE') {
    const b = new ResultBuilder(ctx, 'C-2.4', { scope: 'site', target_url: ctx.canonicalOrigin });
    b.notApplicable('INSUFFICIENT_SAMPLE', 'Only one page in the sample (R-2.4-1).');
    return [b.build()];
  }

  // Link graph + target validation (R-2.4-4, R-2.4-8)
  const sampleUrls = new Set(ctx.pages.map((p) => p.finalUrl));
  const inDegree = new Map([...sampleUrls].map((u) => [u, 0]));
  const targetDegree = new Map();
  for (const p of ctx.pages) {
    if (!p.rawFacts) continue;
    const seen = new Set();
    for (const l of contextual(p.rawFacts)) {
      if (l.resolved === p.finalUrl || seen.has(l.resolved)) continue; // self-links neutral (R-2.4-10)
      seen.add(l.resolved);
      targetDegree.set(l.resolved, (targetDegree.get(l.resolved) || 0) + 1);
      if (inDegree.has(l.resolved)) inDegree.set(l.resolved, inDegree.get(l.resolved) + 1);
    }
  }
  const targets = [...targetDegree.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const budget = ctx.cfg.links.max_validations;
  const validated = new Map();
  let rateLimited = 0;
  for (const [u] of targets.slice(0, budget)) {
    const known = ctx.pages.find((p) => p.finalUrl === u || p.url === u);
    if (known) {
      validated.set(u, known.raw.status);
      continue;
    }
    const rec = await ctx.http.fetch(u, { budgetClass: 'secondary', discardBody: true });
    if (rec.terminal === 'BLOCKED_BY_ROBOTS_FOR_AUDITOR') continue;
    if (rec.status === 429) rateLimited++;
    validated.set(u, rec.status);
    if (rateLimited >= 2) break; // B-2.4-4
  }
  const unvalidated = targets.length - validated.size;
  ctx.derived.linkValidation = { targets: targets.length, validated: validated.size, unvalidated };

  const results = await forEachPage(ctx, 'C-2.4', (page, b) => {
    if (!page.is_html) return b.notApplicable('INSUFFICIENT_SAMPLE', 'Non-HTML resource.');
    const f = page.rawFacts;
    const degraded = f.mainMethod === 'body_minus_boilerplate';
    const ctxLinks = contextual(f).filter((l) => l.resolved !== page.finalUrl);
    const boiler = f.links.filter((l) => !l.discard && l.same_site && ['nav', 'header', 'footer', 'aside'].includes(l.zone));
    b.metric('contextual_links', ctxLinks.length).metric('boilerplate_links', boiler.length).metric('in_degree_in_sample', inDegree.get(page.finalUrl) ?? 0);
    if (degraded) b.note('LINK_ZONING_DEGRADED', 'Main region undetermined: ratio conditions are informational only (B-2.4-3).');
    const linkEv = domEv(page, 'RAW', 'main a[href] (contextual)', ctxLinks.slice(0, 30).map((l) => `${l.anchor || '(no text)'} → ${l.resolved}`).join(' | ') || '(none)');

    const broken = ctxLinks.filter((l) => validated.has(l.resolved) && validated.get(l.resolved) >= 400);
    if (broken.length) b.hit('C-2.4-c', { summary: `${broken.length} contextual link target(s) return 4xx/5xx: ${[...new Set(broken.map((l) => `${l.resolved} (${validated.get(l.resolved)})`))].join(', ')}.`, evidence: broken.map((l) => ev({ kind: 'http_status', source_url: l.resolved, fetch_profile: 'RAW', selector_or_key: `linked from ${page.finalUrl} ("${l.anchor}")`, observed_value: String(validated.get(l.resolved)) })) });
    if (!page.isHomepage && (inDegree.get(page.finalUrl) ?? 0) === 0) b.hit('C-2.4-d', { summary: 'No other sampled page links to this page contextually. Sample-scoped only — the page may be well linked site-wide (E-2.4-3).', evidence: [linkEv] });
    const scored = ctxLinks.filter((l) => !/^https?:\/\//i.test(l.anchor) && !/^\d+$/.test(l.anchor) && !l.rel.includes('next') && !l.rel.includes('prev'));
    const generic = scored.filter((l) => GENERIC.test(l.anchor.trim()));
    const ratio = scored.length ? generic.length / scored.length : 0;
    b.metric('generic_anchor_ratio', Number(ratio.toFixed(3)));
    if (ratio >= 0.2 && generic.length) {
      if (degraded) b.note('GENERIC_ANCHOR_TEXT', `${Math.round(ratio * 100)}% generic anchors (informational: zoning degraded).`);
      else b.hit('C-2.4-e', { summary: `${generic.length}/${scored.length} contextual anchors (${Math.round(ratio * 100)}%) are generic ("${[...new Set(generic.map((l) => l.anchor))].slice(0, 4).join('", "')}").`, evidence: generic.slice(0, 8).map((l) => domEv(page, 'RAW', 'a[href]', `${l.anchor} → ${l.resolved}`)) });
    }
    const empty = f.links.filter((l) => !l.discard && l.same_site && !l.anchor);
    if (empty.length) b.hit('C-2.4-f', { summary: `${empty.length} internal anchor(s) with no text, aria-label or image alt.`, evidence: empty.slice(0, 8).map((l) => domEv(page, 'RAW', 'a[href]', l.href)) });
    const nofollow = f.links.filter((l) => !l.discard && l.same_site && l.rel.some((r) => CRAWL_REL.has(r)) && !matchesAny(l.resolved, ctx.cfg.expected_noindex_paths));
    if (nofollow.length) {
      // Name only the crawl directives. rel="noopener"/"noreferrer" are window and referrer
      // controls that frequently sit alongside them and say nothing about crawling.
      const directives = [...new Set(nofollow.flatMap((l) => l.rel).filter((r) => CRAWL_REL.has(r)))];
      b.hit('C-2.4-g', { summary: `${nofollow.length} internal link(s) carry rel="${directives.join('", "')}".`, evidence: nofollow.slice(0, 8).map((l) => domEv(page, 'RAW', `a[rel~=${directives[0]}]`, `${l.anchor || '(no text)'} → ${l.resolved} (rel="${l.rel.join(' ')}")`)) });
    }
    if (!ctxLinks.length) {
      if (matchesAny(page.finalUrl, ctx.cfg.expected_standalone_paths)) b.note('NO_CONTEXTUAL_LINKS', 'Standalone landing page with no contextual links (E-2.4-2).');
      else if (!degraded) b.hit('C-2.4-h', { summary: 'This page has no contextual (main-region) internal links.', evidence: [linkEv] });
    }
    if (hasRendered(page)) {
      const rawSet = new Set(f.links.filter((l) => !l.discard && l.same_site).map((l) => l.resolved));
      const renSet = new Set(page.renFacts.links.filter((l) => !l.discard && l.same_site).map((l) => l.resolved));
      const jsOnly = [...renSet].filter((u) => !rawSet.has(u));
      const share = renSet.size ? jsOnly.length / renSet.size : 0;
      b.metric('js_only_links', jsOnly.length).metric('js_only_ratio', Number(share.toFixed(3)));
      if (share > 0.3) b.hit('C-2.4-i', { summary: `${Math.round(share * 100)}% of internal links (${jsOnly.length}/${renSet.size}) exist only after rendering; discoverable only if rendering succeeds.`, evidence: [domEv(page, 'RENDERED', 'a[href] only in RENDERED', jsOnly.slice(0, 20).join(' | '))], cross_references: ['C-5.2'] });
    } else {
      b.caveat('JS-only link share not computed (no RENDERED profile); C-2.4-i NOT_TESTABLE (B-2.4-1).');
    }
    if (page.isHomepage && ctx.flags.has('NON_ANCHOR_NAVIGATION')) b.hit('C-2.4-j', { summary: 'Navigation exists only as non-anchor elements (buttons/click handlers); Google discovers links only from <a href>.', evidence: [linkEv], cross_references: ['C-5.2'] });
    if (unvalidated > 0) b.caveat(`${unvalidated} link target(s) left unvalidated by the ${budget}-request budget — not assumed healthy (LINK_VALIDATION_CAPPED).`);
    b.addEvidence(linkEv);
    if (!b.hits.length) b.pass(`${ctxLinks.length} contextual internal link(s), no broken targets among those validated, generic-anchor ratio ${Math.round(ratio * 100)}%.`);
  });
  return results;
}
