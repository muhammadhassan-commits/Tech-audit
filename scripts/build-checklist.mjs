// Turns an audit report into three deliverables: an HTML checklist, an .xlsx and a PDF.
//
//   node scripts/build-checklist.mjs <report.json> <out-dir>
//
// The three are generated from one extract, so they cannot disagree with each other. The PDF is the
// HTML printed by Chrome rather than a separate renderer, for the same reason.

import fs from 'node:fs';
import path from 'node:path';
import { writeZip, esc } from './lib/workbook.mjs';

const [, , REPORT, OUT_DIR = 'deliverables'] = process.argv;
if (!REPORT) {
  console.error('usage: node scripts/build-checklist.mjs <report.json> [out-dir]');
  process.exit(1);
}
const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
fs.mkdirSync(OUT_DIR, { recursive: true });

const SEV_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ── Extract ─────────────────────────────────────────────────────────────
// One row per distinct problem, with the pages it affects collected onto it. A reader works through
// problems, not through the 178 individual results that produced them.
const grouped = new Map();
for (const r of report.results) {
  if (!['FAIL', 'WARN'].includes(r.status)) continue;
  const key = `${r.check_id}|${r.reason_code}`;
  if (!grouped.has(key)) {
    grouped.set(key, {
      check_id: r.check_id,
      check_name: r.check_name,
      section: r.section,
      status: r.status,
      severity: r.severity || '',
      reason_code: r.reason_code || '',
      summary: clean(r.summary),
      action: clean(r.remediation?.action) || '',
      proposed: r.remediation?.proposed || '',
      sources: (r.sources || []).map((s) => s.url).filter(Boolean).slice(0, 2),
      urls: [],
    });
  }
  const g = grouped.get(key);
  if (r.target_url && !g.urls.includes(r.target_url)) g.urls.push(r.target_url);
}

const rows = [...grouped.values()].sort((a, b) => {
  if (a.status !== b.status) return a.status === 'FAIL' ? -1 : 1;
  return (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9);
});

const sections = report.scores.sections.map((s) => ({
  id: s.section, name: s.name, pct: s.score == null ? null : Math.round(s.score * 100),
}));
const counts = report.results.reduce((o, r) => { o[r.status] = (o[r.status] || 0) + 1; return o; }, {});
const meta = {
  target: report.target?.canonical_origin || report.run?.seed || 'the site',
  when: new Date(report.run?.started_at || Date.now()).toISOString().slice(0, 10),
  overall: report.scores.overall_percent,
  verdict: report.scores.verdict,
  pages: report.sample?.pages?.length ?? 0,
  caveats: report.scores.caveats || [],
  pageList: (report.sample?.pages || []).map((p) => ({ type: p.page_type, url: p.url })),
};

// ── 1. HTML checklist ───────────────────────────────────────────────────
const SEV_CLASS = { CRITICAL: 'crit', HIGH: 'high', MEDIUM: 'med', LOW: 'low' };
const shortUrl = (u) => u.replace(/^https?:\/\/(www\.)?[^/]+/, '') || '/';

