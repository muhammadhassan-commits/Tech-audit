// P3 — per-page acquisition. RAW for every sampled page (primary budget); RENDERED conditionally
// (R-FETCH-3a): always for the homepage, otherwise only on a client-rendering signature, and only
// when elapsed + render.budget_ms fits inside net.url_budget_ms (R-FETCH-2).
import { bodyText } from '../net/http.js';
import { extractFacts, hasClientRenderingSignature } from '../parse/html.js';
import { classifyResponse, VALIDITY } from '../net/validity.js';
import { normalizeUrl } from '../parse/url.js';

export async function acquirePages(ctx) {
  const { http, renderer, cfg } = ctx;
  const pages = [];
  const dropped = [];
  let failures = 0;
  const hp = ctx.derived.homepageAcq;

  for (const sel of ctx.sample.pages) {
    ctx.emit('acquire', { url: sel.url, page_type: sel.page_type });
    const isHomepage = sel.page_type === 'homepage';
    let raw;
    let rawHtml;
    let rendered = null;
    let renderState;
    if (isHomepage && hp) {
      raw = hp.raw;
      rawHtml = hp.html;
      rendered = hp.rendered && !hp.rendered.error ? hp.rendered : null;
      renderState = rendered ? 'RENDERED' : hp.rendered?.error?.code === 'RENDER_UNAVAILABLE' || !cfg.cap.render_js ? 'UNAVAILABLE' : hp.rendered ? 'FAILED' : 'BUDGET';
    } else {
      raw = await http.fetch(sel.url, { budgetClass: 'primary', exempt: sel.discovery_method === 'OPERATOR_SUPPLIED' });
      if (raw.budget_class !== 'primary' && (raw.not_responding || raw.error)) {
        raw = await http.fetch(sel.url, { budgetClass: 'primary', noCache: true }); // discovery probe was secondary-budget
      }
      rawHtml = bodyText(raw);
    }
    const finalUrl = normalizeUrl(raw.final_url || sel.url) || sel.url;
    const page = {
      url: sel.url,
      finalUrl,
      page_type: sel.page_type,
      sel,
      isHomepage,
      raw,
      rawHtml,
      rawFacts: null,
      rendered: null,
      renFacts: null,
      render_state: null,
      not_responding: !!raw.not_responding,
      is_html: true,
    };

    if (page.not_responding) {
      failures++;
      page.render_state = 'NOT_ATTEMPTED';
      pages.push(page);
      ctx.discovery?.unresponsive_urls?.push({ url: sel.url, http_status: raw.last_status_received ?? null, stall_stage: raw.stall_stage, elapsed_ms: raw.elapsed_ms });
      continue;
    }
    const ct = String(raw.headers?.['content-type'] || '');
    // A0: decide whether this response is the requested page before anything parses its DOM.
    // A challenge or error document that arrived with HTTP 200 would otherwise be read as the page.
    page.validity = classifyResponse({ status: raw.status, headers: raw.headers, html: rawHtml, contentType: ct });
    if (page.validity.state !== 'VALID_PAGE') {
      ctx.flags.add(`A0_${page.validity.state}`);
      ctx.derived.invalidResponses = (ctx.derived.invalidResponses || []);
      ctx.derived.invalidResponses.push({ url: finalUrl, state: page.validity.state, reason: page.validity.reason, signals: page.validity.signals });
    }
    page.is_html = !ct || /html|xml/i.test(ct);
    page.is_pdf = /application\/pdf/i.test(ct);
    page.rawFacts = extractFacts(rawHtml, finalUrl, ctx.canonicalOrigin);

    // E-A4-6 — a selected non-homepage page that 404s/5xxs at P3 is dropped from content checks.
    if (!isHomepage && raw.status != null && (raw.status >= 400 || raw.status < 200)) {
      dropped.push(page);
      ctx.flags.add('SELECTION_REPLACED');
      failures++;
      continue;
    }

    if (!isHomepage) {
      const needsRender = hasClientRenderingSignature(page.rawFacts, cfg.render.raw_text_floor);
      if (!cfg.cap.render_js || renderer.available === false) renderState = 'UNAVAILABLE';
      else if (!needsRender) renderState = 'NOT_REQUIRED';
      else if (raw.elapsed_ms + cfg.render.budget_ms > cfg.net.url_budget_ms) renderState = 'BUDGET';
      else {
        ctx.emit('fetch', { url: finalUrl, purpose: 'RENDERED' });
        const r = await renderer.render(finalUrl);
        if (r.error) renderState = r.error.code === 'RENDER_UNAVAILABLE' ? 'UNAVAILABLE' : 'FAILED';
        else {
          rendered = r;
          renderState = 'RENDERED';
        }
      }
    }
    page.render_state = renderState;
    if (rendered) {
      page.rendered = rendered;
      page.renFacts = extractFacts(rendered.html, normalizeUrl(rendered.final_url) || finalUrl, ctx.canonicalOrigin);

      // A0, reconsidered. The gate reads the raw response, and a client-rendered app legitimately
      // serves an empty shell there — no title, no headings, no text. That is indistinguishable
      // from a truncated or unrecognisable response until the page is rendered, at which point it
      // is no longer in doubt: we are holding the DOM. Leaving the raw verdict standing would gate
      // every page check on a site that rendered perfectly well, which is a statement about our
      // fetch rather than about the site.
      //
      // Only the two "we could not tell" states are upgraded. A challenge or an error document is
      // not in doubt, and passing a challenge during render would mean auditing a page that a
      // crawler without JavaScript never receives.
      const UPGRADABLE = new Set([VALIDITY.EMPTY_OR_TRUNCATED, VALIDITY.UNKNOWN_RESPONSE]);
      if (UPGRADABLE.has(page.validity?.state)) {
        const renVerdict = classifyResponse({
          status: rendered.status ?? raw.status,
          headers: raw.headers,
          html: rendered.html,
          contentType: ct,
        });
        if (renVerdict.state === VALIDITY.VALID_PAGE) {
          ctx.flags.delete(`A0_${page.validity.state}`);
          ctx.derived.invalidResponses = (ctx.derived.invalidResponses || [])
            .filter((x) => x.url !== finalUrl);
          page.validity = {
            ...renVerdict,
            reason: `the raw response was ${page.validity.state.toLowerCase().replace(/_/g, ' ')}, but rendering produced the page (client-rendered)`,
            upgraded_from: page.validity.state,
          };
          ctx.flags.add('A0_VALID_AFTER_RENDER');
        }
      }
    }
    pages.push(page);
  }

  ctx.pages = pages;
  ctx.derived.droppedPages = dropped;
  ctx.homepage = pages.find((p) => p.isHomepage) || null;
  if (dropped.length) ctx.sample.pages = ctx.sample.pages.filter((s) => !dropped.some((d) => d.url === s.url));
  const total = pages.length + dropped.length;
  if (total && failures / total > 0.5) ctx.flags.add('RUN_QUALITY_DEGRADED'); // F-A4-5
  for (const s of ctx.sample.pages) {
    const p = pages.find((x) => x.url === s.url);
    if (p) s.final_status = p.raw.status;
  }
}

/** Caveat text per render state, attached by checks that read RENDERED. */
export function renderCaveat(page) {
  switch (page.render_state) {
    case 'NOT_REQUIRED':
      return 'Evaluated on raw HTML; this page showed no client-rendering signature.';
    case 'BUDGET':
      return 'Raw HTML only; RENDERED load did not fit the remaining URL budget (RENDER_BUDGET_UNAVAILABLE).';
    case 'UNAVAILABLE':
    case 'FAILED':
      return 'Raw HTML only; JavaScript-injected values not evaluated.';
    default:
      return null;
  }
}

/** Reason code when a RAW-vs-RENDERED comparison cannot run for a page. */
export function renderGapCode(page) {
  switch (page.render_state) {
    case 'NOT_REQUIRED':
      return 'RENDER_NOT_REQUIRED';
    case 'BUDGET':
      return 'RENDER_BUDGET_UNAVAILABLE';
    case 'FAILED':
      return 'RENDER_FAILED';
    default:
      return 'RENDER_UNAVAILABLE';
  }
}
