// Register changes that follow from the A0 response-validity gate and the C-6.1 logic fix.
//
// Rows are addressed by the checkpoint id in column B, never by sheet row number: sheet numbers are
// not positions, and addressing by number is how C-1.2-k was destroyed earlier.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip, writeZip, rowXml } from './lib/workbook.mjs';
import { getRegister } from '../src/sources/register.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'technicalaudittoolPRD_v2_source_register.xlsx');
const OUT = process.env.REGISTER_OUT || FILE;
const SHEET = 'xl/worksheets/sheet4.xml';

const JS_SEO = 'https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics';
const GSO = 'https://support.google.com/websearch/answer/2466433';

// New row: raw is thin and rendering does not change that.
const ADD = [
  ['C-6.1', 'C-6.1-p',
    'Main content < 50 words in RAW on a page that passed the A0 validity gate, and rendering does not materially increase it',
    'WARN', 'MEDIUM', 'RAW_CONTENT_THIN_VALID_PAGE',
    'G9, TP', JS_SEO, 'Google — documented', 'Tool policy',
    'Distinct from C-6.1-b. Google documents that content assembled by scripts may not be seen by every consumer, which is what C-6.1-b reports. Where rendering adds nothing, JavaScript is not withholding anything and the page is simply thin — worth reporting, but not the same defect and not critical. The 50-word boundary and the 3x rendering ratio are tool policy.'],
];

// Reworded rows: the conditions changed, so the register must say what the code now does.
const REPLACE = {
  'C-6.1-b': ['C-6.1', 'C-6.1-b',
    'Main content < 50 words in RAW on a page that passed the A0 validity gate, AND the rendered DOM carries at least 3x the raw word count (minimum 50)',
    'FAIL', 'CRITICAL', 'RAW_CONTENT_ABSENT',
    'G9, TP', JS_SEO, 'Google — documented', 'Tool policy',
    'Both halves are required. The rule previously fired on the raw word count alone and asserted JavaScript gating whenever a rendered profile existed, without comparing the two — so a page with 8 words raw and 8 rendered was reported as JavaScript-gated. Google documents the raw/rendered distinction; the thresholds are tool policy.'],

  'X-1.8-b': ['X-1.8', 'X-1.8-b',
    'A site: query for the canonical host returns no organic result belonging to that host',
    'FAIL', 'HIGH', 'SITE_NOT_IN_INDEX',
    'GSO, GSC', GSO, 'Google — documented', 'Tool policy',
    'Downgraded from CRITICAL so it cannot cap the overall score. A CRITICAL caps the audit at 40, and this finding rests on a third-party SERP sample of a query whose counts Google itself calls estimates — evidence strong enough to report prominently, not strong enough to let a provider outage decide a client’s headline number. Search Console (GSC) remains the authoritative confirmation.'],
};

const reg = getRegister();
for (const row of [...ADD, ...Object.values(REPLACE)]) {
  for (const ref of String(row[6]).split(',').map((r) => r.trim()).filter(Boolean)) {
    if (!reg.sources.get(ref)) {
      console.error(`\n  Refusing to write: ${row[1]} cites "${ref}", which is not in the Sources sheet.\n`);
      process.exit(1);
    }
  }
}

const entries = readZip(fs.readFileSync(FILE));
const sheet = entries.find((e) => e.name === SHEET);
let xml = sheet.data.toString('utf8');

// Column B holds the checkpoint id, but it is stored two different ways: rows written by these
// scripts use inline strings, while the workbook's original rows use shared-string indices. A
// reader that only understands one of them silently fails to find half the sheet.
const sharedXml = entries.find((e) => e.name === 'xl/sharedStrings.xml')?.data.toString('utf8') || '';
const SHARED = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)]
  .map((m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));

function idOf(block) {
  const cell = /<c r="B\d+"[^>]*>[\s\S]*?<\/c>/.exec(block);
  if (!cell) return null;
  const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(cell[0]);
  if (inline) return inline[1];
  if (/t="s"/.test(cell[0])) {
    const v = /<v>(\d+)<\/v>/.exec(cell[0]);
    if (v) return SHARED[Number(v[1])] ?? null;
  }
  const plain = /<v>([\s\S]*?)<\/v>/.exec(cell[0]);
  return plain ? plain[1] : null;
}
const rowsOf = () => [...xml.matchAll(/<row r="(\d+)"[^>]*>[\s\S]*?<\/row>/g)];

for (const [id, values] of Object.entries(REPLACE)) {
  const hit = rowsOf().find((m) => idOf(m[0]) === id);
  if (!hit) {
    console.error(`Refusing to write: ${id} not found.`);
    process.exit(1);
  }
  xml = xml.replace(hit[0], rowXml(Number(hit[1]), values));
}

for (const values of ADD) {
  if (rowsOf().some((m) => idOf(m[0]) === values[1])) {
    console.log(`${values[1]} already present; skipped.`);
    continue;
  }
  const maxRow = Math.max(...rowsOf().map((m) => Number(m[1])));
  const target = maxRow + 1;
  xml = xml.replace(new RegExp(`<row r="${target}"[^>]*/>`), '');
  const marker = '</sheetData>';
  xml = xml.slice(0, xml.indexOf(marker)) + rowXml(target, values) + xml.slice(xml.indexOf(marker));
}

const after = [...xml.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]));
const dupes = [...new Set(after.filter((n, i) => after.indexOf(n) !== i))];
if (dupes.length) {
  console.error(`Duplicate row numbers: ${dupes.join(', ')}. Not writing.`);
  process.exit(1);
}

sheet.data = Buffer.from(xml, 'utf8');
fs.writeFileSync(OUT, writeZip(entries));
console.log(`  wrote ${path.basename(OUT)}`);
for (const id of Object.keys(REPLACE)) console.log(`    reworded ${id}`);
for (const v of ADD) console.log(`    added    ${v[1]}  ${v[3]}/${v[4]}  ${v[5]}`);
