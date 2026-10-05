// HTTP client implementing PRD §3 fetch policy (RAW profile).
//  R-FETCH-1  full record: final URL, chain, status, verbatim headers, timing, bytes, truncation
//  R-FETCH-5  per-(url, profile) cache
//  R-FETCH-6  GET only when a body is needed (HEAD is never used)
//  R-FETCH-7  truthful UA only — no impersonation
//  R-FETCH-8  per-run, per-host cookie jar; consent never auto-accepted
//  R-FETCH-10 per-URL wall-clock budget (primary 30 s / secondary 10 s) bounds retries + backoff
//  R-FETCH-11 PAGE_NOT_RESPONDING with the status actually received (or null) + stall_stage
//  R-1.2-5    plain http:// is sent as-is — no HSTS, no client-side upgrade
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import zlib from 'node:zlib';
import { normalizeUrl, hostOf } from '../parse/url.js';
import { classifyResponse, VALIDITY } from './validity.js';

const STAGES = ['dns', 'connect', 'tls', 'first_byte', 'body'];
const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_UNTRUSTED', 'CERT_REVOKED', 'ERR_SSL_WRONG_VERSION_NUMBER',
  'EPROTO', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => Math.round(ms * (0.75 + Math.random() * 0.5));

export class HttpClient {
  constructor(cfg, hooks = {}) {
    this.cfg = cfg;
    this.net = cfg.net;
    this.cache = new Map(); // key: `${profile}|${url}`
    this.hostState = new Map(); // host → { active, lastAt, queue, consecutive429 }
    this.cookies = new Map(); // host → Map(name → value)
    this.fetchCount = 0;
    this.pageFetches = 0;
    this.page429 = 0;
    this.botProtectionUrls = new Set();
    this.log = [];
    this.hooks = hooks; // { isBlockedForAuditor(url) → bool, onAbort(code) }
    this.resolver2 = new dns.promises.Resolver();
    this.resolver2.setServers(this.net.second_resolvers);
  }

  // ── host throttling: net.concurrency_per_host + net.min_delay_ms ─────────
  async acquire(host) {
    let st = this.hostState.get(host);
    if (!st) {
      st = { active: 0, lastAt: 0, waiters: [], consecutive429: 0 };
      this.hostState.set(host, st);
    }
    while (st.active >= this.net.concurrency_per_host) {
      await new Promise((r) => st.waiters.push(r));
    }
    st.active++;
    const wait = st.lastAt + this.net.min_delay_ms - Date.now();
    if (wait > 0) await sleep(wait);
    st.lastAt = Date.now();
    return () => {
      st.active--;
      const w = st.waiters.shift();
      if (w) w();
    };
  }

