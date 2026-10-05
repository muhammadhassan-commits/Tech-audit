// C-1.4 — Redirects (site + page · RAW; RENDERED for client-side divergence).
import { ResultBuilder, ev, errorResult } from '../engine/result.js';
import { originOf, normalizeUrl } from '../parse/url.js';
import { classifyResponse, VALIDITY } from '../net/validity.js';
import { bodyText } from '../net/http.js';
import { forEachPage, hasRendered, matchesAny } from './_util.js';

const PERMANENT = new Set([301, 308]);
const TEMPORARY = new Set([302, 303, 307]);

const chainText = (chain) => chain.map((h) => `${h.status} ${h.url}${h.location ? ` → ${h.location}` : ''}`).join(' | ');

/**
 * Do two origins actually serve the same site?
 *
 * Two hosts answering 200 is not enough to call them duplicate origins. One of them may be a
 * parked page, a holding page, a different site on a shared host, or a bot challenge — all of
 * which answer 200 and none of which mean the site is reachable at two addresses.
 *
 * The origin probe discards bodies, so the comparison is made here, and only when a non-converged
 * 200 has already been seen: at most four extra secondary requests, in the case that is already
 * suspicious. A fast audit should not pay for this on every run.
 */
async function originsEquivalent(ctx, canonicalOrigin, variantUrl) {
  const get = async (url) => {
    const rec = await ctx.http.fetch(url, { budgetClass: 'secondary', exempt: true, noCache: true });
    const html = bodyText(rec) || '';
    return {
      rec,
      html,
      validity: classifyResponse({ status: rec.status, headers: rec.headers, html, contentType: rec.headers?.['content-type'] }),
    };
  };

  const [a, b2] = await Promise.all([get(canonicalOrigin), get(variantUrl)]);

  // A challenge or error on either side is not evidence of anything about the site.
  if (a.validity.state !== VALIDITY.VALID_PAGE || b2.validity.state !== VALIDITY.VALID_PAGE) {
    return { comparable: false, reason: `one of the two responses was not a usable page (${a.validity.state} / ${b2.validity.state})` };
  }

  const words = (html) => new Set(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 2000),
  );

  const wa = words(a.html);
  const wb = words(b2.html);
  if (wa.size < 20 || wb.size < 20) {
    return { comparable: false, reason: 'one of the two responses carried too little text to compare' };
  }
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  // Jaccard over the vocabulary. Tool policy: 0.6 is the point past which two pages are clearly
  // the same content rather than two pages from the same template.
  const similarity = shared / (wa.size + wb.size - shared);
  return { comparable: true, equivalent: similarity >= 0.6, similarity: Number(similarity.toFixed(2)) };
}

export async function run(ctx) {
  const out = [];
  try {
    out.push(await siteLevel(ctx));
  } catch (e) {
    out.push(errorResult(ctx, 'C-1.4', e));
  }
  out.push(...(await forEachPage(ctx, 'C-1.4', (page, b) => pageLevel(ctx, page, b))));
  return out;
}

