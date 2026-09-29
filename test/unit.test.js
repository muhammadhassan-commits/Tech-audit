// Unit tests for the binding rules most likely to be got wrong: robots parsing and group
// selection, URL normalisation, pattern grouping, scoring, and the source-register contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, evaluate, selectGroup, agentToken } from '../src/parse/robots.js';
import { normalizeUrl, isSameSite, parseSeed } from '../src/parse/url.js';
import { computeSignatures, classifySegment, ISO639_1 } from '../src/discovery/grouping.js';
import { validateCode, parseLinkHreflang } from '../src/checks/c3_2_hreflang.js';
import { parseXRobots, tokenise, directiveFacts } from '../src/checks/c1_6_meta_robots.js';
import { parseLlmsTxt } from '../src/checks/c5_3_llms_txt.js';
import { parseBlock, hasField, invalidCasing, buildGraph, typesOf, danglingRefs } from '../src/parse/jsonld.js';
import { pointsFor, computeScores } from '../src/engine/scoring.js';
import { wordCount, levenshteinRatio } from '../src/parse/text.js';
import { getRegister } from '../src/sources/register.js';
import { CHECKPOINTS } from '../src/engine/result.js';
import { selfContained, chunkRoots } from '../src/checks/c6_3_structure.js';
import { isNameShaped } from '../src/checks/c6_2_entity.js';
import { loadConfig } from '../src/config.js';

// ── robots.txt (R-A2-1, R-1.1-2) ──────────────────────────────────────────
test('robots: most specific group wins; groups are not merged across tokens', () => {
  const p = parseRobots(`User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /private/\n`);
  assert.equal(evaluate(p, 'googlebot', '/').verdict, 'ALLOWED');
  assert.equal(evaluate(p, 'googlebot', '/private/x').verdict, 'DISALLOWED');
  assert.equal(evaluate(p, 'gptbot', '/').verdict, 'DISALLOWED'); // inherits *
});

test('robots: longest match wins; Allow beats Disallow on equal length', () => {
  const p = parseRobots(`User-agent: *\nDisallow: /a/\nAllow: /a/b/\n`);
  assert.equal(evaluate(p, '*', '/a/x').verdict, 'DISALLOWED');
  assert.equal(evaluate(p, '*', '/a/b/x').verdict, 'ALLOWED');
  const q = parseRobots(`User-agent: *\nDisallow: /x\nAllow: /x\n`);
  assert.equal(evaluate(q, '*', '/x').verdict, 'ALLOWED'); // least restrictive on a tie
});

test('robots: Disallow: / plus Allow: /$ and /blog/ resolves per path (E-1.1-2)', () => {
  const p = parseRobots(`User-agent: *\nDisallow: /\nAllow: /$\nAllow: /blog/\n`);
  assert.equal(evaluate(p, '*', '/').verdict, 'ALLOWED');
  assert.equal(evaluate(p, '*', '/blog/post').verdict, 'ALLOWED');
  assert.equal(evaluate(p, '*', '/other').verdict, 'DISALLOWED');
});

test('robots: empty Disallow means allow everything (E-A2-2)', () => {
  const p = parseRobots('User-agent: *\nDisallow:\n');
  assert.equal(evaluate(p, '*', '/anything').verdict, 'ALLOWED');
});

test('robots: paths are case-sensitive, agents are not (E-1.1-11)', () => {
  const p = parseRobots('User-agent: GOOGLEBOT\nDisallow: /Admin\n');
  assert.equal(evaluate(p, 'googlebot', '/Admin').verdict, 'DISALLOWED');
  assert.equal(evaluate(p, 'googlebot', '/admin').verdict, 'ALLOWED');
});

test('robots: wildcards and $ anchor', () => {
  const p = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?\n');
  assert.equal(evaluate(p, '*', '/a/b.pdf').verdict, 'DISALLOWED');
  assert.equal(evaluate(p, '*', '/a/b.pdf?x=1').verdict, 'DISALLOWED'); // matches the query rule
  assert.equal(evaluate(p, '*', '/a/bpdf').verdict, 'ALLOWED');
  assert.equal(evaluate(p, '*', '/clean').verdict, 'ALLOWED');
});

