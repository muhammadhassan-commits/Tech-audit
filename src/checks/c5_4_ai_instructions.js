// C-5.4 — AI Instructions Page (domain, root level · RAW + RENDERED).
// Reference implementations: wellows.com/ai-info, peec.ai/ai-instructions.
// R-5.4-1: this page is never added to the 1–10 sample and never evaluated by page-level checks.
import { ResultBuilder, ev, errorResult } from '../engine/result.js';
import { bodyText } from '../net/http.js';
import { extractFacts } from '../parse/html.js';
import { collapse, wordCount, jaccard, shingles, sentences } from '../parse/text.js';
import { normalizeUrl } from '../parse/url.js';
import { RETRIEVAL_AGENTS } from './ai_agents.js';
import { evaluate } from '../parse/robots.js';
import { parseBlock, buildGraph, typesOf } from '../parse/jsonld.js';

const OPTIONAL_NOTE = 'An AI-instructions page is an optional, additive practice. Google states there are no additional requirements to appear in AI Overviews or AI Mode, and that no new machine-readable files or markup are needed for those surfaces.';
const CONVENTIONAL_PATHS = ['/ai-info', '/ai-instructions', '/ai', '/for-ai', '/ai-overview', '/llm', '/llms', '/ai-facts'];
const ANCHOR_LEXICON = /\b(ai[\s-]?(info|instructions|overview|facts)|for ai|llm[s]?)\b/i;

// R-5.4-4 completeness rubric (Σ weights = 23).
const RUBRIC = [
  { id: 'definitional', label: 'Definitional sentence (what the organisation is, in one sentence)', weight: 3 },
  { id: 'offerings', label: 'What it does / core offerings', weight: 3 },
  { id: 'audience', label: 'Who it is for', weight: 2 },
  { id: 'competitors', label: 'Category and named alternatives/competitors', weight: 2 },
  { id: 'pricing', label: 'Pricing or commercial model', weight: 2 },
  { id: 'instructions', label: 'Explicit instructions to AI assistants', weight: 3 },
  { id: 'key_facts', label: 'Key facts block', weight: 2 },
  { id: 'people', label: 'People / founders', weight: 1 },
  { id: 'qa', label: 'Q&A / FAQ', weight: 1 },
  { id: 'updated', label: 'Last-updated date', weight: 2 },
  { id: 'not_fit', label: 'When it is not the right fit', weight: 1 },
  { id: 'contact', label: 'Contact / demo path', weight: 1 },
];

