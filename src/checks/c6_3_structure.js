// C-6.3 — Content Structure (page · deterministic; one optional rubric criterion).
// F-6.3-4: nothing measurable is delegated to the judge.
import { ev } from '../engine/result.js';
import { forEachPage, domEv } from './_util.js';
import { collapse, wordCount, sentences, isMostlyNonLatin } from '../parse/text.js';
import { MODELLED_CAVEAT, NON_DETERMINISTIC_CAVEAT } from '../llm/judge.js';

const LEGAL = /\b(terms (of|and) (service|use|conditions)|privacy policy|cookie policy|legal notice|disclaimer|acceptable use|data processing agreement|gdpr)\b/i;
const UNRESOLVED_OPENER = /^(it|this|that|these|those|they|he|she|there|such)\b/i;

const CRITERION = { id: 'S1', label: 'Section independence', guide: 'Could each top-level section be lifted out of the page and still make sense on its own?' };

export async function run(ctx) {
  ctx.derived.structure = new Map();
  return forEachPage(ctx, 'C-6.3', async (page, b) => {
    if (!page.is_html) return b.notApplicable('INSUFFICIENT_CONTENT_FOR_STRUCTURE', 'Non-HTML resource.');
    const f = page.rawFacts;
    const $ = f.$;
    const extraction = ctx.derived.extraction?.get(page.url);
    const text = extraction?.main || f.mainText;
    const words = wordCount(text);
    const nonLatin = isMostlyNonLatin(text);
    const isLegal = LEGAL.test(`${f.titles[0]?.text || ''} ${f.headings.map((h) => h.text).join(' ')}`);

    if (words < ctx.cfg.th.min_words_content_page) {
      b.notApplicable('INSUFFICIENT_CONTENT_FOR_STRUCTURE', `Main content is ${words} words: structure rules do not apply below ${ctx.cfg.th.min_words_content_page} words, and the length itself is reported by C-6.1 (E-6.3-1).`);
      b.metric('word_count', words);
      b.xref('C-6.1');
      return;
    }
    if (extraction?.degraded) b.caveat('Content extraction was degraded (C-6.1); structure metrics inherit that limitation and the achievable status is capped at WARN (B-6.3-4).');

    // R-6.3-1 heading map + section word counts, with code blocks excluded (E-6.3-2, F-6.3-3)
    const headings = f.headings.filter((h) => h.in_main || f.mainMethod === 'body_minus_boilerplate').filter((h) => !h.in_widget);
    const codeText = new Set();
    $('pre, code').each((_, el) => codeText.add(collapse($(el).text())));
    const sectionsList = sectionize($, headings, codeText);
    const byLevel = {};
    for (const h of headings) byLevel[`h${h.level}`] = (byLevel[`h${h.level}`] || 0) + 1;
    const sectionWords = sectionsList.map((s) => s.words);
    // A heading whose own prose runs past the cap is the one a reader meets without a break; a
    // parent section that is long only because it nests subsections is correctly structured.
    const overlong = sectionsList.filter((s) => s.own_words > ctx.cfg.structure.max_section_words);
    const tiny = sectionsList.filter((s) => s.own_words > 0 && s.own_words < 20);
    let skips = 0;
    let prev = null;
    for (const h of headings) {
      if (prev && h.level > prev + 1) skips++;
      prev = h.level;
    }

    // R-6.3-2 paragraphs
    const paras = f.paragraphs.filter((p) => !codeText.has(p));
    const paraWords = paras.map((p) => wordCount(p));
    const longParas = paraWords.filter((n) => n > ctx.cfg.structure.max_para_words);

    // R-6.3-4 chunk viability — chunks are the page's top-level sections (each carrying its own
    // subsections), split further at paragraph boundaries when one exceeds the cap.
    const chunks = buildChunks(chunkRoots(sectionsList), ctx.cfg.structure.max_section_words);
    const viable = chunks.filter((c) => c.words >= 40 && c.words <= 400 && selfContained(c.first));
    const viability = chunks.length ? viable.length / chunks.length : null;

    // R-6.3-9 sentence stats
    const sents = nonLatin ? [] : sentences(text);
    const sentWords = sents.map((s) => wordCount(s));
    const meanSentence = sentWords.length ? sentWords.reduce((a, n) => a + n, 0) / sentWords.length : null;
    const longSentenceShare = sentWords.length ? sentWords.filter((n) => n > 40).length / sentWords.length : null;

    const lists = f.lists;
    const tables = f.tables;
    const hasToc = $('nav a[href^="#"], .toc a[href^="#"], #toc a[href^="#"], [aria-label*="table of contents" i] a').length >= 3;
    b.metric('word_count', words)
      .metric('headings_by_level', byLevel)
      .metric('sections', sectionsList.length)
      .metric("chunk_root_sections", chunkRoots(sectionsList).length)
      .metric('max_section_words', sectionWords.length ? Math.max(...sectionWords) : 0)
      .metric('max_unbroken_prose_words', sectionsList.length ? Math.max(...sectionsList.map((s) => s.own_words)) : 0)
      .metric('mean_section_words', sectionWords.length ? Math.round(sectionWords.reduce((a, n) => a + n, 0) / sectionWords.length) : 0)
      .metric('paragraphs', paras.length)
      .metric('max_paragraph_words', paraWords.length ? Math.max(...paraWords) : 0)
      .metric('lists', lists.length)
      .metric('tables', tables.length)
      .metric('chunk_viability', viability == null ? null : Number(viability.toFixed(2)))
      .metric('heading_level_skips', skips)
      .metric('mean_sentence_words', meanSentence == null ? null : Math.round(meanSentence))
      .metric('long_sentence_share', longSentenceShare == null ? null : Number(longSentenceShare.toFixed(2)))
      .metric('table_of_contents', hasToc);
    ctx.derived.structure.set(page.url, { chunks, sections: sectionsList, viability });

    const cEv = ev({ kind: 'computed', source_url: page.finalUrl, fetch_profile: 'RAW', selector_or_key: 'chunk_viability = viable chunks / total chunks', observed_value: `${viable.length}/${chunks.length} = ${viability == null ? 'n/a' : viability.toFixed(2)}; ${sectionsList.length} section(s), longest ${sectionWords.length ? Math.max(...sectionWords) : 0} words`, expected_value: '≥ 0.70' });
    b.addEvidence(cEv);
    if (nonLatin) b.caveat('Word- and sentence-length thresholds are calibrated to English; for this script the values are reported and the threshold-based conditions are suppressed (E-6.3-6, F-6.3-1).');

    // R-6.3-5 wall of text
    if (words >= 500 && headings.length < 2 && !lists.length && !tables.length) {
      b.hit('C-6.3-b', { summary: `Wall of text: ${words} words with ${headings.length} heading(s) and no lists or tables, so there are no boundaries for a retrieval system to chunk on.`, evidence: [cEv] });
    }
    if (viability != null && !nonLatin) {
      if (viability < 0.4) b.hit('C-6.3-c', { summary: `Only ${Math.round(viability * 100)}% of chunks are viable (40–400 words with a self-contained opening sentence).`, evidence: [cEv, ...chunks.filter((c) => !selfContained(c.first)).slice(0, 3).map((c) => domEv(page, 'RAW', `section "${c.heading || '(no heading)'}"`, c.first.slice(0, 200)))] });
      else if (viability < 0.7) b.hit('C-6.3-d', { summary: `${Math.round(viability * 100)}% of chunks are viable; several open with an unresolved pronoun or bare demonstrative.`, evidence: [cEv] });
    }
    if (overlong.length) {
      if (isLegal) b.note('OVERLONG_SECTIONS', `${overlong.length} section(s) exceed ${ctx.cfg.structure.max_section_words} words — long numbered sections are the correct form on a legal page (E-6.3-3).`);
      else b.hit('C-6.3-e', { summary: `${overlong.length} section(s) run past ${ctx.cfg.structure.max_section_words} words of unbroken prose (longest ${Math.max(...overlong.map((s) => s.own_words))}): "${overlong[0].heading || '(no heading)'}".`, evidence: [cEv] });
    }
    if (longParas.length >= 3 && !nonLatin) {
      if (isLegal) b.note('OVERLONG_PARAGRAPHS', `${longParas.length} paragraphs exceed ${ctx.cfg.structure.max_para_words} words — expected on a legal page (E-6.3-3).`);
      else b.hit('C-6.3-f', { summary: `${longParas.length} paragraphs exceed ${ctx.cfg.structure.max_para_words} words (longest ${Math.max(...longParas)}).`, evidence: [cEv] });
    }
    if (headings.length === 1 && words >= 800) {
      const visualSections = ['homepage', 'service_main', 'service_secondary'].includes(page.page_type) && f.headings.filter((h) => h.level === 2).length >= 2;
      if (visualSections || words < 400) b.note('INSUFFICIENT_HEADINGS', 'Single top-level heading on a visually-sectioned landing page (E-6.3-4).');
      else b.hit('C-6.3-g', { summary: `${words} words under a single heading.`, evidence: [cEv] });
    }
    // R-6.3-6 layout tables vs data tables
    const layoutTables = tables.filter((t) => !t.has_th && !t.has_caption && t.has_block_layout);
    if (layoutTables.length) b.hit('C-6.3-h', { summary: `${layoutTables.length} table(s) used for layout rather than data.`, evidence: [domEv(page, 'RAW', 'table (no th, no caption, block children)', `${layoutTables.length} of ${tables.length} tables`)] });
    const noHeaderTables = tables.filter((t) => !t.has_th && !t.has_block_layout);
    if (noHeaderTables.length) b.hit('C-6.3-i', { summary: `${noHeaderTables.length} data table(s) have no <th> header cells${page.page_type === 'pricing' ? ' (common in styled pricing components — E-6.3-5)' : ''}.`, evidence: [domEv(page, 'RAW', 'table without th', String(noHeaderTables.length))] });
    if (skips >= 3) b.hit('C-6.3-j', { summary: `${skips} heading-level skips break the outline hierarchy.`, evidence: [domEv(page, 'RAW', 'heading outline', headings.map((h) => `h${h.level}`).join(' → '))], cross_references: ['C-2.3'] });
    // R-6.3-8 list abuse
    const proseLists = lists.filter((l) => l.items >= 2 && l.avg_words > 60);
    if (proseLists.length) b.note('OVERLONG_PARAGRAPHS', `${proseLists.length} list(s) average over 60 words per item — prose in list clothing, which does not chunk better than a paragraph (R-6.3-8).`);
    if (hasToc) b.note('MODERATE_CHUNK_VIABILITY', 'A table of contents / on-page anchor navigation is present (R-6.3-7).');

    // R-6.3-10 single rubric criterion
    if (!ctx.llm.enabled) {
      b.note('RUBRIC_DISABLED', `Section-independence criterion S1 is NOT_TESTABLE: ${ctx.llm.disabledReason}. This check loses little without the judge, by design (B-6.3-3).`);
    } else if (ctx.llm.budgetLeftFor('C-6.3') > 0 && sectionsList.length >= 2) {
      const res = await ctx.llm.score({ page: { url: page.finalUrl, page_type: page.page_type, text, outline: headings.map((h) => `h${h.level}: ${h.text}`) }, criteria: [CRITERION], rubricName: 'C-6.3 section independence', checkId: 'C-6.3' });
      if (res.ok && !res.criteria.S1.not_testable) {
        b.metric('rubric_S1', res.criteria.S1).metric('rubric_version', res.rubric_version);
        b.setConfidence(b.confidence === 'OBSERVED' ? 'OBSERVED' : b.confidence);
        b.note('MODERATE_CHUNK_VIABILITY', `Section independence (modelled, rubric ${res.rubric_version}): ${res.criteria.S1.score}/3 — ${res.criteria.S1.justification} ${MODELLED_CAVEAT} ${NON_DETERMINISTIC_CAVEAT}`);
      } else if (res.ok) {
        b.note('RUBRIC_PARSE_FAILED', 'Criterion S1 became NOT_TESTABLE: no verbatim quote supported a non-zero score (R-S6-3).');
      }
    }

    if (extraction?.degraded) for (const h of b.hits) if (h.status === 'FAIL') h.status = 'WARN';
    if (!b.hits.length) b.pass(`${headings.length} heading(s), longest section ${sectionWords.length ? Math.max(...sectionWords) : 0} words, chunk viability ${viability == null ? 'n/a' : viability.toFixed(2)}${lists.length || tables.length ? `, ${lists.length} list(s) and ${tables.length} table(s)` : ''}.`);
  });
}

