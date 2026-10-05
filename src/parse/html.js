// HTML document model. One extractor, applied identically to RAW and RENDERED (F-5.2-3).
// Parsing uses parse5 (HTML5 tree builder via cheerio), so head/body placement reflects what a
// browser and Google see (R-1.5-2, B-1.5-4).
import * as cheerio from 'cheerio';
import { collapse, wordCount, decodeEntities } from './text.js';
import { normalizeUrl, stripFragment, isSameSite } from './url.js';

const BOILER_TAGS = 'header,nav,footer,aside';
const SR_ONLY = /\b(sr-only|visually-hidden|screen-reader-text|screenreader|a11y-hidden|hidden-visually)\b/i;
const WIDGET = /(intercom|drift|hubspot-messages|zendesk|trustpilot|yotpo|disqus|livechat|crisp|tawk|reviews-widget|chat-widget)/i;
const MOUNT_IDS = ['root', 'app', '__next', '__nuxt', 'gatsby-focus-wrapper', 'svelte', 'q-app'];

export function loadHtml(html) {
  return cheerio.load(html || '', { scriptingEnabled: false }); // parse <noscript> content as elements
}

function textOf($, el) {
  return collapse($(el).text());
}

function inlineHidden($, el) {
  const style = String($(el).attr('style') || '').replace(/\s+/g, '').toLowerCase();
  if (style.includes('display:none') || style.includes('visibility:hidden')) return true;
  if ($(el).attr('hidden') !== undefined || $(el).attr('aria-hidden') === 'true') return true;
  if (SR_ONLY.test(String($(el).attr('class') || ''))) return true;
  return false;
}

function zoneOf($, el) {
  const $el = $(el);
  if ($el.closest('noscript').length) return 'noscript';
  if ($el.closest('nav,[role=navigation]').length) return 'nav';
  if ($el.closest('header,[role=banner]').length) return 'header';
  if ($el.closest('footer,[role=contentinfo]').length) return 'footer';
  if ($el.closest('aside,[role=complementary]').length) return 'aside';
  return 'body';
}

/** R-2.3-4 main region: <main>; [role=main]; largest text-bearing article/section; else body minus boilerplate. */
export function mainRegion($) {
  const main = $('body main').first();
  if (main.length) return { $root: main, method: 'main' };
  const role = $('body [role=main]').first();
  if (role.length) return { $root: role, method: 'role_main' };
  let best = null;
  $('body article, body section').each((_, el) => {
    if ($(el).closest(BOILER_TAGS).length) return;
    const len = collapse($(el).text()).length;
    if (!best || len > best.len) best = { el, len };
  });
  const bodyLen = collapse($('body').text()).length || 1;
  if (best && best.len >= 0.3 * bodyLen) return { $root: $(best.el), method: 'largest_block' };
  return { $root: $('body'), method: 'body_minus_boilerplate', undetermined: !$('body').length };
}

/** The primary subtag of a BCP-47 tag: `en-GB` and `en` both reduce to `en`. */
const primarySubtag = (tag) => String(tag || '').trim().toLowerCase().split(/[-_]/)[0] || null;

/**
 * Main-content text with scripts/styles/templates/noscript and boilerplate zones removed (R-5.2-3).
 *
 * `primaryLang` additionally drops subtrees marked as a different language. A page that declares
 * `<html lang=en>` and carries translations of the same prose in other languages has not published
 * more content — it has published the same content again — and counting those words makes the page
 * look as though most of it were missing from the raw HTML. example.com does exactly this: its
 * English paragraph is in the HTML and a script appends Arabic, Chinese and other renderings of it,
 * which read as a page that is 83% JavaScript-gated when nothing is gated at all.
 */
export function mainText($, { excludeWidgets = true, primaryLang = null } = {}) {
  const { $root, method } = mainRegion($);
  const clone = $root.clone();
  clone.find('script,style,template,noscript,svg,iframe').remove();
  clone.find(BOILER_TAGS).remove();
  clone.find('[role=navigation],[role=banner],[role=contentinfo],[role=complementary]').remove();
  const want = primarySubtag(primaryLang);
  if (want) {
    clone.find('[lang]').each((_, el) => {
      const got = primarySubtag($(el).attr('lang'));
      if (got && got !== want) $(el).remove();
    });
  }
  if (excludeWidgets) {
    clone.find('*').each((_, el) => {
      const id = `${$(el).attr('id') || ''} ${$(el).attr('class') || ''}`;
      if (WIDGET.test(id)) $(el).remove();
    });
  }
  // Keep block boundaries as whitespace so words don't fuse.
  clone.find('p,div,li,h1,h2,h3,h4,h5,h6,br,td,th,tr,section,article,blockquote,pre,dd,dt').each((_, el) => {
    $(el).prepend(' ').append(' ');
  });
  return { text: collapse(clone.text()), method };
}

