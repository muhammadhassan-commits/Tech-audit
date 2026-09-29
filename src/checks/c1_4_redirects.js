// C-1.4 — Redirects (site + page · RAW; RENDERED for client-side divergence).
import { ResultBuilder, ev, errorResult } from '../engine/result.js';
import { originOf, normalizeUrl } from '../parse/url.js';
import { forEachPage, hasRendered, matchesAny } from './_util.js';

const PERMANENT = new Set([301, 308]);
const TEMPORARY = new Set([302, 303, 307]);

const chainText = (chain) => chain.map((h) => `${h.status} ${h.url}${h.location ? ` → ${h.location}` : ''}`).join(' | ');

export async function run(ctx) {
  const out = [];
  try {
    out.push(siteLevel(ctx));
  } catch (e) {
    out.push(errorResult(ctx, 'C-1.4', e));
  }
  out.push(...(await forEachPage(ctx, 'C-1.4', (page, b) => pageLevel(ctx, page, b))));
  return out;
}

function siteLevel(ctx) {
  const { cfg } = ctx;
  const variants = ctx.derived.originVariants || [];
  const b = new ResultBuilder(ctx, 'C-1.4', { scope: 'site', target_url: ctx.canonicalOrigin });
  const vEv = (v) => ev({ kind: 'http_header', source_url: v.url, fetch_profile: 'RAW', selector_or_key: 'redirect_chain', observed_value: v.chain?.length ? chainText(v.chain) : `${v.status ?? 'no response'} ${v.error || ''}`.trim() });
  b.metric('origin_variants', variants.map((v) => ({ url: v.url, final_url: v.final_url, status: v.status, hops: v.hops, error: v.error })));

  const answered = variants.filter((v) => v.status != null);
  const live200NotConverged = answered.filter((v) => v.status >= 200 && v.status < 300 && originOf(v.final_url) !== ctx.canonicalOrigin);
  if (answered.some((v) => v.terminal === 'REDIRECT_LOOP')) b.hit('C-1.4-b', { summary: 'Redirect loop on an origin variant.', evidence: answered.filter((v) => v.terminal === 'REDIRECT_LOOP').map(vEv) });
  if (answered.some((v) => v.terminal === 'REDIRECT_HOPS_EXCEEDED')) b.hit('C-1.4-e', { summary: `An origin variant exceeds ${cfg.net.max_redirect_hops} redirect hops.`, evidence: answered.filter((v) => v.terminal === 'REDIRECT_HOPS_EXCEEDED').map(vEv) });
  if (live200NotConverged.length) {
    ctx.derived.multipleLiveOrigins = true;
    b.hit('C-1.4-c', {
      summary: `The site is reachable at ≥ 2 hosts without consolidation: ${[ctx.canonicalOrigin, ...new Set(live200NotConverged.map((v) => originOf(v.final_url)))].join(', ')}.`,
      evidence: [...live200NotConverged, ...answered.filter((v) => originOf(v.final_url || v.url) === ctx.canonicalOrigin)].map(vEv),
      cross_references: ['C-1.5'],
    });
  }
  for (const v of answered) {
    const hops = v.hops || 0;
    const chain = v.chain || [];
    if (chain.some((h, i) => h.url.startsWith('https://') && chain[i]?.resolved?.startsWith('http://'))) b.hit('C-1.4-g', { summary: `HTTPS → HTTP downgrade in ${v.url}.`, evidence: [vEv(v)] });
    if (hops >= cfg.th.redirect_chain_fail && v.terminal !== 'REDIRECT_HOPS_EXCEEDED') b.hit('C-1.4-d', { summary: `${v.url} takes ${hops} hops to resolve.`, evidence: [vEv(v)] });
    else if (hops >= cfg.th.redirect_chain_warn && hops < cfg.th.redirect_chain_fail) b.hit('C-1.4-f', { summary: `${v.url} resolves in ${hops} hops (origin consolidation should be ≤ 1 hop).`, evidence: [vEv(v)] });
    const temp = chain.filter((h) => TEMPORARY.has(h.status) && h.resolved);
    if (temp.length && originOf(v.final_url || v.url) === ctx.canonicalOrigin) {
      const localeRedirect = temp.some((h) => /^\/[a-z]{2}(-[a-z]{2})?\/?$/i.test(new URL(h.resolved).pathname));
      if (localeRedirect) b.note('TEMPORARY_REDIRECT_FOR_PERMANENT_MOVE', `Locale redirect on the homepage via ${temp[0].status} (E-1.4-3). Acceptable with an x-default hreflang; Google crawls mainly from the US and cannot follow geo-IP redirects for other regions.`, [vEv(v)]);
      else b.hit('C-1.4-h', { summary: `Origin consolidation for ${v.url} uses a temporary ${temp.map((h) => h.status).join('/')} redirect instead of 301/308.`, evidence: [vEv(v)] });
    }
    const rel = chain.filter((h) => h.location && !/^https?:\/\//i.test(h.location));
    if (rel.length) b.hit('C-1.4-o', { summary: `Relative Location header on ${v.url}: "${rel[0].location}".`, evidence: [vEv(v)] });
  }
  const unresolved = variants.filter((v) => v.status == null);
  if (unresolved.length) b.note('MALFORMED_REDIRECT', `Origin variant(s) did not answer (${unresolved.map((v) => `${v.url}: ${v.error}`).join('; ')}); absence of a response is not evidence of a second live origin (B-1.4-2).`);
  b.addEvidence(...answered.map(vEv));
  if (!b.hits.length) b.pass(`Origin variants converge on ${ctx.canonicalOrigin} via permanent redirects in ≤ 1 hop.`);
  return b.build();
}

async function pageLevel(ctx, page, b) {
  const { cfg } = ctx;
  const r = page.raw;
  const chain = r.chain;
  const hops = r.hop_count || 0;
  const cEv = ev({ kind: 'http_header', source_url: page.url, fetch_profile: 'RAW', selector_or_key: 'redirect_chain', observed_value: chainText(chain) });
  b.metric('hops', hops).metric('chain', chain.map((h) => ({ status: h.status, url: h.url, location: h.location })));

  if (r.terminal === 'REDIRECT_LOOP') b.hit('C-1.4-b', { summary: 'Redirect loop detected.', evidence: [cEv] });
  if (r.terminal === 'REDIRECT_HOPS_EXCEEDED') b.hit('C-1.4-e', { summary: `Chain exceeds ${cfg.net.max_redirect_hops} hops without resolving.`, evidence: [cEv] });
  if (hops >= cfg.th.redirect_chain_fail && r.terminal !== 'REDIRECT_HOPS_EXCEEDED') b.hit('C-1.4-d', { summary: `Redirect chain of ${hops} hops.`, evidence: [cEv] });
  else if (hops >= cfg.th.redirect_chain_warn && hops < cfg.th.redirect_chain_fail) b.hit('C-1.4-f', { summary: `Redirect chain of ${hops} hops.`, evidence: [cEv] });
  for (const h of chain) {
    if (h.resolved && h.url.startsWith('https://') && h.resolved.startsWith('http://')) b.hit('C-1.4-g', { summary: `HTTPS → HTTP downgrade: ${h.url} → ${h.resolved}.`, evidence: [cEv] });
    if (h.location && !/^https?:\/\//i.test(h.location)) b.hit('C-1.4-o', { summary: `Relative Location header "${h.location}" (permitted by RFC 9110, but a frequent source of misconfiguration).`, evidence: [cEv] });
  }
  const temp = chain.filter((h) => TEMPORARY.has(h.status) && h.resolved);
  if (temp.length && !matchesAny(page.url, cfg.expected_temporary_paths)) {
    b.hit('C-1.4-h', { summary: `Redirect uses temporary ${temp.map((h) => h.status).join('/')}; a permanent move should use 301/308.${chain[0] && TEMPORARY.has(chain[0].status) && chain.some((h) => PERMANENT.has(h.status)) ? ' Mixed-signal chain: the first hop dominates interpretation (R-1.4-8).' : ''}`, evidence: [cEv] });
  }
  // R-1.4-7 deep URL → homepage
  const startPath = new URL(page.url).pathname;
  if (hops > 0 && startPath !== '/' && r.final_url && new URL(r.final_url).pathname === '/' && !page.isHomepage) {
    b.hit('C-1.4-i', { summary: `Deep URL ${page.url} redirects to the homepage — treated by Google as a soft 404.`, evidence: [cEv] });
  }
  if (hops > 0 && r.status != null && r.status >= 400) b.hit('C-1.4-l', { summary: `Redirect target returns HTTP ${r.status}.`, evidence: [cEv], cross_references: ['C-1.3'] });
  if (hops > 0 && r.status >= 200 && r.status < 300 && page.rawFacts) {
    const noindex = page.rawFacts.metaRobots.some((m) => ['robots', 'googlebot'].includes(m.name) && /noindex|none/i.test(m.content)) || /noindex/i.test(String(r.headers?.['x-robots-tag'] || ''));
    const canon = page.rawFacts.canonicals.find((c) => c.in_head)?.href;
    const canonAbs = canon ? normalizeUrl(canon, r.final_url) : null;
    if (noindex || (canonAbs && canonAbs !== normalizeUrl(r.final_url))) b.hit('C-1.4-m', { summary: `Redirect target is ${noindex ? 'noindex' : `canonicalised to ${canonAbs}`}.`, evidence: [cEv], cross_references: ['C-1.5', 'C-1.6'] });
  }
  // Meta refresh / Refresh header (R-1.4-3, E-1.4-10) — recorded, not followed.
  const $ = page.rawFacts?.$;
  const metaRefresh = $ ? $('meta[http-equiv]').filter((_, el) => String($(el).attr('http-equiv')).toLowerCase() === 'refresh').attr('content') : null;
  const refreshHeader = r.headers?.refresh;
  if ((metaRefresh && /url=/i.test(metaRefresh)) || refreshHeader) {
    const val = metaRefresh || refreshHeader;
    const delay = parseFloat(String(val)) || 0;
    b.hit('C-1.4-j', { summary: `${metaRefresh ? 'Meta refresh' : 'Refresh: header'} redirect ("${val}") — ${delay === 0 ? 'permanent-equivalent' : 'temporary-equivalent'} but weaker than a server redirect.`, evidence: [ev({ kind: metaRefresh ? 'dom_node' : 'http_header', source_url: page.url, fetch_profile: 'RAW', selector_or_key: metaRefresh ? 'meta[http-equiv=refresh]' : 'Refresh', observed_value: val })] });
  }
  // R-1.4-9/10 — client-side navigation divergence (RENDERED)
  if (hasRendered(page)) {
    const rawFinal = normalizeUrl(r.final_url);
    const renFinal = normalizeUrl(page.rendered.final_url);
    if (rawFinal && renFinal && rawFinal.split('#')[0] !== renFinal.split('#')[0]) {
      b.hit('C-1.4-n', { summary: `RAW final URL ${rawFinal} differs from RENDERED final URL ${renFinal}.`, evidence: [ev({ kind: 'computed', source_url: page.url, fetch_profile: 'RENDERED', selector_or_key: 'final_url', observed_value: renFinal, expected_value: rawFinal })] });
      if (/(window\.)?location(\.href)?\s*=|location\.replace\(|location\.assign\(/.test(page.rawHtml || '')) {
        b.hit('C-1.4-k', { summary: 'JavaScript-only redirect: the move happens only after rendering; if rendering fails Google never sees it (JS_REDIRECT).', evidence: [ev({ kind: 'computed', source_url: page.url, fetch_profile: 'RENDERED', selector_or_key: 'navigations', observed_value: page.rendered.navigations.map((n) => n.url).join(' → ') })] });
      }
    }
  } else {
    b.caveat('Client-side redirects not evaluated: no RENDERED profile for this page (B-1.4-3).');
  }
  b.addEvidence(cEv);
  if (!b.hits.length) {
    if (hops === 0) b.pass('Sampled URL resolves in 0 hops.');
    else if (hops === 1 && PERMANENT.has(chain[0].status)) b.pass(`Single ${chain[0].status} hop (e.g. trailing-slash or case normalisation, E-1.4-4/5).`);
    else b.pass(`Resolves in ${hops} hop(s).`);
  }
}
