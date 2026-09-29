// A.0 — Target intake & normalisation (P0). Resolves canonical_origin from the probe order in
// R-A0-2 using status lines only; no page content is evaluated before the robots.txt gate.
import { originOf, normalizeUrl } from '../parse/url.js';
import { agentToken } from '../parse/robots.js';

export async function runIntake(ctx, seed) {
  const { http, cfg } = ctx;
  ctx.auditorToken = agentToken(cfg.net.user_agent_resolved.split('/')[0]) || 'wellowsauditbot';
  const port = seed.port ? `:${seed.port}` : '';

  // R-A0-2 probe order; for a www seed the apex variants are appended for the C-1.4 matrix.
  const probes = [];
  const add = (u, eligible = true) => {
    if (!probes.some((p) => p.url === u)) probes.push({ url: u, eligible });
  };
  add(`https://${seed.host}${port}/`);
  if (!seed.hadWww && !seed.port) add(`https://www.${seed.host}/`);
  add(`http://${seed.host}${seed.port ? port : ''}/`);
  if (!seed.hadWww && !seed.port) add(`http://www.${seed.host}/`);
  if (seed.hadWww && !seed.port) {
    add(`https://${seed.bareHost}/`, true);
    add(`http://${seed.bareHost}/`, true);
  }

  const variants = [];
  for (const p of probes) {
    ctx.emit('fetch', { url: p.url, purpose: 'origin probe' });
    const rec = await http.fetch(p.url, { budgetClass: 'secondary', exempt: true, discardBody: true, noCache: true });
    variants.push({
      url: p.url,
      final_url: rec.final_url,
      status: rec.status,
      hops: rec.hop_count || 0,
      chain: rec.chain,
      error: rec.error?.code || null,
      error_kind: rec.error?.kind || null,
      terminal: rec.terminal,
      tls: rec.tls,
      elapsed_ms: rec.elapsed_ms,
      eligible: p.eligible,
    });
  }
  ctx.derived.originVariants = variants;

  const ok = variants.filter((v) => v.eligible && v.status >= 200 && v.status < 300);
  let winner = ok[0] || null;
  const flags = ctx.flags;

  if (!winner) {
    if (variants.every((v) => v.error_kind === 'dns_nxdomain')) throw abort('SEED_DNS_FAILURE'); // F-RUN-1
    if (variants.some((v) => v.status === 401 || v.status === 403)) {
      ctx.notes.push({ kind: 'remediation', code: 'ACCESS_DENIED', text: 'The site requires allow-listing the auditor user-agent/IP (F-RUN-3).' });
      throw abort('ACCESS_DENIED');
    }
    // C-A0-d: no 2xx. F-RUN-2 applies when the seed 5xx/resets AND robots.txt is unreachable too.
    const responded = variants.find((v) => v.status != null);
    if (!responded) throw abort('ORIGIN_UNREACHABLE');
    const origin = originOf(responded.final_url);
    const robots = await http.fetch(`${origin}/robots.txt`, { budgetClass: 'secondary', exempt: true, discardBody: true, noCache: true });
    if (responded.status >= 500 && (robots.status == null || robots.status >= 500)) throw abort('ORIGIN_UNREACHABLE');
    winner = responded; // canonical_origin still set (F-A0-3); page selection will abort if the homepage is unselectable
    flags.add('HOMEPAGE_NON_2XX_AT_INTAKE');
  }

  const canonicalOrigin = originOf(winner.final_url);
  ctx.canonicalOrigin = canonicalOrigin;

  // C-A0-b: multiple probes reach 2xx without redirecting to one another.
  const liveOrigins = new Set(ok.map((v) => originOf(v.final_url)));
  const multipleLive = liveOrigins.size > 1;
  const consolidated = ok.length > 0 && variants.filter((v) => v.status != null).every((v) => originOf(v.final_url) === canonicalOrigin);

  // E-A0-1 deep seed: audit that URL as homepage-equivalent; control files still from canonical_origin.
  let homepageUrl = `${canonicalOrigin}/`;
  if (seed.isDeep) {
    flags.add('SCOPE_SUBPATH');
    homepageUrl = normalizeUrl(seed.path, canonicalOrigin) || homepageUrl;
  } else if (winner.final_url && originOf(winner.final_url) === canonicalOrigin) {
    // E-1.4-3 locale redirect on the homepage (/ → /en/): the redirect target is what is audited.
    homepageUrl = normalizeUrl(winner.final_url) || homepageUrl;
  }
  ctx.homepageUrl = homepageUrl;
  ctx.rootUrl = `${canonicalOrigin}/`;

  ctx.target = {
    seed: seed.raw,
    canonical_origin: canonicalOrigin,
    display_host: seed.host,
    origin_variants: variants.map(({ url, final_url, status, hops, error }) => ({ url, final_url, status, hops, error })),
    origin_consolidated: consolidated,
    multiple_live_origins: multipleLive,
    homepage_url: homepageUrl,
    site_shape: null,
    is_multilingual: null,
    multilingual_signals: [],
    render_strategy: null,
    env: ctx.cfg.env,
  };
  ctx.emit('target', { canonical_origin: canonicalOrigin, homepage_url: homepageUrl });
}

function abort(code) {
  const e = new Error(code);
  e.code = code;
  e.name = 'RunAbort';
  return Object.assign(e, { __abort: true });
}
