// C-6.2 — Entity Clarity (page + site · deterministic gate + optional rubric).
// R-6.2-5 is a proxy for "the page declares its subject", not a topical-relevance model.
// F-6.2-3: no claim is ever made about how an AI system resolves this entity.
import { ResultBuilder, ev, errorResult } from '../engine/result.js';
import { forEachPage, renderedDomObservable} from './_util.js';
import { collapse, significantTokens, jaccard, shingles, sentences, isMostlyNonLatin } from '../parse/text.js';
import { detectSiteName, normName } from './_sitename.js';
import { MODELLED_CAVEAT, NON_DETERMINISTIC_CAVEAT, RAW_ONLY_CAVEAT } from '../llm/judge.js';

const DEFINITIONAL = /\b(is|are)\s+(a|an|the)\s+[\w\s,'-]{3,90}?\b(that|which|for|helping|providing|offering|serving|specialising|specializing|designed|built|used)\b/i;
const AMBIGUOUS = new Set(['apple', 'amazon', 'orange', 'target', 'shell', 'mercury', 'jaguar', 'delta', 'oracle', 'square', 'notion', 'linear', 'pulse', 'focus', 'bloom', 'atlas', 'echo', 'nova', 'spark', 'zen', 'peak', 'core', 'base', 'hub', 'flow', 'mint', 'ember', 'monday', 'zoom', 'box', 'drift', 'loom', 'sage', 'wave', 'summit', 'anchor', 'beacon', 'compass', 'forge', 'north', 'prime', 'vertex', 'element']);

const CRITERIA = [
  { id: 'E1', label: 'Subject identifiability', guide: 'Can the page\'s primary subject be named from the first 150 words?' },
  { id: 'E2', label: 'Publisher identifiability', guide: 'Can the publishing organisation be named from the page alone?' },
  { id: 'E3', label: 'Category placement', guide: 'Does the page state what category or class the entity belongs to?' },
  { id: 'E4', label: 'Disambiguation', guide: 'Does the page distinguish the entity from similarly-named or adjacent things?' },
];

/**
 * Is this string a name, or a sentence that happens to sit where a name could?
 * Entity names are short and do not close with terminal punctuation; slogans and headlines do one
 * or both. Used only for the inferred sources (h1, logo alt), never for declared name fields.
 */
export function isNameShaped(s) {
  const t = collapse(s);
  if (!t) return false;
  // A sentence break, as distinct from an abbreviation: "…comes back. Not you." breaks, while
  // "Acme Corp. Ltd" does not, because a short token before the period reads as an abbreviation.
  if (/[!?]\s+\S/.test(t)) return false;
  if (/(\w{5,})\.["')]?\s+["'(]?[A-Z]/.test(t)) return false;
  if (/[!?]$/.test(t)) return false;
  if (/\.$/.test(t) && /(\w{5,})\.$/.test(t)) return false; // a closing full stop, not an abbreviation
  return t.split(/\s+/).length <= 6;
}

export async function run(ctx) {
  const results = [];
  const siteName = detectSiteName(ctx);
  const org = ctx.derived.schema?.org;
  const S = ctx.derived.schema;
  const hp = ctx.homepage;

  // ── Site-level: name and description consistency (R-6.2-1…R-6.2-4, R-6.2-6) ──
  try {
    const b = new ResultBuilder(ctx, 'C-6.2', { scope: 'site', target_url: ctx.canonicalOrigin });
    const personalSite = !org && (S?.persons?.size > 0);
    if (personalSite) {
      const person = [...S.persons.values()][0][0];
      b.notApplicable('ENTITY_NAME_INCONSISTENT', `This is a personal site: a Person node ("${person?.name || 'unnamed'}") stands in place of an Organization, so organisation-name consistency does not apply (E-6.2-3). The Person node is evaluated in C-3.1.`);
      b.addEvidence(ev({ kind: 'computed', source_url: ctx.canonicalOrigin, selector_or_key: 'entity type', observed_value: `Person: ${person?.name || '(unnamed)'}` }));
      results.push(b.build());
    } else {
      // R-6.2-1 candidate names, in order. Sources that declare a name outright are always name
      // claims; the homepage h1 and the logo alt are inferred, so they count only when they are
      // shaped like a name. A marketing-slogan h1 is not a competing name — E-2.3-8 says it is not
      // a defect on its own — and treating it as one would report an inconsistency on a site whose
      // name is in fact stated identically everywhere.
      const h1Text = hp?.rawFacts?.headings.find((h) => h.level === 1)?.text || null;
      const logoAlt = hp?.rawFacts?.logoAlt || null;
      const all = [
        { key: 'Organization.name', value: org?.name || null },
        { key: 'Organization.legalName', value: org?.legalName || null, legal: true },
        { key: 'WebSite.name', value: S?.websiteName || null },
        { key: 'homepage h1', value: h1Text, inferred: true },
        { key: 'og:site_name', value: hp?.rawFacts?.og?.['og:site_name'] || null },
        { key: 'title brand suffix', value: siteName || null },
        { key: 'logo alt', value: logoAlt, inferred: true },
        { key: 'llms.txt H1', value: ctx.derived.llmsTxt?.parsed?.h1 || null },
      ].filter((s) => s.value && collapse(s.value));
      const sources = all.filter((s) => !s.inferred || isNameShaped(s.value));
      const prose = all.filter((s) => s.inferred && !isNameShaped(s.value));
      for (const p of prose) {
        b.note('NO_DEFINITIONAL_STATEMENT', `The ${p.key} is a sentence rather than a name ("${collapse(p.value).slice(0, 90)}"), so it is not read as a competing name claim. It is assessed as page content instead (E-2.3-8).`);
      }
      b.metric('name_sources_excluded_as_prose', prose.map((p) => ({ source: p.key, value: collapse(p.value) })));
      const matrix = [];
      const disagreements = [];
      for (let i = 0; i < sources.length; i++) {
        for (let j = i + 1; j < sources.length; j++) {
          const a = sources[i];
          const c = sources[j];
          const exact = collapse(a.value) === collapse(c.value);
          const normalised = normName(a.value) === normName(c.value);
          const contained = normName(a.value).includes(normName(c.value)) || normName(c.value).includes(normName(a.value));
          matrix.push({ a: a.key, b: c.key, exact, normalised, contained });
          // E-6.2-1 legalName↔name and E-6.2-6 case/punctuation-only differences are excluded.
          if (!normalised && !contained && !a.legal && !c.legal) disagreements.push(`${a.key} "${collapse(a.value)}" vs ${c.key} "${collapse(c.value)}"`);
        }
      }
      b.metric('name_sources', sources.map((s) => ({ source: s.key, value: collapse(s.value) })))
        .metric('name_matrix', matrix)
        .metric('distinct_names', [...new Set(sources.map((s) => normName(s.value)))].length);
      const nEv = ev({ kind: 'computed', source_url: ctx.canonicalOrigin, selector_or_key: 'entity name by source', observed_value: sources.map((s) => `${s.key}="${collapse(s.value)}"`).join(' | ') });
      b.addEvidence(nEv);

      if (disagreements.length) {
        if (ctx.cfg.policy.rebranding) b.note('ENTITY_NAME_INCONSISTENT', `Name differs across sources during a declared rebranding (E-6.2-2): ${disagreements.slice(0, 4).join('; ')}.`);
        else b.hit('C-6.2-b', { summary: `The entity name differs across sources — these are the strings an assistant reconciles when deciding what the site is: ${disagreements.slice(0, 4).join('; ')}.`, evidence: [nEv] });
      }
      // R-6.2-3 definitional statement on the homepage
      const hpText = collapse(hp?.rawFacts?.mainText || '');
      const first200 = hpText.split(/\s+/).slice(0, 200).join(' ');
      const nonLatin = isMostlyNonLatin(first200);
      const def = nonLatin ? null : sentences(first200).find((s) => DEFINITIONAL.test(s) && (!sources.length || sources.some((x) => normName(s).includes(normName(x.value).split(' ')[0] || '')))) || (nonLatin ? null : sentences(first200).find((s) => DEFINITIONAL.test(s)));
      b.metric('definitional_statement', def || null);
      if (nonLatin) {
        b.note('NO_DEFINITIONAL_STATEMENT', 'Definitional-pattern detection is English-calibrated and was disabled for this language; reported as NOT_TESTABLE rather than a false warning (E-6.2-5).');
      } else if (!def) {
        b.hit('C-6.2-c', { summary: 'No definitional statement ("X is a Y that Z") in the first 200 words of the homepage — the sentence an assistant would quote to say what this organisation is.', evidence: [ev({ kind: 'computed', source_url: hp?.finalUrl || ctx.canonicalOrigin, fetch_profile: 'RAW', selector_or_key: 'first 200 words of homepage main content', observed_value: first200.slice(0, 600) })] });
      }
      // R-6.2-4 description consistency
      const descs = [
        { key: 'Organization.description', value: org?.description || null },
        { key: 'homepage meta description', value: hp?.rawFacts?.metaDescriptions[0]?.content || null },
        { key: 'llms.txt summary', value: ctx.derived.llmsTxt?.summary || null },
        { key: 'definitional statement', value: def || null },
      ].filter((d) => d.value && collapse(d.value));
      const dPairs = [];
      for (let i = 0; i < descs.length; i++) for (let j = i + 1; j < descs.length; j++) dPairs.push({ a: descs[i].key, b: descs[j].key, similarity: Number(jaccard(shingles(descs[i].value, 3), shingles(descs[j].value, 3)).toFixed(2)) });
      b.metric('description_pairs', dPairs);
      const material = dPairs.filter((p) => p.similarity < 0.06);
      if (descs.length >= 3 && material.length >= 2) {
        b.hit('C-6.2-d', { summary: `The site describes itself differently across surfaces: ${material.slice(0, 3).map((p) => `${p.a} vs ${p.b} (similarity ${p.similarity})`).join('; ')}.`, evidence: descs.map((d) => ev({ kind: 'computed', source_url: ctx.canonicalOrigin, selector_or_key: d.key, observed_value: collapse(d.value).slice(0, 300) })) });
      }
      // R-6.2-6 ambiguity
      const primary = org?.name || siteName;
      if (primary) {
        const n = normName(primary);
        const ambiguous = AMBIGUOUS.has(n) || (n.split(' ').length === 1 && n.length <= 5);
        b.metric('entity_name_ambiguous', ambiguous);
        if (ambiguous && !(org?.sameAs || []).length) b.note('AMBIGUOUS_ENTITY_UNANCHORED', `The entity name "${primary}" is a common word or very short and carries no sameAs anchors, so disambiguation depends entirely on page context (reported in C-3.1-y).`);
      }
      if (!org) b.caveat('No Organization schema: the name-consistency matrix was built from og:site_name, the title suffix and the logo alt alone (B-6.2-1).');
      if (!b.hits.length) b.pass(`Consistent entity name across ${sources.length} source(s)${def ? ', with a definitional statement on the homepage' : ''}.`);
      results.push(b.build());
    }
  } catch (e) {
    results.push(errorResult(ctx, 'C-6.2', e, ctx.canonicalOrigin));
  }

  // ── Page-level: subject declaration + optional rubric ───────────────────
  const pageResults = await forEachPage(ctx, 'C-6.2', async (page, b) => {
    if (!page.is_html) return b.notApplicable('INSUFFICIENT_CONTENT', 'Non-HTML resource.');
    const f = page.rawFacts;
    const h1 = f.headings.find((h) => h.level === 1)?.text || null;
    const title = f.titles[0]?.text || null;
    const text = ctx.derived.extraction?.get(page.url)?.main || f.mainText;
    const h1Tokens = new Set(significantTokens(h1 || ''));
    const titleTokens = new Set(significantTokens(title || ''));
    const shared = [...h1Tokens].filter((t) => titleTokens.has(t));
    // Most frequent significant noun-ish phrase, used only as a proxy (R-6.2-5).
    const counts = new Map();
    for (const t of significantTokens(text)) counts.set(t, (counts.get(t) || 0) + 1);
    const topTerm = [...counts.entries()].sort((a, c) => c[1] - a[1] || a[0].localeCompare(c[0]))[0]?.[0] || null;
    b.metric('h1', h1).metric('title_h1_shared_tokens', shared).metric('dominant_term', topTerm).metric('dominant_term_in_h1', topTerm ? h1Tokens.has(topTerm) : null);
    const sEv = ev({ kind: 'computed', source_url: page.finalUrl, fetch_profile: 'RAW', selector_or_key: 'page subject signals', observed_value: `h1="${h1 ?? '(none)'}"; title="${title ?? '(none)'}"; shared tokens: ${shared.join(', ') || 'none'}; dominant term: ${topTerm ?? 'n/a'}` });
    b.addEvidence(sEv);

    if (!h1 || !shared.length) {
      if (page.page_type === 'category') b.note('PAGE_SUBJECT_UNCLEAR', `Category page: ${!h1 ? 'no h1' : 'h1 and title share no significant token'} — informational for a list template (E-6.2-7).`);
      else b.hit('C-6.2-e', { summary: !h1 ? 'The page has no h1, so its subject is not declared in a heading.' : `The h1 ("${h1}") and title ("${title}") share no significant token.`, evidence: [sEv], cross_references: ['C-2.3'] });
    }
    // R-6.2-7 author attribution
    if (['blog_article', 'blog_template_alt'].includes(page.page_type)) {
      const visibleAuthor = /\b(by|written by|author)\s*:?\s+[A-Z][\p{L}'-]+/u.test(page.rendered?.dom?.visibleText || f.bodyText) || !!f.og['article:author'];
      // Without a browser this is textContent, not innerText: it includes text a reader cannot see.
      if (!renderedDomObservable(page)) {
        b.note('VISIBLE_TEXT_APPROXIMATED', 'Author presence was read from the page’s text content rather than from what a browser renders, because this run had no browser. Text hidden by CSS counts as present here, so a byline in collapsed or off-screen markup may be credited as visible.');
      }
      b.metric('author_named', visibleAuthor);
      if (!visibleAuthor) b.hit('C-6.2-f', { summary: 'Article with no author named in visible text.', evidence: [sEv], cross_references: ['C-3.1'] });
    }

    // Rubric (only where the gate leaves something undecidable, and the budget allows)
    const gateDecided = !!h1 && shared.length > 0;
    if (!ctx.llm.enabled) {
      b.note('RUBRIC_DISABLED', `entity_clarity_score is NOT_TESTABLE: ${ctx.llm.disabledReason}. The deterministic findings above still stand (C-6.2-h).`);
      return;
    }
    if (ctx.llm.budgetLeftFor('C-6.2') <= 0) {
      b.note('RUBRIC_DISABLED', "This check's share of the LLM call budget is spent; this page is gate-only (F-6.2-5).");
      return;
    }
    if (gateDecided && ctx.llm.budgetLeftFor('C-6.2') < 2) return; // leave room for undecided pages
    const res = await ctx.llm.score({
      page: { url: page.finalUrl, page_type: page.page_type, text, outline: f.headings.map((h) => `h${h.level}: ${h.text}`) },
      criteria: CRITERIA,
      rubricName: 'C-6.2 entity clarity',
      checkId: 'C-6.2',
    });
    if (!res.ok) {
      b.note(res.reason, `Rubric did not run: ${res.detail}.`);
      return;
    }
    const scored = Object.entries(res.criteria).filter(([, v]) => !v.not_testable);
    const notTestable = Object.entries(res.criteria).filter(([, v]) => v.not_testable).map(([k]) => k);
    const total = scored.reduce((a, [, v]) => a + v.score, 0);
    const score = scored.length ? total / (scored.length * 3) : null;
    b.metric('entity_clarity_score', score == null ? null : Number(score.toFixed(2)))
      .metric('rubric', Object.fromEntries(Object.entries(res.criteria).map(([k, v]) => [k, { score: v.score, justification: v.justification, quote: v.quote, not_testable: !!v.not_testable }])))
      .metric('rubric_version', res.rubric_version);
    for (const k of notTestable) b.note('RUBRIC_PARSE_FAILED', `Criterion ${k} became NOT_TESTABLE: the judge could not supply a verbatim quote for a non-zero score (R-S6-3).`);
    if (score != null) {
      b.setConfidence('MODELLED', MODELLED_CAVEAT);
      b.caveat(NON_DETERMINISTIC_CAVEAT);
      if (!page.renFacts) b.caveat(RAW_ONLY_CAVEAT);
      const rEv = ev({ kind: 'computed', source_url: page.finalUrl, fetch_profile: 'NONE', selector_or_key: `entity_clarity_score (rubric ${res.rubric_version}, model ${res.model})`, observed_value: `${total}/${scored.length * 3} = ${score.toFixed(2)} — ` + scored.map(([k, v]) => `${k}=${v.score} ("${v.quote.slice(0, 80)}")`).join('; '), expected_value: '≥ 0.50' });
      b.addEvidence(rEv);
      // R-6.2-5/F-6.2-2: the rubric never overturns the gate.
      if (score < 0.5) b.hit('C-6.2-g', { summary: `Modelled entity-clarity score ${score.toFixed(2)}: ${scored.filter(([, v]) => v.score <= 1).map(([k, v]) => `${k} — ${v.justification}`).join(' ')}`, evidence: [rEv] });
    }
  });

  results.push(...pageResults);
  return results;
}
