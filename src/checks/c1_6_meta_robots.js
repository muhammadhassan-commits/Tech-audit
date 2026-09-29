// C-1.6 — Meta Robots (page · RAW and RENDERED + X-Robots-Tag). Sources kept separate (F-1.6-3).
import { ev } from '../engine/result.js';
import { forEachPage, hasRendered, domEv, matchesAny } from './_util.js';

const RECOGNISED = new Set(['all', 'noindex', 'nofollow', 'none', 'nosnippet', 'indexifembedded', 'notranslate', 'noimageindex', 'index', 'follow']);
const PARAM = /^(max-snippet|max-image-preview|max-video-preview|unavailable_after)\s*:/i;
const OBSOLETE = new Set(['noarchive', 'nocache', 'nositelinkssearchbox']);
const SNIPPET_OK_ELEMENTS = new Set(['span', 'div', 'section']);

export function tokenise(content) {
  const out = [];
  for (const raw of String(content || '').split(',')) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    out.push(t.replace(/\s*:\s*/, ':'));
  }
  return out;
}

/** Parse X-Robots-Tag header value(s) into [{ agent|null, directives[] }] (R-1.6-1 #3). */
export function parseXRobots(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  const out = [];
  for (const v of values) {
    let agent = null;
    let rest = String(v).trim();
    const m = /^([a-z0-9_.-]+)\s*:\s*(.*)$/i.exec(rest);
    if (m && !PARAM.test(rest) && !RECOGNISED.has(m[1].toLowerCase())) {
      agent = m[1].toLowerCase();
      rest = m[2];
    }
    out.push({ agent, directives: tokenise(rest), raw: v });
  }
  return out;
}

export function directiveFacts(tokens) {
  const set = new Set(tokens.map((t) => t.split(':')[0]));
  const maxSnippet = tokens.find((t) => t.startsWith('max-snippet:'));
  const maxImg = tokens.find((t) => t.startsWith('max-image-preview:'));
  const ua = tokens.find((t) => t.startsWith('unavailable_after:'));
  return {
    noindex: set.has('noindex') || set.has('none'),
    nofollow: set.has('nofollow') || set.has('none'),
    nosnippet: set.has('nosnippet'),
    maxSnippet0: !!maxSnippet && Number(maxSnippet.split(':')[1]) === 0,
    maxImageNone: !!maxImg && maxImg.split(':')[1] === 'none',
    unavailableAfter: ua ? ua.slice('unavailable_after:'.length).trim() : null,
    unknown: tokens.filter((t) => !RECOGNISED.has(t.split(':')[0]) && !PARAM.test(t) && !OBSOLETE.has(t)),
    obsolete: tokens.filter((t) => OBSOLETE.has(t)),
    explicitIndex: set.has('index') || set.has('all'),
  };
}

function metaTokens(facts, { inHeadOnly = true } = {}) {
  const forGoogle = facts.metaRobots.filter((m) => ['robots', 'googlebot'].includes(m.name) && (!inHeadOnly || (m.in_head && !m.in_noscript)));
  return forGoogle.flatMap((m) => tokenise(m.content));
}

