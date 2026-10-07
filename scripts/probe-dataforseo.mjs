// Answers, empirically, the questions the DataForSEO docs do not: can it replace Chromium, and
// what does one page cost?
//
// Run it once credentials are set. It audits a page whose entire content is injected by script, so
// the answers are unambiguous: if the stored HTML carries the injected text, the capture is
// post-JavaScript and DataForSEO can stand in for the RENDERED profile. If it does not, it cannot,
// and no amount of configuration will change that.
//
//   DATAFORSEO_LOGIN=... DATAFORSEO_PASSWORD=... node scripts/probe-dataforseo.mjs [url]
//
// Nothing here is wired into the engine. It is a question, asked once.

import { loadConfig } from '../src/config.js';

const cfg = loadConfig({});
const { dataforseo_login: LOGIN, dataforseo_password: PASSWORD } = cfg.keys;

if (!LOGIN || !PASSWORD) {
  console.error('FAIL: set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD (see .env.example).');
  process.exit(1);
}

const AUTH = 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');
const TARGET = process.argv[2] || 'https://react.dev/';

async function call(path, body) {
  const t0 = Date.now();
  const res = await fetch(`https://api.dataforseo.com/v3${path}`, {
    method: 'POST',
    headers: { authorization: AUTH, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { http: res.status, ms: Date.now() - t0, json };
}

const show = (label, value) => console.log(`${label.padEnd(34)} ${value}`);

console.log(`\nProbing DataForSEO against ${TARGET}\n${'-'.repeat(68)}`);

// ── 1. Credentials and balance ──────────────────────────────────────────
const me = await fetch('https://api.dataforseo.com/v3/appendix/user_data', {
  headers: { authorization: AUTH },
}).then((r) => r.json()).catch(() => null);

const user = me?.tasks?.[0]?.result?.[0];
if (!user) {
  console.error('FAIL: credentials rejected, or user_data unavailable.');
  console.error(JSON.stringify(me, null, 1).slice(0, 600));
  process.exit(1);
}
show('credentials', 'OK');
show('balance (USD)', user.money?.balance ?? '?');
show('rate limit (calls/min)', user.rates?.limits?.minute ?? '?');

// ── 2. Without JavaScript: the raw profile ──────────────────────────────
const rawTask = await call('/on_page/instant_pages', [{
  url: TARGET,
  enable_javascript: false,
  store_raw_html: true,
  custom_user_agent: cfg.net.user_agent_resolved,
}]);

const rawItem = rawTask.json?.tasks?.[0]?.result?.[0]?.items?.[0];
console.log(`\n[RAW]  enable_javascript: false   (${rawTask.ms} ms)`);
if (!rawItem) {
  console.error('  no item returned:', JSON.stringify(rawTask.json?.tasks?.[0]?.status_message || rawTask.json).slice(0, 400));
} else {
  show('  status_code', rawItem.status_code);
  show('  resource_type', rawItem.resource_type);
  show('  title', JSON.stringify(rawItem.meta?.title || null));
  show('  plain text word count', rawItem.meta?.content?.plain_text_word_count ?? '?');
  show('  redirect chain reported', JSON.stringify(rawItem.checks?.is_redirect ?? null));
}
show('cost (USD)', rawTask.json?.tasks?.[0]?.cost ?? rawTask.json?.cost ?? '?');

// ── 3. With JavaScript: can it stand in for Chromium? ───────────────────
const renTask = await call('/on_page/instant_pages', [{
  url: TARGET,
  enable_javascript: true,
  enable_browser_rendering: true,
  browser_preset: 'mobile',
  store_raw_html: true,
  custom_user_agent: cfg.net.user_agent_resolved,
}]);

const renItem = renTask.json?.tasks?.[0]?.result?.[0]?.items?.[0];
console.log(`\n[RENDERED]  enable_javascript: true   (${renTask.ms} ms)`);
if (renItem) {
  show('  status_code', renItem.status_code);
  show('  plain text word count', renItem.meta?.content?.plain_text_word_count ?? '?');
  show('  LCP', renItem.page_timing?.largest_contentful_paint ?? '?');
}
show('cost (USD)', renTask.json?.tasks?.[0]?.cost ?? renTask.json?.cost ?? '?');

// ── 4. The decisive question: is the stored HTML post-JavaScript? ───────
async function rawHtml(label) {
  const r = await call('/on_page/raw_html', [{ url: TARGET }]);
  const html = r.json?.tasks?.[0]?.result?.[0]?.items?.[0]?.html;
  console.log(`\n[raw_html after ${label}]   (${r.ms} ms, cost ${r.json?.tasks?.[0]?.cost ?? '?'})`);
  if (!html) {
    console.log('  no HTML returned:', JSON.stringify(r.json?.tasks?.[0]?.status_message || '').slice(0, 300));
    return null;
  }
  show('  bytes', html.length);
  show('  has <script>', /<script/i.test(html));
  // The tell: text that only exists once scripts have run.
  const bodyText = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  show('  body words after tag strip', bodyText.split(' ').filter(Boolean).length);
  return { html, words: bodyText.split(' ').filter(Boolean).length };
}

const after = await rawHtml('the JavaScript-enabled call');

console.log(`\n${'-'.repeat(68)}\nVERDICT`);
if (!after) {
  console.log('  Could not retrieve stored HTML - store_raw_html may need a Task POST rather');
  console.log('  than instant_pages. Check the status_message above.');
} else {
  const rawWords = rawItem?.meta?.content?.plain_text_word_count ?? 0;
  const renWords = renItem?.meta?.content?.plain_text_word_count ?? 0;
  console.log(`  word count without JS: ${rawWords}`);
  console.log(`  word count with JS   : ${renWords}`);
  console.log(`  words in stored HTML : ${after.words}`);
  if (renWords > rawWords * 1.5) {
    console.log('  -> JavaScript execution demonstrably changes what DataForSEO sees.');
  } else {
    console.log('  -> No meaningful difference. Either this page is server-rendered (try a');
    console.log('     client-rendered URL), or JS execution is not affecting the capture.');
  }
  console.log('\n  Compare "words in stored HTML" against the two counts above: if it tracks the');
  console.log('  with-JS number, the stored HTML is post-render and can replace the RENDERED');
  console.log('  profile. If it tracks the without-JS number, it cannot.');
}
console.log();
