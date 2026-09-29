// C-1.2 — XML Sitemap: Variant Reachability (site · RAW). Status lines only: bodies are never read
// (F-1.2-3); http:// is sent as plain HTTP with no HSTS/upgrade (R-1.2-5, F-1.2-4).
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
  const fixed = ['/sitemap.xml', '/sitemap_index.xml'].map((p) => ({ url: `${ctx.canonicalOrigin}${p}`, source: 'fixed_path', class: 'SAME_DOMAIN' }));
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

  // ── Operator rule: every variant must converge on the canonical host ──────
  // The PRD stops at reachability (R-1.2-6) and F-1.2-6 forbids changing this check's status for
  // non-converging final URLs. The operator requires more: a variant may answer 200, but it must do
  // so *at* the canonical host, reaching it by redirect where needed. A sitemap served directly on
  // both www and non-www is the same file live at two addresses, which is what the www/non-www
  // decision exists to prevent. Enabled by sitemap.require_canonical_host.
  const canonicalHost = new URL(ctx.canonicalOrigin).host;
  const hostMismatches = cfg.sitemap.require_canonical_host
    ? matrix.filter((m) => m.verdict === 'OPEN' && m.final_url && new URL(m.final_url).host !== canonicalHost)
    : [];
  ctx.derived.sitemapAccess = {
    variant_scope: scope,
    candidates: candOut.map(({ url, source, class: cls, reachable }) => ({ url, source, class: cls, reachable })),
    located_sitemaps: located.map((c) => c.url),
    matrix,
    requests_used: used,
    caps_hit: used >= cfg.sitemap.max_requests ? ['SITEMAP_MAX_REQUESTS'] : [],
  };

  // ── CONDITIONS (first matching status-bearing row wins) ───────────────────
  const b = new ResultBuilder(ctx, 'C-1.2', { scope: 'site', target_url: `${ctx.canonicalOrigin}/`, mode: 'first' });
  const cellEv = (m) => ev({ kind: 'http_status', source_url: m.request_url, fetch_profile: 'RAW', selector_or_key: `final status (${m.variant})`, observed_value: m.final_status == null ? null : String(m.final_status), expected_value: '200' });
  const anyInconclusive = matrix.some((m) => m.verdict === 'INCONCLUSIVE');
  const sameLocated = located.filter((c) => c.class === 'SAME_DOMAIN');
  const crossOpen = located.filter((c) => c.class === 'CROSS_HOST');
  b.metric('variant_scope', scope).metric('located', located.map((c) => c.url)).metric('requests_used', used);

  if (!located.length && !anyInconclusive) {
    b.hit('C-1.2-b', { summary: `No sitemap located: no declared Sitemap: URL and neither /sitemap.xml nor /sitemap_index.xml returned 200 on any ${scope} variant.`, evidence: matrix.slice(0, 8).map(cellEv) });
  }
  const unreachableDeclared = candOut.filter((c) => c.class === 'SAME_DOMAIN' && c.source === 'robots_txt' && !c.reachable && c.cells.length && c.cells.every((x) => x.r.verdict === 'NOT_OPEN'));
  if (unreachableDeclared.length) {
    b.hit('C-1.2-c', { summary: `${unreachableDeclared.length} sitemap URL(s) declared in robots.txt return no 200 on any variant: ${unreachableDeclared.map((c) => c.url).join(', ')}`, evidence: matrix.filter((m) => unreachableDeclared.some((c) => c.url === m.candidate)).map(cellEv) });
  }
  const variantFails = matrix.filter((m) => m.verdict === 'NOT_OPEN' && located.some((c) => c.url === m.candidate));
  if (variantFails.length) {
    const dnsFix = variantFails.some((m) => m.variant_failure === 'DNS_UNRESOLVED') ? ' Where a variant has no DNS record, the fix is at DNS/origin level: create the record and 301 it to the canonical host (see C-1.4).' : '';
    b.hit('C-1.2-d', {
      summary: `Sitemap reachable, but ${variantFails.length} variant cell(s) do not return 200: ${variantFails.map((m) => `${m.request_url} (${m.variant_failure})`).join('; ')}.${dnsFix}`,
      evidence: variantFails.map(cellEv),
      cross_references: variantFails.some((m) => m.variant_failure === 'DNS_UNRESOLVED') ? ['C-1.4'] : [],
    });
  }
  if (!sameLocated.length && crossOpen.length) {
    b.hit('C-1.2-e', { summary: `No same-domain sitemap returns 200; a cross-host declared sitemap is open (${crossOpen.map((c) => c.url).join(', ')}). Cross-host submission is valid only when both hosts are verified in the same Search Console account, which this tool cannot confirm.` });
  }
  const reachableInconclusive = matrix.filter((m) => m.verdict === 'INCONCLUSIVE' && located.some((c) => c.url === m.candidate));
  if (located.length && !variantFails.length && reachableInconclusive.length) {
    b.hit('C-1.2-f', { summary: `Sitemap reachable; ${reachableInconclusive.length} variant cell(s) inconclusive (${[...new Set(reachableInconclusive.map((m) => m.variant_failure))].join(', ')}).`, evidence: reachableInconclusive.map(cellEv) });
  }
  if (!located.length && anyInconclusive) {
    b.hit('C-1.2-g', { summary: `No sitemap located, but ${matrix.filter((m) => m.verdict === 'INCONCLUSIVE').length} cell(s) were inconclusive, so absence cannot be concluded (F-1.2-2).`, evidence: matrix.filter((m) => m.verdict === 'INCONCLUSIVE').map(cellEv) });
  }
  const invalid = declared.filter((d) => d.class === 'INVALID');
  if (invalid.length) b.note('SITEMAP_DECLARATION_INVALID', `${invalid.length} Sitemap: value(s) in robots.txt are not absolute http(s) URLs and were not fetched: ${invalid.map((d) => d.url).join(', ')}`);
  if (matrix.some((m) => m.http_200_no_upgrade)) b.xref('C-1.3');
  if (new Set(matrix.filter((m) => m.verdict === 'OPEN').map((m) => m.final_url)).size > 1) b.xref('C-1.4');

  if (hostMismatches.length) {
    const byHost = [...new Set(hostMismatches.map((m) => new URL(m.final_url).host))];
    b.hit('C-1.2-d', {
      status: 'FAIL',
      severity: 'HIGH',
      reason_code: 'SITEMAP_VARIANT_HOST_MISMATCH',
      summary: `${hostMismatches.length} variant(s) answer 200 on a host other than the canonical ${canonicalHost} (${byHost.join(', ')}) instead of redirecting to it. The sitemap is therefore live at more than one address: ${hostMismatches.map((m) => `${m.request_url} → ${m.final_url}`).join('; ')}.`,
      evidence: hostMismatches.map((m) => ev({ kind: 'http_status', source_url: m.request_url, fetch_profile: 'RAW', selector_or_key: `final URL after ${m.hop_count} hop(s)`, observed_value: `${m.final_status} ${m.final_url}`, expected_value: `200 at ${canonicalHost}` })),
      cross_references: ['C-1.4', 'C-1.5'],
      // One file served at two hosts is the duplicate-URL situation Google's canonicalisation
      // guidance addresses, and G5 documents where a sitemap is expected to live. Both are already
      // registered; they are cited here because they speak to this condition.
      sourceRefs: ['G7', 'G5'],
    });
    b.caveat('Canonical-host convergence is an operator rule layered on the PRD, which scores this check on reachability alone (F-1.2-6). Disable it with sitemap.require_canonical_host = false.');
  }

  const openCells = matrix.filter((m) => m.verdict === 'OPEN');
  b.addEvidence(...openCells.slice(0, 8).map(cellEv));
  if (!b.hits.length) b.pass(`Sitemap located (${located.map((c) => c.url).join(', ')}); every ${scope} variant returns 200 and converges on ${canonicalHost}.`);
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
