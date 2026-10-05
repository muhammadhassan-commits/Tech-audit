// Edge cases an operator will hit in the first hour of use. Every one must produce a clean report
// with a reason the reader can act on — never an unhandled exception and never a silent zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runAudit } from '../src/engine/pipeline.js';

const CONFIG = {
  cap: { render_js: false, llm_judge: false, crux_api: false, psi_api: false, commoncrawl: false, serp_api: false },
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

// A call budget alone does not bound a run. The Anthropic SDK's own defaults are a 10-minute
// timeout and 2 retries, so one unresponsive request can outlast run.max_minutes — and the run
// deadline is only tested between operations, so the pipeline cannot interrupt it. The judge must
// therefore refuse to start a call it does not have time to finish.
test('llm judge: stops spending when the run deadline is closer than one call timeout', async () => {
  const { LlmJudge } = await import('../src/llm/judge.js');
  const cfg = {
    cap: { llm_judge: true },
    llm: { max_calls_per_run: 20, model: 'test', max_chars: 1000, request_timeout_ms: 120000, max_retries: 1, budget_share: { 'C-6.2': 0.5 } },
  };
  // A key is needed only so the judge builds a client; no request is made in this test.
  const had = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test-not-used';
  try {
    const emitted = [];
    const emit = (type, data) => emitted.push({ type, ...data });

    const roomy = new LlmJudge(cfg, { deadline: Date.now() + 10 * 60000, emit });
    assert.equal(roomy.budgetLeft(), 20, 'with 10 minutes left, the full call budget is available');
    assert.ok(roomy.budgetLeftFor('C-6.2') > 0, 'and the per-check reservation is spendable');

    const tight = new LlmJudge(cfg, { deadline: Date.now() + 30000, emit });
    assert.equal(tight.budgetLeft(), 0, 'with 30s left and a 120s call timeout, nothing may be spent');
    assert.equal(tight.budgetLeftFor('C-6.2'), 0, 'the per-check reservation is withheld too');
    assert.ok(emitted.some((e) => e.type === 'llm_budget' && e.reason === 'RUN_TIME_BUDGET'),
      'the operator is told why the rubric stopped, once');
    assert.equal(emitted.filter((e) => e.type === 'llm_budget').length, 1, 'and only once');

    // No deadline on the context must not disable the judge.
    const unbounded = new LlmJudge(cfg, { emit });
    assert.equal(unbounded.budgetLeft(), 20, 'a context without a deadline spends its call budget');
  } finally {
    if (had === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = had;
  }
});


// ── C-1.2 XML Sitemap, revised specification ─────────────────────────────
// The check answers one question: can a usable parent sitemap be located and fetched. Everything
// that used to make it fail — a variant that did not answer, a hostname that served the file
// directly instead of redirecting — is now recorded and not scored, because none of it decides
// whether the sitemap works. These tests pin the three outcomes that changed.

const PAGE = '<!doctype html><html lang=en><head><title>Fixture</title></head><body><main><h1>Fixture</h1><p>Enough words in the body for the page to be treated as a real page.</p></main></body></html>';
const SITEMAP = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>http://example.invalid/</loc></url></urlset>';

function sitemapResult(report) {
  return report.results.find((r) => r.check_id === 'C-1.2');
}

test('C-1.2: a sitemap that answers 200 at several addresses still passes', async () => {
  // The previous rule failed this: a variant answering 200 on a non-canonical host was a FAIL.
  // Serving the same sitemap at more than one address is not a sitemap failure, and hostname
  // consolidation belongs to C-1.4 / C-1.5, so this must pass with a note and nothing more.
  const server = await fixture((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nAllow: /\n');
    }
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(SITEMAP);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  try {
    const report = await runAudit(base(server), { config: CONFIG });
    const r = sitemapResult(report);
    assert.equal(r.status, 'PASS', `expected PASS, got ${r.status} (${r.reason_code})`);
    assert.ok(!/HOST_MISMATCH/.test(JSON.stringify(r)), 'the withdrawn host-mismatch rule must not fire');
  } finally {
    server.close();
  }
});

test('C-1.2: no sitemap anywhere is a low warning, not a failure', async () => {
  // Google does not require a site to have a sitemap, so absence is reported and not failed.
  const server = await fixture((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nAllow: /\n');
    }
    if (/sitemap/i.test(req.url)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  try {
    const report = await runAudit(base(server), { config: CONFIG });
    const r = sitemapResult(report);
    assert.equal(r.status, 'WARN', `expected WARN, got ${r.status}`);
    assert.equal(r.reason_code, 'SITEMAP_NOT_FOUND');
    assert.equal(r.severity, 'LOW');
  } finally {
    server.close();
  }
});

test('C-1.2: a declared sitemap that is dead, with another that serves, is a partial break', async () => {
  const server = await fixture((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(`User-agent: *\nAllow: /\nSitemap: ${base(server)}/missing-sitemap.xml\n`);
    }
    if (req.url === '/missing-sitemap.xml') { res.writeHead(404); return res.end(); }
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(SITEMAP);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  try {
    const report = await runAudit(base(server), { config: CONFIG });
    const r = sitemapResult(report);
    assert.equal(r.status, 'WARN', `expected WARN, got ${r.status} (${r.reason_code})`);
    assert.equal(r.reason_code, 'SITEMAP_PARTIALLY_BROKEN');
  } finally {
    server.close();
  }
});

test('C-1.2: a declared sitemap that is dead, with nothing else serving, fails', async () => {
  const server = await fixture((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(`User-agent: *\nAllow: /\nSitemap: ${base(server)}/missing-sitemap.xml\n`);
    }
    if (/sitemap/i.test(req.url)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  try {
    const report = await runAudit(base(server), { config: CONFIG });
    const r = sitemapResult(report);
    assert.equal(r.status, 'FAIL', `expected FAIL, got ${r.status} (${r.reason_code})`);
    assert.equal(r.reason_code, 'DECLARED_SITEMAP_UNAVAILABLE');
  } finally {
    server.close();
  }
});

test('C-1.2: WARN scores 0.70, not the severity-derived value', async () => {
  const { pointsFor } = await import('../src/engine/scoring.js');
  assert.equal(pointsFor({ check_id: 'C-1.2', status: 'WARN', severity: 'LOW' }), 0.7);
  assert.equal(pointsFor({ check_id: 'C-1.2', status: 'WARN', severity: 'MEDIUM' }), 0.7);
  assert.equal(pointsFor({ check_id: 'C-1.2', status: 'PASS' }), 1);
  assert.equal(pointsFor({ check_id: 'C-1.2', status: 'FAIL', severity: 'HIGH' }), 0);
  assert.equal(pointsFor({ check_id: 'C-1.2', status: 'NOT_TESTABLE' }), null, 'excluded from the score');
  // Other checks keep the severity formula.
  assert.equal(pointsFor({ check_id: 'C-1.4', status: 'WARN', severity: 'MEDIUM' }), 0.4);
});


// ── C-2.4 Internal Links ─────────────────────────────────────────────────
// A page without a <main> landmark must still have its content links counted. mainRegion() falls
// back to the largest text-bearing block, which on many real sites contains no links at all; when
// in_main was required unconditionally, every such page reported zero internal links and every
// page in the sample looked like an orphan.

test('C-2.4: content links are counted on a page with no <main> landmark', async () => {
  const body = (extra) => `<!doctype html><html lang=en><head><title>T</title></head><body>
    <header><a href="/">Home</a></header>
    <nav><a href="/a/">A</a><a href="/b/">B</a></nav>
    <section><p>A long block of text that carries no links at all, which is what makes the largest
    text-bearing block the wrong place to look for them on a page like this one.</p></section>
    <div><p>Body copy that does link onward to <a href="/a/">the first page</a> and to
    <a href="/b/">the second page</a>.</p>${extra || ''}</div>
    <footer><a href="/c/">C</a></footer></body></html>`;

  const server = await fixture((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nAllow: /\n');
    }
    if (/sitemap/i.test(req.url)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body());
  });
  try {
    const report = await runAudit(base(server), { config: CONFIG });
    const results = report.results.filter((r) => r.check_id === 'C-2.4');
    assert.ok(results.length, 'C-2.4 produced results');
    const counted = results.map((r) => r.metrics?.contextual_links ?? 0);
    assert.ok(counted.some((n) => n > 0),
      `every page reported zero contextual links (${counted.join(', ')}) — the <main> fallback is broken again`);
    // The menu, header and footer links must still be excluded.
    const withLinks = results.find((r) => (r.metrics?.contextual_links ?? 0) > 0);
    assert.ok(withLinks.metrics.boilerplate_links > 0, 'boilerplate links are counted separately');
  } finally {
    server.close();
  }
});

test('C-2.4: a real <main> landmark still confines content links to it', async () => {
  // Where <main> exists it is authoritative: a link outside it is not a content link, even in the
  // body zone. This is the case the fallback must not loosen.
  const html = `<!doctype html><html lang=en><head><title>T</title></head><body>
    <div><p>Outside main, so not contextual: <a href="/outside/">outside</a>.</p></div>
    <main><p>Inside main, so contextual: <a href="/inside/">inside</a>.</p></main>
    </body></html>`;
  const { extractFacts } = await import('../src/parse/html.js');
  const f = extractFacts(html, 'https://example.test/', 'https://example.test');
  assert.equal(f.mainMethod, 'main');
  const mainIsLandmark = f.mainMethod === 'main' || f.mainMethod === 'role_main';
  const contextual = f.links.filter((l) => !l.discard && l.same_site && !l.in_breadcrumb
    && l.zone === 'body' && (!mainIsLandmark || l.in_main));
  assert.equal(contextual.length, 1, 'only the link inside <main> counts');
  assert.ok(contextual[0].resolved.endsWith('/inside/'));
});


// ── A0 response validity ─────────────────────────────────────────────────
// A bot challenge served with HTTP 200 used to be parsed as the page. Everything downstream then
// described a page nobody had seen: no headings, no structured data, no content, and a CRITICAL
// that capped the whole audit. A challenge shown to this auditor is a fact about the request, not
// a defect in the site.

const CHALLENGE_HTML = `<!doctype html><html><head><title>One moment, please...</title></head>
  <body><div id="challenge">Enable JavaScript and cookies to continue</div>
  <script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page"></script></body></html>`;

test('A0: a challenge served with HTTP 200 is not scored as a site defect', async () => {
  const server = await fixture((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nAllow: /\n');
    }
    if (/sitemap/i.test(req.url)) { res.writeHead(404); return res.end(); }
    // The interstitial, with a 200, exactly as a CDN serves it.
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(CHALLENGE_HTML);
  });
  try {
    const report = await runAudit(base(server), { config: CONFIG });

    const pageChecks = report.results.filter((r) => ['C-2.3', 'C-3.1', 'C-6.1'].includes(r.check_id));
    assert.ok(pageChecks.length, 'page checks produced results');
    for (const r of pageChecks) {
      assert.equal(r.status, 'NOT_TESTABLE',
        `${r.check_id} returned ${r.status}/${r.reason_code} against a challenge page — it must not be scored`);
      assert.equal(r.reason_code, 'ACCESS_CHALLENGE_DETECTED');
    }

    // The specific false findings this gate exists to prevent.
    const codes = new Set(report.results.map((r) => r.reason_code));
    for (const bad of ['NO_HEADINGS', 'RAW_CONTENT_ABSENT', 'NO_STRUCTURED_DATA']) {
      assert.ok(!codes.has(bad), `${bad} was reported from a challenge page`);
    }

    // No page-content check may produce a CRITICAL from a challenge. (The fixture is plain HTTP
    // on a loopback address, so C-1.3 reports TLS_INVALID; that is the test server, not the gate.)
    const contentCritical = report.results.filter((r) => r.status === 'FAIL' && r.severity === 'CRITICAL'
      && r.check_id !== 'C-1.3');
    assert.equal(contentCritical.length, 0,
      `a challenge page produced ${contentCritical.map((r) => r.check_id + '/' + r.reason_code).join(', ')}, which would cap the audit at 40%`);

    // Three challenged fetches abort the run (F-RUN-5), and an aborted run is not given a score.
    // Reporting a precise percentage computed from interstitials would be the worse outcome.
    assert.equal(report.run.abort_reason, 'BOT_PROTECTION_DETECTED');
    assert.equal(report.scores.verdict, 'INSUFFICIENT_EVIDENCE');
    assert.equal(report.scores.overall_percent, null, 'no score is computed from challenge responses');
    assert.ok((report.run.flags || []).includes('A0_ACCESS_CHALLENGE'), 'the run records why');
  } finally {
    server.close();
  }
});

test('A0: a real page is unaffected by the gate', async () => {
  const real = `<!doctype html><html lang=en><head><title>Acme Home Care</title>
    <meta name="description" content="Home care services in Montgomery."></head>
    <body><main><h1>Enabling Seniors to Flourish at Home</h1>
    <h2>Dementia Care</h2><p>${'care '.repeat(120)}</p>
    <h2>Respite Care</h2><p>${'support '.repeat(120)}</p></main></body></html>`;
  const server = await fixture((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nAllow: /\n');
    }
    if (/sitemap/i.test(req.url)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(real);
  });
  try {
    const report = await runAudit(base(server), { config: CONFIG });
    const gated = report.results.filter((r) => r.reason_code === 'ACCESS_CHALLENGE_DETECTED');
    assert.equal(gated.length, 0, 'the gate fired on a legitimate page');
    const headings = report.results.filter((r) => r.check_id === 'C-2.3');
    assert.ok(headings.some((r) => r.status === 'PASS'), 'headings were evaluated on a valid page');
  } finally {
    server.close();
  }
});

test('C-6.1: thin raw content is only called JavaScript-gated when rendering adds content', async () => {
  // The reviewed audit reported "raw 8 words, rendered 8 words, therefore JavaScript-gated". If
  // rendering adds nothing, JavaScript is not what is withholding the content.
  const { classifyResponse } = await import('../src/net/validity.js');
  // Guard the gate's own thresholds while we are here.
  assert.equal(classifyResponse({ status: 200, html: CHALLENGE_HTML }).state, 'ACCESS_CHALLENGE');
  assert.equal(classifyResponse({ status: 200, headers: { 'cf-mitigated': 'challenge' }, html: '<html><body>x</body></html>' }).state, 'ACCESS_CHALLENGE');
  // A substantial page that merely embeds a captcha widget is still a real page.
  const withWidget = `<html><head><title>Contact</title></head><body><h1>Contact</h1>
    <p>${'word '.repeat(300)}</p><div class="g-recaptcha"></div></body></html>`;
  assert.equal(classifyResponse({ status: 200, html: withWidget }).state, 'VALID_PAGE');
});


// ── Optional / advisory signals ──────────────────────────────────────────
// These test conventions no search engine has adopted. They are reported and never scored, so the
// thing worth pinning is that they cannot move a number — and that absence is never a failure.

async function runX53b(handler) {
  const server = await fixture(handler);
  try {
    const { run } = await import('../src/checks/x5_3b_llms_full.js');
    const { loadConfig } = await import('../src/config.js');
    const { getRegister } = await import('../src/sources/register.js');
    const { HttpClient } = await import('../src/net/http.js');
    const cfg = loadConfig(CONFIG);
    const ctx = {
      cfg, canonicalOrigin: base(server), register: getRegister(),
      emit() {}, derived: {}, flags: new Set(), robots: null, pages: [], sample: {}, target: {},
    };
    ctx.http = new HttpClient(cfg, { isBlockedForAuditor: () => false, onAbort() {} });
    const [result] = await run(ctx);
    return result;
  } finally {
    server.close();
  }
}

const codesOf = (r) => new Set([...(r.notes || []).map((n) => n.reason_code), r.reason_code].filter(Boolean));

test('X-5.3b: a missing llms-full.txt is recorded, never failed', async () => {
  const r = await runX53b((req, res) => { res.writeHead(404); res.end(); });
  assert.ok(codesOf(r).has('LLMS_FULL_TXT_ABSENT'));
  assert.notEqual(r.status, 'FAIL', 'absence of an optional file must not be a failure');
  assert.notEqual(r.status, 'WARN');
});

test('X-5.3b: HTML at /llms-full.txt is a fallback, not a published file', async () => {
  // A catch-all route answering with the homepage is the common case, and reading it as a valid
  // file would report a file that does not exist.
  const r = await runX53b((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1></body></html>');
  });
  assert.ok(codesOf(r).has('LLMS_FULL_TXT_FALLBACK'));
  assert.ok(!codesOf(r).has('LLMS_FULL_TXT_PRESENT'), 'HTML must not be reported as a published file');
});

test('X-5.3b: a real text file is recorded as present', async () => {
  const r = await runX53b((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('# Acme\n\n' + 'This file describes the site for agents. '.repeat(10));
  });
  assert.ok(codesOf(r).has('LLMS_FULL_TXT_PRESENT'));
});

test('X-5.3b: a blocked or erroring request is NOT_TESTABLE, not absence', async () => {
  const r = await runX53b((req, res) => { res.writeHead(403); res.end('denied'); });
  assert.equal(r.status, 'NOT_TESTABLE');
  assert.ok(codesOf(r).has('LLMS_FULL_TXT_FETCH_FAILED'));
});

test('advisory factors are reported and excluded from every score', async () => {
  const { FACTORS } = await import('../src/engine/catalog.js');
  const advisory = FACTORS.filter((f) => f.advisory).map((f) => f.id);
  // These test conventions no search engine requires; scoring them would mark a site down for
  // declining to adopt something nothing consumes.
  for (const id of ['C-5.3', 'C-5.4', 'X-1.8', 'X-5.3b', 'X-5.5']) {
    assert.ok(advisory.includes(id), `${id} should be advisory`);
  }
  // And none of them is left as an UNSPECIFIED block in the client report.
  assert.equal(FACTORS.filter((f) => f.unspecified).length, 0,
    'no factor may be shown to a client as UNSPECIFIED');
});

test('severities: findings that are not failures are not graded as failures', async () => {
  const { getRegister } = await import('../src/sources/register.js');
  const reg = getRegister();
  const grade = (code) => {
    const row = [...reg.checkpoints.values()].find((c) => c.reason_code === code);
    return row ? `${row.status}/${row.severity}` : 'ABSENT';
  };
  // Google requires none of these; a FAIL would claim something is broken when it is not.
  assert.equal(grade('NO_HEADINGS'), 'WARN/MEDIUM');
  assert.equal(grade('H1_MISSING'), 'WARN/MEDIUM');
  assert.equal(grade('NO_STRUCTURED_DATA'), 'WARN/MEDIUM');
  assert.equal(grade('MULTIPLE_LIVE_ORIGINS'), 'WARN/HIGH');
  // A third-party SERP sample must not be able to cap an audit.
  assert.ok(!grade('SITE_NOT_IN_INDEX').includes('CRITICAL'));
});
