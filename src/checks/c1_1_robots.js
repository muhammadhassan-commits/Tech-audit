// C-1.1 — robots.txt (site · RAW · depends on A.2). The pipeline's entry check and gate.
import { ResultBuilder, ev } from '../engine/result.js';
import { parseRobots, evaluate, tolerantScan, disallowPrefixes } from '../parse/robots.js';
import { bodyText } from '../net/http.js';
import { hostOf, normalizeUrl, originOf } from '../parse/url.js';
import { AI_AGENTS } from './ai_agents.js';

/** Fetch robots.txt exactly once (no_cache), classify its state, and evaluate C-1.1 site-level rows. */
export async function acquireAndEvaluate(ctx) {
  const { http, cfg } = ctx;
  const url = `${ctx.canonicalOrigin}/robots.txt`;
  ctx.emit('fetch', { url, purpose: 'robots.txt' });
  const rec = await http.fetch(url, { budgetClass: 'secondary', exempt: true, noCache: true, headers: { accept: 'text/plain,*/*;q=0.5' } });
  const robots = { url, record: rec, parsed: null, state: null, text: '', tolerant: null, http_only: null };
  ctx.robots = robots;

  const status = rec.status;
  const ct = String(rec.headers?.['content-type'] || '');
  const hops = rec.hop_count || 0;

  if (status == null || status >= 500 || status === 429) {
    robots.state = 'UNAVAILABLE';
    // B-1.1-2 — HTTPS timeout: one retry on HTTP for the same host; never treated as governing HTTPS.
    if (url.startsWith('https://') && (rec.error?.kind === 'timeout' || rec.error?.kind === 'connect_timeout')) {
      const httpUrl = url.replace(/^https:/, 'http:');
      const alt = await http.fetch(httpUrl, { budgetClass: 'secondary', exempt: true, noCache: true });
      if (alt.status >= 200 && alt.status < 300) robots.http_only = { url: httpUrl, status: alt.status };
    }
  } else if (hops > cfg.th.robots_max_redirect_hops) {
    robots.state = 'REDIRECT_CHAIN'; // C-A2-g: treated as 404 (no restrictions)
  } else if (status >= 400) {
    robots.state = 'ABSENT';
  } else if (status >= 200 && status < 300) {
    const text = bodyText(rec);
    robots.text = text;
    if (/text\/html/i.test(ct) || /<html[\s>]/i.test(text.slice(0, 4000))) {
      robots.state = 'HTML';
      robots.tolerant = tolerantScan(text); // B-1.1-3 — feeds discovery/C-1.2 only
    } else {
      robots.state = 'OK';
      robots.parsed = parseRobots(rec.body, { maxBytes: cfg.th.robots_max_bytes });
    }
  } else {
    robots.state = 'UNAVAILABLE';
  }
  robots.cross_host = rec.final_url && hostOf(rec.final_url) !== hostOf(url);
  ctx.derived.robotsDisallowFolders = robots.parsed ? disallowPrefixes(robots.parsed) : [];
  return evaluateC11(ctx, {});
}

export function finalizeWithSample(ctx, prior) {
  if (!ctx.robots || prior.status === 'ERROR') return prior;
  return evaluateC11(ctx, { withSample: true });
}

