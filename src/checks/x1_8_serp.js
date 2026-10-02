// X-1.8 — Googlebot Access (using SERP) (site · no fetch profile).
//
// Every other check in Section 1 confirms that Google *can* reach the site: robots.txt allows it,
// pages return 200, nothing carries noindex. This one asks whether Google actually *did* — by
// searching for the domain and seeing whether anything comes back.
//
// Those are not the same question. Every precondition can pass while the site is absent from the
// index, and until now the tool could not tell the difference.
//
// What this evidence can and cannot carry:
//
//   it can      separate "Google has pages from this domain" from "Google has none"
//   it cannot   measure coverage, or tell you which pages are missing
//
// Google states that site: counts are estimates, and the result set is a sample rather than an
// index report. So only the binary outcome is scored, and the caveat travels with every finding.
// Search Console is the authoritative source and only the site owner can authorise it.
import { ResultBuilder, ev, errorResult } from '../engine/result.js';
import { siteQuery, belongsTo } from '../net/serp.js';

const CAVEAT = 'A site: query returns a sample of what Google holds, not an index report, and Google describes the counts as estimates. It establishes whether the domain is present in the index, not how much of it is. Google Search Console is authoritative and needs the owner’s access.';

export async function run(ctx) {
  try {
    return [await evaluate(ctx)];
  } catch (e) {
    return [errorResult(ctx, 'X-1.8', e)];
  }
}

async function evaluate(ctx) {
  const { cfg } = ctx;
  const host = new URL(ctx.canonicalOrigin).hostname;
  const b = new ResultBuilder(ctx, 'X-1.8', { scope: 'site', target_url: ctx.canonicalOrigin, mode: 'first' });

  if (!cfg.cap.serp_api) {
    b.notTestable('SERP_LOOKUP_UNAVAILABLE', 'SERP lookups are switched off for this run (cap.serp_api = false).');
    b.caveat(CAVEAT);
    return b.build();
  }

  ctx.emit('fetch', { url: `site:${host}`, purpose: 'SERP index presence' });
  const r = await siteQuery(host, {
    apiKey: cfg.keys.cloro_api_key,
    timeoutMs: cfg.serp.timeout_ms,
    countryCode: cfg.serp.country,
  });

  if (!r.ok) {
    // The tool could not establish the answer. That is not a finding about the site.
    const msg = {
      NO_KEY: 'No SERP API key is configured, so index presence was not checked.',
      KEY_REJECTED: 'The SERP API rejected the configured key.',
      QUOTA: 'The SERP API quota is exhausted.',
      TIMEOUT: 'The SERP API did not answer in time.',
    }[r.error.code] || `The SERP lookup failed: ${r.error.message}`;
    b.notTestable('SERP_LOOKUP_UNAVAILABLE', msg);
    b.caveat(CAVEAT);
    return b.build();
  }

  const mine = r.results.filter((x) => belongsTo(x.url, host));
  const listed = mine.slice(0, 10).map((x) => `#${x.position} ${x.url}`).join(' | ');
  const queryEv = ev({
    kind: 'api_payload',
    source_url: ctx.canonicalOrigin,
    fetch_profile: 'NONE',
    selector_or_key: `Google "site:${host}" — first page of organic results`,
    observed_value: mine.length ? listed : '(no organic results for this domain)',
    expected_value: 'at least one indexed page',
  });

  b.metric('serp_results_returned', r.returned).metric('serp_results_for_host', mine.length);
  b.caveat(CAVEAT);

  if (!mine.length) {
    b.hit('X-1.8-b', {
      summary: `A Google search for site:${host} returns no pages from this domain. Everything else may be configured correctly, but the site is not in the index, so it cannot appear in search results.`,
      evidence: [queryEv],
      cross_references: ['C-1.1', 'C-1.6', 'C-1.7'],
    });
    return b.build();
  }

  b.addEvidence(queryEv);
  b.pass(`Google returns ${mine.length} page(s) from this domain for site:${host}, so the site is in the index. Top result: ${mine[0].url}.`);
  return b.build();
}
