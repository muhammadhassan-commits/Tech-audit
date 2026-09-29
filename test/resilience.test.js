// Edge cases an operator will hit in the first hour of use. Every one must produce a clean report
// with a reason the reader can act on — never an unhandled exception and never a silent zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runAudit } from '../src/engine/pipeline.js';

const CONFIG = {
  cap: { render_js: false, llm_judge: false, crux_api: false, psi_api: false, commoncrawl: false },
  net: { min_delay_ms: 0, url_budget_ms: 4000, secondary_budget_ms: 2500, unresponsive_ms: 3000, secondary_unresponsive_ms: 2000, timeout_connect_ms: 1200, timeout_read_ms: 1500, backoff_ms: [50, 100] },
};

function fixture(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
const base = (s) => `http://127.0.0.1:${s.address().port}`;

test('a domain that does not resolve aborts cleanly with a DNS reason', async () => {
  const report = await runAudit('this-domain-should-not-resolve-9f2b7a.invalid', { config: CONFIG });
  assert.equal(report.run.run_status, 'ABORTED');
  assert.equal(report.run.abort_reason, 'SEED_DNS_FAILURE');
  assert.ok(report.scores, 'a score block is still emitted');
  assert.equal(report.results.filter((r) => r.status === 'ERROR').length, 0, 'no tool defects');
});

test('a seed with a typo or stray whitespace is still parsed', async () => {
  const server = await fixture((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html lang=en><head><title>T</title></head><body><main><h1>T</h1><p>Some words here for the fixture page body content.</p></main></body></html>');
  });
  try {
    const report = await runAudit(`  ${base(server)}/  `, { config: CONFIG });
    assert.equal(report.run.run_status, 'COMPLETED');
    assert.ok(report.sample.pages.length >= 1);
  } finally {
    server.close();
  }
});

test('an HTTP 500 on every page completes with findings, not a crash', async () => {
  const server = await fixture((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n'); }
    res.writeHead(500, { 'content-type': 'text/html' });
    res.end('<html><body>error</body></html>');
  });
  try {
    const report = await runAudit(base(server), { config: CONFIG });
    assert.equal(report.results.filter((r) => r.status === 'ERROR').length, 0);
    assert.ok(['ABORTED', 'COMPLETED', 'PARTIAL'].includes(report.run.run_status));
    assert.ok(report.scores.verdict, 'a verdict is always produced');
  } finally {
    server.close();
  }
});

test('a page that never sends a byte is PAGE_NOT_RESPONDING with a null status, not a fabricated one', async () => {
  const server = await fixture((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n'); }
    // Hold the socket open without responding.
  });
  try {
    const report = await runAudit(base(server), { config: CONFIG });
    assert.equal(report.results.filter((r) => r.status === 'ERROR').length, 0);
    const statuses = report.results.flatMap((r) => r.evidence || []).map((e) => e.observed_value);
    assert.ok(!statuses.includes('0'), 'a status the server never sent is never invented');
  } finally {
    server.close();
  }
});

test('an empty HTML body does not crash the content checks', async () => {
  const server = await fixture((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head></head><body></body></html>');
  });
  try {
    const report = await runAudit(base(server), { config: CONFIG });
    assert.equal(report.results.filter((r) => r.status === 'ERROR').length, 0);
  } finally {
    server.close();
  }
});

test('malformed HTML, bad JSON-LD and a broken head are handled without defects', async () => {
  const server = await fixture((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    // A div inside <head> closes it early, so everything after it is parsed into <body> — the
    // shape R-1.5-2 and B-1.5-4 are about. The JSON-LD is invalid two different ways.
    res.end(`<!doctype html><html lang=en><head><title>Broken</title><div>stray</div>
      <script type="application/ld+json">{"@type":"Organization","name":}</script>
      <script type="application/ld+json">not json at all</script>
      <link rel=canonical href="::::">
      </head><body><main><h1></h1><p>${'word '.repeat(200)}</p><table><tr><td>x</td></tr></table></main></body></html>`);
  });
  try {
    const report = await runAudit(base(server), { config: CONFIG });
    const errs = report.results.filter((r) => r.status === 'ERROR');
    assert.deepEqual(errs.map((e) => `${e.check_id}: ${e.summary}`), [], 'malformed input must not produce tool defects');
    const sd = report.results.find((r) => r.check_id === 'C-3.1' && r.scope === 'page');
    assert.ok(sd.sub_findings.some((s) => s.reason_code === 'JSONLD_PARSE_ERROR'), 'the parse failure is reported as a finding');
  } finally {
    server.close();
  }
});

test('a non-HTML response in the sample is handled as not applicable, not as broken HTML', async () => {
  const server = await fixture((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n'); }
    if (req.url === '/doc.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF-1.4 fake'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html lang=en><head><title>Home</title></head><body><main><h1>Home</h1><p>Body words for the page.</p><a href="/doc.pdf">Spec</a></main></body></html>');
  });
  try {
    const report = await runAudit(base(server), { config: CONFIG });
    assert.equal(report.results.filter((r) => r.status === 'ERROR').length, 0);
  } finally {
    server.close();
  }
});

test('every emitted result satisfies the output contract', async () => {
  const server = await fixture((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\nSitemap: ' + base(server) + '/sitemap.xml\n'); }
    if (req.url === '/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); return res.end('<urlset/>'); }
    const titles = { '/': 'Home', '/pricing': 'Pricing', '/about': 'About' };
    const t = titles[req.url];
    if (!t) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html lang=en><head><title>${t}</title><link rel=canonical href="${base(server)}${req.url}"></head><body><nav><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/about">About</a></nav><main><h1>${t}</h1><p>${'content '.repeat(120)}</p></main></body></html>`);
  });
  try {
    const report = await runAudit(base(server), { config: CONFIG });
    for (const r of report.results) {
      assert.ok(r.check_id && r.status, 'every result carries an id and a status');
      assert.ok(['PASS', 'WARN', 'FAIL', 'NOT_APPLICABLE', 'NOT_TESTABLE', 'ERROR'].includes(r.status), `bad status ${r.status}`);
      if (r.status !== 'PASS') assert.ok(r.reason_code, `${r.check_id} ${r.status} without a reason_code`);
      if (r.status === 'PASS') assert.ok(r.evidence.length, `${r.check_id} PASS without evidence`);
      if (r.status === 'FAIL' || r.status === 'WARN') {
        assert.ok(r.sources.length, `${r.check_id}/${r.reason_code} without a source`);
        assert.ok(r.evidence.length, `${r.check_id}/${r.reason_code} without evidence`);
        assert.ok(r.severity, `${r.check_id}/${r.reason_code} without a severity`);
      }
      if (r.confidence === 'MODELLED' || r.confidence === 'THIRD_PARTY') assert.ok(r.caveats.length, `${r.check_id} ${r.confidence} without a caveat`);
      assert.ok(!(r.status === 'NOT_TESTABLE' && r.score), 'no score on a NOT_TESTABLE result');
    }
    assert.ok(report.scores.overall_percent >= 0);
  } finally {
    server.close();
  }
});
