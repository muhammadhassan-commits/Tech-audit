// Registers X-1.8 — Googlebot Access (using SERP).
//
// The check was listed in the audit checklist and never evaluated, because the PRD defined no
// conditions and no source for it, and there was no SERP data to work from. Both gaps are now
// closed: the operator supplied a SERP provider, and the conditions below are deliberately narrow.
//
// Only the binary outcome is scored — the domain is in Google's index, or it is not. Coverage is
// not, because a site: query returns a sample and Google calls the counts estimates. Every finding
// carries that caveat, and the register rows say which part rests on Google's documentation and
// which is this tool's own judgement.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip, writeZip, rowXml, esc, COLS, STYLES } from './lib/workbook.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'technicalaudittoolPRD_v2_source_register.xlsx');
const OUT = process.env.REGISTER_OUT || SRC;

const SOURCES_SHEET = 'xl/worksheets/sheet2.xml';
const FACTORS_SHEET = 'xl/worksheets/sheet3.xml';
const CHECKPOINTS_SHEET = 'xl/worksheets/sheet4.xml';

const GSO_URL = 'https://support.google.com/websearch/answer/2466433';
const GSC_URL = 'https://developers.google.com/search/docs/monitor-debug/search-console-start';

// Ref | Publisher | Document | URL | Source class | URL verified in this pass | What it supports
const NEW_SOURCES = [
  ['GSO', 'Google', 'Refine web searches (search operators, including site:)', GSO_URL,
    'Google — documented', 'Yes',
    'Documents the site: operator and states that result counts are estimates. Supports reading a site: query as evidence that a domain is or is not present in the index, and nothing finer.'],
  ['GSC', 'Google Search Central', 'Get started with Search Console', GSC_URL,
    'Google — documented', 'Yes',
    'The authoritative report on index coverage, available only to a verified owner. Cited wherever a SERP sample is used in its place, so the weaker evidence is never presented as the stronger.'],
  ['CLR', 'Cloro', 'SERP API', 'https://cloro.dev/serp-api/',
    'Third-party API — data provider', 'Yes',
    'The provider through which the site: query is executed. A data source, not an authority: it reports what Google returned and documents nothing about how search works.'],
];

// Factor | Name | Section | Checkpoints | Source refs | Primary reference URL | Source class |
// What the sources actually support
const NEW_FACTORS = [
  ['X-1.8', 'Googlebot Access (using SERP)', 'SECTION 1 — CRAWL & INDEXING', '3.0',
    'GSO, GSC, CLR', GSO_URL, 'Google — documented',
    'Google documents the site: operator and states that its counts are estimates. That supports one inference only: whether the domain is present in the index. Coverage is not measurable this way, and Search Console remains the authoritative report.'],
];

// Factor | Checkpoint | Condition | Status | Severity | reason_code | Source refs | Reference URL |
// Source class | Threshold set by | What the source supports / gap
const NEW_CHECKPOINTS = [
  ['X-1.8', 'X-1.8-a',
    'A site: query for the canonical host returns at least one organic result belonging to that host',
    'PASS', '—', '—',
    'GSO, CLR', GSO_URL, 'Google — documented', 'Tool policy',
    'Google documents the site: operator. That a non-empty result set means the domain is present in the index follows directly; how much of it is present does not, and is not claimed.'],

  ['X-1.8', 'X-1.8-b',
    'A site: query for the canonical host returns no organic results belonging to that host',
    'FAIL', 'CRITICAL', 'SITE_NOT_IN_INDEX',
    'GSO, GSC', GSO_URL, 'Google — documented', 'Tool policy',
    'An empty site: result set is the one strong inference the operator supports: Google is returning nothing for the domain. Severity is tool policy — a site absent from the index cannot rank at all, whatever else is configured correctly. Search Console (GSC) is the authoritative confirmation and needs the owner.'],

  ['X-1.8', 'X-1.8-c',
    'The SERP lookup could not be completed: no key, key rejected, quota exhausted, timeout, or cap.serp_api = false',
    'NOT_TESTABLE', '—', 'SERP_LOOKUP_UNAVAILABLE',
    'CLR', 'https://cloro.dev/serp-api/', 'Third-party API — data provider', 'Tool policy',
    'A lookup the tool could not complete says nothing about the site. Excluded from the score rather than reported as absence.'],
];

const entries = readZip(fs.readFileSync(SRC));

function appendRows(sheetName, rows, firstFreeRow) {
  const sheet = entries.find((e) => e.name === sheetName);
  if (!sheet) throw new Error(`${sheetName} not found`);
  let xml = sheet.data.toString('utf8');
  const marker = '</sheetData>';
  if (!xml.includes(marker)) throw new Error(`no </sheetData> in ${sheetName}`);
  let n = firstFreeRow;
  const built = [];
  for (const values of rows) {
    // Placeholder rows run out to 1000; clear the one we are about to occupy.
    xml = xml.replace(new RegExp(`<row r="${n}"[^>]*/>`), '');
    built.push(rowXml(n, values));
    n++;
  }
  xml = xml.slice(0, xml.indexOf(marker)) + built.join('') + xml.slice(xml.indexOf(marker));
  sheet.data = Buffer.from(xml, 'utf8');
  return n;
}

// Sources: 46 rows in use (1 header + 45 sources).
appendRows(SOURCES_SHEET, NEW_SOURCES, 47);
// Factors: 24 rows in use (1 header + 23 factors).
appendRows(FACTORS_SHEET, NEW_FACTORS, 25);
// Checkpoints: 331 rows in use after the earlier revisions.
appendRows(CHECKPOINTS_SHEET, NEW_CHECKPOINTS, 334);

fs.writeFileSync(OUT, writeZip(entries));
console.log(`  wrote ${path.basename(OUT)}`);
console.log('  sources added:');
for (const s of NEW_SOURCES) console.log(`    ${s[0].padEnd(5)} ${s[1]} — ${s[2]}`);
console.log('  checkpoints added:');
for (const c of NEW_CHECKPOINTS) console.log(`    ${c[1].padEnd(9)} ${c[3].padEnd(13)} ${c[4].padEnd(9)} ${c[5]}`);
