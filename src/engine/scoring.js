// Appendix A — Scoring. Per section, then rolled up. Never a flat percentage of all checks.
//  R-SCORE-1  PASS 1.0 · WARN 0.5 − (0.1 × severity_rank), floored at 0.1 · FAIL 0.0
//             NOT_APPLICABLE / NOT_TESTABLE / ERROR excluded from numerator and denominator
//  R-SCORE-2  page-level checks score as the mean across pages; the per-page breakdown is kept
//  R-SCORE-5  any CRITICAL FAIL caps the overall score at 40 and forces verdict BLOCKED
//  R-SCORE-6  > 25% not-testable ⇒ score suppressed, replaced by INSUFFICIENT_EVIDENCE
//  R-SCORE-9  a finding is scored in its report_section and in no other
import { SECTIONS, FACTORS } from './catalog.js';
import { SEV_RANK } from './result.js';

export function pointsFor(result) {
  if (result.status === 'PASS') return 1.0;
  if (result.status === 'FAIL') return 0.0;
  if (result.status === 'WARN') {
    const rank = SEV_RANK[result.severity] ?? 1;
    return Math.max(0.1, 0.5 - 0.1 * rank);
  }
  return null; // NOT_APPLICABLE / NOT_TESTABLE / ERROR — excluded entirely
}

export function computeScores(report, cfg) {
  const weights = cfg.weights;
  const results = report.results;

  // Group results by check, then by the section each finding is routed to (R-SCORE-9).
  const byCheck = new Map();
  for (const r of results) {
    const key = `${r.check_id}|${r.report_section}`;
    if (!byCheck.has(key)) byCheck.set(key, { check_id: r.check_id, section: r.report_section, results: [] });
    byCheck.get(key).results.push(r);
  }

  const checkScores = [];
  for (const { check_id, section, results: rs } of byCheck.values()) {
    const scored = rs.map((r) => ({ r, points: pointsFor(r) }));
    const eligible = scored.filter((x) => x.points != null);
    const notApplicable = rs.filter((r) => r.status === 'NOT_APPLICABLE').length;
    const notTestable = rs.filter((r) => r.status === 'NOT_TESTABLE').length;
    const errors = rs.filter((r) => r.status === 'ERROR').length;
    const score = eligible.length ? eligible.reduce((a, x) => a + x.points, 0) / eligible.length : null; // R-SCORE-2 mean across pages
    checkScores.push({
      check_id,
      check_name: rs[0].check_name,
      section,
      score,
      evaluated: eligible.length,
      not_applicable: notApplicable,
      not_testable: notTestable,
      errors,
      modelled: rs.some((r) => r.confidence === 'MODELLED'),
      third_party: rs.some((r) => r.confidence === 'THIRD_PARTY'),
      per_target: scored.map((x) => ({ target_url: x.r.target_url, page_type: x.r.page_type, scope: x.r.scope, status: x.r.status, severity: x.r.severity, reason_code: x.r.reason_code, points: x.points })),
      worst: eligible.length ? eligible.reduce((a, x) => (x.points < a.points ? x : a)).r.status : rs[0].status,
    });
  }

  // Section scores (R-SCORE-3): Σ points ÷ Σ eligible checks, counting each check once.
  const sections = SECTIONS.map((s) => {
    const checks = checkScores.filter((c) => c.section === s.id);
    const eligible = checks.filter((c) => c.score != null);
    const score = eligible.length ? eligible.reduce((a, c) => a + c.score, 0) / eligible.length : null;
    const unspecified = FACTORS.filter((f) => f.section === s.id && f.unspecified);
    return {
      section: s.id,
      name: s.name,
      score,
      weight: weights[s.id],
      evaluated: eligible.length,
      not_applicable: checks.filter((c) => c.score == null && c.not_applicable && !c.not_testable).length,
      not_testable: checks.filter((c) => c.score == null && c.not_testable).length,
      errors: checks.reduce((a, c) => a + c.errors, 0),
      modelled: checks.some((c) => c.modelled),
      third_party: checks.some((c) => c.third_party),
      unspecified_factors: unspecified.map((f) => ({ id: f.id, name: f.name, note: f.note })),
      checks: checks.map((c) => c.check_id),
    };
  });

  // Overall: weighted mean of section scores (R-SCORE-4), using only sections with a score.
  const scored = sections.filter((s) => s.score != null);
  const totalWeight = scored.reduce((a, s) => a + s.weight, 0);
  let overall = totalWeight ? scored.reduce((a, s) => a + s.score * s.weight, 0) / totalWeight : null;

  // R-SCORE-5 gating: any CRITICAL FAIL caps at 40 and forces BLOCKED.
  const criticalFails = results.filter((r) => r.status === 'FAIL' && r.severity === 'CRITICAL');
  const gatedBy = criticalFails.map((r) => `${r.check_id}: ${r.reason_code}`);
  let verdict;
  let suppressed = false;

  // R-SCORE-6: suppress the score when more than a quarter of in-scope checks are untestable.
  const inScope = checkScores.filter((c) => c.score != null || c.not_testable);
  const untestable = checkScores.filter((c) => c.score == null && c.not_testable);
  const untestableShare = inScope.length ? untestable.length / inScope.length : 0;
  const missingInputs = [...new Set(results.filter((r) => r.status === 'NOT_TESTABLE').map((r) => r.reason_code))];

  if (untestableShare > 0.25) {
    suppressed = true;
    overall = null;
    verdict = 'INSUFFICIENT_EVIDENCE';
  } else if (criticalFails.length) {
    overall = Math.min(overall ?? 0, 0.4);
    verdict = 'BLOCKED';
  } else if (overall == null) {
    verdict = 'INSUFFICIENT_EVIDENCE';
  } else {
    verdict = overall >= 0.85 ? 'HEALTHY' : 'NEEDS_WORK';
  }
  if (report.run.run_status === 'ABORTED' && report.run.gate && report.run.gate.passed === false) {
    verdict = 'BLOCKED';
    overall = overall == null ? null : Math.min(overall, 0.4);
  }

  const caveats = [];
  if (sections.some((s) => s.modelled)) caveats.push('Section 6 sub-scores are modelled estimates against a fixed rubric, not measurements of retrieval behaviour by any specific AI system.');
  if (sections.some((s) => s.third_party)) caveats.push('Core Web Vitals come from a third-party API whose freshness and coverage this tool does not control.');
  if (untestable.length) caveats.push(`${untestable.length} check(s) were not testable and are excluded from every score; they are listed separately.`);
  if (report.run.capabilities && !report.run.capabilities.render_js) caveats.push('Rendering was unavailable for this run: raw HTML only, JavaScript-injected values not evaluated.');
  if (suppressed) caveats.push(`Overall score suppressed: ${Math.round(untestableShare * 100)}% of in-scope checks were not testable (R-SCORE-6). A score computed over a quarter-blind audit is worse than no score.`);

  // Error distribution for the dashboard (counts by status, severity, section and reason code).
  const distribution = errorDistribution(results);

  return {
    sections,
    checks: checkScores,
    overall: overall == null ? null : Number(overall.toFixed(3)),
    overall_percent: overall == null ? null : Math.round(overall * 100),
    verdict,
    suppressed,
    gated_by: gatedBy,
    missing_inputs: suppressed || untestable.length ? missingInputs : [],
    not_testable_share: Number(untestableShare.toFixed(3)),
    caveats,
    distribution,
    weights,
  };
}

