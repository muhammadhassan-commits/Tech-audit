#!/usr/bin/env node
// CLI: wellows-audit <seed> [--json out.json] [--gate prd|strict] [--url extra] [--staging] [--quiet]
import fs from 'node:fs';
import path from 'node:path';
import { runAudit } from './engine/pipeline.js';

function parseArgs(argv) {
  const out = { seed: null, json: null, config: {}, operator_urls: [], quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = argv[++i];
    else if (a === '--gate') out.config.gate = { robots_mode: argv[++i] };
    else if (a === '--url') out.operator_urls.push(argv[++i]);
    else if (a === '--staging') out.config.env = 'staging';
    else if (a === '--no-render') out.config.cap = { ...(out.config.cap || {}), render_js: false };
    else if (a === '--no-llm') out.config.cap = { ...(out.config.cap || {}), llm_judge: false };
    else if (a === '--ua-probe') out.config.cap = { ...(out.config.cap || {}), ua_probe: true };
    else if (a === '--force-crawl') out.config.force_crawl = true;
    else if (a === '--only-urls') out.config.operator_urls_only = true;
    else if (a === '--quiet') out.quiet = true;
    else if (!a.startsWith('-')) out.seed = a;
  }
  return out;
}

const STATUS_COLOR = { PASS: '\x1b[32m', WARN: '\x1b[33m', FAIL: '\x1b[31m', NOT_APPLICABLE: '\x1b[90m', NOT_TESTABLE: '\x1b[90m', ERROR: '\x1b[35m' };
const c = (s, code) => `${code}${s}\x1b[0m`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.seed) {
    console.error('Usage: wellows-audit <domain> [--json out.json] [--gate prd|strict] [--url https://… [--only-urls]] [--staging] [--no-render] [--no-llm]');
    process.exit(2);
  }
  const t0 = Date.now();
  const report = await runAudit(args.seed, { config: args.config, operator_urls: args.operator_urls }, (e) => {
    if (args.quiet) return;
    if (e.type === 'phase') console.error(c(`▸ ${e.phase} — ${e.label}`, '\x1b[36m'));
    else if (e.type === 'gate') console.error(e.passed ? c(`  gate: robots.txt ${e.status} — pipeline unlocked`, '\x1b[32m') : c(`  gate: robots.txt ${e.status} (${e.reason_code}) — HALTED (mode: ${e.mode})`, '\x1b[31m'));
    else if (e.type === 'check_done') console.error(`  ${e.check_id}: ${Object.entries(e.status).map(([k, v]) => `${v}×${k}`).join(', ')}`);
    else if (e.type === 'sample') console.error(c(`  sample (${e.quality}): ${e.pages.length} page(s)`, '\x1b[36m'));
  });

  const s = report.scores;
  console.log('');
  console.log(`Target      ${report.target.canonical_origin || report.target.seed}`);
  console.log(`Run         ${report.run.run_status} · quality ${report.run.run_quality} · ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`Gate        robots.txt ${report.run.gate.status}${report.run.gate.passed ? ' — passed' : ` — HALTED (${report.run.gate.reason_code})`}`);
  console.log(`Verdict     ${s.verdict}${s.overall_percent != null ? ` · overall ${s.overall_percent}%` : ' · score suppressed'}`);
  if (s.gated_by.length) console.log(`Gated by    ${s.gated_by.join(', ')}`);
  console.log('');
  for (const sec of s.sections) {
    const label = `${sec.section}. ${sec.name}`.padEnd(32);
    const score = sec.score == null ? '   —' : `${String(Math.round(sec.score * 100)).padStart(3)}%`;
    console.log(`${label} ${score}  (weight ${sec.weight}, ${sec.evaluated} evaluated, ${sec.not_applicable} n/a, ${sec.not_testable} not testable)`);
  }
  console.log('');
  const ORDER = ['FAIL', 'WARN', 'PASS'];
  for (const chk of s.checks.sort((a, b) => a.check_id.localeCompare(b.check_id))) {
    const scored = chk.per_target.filter((t) => ORDER.includes(t.status));
    const worst = scored.reduce((a, t) => (ORDER.indexOf(t.status) < ORDER.indexOf(a) ? t.status : a), 'PASS');
    const st = chk.score == null ? (chk.not_testable ? 'NOT_TESTABLE' : 'NOT_APPLICABLE') : worst;
    console.log(`  ${chk.check_id.padEnd(7)} ${c(st.padEnd(15), STATUS_COLOR[st] || '')} ${chk.check_name.padEnd(38)} ${chk.score == null ? '—' : `${Math.round(chk.score * 100)}%`}`);
  }
  const findings = report.results.filter((r) => r.status === 'FAIL' || r.status === 'WARN');
  if (findings.length) {
    console.log('');
    console.log(`Findings (${findings.length}):`);
    for (const f of findings.slice(0, 40)) {
      console.log(`  ${c(f.status, STATUS_COLOR[f.status])}${f.severity ? `/${f.severity}` : ''} ${f.check_id} ${f.reason_code}${f.target_url ? ` — ${f.target_url}` : ''}`);
      console.log(`      ${f.summary}`);
      if (f.sources?.[0]) console.log(`      source: ${f.sources[0].publisher} — ${f.sources[0].url || f.sources[0].title}`);
    }
    if (findings.length > 40) console.log(`  … and ${findings.length - 40} more`);
  }
  if (s.caveats.length) {
    console.log('');
    console.log('Caveats:');
    for (const cv of s.caveats) console.log(`  • ${cv}`);
  }
  if (args.json) {
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
    console.log(`\nReport written to ${args.json}`);
  }
  process.exit(report.run.run_status === 'ABORTED' ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
