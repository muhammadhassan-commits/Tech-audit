// C-1.5 — Canonical Tags (page · RAW and RENDERED + Link header). Declared canonical only (F-1.5-5).
import { ev } from '../engine/result.js';
import { normalizeUrl, originOf } from '../parse/url.js';
import { bodyText } from '../net/http.js';
import { extractFacts } from '../parse/html.js';
import { shingles, jaccard } from '../parse/text.js';
import { forEachPage, hasRendered, domEv, sampleSize } from './_util.js';

const STANDING = 'A declared canonical is a strong signal, not an instruction; Google may select a different canonical.';

export function linkHeaderCanonicals(headers) {
  const v = headers?.link;
  if (!v) return [];
  const out = [];
  for (const part of String(v).split(/,(?=\s*<)/)) {
    const m = /<([^>]+)>\s*;(.*)$/.exec(part.trim());
    if (m && /rel\s*=\s*"?[^";]*\bcanonical\b/i.test(m[2])) out.push(m[1]);
  }
  return out;
}

function looseKey(u) {
  try {
    const x = new URL(u);
    return `${x.host.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '').toLowerCase()}${x.search}`;
  } catch {
    return u;
  }
}

async function fetchTarget(ctx, url) {
  ctx.derived.canonicalTargets ||= new Map();
  if (ctx.derived.canonicalTargets.has(url)) return ctx.derived.canonicalTargets.get(url);
  const p = (async () => {
    const rec = await ctx.http.fetch(url, { budgetClass: 'secondary' });
    const facts = rec.status >= 200 && rec.status < 300 ? extractFacts(bodyText(rec), rec.final_url, ctx.canonicalOrigin) : null;
    const noindex = facts ? facts.metaRobots.some((m) => ['robots', 'googlebot'].includes(m.name) && /noindex|none/i.test(m.content)) || /noindex/i.test(String(rec.headers?.['x-robots-tag'] || '')) : false;
    const canon = facts?.canonicals.find((c) => c.in_head)?.href;
    return { rec, facts, noindex, canonical: canon ? normalizeUrl(canon, rec.final_url) : null };
  })();
  ctx.derived.canonicalTargets.set(url, p);
  return p;
}

