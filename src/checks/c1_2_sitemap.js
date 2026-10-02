// C-1.2 — XML Sitemap: parent sitemap locatable and fetchable (site · RAW).
//
// The question is narrow on purpose: can a usable parent sitemap be found and does it answer 200.
// This check does not crawl child sitemaps, does not read or extract sitemap URLs, does not compare
// them against the sampled pages, does not validate lastmod/changefreq/priority, and does not
// compute coverage. Bodies are never read (F-1.2-3); http:// is sent as plain HTTP with no
// HSTS/upgrade (R-1.2-5, F-1.2-4).
//
// Variant reachability is recorded but deliberately does not drive the status. A sitemap answering
// 200 on both www and non-www is not a sitemap failure — Google takes the sitemap it is given — so
// hostname convergence and redirect-chain quality are reported as notes and scored under C-1.4 and
// C-1.5 instead. Absence is a WARN, not a FAIL: Google does not require a site to have a sitemap.
import { ResultBuilder, ev, errorResult } from '../engine/result.js';
import { normalizeUrl, registrableDomain, isAbsoluteHttpUrl } from '../parse/url.js';

const INCONCLUSIVE = new Set(['CONNECT_TIMEOUT', 'READ_TIMEOUT', 'DNS_ERROR', 'RATE_LIMITED', 'BOT_PROTECTION', 'GEO_RESTRICTED', 'AUTH_DENIED', 'CAP_REACHED']);

export async function run(ctx) {
  try {
    return [await evaluate(ctx)];
  } catch (e) {
    return [errorResult(ctx, 'C-1.2', e)];
  }
}

