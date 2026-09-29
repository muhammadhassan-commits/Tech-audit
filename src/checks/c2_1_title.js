// C-2.1 — Title Tags (page · RAW and RENDERED). Length is reported, never failed (R-CFG-1, F-2.1-1).
import { forEachPage, hasRendered, domEv, jsCaveat, sampleSize, isPaginated } from './_util.js';
import { collapse, levenshteinRatio, graphemeLength, pixelWidth, isMostlyNonLatin, PLACEHOLDER_RE, tokens, STOP } from '../parse/text.js';
import { detectSiteName, normaliseTitle, normName } from './_sitename.js';
import { parseBlock, buildGraph, typesOf } from '../parse/jsonld.js';

const BOILERPLATE = /^(home|homepage|untitled|untitled document|new page|page|document|index|welcome|my (wordpress )?(site|blog)|just another wordpress site|react app|vite app|next\.js app)$/i;
const LENGTH_CAVEAT = 'Google specifies no character limit; truncation is device-width dependent.';

export function keywordStuffed(t) {
  const counts = new Map();
  for (const tok of tokens(t)) if (tok.length >= 4 && !STOP.has(tok)) counts.set(tok, (counts.get(tok) || 0) + 1);
  if ([...counts.values()].some((c) => c >= 3)) return true;
  const frags = t.split(/[,|]/).map((s) => s.trim()).filter(Boolean);
  return frags.length >= 4 && !frags.some((f) => /\b(is|are|get|make|find|learn|discover|build|create|use|helps?|see|try|start|how)\b/i.test(f));
}