export async function run(ctx) {
  ctx.derived.canonical = new Map();
  const results = await forEachPage(ctx, 'C-1.5', async (page, b) => {
    b.caveat(STANDING);
    if (ctx.derived.multipleLiveOrigins) b.caveat('Duplicate live origins (C-1.4-c) may be producing canonical findings on this page (F-1.4-5).');
    if (!page.is_html) {
      const lh = linkHeaderCanonicals(page.raw.headers);
      if (lh.length) b.pass('Non-HTML resource declares its canonical via the Link header (E-1.5-8).');
      else b.notApplicable('CANONICAL_ABSENT', 'Non-HTML resource without a Link canonical.');
      b.addEvidence(ev({ kind: 'http_header', source_url: page.url, fetch_profile: 'RAW', selector_or_key: 'Link', observed_value: page.raw.headers?.link ?? null }));
      return;
    }
    const f = page.rawFacts;
    const finalUrl = page.finalUrl;
    const head = f.canonicals.filter((c) => c.in_head && !c.in_noscript);
    const body = f.canonicals.filter((c) => !c.in_head);
    const header = linkHeaderCanonicals(page.raw.headers);
    const ren = hasRendered(page) ? page.renFacts.canonicals.filter((c) => c.in_head) : null;
    b.metric('raw_head', head.map((c) => c.href)).metric('raw_body', body.map((c) => c.href)).metric('link_header', header).metric('rendered', ren ? ren.map((c) => c.href) : 'NOT_AVAILABLE');
    const rawEv = domEv(page, 'RAW', 'head > link[rel=canonical]', head.map((c) => c.href).join(' | ') || '(none)', finalUrl);

    const state = { state: 'ABSENT', target: null };
    ctx.derived.canonical.set(page.url, state);

    // Multiplicity / placement
    const distinct = [...new Set(head.map((c) => String(c.href ?? '').trim()))];
    if (head.length > 1 && distinct.length > 1) b.hit('C-1.5-b', { summary: `${head.length} link[rel=canonical] elements with different values in <head>; Google may ignore all of them.`, evidence: [rawEv] });
    else if (head.length > 1) b.hit('C-1.5-b', { status: 'WARN', severity: 'LOW', reason_code: 'CANONICAL_DUPLICATED_IDENTICAL', summary: 'Duplicate identical canonical elements (sloppy but unambiguous, E-1.5-6).', evidence: [rawEv] });
    if (!head.length && body.length) b.hit('C-1.5-c', { summary: 'Canonical present only in <body> of the parsed document; Google ignores it.', evidence: [domEv(page, 'RAW', 'body link[rel=canonical]', body.map((c) => c.href).join(' | '))] });

    const declared = head[0]?.href ?? null;
    if (head.length) {
      const raw = String(declared ?? '').trim();
      const resolved = raw ? normalizeUrl(raw, f.base_url) : null;
      if (!raw || !resolved) {
        b.hit('C-1.5-e', { summary: `Canonical value is empty or unparseable ("${raw}").`, evidence: [rawEv] });
        state.state = 'INVALID';
      } else {
        if (!/^https?:\/\//i.test(raw)) b.hit('C-1.5-d', { summary: `Canonical is relative ("${raw}"); resolvable, but Google's guidance is to use absolute URLs.`, evidence: [rawEv] });
        if (raw.includes('#')) b.hit('C-1.5-r', { summary: 'Canonical contains a fragment.', evidence: [rawEv] });
        const target = resolved.split('#')[0];
        state.target = target;
        if (target === finalUrl) state.state = 'SELF';
        else {
          state.state = 'CROSS';
          if (looseKey(target) === looseKey(finalUrl)) {
            b.hit('C-1.5-q', { summary: `Canonical ${target} differs from the page URL ${finalUrl} only by protocol, www, trailing slash or case.`, evidence: [rawEv] });
          }
          if (originOf(target) !== ctx.canonicalOrigin && new URL(target).host.replace(/^www\./, '') !== new URL(ctx.canonicalOrigin).host.replace(/^www\./, '')) {
            b.hit('C-1.5-t', { summary: `Canonical points off ${ctx.canonicalOrigin} to ${target} (intentional for syndicated content, E-1.5-3).`, evidence: [rawEv] });
          }
          if (ctx.robotsAllowed('googlebot', target).verdict === 'DISALLOWED') b.hit('C-1.5-i', { summary: `Canonical target ${target} is disallowed for Googlebot.`, evidence: [rawEv], cross_references: ['C-1.1'] });
          const t = await fetchTarget(ctx, target);
          const tEv = ev({ kind: 'http_status', source_url: target, fetch_profile: 'RAW', selector_or_key: 'canonical target status', observed_value: t.rec.status == null ? null : String(t.rec.status), expected_value: '200' });
          if (t.rec.status == null) b.caveat(`Canonical target ${target} could not be fetched (${t.rec.error?.code}); target validation NOT_TESTABLE (B-1.5-3).`);
          else if ((t.rec.hop_count || 0) > 0) b.hit('C-1.5-g', { summary: `Canonical target ${target} redirects (${t.rec.chain.map((h) => h.status).join(' → ')} → ${t.rec.final_url}).`, evidence: [tEv], cross_references: ['C-1.4'] });
          else if (t.rec.status >= 400) b.hit('C-1.5-f', { summary: `Canonical target ${target} returns HTTP ${t.rec.status}.`, evidence: [tEv] });
          if (t.noindex) b.hit('C-1.5-h', { summary: `Canonical target ${target} is noindex.`, evidence: [tEv], cross_references: ['C-1.6'] });
          if (t.canonical && t.canonical !== target) {
            if (t.canonical === finalUrl) b.hit('C-1.5-j', { summary: `Canonical loop: ${finalUrl} → ${target} → ${finalUrl}.`, evidence: [tEv] });
            else {
              // Resolve one more level (F-1.5-1 depth 3).
              const t2 = await fetchTarget(ctx, t.canonical);
              const deep = t2.canonical && t2.canonical !== t.canonical;
              b.hit('C-1.5-k', { reason_code: deep ? 'CANONICAL_CHAIN_DEEP' : undefined, summary: `Canonical chain: ${finalUrl} → ${target} → ${t.canonical}${deep ? ` → ${t2.canonical}` : ''}.`, evidence: [tEv] });
            }
          }
          if (t.facts && page.rawFacts.mainText.length > 200) {
            const sim = jaccard(shingles(page.rawFacts.mainText), shingles(t.facts.mainText));
            if (sim < 0.2) b.hit('C-1.5-l', { summary: `Cross-canonical target shares little of this page's content (5-shingle Jaccard ${sim.toFixed(2)}).`, evidence: [tEv] });
          }
          state.targetIndexable = t.rec.status === 200 && !t.noindex && (t.rec.hop_count || 0) === 0;
        }
      }
    }

    // Link header vs HTML (R-1.5-1 #3)
    if (header.length) {
      const h = normalizeUrl(header[0], finalUrl);
      const html = declared ? normalizeUrl(declared, f.base_url) : null;
      if (html && h && h !== html) b.hit('C-1.5-p', { summary: `HTTP Link canonical (${h}) disagrees with the HTML canonical (${html}).`, evidence: [ev({ kind: 'http_header', source_url: page.url, fetch_profile: 'RAW', selector_or_key: 'Link', observed_value: page.raw.headers.link, expected_value: html })] });
      if (!html && h) {
        state.state = h === finalUrl ? 'SELF' : 'CROSS';
        state.target = h;
      }
    }

    // RAW vs RENDERED (R-1.5-7)
    if (ren) {
      const renVal = ren[0]?.href ? normalizeUrl(ren[0].href, page.renFacts.base_url) : null;
      const rawVal = declared ? normalizeUrl(declared, f.base_url) : null;
      const renEv = domEv(page, 'RENDERED', 'head > link[rel=canonical]', ren.map((c) => c.href).join(' | ') || '(none)');
      if (!rawVal && renVal) {
        b.hit('C-1.5-n', { summary: 'Canonical present only after rendering (JS/tag-manager injected); a rendering failure would leave the page with no canonical (E-1.5-7).', evidence: [renEv], cross_references: ['C-5.2'] });
        state.state = renVal === finalUrl ? 'SELF' : 'CROSS';
        state.target = renVal;
      } else if (rawVal && renVal && rawVal !== renVal) {
        b.hit('C-1.5-o', { summary: `RAW canonical ${rawVal} differs from RENDERED canonical ${renVal}.`, evidence: [rawEv, renEv] });
      }
    } else {
      b.caveat('RENDERED canonical not compared (no RENDERED profile for this page); C-1.5-n/o NOT_TESTABLE (B-1.5-2).');
    }

    if (!head.length && !body.length && !header.length && !(ren && ren.length)) {
      b.hit('C-1.5-m', { summary: 'No canonical in RAW, RENDERED or Link header. Legal — Google will choose one — reported as a risk, not breakage.', evidence: [rawEv] });
    }
    const noindex = f.metaRobots.some((m) => ['robots', 'googlebot'].includes(m.name) && /noindex|none/i.test(m.content));
    if (noindex && head.length) b.note('CANONICAL_ABSENT', 'Canonical on a noindex page: conflicting but not fatal — noindex wins (E-1.5-5).');

    b.addEvidence(rawEv);
    if (!b.hits.filter((h) => h.status !== 'PASS').length && head.length === 1) {
      b.pass(state.state === 'SELF' ? `Exactly one self-referencing canonical in RAW <head>: ${state.target}.` : `Exactly one canonical in RAW <head> pointing to a healthy, indexable target ${state.target} (E-1.5-2).`);
    }
  });

  // P6 — canonical clusters (R-1.5-10)
  if (sampleSize(ctx) >= 2) {
    const byTarget = new Map();
    for (const [url, s] of ctx.derived.canonical) if (s.target) (byTarget.get(s.target) || byTarget.set(s.target, []).get(s.target)).push(url);
    for (const [target, urls] of byTarget) {
      if (urls.length < 2) continue;
      for (const r of results) {
        if (!urls.includes(r.target_url) && !urls.some((u) => ctx.pages.find((p) => p.url === u)?.finalUrl === r.target_url)) continue;
        r.sub_findings.push({ checkpoint: 'C-1.5-s', status: 'WARN', severity: 'MEDIUM', reason_code: 'CANONICAL_CLUSTER', summary: `${urls.length} sampled pages declare the same canonical ${target}: ${urls.join(', ')}.`, evidence: [], sources: ctx.register.resolve('C-1.5', { checkpoint: 'C-1.5-s' }).sources, caveats: [] });
        if (r.status === 'PASS') Object.assign(r, { status: 'WARN', severity: 'MEDIUM', reason_code: 'CANONICAL_CLUSTER', summary: `Canonical cluster: ${urls.length} sampled pages declare ${target}.` });
      }
    }
  }
  return results;
}
