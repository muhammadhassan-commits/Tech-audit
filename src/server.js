// HTTP server: static UI + audit API with Server-Sent Events progress, and the source-register
// endpoint that backs the Reference affordance (R-SRC-7).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runAudit } from './engine/pipeline.js';
import { getRegister } from './sources/register.js';
import { FACTORS, SECTIONS } from './engine/catalog.js';
import { CHECKPOINTS } from './engine/result.js';
import { PROJECT_ROOT, TOOL_VERSION } from './config.js';
import { findBrowser } from './net/render.js';

const UI_DIR = path.join(PROJECT_ROOT, 'public');
const RUNS_DIR = path.join(PROJECT_ROOT, 'runs');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const runs = new Map(); // run_id → { status, events, report, seed, started }

function send(res, code, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) {
    chunks.push(c);
    if (Buffer.concat(chunks).length > 1e6) throw new Error('Request body too large');
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(UI_DIR, rel);
  if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, { error: 'Not found' }, { 'content-type': 'application/json' });
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

export function createServer() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      // ── Source register: powers the Reference button on every factor and child item ──
      if (url.pathname === '/api/sources') {
        const reg = getRegister();
        return send(res, 200, {
          ...reg.toJSON(),
          catalog: { sections: SECTIONS, factors: FACTORS },
          checkpoint_table: CHECKPOINTS,
        });
      }
      // Per-item lookup: /api/source?check=C-1.5&checkpoint=C-1.5-g&reason=CANONICAL_TO_REDIRECT
      // Deployment health check. It reports what the host actually gives this process, because
      // the two things that silently degrade an audit — no browser, no keys — are invisible until
      // a report comes back wrong. A platform probe only reads the status code; a human reads the
      // body and can see at a glance whether rendering is really available here.
      if (url.pathname === '/health') {
        const browser = findBrowser() || null;
        return send(res, 200, {
          ok: true,
          tool_version: TOOL_VERSION,
          browser_path: browser,
          render_available: Boolean(browser),
          keys: {
            google: Boolean(process.env.GOOGLE_API_KEY),
            anthropic: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
          },
          saved_reports: fs.existsSync(RUNS_DIR) ? fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')).length : 0,
          active_runs: [...runs.values()].filter((r) => r.status === 'running').length,
        }, { 'cache-control': 'no-store' });
      }
      if (url.pathname === '/api/source') {
        const reg = getRegister();
        const checkId = url.searchParams.get('check');
        if (!checkId) return send(res, 400, { error: 'check is required' });
        const resolved = reg.resolve(checkId, { checkpoint: url.searchParams.get('checkpoint') || undefined, reasonCode: url.searchParams.get('reason') || undefined });
        const factor = reg.factors.get(checkId) || null;
        // resolved carries: sources (addressing this finding), also_registered (factor-level refs
        // set aside), condition, specificity, reference_url, threshold_by, unsourced_note.
        return send(res, 200, { check_id: checkId, factor, ...resolved }, { 'cache-control': 'public, max-age=60' });
      }
      if (url.pathname === '/api/runs' && req.method === 'GET') {
        const list = [...runs.values()].map((r) => ({ run_id: r.run_id, seed: r.seed, status: r.status, started: r.started, verdict: r.report?.scores?.verdict ?? null }));
        const saved = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')).map((f) => ({ run_id: f.replace(/\.json$/, ''), file: f, saved: true }));
        return send(res, 200, { active: list, saved });
      }
      if (url.pathname === '/api/audit' && req.method === 'POST') {
        const body = await readJson(req);
        const seed = String(body.seed || '').trim();
        if (!seed) return send(res, 400, { error: 'seed is required' });
        const run_id = crypto.randomUUID();
        const state = { run_id, seed, status: 'running', events: [], report: null, started: new Date().toISOString(), listeners: new Set() };
        runs.set(run_id, state);
        const config = {};
        if (body.gate_mode) config.gate = { robots_mode: body.gate_mode };
        if (body.env) config.env = body.env;
        if (body.no_render) config.cap = { ...(config.cap || {}), render_js: false };
        if (body.no_llm) config.cap = { ...(config.cap || {}), llm_judge: false };
        if (body.ua_probe) config.cap = { ...(config.cap || {}), ua_probe: true };
        if (body.operator_urls_only) config.operator_urls_only = true;
        runAudit(seed, { config, operator_urls: body.operator_urls || [] }, (e) => {
          state.events.push(e);
          for (const l of state.listeners) l(e);
        })
          .then((report) => {
            state.report = report;
            state.status = 'done';
            fs.writeFileSync(path.join(RUNS_DIR, `${run_id}.json`), JSON.stringify(report));
            for (const l of state.listeners) l({ type: 'complete' });
          })
          .catch((err) => {
            state.status = 'error';
            state.error = { message: err.message, stack: String(err.stack).split('\n').slice(0, 6) };
            for (const l of state.listeners) l({ type: 'error', message: err.message });
          });
        return send(res, 202, { run_id });
      }
      if (url.pathname.startsWith('/api/run/')) {
        const id = url.pathname.split('/')[3];
        const tail = url.pathname.split('/')[4];
        const state = runs.get(id);
        if (tail === 'events') {
          if (!state) return send(res, 404, { error: 'Unknown run' });
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          const write = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
          state.events.forEach(write);
          if (state.status === 'done') write({ type: 'complete' });
          else {
            state.listeners.add(write);
            req.on('close', () => state.listeners.delete(write));
          }
          return undefined;
        }
        if (state?.report) return send(res, 200, state.report);
        const file = path.join(RUNS_DIR, `${id}.json`);
        if (fs.existsSync(file)) return send(res, 200, fs.readFileSync(file, 'utf8'));
        if (state) return send(res, 202, { status: state.status, error: state.error || null });
        return send(res, 404, { error: 'Unknown run' });
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' });
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const port = Number(process.env.PORT) || 4317;
  createServer().listen(port, () => {
    console.log(`Initial Technical SEO + LLM Visibility Audit — http://localhost:${port}`);
    const reg = getRegister();
    console.log(`Source register: ${reg.sources.size} sources, ${reg.factors.size} factors, ${reg.checkpoints.size} checkpoints`);
  });
}
