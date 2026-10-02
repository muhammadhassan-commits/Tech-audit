// Adds checkpoint rows to the source register for findings the code emits but the register never
// described.
//
// Why these rows are needed, and not merely tidy: resolve() looks up the checkpoint id first, so a
// finding emitted under a borrowed id (b.hit('C-1.2-d', { reason_code: 'SITEMAP_VARIANT_HOST_MISMATCH' }))
// resolved to the row for a *different* rule — and the Reference popover showed that other rule's
// condition text and sources. The citation was not merely vague, it was wrong, which is exactly what
// F-SRC-2 forbids. Each variant now has an id and a row of its own.
//
// Seven of the nine are exception conditions the PRD already defines (E-1.1-12, E-1.3-3, E-1.5-6,
// E-1.6-8, E-1.6-10, B-3.2-3) that simply never got a row. Two are operator rules added after live
// audits, and their rows say so: the Google document is cited for what it actually states, and the
// decision to fail on it is recorded as tool policy rather than dressed up as a vendor requirement.
//
// The workbook is edited in place rather than regenerated: it carries five sheets, hyperlink
// relationships, drawings and styles, none of which this script understands or should disturb. Only
// xl/worksheets/sheet4.xml (Checkpoints) is rewritten, and the new rows use inline strings so
// sharedStrings.xml is left untouched.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { getRegister } from '../src/sources/register.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'technicalaudittoolPRD_v2_source_register.xlsx');
const OUT = process.env.REGISTER_OUT || SRC;
const SHEET = 'xl/worksheets/sheet4.xml'; // Checkpoints

// Column order, from the sheet's own header row.
// Factor | Checkpoint | Condition | Status | Severity | reason_code | Source refs | Reference URL |
// Source class | Threshold set by | What the source supports / gap
const NEW_ROWS = [
  {
    factor: 'C-1.1', checkpoint: 'C-1.1-l', reason_code: 'STAGING_BLOCK_EXPECTED',
    condition: 'Disallow: / applies to Googlebot on a host the operator declared as staging (env = staging)',
    status: 'WARN', severity: 'LOW', refs: ['G1', 'G1b'],
    note: 'E-1.1-12. The directive is read exactly as the Google specification documents it. That a sitewide block is expected here is operator-supplied context, not something any source can establish, so the downgrade from CRITICAL is tool policy.',
  },
  {
    factor: 'C-1.2', checkpoint: 'C-1.2-i', reason_code: 'SITEMAP_VARIANT_HOST_MISMATCH',
    condition: 'A reachable sitemap variant answers 200 on a host other than the canonical host instead of redirecting to it',
    status: 'FAIL', severity: 'HIGH', refs: ['G5', 'G7'],
    note: 'Operator rule, added after a live audit found the sitemap served from two hosts at once. Google documents that duplicate URLs are consolidated to one canonical and that a sitemap is scoped to its host; neither document states a severity, so FAIL/HIGH is tool policy.',
  },
  {
    factor: 'C-1.3', checkpoint: 'C-1.3-s', reason_code: 'MAINTENANCE_MODE',
    condition: 'HTTP 503 accompanied by a Retry-After header',
    status: 'WARN', severity: 'MEDIUM', refs: ['G2'],
    note: 'E-1.3-3. Google documents 503 with Retry-After as the correct way to signal temporary unavailability, so it is not scored as a server error. Whether the maintenance is intentional is not observable.',
  },
  {
    factor: 'C-1.4', checkpoint: 'C-1.4-p', reason_code: 'TRAILING_SLASH_BOTH_LIVE',
    condition: 'Both the trailing-slash and the no-slash form return 2xx and neither redirects to the other',
    status: 'FAIL', severity: 'HIGH', refs: ['G7', 'G2'],
    note: 'Operator rule, added after a live audit. Google documents that the same content reachable at several URLs must be consolidated to one canonical form; the document does not assign a severity, so FAIL/HIGH is tool policy.',
  },
  {
    factor: 'C-1.5', checkpoint: 'C-1.5-u', reason_code: 'CANONICAL_DUPLICATED_IDENTICAL',
    condition: 'More than one link[rel=canonical] in <head>, all carrying the same value',
    status: 'WARN', severity: 'LOW', refs: ['G7'],
    note: 'E-1.5-6. Google documents that conflicting canonicals may all be ignored; duplicates that agree are unambiguous, so this is a tidiness warning and not the conflicting-canonical failure.',
  },
  {
    factor: 'C-1.6', checkpoint: 'C-1.6-o', reason_code: 'STAGING_NOINDEX_EXPECTED',
    condition: 'Effective noindex for Googlebot on a host the operator declared as staging (env = staging)',
    status: 'WARN', severity: 'LOW', refs: ['G8'],
    note: 'E-1.6-8. The directive is read as documented. That noindex is expected on staging is operator-supplied context, so the downgrade from CRITICAL is tool policy.',
  },
  {
    factor: 'C-1.6', checkpoint: 'C-1.6-p', reason_code: 'META_ROBOTS_IN_NOSCRIPT',
    condition: 'A meta robots element appears inside <noscript>',
    status: 'WARN', severity: 'HIGH', refs: ['G8'],
    note: 'E-1.6-10. Google documents where robots meta tags are honoured; it does not document behaviour inside <noscript>, which is why the finding reports inconsistency rather than asserting a specific outcome.',
  },
  {
    factor: 'C-3.2', checkpoint: 'C-3.2-t', reason_code: 'HREFLANG_POSSIBLY_MISSING',
    condition: 'Exactly one weak multilingual signal observed and no hreflang annotations present',
    status: 'WARN', severity: 'MEDIUM', refs: ['G10'],
    note: 'B-3.2-3. Advisory only: a single weak signal is not evidence that the site is multilingual, so this never reaches the hreflang-absent failure.',
  },
  {
    factor: 'C-5.3', checkpoint: 'C-5.3-o', reason_code: 'LLMS_TXT_SITEMAP_CLONE',
    condition: 'llms.txt is a flat list of URLs with no H2 sections and no descriptions',
    status: 'WARN', severity: 'LOW', refs: ['L1', 'G16'],
    note: 'The file conforms to the proposed specification, which requires only an H1. That a flat URL list is low value is a judgement this tool makes, not a requirement of the specification — and llms.txt is not adopted by any search engine.',
  },
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Minimal zip reader/writer ─────────────────────────────────────────────
function readZip(buf) {
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error('not a zip file: no end-of-central-directory record');
  const count = buf.readUInt16LE(i + 10);
  let off = buf.readUInt32LE(i + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const lho = buf.readUInt32LE(off + 42);
    const lnl = buf.readUInt16LE(lho + 26);
    const lel = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnl + lel;
    const raw = buf.slice(start, start + csize);
    entries.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : raw });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const comp = zlib.deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0, 6);           // flags
    lh.writeUInt16LE(8, 8);           // deflate
    lh.writeUInt16LE(0, 10);          // time
    lh.writeUInt16LE(0, 12);          // date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ── Build the rows ────────────────────────────────────────────────────────