test('robots: same-token groups merge; unsupported directives are classified, not acted on', () => {
  const p = parseRobots('User-agent: Googlebot\nDisallow: /a\n\nUser-agent: Googlebot\nDisallow: /b\n\nUser-agent: *\nCrawl-delay: 10\nNoindex: /x\n');
  assert.equal(evaluate(p, 'googlebot', '/a').verdict, 'DISALLOWED');
  assert.equal(evaluate(p, 'googlebot', '/b').verdict, 'DISALLOWED');
  const unsupported = p.lineClasses.filter((l) => l.class === 'UNSUPPORTED_BY_GOOGLE').map((l) => l.field);
  assert.deepEqual(unsupported.sort(), ['crawl-delay', 'noindex']);
  assert.equal(evaluate(p, 'somebot', '/x').verdict, 'ALLOWED'); // robots noindex is never a control
});

test('robots: BOM stripped, malformed lines ignored, sitemaps collected anywhere', () => {
  const p = parseRobots('﻿Sitemap: https://e.com/s.xml\ngarbage line\nUser-agent: *\nAllow: /\nSitemap: https://e.com/s2.xml\n');
  assert.equal(p.hadBom, true);
  assert.equal(p.sitemaps.length, 2);
  assert.equal(p.lineClasses.filter((l) => l.class === 'IGNORED_MALFORMED').length, 1);
});

test('robots: user-agent token matching is prefix-safe', () => {
  const p = parseRobots('User-agent: Claude\nDisallow: /\n');
  assert.equal(evaluate(p, 'claude-searchbot', '/').verdict, 'DISALLOWED'); // Claude-SearchBot matches "claude-"
  const q = parseRobots('User-agent: Claudebot\nDisallow: /\n');
  assert.equal(evaluate(q, 'claude-user', '/').verdict, 'ALLOWED'); // "claudebot" is not a prefix of "claude-user"
  assert.equal(agentToken('GPTBot/1.0'), 'gptbot');
});

test('robots: oversize files are parsed only to the byte cap', () => {
  const body = `User-agent: *\n${'#'.repeat(600)}\nDisallow: /late\n`;
  const p = parseRobots(body, { maxBytes: 60 });
  assert.equal(p.oversize, true);
  assert.equal(evaluate(p, '*', '/late').verdict, 'ALLOWED'); // the rule fell beyond the cap
});

// ── URL normalisation (R-FETCH-9) ─────────────────────────────────────────
test('URL: normalisation preserves path case, trailing slash and query', () => {
  assert.equal(normalizeUrl('HTTPS://Example.COM:443/A/./b/../C/?q=1#f'), 'https://example.com/A/C/?q=1#f');
  assert.notEqual(normalizeUrl('https://e.com/a'), normalizeUrl('https://e.com/a/'));
  assert.notEqual(normalizeUrl('https://e.com/A'), normalizeUrl('https://e.com/a'));
  assert.equal(normalizeUrl('https://e.com/%7euser'), 'https://e.com/%7Euser');
  assert.equal(normalizeUrl('mailto:a@b.com'), null);
});

test('URL: subdomains are different sites (R-A0-5)', () => {
  assert.equal(isSameSite('https://blog.e.com/x', 'https://e.com'), false);
  assert.equal(isSameSite('https://e.com/x', 'https://e.com'), true);
});

test('URL: seed accepts bare hosts, www and deep paths', () => {
  assert.deepEqual(parseSeed('Example.com/pricing').isDeep, true);
  assert.equal(parseSeed('www.example.com').bareHost, 'example.com');
  assert.equal(parseSeed('https://example.com:8443/').port, '8443');
});

// ── Grouping (A.3) ────────────────────────────────────────────────────────
test('grouping: checklist examples produce the documented signatures', () => {
  const m = computeSignatures([
    'https://e.com/blog/how-to-fix-seo',
    'https://e.com/blog/best-vpn-2026',
    'https://e.com/product/12345/red-shoe',
  ]);
  assert.equal(m.get('https://e.com/blog/how-to-fix-seo').signature, '/blog/*');
  assert.equal(m.get('https://e.com/blog/best-vpn-2026').signature, '/blog/*');
  assert.equal(m.get('https://e.com/product/12345/red-shoe').signature, '/product/*/*');
});

test('grouping: locale prefixes collapse to one template (R-A3-4)', () => {
  const m = computeSignatures(['https://e.com/en/pricing', 'https://e.com/de/pricing']);
  assert.equal(m.get('https://e.com/en/pricing').signature, '/*/pricing');
  assert.equal(m.get('https://e.com/de/pricing').signature, '/*/pricing');
});

