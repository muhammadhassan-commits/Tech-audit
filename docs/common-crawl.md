# Common Crawl: how to use it, and how this tool uses it

Everything below was verified live against the API on 2026-10-06. Where the outage described in §0
stopped me verifying something, it is marked **[unverified]** rather than stated as fact.

---

## 0. Current status: the query API is down, the file host is not

| Endpoint | Result |
| :-- | :-- |
| `index.commoncrawl.org/` (homepage) | **200**, 0.8 s |
| `index.commoncrawl.org/collinfo.json` | **200**, 0.9 s |
| `index.commoncrawl.org/CC-MAIN-*-index?url=…` | **504**, 10.7 s — *every* index, *every* query |
| `data.commoncrawl.org/…` (WARC/WAT/WET, manifests) | **200**, byte ranges work |

Tested across five crawl releases (2026-39, 2026-34 and 2025-05 among them), four query shapes
(`exact`, `prefix`, `host`, `domain`) and two domains including `example.com` as a control. All
returned 504 at a flat ~10.7 s, which is a gateway timeout rather than load.

**So X-5.5 reporting `NOT_TESTABLE` / `COMMON_CRAWL_API_UNAVAILABLE` is correct.** The rule that
produced it (R-5.5-5) says an API that did not answer is never reported as the domain being absent.
Reporting "not in Common Crawl" here would have been a finding about Common Crawl's gateway, not
about the site.

This service 504s often. Treat it as expected, not exceptional.

---

## 1. What Common Crawl is

An open repository of web crawl data, published as roughly monthly releases since 2008. Each release
is billions of pages: the raw HTTP exchanges, plus derived metadata and plain text.

What presence in it **does** establish: at least one URL from the domain was captured in that crawl.

What it **does not** establish — and this matters for how the tool words its findings: nothing about
whether a model trained on it, whether an assistant will cite the site, whether a search engine can
reach it, and nothing about ranking. It is an archive, not a search index and not a training
manifest.

## 2. Is an API key required?

**No.** Every request in this document is unauthenticated. There is no key, no signup, no header.
The S3 bucket is public and `data.commoncrawl.org` fronts it over HTTPS.

## 3. Official endpoints

```
https://index.commoncrawl.org/collinfo.json                      # list of crawl releases
https://index.commoncrawl.org/CC-MAIN-<YYYY>-<WW>-index?url=…    # CDX query API
https://data.commoncrawl.org/crawl-data/CC-MAIN-<YYYY>-<WW>/…    # manifests and data files
https://data.commoncrawl.org/cc-index/collections/CC-MAIN-…/     # the index shards themselves
```

## 4. Getting the available crawl indexes

```bash
curl -s https://index.commoncrawl.org/collinfo.json | head -40
```

Returns 128 releases as of today, newest first. Each entry:

```json
{ "id": "CC-MAIN-2026-39",
  "name": "September 2026 Index",
  "timegate": "https://index.commoncrawl.org/CC-MAIN-2026-39/",
  "cdx-api": "https://index.commoncrawl.org/CC-MAIN-2026-39-index" }
```

**Read this live; never hardcode an id.** Releases appear roughly monthly, and a pinned id silently
reports "absent" forever once it ages out. This tool reads `collinfo.json` on every run for exactly
that reason (R-5.5-1).

## 5–6. Searching a domain, or a URL pattern

```bash
IDX=https://index.commoncrawl.org/CC-MAIN-2026-39-index

# every URL captured for the registrable domain, including subdomains
curl -s "$IDX?url=example.com&matchType=domain&output=json&limit=20"

# that exact host only
curl -s "$IDX?url=example.com&matchType=host&output=json"

# a path prefix
curl -s "$IDX?url=example.com/blog/&matchType=prefix&output=json"

# one exact URL
curl -s "$IDX?url=https://example.com/&output=json"
```

The wildcard form `url=example.com/*` is equivalent to `matchType=prefix`.

Output is **JSON Lines** — one JSON object per line, not a JSON array. Parse line by line.

A record carries at least `url`, `timestamp`, `filename`, `offset` and `length`, plus `status`,
`mime` and `digest`. The `filename`/`offset`/`length` triple is what you need to fetch the page
itself (§7).

