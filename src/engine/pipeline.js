// Pipeline — PRD §6 execution order (binding) with the robots.txt entry gate.
//   P0 intake & normalisation → P1 control files (robots.txt FIRST, gate) → P2 discovery & sampling
//   → P3 per-page acquisition → P4 site checks → P5 page checks → P6 cross-page → P7 scoring & report
import crypto from 'node:crypto';
import { loadConfig, TOOL_VERSION, RUBRIC_VERSION, THRESHOLD_SET_VERSION } from '../config.js';
import { HttpClient, bodyText } from '../net/http.js';
import { Renderer } from '../net/render.js';
import { getRegister } from '../sources/register.js';
import { parseSeed, normalizeUrl, originOf, pathOf } from '../parse/url.js';
import { evaluate as robotsEvaluate } from '../parse/robots.js';
import { FACTORS } from './catalog.js';
import { haltedResult, errorResult } from './result.js';
import { computeScores } from './scoring.js';
import { runIntake } from '../discovery/intake.js';
import { runDiscovery } from '../discovery/discover.js';
import { acquirePages } from '../discovery/acquire.js';
import { LlmJudge } from '../llm/judge.js';
import * as C11 from '../checks/c1_1_robots.js';
import * as C12 from '../checks/c1_2_sitemap.js';
import * as C13 from '../checks/c1_3_status.js';
import * as C14 from '../checks/c1_4_redirects.js';
import * as C15 from '../checks/c1_5_canonical.js';
import * as C16 from '../checks/c1_6_meta_robots.js';
import * as C17 from '../checks/c1_7_indexability.js';
import * as C21 from '../checks/c2_1_title.js';
import * as C22 from '../checks/c2_2_metadesc.js';
import * as C23 from '../checks/c2_3_headings.js';
import * as C24 from '../checks/c2_4_internal_links.js';
import * as C31 from '../checks/c3_1_structured_data.js';
import * as C32 from '../checks/c3_2_hreflang.js';
import * as C41 from '../checks/c4_1_cwv.js';
import * as C51 from '../checks/c5_1_ai_crawlers.js';
import * as C52 from '../checks/c5_2_js_disabled.js';
import * as C53 from '../checks/c5_3_llms_txt.js';
import * as C54 from '../checks/c5_4_ai_instructions.js';
import * as C61 from '../checks/c6_1_raw_content.js';
import * as C62 from '../checks/c6_2_entity.js';
import * as C63 from '../checks/c6_3_structure.js';
import * as C64 from '../checks/c6_4_extractability.js';
import * as C65 from '../checks/c6_5_freshness.js';

// Execution order after the gate (dependencies first: C-1.7 composes 1.1–1.6, C-5.4 reads 3.1 + 5.3, …).
const ORDER = [
  ['C-1.2', C12], ['C-1.3', C13], ['C-1.4', C14], ['C-1.5', C15], ['C-1.6', C16], ['C-1.7', C17],
  ['C-2.1', C21], ['C-2.2', C22], ['C-2.3', C23], ['C-2.4', C24],
  ['C-3.1', C31], ['C-3.2', C32],
  ['C-4.1', C41],
  ['C-5.1', C51], ['C-5.2', C52], ['C-5.3', C53], ['C-5.4', C54],
  ['C-6.1', C61], ['C-6.2', C62], ['C-6.3', C63], ['C-6.4', C64], ['C-6.5', C65],
];
const CONTROL_FILE_CHECKS = new Set(['C-1.2', 'C-5.3']); // F-RUN-6 / F-RUN-8 control-file-only set (+ C-1.1)

class RunAbort extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export async function runAudit(seed, options = {}, onEvent = () => {}) {
  const cfg = loadConfig(options.config || {});
  if (options.operator_urls?.length) cfg.operator_urls = options.operator_urls;
  const register = getRegister(options.registerPath);
  const started = Date.now();
  const deadline = started + cfg.run.max_minutes * 60000;

