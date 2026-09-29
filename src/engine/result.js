// Result construction — enforces §1 (status vocabulary), §4 (evidence contract), §4.1 (sources).
import fs from 'node:fs';
import { GENERATED_PATH } from '../sources/build-checkpoints.js';
import { FACTOR_BY_ID, sectionOf } from './catalog.js';

export const CHECKPOINTS = JSON.parse(fs.readFileSync(GENERATED_PATH, 'utf8'));
export const SEV_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const STATUS_RANK = { FAIL: 3, WARN: 2, PASS: 1 };
const STRONG_TIERS = new Set(['STANDARD', 'VENDOR_DOC']);

const MAX_OBS = 2000;

/** Evidence entry (§4). observed_value verbatim, truncated to 2000 chars with a flag (R-EV-1). */
export function ev({ kind = 'computed', source_url = null, fetch_profile = 'NONE', selector_or_key = null, observed_value = null, expected_value = null, elapsed_ms = null, stall_stage = null, observed_at } = {}) {
  let obs = observed_value;
  let truncated = false;
  if (obs != null && typeof obs !== 'string') obs = JSON.stringify(obs);
  if (typeof obs === 'string' && obs.length > MAX_OBS) {
    obs = obs.slice(0, MAX_OBS) + '…';
    truncated = true;
  }
  return Object.freeze({
    kind,
    source_url,
    fetch_profile,
    selector_or_key,
    observed_value: obs,
    observed_value_truncated: truncated,
    expected_value: expected_value == null ? null : typeof expected_value === 'string' ? expected_value : JSON.stringify(expected_value),
    observed_at: observed_at || new Date().toISOString(),
    elapsed_ms,
    stall_stage,
  });
}

export class ResultBuilder {
  /**
   * @param ctx      run context (register, caveats, etc.)
   * @param checkId  e.g. 'C-1.5'
   * @param opts     { scope, target_url, page_type, mode: 'most_severe' | 'first' }
   */
  constructor(ctx, checkId, opts = {}) {
    this.ctx = ctx;
    this.checkId = checkId;
    this.scope = opts.scope || 'page';
    this.target_url = opts.target_url || null;
    this.page_type = opts.page_type || null;
    this.mode = opts.mode || 'most_severe';
    this.report_section = opts.report_section || sectionOf(checkId);
    this.hits = [];
    this.notes = [];
    this.evidence = [];
    this.caveats = [];
    this.cross = new Set();
    this.metrics = {};
    this.terminal = null; // { status, reason_code, summary }
    this.confidence = 'OBSERVED';
    this.remediation = null;
    this.passSummary = null;
    this.passReason = null;
  }

  /** A matched condition row. `id` is a checkpoint id (C-1.5-g) from the PRD tables. */
  hit(id, { summary, evidence = [], status, severity, caveat, cross_references = [], reason_code, remediation } = {}) {
    const def = CHECKPOINTS[id];
    if (!def) throw new Error(`Unknown checkpoint ${id}`);
    const h = {
      checkpoint: id,
      status: status || def.status,
      severity: severity !== undefined ? severity : def.severity,
      reason_code: reason_code || def.reason_code,
      condition: def.condition,
      summary: summary || def.condition,
      evidence: evidence.filter(Boolean),
      caveat: caveat || null,
      cross_references,
      remediation: remediation || null,
    };
    cross_references.forEach((c) => this.cross.add(c));
    this.hits.push(h);
    return this;
  }

  /** Informational note (does not affect status): positive signals, INFO rows, context. */
  note(reason_code, summary, evidence = []) {
    this.notes.push({ reason_code, summary, evidence: evidence.filter(Boolean) });
    return this;
  }

  addEvidence(...e) {
    this.evidence.push(...e.filter(Boolean));
    return this;
  }

  caveat(text) {
    if (text && !this.caveats.includes(text)) this.caveats.push(text);
    return this;
  }

  xref(...ids) {
    ids.forEach((i) => this.cross.add(i));
    return this;
  }

  metric(k, v) {
    this.metrics[k] = v;
    return this;
  }

  setConfidence(c, caveat) {
    this.confidence = c;
    if (caveat) this.caveat(caveat);
    return this;
  }

  pass(summary, reason_code = null) {
    this.passSummary = summary;
    this.passReason = reason_code;
    return this;
  }

  notApplicable(reason_code, summary) {
    this.terminal = { status: 'NOT_APPLICABLE', reason_code, summary };
    return this;
  }

  notTestable(reason_code, summary, missing = []) {
    this.terminal = { status: 'NOT_TESTABLE', reason_code, summary, missing };
    return this;
  }