test('grouping: named root pages stay addressable; other root slugs collapse (E-A3-1)', () => {
  const m = computeSignatures(['https://e.com/pricing', 'https://e.com/some-post', 'https://e.com/other-post']);
  assert.equal(m.get('https://e.com/pricing').signature, '/pricing');
  assert.equal(m.get('https://e.com/some-post').signature, '/*');
});

test('grouping: file extensions are preserved and dates classified', () => {
  const m = computeSignatures(['https://e.com/blog/a.html', 'https://e.com/blog/b.html', 'https://e.com/2026/09/post']);
  assert.equal(m.get('https://e.com/blog/a.html').signature, '/blog/*.html');
  assert.equal(m.get('https://e.com/2026/09/post').signature, '/*/*/*'); // E-A3-2 date-partitioned blog
  assert.equal(classifySegment('2026', 0, null), 'YEAR');
  assert.equal(classifySegment('09', 1, 'YEAR'), 'DATE');
  assert.equal(classifySegment('12345-red-shoe', 1, null), 'SLUG'); // E-A3-4 hybrid IDs stay slugs
});

test('grouping: identical input always yields identical signatures (F-A3-1)', () => {
  const urls = ['https://e.com/a/1', 'https://e.com/a/2', 'https://e.com/b'];
  assert.deepEqual([...computeSignatures(urls).values()], [...computeSignatures([...urls].reverse()).values()]);
});

// ── hreflang (R-3.2-4) ────────────────────────────────────────────────────
test('hreflang: code validation accepts script subtags and rejects the common invalid values', () => {
  assert.equal(validateCode('en-GB').valid, true);
  assert.equal(validateCode('zh-Hant').valid, true);
  assert.equal(validateCode('x-default').xDefault, true);
  assert.equal(validateCode('en-UK').valid, false);
  assert.equal(validateCode('en-EU').valid, false); // EU is not an ISO 3166-1 region
  assert.equal(validateCode('us').valid, false); // region code with no language
  assert.equal(validateCode('us').regionOnly, true);
  assert.equal(validateCode('eng').valid, false); // 3-letter where a 2-letter exists
});

test('hreflang: Link header parsing', () => {
  const out = parseLinkHreflang({ link: '<https://e.com/de>; rel="alternate"; hreflang="de", <https://e.com/>; rel="canonical"' });
  assert.deepEqual(out, [{ hreflang: 'de', href: 'https://e.com/de' }]);
});

// ── meta robots (R-1.6-1…R-1.6-4) ─────────────────────────────────────────
test('meta robots: per-agent X-Robots-Tag and most-restrictive resolution', () => {
  const parsed = parseXRobots(['googlebot: noindex, nofollow', 'otherbot: noindex']);
  assert.equal(parsed[0].agent, 'googlebot');
  assert.equal(parsed[1].agent, 'otherbot');
  const google = parsed.filter((x) => !x.agent || x.agent === 'googlebot').flatMap((x) => x.directives);
  assert.equal(directiveFacts(google).noindex, true);
  const other = parseXRobots(['otherbot: noindex']).filter((x) => !x.agent || x.agent === 'googlebot');
  assert.equal(other.length, 0); // E-1.6-7 must not fire C-1.6-b
});

test('meta robots: max-snippet:-1 grants, max-snippet:0 suppresses', () => {
  assert.equal(directiveFacts(tokenise('max-snippet:-1')).maxSnippet0, false);
  assert.equal(directiveFacts(tokenise('max-snippet:0')).maxSnippet0, true);
  assert.equal(directiveFacts(tokenise('none')).noindex, true);
  assert.equal(directiveFacts(tokenise('all')).noindex, false);
});

// ── llms.txt (R-5.3-2) ────────────────────────────────────────────────────
test('llms.txt: H1, blockquote, H2 link sections and the Optional convention', () => {
  const p = parseLlmsTxt(`# Acme\n\n> Acme is a widget company.\n\nSome prose.\n\n## Docs\n- [Guide](https://acme.com/guide): how to start\n- [API](https://acme.com/api)\n\n## Optional\n- [Changelog](https://acme.com/changelog)\n`);
  assert.equal(p.h1, 'Acme');
  assert.equal(p.blockquote, 'Acme is a widget company.');
  assert.equal(p.linkSections.length, 2);
  assert.equal(p.links.length, 3);
  assert.equal(p.optionalSection, true);
  assert.equal(p.links[0].notes, 'how to start');
});