  const ctx = {
    cfg,
    register,
    seed,
    flags: new Set(),
    results: [],
    pages: [],
    derived: {},
    notes: [],
    phase: 'P0',
    controlOnly: false,
    abortCode: null,
    emit: (type, data = {}) => {
      try {
        onEvent({ type, at: new Date().toISOString(), ...data });
      } catch {
        /* progress sinks never break a run */
      }
    },
    checkDeadline() {
      if (Date.now() > deadline) throw new RunAbort('BUDGET_EXHAUSTED'); // F-RUN-7
      if (this.abortCode) throw new RunAbort(this.abortCode);
    },
  };
  ctx.http = new HttpClient(cfg, {
    isBlockedForAuditor: (url) => isBlockedForAuditor(ctx, url),
    onAbort: (code) => {
      if (!ctx.abortCode) ctx.abortCode = code;
    },
  });
  ctx.renderer = new Renderer(cfg);
  ctx.llm = new LlmJudge(cfg, ctx);
  ctx.robotsAllowed = (agent, url) => robotsVerdict(ctx, agent, url);

  const run = {
    run_id: crypto.randomUUID(),
    started_at: new Date(started).toISOString(),
    finished_at: null,
    run_status: 'COMPLETED',
    run_quality: 'OK',
    abort_reason: null,
    tool_version: TOOL_VERSION,
    rubric_version: RUBRIC_VERSION,
    threshold_set_version: THRESHOLD_SET_VERSION,
    capabilities: {},
    flags: [],
    gate: { check: 'C-1.1', mode: cfg.gate.robots_mode, passed: null, status: null, reason_code: null },
  };
  ctx.run = run;
  let halted = false;

