// C-4.1 — Core Web Vitals (page + origin). Field data from CrUX/PSI is the assessment; lab is
// diagnostic only and never occupies a pass/fail position (F-4.1-1). Form factors never blended.
import { ResultBuilder, ev, errorResult } from '../engine/result.js';

const CRUX_URL = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';
const PSI_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const FORM_FACTORS = ['PHONE', 'DESKTOP'];

const FIELD_CAVEAT = 'Field data is a 28-day rolling aggregate of real users, updated daily, lagging roughly two days, and segmented by form factor. It is not a live measurement and does not reflect changes made this week.';
const LAB_CAVEAT = 'Lab data is a single synthetic run from one location on one simulated device. It does not determine whether a page passes Core Web Vitals and is diagnostic only.';
const NO_DATA_CAVEAT = 'A page or origin with insufficient traffic has no field data. That is an absence of data, not a performance failure.';

const METRICS = {
  largest_contentful_paint: { key: 'LCP', good: (c) => c.th.lcp_good_ms, poor: (c) => c.th.lcp_poor_ms, unit: 'ms' },
  interaction_to_next_paint: { key: 'INP', good: (c) => c.th.inp_good_ms, poor: (c) => c.th.inp_poor_ms, unit: 'ms' },
  cumulative_layout_shift: { key: 'CLS', good: (c) => c.th.cls_good, poor: (c) => c.th.cls_poor, unit: '' },
};

function band(cfg, metricId, p75) {
  const m = METRICS[metricId];
  if (p75 == null || !m) return null;
  const v = metricId === 'cumulative_layout_shift' ? Number(p75) : Number(p75);
  if (v <= m.good(cfg)) return 'GOOD';
  if (v <= m.poor(cfg)) return 'NEEDS_IMPROVEMENT';
  return 'POOR';
}

