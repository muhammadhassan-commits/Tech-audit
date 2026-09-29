// C-5.2 — Content accessible with JavaScript disabled (page · RAW vs RENDERED, both required).
// F-5.2-1: never run with one profile. F-5.2-3: the same extractor on both sides.
import { ev } from '../engine/result.js';
import { forEachPage, hasRendered, domEv } from './_util.js';
import { extractFacts } from '../parse/html.js';
import { wordCount, shingles, jaccard, collapse } from '../parse/text.js';
import { renderGapCode } from '../discovery/acquire.js';

const RISK_NOTE =
  'Google renders with an evergreen Chromium and will generally see rendered content on a second pass; many AI crawlers and fetchers do not execute JavaScript at all. Content that exists only after rendering is therefore at materially higher risk for AI retrieval than for Google indexing.';

const CONSENT_RE = /(cookie|consent|privacy)\s+(banner|notice|settings|preferences)|we use cookies|accept all cookies|manage (your )?(cookie )?preferences|gdpr/i;

export async function run(ctx) {
  ctx.derived.renderStrategy = new Map();
  return forEachPage(ctx, 'C-5.2', (page, b) => {
    b.caveat(RISK_NOTE);
    if (!page.is_html) return b.notApplicable('RENDER_NOT_REQUIRED', 'Non-HTML resource.');
    if (!hasRendered(page)) {
      const code = renderGapCode(page);
      const msg = {
        RENDER_NOT_REQUIRED: 'This page showed no client-rendering signature in RAW, so no RENDERED profile was acquired (R-FETCH-3a). A raw-only comparison against nothing is meaningless, so the ratio is not computed.',
        RENDER_BUDGET_UNAVAILABLE: 'The RENDERED load did not fit inside the remaining URL budget, so the comparison could not run.',
        RENDER_FAILED: 'The RENDERED fetch failed for this page.',
        RENDER_UNAVAILABLE: `Rendering is unavailable for this run${ctx.renderer.unavailableReason ? ` (${ctx.renderer.unavailableReason})` : ''}. Every check with a RENDERED dependency inherits this limitation.`,
      }[code];
      b.notTestable(code, msg);
      b.addEvidence(ev({ kind: 'computed', source_url: page.finalUrl, fetch_profile: 'RAW', selector_or_key: 'render_state', observed_value: page.render_state }));
      // R-5.2-9: record raw-side facts anyway so the reader sees what was available.
      b.metric('raw_words', wordCount(page.rawFacts?.mainText || ''));
      ctx.derived.renderStrategy.set(page.url, null);
      return;
    }

    const rawF = page.rawFacts;
    const renF = page.renFacts;
    const rawText = rawF.mainText;
    const renText = renF.mainText;
    const rawWords = wordCount(rawText);
    const renWords = wordCount(renText);
    const ratio = rawWords / Math.max(renWords, 1);
    const similarity = jaccard(shingles(rawText), shingles(renText));

    // Blocks present in RENDERED but absent from RAW (R-5.2-4)
    const rawBlocks = new Set([...rawF.headings.map((h) => collapse(h.text)), ...rawF.paragraphs.map((p) => collapse(p).slice(0, 120))].filter(Boolean));
    const missingBlocks = [...renF.headings.map((h) => collapse(h.text)), ...renF.paragraphs.map((p) => collapse(p).slice(0, 120))]
      .filter((t) => t && !rawBlocks.has(t))
      .slice(0, 20);

    // Element-level presence (R-5.2-5)
    const el = {
      title: [!!rawF.titles.length, !!renF.titles.length],
      'meta[name=description]': [!!rawF.metaDescriptions.length, !!renF.metaDescriptions.length],
      h1: [rawF.headings.some((h) => h.level === 1), renF.headings.some((h) => h.level === 1)],
      'h2-h3': [rawF.headings.some((h) => h.level === 2 || h.level === 3), renF.headings.some((h) => h.level === 2 || h.level === 3)],
      'link[rel=canonical]': [!!rawF.canonicals.length, !!renF.canonicals.length],
      'meta[name=robots]': [rawF.metaRobots.length > 0, renF.metaRobots.length > 0],
      'link[hreflang]': [rawF.hreflang.length > 0, renF.hreflang.length > 0],
      'json-ld': [rawF.jsonld.length > 0, renF.jsonld.length > 0],
      img: [rawF.images.length, renF.images.length],
      a: [rawF.links.length, renF.links.length],
    };
    b.metric('raw_words', rawWords).metric('rendered_words', renWords).metric('text_ratio', Number(ratio.toFixed(3)))
      .metric('content_similarity', Number(similarity.toFixed(3))).metric('element_presence', el)
      .metric('missing_blocks', missingBlocks);
    const rEv = ev({ kind: 'computed', source_url: page.finalUrl, fetch_profile: 'RAW', selector_or_key: 'text_ratio = raw_words / rendered_words', observed_value: `${rawWords} / ${renWords} = ${ratio.toFixed(2)}; 5-shingle Jaccard ${similarity.toFixed(2)}`, expected_value: '≥ 0.90' });

    // R-5.2-8 render strategy
    let strategy;
    if (ratio >= 0.9) strategy = rawF.hydrationMarker ? 'HYDRATED' : 'SSR/SSG';
    else if (ratio < 0.3 && rawF.mountNode) strategy = 'CSR';
    else strategy = 'HYBRID';
    b.metric('render_strategy', strategy);
    ctx.derived.renderStrategy.set(page.url, strategy);
    if (page.isHomepage) ctx.target.render_strategy = strategy === 'SSR/SSG' ? 'SSR' : strategy;

    // Consent-wall guard (E-5.2-2, F-5.2-4) — never report CONTENT_REQUIRES_JS for a consent wall.
    const consentGated = ctx.flags.has('CONSENT_WALL_RAW') || (CONSENT_RE.test(rawText.slice(0, 600)) && rawWords < 120 && renWords < 120);
    if (consentGated) {
      b.notTestable('CONSENT_GATED_CONTENT', 'A consent/cookie interstitial gates the content, so a text ratio computed here would be false (E-5.2-2). Consent is recorded, never auto-accepted.');
      b.addEvidence(rEv);
      return;
    }

    // Noscript substance (R-5.2-7)
    const noscriptText = rawF.noscripts.join(' ');
    const noscriptWords = wordCount(noscriptText);
    const noscriptSubstantive = noscriptWords >= 50 && !/^[^.]*\b(enable|turn on|activate)\b[^.]*javascript/i.test(collapse(noscriptText));
    if (rawF.noscripts.length && !noscriptSubstantive && noscriptWords > 0) b.hit('C-5.2-j', { summary: '<noscript> contains only an "enable JavaScript" message rather than substantive content.', evidence: [domEv(page, 'RAW', 'noscript', collapse(noscriptText).slice(0, 300))] });
    if (noscriptSubstantive) b.note('NOSCRIPT_SUBSTANTIVE', `<noscript> carries ${noscriptWords} words of real content, which genuinely mitigates the risk (E-5.2-7).`);

    if (!rawWords && !renWords) {
      b.hit('C-5.2-l', { summary: 'Both profiles are empty: no main content in RAW or RENDERED.', evidence: [rEv] });
      return;
    }
    // R-5.2-6 SPA shell signature
    const spaShell = !!rawF.mountNode && rawWords < 50;
    if (spaShell) {
      b.hit('C-5.2-e', { summary: `SPA shell only: RAW contains the mount node #${rawF.mountNode} plus scripts and ${rawWords} words of text, while RENDERED has ${renWords}.`, evidence: [rEv, domEv(page, 'RAW', `#${rawF.mountNode}`, collapse(rawF.bodyText).slice(0, 300) || '(empty)')] });
    }
    // Ratio bands (C-5.2-b/c/d/k) — one band only.
    const upgrade = noscriptSubstantive;
    if (ratio > 1.2) {
      b.hit('C-5.2-k', { summary: `RAW carries more text than RENDERED (ratio ${ratio.toFixed(2)}): content present at fetch time is removed at render time${/paywall|subscribe to (read|continue)/i.test(rawText) ? ' — a client-side paywall pattern (E-5.2-9)' : ''}.`, evidence: [rEv] });
    } else if (!spaShell && ratio < ctx.cfg.th.raw_text_ratio_fail) {
      b.hit('C-5.2-b', { status: upgrade ? 'FAIL' : undefined, severity: upgrade ? 'HIGH' : undefined, summary: `Only ${Math.round(ratio * 100)}% of the rendered main content exists in raw HTML (${rawWords} of ${renWords} words).${upgrade ? ' Severity reduced one band: <noscript> carries substantive content (E-5.2-7).' : ''}`, evidence: [rEv] });
    } else if (ratio < ctx.cfg.th.raw_text_ratio_warn) {
      b.hit('C-5.2-c', { status: upgrade ? 'WARN' : undefined, severity: upgrade ? 'MEDIUM' : undefined, summary: `${Math.round(ratio * 100)}% of the rendered main content exists in raw HTML (${rawWords} of ${renWords} words); the remainder requires JavaScript.`, evidence: [rEv] });
    } else if (ratio < 0.9) {
      b.hit('C-5.2-d', { summary: `${Math.round(ratio * 100)}% of the rendered main content is in raw HTML; a minority requires JavaScript.`, evidence: [rEv] });
    }

    // Element-level failures
    if (!el.h1[0] && el.h1[1]) b.hit('C-5.2-f', { summary: 'h1 is absent from raw HTML and present only after rendering.', evidence: [domEv(page, 'RENDERED', 'h1', renF.headings.find((h) => h.level === 1)?.text || '')], cross_references: ['C-2.3'] });
    if (!el.title[0] && el.title[1]) b.hit('C-5.2-g', { summary: 'The <title> is absent from raw HTML and set only by JavaScript.', evidence: [domEv(page, 'RENDERED', 'title', renF.titles[0]?.text || '')], cross_references: ['C-2.1'] });
    if (!el['link[rel=canonical]'][0] && el['link[rel=canonical]'][1]) b.hit('C-5.2-h', { summary: 'The canonical link is injected by JavaScript.', evidence: [domEv(page, 'RENDERED', 'link[rel=canonical]', renF.canonicals[0]?.href || '')], cross_references: ['C-1.5'] });
    const rawLinks = new Set(rawF.links.filter((l) => !l.discard && l.same_site).map((l) => l.resolved));
    const renLinks = new Set(renF.links.filter((l) => !l.discard && l.same_site).map((l) => l.resolved));
    const jsOnly = [...renLinks].filter((u) => !rawLinks.has(u));
    const linkShare = renLinks.size ? jsOnly.length / renLinks.size : 0;
    b.metric('js_only_link_share', Number(linkShare.toFixed(3)));
    if (linkShare > 0.3) b.hit('C-5.2-i', { summary: `${Math.round(linkShare * 100)}% of internal links (${jsOnly.length} of ${renLinks.size}) appear only after rendering.`, evidence: [ev({ kind: 'computed', source_url: page.finalUrl, fetch_profile: 'RENDERED', selector_or_key: 'links only in RENDERED', observed_value: jsOnly.slice(0, 20).join(' | ') })], cross_references: ['C-2.4'] });

    // E-5.2-4 / E-5.2-8 notes
    if (page.rendered?.timed_out_network_idle) b.note('RENDER_VARIANCE_POSSIBLE', 'The rendered load hit the render budget before network idle; late-arriving content may be missing from the rendered side.');
    if (missingBlocks.length && !spaShell && ratio >= 0.7) b.note('LAZY_CONTENT_BELOW_FOLD', `${missingBlocks.length} block(s) appear only in the rendered DOM; where these are lazy-loaded below the fold they are excluded from the JS-gated count (E-5.2-1).`);
    if (!ctx.cfg.cap.ua_probe) b.note('DYNAMIC_RENDERING_DETECTED', 'Dynamic-rendering detection not attempted: UA-variant probing is disabled (cap.ua_probe = false), so the measured ratio reflects the auditor\'s UA (E-5.2-8).');

    // F-5.2-5 — content-dependent results for this page carry the cross-reference.
    if (b.hits.some((h) => h.status === 'FAIL')) {
      b.xref('C-2.1', 'C-2.3', 'C-6.1', 'C-6.3', 'C-6.4');
      ctx.derived.jsGatedPages ||= new Set();
      ctx.derived.jsGatedPages.add(page.url);
    }
    b.addEvidence(rEv);
    if (!b.hits.length) b.pass(`Raw HTML carries ${Math.round(ratio * 100)}% of the rendered main content (similarity ${similarity.toFixed(2)}) and every retrieval-weight element is present without JavaScript. Render strategy: ${strategy}.`);
  });
}
