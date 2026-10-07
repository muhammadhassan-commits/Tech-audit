// DataForSEO as the fetch transport.
//
// The tool is published on wellows.com and audits sites from a datacentre address under a bot
// user-agent it refuses to disguise (R-FETCH-7). That combination gets challenged within a few
// requests, and a challenge page read as the site produces findings about our own blocking. Routing
// fetches through DataForSEO's proxy pool is how that is avoided.
//
// What was established against the live API before this was written, not assumed from the docs:
//
//   * `instant_pages` returns metadata only. The body requires `store_raw_html: true` and a second
//     call to `raw_html` with the *task id* - without the id the endpoint answers "Task Not Found",
//     because a Live method files its results under its own task rather than under the URL.
//   * `raw_html` returns `items` as an OBJECT, `{ html }`, not an array like every other endpoint.
//   * With `enable_javascript: false` the stored HTML is byte-identical to a plain GET (645 bytes
//     on a test page, matching exactly). With it true, the same page returns 3157 bytes containing
//     script-injected content. So one provider serves both the RAW and the RENDERED profile
//     faithfully, and this can stand in for Chromium.
//   * robots.txt and sitemap.xml come back whole, tagged `resource_type: robots` / `sitemap`.
//
// What it cannot do, and so is surfaced rather than papered over:
//
//   * No arbitrary response headers. `media_type`, `cache_control`, `content_encoding`, `server` and
//     `last_modified` are exposed as fields; `x-robots-tag` is not exposed at all, so the
//     header-side of C-1.6 is unobservable through this transport. The record carries
//     `headers_unavailable` so checks can say that rather than read an absent header as absent.
//   * No `custom_js` on instant_pages (the field is rejected), so there is no innerText and no
//     way to ask the page anything a browser would answer.

const API = 'https://api.dataforseo.com/v3';

/** DataForSEO reports its own failures in-band; only a transport failure throws. */
async function post(auth, path, body, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const json = await res.json().catch(() => null);
    return { http: res.status, json };
  } catch (e) {
    return { http: 0, json: null, error: e.name === 'AbortError' ? 'TIMEOUT' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

export class DataForSeoClient {
  constructor(cfg) {
    this.cfg = cfg;
    const { dataforseo_login: login, dataforseo_password: password } = cfg.keys;
    this.available = !!(login && password);
    this.auth = this.available
      ? 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64')
      : null;
    this.unavailableReason = this.available
      ? null
      : 'DATAFORSEO_EMAIL and DATAFORSEO_PASSWORD are not set';
    this.calls = 0;
    this.cost = 0;
  }

  /**
   * One page, one profile. Resolves (never rejects) with a record shaped like the HTTP client's,
   * so the rest of the engine does not need to know which transport fetched it.
   */
  async fetch(url, { js = false, timeoutMs = 60000 } = {}) {
    const start = Date.now();
    const record = {
      requested_url: url,
      final_url: url,
      chain: [],
      status: null,
      headers: null,
      headers_unavailable: true, // this transport does not expose them; see the header note above
      body: Buffer.alloc(0),
      bytes: 0,
      truncated: false,
      elapsed_ms: 0,
      stall_stage: null,
      budget_class: js ? 'render' : 'primary',
      attempts: [],
      error: null,
      not_responding: false,
      last_status_received: null,
      terminal: null,
      retry_after_honoured: false,
      tls: null,
      transport: 'dataforseo',
      observed_at: new Date().toISOString(),
    };

    if (!this.available) {
      record.error = { code: 'TRANSPORT_UNAVAILABLE', message: this.unavailableReason };
      record.terminal = 'TRANSPORT_UNAVAILABLE';
      return record;
    }

    const task = [{
      url,
      enable_javascript: js,
      // Browser rendering also turns on resource loading, which is what makes the DOM comparable to
      // one a browser would build. It is the expensive flag, so it is only set for RENDERED.
      ...(js ? { enable_browser_rendering: true, browser_preset: 'mobile' } : {}),
      store_raw_html: true,
      custom_user_agent: this.cfg.net.user_agent_resolved,
    }];

    const meta = await post(this.auth, '/on_page/instant_pages', task, timeoutMs);
    this.calls++;
    record.elapsed_ms = Date.now() - start;

    if (meta.error || !meta.json) {
      record.error = { code: 'TRANSPORT_ERROR', message: meta.error || `HTTP ${meta.http}` };
      record.not_responding = meta.error === 'TIMEOUT';
      record.terminal = 'TRANSPORT_ERROR';
      return record;
    }

    const t = meta.json.tasks?.[0];
    this.cost += Number(t?.cost || 0);
    // 20000 is DataForSEO's "Ok."; anything else is a failure on their side, not the site's.
    if (!t || t.status_code !== 20000) {
      record.error = { code: 'TRANSPORT_REJECTED', message: t?.status_message || 'no task returned' };
      record.terminal = 'TRANSPORT_REJECTED';
      return record;
    }

    const item = t.result?.[0]?.items?.[0];
    if (!item) {
      record.error = { code: 'NO_RESULT', message: 'the crawl returned no item for this URL' };
      record.terminal = 'TRANSPORT_ERROR';
      return record;
    }

    record.status = item.status_code ?? null;
    record.last_status_received = record.status;
    record.final_url = item.url || url;
    // `location` is the redirect target when this response is a 3xx. One hop, not the chain.
    if (item.location) record.chain = [{ from: url, to: item.location, status: record.status }];

    // The fields DataForSEO does expose, presented as the headers they correspond to so that code
    // reading content-type keeps working. Nothing is invented: a field absent here is absent.
    const headers = {};
    if (item.media_type) headers['content-type'] = item.media_type;
    if (item.cache_control?.cachable != null) headers['cache-control'] = item.cache_control.ttl != null ? `max-age=${item.cache_control.ttl}` : 'public';
    if (item.content_encoding) headers['content-encoding'] = item.content_encoding;
    if (item.server) headers.server = item.server;
    if (item.last_modified) headers['last-modified'] = item.last_modified;
    record.headers = headers;
    record.dfs = {
      resource_type: item.resource_type,
      onpage_score: item.onpage_score ?? null,
      page_timing: item.page_timing ?? null,
      checks: item.checks ?? null,
      size: item.size ?? null,
    };

    // The body, which is a second call. A page that answered with a status but no stored HTML is
    // still a real observation of that status, so the record is returned either way.
    const bodyRes = await post(this.auth, '/on_page/raw_html', [{ id: t.id, url: record.final_url }], timeoutMs);
    this.calls++;
    const bt = bodyRes.json?.tasks?.[0];
    this.cost += Number(bt?.cost || 0);
    // raw_html returns items as an object, not an array. This is the one endpoint that does.
    const html = bt?.result?.[0]?.items?.html;
    if (typeof html === 'string') {
      record.body = Buffer.from(html, 'utf8');
      record.bytes = record.body.length;
    }

    record.elapsed_ms = Date.now() - start;
    record.terminal = 'OK';
    return record;
  }
}