function evaluateC11(ctx, { withSample }) {
  const { robots, cfg } = ctx;
  const rec = robots.record;
  const b = new ResultBuilder(ctx, 'C-1.1', { scope: 'site', target_url: robots.url });
  const statusEv = ev({ kind: 'http_status', source_url: robots.url, fetch_profile: 'RAW', selector_or_key: 'status', observed_value: rec.status == null ? null : String(rec.status), elapsed_ms: rec.elapsed_ms, stall_stage: rec.stall_stage });
  const ctEv = ev({ kind: 'http_header', source_url: robots.url, fetch_profile: 'RAW', selector_or_key: 'Content-Type', observed_value: rec.headers?.['content-type'] ?? null });
  b.addEvidence(statusEv, ctEv);
  if (rec.chain.length > 1) b.addEvidence(ev({ kind: 'http_header', source_url: robots.url, fetch_profile: 'RAW', selector_or_key: 'redirect_chain', observed_value: rec.chain.map((h) => `${h.status} ${h.url}${h.location ? ' → ' + h.location : ''}`).join(' | ') }));
  b.metric('state', robots.state).metric('bytes', rec.bytes).metric('hops', rec.hop_count || 0);

  if (robots.cross_host) b.note('ROBOTS_CROSS_HOST', `robots.txt is served from a different host via redirect (${rec.final_url}); its rules govern a host that does not serve them (E-A2-1).`);
  if (robots.http_only) b.note('ROBOTS_HTTP_ONLY', `HTTPS robots.txt timed out; ${robots.http_only.url} answered ${robots.http_only.status}. The HTTP file does not govern the HTTPS origin (B-1.1-2).`);

  switch (robots.state) {
    case 'UNAVAILABLE':
      b.hit('C-1.1-d', {
        summary: rec.status == null
          ? `robots.txt unavailable — no HTTP status received (${rec.error?.code || 'network error'}, stalled at ${rec.stall_stage || 'unknown'} after ${rec.elapsed_ms} ms). Google treats an unreachable robots.txt as crawl-blocking.`
          : `robots.txt returned HTTP ${rec.status}. Google pauses crawling and falls back to a cached copy; an unavailable robots.txt is a crawl-blocking condition.`,
        evidence: [statusEv],
      });
      return b.build();
    case 'REDIRECT_CHAIN':
      b.hit('C-1.1-g', { summary: `robots.txt redirect chain has ${rec.hop_count} hops (> ${cfg.th.robots_max_redirect_hops}); Google treats this as 404, i.e. no restrictions.`, evidence: [statusEv] });
      b.hit('C-1.1-f', { summary: 'Treated as absent after the redirect-chain limit: no restrictions apply.', evidence: [statusEv] });
      return b.build();
    case 'ABSENT':
      b.hit('C-1.1-f', {
        summary: `robots.txt returned HTTP ${rec.status}: Google treats this as no restrictions. Advisory: publish an explicit robots.txt file.`,
        evidence: [statusEv],
      });
      return b.build();
    case 'HTML':
      b.hit('C-1.1-e', {
        summary: 'robots.txt returns HTML instead of plain-text directives; no valid directives exist, so crawlers treat it as unrestricted.',
        evidence: [ev({ kind: 'file_content', source_url: robots.url, fetch_profile: 'RAW', selector_or_key: 'body[0:300]', observed_value: robots.text.slice(0, 300) }), ctEv],
      });
      return b.build();
    default:
      break;
  }

  const p = robots.parsed;
  const text = robots.text;
  b.addEvidence(ev({ kind: 'file_content', source_url: robots.url, fetch_profile: 'RAW', selector_or_key: 'body', observed_value: text }));

  // R-1.1-4 verdict matrix
  const matrixAgents = ['Googlebot', 'Googlebot-Image', '*', ...AI_AGENTS.map((a) => a.token)];
  const matrix = matrixAgents.map((agent) => {
    const token = agent === '*' ? '__catchall__' : agent;
    const v = evaluate(p, token, '/');
    const g = agent === '*' ? p.byToken.get('*') : null;
    const groupRules = (agent === '*' ? g : selectFor(p, agent))?.rules || [];
    return { agent, root: v.verdict, via: v.token, disallow_rules: groupRules.filter((r) => r.type === 'disallow' && r.path).length };
  });
  b.metric('verdict_matrix', matrix);
  b.metric('groups', p.validGroupCount).metric('sitemaps', p.sitemaps.map((s) => s.value));

  const gb = evaluate(p, 'googlebot', '/');
  const allCatch = p.byToken.get('*');
  if (gb.verdict === 'DISALLOWED') {
    const rulesEv = ev({ kind: 'file_content', source_url: robots.url, fetch_profile: 'RAW', selector_or_key: `line ${gb.rule.line_no}`, observed_value: `${gb.rule.type}: ${gb.rule.path} (group: ${gb.token})`, expected_value: 'Googlebot allowed on /' });
    if (cfg.env === 'staging') {
      b.hit('C-1.1-l', { status: 'WARN', severity: 'LOW', reason_code: 'STAGING_BLOCK_EXPECTED', summary: 'Disallow: / applies to Googlebot on a host the operator declared as staging (E-1.1-12).', evidence: [rulesEv] });
    } else {
      b.hit('C-1.1-b', { summary: `Disallow: / applies to Googlebot via the "${gb.token}" group (line ${gb.rule.line_no}). Crawling of the site is blocked.`, evidence: [rulesEv] });
    }
  }
  if (rec.bytes > cfg.th.robots_max_bytes || p.oversize) b.hit('C-1.1-h', { summary: `robots.txt is ${rec.bytes} bytes; content beyond ${cfg.th.robots_max_bytes} bytes (500 KiB) is ignored.`, evidence: [statusEv] });
  const malformed = p.lineClasses.filter((l) => l.class === 'IGNORED_MALFORMED');
  if (malformed.length) b.hit('C-1.1-i', { summary: `${malformed.length} malformed line(s) are ignored by parsers.`, evidence: malformed.slice(0, 10).map((l) => ev({ kind: 'file_content', source_url: robots.url, fetch_profile: 'RAW', selector_or_key: `line ${l.line_no}`, observed_value: l.raw })) });
  const unsupported = p.lineClasses.filter((l) => l.class === 'UNSUPPORTED_BY_GOOGLE');
  if (unsupported.length) {
    b.hit('C-1.1-j', {
      summary: `${unsupported.length} directive(s) Google does not support (${[...new Set(unsupported.map((u) => u.field))].join(', ')}); they have no effect on Googlebot.${unsupported.some((u) => u.field === 'noindex') ? ' A robots.txt noindex is not an indexing control (F-A2-3).' : ''}`,
      evidence: unsupported.slice(0, 10).map((l) => ev({ kind: 'file_content', source_url: robots.url, fetch_profile: 'RAW', selector_or_key: `line ${l.line_no}`, observed_value: l.raw })),
    });
  }
  if (!/^text\//i.test(String(rec.headers?.['content-type'] || ''))) b.caveat(`Content-Type is "${rec.headers?.['content-type'] || 'absent'}", not text/plain; the body parsed as robots.txt.`);
  if (!text.replace(/#.*$/gm, '').trim()) b.note('ROBOTS_EMPTY', 'robots.txt is empty or comment-only: no rules, everything allowed (E-1.1-8/9).');
  if (p.encodingIssue) b.note('ROBOTS_ENCODING', 'Non-UTF-8 bytes were decoded with replacement characters (E-1.1-7).');
  const signals = [...p.fileContentSignals, ...[...p.byToken.values()].flatMap((g) => g.content_signals)];
  if (signals.length) b.metric('content_signals', signals.map((s) => s.raw)); // R-1.1-7, fed to C-5.1

  if (withSample) {
    // C-1.1-c — sampled URLs disallowed for Googlebot; discovery exclusions are evidence (R-1.1-5).
    const blocked = (ctx.sample?.pages || []).filter((pg) => ctx.robotsAllowed('googlebot', pg.url).verdict === 'DISALLOWED');
    if (blocked.length) {
      b.hit('C-1.1-c', { summary: `${blocked.length} URL(s) in the audit page set are disallowed for Googlebot.`, evidence: blocked.map((pg) => ev({ kind: 'computed', source_url: pg.url, selector_or_key: 'robots verdict (googlebot)', observed_value: 'DISALLOWED' })) });
    }
    const excluded = ctx.discovery?.robots_blocked_candidates || [];
    if (excluded.length) b.note('ROBOTS_BLOCKS_AUDITED_URL', `${excluded.length} discovered candidate URL(s) were excluded from the sample because robots.txt disallows them for Googlebot (R-A2-3).`, excluded.slice(0, 10).map((u) => ev({ kind: 'computed', source_url: u, selector_or_key: 'robots verdict (googlebot)', observed_value: 'DISALLOWED' })));
    // C-1.1-k — Disallow matching JS/CSS assets referenced by sampled pages.
    const assets = new Set();
    for (const pg of ctx.pages) {
      const $ = pg.rawFacts?.$;
      if (!$) continue;
      $('script[src], link[rel~=stylesheet][href]').each((_, el) => {
        const u = normalizeUrl($(el).attr('src') || $(el).attr('href'), pg.finalUrl || pg.url);
        if (u && originOf(u) === ctx.canonicalOrigin) assets.add(u);
      });
    }
    const blockedAssets = [...assets].filter((u) => ctx.robotsAllowed('googlebot', u).verdict === 'DISALLOWED');
    if (blockedAssets.length) {
      b.hit('C-1.1-k', { summary: `${blockedAssets.length} JS/CSS resource(s) referenced by sampled pages are disallowed for Googlebot; rendering may be incomplete.`, evidence: blockedAssets.slice(0, 10).map((u) => ev({ kind: 'computed', source_url: u, selector_or_key: 'robots verdict (googlebot)', observed_value: 'DISALLOWED' })) });
    }
  }

  if (!b.hits.length) b.pass(`robots.txt returned ${rec.status}, parsed ${p.validGroupCount} group(s), and / is allowed for Googlebot${gb.token ? ` (effective group "${gb.token}")` : ' (no group applies)'}.`);
  if (!allCatch && gb.token) b.caveat('No User-agent: * group: non-Google agents, including the auditor, are unrestricted (E-A2-4).');
  return b.build();
}

function selectFor(parsed, agent) {
  const name = agent.toLowerCase();
  let best = null;
  for (const [token, g] of parsed.byToken) {
    if (token === '*') continue;
    if (name === token || name.startsWith(token + '-')) if (!best || token.length > best.token.length) best = g;
  }
  return best || parsed.byToken.get('*') || null;
}