export function errorDistribution(results) {
  const byStatus = { PASS: 0, WARN: 0, FAIL: 0, NOT_APPLICABLE: 0, NOT_TESTABLE: 0, ERROR: 0 };
  const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  const bySection = {};
  const byReason = new Map();
  const seen = new Set();
  for (const r of results) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if ((r.status === 'FAIL' || r.status === 'WARN') && r.severity) bySeverity[r.severity]++;
    const s = r.report_section;
    bySection[s] ||= { PASS: 0, WARN: 0, FAIL: 0, NOT_APPLICABLE: 0, NOT_TESTABLE: 0, ERROR: 0 };
    bySection[s][r.status] = (bySection[s][r.status] || 0) + 1;
    if (r.status === 'FAIL' || r.status === 'WARN') {
      const key = r.reason_code || 'UNSPECIFIED';
      if (!byReason.has(key)) byReason.set(key, { reason_code: key, count: 0, severity: r.severity, status: r.status, check_id: r.check_id, check_name: r.check_name, section: r.report_section, summary: r.summary });
      byReason.get(key).count++;
    }
    seen.add(r.check_id);
  }
  const top = [...byReason.values()].sort((a, b) => b.count - a.count || (SEV_RANK[b.severity] ?? -1) - (SEV_RANK[a.severity] ?? -1)).slice(0, 25);
  return { by_status: byStatus, by_severity: bySeverity, by_section: bySection, by_reason_code: top, total_findings: results.filter((r) => r.status === 'FAIL' || r.status === 'WARN').length };
}
