// C-6.1 — Raw Content Availability (page · RAW primary, RENDERED comparative).
// C-5.2 asks whether content exists without JavaScript; C-6.1 asks whether the content that exists
// is extractable as clean text by a non-browser fetcher. A page can pass one and fail the other.
import { ev } from '../engine/result.js';
import { forEachPage, hasRendered, domEv } from './_util.js';
import { mainText, naiveText, densityText } from '../parse/html.js';
import { wordCount, shingles, jaccard, collapse, isMostlyNonLatin } from '../parse/text.js';

const MOJIBAKE = /â€™|â€œ|â€\u009d|Ã©|Ã¨|Ã¼|Ã¶|Ã¤|Ã±|â€“|â€”|Â«|Â»|Ã‚|ï»¿/;
const CONSENT_RE = /(cookie|consent)\s+(banner|notice|settings|preferences)|we use cookies|accept all cookies/i;

export async function run(ctx) {
  ctx.derived.extraction = new Map();
  return forEachPage(ctx, 'C-6.1', (page, b) => {
    if (!page.is_html) {
      b.notApplicable('RAW_FETCH_FAILED', 'Non-HTML resource: HTML-structure rules do not apply (E-6.1-9).');
      b.metric('word_count', wordCount(collapse(page.rawHtml || '')));
      return;
    }
    if (!page.rawFacts || page.raw.status == null) {
      b.notTestable('RAW_FETCH_FAILED', `The RAW fetch did not produce a body (${page.raw.error?.code || 'no response'}).`);
      return;
    }
    const f = page.rawFacts;
    const $ = f.$;

    // R-6.1-1 three independent extractions on the RAW document.
    const extractions = [];
    let failed = 0;
    for (const [name, fn] of [['main_region', () => mainText($).text], ['naive', () => naiveText($)], ['readability', () => densityText($)]]) {
      try {
        extractions.push({ name, text: fn() });
      } catch {
        failed++;
      }
    }
    const usable = extractions.filter((x) => x.text && x.text.length > 0);
    const main = extractions.find((x) => x.name === 'main_region')?.text || f.mainText || '';
    const words = wordCount(main);
    const consent = ctx.flags.has('CONSENT_WALL_RAW') || (CONSENT_RE.test(main.slice(0, 500)) && words < 120);

    // R-6.1-2 pairwise agreement
    let agreement = null;
    if (usable.length >= 2) {
      const pairs = [];
      for (let i = 0; i < usable.length; i++) for (let j = i + 1; j < usable.length; j++) pairs.push(jaccard(shingles(usable[i].text), shingles(usable[j].text)));
      agreement = pairs.reduce((a, x) => a + x, 0) / pairs.length;
    }
    const htmlBytes = f.html_bytes || Buffer.byteLength(page.rawHtml || '', 'utf8');
    const textRatio = htmlBytes ? Buffer.byteLength(main, 'utf8') / htmlBytes : 0;
    // R-6.1-4 — boilerplate-zone words over total words. Measured from the zones themselves, not
    // as "everything outside the main region": content that sits outside <main> is still content,
    // and counting it as boilerplate reported well-populated pages as boilerplate-dominant.
    const totalWords = wordCount(f.bodyText);
    const boilerWords = wordCount(f.boilerplateText || '');
    const boilerRatio = totalWords ? Math.min(1, boilerWords / totalWords) : 0;
    const landmarkCount = Object.values(f.landmarks).reduce((a, n) => a + n, 0);
    const codeWords = f.hasCodeBlocks ? wordCount(collapse($('pre,code').text())) : 0;
    b.metric('word_count', words)
      .metric('extraction_agreement', agreement == null ? null : Number(agreement.toFixed(3)))
      .metric('text_to_html_ratio', Number(textRatio.toFixed(4)))
      .metric('boilerplate_ratio', Number(boilerRatio.toFixed(3)))
      .metric('semantic_landmarks', f.landmarks)
      .metric('code_ratio', words ? Number((codeWords / words).toFixed(3)) : 0)
      .metric('extractors_run', usable.map((x) => x.name));
    ctx.derived.extraction.set(page.url, { words, agreement, main, degraded: failed > 0 });

    const mEv = ev({ kind: 'computed', source_url: page.finalUrl, fetch_profile: 'RAW', selector_or_key: 'main-content extraction (3 extractors)', observed_value: `${words} words; agreement ${agreement == null ? 'n/a' : agreement.toFixed(2)}; text/html ${textRatio.toFixed(4)}; boilerplate ${(boilerRatio * 100).toFixed(0)}%`, expected_value: `≥ ${ctx.cfg.th.min_words_content_page} words, agreement ≥ 0.80` });
    b.addEvidence(mEv);
    if (failed) b.note('EXTRACTION_PARTIAL', `${failed} extractor(s) failed; agreement computed over the remainder and the achievable status is capped at WARN (B-6.1-1).`);
    if (isMostlyNonLatin(main)) b.caveat('Word counts are script-aware: CJK text is segmented by character count, not spaces (E-6.1-5).');

    // R-6.1-6 encoding
    const declared = (f.metaCharset || '').toLowerCase().replace(/^["']|["']$/g, '');
    const headerCs = /charset=([^;]+)/i.exec(String(page.raw.headers?.['content-type'] || ''))?.[1]?.toLowerCase().trim();
    const mojibake = MOJIBAKE.test(main.slice(0, 20000));
    b.metric('charset', { meta: declared || null, header: headerCs || null });
    if (mojibake) {
      b.hit('C-6.1-j', { summary: `Encoding corruption detected in the extracted text (declared charset: meta="${declared || 'none'}", header="${headerCs || 'none'}"). Mojibake silently corrupts every downstream extraction.`, evidence: [ev({ kind: 'computed', source_url: page.finalUrl, fetch_profile: 'RAW', selector_or_key: 'mojibake sample', observed_value: (MOJIBAKE.exec(main) ? main.slice(Math.max(0, MOJIBAKE.exec(main).index - 60), MOJIBAKE.exec(main).index + 60) : '').trim() })] });
    } else if (declared && headerCs && declared !== headerCs && !(declared === 'utf-8' && headerCs === 'utf8')) {
      b.hit('C-6.1-j', { summary: `Declared charset disagrees: <meta charset="${declared}"> vs Content-Type charset="${headerCs}".`, evidence: [ev({ kind: 'http_header', source_url: page.finalUrl, fetch_profile: 'RAW', selector_or_key: 'Content-Type', observed_value: page.raw.headers['content-type'], expected_value: `charset=${declared}` })] });
    }

    // Word-count bands (C-6.1-b/c) with the consent-wall and short-page guards (F-6.1-1, F-6.1-4)
    if (consent) {
      b.notTestable('CONSENT_GATED_CONTENT', 'A consent wall occupies the raw HTML, so raw content availability cannot be measured here (E-6.1-8). Recorded as missing evidence, not as absent content.');
      return;
    }
    if (words < 50) {
      // Raw is thin. Whether that means the content is JavaScript-gated depends entirely on what
      // rendering produced, and the previous wording asserted gating whenever a rendered profile
      // existed — without comparing the two. Raw 8 / rendered 8 was reported as "JavaScript-gated",
      // which the evidence does not support: if rendering adds nothing, JavaScript is not what is
      // withholding the content.
      const renderedWords = hasRendered(page) ? wordCount(page.renFacts.mainText) : null;
      // Tool policy: rendering has to add real content, not a few words of chrome, before the
      // gating explanation is the right one.
      const gated = renderedWords != null && renderedWords >= Math.max(50, words * 3);

      if (gated) {
        b.hit('C-6.1-b', {
          summary: `Main content is ${words} words in raw HTML but ${renderedWords} after rendering, so the content is JavaScript-gated: anything reading the page without running scripts sees almost nothing (see C-5.2).`,
          evidence: [mEv],
          cross_references: ['C-5.2'],
        });
      } else if (renderedWords != null) {
        // Rendering changed nothing, so this is a thin page rather than a gated one. Reported, but
        // not as the critical "content is absent because of JavaScript" finding.
        b.hit('C-6.1-p', {
          summary: `Main content is ${words} words in raw HTML and ${renderedWords} after rendering. Rendering adds nothing, so the content is not JavaScript-gated — the page itself carries very little text for a search engine or an assistant to use.`,
          evidence: [mEv],
        });
      } else {
        b.hit('C-6.1-p', {
          summary: `Main content is ${words} words in raw HTML. No rendered profile was captured for this page, so whether scripts would add content is untested — the raw page carries very little text either way.`,
          evidence: [mEv],
          cross_references: ['C-5.2'],
        });
      }
    } else if (words < ctx.cfg.th.min_words_content_page) {
      const legitimatelyShort = ['pricing', 'other', 'author'].includes(page.page_type) && (f.tables.length > 0 || f.lists.length > 0);
      if (legitimatelyShort) b.note('RAW_CONTENT_THIN', `${words} words, which is legitimate for a ${page.page_type} page carrying a structured table or list (E-6.1-1).`);
      else b.hit('C-6.1-c', { summary: `Main content is ${words} words (below the ${ctx.cfg.th.min_words_content_page}-word threshold). Reported factually — brevity alone is not judged.`, evidence: [mEv] });
    }

    // Extraction agreement (C-6.1-d/e)
    if (agreement != null) {
      if (agreement < 0.5) b.hit('C-6.1-d', { summary: `The three extractors agree only ${agreement.toFixed(2)}: the page's content boundaries are ambiguous to any extractor, which is exactly the condition that degrades retrieval.`, evidence: [mEv] });
      else if (agreement < 0.8) b.hit('C-6.1-e', { summary: `Extractor agreement is ${agreement.toFixed(2)}; content boundaries are unclear.`, evidence: [mEv] });
    }
    if (boilerRatio > 0.6) b.hit('C-6.1-f', { summary: `Boilerplate (header/nav/footer/aside) accounts for ${Math.round(boilerRatio * 100)}% of the page's words.`, evidence: [mEv] });
    if (textRatio < 0.05) b.hit('C-6.1-l', { summary: `Extracted main content is ${(textRatio * 100).toFixed(2)}% of the HTML payload.`, evidence: [mEv] });
    if (!landmarkCount) b.hit('C-6.1-k', { summary: 'No semantic HTML landmarks (main, article, section, header, nav, footer, aside): every extractor must guess where the content is.', evidence: [domEv(page, 'RAW', 'semantic landmarks', JSON.stringify(f.landmarks))] });
    else if (!f.landmarks.main && !f.landmarks.article && agreement != null && agreement < 0.8) b.note('NO_SEMANTIC_HTML', 'No <main> or <article>: the main region was inferred from block density.');

    // R-6.1-5 content locked in structures a text extractor cannot read
    const imgOnlyText = f.images.filter((i) => !i.alt || !collapse(i.alt)).length;
    if (words < 100 && f.images.length >= 3 && imgOnlyText >= f.images.length * 0.7) {
      b.hit('C-6.1-g', { summary: `Substantive content appears to be baked into images: ${words} words of text alongside ${f.images.length} images, ${imgOnlyText} of them without alt text (captions and alt text count as text — E-6.1-2).`, evidence: [domEv(page, 'RAW', 'img[alt]', f.images.slice(0, 10).map((i) => `${i.src} alt="${i.alt ?? ''}"`).join(' | '))] });
    }
    const sameOriginIframes = f.iframes.filter((u) => {
      try {
        return new URL(u).origin === ctx.canonicalOrigin;
      } catch {
        return false;
      }
    });
    if (sameOriginIframes.length && words < ctx.cfg.th.min_words_content_page) {
      b.hit('C-6.1-h', { summary: `Substantive content may live inside ${sameOriginIframes.length} same-origin iframe(s), which a text extractor does not follow: ${sameOriginIframes.slice(0, 3).join(', ')}.`, evidence: [domEv(page, 'RAW', 'iframe[src]', sameOriginIframes.join(' | '))] });
    }
    // Tabs/accordions present in RENDERED but absent from RAW (E-6.1-3: hidden-by-CSS is still present)
    if (hasRendered(page)) {
      const panels = $('[role=tabpanel], details, .accordion, [data-accordion], [aria-controls]').length;
      const renPanels = page.renFacts.$('[role=tabpanel], details, .accordion, [data-accordion], [aria-controls]').length;
      const rawPanelText = collapse($('[role=tabpanel], details').text()).length;
      const renPanelText = collapse(page.renFacts.$('[role=tabpanel], details').text()).length;
      if (renPanels > panels && renPanelText > rawPanelText * 2 && renPanelText > 200) {
        b.hit('C-6.1-i', { summary: `Tab/accordion panel content is absent from raw HTML (${rawPanelText} vs ${renPanelText} characters after rendering).`, evidence: [ev({ kind: 'computed', source_url: page.finalUrl, fetch_profile: 'RENDERED', selector_or_key: 'tab/accordion panel text', observed_value: `RAW ${rawPanelText} chars vs RENDERED ${renPanelText} chars` })] });
      }
    }
    // R-6.1-9 markdown twin (computed by C-5.3)
    const twin = ctx.derived.markdownTwins?.find((t) => t.url === page.finalUrl);
    if (twin) b.hit('C-6.1-m', { summary: `A markdown twin is served for this URL (${twin.via}), which removes extraction ambiguity entirely for non-browser fetchers.`, evidence: [ev({ kind: 'http_header', source_url: page.finalUrl, fetch_profile: 'RAW', selector_or_key: 'markdown twin', observed_value: twin.via })] });
    // R-6.1-10 UA-conditional serving — opt-in only
    if (!ctx.cfg.cap.ua_probe) b.note('UA_CONDITIONAL_CONTENT', 'UA-conditional serving not probed: user-agent variant probing is disabled (cap.ua_probe = false, the safe default); C-6.1-n is NOT_TESTABLE (B-6.1-4).');
    if (f.hasCodeBlocks) b.note('RAW_CONTENT_THIN', `Code blocks are counted as content; code_ratio is reported separately so prose volume is not misread (E-6.1-6).`);

    if (failed && b.hits.some((h) => h.status === 'FAIL')) for (const h of b.hits) if (h.status === 'FAIL') h.status = 'WARN';
    if (!b.hits.length) b.pass(`${words} words of main content extract cleanly from raw HTML (extractor agreement ${agreement == null ? 'n/a' : agreement.toFixed(2)}), semantic landmarks present, encoding correct.`);
  });
}