export async function run(ctx) {
  ctx.derived.robotsMeta = new Map();
  const results = await forEachPage(ctx, 'C-1.6', async (page, b) => {
    const f = page.rawFacts;
    const url = page.finalUrl;
    const xrt = parseXRobots(page.raw.headers?.['x-robots-tag']);
    const headerTokens = xrt.filter((x) => !x.agent || x.agent === 'googlebot').flatMap((x) => x.directives);
    const metaTok = metaTokens(f);
    const effective = [...metaTok, ...headerTokens];
    const eff = directiveFacts(effective);
    const metaFacts = directiveFacts(metaTok);
    const hdrFacts = directiveFacts(headerTokens);
    const renTok = hasRendered(page) ? metaTokens(page.renFacts) : null;
    const renFacts = renTok ? directiveFacts([...renTok, ...headerTokens]) : null;
    const disallowed = ctx.robotsAllowed('googlebot', url).verdict === 'DISALLOWED';

    const srcEv = [];
    for (const m of f.metaRobots) srcEv.push(domEv(page, 'RAW', `meta[name=${m.name}]${m.in_head ? '' : ' (outside <head>)'}${m.in_noscript ? ' (in <noscript>)' : ''}`, m.content));
    for (const x of xrt) srcEv.push(ev({ kind: 'http_header', source_url: url, fetch_profile: 'RAW', selector_or_key: 'X-Robots-Tag', observed_value: x.raw }));
    b.metric('meta', f.metaRobots.map((m) => ({ name: m.name, content: m.content, in_head: m.in_head })))
      .metric('x_robots_tag', xrt.map((x) => x.raw))
      .metric('effective_googlebot', effective)
      .metric('rendered', renTok ?? 'NOT_AVAILABLE');

    ctx.derived.robotsMeta.set(page.url, { noindex: eff.noindex, nofollow: eff.nofollow, nosnippet: eff.nosnippet, maxSnippet0: eff.maxSnippet0, rawNoindex: eff.noindex, renNoindex: renFacts?.noindex ?? null });

    const intentional = matchesAny(url, ctx.cfg.expected_noindex_paths);
    if (eff.noindex) {
      if (disallowed) b.hit('C-1.6-c', { summary: 'noindex is present but the URL is disallowed for Googlebot, so the noindex can never be seen (classic "blocked page still in search" cause).', evidence: srcEv, cross_references: ['C-1.1', 'C-1.7'] });
      else if (intentional) b.note('NOINDEX_INTENTIONAL', 'noindex on an intentionally private path (E-1.6-1).', srcEv);
      else if (ctx.cfg.env === 'staging') b.hit('C-1.6-b', { status: 'WARN', severity: 'LOW', reason_code: 'STAGING_NOINDEX_EXPECTED', summary: 'noindex on a staging host (E-1.6-8).', evidence: srcEv });
      else b.hit('C-1.6-b', { summary: `Effective noindex for Googlebot (${effective.join(', ')}) on a page intended to rank.${page.isHomepage ? ' This is the homepage — run-level headline (F-1.6-4).' : ''}`, evidence: srcEv, cross_references: ['C-1.7'] });
    }
    if (eff.nofollow && ['homepage', 'category'].includes(page.page_type) && !intentional) b.hit('C-1.6-d', { summary: `nofollow on a hub page (${page.page_type}).`, evidence: srcEv });
    if (renFacts) {
      if (eff.noindex && !renFacts.noindex) b.hit('C-1.6-e', { summary: 'RAW has noindex and RENDERED does not; Google may skip rendering entirely on a RAW noindex, so removing it with JavaScript is unreliable.', evidence: [...srcEv, domEv(page, 'RENDERED', 'meta[name=robots]', renTok.join(', ') || '(none)')] });
      if (!eff.noindex && renFacts.noindex) b.hit('C-1.6-f', { summary: 'noindex is added by JavaScript (present only in RENDERED).', evidence: [domEv(page, 'RENDERED', 'meta[name=robots]', renTok.join(', '))] });
    } else {
      b.caveat('RAW vs RENDERED directives not compared (no RENDERED profile); C-1.6-e/f NOT_TESTABLE (B-1.6-1).');
    }
    if (metaTok.length && headerTokens.length && (metaFacts.noindex !== hdrFacts.noindex || metaFacts.nofollow !== hdrFacts.nofollow) && (metaFacts.explicitIndex || hdrFacts.explicitIndex || metaFacts.noindex || hdrFacts.noindex)) {
      b.hit('C-1.6-g', { summary: `X-Robots-Tag (${headerTokens.join(', ')}) and meta robots (${metaTok.join(', ')}) conflict; resolved to the most restrictive.`, evidence: srcEv });
    }
    if (eff.nosnippet) b.hit('C-1.6-h', { summary: 'nosnippet suppresses search snippets and blocks the page as a direct input to AI Overviews and AI Mode.', evidence: srcEv, cross_references: ['C-5.1', 'C-2.2'] });
    else if (eff.maxSnippet0) b.hit('C-1.6-i', { summary: 'max-snippet:0 — equivalent to nosnippet in effect, including for AI Overviews/AI Mode input.', evidence: srcEv, cross_references: ['C-5.1', 'C-2.2'] });
    if (eff.maxImageNone) b.hit('C-1.6-j', { summary: 'max-image-preview:none.', evidence: srcEv });
    if (eff.unavailableAfter) {
      const d = Date.parse(eff.unavailableAfter);
      if (Number.isNaN(d)) b.note('UNKNOWN_DIRECTIVE', `unavailable_after value "${eff.unavailableAfter}" does not parse as RFC 822/850 or ISO 8601.`);
      else if (d < Date.now()) b.hit('C-1.6-k', { summary: `unavailable_after date ${eff.unavailableAfter} is in the past.`, evidence: srcEv });
    }
    const outside = f.metaRobots.filter((m) => ['robots', 'googlebot'].includes(m.name) && !m.in_head);
    for (const m of outside) {
      if (m.in_noscript) b.hit('C-1.6-l', { severity: 'HIGH', reason_code: 'META_ROBOTS_IN_NOSCRIPT', summary: `meta ${m.name} inside <noscript> ("${m.content}"): behaviour is inconsistent and the intent is almost always wrong (E-1.6-10).`, evidence: [domEv(page, 'RAW', 'noscript meta[name=robots]', m.content)] });
      else b.hit('C-1.6-l', { summary: `meta ${m.name} outside <head> ("${m.content}") is ignored by Google.`, evidence: [domEv(page, 'RAW', 'body meta[name=robots]', m.content)] });
    }
    const robotsMetas = f.metaRobots.filter((m) => m.name === 'robots' && m.in_head);
    if (robotsMetas.length > 1 && new Set(robotsMetas.map((m) => tokenise(m.content).sort().join(','))).size > 1) b.hit('C-1.6-m', { summary: `${robotsMetas.length} meta name="robots" elements with conflicting values; the most restrictive applies.`, evidence: srcEv });
    const badSnippet = f.dataNosnippet.filter((t) => !SNIPPET_OK_ELEMENTS.has(t));
    if (badSnippet.length) b.hit('C-1.6-n', { summary: `data-nosnippet on unsupported element(s): ${[...new Set(badSnippet)].join(', ')} (supported: span, div, section).`, evidence: [domEv(page, 'RAW', '[data-nosnippet]', badSnippet.join(', '))] });
    if (eff.obsolete.length) b.note('UNKNOWN_DIRECTIVE', `Directive(s) documented as no longer used by Google Search: ${eff.obsolete.join(', ')} — ineffective, not controls.`);
    if (eff.unknown.length) b.note('UNKNOWN_DIRECTIVE', `Unrecognised directive(s) reported, not acted on: ${eff.unknown.join(', ')}.`);
    const otherBots = f.metaRobots.filter((m) => !['robots', 'googlebot'].includes(m.name));
    if (otherBots.length) b.note('UNKNOWN_DIRECTIVE', `Crawler-specific meta tags for other agents (${otherBots.map((m) => m.name).join(', ')}) do not apply to Googlebot (F-1.6-5).`);

    b.addEvidence(...srcEv, ev({ kind: 'computed', source_url: url, fetch_profile: 'RAW', selector_or_key: 'effective directives (googlebot)', observed_value: effective.join(', ') || '(none — defaults: index, follow)' }));
    if (!b.hits.length) b.pass(effective.length ? `No indexing-restrictive directive for Googlebot (effective: ${effective.join(', ')}).` : 'No robots meta tag or X-Robots-Tag restricts Googlebot (defaults: index, follow).');
  });

  // C-1.6-d site-wide nofollow
  const metas = [...ctx.derived.robotsMeta.values()];
  if (metas.length >= 2 && metas.every((m) => m.nofollow)) {
    for (const r of results) if (!r.sub_findings.some((s) => s.checkpoint === 'C-1.6-d') && r.status !== 'NOT_TESTABLE') {
      r.sub_findings.push({ checkpoint: 'C-1.6-d', status: 'WARN', severity: 'HIGH', reason_code: 'NOFOLLOW_PRESENT', summary: 'nofollow is present on every sampled page (site-wide).', evidence: [], sources: ctx.register.resolve('C-1.6', { checkpoint: 'C-1.6-d' }).sources, caveats: [] });
      if (r.status === 'PASS') Object.assign(r, { status: 'WARN', severity: 'HIGH', reason_code: 'NOFOLLOW_PRESENT', summary: 'nofollow is present site-wide across the sample.' });
    }
  }
  return results;
}
