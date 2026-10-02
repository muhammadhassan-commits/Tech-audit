// Just enough of the xlsx container to edit one sheet in place.
//
// The register workbook carries five sheets, hyperlink relationships, drawings and styles. None of
// that is understood here and none of it should be disturbed, so entries are read, the one sheet
// that needs changing is rewritten, and everything else is written back byte-identical.
//
// New and edited cells use inline strings, which keeps sharedStrings.xml untouched — re-indexing a
// shared string table is where this kind of edit usually goes wrong.
import zlib from 'node:zlib';

export const esc = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export function readZip(buf) {
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
  let c;
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const comp = zlib.deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
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

export const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
// Style ids lifted from the sheet's existing data rows, so edited rows look like their neighbours.
export const STYLES = ['5', '7', '5', '7', '7', '5', '7', '9', '11', '12', '5'];

/** Render one Checkpoints row as inline-string cells. */
export function rowXml(rowNum, values) {
  const cells = values.map((v, i) =>
    `<c r="${COLS[i]}${rowNum}" s="${STYLES[i]}" t="inlineStr"><is><t xml:space="preserve">${esc(v ?? '')}</t></is></c>`).join('');
  return `<row r="${rowNum}" ht="15.75" customHeight="1">${cells}</row>`;
}

/** Replace the <row r="N"> element wholesale, or remove it when values is null. */
export function spliceRow(xml, rowNum, values) {
  const re = new RegExp(`<row r="${rowNum}"[^>]*(?:/>|>[\\s\\S]*?</row>)`);
  if (!re.test(xml)) throw new Error(`row ${rowNum} not found in the sheet`);
  return xml.replace(re, values === null ? '' : rowXml(rowNum, values));
}
