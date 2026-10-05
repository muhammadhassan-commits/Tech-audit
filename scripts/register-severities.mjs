// Severity corrections: findings that were graded as failures but are not failures.
//
// A FAIL says something is broken. None of these are: a page with no H1 is still crawled, indexed
// and ranked, and a domain reachable at two origins is a consolidation problem rather than an
// outage. Grading them as failures overstated what the evidence supports and, for the critical
// ones, moved the headline number for something Google does not treat as a defect.
//
// Rows are addressed by the checkpoint id in column B, resolving both inline and shared strings.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip, writeZip, rowXml } from './lib/workbook.mjs';
import { getRegister } from '../src/sources/register.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'technicalaudittoolPRD_v2_source_register.xlsx');
const OUT = process.env.REGISTER_OUT || FILE;
const SHEET = 'xl/worksheets/sheet4.xml';

const G_HEAD = 'https://developers.google.com/search/docs/essentials/technical';
const G_CANON = 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls';
const GSO = 'https://support.google.com/websearch/answer/2466433';

const REPLACE = {
  'C-2.3-b': ['C-2.3', 'C-2.3-b',
    'No h1 in RAW or RENDERED on a page that passed the A0 validity gate',
    'WARN', 'MEDIUM', 'H1_MISSING',
    'G18, A4', G_HEAD, 'Google — documented', 'Tool policy',
    'Downgraded from FAIL. Google documents headings as helping it understand page structure; it does not require an h1, and a page without one is still crawled, indexed and ranked. A missing h1 is a clarity problem worth fixing, not a defect. The grading is tool policy.'],

  'C-2.3-n': ['C-2.3', 'C-2.3-n',
    'Zero headings of any level on a page that passed the A0 validity gate',
    'WARN', 'MEDIUM', 'NO_HEADINGS',
    'G18, A4', G_HEAD, 'Google — documented', 'Tool policy',
    'Downgraded from FAIL/HIGH. The A0 gate now guarantees this is a real page rather than an interstitial, which is what previously produced this finding falsely. A page genuinely without headings is harder for a reader and an assistant to navigate, but it is not broken. The grading is tool policy.'],

  'C-1.4-c': ['C-1.4', 'C-1.4-c',
    'Two or more origin variants serve equivalent real content and none redirects to a single preferred origin',
    'WARN', 'HIGH', 'MULTIPLE_LIVE_ORIGINS',
    'G7, G2', G_CANON, 'Google — documented', 'Tool policy',
    'Downgraded from FAIL. Google documents that it consolidates duplicate URLs and picks a canonical itself, so a site reachable at several origins is diluting signals rather than failing. Reported prominently; not graded as breakage. The severity is tool policy.'],

  'X-1.8-b': ['X-1.8', 'X-1.8-b',
    'A site: query for the canonical host returns no organic result belonging to that host',
    'WARN', 'HIGH', 'SITE_NOT_IN_INDEX',
    'GSO, GSC', GSO, 'Google — documented', 'Tool policy',
    'The factor is marked advisory in the catalogue, so this never enters a score. A site: query samples what Google will show for one operator whose counts Google itself calls estimates; it is not an index report and not a test of crawler access. Worth surfacing — an empty result is a strong prompt to check Search Console — but not something that should move a score it cannot support.'],
};

const reg = getRegister();
for (const row of Object.values(REPLACE)) {
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
const sharedXml = entries.find((e) => e.name === 'xl/sharedStrings.xml')?.data.toString('utf8') || '';
const SHARED = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)]
  .map((m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));

function idOf(block) {
  const cell = /<c r="B\d+"[^>]*>[\s\S]*?<\/c>/.exec(block);
  if (!cell) return null;
  const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(cell[0]);
  if (inline) return inline[1];
  const v = /<v>(\d+)<\/v>/.exec(cell[0]);
  return v && /t="s"/.test(cell[0]) ? (SHARED[Number(v[1])] ?? null) : null;
}

for (const [id, values] of Object.entries(REPLACE)) {
  const rows = [...xml.matchAll(/<row r="(\d+)"[^>]*>[\s\S]*?<\/row>/g)];
  const hit = rows.find((m) => idOf(m[0]) === id);
  if (!hit) {
    console.error(`Refusing to write: ${id} not found.`);
    process.exit(1);
  }
  xml = xml.replace(hit[0], rowXml(Number(hit[1]), values));
}

sheet.data = Buffer.from(xml, 'utf8');
fs.writeFileSync(OUT, writeZip(entries));
console.log(`  wrote ${path.basename(OUT)}`);
for (const [id, v] of Object.entries(REPLACE)) console.log(`    ${id.padEnd(9)} -> ${v[3]}/${v[4]}  ${v[5]}`);
