// End-to-end gate tests against a local fixture site: the pipeline must begin at robots.txt and,
// when that check does not complete successfully, halt every remaining factor (operator directive),
// or fall back to control-file-only mode under the PRD's own F-RUN-6 / F-RUN-8 rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runAudit } from '../src/engine/pipeline.js';
import { FACTORS } from '../src/engine/catalog.js';

const PAGE = (title, body = '') => `<!doctype html><html lang="en"><head><title>${title}</title>
<link rel="canonical" href="https://SELF"><meta name="description" content="${title} description for the fixture site."></head>
<body><header><nav><a href="/">Home</a> <a href="/pricing">Pricing</a> <a href="/about">About</a></nav></header>
<main><h1>${title}</h1>${body || `<p>${title} content for the fixture site, long enough to be extracted by the content checks without tripping the thin-content threshold.</p>`}</main>
<footer><p>© 2026 Fixture</p></footer></body></html>`;

function startFixture(robotsHandler) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/robots.txt') return robotsHandler(req, res);
    const titles = { '/': 'Fixture Home', '/pricing': 'Pricing', '/about': 'About' };
    const title = titles[url.pathname];
    if (!title) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end(PAGE('Not found'));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE(title).replace('https://SELF', `http://127.0.0.1:${server.address().port}${url.pathname}`));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const CONFIG = { cap: { render_js: false, llm_judge: false, crux_api: false, psi_api: false, commoncrawl: false }, net: { min_delay_ms: 0, secondary_budget_ms: 4000, url_budget_ms: 6000, secondary_unresponsive_ms: 3000, unresponsive_ms: 5000 } };

test('gate: a 5xx robots.txt halts every other factor in strict mode', async () => {
  const server = await startFixture((req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('unavailable');
  });
  try {
    const report = await runAudit(`http://127.0.0.1:${server.address().port}`, { config: { ...CONFIG, gate: { robots_mode: 'strict' } } });
    assert.equal(report.run.gate.passed, false);
    assert.equal(report.run.gate.reason_code, 'ROBOTS_UNAVAILABLE');
    assert.equal(report.run.run_status, 'ABORTED');
    const robots = report.results.find((r) => r.check_id === 'C-1.1');
    assert.equal(robots.status, 'FAIL');
    assert.equal(robots.severity, 'CRITICAL');
    // Every other factor is present, marked not-testable, and explicitly flagged as halted.
    const others = report.results.filter((r) => r.check_id !== 'C-1.1');
    assert.equal(others.length, FACTORS.filter((f) => !f.unspecified).length - 1);
    assert.ok(others.every((r) => r.status === 'NOT_TESTABLE' && r.halted === true));
    // No scoring survives the halt, and the verdict is BLOCKED.
    assert.equal(report.scores.verdict, 'BLOCKED');
    assert.ok(report.headlines.some((h) => /halted at the robots\.txt gate/i.test(h.summary)));
    // The run performed no page fetches after the gate.
    assert.equal(report.sample.pages.length, 0);
  } finally {
    server.close();
  }
});

test('gate: PRD mode keeps control-file checks running after an unavailable robots.txt', async () => {
  const server = await startFixture((req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('boom');
  });
  try {
    const report = await runAudit(`http://127.0.0.1:${server.address().port}`, { config: { ...CONFIG, gate: { robots_mode: 'prd' } } });
    assert.equal(report.run.gate.passed, false);
    assert.ok(report.run.flags.includes('ROBOTS_UNAVAILABLE_CONSERVATIVE_MODE'));
    const sitemap = report.results.find((r) => r.check_id === 'C-1.2');
    const llms = report.results.find((r) => r.check_id === 'C-5.3');
    assert.ok(!sitemap.halted, 'C-1.2 is a control-file check and must still run');
    assert.ok(!llms.halted, 'C-5.3 is a control-file check and must still run');
    const pageCheck = report.results.find((r) => r.check_id === 'C-2.1');
    assert.equal(pageCheck.status, 'NOT_TESTABLE');
    assert.equal(pageCheck.halted, true);
  } finally {
    server.close();
  }
});