async function siteLevel(ctx) {
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
    // Confirm the other origin is really serving this site before calling it a duplicate. Both
    // responses must be usable pages and must carry the same content; a parked page, a holding
    // page or a challenge all answer 200 without meaning anything of the sort.
    const confirmed = [];
    const unconfirmed = [];
    for (const v of live200NotConverged.slice(0, 3)) {
      let verdict;
      try {
        verdict = await originsEquivalent(ctx, ctx.canonicalOrigin, v.final_url || v.url);
      } catch {
        verdict = { comparable: false, reason: 'the comparison request failed' };
      }
      if (verdict.comparable && verdict.equivalent) confirmed.push({ v, verdict });
      else unconfirmed.push({ v, verdict });
    }

    if (confirmed.length) {
      ctx.derived.multipleLiveOrigins = true;
      b.hit('C-1.4-c', {
        summary: `The site is reachable at ≥ 2 hosts without consolidation: ${[ctx.canonicalOrigin, ...new Set(confirmed.map((c) => originOf(c.v.final_url)))].join(', ')}. Each serves the same content (${confirmed.map((c) => `${Math.round(c.verdict.similarity * 100)}% word overlap`).join(', ')}), so the two addresses compete for the same signals.`,
        evidence: [...confirmed.map((c) => c.v), ...answered.filter((v) => originOf(v.final_url || v.url) === ctx.canonicalOrigin)].map(vEv),
        cross_references: ['C-1.5'],
      });
    }
    for (const { v, verdict } of unconfirmed) {
      b.note('MULTIPLE_LIVE_ORIGINS', verdict.comparable
        ? `${v.url} answers 200 without redirecting to ${ctx.canonicalOrigin}, but serves different content (${Math.round(verdict.similarity * 100)}% word overlap), so it is not a duplicate of this site. Recorded, not scored.`
        : `${v.url} answers 200 without redirecting to ${ctx.canonicalOrigin}, but whether it serves this site could not be established: ${verdict.reason}. Recorded, not scored.`,
      [vEv(v)]);
    }
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

/**
 * R-1.4-1 — "where a trailing-slash variant exists, both forms". Request the page's opposite
 * trailing-slash form: one of the two must be canonical and the other must redirect to it. Both
 * answering 200 means the same content is live at two URLs, which splits signals exactly as an
 * unconsolidated www/non-www pair does.
 */
async function trailingSlashVariant(ctx, page) {
  const u = new URL(page.finalUrl);
  if (u.pathname === '/' || u.search) return null; // the root has no meaningful pair
  const alt = new URL(u);
  alt.pathname = u.pathname.endsWith('/') ? u.pathname.replace(/\/+$/, '') : `${u.pathname}/`;
  if (!alt.pathname) return null;
  const altUrl = alt.toString();
  ctx.derived.slashProbes ||= new Map();
  if (ctx.derived.slashProbes.has(altUrl)) return ctx.derived.slashProbes.get(altUrl);
  const rec = await ctx.http.fetch(altUrl, { budgetClass: 'secondary', discardBody: true });
  const out = { url: altUrl, status: rec.status, final_url: rec.final_url, hops: rec.hop_count || 0, terminal: rec.terminal };
  ctx.derived.slashProbes.set(altUrl, out);
  return out;
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
  // Trailing-slash pair (R-1.4-1)
  let slash = null;
  if (r.status >= 200 && r.status < 300) {
    slash = await trailingSlashVariant(ctx, page);
    if (slash) {
      b.metric('trailing_slash_variant', slash);
      const sEv = ev({ kind: 'http_status', source_url: slash.url, fetch_profile: 'RAW', selector_or_key: 'trailing-slash variant final status', observed_value: `${slash.status ?? 'no response'} ${slash.final_url || ''}`.trim(), expected_value: `redirect to ${page.finalUrl}` });
      const landsHere = slash.final_url && normalizeUrl(slash.final_url) === page.finalUrl;
      if (slash.status >= 200 && slash.status < 300 && !landsHere) {
        b.hit('C-1.4-p', {
          status: 'FAIL',
          severity: 'HIGH',
          reason_code: 'TRAILING_SLASH_BOTH_LIVE',
          summary: `Both ${page.finalUrl} and ${slash.url} return ${slash.status} without either redirecting to the other. The same content is live at two URLs; one form must be canonical and the other must redirect to it.`,
          evidence: [sEv],
          cross_references: ['C-1.5'],
        });
      } else if (landsHere && slash.hops > 0) {
        b.note('TRAILING_SLASH_REDIRECT', `The ${slash.url.endsWith('/') ? 'trailing-slash' : 'no-slash'} form redirects here in ${slash.hops} hop(s) — correct consolidation (E-1.4-4).`, [sEv]);
      } else if (slash.status != null && slash.status >= 400) {
        b.note('TRAILING_SLASH_REDIRECT', `The opposite trailing-slash form returns ${slash.status}; only one form is served.`, [sEv]);
      }
    }
  }

  b.addEvidence(cEv);
  if (!b.hits.length) {
    if (hops === 0) b.pass(`Sampled URL resolves in 0 hops${slash && slash.status >= 400 ? '; the opposite trailing-slash form is not served' : slash ? '; the opposite trailing-slash form redirects here' : ''}.`);
    else if (hops === 1 && PERMANENT.has(chain[0].status)) b.pass(`Single ${chain[0].status} hop (e.g. trailing-slash or case normalisation, E-1.4-4/5).`);
    else b.pass(`Resolves in ${hops} hop(s).`);
  }
}