## 7. Retrieving WARC, WAT and WET files

Three views of the same crawl:

- **WARC** — the raw exchange: request, response headers, response body.
- **WAT** — metadata as JSON: headers, links, title. No body.
- **WET** — extracted plain text only.

Manifests for a release (all verified 200):

```bash
B=https://data.commoncrawl.org/crawl-data/CC-MAIN-2026-39
curl -s $B/warc.paths.gz | gunzip | head -1
curl -s $B/wat.paths.gz  | gunzip | head -1
curl -s $B/wet.paths.gz  | gunzip | head -1
```

Paths are derived from one another by substitution — verified, both return 200:

```
…/warc/CC-MAIN-20260904131603-20260904161603-00000.warc.gz
…/wat/ CC-MAIN-20260904131603-20260904161603-00000.warc.wat.gz
…/wet/ CC-MAIN-20260904131603-20260904161603-00000.warc.wet.gz
```

**Fetching one page, not the whole 1 GB file.** Each record is its own gzip member, so an HTTP range
request over `offset`/`length` from the CDX record returns a standalone gzip stream:

```bash
curl -s -r 0-199 "https://data.commoncrawl.org/$PATH" | gunzip | head
# WARC/1.0
# WARC-Type: warcinfo
```

This is the single most important technique here: never download a whole WARC to read one page.

## 8. Index API vs CDX API vs raw files

They are not three things — they are two, and one of them has two names.

- **The Index API and the CDX API are the same service.** "CDX" is the index format, inherited from
  the Wayback Machine; `index.commoncrawl.org` is the server that speaks it. It answers *"which
  crawls captured this URL, and where in the archive is it?"* It gives you a pointer.
- **The raw crawl files** on `data.commoncrawl.org` are the content. You go there with the pointer.
- There is also a **columnar (Parquet) index** on S3, queryable with Athena, DuckDB or Spark. It is
  the right tool for bulk analysis — "every .edu URL in this crawl" — which the CDX API will
  rate-limit or time out on. **[unverified today]**

## 9. Working examples

### cURL

```bash
IDX=$(curl -s https://index.commoncrawl.org/collinfo.json | python -c "import json,sys;print(json.load(sys.stdin)[0]['cdx-api'])")
curl -s "$IDX?url=example.com&matchType=domain&output=json&limit=5"
```

### Python

```python
import gzip, io, json, urllib.parse, urllib.request

UA = "my-tool/1.0 (contact: you@example.com)"

def get(url, **headers):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **headers})
    return urllib.request.urlopen(req, timeout=60)

def latest_index():
    return json.load(get("https://index.commoncrawl.org/collinfo.json"))[0]["cdx-api"]

def search(domain, match="domain", limit=20, **extra):
    q = {"url": domain, "matchType": match, "output": "json", "limit": limit, **extra}
    body = get(f"{latest_index()}?{urllib.parse.urlencode(q)}").read().decode()
    return [json.loads(line) for line in body.splitlines() if line.strip()]

def fetch_page(rec):
    """Pull one captured page out of its WARC with a range request."""
    start = int(rec["offset"])
    end = start + int(rec["length"]) - 1
    raw = get("https://data.commoncrawl.org/" + rec["filename"],
              Range=f"bytes={start}-{end}").read()
    body = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
    # WARC header, then HTTP header, then the body - separated by blank lines.
    return body.split(b"\r\n\r\n", 2)[2].decode("utf-8", "replace")

for r in search("example.com", limit=5):
    print(r["timestamp"], r["status"], r["url"])
```

### JavaScript (Node 18+)

