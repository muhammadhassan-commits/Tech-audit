// C-6.4 — Answer Extractability (page · deterministic gate + rubric).
// Simulates what retrieval does to content: can an answer be lifted out and still be true and
// attributable? F-6.4-1: no claim is ever made about whether an AI system will cite the page.
import { ev } from '../engine/result.js';
import { forEachPage, domEv, renderedDomObservable} from './_util.js';
import { collapse, wordCount, sentences, isMostlyNonLatin } from '../parse/text.js';
import { selfContained } from './c6_3_structure.js';
import { MODELLED_CAVEAT, NON_DETERMINISTIC_CAVEAT } from '../llm/judge.js';

const THROAT_CLEARING = /^(in (today'?s|this) (fast-paced|digital|modern|competitive)|before we (dive|get|begin)|let'?s (dive|take a look|explore|start)|as (we all know|you (may|might) know)|in this (article|post|guide) (we|you)|it'?s no secret|we all know|first, (let'?s|we))/i;
const DEFERRING = /(we'?ll (cover|discuss|explain|explore|look at) (this|that|it) (below|later|in a moment)|more on (this|that) (below|later)|read on to|keep reading|as we'?ll see)/i;
const DEFINITIONAL = /\b(is|are|refers to|means|describes|denotes)\s+(a|an|the)?\s*[\w\s,'-]{3,90}/i;
const NAMED_ENTITY = /\b[A-Z][\p{L}]+(?:\s+[A-Z][\p{L}]+)*\b/u;
const MEASURABLE = /\b\d+([.,]\d+)?\s*(%|percent|ms|s|kb|mb|gb|x|hours?|days?|weeks?|months?|years?|users?|customers?|countries)\b|[$€£¥₹]\s?\d/i;

const CRITERIA = [
  { id: 'A1', label: 'Direct answering', guide: 'Does the content answer the questions its headings pose, immediately beneath them?' },
  { id: 'A2', label: 'Excerpt survivability', guide: 'Would a 2-3 sentence excerpt remain accurate and comprehensible with the rest of the page removed?' },
  { id: 'A3', label: 'Claim specificity', guide: 'Are claims concrete and checkable rather than vague?' },
  { id: 'A4', label: 'Attribution clarity', guide: 'Is it clear who is asserting this and on what basis?' },
];

export async function run(ctx) {
  return forEachPage(ctx, 'C-6.4', async (page, b) => {
    if (!page.is_html) return b.notApplicable('INSUFFICIENT_CONTENT', 'Non-HTML resource.');
    const f = page.rawFacts;
    const extraction = ctx.derived.extraction?.get(page.url);
    const text = extraction?.main || f.mainText;
    const words = wordCount(text);
    if (words < ctx.cfg.th.min_words_content_page) {
      b.notApplicable('INSUFFICIENT_CONTENT', `Main content is ${words} words, below the ${ctx.cfg.th.min_words_content_page}-word threshold for extractability analysis.`);
      b.xref('C-6.1');
      return;
    }
    const nonLatin = isMostlyNonLatin(text);
    if (nonLatin) {
      b.notTestable('INSUFFICIENT_CONTENT', 'Pronoun and definitional detection are language-specific and unsupported for this script; gate items would produce false ratios, so they are not computed (E-6.4-5, F-6.4-4).');
      b.metric('word_count', words);
      return;
    }
    if (extraction?.degraded) b.caveat('Content extraction was degraded (C-6.1); this check inherits the cap and caveat (B-6.4-3).');
    const structure = ctx.derived.structure?.get(page.url);

    // R-6.4-1/2 question headings and their answers
    const questionHeadings = ctx.derived.questionHeadings?.get(page.url) || [];
    const answered = [];
    const unanswered = [];
    for (const q of questionHeadings) {
      const section = structure?.sections.find((s) => collapse(s.heading) === collapse(q));
      if (!section) continue;
      const sents = sentences(section.text);
      const first = sents[0] || '';
      const qTerms = collapse(q).toLowerCase().split(/\W+/).filter((t) => t.length > 3);
      const direct = !!first && !THROAT_CLEARING.test(first) && !DEFERRING.test(first) && !/\?$/.test(first) && qTerms.some((t) => first.toLowerCase().includes(t));
      const brief = sents.length <= 3;
      (direct && brief ? answered : unanswered).push({ q, first, sentences: sents.length, direct, brief });
    }
    // R-6.4-3 standalone-sentence analysis (first 20 sentences following a heading)
    const following = (structure?.sections || []).flatMap((s) => sentences(s.text).slice(0, 4)).slice(0, 20);
    const pool = following.length ? following : sentences(text).slice(0, 20);
    const standalone = pool.filter((s) => selfContained(s) && (NAMED_ENTITY.test(s) || MEASURABLE.test(s)));
    const standaloneRatio = pool.length ? standalone.length / pool.length : null;

    // R-6.4-4 definitional extractability
    const subject = f.headings.find((h) => h.level === 1)?.text || f.titles[0]?.text || '';
    const subjTerms = collapse(subject).toLowerCase().split(/\W+/).filter((t) => t.length > 3);
    const defSentence = sentences(text).slice(0, 40).find((s) => DEFINITIONAL.test(s) && (subjTerms.length === 0 || subjTerms.some((t) => s.toLowerCase().includes(t))));

    // R-6.4-5 factual density
    const allSents = sentences(text);
    const factual = allSents.filter((s) => MEASURABLE.test(s) || /\b(19|20)\d{2}\b/.test(s) || NAMED_ENTITY.test(s.replace(/^[A-Z][\p{L}]+/u, '')));
    const density = allSents.length ? factual.length / allSents.length : null;

    // R-6.4-6 attribution scaffolding
    const visibleText = page.rendered?.dom?.visibleText || f.bodyText;
    // Without a browser this is textContent, not innerText: it includes text a reader cannot see.
    if (!renderedDomObservable(page)) {
      b.note('VISIBLE_TEXT_APPROXIMATED', 'Author and date presence were read from the page’s text content rather than from what a browser renders, because this run had no browser. Text hidden by CSS counts as present here, so a byline or date in collapsed or off-screen markup may be credited as visible.');
    }
    const hasAuthor = /\b(by|written by|author)\s*:?\s+[A-Z][\p{L}'-]+/u.test(visibleText) || !!f.og['article:author'];
    const hasDate = f.timeEls.length > 0 || /\b(19|20)\d{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+(19|20)\d{2}\b/i.test(visibleText);
    const outboundCitations = f.links.filter((l) => !l.discard && !l.same_site && l.in_main).length;
    const makesFactualClaims = (density ?? 0) > 0.05 && allSents.length >= 10;

    // R-6.4-7 list/table answers
    const answerStructures = (structure?.sections || []).filter((s) => /^(how|what|steps|vs\.?|versus|compare)/i.test(s.heading || '')).length;
    // R-6.4-8 anti-patterns
    const openers = (structure?.sections || []).map((s) => sentences(s.text)[0] || '').filter(Boolean);
    const antipatterns = openers.filter((s) => THROAT_CLEARING.test(s) || DEFERRING.test(s));

    b.metric('word_count', words)
      .metric('question_headings', questionHeadings.length)
      .metric('questions_answered_within_3_sentences', answered.length)
      .metric('standalone_ratio', standaloneRatio == null ? null : Number(standaloneRatio.toFixed(2)))
      .metric('definitional_sentence', defSentence || null)
      .metric('factual_density', density == null ? null : Number(density.toFixed(2)))
      .metric('attribution', { author: hasAuthor, date: hasDate, outbound_citations: outboundCitations })
      .metric('answer_structures', answerStructures)
      .metric('antipatterns', antipatterns.length);

    const sEv = ev({ kind: 'computed', source_url: page.finalUrl, fetch_profile: 'RAW', selector_or_key: 'standalone_ratio = self-contained sentences / evaluated', observed_value: `${standalone.length}/${pool.length} = ${standaloneRatio == null ? 'n/a' : standaloneRatio.toFixed(2)}; factual density ${density == null ? 'n/a' : density.toFixed(2)}; ${answered.length}/${questionHeadings.length} question headings answered within 3 sentences`, expected_value: '≥ 0.70' });
    b.addEvidence(sEv);

    const narrative = page.page_type === 'about';
    const product = page.page_type === 'product_main';
    if (standaloneRatio != null) {
      if (standaloneRatio < 0.4) {
        if (narrative) b.hit('C-6.4-b', { status: 'WARN', severity: 'MEDIUM', reason_code: 'WEAK_SELF_CONTAINMENT', summary: `Self-containment ${standaloneRatio.toFixed(2)} — downgraded one band: narrative/brand-story content on an About page is a genre where self-containment is a lower priority (E-6.4-1).`, evidence: [sEv] });
        else b.hit('C-6.4-b', { summary: `Only ${Math.round(standaloneRatio * 100)}% of sentences survive being lifted out of the page: the rest open with an unresolved pronoun, a bare demonstrative, or carry no concrete term.`, evidence: [sEv, ...pool.filter((s) => !selfContained(s)).slice(0, 3).map((s) => domEv(page, 'RAW', 'sentence following a heading', s.slice(0, 200)))] });
      } else if (standaloneRatio < 0.7) {
        b.hit('C-6.4-c', { summary: `${Math.round(standaloneRatio * 100)}% of evaluated sentences are self-contained.`, evidence: [sEv] });
      }
    }
    if (questionHeadings.length && !answered.length) {
      b.hit('C-6.4-d', { summary: `${questionHeadings.length} question-form heading(s), none answered directly within three sentences: ${unanswered.slice(0, 3).map((u) => `"${u.q}" → "${collapse(u.first).slice(0, 90)}"`).join('; ')}.`, evidence: unanswered.slice(0, 3).map((u) => domEv(page, 'RAW', `answer under "${u.q}"`, u.first.slice(0, 200))) });
    } else if (!questionHeadings.length) {
      b.note('QUESTIONS_NOT_DIRECTLY_ANSWERED', 'No question-form headings on this page: C-6.4-d is NOT_APPLICABLE, and definitional extractability is assessed instead (E-6.4-7).');
    }
    if (!defSentence) {
      if (product) b.note('NO_DEFINITIONAL_ANSWER', 'No definitional sentence — downgraded for a product page, where specifications and prices are the answers (E-6.4-2).');
      else b.hit('C-6.4-e', { summary: `No sentence defines the page's primary subject${subject ? ` ("${collapse(subject).slice(0, 60)}")` : ''} in a form that could be quoted on its own.`, evidence: [sEv] });
    }
    if (makesFactualClaims && density != null && density < 0.1) {
      b.hit('C-6.4-f', { summary: `Factual density ${density.toFixed(2)}: few sentences carry a number, date, named entity or measurable claim.`, evidence: [sEv] });
    }
    if (makesFactualClaims && !hasAuthor && !hasDate && !outboundCitations) {
      b.hit('C-6.4-g', { summary: 'The page makes factual claims with no visible author, no date and no source links: extractable, but not trustable — those are different problems.', evidence: [ev({ kind: 'computed', source_url: page.finalUrl, fetch_profile: 'RAW', selector_or_key: 'attribution scaffolding', observed_value: 'author: no; date: no; outbound citations: 0' })], cross_references: ['C-6.5'] });
    }
    if (antipatterns.length >= 3) {
      b.hit('C-6.4-h', { summary: `${antipatterns.length} section(s) open with throat-clearing or a deferral: "${collapse(antipatterns[0]).slice(0, 100)}".`, evidence: antipatterns.slice(0, 3).map((s) => domEv(page, 'RAW', 'section opening sentence', s.slice(0, 180))) });
    }
    if (answerStructures) b.note('QUESTIONS_NOT_DIRECTLY_ANSWERED', `${answerStructures} heading(s) are followed by a list or table that answers them directly (R-6.4-7).`);

    // Rubric
    if (!ctx.llm.enabled) {
      b.note('RUBRIC_DISABLED', `extractability_score is NOT_TESTABLE: ${ctx.llm.disabledReason}. The deterministic gate findings still stand (C-6.4-k).`);
      return;
    }
    if (ctx.llm.budgetLeftFor('C-6.4') <= 0) {
      b.note('RUBRIC_DISABLED', "This check's share of the LLM call budget is spent; this page is gate-only (F-6.2-5).");
      return;
    }
    const res = await ctx.llm.score({ page: { url: page.finalUrl, page_type: page.page_type, text, outline: f.headings.map((h) => `h${h.level}: ${h.text}`) }, criteria: CRITERIA, rubricName: 'C-6.4 answer extractability', checkId: 'C-6.4' });
    if (!res.ok) {
      b.note(res.reason, `Rubric did not run: ${res.detail}.`);
      return;
    }
    const scored = Object.entries(res.criteria).filter(([, v]) => !v.not_testable);
    const total = scored.reduce((a, [, v]) => a + v.score, 0);
    const score = scored.length ? total / (scored.length * 3) : null;
    b.metric('extractability_score', score == null ? null : Number(score.toFixed(2)))
      .metric('rubric', Object.fromEntries(Object.entries(res.criteria).map(([k, v]) => [k, { score: v.score, justification: v.justification, quote: v.quote, not_testable: !!v.not_testable }])))
      .metric('rubric_version', res.rubric_version);
    for (const [k, v] of Object.entries(res.criteria)) if (v.not_testable) b.note('RUBRIC_PARSE_FAILED', `Criterion ${k} became NOT_TESTABLE: no verbatim quote supported a non-zero score (R-S6-3).`);
    if (score != null) {
      b.setConfidence('MODELLED', MODELLED_CAVEAT);
      b.caveat(NON_DETERMINISTIC_CAVEAT);
      const rEv = ev({ kind: 'computed', source_url: page.finalUrl, fetch_profile: 'NONE', selector_or_key: `extractability_score (rubric ${res.rubric_version}, model ${res.model})`, observed_value: `${total}/${scored.length * 3} = ${score.toFixed(2)} — ` + scored.map(([k, v]) => `${k}=${v.score} ("${collapse(v.quote).slice(0, 70)}")`).join('; '), expected_value: '≥ 0.50' });
      b.addEvidence(rEv);
      if (score < 0.5) b.hit('C-6.4-i', { summary: `Modelled extractability score ${score.toFixed(2)}: ${scored.filter(([, v]) => v.score <= 1).map(([k, v]) => `${k} — ${v.justification}`).join(' ')}`, evidence: [rEv] });
    }
    if (extraction?.degraded) for (const h of b.hits) if (h.status === 'FAIL') h.status = 'WARN';
    if (!b.hits.length) b.pass(`Self-containment ${standaloneRatio == null ? 'n/a' : standaloneRatio.toFixed(2)}${answered.length ? `, ${answered.length} question heading(s) answered within three sentences` : defSentence ? ', with a definitional sentence present' : ''}${hasAuthor || hasDate ? ', attribution present' : ''}.`);
  });
}