// ── JSON-LD (R-3.1-2, R-3.1-12) ───────────────────────────────────────────
test('JSON-LD: strict parse fails and lenient recovery names the fault', () => {
  const ok = parseBlock('{"@type":"Organization","name":"A"}');
  assert.equal(ok.ok, true);
  const trailing = parseBlock('{"@type":"Organization","name":"A",}');
  assert.equal(trailing.ok, false);
  assert.equal(trailing.lenient, true);
  assert.ok(trailing.faults.includes('trailing commas'));
});

test('JSON-LD: field alternatives and case-sensitive property names', () => {
  assert.equal(hasField({ offers: { price: '9' } }, 'offers|review'), true);
  assert.equal(hasField({ priceSpecification: { price: '9' } }, 'price|priceSpecification.price'), true);
  assert.equal(hasField({ name: '  ' }, 'name'), false);
  assert.deepEqual(invalidCasing({ Url: 'x', name: 'y', '@type': 'Z' }), ['Url']);
});

// ── Scoring (Appendix A) ──────────────────────────────────────────────────
test('scoring: per-check points follow R-SCORE-1', () => {
  assert.equal(pointsFor({ status: 'PASS' }), 1);
  assert.equal(pointsFor({ status: 'FAIL' }), 0);
  assert.equal(pointsFor({ status: 'WARN', severity: 'LOW' }), 0.5);
  assert.equal(pointsFor({ status: 'WARN', severity: 'MEDIUM' }), 0.4);
  assert.ok(Math.abs(pointsFor({ status: 'WARN', severity: 'HIGH' }) - 0.3) < 1e-9);
  assert.ok(Math.abs(pointsFor({ status: 'WARN', severity: 'CRITICAL' }) - 0.2) < 1e-9);
  for (const s of ['NOT_APPLICABLE', 'NOT_TESTABLE', 'ERROR']) assert.equal(pointsFor({ status: s }), null);
});

function fakeReport(results, runOverrides = {}) {
  return { run: { run_status: 'COMPLETED', gate: { passed: true }, capabilities: { render_js: true }, ...runOverrides }, results };
}
const R = (check_id, section, status, severity, extra = {}) => ({ check_id, section, report_section: section, status, severity, check_name: check_id, confidence: 'OBSERVED', reason_code: status === 'PASS' ? null : 'X', ...extra });

test('scoring: a CRITICAL FAIL caps the overall score at 40 (R-SCORE-5)', () => {
  const cfg = loadConfig();
  const rest = [R('C-2.1', '2', 'PASS'), R('C-2.2', '2', 'PASS'), R('C-3.1', '3', 'PASS'),
    R('C-4.1', '4', 'PASS'), R('C-5.1', '5', 'PASS'), R('C-6.1', '6', 'PASS')];

  // A critical failure that genuinely stops crawling reads as BLOCKED.
  const blocked = computeScores(fakeReport([
    R('C-1.1', '1', 'FAIL', 'CRITICAL', { reason_code: 'ROBOTS_BLOCKS_GOOGLEBOT_SITEWIDE' }), ...rest,
  ]), cfg);
  assert.equal(blocked.verdict, 'BLOCKED');
  assert.ok(blocked.overall <= 0.4);

  // A critical failure found during a successful crawl must not claim the site was unreachable.
  const critical = computeScores(fakeReport([
    R('C-6.1', '6', 'FAIL', 'CRITICAL', { reason_code: 'RAW_CONTENT_ABSENT' }),
    R('C-1.1', '1', 'PASS'), ...rest.slice(0, 5),
  ]), cfg);
  assert.equal(critical.verdict, 'CRITICAL_ISSUES');
  assert.ok(critical.overall <= 0.4);
  assert.deepEqual(critical.gated_by, ['C-6.1: RAW_CONTENT_ABSENT']);
});

test('scoring: not-testable checks are excluded from numerator and denominator', () => {
  const cfg = loadConfig();
  const s = computeScores(fakeReport([R('C-1.1', '1', 'PASS'), R('C-1.2', '1', 'NOT_TESTABLE')]), cfg);
  const sec1 = s.sections.find((x) => x.section === '1');
  assert.equal(sec1.score, 1);
  assert.equal(sec1.evaluated, 1);
  assert.equal(sec1.not_testable, 1);
});

