// Register rows for the two checks that were previously shown to clients as UNSPECIFIED.
//
// Both are advisory: reported, never scored. The rows say what each signal does and does not
// establish, because the temptation with both is to read more into them than they carry.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip, writeZip, rowXml } from './lib/workbook.mjs';
import { getRegister } from '../src/sources/register.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'technicalaudittoolPRD_v2_source_register.xlsx');
const OUT = process.env.REGISTER_OUT || FILE;
const SHEET = 'xl/worksheets/sheet4.xml';
const SOURCES_SHEET = 'xl/worksheets/sheet2.xml';
const FACTORS_SHEET = 'xl/worksheets/sheet3.xml';

const CC_URL = 'https://commoncrawl.org/';
const L1_URL = 'https://llmstxt.org/';

// Ref | Publisher | Document | URL | Source class | URL verified | What it supports
const NEW_SOURCES = [
  ['CC', 'Common Crawl', 'Common Crawl open web archive', CC_URL,
    'Third-party archive — not a search index', 'Yes',
    'An open repository of web crawl data. Supports one inference: a URL was captured in a given crawl. It documents nothing about search ranking, indexing, model training, or whether any assistant will cite a page.'],
];

const NEW_FACTORS = [
  ['X-5.3b', 'LLms-full.txt', 'SECTION 5 — LLM / AI ACCESS', '4.0',
    'L1, TP', L1_URL, 'Proposed — not adopted',
    'llms-full.txt is not part of the llms.txt proposal and no search engine consumes it. Reported as information only; there is no requirement for it to meet.'],
  ['X-5.5', 'Common Crawl presence', 'SECTION 5 — LLM / AI ACCESS', '4.0',
    'CC, TP', CC_URL, 'Third-party archive — not a search index',
    'Presence in an open web archive. Reported as information only. Treating it as an AI-visibility or SEO outcome would claim more than the archive supports.'],
];

// Factor | Checkpoint | Condition | Status | Severity | reason_code | refs | URL | class | set by | note
const NEW_CHECKPOINTS = [
  ['X-5.3b', 'X-5.3b-a', '/llms-full.txt returns 200 with substantive non-HTML text', 'PASS', '—', 'LLMS_FULL_TXT_PRESENT',
    'L1, TP', L1_URL, 'Proposed — not adopted', 'Tool policy',
    'Advisory. The file is published. No search engine consumes it, so this records a fact rather than a requirement met. The 20-word substantiveness floor is tool policy.'],
  ['X-5.3b', 'X-5.3b-b', '/llms-full.txt returns 404 or 410', 'PASS', '—', 'LLMS_FULL_TXT_ABSENT',
    'L1, TP', L1_URL, 'Proposed — not adopted', 'Tool policy',
    'Advisory. Absence is not a defect: nothing requires this file. A clean 404 is the correct answer for a site that does not publish one.'],
  ['X-5.3b', 'X-5.3b-c', '/llms-full.txt returns 200 with HTML, or with almost no content', 'PASS', '—', 'LLMS_FULL_TXT_FALLBACK',
    'L1, TP', L1_URL, 'Proposed — not adopted', 'Tool policy',
    'Advisory. The server answered with a page instead of saying the file is absent, so no llms-full.txt is published. Distinguished from a real file so the two are not confused.'],
  ['X-5.3b', 'X-5.3b-d', 'The request did not resolve: no response, 403, 429, 5xx, or a bot challenge', 'NOT_TESTABLE', '—', 'LLMS_FULL_TXT_FETCH_FAILED',
    'L1, TP', L1_URL, 'Proposed — not adopted', 'Tool policy',
    'Advisory. A request that did not resolve says nothing about whether the file exists.'],

  ['X-5.5', 'X-5.5-a', 'The registrable domain appears in the latest Common Crawl index', 'PASS', '—', 'COMMON_CRAWL_PRESENT',
    'CC, TP', CC_URL, 'Third-party archive — not a search index', 'Tool policy',
    'Advisory. Confirms a URL from the domain was captured in that crawl, and nothing further: not training, not citation, not search visibility, not current crawler access.'],
  ['X-5.5', 'X-5.5-b', 'Not in the latest index, but present in one of the previous two releases', 'PASS', '—', 'COMMON_CRAWL_PRESENT_RECENTLY',
    'CC, TP', CC_URL, 'Third-party archive — not a search index', 'Tool policy',
    'Advisory. Coverage varies between releases, so absence from the newest one is not evidence of a change on the site. Checking three releases rather than the whole archive is tool policy, to keep an initial audit fast.'],
  ['X-5.5', 'X-5.5-c', 'No capture in the latest three Common Crawl releases', 'PASS', '—', 'COMMON_CRAWL_NOT_FOUND_RECENT',
    'CC, TP', CC_URL, 'Third-party archive — not a search index', 'Tool policy',
    'Advisory, and never a failure. Common Crawl samples the web rather than covering it, so absence is not evidence that a site is unreachable, unindexed or invisible to assistants.'],
  ['X-5.5', 'X-5.5-d', 'The Common Crawl index did not answer: 429, 5xx, timeout, network failure, or invalid JSON', 'NOT_TESTABLE', '—', 'COMMON_CRAWL_API_UNAVAILABLE',
    'CC, TP', CC_URL, 'Third-party archive — not a search index', 'Tool policy',
    'Advisory. The CDX API answers 503/504 under load often enough that one retry with backoff is built in. An API that still did not answer says nothing about the domain, and must not be reported as absence.'],
];

