// Minimal, dependency-free .xlsx reader (ZIP + SpreadsheetML shared strings / inline strings).
// Used to read the Source Reference file at runtime, so the UI always reflects the file on disk.
import fs from 'node:fs';
import zlib from 'node:zlib';

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Not a ZIP/XLSX file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Corrupt central directory');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    entries.set(name, { method, csize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const lo = e.localOff;
      const nl = buf.readUInt16LE(lo + 26);
      const xl = buf.readUInt16LE(lo + 28);
      const data = buf.subarray(lo + 30 + nl + xl, lo + 30 + nl + xl + e.csize);
      if (e.method === 0) return data;
      if (e.method === 8) return zlib.inflateRawSync(data);
      throw new Error(`Unsupported ZIP compression method ${e.method}`);
    },
  };
}

const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

const textRuns = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Returns { sheetName: string[][] } — rows of cell strings, column-aligned. */
export function readXlsx(filePath) {
  const zip = readZip(fs.readFileSync(filePath));
  const ssXml = zip.read('xl/sharedStrings.xml')?.toString('utf8') || '';
  const shared = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1]));
  const wb = zip.read('xl/workbook.xml').toString('utf8');
  const rels = zip.read('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const relMap = new Map([...rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const sheets = {};
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = m[1];
    const name = unescapeXml(/name="([^"]*)"/.exec(attrs)[1]);
    const rid = /r:id="([^"]*)"/.exec(attrs)?.[1];
    let target = relMap.get(rid) || '';
    target = target.replace(/^\//, '');
    if (!target.startsWith('xl/')) target = `xl/${target}`;
    const xml = zip.read(target)?.toString('utf8');
    if (!xml) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const cattrs = c[1];
        const inner = c[2] || '';
        const ref = /r="([A-Z]+)\d+"/.exec(cattrs)?.[1];
        const t = /t="([^"]+)"/.exec(cattrs)?.[1];
        let v = '';
        if (t === 's') v = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1])] ?? '';
        else if (t === 'inlineStr') v = textRuns(inner);
        else v = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
        const idx = ref ? colIndex(ref) : row.length;
        row[idx] = v;
      }
      rows.push(Array.from(row, (x) => x ?? ''));
    }
    sheets[name] = rows;
  }
  return sheets;
}
