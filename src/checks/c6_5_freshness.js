// C-6.5 — Content Freshness (page + site · deterministic, plus one optional currency check).
// F-6.5-1: never infer a date the page does not state. No archive lookups, no domain-age proxies.
import { ResultBuilder, ev, errorResult } from '../engine/result.js';
import { forEachPage, domEv } from './_util.js';
import { collapse, median } from '../parse/text.js';
import { MODELLED_CAVEAT, NON_DETERMINISTIC_CAVEAT } from '../llm/judge.js';

// R-6.5-8 — staleness thresholds apply only where recency carries meaning.
const DATE_SENSITIVE = new Set(['blog_article', 'blog_template_alt', 'pricing', 'product_main']);
const EVERGREEN = new Set(['about', 'author', 'service_main', 'service_secondary']);
const ARCHIVE_SIGNATURE = /\/(archive|archives)\/|\/(19|20)\d{2}\/(0?[1-9]|1[0-2])\//;
const LABELLED_DATE = /\b(published|posted|updated|last updated|revised|modified)\b[:\s]*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i;
const YEAR_IN_TITLE = /\b(19|20)\d{2}\b/;
const VERSION_RE = /\bv?\d+\.\d+(\.\d+)?\b/;

function parseDate(raw) {
  if (!raw) return null;
  const s = collapse(String(raw));
  // E-6.5-4 — locale-ambiguous numeric formats: record both readings, never pick one silently.
  const ambiguous = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s);
  if (ambiguous) {
    const [, a, b, y] = ambiguous.map(Number);
    if (a <= 12 && b <= 12 && a !== b) {
      const mdy = Date.UTC(y, a - 1, b);
      const dmy = Date.UTC(y, b - 1, a);
      return { value: new Date(Math.min(mdy, dmy)).toISOString(), ambiguous: true, interpretations: [new Date(mdy).toISOString().slice(0, 10), new Date(dmy).toISOString().slice(0, 10)], raw: s };
    }
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return { value: null, unparseable: true, raw: s };
  return { value: new Date(t).toISOString(), raw: s };
}