const reg = getRegister();
const knownAfter = new Set([...reg.sources.keys(), ...NEW_SOURCES.map((s) => s[0])]);
for (const row of [...NEW_FACTORS, ...NEW_CHECKPOINTS]) {
  const refsCell = row.length > 8 ? row[6] : row[4];
  for (const ref of String(refsCell).split(',').map((r) => r.trim()).filter(Boolean)) {
    if (!knownAfter.has(ref)) {
      console.error(`\n  Refusing to write: ${row[1]} cites "${ref}", which is not a registered source.\n`);
      process.exit(1);
    }
  }
}

const entries = readZip(fs.readFileSync(FILE));
function append(sheetName, rows) {
  const sheet = entries.find((e) => e.name === sheetName);
  if (!sheet) throw new Error(`${sheetName} not found`);
  let xml = sheet.data.toString('utf8');
  const marker = '</sheetData>';
  const used = [...xml.matchAll(/<row r="(\d+)"[^>]*>[\s\S]*?<\/row>/g)].map((m) => Number(m[1]));
  let n = (used.length ? Math.max(...used) : 1) + 1;
  const built = [];
  for (const values of rows) {
    xml = xml.replace(new RegExp(`<row r="${n}"[^>]*/>`), '');
    built.push(rowXml(n, values));
    n++;
  }
  xml = xml.slice(0, xml.indexOf(marker)) + built.join('') + xml.slice(xml.indexOf(marker));
  const after = [...xml.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]));
  const dupes = [...new Set(after.filter((x, i) => after.indexOf(x) !== i))];
  if (dupes.length) throw new Error(`duplicate rows in ${sheetName}: ${dupes.join(', ')}`);
  sheet.data = Buffer.from(xml, 'utf8');
}

append(SOURCES_SHEET, NEW_SOURCES);
append(FACTORS_SHEET, NEW_FACTORS);
append(SHEET, NEW_CHECKPOINTS);
fs.writeFileSync(OUT, writeZip(entries));

console.log(`  wrote ${path.basename(OUT)}`);
console.log(`    sources     +${NEW_SOURCES.length}  (${NEW_SOURCES.map((s) => s[0]).join(', ')})`);
console.log(`    factors     +${NEW_FACTORS.length}  (${NEW_FACTORS.map((f) => f[0]).join(', ')})`);
console.log(`    checkpoints +${NEW_CHECKPOINTS.length}`);