// Two fields: what the check is called, and what it found. Severity, affected URLs, remediation and
// source references are all in the report - this is the readable summary, not the working document.
const rowHtml = (r) => `
<li class="item">
  <span class="chk">${esc(r.check_name)}</span>
  <p class="what">${esc(r.summary)}</p>
</li>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GEO Audit Checklist</title>
<style>
  :root {
    --bg: #ffffff; --fg: #15181d; --muted: #5c6470; --line: #e3e6ea; --card: #f7f8fa;
    --fail: #c0362c; --warn: #9a6400; --crit: #8b1a10; --high: #c0362c; --med: #9a6400; --low: #5c6470;
    --accent: #1d4ed8;
  }
  :root:not([data-theme="light"]) { }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #14171c; --fg: #e8eaed; --muted: #9aa3ae; --line: #2a2f37; --card: #1b1f25;
      --fail: #f05a4c; --warn: #e0a106; --crit: #ff6b5b; --high: #f05a4c; --med: #e0a106; --low: #9aa3ae;
      --accent: #7aa2ff;
    }
  }
  :root[data-theme="dark"] {
    --bg: #14171c; --fg: #e8eaed; --muted: #9aa3ae; --line: #2a2f37; --card: #1b1f25;
    --fail: #f05a4c; --warn: #e0a106; --crit: #ff6b5b; --high: #f05a4c; --med: #e0a106; --low: #9aa3ae;
    --accent: #7aa2ff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 920px; margin: 0 auto; padding: 32px 16px 72px; }
  header { border-bottom: 2px solid var(--fg); padding-bottom: 18px; margin-bottom: 26px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 13.5px; }
  .scoreline { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; margin-top: 16px; }
  .big { font-size: 42px; font-weight: 700; line-height: 1; }
  .verdict { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--warn); font-weight: 700; }
  .secs { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 22px 0 0; }
  .sec { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .sec .n { font-size: 12px; color: var(--muted); display: block; margin-bottom: 3px; }
  .sec .v { font-size: 20px; font-weight: 700; }
  h2 { font-size: 15px; letter-spacing: .07em; text-transform: uppercase; color: var(--muted);
       margin: 34px 0 12px; padding-bottom: 7px; border-bottom: 1px solid var(--line); }
  ul.list { list-style: none; margin: 0; padding: 0; }
  /* No tick column. This is a list of findings to read and act on, not a form to fill in - whoever
     works through it tracks progress wherever they already track work. */
  .item { padding: 14px 0; border-bottom: 1px solid var(--line); }
  .head { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; margin-bottom: 5px; }
  .pill { font-size: 10.5px; font-weight: 700; letter-spacing: .05em; padding: 2px 7px; border-radius: 999px;
          border: 1px solid currentColor; }
  .pill.fail { color: var(--fail); } .pill.warn { color: var(--warn); }
  .pill.sev.crit { color: var(--crit); } .pill.sev.high { color: var(--high); }
  .pill.sev.med { color: var(--med); } .pill.sev.low { color: var(--low); }
  .chk { font-size: 12.5px; color: var(--muted); font-weight: 600; }
  .count { font-size: 12px; color: var(--muted); margin-left: auto; }
  .what { margin: 0 0 6px; }
  .fix { margin: 0; font-size: 13.5px; color: var(--muted); }
  .fix strong { color: var(--fg); }
  .urls { margin-top: 7px; font-size: 13px; }
  .urls summary { cursor: pointer; color: var(--accent); }
  .urls ul { margin: 6px 0 0 16px; padding: 0; }
  .urls a { color: var(--accent); text-decoration: none; word-break: break-all; }
  .note { background: var(--card); border-left: 3px solid var(--muted); padding: 11px 14px;
          margin: 10px 0; font-size: 13.5px; color: var(--muted); border-radius: 0 6px 6px 0; }
  footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line);
           font-size: 12.5px; color: var(--muted); }
  @media print {
    body { background: #fff; color: #000; font-size: 10.5pt; }
    .wrap { max-width: none; padding: 0; }
    .box { border-color: #666; }
    .urls { display: block !important; }
    .urls summary { display: none; }
    .item { break-inside: avoid; page-break-inside: avoid; }
    .pill { border-color: #666; color: #000 !important; }
    a { color: #000; }
    h2 { break-after: avoid; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>GEO Audit Checklist</h1>
    <div class="sub">${esc(meta.target)} · ${meta.pages} representative pages · ${esc(meta.when)}</div>
    <div class="scoreline">
      <span class="big">${meta.overall}%</span>
      <span class="verdict">${esc(String(meta.verdict || '').replace(/_/g, ' '))}</span>
      <span class="sub">${counts.PASS || 0} pass · ${counts.WARN || 0} warn · ${counts.FAIL || 0} fail</span>
    </div>
    <div class="secs">
      ${sections.map((s) => `<div class="sec"><span class="n">${s.id}. ${esc(s.name)}</span><span class="v">${s.pct == null ? '—' : s.pct + '%'}</span></div>`).join('')}
    </div>
  </header>

  <h2>Fix first — ${rows.filter((r) => r.status === 'FAIL').length} failing</h2>
  <ul class="list">${rows.filter((r) => r.status === 'FAIL').map(rowHtml).join('')}</ul>

  <h2>Then — ${rows.filter((r) => r.status === 'WARN').length} warnings</h2>
  <ul class="list">${rows.filter((r) => r.status === 'WARN').map(rowHtml).join('')}</ul>

  <h2>Pages audited</h2>
  <ul class="list">${meta.pageList.map((p) => `<li class="item"><div class="body"><span class="chk">${esc(p.type)}</span><p class="what"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(shortUrl(p.url))}</a></p></div></li>`).join('')}</ul>

  <h2>What this audit does and does not show</h2>
  ${meta.caveats.map((c) => `<p class="note">${esc(c)}</p>`).join('')}

  <footer>
    Generated from a technical audit of ${meta.pages} representative pages. Not a full-site crawl:
    findings describe the pages listed above and patterns visible in them.
  </footer>
</div>
</body>
</html>`;