async function evaluate(ctx) {
  const { cfg, http } = ctx;
  const origin = new URL(ctx.canonicalOrigin);
  const H = origin.hostname;
  const bare = H.replace(/^www\./, '');
  const wwwHost = `www.${bare}`;
  const nonDefaultPort = !!origin.port;
  let scope;
  let variants;
  if (nonDefaultPort) {
    scope = 'canonical_only';
    variants = [ctx.canonicalOrigin];
  } else if (bare !== registrableDomain(bare)) {
    scope = 'host_only';
    variants = [`https://${H}`, `http://${H}`];
  } else {
    scope = 'apex_www';
    variants = [`https://${bare}`, `https://${wwwHost}`, `http://${bare}`, `http://${wwwHost}`];
  }
  const variantHosts = new Set(variants.map((v) => new URL(v).host));

  // R-1.2-2 candidate set
  const declaredRaw = ctx.robots?.parsed?.sitemaps || ctx.robots?.tolerant?.sitemaps || [];
  const seen = new Set();
  const declared = [];
  for (const s of declaredRaw) {
    const v = String(s.value || '').trim();
    if (!isAbsoluteHttpUrl(v)) {
      declared.push({ url: v, source: 'robots_txt', class: 'INVALID' });
      continue;
    }
    const n = normalizeUrl(v);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    if (declared.filter((d) => d.class !== 'INVALID').length >= cfg.sitemap.max_paths) continue;
    declared.push({ url: n, written: v, source: 'robots_txt', class: variantHosts.has(new URL(n).host) ? 'SAME_DOMAIN' : 'CROSS_HOST' });
  }
  // Standard locations, probed in this order after any Sitemap: directive in robots.txt.
  const FIXED_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml'];
  const fixed = FIXED_PATHS.map((p) => ({ url: `${ctx.canonicalOrigin}${p}`, source: 'fixed_path', class: 'SAME_DOMAIN' }));
  const candidates = [...declared, ...fixed.filter((f) => !declared.some((d) => d.url === f.url))];

  // Build ordered cell list per R-1.2-9 spend order.
  const cells = [];
  const cellKey = new Set();
  const addCell = (cand, reqUrl, variant) => {
    const k = reqUrl;
    if (cellKey.has(k)) {
      cells.push({ cand, request_url: reqUrl, variant, dup: true });
      return;
    }
    cellKey.add(k);
    cells.push({ cand, request_url: reqUrl, variant });
  };
  const pathOfUrl = (u) => {
    const x = new URL(u);
    return x.pathname + x.search;
  };
  const sameDecl = declared.filter((d) => d.class === 'SAME_DOMAIN');
  for (const d of sameDecl) addCell(d, d.url, new URL(d.url).origin);
  for (const f of candidates.filter((c) => c.source === 'fixed_path')) addCell(f, f.url, ctx.canonicalOrigin);
  for (const c of candidates.filter((x) => x.class === 'SAME_DOMAIN')) for (const v of variants) addCell(c, `${v}${pathOfUrl(c.url)}`, v);
  for (const d of declared.filter((x) => x.class === 'CROSS_HOST')) addCell(d, d.url, new URL(d.url).origin);

  let used = 0;
  const hostUp = new Map(); // host → true if answered on any scheme
  const results = new Map(); // request_url → cell result
  for (const cell of cells) {
    if (cell.dup) continue;
    if (used >= cfg.sitemap.max_requests) {
      results.set(cell.request_url, { verdict: 'INCONCLUSIVE', variant_failure: 'CAP_REACHED', chain: [], final_status: null, final_url: null });
      continue;
    }
    ctx.emit('fetch', { url: cell.request_url, purpose: 'sitemap variant' });
    const rec = await http.fetch(cell.request_url, { budgetClass: 'secondary', exempt: true, discardBody: true, headers: { accept: 'application/xml,text/xml,*/*;q=0.5' } });
    used += Math.max(1, rec.attempts.length);
    if (rec.status != null) hostUp.set(new URL(cell.request_url).hostname, true);
    results.set(cell.request_url, classifyCell(rec));
  }
  // Second pass: CONNECT_TIMEOUT_HOST_UP needs knowledge of the other scheme's answer.
  for (const [u, r] of results) {
    if (r.variant_failure === 'CONNECT_TIMEOUT' && hostUp.get(new URL(u).hostname)) {
      r.variant_failure = 'CONNECT_TIMEOUT_HOST_UP';
      r.verdict = 'NOT_OPEN';
    }
  }
  if (used >= cfg.sitemap.max_requests) ctx.flags.add('SITEMAP_REQUEST_CAP');

  // Assemble per-candidate matrices
  const matrix = [];
  const candOut = [];
  for (const c of candidates) {
    const rows = cells.filter((x) => x.cand === c).map((x) => ({ ...x, r: results.get(x.request_url) }));
    const uniq = new Map();
    for (const row of rows) if (row.r && !uniq.has(row.request_url)) uniq.set(row.request_url, row);
    const list = [...uniq.values()];
    const reachable = list.some((row) => row.r.verdict === 'OPEN');
    candOut.push({ url: c.url, source: c.source, class: c.class, reachable, cells: list });
    for (const row of list) {
      matrix.push({
        path: c.class === 'CROSS_HOST' ? c.url : pathOfUrl(c.url),
        candidate: c.url,
        variant: row.variant,
        request_url: row.request_url,
        chain: row.r.chain,
        final_url: row.r.final_url,
        final_status: row.r.final_status,
        hop_count: row.r.hop_count,
        final_path_differs: row.r.final_url ? new URL(row.r.final_url).pathname !== new URL(row.request_url).pathname : false,
        final_off_domain: row.r.final_url ? !variantHosts.has(new URL(row.r.final_url).host) : false,
        http_200_no_upgrade: row.request_url.startsWith('http://') && row.r.final_status === 200 && String(row.r.final_url).startsWith('http://'),
        verdict: row.r.verdict,
        variant_failure: row.r.variant_failure,
      });
    }
  }
  for (const c of declared.filter((d) => d.class === 'INVALID')) candOut.push({ url: c.url, source: 'robots_txt', class: 'INVALID', reachable: false, cells: [] });

  const located = candOut.filter((c) => c.reachable && c.class !== 'INVALID');

  const canonicalHost = new URL(ctx.canonicalOrigin).host;
  ctx.derived.sitemapAccess = {
    variant_scope: scope,
    candidates: candOut.map(({ url, source, class: cls, reachable }) => ({ url, source, class: cls, reachable })),
    located_sitemaps: located.map((c) => c.url),
    matrix,
    requests_used: used,
    caps_hit: used >= cfg.sitemap.max_requests ? ['SITEMAP_MAX_REQUESTS'] : [],
  };

  // CONDITIONS (first matching status-bearing row wins)
  const b = new ResultBuilder(ctx, 'C-1.2', { scope: 'site', target_url: `${ctx.canonicalOrigin}/`, mode: 'first' });
  const cellEv = (m) => ev({ kind: 'http_status', source_url: m.request_url, fetch_profile: 'RAW', selector_or_key: `final status (${m.variant})`, observed_value: m.final_status == null ? null : String(m.final_status), expected_value: '200' });
  const anyInconclusive = matrix.some((m) => m.verdict === 'INCONCLUSIVE');
  const sameLocated = located.filter((c) => c.class === 'SAME_DOMAIN');
  const crossOpen = located.filter((c) => c.class === 'CROSS_HOST');
  b.metric('variant_scope', scope).metric('located', located.map((c) => c.url)).metric('requests_used', used);

  // A declared sitemap that is definitively broken: 4xx/5xx or a network failure on every variant.
  // Inconclusive cells are excluded, because an unanswered request is not evidence of absence.
  const brokenDeclared = candOut.filter((c) => c.source === 'robots_txt' && c.class === 'SAME_DOMAIN'
    && !c.reachable && c.cells.length && c.cells.every((x) => x.r.verdict === 'NOT_OPEN'));

  // A standard-location probe that answered with a server error, or whose redirect chain resolved
  // into a failure, is an endpoint that exists and does not serve. A clean 404 is not that: it
  // means no sitemap is published there, which is the "not found" case and only ever a warning.
  const hardBroken = matrix.filter((m) => m.verdict === 'NOT_OPEN'
    && (m.variant_failure === 'HTTP_5XX' || (m.hop_count > 0 && m.variant_failure === 'HTTP_4XX')));

  if (located.length) {
    // Something serves. Nothing about the other variants can turn that into a failure.
    if (brokenDeclared.length) {
      // One declared sitemap is dead while another parent sitemap serves: the setup is usable, but
      // robots.txt is pointing at something that is not there.
      b.hit('C-1.2-j', {
        summary: `${brokenDeclared.length} declared sitemap(s) are unavailable (${brokenDeclared.map((c) => `${c.url} - ${[...new Set(c.cells.map((x) => x.r.variant_failure))].join(', ')}`).join('; ')}), but ${located.map((c) => c.url).join(', ')} returns 200.`,
        evidence: matrix.filter((m) => brokenDeclared.some((c) => c.url === m.candidate)).slice(0, 8).map(cellEv),
      });
    }
  } else if (brokenDeclared.length) {
    // robots.txt declares a sitemap, it is definitively broken, and nothing else serves.
    b.hit('C-1.2-c', {
      summary: `robots.txt declares ${brokenDeclared.map((c) => c.url).join(', ')} and no declared or standard-location parent sitemap returns 200 (${[...new Set(brokenDeclared.flatMap((c) => c.cells.map((x) => x.r.variant_failure)))].join(', ')}).`,
      evidence: matrix.filter((m) => brokenDeclared.some((c) => c.url === m.candidate)).slice(0, 8).map(cellEv),
    });
  } else if (hardBroken.length) {
    // Nothing was declared in robots.txt, but a standard location answered and answered badly: a
    // 5xx, or a redirect chain that resolved to a failure. The endpoint exists and does not serve.
    // That is different from "there is no sitemap here", which a clean 404 would mean.
    b.hit('C-1.2-k', {
      summary: `A sitemap endpoint responds but never reaches a successful response: ${hardBroken.map((m) => `${m.request_url} -> ${m.final_status ?? m.variant_failure}`).join('; ')}.`,
      evidence: hardBroken.slice(0, 8).map(cellEv),
    });
  } else if (anyInconclusive) {
    // Nothing located, but the tool could not complete its own checks: absence is not established.
    b.hit('C-1.2-g', {
      summary: `No parent sitemap located, but ${matrix.filter((m) => m.verdict === 'INCONCLUSIVE').length} request(s) were inconclusive (${[...new Set(matrix.filter((m) => m.verdict === 'INCONCLUSIVE').map((m) => m.variant_failure))].join(', ')}), so absence cannot be concluded (F-1.2-2).`,
      evidence: matrix.filter((m) => m.verdict === 'INCONCLUSIVE').slice(0, 8).map(cellEv),
    });
  } else if (!crossOpen.length) {
    // Nothing declared, nothing at any standard location, and every request answered cleanly.
    // Absent is not broken: Google does not require a sitemap, so this is a low warning.
    b.hit('C-1.2-b', {
      summary: `No parent sitemap found: robots.txt declares none, and none of ${FIXED_PATHS.join(', ')} returned 200. A sitemap is not required, but it is the most direct way to tell a crawler which URLs matter.`,
      evidence: matrix.slice(0, 8).map(cellEv),
    });
  }

  if (!sameLocated.length && crossOpen.length) {
    b.hit('C-1.2-e', { summary: `No same-domain sitemap returns 200; a cross-host declared sitemap is open (${crossOpen.map((c) => c.url).join(', ')}). Cross-host submission is valid only when both hosts are verified in the same Search Console account, which this tool cannot confirm.` });
  }

  // Notes: recorded, never scored.
  // Everything below is variant detail. It is useful to see and must not change the status: the
  // sitemap either serves or it does not, and none of this says whether it serves.
  const openCellsAll = matrix.filter((m) => m.verdict === 'OPEN');
  const distinctOpen = [...new Set(openCellsAll.map((m) => m.request_url))];
  const offCanonical = openCellsAll.filter((m) => m.final_url && new URL(m.final_url).host !== canonicalHost);
  if (offCanonical.length) {
    b.note('SITEMAP_VARIANT_NOT_CANONICAL', `${offCanonical.length} variant(s) answer 200 on a host other than the canonical ${canonicalHost}: ${offCanonical.map((m) => `${m.request_url} -> ${m.final_url}`).join('; ')}. Recorded only: hostname consolidation is assessed under C-1.4 and C-1.5.`, offCanonical.slice(0, 6).map(cellEv));
    b.xref('C-1.4');
  }
  if (distinctOpen.length > 1) {
    b.note('SITEMAP_MULTIPLE_ADDRESSES', `The sitemap answers 200 at ${distinctOpen.length} addresses (${distinctOpen.join(', ')}). Recorded only: serving a sitemap at several addresses is not a sitemap failure.`);
  }
  const variantFails = matrix.filter((m) => m.verdict === 'NOT_OPEN' && located.some((c) => c.url === m.candidate));
  if (variantFails.length) {
    const dnsFix = variantFails.some((m) => m.variant_failure === 'DNS_UNRESOLVED') ? ' Where a variant has no DNS record, the fix is at DNS/origin level: create the record and 301 it to the canonical host (see C-1.4).' : '';
    b.note('SITEMAP_VARIANT_UNAVAILABLE', `A parent sitemap serves, but ${variantFails.length} optional variant(s) do not return 200: ${variantFails.map((m) => `${m.request_url} (${m.variant_failure})`).join('; ')}.${dnsFix} Recorded only.`, variantFails.slice(0, 6).map(cellEv));
  }
  // Running out of request budget after a sitemap has already been confirmed leaves the variant
  // picture incomplete, not the sitemap unproven. The result stays PASS and says what is missing.
  const reachableInconclusive = matrix.filter((m) => m.verdict === 'INCONCLUSIVE' && located.some((c) => c.url === m.candidate));
  if (located.length && reachableInconclusive.length) {
    b.note('VARIANT_CHECK_INCOMPLETE', `A parent sitemap returned 200; ${reachableInconclusive.length} optional variant check(s) did not complete (${[...new Set(reachableInconclusive.map((m) => m.variant_failure))].join(', ')}). The sitemap result is unaffected.`, reachableInconclusive.slice(0, 6).map(cellEv));
  }
  const invalid = declared.filter((d) => d.class === 'INVALID');
  if (invalid.length) b.note('SITEMAP_DECLARATION_INVALID', `${invalid.length} Sitemap: value(s) in robots.txt are not absolute http(s) URLs and were not fetched: ${invalid.map((d) => d.url).join(', ')}`);
  if (matrix.some((m) => m.http_200_no_upgrade)) b.xref('C-1.3');

  const openCells = matrix.filter((m) => m.verdict === 'OPEN');
  b.addEvidence(...openCells.slice(0, 8).map(cellEv));
  if (!b.hits.length) b.pass(`Parent sitemap located and serving: ${located.map((c) => c.url).join(', ')} returns HTTP 200.`);
  return b.build();
}