test('gate: a 404 robots.txt passes the gate and unlocks the checklist', async () => {
  const server = await startFixture((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  try {
    const report = await runAudit(`http://127.0.0.1:${server.address().port}`, { config: { ...CONFIG, gate: { robots_mode: 'strict' } } });
    assert.equal(report.run.gate.passed, true);
    assert.equal(report.run.gate.reason_code, 'ROBOTS_ABSENT_TREATED_AS_ALLOW_ALL');
    assert.equal(report.run.run_status, 'COMPLETED');
    assert.ok(report.sample.pages.length >= 1, 'discovery must run once the gate passes');
    assert.ok(report.results.some((r) => r.check_id === 'C-2.1' && r.status === 'PASS'));
    assert.ok(!report.results.some((r) => r.halted));
  } finally {
    server.close();
  }
});

test('gate: Disallow: / for Googlebot fails the gate as CRITICAL and halts in strict mode', async () => {
  const server = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('User-agent: *\nDisallow: /\n');
  });
  try {
    const report = await runAudit(`http://127.0.0.1:${server.address().port}`, { config: { ...CONFIG, gate: { robots_mode: 'strict' } } });
    const robots = report.results.find((r) => r.check_id === 'C-1.1');
    assert.equal(robots.reason_code, 'ROBOTS_BLOCKS_GOOGLEBOT_SITEWIDE');
    assert.equal(robots.severity, 'CRITICAL');
    assert.equal(report.run.gate.passed, false);
    assert.equal(report.scores.verdict, 'BLOCKED');
    assert.ok(report.results.filter((r) => r.check_id !== 'C-1.1').every((r) => r.halted === true));
  } finally {
    server.close();
  }
});

test('pipeline: a healthy robots.txt runs discovery, sampling and every section', async () => {
  const server = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('User-agent: *\nAllow: /\nDisallow: /private/\n\nUser-agent: GPTBot\nDisallow: /\n');
  });
  try {
    const report = await runAudit(`http://127.0.0.1:${server.address().port}`, { config: { ...CONFIG, gate: { robots_mode: 'strict' } } });
    assert.equal(report.run.gate.passed, true);
    assert.equal(report.run.run_status, 'COMPLETED');
    assert.ok(report.sample.pages.length >= 2, 'multi-page fixture must yield more than the homepage');
    assert.equal(report.target.site_shape, 'multi_page');
    // Every specified factor produced a result.
    for (const f of FACTORS.filter((x) => !x.unspecified)) {
      assert.ok(report.results.some((r) => r.check_id === f.id), `${f.id} produced no result`);
    }
    // GPTBot blocked site-wide is a training-agent licensing decision, reported not failed.
    const ai = report.results.find((r) => r.check_id === 'C-5.1');
    assert.ok(['PASS', 'WARN'].includes(ai.status), `C-5.1 was ${ai.status}`);
    // No tool defects.
    assert.deepEqual(report.results.filter((r) => r.status === 'ERROR').map((r) => `${r.check_id}: ${r.summary}`), []);
    // Every finding carries at least one source and every FAIL carries evidence.
    for (const r of report.results) {
      if (r.status === 'FAIL' || r.status === 'WARN') {
        assert.ok(r.sources.length > 0, `${r.check_id}/${r.reason_code} has no source`);
        assert.ok(r.evidence.length > 0, `${r.check_id}/${r.reason_code} has no evidence`);
      }
      if (r.status === 'PASS') assert.ok(r.evidence.length > 0, `${r.check_id} PASS without evidence`);
      if (r.status !== 'PASS') assert.ok(r.reason_code, `${r.check_id} ${r.status} without a reason_code`);
    }
  } finally {
    server.close();
  }
});
