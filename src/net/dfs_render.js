// The RENDERED profile without a browser.
//
// DataForSEO with enable_javascript returns the DOM after scripts have run - verified against a
// client-rendered page, where the same URL came back as 645 bytes with the flag off and 3157 bytes
// with it on. That is what the RENDERED profile exists to obtain, so this stands in for Chromium.
//
// One thing it cannot return, and the difference matters:
//
//   Chromium gave us `dom`, collected by running JavaScript *in* the page: innerText, textContent,
//   headings and title straight from the live document. innerText is the text a reader actually
//   sees, with CSS applied - it omits a collapsed accordion, a `display: none` panel, an off-screen
//   tab. Nothing recovers that from HTML, because it is a question about layout, not markup.
//
// So `dom` is left null rather than filled with a lookalike built from the HTML. Checks that need
// to know what is visible *without interaction* report NOT_TESTABLE instead of guessing, which is
// the whole reason the field is absent rather than approximated.

export class DataForSeoRenderer {
  constructor(cfg, transport) {
    this.cfg = cfg;
    this.transport = transport;
    this.available = transport.available;
    this.unavailableReason = transport.available
      ? null
      : transport.unavailableReason;
  }

  async init() {
    return this.available;
  }

  async render(url) {
    if (!this.available) {
      return { error: { code: 'RENDER_UNAVAILABLE', message: this.unavailableReason }, elapsed_ms: 0 };
    }
    const t0 = Date.now();
    const rec = await this.transport.fetch(url, { js: true, timeoutMs: this.cfg.render.budget_ms * 6 });

    if (rec.error || !rec.bytes) {
      return {
        error: {
          code: rec.error?.code === 'TRANSPORT_UNAVAILABLE' ? 'RENDER_UNAVAILABLE' : 'RENDER_FAILED',
          message: rec.error?.message || 'the transport returned no document',
        },
        elapsed_ms: Date.now() - t0,
      };
    }

    return {
      profile: 'RENDERED',
      requested_url: url,
      final_url: rec.final_url || url,
      status: rec.status,
      html: rec.body.toString('utf8'),
      // Deliberately null. See the note above: a browser-only observation, not approximated.
      dom: null,
      dom_unavailable: 'NO_BROWSER_TRANSPORT',
      // A client-side navigation chain is a browser observation too. `location` gives at most the
      // server's own redirect, which the RAW profile already records.
      navigations: [],
      timed_out_network_idle: false,
      elapsed_ms: Date.now() - t0,
      observed_at: new Date().toISOString(),
      transport: 'dataforseo',
    };
  }

  async close() {
    /* nothing to close: there is no browser */
  }
}