  try {
    // ── P0: target intake & normalisation ──────────────────────────────────
    ctx.phase = 'P0';
    ctx.emit('phase', { phase: 'P0', label: 'Target intake & normalisation' });
    const seedInfo = parseSeed(seed);
    if (!seedInfo) throw new RunAbort('SEED_DNS_FAILURE');
    await runIntake(ctx, seedInfo);
    ctx.checkDeadline();

    // ── P1: control files — execution begins at 1. Crawl & Indexing › robots.txt ──
    ctx.phase = 'P1';
    ctx.emit('phase', { phase: 'P1', label: 'robots.txt (entry gate)' });
    ctx.emit('check_start', { check_id: 'C-1.1' });
    let robotsResult;
    try {
      robotsResult = await C11.acquireAndEvaluate(ctx);
    } catch (e) {
      robotsResult = errorResult(ctx, 'C-1.1', e);
    }
    ctx.derived.robotsResult = robotsResult;
    ctx.emit('check_done', { check_id: 'C-1.1', status: summarise([robotsResult]) });

    const gatePassed = ['PASS', 'WARN'].includes(robotsResult.status);
    run.gate = { ...run.gate, passed: gatePassed, status: robotsResult.status, reason_code: robotsResult.reason_code };
    if (!gatePassed) {
      if (cfg.gate.robots_mode === 'strict') {
        // Operator directive: a failed, incomplete or errored robots.txt check halts ALL processing.
        halted = true;
        ctx.flags.add('HALTED_AT_ROBOTS_GATE');
        ctx.results.push(robotsResult);
        for (const f of FACTORS) {
          if (f.id === 'C-1.1' || f.unspecified) continue;
          ctx.results.push(haltedResult(ctx, f.id, robotsResult.reason_code === 'ROBOTS_BLOCKS_GOOGLEBOT_SITEWIDE' ? 'BLOCKED' : 'UNAVAILABLE'));
        }
        run.run_status = 'ABORTED';
        run.abort_reason = robotsResult.reason_code || 'ROBOTS_CHECK_ERROR';
        ctx.emit('gate', { passed: false, status: robotsResult.status, reason_code: robotsResult.reason_code, mode: 'strict' });
        return finalize(ctx, run, halted);
      }
      // PRD mode: F-RUN-6 / F-RUN-8 — control-file-only; ROBOTS_IS_HTML proceeds as "no restrictions".
      if (robotsResult.reason_code !== 'ROBOTS_IS_HTML') {
        ctx.controlOnly = true;
        ctx.flags.add('ROBOTS_UNAVAILABLE_CONSERVATIVE_MODE');
      }
    }
    ctx.emit('gate', { passed: gatePassed, status: robotsResult.status, reason_code: robotsResult.reason_code, mode: cfg.gate.robots_mode });

    // F-RUN-6 — auditor UA disallowed site-wide: halt page crawling, control-file checks only.
    if (!ctx.controlOnly && ctx.robots?.parsed && robotsEvaluate(ctx.robots.parsed, ctx.auditorToken, '/').verdict === 'DISALLOWED' && !cfg.force_crawl) {
      ctx.controlOnly = true;
      ctx.flags.add('AUDITOR_BLOCKED_SITEWIDE');
    }

    if (!ctx.controlOnly) {
      // ── P2: discovery & sampling ─────────────────────────────────────────
      ctx.phase = 'P2';
      ctx.emit('phase', { phase: 'P2', label: 'Page discovery & sampling' });
      await runDiscovery(ctx);
      ctx.checkDeadline();

      // ── P3: per-page acquisition (RAW + conditional RENDERED) ────────────
      ctx.phase = 'P3';
      ctx.emit('phase', { phase: 'P3', label: 'Per-page acquisition' });
      await acquirePages(ctx);
      ctx.checkDeadline();
    }

    // Finalise C-1.1 with sample-dependent rows (C-1.1-c, C-1.1-k).
    try {
      ctx.results.push(C11.finalizeWithSample(ctx, robotsResult));
    } catch (e) {
      ctx.results.push(robotsResult);
    }

    // ── P4–P6: checks ──────────────────────────────────────────────────────
    ctx.phase = 'P4-P6';
    ctx.emit('phase', { phase: 'P4-P6', label: 'Site-level, page-level and cross-page checks' });
    for (const [id, mod] of ORDER) {
      ctx.checkDeadline();
      if (ctx.controlOnly && !CONTROL_FILE_CHECKS.has(id)) {
        ctx.results.push(controlOnlyResult(ctx, id));
        continue;
      }
      ctx.emit('check_start', { check_id: id });
      let out = [];
      try {
        out = await mod.run(ctx); // each check catches per-page exceptions itself (F-RUN-9)
      } catch (e) {
        out = [errorResult(ctx, id, e)]; // never propagate to run abort
      }
      ctx.results.push(...out);
      ctx.emit('check_done', { check_id: id, status: summarise(out) });
    }
  } catch (e) {
    if (e instanceof RunAbort || e.__abort) {
      run.run_status = 'ABORTED';
      run.abort_reason = e.code;
      ctx.flags.add(e.code);
    } else {
      run.run_status = 'ABORTED';
      run.abort_reason = 'TOOL_EXCEPTION';
      ctx.notes.push({ kind: 'exception', message: e.message, stack: String(e.stack).split('\n').slice(0, 5) });
    }
  } finally {
    await ctx.renderer.close();
  }
  return finalize(ctx, run, halted);
}

function summarise(results) {
  const c = {};
  for (const r of results) c[r.status] = (c[r.status] || 0) + 1;
  return c;
}

function controlOnlyResult(ctx, id) {
  const r = haltedResult(ctx, id, ctx.flags.has('AUDITOR_BLOCKED_SITEWIDE') ? 'BLOCKED' : 'UNAVAILABLE');
  r.summary = ctx.flags.has('AUDITOR_BLOCKED_SITEWIDE')
    ? 'Not evaluated — robots.txt disallows the auditor user-agent site-wide (F-RUN-6). Reported as a tool limitation, not a site defect.'
    : 'Not evaluated — robots.txt unavailable; conservative mode runs control-file checks only (F-RUN-8).';
  return r;
}

export function isBlockedForAuditor(ctx, url) {
  if (!ctx.robots?.parsed || !ctx.cfg.net.respect_robots) return false;
  try {
    const u = new URL(url);
    if (ctx.canonicalOrigin && originOf(url) !== ctx.canonicalOrigin) return false; // rules are per host/protocol/port
    const p = u.pathname + u.search;
    if (p === '/robots.txt' || /\/llms(-full)?\.txt$/.test(u.pathname) || u.pathname.startsWith('/.well-known/')) return false;
    if (ctx.cfg.operator_urls?.some((o) => normalizeUrl(o) === normalizeUrl(url))) return false;
    return robotsEvaluate(ctx.robots.parsed, ctx.auditorToken, p).verdict === 'DISALLOWED';
  } catch {
    return false;
  }
}

