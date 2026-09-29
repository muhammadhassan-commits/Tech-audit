// URL handling — R-FETCH-9 (RFC 3986 normalisation) and same-site rules (R-A0-5).
import { domainToASCII } from 'node:url';
import { parse as parseDomain } from 'tldts';

const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' };

function upperPercent(s) {
  return s.replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase());
}

function removeDotSegments(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '.') continue;
    if (seg === '..') {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(seg);
  }
  let res = out.join('/');
  if ((p.endsWith('/.') || p.endsWith('/..')) && !res.endsWith('/')) res += '/';
  return res || '/';
}

/**
 * Normalise per R-FETCH-9: lowercase scheme + host, default port removed, dot-segments
 * resolved, percent-encoding uppercased. Path case, trailing slash and query are preserved.
 * Returns null for anything that is not an absolute http(s) URL.
 */
export function normalizeUrl(input, base) {
  let u;
  try {
    u = base ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = domainToASCII(u.hostname.toLowerCase()) || u.hostname.toLowerCase(); // E-A0-2 A-label
  const port = u.port && u.port !== DEFAULT_PORTS[u.protocol] ? `:${u.port}` : '';
  const pathname = upperPercent(removeDotSegments(u.pathname || '/'));
  const search = u.search ? upperPercent(u.search) : '';
  const hash = u.hash || '';
  return `${u.protocol}//${host}${port}${pathname}${search}${hash}`;
}

export function stripFragment(url) {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

export function originOf(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

export function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

/** R-A0-5 — same site = exact canonical_origin host match (subdomains are different sites). */
export function isSameSite(url, canonicalOrigin) {
  try {
    const a = new URL(url);
    const b = new URL(canonicalOrigin);
    return a.host.toLowerCase() === b.host.toLowerCase();
  } catch {
    return false;
  }
}

export function registrableDomain(host) {
  const r = parseDomain(host);
  return r.domain || host;
}

export function isAbsoluteHttpUrl(s) {
  return /^https?:\/\/[^\s/]+/i.test(String(s || '').trim());
}

/** Seed parsing — R-A0-1: accept with/without scheme, www, path. */
export function parseSeed(seed) {
  let s = String(seed || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = domainToASCII(u.hostname.toLowerCase()) || u.hostname.toLowerCase();
  const hadWww = host.startsWith('www.');
  return {
    raw: seed,
    host,
    bareHost: hadWww ? host.slice(4) : host,
    hadWww,
    port: u.port || '',
    path: u.pathname + u.search,
    isDeep: (u.pathname && u.pathname !== '/') || !!u.search,
  };
}
