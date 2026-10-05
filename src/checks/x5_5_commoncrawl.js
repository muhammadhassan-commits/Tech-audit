// X-5.5 — Common Crawl presence (site · no fetch profile). Advisory: reported, never scored.
//
// Previously this appeared in the report as UNSPECIFIED with an explanation of why the PRD had no
// rule for it — an internal note shown to clients. It is now implemented, and implemented narrowly,
// because the honest scope is narrow.
//
// A hit establishes that at least one URL from the domain was captured in that crawl. It does not
// establish that a model trained on it, that an assistant will cite it, that a search engine can
// reach the site, or anything about ranking. Common Crawl is an open web archive, not a search
// index and not a training manifest. Scoring it would attach a number to a claim it cannot support.
import { ResultBuilder, ev, errorResult } from '../engine/result.js';
import { presence } from '../net/commoncrawl.js';

const MEANING = 'Common Crawl is an open web archive. Presence confirms a page was captured; it does not establish AI training, citation by any assistant, search-engine visibility, or current crawler access.';

export async function run(ctx) {
  try {
    return [await evaluate(ctx)];
  } catch (e) {
    return [errorResult(ctx, 'X-5.5', e)];
  }
}

async function evaluate(ctx) {
  const { cfg } = ctx;
  const host = new URL(ctx.canonicalOrigin).hostname;
  const b = new ResultBuilder(ctx, 'X-5.5', { scope: 'site', target_url: ctx.canonicalOrigin, mode: 'first' });

  if (!cfg.cap.commoncrawl) {
    b.notTestable('COMMON_CRAWL_API_UNAVAILABLE', 'Common Crawl lookups are switched off for this run (cap.commoncrawl = false).');
    return b.build();
  }

  ctx.emit('fetch', { url: 'index.commoncrawl.org', purpose: 'Common Crawl presence' });
  const r = await presence(host, {
    ua: cfg.net.user_agent_resolved,
    timeoutMs: cfg.commoncrawl?.timeout_ms ?? 45000,
  });

  if (!r.ok) {
    // An API that did not answer says nothing about the domain. Reporting absence here would be
    // reporting our own outage as the site's.
    b.notTestable('COMMON_CRAWL_API_UNAVAILABLE', `The Common Crawl index did not answer (${r.error}${r.message ? `: ${r.message}` : ''}), so presence could not be established. This says nothing about the domain.`);
    return b.build();
  }

  const evidence = ev({
    kind: 'api_payload',
    source_url: 'https://index.commoncrawl.org/',
    fetch_profile: 'NONE',
    selector_or_key: `Common Crawl index lookup for ${r.domain}`,
    observed_value: r.found
      ? `${r.index_id}: ${r.record.url} captured ${r.record.timestamp}`
      : `no capture in ${r.indexes_checked.join(', ')}`,
  });

  b.metric('common_crawl', {
    domain: r.domain,
    found: r.found,
    index_id: r.index_id ?? null,
    indexes_checked: r.indexes_checked,
    checked_at: r.checked_at,
    record: r.record ?? null,
  });
  b.addEvidence(evidence);

  if (r.found && r.latest) {
    b.note('COMMON_CRAWL_PRESENT', `The domain appears in the latest Common Crawl index (${r.index_id}). ${MEANING}`);
  } else if (r.found) {
    b.note('COMMON_CRAWL_PRESENT_RECENTLY', `The domain does not appear in the latest Common Crawl index but was captured in ${r.index_id}. Crawl coverage varies between releases, so this is not evidence of a change on the site. ${MEANING}`);
  } else {
    b.note('COMMON_CRAWL_NOT_FOUND_RECENT', `No capture found in the last ${r.indexes_checked.length} Common Crawl releases (${r.indexes_checked.join(', ')}). Common Crawl samples the web rather than covering it, so absence is not evidence that the site is unreachable or unindexed. ${MEANING}`);
  }

  b.pass(r.found
    ? `Checked against the live Common Crawl index list; the domain was captured in ${r.index_id}.`
    : `Checked against the ${r.indexes_checked.length} most recent Common Crawl releases. Informational only — this factor is not scored.`);
  return b.build();
}
