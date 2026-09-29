// C-5.1 — AI Crawler Access (site · RAW · depends on C-1.1).
// Section-wide note: Google states there are no additional requirements to appear in AI Overviews
// or AI Mode, and no "AI text files" are needed. Everything here is optional and additive.
import { ResultBuilder, ev, errorResult } from '../engine/result.js';
import { evaluate, selectGroup } from '../parse/robots.js';
import { AI_AGENTS, RETRIEVAL_AGENTS, TRAINING_AGENTS, KNOWN_NON_AI } from './ai_agents.js';

const CONTENT_PATHS = ['/blog/', '/docs/', '/resources/', '/news/', '/articles/', '/insights/', '/guides/', '/learn/'];
const HYGIENE_PATHS = ['/cart', '/account', '/checkout', '/admin', '/wp-admin', '/search', '/login'];

export async function run(ctx) {
  try {
    return [await evaluateCheck(ctx)];
  } catch (e) {
    return [errorResult(ctx, 'C-5.1', e)];
  }
}

async function evaluateCheck(ctx) {
  const b = new ResultBuilder(ctx, 'C-5.1', { scope: 'site', target_url: `${ctx.canonicalOrigin}/robots.txt` });
  const state = ctx.robots?.state;
  let parsed = ctx.robots?.parsed;
  // C-A2-b / C-1.1-f: a 4xx (or an unparseable-but-served) robots.txt means no restrictions, exactly
  // as Google treats it — every agent is allowed, with no rule recorded. Only a genuinely unavailable
  // file (5xx, 429, network error) makes per-agent access untestable (C-5.1-n).
  const noRestrictions = !parsed && ['ABSENT', 'REDIRECT_CHAIN', 'HTML'].includes(state);
  if (noRestrictions) parsed = { groups: [], byToken: new Map(), sitemaps: [], lineClasses: [], fileContentSignals: [], validGroupCount: 0 };
  if (!parsed) {
    b.notTestable('ROBOTS_UNAVAILABLE', `robots.txt is unavailable (state: ${state || 'unknown'}, HTTP ${ctx.robots?.record?.status ?? 'no response'}), so per-agent access cannot be evaluated.`);
    b.addEvidence(ev({ kind: 'http_status', source_url: ctx.robots?.url || `${ctx.canonicalOrigin}/robots.txt`, fetch_profile: 'RAW', selector_or_key: 'status', observed_value: ctx.robots?.record?.status == null ? null : String(ctx.robots.record.status) }));
    return b.build();
  }
  if (noRestrictions) {
    b.caveat(state === 'ABSENT'
      ? `robots.txt returns HTTP ${ctx.robots.record.status}, which Google treats as no restrictions: every agent below is allowed by absence of rules, not by a deliberate decision.`
      : 'robots.txt contains no usable directives, so every agent is allowed by absence of rules.');
  }

  // R-5.1-1 — token × path matrix, with the three-state distinction (R-5.1-2).
  const paths = ['/', ...ctx.pages.map((p) => new URL(p.finalUrl).pathname + new URL(p.finalUrl).search)];
  const uniquePaths = [...new Set(paths)];
  const matrix = [];
  const posture = {};
  for (const agent of AI_AGENTS) {
    const cells = uniquePaths.map((path) => {
      const v = evaluate(parsed, agent.token.toLowerCase(), path);
      return { path, verdict: v.verdict, explicit: v.explicit, via: v.token, rule: v.rule ? `${v.rule.type}: ${v.rule.path} (line ${v.rule.line_no})` : null };
    });
    const root = cells[0];
    const anyDisallowed = cells.some((c) => c.verdict === 'DISALLOWED');
    const allDisallowed = cells.every((c) => c.verdict === 'DISALLOWED');
    const hasOwnGroup = [...parsed.byToken.keys()].includes(agent.token.toLowerCase());
    let p;
    if (!hasOwnGroup && !cells.some((c) => c.explicit)) p = 'UNDECLARED';
    else if (allDisallowed) p = 'BLOCKED';
    else if (anyDisallowed) p = 'PARTIAL';
    else p = 'OPEN';
    posture[agent.token] = p;
    const group = selectGroup(parsed, agent.token.toLowerCase());
    const crawlDelay = group?.unsupported?.find((u) => u.field === 'crawl-delay');
    matrix.push({ token: agent.token, vendor: agent.vendor, kind: agent.kind, purpose: agent.purpose, respects_robots: agent.respects_robots, posture: p, root: root.verdict, root_explicit: root.explicit, has_own_group: hasOwnGroup, via_group: root.via, cells, crawl_delay: crawlDelay ? crawlDelay.value : null });
  }
  b.metric('agent_matrix', matrix).metric('posture', posture);
  const mEv = (token) => {
    const row = matrix.find((m) => m.token === token);
    return ev({ kind: 'file_content', source_url: ctx.robots.url, fetch_profile: 'RAW', selector_or_key: `robots.txt verdict for ${token}`, observed_value: `${row.posture} — / is ${row.root} via group "${row.via_group ?? 'none'}"${row.cells.find((c) => c.rule) ? `; rule ${row.cells.find((c) => c.rule).rule}` : ''}` });
  };

  const staging = ctx.cfg.env === 'staging';
  const intentional = ctx.cfg.policy.ai_blocking_intentional;

  // C-5.1-h / C-5.1-g — inheritance from the catch-all group (R-5.1-6)
  const aiWithOwnGroup = matrix.filter((m) => m.has_own_group);
  const catchAll = parsed.byToken.get('*');
  const catchAllBlocksRoot = catchAll ? evaluate(parsed, '__no_specific_token__', '/').verdict === 'DISALLOWED' : false;
  if (!aiWithOwnGroup.length && catchAllBlocksRoot) {
    b.hit('C-5.1-h', { summary: 'robots.txt has no AI-specific groups and the * group disallows /: every AI agent inherits a site-wide block. This is usually unintended collateral of a Googlebot-focused rule.', evidence: [mEv('GPTBot'), mEv('PerplexityBot')] });
  } else if (!aiWithOwnGroup.length) {
    b.hit('C-5.1-g', { summary: `No AI-specific groups in robots.txt: all ${AI_AGENTS.length} registry agents inherit the ${catchAll ? '* group, which is permissive' : 'absence of rules'}. Access is allowed, but no deliberate decision is recorded (UNDECLARED is not the same as OPEN).`, evidence: [mEv('GPTBot')] });
  }

  // C-5.1-b / C-5.1-c — retrieval agents
  const retrievalBlocked = matrix.filter((m) => RETRIEVAL_AGENTS.includes(m.token) && m.posture === 'BLOCKED');
  const allBlocked = matrix.filter((m) => m.kind !== 'control').every((m) => m.posture === 'BLOCKED');
  if (allBlocked && matrix.some((m) => m.has_own_group)) {
    if (intentional || staging) b.note('ALL_AI_AGENTS_BLOCKED', `Every AI agent is blocked site-wide — recorded as ${staging ? 'expected on a staging host' : 'a deliberate policy decision'}, not a defect.`, [mEv('GPTBot')]);
    else b.hit('C-5.1-c', { summary: `Every AI agent in the registry is blocked site-wide. This is legitimate if deliberate — is it? If AI blocking is policy, set policy.ai_blocking_intentional and this becomes informational.`, evidence: [mEv('GPTBot'), mEv('OAI-SearchBot')] });
  } else if (retrievalBlocked.length && !intentional && !staging) {
    b.hit('C-5.1-b', { summary: `Retrieval-oriented agent(s) blocked site-wide: ${retrievalBlocked.map((m) => `${m.token} (${m.vendor})`).join(', ')}. These agents surface sites in assistant answers; blocking them removes the site from those surfaces.`, evidence: retrievalBlocked.map((m) => mEv(m.token)) });
  } else if (retrievalBlocked.length) {
    b.note('AI_RETRIEVAL_AGENT_BLOCKED', `Retrieval agents blocked (${retrievalBlocked.map((m) => m.token).join(', ')}) — recorded as deliberate; no unblocking is recommended (F-5.1-3).`, retrievalBlocked.map((m) => mEv(m.token)));
  }

  // C-5.1-d — training blocked, retrieval allowed: a coherent posture, reported not scored down.
  const trainingBlocked = matrix.filter((m) => TRAINING_AGENTS.includes(m.token) && m.posture === 'BLOCKED');
  if (trainingBlocked.length && !retrievalBlocked.length && !allBlocked) {
    b.hit('C-5.1-d', { summary: `Training agents blocked (${trainingBlocked.map((m) => m.token).join(', ')}) while retrieval agents remain allowed — a coherent content-licensing posture, reported not scored.`, evidence: trainingBlocked.map((m) => mEv(m.token)) });
  }

  // C-5.1-e / C-5.1-f — control tokens (never a search-visibility finding, F-5.1-2)
  for (const [token, cp] of [['Google-Extended', 'C-5.1-e'], ['Applebot-Extended', 'C-5.1-f']]) {
    const row = matrix.find((m) => m.token === token);
    if (row?.posture === 'BLOCKED' || row?.posture === 'PARTIAL') {
      const text = token === 'Google-Extended'
        ? 'Google-Extended is disallowed. It has no separate HTTP user-agent — crawling is done with existing Google user agents and the token acts purely as a control over Gemini training and grounding. Disallowing it does not affect inclusion in Google Search and is not a ranking signal: a content-licensing decision, not an SEO defect.'
        : 'Applebot-Extended is disallowed. It does not crawl; pages that disallow it can still appear in Apple search surfaces. A content-licensing decision, not an SEO defect.';
      b.hit(cp, { summary: text, evidence: [mEv(token)] });
    }
  }

  // C-5.1-m — blocks on content paths vs hygiene paths (R-5.1-8).
  // A training-only agent blocked while retrieval agents stay allowed is the coherent licensing
  // posture already reported by C-5.1-d, and E-5.1-2 says that is never a defect — so those agents
  // are excluded here rather than counted twice, once as a choice and once as a failure.
  const licensingPosture = trainingBlocked.length && !retrievalBlocked.length && !allBlocked;
  const contentBlocks = [];
  for (const m of matrix) {
    if (m.kind === 'control' || m.posture === 'OPEN' || m.posture === 'UNDECLARED') continue;
    if (licensingPosture && TRAINING_AGENTS.includes(m.token)) continue;
    const blockedContent = m.cells.filter((c) => c.verdict === 'DISALLOWED' && CONTENT_PATHS.some((p) => c.path.startsWith(p)));
    const blockedByRule = (m.cells.find((c) => c.rule && c.verdict === 'DISALLOWED')?.rule || '');
    if (blockedContent.length || CONTENT_PATHS.some((p) => evaluate(parsed, m.token.toLowerCase(), p).verdict === 'DISALLOWED')) {
      contentBlocks.push({ token: m.token, rule: blockedByRule, paths: blockedContent.map((c) => c.path) });
    }
  }
  if (contentBlocks.length && !intentional && !staging && !allBlocked) {
    b.hit('C-5.1-m', { summary: `Blocking rules target content paths carrying the site's substantive material: ${contentBlocks.slice(0, 5).map((c) => `${c.token}${c.rule ? ` (${c.rule})` : ''}`).join(', ')}.`, evidence: contentBlocks.slice(0, 5).map((c) => mEv(c.token)) });
  }
  const hygieneOnly = matrix.filter((m) => m.posture === 'PARTIAL' && !contentBlocks.some((c) => c.token === m.token));
  if (hygieneOnly.length) b.note('AI_BLOCKED_ON_CONTENT_PATHS', `${hygieneOnly.length} agent(s) are blocked only on non-retrieval paths (cart/account/admin) — normal hygiene, not a retrieval problem.`);

  // C-5.1-j — snippet directives suppress AI-surface input even when crawling is allowed (R-5.1-5)
  const suppressed = [...(ctx.derived.robotsMeta || new Map())].filter(([, m]) => m.nosnippet || m.maxSnippet0);
  if (suppressed.length) {
    b.hit('C-5.1-j', { summary: `${suppressed.length} sampled content page(s) carry nosnippet or max-snippet:0. A site can be fully crawlable and still be excluded as a direct input to Google's AI Overviews and AI Mode by its own snippet directives.`, evidence: suppressed.slice(0, 5).map(([url]) => ev({ kind: 'dom_node', source_url: url, fetch_profile: 'RAW', selector_or_key: 'meta[name=robots] / X-Robots-Tag', observed_value: 'nosnippet or max-snippet:0' })), cross_references: ['C-1.6'] });
  }

  // R-5.1-4 — Content-Signal declarations (advisory: permission, not enforcement)
  const signals = [...parsed.fileContentSignals, ...[...parsed.byToken.values()].flatMap((g) => (g.content_signals || []).map((s) => ({ ...s, token: g.token })))];
  if (signals.length) {
    const sEv = ev({ kind: 'file_content', source_url: ctx.robots.url, fetch_profile: 'RAW', selector_or_key: 'Content-Signal', observed_value: signals.map((s) => `${s.token ? `[${s.token}] ` : ''}${s.raw}`).join(' | ') });
    const contradictions = [];
    for (const s of signals) {
      if (s.signals['ai-train'] === 'yes' && TRAINING_AGENTS.some((t) => posture[t] === 'BLOCKED')) contradictions.push(`ai-train=yes while ${TRAINING_AGENTS.filter((t) => posture[t] === 'BLOCKED').join('/')} is disallowed`);
      if (s.signals['ai-input'] === 'yes' && RETRIEVAL_AGENTS.some((t) => posture[t] === 'BLOCKED')) contradictions.push(`ai-input=yes while ${RETRIEVAL_AGENTS.filter((t) => posture[t] === 'BLOCKED').join('/')} is disallowed`);
      if (s.signals['ai-train'] === 'no' && TRAINING_AGENTS.every((t) => posture[t] === 'OPEN' || posture[t] === 'UNDECLARED')) contradictions.push('ai-train=no while every training agent is allowed');
    }
    if (contradictions.length) b.hit('C-5.1-l', { summary: `Content-Signal declarations contradict the robots rules in the same group: ${contradictions.join('; ')}. Content-Signal expresses permission; it does not enforce it.`, evidence: [sEv] });
    else b.hit('C-5.1-k', { summary: `Content-Signal declared and internally consistent with the robots rules (${signals.map((s) => s.raw).join('; ')}). Advisory: it expresses permission, it does not enforce it.`, evidence: [sEv] });
  }

  // R-5.1-9 crawl-delay per vendor; E-5.1-6 unknown tokens; E-5.1-4 platform-managed file
  const delays = matrix.filter((m) => m.crawl_delay);
  if (delays.length) b.note('UNKNOWN_AGENT_RULES', `Crawl-delay declared for ${delays.map((m) => `${m.token}=${m.crawl_delay}`).join(', ')}. Some vendors honour it; Google does not support the directive at all.`);
  const known = new Set([...AI_AGENTS.map((a) => a.token.toLowerCase()), ...KNOWN_NON_AI]);
  const unknown = [...parsed.byToken.keys()].filter((t) => !known.has(t));
  if (unknown.length) b.note('UNKNOWN_AGENT_RULES', `User-agent token(s) in robots.txt that are not in the registry: ${unknown.join(', ')}. Listed without guessing a vendor (E-5.1-6).`);
  if (/content-signal|managed by cloudflare|cloudflare/i.test(ctx.robots.text || '')) b.note('CONTENT_SIGNAL_DECLARED', 'robots.txt carries a platform-managed signature: rules may be managed by the CDN rather than authored by the site owner, so remediation goes through the platform dashboard (E-5.1-4).');

  // C-5.1-i — UA-variant probing, opt-in only (cap.ua_probe default false, B-5.1-2)
  if (!ctx.cfg.cap.ua_probe) {
    b.note('AI_BLOCKED_AT_SERVER', 'Server-level blocking not probed: user-agent variant probing is disabled (cap.ua_probe = false, the safe default). Only robots.txt was analysed; C-5.1-i is NOT_TESTABLE.');
  } else {
    b.caveat('UA-variant probe; server may treat unverified UA strings differently from the verified crawler.');
    b.setConfidence('DERIVED');
  }

  // Vendor-declaration caveats (E-5.1-3, F-5.1-5)
  const userInitiated = matrix.filter((m) => m.kind === 'user' && m.posture !== 'OPEN' && m.posture !== 'UNDECLARED');
  if (userInitiated.length) {
    b.note('AI_CHALLENGE_NOT_BLOCK', `Rules exist for user-initiated fetchers (${userInitiated.map((m) => m.token).join(', ')}). Their vendors document that robots.txt rules may not apply to user-triggered requests, so these rules may not be honoured — they are reported as declarations, not as effective controls.`);
  }
  b.caveat('AI-crawler behaviour rests on each vendor\'s own declaration — a statement of intent, not an independently verifiable fact.');

  b.addEvidence(ev({ kind: 'file_content', source_url: ctx.robots.url, fetch_profile: 'RAW', selector_or_key: 'per-vendor access posture', observed_value: Object.entries(posture).map(([k, v]) => `${k}=${v}`).join(', ') }));
  if (!b.hits.length) {
    b.pass(`All retrieval-oriented agents (${RETRIEVAL_AGENTS.join(', ')}) are allowed on content paths.`);
  }
  return b.build();
}
