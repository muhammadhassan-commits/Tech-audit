// C-5.3 — llms.txt (site · RAW). A community proposal, not a search-engine requirement:
// Google states no AI text files are needed. Absence is WARN/LOW at most, never FAIL (F-5.3-1).
import { ResultBuilder, ev, errorResult } from '../engine/result.js';
import { bodyText } from '../net/http.js';
import { normalizeUrl, isSameSite } from '../parse/url.js';
import { collapse, jaccard, shingles } from '../parse/text.js';
import { RETRIEVAL_AGENTS } from './ai_agents.js';
import { evaluate } from '../parse/robots.js';

const OPTIONAL_NOTE = 'llms.txt is a proposed convention. No search engine has confirmed it as a crawl or ranking input, and Google states no AI text files are needed for its AI features.';
const FALLBACK_PATHS = ['/docs/llms.txt', '/documentation/llms.txt', '/.well-known/llms.txt'];

/** Parse the llms.txt structure per the specification (R-5.3-2). */
export function parseLlmsTxt(text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  const out = { h1: null, blockquote: null, sections: [], links: [], optionalSection: false, headings: [] };
  let current = null;
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h1 = /^#\s+(.*)$/.exec(line);
    const h2 = /^##\s+(.*)$/.exec(line);
    const hx = /^(#{3,6})\s+(.*)$/.exec(line);
    if (h1) {
      if (out.h1 == null) out.h1 = h1[1].trim();
      out.headings.push({ level: 1, text: h1[1].trim() });
      continue;
    }
    if (h2) {
      current = { name: h2[1].trim(), items: [] };
      out.sections.push(current);
      out.headings.push({ level: 2, text: current.name });
      if (/^optional$/i.test(current.name)) out.optionalSection = true;
      continue;
    }
    if (hx) {
      out.headings.push({ level: hx[1].length, text: hx[2].trim() });
      continue;
    }
    if (out.h1 != null && out.blockquote == null && /^>\s?/.test(line)) {
      out.blockquote = line.replace(/^>\s?/, '').trim();
      continue;
    }
    const item = /^\s*[-*+]\s+\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*:?\s*(.*)$/.exec(line);
    if (item) {
      const rec = { name: item[1].trim(), url: item[2].trim(), notes: item[3].trim() || null, section: current?.name || null, optional: /^optional$/i.test(current?.name || '') };
      out.links.push(rec);
      if (current) current.items.push(rec);
      continue;
    }
    const bare = /^\s*[-*+]\s+(https?:\/\/\S+)\s*$/.exec(line);
    if (bare) {
      const rec = { name: null, url: bare[1], notes: null, section: current?.name || null, bare: true, optional: /^optional$/i.test(current?.name || '') };
      out.links.push(rec);
      if (current) current.items.push(rec);
    }
  }
  out.linkSections = out.sections.filter((s) => s.items.length > 0);
  return out;
}

export async function run(ctx) {
  try {
    return [await evaluateCheck(ctx)];
  } catch (e) {
    return [errorResult(ctx, 'C-5.3', e)];
  }
}

