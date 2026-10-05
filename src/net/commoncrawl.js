// Common Crawl index lookup.
//
// What a hit here does and does not establish. It establishes that at least one URL from the domain
// was captured in that crawl. It does not establish that any model trained on it, that an assistant
// will cite it, that a search engine can reach the site today, or anything about ranking. Common
// Crawl is an open web archive, not a search index and not a training manifest, and presenting
// presence in it as an SEO or AI-visibility outcome would be inventing a meaning it does not carry.
//
// So this is INFO and never scored.
//
// The crawl release is read from the live index list rather than hardcoded: releases appear roughly
// monthly, and a pinned id silently reports "absent" forever once it ages out.
import { registrableDomain } from '../parse/url.js';

const COLLINFO = 'https://index.commoncrawl.org/collinfo.json';

/** One attempt, with a single retry on the transient failures this API is prone to. */
async function getJson(url, { ua, timeoutMs, retries = 1 }) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { 'user-agent': ua, accept: 'application/json' } });
      const text = await res.text();
      // The CDX API answers 504/503 under load often enough that one retry is worth the wait.
      if ((res.status === 503 || res.status === 504 || res.status === 429) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      return { status: res.status, text };
    } catch (e) {
      if (attempt < retries && e.name !== 'AbortError') {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      return { error: e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', message: String(e.message).slice(0, 160) };
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: 'NETWORK', message: 'exhausted retries' };
}

/** The crawl releases, newest first. */
export async function listIndexes(opts) {
  const r = await getJson(COLLINFO, opts);
  if (r.error) return { ok: false, error: r.error, message: r.message };
  if (r.status !== 200) return { ok: false, error: 'API_STATUS', message: `collinfo returned HTTP ${r.status}` };
  try {
    const list = JSON.parse(r.text);
    if (!Array.isArray(list) || !list.length) return { ok: false, error: 'BAD_JSON', message: 'collinfo returned no indexes' };
    return { ok: true, indexes: list };
  } catch {
    return { ok: false, error: 'BAD_JSON', message: 'collinfo was not valid JSON' };
  }
}

/**
 * Look for a domain in one crawl release.
 * Resolves { ok, found, record } or { ok: false, error } — never throws.
 */
export async function queryIndex(indexId, domain, opts) {
  const url = `https://index.commoncrawl.org/${encodeURIComponent(indexId)}-index`
    + `?url=${encodeURIComponent(domain)}&matchType=domain&output=json&limit=1`;
  const r = await getJson(url, opts);
  if (r.error) return { ok: false, error: r.error, message: r.message };
  // 404 from the CDX API means "nothing captured", which is an answer, not a failure.
  if (r.status === 404) return { ok: true, found: false };
  if (r.status !== 200) return { ok: false, error: 'API_STATUS', message: `HTTP ${r.status}` };

  const line = r.text.trim().split('\n').find(Boolean);
  if (!line) return { ok: true, found: false };
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return { ok: false, error: 'BAD_JSON', message: 'the index returned a line that was not JSON' };
  }
  // The required fields, and the domain actually matching: a CDX query can return a neighbouring
  // registrable domain, and counting that as a hit would be reporting someone else's capture.
  if (!rec.url || !rec.timestamp || !rec.filename) return { ok: true, found: false };
  if (registrableDomain(new URL(rec.url).hostname) !== domain) return { ok: true, found: false };

  return { ok: true, found: true, record: { url: rec.url, timestamp: rec.timestamp, filename: rec.filename, status: rec.status ?? null } };
}

/**
 * Presence in the latest release, falling back to the previous two.
 *
 * Only three releases are checked. Walking the whole archive would turn a fast initial audit into a
 * long one to answer a question that is INFO either way.
 */
export async function presence(host, opts) {
  const domain = registrableDomain(host) || host;
  const list = await listIndexes(opts);
  if (!list.ok) return { ok: false, error: list.error, message: list.message, domain };

  const recent = list.indexes.slice(0, 3);
  for (let i = 0; i < recent.length; i++) {
    const idx = recent[i];
    const q = await queryIndex(idx.id, domain, opts);
    if (!q.ok) return { ok: false, error: q.error, message: q.message, domain, index_id: idx.id };
    if (q.found) {
      return {
        ok: true, found: true, latest: i === 0, domain,
        index_id: idx.id, index_name: idx.name, record: q.record,
        checked_at: new Date().toISOString(),
        indexes_checked: recent.slice(0, i + 1).map((x) => x.id),
      };
    }
  }
  return {
    ok: true, found: false, domain,
    checked_at: new Date().toISOString(),
    indexes_checked: recent.map((x) => x.id),
  };
}
