// Shared check scaffolding: per-page iteration with exception containment (F-RUN-9) and the
// PAGE_NOT_RESPONDING rule (R-FETCH-11: every dependent page-level check → NOT_TESTABLE).
import { ResultBuilder, errorResult, ev } from '../engine/result.js';
import { renderCaveat } from '../discovery/acquire.js';

// A0 states map to the reason code the reader sees. Each says what was observed, not what the site
// did wrong, because none of these are findings about the site.
const VALIDITY_REASON = {
  ACCESS_CHALLENGE: 'ACCESS_CHALLENGE_DETECTED',
  ERROR_DOCUMENT: 'RESPONSE_NOT_PAGE_CONTENT',
  EMPTY_OR_TRUNCATED: 'RESPONSE_NOT_PAGE_CONTENT',
  UNKNOWN_RESPONSE: 'RESPONSE_VALIDITY_UNKNOWN',
};

// C-1.3 reads status lines and C-1.4 reads redirect chains; neither depends on the DOM, so both
// remain meaningful when the body is a challenge. Everything else is gated.
const PAGE_CONTENT_EXEMPT = new Set(['C-1.3', 'C-1.4']);

export async function forEachPage(ctx, checkId, fn, { includeUnresponsive = false } = {}) {
  const out = [];
  for (const page of ctx.pages) {
    const b = new ResultBuilder(ctx, checkId, { scope: 'page', target_url: page.finalUrl || page.url, page_type: page.page_type });
    try {
      if (page.not_responding && !includeUnresponsive) {
        b.notTestable('PAGE_NOT_RESPONDING', notRespondingText(page));
        b.addEvidence(notRespondingEvidence(page));
      } else if (page.validity && page.validity.state !== 'VALID_PAGE' && !PAGE_CONTENT_EXEMPT.has(checkId)) {
        // A0: the fetched response is not the requested page, so nothing read from its DOM says
        // anything about the site. A challenge shown to this auditor is a fact about the request,
        // not a defect in the page, and scoring it would be inventing a finding.
        b.notTestable(VALIDITY_REASON[page.validity.state] || 'RESPONSE_VALIDITY_UNKNOWN', `${page.validity.reason} Page-content checks were not run against it.`);
        b.addEvidence(ev({
          kind: 'http_status',
          source_url: page.finalUrl || page.url,
          fetch_profile: 'RAW',
          selector_or_key: 'A0 response validity',
          observed_value: `${page.validity.state} — ${page.validity.signals.join('; ')}`,
          expected_value: 'VALID_PAGE',
        }));
      } else {
        await fn(page, b);
      }
      out.push(b.build());
    } catch (e) {
      out.push(errorResult(ctx, checkId, e, page.finalUrl || page.url));
    }
  }
  return out;
}

export function siteResult(ctx, checkId, target_url, fn, opts = {}) {
  const b = new ResultBuilder(ctx, checkId, { scope: 'site', target_url, ...opts });
  return Promise.resolve()
    .then(() => fn(b))
    .then(() => [b.build()])
    .catch((e) => [errorResult(ctx, checkId, e, target_url)]);
}

export function notRespondingText(page) {
  const r = page.raw;
  const status = r.last_status_received ?? r.status;
  return status != null
    ? `Page not responding — HTTP ${status}, incomplete after ${r.elapsed_ms} ms at ${r.stall_stage || 'body'}`
    : `Page not responding — no HTTP status received; stalled at ${r.stall_stage || 'unknown'} after ${r.elapsed_ms} ms`;
}

export function notRespondingEvidence(page) {
  const r = page.raw;
  return ev({
    kind: 'http_status',
    source_url: page.url,
    fetch_profile: 'RAW',
    selector_or_key: 'status',
    observed_value: r.last_status_received == null ? null : String(r.last_status_received),
    elapsed_ms: r.elapsed_ms,
    stall_stage: r.stall_stage || null,
  });
}

/** Attach the render-state caveat when a check reads RENDERED but only RAW exists. */
export function jsCaveat(b, page) {
  const c = renderCaveat(page);
  if (c) b.caveat(c);
}

export const hasRendered = (page) => page.render_state === 'RENDERED' && !!page.renFacts;

export function domEv(page, profile, selector, value, expected = null) {
  return ev({ kind: 'dom_node', source_url: page.finalUrl || page.url, fetch_profile: profile, selector_or_key: selector, observed_value: value, expected_value: expected });
}

export function sampleSize(ctx) {
  return ctx.pages.filter((p) => !p.not_responding).length;
}

export function isPaginated(url) {
  return /\/page\/\d+\/?$|[?&](page|p|pg)=\d+/i.test(url);
}

export function matchesAny(url, paths = []) {
  try {
    const p = new URL(url).pathname;
    return paths.some((x) => p === x || p.startsWith(x.endsWith('/') ? x : x + '/') || p.startsWith(x));
  } catch {
    return false;
  }
}

export { ev };
