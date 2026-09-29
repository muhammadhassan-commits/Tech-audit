// C-1.7 — Indexability (composite over C-1.1, C-1.3, C-1.4, C-1.5, C-1.6; no new fetching).
import { ResultBuilder, ev, errorResult } from '../engine/result.js';
import { wordCount } from '../parse/text.js';
import { forEachPage, hasRendered, matchesAny, isPaginated } from './_util.js';

const GSC_CAVEAT = "Declared/observable state only; Google's actual index decision not verified.";

export async function run(ctx) {
  const states = [];
  const results = await forEachPage(ctx, 'C-1.7', (page, b) => {
    b.caveat(GSC_CAVEAT);
    const url = page.finalUrl;
    if (matchesAny(url, ctx.cfg.expected_noindex_paths)) {
      b.notApplicable('NOINDEX_INTENTIONAL', 'URL matches expected_noindex_paths — not expected to be indexable (E-1.7-1).');
      return;
    }
    const inputs = {};
    const missing = [];
    const status = page.raw.status;
    const robots = ctx.robotsAllowed('googlebot', url);
    const meta = ctx.derived.robotsMeta?.get(page.url);
    const canon = ctx.derived.canonical?.get(page.url);
    const c13 = ctx.results.find((r) => r.check_id === 'C-1.3' && r.scope === 'page' && r.target_url === page.url);
    if (!meta) missing.push('C-1.6 directives');
    if (!canon) missing.push('C-1.5 canonical');
    if (c13?.status === 'NOT_TESTABLE') missing.push('C-1.3 status');
    const soft404 = c13?.sub_findings?.some((s) => s.reason_code === 'SOFT_404_PAGE');
    const rawWords = wordCount(page.rawFacts?.mainText || '');
    const renWords = hasRendered(page) ? wordCount(page.renFacts.mainText) : null;
    const contentPresent = rawWords > 0 || (renWords ?? 0) > 0;
    const renderDependent = hasRendered(page) ? rawWords < 50 && renWords >= ctx.cfg.th.min_words_content_page : null;

    Object.assign(inputs, { robots: robots.verdict, status, noindex: meta?.noindex ?? null, canonical: canon?.state ?? null, canonical_target: canon?.target ?? null, soft_404: !!soft404, raw_words: rawWords, rendered_words: renWords });
    b.metric('inputs', inputs);

    const chain = [];
    if (robots.verdict === 'DISALLOWED') chain.push('BLOCKED_ROBOTS');
    if (status !== 200) chain.push('NON_200');
    if (meta?.noindex) chain.push('NOINDEX');
    if (canon?.state === 'CROSS') chain.push('CANONICALISED_AWAY');
    if (soft404) chain.push('SOFT_404');
    if (!contentPresent) chain.push('NO_CONTENT');
    b.metric('blocking_signal_chain', chain); // R-1.7-4 remediation order

    const conflicted =
      (robots.verdict === 'DISALLOWED' && meta?.noindex) ||
      (meta && meta.renNoindex != null && meta.rawNoindex !== meta.renNoindex) ||
      ctx.results.some((r) => r.check_id === 'C-1.5' && r.target_url === url && r.sub_findings?.some((s) => s.reason_code === 'CANONICAL_LOOP'));

    let state;
    if (conflicted) state = 'CONFLICTED';
    else state = chain[0] || 'INDEXABLE';
    if (state === 'INDEXABLE' && missing.length) {
      b.notTestable('INDEXABILITY_CONFLICT', `Indexability cannot be asserted: required input(s) not available — ${missing.join(', ')} (F-1.7-1).`, missing);
      states.push({ url, state: 'NOT_TESTABLE' });
      return;
    }
    b.metric('indexability_state', state).metric('render_dependent', renderDependent);
    const sEv = ev({ kind: 'computed', source_url: url, fetch_profile: 'NONE', selector_or_key: 'indexability_state', observed_value: `${state}${chain.length ? ` (chain: ${chain.join(' → ')})` : ''}`, expected_value: 'INDEXABLE' });
    b.addEvidence(sEv);
    const sel = ctx.sample.pages.find((s) => s.url === page.url);
    if (sel) sel.indexability_state = state;
    states.push({ url, state, isHomepage: page.isHomepage });

    switch (state) {
      case 'CONFLICTED':
        b.hit('C-1.7-i', { summary: `Signals disagree so the outcome is unpredictable (${chain.join(', ') || 'RAW/RENDERED directive mismatch'}). Remediate in order: unblock the crawl first, let noindex be seen, then remove it (E-1.7-5).`, evidence: [sEv], cross_references: ['C-1.1', 'C-1.6'] });
        break;
      case 'BLOCKED_ROBOTS':
        b.hit('C-1.7-b', { summary: 'Disallowed for Googlebot in robots.txt.', evidence: [sEv], cross_references: ['C-1.1'] });
        break;
      case 'NON_200':
        b.hit('C-1.7-d', { summary: `Final HTTP status ${status ?? 'none'} (must be 200).`, evidence: [sEv], cross_references: ['C-1.3'] });
        break;
      case 'NOINDEX':
        b.hit('C-1.7-c', { summary: 'Effective noindex for Googlebot.', evidence: [sEv], cross_references: ['C-1.6'] });
        break;
      case 'CANONICALISED_AWAY': {
        const byDesign = /[?&]/.test(url) || isPaginated(url);
        if (byDesign) b.hit('C-1.7-g', { summary: `Canonicalised to ${canon.target} by design (parameter/facet URL).`, evidence: [sEv] });
        else b.hit('C-1.7-f', { summary: `Canonicalised away to ${canon.target} on a page that should rank in its own right.`, evidence: [sEv], cross_references: ['C-1.5'] });
        break;
      }
      case 'SOFT_404':
        b.hit('C-1.7-e', { summary: 'Detected as a soft 404 (C-1.3-f).', evidence: [sEv], cross_references: ['C-1.3'] });
        break;
      case 'NO_CONTENT':
        b.hit('C-1.7-h', { summary: 'No content in RAW or RENDERED.', evidence: [sEv] });
        break;
      default:
        if (renderDependent) {
          b.hit('C-1.7-j', { summary: `Indexable, but main content exists only after rendering (RAW ${rawWords} words vs RENDERED ${renWords}); indexing is contingent on successful rendering.`, evidence: [sEv], cross_references: ['C-5.2'] });
        } else {
          if (renderDependent === null) b.caveat('render_dependent NOT_TESTABLE — no RENDERED profile for this page (B-1.7-3).');
          b.pass('All six R-1.7-1 conditions hold: crawlable, HTTP 200, no noindex, canonical SELF/ABSENT/healthy, not a soft 404, content present.');
        }
    }
    if (page.isHomepage && state !== 'INDEXABLE' && state !== 'CANONICALISED_AWAY') {
      b.hit('C-1.7-l', { summary: `Homepage is not indexable (${state}). Run-level headline (F-1.7-3).`, evidence: [sEv] });
    }
  });

  // R-1.7-7 — site-level ratio
  try {
    const evaluated = states.filter((s) => s.state !== 'NOT_TESTABLE');
    const b = new ResultBuilder(ctx, 'C-1.7', { scope: 'site', target_url: ctx.canonicalOrigin });
    b.caveat(GSC_CAVEAT);
    if (evaluated.length < 2) {
      b.notApplicable('INSUFFICIENT_SAMPLE', 'Site-level indexable ratio needs ≥ 2 evaluated pages.');
    } else {
      const ok = evaluated.filter((s) => s.state === 'INDEXABLE' || s.state === 'CANONICALISED_AWAY').length;
      const ratio = ok / evaluated.length;
      b.metric('indexable_ratio', Number(ratio.toFixed(3)));
      b.caveat(`Computed over ${evaluated.length} sampled pages; not representative of the full site.`);
      const rEv = ev({ kind: 'computed', source_url: ctx.canonicalOrigin, selector_or_key: 'indexable_sampled / total_sampled', observed_value: `${ok}/${evaluated.length}`, expected_value: '≥ 70%' });
      if (ratio < 0.7) b.hit('C-1.7-m', { summary: `Only ${Math.round(ratio * 100)}% of sampled pages are indexable.`, evidence: [rEv] });
      else {
        b.addEvidence(rEv);
        b.pass(`${ok} of ${evaluated.length} sampled pages are indexable (${Math.round(ratio * 100)}%).`);
      }
    }
    results.push(b.build());
  } catch (e) {
    results.push(errorResult(ctx, 'C-1.7', e));
  }
  return results;
}