async function evaluateCheck(ctx) {
  const { http, cfg } = ctx;
  const b = new ResultBuilder(ctx, 'C-5.3', { scope: 'site', target_url: `${ctx.canonicalOrigin}/llms.txt` });
  b.caveat(OPTIONAL_NOTE);

  // R-5.3-1 + B-5.3-1 discovery ladder
  const tried = [];
  let found = null;
  for (const path of ['/llms.txt', ...FALLBACK_PATHS]) {
    const url = `${ctx.canonicalOrigin}${path}`;
    ctx.emit('fetch', { url, purpose: 'llms.txt' });
    const rec = await http.fetch(url, { budgetClass: 'secondary', exempt: true, headers: { accept: 'text/markdown,text/plain,*/*;q=0.5' } });
    tried.push({ url, status: rec.status, bytes: rec.bytes });
    if (rec.status >= 200 && rec.status < 300) {
      found = { url, rec, text: bodyText(rec) };
      break;
    }
    if (rec.status >= 500 || rec.status == null) found = found || { url, rec, unreachable: true };
  }
  b.metric('probed', tried);
  const statusEv = (f) => ev({ kind: 'http_status', source_url: f.url, fetch_profile: 'RAW', selector_or_key: 'status', observed_value: f.rec.status == null ? null : String(f.rec.status) });

  if (!found || (found.unreachable && !found.text)) {
    if (found?.unreachable) {
      b.hit('C-5.3-i', { summary: `llms.txt at ${found.url} returned HTTP ${found.rec.status ?? 'no response'}; reachability could not be established.`, evidence: [statusEv(found)] });
      return b.build();
    }
    b.hit('C-5.3-b', { summary: `No llms.txt at /llms.txt or the documented fallback paths (${FALLBACK_PATHS.join(', ')}). This is an optional practice: it is not required by Google, and its absence is not a defect.`, evidence: tried.map((t) => ev({ kind: 'http_status', source_url: t.url, fetch_profile: 'RAW', selector_or_key: 'status', observed_value: t.status == null ? null : String(t.status), expected_value: '200 (optional)' })) });
    // C-5.3-n contradiction check still applies to the recommendation (F-5.3-4).
    if (ctx.robots?.parsed && RETRIEVAL_AGENTS.every((a) => evaluate(ctx.robots.parsed, a.toLowerCase(), '/').verdict === 'DISALLOWED')) {
      b.note('LLMS_TXT_CONTRADICTS_ROBOTS', 'Note before recommending one: robots.txt currently blocks every retrieval-oriented AI agent, so an llms.txt would advertise content those agents are forbidden to read (F-5.3-4).');
    }
    return b.build();
  }

  const text = found.text;
  const ct = String(found.rec.headers?.['content-type'] || '');
  b.metric('url', found.url).metric('bytes', found.rec.bytes).metric('content_type', ct || null);
  const fileEv = ev({ kind: 'file_content', source_url: found.url, fetch_profile: 'RAW', selector_or_key: 'body', observed_value: text });
  b.addEvidence(statusEv(found), fileEv);

  // R-5.3-5 malformations
  if (/text\/html/i.test(ct) || /<html[\s>]|<!doctype html/i.test(text.slice(0, 2000))) {
    b.hit('C-5.3-c', { summary: `llms.txt is served as HTML (Content-Type: ${ct || 'unset'}), not markdown.`, evidence: [fileEv] });
    return b.build();
  }
  const probe = ctx.derived.probe404;
  if (probe?.html && collapse(probe.html).slice(0, 400) && collapse(text).slice(0, 400) === collapse(probe.html).slice(0, 400)) {
    b.hit('C-5.3-j', { summary: 'The URL returns HTTP 200 but serves the site\'s 404 page.', evidence: [fileEv] });
    return b.build();
  }
  if (/text\/plain/i.test(ct)) b.note('MARKDOWN_TWINS_PRESENT', `Served as ${ct} rather than text/markdown — acceptable; content is what matters (E-5.3-3).`);

  const parsed = parseLlmsTxt(text);
  b.metric('h1', parsed.h1).metric('sections', parsed.sections.map((s) => s.name)).metric('links', parsed.links.length).metric('optional_section', parsed.optionalSection);

  if (!parsed.h1) b.hit('C-5.3-d', { summary: 'No H1 with the project or site name — the only required element of the specification.', evidence: [fileEv] });
  if (!parsed.blockquote) b.hit('C-5.3-k', { summary: 'No blockquote summary after the H1 (optional in the spec, but it is what lets an agent understand the rest of the file).', evidence: [fileEv] });
  if (!parsed.linkSections.length) b.hit('C-5.3-e', { summary: 'No H2-delimited file-list sections: the file declares no links for an agent to follow.', evidence: [fileEv] });
  if (parsed.links.length && parsed.links.every((l) => l.bare || (!l.notes && !l.section))) {
    b.hit('C-5.3-e', { status: 'WARN', severity: 'LOW', reason_code: 'LLMS_TXT_SITEMAP_CLONE', summary: `The file is a flat list of ${parsed.links.length} URLs with no section structure or descriptions. Technically conformant, low value: a useful file names each resource and says what it is for.`, evidence: [fileEv] });
  }
  if (parsed.optionalSection) b.note('MARKDOWN_TWINS_PRESENT', 'An "Optional" H2 section is present — correct use of the convention for secondary links an agent may skip (E-5.3-7).');

  // R-5.3-3 link validation (budgeted)
  const budget = cfg.llms.max_link_checks;
  const checked = [];
  const broken = [];
  const blocked = [];
  for (const link of parsed.links.slice(0, budget)) {
    const abs = normalizeUrl(link.url, found.url);
    if (!abs) {
      broken.push({ ...link, status: 'unresolvable' });
      continue;
    }
    const rec = await http.fetch(abs, { budgetClass: 'secondary', discardBody: true });
    checked.push({ url: abs, status: rec.status });
    if (rec.status == null || rec.status >= 400) broken.push({ ...link, url: abs, status: rec.status });
    if (isSameSite(abs, ctx.canonicalOrigin) && ctx.robots?.parsed) {
      const blockedFor = RETRIEVAL_AGENTS.filter((a) => evaluate(ctx.robots.parsed, a.toLowerCase(), new URL(abs).pathname).verdict === 'DISALLOWED');
      if (blockedFor.length) blocked.push({ url: abs, agents: blockedFor });
    }
  }
  const unvalidated = Math.max(0, parsed.links.length - budget);
  b.metric('links_validated', checked.length).metric('links_unvalidated', unvalidated);
  if (unvalidated) b.caveat(`${unvalidated} link(s) beyond the ${budget}-check budget were not validated (F-5.3-3).`);
  if (broken.length) b.hit('C-5.3-f', { summary: `${broken.length} link(s) in llms.txt do not resolve: ${broken.slice(0, 5).map((l) => `${l.url} (${l.status ?? 'no response'})`).join(', ')}.`, evidence: broken.slice(0, 5).map((l) => ev({ kind: 'http_status', source_url: String(l.url), fetch_profile: 'RAW', selector_or_key: 'linked from llms.txt', observed_value: String(l.status), expected_value: '2xx' })) });
  if (blocked.length) b.hit('C-5.3-g', { summary: `${blocked.length} link(s) in llms.txt are robots-disallowed for AI agents (${[...new Set(blocked.flatMap((x) => x.agents))].join(', ')}) — the file advertises what the site forbids.`, evidence: blocked.slice(0, 5).map((x) => ev({ kind: 'computed', source_url: x.url, selector_or_key: 'robots verdict', observed_value: `DISALLOWED for ${x.agents.join(', ')}` })), cross_references: ['C-5.1'] });

  // R-5.3-4 coverage against the sampled page set
  if (ctx.pages.length) {
    const declared = new Set(parsed.links.map((l) => normalizeUrl(l.url, found.url)).filter(Boolean));
    const covered = ctx.pages.filter((p) => declared.has(p.finalUrl) || declared.has(p.url)).length;
    const coverage = covered / ctx.pages.length;
    b.metric('sample_coverage', Number(coverage.toFixed(2)));
    if (coverage < 0.5) b.hit('C-5.3-h', { summary: `llms.txt covers ${covered} of ${ctx.pages.length} sampled pages (${Math.round(coverage * 100)}%).`, evidence: [ev({ kind: 'computed', source_url: found.url, selector_or_key: 'coverage of sampled pages', observed_value: `${covered}/${ctx.pages.length}`, expected_value: '≥ 50%' })] });
  }

  // R-5.3-8 entity consistency with Organization.description and the homepage h1
  const org = ctx.derived.schema?.org;
  const hpH1 = ctx.homepage?.rawFacts?.headings.find((h) => h.level === 1)?.text || null;
  const summary = parsed.blockquote || parsed.h1;
  if (summary && (org?.description || hpH1)) {
    const compare = org?.description || hpH1;
    const sim = jaccard(shingles(summary, 3), shingles(compare, 3));
    b.metric('entity_description_similarity', Number(sim.toFixed(2)));
    if (sim < 0.1 && org?.name && !collapse(summary).toLowerCase().includes(collapse(org.name).toLowerCase())) {
      b.hit('C-5.3-l', { summary: `The llms.txt summary does not agree with ${org?.description ? 'Organization.description' : 'the homepage h1'}: "${collapse(summary).slice(0, 120)}" vs "${collapse(compare).slice(0, 120)}".`, evidence: [fileEv], cross_references: ['C-3.1', 'C-6.2'] });
    }
  }
  ctx.derived.llmsTxt = { url: found.url, parsed, summary, text };

  // R-5.3-6 markdown twins (probe up to 3 sampled URLs)
  const twins = [];
  for (const page of ctx.pages.slice(0, 3)) {
    const u = page.finalUrl.replace(/\/$/, '');
    const negotiated = await http.fetch(page.finalUrl, { budgetClass: 'secondary', noCache: true, headers: { accept: 'text/markdown' }, discardBody: true });
    const negotiatedOk = /text\/markdown/i.test(String(negotiated.headers?.['content-type'] || ''));
    const mdPath = /\.[a-z]{2,5}$/i.test(u) ? u.replace(/\.[a-z]{2,5}$/i, '.md') : `${u}.md`;
    const md = await http.fetch(mdPath, { budgetClass: 'secondary', discardBody: true });
    if (negotiatedOk || (md.status >= 200 && md.status < 300)) twins.push({ url: page.finalUrl, via: negotiatedOk ? `content negotiation (Vary: ${negotiated.headers?.vary || 'not declared'})` : mdPath });
  }
  if (twins.length) {
    b.hit('C-5.3-m', { summary: `Markdown twin(s) available: ${twins.map((t) => `${t.url} via ${t.via}`).join('; ')}. This removes extraction ambiguity for non-browser fetchers.`, evidence: twins.map((t) => ev({ kind: 'http_header', source_url: t.url, fetch_profile: 'RAW', selector_or_key: 'markdown twin', observed_value: t.via })) });
    ctx.derived.markdownTwins = twins;
  }
  if (/cite|attribution|quote|reference us|how to (cite|reference)/i.test(text)) b.note('MARKDOWN_TWINS_PRESENT', 'A citation/attribution preferences block is present — a positive signal (R-5.3-7).');

  // C-5.3-n contradiction with robots.txt
  if (ctx.robots?.parsed) {
    const blockedAll = RETRIEVAL_AGENTS.every((a) => evaluate(ctx.robots.parsed, a.toLowerCase(), '/').verdict === 'DISALLOWED');
    if (blockedAll) b.hit('C-5.3-n', { summary: 'llms.txt is published, but robots.txt blocks every retrieval-oriented AI agent site-wide: the file advertises content those agents may not read.', evidence: [fileEv], cross_references: ['C-5.1'] });
  }

  if (!b.hits.length) b.pass(`llms.txt at ${found.url}: valid H1 ("${parsed.h1}"), ${parsed.linkSections.length} H2 link section(s), ${checked.length} link(s) validated and resolving.`);
  return b.build();
}
