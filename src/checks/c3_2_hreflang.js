// C-3.2 — Hreflang (site + page · RAW + headers). Evaluated only for multilingual sites (R-3.2-1).
// Four conditions are detected here but reported and scored under Section 1 (R-3.2-15).
import { ResultBuilder, ev, errorResult } from '../engine/result.js';
import { normalizeUrl } from '../parse/url.js';
import { bodyText } from '../net/http.js';
import { extractFacts } from '../parse/html.js';
import { forEachPage, hasRendered, domEv } from './_util.js';

const STANDING = 'Hreflang findings reflect HTML <head> and HTTP Link header annotations only.';
// Routed to Section 1 — Crawl & Indexing (R-3.2-15).
const SECTION1_ROUTED = new Set(['C-3.2-d', 'C-3.2-i', 'C-3.2-k', 'C-3.2-l']);

const ISO639_1 = new Set(('aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu').split(' '));
const ISO3166 = /^[A-Z]{2}$/;
const SCRIPTS = new Set(['Latn', 'Cyrl', 'Hans', 'Hant', 'Arab', 'Hebr', 'Grek', 'Jpan', 'Kore', 'Deva', 'Thai', 'Armn', 'Geor']);
const INVALID_REGIONS = new Set(['UK', 'EU', 'UN']);

/** R-3.2-4 value validation, accepting BCP-47 script subtags (E-3.2-10, F-3.2-5). */
export function validateCode(value) {
  const v = String(value || '').trim();
  if (!v) return { valid: false, reason: 'empty' };
  if (v.toLowerCase() === 'x-default') return { valid: true, xDefault: true, lang: null, region: null };
  const parts = v.split('-');
  const lang = parts[0].toLowerCase();
  if (!ISO639_1.has(lang)) {
    // A bare two-letter code that is a valid region but not a language is the region-only error
    // (hreflang="us"), which C-3.2-g reports separately from a plain invalid code (C-3.2-f).
    if (parts.length === 1 && ISO3166.test(parts[0].toUpperCase())) return { valid: false, regionOnly: true, reason: `"${v}" is a region code without a language` };
    if (/^[a-z]{3}$/i.test(parts[0])) return { valid: false, reason: `3-letter code "${parts[0]}" — use the ISO 639-1 2-letter code where one exists` };
    return { valid: false, reason: `"${parts[0]}" is not a valid ISO 639-1 language code` };
  }
  let region = null;
  let script = null;
  for (const p of parts.slice(1)) {
    if (p.length === 4 && SCRIPTS.has(p[0].toUpperCase() + p.slice(1).toLowerCase())) script = p;
    else if (/^[a-z]{2}$/i.test(p)) {
      const R = p.toUpperCase();
      if (INVALID_REGIONS.has(R)) return { valid: false, reason: `"${R}" is not a valid ISO 3166-1 Alpha-2 region${R === 'UK' ? ' (the region code is GB)' : ''}` };
      if (!ISO3166.test(R)) return { valid: false, reason: `"${p}" is not a valid region code` };
      region = R;
    } else return { valid: false, reason: `subtag "${p}" is not a valid region or script` };
  }
  return { valid: true, lang, region, script, xDefault: false };
}

/** Parse Link: <url>; rel="alternate"; hreflang="xx" response headers (R-3.2-2 #2). */
export function parseLinkHreflang(headers) {
  const v = headers?.link;
  if (!v) return [];
  const out = [];
  for (const part of String(v).split(/,(?=\s*<)/)) {
    const m = /<([^>]+)>\s*;(.*)$/.exec(part.trim());
    if (!m) continue;
    const params = m[2];
    if (!/rel\s*=\s*"?[^";]*\balternate\b/i.test(params)) continue;
    const hl = /hreflang\s*=\s*"?([^";\s]+)"?/i.exec(params);
    if (hl) out.push({ hreflang: hl[1], href: m[1] });
  }
  return out;
}

function annotationsOf(page) {
  const html = (page.rawFacts?.hreflang || []).map((a) => ({ ...a, mechanism: 'html' }));
  const header = parseLinkHreflang(page.raw?.headers).map((a) => ({ ...a, mechanism: 'header', in_head: true }));
  return { html, header, all: [...html, ...header] };
}

