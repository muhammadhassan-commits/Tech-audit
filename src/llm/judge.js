// Section 6 rubric protocol (R-S6-1…R-S6-5). The judge receives only the extracted main content,
// the heading outline, the URL, page_type and the rubric — never the site's marketing claims, the
// tool's other findings, or a desired outcome. Every sub-score is MODELLED and carries the caveat.
import Anthropic from '@anthropic-ai/sdk';
import { RUBRIC_VERSION } from '../config.js';
import { collapse } from '../parse/text.js';

export const MODELLED_CAVEAT =
  'Modelled estimate against a fixed rubric; not a measurement of retrieval behaviour by any specific AI system. No public API exposes whether a given model retrieved or cited a page.';
export const RAW_ONLY_CAVEAT = 'Evaluated on raw HTML; JavaScript-rendered content was not assessed.';
// R-S6-2 asks for temperature 0. The current model family does not accept a sampling temperature,
// so determinism cannot be pinned that way; the rubric version is fixed and recorded instead, and
// this limitation is surfaced on every modelled score rather than left implicit.
export const NON_DETERMINISTIC_CAVEAT =
  'The judge model does not accept a sampling temperature, so repeated runs may differ slightly; the rubric version is fixed and recorded in evidence.';

const SYSTEM = `You score web page content against a fixed rubric for a technical audit.

Rules, all binding:
- Score only what the supplied text supports. You are not told, and must not infer, any desired outcome.
- Every criterion you score above 0 must be supported by a verbatim quote copied exactly from the supplied content. Never paraphrase a quote, never invent one.
- If the content does not let you judge a criterion, score it 0 and say so in the justification.
- Return only the JSON object the schema describes. No preamble, no commentary.`;

function schemaFor(criteria) {
  return {
    type: 'object',
    additionalProperties: false,
    required: criteria.map((c) => c.id),
    properties: Object.fromEntries(
      criteria.map((c) => [
        c.id,
        {
          type: 'object',
          additionalProperties: false,
          required: ['score', 'justification', 'quote'],
          properties: {
            score: { type: 'integer', enum: [0, 1, 2, 3], description: c.label },
            justification: { type: 'string', description: 'One sentence.' },
            quote: { type: 'string', description: 'Verbatim text from the supplied content, or an empty string when the score is 0.' },
          },
        },
      ]),
    ),
  };
}

const CURRENCY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['quote', 'correction', 'reference_url'],
        properties: {
          quote: { type: 'string', description: 'Verbatim sentence from the page that is contradicted.' },
          correction: { type: 'string', description: 'One sentence stating what is the case now.' },
          reference_url: { type: 'string', description: 'A resolving URL supporting the correction.' },
        },
      },
    },
  },
};

