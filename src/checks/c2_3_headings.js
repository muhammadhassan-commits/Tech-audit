// C-2.3 — H1 / Headings (page · RAW and RENDERED). Never FAIL on multiple h1s or level skips.
import { forEachPage, hasRendered, domEv, jsCaveat, sampleSize, isPaginated } from './_util.js';
import { collapse, PLACEHOLDER_RE } from '../parse/text.js';
import { detectSiteName, normaliseTitle, normName } from './_sitename.js';

export const QUESTION_RE = /^(what|how|why|when|where|who|which|can|does|do|is|are|should|will|could)\b.*|.*\?$/i;

export async function run(ctx) {
  const siteName = detectSiteName(ctx);
  const h1s = new Map();
  for (const p of ctx.pages) {
    const f = p.rawFacts;
    if (!f) continue;
    const h = f.headings.find((x) => x.level === 1 && (x.in_main || f.mainMethod === 'body_minus_boilerplate') && !x.in_widget);
    const t = h ? h.text || h.alt_text : null;
    if (t) h1s.set(p.url, normaliseTitle(t, siteName));
  }
  const multi = sampleSize(ctx) >= 2;

  return forEachPage(ctx, 'C-2.3', (page, b) => {
    if (!page.is_html) return b.notApplicable('INSUFFICIENT_SAMPLE', 'Non-HTML resource.');
    const f = page.rawFacts;
    jsCaveat(b, page);
    const undetermined = f.mainMethod === 'body_minus_boilerplate';
    if (undetermined) b.note('MAIN_REGION_UNDETERMINED', 'No <main>/[role=main]/dominant block: evaluated over the whole body; C-2.3-d downgraded to informational (B-2.3-3).');
    const all = f.headings.filter((h) => !h.in_widget);
    const inScope = (h) => (undetermined ? !['header', 'footer', 'nav'].includes(h.zone) || h.level === 1 : h.in_main);
    const mainH1 = all.filter((h) => h.level === 1 && inScope(h));
    const anyH1 = all.filter((h) => h.level === 1);
    const ren = hasRendered(page) ? page.renFacts.headings.filter((h) => !h.in_widget) : null;
    const renH1 = ren ? ren.filter((h) => h.level === 1) : null;
    const outline = all.map((h) => `h${h.level}: ${h.text || h.alt_text || '(empty)'}`);
    b.metric('outline', outline.slice(0, 60)).metric('h1_count_main', mainH1.length).metric('aria_headings', f.ariaHeadings);
    const oEv = domEv(page, 'RAW', 'h1..h6 (document order)', outline.slice(0, 40).join(' | ') || '(none)');
    // Question-form headings → C-6.4 (R-2.3-10)
    ctx.derived.questionHeadings ||= new Map();
    ctx.derived.questionHeadings.set(page.url, all.filter((h) => QUESTION_RE.test(h.text)).map((h) => h.text));

    if (!all.length && !(ren && ren.length)) {
      b.hit('C-2.3-n', { summary: 'No headings of any level on the page.', evidence: [oEv], cross_references: ['C-6.3'] });
      if (f.ariaHeadings) b.note('ARIA_HEADING_PRESENT', `${f.ariaHeadings} role="heading" element(s) — not native heading elements (F-2.3-4).`);
      return;
    }
    if (!anyH1.length) {
      if (renH1 && renH1.length) b.hit('C-2.3-f', { summary: `h1 present only after rendering ("${renH1[0].text}").`, evidence: [domEv(page, 'RENDERED', 'h1', renH1[0].text)], cross_references: ['C-5.2'] });
      else b.hit('C-2.3-b', { summary: `No h1 in RAW${ren ? ' or RENDERED' : ''}.${page.isHomepage ? ' A real gap for entity extraction on the homepage (E-2.3-5).' : ''}`, evidence: [oEv], cross_references: ['C-6.2'] });
    }
    const h1 = mainH1[0] || anyH1[0];
    const h1Text = h1 ? h1.text || h1.alt_text || '' : null;
    if (h1 && !h1.text && h1.alt_text) b.note('H1_IMAGE_ALT', `h1 wraps an image; its alt text "${h1.alt_text}" is evaluated as the heading text (E-2.3-7).`);
    if (h1 && !h1Text) b.hit('C-2.3-c', { summary: 'h1 present but empty.', evidence: [domEv(page, 'RAW', 'h1', '(empty)')] });
    if (mainH1.length > 1) {
      if (undetermined) b.note('H1_MULTIPLE', `${mainH1.length} h1 elements (informational: main region undetermined).`);
      else b.hit('C-2.3-d', { summary: `${mainH1.length} h1 elements in the main region — valid HTML5 and not a ranking problem, but it weakens the single-topic signal for extraction.`, evidence: mainH1.map((h) => domEv(page, 'RAW', 'main h1', h.text)) });
    }
    if (h1Text && PLACEHOLDER_RE.test(h1Text)) b.hit('C-2.3-o', { summary: `h1 contains an unresolved placeholder: "${h1Text}".`, evidence: [domEv(page, 'RAW', 'h1', h1Text)] });
    if (h1Text && siteName && normName(h1Text) === normName(siteName) && anyH1.length === 1) b.hit('C-2.3-m', { summary: `The only h1 is the site name/logo ("${h1Text}").`, evidence: [domEv(page, 'RAW', 'h1', h1Text)], cross_references: ['C-6.2'] });

    // Hidden-state: RENDERED governs (R-2.3-2); never declared hidden on RAW alone (F-2.3-3).
    const domHeadings = page.rendered?.dom?.headings;
    if (domHeadings) {
      const visH1 = domHeadings.filter((h) => h.level === 1);
      if (visH1.length && visH1.every((h) => !h.visible)) b.hit('C-2.3-e', { summary: 'The only h1 is visually hidden (valid for accessibility, weak for extraction).', evidence: [domEv(page, 'RENDERED', 'h1 (computed style)', visH1.map((h) => h.text).join(' | '))] });
    } else if (anyH1.length && anyH1.every((h) => h.hidden_inline)) {
      b.caveat('The h1 carries an inline hidden/sr-only marker, but hidden state is not declared on RAW evidence alone (F-2.3-3); visibility_confidence = LOW.');
    }
    if (renH1 && renH1.length && h1Text && collapse(renH1[0].text || '') !== collapse(h1Text) && anyH1.length) {
      b.hit('C-2.3-g', { summary: `RAW h1 "${h1Text}" differs from RENDERED h1 "${renH1[0].text}".`, evidence: [domEv(page, 'RAW', 'h1', h1Text), domEv(page, 'RENDERED', 'h1', renH1[0].text)] });
    }
    if (!ren) b.caveat('RAW vs RENDERED headings not compared; C-2.3-f/g NOT_TESTABLE.');

    // Outline: skips and start level (R-2.3-3)
    let prev = null;
    const skips = [];
    for (const h of all) {
      if (prev && h.level > prev.level + 1) skips.push(`h${prev.level} → h${h.level} ("${h.text.slice(0, 50)}")`);
      prev = h;
    }
    if (skips.length) b.hit('C-2.3-i', { summary: `${skips.length} heading-level skip(s): ${skips.slice(0, 5).join('; ')}.`, evidence: [oEv] });
    const firstH1 = all.findIndex((h) => h.level === 1);
    if (firstH1 > 0 && all.slice(0, firstH1).some((h) => h.level >= 2 && h.in_main)) b.hit('C-2.3-j', { summary: 'Main content starts with h2+ before any h1.', evidence: [oEv] });
    const empty = all.filter((h) => !h.text && !h.alt_text && !h.aria_label);
    if (empty.length >= 3) b.hit('C-2.3-k', { summary: `${empty.length} empty headings.`, evidence: [oEv] });
    const byText = new Map();
    for (const h of all) byText.set(h.text, (byText.get(h.text) || 0) + 1);
    const layout = all.filter((h) => (h.text && h.text.length < 3) || (h.text && byText.get(h.text) > 5));
    if (layout.length) b.hit('C-2.3-l', { summary: `${layout.length} heading(s) look like layout use (text < 3 chars or repeated > 5 times).`, evidence: layout.slice(0, 5).map((h) => domEv(page, 'RAW', `h${h.level}`, h.text)) });

    // P6 duplicate h1 (R-2.3-8)
    if (h1Text && multi && !isPaginated(page.url)) {
      const n = normaliseTitle(h1Text, siteName);
      const dups = [...h1s.entries()].filter(([u, v]) => u !== page.url && v === n && !isPaginated(u)).map(([u]) => u);
      if (dups.length) b.hit('C-2.3-h', { summary: `h1 "${h1Text}" duplicates: ${dups.join(', ')}.`, evidence: [domEv(page, 'RAW', 'h1', h1Text)] });
    } else if (!multi) {
      b.caveat('Duplicate-h1 detection NOT_APPLICABLE — fewer than 2 sampled pages (B-2.3-4).');
    }
    if (f.ariaHeadings) b.note('ARIA_HEADING_PRESENT', `${f.ariaHeadings} role="heading" element(s) recorded separately — not native heading elements (F-2.3-4).`);
    b.addEvidence(oEv);
    if (!b.hits.length) b.pass(`Exactly one visible, non-empty h1 in the main region ("${h1Text}"), no level skips, unique in the sample.`);
  });
}