  /** Resolve sources for a hit and apply tier discipline (R-SRC-3). */
  _sourcesFor(h) {
    const reg = this.ctx.register;
    const res = reg.resolve(this.checkId, { checkpoint: h.checkpoint, reasonCode: h.reason_code });
    const sources = res.sources.map((s) => ({ ...s }));
    this._lastResolve = res;
    let status = h.status;
    let severity = h.severity;
    let capNote = null;
    if (status === 'FAIL' && !sources.some((s) => STRONG_TIERS.has(s.tier))) {
      const tiers = [...new Set(sources.map((s) => s.tier))].join(', ') || 'none';
      status = 'WARN';
      capNote = `Capped at WARN (R-SRC-3): this finding's only support is ${tiers}, not a standard or vendor documentation.`;
    }
    if (severity === 'CRITICAL' && !sources.some((s) => STRONG_TIERS.has(s.tier))) severity = 'HIGH';
    const toolPolicy = /tool policy/i.test(res.threshold_by || '') || /tool policy/i.test(res.source_class || '');
    return {
      status,
      severity,
      sources,
      capNote,
      reference_url: res.reference_url,
      toolPolicy,
      unsourced_note: res.unsourced_note,
      condition: res.condition,
      // CONDITION = the register maps these sources to this exact condition.
      // FACTOR    = they support the check generally; the register defers to the factor row here.
      source_specificity: res.specificity,
      also_registered: res.also_registered,
    };
  }