const reg = getRegister();

// Never cite a ref that is not registered: a row pointing at a source that does not exist is worse
// than no row, because it reads as though the finding were supported.
for (const r of NEW_ROWS) {
  for (const ref of r.refs) {
    if (!reg.sources.get(ref)) {
      console.error(`\n  Refusing to write: ${r.checkpoint} cites "${ref}", which is not in the Sources sheet.\n`);
      process.exit(1);
    }
  }
  if (reg.checkpoints.get(r.checkpoint)) {
    console.error(`\n  Refusing to write: ${r.checkpoint} already exists in the register.\n`);
    process.exit(1);
  }
}

const entries = readZip(fs.readFileSync(SRC));
const sheet = entries.find((e) => e.name === SHEET);
if (!sheet) throw new Error(`${SHEET} not found in the workbook`);
let xml = sheet.data.toString('utf8');

const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
// Style ids copied from the existing data rows so the new ones match the sheet.
const STYLES = ['5', '7', '5', '7', '7', '5', '7', '9', '11', '12', '5'];

let rowNum = 324; // first row after the 323 existing ones (1 header + 322 checkpoints)
const built = [];
for (const r of NEW_ROWS) {
  const src = reg.sources.get(r.refs[0]);
  const values = [
    r.factor,
    r.checkpoint,
    r.condition,
    r.status,
    r.severity,
    r.reason_code,
    r.refs.join(', '),
    src.url || '',
    src.source_class || '',
    'Tool policy',
    r.note,
  ];
  const cells = values.map((v, i) =>
    `<c r="${COLS[i]}${rowNum}" s="${STYLES[i]}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`).join('');
  built.push(`<row r="${rowNum}" ht="15.75" customHeight="1">${cells}</row>`);
  rowNum++;
}

// The sheet carries empty placeholder rows out to 1000; drop the ones we are about to occupy.
for (let n = 324; n < rowNum; n++) {
  xml = xml.replace(new RegExp(`<row r="${n}"[^>]*/>`), '');
  xml = xml.replace(new RegExp(`<row r="${n}"[^>]*>\\s*</row>`), '');
}

const marker = '</sheetData>';
if (!xml.includes(marker)) throw new Error('no </sheetData> in the Checkpoints sheet');
// Insert in row order: the new rows go immediately after row 323, not at the very end, so the
// file stays sorted even though the placeholder rows for 333-1000 follow.
const anchor = xml.indexOf('<row r="324"') >= 0 ? xml.indexOf('<row r="324"') : xml.indexOf(marker);
xml = xml.slice(0, anchor) + built.join('') + xml.slice(anchor);

sheet.data = Buffer.from(xml, 'utf8');
fs.writeFileSync(OUT, writeZip(entries));

console.log(`  wrote ${path.basename(OUT)}`);
console.log(`  added ${NEW_ROWS.length} checkpoint rows (${NEW_ROWS[0].checkpoint} … ${NEW_ROWS[NEW_ROWS.length - 1].checkpoint})`);
for (const r of NEW_ROWS) console.log(`    ${r.checkpoint.padEnd(9)} ${r.status.padEnd(5)} ${r.severity.padEnd(7)} ${r.reason_code}`);
