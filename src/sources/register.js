// Source register — reads the Source Reference file (.xlsx) at runtime and maps every
// check / checkpoint / reason_code to its sources (PRD §4.1, R-SRC-1…R-SRC-7).
import fs from 'node:fs';
import path from 'node:path';
import { readXlsx } from './xlsx.js';
import { PROJECT_ROOT } from '../config.js';

export const DEFAULT_REGISTER_PATH = path.join(PROJECT_ROOT, 'technicalaudittoolPRD_v2_source_register.xlsx');

// Source class (register) → tier (PRD R-SRC-2). The register's own vocabulary is kept alongside.
const CLASS_TO_TIER = [
  [/google\s*[—-]\s*documented/i, 'VENDOR_DOC'],
  [/^standard/i, 'STANDARD'],
  [/vendor declaration/i, 'VENDOR_DOC'],
  [/vendor statement/i, 'VENDOR_STATEMENT'],
  [/industry research|industry study/i, 'INDUSTRY_STUDY'],
  [/commentary/i, 'INDUSTRY_COMMENTARY'],
  [/proposed/i, 'VENDOR_DOC'],
  [/third-party corpus/i, 'VENDOR_DOC'],
  [/tool policy/i, 'TOOL_POLICY'],
];

// Authority order for display: the reader should meet the strongest source first (R-SRC-3).
export const TIER_RANK = { STANDARD: 0, VENDOR_DOC: 1, VENDOR_STATEMENT: 2, INDUSTRY_STUDY: 3, INDUSTRY_COMMENTARY: 4, TOOL_POLICY: 5 };
export const STRONG_TIERS = new Set(['STANDARD', 'VENDOR_DOC']);

/**
 * Implementation specifications hidden from findings by default.
 *
 * These define how software must behave, not what a site owner should do. A marketing reader shown
 * RFC 9110 alongside "your redirect chain is two hops" learns nothing they can act on, and a
 * citation that cannot be acted on erodes trust in the ones that can. Verified above: no finding
 * loses its only source, and no FAIL loses its only authoritative source, so tier discipline
 * (R-SRC-3) is unaffected. Override with sources.hide_refs in config/audit.config.json.
 */
export const DEFAULT_HIDDEN_REFS = ['P1', 'R1', 'R2', 'R3', 'R4'];

const STOP_TERMS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'not', 'are', 'was', 'its', 'per', 'any', 'all', 'one', 'two', 'more', 'than', 'when', 'where', 'which', 'what', 'into', 'over', 'under', 'only', 'other', 'their', 'there', 'have', 'has', 'been', 'but', 'set', 'used', 'using', 'use', 'page', 'pages', 'site', 'sites', 'google', 'search', 'tool', 'rule', 'rules', 'source', 'sources', 'documented', 'documents', 'document']);

// reason_code shorthand expanded to the words a source's statement would actually use.
const CODE_WORDS = {
  METADESC: 'meta description snippet',
  CWV: 'core web vitals performance',
  LCP: 'largest contentful paint',
  INP: 'interaction next paint',
  CLS: 'cumulative layout shift',
  SD: 'structured data',
  FAQ: 'faqpage structured data',
  JSONLD: 'structured data json',
  HREFLANG: 'hreflang localized language',
  ROBOTS: 'robots.txt crawling',
  CANONICAL: 'canonical canonicalisation duplicate',
  NOINDEX: 'robots meta indexing',
  TITLE: 'title link',
  H1: 'heading',
  AI: 'ai crawler',
  LLMS: 'llms.txt',
};

function terms(text) {
  let t = String(text || '');
  for (const [code, words] of Object.entries(CODE_WORDS)) {
    if (new RegExp(`\\b${code}\\b`, 'i').test(t)) t += ` ${words}`;
  }
  return new Set(
    t
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOP_TERMS.has(w))
      .map((w) => w.replace(/(ing|ed|es|s)$/, '')),
  );
}

/** Related if a term matches, or one is a prefix of the other (canonical ↔ canonicalisation). */
function related(a, b) {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      if (x.length >= 5 && y.startsWith(x)) return true;
      if (y.length >= 5 && x.startsWith(y)) return true;
    }
  }
  return false;
}

/**
 * Does this source's registered statement address the condition in front of the reader?
 *
 * F-SRC-2: "Never cite a source that does not address the specific finding … the note must be
 * defensible on its own." A ~155-160 character length study is registered against the meta
 * description factor, but it says nothing about a keyword-list finding, and showing it there
 * invites exactly the distrust that citations exist to prevent. Judged on the register's own
 * words — the source's statement of what it supports against the condition's own text — so the
 * decision is traceable rather than an opinion of this tool's.
 */