export async function run(ctx) {
  const ages = [];
  const buildTimestamps = [];
  const runStart = Date.parse(ctx.run.started_at);

  const results = await forEachPage(ctx, 'C-6.5', async (page, b) => {
    if (!page.is_html) return b.notApplicable('EVERGREEN_PAGE_TYPE', 'Non-HTML resource.');
    const f = page.rawFacts;
    const dateSensitive = DATE_SENSITIVE.has(page.page_type) || (!EVERGREEN.has(page.page_type) && hasDatedContent(f));

    // R-6.5-1 — four signal sources, kept separate and never merged.
    const schemaDates = ctx.derived.schema?.dates?.get(page.url) || {};
    const visible = visibleDates(page);
    const lastModified = page.raw.headers?.['last-modified'] || null;
    const ogUpdated = f.og['article:modified_time'] || f.og['og:updated_time'] || null;
    const signals = [
      { source: 'schema dateModified', raw: schemaDates.dateModified || null, kind: 'modified' },
      { source: 'schema datePublished', raw: schemaDates.datePublished || null, kind: 'published' },
      { source: 'visible dateModified', raw: visible.modified, kind: 'modified' },
      { source: 'visible datePublished', raw: visible.published, kind: 'published' },
      { source: 'Last-Modified header', raw: lastModified, kind: 'modified' },
      { source: 'og:updated_time / article:modified_time', raw: ogUpdated, kind: 'modified' },
    ]
      .filter((s) => s.raw)
      .map((s) => ({ ...s, parsed: parseDate(s.raw) }));
    b.metric('date_signals', signals.map((s) => ({ source: s.source, raw: s.raw, normalised: s.parsed?.value || null, ambiguous: !!s.parsed?.ambiguous })));
    b.metric('date_sensitive', dateSensitive).metric('page_type', page.page_type);

    // R-6.5-3 precedence
    const pick = (src) => signals.find((s) => s.source === src && s.parsed?.value);
    const chosen = pick('visible dateModified') || pick('schema dateModified') || pick('visible datePublished') || pick('schema datePublished') || pick('Last-Modified header') || pick('og:updated_time / article:modified_time');
    const ageDays = chosen ? Math.floor((Date.now() - Date.parse(chosen.parsed.value)) / 86400000) : null;
    b.metric('content_age_days', ageDays).metric('age_source', chosen?.source || null);
    const dEv = ev({ kind: 'computed', source_url: page.finalUrl, fetch_profile: 'RAW', selector_or_key: 'date signals (kept separate; precedence applied)', observed_value: signals.length ? signals.map((s) => `${s.source}="${s.raw}"${s.parsed?.value ? ` → ${s.parsed.value.slice(0, 10)}` : ' → unparseable'}`).join(' | ') : '(none)', expected_value: dateSensitive ? `≤ ${ctx.cfg.th.freshness_stale_days} days old` : null });
    b.addEvidence(dEv);

    if (!dateSensitive) {
      b.notApplicable('EVERGREEN_PAGE_TYPE', `page_type "${page.page_type}" is not date-sensitive: staleness thresholds are never applied to it (R-6.5-8, F-6.5-2).${chosen ? ` Date signal recorded for reference: ${chosen.parsed.value.slice(0, 10)} from ${chosen.source}.` : ''}`);
      return;
    }
    if (ageDays != null) ages.push(ageDays);

    // R-6.5-5 validity
    const unparseable = signals.filter((s) => s.parsed?.unparseable);
    if (unparseable.length) b.hit('C-6.5-e', { summary: `Unparseable date value(s): ${unparseable.map((s) => `${s.source}="${s.raw}"`).join('; ')}.`, evidence: [dEv] });
    const future = signals.filter((s) => s.parsed?.value && Date.parse(s.parsed.value) > Date.now() + 86400000);
    if (future.length) b.hit('C-6.5-d', { summary: `Date in the future: ${future.map((s) => `${s.source}="${s.raw}"`).join('; ')}.`, evidence: [dEv] });
    const pub = pick('schema datePublished') || pick('visible datePublished');
    const mod = pick('schema dateModified') || pick('visible dateModified');
    if (pub?.parsed?.value && mod?.parsed?.value && Date.parse(mod.parsed.value) < Date.parse(pub.parsed.value)) {
      b.hit('C-6.5-c', { summary: `dateModified (${mod.parsed.value.slice(0, 10)}) is earlier than datePublished (${pub.parsed.value.slice(0, 10)}).`, evidence: [dEv], cross_references: ['C-3.1'] });
    }
    const ambiguous = signals.filter((s) => s.parsed?.ambiguous);
    if (ambiguous.length) b.note('DATE_AMBIGUOUS', `Locale-ambiguous date format: "${ambiguous[0].raw}" reads as either ${ambiguous[0].parsed.interpretations.join(' or ')}. Both readings are recorded and the more conservative one is used for content_age_days (E-6.5-4).`);

    if (!signals.length) {
      b.hit('C-6.5-b', { summary: `No date signal from schema, visible text, the Last-Modified header or Open Graph on a date-sensitive ${page.page_type} page. No date is inferred from content, archives or domain age (F-6.5-1).`, evidence: [dEv] });
    }
    // R-6.5-6 visibility
    if (chosen && !visible.modified && !visible.published && /schema|header|og:/.test(chosen.source)) {
      b.note('DATE_NOT_USER_VISIBLE', `The date comes from ${chosen.source} and is not shown to a reader, which is a weaker signal than a visible one (R-6.5-6).`);
    }
    // R-6.5-4 build-timestamp candidate (confirmed at site level — F-6.5-4)
    const modDate = mod?.parsed?.value ? Date.parse(mod.parsed.value) : null;
    if (modDate && Math.abs(runStart - modDate) < 86400000) buildTimestamps.push(page.url);

    // Age bands
    if (ageDays != null) {
      const archive = ARCHIVE_SIGNATURE.test(page.finalUrl);
      if (ageDays > ctx.cfg.th.freshness_stale_days) {
        if (archive) b.note('CONTENT_STALE', `${ageDays} days old, but the URL matches an archive signature where old dates are the point (E-6.5-3).`);
        else b.hit('C-6.5-g', { summary: `Content is ${ageDays} days old (threshold ${ctx.cfg.th.freshness_stale_days} days) on a date-sensitive ${page.page_type} page, per ${chosen.source}.`, evidence: [dEv] });
      } else if (ageDays > ctx.cfg.th.freshness_warn_days) {
        b.hit('C-6.5-h', { summary: `Content is ${ageDays} days old (ageing threshold ${ctx.cfg.th.freshness_warn_days} days).`, evidence: [dEv] });
      }
    }
    // R-6.5-9 self-reported staleness
    const heading = f.headings.find((h) => h.level === 1)?.text || '';
    const title = f.titles[0]?.text || '';
    const years = [...`${title} ${heading}`.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
    const thisYear = new Date().getFullYear();
    const staleYear = years.find((y) => thisYear - y >= 2);
    if (staleYear) {
      b.hit('C-6.5-i', { summary: `The title or H1 contains the year ${staleYear}, ${thisYear - staleYear} years old — the page self-reports its own staleness regardless of its metadata.`, evidence: [domEv(page, 'RAW', 'title / h1', `${title} | ${heading}`)] });
    }
    const copyright = /©\s*(\d{4})|copyright\s+(\d{4})/i.exec(f.bodyText);
    const copyYear = copyright ? Number(copyright[1] || copyright[2]) : null;
    if (copyYear && thisYear - copyYear >= 2) b.note('SELF_REPORTED_STALENESS', `Copyright year ${copyYear} in the page footer is ${thisYear - copyYear} years old.`);
    const version = VERSION_RE.exec(`${title} ${heading}`);
    if (version) b.metric('version_reference', version[0]);

    // R-6.5-10 currency check (LLM, deliberately shallow)
    if (!ctx.llm.enabled) {
      b.note('RUBRIC_DISABLED', `The content-currency check did not run: ${ctx.llm.disabledReason}. Every deterministic date finding above still stands (C-6.5-m).`);
      return;
    }
    if (ctx.llm.budgetLeftFor('C-6.5') <= 0) {
      b.note('RUBRIC_DISABLED', "This check's share of the LLM call budget is spent; the currency check did not run for this page.");
      return;
    }
    const text = ctx.derived.extraction?.get(page.url)?.main || f.mainText;
    const res = await ctx.llm.currencyCheck({ page: { url: page.finalUrl, page_type: page.page_type, text }, checkId: 'C-6.5' });
    if (!res.ok) {
      b.note(res.reason, `Currency check did not run: ${res.detail}.`);
      return;
    }
    b.metric('currency_claims_discarded', res.discarded);
    if (res.claims.length) {
      b.setConfidence('MODELLED', MODELLED_CAVEAT);
      b.caveat(NON_DETERMINISTIC_CAVEAT);
      b.hit('C-6.5-l', {
        summary: `${res.claims.length} claim(s) on the page are contradicted by more recent, widely-established information. This is an initial-audit signal, not fact-checking, and it does not change content_age_days or any date-derived finding (F-6.5-7).`,
        evidence: res.claims.map((c) => ev({ kind: 'computed', source_url: page.finalUrl, fetch_profile: 'NONE', selector_or_key: 'contradicted claim (verbatim quote → correction → reference)', observed_value: `"${c.quote}" → ${c.correction} → ${c.reference_url}` })),
      });
    }
  });

  // ── Site-level distribution (R-6.5-7) and build-timestamp pattern (R-6.5-4) ──
  try {
    const b = new ResultBuilder(ctx, 'C-6.5', { scope: 'site', target_url: ctx.canonicalOrigin });
    const dateSensitivePages = ctx.pages.filter((p) => DATE_SENSITIVE.has(p.page_type) || (!EVERGREEN.has(p.page_type) && p.rawFacts && hasDatedContent(p.rawFacts)));
    if (!ages.length) {
      b.notApplicable('EVERGREEN_PAGE_TYPE', dateSensitivePages.length ? 'No date signal on any date-sensitive sampled page, so no distribution can be computed.' : 'No date-sensitive page types in the sample.');
      b.addEvidence(ev({ kind: 'computed', source_url: ctx.canonicalOrigin, selector_or_key: 'date-sensitive pages sampled', observed_value: String(dateSensitivePages.length) }));
    } else {
      const med = median(ages);
      const stale = ages.filter((a) => a > ctx.cfg.th.freshness_stale_days).length;
      b.metric('age_distribution_days', ages.sort((x, y) => x - y)).metric('median_age_days', med).metric('pages_over_stale_threshold', stale).metric('date_sensitive_pages', dateSensitivePages.length);
      const aEv = ev({ kind: 'computed', source_url: ctx.canonicalOrigin, selector_or_key: 'content_age_days across date-sensitive sampled pages', observed_value: `n=${ages.length}, median ${med} days, ${stale} over ${ctx.cfg.th.freshness_stale_days} days`, expected_value: `median ≤ ${ctx.cfg.th.freshness_stale_days} days` });
      b.addEvidence(aEv);
      b.caveat(`Computed over ${ages.length} date-sensitive sampled page(s); not representative of the full site.`);
      if (med > ctx.cfg.th.freshness_stale_days) b.hit('C-6.5-j', { summary: `Median content age across date-sensitive sampled pages is ${med} days, beyond the ${ctx.cfg.th.freshness_stale_days}-day threshold.`, evidence: [aEv] });
      // F-6.5-4: the build-timestamp pattern requires a majority of the sample.
      if (buildTimestamps.length > dateSensitivePages.length / 2 && buildTimestamps.length >= 2) {
        b.hit('C-6.5-f', { summary: `dateModified equals or is within 24 hours of the crawl date on ${buildTimestamps.length} of ${dateSensitivePages.length} date-sensitive pages: the freshness signal is a build timestamp and carries no information. Real editorial updates do not cluster on the crawl date.`, evidence: buildTimestamps.slice(0, 5).map((u) => ev({ kind: 'computed', source_url: u, selector_or_key: 'dateModified vs run date', observed_value: 'within 24 hours of the crawl' })) });
      }
      if (!b.hits.length) b.pass(`Median content age ${med} days across ${ages.length} date-sensitive page(s); ${stale} beyond the staleness threshold.`);
    }
    results.push(b.build());
  } catch (e) {
    results.push(errorResult(ctx, 'C-6.5', e, ctx.canonicalOrigin));
  }
  return results;
}

function visibleDates(page) {
  const f = page.rawFacts;
  const out = { published: null, modified: null };
  for (const t of f.timeEls) {
    const label = `${t.itemprop || ''}`.toLowerCase();
    const val = t.datetime || t.text;
    if (!val) continue;
    if (/modif|updat/.test(label)) out.modified ||= val;
    else if (/publish|date/.test(label)) out.published ||= val;
    else out.published ||= val;
  }
  const text = page.rendered?.dom?.visibleText || f.bodyText;
  const m = LABELLED_DATE.exec(text);
  if (m) {
    if (/updat|revis|modif/i.test(m[1])) out.modified ||= m[2];
    else out.published ||= m[2];
  }
  return out;
}

function hasDatedContent(f) {
  const t = `${f.titles[0]?.text || ''} ${f.headings.map((h) => h.text).join(' ')}`;
  return YEAR_IN_TITLE.test(t) || VERSION_RE.test(t);
}
