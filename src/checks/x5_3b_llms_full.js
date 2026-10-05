// X-5.3b — llms-full.txt (site · RAW). Advisory: reported, never scored.
//
// Previously shown to clients as UNSPECIFIED with an explanation of why the PRD had no rule for it.
// It is now checked, and reported as information only: llms-full.txt is not part of the llms.txt
// specification, no search engine consumes it, and nothing about its absence is a defect.
//
// One request, one path. Probing invented fallback paths to find a file nobody requires would spend
// a fast audit's budget manufacturing a finding.
import { ResultBuilder, ev, errorResult } from '../engine/result.js';
import { classifyResponse, VALIDITY } from '../net/validity.js';
import { bodyText } from '../net/http.js';

const PATH = '/llms-full.txt';

export async function run(ctx) {
  try {
    return [await evaluate(ctx)];
  } catch (e) {
    return [errorResult(ctx, 'X-5.3b', e)];
  }
}

async function evaluate(ctx) {
  const url = `${ctx.canonicalOrigin}${PATH}`;
  const b = new ResultBuilder(ctx, 'X-5.3b', { scope: 'site', target_url: url, mode: 'first' });

  ctx.emit('fetch', { url, purpose: 'llms-full.txt' });
  const rec = await ctx.http.fetch(url, { budgetClass: 'secondary', headers: { accept: 'text/plain,text/markdown,*/*;q=0.5' } });

  const statusEv = (observed) => ev({
    kind: 'http_status', source_url: url, fetch_profile: 'RAW',
    selector_or_key: 'llms-full.txt final status', observed_value: observed,
  });

  // Could not be established: an unanswered or blocked request says nothing about the file.
  if (rec.status == null || [403, 429].includes(rec.status) || rec.status >= 500) {
    b.addEvidence(statusEv(rec.status == null ? (rec.terminal || rec.error?.kind || 'no response') : String(rec.status)));
    b.notTestable('LLMS_FULL_TXT_FETCH_FAILED', `The request for ${PATH} did not resolve (${rec.status ?? rec.terminal ?? 'no response'}), so whether the file exists could not be established.`);
    return b.build();
  }

  if (rec.status === 404 || rec.status === 410) {
    b.addEvidence(statusEv(String(rec.status)));
    b.note('LLMS_FULL_TXT_ABSENT', `No ${PATH} is published. It is not part of the llms.txt specification and no search engine consumes it, so this is recorded for completeness only.`);
    b.pass(`${PATH} is not published. Informational only — this factor is not scored.`);
    return b.build();
  }

  const text = bodyText(rec) || '';
  const ct = String(rec.headers?.['content-type'] || '');
  const verdict = classifyResponse({ status: rec.status, headers: rec.headers, html: text, contentType: ct });

  if (verdict.state === VALIDITY.ACCESS_CHALLENGE) {
    b.addEvidence(statusEv(`${rec.status} — ${verdict.reason}`));
    b.notTestable('LLMS_FULL_TXT_FETCH_FAILED', `The request for ${PATH} returned a bot challenge rather than a file, so whether one exists could not be established.`);
    return b.build();
  }

  // A 200 that is really the site's HTML — a catch-all route or a soft 404 — is not a file.
  const looksHtml = /<html[\s>]|<!doctype html/i.test(text.slice(0, 2000)) || /text\/html/i.test(ct);
  if (looksHtml) {
    b.addEvidence(statusEv(`${rec.status} ${ct || 'unknown type'} — HTML, not a text file`));
    b.note('LLMS_FULL_TXT_FALLBACK', `${PATH} returns HTML rather than a text file, which means the server answered with a page (usually the homepage or a soft 404) instead of saying the file is absent. No llms-full.txt is published.`);
    b.pass(`${PATH} resolves to HTML, so no such file is published. Informational only — this factor is not scored.`);
    return b.build();
  }

  const words = text.split(/\s+/).filter(Boolean).length;
  b.metric('llms_full_txt', { status: rec.status, content_type: ct || null, bytes: text.length, words });
  b.addEvidence(statusEv(`${rec.status} ${ct || 'unknown type'}, ${words} words`));

  // Tool policy: a file with almost nothing in it is published but carries no content to use.
  if (words < 20) {
    b.note('LLMS_FULL_TXT_FALLBACK', `${PATH} exists but contains only ${words} words, so there is effectively nothing in it for an agent to read.`);
  } else {
    b.note('LLMS_FULL_TXT_PRESENT', `${PATH} is published (${words} words). It is not part of the llms.txt specification and no search engine consumes it, so this is recorded as information rather than a requirement met.`);
  }
  b.pass(`${PATH} is published (${words} words). Informational only — this factor is not scored.`);
  return b.build();
}