```js
import { gunzipSync } from 'node:zlib';

const UA = 'my-tool/1.0 (contact: you@example.com)';

async function latestIndex() {
  const r = await fetch('https://index.commoncrawl.org/collinfo.json', { headers: { 'user-agent': UA } });
  return (await r.json())[0]['cdx-api'];
}

async function search(domain, { match = 'domain', limit = 20, ...extra } = {}) {
  const q = new URLSearchParams({ url: domain, matchType: match, output: 'json', limit, ...extra });
  const res = await fetch(`${await latestIndex()}?${q}`, { headers: { 'user-agent': UA } });
  if (res.status === 404) return [];                       // "nothing captured" is an answer
  if (!res.ok) throw new Error(`CDX HTTP ${res.status}`);  // a 504 is NOT "absent"
  return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function fetchPage(rec) {
  const start = Number(rec.offset);
  const end = start + Number(rec.length) - 1;
  const res = await fetch(`https://data.commoncrawl.org/${rec.filename}`,
    { headers: { 'user-agent': UA, range: `bytes=${start}-${end}` } });
  const raw = gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8');
  return raw.split('\r\n\r\n').slice(2).join('\r\n\r\n');  // drop WARC + HTTP headers
}
```

## 10. The parameters

| Parameter | What it does |
| :-- | :-- |
| `url` | The URL or domain to look up. Always URL-encode it. |
| `matchType` | `exact` (default), `prefix` (this path and below), `host` (that hostname only), `domain` (hostname and all subdomains). |
| `output` | `json` gives JSON Lines. Omit it and you get the legacy space-separated CDX text. |
| `limit` | Maximum records returned. Use it — an unbounded query on a large domain is how you get a 504. |
| `offset` | Skip the first N records. Crude paging; prefer `page`/`pageSize`. |
| `from` / `to` | Timestamp bounds, `YYYYMMDDhhmmss` truncated to any length — `from=202601` means January 2026 onward. |
| `filter` | Field constraint. `filter==status:200` for exact, `filter=~url:blog` for regex, `filter=!=mime:text/html` to negate. Repeatable; all must match. **[unverified today]** |
| `page`, `pageSize`, `showNumPages` | Proper pagination. `showNumPages=true` returns the page count first. **[unverified today]** |

## 11. Practical recipes

```bash
IDX=https://index.commoncrawl.org/CC-MAIN-2026-39-index

# every URL for a domain, across subdomains
curl -s "$IDX?url=example.com&matchType=domain&output=json"

# latest pages from a domain, successful HTML only
curl -s "$IDX?url=example.com&matchType=domain&output=json&from=202601&filter==status:200&limit=100"

# blog URLs only
curl -s "$IDX?url=example.com/blog/&matchType=prefix&output=json&limit=100"

# is this domain present at all? (what X-5.5 asks)
curl -s "$IDX?url=example.com&matchType=domain&output=json&limit=1"
```

For *page content*, use `fetch_page()` above. For *metadata without the body*, read the WAT record at
the same offset — it is JSON with headers, links and title already parsed, and far smaller.

## 12. Rate limits, restrictions, best practices

There is no published hard rate limit, and no key to scope one to. What is observable is that the CDX
service is small and fails under load — 503 and 504 are routine, and today it is returning 504 for
everything. Treat it as best-effort infrastructure.

- **Send a real `User-Agent` with contact details.** It is the only way they can reach you.
- **One request at a time.** Do not parallelise across indexes.
- **Always set `limit`.** Unbounded queries on large domains are the main source of timeouts.
- **Retry 503/504/429 once, with backoff — then give up and say so.** Do not retry in a tight loop.
- **Never read a 5xx as "not present".** This is the one that produces false findings: a gateway
  timeout means you did not get an answer, not that the answer was no. A 404 *is* an answer.
- **Use range requests** for page content; never download a whole WARC for one record.
- **For bulk work use the columnar index** via Athena/DuckDB, not the CDX API.
- **Cache.** A crawl release is immutable once published, so a result for a given index id never
  changes and can be cached indefinitely.

---

## How this tool uses it (X-5.5)

Deliberately narrow — a presence check, nothing more:

1. Read `collinfo.json` live; never hardcode an id (R-5.5-1).
2. Resolve the registrable domain through the public suffix list, not by stripping `www` (R-5.5-2).
3. Query `matchType=domain`, `limit=1`, newest release first.
4. Count a record only if it has `url`, `timestamp` **and** `filename`, **and** its registrable
   domain matches the one requested — a CDX query can return a neighbouring domain, and counting
   that would report someone else's capture (R-5.5-3).
5. Check the latest release, then the previous two, and stop (R-5.5-4).
6. **An API that did not answer is `NOT_TESTABLE`, never absence** (R-5.5-5). One retry with backoff,
   then report the HTTP status plainly.

The check is **advisory**: reported, never scored (ADD-11.4). Nothing a search engine requires
depends on it.
