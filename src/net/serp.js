// SERP lookups through the Cloro API (https://cloro.dev/serp-api/).
//
// Every other check asks the site a question. This one asks Google a question — "do you have any of
// these pages?" — which is why it needs a third party at all: Google publishes no search API.
//
// The result is weaker evidence than it looks. A site: query returns a sample, not an index report,
// and Google says the counts are estimates. So this is used for one thing only: distinguishing
// "Google has pages from this domain" from "Google has none". Anything finer belongs to Search
// Console, which only the site owner can authorise.
const ENDPOINT = 'https://api.cloro.dev/v1/monitor/google';

/** Cloro rejects lower-case country codes with a validation error, so normalise before sending. */
const country = (c) => String(c || 'US').toUpperCase();

/**
 * Run a site: query for a host.
 * Resolves to { ok, results, total, error } and never throws: a SERP lookup failing must leave the
 * finding NOT_TESTABLE, not abort the run.
 */
export async function siteQuery(host, { apiKey, timeoutMs = 45000, countryCode = 'US', device = 'desktop' } = {}) {
  if (!apiKey) return { ok: false, error: { code: 'NO_KEY', message: 'No SERP API key is configured.' } };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query: `site:${host}`,
        country: country(countryCode),
        device,
        pages: 1,
      }),
    });

    let body = null;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: { code: 'BAD_RESPONSE', message: `HTTP ${res.status} with an unreadable body.` } };
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: { code: 'KEY_REJECTED', message: `The SERP API rejected the key (HTTP ${res.status}).` } };
    }
    if (res.status === 429) {
      return { ok: false, error: { code: 'QUOTA', message: 'The SERP API quota is exhausted (HTTP 429).' } };
    }
    if (!res.ok || body?.success === false) {
      const detail = body?.error?.message || body?.message || `HTTP ${res.status}`;
      return { ok: false, error: { code: 'API_ERROR', message: String(detail).slice(0, 200) } };
    }

    const organic = Array.isArray(body?.result?.organicResults) ? body.result.organicResults : [];
    return {
      ok: true,
      query: `site:${host}`,
      results: organic.map((r) => ({
        position: r.position ?? null,
        url: r.link || null,
        title: r.title || null,
        snippet: r.snippet || null,
      })),
      // The sample size, which is not the index count. Named so it cannot be mistaken for one.
      returned: organic.length,
    };
  } catch (e) {
    if (e.name === 'AbortError') {
      return { ok: false, error: { code: 'TIMEOUT', message: `The SERP API did not answer within ${timeoutMs} ms.` } };
    }
    return { ok: false, error: { code: 'NETWORK', message: String(e.message).slice(0, 200) } };
  }
}

/** True when a returned URL belongs to the audited host (or a subdomain of it). */
export function belongsTo(urlStr, host) {
  try {
    const h = new URL(urlStr).hostname.toLowerCase();
    const want = String(host).toLowerCase().replace(/^www\./, '');
    return h === want || h === `www.${want}` || h.endsWith(`.${want}`);
  } catch {
    return false;
  }
}