test('scoring: over 25% not testable suppresses the score entirely (R-SCORE-6)', () => {
  const cfg = loadConfig();
  const s = computeScores(fakeReport([
    R('C-1.1', '1', 'PASS'), R('C-1.2', '1', 'NOT_TESTABLE'),
    R('C-2.1', '2', 'PASS'), R('C-2.2', '2', 'NOT_TESTABLE'),
  ]), cfg);
  assert.equal(s.suppressed, true);
  assert.equal(s.overall, null);
  assert.equal(s.verdict, 'INSUFFICIENT_EVIDENCE');
});

test('scoring: page-level checks average across pages and keep the breakdown (R-SCORE-2)', () => {
  const cfg = loadConfig();
  const s = computeScores(fakeReport([
    R('C-2.1', '2', 'PASS', null, { target_url: 'a' }),
    R('C-2.1', '2', 'FAIL', 'HIGH', { target_url: 'b' }),
  ]), cfg);
  const c = s.checks.find((x) => x.check_id === 'C-2.1');
  assert.equal(c.score, 0.5);
  assert.equal(c.per_target.length, 2);
});

test('scoring: a routed finding counts in its report_section only (R-SCORE-9)', () => {
  const cfg = loadConfig();
  const s = computeScores(fakeReport([
    R('C-3.2', '1', 'FAIL', 'CRITICAL', { report_section: '1' }),
    R('C-3.1', '3', 'PASS'),
  ]), cfg);
  assert.equal(s.distribution.by_section['1'].FAIL, 1);
  assert.equal(s.distribution.by_section['3']?.FAIL ?? 0, 0);
});

// ── Source register contract (R-SRC-1, R-SRC-4) ───────────────────────────
test('register: every checkpoint reason_code resolves to at least one source', () => {
  const reg = getRegister();
  const unmapped = [];
  for (const [id, cp] of Object.entries(CHECKPOINTS)) {
    if (!cp.reason_code) continue;
    const res = reg.resolve(cp.check_id, { checkpoint: id, reasonCode: cp.reason_code });
    if (!res.sources.length) unmapped.push(id);
  }
  assert.deepEqual(unmapped, [], `checkpoints with no mapped source: ${unmapped.join(', ')}`);
});