export function naiveText($) {
  const c = $('body').clone();
  c.find('script,style,template,noscript,svg').remove();
  c.find('*').each((_, el) => {
    $(el).prepend(' ').append(' ');
  });
  return collapse(c.text());
}

/** Readability-style density extraction (R-6.1-1 #3): the block with the best text/link density. */
export function densityText($) {
  let best = null;
  $('body div, body article, body section, body main, body td').each((_, el) => {
    const $el = $(el);
    if ($el.closest(BOILER_TAGS).length) return;
    const c = $el.clone();
    c.find('script,style,noscript,template,svg,nav,footer,header,aside').remove();
    const text = collapse(c.text());
    if (text.length < 80) return;
    const linkText = collapse(c.find('a').text()).length;
    const pCount = c.find('p').length;
    const density = (text.length - linkText) / (text.length || 1);
    const score = text.length * density * (1 + Math.min(pCount, 20) * 0.05);
    if (!best || score > best.score) best = { score, el };
  });
  if (!best) return mainText($).text;
  const c = $(best.el).clone();
  c.find('script,style,noscript,template,svg,nav,footer,header,aside').remove();
  c.find('*').each((_, el) => {
    $(el).prepend(' ').append(' ');
  });
  return collapse(c.text());
}

function headOf($) {
  return $('head');
}

/**
 * Build the per-profile fact sheet. `url` is the document URL (final URL after redirects).
 */