export async function run(ctx) {
  const siteName = detectSiteName(ctx);
  const titles = new Map();
  for (const p of ctx.pages) {
    const t = p.rawFacts?.titles.find((x) => x.in_head)?.text ?? p.renFacts?.titles[0]?.text;
    if (t != null && collapse(t)) titles.set(p.url, { raw: collapse(t), norm: normaliseTitle(t, siteName), paginated: isPaginated(p.url) });
  }
  const multi = sampleSize(ctx) >= 2;

  return forEachPage(ctx, 'C-2.1', (page, b) => {
    if (!page.is_html) return b.notApplicable('INSUFFICIENT_SAMPLE', 'Non-HTML resource.');
    const f = page.rawFacts;
    const inHead = f.titles.filter((t) => t.in_head);
    const outside = f.titles.filter((t) => !t.in_head);
    const ren = hasRendered(page) ? page.renFacts.titles.filter((t) => t.in_head) : null;
    const first = inHead[0] || outside[0];
    const text = first ? collapse(first.text) : null;
    const tEv = domEv(page, 'RAW', 'head > title', first ? first.text : '(absent)');
    jsCaveat(b, page);

    // R-2.1-3 fallback sources Google may use for the title link
    const h1 = f.headings.find((h) => h.level === 1)?.text || null;
    const g = buildGraph(f.jsonld.map((x) => parseBlock(x.raw)).filter((x) => x.value !== undefined));
    const wsName = g.nodes.find((n) => typesOf(n.node).some((t) => ['WebSite', 'WebPage'].includes(t)))?.node?.name || null;
    b.metric('title', text)
      .metric('chars', text ? graphemeLength(text) : 0)
      .metric('pixel_width_20px_arial', text ? pixelWidth(text) : 0)
      .metric('fallback_sources', { h1, og_title: f.og['og:title'] || null, structured_data_name: wsName })
      .metric('site_name', siteName);
    if (text) {
      const len = graphemeLength(text);
      if (!isMostlyNonLatin(text) && (len < ctx.cfg.th.title_len_warn_min || len > ctx.cfg.th.title_len_warn_max)) {
        b.note(null, `Title length ${len} characters (~${pixelWidth(text)}px at 20px Arial) is outside the advisory ${ctx.cfg.th.title_len_warn_min}–${ctx.cfg.th.title_len_warn_max} band. ${LENGTH_CAVEAT}`);
      }
    }

    if (!first && !(ren && ren.length)) {
      b.hit('C-2.1-b', { summary: 'No <title> element in RAW or RENDERED.', evidence: [tEv] });
      return;
    }
    if (!first && ren?.length) {
      b.hit('C-2.1-e', { summary: `<title> exists only after rendering ("${collapse(ren[0].text)}"); it depends on rendering succeeding.`, evidence: [domEv(page, 'RENDERED', 'head > title', ren[0].text)], cross_references: ['C-5.2'] });
      return;
    }
    if (!text) b.hit('C-2.1-c', { summary: '<title> is empty.', evidence: [tEv] });
    if (f.titles.length > 1) b.hit('C-2.1-d', { summary: `${f.titles.length} <title> elements; parsers use the first and ignore the rest.`, evidence: f.titles.map((t) => domEv(page, 'RAW', 'title', t.text)) });
    if (!inHead.length && outside.length) b.hit('C-2.1-k', { summary: '<title> sits outside <head> in the parsed document.', evidence: [tEv] });
    if (ren && ren.length && text && collapse(ren[0].text) !== text) b.hit('C-2.1-f', { summary: `RAW title "${text}" differs from RENDERED title "${collapse(ren[0].text)}".`, evidence: [tEv, domEv(page, 'RENDERED', 'head > title', ren[0].text)] });
    if (!ren) b.caveat('RAW vs RENDERED title not compared; C-2.1-e/f NOT_TESTABLE (B-2.1-2).');
    if (text && PLACEHOLDER_RE.test(text)) b.hit('C-2.1-m', { summary: `Title contains an unresolved template placeholder: "${text}".`, evidence: [tEv] });
    if (text) {
      const norm = normaliseTitle(text, siteName);
      if (BOILERPLATE.test(norm) || (siteName && normName(text) === normName(siteName))) {
        b.hit('C-2.1-i', { summary: `Title is boilerplate or the site name only: "${text}".`, evidence: [tEv] });
      }
      if (keywordStuffed(text)) b.hit('C-2.1-j', { summary: `Title looks keyword-stuffed: "${text}".`, evidence: [tEv] });
      if (h1 && siteName && normName(h1) === normName(text) && normName(text) === normName(siteName)) b.hit('C-2.1-l', { summary: 'Title and H1 are both just the brand name.', evidence: [tEv] });

      // P6 duplicates (R-2.1-5) — brand suffix stripped first (E-2.1-2); pagination excluded (E-2.1-5)
      if (multi && !isPaginated(page.url)) {
        const exact = [];
        const near = [];
        for (const [u, o] of titles) {
          if (u === page.url || o.paginated) continue;
          if (o.norm === norm) exact.push(u);
          else if (levenshteinRatio(o.norm, norm) >= 0.9) near.push(u);
        }
        if (exact.length) b.hit('C-2.1-g', { summary: `Title duplicates ${exact.length} other sampled page(s): ${exact.join(', ')}.`, evidence: [tEv, ...exact.map((u) => domEv({ url: u }, 'RAW', 'head > title', titles.get(u).raw))] });
        else if (near.length) b.hit('C-2.1-h', { summary: `Title is a near-duplicate (≥ 0.9 similarity) of: ${near.join(', ')}.`, evidence: [tEv, ...near.map((u) => domEv({ url: u }, 'RAW', 'head > title', titles.get(u).raw))] });
      } else if (!multi) {
        b.caveat('Duplicate detection NOT_APPLICABLE — fewer than 2 sampled pages (B-2.1-3).');
      }
      if (!siteName) b.caveat('Site name undetectable; brand-suffix stripping skipped before the duplicate test (B-2.1-4).');
    }
    b.addEvidence(tEv);
    if (!b.hits.length) b.pass(`Exactly one non-empty <title> in <head>, unique within the sample: "${text}".`);
  });
}