async function cruxQuery(ctx, body) {
  const key = ctx.cfg.keys.google_api_key;
  if (!key) return { error: 'NO_KEY' };
  ctx.derived.cwvCalls = (ctx.derived.cwvCalls || 0) + 1;
  if (ctx.derived.cwvCalls > ctx.cfg.cwv.max_calls) return { error: 'CAP' };
  try {
    const res = await fetch(`${CRUX_URL}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, metrics: ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift', 'first_contentful_paint', 'experimental_time_to_first_byte'] }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) return { notFound: true };
    if (res.status === 429) return { error: 'QUOTA' };
    if (res.status === 400 || res.status === 403) return { error: 'KEY_INVALID', detail: (await res.json().catch(() => ({})))?.error?.message };
    if (!res.ok) return { error: `HTTP_${res.status}` };
    const j = await res.json();
    return { record: j.record, urlNormalizationDetails: j.urlNormalizationDetails };
  } catch (e) {
    return { error: 'NETWORK', detail: e.message };
  }
}

// Lighthouse category ids, as the API expects them.
const PSI_CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo', 'agentic-browsing'];

async function psiQuery(ctx, url, strategy) {
  const key = ctx.cfg.keys.google_api_key;
  ctx.derived.cwvCalls = (ctx.derived.cwvCalls || 0) + 1;
  if (ctx.derived.cwvCalls > ctx.cfg.cwv.max_calls) return { error: 'CAP' };
  try {
    const q = new URL(PSI_URL);
    q.searchParams.set('url', url);
    q.searchParams.set('strategy', strategy);
    // One request, five categories. PSI sends only 'performance' unless the rest are named, and
    // the agentic-browsing set is the one that speaks to what this tool is for: it covers
    // llms.txt, the agent accessibility tree and WebMCP.
    for (const c of PSI_CATEGORIES) q.searchParams.append('category', c);
    if (key) q.searchParams.set('key', key);
    const res = await fetch(q, { signal: AbortSignal.timeout(ctx.cfg.cwv.psi_timeout_ms) });
    if (res.status === 429) return { error: 'QUOTA' };
    if (res.status === 400 || res.status === 403) {
      const body = await res.json().catch(() => ({}));
      return { error: 'KEY_INVALID', detail: body?.error?.message };
    }
    if (!res.ok) return { error: `HTTP_${res.status}` };
    return { data: await res.json() };
  } catch (e) {
    return { error: e.name === 'TimeoutError' ? 'PSI_TIMEOUT' : 'NETWORK', detail: e.message };
  }
}

// PSI reports CLS as an integer hundredth (9 ⇒ 0.09); every other metric is already in ms.
const PSI_METRICS = {
  LARGEST_CONTENTFUL_PAINT_MS: { key: 'LCP', id: 'largest_contentful_paint', scale: 1 },
  INTERACTION_TO_NEXT_PAINT: { key: 'INP', id: 'interaction_to_next_paint', scale: 1 },
  CUMULATIVE_LAYOUT_SHIFT_SCORE: { key: 'CLS', id: 'cumulative_layout_shift', scale: 0.01 },
};

/** Read a PSI loadingExperience / originLoadingExperience block into the same shape as CrUX. */
function readPsiExperience(cfg, exp) {
  if (!exp || !exp.metrics || exp.overall_category === 'NONE') return null;
  const out = { metrics: {}, collectionPeriod: null, key: exp.id || null, supporting: {} };
  for (const [psiName, meta] of Object.entries(PSI_METRICS)) {
    const m = exp.metrics[psiName];
    if (!m || m.percentile == null) {
      out.metrics[meta.key] = { p75: null, band: null, densities: null, no_data: true };
      continue;
    }
    const p75 = Number((m.percentile * meta.scale).toFixed(meta.scale === 1 ? 0 : 2));
    const d = m.distributions || [];
    out.metrics[meta.key] = {
      p75,
      band: band(cfg, meta.id, p75),
      densities: { good: d[0]?.proportion ?? null, needs_improvement: d[1]?.proportion ?? null, poor: d[2]?.proportion ?? null },
    };
  }
  const fcp = exp.metrics.FIRST_CONTENTFUL_PAINT_MS?.percentile;
  const ttfb = exp.metrics.EXPERIMENTAL_TIME_TO_FIRST_BYTE?.percentile;
  out.supporting = { FCP: fcp ?? null, TTFB: ttfb ?? null };
  return out;
}

/** R-4.1-9 — lab audits are extracted for diagnosis only and never occupy a pass/fail position. */
function readLab(data) {
  const lh = data?.lighthouseResult;
  if (!lh) return null;
  const a = lh.audits || {};
  const num = (id) => (a[id]?.numericValue != null ? Math.round(a[id].numericValue) : null);
  const lcpEl = a['largest-contentful-paint-element']?.details?.items?.[0]?.items?.[0]?.node?.snippet
    || a['largest-contentful-paint-element']?.details?.items?.[0]?.node?.snippet || null;
  // Category scores, 0-100, exactly as PageSpeed Insights presents them. Lab only: they describe
  // one synthetic run and are never scored into this audit.
  const cats = lh.categories || {};
  const categoryScore = (id) => (cats[id]?.score == null ? null : Math.round(cats[id].score * 100));

  // Agentic browsing is reported as a count rather than a percentage, because most of its checks
  // are not applicable to most sites — a page with no WebMCP integration is not failing those
  // checks, it simply has nothing for them to look at. Counting passes against applicable checks
  // is what PSI shows, and it is the honest reading.
  const agentic = (() => {
    const cat = cats['agentic-browsing'];
    if (!cat) return null;
    const audits = [];
    for (const ref of cat.auditRefs || []) {
      const audit = a[ref.id];
      if (!audit) continue;
      const applicable = audit.scoreDisplayMode !== 'notApplicable';
      audits.push({
        id: ref.id,
        title: audit.title || ref.id,
        applicable,
        passed: applicable ? audit.score === 1 : null,
        display_value: audit.displayValue || null,
      });
    }
    const applicable = audits.filter((x) => x.applicable);
    return {
      score: categoryScore('agentic-browsing'),
      passed: applicable.filter((x) => x.passed).length,
      applicable: applicable.length,
      not_applicable: audits.length - applicable.length,
      audits,
    };
  })();

  return {
    category_scores_lab_only: {
      performance: categoryScore('performance'),
      accessibility: categoryScore('accessibility'),
      best_practices: categoryScore('best-practices'),
      seo: categoryScore('seo'),
    },
    agentic_browsing: agentic,
    performance_score_lab_only: lh.categories?.performance?.score ?? null,
    lcp_ms: num('largest-contentful-paint'),
    total_blocking_time_ms: num('total-blocking-time'),
    cls: a['cumulative-layout-shift']?.numericValue ?? null,
    speed_index_ms: num('speed-index'),
    lcp_element: lcpEl,
    render_blocking: (a['render-blocking-resources']?.details?.items || a['render-blocking-insight']?.details?.items || []).slice(0, 5).map((i) => i.url || i.label).filter(Boolean),
    unsized_images: (a['unsized-images']?.details?.items || []).slice(0, 5).map((i) => i.url).filter(Boolean),
    long_tasks: (a['long-tasks']?.details?.items || []).length,
    third_party_kb: a['third-party-summary']?.details?.items ? Math.round((a['third-party-summary'].details.items.reduce((s, i) => s + (i.transferSize || 0), 0)) / 1024) : null,
    lighthouse_version: lh.lighthouseVersion || null,
    fetch_time: lh.fetchTime || null,
  };
}

function readRecord(cfg, record) {
  const out = { metrics: {}, collectionPeriod: record?.collectionPeriod || null, key: record?.key || null };
  for (const [id, meta] of Object.entries(METRICS)) {
    const m = record?.metrics?.[id];
    if (!m) {
      out.metrics[meta.key] = { p75: null, band: null, densities: null, no_data: true };
      continue;
    }
    const p75 = m.percentiles?.p75;
    const num = typeof p75 === 'string' ? Number(p75) : p75;
    const h = m.histogram || [];
    out.metrics[meta.key] = {
      p75: num ?? null,
      band: band(cfg, id, num),
      densities: { good: h[0]?.density ?? null, needs_improvement: h[1]?.density ?? null, poor: h[2]?.density ?? null },
    };
  }
  const extra = record?.metrics || {};
  out.supporting = {
    FCP: extra.first_contentful_paint?.percentiles?.p75 ?? null,
    TTFB: extra.experimental_time_to_first_byte?.percentiles?.p75 ?? null,
  };
  out.navigation_types = record?.metrics?.navigation_types || null;
  return out;
}

function periodText(cp) {
  if (!cp) return null;
  const f = (d) => (d ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : '?');
  return `${f(cp.firstDate)} → ${f(cp.lastDate)}`;
}

function daysSince(cp) {
  if (!cp?.lastDate) return null;
  const d = new Date(Date.UTC(cp.lastDate.year, cp.lastDate.month - 1, cp.lastDate.day));
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

/**
 * R-4.1-2 data ladder, stopping at the first rung that returns data and recording which one did.
 *   1 CrUX URL-level → 2 CrUX origin-level → 3 PSI (same CrUX field data + lab) → 4 local Lighthouse
 * B-4.1-2: when CrUX is unavailable entirely, PSI carries the identical field data in one call, so
 * the ladder falls straight to it rather than reporting an absence the site is not responsible for.
 */
async function fieldDataFor(ctx, { url, origin, formFactor }) {
  const { cfg } = ctx;
  const strategy = formFactor === 'PHONE' ? 'mobile' : 'desktop';

  if (cfg.cap.crux_api && ctx.derived.cruxUsable !== false) {
    const body = url ? { url, formFactor } : { origin, formFactor };
    const r = await cruxQuery(ctx, body);
    if (r.record) return { ...readRecord(cfg, r.record), rung: url ? 'CRUX_URL' : 'CRUX_ORIGIN', normalization: r.urlNormalizationDetails || null };
    if (r.error === 'KEY_INVALID' || r.error === 'NO_KEY') {
      // The CrUX API is not enabled or the key is rejected: stop trying it for the rest of the run.
      ctx.derived.cruxUsable = false;
      ctx.derived.cruxDisabledReason = r.detail || r.error;
    } else if (r.error === 'QUOTA' || r.error === 'CAP') {
      return { error: r.error, rung: null };
    } else if (r.notFound && url) {
      return { notFound: true, rung: null }; // C-4.1-h — expected for low-traffic URLs, not an error
    } else if (r.notFound) {
      return { notFound: true, rung: null };
    }
  }

  if (!cfg.cap.psi_api || !cfg.keys.google_api_key) return { error: 'NO_KEY', rung: null };
  const target = url || origin;
  const cacheKey = `${target}|${strategy}`;
  ctx.derived.psiCache ||= new Map();
  if (!ctx.derived.psiCache.has(cacheKey)) ctx.derived.psiCache.set(cacheKey, psiQuery(ctx, target, strategy));
  const psi = await ctx.derived.psiCache.get(cacheKey);
  if (psi.error) return { error: psi.error, detail: psi.detail, rung: null };

  const lab = readLab(psi.data);
  const urlField = readPsiExperience(cfg, psi.data.loadingExperience);
  const originField = readPsiExperience(cfg, psi.data.originLoadingExperience);
  // A PSI response carries both scopes; cache the origin half so origin queries cost no extra call.
  if (originField) {
    ctx.derived.psiOrigin ||= {};
    ctx.derived.psiOrigin[formFactor] ||= { ...originField, rung: 'PSI_ORIGIN', lab };
  }
  if (url) {
    if (urlField) return { ...urlField, rung: 'PSI_URL', lab };
    if (originField) return { ...originField, rung: 'PSI_ORIGIN', lab };
    return { notFound: true, rung: null, lab }; // no field data at any level; lab is diagnostics only
  }
  if (originField) return { ...originField, rung: 'PSI_ORIGIN', lab };
  return { notFound: true, rung: null, lab };
}

export async function run(ctx) {
  const results = [];
  const { cfg } = ctx;
  const haveKey = !!cfg.keys.google_api_key;

  // ── Origin-level assessment (R-4.1-13: the site verdict is origin field data) ──
  try {
    const b = new ResultBuilder(ctx, 'C-4.1', { scope: 'origin', target_url: ctx.canonicalOrigin });
    b.setConfidence('THIRD_PARTY');
    b.caveat(FIELD_CAVEAT).caveat(NO_DATA_CAVEAT);
    b.metric('threshold_set', { LCP: `≤ ${cfg.th.lcp_good_ms} ms good, > ${cfg.th.lcp_poor_ms} ms poor`, INP: `≤ ${cfg.th.inp_good_ms} ms good, > ${cfg.th.inp_poor_ms} ms poor`, CLS: `≤ ${cfg.th.cls_good} good, > ${cfg.th.cls_poor} poor`, percentile: cfg.th.cwv_percentile });
    if (!haveKey || (!cfg.cap.crux_api && !cfg.cap.psi_api)) {
      b.notTestable('CWV_NO_API_KEY', 'No Google API key configured, so neither CrUX nor PageSpeed Insights could be queried. This is a tool-configuration gap, not a site defect (F-NEVER-5). Set GOOGLE_API_KEY to enable Core Web Vitals.');
      b.addEvidence(ev({ kind: 'computed', source_url: ctx.canonicalOrigin, selector_or_key: 'cap.crux_api / cap.psi_api / keys.google_api_key', observed_value: haveKey ? 'both CWV capabilities disabled' : 'no API key configured' }));
      results.push(b.build());
      return results.concat(await pageLevel(ctx, { noKey: true }));
    }
    // The origin verdict is the origin-level field assessment, never an average of page verdicts.
    const perFF = {};
    for (const ff of FORM_FACTORS) perFF[ff] = await fieldDataFor(ctx, { origin: ctx.canonicalOrigin, formFactor: ff });
    assess(ctx, b, perFF, { scopeLabel: 'origin', url: ctx.canonicalOrigin });
    ctx.derived.originCwv = perFF;
    results.push(b.build());
  } catch (e) {
    results.push(errorResult(ctx, 'C-4.1', e, ctx.canonicalOrigin));
  }

  results.push(...(await pageLevel(ctx, {})));
  return results;
}

async function pageLevel(ctx, { noKey }) {
  const { cfg } = ctx;
  // R-4.1-10 priority: origin (done) → homepage → remaining pages in page_type rank order.
  const ordered = [...ctx.pages].sort((a, b) => (a.isHomepage ? -1 : b.isHomepage ? 1 : 0));
  // A PSI call runs a real Lighthouse pass and takes tens of seconds, so pages are fetched through
  // a small pool rather than serially. The pool stays far below the documented per-minute quotas
  // (CrUX 150/min, PSI 240/min) and the cwv.max_calls budget still bounds the total (F-4.1-5).
  const pool = Math.max(1, cfg.cwv.concurrency || 1);
  const out = new Array(ordered.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(pool, ordered.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= ordered.length) return;
        out[i] = await pageResult(ctx, ordered[i], { noKey });
      }
    }),
  );
  return out.filter(Boolean);
}

async function pageResult(ctx, page, { noKey }) {
  const { cfg } = ctx;
  const b = new ResultBuilder(ctx, 'C-4.1', { scope: 'page', target_url: page.finalUrl, page_type: page.page_type });
  try {
    b.setConfidence('THIRD_PARTY');
    b.caveat(FIELD_CAVEAT).caveat(NO_DATA_CAVEAT);
    if (page.not_responding) {
      b.notTestable('PAGE_NOT_RESPONDING', 'Page did not respond; Core Web Vitals not queried.');
      return b.build();
    }
    if (!page.is_html) {
      b.notApplicable('CWV_NO_DATA', 'Core Web Vitals do not apply to a non-HTML resource (E-4.1-11).');
      return b.build();
    }
    if (noKey) {
      b.notTestable('CWV_NO_API_KEY', 'No Google API key configured; CrUX and PageSpeed Insights were not queried.');
      b.addEvidence(ev({ kind: 'computed', source_url: page.finalUrl, selector_or_key: 'keys.google_api_key', observed_value: 'not configured' }));
      return b.build();
    }
    if ((ctx.derived.cwvCalls || 0) >= cfg.cwv.max_calls) {
      b.notTestable('CWV_QUOTA_EXHAUSTED', `Call budget of ${cfg.cwv.max_calls} reached; the origin and homepage were prioritised (B-4.1-5).`);
      b.addEvidence(ev({ kind: 'computed', source_url: page.finalUrl, selector_or_key: 'cwv.max_calls', observed_value: String(ctx.derived.cwvCalls) }));
      return b.build();
    }
    // R-4.1-5: always query the page's final URL — CrUX normalises and does not follow redirects.
    const target = page.finalUrl;
    const perFF = {};
    let normalised = null;
    for (const ff of FORM_FACTORS) {
      const d = await fieldDataFor(ctx, { url: target, formFactor: ff });
      if (d.normalization) normalised = d.normalization;
      if (d.rung) {
        perFF[ff] = d;
        continue;
      }
      // B-4.1-1 — no URL-level record: fall to origin-level for that form factor, clearly labelled.
      const o = ctx.derived.originCwv?.[ff] || ctx.derived.psiOrigin?.[ff];
      perFF[ff] = o && o.rung && !o.error
        ? { ...o, rung: o.rung.endsWith('ORIGIN') ? o.rung : 'CRUX_ORIGIN', lab: d.lab || o.lab }
        : { error: d.error, notFound: d.notFound, rung: null, lab: d.lab };
    }
    if (normalised) b.note('CRUX_RECORD_NOT_FOUND', `CrUX normalised the queried URL to ${normalised.normalizedUrl || '(unspecified)'}; the data describes the normalised URL (E-4.1-3).`);
    assess(ctx, b, perFF, { scopeLabel: 'page', url: target });
    return b.build();
  } catch (e) {
    return errorResult(ctx, 'C-4.1', e, page.finalUrl);
  }
}


/** Apply the CONDITIONS table per form factor; overall = worse of the two (C-4.1-m). */
function assess(ctx, b, perFF, { scopeLabel, url }) {
  const { cfg } = ctx;
  const summaries = [];
  let anyField = false;
  let anyPoor = false;
  let anyNI = false;
  let originOnly = false;
  const ffStatus = {};

  for (const ff of FORM_FACTORS) {
    const d = perFF[ff];
    if (!d || d.error) {
      ffStatus[ff] = d?.error || 'NO_DATA';
      continue;
    }
    if (d.notFound) {
      ffStatus[ff] = 'NO_FIELD_DATA';
      continue;
    }
    anyField = true;
    const isOriginRung = d.rung === 'CRUX_ORIGIN' || d.rung === 'PSI_ORIGIN';
    if (isOriginRung) originOnly = true;
    const rungLabel = { CRUX_URL: 'CrUX URL-level field data', CRUX_ORIGIN: 'CrUX origin-level field data', PSI_URL: 'PageSpeed Insights URL-level field data (CrUX via PSI)', PSI_ORIGIN: 'PageSpeed Insights origin-level field data (CrUX via PSI)' }[d.rung] || d.rung;
    const rows = Object.entries(d.metrics).map(([k, m]) => `${k} ${m.p75 ?? 'no data'}${m.p75 != null && k !== 'CLS' ? ' ms' : ''}${m.band ? ` (${m.band})` : ''}`);
    summaries.push(`${ff}: ${rows.join(', ')}${d.collectionPeriod ? ` [${periodText(d.collectionPeriod)}]` : ''}`);
    const poor = Object.entries(d.metrics).filter(([, m]) => m.band === 'POOR');
    const ni = Object.entries(d.metrics).filter(([, m]) => m.band === 'NEEDS_IMPROVEMENT');
    ffStatus[ff] = poor.length ? 'FAIL' : ni.length ? 'WARN' : 'PASS';
    // R-4.1-11 / F-4.1-6: the collection period is reported on every field result. PSI does not
    // return one, so that is stated rather than silently omitted.
    const period = d.collectionPeriod ? periodText(d.collectionPeriod) : 'not supplied by this rung (PSI returns no collectionPeriod; the underlying window is CrUX\'s 28-day rolling aggregate)';
    const mEv = (name, m) => ev({ kind: 'api_payload', source_url: url, fetch_profile: 'NONE', selector_or_key: `${rungLabel} · ${ff} · ${name} p75`, observed_value: `p75=${m.p75}; good=${fmtD(m.densities?.good)}, needs-improvement=${fmtD(m.densities?.needs_improvement)}, poor=${fmtD(m.densities?.poor)}; collectionPeriod=${period}`, expected_value: name === 'LCP' ? `≤ ${cfg.th.lcp_good_ms} ms` : name === 'INP' ? `≤ ${cfg.th.inp_good_ms} ms` : `≤ ${cfg.th.cls_good}` });
    b.metric(`${ff}_rung`, d.rung);
    if (!d.collectionPeriod) b.caveat('Field data was supplied by PageSpeed Insights, which does not return the collection period; the window is CrUX\'s 28-day rolling aggregate but its exact dates are not reported by this rung.');
    for (const [name, m] of Object.entries(d.metrics)) if (m.p75 != null) b.addEvidence(mEv(name, m));

    const pageScoped = scopeLabel === 'page';
    if (poor.length) {
      anyPoor = true;
      if (isOriginRung && pageScoped) b.hit('C-4.1-e', { summary: `${ff}: no URL-level field data; the origin-level assessment fails (${poor.map(([k, m]) => `${k} p75 ${m.p75}`).join(', ')}). A page-specific verdict is unavailable.`, evidence: poor.map(([k, m]) => mEv(k, m)) });
      else b.hit('C-4.1-b', { summary: `${ff}: ${poor.map(([k, m]) => `${k} p75 ${m.p75}${k === 'CLS' ? '' : ' ms'} is in the Poor band`).join('; ')}.`, evidence: poor.map(([k, m]) => mEv(k, m)) });
    } else if (ni.length) {
      anyNI = true;
      if (isOriginRung && pageScoped) b.hit('C-4.1-e', { summary: `${ff}: origin-level field data only; ${ni.map(([k, m]) => `${k} p75 ${m.p75}`).join(', ')} needs improvement. A page-specific verdict is unavailable.`, evidence: ni.map(([k, m]) => mEv(k, m)) });
      else b.hit('C-4.1-c', { summary: `${ff}: ${ni.map(([k, m]) => `${k} p75 ${m.p75}${k === 'CLS' ? '' : ' ms'} needs improvement`).join('; ')}.`, evidence: ni.map(([k, m]) => mEv(k, m)) });
    } else if (isOriginRung && pageScoped) {
      b.hit('C-4.1-d', { summary: `${ff}: no URL-level field data; the origin-level assessment passes. This verdict describes the origin, not this page.`, evidence: Object.entries(d.metrics).filter(([, m]) => m.p75 != null).map(([k, m]) => mEv(k, m)) });
    }
    // R-4.1-9 — lab audits, recorded as diagnosis only and never in a pass/fail position (F-4.1-1).
    if (d.lab) {
      b.metric(`${ff}_lab_diagnostics_only`, d.lab);
      if (!ctx.derived.labNoted) {
        b.caveat(LAB_CAVEAT);
        ctx.derived.labNoted = true;
      }
    }
    // C-4.1-l long tail
    for (const [k, m] of Object.entries(d.metrics)) {
      if (m.band === 'GOOD' && m.densities?.poor != null && m.densities.poor > 0.25) b.hit('C-4.1-l', { summary: `${ff}: ${k} passes at p75 but ${Math.round(m.densities.poor * 100)}% of visits are in the Poor band.`, evidence: [mEv(k, m)] });
    }
    for (const [k, m] of Object.entries(d.metrics)) {
      if (m.no_data || m.p75 == null) b.note('CWV_NO_FIELD_DATA', `${ff}: ${k} has no field samples${k === 'INP' ? ' (very low interaction volume); the page is not failed for a metric with no samples (E-4.1-6)' : ''}.`);
    }
    const stale = d.collectionPeriod ? daysSince(d.collectionPeriod) : null;
    if (stale != null && stale > 5) b.hit('C-4.1-n', { summary: `${ff}: collection period ended ${stale} days before this run (${periodText(d.collectionPeriod)}).`, evidence: [ev({ kind: 'api_payload', source_url: url, selector_or_key: `${ff} · collectionPeriod`, observed_value: periodText(d.collectionPeriod) })] });
    b.metric(`${ff}_supporting_diagnostics_only`, d.supporting);
  }
  b.metric('form_factors', ffStatus).metric('field_data', perFF);

  if (!anyField) {
    const errs = [...new Set(Object.values(ffStatus))];
    const anyLab = FORM_FACTORS.some((ff) => perFF[ff]?.lab);
    if (anyLab) for (const ff of FORM_FACTORS) if (perFF[ff]?.lab) b.metric(`${ff}_lab_diagnostics_only`, perFF[ff].lab);
    if (errs.includes('QUOTA')) b.notTestable('CWV_QUOTA_EXHAUSTED', 'API quota exhausted (HTTP 429).');
    else if (errs.includes('KEY_INVALID') || errs.includes('NO_KEY')) b.notTestable('CWV_NO_API_KEY', `The configured Google API key was rejected${ctx.derived.cruxDisabledReason ? ` — ${String(ctx.derived.cruxDisabledReason).slice(0, 180)}` : ''}.`);
    else if (errs.includes('CAP')) b.notTestable('CWV_QUOTA_EXHAUSTED', `Call budget of ${ctx.cfg.cwv.max_calls} reached; origin and homepage were prioritised (B-4.1-5).`);
    else if (errs.includes('PSI_TIMEOUT')) b.notTestable('LAB_RUN_FAILED', 'PageSpeed Insights did not return within the timeout.');
    else if (anyLab) {
      b.notTestable('CWV_NO_FIELD_DATA', `No field data at any level for this ${scopeLabel}. Insufficient real-user traffic for field data — an absence of data, not a performance failure. Lab diagnostics only, which do not determine whether a page passes Core Web Vitals.`);
      b.caveat(LAB_CAVEAT);
    } else {
      b.notTestable('CWV_NO_DATA', `No field data and no lab data for this ${scopeLabel}.`);
      b.caveat(LAB_CAVEAT);
    }
    b.addEvidence(ev({ kind: 'api_payload', source_url: url, fetch_profile: 'NONE', selector_or_key: 'CWV data ladder outcome per form factor', observed_value: JSON.stringify(ffStatus) }));
    return;
  }
  if (Object.values(ffStatus).includes('FAIL') && Object.values(ffStatus).includes('PASS')) {
    b.note('CWV_FORM_FACTOR_DIVERGENCE', `Form factors diverge (${Object.entries(ffStatus).map(([k, v]) => `${k}=${v}`).join(', ')}); the overall verdict is the worse of the two.`);
  }
  if (!anyPoor && !anyNI) {
    const rungs = [...new Set(FORM_FACTORS.map((ff) => perFF[ff]?.rung).filter(Boolean))].join(', ');
    b.pass(`${summaries.join(' · ')} — all three Core Web Vitals in the Good band at p75 (${rungs}).`, originOnly ? 'CWV_ORIGIN_LEVEL_ONLY' : null);
  }
}

const fmtD = (d) => (d == null ? 'n/a' : `${Math.round(d * 100)}%`);
