// Global configuration — PRD §2. Every value here is configuration, not a constant:
// defaults are binding when unset; overrides come from config/audit.config.json or the caller.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..');

// Load .env (gitignored) so keys live outside the committed config. Variables already set in the
// environment win, so CI and shell exports are never overridden by the file.
try {
  const envFile = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
} catch {
  // Node < 20.12 has no loadEnvFile; fall back to a minimal KEY=VALUE parse.
  try {
    for (const line of fs.readFileSync(path.join(PROJECT_ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // No .env file: keys come from the environment, or the affected checks report NOT_TESTABLE.
  }
}

// Bump this whenever a change can alter a verdict, a score or a citation. A report carries the
// version that produced it, so a stale report is identifiable instead of silently outranked by
// newer logic. 1.2.0: verdict split (BLOCKED vs CRITICAL_ISSUES), sitemap canonical-host rule,
// trailing-slash variant check, per-source citation notes.
export const TOOL_VERSION = '1.2.0';
export const RUBRIC_VERSION = 's6-2026-09';
export const THRESHOLD_SET_VERSION = '2026-09';

export const DEFAULTS = {
  // §2.1 capability flags
  cap: {
    render_js: true,
    psi_api: true,
    crux_api: true,
    gsc_api: false,
    // Index presence via a SERP provider (X-1.8). On only when a key is configured: without one
    // the check reports NOT_TESTABLE rather than guessing.
    serp_api: true,
    llm_judge: true,
    ua_probe: false,
    commoncrawl: true, // discovery only (B-A1-4)
  },
  // §2.2 network policy
  net: {
    user_agent: 'WellowsAuditBot/1.0 (+{contact_url})',
    contact_url: 'https://wellows.com/ai-info',
    url_budget_ms: 30000,
    unresponsive_ms: 20000,
    secondary_budget_ms: 10000,
    secondary_unresponsive_ms: 8000,
    timeout_connect_ms: 5000,
    timeout_read_ms: 12000,
    backoff_ms: [750, 2000],
    retry_on: [429, 500, 502, 503, 504, 408],
    max_redirect_hops: 10,
    concurrency_per_host: 2,
    min_delay_ms: 500,
    max_response_bytes: 10485760,
    respect_robots: true,
    follow_meta_refresh: false,
    second_resolvers: ['1.1.1.1', '8.8.8.8'],
  },
  // §2.3 thresholds — single registry, nothing hard-coded elsewhere
  th: {
    robots_max_bytes: 512000,
    robots_max_redirect_hops: 5,
    redirect_chain_warn: 2,
    redirect_chain_fail: 5,
    googlebot_bytes_supported_type: 2097152,
    googlebot_bytes_pdf: 67108864,
    crawler_bytes_default: 15728640,
    lcp_good_ms: 2500,
    lcp_poor_ms: 4000,
    inp_good_ms: 200,
    inp_poor_ms: 500,
    cls_good: 0.1,
    cls_poor: 0.25,
    cwv_percentile: 75,
    title_len_warn_min: 15,
    title_len_warn_max: 70,
    metadesc_len_warn_min: 50,
    metadesc_len_warn_max: 165,
    raw_text_ratio_fail: 0.3,
    raw_text_ratio_warn: 0.7,
    min_words_content_page: 150,
    freshness_stale_days: 540,
    freshness_warn_days: 365,
  },
  schema: { min_sameas: 2 },
  render: { raw_text_floor: 500, budget_ms: 10000, viewport: { width: 412, height: 915 } },
  discovery: { max_links_per_page: 500, max_fetches: 60 },
  group: { slug_collapse_min: 2, saturation_cap: 20, max_groups: 200 },
  // max_paths bounds how many declared Sitemap: URLs are followed; max_requests bounds the whole
  // variant matrix. Hostname convergence is deliberately not a sitemap condition: a sitemap that
  // answers 200 at more than one address is still a working sitemap, and consolidation is scored
  // under C-1.4 and C-1.5 where it belongs.
  sitemap: { max_paths: 5, max_requests: 24 },
  links: { max_validations: 25 },
  hreflang: { max_alternates: 15 },
  cwv: { max_calls: 24, psi_timeout_ms: 90000, concurrency: 4 },
  ai_agents: { max_probes: 6 },
  llms: { max_link_checks: 25 },
  ai_page: { max_probes: 12 },
  structure: { max_section_words: 400, max_para_words: 150 },
  currency: { max_claims: 5 },
  llm: {
    max_calls_per_run: 20,
    model: 'claude-opus-5',
    max_chars: 12000,
    // Share of the run budget reserved per rubric, so one check cannot consume it all.
    budget_share: { 'C-6.2': 0.35, 'C-6.3': 0.1, 'C-6.4': 0.35, 'C-6.5': 0.2 },
    // A call budget alone does not bound a run: one request that never answers stalls the pipeline
    // past run.max_minutes, because the deadline is only tested between operations. So each call
    // gets a wall-clock limit, and the SDK is told how many times it may retry — its own defaults
    // are a 10-minute timeout and 2 retries, which is 30 minutes of silence for a single rubric.
    request_timeout_ms: 120000,
    max_retries: 1,
  },
  run: { max_minutes: 30 },
  // Section weights — R-SCORE-4
  weights: { 1: 30, 2: 15, 3: 20, 4: 10, 5: 10, 6: 15 },
  // Operator inputs
  env: 'production',
  force_crawl: false,
  expected_noindex_paths: ['/cart', '/checkout', '/account', '/login', '/wp-admin', '/search', '/thank-you'],
  expected_temporary_paths: [],
  expected_standalone_paths: [],
  policy: { ai_blocking_intentional: false, rebranding: false },
  operator_urls: [],
  // Audit exactly the supplied URLs and skip discovery entirely (E-A4-9).
  operator_urls_only: false,
  // Gate mode for the robots.txt entry check.
  //  strict — the operator directive: any non-successful robots.txt result halts every further factor.
  //  prd    — PRD F-RUN-6/F-RUN-8: control-file checks (C-1.1, C-1.2, C-5.3) still run.
  gate: { robots_mode: 'strict' },
  // API keys, read from the environment only — never written to a report, a log or the UI.
  // SERP lookups (X-1.8). One request per run: a site: query against the canonical host.
  // country must be an upper-case ISO-3166 code; the provider rejects lower case.
  serp: { country: 'US', timeout_ms: 45000 },
  keys: {
    google_api_key: process.env.GOOGLE_API_KEY || process.env.PSI_API_KEY || process.env.CRUX_API_KEY || '',
    cloro_api_key: process.env.CLORO_API_KEY || '',
    // DataForSEO is used as a fetch transport, not as a data source: it crawls from its own proxy
    // pool, which is the point - an identified bot on a datacentre IP gets challenged. Basic auth,
    // login and password, exactly as DataForSEO issues them.
    dataforseo_login: process.env.DATAFORSEO_LOGIN || '',
    dataforseo_password: process.env.DATAFORSEO_PASSWORD || '',
  },
  // The fixed schema registry is loaded from config/schema.fixed_set.json (C-3.1 §3.1.0).
};

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, over) {
  if (!isObj(over)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(overrides = {}) {
  let fileCfg = {};
  const p = path.join(PROJECT_ROOT, 'config', 'audit.config.json');
  if (fs.existsSync(p)) fileCfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  const cfg = deepMerge(deepMerge(DEFAULTS, fileCfg), overrides);
  cfg.net.user_agent_resolved = cfg.net.user_agent.replace('{contact_url}', cfg.net.contact_url);
  cfg.schema.fixed_set = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'schema.fixed_set.json'), 'utf8'),
  );
  if (!cfg.keys.google_api_key) {
    // C-4.1-j: no key → CWV NOT_TESTABLE / CWV_NO_API_KEY. Recorded, not guessed.
    cfg.cap.crux_api_key_missing = true;
  }
  return cfg;
}