/**
 * Build the heading map of R-2.3-9: for each heading, the text between it and the next heading of
 * equal or higher level — so an h2 section owns its h3 subsections.
 *
 * Two counts are kept, because they answer different questions:
 *   own_words   — prose directly under the heading, before any subheading. This is what the
 *                 overlong-section test means by a section a reader hits without a break.
 *   words       — the whole section including its subsections. This is the retrieval unit, and the
 *                 one chunking uses; counting a 22-word subheading as its own chunk would fail the
 *                 40-word floor on content that is not fragmented at all, only nested.
 */
function sectionize($, headings, codeText) {
  const sections = [];
  if (!headings.length) return sections;
  const used = new Set();
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    // Text directly under this heading, stopping at the next heading of any level.
    const matches = $(`h${h.level}`).filter((_, el) => collapse($(el).text()) === h.text);
    let start = null;
    matches.each((_, el) => {
      if (start) return;
      const node = $(el);
      const key = `${h.level}|${h.text}|${matches.index(node)}`;
      if (used.has(key)) return;
      used.add(key);
      start = node;
    });
    const between = [];
    if (start?.length) {
      let node = start.next();
      let guard = 0;
      while (node.length && guard++ < 400) {
        const tag = node.get(0)?.tagName;
        if (tag && /^h[1-6]$/.test(tag)) break;
        const t = collapse(node.text());
        if (t && !codeText.has(t)) between.push(t);
        node = node.next();
      }
    }
    const own = between.join(' ');
    sections.push({ heading: h.text, level: h.level, own_text: own, own_words: wordCount(own), index: i });
  }
  // Roll subsection text up into the nearest ancestor section (R-2.3-9 boundary).
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const parts = [s.own_text];
    for (let j = i + 1; j < sections.length; j++) {
      if (sections[j].level <= s.level) break; // next heading of equal or higher level ends the section
      parts.push(sections[j].heading, sections[j].own_text);
    }
    const text = parts.filter(Boolean).join(' ');
    s.text = text;
    s.words = wordCount(text);
    s.first = sentences(s.own_text)[0] || sentences(text)[0] || '';
  }
  return sections;
}

