// Text utilities: script-aware word counting (E-6.1-5 / F-6.1-2), shingles, similarity, sentences.

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g;
const STOP = new Set(
  'a an and are as at be by for from has have how i in is it its of on or our that the their this to was we what when where which who why will with you your can does not more all any about into than then them they these those also just only very'.split(' '),
);

export function collapse(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** Word count that does not apply space-delimitation to CJK scripts: each CJK char ≈ 1 unit / 2. */
export function wordCount(s) {
  const t = collapse(s);
  if (!t) return 0;
  const cjk = (t.match(CJK) || []).length;
  const rest = t.replace(CJK, ' ');
  const words = rest.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return words + Math.round(cjk / 2);
}

export function isMostlyNonLatin(s) {
  const t = collapse(s);
  if (!t) return false;
  const letters = t.match(/\p{L}/gu) || [];
  if (!letters.length) return false;
  const latin = letters.filter((c) => /[A-Za-zÀ-ɏ]/.test(c)).length;
  return latin / letters.length < 0.5;
}

export function tokens(s) {
  return collapse(s)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function significantTokens(s) {
  return tokens(s).filter((t) => t.length >= 3 && !STOP.has(t));
}

export function shingles(s, n = 5) {
  const t = tokens(s);
  const out = new Set();
  if (t.length < n) {
    if (t.length) out.add(t.join(' '));
    return out;
  }
  for (let i = 0; i <= t.length - n; i++) out.add(t.slice(i, i + n).join(' '));
  return out;
}

export function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

export function levenshteinRatio(a, b) {
  a = String(a);
  b = String(b);
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

export function sentences(s) {
  const t = collapse(s);
  if (!t) return [];
  return t
    .split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"“'(])/u)
    .map((x) => x.trim())
    .filter((x) => x.length > 1);
}

export function graphemeLength(s) {
  try {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(String(s))].length;
  } catch {
    return [...String(s)].length;
  }
}

// Approximate 20px Arial advance widths (R-2.1-8 truncation proxy only).
const NARROW = /[iljtfI!.,;:'|]/;
const WIDE = /[mwMW@%]/;
export function pixelWidth(s, px = 20) {
  let w = 0;
  for (const ch of String(s)) {
    if (ch === ' ') w += 0.28;
    else if (NARROW.test(ch)) w += 0.28;
    else if (WIDE.test(ch)) w += 0.83;
    else if (/[A-Z]/.test(ch)) w += 0.67;
    else if (/[぀-鿿]/.test(ch)) w += 1.0;
    else w += 0.55;
  }
  return Math.round(w * px);
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

export const PLACEHOLDER_RE = /\{\{|\}\}|%s\b|\[title\]|%%|\{\$|<%|\$\{/i;

export function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export { STOP };