const RE = {
  addressesAI: /\b(ai assistants?|language models?|for ai\b|ai instructions|llms?\b|chatgpt|claude|perplexity|gemini|copilot|ai systems?|ai tools?)\b/i,
  definitional: /\b(is|are)\s+(a|an|the)\s+[a-z][\w\s,-]{3,80}?\b(that|which|for|helping|serving|offering|providing)\b/i,
  offerings: /^(what (we do|it does|[\w\s]{2,30} (does|offers?|measures|provides?|tracks?))|our (services|products|offerings|solutions)|services|products?|offerings|solutions|core (services|offerings)|capabilities|features|how it works|what (it|we) (offers?|provides?)|platform|use cases)/i,
  audience: /^(who (it is|we are|this is) for|who we (help|serve)|our (clients|customers|audience)|ideal (customer|client)|target (audience|market)|best for)/i,
  competitorsHeading: /(competitors?|alternatives?|compare|comparison|vs\.?\b|category|landscape|how we differ)/i,
  pricingHeading: /(pricing|plans|packages|cost|rates|fees|commercial model)/i,
  instructions: /(instructions? (for|to) ai|how (to|should) (ai|assistants?|llms?) (use|describe|cite|reference)|guidance for ai|for ai assistants?|if you are an? (ai|llm|assistant))/i,
  keyFacts: /(key facts?|quick facts?|at a glance|fact sheet|basic information|company facts)/i,
  people: /(founder|ceo|cto|co-?founder|leadership|our team|managing director|principal)/i,
  notFit: /(not (the )?(right )?(fit|for you|suitable)|when (not|we are not)|who (we|this) (is|are) not for|we (are|'re) not (a|the)|not a good fit)/i,
  contact: /\b(contact|book a (demo|call)|get in touch|request a (demo|quote)|start (a )?(free )?trial|talk to (us|sales))\b/i,
  date: /\b(last[\s-]?updated|updated on|updated|as of|revised)\b\W{0,4}([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]+\s+\d{4}|[A-Za-z]{3,9}\s+\d{4})/i,
  basicInfo: /^(basic information|company (facts|information|details)|about (the )?(company|us)|overview|at a glance|entity)/i,
  currency: /[$€£¥₹]\s?\d|\b\d[\d,.]*\s?(usd|eur|gbp|inr)\b|\bper (month|year|seat|user)\b/i,
  price: /[$€£¥₹]\s?([\d,]+(?:\.\d{2})?)/g,
};

export async function run(ctx) {
  try {
    return [await evaluateCheck(ctx)];
  } catch (e) {
    return [errorResult(ctx, 'C-5.4', e)];
  }
}

async function evaluateCheck(ctx) {
  const { http, cfg } = ctx;
  const b = new ResultBuilder(ctx, 'C-5.4', { scope: 'site', target_url: ctx.canonicalOrigin });
  b.caveat(OPTIONAL_NOTE);

  // R-5.4-2 discovery ladder — single-segment root paths only, capped at ai_page.max_probes.
  const candidates = [];
  const probed = [];
  let probes = 0;
  for (const path of CONVENTIONAL_PATHS) {
    if (probes >= cfg.ai_page.max_probes) break;
    probes++;
    const url = `${ctx.canonicalOrigin}${path}`;
    ctx.emit('fetch', { url, purpose: 'AI instructions page probe' });
    const rec = await http.fetch(url, { budgetClass: 'secondary', exempt: true });
    probed.push({ url, status: rec.status });
    if (rec.status >= 200 && rec.status < 300 && rec.body?.length) candidates.push({ url: normalizeUrl(rec.final_url) || url, rec });
  }
  // Ladder step 2 — links from llms.txt whose anchor matches the lexicon and target is root level.
  const llms = ctx.derived.llmsTxt;
  if (llms) {
    for (const link of llms.parsed.links) {
      if (probes >= cfg.ai_page.max_probes) break;
      if (!ANCHOR_LEXICON.test(`${link.name || ''} ${link.url}`)) continue;
      const abs = normalizeUrl(link.url, llms.url);
      if (!abs || new URL(abs).origin !== ctx.canonicalOrigin) continue;
      if (new URL(abs).pathname.replace(/^\/|\/$/g, '').includes('/')) continue; // root level only
      if (candidates.some((c) => c.url === abs)) continue;
      probes++;
      const rec = await http.fetch(abs, { budgetClass: 'secondary', exempt: true });
      probed.push({ url: abs, status: rec.status, via: 'llms.txt' });
      if (rec.status >= 200 && rec.status < 300) candidates.push({ url: abs, rec, viaLlms: true });
    }
  }
  b.metric('probed', probed).metric('probe_budget', cfg.ai_page.max_probes);

  // R-5.4-3 classification
  const scored = [];
  for (const c of candidates) {
    const facts = extractFacts(bodyText(c.rec), c.rec.final_url, ctx.canonicalOrigin);
    const text = collapse(facts.mainText || facts.bodyText);
    // Section headings are read from the DOM and from markdown-style headings in the text: an
    // AI-instructions page is often published as markdown, where "## Pricing" is a section heading
    // a reader and an assistant both see, even though it is not an <h2>.
    const headings = [...facts.headings.map((h) => h.text), ...markdownHeadings(bodyText(c.rec))];
    let score = 0;
    const signals = [];
    const add = (n, why) => {
      score += n;
      signals.push(why);
    };
    if (RE.addressesAI.test([...headings, text.slice(0, 3000)].join(' '))) add(2, 'addresses AI systems explicitly');
    if (RE.definitional.test(text.slice(0, 1500))) add(2, 'contains a definitional statement');
    if (headings.some((h) => RE.competitorsHeading.test(h))) add(1, 'names competitors or the category');
    if (RE.currency.test(text)) add(1, 'states pricing or product facts');
    if (headings.some((h) => RE.keyFacts.test(h) || RE.instructions.test(h))) add(1, 'has a key-facts or instructions block');
    if (RE.date.test(text) || facts.timeEls.length) add(1, 'carries a last-updated date');
    if (RE.people.test(text)) add(1, 'lists people/founders');
    if (facts.qaHeadingCount >= 3 || facts.detailsQaCount >= 3) add(1, 'contains a Q&A block');
    scored.push({ ...c, facts, text, headings, score, signals });
  }
  scored.sort((a, b2) => b2.score - a.score || a.url.localeCompare(b2.url));
  const qualifying = scored.filter((s) => s.score >= 4);
  let page = qualifying[0] || null;
  let uncertain = false;
  if (!page) {
    const borderline = scored.find((s) => s.score === 3);
    if (borderline) {
      page = borderline;
      uncertain = true;
    }
  }

  // E-5.4-2 / E-5.4-3 — the function matters more than the URL.
  let servedByAbout = false;
  if (!page) {
    const about = ctx.pages.find((p) => p.page_type === 'about');
    if (about?.rawFacts) {
      const facts = about.rawFacts;
      const cand = { url: about.finalUrl, rec: about.raw, facts, text: collapse(facts.mainText), headings: [...facts.headings.map((h) => h.text), ...markdownHeadings(about.rawHtml || '')], score: 0, signals: ['about page evaluated under E-5.4-2'] };
      const c = completeness(ctx, cand);
      if (c.score >= 0.7) {
        page = cand;
        servedByAbout = true;
      }
    }
  }

  if (!page) {
    const summaryText = llms?.summary
      ? `No AI-instructions page found after the full ladder (${CONVENTIONAL_PATHS.join(', ')} and llms.txt links). The llms.txt summary partly serves this purpose (E-5.4-3); an HTML page is additionally citable and linkable, which a text file is not.`
      : `No AI-instructions page found after the full ladder: ${CONVENTIONAL_PATHS.join(', ')} and any llms.txt links. This is an optional practice — an opportunity, not a defect. Reference implementations: wellows.com/ai-info, peec.ai/ai-instructions.`;
    b.hit('C-5.4-b', { summary: summaryText, evidence: probed.slice(0, 8).map((p) => ev({ kind: 'http_status', source_url: p.url, fetch_profile: 'RAW', selector_or_key: 'status', observed_value: p.status == null ? null : String(p.status), expected_value: '200 (optional)' })) });
    if (ctx.robots?.parsed && RETRIEVAL_AGENTS.every((a) => evaluate(ctx.robots.parsed, a.toLowerCase(), '/').verdict === 'DISALLOWED')) {
      b.note('AI_INSTRUCTIONS_PAGE_ABSENT', 'Before recommending one: robots.txt blocks every retrieval-oriented AI agent site-wide, so such a page could not be read by the agents it is written for (F-5.4-5).');
    }
    return b.build();
  }

  if (qualifying.length > 1) b.hit('C-5.4-m', { summary: `${qualifying.length} candidate pages qualify (${qualifying.map((q) => q.url).join(', ')}); authority is split — consolidate to one.`, evidence: qualifying.map((q) => ev({ kind: 'http_status', source_url: q.url, fetch_profile: 'RAW', selector_or_key: 'classification score', observed_value: String(q.score) })) });
  if (uncertain) b.caveat('Classification was borderline (score 3 of the R-5.4-3 scale): this page is evaluated, but the achievable status is capped at WARN and the uncertainty is stated (B-5.4-2).');
  if (servedByAbout) b.note('AI_INSTRUCTIONS_SERVED_BY_ABOUT', 'No dedicated AI page exists, but the About page serves the function with completeness ≥ 0.70 (E-5.4-2).');

  const pageEv = ev({ kind: 'http_status', source_url: page.url, fetch_profile: 'RAW', selector_or_key: 'status', observed_value: String(page.rec.status) });
  b.addEvidence(pageEv);
  b.metric('page_url', page.url).metric('classification_score', page.score).metric('classification_signals', page.signals).metric('word_count', wordCount(page.text));

  // R-5.4-4 completeness
  const c = completeness(ctx, page);
  b.metric('completeness', Number(c.score.toFixed(2))).metric('completeness_checklist', c.rows);
  const cEv = ev({ kind: 'computed', source_url: page.url, fetch_profile: 'RAW', selector_or_key: 'completeness = Σ(present weights) / 23', observed_value: `${c.present}/23 = ${c.score.toFixed(2)}`, expected_value: '≥ 0.70' });
  b.addEvidence(cEv);
  if (!ctx.llm.enabled) b.caveat('Completeness is structural only: the rubric ran its deterministic detections without an LLM judge (B-5.4-3).');
  if (c.score < 0.4) b.hit('C-5.4-c', { summary: `The page is thin for its purpose: completeness ${c.score.toFixed(2)} (${c.present}/23). Missing: ${c.missing.join(', ')}.`, evidence: [cEv] });

  // R-5.4-7 accessibility to AI
  const meta = page.facts.metaRobots.some((m) => ['robots', 'googlebot'].includes(m.name) && /noindex|none/i.test(m.content)) || /noindex/i.test(String(page.rec.headers?.['x-robots-tag'] || ''));
  const blockedFor = ctx.robots?.parsed ? RETRIEVAL_AGENTS.filter((a) => evaluate(ctx.robots.parsed, a.toLowerCase(), new URL(page.url).pathname).verdict === 'DISALLOWED') : [];
  if (meta || blockedFor.length) {
    b.hit('C-5.4-d', { summary: `The page exists for machines that are forbidden from reading it: ${meta ? 'it is noindex' : ''}${meta && blockedFor.length ? '; ' : ''}${blockedFor.length ? `robots.txt disallows ${blockedFor.join(', ')}` : ''}.`, evidence: [ev({ kind: 'dom_node', source_url: page.url, fetch_profile: 'RAW', selector_or_key: meta ? 'meta[name=robots] / X-Robots-Tag' : 'robots.txt verdict', observed_value: meta ? page.facts.metaRobots.map((m) => m.content).join(', ') || page.rec.headers['x-robots-tag'] : `DISALLOWED for ${blockedFor.join(', ')}` })], cross_references: ['C-1.6', 'C-5.1'] });
  }
  // Present in RAW, not JS-only (R-5.4-7)
  if (wordCount(page.text) < 50) {
    const rendered = await ctx.renderer.render(page.url);
    if (!rendered.error) {
      const rf = extractFacts(rendered.html, page.url, ctx.canonicalOrigin);
      if (wordCount(collapse(rf.mainText)) >= 50) {
        b.hit('C-5.4-e', { summary: 'The page renders its content with JavaScript: raw HTML carries almost no text, so non-browser AI fetchers see an empty page.', evidence: [ev({ kind: 'computed', source_url: page.url, fetch_profile: 'RENDERED', selector_or_key: 'raw vs rendered words', observed_value: `${wordCount(page.text)} raw vs ${wordCount(collapse(rf.mainText))} rendered` })], cross_references: ['C-5.2'] });
      }
    }
  }
  // Inbound links — read from links already harvested in Module A (never adds the page to the sample).
  const linkedFrom = [];
  for (const p of ctx.pages) {
    if (!p.rawFacts) continue;
    if (p.rawFacts.links.some((l) => !l.discard && l.resolved === page.url)) linkedFrom.push(p.finalUrl);
  }
  const inLlms = !!llms?.parsed.links.some((l) => normalizeUrl(l.url, llms.url) === page.url);
  b.metric('linked_from', linkedFrom).metric('listed_in_llms_txt', inLlms);
  if (!linkedFrom.length && !inLlms) b.hit('C-5.4-f', { summary: 'The page is orphaned: no crawled page links to it and it is not listed in llms.txt, so it is effectively invisible.', evidence: [ev({ kind: 'computed', source_url: page.url, selector_or_key: 'inbound links from the harvested link set', observed_value: '0' })] });

  // R-5.4-5 consistency verification
  const def = definitionalSentence(page.text);
  const org = ctx.derived.schema?.org;
  const hpH1 = ctx.homepage?.rawFacts?.headings.find((h) => h.level === 1)?.text || null;
  const hpDesc = ctx.homepage?.rawFacts?.metaDescriptions[0]?.content || null;
  const pairs = [];
  const sim = (a, x) => (a && x ? jaccard(shingles(a, 3), shingles(x, 3)) : null);
  if (def) {
    pairs.push({ against: 'Organization.description', value: org?.description || null, similarity: sim(def, org?.description) });
    pairs.push({ against: 'llms.txt summary', value: llms?.summary || null, similarity: sim(def, llms?.summary) });
    pairs.push({ against: 'homepage h1', value: hpH1, similarity: sim(def, hpH1) });
    pairs.push({ against: 'homepage meta description', value: hpDesc, similarity: sim(def, hpDesc) });
  }
  b.metric('definitional_sentence', def).metric('consistency_pairs', pairs);
  const orgName = org?.name || null;
  const conflicting = pairs.filter((p) => p.value && p.similarity != null && p.similarity < 0.08 && ['Organization.description', 'homepage h1'].includes(p.against));
  if (def && conflicting.length === 2 && orgName && !collapse(def).toLowerCase().includes(collapse(orgName).toLowerCase())) {
    b.hit('C-5.4-g', { summary: `The page's definitional sentence does not agree with how the site describes itself elsewhere. Page: "${collapse(def).slice(0, 140)}". ${conflicting.map((p) => `${p.against}: "${collapse(String(p.value)).slice(0, 100)}"`).join(' · ')}. Inconsistent self-description across these surfaces is what an assistant resolves against.`, evidence: [ev({ kind: 'computed', source_url: page.url, selector_or_key: 'definitional sentence vs other surfaces', observed_value: `${def} || ${conflicting.map((p) => `${p.against}=${p.value}`).join(' || ')}` })], cross_references: ['C-3.1', 'C-6.2'] });
  } else if (!def) {
    b.note('AI_INSTRUCTIONS_PAGE_THIN', 'No single-sentence definitional statement ("X is a Y that Z") was detected in the first 200 words.');
  }
  if (!ctx.derived.schema?.org && !llms) b.caveat('Consistency verification used the homepage h1 and meta description alone: no Organization schema and no llms.txt were available (B-5.4-4).');

  // R-5.4-6 verifiability against the live site (cheaply checkable claims only)
  const contradictions = [];
  const pricingPage = ctx.pages.find((p) => p.page_type === 'pricing');
  if (pricingPage?.rawFacts) {
    const livePrices = new Set((collapse(pricingPage.rawFacts.mainText).match(RE.price) || []).map((x) => x.replace(/[^\d.]/g, '')));
    const claimed = [...new Set((page.text.match(RE.price) || []).map((x) => x.replace(/[^\d.]/g, '')))];
    const mismatched = claimed.filter((p) => livePrices.size && !livePrices.has(p));
    if (mismatched.length && claimed.length) contradictions.push(`price(s) ${mismatched.join(', ')} are not present on the pricing page ${pricingPage.finalUrl} (which shows ${[...livePrices].slice(0, 6).join(', ')})`);
  }
  if (contradictions.length) b.hit('C-5.4-k', { summary: `A verifiable claim contradicts the live site: ${contradictions.join('; ')}.`, evidence: [ev({ kind: 'computed', source_url: page.url, selector_or_key: 'claim verification', observed_value: contradictions.join('; ') })] });

  // Content-completeness rows that are their own conditions
  const dateMatch = RE.date.exec(page.text);
  const isoDate = page.facts.timeEls.map((t) => t.datetime).find(Boolean);
  const schemaDate = schemaDates(page.facts);
  const dateStr = dateMatch?.[2] || isoDate || schemaDate;
  if (!dateStr) b.hit('C-5.4-h', { summary: 'No last-updated date on the page, so a reader cannot tell whether its claims are current.', evidence: [ev({ kind: 'computed', source_url: page.url, selector_or_key: 'last-updated date', observed_value: '(none)' })] });
  else {
    const t = Date.parse(dateStr);
    const ageDays = Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
    b.metric('last_updated', dateStr).metric('age_days', ageDays);
    if (ageDays != null && ageDays > cfg.th.freshness_stale_days) b.hit('C-5.4-l', { summary: `The page was last updated ${dateStr} (${ageDays} days ago, beyond the ${cfg.th.freshness_stale_days}-day staleness threshold).`, evidence: [ev({ kind: 'computed', source_url: page.url, selector_or_key: 'last-updated', observed_value: dateStr })] });
  }
  if (!c.rows.find((r) => r.id === 'competitors').present) b.hit('C-5.4-i', { summary: 'No competitors or category named. Both reference implementations name competitors; a page without them answers fewer of the questions assistants actually get asked. Presence is detected only — positioning and sentiment are never judged (F-5.4-4).', evidence: [cEv] });
  if (!c.rows.find((r) => r.id === 'instructions').present) b.hit('C-5.4-j', { summary: 'No explicit instructions block addressed to AI assistants.', evidence: [cEv] });

  // R-5.4-9 structured data on the page
  const g = buildGraph(page.facts.jsonld.map((x) => parseBlock(x.raw)).filter((x) => x.value !== undefined));
  const types = [...new Set(g.nodes.flatMap((n) => typesOf(n.node)))];
  b.metric('structured_data_types', types);
  if (types.length) b.note('AI_INSTRUCTIONS_NO_DIRECTIVES', `Structured data on the page: ${types.join(', ')} (cross-referenced with C-3.1).`);

  if (uncertain && b.hits.some((h) => h.status === 'FAIL')) {
    for (const h of b.hits) if (h.status === 'FAIL') h.status = 'WARN';
  }
  if (!b.hits.length) b.pass(`AI-instructions page found at ${page.url}: completeness ${c.score.toFixed(2)} (${c.present}/23), accessible to AI agents, and consistent with the site's other self-descriptions.`);
  return b.build();
}

/**
 * Markdown-style section headings ("## Pricing") and bolded label lines ("**Category:** …") found in
 * the served text. Pages written for AI assistants are frequently published as markdown, so these
 * are the page's real section headings even when the DOM carries none.
 */
function markdownHeadings(html) {
  const text = String(html || '').replace(/<[^>]+>/g, '\n');
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const h = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push(collapse(h[2]).replace(/\*\*/g, ''));
      continue;
    }
    const label = /^\s*(?:[-*+]\s+)?\*\*([^*]{2,60})\*\*\s*:?\s*/.exec(line);
    if (label) out.push(collapse(label[1]));
  }
  return out;
}