export function addressesCondition(source, condition, reasonCode) {
  if (!source) return false;
  // Standards, vendor documentation, vendor statements and the tool's own policy are the register's
  // authoritative mapping for the check, and under R-SRC-3 they are the only tiers that can support
  // a FAIL at all. They are never filtered out — only the corroborating tiers are tested, because
  // those are the ones that add noise without adding authority.
  if (source.tier !== 'INDUSTRY_STUDY' && source.tier !== 'INDUSTRY_COMMENTARY') return true;
  const subject = terms(`${condition || ''} ${String(reasonCode || '').replace(/_/g, ' ')}`);
  if (!subject.size) return true; // nothing to test against; the register's mapping stands
  return related(subject, terms(source.supports || source.note || ''));
}

export function tierOf(sourceClass) {
  for (const [re, tier] of CLASS_TO_TIER) if (re.test(sourceClass || '')) return tier;
  return 'INDUSTRY_COMMENTARY';
}

const splitRefs = (s) =>
  String(s || '')
    .split(/[,;]\s*/)
    .map((x) => x.trim())
    .filter(Boolean);

const leadingCode = (s) => {
  const m = /^[A-Z][A-Z0-9_]{2,}/.exec(String(s || '').trim());
  return m ? m[0] : null;
};

function rowsToObjects(rows) {
  if (!rows?.length) return [];
  const header = rows[0].map((h) => String(h).trim());
  return rows
    .slice(1)
    .filter((r) => r.some((c) => String(c).trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, String(r[i] ?? '').trim()])));
}

export class SourceRegister {
  constructor(filePath = DEFAULT_REGISTER_PATH, { hideRefs = DEFAULT_HIDDEN_REFS } = {}) {
    this.hiddenRefs = new Set(hideRefs);
    this.filePath = filePath;
    this.mtime = 0;
    this.load();
  }

  /** Re-read the file whenever it changes on disk. */
  refresh() {
    try {
      const m = fs.statSync(this.filePath).mtimeMs;
      if (m !== this.mtime) this.load();
    } catch {
      /* keep the last good copy */
    }
    return this;
  }

  load() {
    const sheets = readXlsx(this.filePath);
    this.mtime = fs.statSync(this.filePath).mtimeMs;
    this.loadedAt = new Date().toISOString();

    this.sources = new Map();
    for (const r of rowsToObjects(sheets.Sources)) {
      if (!r.Ref) continue;
      this.sources.set(r.Ref, {
        ref: r.Ref,
        publisher: r.Publisher,
        title: r.Document,
        url: /^https?:\/\//.test(r.URL) ? r.URL : null,
        url_raw: r.URL,
        source_class: r['Source class'],
        tier: tierOf(r['Source class']),
        verified: r['URL verified in this pass'],
        supports: r['What it supports'],
      });
    }

    this.factors = new Map();
    for (const r of rowsToObjects(sheets.Factors)) {
      if (!/^C-\d/.test(r.Factor)) continue;
      this.factors.set(r.Factor, {
        check_id: r.Factor,
        name: r.Name,
        section: r.Section,
        refs: splitRefs(r['Source refs']),
        primary_url: /^https?:/.test(r['Primary reference URL']) ? r['Primary reference URL'] : null,
        source_class: r['Source class'],
        supports: r['What the sources actually support'],
      });
    }

    this.checkpoints = new Map();
    this.byReason = new Map(); // reason_code → [checkpoint]
    for (const r of rowsToObjects(sheets.Checkpoints)) {
      if (!/^C-\d/.test(r.Checkpoint)) continue;
      const cp = {
        check_id: r.Factor,
        checkpoint: r.Checkpoint,
        condition: r.Condition,
        status: r.Status,
        severity: r.Severity,
        reason_code: leadingCode(r.reason_code),
        reason_text: r.reason_code,
        refs: splitRefs(r['Source refs']),
        reference_url: /^https?:/.test(r['Reference URL']) ? r['Reference URL'] : null,
        source_class: r['Source class'],
        threshold_by: r['Threshold set by'],
        note: r['What the source supports / gap'],
      };
      this.checkpoints.set(cp.checkpoint, cp);
      if (cp.reason_code) {
        if (!this.byReason.has(cp.reason_code)) this.byReason.set(cp.reason_code, []);
        this.byReason.get(cp.reason_code).push(cp);
      }
    }

    this.unsourced = new Map();
    for (const r of rowsToObjects(sheets.Unsourced)) {
      if (r.Checkpoint) this.unsourced.set(r.Checkpoint, r['Why this is not externally sourced']);
    }
    return this;
  }

