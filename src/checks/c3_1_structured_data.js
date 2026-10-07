// C-3.1 — Structured Data (page · RAW and RENDERED). Validates ONLY schema.fixed_set (F-3.1-1);
// everything else is inventoried. Required-field lists are this tool's policy where Google has none.
import { ev } from '../engine/result.js';
import { forEachPage, hasRendered, domEv, jsCaveat, sampleSize, renderedDomObservable} from './_util.js';
import { parseBlock, buildGraph, typesOf, danglingRefs, hasField, invalidCasing, placeholderValues, isIsoDate, asArray } from '../parse/jsonld.js';
import { collapse, significantTokens } from '../parse/text.js';
import { detectSiteName, normName } from './_sitename.js';
import { loadHtml } from '../parse/html.js';

const FAQ_NOTE = 'FAQ rich results stopped appearing in Google Search on 7 May 2026; FAQ markup is retained for entity/LLM-extraction value only.';
const ORG_POLICY = "Google documents no strictly required properties for Organization; the name/url/logo requirement is this tool's standard for entity resolution, not a Google requirement.";
const VALIDATION_NOTE = "Validation is this tool's own; Google's Rich Results Test and the schema.org validator were not called (F-3.1-7).";
const AMBIGUOUS_WORDS = new Set(['apple', 'amazon', 'orange', 'target', 'shell', 'mercury', 'jaguar', 'delta', 'oracle', 'square', 'slack', 'notion', 'linear', 'pulse', 'focus', 'bloom', 'atlas', 'echo', 'nova', 'spark', 'zen', 'peak', 'core', 'base', 'hub', 'flow', 'mint', 'ember', 'monday', 'zoom', 'box', 'drift', 'loom', 'figma', 'sage', 'wave']);

function typeDefFor(fixed, types) {
  return fixed.types.find((d) => types.some((t) => d.match.includes(t)));
}

// Properties whose nested value points at an entity declared elsewhere rather than declaring one.
const REFERENCE_PARENTS = new Set(['publisher', 'author', 'provider', 'brand', 'creator', 'worksFor', 'isPartOf', 'about', 'parentOrganization', 'subOrganization', 'memberOf', 'sourceOrganization', 'copyrightHolder', 'funder', 'sponsor', 'mainEntityOfPage', 'primaryImageOfPage']);
// Properties whose nested value describes a *different* resource (other pages, list members), so it
// is never this page's own node and is inventoried rather than validated against this page's slate.
const DESCRIPTOR_PARENTS = new Set(['hasPart', 'itemListElement', 'relatedLink', 'significantLink', 'breadcrumb', 'containsPlace', 'subjectOf']);
const IDENTITY_KEYS = new Set(['@type', '@id', '@context', 'name', 'url']);

/**
 * A nested node carrying nothing beyond identity keys under a reference-bearing property is a
 * pointer to an entity declared elsewhere — validating it as a declaration produces false
 * "missing required field" findings for fields the real node does carry.
 */
function isReferenceNode(n) {
  if (!n.nested) return false;
  const keys = Object.keys(n.node).filter((k) => k !== '@context');
  if (REFERENCE_PARENTS.has(n.parentKey) && keys.every((k) => IDENTITY_KEYS.has(k))) return true;
  return keys.length <= 2 && !!n.node['@id'];
}

/** A nested node under a descriptor property describes another resource, not this page's entity. */
function isDescriptorNode(n) {
  return n.nested && DESCRIPTOR_PARENTS.has(n.parentKey);
}

const normalizeForCompare = (u) => String(u || '').replace(/\/+$/, '').toLowerCase();

function expectedFor(pageType, isHome) {
  const exp = ['S3'];
  if (!isHome) exp.push('S4');
  if (isHome) exp.push('S1', 'S2');
  if (pageType === 'about') exp.push('S1');
  if (pageType === 'blog_article' || pageType === 'blog_template_alt') exp.push('S5');
  if (pageType === 'author') exp.push('S6');
  if (pageType === 'product_main') exp.push('S7');
  if (pageType === 'service_main' || pageType === 'service_secondary') exp.push('S9');
  return [...new Set(exp)];
}

function graphFor(facts) {
  const blocks = facts.jsonld.map((b) => ({ ...b, parsed: parseBlock(b.raw) }));
  const graph = buildGraph(blocks.map((b) => b.parsed).filter((p) => p.value !== undefined));
  return { blocks, graph };
}