/**
 * The page's chunk roots: every maximal section, i.e. one contained by no other.
 *
 * Because each section already rolls its subsections up (R-2.3-9), the maximal sections tile the
 * page exactly once — no content is chunked twice, and none is dropped. A heading that appears
 * before any shallower heading is a root in its own right, which matters on pages that open with
 * h3 cards and only reach an h2 further down.
 *
 * The leading page-title h1 is excluded first: it contains everything, so keeping it would make the
 * whole page a single chunk and the viability measure meaningless.
 */
export function chunkRoots(sections) {
  if (!sections.length) return [];
  let list = sections;
  const h1s = sections.filter((s) => s.level === Math.min(...sections.map((x) => x.level)));
  if (h1s.length === 1 && h1s[0].index === sections[0].index && sections.length > 1) list = sections.slice(1);
  const roots = [];
  const openLevels = [];
  for (const s of list) {
    while (openLevels.length && openLevels[openLevels.length - 1] >= s.level) openLevels.pop();
    if (!openLevels.length) roots.push(s);
    openLevels.push(s.level);
  }
  return roots;
}

function buildChunks(sections, maxWords) {
  const chunks = [];
  for (const s of sections) {
    if (!s.words) continue;
    if (s.words <= maxWords) {
      chunks.push({ heading: s.heading, words: s.words, first: s.first || s.heading });
      continue;
    }
    // Split at paragraph boundaries where a section exceeds the cap.
    const parts = s.text.split(/(?<=\.)\s+(?=[A-Z])/);
    let buf = [];
    let count = 0;
    for (const p of parts) {
      buf.push(p);
      count += wordCount(p);
      if (count >= maxWords * 0.6) {
        chunks.push({ heading: s.heading, words: count, first: sentences(buf.join(' '))[0] || buf[0] });
        buf = [];
        count = 0;
      }
    }
    if (buf.length) chunks.push({ heading: s.heading, words: count, first: sentences(buf.join(' '))[0] || buf[0] });
  }
  return chunks;
}

export function selfContained(sentence) {
  const s = collapse(sentence || '');
  if (!s) return false;
  if (UNRESOLVED_OPENER.test(s)) return false;
  if (/\b(as (mentioned|described|noted) (above|below|earlier)|see (above|below)|the above|the following)\b/i.test(s)) return false;
  return /[A-Z][\p{L}]+|\d/u.test(s);
}