export function extractFacts(html, url, canonicalOrigin) {
  const $ = loadHtml(html);
  const head = headOf($);
  const baseHref = head.find('base[href]').first().attr('href');
  const baseUrl = baseHref ? normalizeUrl(baseHref, url) || url : url;

  // Titles (R-2.1-1, R-2.1-9)
  const titles = [];
  $('title').each((i, el) => {
    if ($(el).closest('svg').length) return; // <title> inside SVG is not a document title
    titles.push({ text: decodeEntities($(el).text()), in_head: $(el).closest('head').length > 0, index: i });
  });

  // Meta description(s) — name match case-insensitive (R-2.2-1)
  const metaDescriptions = [];
  $('meta').each((_, el) => {
    const name = String($(el).attr('name') || '').toLowerCase();
    if (name === 'description') metaDescriptions.push({ content: $(el).attr('content') ?? '', in_head: $(el).closest('head').length > 0 });
  });
  const og = {};
  $('meta[property], meta[name]').each((_, el) => {
    const k = String($(el).attr('property') || $(el).attr('name') || '').toLowerCase();
    if (/^(og:|twitter:|article:)/.test(k)) og[k] = $(el).attr('content') ?? '';
  });

  // Canonical links (R-1.5-1/2)
  const canonicals = [];
  $('link').each((_, el) => {
    const rel = String($(el).attr('rel') || '').toLowerCase().split(/\s+/);
    if (rel.includes('canonical')) {
      canonicals.push({ href: $(el).attr('href') ?? null, in_head: $(el).closest('head').length > 0, in_noscript: $(el).closest('noscript').length > 0 });
    }
  });

  // Meta robots — robots, googlebot and other crawler-specific names (R-1.6-1)
  const metaRobots = [];
  $('meta').each((_, el) => {
    const name = String($(el).attr('name') || '').toLowerCase();
    if (!name) return;
    const isRobotsName = name === 'robots' || /bot|crawler|slurp/.test(name);
    if (!isRobotsName) return;
    metaRobots.push({
      name,
      content: $(el).attr('content') ?? '',
      in_head: $(el).closest('head').length > 0,
      in_noscript: $(el).closest('noscript').length > 0,
    });
  });

  // hreflang (R-3.2-2)
  const hreflang = [];
  $('link[hreflang]').each((_, el) => {
    const rel = String($(el).attr('rel') || '').toLowerCase();
    if (!rel.split(/\s+/).includes('alternate')) return;
    hreflang.push({ hreflang: $(el).attr('hreflang'), href: $(el).attr('href'), in_head: $(el).closest('head').length > 0 });
  });
  const htmlLang = $('html').attr('lang') || null;

  // JSON-LD blocks (R-3.1-1)
  const jsonld = [];
  $('script').each((i, el) => {
    const type = String($(el).attr('type') || '').toLowerCase().trim();
    if (type === 'application/ld+json') {
      jsonld.push({ index: i, raw: $(el).html() ?? '', in_noscript: $(el).closest('noscript').length > 0 });
    }
  });
  const microdata = $('[itemscope][itemtype]').map((_, el) => $(el).attr('itemtype')).get();
  const rdfa = $('[typeof]').map((_, el) => $(el).attr('typeof')).get();

  // Links (R-A1-1…R-A1-7). Only <a href>.
  const links = [];
  const { $root: $main, method: mainMethod } = mainRegion($);
  const mainEl = $main.get(0);
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href');
    const trimmed = String(href).trim();
    const lower = trimmed.toLowerCase();
    const scheme = /^([a-z][a-z0-9+.-]*):/.exec(lower)?.[1];
    const img = $(el).find('img[alt]').first();
    const anchor = collapse($(el).text()) || collapse($(el).attr('aria-label') || '') || collapse(img.attr('alt') || '') || collapse($(el).attr('title') || '');
    const rec = {
      href,
      index: i,
      anchor,
      has_img_alt: !!img.length && !!collapse(img.attr('alt') || ''),
      rel: String($(el).attr('rel') || '').toLowerCase().split(/\s+/).filter(Boolean),
      zone: zoneOf($, el),
      in_main: mainEl ? $(el).closest(mainEl).length > 0 && !$(el).closest(BOILER_TAGS).length : false,
      in_breadcrumb: $(el).closest('[aria-label*=breadcrumb i],.breadcrumb,.breadcrumbs,[itemtype*=BreadcrumbList]').length > 0,
      target: $(el).attr('target') || null,
      resolved: null,
      discard: null,
    };
    if (!trimmed) rec.discard = 'EMPTY_HREF';
    else if (trimmed.startsWith('#')) rec.discard = 'FRAGMENT';
    else if (scheme && !['http', 'https'].includes(scheme)) rec.discard = `SCHEME_${scheme.toUpperCase()}`;
    else {
      const abs = normalizeUrl(trimmed, baseUrl); // E-A1-4 protocol-relative resolves against doc scheme
      if (!abs) rec.discard = 'UNPARSEABLE';
      else {
        rec.resolved = stripFragment(abs); // R-A1-5
        rec.same_site = canonicalOrigin ? isSameSite(rec.resolved, canonicalOrigin) : true;
      }
    }
    links.push(rec);
  });

  // Headings (R-2.3-1)
  const headings = [];
  $('h1,h2,h3,h4,h5,h6').each((i, el) => {
    const $el = $(el);
    const img = $el.find('img[alt]').first();
    const text = collapse($el.text());
    headings.push({
      level: Number(el.tagName[1]),
      text,
      alt_text: !text && img.length ? collapse(img.attr('alt') || '') : null,
      aria_label: $el.attr('aria-label') || null,
      zone: zoneOf($, el),
      in_main: mainEl ? $el.closest(mainEl).length > 0 && !$el.closest(BOILER_TAGS).length : false,
      hidden_inline: inlineHidden($, el) || $el.parents().toArray().some((p) => inlineHidden($, p)),
      in_widget: $el.parents().toArray().some((p) => WIDGET.test(`${$(p).attr('id') || ''} ${$(p).attr('class') || ''}`)) || $el.closest('iframe').length > 0,
      index: i,
    });
  });
  const ariaHeadings = $('[role=heading]').length;

  // Content text (R-5.2-2 / R-6.1-1). Script, style and template contents are never body text:
  // inline JSON (framework state, JSON-LD) would otherwise inflate every word count that reads this
  // and, worse, let a marked-up value match itself inside its own <script> when R-3.1-8 checks
  // whether the value appears in the page's visible content.
  const main = mainText($);
  // Same extraction, minus subtrees marked as another language. Used by the raw/rendered comparison
  // so both profiles are measured over the page's own language; see mainText() above.
  const mainPrimary = htmlLang ? mainText($, { primaryLang: htmlLang }) : main;
  const naive = naiveText($);
  const bodyClone = $('body').clone();
  bodyClone.find('script,style,template').remove();
  bodyClone.find('p,div,li,h1,h2,h3,h4,h5,h6,br,td,th,tr,section,article,blockquote,pre,dd,dt').each((_, el) => {
    $(el).prepend(' ').append(' ');
  });
  const bodyText = collapse(bodyClone.text());
  // R-6.1-4 boilerplate zones, counted once each (a nav inside a header is not counted twice).
  const boilerplateText = collapse(
    $(BOILER_TAGS).filter((_, el) => $(el).parents(BOILER_TAGS).length === 0).text(),
  );

  // Paragraph / structure facts (R-6.3)
  const $mainClone = $main.clone();
  $mainClone.find('pre,code').remove();
  const paragraphs = $main
    .find('p')
    .map((_, el) => collapse($(el).text()))
    .get()
    .filter(Boolean);
  const lists = $main.find('ul,ol').map((_, el) => {
    const items = $(el).children('li').map((__, li) => collapse($(li).text())).get();
    return { items: items.length, avg_words: items.length ? items.reduce((a, t) => a + wordCount(t), 0) / items.length : 0 };
  }).get();
  const tables = $main.find('table').map((_, el) => ({
    has_th: $(el).find('th').length > 0,
    has_caption: $(el).find('caption').length > 0,
    has_block_layout: $(el).find('div,p,section,article,h1,h2,h3,img').length > 3,
  })).get();

  // Semantic landmarks (R-6.1-7)
  const landmarks = {};
  for (const t of ['main', 'article', 'section', 'header', 'nav', 'footer', 'aside']) landmarks[t] = $(t).length;

  // Rendering-signature facts (R-FETCH-3a, R-5.2-6/7)
  const bodyChildren = $('body').children().toArray().filter((el) => !['script', 'noscript', 'style', 'link', 'template'].includes(el.tagName));
  const mountNode = MOUNT_IDS.find((id) => $(`#${id}`).length > 0) || null;
  const noscripts = $('noscript')
    .map((_, el) => collapse($(el).text()))
    .get();
  const hydrationMarker = /__NEXT_DATA__|__NUXT__|data-reactroot|data-server-rendered|ng-version|__remixContext|data-sveltekit|astro-island|__APOLLO_STATE__/.test(html || '');

  // Images / iframes (R-6.1-5)
  const images = $('img').map((_, el) => ({ alt: $(el).attr('alt') ?? null, src: $(el).attr('src') || $(el).attr('data-src') || null })).get();
  const iframes = $('iframe[src]').map((_, el) => normalizeUrl($(el).attr('src'), baseUrl)).get().filter(Boolean);

  // Time elements / visible dates (R-6.5-1)
  const timeEls = $('time').map((_, el) => ({ datetime: $(el).attr('datetime') || null, text: collapse($(el).text()), itemprop: $(el).attr('itemprop') || null })).get();

  // Meta charset (R-6.1-6)
  const metaCharset = $('meta[charset]').attr('charset') || /charset=([^;"']+)/i.exec($('meta[http-equiv="Content-Type" i]').attr('content') || '')?.[1] || null;

  // data-nosnippet usage (R-1.6-8)
  const dataNosnippet = $('[data-nosnippet]').map((_, el) => el.tagName).get();

  // Logo alt (R-6.2-1)
  const logoAlt = collapse($('header img[alt], [class*=logo] img[alt], img[class*=logo][alt], a[rel=home] img[alt]').first().attr('alt') || '') || null;

  // Q&A detection (R-3.1-17 / C-3.1-v)
  const qaBlocks = headings.filter((h) => /\?$/.test(h.text) || /^(what|how|why|when|where|who|which|can|does|is|are|should)\b/i.test(h.text)).length;
  const detailsQa = $('details summary').length;

  return {
    $,
    url,
    base_url: baseUrl,
    html_bytes: Buffer.byteLength(html || '', 'utf8'),
    titles,
    metaDescriptions,
    og,
    canonicals,
    metaRobots,
    hreflang,
    htmlLang,
    jsonld,
    microdata,
    rdfa,
    links,
    headings,
    ariaHeadings,
    mainText: main.text,
    mainTextPrimaryLang: mainPrimary.text,
    mainMethod: mainMethod,
    naiveText: naive,
    bodyText,
    boilerplateText,
    paragraphs,
    lists,
    tables,
    landmarks,
    bodyChildCount: bodyChildren.length,
    mountNode,
    noscripts,
    hydrationMarker,
    images,
    iframes,
    timeEls,
    metaCharset,
    dataNosnippet,
    logoAlt,
    qaHeadingCount: qaBlocks,
    detailsQaCount: detailsQa,
    hasCodeBlocks: $main.find('pre,code').length > 0,
  };
}

/** R-FETCH-3a client-rendering signature on a RAW document. */
export function hasClientRenderingSignature(facts, floor) {
  const bodyLen = facts.bodyText.length;
  if (facts.mountNode && facts.mainText.length < floor) return true;
  if (bodyLen < floor) return true;
  if (facts.noscripts.length && facts.noscripts.join(' ').length >= bodyLen * 0.8 && bodyLen > 0) return true;
  return false;
}

export { MOUNT_IDS, WIDGET, SR_ONLY };