  /**
   * One source, carrying its own registered statement of what it establishes.
   *
   * R-SRC-6 requires the note to say what *that* source establishes for the finding. Passing one
   * shared note to every source made three different documents display identical text — and on a
   * keyword-stuffing finding that text was about character limits, which F-SRC-2 forbids.
   */
  source(ref, { specificity = 'FACTOR' } = {}) {
    const s = this.sources.get(ref);
    if (!s) return null;
    return {
      ref: s.ref,
      publisher: s.publisher,
      title: s.title,
      url: s.url,
      tier: s.tier,
      source_class: s.source_class,
      verified: s.verified,
      note: s.supports, // what this source establishes, in the register's own words
      specificity, // CONDITION = registered against this exact condition · FACTOR = supports the check generally
    };
  }

  /**
   * Resolve sources for a finding (R-SRC-6). Lookup order: explicit checkpoint → the checkpoint
   * carrying this reason_code in this check → any checkpoint with this reason_code → factor refs.
   *
   * The register marks 251 of its 322 rows as inheriting the factor-level source, so most findings
   * are supported at factor level rather than against the exact condition. That distinction is
   * carried through rather than flattened: presenting factor-level support as though it addressed
   * the specific condition is the failure F-SRC-2 names.
   */
  resolve(checkId, { checkpoint, reasonCode, extraRefs = [] } = {}) {
    let cp = checkpoint ? this.checkpoints.get(checkpoint) : null;
    if (!cp && reasonCode) {
      const list = this.byReason.get(reasonCode) || [];
      cp = list.find((c) => c.check_id === checkId) || list[0] || null;
    }
    const factor = this.factors.get(checkId);
    // extraRefs cite registered entries on a finding the register does not itself map to them.
    // Used only where an operator rule extends the PRD and the supporting document already exists
    // in the register — never to invent a source.
    const refs = [...new Set([...(cp?.refs?.length ? cp.refs : factor?.refs || []), ...extraRefs])];
    const inherits = !cp?.note || /^inherits the factor-level source/i.test(cp.note);
    const narrowed = !!cp && !!factor && JSON.stringify(cp.refs) !== JSON.stringify(factor.refs);
    // A row is condition-specific when the register wrote a note for it rather than deferring to the
    // factor, or narrowed its refs away from the factor's list.
    const specificity = !inherits || narrowed ? 'CONDITION' : 'FACTOR';
    const all = refs
      .filter((r) => !this.hiddenRefs.has(r))
      .map((r) => this.source(r, { specificity }))
      .filter(Boolean)
      .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
    // Split what supports this finding from what is merely registered against the factor, so the
    // reader is never shown a citation that does not address what they are reading (F-SRC-2).
    const condition = cp?.condition || null;
    const code = cp?.reason_code || reasonCode || null;
    const sources = all.filter((s) => addressesCondition(this.sources.get(s.ref), condition, code));
    const alsoRegistered = all.filter((s) => !sources.includes(s));
    // The headline reference is the strongest source that both resolves and addresses the finding.
    const primary = sources.find((s) => s.url && STRONG_TIERS.has(s.tier)) || sources.find((s) => s.url);
    return {
      checkpoint: cp?.checkpoint || null,
      condition,
      specificity,
      condition_note: cp?.note || factor?.supports || null,
      also_registered: alsoRegistered,
      registered_refs: refs,
      reference_url: primary?.url || null,
      source_class: cp?.source_class || factor?.source_class || null,
      threshold_by: cp?.threshold_by || null,
      unsourced_note: cp ? this.unsourced.get(cp.checkpoint) || null : null,
      sources,
    };
  }

  /** Payload served to the UI for hover affordances. */
  toJSON() {
    return {
      file: path.basename(this.filePath),
      loaded_at: this.loadedAt,
      sources: Object.fromEntries(this.sources),
      factors: Object.fromEntries(this.factors),
      checkpoints: Object.fromEntries(this.checkpoints),
      unsourced: Object.fromEntries(this.unsourced),
    };
  }
}

let singleton = null;
export function getRegister(filePath) {
  if (!singleton || (filePath && singleton.filePath !== filePath)) singleton = new SourceRegister(filePath);
  return singleton.refresh();
}