export async function run(ctx) {
  // R-3.2-1 applicability gate, evaluated first and auditable.
  const signals = ctx.target.multilingual_signals || [];
  const pageSignals = [];
  const langs = new Set();
  for (const p of ctx.pages) {
    if (p.rawFacts?.hreflang.length) pageSignals.push(`hreflang in <head> on ${p.finalUrl}`);
    if (parseLinkHreflang(p.raw?.headers).length) pageSignals.push(`Link header hreflang on ${p.finalUrl}`);
    if (p.rawFacts?.htmlLang) langs.add(String(p.rawFacts.htmlLang).toLowerCase().split('-')[0]);
  }
  if (langs.size >= 2) pageSignals.push(`≥ 2 distinct <html lang> values across sampled pages: ${[...langs].join(', ')}`);
  const prefixes = ctx.derived.langPrefixes || [];
  if (prefixes.length >= 2) pageSignals.push(`language-coded path prefixes observed in discovery: ${prefixes.join(', ')}`);
  const allSignals = [...new Set([...signals, ...pageSignals])];
  const isMultilingual = allSignals.length > 0;
  ctx.target.is_multilingual = isMultilingual;
  ctx.target.multilingual_signals = allSignals;

  if (!isMultilingual) {
    const b = new ResultBuilder(ctx, 'C-3.2', { scope: 'site', target_url: ctx.canonicalOrigin });
    b.metric('signals_evaluated', ['rel=alternate hreflang in head', 'Link: rel=alternate hreflang header', '≥ 2 distinct html lang values', '≥ 2 language-coded path prefixes'])
      .metric('signals_fired', []);
    b.notApplicable('MONOLINGUAL_SITE', 'Monolingual site — hreflang is ignored per the checklist (R-3.2-1). All four detection signals were evaluated and returned negative.');
    return [b.build()];
  }

  // B-3.2-3 advisory mode: exactly one weak signal (a language prefix) and no annotations anywhere.
  const hasAnnotations = ctx.pages.some((p) => annotationsOf(p).all.length);
  const advisory = !hasAnnotations && allSignals.length === 1 && /path prefixes|html lang/.test(allSignals[0]);

  // ── Cluster assembly (R-3.2-13) ────────────────────────────────────────
  const clusters = new Map(); // key → { members: Map(url → {codes, mechanism}), codes }
  const pageAnn = new Map();
  for (const page of ctx.pages) {
    const ann = annotationsOf(page);
    pageAnn.set(page.url, ann);
  }
  const alternateCache = new Map();
  let fetched = 0;
  const fetchAlternate = async (url) => {
    if (alternateCache.has(url)) return alternateCache.get(url);
    if (fetched >= ctx.cfg.hreflang.max_alternates) {
      alternateCache.set(url, { capped: true });
      return alternateCache.get(url);
    }
    fetched++;
    const known = ctx.pages.find((p) => p.finalUrl === url || p.url === url);
    let entry;
    if (known && known.rawFacts) {
      entry = { rec: known.raw, facts: known.rawFacts, annotations: annotationsOf(known).all };
    } else {
      const rec = await ctx.http.fetch(url, { budgetClass: 'secondary' });
      const facts = rec.status >= 200 && rec.status < 300 ? extractFacts(bodyText(rec), rec.final_url, ctx.canonicalOrigin) : null;
      entry = {
        rec,
        facts,
        annotations: facts ? [...facts.hreflang.map((a) => ({ ...a, mechanism: 'html' })), ...parseLinkHreflang(rec.headers).map((a) => ({ ...a, mechanism: 'header' }))] : [],
      };
    }
    entry.noindex = entry.facts ? entry.facts.metaRobots.some((m) => ['robots', 'googlebot'].includes(m.name) && /noindex|none/i.test(m.content)) || /noindex/i.test(String(entry.rec.headers?.['x-robots-tag'] || '')) : false;
    entry.canonical = entry.facts?.canonicals.find((c) => c.in_head)?.href ? normalizeUrl(entry.facts.canonicals.find((c) => c.in_head).href, entry.rec.final_url) : null;
    alternateCache.set(url, entry);
    return entry;
  };

  const results = await forEachPage(ctx, 'C-3.2', async (page, b) => {
    b.caveat(STANDING);
    const url = page.finalUrl;
    const ann = pageAnn.get(page.url);
    const annEv = domEv(page, 'RAW', 'head > link[rel=alternate][hreflang]', ann.html.map((a) => `${a.hreflang} → ${a.href}`).join(' | ') || '(none)');
    const hdrEv = ev({ kind: 'http_header', source_url: url, fetch_profile: 'RAW', selector_or_key: 'Link (rel=alternate)', observed_value: page.raw?.headers?.link ?? null });
    b.metric('html_annotations', ann.html.map((a) => ({ hreflang: a.hreflang, href: a.href })))
      .metric('header_annotations', ann.header.map((a) => ({ hreflang: a.hreflang, href: a.href })))
      .metric('html_lang', page.rawFacts?.htmlLang || null);
    b.addEvidence(annEv, hdrEv);

    if (!ann.all.length) {
      const renAnn = hasRendered(page) ? page.renFacts.hreflang : [];
      if (renAnn.length) {
        b.hit('C-3.2-p', { summary: `hreflang annotations exist only after rendering (${renAnn.map((a) => a.hreflang).join(', ')}).`, evidence: [domEv(page, 'RENDERED', 'head > link[rel=alternate][hreflang]', renAnn.map((a) => `${a.hreflang} → ${a.href}`).join(' | '))], cross_references: ['C-5.2'] });
        return;
      }
      if (advisory) {
        b.hit('C-3.2-c', { status: 'WARN', severity: 'MEDIUM', reason_code: 'HREFLANG_POSSIBLY_MISSING', summary: `A single weak multilingual signal was observed (${allSignals[0]}) and no hreflang annotations are present. Advisory only (B-3.2-3).`, evidence: [annEv] });
      } else {
        b.hit('C-3.2-c', { summary: `Multilingual signals present (${allSignals.join('; ')}) but no hreflang in the HTML <head> or Link headers. Absence from the two evaluated mechanisms does not prove hreflang is undeclared.`, evidence: [annEv, hdrEv] });
      }
      return;
    }

    // Body-placed annotations (C-3.2-r)
    const inBody = (page.rawFacts?.hreflang || []).filter((a) => !a.in_head);
    if (inBody.length) b.hit('C-3.2-r', { summary: `${inBody.length} hreflang link(s) outside <head> in the parsed document.`, evidence: [domEv(page, 'RAW', 'body link[rel=alternate][hreflang]', inBody.map((a) => `${a.hreflang} → ${a.href}`).join(' | '))] });

    // Mechanism conflict (R-3.2-3)
    if (ann.html.length && ann.header.length) {
      const setOf = (list) => new Set(list.map((a) => `${String(a.hreflang).toLowerCase()}|${normalizeUrl(a.href, url) || a.href}`));
      const h = setOf(ann.html);
      const g = setOf(ann.header);
      const differs = h.size !== g.size || [...h].some((x) => !g.has(x));
      if (differs) b.hit('C-3.2-o', { summary: 'The HTML and Link-header mechanisms annotate this URL with different sets.', evidence: [annEv, hdrEv] });
    }

    // Value + URL-form validation
    const seenCodes = new Map();
    let selfRef = false;
    const alternates = [];
    for (const a of ann.all) {
      const v = validateCode(a.hreflang);
      const href = String(a.href || '').trim();
      const abs = /^https?:\/\//i.test(href) ? normalizeUrl(href, url) : null;
      const aEv = domEv(page, 'RAW', `link[hreflang=${a.hreflang}]`, `${a.hreflang} → ${href}`);
      if (!v.valid) {
        if (v.regionOnly) b.hit('C-3.2-g', { summary: `hreflang="${a.hreflang}" is a region code without a language.`, evidence: [aEv] });
        else b.hit('C-3.2-f', { summary: `Invalid hreflang value "${a.hreflang}": ${v.reason}.`, evidence: [aEv] });
        continue;
      }
      if (!abs) {
        b.hit('C-3.2-h', { summary: `hreflang href "${href}" is ${href.startsWith('//') ? 'protocol-relative' : 'relative'}; values must be fully-qualified absolute URLs including the transport method.`, evidence: [aEv] });
        continue;
      }
      const key = String(a.hreflang).toLowerCase();
      if (seenCodes.has(key) && seenCodes.get(key) !== abs) {
        b.hit('C-3.2-l', { summary: `hreflang="${a.hreflang}" maps to two different URLs in one cluster: ${seenCodes.get(key)} and ${abs}.`, evidence: [aEv], report_section: '1' });
      } else seenCodes.set(key, abs);
      if (abs === url) {
        selfRef = true;
        if (!v.xDefault) {
          const hl = page.rawFacts?.htmlLang;
          if (hl && v.lang && String(hl).toLowerCase().split('-')[0] !== v.lang) {
            b.hit('C-3.2-n', { summary: `<html lang="${hl}"> does not match the hreflang self-reference "${a.hreflang}".`, evidence: [aEv, domEv(page, 'RAW', 'html[lang]', hl)] });
          }
        }
      } else alternates.push({ code: a.hreflang, url: abs, xDefault: v.xDefault, mechanism: a.mechanism });
    }
    if (!selfRef) b.hit('C-3.2-e', { summary: 'No hreflang annotation points at this page itself with its own language code.', evidence: [annEv] });
    if (!ann.all.some((a) => String(a.hreflang).toLowerCase() === 'x-default')) b.hit('C-3.2-m', { summary: 'No x-default annotation in the cluster (recommended, not required).', evidence: [annEv] });

    // Cluster registration
    const clusterKey = [url, ...alternates.map((a) => a.url)].sort().join('|');
    if (!clusters.has(clusterKey)) clusters.set(clusterKey, { members: new Set([url, ...alternates.map((a) => a.url)]), source: url });
    if (alternates.length === 0) b.hit('C-3.2-q', { summary: 'This page annotates only itself — a single-member hreflang cluster.', evidence: [annEv] });

    // Target health + return links (R-3.2-6, R-3.2-8)
    let verified = 0;
    let capped = 0;
    for (const alt of alternates) {
      const t = await fetchAlternate(alt.url);
      if (t.capped) {
        capped++;
        continue;
      }
      const tEv = ev({ kind: 'http_status', source_url: alt.url, fetch_profile: 'RAW', selector_or_key: `alternate ${alt.code} status`, observed_value: t.rec.status == null ? null : String(t.rec.status), expected_value: '200' });
      if (t.rec.status == null) {
        b.caveat(`Alternate ${alt.url} was unreachable (${t.rec.error?.code}); NOT_TESTABLE for that alternate, not a broken-target finding (E-3.2-6).`);
        continue;
      }
      if (t.rec.status >= 400) {
        b.hit('C-3.2-i', { summary: `Alternate ${alt.url} (hreflang="${alt.code}") returns HTTP ${t.rec.status}.`, evidence: [tEv], report_section: '1' });
        continue;
      }
      if (t.noindex || ctx.robotsAllowed('googlebot', alt.url).verdict === 'DISALLOWED') {
        b.hit('C-3.2-j', { summary: `Alternate ${alt.url} is ${t.noindex ? 'noindex' : 'robots-disallowed for Googlebot'}.`, evidence: [tEv], cross_references: ['C-1.6', 'C-1.1'] });
      }
      if ((t.rec.hop_count || 0) > 0) {
        const geo = /[?&](gl|country|locale|lang)=/i.test(t.rec.final_url) || alternates.some((x) => x.url !== alt.url && normalizeUrl(t.rec.final_url) === x.url);
        if (geo) b.note('HREFLANG_GEO_REDIRECT', `Alternate ${alt.url} redirected to ${t.rec.final_url}. Google generally crawls from the US and is subject to the same behaviour, which is why geo-redirects are discouraged alongside hreflang (E-3.2-8).`, [tEv]);
        else b.note('HREFLANG_TARGET_BROKEN', `Alternate ${alt.url} redirects to ${t.rec.final_url} (targets should return 200 directly).`, [tEv]);
      }
      // Reciprocity — both in-scope mechanisms must be checked (E-3.2-5, F-3.2-2).
      if (!t.annotations.length) {
        b.hit('C-3.2-s', { summary: `Alternate ${alt.url} publishes no HTML or header hreflang, so no return link can be verified for this pair.`, evidence: [tEv] });
        continue;
      }
      const pointsBack = t.annotations.some((x) => {
        const abs = normalizeUrl(String(x.href || '').trim(), t.rec.final_url);
        return abs === url || abs === page.url;
      });
      if (!pointsBack) {
        b.hit('C-3.2-d', {
          summary: `Alternate ${alt.url} (hreflang="${alt.code}") publishes its own hreflang set but omits a return link to ${url}; non-reciprocal annotations are ignored entirely.`,
          evidence: [tEv, ev({ kind: 'dom_node', source_url: alt.url, fetch_profile: 'RAW', selector_or_key: 'link[rel=alternate][hreflang] on the alternate', observed_value: t.annotations.map((x) => `${x.hreflang} → ${x.href}`).join(' | '), expected_value: `an annotation pointing to ${url}` })],
          report_section: '1',
        });
      } else verified++;
      // Canonical consistency within the cluster (R-3.2-9)
      if (t.canonical && t.canonical !== alt.url && alternates.some((x) => x.url === t.canonical) ) {
        b.hit('C-3.2-k', { summary: `Alternate ${alt.url} canonicalises to ${t.canonical}, a different language in the same cluster — this collapses the cluster.`, evidence: [tEv], cross_references: ['C-1.5'], report_section: '1' });
      }
    }
    const ownCanonical = ctx.derived.canonical?.get(page.url);
    if (ownCanonical?.state === 'CROSS' && alternates.some((a) => a.url === ownCanonical.target)) {
      b.hit('C-3.2-k', { summary: `This page canonicalises to ${ownCanonical.target}, which is a different language in its own hreflang cluster.`, evidence: [annEv], cross_references: ['C-1.5'], report_section: '1' });
    }
    if (capped) b.caveat(`${capped} alternate(s) were not verified: the run-level cap of ${ctx.cfg.hreflang.max_alternates} alternate fetches was reached (HREFLANG_VERIFICATION_SAMPLED; true count ${alternates.length}).`);
    b.metric('alternates', alternates.length).metric('return_links_verified', verified);

    if (!b.hits.length) b.pass(`${ann.all.length} annotation(s): all codes valid, self-referencing, every alternate returns 200 and indexable, and return links verified for ${verified} pair(s).`);
  });

  // Site-level cluster summary
  try {
    const b = new ResultBuilder(ctx, 'C-3.2', { scope: 'site', target_url: ctx.canonicalOrigin });
    b.caveat(STANDING);
    b.metric('multilingual_signals', allSignals)
      .metric('clusters', [...clusters.values()].map((c) => ({ members: [...c.members] })))
      .metric('alternates_fetched', fetched);
    b.addEvidence(ev({ kind: 'computed', source_url: ctx.canonicalOrigin, selector_or_key: 'multilingual detection', observed_value: allSignals.join('; ') }));
    if (fetched >= ctx.cfg.hreflang.max_alternates) b.caveat(`Alternate verification capped at ${ctx.cfg.hreflang.max_alternates} fetches (F-3.2-3).`);
    b.pass(`Site detected as multilingual (${allSignals.join('; ')}); ${clusters.size} hreflang cluster(s) assembled across the sample.`, 'HREFLANG_VERIFICATION_SAMPLED');
    results.push(b.build());
  } catch (e) {
    results.push(errorResult(ctx, 'C-3.2', e));
  }

  // R-3.2-15 routing: the four crawl/index conditions are reported and scored under Section 1 only.
  for (const r of results) {
    const routed = (r.sub_findings || []).filter((s) => SECTION1_ROUTED.has(s.checkpoint));
    if (!routed.length) continue;
    r.routed_findings = routed.map((s) => ({ checkpoint: s.checkpoint, reason_code: s.reason_code, report_section: '1' }));
    const top = (r.sub_findings || []).find((s) => s.reason_code === r.reason_code);
    if (top && SECTION1_ROUTED.has(top.checkpoint)) {
      r.report_section = '1';
      r.routing_note = `Detected by ${r.check_id} (Hreflang); reported and scored under Section 1 — Crawl & Indexing, and counted in no other section (R-3.2-15, R-SCORE-9).`;
    }
  }
  return results;
}
