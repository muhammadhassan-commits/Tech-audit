// C-1.3 — HTTP Status Codes (page, all sampled + site · RAW).
import crypto from 'node:crypto';
import { ResultBuilder, ev, errorResult } from '../engine/result.js';
import { bodyText } from '../net/http.js';
import { extractFacts } from '../parse/html.js';
import { wordCount } from '../parse/text.js';
import { notRespondingText, notRespondingEvidence } from './_util.js';

const NOT_FOUND_TITLE = /(404|not found|page not found|error|no results)/i;
const NOT_FOUND_LEXICON = /(page (you('| a)re looking for|you requested) (could not|cannot|can't|was not|wasn't) (be )?found|this page (does not|doesn't) exist|404 error|page not found|nothing (was )?found|no longer available|sorry, we couldn'?t find)/i;

export async function getProbe(ctx) {
  if (ctx.derived.probe404) return ctx.derived.probe404;
  const url = `${ctx.canonicalOrigin}/${crypto.randomBytes(16).toString('hex')}-audit-404-probe`;
  ctx.emit('fetch', { url, purpose: '404 probe' });
  const rec = await ctx.http.fetch(url, { budgetClass: 'secondary', noCache: true });
  const html = bodyText(rec);
  ctx.derived.probe404 = { url, rec, html, hash: crypto.createHash('sha256').update(html).digest('hex') };
  return ctx.derived.probe404;
}

export async function run(ctx) {
  const out = [];
  let probe = null;
  try {
    probe = await getProbe(ctx);
  } catch {
    /* probe failure only affects C-1.3-e / soft-404 byte comparison */
  }

  // ── Site-level: 404 handling, TLS, http→https ──────────────────────────
  try {
    const b = new ResultBuilder(ctx, 'C-1.3', { scope: 'site', target_url: `${ctx.canonicalOrigin}/` });
    if (probe?.rec.terminal === 'BLOCKED_BY_ROBOTS_FOR_AUDITOR') {
      b.note('BLOCKED_BY_ROBOTS_FOR_AUDITOR', '404 probe path is disallowed for the auditor; error handling not tested.');
    } else if (probe?.rec.status != null) {
      const pev = ev({ kind: 'http_status', source_url: probe.url, fetch_profile: 'RAW', selector_or_key: 'status', observed_value: String(probe.rec.status), expected_value: '404 or 410' });
      b.addEvidence(pev);
      if (probe.rec.status >= 200 && probe.rec.status < 300) {
        b.hit('C-1.3-e', { summary: `A URL guaranteed not to exist returned HTTP ${probe.rec.status} (soft-404 configuration).`, evidence: [pev] });
      }
    }
    const variants = ctx.derived.originVariants || [];
    const tlsBad = variants.filter((v) => v.url.startsWith('https://') && v.error_kind === 'tls');
    if (tlsBad.length && ctx.canonicalOrigin.startsWith('http://')) {
      b.hit('C-1.3-i', { summary: `HTTPS is unusable (${tlsBad.map((v) => `${v.url}: ${v.error}`).join('; ')}); the audit fell back to http:// (B-A0-2).`, evidence: tlsBad.map((v) => ev({ kind: 'http_status', source_url: v.url, fetch_profile: 'RAW', selector_or_key: 'tls', observed_value: v.error })) });
    }
    const httpLive = variants.filter((v) => v.url.startsWith('http://') && v.status === 200 && String(v.final_url).startsWith('http://'));
    if (httpLive.length) {
      b.hit('C-1.3-j', { summary: `Reachable on http:// with HTTP 200 and no redirect to https:// (${httpLive.map((v) => v.url).join(', ')}).`, evidence: httpLive.map((v) => ev({ kind: 'http_status', source_url: v.url, fetch_profile: 'RAW', selector_or_key: 'final_url', observed_value: `${v.status} ${v.final_url}`, expected_value: 'redirect to https://' })) });
    }
    const hp = variants.find((v) => v.final_url && v.status >= 200 && v.status < 300);
    if (hp) b.addEvidence(ev({ kind: 'http_status', source_url: hp.url, fetch_profile: 'RAW', selector_or_key: 'origin probe', observed_value: `${hp.status} ${hp.final_url}` }));
    if (!b.hits.length) {
      b.pass('Missing URLs return an error status, TLS is valid on the canonical origin, and http:// does not serve content without upgrading.');
      // Say what each clause actually means. A reader should not have to know what a soft 404 is to
      // understand what passed, or why it would matter if it had not.
      b.note(null, `A URL that does not exist returns ${probe?.rec?.status ?? 'an error status'}, not 200. Had it returned 200 with a "page not found" design — a soft 404 — Google would spend crawl budget on pages that do not exist and may index them.`);
      b.note(null, 'The HTTPS certificate on the canonical origin is valid, unexpired, and matches the hostname. An invalid certificate warns visitors away and blocks crawling entirely.');
      b.note(null, 'Requesting the http:// address redirects to https:// rather than serving the page. Serving both would put the same content on two protocols, splitting ranking signals between them and leaving the insecure copy live.');
    }
    out.push(b.build());
  } catch (e) {
    out.push(errorResult(ctx, 'C-1.3', e));
  }

  // ── Page-level (sampled + dropped pages) ───────────────────────────────
  const pages = [...ctx.pages, ...(ctx.derived.droppedPages || [])];
  for (const page of pages) {
    const b = new ResultBuilder(ctx, 'C-1.3', { scope: 'page', target_url: page.url, page_type: page.page_type });
    try {
      evaluatePage(ctx, page, b, probe);
      out.push(b.build());
    } catch (e) {
      out.push(errorResult(ctx, 'C-1.3', e, page.url));
    }
  }
  return out;
}

function evaluatePage(ctx, page, b, probe) {
  const { cfg } = ctx;
  const r = page.raw;
  const url = page.url;
  const hopsDesc = r.chain.map((h) => `${h.status} ${h.url}${h.location ? ` → ${h.location}` : ''}`).join(' | ');
  const statusEv = ev({ kind: 'http_status', source_url: url, fetch_profile: 'RAW', selector_or_key: 'final status', observed_value: r.status == null ? null : String(r.status), elapsed_ms: r.elapsed_ms, stall_stage: r.stall_stage });
  b.metric('initial_status', r.chain[0]?.status ?? null)
    .metric('final_status', r.status)
    .metric('hop_count', r.hop_count || 0)
    .metric('bytes', r.bytes)
    .metric('elapsed_ms', r.elapsed_ms)
    .metric('budget_class', r.budget_class)
    .metric('content_type', r.headers?.['content-type'] || null)
    .metric('tls_protocol', r.tls?.protocol || null);
  const sec = {};
  for (const h of ['strict-transport-security', 'x-robots-tag', 'cache-control', 'vary', 'link', 'content-encoding']) if (r.headers?.[h]) sec[h] = r.headers[h];
  b.metric('headers_recorded', sec); // R-1.3-6
  b.addEvidence(statusEv);
  if (hopsDesc) b.addEvidence(ev({ kind: 'http_header', source_url: url, fetch_profile: 'RAW', selector_or_key: 'redirect_chain', observed_value: hopsDesc }));

  // C-1.3-q / C-1.3-r first (R-FETCH-11)
  if (page.not_responding || (r.error?.kind === 'timeout' && r.status == null)) {
    const got = r.last_status_received;
    b.hit(got != null ? 'C-1.3-q' : 'C-1.3-r', { summary: notRespondingText(page), evidence: [notRespondingEvidence(page)] });
    return;
  }
  if (r.terminal === 'BLOCKED_BY_ROBOTS_FOR_AUDITOR') {
    b.notTestable('BLOCKED_BY_ROBOTS_FOR_AUDITOR', 'URL is disallowed for the auditor user-agent; not fetched (R-FETCH-4).');
    return;
  }
  if (r.status == null) {
    if (r.error?.kind === 'tls') b.hit('C-1.3-i', { summary: `TLS failure: ${r.error.code}`, evidence: [statusEv] });
    else b.notTestable('RATE_LIMITED', `No response obtained (${r.error?.code || 'network error'}).`);
    return;
  }
  if (r.terminal === 'REDIRECT_LOOP' || r.terminal === 'REDIRECT_HOPS_EXCEEDED' || (r.status >= 300 && r.status < 400)) {
    b.hit('C-1.3-o', { summary: `Redirect chain did not resolve (${r.terminal || `final ${r.status}`}).`, evidence: [statusEv], cross_references: ['C-1.4'] });
    return;
  }
  const s = r.status;
  if (s >= 500) {
    if (s === 503 && r.headers?.['retry-after']) {
      b.hit('C-1.3-b', { status: 'WARN', severity: 'MEDIUM', reason_code: 'MAINTENANCE_MODE', summary: `HTTP 503 with Retry-After: ${r.headers['retry-after']} (maintenance, E-1.3-3).`, evidence: [statusEv] });
    } else {
      const cdn = s >= 520 && s <= 530;
      b.hit('C-1.3-b', { summary: `Server error HTTP ${s}${cdn ? ' (CDN_ERROR — CDN/edge 5xx, frequently transient)' : ''}.`, evidence: [statusEv] });
    }
  } else if (s === 401 || s === 403) {
    b.hit('C-1.3-g', { summary: `HTTP ${s}: access restricted for the auditor user-agent. If a browser receives 200, this is WAF user-agent filtering (AUDITOR_UA_BLOCKED) — allow-list the auditor rather than treating it as a site defect.`, evidence: [statusEv] });
  } else if (s === 429) {
    b.hit('C-1.3-h', { summary: `HTTP 429 after Retry-After was honoured${r.retry_after_honoured ? '' : ' (no usable Retry-After)'}.`, evidence: [statusEv] });
  } else if (s === 451) {
    b.notTestable('GEO_RESTRICTED', 'HTTP 451 — geo-restricted from this vantage point (E-1.3-4).');
    return;
  } else if (s === 404 || s === 410) {
    b.hit('C-1.3-d', { summary: `Sampled URL returns HTTP ${s}; a URL discovered on-site should not 404.`, evidence: [statusEv] });
  } else if (s >= 400) {
    b.hit('C-1.3-c', { summary: `Client error HTTP ${s}.`, evidence: [statusEv] });
  }
  if (s >= 200 && s < 300) {
    const ct = String(r.headers?.['content-type'] || '');
    const isPdf = /application\/pdf/i.test(ct);
    const size = Math.max(r.bytes || 0, Number(r.headers?.['content-length']) || 0);
    if (r.truncated) b.note('TRUNCATED_RESPONSE', `Body truncated at ${cfg.net.max_response_bytes} bytes.`);
    const sizeEv = ev({ kind: 'computed', source_url: url, fetch_profile: 'RAW', selector_or_key: 'response bytes (decoded)', observed_value: String(size) });
    if (isPdf) {
      if (size > cfg.th.googlebot_bytes_pdf) b.hit('C-1.3-l', { summary: `PDF is ${size} bytes (> 64 MB Googlebot PDF limit).`, evidence: [sizeEv] });
    } else if (size > cfg.th.crawler_bytes_default) {
      b.hit('C-1.3-l', { summary: `Response is ${size} bytes: above the 15 MB crawler default (Google's crawler overview) and the 2 MB Googlebot per-file-type figure.`, evidence: [sizeEv] });
    } else if (size > cfg.th.googlebot_bytes_supported_type) {
      b.hit('C-1.3-k', { summary: `Response is ${size} bytes: above the 2 MB Googlebot per-file-type figure (Googlebot doc); the crawler-overview doc documents 15 MB. Both reference points are reported.`, evidence: [sizeEv] });
    }
    if (s === 200 && (!r.body?.length || Number(r.headers?.['content-length']) === 0)) {
      b.hit('C-1.3-m', { summary: 'HTTP 200 with an empty body.', evidence: [sizeEv] });
    }
    if (!isPdf && ct && !/text\/html|application\/xhtml\+xml/i.test(ct)) b.hit('C-1.3-n', { summary: `HTTP 200 but Content-Type is "${ct}" for an HTML page.`, evidence: [ev({ kind: 'http_header', source_url: url, fetch_profile: 'RAW', selector_or_key: 'Content-Type', observed_value: ct, expected_value: 'text/html' })] });

    // R-1.3-3 soft-404 — two or more signals required (F-1.3-4)
    if (!isPdf && r.body?.length) {
      const f = page.rawFacts || extractFacts(page.rawHtml || bodyText(r), url, ctx.canonicalOrigin);
      const signals = [];
      if (wordCount(f.mainText || f.bodyText) < 50) signals.push('visible text < 50 words');
      const t = f.titles[0]?.text || '';
      const h1 = f.headings.find((h) => h.level === 1)?.text || '';
      if (NOT_FOUND_TITLE.test(t) || NOT_FOUND_TITLE.test(h1)) signals.push('title/H1 matches a not-found pattern');
      if (NOT_FOUND_LEXICON.test(f.bodyText)) signals.push('body matches not-found lexicon');
      if (probe?.html && probe.rec.status >= 200 && probe.rec.status < 300 && probe.hash === crypto.createHash('sha256').update(page.rawHtml || '').digest('hex')) signals.push('byte-identical to the 404-probe response');
      if (signals.length >= 2) {
        const hasQuery = url.includes('?');
        b.hit('C-1.3-f', { severity: hasQuery ? 'MEDIUM' : undefined, summary: `HTTP ${s} page matches the soft-404 heuristic: ${signals.join('; ')}.`, evidence: [statusEv, ev({ kind: 'dom_node', source_url: url, fetch_profile: 'RAW', selector_or_key: 'title', observed_value: t })] });
      }
    }
    const xrt = String(r.headers?.['x-robots-tag'] || '');
    if (/noindex/i.test(xrt)) {
      b.note('NOINDEX_PRESENT', `X-Robots-Tag: ${xrt} — evaluated under C-1.6 (C-1.3-p).`);
      b.xref('C-1.6');
    }
  }
  if (!b.hits.length && s === 200) {
    const hops = r.hop_count || 0;
    if (hops <= 1) b.pass(`HTTP 200 in ${hops} hop(s), ${r.bytes} bytes, ${r.elapsed_ms} ms${r.tls?.protocol ? `, ${r.tls.protocol}` : ''}.`);
    else {
      b.pass(`HTTP 200 after ${hops} hops (redirect chain evaluated under C-1.4).`);
      b.xref('C-1.4');
    }
  } else if (!b.hits.length && s >= 200 && s < 300) {
    b.pass(`HTTP ${s}.`);
  }
}
