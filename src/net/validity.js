// A0 — response validity.
//
// Is the thing we fetched actually the page we asked for?
//
// Every page-level check assumes it is, and until now nothing tested that assumption. A Cloudflare
// interstitial — "One moment, please…" — is served with HTTP 200, so it arrived looking like a
// successful fetch and was parsed as the homepage. The result was a cascade of findings about a
// page nobody had seen: no headings, no structured data, no content, and a CRITICAL that capped the
// whole audit at 40%. None of it was about the site.
//
// A challenge shown to this auditor is not a finding about the site. It says the site's edge did
// not like this client on this request, which is a fact about the request. Reporting it as an SEO
// defect would be inventing a problem; silently scoring it would be worse. The honest outcome is
// NOT_TESTABLE, which is excluded from the score entirely.
//
// Detection uses several independent signals, because any one of them alone is wrong somewhere: a
// page may legitimately contain the word "captcha", and a legitimate page may be short.

export const VALIDITY = {
  VALID_PAGE: 'VALID_PAGE',
  ACCESS_CHALLENGE: 'ACCESS_CHALLENGE',
  ERROR_DOCUMENT: 'ERROR_DOCUMENT',
  EMPTY_OR_TRUNCATED: 'EMPTY_OR_TRUNCATED',
  UNKNOWN_RESPONSE: 'UNKNOWN_RESPONSE',
};

// Titles an interstitial uses. These are the vendor's own strings, not guesses.
const CHALLENGE_TITLES = [
  'just a moment',
  'one moment, please',
  'one moment please',
  'checking your browser',
  'verify you are human',
  'attention required',
  'security check',
  'access denied',
  'please wait',
  'ddos protection',
];

// Body markers. challenge-platform and cf-chl are Cloudflare's own asset paths, so they are strong;
// the wordier ones are only used in combination with a thin body (see below).
const CHALLENGE_BODY_STRONG = [
  'challenge-platform',
  'cf-chl-',
  'cf_chl_opt',
  '_cf_chl',
  'turnstile',
  'g-recaptcha',
  'hcaptcha',
];

const CHALLENGE_BODY_PHRASES = [
  'verify you are human',
  'verifying your browser',
  'checking your browser before accessing',
  'enable javascript and cookies to continue',
  'bot verification',
  'please enable cookies',
  'ray id',
];

const CHALLENGE_HEADERS = [
  ['cf-mitigated', 'challenge'],
  ['x-datadome', null],
  ['x-iinfo', null],       // Imperva/Incapsula
  ['x-sucuri-id', null],
];

const ERROR_TITLES = ['404', 'not found', '403 forbidden', '500 internal server error', 'service unavailable', 'error'];

const lower = (s) => String(s || '').toLowerCase();

/** Visible-ish text length, with scripts and styles removed, as a cheap thinness signal. */
function visibleWordCount(html) {
  const stripped = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return stripped.split(/\s+/).filter(Boolean).length;
}

function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

/**
 * Classify one fetched response.
 *
 * Returns { state, reason, signals } where signals names what was actually observed, so a reader
 * can see why a page was set aside rather than having to trust the verdict.
 */
export function classifyResponse({ status, headers = {}, html = '', contentType = '' } = {}) {
  const signals = [];
  const title = titleOf(html);
  const t = lower(title);
  const body = lower(html).slice(0, 60000);
  const words = visibleWordCount(html);
  const headingCount = (String(html || '').match(/<h[1-6][\s>]/gi) || []).length;

  // ── Headers. A vendor saying "challenge" outright settles it. ──────────
  for (const [name, value] of CHALLENGE_HEADERS) {
    const got = lower(headers[name]);
    if (got && (value == null || got === value)) {
      signals.push(`header ${name}${value ? `: ${value}` : ''}`);
      return { state: VALIDITY.ACCESS_CHALLENGE, reason: `The edge returned a challenge (${name}).`, signals };
    }
  }

  // ── Title. The interstitial names itself. ──────────────────────────────
  const titleHit = CHALLENGE_TITLES.find((x) => t.includes(x));
  if (titleHit) {
    signals.push(`title: "${title}"`);
    return { state: VALIDITY.ACCESS_CHALLENGE, reason: `The response is an interstitial titled "${title}".`, signals };
  }

  // ── Strong body markers, which are vendor asset paths rather than prose.
  const strongHit = CHALLENGE_BODY_STRONG.find((x) => body.includes(x));
  if (strongHit) {
    signals.push(`body contains "${strongHit}"`);
    // A real page can embed a captcha widget on a contact form, so this alone is not enough when
    // the page is otherwise substantial. Thin + marker is a challenge; fat + marker is a form.
    if (words < 120 || headingCount === 0) {
      return { state: VALIDITY.ACCESS_CHALLENGE, reason: `The response carries challenge markup ("${strongHit}") and little else (${words} words, ${headingCount} headings).`, signals };
    }
    signals.push(`but the page has ${words} words and ${headingCount} headings, so it is treated as a real page carrying a widget`);
  }

  // ── Phrases, only in combination with a thin body. ─────────────────────
  const phraseHit = CHALLENGE_BODY_PHRASES.find((x) => body.includes(x));
  if (phraseHit && words < 120) {
    signals.push(`body contains "${phraseHit}" with only ${words} words`);
    return { state: VALIDITY.ACCESS_CHALLENGE, reason: `The response reads as a verification page ("${phraseHit}") and carries ${words} words.`, signals };
  }

  // ── Not a document at all. ─────────────────────────────────────────────
  if (status != null && status >= 400) {
    signals.push(`HTTP ${status}`);
    return { state: VALIDITY.ERROR_DOCUMENT, reason: `The server returned HTTP ${status}.`, signals };
  }

  if (!html || !html.trim()) {
    signals.push('empty body');
    return { state: VALIDITY.EMPTY_OR_TRUNCATED, reason: 'The response body is empty.', signals };
  }

  if (contentType && !/html|xml|text\/plain/i.test(contentType)) {
    signals.push(`content-type: ${contentType}`);
    return { state: VALIDITY.UNKNOWN_RESPONSE, reason: `The response is ${contentType}, not a web page.`, signals };
  }

  // ── Normal-page signals. ───────────────────────────────────────────────
  // A real page has a title, some headings and some words. Missing all three on a 200 is not
  // proof of a challenge, but it is not something to run content checks against either.
  if (words < 25 && headingCount === 0 && !title) {
    signals.push(`${words} words, no headings, no title`);
    return { state: VALIDITY.UNKNOWN_RESPONSE, reason: `The response has no title, no headings and ${words} words, so it cannot be confirmed as the requested page.`, signals };
  }

  signals.push(`${words} words, ${headingCount} headings, title "${title.slice(0, 60)}"`);
  return { state: VALIDITY.VALID_PAGE, reason: null, signals };
}

/** True when page-content checks may run against this response. */
export const isValidPage = (v) => v?.state === VALIDITY.VALID_PAGE;