function classifyCell(rec) {
  const out = { verdict: 'NOT_OPEN', variant_failure: null, chain: rec.chain.map((h) => ({ url: h.url, status: h.status, location: h.location })), final_status: rec.status, final_url: rec.final_url, hop_count: rec.hop_count || 0 };
  if (rec.terminal === 'REDIRECT_LOOP') return { ...out, variant_failure: 'REDIRECT_LOOP' };
  if (rec.terminal === 'REDIRECT_HOPS_EXCEEDED') return { ...out, variant_failure: 'REDIRECT_HOPS_EXCEEDED' };
  if (rec.terminal === 'MALFORMED_REDIRECT') return { ...out, variant_failure: 'MALFORMED_REDIRECT' };
  if (rec.bot_protection) return { ...out, verdict: 'INCONCLUSIVE', variant_failure: 'BOT_PROTECTION' };
  if (rec.status == null) {
    const k = rec.error?.kind;
    if (k === 'dns_nxdomain') return { ...out, variant_failure: 'DNS_UNRESOLVED' };
    if (k === 'dns_error') return { ...out, verdict: 'INCONCLUSIVE', variant_failure: 'DNS_ERROR' };
    if (k === 'refused') return { ...out, variant_failure: 'CONNECTION_REFUSED' };
    if (k === 'tls') return { ...out, variant_failure: 'TLS_INVALID' };
    if (k === 'connect_timeout') return { ...out, verdict: 'INCONCLUSIVE', variant_failure: 'CONNECT_TIMEOUT' };
    return { ...out, verdict: 'INCONCLUSIVE', variant_failure: 'READ_TIMEOUT' };
  }
  const s = rec.status;
  if (s === 200) return { ...out, verdict: 'OPEN' };
  if (s >= 200 && s < 300) return { ...out, variant_failure: 'NON_200_SUCCESS' };
  if (s >= 300 && s < 400) return { ...out, variant_failure: 'HTTP_3XX_UNRESOLVED' };
  if (s === 401 || s === 403) return { ...out, verdict: 'INCONCLUSIVE', variant_failure: 'AUTH_DENIED' };
  if (s === 429) return { ...out, verdict: 'INCONCLUSIVE', variant_failure: 'RATE_LIMITED' };
  if (s === 451) return { ...out, verdict: 'INCONCLUSIVE', variant_failure: 'GEO_RESTRICTED' };
  if (s >= 400 && s < 500) return { ...out, variant_failure: 'HTTP_4XX' };
  return { ...out, variant_failure: 'HTTP_5XX' };
}

export { INCONCLUSIVE };
