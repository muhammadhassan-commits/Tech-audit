// Rewrites the C-1.2 rows of the source register to the revised XML Sitemap specification.
//
// What changed, and why it is a revision rather than an addition: the previous rows scored the
// sitemap check on variant reachability — every protocol x host combination had to answer 200, and
// a variant that did not was a FAIL. That is not what a sitemap check is for. A sitemap either can
// be found and fetched or it cannot; which hostnames also serve it is a consolidation question,
// and it is already scored under C-1.4 and C-1.5. Scoring it twice made ordinary setups fail.
//
//   C-1.2-b  FAIL/HIGH  -> WARN/LOW   absence is not a defect; Google requires no sitemap
//   C-1.2-c  reworded               only fails when a declared sitemap is dead AND nothing serves
//   C-1.2-d  deleted                variant not OPEN is now an unscored note
//   C-1.2-f  deleted                variant inconclusive is now an unscored note
//   C-1.2-i  deleted                the canonical-host operator rule is withdrawn
//   C-1.2-a  reworded               PASS is "one parent sitemap returns 200", nothing more
//   C-1.2-j  added     WARN/MEDIUM  a declared sitemap is dead but another one serves
//   C-1.2-k  added     FAIL/HIGH    an endpoint responds but never reaches success
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip, writeZip, spliceRow, rowXml } from './lib/workbook.mjs';
import { getRegister } from '../src/sources/register.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'technicalaudittoolPRD_v2_source_register.xlsx');
const OUT = process.env.REGISTER_OUT || SRC;
const SHEET = 'xl/worksheets/sheet4.xml';

const G5 = 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap';
const GOOGLE = 'Google — documented';

// Row numbers are 1-based sheet rows, confirmed by reading the workbook before editing.
const REPLACE = {
  13: ['C-1.2', 'C-1.2-b',
    'No parent sitemap located: robots.txt declares none, no standard location returns 200, and no request was inconclusive',
    'WARN', 'LOW', 'SITEMAP_NOT_FOUND',
    'G5', G5, GOOGLE, 'Tool policy',
    'Google documents the Sitemap: directive and the standard locations, and states that a sitemap is not required for every site. Absence is therefore reported, not failed. The WARN/LOW grading is tool policy.'],

  14: ['C-1.2', 'C-1.2-c',
    'robots.txt declares a sitemap, every variant of it returns 4xx/5xx or a network failure, and no other declared or standard-location parent sitemap returns 200',
    'FAIL', 'HIGH', 'DECLARED_SITEMAP_UNAVAILABLE',
    'G5, G2', G5, GOOGLE, 'Tool policy',
    'A URL the site advertises to crawlers in robots.txt, which does not resolve and has no working alternative, is a broken declaration. Both conditions are required: a dead declaration alongside a sitemap that does serve is C-1.2-j, not a failure.'],

  20: ['C-1.2', 'C-1.2-a',
    'At least one declared or standard-location parent sitemap reaches a final HTTP 200 (directly, or through a redirect chain)',
    'PASS', '—', '—',
    'G5, G6, G2, P1', G5, GOOGLE, 'Tool policy',
    'Inherits the factor-level source. Google documents the Sitemap: directive as a location source and sitemaps.org defines the root elements. PASS asks only that a parent sitemap can be located and fetched; the number of hostnames that also serve it is not a sitemap condition.'],
};

const DELETE = {
  15: 'C-1.2-d  SITEMAP_VARIANT_NOT_OPEN — a variant that does not answer is now an unscored note',
  17: 'C-1.2-f  SITEMAP_VARIANT_INCONCLUSIVE — now VARIANT_CHECK_INCOMPLETE, an unscored note',
  325: 'C-1.2-i  SITEMAP_VARIANT_HOST_MISMATCH — operator rule withdrawn; the revised specification states that multiple hostname variants returning 200 must not fail this check',
};

const APPEND = [
  ['C-1.2', 'C-1.2-j',
    'A declared sitemap is unavailable on every variant, while another declared or standard-location parent sitemap returns 200',
    'WARN', 'MEDIUM', 'SITEMAP_PARTIALLY_BROKEN',
    'G5, G2', G5, GOOGLE, 'Tool policy',
    'The sitemap setup works, but robots.txt advertises a URL that is not there. Usable, so not a failure; misleading, so not silent.'],

  ['C-1.2', 'C-1.2-k',
    'A sitemap endpoint responds but never reaches a successful response: a 5xx, or a redirect chain that resolves to a 4xx',
    'FAIL', 'HIGH', 'SITEMAP_UNAVAILABLE',
    'G5, G2', G5, GOOGLE, 'Tool policy',
    'Distinct from "not found". A clean 404 at a standard location means no sitemap is published there, which is only a warning. An endpoint that answers and then fails is a sitemap that exists and does not serve.'],
];

// ── Guards ────────────────────────────────────────────────────────────────
const reg = getRegister();
for (const row of [...Object.values(REPLACE), ...APPEND]) {
  for (const ref of String(row[6]).split(',').map((r) => r.trim()).filter(Boolean)) {
    if (!reg.sources.get(ref)) {
      console.error(`\n  Refusing to write: ${row[1]} cites "${ref}", which is not in the Sources sheet.\n`);
      process.exit(1);
    }
  }
}

const entries = readZip(fs.readFileSync(SRC));
const sheet = entries.find((e) => e.name === SHEET);
if (!sheet) throw new Error(`${SHEET} not found in the workbook`);
let xml = sheet.data.toString('utf8');

// Confirm each row is the one we think it is before overwriting it. Editing by row number against
// a sheet that has shifted underneath would silently corrupt unrelated rules.
for (const [n, values] of Object.entries(REPLACE)) {
  const m = new RegExp(`<row r="${n}"[\\s\\S]*?</row>`).exec(xml);
  if (!m) throw new Error(`row ${n} not found`);
  if (!m[0].includes(values[1]) && !/t="s"/.test(m[0])) {
    throw new Error(`row ${n} does not look like ${values[1]}`);
  }
}

for (const [n, values] of Object.entries(REPLACE)) xml = spliceRow(xml, Number(n), values);
for (const n of Object.keys(DELETE)) xml = spliceRow(xml, Number(n), null);

let rowNum = 333; // first free row after the nine added previously (324-332)
const added = [];
for (const values of APPEND) {
  added.push(rowXml(rowNum, values));
  rowNum++;
}
const marker = '</sheetData>';
const anchor = xml.indexOf(`<row r="${333}"`) >= 0 ? xml.indexOf(`<row r="${333}"`) : xml.indexOf(marker);
for (let n = 333; n < rowNum; n++) xml = xml.replace(new RegExp(`<row r="${n}"[^>]*/>`), '');
xml = xml.slice(0, xml.indexOf(marker)) + added.join('') + xml.slice(xml.indexOf(marker));

sheet.data = Buffer.from(xml, 'utf8');
fs.writeFileSync(OUT, writeZip(entries));

console.log(`  wrote ${path.basename(OUT)}`);
console.log('  replaced:');
for (const [n, v] of Object.entries(REPLACE)) console.log(`    row ${n.padEnd(4)} ${v[1].padEnd(9)} ${v[3].padEnd(5)} ${v[4].padEnd(7)} ${v[5]}`);
console.log('  deleted:');
for (const [n, why] of Object.entries(DELETE)) console.log(`    row ${n.padEnd(4)} ${why}`);
console.log('  added:');
for (const v of APPEND) console.log(`    ${v[1].padEnd(9)} ${v[3].padEnd(5)} ${v[4].padEnd(7)} ${v[5]}`);
