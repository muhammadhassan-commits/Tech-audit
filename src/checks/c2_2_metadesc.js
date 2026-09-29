// C-2.2 — Meta Descriptions (page · RAW and RENDERED). Never FAIL on absence or length (F-2.2-1/2).
import { forEachPage, hasRendered, domEv, jsCaveat, sampleSize, isPaginated } from './_util.js';
import { collapse, levenshteinRatio, graphemeLength, pixelWidth, PLACEHOLDER_RE, tokens, STOP } from '../parse/text.js';

const LENGTH_CAVEAT = 'Google documents no meta-description length limit and may not use the tag at all — snippets are generated primarily from page content.';

function keywordList(d) {
  const frags = d.split(',').map((s) => s.trim()).filter(Boolean);
  if (frags.length >= 5 && !frags.some((f) => /\b(is|are|get|make|find|learn|discover|build|create|use|helps?|see|try|start|offers?|provides?)\b/i.test(f))) return true;
  const counts = new Map();
  for (const t of tokens(d)) if (t.length >= 3 && !STOP.has(t)) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.values()].some((c) => c >= 4);
}

const skeleton = (s) => collapse(s).replace(/\d[\d,.]*/g, '#').replace(/\b[A-Z][\p{L}]+/gu, 'X').toLowerCase();

export async function run(ctx) {
  const descs = new Map();
  for (const p of ctx.pages) {
    const d = p.rawFacts?.metaDescriptions.find((m) => m.in_head)?.content;
    if (d && collapse(d)) descs.set(p.url, { d: collapse(d), sk: skeleton(d), paginated: isPaginated(p.url) });
  }
  const multi = sampleSize(ctx) >= 2;

  return forEachPage(ctx, 'C-2.2', (page, b) => {
    if (!page.is_html) return b.notApplicable('INSUFFICIENT_SAMPLE', 'Non-HTML resource.');
    const f = page.rawFacts;
    const meta = ctx.derived.robotsMeta?.get(page.url);
    if (meta?.nosnippet || meta?.maxSnippet0) {
      b.notApplicable('SNIPPET_SUPPRESSED', 'The page carries nosnippet / max-snippet:0, so a meta description cannot be used (C-2.2-l; cross-reference C-1.6). Length and duplication are not evaluated (E-2.2-7).');
      b.xref('C-1.6');
      return;
    }
    jsCaveat(b, page);
    const els = f.metaDescriptions.filter((m) => m.in_head);
    const ren = hasRendered(page) ? page.renFacts.metaDescriptions.filter((m) => m.in_head) : null;
    const d = els[0] ? collapse(els[0].content) : null;
    const dEv = domEv(page, 'RAW', 'head > meta[name=description]', els[0]?.content ?? '(absent)');
    b.metric('description', d).metric('chars', d ? graphemeLength(d) : 0).metric('pixel_width', d ? pixelWidth(d, 14) : 0).metric('og_description', f.og['og:description'] || null).metric('twitter_description', f.og['twitter:description'] || null);
    if (d && (graphemeLength(d) < ctx.cfg.th.metadesc_len_warn_min || graphemeLength(d) > ctx.cfg.th.metadesc_len_warn_max)) {
      b.note(null, `Description is ${graphemeLength(d)} characters, outside the advisory ${ctx.cfg.th.metadesc_len_warn_min}–${ctx.cfg.th.metadesc_len_warn_max} band. ${LENGTH_CAVEAT}`);
    }

    if (!els.length && !(ren && ren.some((m) => collapse(m.content)))) {
      b.hit('C-2.2-b', { summary: `No meta description in RAW or RENDERED. Google generates snippets from page content and often ignores the tag, so this is an opportunity, not a defect.${f.og['og:description'] ? ' og:description is present, but it serves social previews, not Google snippets (E-2.2-3).' : ''}`, evidence: [dEv] });
      b.addEvidence(dEv);
      return;
    }
    if (!els.length && ren?.length) {
      b.hit('C-2.2-h', { summary: 'Meta description exists only after rendering.', evidence: [domEv(page, 'RENDERED', 'head > meta[name=description]', ren[0].content)], cross_references: ['C-5.2'] });
      return;
    }
    if (!d) b.hit('C-2.2-c', { summary: 'Meta description is empty or whitespace-only.', evidence: [dEv] });
    if (els.length > 1) b.hit('C-2.2-d', { summary: `${els.length} meta description elements.`, evidence: els.map((m) => domEv(page, 'RAW', 'meta[name=description]', m.content)) });
    if (d && PLACEHOLDER_RE.test(d)) b.hit('C-2.2-j', { summary: `Unresolved template placeholder in the description: "${d}".`, evidence: [dEv] });
    if (d && keywordList(d)) b.hit('C-2.2-g', { summary: 'Description has a keyword-list shape.', evidence: [dEv] });
    const title = f.titles[0]?.text ? collapse(f.titles[0].text) : null;
    if (d && title && d.toLowerCase() === title.toLowerCase()) b.hit('C-2.2-k', { summary: 'Description is identical to the <title>.', evidence: [dEv] });
    if (ren && d && ren[0] && collapse(ren[0].content) !== d) b.hit('C-2.2-i', { summary: 'RAW and RENDERED descriptions differ.', evidence: [dEv, domEv(page, 'RENDERED', 'head > meta[name=description]', ren[0].content)] });
    if (!ren) b.caveat('RAW vs RENDERED description not compared; C-2.2-h/i NOT_TESTABLE (B-2.2-2).');

    if (d && multi && !isPaginated(page.url)) {
      const exact = [];
      const near = [];
      for (const [u, o] of descs) {
        if (u === page.url || o.paginated) continue;
        if (o.d.toLowerCase() === d.toLowerCase()) exact.push(u);
        else if (levenshteinRatio(o.d.toLowerCase(), d.toLowerCase()) >= 0.9) near.push(u);
      }
      const sk = skeleton(d);
      const sameSkeleton = [...descs.entries()].filter(([u, o]) => u !== page.url && o.sk === sk).map(([u]) => u);
      if (exact.length) b.hit('C-2.2-e', { summary: `Description duplicates: ${exact.join(', ')}.`, evidence: [dEv] });
      else if (near.length || sameSkeleton.length >= 2) {
        const others = near.length ? near : sameSkeleton;
        const variable = 1 - levenshteinRatio(descs.get(others[0])?.d || '', d);
        if (variable >= 0.2) b.note('METADESC_TEMPLATED', `Templated description with a variable portion of ~${Math.round(variable * 100)}% — templating done correctly (E-2.2-6).`);
        else b.hit('C-2.2-f', { summary: `Description is templated / near-duplicate across: ${others.join(', ')}.`, evidence: [dEv] });
      }
    } else if (!multi) {
      b.caveat('Duplicate detection NOT_APPLICABLE — fewer than 2 sampled pages (B-2.2-3).');
    }
    b.addEvidence(dEv);
    if (!b.hits.length) b.pass(`Exactly one non-empty, sample-unique meta description (${graphemeLength(d)} characters). ${LENGTH_CAVEAT}`);
  });
}