function schemaDates(facts) {
  try {
    const g = buildGraph(facts.jsonld.map((x) => parseBlock(x.raw)).filter((x) => x.value !== undefined));
    for (const n of g.nodes) if (n.node.dateModified || n.node.datePublished) return n.node.dateModified || n.node.datePublished;
  } catch {
    /* schema dates are optional here */
  }
  return null;
}

function definitionalSentence(text) {
  const first = sentences(collapse(text)).slice(0, 12);
  return first.find((s) => RE.definitional.test(s) && s.length < 320) || null;
}

function hasHeading(headings, re) {
  return headings.some((h) => re.test(h));
}

function completeness(ctx, page) {
  const text = page.text;
  const headings = page.headings;
  // R-5.4-4: the definitional element is "first paragraph or a Basic Information block containing
  // an 'X is a Y that Z' pattern" — a labelled block that states the name and the category answers
  // the same question, so it counts.
  const basicInfoBlock = hasHeading(headings, RE.basicInfo) && /\b(type|category|what it is)\b\s*:?\s*\S/i.test(text);
  const checks = {
    definitional: !!definitionalSentence(text) || basicInfoBlock,
    offerings: hasHeading(headings, RE.offerings),
    audience: hasHeading(headings, RE.audience),
    competitors: hasHeading(headings, RE.competitorsHeading) || (page.facts.tables.length > 0 && RE.competitorsHeading.test(text)),
    pricing: RE.currency.test(text) || hasHeading(headings, RE.pricingHeading),
    instructions: hasHeading(headings, RE.instructions) || RE.instructions.test(text),
    key_facts: hasHeading(headings, RE.keyFacts),
    people: RE.people.test(text),
    qa: page.facts.qaHeadingCount >= 3 || page.facts.detailsQaCount >= 3,
    updated: RE.date.test(text) || page.facts.timeEls.length > 0 || !!schemaDates(page.facts),
    not_fit: hasHeading(headings, RE.notFit) || RE.notFit.test(text),
    contact: RE.contact.test(text) || page.facts.links.some((l) => /contact|demo|trial/i.test(`${l.href} ${l.anchor}`)),
  };
  const rows = RUBRIC.map((r) => ({ ...r, present: !!checks[r.id] }));
  const present = rows.filter((r) => r.present).reduce((a, r) => a + r.weight, 0);
  return { rows, present, score: present / 23, missing: rows.filter((r) => !r.present).map((r) => r.label) };
}