test('register: every registered source URL is absolute or explicitly internal (R-SRC-4)', () => {
  const reg = getRegister();
  for (const s of reg.sources.values()) {
    if (s.url) assert.match(s.url, /^https?:\/\//, `${s.ref} has a non-absolute URL`);
    else assert.match(s.url_raw || '', /internal|n\/a/i, `${s.ref} has neither a URL nor an internal marker`);
  }
});

test('register: no FAIL/CRITICAL checkpoint rests only on industry sources (R-SRC-3)', () => {
  const reg = getRegister();
  const weak = new Set(['INDUSTRY_STUDY', 'INDUSTRY_COMMENTARY']);
  const offenders = [];
  for (const [id, cp] of Object.entries(CHECKPOINTS)) {
    if (cp.status !== 'FAIL') continue;
    const res = reg.resolve(cp.check_id, { checkpoint: id, reasonCode: cp.reason_code });
    if (res.sources.length && res.sources.every((s) => weak.has(s.tier))) offenders.push(id);
  }
  assert.deepEqual(offenders, []);
});

test('register: the generated checkpoint table matches the register on disk', () => {
  const reg = getRegister();
  const drift = [];
  for (const [id, cp] of Object.entries(CHECKPOINTS)) {
    const live = reg.checkpoints.get(id);
    if (!live) drift.push(`${id} missing from register`);
    else if (live.reason_code !== cp.reason_code) drift.push(`${id} reason_code drift`);
  }
  assert.deepEqual(drift, []);
});

// ── Text and content helpers ──────────────────────────────────────────────
test('text: word counting is script-aware (E-6.1-5)', () => {
  assert.equal(wordCount('one two three'), 3);
  assert.equal(wordCount('  spaced   out  '), 2);
  assert.ok(wordCount('这是一个测试句子') >= 3); // CJK is not space-delimited
  assert.equal(wordCount(''), 0);
});

test('text: near-duplicate ratio', () => {
  assert.ok(levenshteinRatio('Pricing plans', 'Pricing plan') >= 0.9);
  assert.ok(levenshteinRatio('About us', 'Contact us') < 0.9);
});

test('structure: self-containment rejects unresolved openers (R-6.3-4)', () => {
  assert.equal(selfContained('It does this by caching responses.'), false);
  assert.equal(selfContained('This means latency drops.'), false);
  assert.equal(selfContained('As mentioned above, Acme caches responses.'), false);
  assert.equal(selfContained('Acme caches responses at the edge.'), true);
  assert.equal(selfContained(''), false);
});

// ── Structured-data entity resolution (regressions) ───────────────────────
// Each of these reproduced a false positive found while auditing a real site.

test('JSON-LD: nodes sharing an @id are merged into one entity', () => {
  const g = buildGraph([
    parseBlock('{"@type":"WebPage","@id":"https://e.com/","url":"https://e.com/","name":"Home","isPartOf":{"@id":"https://e.com/#website"}}'),
    parseBlock('{"@type":"WebPage","@id":"https://e.com/","primaryImageOfPage":{"@type":"ImageObject","url":"https://e.com/a.png"}}'),
  ]);
  const pages = g.nodes.filter((n) => typesOf(n.node).includes('WebPage'));
  assert.equal(pages.length, 1, 'the two fragments describe one entity');
  const node = pages[0].node;
  // The augmentation must not hide fields the full declaration carried.
  for (const f of ['@id', 'url', 'name', 'isPartOf', 'primaryImageOfPage']) {
    assert.ok(hasField(node, f) || node[f] !== undefined, `merged node lost ${f}`);
  }
});

test('JSON-LD: the most complete declaration wins on conflict', () => {
  const g = buildGraph([
    parseBlock('{"@type":"Organization","@id":"#org","name":"Acme","url":"https://acme.com","logo":"https://acme.com/l.png","sameAs":["https://x.com/acme"]}'),
    parseBlock('{"@type":"Organization","@id":"#org","name":"Acme"}'),
  ]);
  const orgs = g.nodes.filter((n) => typesOf(n.node).includes('Organization'));
  assert.equal(orgs.length, 1);
  assert.deepEqual(orgs[0].node.sameAs, ['https://x.com/acme']);
  assert.equal(orgs[0].node.logo, 'https://acme.com/l.png');
});

test('JSON-LD: a bare @id reference does not shadow the declared entity', () => {
  const g = buildGraph([
    parseBlock('{"@type":"Article","author":{"@id":"#p"},"publisher":{"@id":"#org"}}'),
    parseBlock('{"@type":"Person","@id":"#p","name":"Ada","url":"https://e.com/ada"}'),
  ]);
  assert.equal(danglingRefs(g).filter((d) => d.ref === '#p').length, 0, '#p resolves and is not dangling');
  assert.deepEqual(danglingRefs(g).map((d) => d.ref), ['#org'], 'only the undeclared #org dangles');
});

test('entity: a slogan h1 is not read as a competing name claim (E-2.3-8)', () => {
  assert.equal(isNameShaped('Wellows'), true);
  assert.equal(isNameShaped('Wellows wordmark logo'), true);
  assert.equal(isNameShaped('Acme Corp. Ltd'), true);
  assert.equal(isNameShaped('Ask AI about your category and a competitor comes back. Not you.'), false);
  assert.equal(isNameShaped('We build the future of search.'), false);
  assert.equal(isNameShaped('The complete platform for modern engineering teams everywhere'), false);
});

test('structure: chunk roots tile the page once, with no page-title chunk', () => {
  // One h1 title, two h2 sections, the second nesting two h3s.
  const sections = [
    { level: 1, index: 0 }, { level: 2, index: 1 }, { level: 2, index: 2 },
    { level: 3, index: 3 }, { level: 3, index: 4 },
  ];
  assert.deepEqual(chunkRoots(sections).map((s) => s.index), [1, 2], 'the h2s are the chunk roots');
  // Cards at h3 before any h2 must still be covered.
  const cards = [{ level: 1, index: 0 }, { level: 3, index: 1 }, { level: 3, index: 2 }, { level: 2, index: 3 }];
  assert.deepEqual(chunkRoots(cards).map((s) => s.index), [1, 2, 3], 'leading h3 cards are roots too');
  // A page with no title heading keeps every top-level section.
  assert.deepEqual(chunkRoots([{ level: 2, index: 0 }, { level: 2, index: 1 }]).map((s) => s.index), [0, 1]);
});

test('discovery: only real ISO 639-1 codes count as locale path prefixes (R-A0-7)', () => {
  // Section names that look like locales must not make a monolingual site "multilingual",
  // or the tool reports hreflang as missing where none is required.
  for (const seg of ['ai', 'vs', 'go', 'ui', 'ux', 'qa']) {
    assert.equal(ISO639_1.has(seg), false, `"${seg}" must not be treated as a language`);
  }
  for (const seg of ['en', 'de', 'es', 'fr', 'ja', 'zh', 'pt', 'nl']) {
    assert.equal(ISO639_1.has(seg), true, `"${seg}" is a valid ISO 639-1 code`);
  }
});

// ── Source attribution (R-SRC-6, F-SRC-2) ─────────────────────────────────
test('sources: each source carries its own statement, not one shared note', () => {
  const reg = getRegister();
  const r = reg.resolve('C-2.2', { checkpoint: 'C-2.2-g', reasonCode: 'METADESC_KEYWORD_LIST' });
  assert.ok(r.sources.length >= 2, 'more than one source is cited here');
  const notes = r.sources.map((s) => s.note);
  assert.equal(new Set(notes).size, notes.length, 'every source states what it itself establishes');
});

test('sources: a source that does not address the condition is not cited on it (F-SRC-2)', () => {
  const reg = getRegister();
  // A ~155-160 character length study says nothing about a keyword-list finding.
  const r = reg.resolve('C-2.2', { checkpoint: 'C-2.2-g', reasonCode: 'METADESC_KEYWORD_LIST' });
  assert.ok(!r.sources.some((s) => /character guidance/i.test(s.note || '')), 'length guidance is not cited on a keyword-list finding');
  assert.ok(r.also_registered.some((s) => s.ref === 'M2'), 'it is still named as registered for the factor');
  // The same applies to the title equivalent.
  const t = reg.resolve('C-2.1', { checkpoint: 'C-2.1-j', reasonCode: 'TITLE_KEYWORD_STUFFED' });
  assert.ok(!t.sources.some((s) => s.ref === 'M1'), 'title length guidance is not cited on keyword stuffing');
});

test('sources: authoritative tiers are never filtered out of a finding', () => {
  const reg = getRegister();
  const strong = new Set(['STANDARD', 'VENDOR_DOC', 'VENDOR_STATEMENT', 'TOOL_POLICY']);
  for (const [id, cp] of Object.entries(CHECKPOINTS)) {
    if (!cp.reason_code) continue;
    const r = reg.resolve(cp.check_id, { checkpoint: id, reasonCode: cp.reason_code });
    const droppedStrong = r.also_registered.filter((s) => strong.has(s.tier));
    assert.deepEqual(droppedStrong, [], `${id} dropped an authoritative source: ${droppedStrong.map((s) => s.ref).join(', ')}`);
  }
});

test('sources: every finding keeps at least one citation, and the headline link resolves', () => {
  const reg = getRegister();
  for (const [id, cp] of Object.entries(CHECKPOINTS)) {
    if (!cp.reason_code) continue;
    const r = reg.resolve(cp.check_id, { checkpoint: id, reasonCode: cp.reason_code });
    assert.ok(r.sources.length > 0, `${id} lost every source`);
    if (r.reference_url) assert.match(r.reference_url, /^https?:\/\//, `${id} headline link is not absolute`);
    // A tool-policy finding must not point at an external URL as if a vendor documented it.
    if (r.sources.every((s) => s.tier === 'TOOL_POLICY')) {
      assert.equal(r.reference_url, null, `${id} is tool policy but offers an external reference`);
    }
  }
});

test('sources: the condition and its scope are always stated', () => {
  const reg = getRegister();
  const r = reg.resolve('C-1.1', { checkpoint: 'C-1.1-b', reasonCode: 'ROBOTS_BLOCKS_GOOGLEBOT_SITEWIDE' });
  assert.equal(r.condition, 'Disallow: / applies to Googlebot (or to * with no Googlebot group)');
  assert.ok(['CONDITION', 'FACTOR'].includes(r.specificity));
  assert.equal(r.specificity, 'CONDITION', 'this row is registered against its own condition');
});