const htmlPath = path.join(OUT_DIR, 'socialchamp-geo-checklist.html');
fs.writeFileSync(htmlPath, html, 'utf8');
console.log('HTML  ->', htmlPath);

// ── 2. XLSX ─────────────────────────────────────────────────────────────
// Written from scratch as OOXML. Inline strings throughout, so there is no shared-string table to
// keep in step - the failure mode that table produces is silent and ugly.
const sheetRow = (n, cells) => {
  const col = (i) => {
    let s = '', x = i;
    do { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1; } while (x >= 0);
    return s;
  };
  return `<row r="${n}">` + cells.map((v, i) => {
    if (typeof v === 'number') return `<c r="${col(i)}${n}"><v>${v}</v></c>`;
    const s = i === 0 && n === 1 ? ' s="1"' : (n === 1 ? ' s="1"' : '');
    return `<c r="${col(i)}${n}" t="inlineStr"${s}><is><t xml:space="preserve">${esc(v ?? '')}</t></is></c>`;
  }).join('') + '</row>';
};

const HEAD = ['Check name', 'Description'];
const dataRows = rows.map((r) => [r.check_name, r.summary]);

const summaryRows = [
  ['GEO Audit', meta.target],
  ['Date', meta.when],
  ['Overall score', `${meta.overall}%`],
  ['Verdict', String(meta.verdict || '').replace(/_/g, ' ')],
  ['Pages audited', meta.pages],
  ['', ''],
  ['Section', 'Score'],
  ...sections.map((s) => [`${s.id}. ${s.name}`, s.pct == null ? 'n/a' : `${s.pct}%`]),
  ['', ''],
  ['Pass', counts.PASS || 0],
  ['Warn', counts.WARN || 0],
  ['Fail', counts.FAIL || 0],
  ['Not applicable', counts.NOT_APPLICABLE || 0],
  ['Not testable', counts.NOT_TESTABLE || 0],
  ['', ''],
  ['Caveats', ''],
  ...meta.caveats.map((c) => ['', c]),
];

const sheet = (rowsXml, cols) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols>${cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rowsXml}</sheetData>
</worksheet>`;

const checklistXml = sheet(
  [sheetRow(1, HEAD), ...dataRows.map((d, i) => sheetRow(i + 2, d))].join(''),
  [34, 120],
);
const summaryXml = sheet(summaryRows.map((d, i) => sheetRow(i + 1, d)).join(''), [34, 80]);

// writeZip takes { name, data: Buffer } entries; the pairs below are mapped to that shape.
const xlsx = writeZip(([
  ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`],
  ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`],
  ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Checklist" sheetId="1" r:id="rId1"/><sheet name="Summary" sheetId="2" r:id="rId2"/></sheets>
</workbook>`],
  ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
  ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`],
  ['xl/worksheets/sheet1.xml', checklistXml],
  ['xl/worksheets/sheet2.xml', summaryXml],
]).map(([name, data]) => ({ name, data: Buffer.from(data, 'utf8') })));

const xlsxPath = path.join(OUT_DIR, 'socialchamp-geo-checklist.xlsx');
fs.writeFileSync(xlsxPath, xlsx);
console.log('XLSX  ->', xlsxPath, `(${rows.length} rows)`);

// ── 3. PDF ──────────────────────────────────────────────────────────────
// Printed from the same HTML by Chrome, so the PDF cannot drift from the page.
const { chromium } = await import('playwright-core');
const exe = process.env.AUDIT_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--disable-gpu'] });
const page = await browser.newPage();
await page.goto('file:///' + path.resolve(htmlPath).replace(/\\/g, '/'), { waitUntil: 'load' });
await page.emulateMedia({ media: 'print', colorScheme: 'light' });
const pdfPath = path.join(OUT_DIR, 'socialchamp-geo-checklist.pdf');
await page.pdf({
  path: pdfPath,
  format: 'A4',
  printBackground: true,
  margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate: '<div style="width:100%;font-size:8pt;color:#666;padding:0 14mm;display:flex;justify-content:space-between;"><span>GEO Audit — ' + esc(meta.target) + '</span><span class="pageNumber"></span></div>',
});
await browser.close();
console.log('PDF   ->', pdfPath);