  cookieHeader(host) {
    const jar = this.cookies.get(host);
    if (!jar || !jar.size) return null;
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(host, setCookie) {
    if (!setCookie) return;
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    let jar = this.cookies.get(host);
    if (!jar) this.cookies.set(host, (jar = new Map()));
    for (const c of list) {
      const m = /^\s*([^=;\s]+)=([^;]*)/.exec(c);
      if (m) jar.set(m[1], m[2]);
    }
  }

  /** Custom lookup: system resolver first, then the second configured resolver (B-A0-1). */
  lookup(hostname, options, cb) {
    dns.lookup(hostname, options, (err, address, family) => {
      if (!err) return cb(null, address, family);
      if (err.code !== 'ENOTFOUND' && err.code !== 'EAI_AGAIN') return cb(err);
      this.resolver2
        .resolve4(hostname)
        .then((a) => (options.all ? cb(null, a.map((x) => ({ address: x, family: 4 }))) : cb(null, a[0], 4)))
        .catch((e2) => {
          const e = new Error(e2.code === 'ENOTFOUND' || e2.code === 'ENODATA' ? 'NXDOMAIN' : 'DNS_ERROR');
          e.code = e2.code === 'ENOTFOUND' || e2.code === 'ENODATA' ? 'ENOTFOUND' : 'EAI_AGAIN';
          e.secondResolver = true;
          cb(e);
        });
    });
  }

  /**
   * One HTTP attempt. Never follows redirects. Resolves (never rejects) with an attempt record.
   * deadlineAt = absolute wall-clock ms at which this attempt must be abandoned.
   */
  attempt(url, { method = 'GET', headers = {}, deadlineAt, discardBody = false, maxBytes }) {
    return new Promise((resolve) => {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const t0 = Date.now();
      const stageAt = {};
      let stage = 'dns';
      let settled = false;
      let status = null;
      let resHeaders = null;
      let rawHeaders = null;
      const chunks = [];
      let bytes = 0;
      let truncated = false;
      let tlsInfo = null;

      const finish = (extra = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(connectTimer);
        const elapsed = Date.now() - t0;
        resolve({
          url,
          status,
          headers: resHeaders,
          raw_headers: rawHeaders,
          body: Buffer.concat(chunks),
          bytes,
          truncated,
          elapsed_ms: elapsed,
          stage_at: stageAt,
          stall_stage: extra.error ? stage : null,
          tls: tlsInfo,
          ...extra,
        });
      };

      const reqHeaders = {
        'user-agent': this.net.user_agent_resolved, // R-FETCH-7 truthful UA
        accept: headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'en',
        ...headers,
      };
      const ck = this.cookieHeader(u.host);
      if (ck) reqHeaders.cookie = ck;

      let req;
      try {
        req = lib.request(
          {
            method,
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            headers: reqHeaders,
            lookup: this.lookup.bind(this),
            servername: u.hostname,
            rejectUnauthorized: true, // B-A0-2: never disable certificate verification
            agent: false,
          },
          (res) => {
            stageAt.first_byte = Date.now() - t0;
            stage = 'body';
            status = res.statusCode;
            resHeaders = res.headers;
            rawHeaders = res.rawHeaders;
            this.storeCookies(u.host, res.headers['set-cookie']);
            if (discardBody || method === 'HEAD') {
              res.destroy();
              stageAt.body = Date.now() - t0;
              return finish({ body_discarded: true });
            }
            let stream = res;
            const enc = String(res.headers['content-encoding'] || '').toLowerCase();
            try {
              if (enc.includes('br')) stream = res.pipe(zlib.createBrotliDecompress());
              else if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
              else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
            } catch {
              stream = res;
            }
            const cap = maxBytes ?? this.net.max_response_bytes;
            stream.on('data', (c) => {
              bytes += c.length;
              if (bytes > cap) {
                truncated = true; // TRUNCATED_RESPONSE
                const keep = c.length - (bytes - cap);
                if (keep > 0) chunks.push(c.subarray(0, keep));
                res.destroy();
                stageAt.body = Date.now() - t0;
                finish();
                return;
              }
              chunks.push(c);
            });
            stream.on('end', () => {
              stageAt.body = Date.now() - t0;
              finish();
            });
            stream.on('error', (e) => {
              if (truncated) return;
              // Corrupt compression still yields what arrived; record the fault.
              finish({ error: { code: e.code || 'DECODE_ERROR', message: e.message, kind: 'decode' } });
            });
          },
        );
      } catch (e) {
        return finish({ error: { code: e.code || 'REQUEST_ERROR', message: e.message, kind: 'request' } });
      }

      req.on('socket', (sock) => {
        sock.on('lookup', () => {
          stageAt.dns = Date.now() - t0;
          stage = 'connect';
        });
        sock.on('connect', () => {
          stageAt.connect = Date.now() - t0;
          stage = u.protocol === 'https:' ? 'tls' : 'first_byte';
          clearTimeout(connectTimer);
        });
        sock.on('secureConnect', () => {
          stageAt.tls = Date.now() - t0;
          stage = 'first_byte';
          try {
            const cert = sock.getPeerCertificate();
            tlsInfo = {
              protocol: sock.getProtocol?.() || null,
              authorized: sock.authorized,
              valid_from: cert?.valid_from || null,
              valid_to: cert?.valid_to || null,
              subject_cn: cert?.subject?.CN || null,
            };
          } catch {
            /* certificate introspection is best-effort */
          }
        });
      });

      req.on('error', (e) => {
        const code = e.code || 'ERR';
        let kind = 'network';
        if (TLS_ERROR_CODES.has(code) || /certificate|SSL|TLS/i.test(e.message)) kind = 'tls';
        else if (code === 'ENOTFOUND') kind = 'dns_nxdomain';
        else if (code === 'EAI_AGAIN' || code === 'ESERVFAIL') kind = 'dns_error';
        else if (code === 'ECONNREFUSED') kind = 'refused';
        else if (code === 'ECONNRESET') kind = 'reset';
        finish({ error: { code, message: e.message, kind } });
      });

      // Connect timeout (per attempt) and the hard attempt deadline (budget-derived).
      const connectTimer = setTimeout(() => {
        if (stage === 'dns' || stage === 'connect') {
          req.destroy();
          finish({ error: { code: 'CONNECT_TIMEOUT', message: 'connect timeout', kind: 'connect_timeout' } });
        }
      }, Math.max(1, Math.min(this.net.timeout_connect_ms, deadlineAt - Date.now())));
      const timer = setTimeout(() => {
        req.destroy();
        finish({
          error: {
            code: status ? 'READ_TIMEOUT' : stage === 'dns' || stage === 'connect' ? 'CONNECT_TIMEOUT' : 'READ_TIMEOUT',
            message: 'deadline reached',
            kind: 'timeout',
          },
        });
      }, Math.max(1, deadlineAt - Date.now()));
      req.end();
    });
  }

  /**
   * Fetch with manual redirect following, loop detection, and a budget-bound retry ladder.
   * opts.budgetClass: 'primary' | 'secondary'
   * opts.exempt: control-file exemption from the auditor robots guard (R-FETCH-4)
   * opts.noCache, opts.discardBody, opts.headers, opts.maxHops, opts.followRedirects
   */
  async fetch(url, opts = {}) {
    const profile = 'RAW';
    const norm = normalizeUrl(url) || url;
    const key = `${profile}|${opts.headers?.accept || ''}|${opts.discardBody ? 'D' : ''}|${norm}`;
    if (!opts.noCache && this.cache.has(key)) return this.cache.get(key);
    const p = this._fetch(norm, opts);
    if (!opts.noCache) this.cache.set(key, p);
    return p;
  }

  async _fetch(url, opts) {
    const budgetClass = opts.budgetClass || 'secondary';
    const budget = budgetClass === 'primary' ? this.net.url_budget_ms : this.net.secondary_budget_ms;
    const unresponsive = budgetClass === 'primary' ? this.net.unresponsive_ms : this.net.secondary_unresponsive_ms;
    const start = Date.now();
    const budgetEnd = start + budget;
    const responseEnd = start + unresponsive; // R-FETCH-11 threshold for a complete response
    const maxHops = opts.maxHops ?? this.net.max_redirect_hops;
    const record = {
      requested_url: url,
      final_url: url,
      chain: [],
      status: null,
      headers: null,
      body: Buffer.alloc(0),
      bytes: 0,
      truncated: false,
      elapsed_ms: 0,
      stall_stage: null,
      budget_class: budgetClass,
      attempts: [],
      error: null,
      not_responding: false,
      last_status_received: null,
      terminal: null, // OK | REDIRECT_LOOP | REDIRECT_HOPS_EXCEEDED | MALFORMED_REDIRECT | BLOCKED_BY_ROBOTS_FOR_AUDITOR | ...
      retry_after_honoured: false,
      tls: null,
      observed_at: new Date().toISOString(),
    };

    if (!opts.exempt && this.hooks.isBlockedForAuditor?.(url)) {
      record.terminal = 'BLOCKED_BY_ROBOTS_FOR_AUDITOR'; // F-A2-2 never fetch to "check what's there"
      return record;
    }

    const visited = new Set();
    let current = url;
    let hops = 0;
    this.fetchCount++;
    if (budgetClass === 'primary') this.pageFetches++;

    while (true) {
      const nk = normalizeUrl(current) || current;
      if (visited.has(nk)) {
        record.terminal = 'REDIRECT_LOOP'; // F-1.4-2 loop reported before hop limit
        break;
      }
      visited.add(nk);

      const res = await this._attemptWithRetries(current, opts, { budgetEnd, responseEnd, record, unresponsive });
      record.attempts.push(...res.attempts);
      const a = res.final;
      if (a.status != null) record.last_status_received = a.status;
      if (a.tls && !record.tls) record.tls = a.tls;

      if (a.error && a.status == null) {
        record.error = a.error;
        record.stall_stage = a.stall_stage;
        if (a.error.kind === 'timeout' || a.error.kind === 'connect_timeout') {
          if (Date.now() >= responseEnd - 5 || a.error.kind === 'timeout') record.not_responding = true;
        }
        record.final_url = current;
        break;
      }
      if (a.error && a.status != null) {
        // A status line arrived but the body did not complete in time (R-FETCH-11 row 1).
        record.error = a.error;
        record.stall_stage = a.stall_stage;
        if (a.error.kind === 'timeout') record.not_responding = true;
      }

      const loc = a.headers?.location;
      const hop = { url: current, status: a.status, location: loc ?? null, resolved: null, same_host: null, elapsed_ms: a.elapsed_ms };
      record.chain.push(hop);

      const isRedirect = [301, 302, 303, 307, 308].includes(a.status);
      if (isRedirect && opts.followRedirects !== false) {
        if (!loc) {
          record.terminal = 'MALFORMED_REDIRECT'; // E-1.4-9
          this._setFinal(record, current, a);
          break;
        }
        const next = normalizeUrl(loc, current); // B-1.4-1 resolve against request URL
        if (!next) {
          record.terminal = 'MALFORMED_REDIRECT';
          this._setFinal(record, current, a);
          break;
        }
        hop.resolved = next;
        hop.same_host = hostOf(next) === hostOf(current);
        hops++;
        if (hops > maxHops) {
          record.terminal = 'REDIRECT_HOPS_EXCEEDED';
          this._setFinal(record, current, a);
          break;
        }
        if (Date.now() >= budgetEnd) {
          record.error = { code: 'BUDGET_EXHAUSTED', kind: 'timeout', message: 'URL budget exhausted mid-chain' };
          record.not_responding = true;
          record.stall_stage = 'first_byte';
          this._setFinal(record, current, a);
          break;
        }
        if (!opts.exempt && this.hooks.isBlockedForAuditor?.(next)) {
          record.terminal = 'BLOCKED_BY_ROBOTS_FOR_AUDITOR';
          this._setFinal(record, current, a);
          break;
        }
        current = next;
        continue;
      }
      this._setFinal(record, current, a);
      record.terminal = record.terminal || 'OK';
      break;
    }
    record.hop_count = record.chain.filter((h) => h.resolved).length;
    record.elapsed_ms = Date.now() - start;
    if (record.not_responding) record.status = record.status ?? null;
    this._trackRateLimit(record);
    this._trackBotProtection(record);
    this.log.push({
      url,
      final_url: record.final_url,
      status: record.status,
      elapsed_ms: record.elapsed_ms,
      budget_class: budgetClass,
      terminal: record.terminal,
    });
    return record;
  }

  _setFinal(record, url, a) {
    record.final_url = url;
    record.status = a.status;
    record.headers = a.headers;
    record.raw_headers = a.raw_headers;
    record.body = a.body || Buffer.alloc(0);
    record.bytes = a.bytes || 0;
    record.truncated = !!a.truncated;
  }

  async _attemptWithRetries(url, opts, { budgetEnd, responseEnd, record, unresponsive }) {
    const attempts = [];
    const host = hostOf(url);
    // A complete attempt can never outlast the unresponsive threshold for its budget class.
    const fullAttempt = Math.min(this.net.timeout_connect_ms + this.net.timeout_read_ms, unresponsive);
    let retryAfterUsed = false;
    let i = 0;
    while (true) {
      const release = await this.acquire(host);
      let a;
      try {
        const deadlineAt = Math.min(budgetEnd, responseEnd, Date.now() + fullAttempt);
        a = await this.attempt(url, {
          method: 'GET',
          headers: opts.headers,
          deadlineAt,
          discardBody: opts.discardBody,
          maxBytes: opts.maxBytes,
        });
      } finally {
        release();
      }
      attempts.push({
        n: ++i,
        status: a.status,
        elapsed_ms: a.elapsed_ms,
        stall_stage: a.stall_stage,
        error: a.error?.code || null,
      });

      const retryableStatus = a.status != null && this.net.retry_on.includes(a.status);
      const retryableErr = a.error && a.status == null && ['reset', 'dns_error', 'connect_timeout', 'network'].includes(a.error.kind);
      if (!retryableStatus && !retryableErr) return { attempts, final: a };
      // F-1.3-3 never retry 404/403 (not in retry_on); 4xx other than 408/429 are never retried.

      let wait = jitter(this.net.backoff_ms[Math.min(i - 1, this.net.backoff_ms.length - 1)]);
      if ((a.status === 429 || a.status === 503) && a.headers?.['retry-after'] && !retryAfterUsed) {
        const ra = parseRetryAfter(a.headers['retry-after']);
        if (ra != null) {
          if (Date.now() + ra + fullAttempt > budgetEnd) {
            record.retry_after_not_waited = ra; // R-1.3-7 recorded, not waited on
            return { attempts, final: a };
          }
          wait = ra;
          retryAfterUsed = true;
          record.retry_after_honoured = true;
        }
      } else if (a.status === 429 && retryAfterUsed) {
        return { attempts, final: a };
      }
      // Budget-bound ladder (R-FETCH-10): only retry if a complete attempt + backoff fits.
      if (Date.now() + wait + fullAttempt > budgetEnd) return { attempts, final: a };
      if (Date.now() + wait >= responseEnd) return { attempts, final: a };
      await sleep(wait);
    }
  }

  _trackRateLimit(record) {
    const host = hostOf(record.requested_url);
    const st = this.hostState.get(host);
    if (!st) return;
    if (record.status === 429) {
      st.consecutive429++;
      if (record.budget_class === 'primary') this.page429++;
      if (st.consecutive429 >= 3) this.hooks.onAbort?.('RATE_LIMITED_BY_TARGET'); // F-RUN-4
    } else if (record.status != null) {
      st.consecutive429 = 0;
    }
    if (this.pageFetches >= 4 && this.page429 / this.pageFetches >= 0.3) this.hooks.onAbort?.('RATE_LIMITED_BY_TARGET');
  }

  _trackBotProtection(record) {
    if (detectBotProtection(record)) {
      record.bot_protection = true;
      this.botProtectionUrls.add(record.requested_url);
      if (this.botProtectionUrls.size >= 3) this.hooks.onAbort?.('BOT_PROTECTION_DETECTED'); // F-RUN-5
    }
  }
}

export function parseRetryAfter(v) {
  if (v == null) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
}

/** Interstitial detection (F-RUN-5, B-1.4-4): records the page and stops; nothing further is attempted. */
/**
 * Is this response a bot challenge rather than the page?
 *
 * The status filter below used to come first, so only 403/429/503 were examined. Cloudflare serves
 * its "One moment, please…" interstitial with **HTTP 200**, which meant the most common challenge
 * of all was never looked at: it passed through as a successful fetch and was parsed as the page.
 *
 * Classification now runs on the body regardless of status. classifyResponse carries the signal
 * list, so this stays a thin boolean over it.
 */
export function detectBotProtection(record) {
  const h = record.headers || {};
  if (h['cf-mitigated'] === 'challenge') return true;
  const html = record.body?.subarray(0, 60000).toString('utf8') || '';
  const verdict = classifyResponse({
    status: record.status,
    headers: h,
    html,
    contentType: h['content-type'],
  });
  return verdict.state === VALIDITY.ACCESS_CHALLENGE;
}

export function bodyText(record) {
  if (!record?.body?.length) return '';
  const ct = String(record.headers?.['content-type'] || '');
  const m = /charset=([^;]+)/i.exec(ct);
  const cs = (m?.[1] || 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '');
  try {
    return new TextDecoder(cs, { fatal: false }).decode(record.body);
  } catch {
    return new TextDecoder('utf-8').decode(record.body);
  }
}

export { STAGES };