export class LlmJudge {
  constructor(cfg, ctx) {
    this.cfg = cfg;
    this.ctx = ctx;
    this.calls = 0;
    this.callsByCheck = new Map();
    this.disabledReason = null;
    this.client = null;
    if (!cfg.cap.llm_judge) this.disabledReason = 'cap.llm_judge = false';
    else if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) this.disabledReason = 'No Anthropic credentials in the environment (ANTHROPIC_API_KEY).';
    else {
      try {
        this.client = new Anthropic();
      } catch (e) {
        this.disabledReason = `SDK init failed: ${e.message}`;
      }
    }
  }

  get enabled() {
    return !!this.client && !this.disabledReason;
  }

  budgetLeft() {
    return this.cfg.llm.max_calls_per_run - this.calls;
  }

  /**
   * Per-check share of llm.max_calls_per_run.
   *
   * The cap is a run-level budget (F-6.2-5), and checks run in order, so first-come spending lets
   * the first rubric consume all of it — leaving later checks gate-only on every page. Each rubric
   * gets a reservation instead, and whatever the earlier ones leave unspent stays available, so the
   * budget is never wasted but is also never monopolised.
   */
  budgetLeftFor(checkId) {
    const share = this.cfg.llm.budget_share?.[checkId];
    const global = this.budgetLeft();
    if (share == null) return global;
    const reserved = Math.max(1, Math.floor(this.cfg.llm.max_calls_per_run * share));
    const used = this.callsByCheck.get(checkId) || 0;
    // Claim the reservation, plus any budget no other check can still claim.
    const otherReservations = Object.entries(this.cfg.llm.budget_share)
      .filter(([id]) => id !== checkId)
      .reduce((a, [id, sh]) => a + Math.max(0, Math.max(1, Math.floor(this.cfg.llm.max_calls_per_run * sh)) - (this.callsByCheck.get(id) || 0)), 0);
    return Math.max(0, Math.min(reserved - used + Math.max(0, global - otherReservations - (reserved - used)), global));
  }

  _charge(checkId) {
    this.calls++;
    if (checkId) this.callsByCheck.set(checkId, (this.callsByCheck.get(checkId) || 0) + 1);
  }

  /**
   * Score one page against a rubric. Returns { ok, criteria: {id: {score, justification, quote, valid}}, notTestable }.
   * R-S6-3: a criterion scored > 0 with no verbatim quote is discarded and re-scored once; if it
   * fails again that criterion becomes NOT_TESTABLE.
   */
  async score({ page, criteria, rubricName, checkId }) {
    if (!this.enabled) return { ok: false, reason: 'RUBRIC_DISABLED', detail: this.disabledReason };
    if (this.budgetLeftFor(checkId) <= 0) return { ok: false, reason: 'RUBRIC_DISABLED', detail: `This check's share of llm.max_calls_per_run (${this.cfg.llm.max_calls_per_run}) is spent; remaining pages are gate-only (F-6.2-5).` };

    const content = collapse(page.text).slice(0, this.cfg.llm.max_chars); // R-S6-1 limit
    const outline = page.outline.slice(0, 80).join('\n');
    const userMessage = [
      `URL: ${page.url}`,
      `page_type: ${page.page_type}`,
      `rubric: ${rubricName} (version ${RUBRIC_VERSION})`,
      '',
      'Criteria, each scored 0-3:',
      ...criteria.map((c) => `- ${c.id} — ${c.label}: ${c.guide}`),
      '',
      'Heading outline:',
      outline || '(no headings)',
      '',
      'Main content:',
      content || '(no extractable main content)',
    ].join('\n');

    const attempt = async () => {
      this._charge(checkId);
      const res = await this.client.messages.create({
        model: this.cfg.llm.model,
        max_tokens: 4000,
        system: SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
        output_config: { format: { type: 'json_schema', schema: schemaFor(criteria) } },
      });
      const block = res.content.find((x) => x.type === 'text');
      return JSON.parse(block.text);
    };

    let parsed;
    try {
      parsed = await attempt();
    } catch (e) {
      try {
        parsed = await attempt(); // B-6.2-3 one retry on malformed output
      } catch (e2) {
        return { ok: false, reason: 'RUBRIC_PARSE_FAILED', detail: e2.message };
      }
    }

    // R-S6-3 quote verification against the supplied content.
    const haystack = collapse(content).toLowerCase();
    const out = {};
    let needsRescore = false;
    for (const c of criteria) {
      const r = parsed[c.id] || {};
      const quote = collapse(r.quote || '');
      const valid = r.score === 0 || (quote.length > 0 && haystack.includes(quote.toLowerCase().slice(0, 120)));
      out[c.id] = { score: r.score ?? 0, justification: r.justification || '', quote, valid };
      if (!valid) needsRescore = true;
    }
    if (needsRescore && this.budgetLeftFor(checkId) > 0) {
      try {
        const second = await attempt();
        for (const c of criteria) {
          if (out[c.id].valid) continue;
          const r = second[c.id] || {};
          const quote = collapse(r.quote || '');
          const valid = r.score === 0 || (quote.length > 0 && haystack.includes(quote.toLowerCase().slice(0, 120)));
          out[c.id] = valid ? { score: r.score ?? 0, justification: r.justification || '', quote, valid: true } : { ...out[c.id], valid: false, not_testable: true };
        }
      } catch {
        for (const c of criteria) if (!out[c.id].valid) out[c.id].not_testable = true;
      }
    } else if (needsRescore) {
      for (const c of criteria) if (!out[c.id].valid) out[c.id].not_testable = true;
    }
    return { ok: true, criteria: out, rubric_version: RUBRIC_VERSION, model: this.cfg.llm.model };
  }

  /**
   * R-6.5-10 — deliberately shallow currency check. At most currency.max_claims claims,
   * each needing a verbatim quote and a resolving reference URL, or it is discarded (F-6.5-6).
   */
  async currencyCheck({ page, checkId = 'C-6.5' }) {
    if (!this.enabled) return { ok: false, reason: 'RUBRIC_DISABLED', detail: this.disabledReason };
    if (this.budgetLeftFor(checkId) <= 0) return { ok: false, reason: 'RUBRIC_DISABLED', detail: "This check's share of the LLM call budget is spent." };
    const content = collapse(page.text).slice(0, this.cfg.llm.max_chars);
    const userMessage = [
      `URL: ${page.url}`,
      `page_type: ${page.page_type}`,
      '',
      `Question: does this page state anything that more recent, widely-established information contradicts?`,
      `Return at most ${this.cfg.currency.max_claims} claims. For each, give the verbatim sentence from the page, one sentence stating what is the case now, and a resolving reference URL that supports the correction.`,
      'Do not fact-check claim by claim, do not research deeply, and do not attempt to date a claim precisely. If nothing on the page is contradicted, return an empty list.',
      '',
      'Page content:',
      content,
    ].join('\n');
    try {
      this._charge(checkId);
      const res = await this.client.messages.create({
        model: this.cfg.llm.model,
        max_tokens: 3000,
        system: SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
        output_config: { format: { type: 'json_schema', schema: CURRENCY_SCHEMA } },
      });
      const block = res.content.find((x) => x.type === 'text');
      const parsed = JSON.parse(block.text);
      const haystack = collapse(content).toLowerCase();
      const claims = (parsed.claims || []).filter((c) => {
        const q = collapse(c.quote || '');
        return q && haystack.includes(q.toLowerCase().slice(0, 120)) && /^https?:\/\/\S+$/.test(String(c.reference_url || '').trim()) && collapse(c.correction || '');
      });
      return { ok: true, claims: claims.slice(0, this.cfg.currency.max_claims), discarded: (parsed.claims || []).length - claims.length };
    } catch (e) {
      return { ok: false, reason: 'RUBRIC_PARSE_FAILED', detail: e.message };
    }
  }
}