  build() {
    const factor = FACTOR_BY_ID.get(this.checkId);
    const base = {
      check_id: this.checkId,
      check_name: factor?.name || this.checkId,
      section: sectionOf(this.checkId),
      report_section: this.report_section,
      scope: this.scope,
      target_url: this.target_url,
      page_type: this.page_type,
      confidence: this.confidence,
      caveat: null,
      caveats: [...this.caveats],
      cross_references: [...this.cross],
      metrics: this.metrics,
      notes: this.notes.map((n) => ({ ...n, ...this._noteSources(n) })),
    };

    // Enrich hits with sources / tier discipline.
    const hits = this.hits.map((h) => {
      const s = this._sourcesFor(h);
      const caveats = [h.caveat, s.capNote, s.toolPolicy ? "Threshold set by this tool's own policy (T1), not a search-engine requirement." : null].filter(Boolean);
      return {
        ...h,
        status: s.status,
        severity: s.status === 'PASS' || s.status === 'NOT_APPLICABLE' || s.status === 'NOT_TESTABLE' || s.status === 'NOTE' ? null : s.severity,
        sources: s.sources,
        reference_url: s.reference_url,
        condition: s.condition,
        source_specificity: s.source_specificity,
        also_registered: s.also_registered,
        caveats,
      };
    });

    let out;
    if (this.terminal) {
      const src = this.ctx.register.resolve(this.checkId, { reasonCode: this.terminal.reason_code });
      out = {
        ...base,
        status: this.terminal.status,
        severity: null,
        reason_code: this.terminal.reason_code,
        summary: this.terminal.summary,
        missing_inputs: this.terminal.missing || [],
        sources: src.sources,
        reference_url: src.reference_url,
        condition: src.condition,
        source_specificity: src.specificity,
        also_registered: src.also_registered,
        evidence: this.evidence,
        sub_findings: hits,
      };
    } else {
      const statusBearing = hits.filter((h) => STATUS_RANK[h.status]);
      const nonPass = statusBearing.filter((h) => h.status !== 'PASS');
      let top = null;
      if (nonPass.length) {
        if (this.mode === 'first') top = nonPass[0];
        else
          top = [...nonPass].sort(
            (a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || (SEV_RANK[b.severity] ?? -1) - (SEV_RANK[a.severity] ?? -1),
          )[0];
      }
      const ntHit = hits.find((h) => h.status === 'NOT_TESTABLE' || h.status === 'NOT_APPLICABLE');
      if (top) {
        out = {
          ...base,
          status: top.status,
          severity: top.severity,
          reason_code: top.reason_code,
          summary: top.summary,
          sources: top.sources,
          reference_url: top.reference_url,
          condition: top.condition,
          source_specificity: top.source_specificity,
          also_registered: top.also_registered,
          evidence: [...top.evidence, ...this.evidence],
          remediation: top.remediation || this.remediation,
          sub_findings: hits,
        };
      } else if (ntHit && !statusBearing.length) {
        out = { ...base, status: ntHit.status, severity: null, reason_code: ntHit.reason_code, summary: ntHit.summary, sources: ntHit.sources, reference_url: ntHit.reference_url, evidence: [...ntHit.evidence, ...this.evidence], sub_findings: hits };
      } else {
        const passCp = `${this.checkId}-a`;
        const passHit = statusBearing.find((h) => h.status === 'PASS');
        const src = this._sourcesFor({ checkpoint: passHit?.checkpoint || (CHECKPOINTS[passCp] ? passCp : null), reason_code: passHit?.reason_code || this.passReason, status: 'PASS' });
        out = {
          ...base,
          status: 'PASS',
          severity: null,
          reason_code: passHit?.reason_code || this.passReason || null,
          summary: passHit?.summary || this.passSummary || 'All binding conditions met.',
          sources: src.sources,
          reference_url: src.reference_url,
          condition: src.condition,
          source_specificity: src.source_specificity,
          also_registered: src.also_registered,
          evidence: [...(passHit?.evidence || []), ...this.evidence],
          sub_findings: hits,
        };
      }
    }

    // Caveat roll-up for the top level
    const allCaveats = [...out.caveats];
    for (const h of hits) if (h === hits.find((x) => x.reason_code === out.reason_code)) allCaveats.push(...h.caveats);
    out.caveats = [...new Set(allCaveats)];
    out.caveat = out.caveats[0] || null;

    // Contract enforcement → ERROR (R-STATUS-3/4/6)
    if (out.status === 'PASS' && !out.evidence.length) {
      out.status = 'ERROR';
      out.reason_code = 'CONTRACT_PASS_WITHOUT_EVIDENCE';
      out.summary = 'Tool defect: PASS emitted without evidence (R-STATUS-4).';
    }
    if (!['PASS'].includes(out.status) && !out.reason_code) {
      out.status = 'ERROR';
      out.reason_code = 'CONTRACT_MISSING_REASON_CODE';
      out.summary = 'Tool defect: non-PASS status without reason_code (R-STATUS-3).';
    }
    if ((out.confidence === 'MODELLED' || out.confidence === 'THIRD_PARTY') && !out.caveats.length) {
      out.caveats.push(out.confidence === 'MODELLED' ? 'Modelled estimate against a fixed rubric.' : 'Third-party data; freshness and coverage not controlled by this tool.');
      out.caveat = out.caveats[0];
    }
    if (out.status === 'NOT_TESTABLE' || out.status === 'NOT_APPLICABLE') out.score = null; // F-NEVER-6
    return out;
  }

  _noteSources(n) {
    const res = this.ctx.register.resolve(this.checkId, { reasonCode: n.reason_code });
    return { sources: res.sources, reference_url: res.reference_url, condition: res.condition, source_specificity: res.specificity, also_registered: res.also_registered };
  }
}

/** ERROR result for an unhandled exception at a check boundary (F-RUN-9). */
export function errorResult(ctx, checkId, err, target_url = null) {
  return {
    check_id: checkId,
    check_name: FACTOR_BY_ID.get(checkId)?.name || checkId,
    section: sectionOf(checkId),
    report_section: sectionOf(checkId),
    scope: target_url ? 'page' : 'site',
    target_url,
    status: 'ERROR',
    severity: null,
    confidence: 'OBSERVED',
    reason_code: 'CHECK_EXCEPTION',
    summary: `Tool defect in ${checkId}: ${err?.message || err}`,
    stack_ref: String(err?.stack || '').split('\n').slice(0, 4).join(' | '),
    caveat: null,
    caveats: [],
    sources: [],
    evidence: [],
    sub_findings: [],
    cross_references: [],
    notes: [],
    metrics: {},
  };
}

/** Results for checks that never ran because the robots.txt gate halted the pipeline. */
export function haltedResult(ctx, checkId, gateReason) {
  return {
    check_id: checkId,
    check_name: FACTOR_BY_ID.get(checkId)?.name || checkId,
    section: sectionOf(checkId),
    report_section: sectionOf(checkId),
    scope: 'site',
    target_url: null,
    status: 'NOT_TESTABLE',
    severity: null,
    confidence: 'OBSERVED',
    reason_code: gateReason === 'BLOCKED' ? 'BLOCKED_BY_ROBOTS_FOR_AUDITOR' : 'ROBOTS_UNAVAILABLE_CONSERVATIVE_MODE',
    summary: 'Not evaluated — the pipeline halted at the robots.txt gate (1. Crawl & Indexing › robots.txt did not complete successfully).',
    halted: true,
    caveat: null,
    caveats: [],
    sources: [],
    evidence: [],
    sub_findings: [],
    cross_references: ['C-1.1'],
    notes: [],
    metrics: {},
  };
}