export function robotsVerdict(ctx, agent, url) {
  if (!ctx.robots?.parsed) return { verdict: 'ALLOWED', explicit: null, rule: null, token: null, no_robots: true };
  if (ctx.canonicalOrigin && originOf(url) !== ctx.canonicalOrigin) return { verdict: 'UNKNOWN', explicit: null, rule: null, token: null, other_host: true };
  return robotsEvaluate(ctx.robots.parsed, agent, pathOf(url));
}

function finalize(ctx, run, halted) {
  run.finished_at = new Date().toISOString();
  run.flags = [...ctx.flags];
  run.capabilities = {
    render_js: ctx.cfg.cap.render_js && ctx.renderer.available !== false,
    serp_api: false,
    psi_api: ctx.cfg.cap.psi_api && !!ctx.cfg.keys.google_api_key,
    // Reports what the run could actually use, not what was requested: a key whose CrUX API is not
    // enabled reads as false here, with the reason recorded alongside it.
    crux_api: ctx.cfg.cap.crux_api && !!ctx.cfg.keys.google_api_key && ctx.derived.cruxUsable !== false,
    commoncrawl: ctx.cfg.cap.commoncrawl,
    gsc_api: ctx.cfg.cap.gsc_api,
    llm_judge: ctx.llm.enabled,
    ua_probe: ctx.cfg.cap.ua_probe,
  };
  if (ctx.renderer.unavailableReason) run.render_unavailable_reason = ctx.renderer.unavailableReason;
  if (ctx.derived.cruxDisabledReason) run.crux_unavailable_reason = `CrUX API unavailable for this key; Core Web Vitals used the PageSpeed Insights rung instead (B-4.1-2). ${String(ctx.derived.cruxDisabledReason).slice(0, 200)}`;
  if (ctx.llm.disabledReason) run.llm_disabled_reason = ctx.llm.disabledReason;
  const errors = ctx.results.filter((r) => r.status === 'ERROR').length;
  if (errors >= 2) run.run_quality = 'DEGRADED'; // F-RUN-10
  if (ctx.flags.has('RUN_QUALITY_DEGRADED')) run.run_quality = 'DEGRADED';
  if (run.run_status === 'COMPLETED' && ctx.controlOnly) run.run_status = 'PARTIAL';

  const report = {
    run,
    target: ctx.target || { seed: ctx.seed },
    discovery: ctx.discovery || null,
    sitemap_access: ctx.derived.sitemapAccess || null,
    sample: ctx.sample || { quality: null, pages: [], page_type_absent: [] },
    results: ctx.results,
    checklist: FACTORS.map((f) => ({ id: f.id, section: f.section, name: f.name, unspecified: !!f.unspecified, note: f.note || null, scope: f.scope || null })),
    headlines: [],
    notes: ctx.notes,
    http_log: ctx.http?.log?.slice(0, 400) || [],
  };
  report.scores = computeScores(report, ctx.cfg);
  // Run-level headlines (F-1.6-4, F-1.7-3)
  for (const r of ctx.results) {
    if (['HOMEPAGE_NOT_INDEXABLE'].includes(r.reason_code) || (r.check_id === 'C-1.6' && r.page_type === 'homepage' && r.reason_code === 'NOINDEX_PRESENT')) {
      report.headlines.push({ check_id: r.check_id, reason_code: r.reason_code, summary: r.summary });
    }
  }
  if (run.run_quality === 'DEGRADED') report.headlines.unshift({ check_id: null, reason_code: 'RUN_QUALITY_DEGRADED', summary: 'Two or more checks emitted ERROR, or page acquisition failed for more than half the sample.' });
  if (halted) report.headlines.unshift({ check_id: 'C-1.1', reason_code: run.abort_reason, summary: 'Pipeline halted at the robots.txt gate — no further factors were evaluated.' });
  ctx.emit('done', { run_status: run.run_status });
  return report;
}

export { bodyText };