export async function run(ctx) {
  const fixed = ctx.cfg.schema.fixed_set;
  const siteName = detectSiteName(ctx);
  ctx.derived.schema = { orgIds: new Map(), siteIds: new Map(), org: null, dates: new Map(), persons: new Map() };
  const S = ctx.derived.schema;

  const results = await forEachPage(ctx, 'C-3.1', (page, b) => {
    if (!page.is_html) return b.notApplicable('INSUFFICIENT_SAMPLE', 'Non-HTML resource.');
    b.caveat(VALIDATION_NOTE);
    jsCaveat(b, page);
    const url = page.finalUrl;
    const raw = graphFor(page.rawFacts);
    const ren = hasRendered(page) ? graphFor(page.renFacts) : null;
    const useRen = !raw.graph.nodes.length && ren?.graph.nodes.length;
    const { graph, blocks } = useRen ? ren : raw;
    const profile = useRen ? 'RENDERED' : 'RAW';
    const facts = useRen ? page.renFacts : page.rawFacts;
    // R-3.1-8 correspondence is checked against the text a reader can reach on the page, which
    // includes expandable panels (accordions, <details>) — Google permits FAQ content behind them.
    // innerText alone omits collapsed sections and would report present content as missing.
    const visible = collapse(page.rendered?.dom?.availableText || facts.bodyText).toLowerCase();
    const visibleWithoutInteraction = collapse(page.rendered?.dom?.visibleText || facts.bodyText).toLowerCase();
    const h1 = facts.headings.find((h) => h.level === 1)?.text || '';
    const title = facts.titles[0]?.text || '';
    const micro = [...page.rawFacts.microdata, ...(ren ? page.renFacts.microdata : [])];
    const rdfa = [...page.rawFacts.rdfa, ...(ren ? page.renFacts.rdfa : [])];
    b.metric('syntax_mix', { jsonld_blocks: raw.blocks.length, jsonld_blocks_rendered: ren ? ren.blocks.length : 'NOT_AVAILABLE', microdata: micro.length, rdfa: rdfa.length });
    const gEv = ev({ kind: 'dom_node', source_url: url, fetch_profile: profile, selector_or_key: 'script[type="application/ld+json"]', observed_value: blocks.map((x) => x.raw.trim()).join('\n---\n') || '(none)' });

    // Presence (C-3.1-b / n / o)
    const hasAny = raw.blocks.length || micro.length || rdfa.length || (ren && ren.blocks.length);
    if (!hasAny) {
      b.hit('C-3.1-b', { summary: 'No structured data of any kind (JSON-LD, Microdata or RDFa) on the page.', evidence: [gEv], remediation: remediationFor(ctx, page, ['S1', 'S3'].filter((s) => s === 'S3' || page.isHomepage)) });
      return;
    }
    if (!raw.blocks.length && ren?.blocks.length) b.hit('C-3.1-n', { summary: 'Structured data exists only in RENDERED (JavaScript-injected) — materially more fragile than server-rendered JSON-LD.', evidence: [gEv], cross_references: ['C-5.2'] });
    if (ren && raw.blocks.length && ren.blocks.length) {
      const tr = new Set(raw.graph.nodes.flatMap((n) => typesOf(n.node)));
      const tn = new Set(ren.graph.nodes.flatMap((n) => typesOf(n.node)));
      const diff = [...new Set([...tr, ...tn])].filter((t) => !tr.has(t) || !tn.has(t));
      if (diff.length) b.hit('C-3.1-o', { summary: `RAW and RENDERED graphs differ materially (types present in only one profile: ${diff.join(', ')}).`, evidence: [gEv] });
    }
    if (!ren) b.caveat('RAW vs RENDERED graph not compared; C-3.1-n/o NOT_TESTABLE (B-3.1-2).');
    if (page.rawFacts.jsonld.some((x) => x.in_noscript)) b.note('SCHEMA_IN_NOSCRIPT', 'JSON-LD inside <noscript>: treated as present, unusual placement (E-3.1-14).');

    // Parse errors (C-3.1-c, B-3.1-1)
    for (const blk of blocks) {
      const p = blk.parsed;
      if (p.ok || p.empty) continue;
      if (p.lenient) b.hit('C-3.1-c', { status: 'WARN', severity: 'MEDIUM', summary: `JSON-LD block ${blk.index} is invalid JSON (${p.faults.join(', ')}); a lenient parse recovered it, but Google's parser is not lenient.`, evidence: [domEv(page, profile, `script[type=ld+json]#${blk.index}`, blk.raw.slice(0, 500))] });
      else b.hit('C-3.1-c', { summary: `JSON-LD block ${blk.index} fails to parse: ${p.error}. Other blocks are still evaluated (F-3.1-5).`, evidence: [domEv(page, profile, `script[type=ld+json]#${blk.index}`, blk.raw.slice(0, 500))] });
    }

    // Classify nodes
    const inScope = [];
    const outScope = new Set();
    for (const n of graph.nodes) {
      const types = typesOf(n.node);
      const def = typeDefFor(fixed, types);
      if (def) inScope.push({ ...n, def, types });
      else types.forEach((t) => outScope.add(t));
    }
    for (const t of micro.concat(rdfa)) outScope.add(String(t).replace(/^https?:\/\/schema\.org\//, ''));
    if (outScope.size) b.note('SCHEMA_OUT_OF_SCOPE_DETECTED', `Out-of-scope type(s) inventoried, never validated: ${[...outScope].join(', ')}.`);
    const present = new Set(inScope.filter((n) => !isDescriptorNode(n)).map((n) => n.def.id));
    const topLevel = inScope.filter((n) => !n.nested || n.parentKey === '@graph');

    // Expected types for this page_type (C-3.1-s; E-3.1-1/6)
    for (const exp of expectedFor(page.page_type, page.isHomepage)) {
      if (present.has(exp)) continue;
      if (exp === 'S1' && present.has('S6') && ctx.derived.personalSite) continue;
      const label = fixed.types.find((d) => d.id === exp)?.label;
      if (exp === 'S1' && page.isHomepage) continue; // handled by C-3.1-t with its own remediation
      b.hit('C-3.1-s', { summary: `Expected in-scope type ${label} (${exp}) is absent for page_type ${page.page_type}.`, evidence: [gEv] });
    }

    // Entity node presence (C-3.1-t) — homepage/about (E-3.1-1)
    const declared = inScope.filter((n) => !isReferenceNode(n) && !isDescriptorNode(n));
    const orgNodes = declared.filter((n) => n.def.id === 'S1');
    const personNodes = declared.filter((n) => n.def.id === 'S6');
    if ((page.isHomepage || page.page_type === 'about') && !orgNodes.length && !personNodes.length) {
      b.hit('C-3.1-t', { summary: 'No Organization (or Person, for a personal site) node anywhere in the page graph — the root cause of most entity-resolution failures.', evidence: [gEv], remediation: remediationFor(ctx, page, ['S1']) });
    }

    // Required fields (R-3.1-7) — present / missing / not applicable
    const report = [];
    const hasVisibleDate = page.rawFacts.timeEls.length > 0 || /\b(19|20)\d{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+(19|20)\d{2}\b/i.test(visible);
    const hasVisiblePrice = /[$€£¥₹]\s?\d|\b\d[\d,.]*\s?(usd|eur|gbp|inr)\b/i.test(visible);
    const hasLogoImg = page.rawFacts.images.some((i) => /logo/i.test(`${i.src} ${i.alt}`));
    const hasByline = /\b(by|written by|author)\s*:?\s+[A-Z][a-z]+/.test(page.rendered?.dom?.visibleText || page.rawFacts.bodyText);
    const naWhen = { logo: !hasLogoImg, datePublished: !hasVisibleDate, author: !hasByline, 'price|priceSpecification.price|lowPrice': !hasVisiblePrice, 'priceCurrency|priceSpecification.priceCurrency': !hasVisiblePrice, 'offers|review|aggregateRating': !hasVisiblePrice };
    for (const n of inScope) {
      const node = n.node;
      if (isReferenceNode(n) || isDescriptorNode(n)) continue; // points at, or describes, another entity
      // S3 is the page's own WebPage node: a second WebPage nested elsewhere describes another URL.
      if (n.def.id === 'S3' && n.nested && node.url && normalizeForCompare(node.url) !== normalizeForCompare(url)) continue;
      const missing = [];
      const na = [];
      for (const f of n.def.required) {
        if (f === '@id' ? !!node['@id'] : hasField(node, f)) continue;
        if (naWhen[f]) na.push(f);
        else missing.push(f);
      }
      const rec = n.def.recommended.filter((f) => hasField(node, f));
      const refsDangling = danglingRefs({ nodes: [{ node }], ids: graph.ids });
      report.push({ type: typesOf(node).join('/'), fixed_id: n.def.id, present: true, syntax: 'json-ld', source_profile: profile, id_value: node['@id'] || null, required_missing: missing, required_not_applicable: na, recommended_present: rec, refs_dangling: refsDangling.map((d) => d.ref) });
      if (missing.length) {
        const policy = n.def.id === 'S1' ? ` ${ORG_POLICY}` : '';
        b.hit('C-3.1-d', { summary: `${n.def.label} (${n.def.id}) is missing tool-required field(s): ${missing.join(', ')}.${policy}`, evidence: [ev({ kind: 'dom_node', source_url: url, fetch_profile: profile, selector_or_key: `${n.def.label} node`, observed_value: JSON.stringify(node).slice(0, 1500) })], remediation: correctedFragment(ctx, page, n, missing) });
      }
      if (n.def.faq) {
        const qs = asArray(node.mainEntity).filter((q) => typesOf(q).includes('Question'));
        const malformed = !qs.length || qs.some((q) => !q.name || !(q.acceptedAnswer?.text || asArray(q.acceptedAnswer)[0]?.text));
        if (malformed) b.hit('C-3.1-r', { summary: `FAQPage markup is malformed (Question needs name + acceptedAnswer.text). ${FAQ_NOTE}`, evidence: [gEv] });
        const onPage = (q) => visible.includes(collapse(q.name).toLowerCase().slice(0, 60));
        const notVisible = qs.filter((q) => q.name && !onPage(q));
        if (notVisible.length) b.hit('C-3.1-u', { summary: `${notVisible.length} FAQ question(s) in markup do not appear in the page's content — violates Google's structured-data content policy. ${FAQ_NOTE}`, evidence: notVisible.slice(0, 5).map((q) => ev({ kind: 'dom_node', source_url: url, fetch_profile: profile, selector_or_key: 'FAQPage.mainEntity[].name', observed_value: q.name })) });
        // Whether an answer sits behind an expand/collapse control is a question about layout, and
        // only innerText answers it. Without a browser the two texts are the same string, so every
        // answer would test as "not behind an expander" - an assertion we have no basis for.
        if (renderedDomObservable(page)) {
          const behindExpander = qs.filter((q) => q.name && onPage(q) && !visibleWithoutInteraction.includes(collapse(q.name).toLowerCase().slice(0, 60)));
          if (behindExpander.length) b.note('FAQ_NOT_MARKED_UP', `${behindExpander.length} marked-up FAQ answer(s) sit behind an expand/collapse control. That is permitted — the content is on the page and a reader can reveal it — and is recorded as context, not as a mismatch.`);
        } else if (qs.some((q) => q.name && onPage(q))) {
          b.note('EXPANDER_STATE_UNOBSERVABLE', 'Whether these FAQ answers are visible immediately or sit behind an expand/collapse control could not be determined: this run had no browser, and that distinction depends on how the page lays out rather than on its markup. Both are permitted, so nothing is reported either way.');
        }
      }
      // Speakable (R-3.1-18)
      const speak = node.speakable;
      if (speak) {
        const sels = asArray(speak).flatMap((s) => asArray(s.cssSelector || s.xpath || []));
        const $ = hasRendered(page) ? loadHtml(page.rendered.html) : page.rawFacts.$;
        const unresolved = sels.filter((s) => {
          try {
            return String(s).startsWith('/') ? false : $(s).length === 0;
          } catch {
            return true;
          }
        });
        if (unresolved.length) b.hit('C-3.1-w', { summary: `speakable selector(s) resolve to nothing: ${unresolved.join(', ')}.`, evidence: [gEv] });
      }
      // Casing (R-3.1-12), placeholders (R-3.1-13), dates (R-3.1-11)
      const bad = invalidCasing(node);
      if (bad.length) b.hit('C-3.1-k', { summary: `${n.def.label}: property name(s) with invalid casing — schema.org properties are case-sensitive lowerCamel: ${bad.join(', ')}.`, evidence: [gEv] });
      const ph = placeholderValues(node);
      if (ph.length) b.hit('C-3.1-l', { summary: `Placeholder value(s) in ${n.def.label}: ${ph.map((p) => `${p.field}="${p.value}"`).join(', ')}. Omit a property rather than supply a placeholder.`, evidence: [gEv] });
      for (const df of ['datePublished', 'dateModified']) {
        const v = node[df];
        if (v == null) continue;
        const d = Date.parse(v);
        if (!isIsoDate(String(v)) || Number.isNaN(d)) b.hit('C-3.1-m', { summary: `${n.def.label}.${df} "${v}" is not ISO 8601.`, evidence: [gEv] });
        else if (d > Date.now() + 86400000) b.hit('C-3.1-m', { summary: `${n.def.label}.${df} ${v} is in the future.`, evidence: [gEv] });
      }
      if (node.datePublished && node.dateModified && Date.parse(node.dateModified) < Date.parse(node.datePublished)) b.hit('C-3.1-m', { summary: `${n.def.label}: dateModified (${node.dateModified}) is earlier than datePublished (${node.datePublished}).`, evidence: [gEv] });
      if ((node.datePublished || node.dateModified) && !hasVisibleDate) b.hit('C-3.1-aa', { summary: `${n.def.label} carries a date in markup that is not visible on the page.`, evidence: [gEv], cross_references: ['C-6.5'] });
      if (node['@id'] && ['S1', 'S2', 'S3', 'S5', 'S7', 'S9'].includes(n.def.id) && !String(node['@id']).includes('#')) b.note('SCHEMA_ID_NO_FRAGMENT', `@id "${node['@id']}" has no fragment; risks collision with the WebPage url and other node types (E-3.1-7).`);
    }
    b.metric('per_type_report', report);

    // Dangling references (R-3.1-4)
    const dangling = danglingRefs(graph);
    if (dangling.length) b.hit('C-3.1-e', { summary: `${dangling.length} @id reference(s) do not resolve within the page graph: ${dangling.slice(0, 5).map((d) => `${d.field} → ${d.ref}`).join('; ')}.`, evidence: [gEv] });

    // Duplicate entities (R-3.1-10)
    for (const id of ['S1', 'S2']) {
      const decl = declared.filter((n) => n.def.id === id && !n.nested);
      const names = new Set(decl.map((n) => `${normName(n.node.name)}|${String(n.node.url || '').replace(/\/$/, '')}`));
      const ids = new Set(decl.map((n) => n.node['@id']).filter(Boolean));
      if (decl.length > 1 && names.size > 1) {
        if (ids.size === decl.length && id === 'S1') b.note('SCHEMA_DUPLICATE_ENTITY', `Multiple Organization nodes with distinct stable @ids (${[...ids].join(', ')}) — multi-brand architecture, not inconsistency (E-6.2-4).`);
        else b.hit('C-3.1-g', { summary: `${decl.length} ${id === 'S1' ? 'Organization' : 'WebSite'} nodes with conflicting name/url on one page. If a CMS plugin emits one of them, modify its graph through the plugin's supported filters rather than adding a second block (E-3.1-8).`, evidence: [gEv] });
      }
    }

    // URL/canonical alignment (R-3.1-6)
    const canon = ctx.derived.canonical?.get(page.url);
    const canonicalUrl = canon?.target || url;
    for (const n of inScope.filter((x) => x.def.id === 'S3' && !x.nested)) {
      const u = n.node.url;
      if (u && u !== canonicalUrl) b.hit('C-3.1-h', { summary: `WebPage url "${u}" ≠ page canonical "${canonicalUrl}".`, evidence: [ev({ kind: 'dom_node', source_url: url, fetch_profile: profile, selector_or_key: 'WebPage.url', observed_value: u, expected_value: canonicalUrl })] });
    }

    // Visible-content correspondence (R-3.1-8)
    const mismatches = [];
    const contains = (v) => {
      const t = collapse(String(v || '')).toLowerCase();
      if (!t) return true;
      if (visible.includes(t.slice(0, 80))) return true;
      const toks = significantTokens(t);
      return toks.length > 0 && toks.filter((x) => visible.includes(x)).length / toks.length >= 0.8;
    };
    for (const n of inScope) {
      if (n.def.id === 'S3' && n.node.name && !contains(n.node.name) && !collapse(title).toLowerCase().includes(collapse(n.node.name).toLowerCase())) mismatches.push(`WebPage.name "${n.node.name}"`);
      if (n.def.id === 'S5' && n.node.headline && !contains(n.node.headline)) mismatches.push(`Article.headline "${n.node.headline}"`);
      if (['S7', 'S8'].includes(n.def.id)) {
        const prices = asArray(n.node.offers || n.node).flatMap((o) => [o?.price, o?.lowPrice, o?.priceSpecification?.price]).filter((x) => x != null);
        for (const p of prices) {
          const num = String(p).replace(/[^\d.]/g, '');
          const variants = [num, Number(num).toLocaleString('en-US'), num.replace(/\.00$/, '')];
          if (num && !variants.some((v) => v && visible.replace(/[, ]/g, '').includes(v.replace(/[, ]/g, '')))) mismatches.push(`price ${p}`);
        }
      }
    }
    if (mismatches.length) {
      const localeSwitch = /currency|select (your )?(country|region)|€|£/.test(visible) && mismatches.every((m) => m.startsWith('price'));
      b.hit('C-3.1-i', { status: localeSwitch ? 'WARN' : undefined, summary: `Marked-up value(s) absent from visible content: ${mismatches.slice(0, 5).join('; ')} — violates Google's structured-data policy.${localeSwitch ? ' A locale/currency switcher was detected (E-3.1-10).' : ''}`, evidence: [gEv] });
    }

    // Type appropriateness (R-3.1-9)
    const standaloneProduct = topLevel.some((n) => n.def.id === 'S7' && n.parentKey !== 'itemListElement');
    if (page.page_type === 'category' && standaloneProduct) b.hit('C-3.1-j', { summary: 'Standalone Product node on a category/list page — product markup belongs on single-product pages (E-3.1-4).', evidence: [gEv] });
    if (['homepage', 'pricing', 'category', 'product_main', 'service_main', 'service_secondary', 'about'].includes(page.page_type) && topLevel.some((n) => n.def.id === 'S5' && n.parentKey !== 'itemListElement')) b.hit('C-3.1-j', { summary: `Article node on a non-article template (${page.page_type}).`, evidence: [gEv] });
    if (siteName && personNodes.some((n) => normName(n.node.name) === normName(siteName)) && !orgNodes.length) b.hit('C-3.1-j', { summary: `Person type used for the brand "${siteName}".`, evidence: [gEv] });

    // FAQ visible but unmarked (C-3.1-v)
    if (!present.has('S10') && (page.rawFacts.qaHeadingCount >= 3 || page.rawFacts.detailsQaCount >= 3)) b.hit('C-3.1-v', { summary: `Visible Q&A block without FAQPage markup. ${FAQ_NOTE}` });

    // Identity anchoring (R-3.1-19)
    // Identity anchoring is judged on the node that declares the organisation, not on a stub that
    // merely names it, nor on a partial second copy of the same organisation. Where several nodes
    // describe one entity (same name and url, no @id to merge on), the most complete one is the
    // declaration; the others would otherwise report an absent sameAs the entity does carry.
    const anchorCandidates = orgNodes.filter((x) => x.node.url || x.node.sameAs || Object.keys(x.node).length > 3);
    const byIdentity = new Map();
    for (const n of anchorCandidates) {
      const key = `${normName(n.node.name)}|${normalizeForCompare(n.node.url)}`;
      const prev = byIdentity.get(key);
      if (!prev || Object.keys(n.node).length > Object.keys(prev.node).length) byIdentity.set(key, n);
    }
    for (const n of byIdentity.values()) {
      const sameAs = asArray(n.node.sameAs).filter((s) => /^https?:\/\//.test(String(s)));
      const name = normName(n.node.name);
      const ambiguous = name && (AMBIGUOUS_WORDS.has(name) || (name.split(' ').length === 1 && name.length <= 5));
      if (!sameAs.length && ambiguous) b.hit('C-3.1-y', { summary: `Entity name "${n.node.name}" is ambiguous and Organization.sameAs is absent — nothing for a retrieval system to resolve against.`, evidence: [gEv], cross_references: ['C-6.2'] });
      else if (sameAs.length < ctx.cfg.schema.min_sameas) b.hit('C-3.1-x', { summary: `Organization.sameAs carries ${sameAs.length} profile URL(s) (< ${ctx.cfg.schema.min_sameas}). Profile reachability is validated by URL shape only (E-3.1-9).`, evidence: [gEv], cross_references: ['C-6.2'] });
      // E-5.3-8 routes this to C-3.1-l, whose registered code is SCHEMA_PLACEHOLDER_VALUE. The
      // summary states the actual fault so the finding is not read as a placeholder value.
      const misusedSameAs = asArray(n.node.sameAs).filter((s) => /llms(-full)?\.txt$/i.test(String(s)));
      if (misusedSameAs.length) {
        b.hit('C-3.1-l', {
          summary: `Organization.sameAs lists ${misusedSameAs.join(', ')}. sameAs is for profile URLs that identify the same entity elsewhere (social, Wikidata, Crunchbase); a text file on the same domain does not disambiguate the entity and dilutes the anchors that do (E-5.3-8).`,
          evidence: [ev({ kind: 'dom_node', source_url: url, fetch_profile: profile, selector_or_key: 'Organization.sameAs', observed_value: JSON.stringify(asArray(n.node.sameAs)), expected_value: 'profile URLs identifying the organisation on other sites' })],
          cross_references: ['C-5.3'],
        });
      }
    }
    if (['blog_article', 'blog_template_alt', 'author'].includes(page.page_type) && hasByline) {
      const art = inScope.find((n) => n.def.id === 'S5');
      const authorRefs = art ? asArray(art.node.author) : [];
      const personRef = authorRefs.some((a) => typesOf(a).includes('Person') || (a['@id'] && graph.ids.get(a['@id'])?.some((x) => typesOf(x).includes('Person'))));
      if (!personRef) b.hit('C-3.1-z', { summary: 'An author is named in visible text but no Person node is referenced from the Article author property.', evidence: [gEv], cross_references: ['C-6.2'] });
    }

    // Blocked-markup (R-3.1-14)
    const meta = ctx.derived.robotsMeta?.get(page.url);
    if ((meta?.noindex || ctx.robotsAllowed('googlebot', url).verdict === 'DISALLOWED') && graph.nodes.length) b.hit('C-3.1-p', { summary: 'Page is noindex or robots-blocked, so its structured data cannot be used at all.', evidence: [gEv], cross_references: ['C-1.6', 'C-1.7'] });

    // Derived data for cross-page and Section 5/6 checks
    for (const n of orgNodes) {
      if (n.node['@id']) S.orgIds.set(page.url, [...(S.orgIds.get(page.url) || []), n.node['@id']]);
      if (!S.org && Object.keys(n.node).length > 2) S.org = { name: n.node.name || null, legalName: n.node.legalName || null, description: n.node.description || null, url: n.node.url || null, sameAs: asArray(n.node.sameAs), id: n.node['@id'] || null, page: url };
    }
    for (const n of inScope.filter((x) => x.def.id === 'S2')) if (n.node['@id']) S.siteIds.set(page.url, [...(S.siteIds.get(page.url) || []), n.node['@id']]);
    const dated = inScope.find((n) => (n.def.id === 'S5' || n.def.id === 'S3') && (n.node.datePublished || n.node.dateModified));
    if (dated) S.dates.set(page.url, { datePublished: dated.node.datePublished || null, dateModified: dated.node.dateModified || null });
    if (personNodes.length) S.persons.set(page.url, personNodes.map((n) => n.node));
    S.websiteName ||= inScope.find((n) => n.def.id === 'S2')?.node?.name || null;

    b.addEvidence(gEv);
    if (!b.hits.length) b.pass(`In-scope types present for ${page.page_type} (${[...present].sort().join(', ')}), parse cleanly, carry required fields, resolve their @ids and align with visible content.`);
  });

  // P6 — @id stability for S1/S2 (R-3.1-5)
  if (sampleSize(ctx) >= 2) {
    for (const [label, map] of [['Organization', S.orgIds], ['WebSite', S.siteIds]]) {
      const all = new Set([...map.values()].flat());
      if (all.size > 1) {
        for (const r of results) {
          if (!map.has(r.target_url) && !map.has(ctx.pages.find((p) => p.finalUrl === r.target_url)?.url)) continue;
          r.sub_findings.push({ checkpoint: 'C-3.1-f', status: 'FAIL', severity: 'HIGH', reason_code: 'SCHEMA_UNSTABLE_ENTITY_ID', summary: `${label} @id differs across sampled pages: ${[...all].join(', ')}.`, evidence: [], sources: ctx.register.resolve('C-3.1', { checkpoint: 'C-3.1-f' }).sources, caveats: [] });
          if (r.status === 'PASS' || r.status === 'WARN') Object.assign(r, { status: 'FAIL', severity: 'HIGH', reason_code: 'SCHEMA_UNSTABLE_ENTITY_ID', summary: `${label} @id is not byte-identical site-wide (${all.size} variants), fragmenting the entity.` });
        }
      }
    }
  }
  return results;
}

/** R-3.1-21 — minimal corrected JSON-LD using only observed/derivable values; placeholders otherwise. */
function correctedFragment(ctx, page, n, missing) {
  const node = { '@context': 'https://schema.org', ...Object.fromEntries(Object.entries(n.node).filter(([k]) => !k.startsWith('@') || k === '@type' || k === '@id')) };
  const f = page.rawFacts;
  for (const field of missing) {
    const key = field.split('|')[0].split('.')[0];
    let v = null;
    if (key === 'name') v = n.def.id === 'S1' ? detectSiteName(ctx) : f.headings.find((h) => h.level === 1)?.text || f.titles[0]?.text || null;
    else if (key === 'url') v = n.def.id === 'S1' || n.def.id === 'S2' ? `${ctx.canonicalOrigin}/` : page.finalUrl;
    else if (key === '@id') v = n.def.id_convention?.replace('{origin}', ctx.canonicalOrigin).replace('{page_url}', page.finalUrl) || null;
    else if (key === 'headline') v = f.headings.find((h) => h.level === 1)?.text || null;
    else if (key === 'publisher' || key === 'provider') v = { '@id': `${ctx.canonicalOrigin}/#organization` };
    else if (key === 'isPartOf') v = { '@id': `${ctx.canonicalOrigin}/#website` };
    node[key] = v ?? '<REQUIRED — supply value>';
  }
  const proposed = JSON.stringify(node, null, 2);
  return {
    action: `Add the missing field(s) ${missing.join(', ')} to the existing ${n.def.label} node (modify the existing graph; do not add a second block — F-3.1-6).`,
    current: n.node['@id'] || typesOf(n.node).join('/'),
    proposed,
    // DERIVED means every value came from the page and the block can be used as it stands.
    // TEMPLATE means it carries placeholders that a human must fill in first. Labelling a
    // template as ready to use is how a placeholder ends up live on a site.
    confidence: hasPlaceholder(proposed) ? 'TEMPLATE' : 'DERIVED',
  };
}

/** True when a generated block still contains a value a human has to supply. */
function hasPlaceholder(json) {
  return /<REQUIRED/.test(String(json));
}

function remediationFor(ctx, page, ids) {
  const out = { '@context': 'https://schema.org', '@graph': [] };
  const site = detectSiteName(ctx);
  if (ids.includes('S1')) out['@graph'].push({ '@type': 'Organization', '@id': `${ctx.canonicalOrigin}/#organization`, name: site || '<REQUIRED — supply value>', url: `${ctx.canonicalOrigin}/`, logo: '<REQUIRED — supply value>' });
  if (ids.includes('S3')) {
    // isPartOf points at #website, so #website has to exist. A reference to an @id that appears
    // nowhere in the graph resolves to nothing and is worse than omitting the relation: it reads
    // as a declared relationship that no consumer can follow.
    out['@graph'].push({
      '@type': 'WebSite',
      '@id': `${ctx.canonicalOrigin}/#website`,
      url: `${ctx.canonicalOrigin}/`,
      name: site || '<REQUIRED — supply value>',
      ...(ids.includes('S1') ? { publisher: { '@id': `${ctx.canonicalOrigin}/#organization` } } : {}),
    });
    out['@graph'].push({ '@type': 'WebPage', '@id': `${page.finalUrl}#webpage`, url: page.finalUrl, name: page.rawFacts.titles[0]?.text || '<REQUIRED — supply value>', isPartOf: { '@id': `${ctx.canonicalOrigin}/#website` } });
  }
  const proposed = JSON.stringify(out, null, 2);
  const template = hasPlaceholder(proposed);
  return {
    action: template
      ? 'Add this JSON-LD graph once the placeholder values have been supplied. Every other value is observed on the page.'
      : 'Add this JSON-LD graph. Every value in it is observed on the page.',
    current: null,
    proposed,
    confidence: template ? 'TEMPLATE' : 'DERIVED',
  };
}
