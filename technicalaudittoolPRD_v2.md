Table of Contents

# **Initial Technical SEO \+ LLM Visibility Audit — Build Specification (PRD)**

**Version:** 2.0 (22 September 2026\) **Status:** Implementation-ready **Source of truth:** “Audit checklist” tab — *Website Technical SEO \+ LLM Optimization & Visibility Audit Framework* **Scope of this document:** Rules, Conditions, Exceptional Conditions, Backup Plans, Failing & Stopping Plans for every checklist item. **No UX/UI in scope**, with one exception: the source-attribution affordance in §4.1, which is a binding output requirement.

---

## **0\. How to read this document**

This PRD is written to be handed to a code-generating LLM without further interpretation. Every check is specified in the same six-part structure:

| Part | Meaning | Binding? |
| :---- | :---- | :---- |
| **RULES (R-\*)** | Deterministic logic. Implement exactly. No inference permitted. | Binding |
| **CONDITIONS (C-\*)** | The complete mapping from observed state → emitted status. Mutually exclusive, evaluated top-down, first match wins. | Binding |
| **EXCEPTIONAL CONDITIONS (E-\*)** | Real-world states that must NOT be treated as failures. Evaluated **before** C-\*. | Binding |
| **BACKUP PLANS (B-\*)** | Ordered fallback ladder when the primary data source is unavailable. Try in order; stop at first success. | Binding |
| **FAILING & STOPPING PLAN (F-\*)** | What is a check-level failure, what is a run-level abort, and what the tool must never do. | Binding |
| **SOURCES** | Every reason\_code the check emits maps to one or more Appendix E refs, carried into the report as sources\[\] and surfaced on the finding (§4.1). | Binding |

**Non-negotiable global principle:**

The tool never guesses. Any check that cannot obtain its required evidence emits NOT\_TESTABLE with a machine-readable reason\_code. NOT\_TESTABLE is never rendered as PASS, and never rendered as FAIL. Absence of evidence is recorded as absence of evidence.

---

## **1\. Status vocabulary (closed enum — do not extend)**

check\_status — one value per check, per target.

| Value | Meaning | Counts toward score? |
| :---- | :---- | :---- |
| PASS | Evidence obtained; all binding conditions met. | Yes (positive) |
| WARN | Evidence obtained; non-blocking deviation from best practice. | Yes (partial) |
| FAIL | Evidence obtained; a binding condition is violated. | Yes (negative) |
| NOT\_APPLICABLE | Check is out of scope for this target by rule (e.g. hreflang on a monolingual site). | No — excluded from denominator |
| NOT\_TESTABLE | Check is in scope but required evidence could not be obtained. | No — excluded from denominator, listed separately |
| ERROR | Tool-side defect (unhandled exception, contract violation). Must be zero in a healthy run. | No — triggers run-quality flag |

**Rules governing status:**

* R-STATUS-1 — A check emits exactly one check\_status. Never a list.

* R-STATUS-2 — NOT\_APPLICABLE and NOT\_TESTABLE are **not** interchangeable. NOT\_APPLICABLE \= “this does not apply here.” NOT\_TESTABLE \= “this applies but I could not measure it.”

* R-STATUS-3 — Every non-PASS status carries a non-empty reason\_code from the registry in Appendix D.

* R-STATUS-4 — Every status carries evidence\[\] (Appendix B). A PASS with empty evidence is an ERROR.

* R-STATUS-5 — ERROR is reserved for tool defects. A 500 from the audited site is not ERROR; it is data.

**severity** — independent of status, set only when status is FAIL or WARN:

| Value | Definition |
| :---- | :---- |
| CRITICAL | Blocks crawling, indexing, or AI retrieval of the page/site outright. |
| HIGH | Materially degrades indexing, canonicalisation, or retrieval quality. |
| MEDIUM | Best-practice deviation with measurable but bounded impact. |
| LOW | Hygiene / consistency issue. |

**confidence** — set on every result:

| Value | When |
| :---- | :---- |
| OBSERVED | Measured directly from a first-party artefact (HTTP response, DOM, API payload). |
| DERIVED | Computed from observed artefacts by deterministic rule. |
| MODELLED | Produced by a scoring rubric or LLM judge. **Must** carry a methodology caveat string. |
| THIRD\_PARTY | Sourced from an external API whose freshness/coverage the tool does not control. |

R-STATUS-6 — Any result with confidence of MODELLED or THIRD\_PARTY must populate caveat with a one-line limitation statement. Renderers must not suppress it.

---

## **2\. Global configuration**

All values below are configuration, not constants in code. Defaults shown are binding when unset.

### **2.1 Capability flags**

| Key | Type | Default | Effect when false |
| :---- | :---- | :---- | :---- |
| cap.render\_js | bool | true | All rendered-DOM checks fall to raw-HTML-only rules and set caveat \= “Raw HTML only; JavaScript-injected values not evaluated.” |
| cap.psi\_api | bool | true | C-4.1 falls to backup ladder B-4.1-2 onward. |
| cap.crux\_api | bool | true | Field-data path disabled; lab-only with caveat. |
| cap.gsc\_api | bool | false | Index-status corroboration unavailable; C-1.7 relies on on-page evidence only. |
| cap.llm\_judge | bool | true | Section 6 subjective sub-scores → NOT\_TESTABLE / RUBRIC\_DISABLED; deterministic gates still run. |
| cap.ua\_probe | bool | **false** | User-agent variant probing (R-FETCH-7) is disabled. C-5.1-i, C-6.1-n and the dynamic-rendering detection in E-5.2-8 → NOT\_TESTABLE. This is the safe default and must remain opt-in. |

### **2.2 Network policy**

| Key | Default | Notes |
| :---- | :---- | :---- |
| net.user\_agent | WellowsAuditBot/1.0 (+{contact\_url}) | Truthful. **Never** impersonate Googlebot or any AI vendor UA (R-FETCH-7). |
| net.url\_budget\_ms | 30000 | **Hard per-URL wall-clock ceiling for a sampled page.** Covers DNS, connect, TLS, request, response, every redirect hop, every retry, every backoff wait and the RENDERED load. No check may exceed it (R-FETCH-10). |
| net.unresponsive\_ms | 20000 | Point at which a URL without a complete response is declared PAGE\_NOT\_RESPONDING (R-FETCH-11). |
| net.secondary\_budget\_ms | 10000 | Ceiling for every fetch that is not a sampled page: discovery probes, link-validation targets, sitemap variants, hreflang alternates, control files. |
| net.secondary\_unresponsive\_ms | 8000 | PAGE\_NOT\_RESPONDING threshold for those fetches. |
| net.timeout\_connect\_ms | 5000 | Per attempt. |
| net.timeout\_read\_ms | 12000 | Per attempt. Connect \+ read \= 17000, so one full attempt always fits inside net.unresponsive\_ms. |
| net.retries | budget-bound | No fixed count. A retry is issued only while the remaining URL budget covers a complete attempt plus its backoff; otherwise the ladder stops early and the verdict is taken on what was observed (R-FETCH-10). |
| net.backoff\_ms | \[750, 2000\] | Plus jitter ±25%. Backoff waits are charged to the URL budget. |
| net.retry\_on | \[429, 500, 502, 503, 504, 408\] \+ connection reset / DNS timeout | Never retry 4xx other than 408/429. |
| net.max\_redirect\_hops | 10 | Matches Google’s documented default. Hop 11 \= chain-too-long. |
| net.concurrency\_per\_host | 2 |  |
| net.min\_delay\_ms | 500 | Between requests to the same host. |
| net.max\_response\_bytes | 10485760 (10 MB) | Truncate and flag TRUNCATED\_RESPONSE. |
| net.respect\_robots | true | See R-FETCH-4. |
| net.follow\_meta\_refresh | false | Recorded, not followed, except where a check states otherwise. |

### **2.3 Thresholds (single registry — no threshold may be hard-coded elsewhere)**

| Key | Default | Source |
| :---- | :---- | :---- |
| th.robots\_max\_bytes | 512000 (500 KiB) | Google robots.txt spec |
| th.robots\_max\_redirect\_hops | 5 | Google robots.txt spec |
| th.redirect\_chain\_warn | 2 | Tool policy |
| th.redirect\_chain\_fail | 5 | Tool policy |
| th.googlebot\_bytes\_supported\_type | 2097152 (2 MB) | Google Googlebot doc |
| th.googlebot\_bytes\_pdf | 67108864 (64 MB) | Google Googlebot doc |
| th.crawler\_bytes\_default | 15728640 (15 MB) | Google crawler-overview doc |
| th.lcp\_good\_ms | 2500 | web.dev |
| th.lcp\_poor\_ms | 4000 | web.dev |
| th.inp\_good\_ms | 200 | web.dev |
| th.inp\_poor\_ms | 500 | web.dev |
| th.cls\_good | 0.1 | web.dev |
| th.cls\_poor | 0.25 | web.dev |
| th.cwv\_percentile | 75 | web.dev |
| th.title\_len\_warn\_min | 15 | Tool policy — advisory only |
| th.title\_len\_warn\_max | 70 | Tool policy — advisory only |
| th.metadesc\_len\_warn\_min | 50 | Tool policy — advisory only |
| th.metadesc\_len\_warn\_max | 165 | Tool policy — advisory only |
| th.raw\_text\_ratio\_fail | 0.30 | Tool policy — see C-5.2 |
| th.raw\_text\_ratio\_warn | 0.70 | Tool policy — see C-5.2 |
| th.min\_words\_content\_page | 150 | Tool policy |
| th.freshness\_stale\_days | 540 | Tool policy |
| th.freshness\_warn\_days | 365 | Tool policy |
| schema.min\_sameas | 2 | Tool policy — see C-3.1 |
| render.raw\_text\_floor | 500 | Tool policy — see R-FETCH-3a |
| render.budget\_ms | 10000 | Tool policy — RENDERED hard cap, must fit inside net.url\_budget\_ms |

R-CFG-1 — Title and meta-description length values are **advisory** (WARN ceiling). Google documents no character limit for either; truncation is pixel- and device-dependent. The tool must never emit FAIL on length alone, and every length finding carries the caveat “Google specifies no character limit; truncation is device-width dependent.”

### **2.4 Page-type taxonomy (closed enum)**

homepage, service\_main, service\_secondary, product\_main, pricing, category, blog\_article, blog\_template\_alt, author, about, other.

---

## **3\. Fetch policy (applies to every HTTP request the tool makes)**

* R-FETCH-1 — Every request records: final URL, full redirect chain (status \+ Location per hop), status code, response headers (verbatim), timing, byte count, and whether the body was truncated.

* R-FETCH-2 — Two fetch profiles exist and are never conflated:

* **RAW** — single HTTP GET, no JavaScript, no subresources. This is the artefact for all “raw HTML” assertions.

* **RENDERED** — headless Chromium, network idle or render.budget\_ms (default 10000\) hard cap, JavaScript enabled, viewport 412×915 mobile by default. Requires cap.render\_js. A RENDERED load is started only when the URL’s elapsed time plus render.budget\_ms still fits inside net.url\_budget\_ms; otherwise it is skipped and the page is assessed RAW-only with the RENDER\_BUDGET\_UNAVAILABLE caveat.

* R-FETCH-3 — When both profiles are available, both are stored. Checks state explicitly which profile they read. A check that reads RENDERED when cap.render\_js \= false must fall back per its B-\* ladder, not silently read RAW.

* R-FETCH-4 — The tool obeys the audited site’s robots.txt for its own UA. A URL disallowed for net.user\_agent is **not** fetched; checks depending on it emit NOT\_TESTABLE / BLOCKED\_BY\_ROBOTS\_FOR\_AUDITOR. **Exception:** robots.txt, llms.txt, every URL requested by C-1.2 (robots-declared Sitemap: URLs and the two fixed paths in R-1.2-2), /.well-known/\* and any URL explicitly supplied by the operator are always fetchable — these are control files, and a robots rule cannot conceal the very file being audited.

* R-FETCH-3a — **Conditional RENDERED acquisition.** The RENDERED profile is expensive (a headless load per page, up to render.budget\_ms each) and most pages do not need it. Fetch RENDERED only for: the homepage, always; and any sampled page whose RAW response shows a client-rendering signature — a framework root element with an empty or near-empty body, a body text length under render.raw\_text\_floor (default 500 characters), or a  block that is the only substantive text. Every other page is assessed RAW-only and carries the caveat “Evaluated on raw HTML; this page showed no client-rendering signature.” Checks that require both profiles emit NOT\_TESTABLE / RENDER\_NOT\_REQUIRED for those pages rather than forcing a fetch.

* R-FETCH-10 — **Per-URL time budget.** Every URL carries one wall-clock budget, started at the first DNS lookup for that URL and stopped when its verdict is written. The budget covers DNS resolution, TCP connect, TLS handshake, request, response body, every redirect hop, every retry attempt, every backoff wait, and the RENDERED load where one runs. Two budgets exist:

| Class | Budget | Applies to |
| :---- | :---- | :---- |
| **Primary** | net.url\_budget\_ms (30000) | A sampled page — any URL in the 1–10 selected set, plus the homepage |
| **Secondary** | net.secondary\_budget\_ms (10000) | Every other fetch: discovery probes, depth-2 crawl, link-validation targets, C-1.2 sitemap variants, hreflang alternates, control files, the 404 probe |

* The budget is a hard stop, not a target. When it expires, in-flight work is abandoned, the connection is closed, and the verdict is taken on what was observed. The retry ladder is bounded by it: a retry is issued only while the remaining budget covers a complete attempt (net.timeout\_connect\_ms \+ net.timeout\_read\_ms) plus its backoff wait. The tool never extends a budget to obtain a cleaner result, and never runs a second profile it cannot finish inside the remainder.

* Elapsed time and the stage the clock stopped in are recorded on every fetch, whether or not the budget was reached.

* R-FETCH-11 — **Unresponsive classification.** A URL whose response is not complete by net.unresponsive\_ms (20000 primary, net.secondary\_unresponsive\_ms 8000 secondary) is classified **PAGE\_NOT\_RESPONDING**. The finding always reports the HTTP status **actually received**, and never a status the tool did not observe:

| What was received | http\_status | Finding text |
| :---- | :---- | :---- |
| A status line, but the body or render did not complete in time | the observed code | “Page not responding — HTTP {status}, incomplete after {elapsed} ms at {stall\_stage}” |
| Nothing: no status line before the threshold | **null** | “Page not responding — no HTTP status received; stalled at {stall\_stage} after {elapsed} ms” |

* stall\_stage is one of dns, connect, tls, first\_byte, body, render. A null http\_status is reported as null and is never rendered as 0, 408, 504 or any other placeholder — inventing a status the server did not send would violate §6 and F-NEVER-1. Where a redirect chain was partly followed, the last status actually received in the chain is reported alongside the hop at which the clock stopped.

* PAGE\_NOT\_RESPONDING is terminal for that URL: no further check evaluates it, and every page-level check that depended on it emits NOT\_TESTABLE / PAGE\_NOT\_RESPONDING rather than a FAIL. A page that did not answer is missing evidence, not a proven defect.

* R-FETCH-5 — Responses are cached per (url, profile) for the run’s duration. A URL is fetched at most once per profile per run unless a check declares no\_cache.

* R-FETCH-6 — HEAD is never used as a substitute for GET when body content is needed. Some servers answer HEAD differently; body-dependent checks always GET.

* R-FETCH-7 — The tool must not send a User-Agent that impersonates Googlebot, GPTBot, ClaudeBot, PerplexityBot or any third-party crawler for the purpose of obtaining different content. UA-variant probing is permitted **only** in C-5.1 and C-6.1, must be explicitly enabled by cap.ua\_probe, must be logged, and its findings carry confidence \= DERIVED with the caveat “UA-variant probe; server may treat unverified UA strings differently from the verified crawler.”

* R-FETCH-8 — Cookie jar is per-run and per-host. Consent walls are recorded, never auto-accepted.

* R-FETCH-9 — All URL comparisons use RFC 3986 normalisation: lowercase scheme \+ host, default port removed, dot-segments resolved, percent-encoding normalised to uppercase hex. **Path case, trailing slash, and query string are preserved and significant.**

---

## **4\. Evidence contract**

Every check result carries evidence\[\]. Each entry:

{

“kind”: “http\_header | http\_status | dom\_node | file\_content | api\_payload | computed | screenshot\_ref”,

“source\_url”: “https://example.com/page”,

“fetch\_profile”: “RAW | RENDERED | NONE”,

“selector\_or\_key”: “head \> link\[rel=canonical\] | Location | metrics.largest\_contentful\_paint”,

“observed\_value”: “…verbatim, truncated to 2000 chars with ellipsis flag…”,

“expected\_value”: “…or null…”,

“observed\_at”: “2026-09-08T11:04:12Z”,

“elapsed\_ms”: 20431,

“stall\_stage”: “dns | connect | tls | first\_byte | body | render | null”

}

* R-EV-1 — observed\_value is verbatim, never paraphrased, never normalised for display.

* R-EV-2 — Every FAIL carries at least one evidence entry that, on its own, demonstrates the failure.

* R-EV-3 — Evidence is immutable once written. Re-checks append; they do not overwrite.

---

## **4.1 Source attribution contract**

Every finding the tool emits must be traceable, by the reader, to the source that makes it a finding. A recommendation the reader cannot check is indistinguishable from an opinion, and this tool’s standing is its citations.

* R-SRC-1 — **Every** **reason\_code** **carries at least one source.** The registry in Appendix D maps each code to one or more refs in Appendix E. A code with no mapped source is a build error, not a runtime warning: the tool must fail its own build rather than ship an uncited finding.

* R-SRC-2 — **Source tiers (closed enum).** Every registered source carries exactly one tier, and the tier governs what a finding resting on it may claim:

| Tier | What it is | Examples | Maximum status it alone may support |
| :---- | :---- | :---- | :---- |
| STANDARD | A specification from a standards body | IETF RFC, W3C, WHATWG, ISO, schema.org, sitemaps.org | FAIL / CRITICAL |
| VENDOR\_DOC | A vendor’s own documentation of its own behaviour | Google Search Central docs, Google crawling docs, vendor crawler pages | FAIL / CRITICAL |
| VENDOR\_STATEMENT | A named employee of the vendor, in an official channel | Search Central Blog, Search Off the Record, documented office-hours or conference statements | WARN — unless it confirms an existing VENDOR\_DOC behaviour, in which case it may support FAIL as corroboration |
| INDUSTRY\_STUDY | Reproducible third-party research with a stated method and sample | Moz, Ahrefs, Semrush published studies | WARN |
| INDUSTRY\_COMMENTARY | Practitioner analysis and reporting | Search Engine Journal, Search Engine Roundtable, practitioner blogs | **Never the sole basis for any status** — corroboration only |
| TOOL\_POLICY | This tool’s own standard, with no external authority | The S1 required-field list for Organization | WARN, and the finding text must say it is this tool’s standard, not a vendor requirement |

* R-SRC-3 — **Tier discipline.** A FAIL or CRITICAL finding must cite at least one STANDARD or VENDOR\_DOC source. INDUSTRY\_STUDY and INDUSTRY\_COMMENTARY sources may accompany any finding, and are shown, but never raise its status. Where a finding’s only support is a vendor statement or third-party study, the status is capped at WARN and the finding text says which.

* R-SRC-4 — **Registry integrity.** Each source entry records ref, publisher, title, url, tier and retrieved\_on. The url must resolve at registry build time. A source whose URL cannot be resolved is not registered, and a source URL is **never** constructed, guessed or inferred from a title — an invented citation is worse than none, because it is checkable and wrong (§6, F-NEVER-1).

* R-SRC-5 — **Staleness.** The registry is re-resolved on a schedule. An entry whose URL has moved is updated with its new location and a re-dated retrieved\_on; an entry whose content has materially changed flags every reason\_code mapped to it for review before the next release. Vendor documentation moves — the register is a live artefact, not a bibliography written once.

* R-SRC-6 — **Output.** Every finding in the report carries sources\[\], each entry {ref, publisher, title, url, tier, note}. note is the one-line statement of what that source establishes for this specific finding, not a summary of the source.

* R-SRC-7 — **Presentation.** The reporting surface must make a finding’s sources reachable from the finding itself, without navigating away — a hover, tooltip or inline disclosure carrying publisher, title and a resolving link. The data contract above is binding; the choice of affordance is not specified here. A finding rendered with no route to its sources is a defect in the reporting layer.

* F-SRC-1 — Never present an INDUSTRY\_STUDY or INDUSTRY\_COMMENTARY source as though it were vendor documentation. The publisher and tier are shown to the reader, not just stored.

* F-SRC-2 — Never cite a source that does not address the specific finding. A general article about canonicals does not support a specific canonical-chain finding; the note in R-SRC-6 must be defensible on its own.

---

## **5\. Run-level failure & stopping plan**

Evaluated continuously. ABORT \= stop the run, emit partial report with run\_status \= ABORTED, list completed checks. HALT\_SECTION \= stop that section only.

| ID | Trigger | Action |
| :---- | :---- | :---- |
| F-RUN-1 | Seed URL unresolvable (DNS NXDOMAIN after 3 attempts across 2 resolvers). | ABORT / SEED\_DNS\_FAILURE. No further requests. |
| F-RUN-2 | Seed URL returns 5xx / connection reset on all 3 attempts **and** /robots.txt also unreachable. | ABORT / ORIGIN\_UNREACHABLE. |
| F-RUN-3 | Seed URL final status is 401 or 403 for the auditor UA, and no credentials configured. | ABORT / ACCESS\_DENIED. Emit remediation note: site requires allow-listing the auditor UA/IP. |
| F-RUN-4 | ≥ 30% of page fetches in the run return 429, or any single host returns 3 consecutive 429s. | ABORT / RATE\_LIMITED\_BY\_TARGET after honouring Retry-After once. Never continue at reduced rate past a second 429 streak. |
| F-RUN-5 | Bot-protection interstitial (JS challenge, CAPTCHA) detected on ≥ 3 distinct URLs. | ABORT / BOT\_PROTECTION\_DETECTED. Do not attempt evasion of any kind. |
| F-RUN-6 | robots.txt disallows the auditor UA site-wide (Disallow: / for \* or for net.user\_agent). | HALT page crawling. Run **only** control-file checks (C-1.1, C-1.2, C-5.3) and mark everything else NOT\_TESTABLE / BLOCKED\_BY\_ROBOTS\_FOR\_AUDITOR. Report this as a finding, not as a site defect. |
| F-RUN-7 | Wall-clock budget exceeded (run.max\_minutes, default 30). | HALT remaining checks, emit partial with BUDGET\_EXHAUSTED. Never truncate silently. The per-URL budgets in R-FETCH-10 bound the worst case: 10 sampled pages × 30 s plus secondary fetches × 10 s, so a run reaches this limit only when a large share of URLs are timing out — which is itself the finding. |
| F-RUN-8 | Robots.txt fetch returns 5xx or times out. | Per Google’s own handling: treat as **crawling not permitted** for the audit’s page-crawl phase. Emit C-1.1 \= FAIL/CRITICAL, run control-file checks only, and set run flag ROBOTS\_UNAVAILABLE\_CONSERVATIVE\_MODE. |
| F-RUN-9 | Unhandled exception in any check. | Catch at check boundary → ERROR for that check with stack ref. **Never** propagate to run abort. A single broken check must not kill a run. |
| F-RUN-10 | Two or more checks emit ERROR. | Complete the run, but set run\_quality \= DEGRADED and surface it at the top of the report. |

**Never-do list (binding):**

* F-NEVER-1 — Never infer a PASS from absence of a negative signal where positive evidence was required.

* F-NEVER-2 — Never substitute a rendered-DOM observation for a raw-HTML assertion, or vice versa.

* F-NEVER-3 — Never retry past the point where the remaining URL budget covers a complete attempt (R-FETCH-10); never lower net.min\_delay\_ms, raise a URL budget, or disable the unresponsive threshold to finish a check.

* F-NEVER-4 — Never circumvent bot protection, rate limits, paywalls, or authentication.

* F-NEVER-5 — Never report a third-party API’s absence of data as a site defect.

* F-NEVER-6 — Never emit a numeric score for a check whose status is NOT\_TESTABLE.

---

## **6\. Pipeline phases (execution order is binding)**

P0 Target intake & normalisation → gates everything

P1 Control-file acquisition → robots.txt, sitemap variant reachability (C-1.2), llms.txt

P2 Page discovery & sampling (Module A) → produces the 1–10 page set

P3 Per-page acquisition (RAW \+ RENDERED)

P4 Site-level checks (1.1, 1.2, 3.2, 5.1, 5.3, 5.4)

P5 Page-level checks (1.3–1.7, 2\.*, 3.1, 4.1, 5.2, 6\.*)

P6 Cross-page reconciliation (duplicate titles/H1s, canonical clusters, hreflang return links)

P7 Scoring, caveat attachment, report emission

## **R-PIPE-1 — P2 cannot start until P1 completes or emits a terminal status for robots.txt. R-PIPE-2 — P6 runs even if some P5 checks are NOT\_TESTABLE; it operates on whatever page set succeeded. R-PIPE-3 — Phase failure is contained to that phase unless listed in §5.**

# **MODULE A — Target Intake, Page Discovery & Sampling**

Implements the “Page Finding for Analysis (Min 1 to Max 10)” and “How to find” sections of the checklist. This module produces the page set every Section 2–6 check consumes. It is the highest-risk module in the tool: a wrong sample invalidates every downstream result.

## **A.0 — Target intake & normalisation**

### **RULES**

* R-A0-1 — Input is a single seed string. Accept with or without scheme, with or without www, with or without path.

* R-A0-2 — Resolution probe order (stop at first that returns a final 2xx after ≤ net.max\_redirect\_hops):

1. https://{host}/

2. https://www.{host}/ (only if input had no www)

3. http://{host}/

4. http://www.{host}/

* R-A0-3 — The final URL of the winning probe defines canonical\_origin \= scheme://host\[:port\]. All subsequent same-site tests compare against this.

* R-A0-4 — Record origin\_variants\[\]: for each of the four probes, {url, final\_url, status, hops}. This is evidence for C-1.4.

* R-A0-5 — “Same site” \= exact canonical\_origin host match. Subdomains are **different sites** (robots.txt, sitemaps and crawl scope are per host, protocol and port).

* R-A0-6 — Detect site\_shape from the homepage:

* single\_page — homepage contains zero same-origin  links whose normalised path differs from /, after excluding pure-fragment (\#…) and non-navigational schemes (mailto:, tel:, javascript:).

* multi\_page — otherwise.

* R-A0-7 — Detect is\_multilingual (drives C-3.2) if **any** of: ≥ 1 rel=“alternate” hreflang” in raw or rendered head; ≥ 1 Link: …rel=“alternate”; hreflang= header; ≥ 2 distinct

* values across sampled pages; ≥ 2 language-coded path prefixes (/xx/ or /xx-YY/) or ccTLD-style subdomains observed in discovery. Record which signal fired.

* R-A0-8 — Detect has\_ecommerce\_shape (informational only, never a FAIL input): presence of /product/, /shop/, /cart, Product JSON-LD, or a currency-bearing price pattern on ≥ 2 pages.

### **CONDITIONS**

| \# | Condition | Result |
| :---- | :---- | :---- |
| C-A0-a | Exactly one probe reaches a final 2xx | Proceed. canonical\_origin set. |
| C-A0-b | Multiple probes reach 2xx **without** redirecting to one another | Proceed using probe order precedence, and raise C-1.4 finding MULTIPLE\_LIVE\_ORIGINS (FAIL/HIGH) — the site is reachable at ≥ 2 canonical hosts without consolidation. |
| C-A0-c | All probes redirect into one final URL | Proceed. Record the consolidation as positive evidence for C-1.4. |
| C-A0-d | No probe reaches 2xx | F-RUN-1 / F-RUN-2. |

### **EXCEPTIONAL CONDITIONS**

* E-A0-1 — **Seed is a deep URL, not a root.** Audit that URL as homepage-equivalent for page-level checks, but still fetch control files from canonical\_origin. Set report flag SCOPE\_SUBPATH. Do not silently rewrite the seed to root.

* E-A0-2 — **Seed resolves to an IDN / punycode host.** Normalise to A-label (xn–…) for all comparisons; display the U-label. A mismatch between the two is not a finding.

* E-A0-3 — **Non-standard port in seed.** Preserve it. robots.txt scope is per port; do not fall back to :443.

* E-A0-4 — **Homepage is a geo/language selector splash with no content.** Still multi\_page. Mark homepage page\_type \= homepage, set flag HOMEPAGE\_IS\_SELECTOR, and require Module A to source service\_main/about etc. from behind the selector by following the selector’s locale links (B-A1-2 depth-2 crawl), then B-A1-3 path probing.

* E-A0-5 — **Site is behind a consent/cookie interstitial that blocks HTML.** If RAW HTML still contains the real document (interstitial is CSS/JS-only), proceed normally. If RAW contains only the interstitial, set CONSENT\_WALL\_RAW and treat every raw-HTML content check as NOT\_TESTABLE, not FAIL.

* E-A0-6 — **Homepage returns 200 but is a soft-404 / “coming soon” placeholder** (\< 50 words, no internal links, or matching a placeholder heuristic). Proceed but set SITE\_PLACEHOLDER; suppress Section 6 scoring (NOT\_APPLICABLE) because there is no content corpus to judge.

### **BACKUP PLANS**

* B-A0-1 — DNS fails on system resolver → retry via a second configured resolver before declaring F-RUN-1.

* B-A0-2 — HTTPS handshake fails (expired/invalid certificate) → retry once with certificate errors recorded but connection still refused. **Never** disable certificate verification. If HTTPS is unusable, fall to http:// and raise C-1.3 finding TLS\_INVALID (FAIL/CRITICAL).

* B-A0-3 — Homepage RENDERED fetch fails but RAW succeeds → proceed raw-only, set cap.render\_js to false **for this run**, and attach the JS caveat to all affected checks.

### **FAILING & STOPPING PLAN**

* F-A0-1 — No resolvable origin → ABORT (F-RUN-1/F-RUN-2). Zero further requests.

* F-A0-2 — canonical\_origin established but homepage body is empty (0 bytes) on both profiles across 3 attempts → ABORT / EMPTY\_HOMEPAGE.

* F-A0-3 — Never proceed to P2 with an unset canonical\_origin. That is an ERROR, not a NOT\_TESTABLE.

---

## **A.1 — Link harvesting**

Checklist rule 1: *“Open the homepage and grab every link on it.”* Checklist rule 2: *“Ignore the \# links (if website is a single page).”*

### **RULES**

* R-A1-1 — Harvest from the homepage: every  element **that has an** **href** **attribute**. Elements without href, and click handlers on non-anchor elements, are not links and must not be collected. (Google discovers links only from .)

* R-A1-2 — Harvest from **both** profiles when available. links\_raw \= from RAW. links\_rendered \= from RENDERED. Union is the working set; the set difference links\_rendered − links\_raw is recorded as js\_only\_links\[\] and is evidence for C-5.2 and C-1.7.

* R-A1-3 — Resolve each href against the document’s  if present, else against the document URL. Apply R-FETCH-9 normalisation.

* R-A1-4 — **Discard** (do not queue, do not count):

* Non-HTTP(S) schemes: mailto:, tel:, sms:, javascript:, data:, blob:, ftp:.

* Pure-fragment links (href=“\#…”) and href=““.

* Off-origin links (host ≠ canonical\_origin host) — retained in external\_links\[\] for reference only.

* R-A1-5 — **Fragment handling.** For every retained link, strip the fragment before queueing and dedupe on the fragment-less URL. Retain the original in evidence. Rationale: a fragment does not address a distinct document to a crawler, and hash-based routing is not reliably resolved by Googlebot.

* R-A1-6 — **Single-page sites.** When site\_shape \= single\_page, the checklist’s “ignore the \# links” applies literally: the page set is exactly \[homepage\], page\_count \= 1, and C-2.4 (Internal Links) becomes NOT\_APPLICABLE / SINGLE\_PAGE\_SITE. Discovery ends here.

* R-A1-7 — Record for every retained link: anchor text (trimmed, collapsed whitespace), rel tokens, whether it is inside

* /

* /

* (link\_zone \= nav | footer | body | aside), and target. Boilerplate-zone links are excluded from C-2.4 uniqueness maths.

* R-A1-8 — Cap harvesting at discovery.max\_links\_per\_page (default 500\) per page, taking document order. Record if the cap was hit.

### **CONDITIONS**

| \# | Condition | Result |
| :---- | :---- | :---- |
| C-A1-a | ≥ 1 retained same-origin link | Proceed to A.2. |
| C-A1-b | 0 retained same-origin links **and** site\_shape \= single\_page | Page set \= \[homepage\]. Proceed. Not a failure. |
| C-A1-c | 0 retained same-origin links in RAW but ≥ 1 in RENDERED | Proceed on rendered links. Raise C-5.2 finding NAV\_REQUIRES\_JS (FAIL/HIGH) and C-1.7 note: link graph is invisible without JavaScript. |
| C-A1-d | 0 retained same-origin links in both profiles but site is not single-page-shaped (e.g. NON\_ANCHOR\_NAVIGATION detected per E-A1-1) | Override site\_shape to multi\_page; fall to B-A1-1. |

### **EXCEPTIONAL CONDITIONS**

* E-A1-1 — **Navigation rendered entirely in** **/**\*\*

* \*\* **with JS routing.** Not links. Record NON\_ANCHOR\_NAVIGATION as a C-2.4/C-5.2 finding; discovery proceeds via the backup ladder from B-A1-1.

* E-A1-2 — **Infinite scroll / “Load more”.** Do not attempt to trigger. Harvest what is in the initial rendered DOM. Record PAGINATION\_REQUIRES\_INTERACTION.

* E-A1-3 — **Links inside** **.** Collect them; label link\_zone \= noscript. They count for discovery but are excluded from C-5.2’s “content available without JS” maths unless they carry real content.

* E-A1-4 — **Protocol-relative** **href=“//host/path”.** Resolve against the document scheme. Not a defect.

* E-A1-5 — **Same URL differing only by trailing slash or case.** Treat as distinct candidates at harvest time; resolve to one during A.2 grouping using observed redirect behaviour, not assumption.

* E-A1-6 — **rel=“nofollow”** **internal links.** Still harvested for discovery. Flagged in C-2.4 as a finding, never excluded from the sample.

### **BACKUP PLANS**

Ordered ladder when homepage harvesting yields an insufficient set (\< 3 same-origin URLs on a multi\_page site):

* B-A1-1 — **HTML sitemap page.** Probe /sitemap, /sitemap.html, /site-map, /sitemap-page. Harvest links from any that return 2xx.

* B-A1-2 — **Second-level crawl.** BFS from the homepage’s links to depth 2, capped at discovery.max\_fetches (default 60).

* B-A1-3 — **Common-path probing.** Probe a fixed list of conventional paths (/about, /about-us, /pricing, /plans, /blog, /news, /services, /products, /contact) with GET. Only 2xx responses are admitted. This is a last resort and every URL admitted this way is tagged discovery\_method \= PATH\_PROBE in the report.

* B-A1-4 — **Common Crawl URL list.** If cap.commoncrawl (discovery only — default true), query the CDX index for matchType=domain and take distinct URLs. Tagged discovery\_method \= COMMON\_CRAWL, confidence \= THIRD\_PARTY, caveat “URLs from a third-party crawl snapshot; may include removed pages.”

* B-A1-5 — If all ladders yield only the homepage, proceed with page\_count \= 1 and set DISCOVERY\_DEGRADED. Every section still runs on that one page.

### **FAILING & STOPPING PLAN**

* F-A1-1 — Homepage fetch itself fails on both profiles → ABORT (F-A0-2).

* F-A1-2 — Never fabricate a URL. B-A1-3 probes are the only tool-generated URLs, they must be verified 2xx before use, and they must be labelled.

* F-A1-3 — Never include off-origin URLs in the audit page set, even if the site’s real content lives there. Instead emit report note CONTENT\_ON\_EXTERNAL\_HOST with the host list.

* F-A1-4 — Discovery stops unconditionally at discovery.max\_fetches. Report DISCOVERY\_CAP\_REACHED with the count.

---

## **A.2 — robots.txt intersection**

Checklist rule 3: *“robots.txt — it lists folders, and find no selected URL is stopped by robots.txt rules.”*

### **RULES**

* R-A2-1 — Parse robots.txt per RFC 9309 \+ Google’s stated interpretation. Implementation requirements:

* Group selection: select the **single** group whose user-agent token is the most specific match for the evaluated agent. Groups are not merged across different tokens; multiple groups declaring the same token are merged into one.

* user-agent field name and value are **case-insensitive**; path values are **case-sensitive**.

* Longest matching path wins. On equal length, or on conflict including wildcards, the **least restrictive** rule wins (Allow beats Disallow).

* Wildcards: \* \= any sequence; \$ \= end-of-URL anchor.

* Only user-agent, allow, disallow, sitemap are supported directives. crawl-delay, host, noindex, clean-param are **unsupported by Google** — parse and report them as informational, never act on them as if Google honours them.

* Content beyond th.robots\_max\_bytes (500 KiB) is ignored, exactly as Google ignores it.

* Strip a leading UTF-8 BOM; ignore invalid lines rather than aborting the parse.

* R-A2-2 — Evaluate every candidate URL against **three** agent profiles and store all three verdicts:

* Googlebot

* 

  * (catch-all)

* net.user\_agent (the auditor)

* R-A2-3 — A candidate URL is **excluded from the audit page set** if it is Disallowed for Googlebot. It is instead recorded in robots\_blocked\_candidates\[\] and surfaced as a C-1.1/C-1.7 finding. This is the checklist’s literal requirement: no selected URL may be stopped by robots.txt.

* R-A2-4 — A candidate Disallowed only for net.user\_agent (not for Googlebot) is also excluded from fetching, but is reported distinctly as AUDITOR\_BLOCKED\_ONLY — a tool limitation, not a site defect.

* R-A2-5 — Collect every Sitemap: directive (any position in file, may appear multiple times). They are used only as candidate URLs for C-1.2 (R-1.2-2); sitemap contents are never read.

* R-A2-6 — Directory hints: derive the set of Disallow path prefixes as robots\_declared\_folders\[\]. These are used as *negative* grouping hints in A.3 and are reported, per the checklist’s “it lists folders.”

### **CONDITIONS**

| \# | Condition | Result |
| :---- | :---- | :---- |
| C-A2-a | robots.txt 2xx, parses, ≥ 1 valid group | Normal path. |
| C-A2-b | robots.txt 4xx (not 429\) | Treat as *no restrictions*, exactly as Google does. Proceed with full discovery. Record for C-1.1. |
| C-A2-c | robots.txt 5xx / 429 / network error | **Conservative mode** (F-RUN-8): crawling of page URLs is not performed. This mirrors Google pausing crawling. Control-file checks continue. |
| C-A2-d | robots.txt 2xx but body is HTML | C-1.1 \= FAIL/HIGH (ROBOTS\_IS\_HTML); treat as unparseable → same as C-A2-b for discovery (no restrictions), because no valid directives exist. |
| C-A2-e | robots.txt \> 500 KiB | Parse first 500 KiB only; C-1.1 \= WARN (ROBOTS\_OVERSIZE). |
| C-A2-f | robots.txt redirects ≤ 5 hops to another robots.txt | Follow and use. |
| C-A2-g | robots.txt redirects \> 5 hops | Treat as 404 per Google’s rule → C-A2-b behaviour, and C-1.1 \= WARN (ROBOTS\_REDIRECT\_CHAIN). |

### **EXCEPTIONAL CONDITIONS**

* E-A2-1 — **robots.txt served from a different host via redirect.** Google follows up to five hops; honour it, but record ROBOTS\_CROSS\_HOST because the rules then govern a host that does not serve them.

* E-A2-2 — **Disallow:** **with empty value** \= allow everything for that group. Must not be read as “disallow root.”

* E-A2-3 — **Allow:** **used without any** **Disallow:.** Valid, no-op. Not a defect.

* E-A2-4 — **Rules present for** **Googlebot** **but no** \*\*\*\*\* **group.** Non-Google agents (including the auditor) are unrestricted. Handle without inventing a catch-all.

* E-A2-5 — **Disallow: /*?*** **or query-blocking patterns.** Apply literally to candidates carrying query strings; do not strip queries to force a match.

* E-A2-6 — **Sitemap:** **pointing to a different host.** Passed to C-1.2 as a CROSS\_HOST candidate (R-1.2-2(a)). Its contents are never read and never feed discovery.

* E-A2-7 — **robots.txt present at** **www** **but not apex (or vice versa).** Rules are per host, protocol and port. Fetch and evaluate for canonical\_origin only; report the other variant’s state as context.

* E-A2-8 — **Site is a staging/dev host with** **Disallow: /.** Do not treat as a production defect if the operator flagged env \= staging; report as STAGING\_BLOCK\_EXPECTED.

### **BACKUP PLANS**

* B-A2-1 — robots.txt unreachable → retry per net.retries with backoff before concluding.

### **FAILING & STOPPING PLAN**

* F-A2-1 — Conservative mode (C-A2-c) never silently degrades into full crawling. Once entered, only an operator override (force\_crawl \= true) exits it, and the override is stamped on the report.

* F-A2-2 — Never fetch a URL disallowed for the auditor UA in order to “check what’s there,” except the control-file allow-list in R-FETCH-4.

* F-A2-3 — Never treat robots.txt noindex: (an unsupported directive) as an indexing control. Report it as ineffective.

---

## **A.3 — URL pattern grouping**

Checklist rule 4: *“Follow links for a while, and sort pages into groups by their URL pattern.”* /blog/how-to-fix-seo → /blog/\* · /blog/best-vpn-2026 → /blog/\* (same group) · /product/12345/red-shoe → /product/*/* (different group)

### **RULES**

* R-A3-1 — **Signature algorithm.** For each URL, produce pattern\_signature deterministically:

1. Take the normalised path; drop the leading and trailing /; split on / into segments.

2. Classify each segment:

* NUMERIC — matches ^\$

* UUID — matches RFC 4122 form

* HASH — [^1]{8,}\$ (case-insensitive)

* DATE — ^(19|20)$,o{r}^{\left({0?\left[{1-9}\right]|1\left[{0-2}\right]}\right)}$ / ^(0?\[1-9\]|\[12\]3\[01\])\$ **only when the preceding segment classified as a 4-digit year**

* LOCALE — matches [^2]{2}(-\[a-z\]{2})?\$ **and** is the first segment **and** the language subtag is a valid ISO 639-1 code

* SLUG — anything else

1. Replace NUMERIC, UUID, HASH, DATE with \*.

2. Replace a SLUG segment with \* **only if it is the final segment and the parent prefix has ≥** **group.slug\_collapse\_min** **(default 2\) distinct observed values.** Otherwise keep the literal.

3. Signature \= / \+ joined segments. Root \= /.

* R-A3-2 — Query strings are excluded from the signature but recorded. URLs identical except for query are the same group; a group where \> 60% of members carry queries is flagged QUERY\_DRIVEN\_GROUP for C-1.5/C-1.7 attention.

* R-A3-3 — File extensions are preserved in the signature (/blog/*.html ≠ /blog/*).

* R-A3-4 — LOCALE first segments are collapsed to \* **and** the group records locale\_variants\[\]. This prevents /en/pricing and /de/pricing from being sampled as two different templates — they are one template, and the language dimension is C-3.2’s job, not the sampler’s.

* R-A3-5 — Group metadata: signature, member\_count, members\[\] (capped at 50 stored, true count retained), depth, first\_seen\_at, example\_url, discovery\_methods\[\].

* R-A3-6 — **Group saturation cap.** Per checklist rule 5: *“Once you’ve seen 20 pages of a group, stop opening more of that group.”* Once member\_count ≥ group.saturation\_cap (default **20**) for a signature, the crawler must not *fetch* further members of that group. Additional members discovered by link extraction are still **counted** (cheap) but never fetched (expensive). Record saturated \= true and true\_member\_count.

* R-A3-7 — Groups with member\_count \= 1 are retained; a one-member group is a legitimate template (e.g. /pricing).

* R-A3-8 — Merge two signatures only when they are byte-identical. No fuzzy merging, no edit-distance heuristics — silent merging of /service/\* and /services/\* would destroy the sample.

### **CONDITIONS**

| \# | Condition | Result |
| :---- | :---- | :---- |
| C-A3-a | ≥ 2 distinct signatures | Normal grouping. |
| C-A3-b | Exactly 1 signature (/) | Site is effectively single-page → R-A1-6 path. |
| C-A3-c | \> group.max\_groups (default 200\) signatures | Keep the 200 with the highest member\_count, then by shallowest depth; record GROUP\_EXPLOSION — usually a symptom of faceted navigation, which is itself worth reporting under C-1.5/C-1.7. |
| C-A3-d | A single group holds \> 80% of all discovered URLs | Record GROUP\_DOMINANCE; still sample one page from every other group first (R-A4-3). |

### **EXCEPTIONAL CONDITIONS**

* E-A3-1 — **Flat architecture** (/how-to-fix-seo, /best-vpn-2026, /pricing all at root). Depth-1 slugs would each be their own group. Apply R-A3-1 step 4: once ≥ 2 distinct root-level slugs exist, collapse to /\* — but exempt any root slug that matches the page-type lexicon in R-A4-2 (/pricing, /about, /contact, …) so that named pages stay individually addressable.

* E-A3-2 — **Date-partitioned blogs** (/2026/09/post-title). Signature /*/*/\*. Correct and intended.

* E-A3-3 — **Locale-prefixed sites.** Handled by R-A3-4. /en-gb/pricing and /fr/pricing → /\*/pricing, one group, two locale variants.

* E-A3-4 — **Hybrid IDs in slugs** (/product/12345-red-shoe). Segment is SLUG, not NUMERIC — it does not match ^\$. Collapse only via step 4\. Do not invent a partial-numeric rule; it produces unstable signatures across sites.

* E-A3-5 — **Trailing-slash inconsistency.** Both forms observed for the same path → probe once; if one 301s to the other, keep the target only and record TRAILING\_SLASH\_REDIRECT (evidence for C-1.4). If both return 200, that is a duplicate-content finding for C-1.5, and the group keeps one member.

* E-A3-6 — **Case variants** (/Blog/Post and /blog/post both 200). Same treatment as E-A3-5; report under C-1.5.

* E-A3-7 — **Pagination** (/blog/page/2). DATE/NUMERIC rules make this /blog/page/*. Distinct from /blog/* and correctly so — paginated list pages are a different template from articles.

### **BACKUP PLANS**

* B-A3-1 — Still fewer than 3 groups → run B-A1-2 depth-2 crawl and re-group.

* B-A3-2 — Still insufficient → B-A1-3 path probing, then re-group. Path-probed URLs are grouped normally but retain their discovery\_method tag.

* B-A3-3 — If the signature algorithm produces a group count equal to the URL count (no collapsing at all, typical of hash-routed SPAs), fall back to **depth-based grouping**: group by segment count alone. Record GROUPING\_DEGRADED\_TO\_DEPTH and caveat the sample.

### **FAILING & STOPPING PLAN**

* F-A3-1 — Grouping is pure and deterministic: the same URL list must always yield the same signatures. Any randomness in grouping is an ERROR.

* F-A3-2 — Never exceed group.saturation\_cap fetches for one group. Exceeding it is a hard stop for that group, not a soft preference.

* F-A3-3 — Never merge groups to force the sample down to 10 pages. Selection (A.4) handles the cap; grouping stays faithful.

* F-A3-4 — If discovery.max\_fetches is reached mid-grouping, freeze the groups as they stand, mark DISCOVERY\_CAP\_REACHED, and proceed. Do not discard partial groups.

---

## **A.4 — Page selection (Min 1, Max 10\)**

Checklist rule 6: *“Pick one page from each group. Never pick two pages from the same group until you’ve covered all the groups. Two blog posts tell you the same thing.”*

### **RULES**

* R-A4-1 — Target slate, in priority order, from the checklist:

| Rank | page\_type | Notes |
| :---- | :---- | :---- |
| 1 | homepage | Always included when reachable. Never substituted. |
| 2 | service\_main |  |
| 3 | service\_secondary | Must be a **different group** from service\_main where one exists; else a different member of the same group (this is the one sanctioned same-group second pick, and only after R-A4-3 is satisfied). |
| 4 | product\_main |  |
| 5 | pricing |  |
| 6 | category | List/hub template. |
| 7 | blog\_article |  |
| 8 | blog\_template\_alt | A *different article template* — e.g. /news/\* vs /blog/\*, or a different post layout. Not simply a second post. |
| 9 | author |  |
| 10 | about |  |

* R-A4-2 — **Page-type classification** is evidence-ranked. A candidate is assigned the highest-ranked type it qualifies for; each type is assigned at most once.

| page\_type | Signals (any two of tier-1, or one tier-1 \+ one tier-2, qualifies) |
| :---- | :---- |
| homepage | tier-1: URL path \= /. |
| pricing | tier-1: path contains pricing/plans/packages/subscribe; Offer/PriceSpecification JSON-LD; ≥ 3 currency-formatted prices in a repeating block. tier-2: title/H1 contains a pricing lexeme. |
| about | tier-1: path contains about/about-us/who-we-are/company/our-story/brand-story; AboutPage JSON-LD. tier-2: H1 matches ^(about |
| author | tier-1: path contains /author///authors///team///people///contributor; ProfilePage or standalone Person JSON-LD as mainEntity. tier-2: page lists ≥ 3 links to articles by one named person. |
| blog\_article | tier-1: Article/BlogPosting/NewsArticle JSON-LD; og:type \= article; path under a /blog/, /news/, /insights/, /resources/, /articles/ prefix with a slug leaf. tier-2: visible publish date \+ author byline. |
| category | tier-1: page contains ≥ 8 links whose targets share one pattern\_signature; CollectionPage/ItemList JSON-LD. tier-2: path is the parent prefix of a saturated group; pagination controls present. |
| product\_main | tier-1: Product JSON-LD with offers; path contains /product///item///p/; add-to-cart control present. tier-2: SKU/variant selector. |
| service\_main / service\_secondary | tier-1: path contains /service//solutions//what-we-do//features//platform//use-cases; Service JSON-LD. tier-2: linked from primary nav with a service-lexicon anchor. Rank the qualifying candidates by nav position; first \= service\_main, second \= service\_secondary. |
| blog\_template\_alt | Assigned to a blog\_article-qualifying page whose pattern\_signature differs from the one already chosen for blog\_article. |
| other | Qualifies for none of the above. |

* R-A4-3 — **Coverage-first selection (binding order):**

1. Add homepage.

2. Iterate groups in descending member\_count, then ascending depth. From each group take **one** best-scoring candidate, assigning it the highest-ranked unfilled page\_type it qualifies for. **No group may contribute a second page until every group has contributed one, or until the 10-page cap is reached.**

3. If, after step 2, slots remain unfilled and every group has contributed once, allow a second pick from the largest groups, still assigning unfilled types.

4. Stop at 10 pages. Never exceed 10; never go below 1\.

* R-A4-4 — **Within-group candidate scoring** (choose the group’s representative): \+3 shallowest depth; \+2 reachable from homepage in one click; \+2 has Article/Product/Service/Offer JSON-LD; \+1 longest visible text; −5 blocked by robots for Googlebot (never selectable); −4 non-2xx final status; −3 noindex in raw HTML; −2 canonicalised to another URL. Ties broken by lexicographically smallest normalised URL — deterministic, not random.

* R-A4-5 — Candidates that are (a) robots-disallowed for Googlebot, (b) non-2xx, or (c) off-origin are **never** selected. They are reported in their own arrays.

* R-A4-6 — A noindex or cross-canonicalised page **may** be selected if it is the only representative of its group; the selection is flagged SAMPLE\_INCLUDES\_NONINDEXABLE so Section 2/6 results are read in that light.

* R-A4-7 — Each selected page records: url, page\_type, pattern\_signature, group\_member\_count, selection\_reason, discovery\_method, score\_breakdown. The sample must be fully auditable after the fact.

* R-A4-8 — Unfilled page\_type slots are reported as page\_type\_absent\[\] with the reason (NO\_QUALIFYING\_CANDIDATE vs CAP\_REACHED). An absent type is **not** a site failure by itself — a B2B SaaS site legitimately has no product\_main or author.

### **CONDITIONS**

| \# | Condition | Result |
| :---- | :---- | :---- |
| C-A4-a | 10 pages selected, ≥ 6 distinct page\_types | sample\_quality \= FULL. |
| C-A4-b | 4–9 pages selected | sample\_quality \= PARTIAL. All checks run; report states the sample size. |
| C-A4-c | 2–3 pages selected | sample\_quality \= MINIMAL. Cross-page checks (C-2.1 duplicate titles, C-2.3 duplicate H1s, C-1.5 canonical clusters) carry caveat “Computed over N pages; not representative of the full site.” |
| C-A4-d | 1 page (homepage only) | sample\_quality \= SINGLE. Cross-page checks → NOT\_APPLICABLE / INSUFFICIENT\_SAMPLE. |
| C-A4-e | 0 pages selectable | ABORT / NO\_SELECTABLE\_PAGES — homepage itself was excluded by R-A4-5, which means the site is unauditable. |

### **EXCEPTIONAL CONDITIONS**

* E-A4-1 — **Fewer than 10 groups exist.** Correct and common. Select one per group; do not pad the sample with second picks from the same group merely to reach 10 unless step 3 conditions are met.

* E-A4-2 — **A page qualifies for two types** (e.g. /pricing also carries Product JSON-LD). Assign the higher-ranked unfilled type; record alt\_types\[\]. Never occupy two slots with one URL.

* E-A4-3 — **The homepage is also the only service/pricing page** (one-page marketing site with anchors). site\_shape \= single\_page → R-A1-6. Report page\_type as homepage with alt\_types \= \[service\_main, pricing, about\] where content sections were detected.

* E-A4-4 — **Blog exists but every article is in one group.** blog\_template\_alt stays unfilled with NO\_QUALIFYING\_CANDIDATE. Do **not** substitute a second /blog/\* post — the checklist is explicit that two blog posts tell you the same thing.

* E-A4-5 — **E-commerce site with 50k products.** /product/*/* saturates at 20; one representative is selected. true\_member\_count is reported so the reader knows the group’s real weight.

* E-A4-6 — **A selected page 404s or 5xxs at P3 fetch time** (discovered state changed). Drop it, promote the next-best candidate from the same group, and record SELECTION\_REPLACED. If no replacement exists, leave the slot unfilled.

* E-A4-7 — **Locale variants of the same template.** One representative only (R-A3-4). If the operator supplies target\_locale, prefer that variant; otherwise prefer the x-default target, then the shortest path.

* E-A4-8 — **Login-gated pages** (/dashboard, /account). Excluded from selection; they are not public retrieval surfaces. Record GATED\_EXCLUDED.

* E-A4-9 — **Operator supplies explicit URLs.** They are honoured verbatim, bypass scoring, still get classified, and still obey the 10-page cap. Tagged discovery\_method \= OPERATOR\_SUPPLIED.

### **BACKUP PLANS**

* B-A4-1 — A page\_type has no qualifying candidate → attempt a targeted path probe for that type only (/pricing, /about, /blog, /authors…). 2xx admits it; tagged PATH\_PROBE.

* B-A4-2 — Still absent → leave unfilled with NO\_QUALIFYING\_CANDIDATE. **Never** substitute an unrelated page into the slot; a mislabelled sample is worse than a short one.

* B-A4-3 — All groups saturated before 10 types are filled → proceed with what exists; the cap protected the crawl budget as designed.

### **FAILING & STOPPING PLAN**

* F-A4-1 — Selection is deterministic. Same discovery input ⇒ byte-identical sample. Any nondeterminism is an ERROR.

* F-A4-2 — Hard stop at 10 pages. An 11th page is an ERROR, not a WARN.

* F-A4-3 — Never select a Googlebot-disallowed URL (R-A4-5). If the homepage itself is disallowed for Googlebot, that is a CRITICAL finding on C-1.1/C-1.7 and the run continues in control-file-only mode.

* F-A4-4 — Never label a page with a page\_type it did not qualify for under R-A4-2. Unclassifiable pages are other.

* F-A4-5 — If P3 acquisition fails for \> 50% of selected pages, set run\_quality \= DEGRADED and caveat every page-level section; do not abort — partial evidence is still evidence.

---

# **SECTION 1 — CRAWL & INDEXING**

---

## **C-1.1 — robots.txt**

**Scope:** site · **Profile:** RAW · **Depends on:** A.2

### **RULES**

* R-1.1-1 — Fetch {canonical\_origin}/robots.txt exactly once, no\_cache. Record status, Content-Type, byte length, encoding, full redirect chain.

* R-1.1-2 — Parse per R-A2-1. Emit a structured parse tree: groups → {agents\[\], rules\[{type, path, line\_no}\], unsupported\_directives\[\]}, plus file-level sitemaps\[\] and comments\[\].

* R-1.1-3 — Validate syntax per line. Classify each line: VALID, IGNORED\_UNKNOWN\_FIELD, IGNORED\_MALFORMED, UNSUPPORTED\_BY\_GOOGLE.

* R-1.1-4 — Compute a verdict matrix: for each of Googlebot, Googlebot-Image, \*, and every AI agent token in the C-5.1 registry, whether / is allowed, and the count of Disallow rules affecting it.

* R-1.1-5 — Verify that no URL in the final audit page set is Disallowed for Googlebot (R-A2-3). Any that are constitute evidence here.

* R-1.1-6 — Detect and report directives Google does **not** support, because their presence usually means the owner believes they are working: Crawl-delay, Noindex:, Nofollow:, Host:, Clean-param:, Request-rate, Visit-time.

* R-1.1-7 — Detect Content-Signal: lines (Content Signals Policy: search, ai-input, ai-train, each yes/no). Parse and report them; they are a declaration of intent, not a crawl directive. Feed to C-5.1.

* R-1.1-8 — Confirm the file is served over the same scheme/host/port as canonical\_origin. robots.txt governs only the host, protocol and port that serves it.

### **CONDITIONS**

Evaluated top-down; first match wins.

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-1.1-a | Status 2xx, Content-Type text/plain (or text/\*), parses, and / is allowed for Googlebot | PASS | — | — |
| C-1.1-b | Disallow: / applies to Googlebot (or to \* with no Googlebot group) | FAIL | CRITICAL | ROBOTS\_BLOCKS\_GOOGLEBOT\_SITEWIDE |
| C-1.1-c | ≥ 1 URL in the audit page set is disallowed for Googlebot | FAIL | HIGH | ROBOTS\_BLOCKS\_AUDITED\_URL |
| C-1.1-d | 5xx / 429 / network error after retries | FAIL | CRITICAL | ROBOTS\_UNAVAILABLE — Google pauses crawling for \~12 h and falls back to a cached copy for up to 30 days; an unavailable robots.txt is a crawl-blocking condition, not a neutral one |
| C-1.1-e | 2xx but Content-Type is text/html or the body contains \<html | FAIL | HIGH | ROBOTS\_IS\_HTML |
| C-1.1-f | 404 / 410 / other 4xx (not 429\) | PASS | — | ROBOTS\_ABSENT\_TREATED\_AS\_ALLOW\_ALL — valid state; Google treats it as no restrictions. Emit an advisory note recommending an explicit robots.txt file. |
| C-1.1-g | Redirect chain \> th.robots\_max\_redirect\_hops (5) | WARN | MEDIUM | ROBOTS\_REDIRECT\_CHAIN |
| C-1.1-h | Body \> th.robots\_max\_bytes (500 KiB) | WARN | MEDIUM | ROBOTS\_OVERSIZE |
| C-1.1-i | ≥ 1 IGNORED\_MALFORMED line | WARN | MEDIUM | ROBOTS\_MALFORMED\_LINES |
| C-1.1-j | ≥ 1 UNSUPPORTED\_BY\_GOOGLE directive | WARN | LOW | ROBOTS\_UNSUPPORTED\_DIRECTIVE |
| C-1.1-k | Parses, allows /, but contains a Disallow matching a JS/CSS asset path referenced by sampled pages | WARN | HIGH | ROBOTS\_BLOCKS\_RENDER\_RESOURCES |

A run may emit several WARNs alongside a PASS-eligible state: the top-level status is the most severe matched row, and all matched rows are reported as sub-findings.

### **EXCEPTIONAL CONDITIONS**

* E-1.1-1 — **Disallow: /** **under a group that is not the effective group for Googlebot** (e.g. User-agent: AhrefsBot / Disallow: /). Not a Googlebot block. Must not trigger C-1.1-b. Group selection correctness is the whole point of R-A2-1.

* E-1.1-2 — **Disallow: /** **present** ***and*** **a longer** **Allow:** **for the same agent** (e.g. Disallow: / \+ Allow: /\$ \+ Allow: /blog/). Longest-match and least-restrictive resolution applies per path; do not shortcut to “site blocked.”

* E-1.1-3 — **BOM at file start.** Strip, then parse. Not a defect.

* E-1.1-4 — **CRLF, CR, or LF line endings.** All three are valid.

* E-1.1-5 — **Multiple groups declaring the same user-agent token.** Merge them into one group (Google’s documented behaviour). Not a defect.

* E-1.1-6 — **User-agent:** \* **appearing after a specific group.** Order is irrelevant to group selection; specificity decides.

* E-1.1-7 — **Non-UTF-8 bytes.** Google may ignore them. Decode with replacement, flag ROBOTS\_ENCODING, continue parsing.

* E-1.1-8 — **Empty file (0 bytes), 2xx.** Valid: no rules, everything allowed. PASS with note ROBOTS\_EMPTY.

* E-1.1-9 — **Comment-only file.** Same as E-1.1-8.

* E-1.1-10 — **robots.txt at apex differs from** **www.** Only the canonical\_origin file is authoritative for this audit. Report the other as context, never as a conflict FAIL.

* E-1.1-11 — **Path case.** Disallow: /Admin does not block /admin. Paths are case-sensitive; do not case-fold when matching.

* E-1.1-12 — **Staging/dev environment.** With env \= staging, C-1.1-b downgrades to WARN / STAGING\_BLOCK\_EXPECTED.

### **BACKUP PLANS**

* B-1.1-1 — Transient failure → net.retries with backoff.

* B-1.1-2 — Timeout on HTTPS → retry once on HTTP for the same host; if it succeeds, report ROBOTS\_HTTP\_ONLY (the HTTPS origin still has no usable robots.txt — do not treat the HTTP file as governing HTTPS).

* B-1.1-3 — Unparseable body → tolerant line-scan extracting Sitemap: and Disallow: by regex, purely to feed discovery (Disallow:) and C-1.2 sitemap location (Sitemap:). The check itself still reports the parse failure; the tolerant result never upgrades the status.

* B-1.1-4 — Whole check errors → NOT\_TESTABLE / ROBOTS\_CHECK\_ERROR; run continues in conservative mode (F-RUN-8).

### **FAILING & STOPPING PLAN**

* F-1.1-1 — C-1.1-b or C-1.1-d triggers F-RUN-6 / F-RUN-8: page-crawl phase halts, control-file checks continue, everything else NOT\_TESTABLE.

* F-1.1-2 — Never fetch robots.txt more than 3 times per run (1 \+ 2 retries).

* F-1.1-3 — Never treat a 404 as a failure. This is the single most common false positive in audit tooling.

* F-1.1-4 — Never evaluate rules for the wrong agent group. If group selection is ambiguous in implementation, that is an ERROR, not a guess.

* F-1.1-5 — Never recommend removing Disallow rules the tool has not evaluated a target for; recommendations must cite the specific blocked URL from the page set.

---

## **C-1.2 — XML Sitemap: Variant Reachability**

**Scope:** site · **Profile:** RAW · **Depends on:** A.0 (canonical\_origin, origin\_variants\[\]), A.2 (Sitemap: lines, R-A2-5)

**What this check answers — and nothing else.** Does a candidate sitemap URL return **HTTP 200** on every protocol × host variant of the domain — http:// apex, http://www, https:// apex, https://www? A variant counts as OPEN when, after following redirects, the final status is exactly 200\. The response body is never read, parsed or classified, and sitemap contents are not used anywhere in the audit.

### **RULES**

* **R-1.2-1 — Variant set.** Take the canonical\_origin host H (A-label, E-A0-2). Derive bare\_host \= H with one leading www. removed, and www\_host \= www. \+ bare\_host. Compute the registrable domain (eTLD+1) of bare\_host with the Public Suffix List.

* variant\_scope \= **apex\_www** when bare\_host equals its registrable domain. Variant set, in test order: https://{bare\_host}, https://{www\_host}, http://{bare\_host}, http://{www\_host}.

* variant\_scope \= **host\_only** when bare\_host is a subdomain (e.g. blog.example.com). Variant set: https://{H}, http://{H}. The www variants are NOT\_APPLICABLE — subdomains are separate sites (R-A0-5).

* variant\_scope \= **canonical\_only** when canonical\_origin carries a non-default port (E-A0-3). Variant set: canonical\_origin only; all other variants NOT\_APPLICABLE.

* Default ports only (:80 for http, :443 for https). Each candidate path is requested exactly as defined in R-1.2-2, never with an appended or stripped trailing slash.

* **R-1.2-2 — Candidate sitemap URLs.** The candidate set is the union of two sources, both always evaluated. Source (b) runs whether or not source (a) produced a reachable URL.

* **(a) Declared.** Every Sitemap: value collected from the canonical robots.txt (R-A2-5), in file order, de-duplicated after R-FETCH-9 normalisation, capped at sitemap.max\_paths (default 5). Classify each:

  * **SAME\_DOMAIN** — absolute http(s) URL whose host is in the variant set (bare\_host / www\_host, or H for host\_only). Requested **exactly as written** — this is the URL a search engine reads from robots.txt — and then expanded into the variant matrix.

  * **CROSS\_HOST** — absolute http(s) URL on any other host. Gets a single cell as written; never expanded into a variant matrix, because its variants belong to another host.

  * **INVALID** — not an absolute http(s) URL (relative path, missing scheme, other scheme). Recorded verbatim as evidence; never fetched; never resolved into a guessed absolute URL.

* **(b) Fixed paths.** The two paths /sitemap.xml and /sitemap\_index.xml, on canonical\_origin. Both are always tested. No other path is probed.

* **R-1.2-3 — Candidate outcome and the located set.** A candidate URL is **REACHABLE** when at least one of its variant cells is OPEN. located\_sitemaps\[\] \= every REACHABLE candidate. A fixed path from R-1.2-2(b) that is REACHABLE on no variant is simply absent — **this is the normal case and is never itself a finding**, because a site publishes one sitemap entry point, not both. Only the conditions in the CONDITIONS table set status.

* **R-1.2-4 — Variant matrix.** For every candidate URL (SAME\_DOMAIN declared entries and the two fixed paths) × every origin in the variant set, issue one GET {variant\_origin}{path} with the RAW profile and follow redirects up to net.max\_redirect\_hops (10) with loop detection per R-1.4-4. A response already obtained for the same URL is reused (R-FETCH-5), not re-requested. Use GET, never HEAD (R-FETCH-6), for consistency with global fetch policy; the body is discarded unread.

* **R-1.2-5 — Plain-HTTP requests are real.** http:// variants are sent over plain HTTP to port 80\. The client must not apply HSTS, HSTS-preload lists, or any automatic HTTPS upgrade. The recorded result is what the server itself returns to an http:// request.

* **R-1.2-6 — OPEN definition.** A cell is **OPEN** when, and only when, the final status after following redirects is exactly **200**. Redirect hops before the final 200 are allowed, are recorded, and do not affect the verdict. The final URL may be on any host. No other property of the response — body, Content-Type, Content-Length, encoding — is examined or may influence the verdict.

* **R-1.2-7 — Cell outcome.** Every cell records verdict ∈ {OPEN, NOT\_OPEN, INCONCLUSIVE} and, when not OPEN, exactly one variant\_failure from this closed enum:

| variant\_failure | Observation (after the B-1.2-\* ladder) | Verdict |
| :---- | :---- | :---- |
| DNS\_UNRESOLVED | NXDOMAIN (or no A/AAAA record) on both configured resolvers | NOT\_OPEN |
| CONNECTION\_REFUSED | TCP connection actively refused on the scheme’s port | NOT\_OPEN |
| CONNECT\_TIMEOUT\_HOST\_UP | Connect timeout on every attempt, **and** the same host answered on the other scheme during this run | NOT\_OPEN |
| TLS\_INVALID | Certificate expired / not yet valid / hostname mismatch / incomplete chain on the initial request or any https hop | NOT\_OPEN |
| HTTP\_4XX | Final status 4xx other than 429 and 451 | NOT\_OPEN |
| HTTP\_5XX | Final status 5xx after retries | NOT\_OPEN |
| NON\_200\_SUCCESS | Final status 2xx other than 200 (e.g. 204) | NOT\_OPEN |
| HTTP\_3XX\_UNRESOLVED | Redirect chain ends on a 3xx without reaching a final status | NOT\_OPEN |
| REDIRECT\_LOOP | Loop detected (R-1.4-4) | NOT\_OPEN |
| REDIRECT\_HOPS\_EXCEEDED | More than 10 hops | NOT\_OPEN |
| MALFORMED\_REDIRECT | 3xx without a usable Location (E-1.4-9, B-1.4-1) | NOT\_OPEN |
| CONNECT\_TIMEOUT | Connect timeout on every attempt, with no evidence the host is up | INCONCLUSIVE |
| READ\_TIMEOUT | Connected, no complete response within the retry ladder | INCONCLUSIVE |
| DNS\_ERROR | SERVFAIL or resolver timeout (not NXDOMAIN) | INCONCLUSIVE |
| RATE\_LIMITED | 429 after Retry-After honoured once | INCONCLUSIVE |
| BOT\_PROTECTION | JS challenge / CAPTCHA interstitial (counts toward F-RUN-5) | INCONCLUSIVE |
| GEO\_RESTRICTED | 451 | INCONCLUSIVE |
| AUTH\_DENIED | 401/403 on any candidate request (see E-1.2-8) | INCONCLUSIVE |
| CAP\_REACHED | Request budget exhausted before the cell was tested (F-1.2-1) | INCONCLUSIVE |

* **R-1.2-8 — Cross-references only.** Record per cell: hop\_count, whether an http:// request received a 200 with no upgrade to https://, and the set of distinct final URLs across the matrix. These may be cited in cross\_references for C-1.3 (NO\_HTTPS\_REDIRECT) and C-1.4 (REDIRECT\_CHAIN, MULTIPLE\_LIVE\_ORIGINS). They never change the C-1.2 status.

* **R-1.2-9 — Request budget.** At most sitemap.max\_requests (default 24\) HTTP requests for this check, counting every redirect hop and every retry. Spend order: declared SAME\_DOMAIN entries → fixed paths → remaining matrix cells (candidates in R-1.2-2 order, variants in R-1.2-1 order) → CROSS\_HOST cells.

### **CONDITIONS**

Every matching row is reported as a sub-finding. The top-level status is set by the **first** matching status-bearing row in table order; C-1.2-h is a note and never sets the top-level status.

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-1.2-b | No sitemap located: no SAME\_DOMAIN declared entry is OPEN on any variant, neither fixed path is OPEN on any variant, no CROSS\_HOST entry is OPEN, and **no** cell is INCONCLUSIVE | FAIL | HIGH | NO\_SITEMAP\_FOUND |
| C-1.2-c | ≥ 1 SAME\_DOMAIN URL declared in robots.txt returns no 200 on any variant | FAIL | HIGH | SITEMAP\_UNREACHABLE — the URL the site advertises to crawlers does not return 200 |
| C-1.2-d | ≥ 1 REACHABLE candidate has ≥ 1 variant cell that is NOT\_OPEN | FAIL | MEDIUM | SITEMAP\_VARIANT\_NOT\_OPEN — evidence names every failing variant with its variant\_failure |
| C-1.2-e | No SAME\_DOMAIN sitemap located, but a CROSS\_HOST declared sitemap is OPEN | WARN | MEDIUM | SITEMAP\_CROSS\_HOST — the domain itself returns no 200 sitemap URL on any variant; cross-host submission is valid only when both hosts are verified in the same Search Console account, which the tool cannot confirm |
| C-1.2-f | ≥ 1 REACHABLE candidate, no variant cell NOT\_OPEN, ≥ 1 cell INCONCLUSIVE | NOT\_TESTABLE | — | SITEMAP\_VARIANT\_INCONCLUSIVE |
| C-1.2-g | No sitemap located, and ≥ 1 cell is INCONCLUSIVE | NOT\_TESTABLE | — | SITEMAP\_LOCATE\_INCONCLUSIVE |
| C-1.2-h | ≥ 1 Sitemap: value classified INVALID | Note only — does not affect status | — | SITEMAP\_DECLARATION\_INVALID |
| C-1.2-a | ≥ 1 REACHABLE candidate, and every cell of every REACHABLE candidate is OPEN (or NOT\_APPLICABLE by variant\_scope) | PASS | — | — |

### **EXCEPTIONAL CONDITIONS**

* **E-1.2-1 — Variants that 301/308 to the canonical sitemap.** http://example.com/sitemap.xml → 301 → https://www.example.com/sitemap.xml → 200 is OPEN. This is the expected healthy pattern, not a defect.

* **E-1.2-2 — A variant redirects to a different sitemap path** (e.g. /sitemap.xml → /sitemap\_index.xml, or WordPress core → /wp-sitemap.xml). OPEN if the final status is 200\. Record final\_path\_differs \= true. No comparison is made between the requested path and the final path.

* **E-1.2-3 — Only one of the two fixed paths exists.** Normal and expected: a Yoast site answers /sitemap\_index.xml and 404s /sitemap.xml; a site with a single flat sitemap does the reverse. The absent path is recorded as NOT\_OPEN at cell level but contributes no finding — C-1.2-b fires only when **no** candidate is reachable anywhere (R-1.2-3).

* **E-1.2-4 — robots.txt disallows the sitemap path.** Irrelevant here: every C-1.2 URL is a control file exempt under R-FETCH-4. Not a finding.

* **E-1.2-5 — X-Robots-Tag: noindex on the sitemap.** Harmless and common. Never a finding.

* **E-1.2-6 — A 200 response that is not a sitemap** (soft-404 serving the homepage, a 404 template returning 200, an HTML page at the sitemap path). **OPEN.** This check tests reachability only; the tool must not infer, warn about, or flag this state.

* **E-1.2-7 — Variant host has no DNS record** (apex-only or www-only domains that never configured the other name). NOT\_OPEN / DNS\_UNRESOLVED, as the check’s contract requires. The finding text must state that the fix is at DNS/origin level (create the record and 301 it to the canonical host) and must cross-reference C-1.4, where the same root cause shows in origin\_variants\[\].

* **E-1.2-8 — 401/403.** A 401/403 cannot distinguish “no sitemap” from “sitemap exists but the auditor UA is filtered” → INCONCLUSIVE / AUTH\_DENIED, so NO\_SITEMAP\_FOUND is never emitted on 401/403 evidence. Never switch UA to test further (R-FETCH-7).

* **E-1.2-9 — http:// variant returns 200 and never upgrades to https://.** OPEN for C-1.2. The missing upgrade is passed to C-1.3 (NO\_HTTPS\_REDIRECT) as a cross-reference only (R-1.2-8).

* **E-1.2-10 — Variant ends on a 200 on another host** (e.g. a CDN or storage bucket). OPEN under this check’s definition; record final\_off\_domain \= true and the final host so a reviewer can see it.

* **E-1.2-11 — Several sitemaps declared without an index** (e.g. separate post, page and product sitemaps). Each SAME\_DOMAIN entry is a candidate and is matrix-tested independently, up to sitemap.max\_paths; results are reported per candidate.

* **E-1.2-12 — Subdomain or non-default-port target.** Variant set reduced per R-1.2-1; the excluded variants are NOT\_APPLICABLE, never NOT\_OPEN.

### **BACKUP PLANS**

* **B-1.2-1** — Transient error in net.retry\_on → full net.retries ladder with backoff before any cell verdict.

* **B-1.2-2** — NXDOMAIN on the system resolver → retry on the second configured resolver (B-A0-1) before DNS\_UNRESOLVED.

* **B-1.2-3** — TLS handshake failure → one retry per B-A0-2. Never disable certificate verification. Still failing → TLS\_INVALID.

* **B-1.2-4** — Read timeout → one further attempt if the cell’s secondary budget covers it (R-FETCH-10), then READ\_TIMEOUT.

* **B-1.2-5** — 429 → honour Retry-After once (R-1.3-7), then RATE\_LIMITED.

* **B-1.2-6** — robots.txt unavailable or unparseable (C-A2-c, C-A2-d) → the declared source contributes whatever Sitemap: lines the tolerant scan recovered (B-1.1-3), or nothing; the two fixed paths are tested regardless. C-1.2 still runs in conservative mode (F-RUN-8) because its URLs are control files.

### **FAILING & STOPPING PLAN**

* **F-1.2-1** — Hard stop at sitemap.max\_requests. Cells not yet tested become INCONCLUSIVE / CAP\_REACHED. Never raise the budget to finish.

* **F-1.2-2** — Never emit NO\_SITEMAP\_FOUND while any cell is INCONCLUSIVE. Any INCONCLUSIVE cell forces C-1.2-g instead.

* **F-1.2-3** — Never read, buffer, decode, inflate or classify a response body in this check. The status line is the whole evidence.

* **F-1.2-4** — Never upgrade http:// to https:// client-side, and never apply HSTS (R-1.2-5).

* **F-1.2-5** — Never request a sitemap URL other than the declared SAME\_DOMAIN / CROSS\_HOST entries and the two fixed paths /sitemap.xml and /sitemap\_index.xml, and never construct an absolute URL from an INVALID declaration.

* **F-1.2-6** — Never change the C-1.2 status because of redirect count, an http:// 200 without upgrade, non-converging final URLs, or the content of any response.

* **F-1.2-7** — Never treat INCONCLUSIVE as NOT\_OPEN or as OPEN.

* **F-1.2-8** — Never emit a finding because only one of the two fixed paths answered (E-1.2-3).

---

## **C-1.3 — HTTP Status Codes**

**Scope:** page (all sampled) \+ site · **Profile:** RAW

### **RULES**

* R-1.3-1 — For every sampled URL record: initial\_status, final\_status, hop\_count, per-hop {url, status, location}, Content-Type, Content-Length, response byte size, and total time.

* R-1.3-2 — Probe the origin’s error handling with a URL guaranteed not to exist: {canonical\_origin}/{random-32-hex}-audit-404-probe. Record its status. A 2xx here is a soft-404 configuration.

* R-1.3-3 — Soft-404 detection on any 2xx page: flag when **two or more** of — visible text \< 50 words; title or H1 matches /(404|not found|page not found|error|no results)/i; body matches a not-found lexicon; page is byte-identical to the R-1.3-2 probe response.

* R-1.3-4 — Record Content-Length (or measured size) against th.googlebot\_bytes\_supported\_type (2 MB). Note the documentation split: Googlebot’s page documents 2 MB per supported file type and 64 MB for PDFs, while the crawler-overview page documents a 15 MB default across Google’s crawlers and fetchers. Report both reference points; do not present either as the sole authority.

* R-1.3-5 — Validate TLS: certificate validity window, hostname match, chain completeness. Record protocol version.

* R-1.3-6 — Record security/caching headers present: Strict-Transport-Security, X-Robots-Tag, Cache-Control, Vary, Link, Content-Encoding.

* R-1.3-7 — Detect Retry-After on 429/503 and honour it once (F-RUN-4), and only when the wait plus a further attempt fits inside the URL budget. A Retry-After longer than the remaining budget is recorded and not waited on.

* R-1.3-8 — **Timing.** Record elapsed\_ms and stall\_stage for every attempt and for the URL as a whole, together with the budget class applied (R-FETCH-10). Timing is evidence in its own right and is reported whether or not a threshold was crossed.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-1.3-a | Final status 200, ≤ 1 hop, valid TLS, size \< 2 MB | PASS | — | — |
| C-1.3-b | Final status 5xx | FAIL | CRITICAL | SERVER\_ERROR |
| C-1.3-c | Final status 4xx (not 404/410 for a URL that was expected to exist) | FAIL | HIGH | CLIENT\_ERROR |
| C-1.3-d | Sampled URL returns 404/410 | FAIL | HIGH | PAGE\_NOT\_FOUND — a URL discovered on-site should not 404 |
| C-1.3-e | 404-probe returns 2xx | FAIL | HIGH | SOFT\_404\_HANDLING |
| C-1.3-f | 2xx page matches R-1.3-3 soft-404 heuristic | FAIL | HIGH | SOFT\_404\_PAGE |
| C-1.3-g | Final status 401/403 | FAIL | HIGH | ACCESS\_RESTRICTED |
| C-1.3-h | 429 after Retry-After honoured | NOT\_TESTABLE | — | RATE\_LIMITED |
| C-1.3-i | TLS certificate invalid, expired, or hostname mismatch | FAIL | CRITICAL | TLS\_INVALID |
| C-1.3-j | Page reachable on http:// and does not redirect to https:// | FAIL | HIGH | NO\_HTTPS\_REDIRECT |
| C-1.3-k | Response size \> 2 MB | WARN | MEDIUM | RESPONSE\_EXCEEDS\_2MB |
| C-1.3-l | Response size \> 15 MB | FAIL | HIGH | RESPONSE\_EXCEEDS\_15MB |
| C-1.3-m | 200 with Content-Length: 0 or empty body | FAIL | HIGH | EMPTY\_RESPONSE |
| C-1.3-n | 200 but Content-Type is not an HTML type for an HTML page | WARN | MEDIUM | UNEXPECTED\_CONTENT\_TYPE |
| C-1.3-o | 3xx final (redirect loop terminated) | FAIL | CRITICAL | REDIRECT\_LOOP |
| C-1.3-p | 200 returned but with X-Robots-Tag: noindex | Defer to C-1.6 | — | — |
| C-1.3-q | No complete response within net.unresponsive\_ms, **and** a status line was received | FAIL | HIGH | PAGE\_NOT\_RESPONDING — reported with the observed HTTP status, elapsed\_ms and stall\_stage |
| C-1.3-r | No complete response within net.unresponsive\_ms, **and** no status line was received | FAIL | HIGH | PAGE\_NOT\_RESPONDING — http\_status null, reported with stall\_stage and elapsed\_ms |

**Evaluation order.** C-1.3-q and C-1.3-r are evaluated **before** every other row in this table. When either fires it is the only status emitted for this check, and every other page-level check for that URL emits NOT\_TESTABLE / PAGE\_NOT\_RESPONDING (R-FETCH-11).

### **EXCEPTIONAL CONDITIONS**

* E-1.3-1 — **410 on a URL the operator declared intentionally removed.** PASS with note; 410 and 404 receive identical treatment from Google, and a deliberate 410 is correct behaviour.

* E-1.3-2 — **403 for the auditor UA but 200 for a browser UA** (WAF UA-filtering). Report as AUDITOR\_UA\_BLOCKED, NOT\_TESTABLE — not a site-wide FAIL. Recommend allow-listing. Do not spoof another UA to get around it (R-FETCH-7).

* E-1.3-3 — **503 with** **Retry-After** **during a declared maintenance window.** Correct use of 503\. WARN / MAINTENANCE\_MODE, not CRITICAL, when Retry-After is present and sane.

* E-1.3-4 — **Geo-blocking / regional 451\.** Record GEO\_RESTRICTED, NOT\_TESTABLE for content checks. The site is not broken; the vantage point is wrong.

* E-1.3-5 — **HTTP/2 or HTTP/3 only, no HTTP/1.1.** Fine. Ensure the client negotiates; a negotiation failure is a tool problem (ERROR), not a site finding.

* E-1.3-6 — **Self-signed certificate on a staging host** with env \= staging → WARN, not CRITICAL.

* E-1.3-7 — **PDF or other non-HTML in the sample.** Size ceiling is 64 MB, not 2 MB. Content checks that assume HTML become NOT\_APPLICABLE.

* E-1.3-8 — **206 Partial Content.** Should not occur without a Range request. If it does, re-request without Range before judging.

* E-1.3-9 — **A “no results” search or filter page returning 200\.** Genuinely a soft 404 from Google’s perspective; keep C-1.3-f but set severity MEDIUM when the URL carries a query string.

* E-1.3-10 — **Cloudflare/CDN 5xx (520–530).** Report as SERVER\_ERROR with sub-code CDN\_ERROR; retry once more than standard, budget permitting (R-FETCH-10), before concluding, as these are frequently transient.

### **BACKUP PLANS**

* B-1.3-1 — Transient 5xx → full retry ladder before C-1.3-b.

* B-1.3-2 — TLS failure → retry with an explicit modern cipher set once; still failing → C-1.3-i. Never disable verification.

* B-1.3-3 — Timeout → one further attempt **only if** the remaining URL budget covers it (R-FETCH-10); read timeout is never extended beyond net.timeout\_read\_ms. Budget exhausted → C-1.3-q.

* B-1.3-4 — RAW fails but RENDERED succeeds → record status from the rendered navigation, caveat “Status observed via headless browser; direct fetch failed.”

* B-1.3-5 — All fetches fail for one page → NOT\_TESTABLE, promote a replacement page per E-A4-6.

### **FAILING & STOPPING PLAN**

* F-1.3-1 — 3 consecutive 429s on one host → F-RUN-4 abort.

* F-1.3-2 — \> 50% of sampled pages 5xx → set run\_quality \= DEGRADED, complete remaining checks, headline the finding.

* F-1.3-3 — Never retry a 404\. Never retry a 403 (except once under E-1.3-2 diagnosis).

* F-1.3-4 — Never report SOFT\_404\_PAGE on the strength of word count alone; R-1.3-3 requires two signals.

* F-1.3-5 — Never follow more than net.max\_redirect\_hops (10). Hop 11 terminates with C-1.3-o / C-1.4-e.

---

## **C-1.4 — Redirects**

**Scope:** site \+ page · **Profile:** RAW

### **RULES**

* R-1.4-1 — **Origin consolidation matrix.** Request all four origin variants (http://apex, http://www, https://apex, https://www) plus, where a trailing-slash variant exists, both forms of the homepage. Record each final URL. The correct outcome is that all converge on canonical\_origin via 301/308.

* R-1.4-2 — For every redirect hop record: source URL, status, Location header verbatim, resolved absolute target, whether the target is same-host, and cumulative hop index.

* R-1.4-3 — Classify redirect semantics:

* 301, 308 → permanent; **strong** signal that the target should be canonical.

* 302, 303, 307 → temporary; **weak** signal; source page is generally kept in results.

* meta refresh with content=“0;url=…” → treated as permanent-equivalent by Google, but weaker than a server redirect.

* meta refresh with delay \> 0 → temporary-equivalent.

* JavaScript location assignment → permanent-equivalent, but requires successful rendering; record JS\_REDIRECT and note that rendering may fail, in which case Google never sees it.

* R-1.4-4 — Detect loops: maintain a visited set on normalised URLs. Any repeat \= REDIRECT\_LOOP, terminate immediately.

* R-1.4-5 — Detect chains: hop\_count ≥ th.redirect\_chain\_warn (2) → WARN; ≥ th.redirect\_chain\_fail (5) → FAIL.

* R-1.4-6 — Detect protocol/host downgrades: https → http, or a redirect that lands off canonical\_origin.

* R-1.4-7 — Detect redirects to the homepage from deep URLs (REDIRECT\_TO\_HOME) — a pattern Google treats as a soft 404\.

* R-1.4-8 — Detect mixed-signal chains (e.g. 302 → 301 → 200). The first hop’s semantics dominate the interpretation; report the chain shape.

* R-1.4-9 — In RENDERED profile, record any client-side navigation that changes the URL after load, and compare to the RAW final URL. A divergence is a finding.

* R-1.4-10 — Detect UA- or geo-conditional redirects by comparing the RAW final URL against the RENDERED final URL and, where cap.ua\_probe is enabled, against a desktop-UA fetch. Report divergence rather than choosing a winner.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-1.4-a | All four origin variants converge on canonical\_origin in ≤ 1 hop via 301/308; sampled pages resolve in 0 hops | PASS | — | — |
| C-1.4-b | Redirect loop detected | FAIL | CRITICAL | REDIRECT\_LOOP |
| C-1.4-c | ≥ 2 origin variants return 200 without converging | FAIL | HIGH | MULTIPLE\_LIVE\_ORIGINS |
| C-1.4-d | Chain length ≥ 5 | FAIL | HIGH | REDIRECT\_CHAIN\_LONG |
| C-1.4-e | Chain exceeds net.max\_redirect\_hops (10) without resolving | FAIL | CRITICAL | REDIRECT\_HOPS\_EXCEEDED |
| C-1.4-f | Chain length 2–4 | WARN | MEDIUM | REDIRECT\_CHAIN |
| C-1.4-g | https → http downgrade anywhere in a chain | FAIL | CRITICAL | HTTPS\_DOWNGRADE |
| C-1.4-h | Permanent consolidation implemented with 302/303/307 | WARN | HIGH | TEMPORARY\_REDIRECT\_FOR\_PERMANENT\_MOVE |
| C-1.4-i | Deep URL redirects to homepage | FAIL | HIGH | REDIRECT\_TO\_HOME |
| C-1.4-j | Meta-refresh redirect used where a server redirect is possible | WARN | MEDIUM | META\_REFRESH\_REDIRECT |
| C-1.4-k | JavaScript-only redirect | WARN | HIGH | JS\_ONLY\_REDIRECT |
| C-1.4-l | Redirect target returns 4xx/5xx | FAIL | HIGH | REDIRECT\_TARGET\_BROKEN |
| C-1.4-m | Redirect target is itself noindex or canonicalised elsewhere | WARN | MEDIUM | REDIRECT\_TARGET\_NONINDEXABLE |
| C-1.4-n | RAW and RENDERED final URLs differ | WARN | HIGH | CLIENT\_SIDE\_REDIRECT\_DIVERGENCE |
| C-1.4-o | Location header is relative | WARN | LOW | RELATIVE\_LOCATION\_HEADER — permitted by RFC 7231 but a frequent source of misconfiguration |

### **EXCEPTIONAL CONDITIONS**

* E-1.4-1 — **307 from HSTS preload.** Browser-internal, not a server redirect. Detect via Strict-Transport-Security and exclude from chain counting.

* E-1.4-2 — **Legitimate temporary redirect** (A/B test, seasonal campaign, maintenance). 302 is correct here. If the operator declares expected\_temporary\_paths\[\], downgrade C-1.4-h to informational for those paths.

* E-1.4-3 — **Locale redirect on the homepage** (/ → /en/). Common and acceptable if it is a 302 and an x-default hreflang exists. WARN at most; note that Google crawls from the US and cannot follow geo-IP redirects for other regions.

* E-1.4-4 — **Trailing-slash normalisation** (/about → /about/) via a single 301\. Correct. PASS, and it resolves E-A3-5.

* E-1.4-5 — **Case normalisation** (/About → /about) via 301\. Correct.

* E-1.4-6 — **www** **→ apex or apex →** **www.** Either direction is fine; consistency is what matters.

* E-1.4-7 — **Redirect chain caused by the audit’s own URL construction** (e.g. probing http:// when the site is HTTPS-only). Excluded from page-level chain counts; belongs only to R-1.4-1.

* E-1.4-8 — **Redirect with a query string appended or dropped.** Record the parameter delta; only a WARN if tracking parameters are being stripped into a canonical (which is correct behaviour).

* E-1.4-9 — **CDN edge redirect returning 301 with no** **Location.** Malformed; report MALFORMED\_REDIRECT and stop the chain.

* E-1.4-10 — **Refresh:** **HTTP header** (non-standard equivalent of meta refresh). Treat as C-1.4-j.

### **BACKUP PLANS**

* B-1.4-1 — Location unparseable → resolve against the request URL per RFC 3986; if still unresolvable, MALFORMED\_REDIRECT.

* B-1.4-2 — Origin variant times out → retry once; on failure record variant\_unreachable rather than assuming non-convergence. Absence of a response is not evidence of a second live origin.

* B-1.4-3 — RENDERED unavailable → skip R-1.4-9/R-1.4-10, attach the JS caveat, and report client-side redirects as NOT\_TESTABLE.

* B-1.4-4 — Chain terminates in a captcha/interstitial → record the chain up to that point, mark terminal state BOT\_PROTECTION, and count toward F-RUN-5.

### **FAILING & STOPPING PLAN**

* F-1.4-1 — Hard stop at 10 hops per URL. Never configurable above 10 — that is Google’s documented ceiling and going beyond it measures something Google will not see.

* F-1.4-2 — Loop detection is mandatory before hop-limit termination; a loop must be reported as a loop, not as “too many hops.”

* F-1.4-3 — Never follow a redirect to a different scheme+host without recording it as a cross-origin hop.

* F-1.4-4 — Never auto-accept an interstitial or consent redirect to reach the target.

* F-1.4-5 — If C-1.4-c fires, all page-level canonical findings (C-1.5) must carry the caveat that duplicate origins may be producing them.

---

## **C-1.5 — Canonical Tags**

**Scope:** page · **Profile:** RAW **and** RENDERED

### **RULES**

* R-1.5-1 — Extract canonical signals from three sources, independently, and never merge them before comparison:

1. RAW HTML

* link\[rel=canonical\] — the authoritative source.

2. RENDERED DOM

* link\[rel=canonical\].

3. HTTP Link: ; rel=“canonical” response header.

* R-1.5-2 — **Head-scope rule.** A link\[rel=canonical\] is only valid inside

* . Determine placement against the *parsed* document (a parser closes

* at the first

* \-level element). If the element is in

* , it is ignored by Google — report it as absent-and-misplaced, not as present.

* R-1.5-3 — Validate the value: must be an absolute URL with scheme and host; must not be empty; must not contain a fragment; must be a single value.

* R-1.5-4 — Compare the resolved canonical to the page’s own final URL under R-FETCH-9 normalisation. Classify: SELF / CROSS / INVALID / ABSENT.

* R-1.5-5 — For CROSS, fetch the canonical target and record: final status, hop count, noindex state, its own canonical (to detect chains and non-reciprocity), and whether it is robots-disallowed.

* R-1.5-6 — Detect canonical chains (A → B, B → C) and canonical loops (A → B, B → A).

* R-1.5-7 — Compare RAW vs RENDERED canonical. A JS-injected or JS-modified canonical is picked up at render time, but it is materially riskier than a server-rendered one; record any divergence.

* R-1.5-8 — Detect a canonical pointing to a URL that redirects — a self-defeating configuration.

* R-1.5-9 — Detect protocol/host mismatch between canonical and canonical\_origin.

* R-1.5-10 — Cross-page (P6): group sampled pages by declared canonical. Two distinct pages declaring the same canonical is a cluster; report clusters with their members.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-1.5-a | Exactly one canonical in RAW  | PASS | — | — |
| C-1.5-b | \> 1 link\[rel=canonical\] in  | FAIL | HIGH | MULTIPLE\_CANONICALS — Google may ignore all of them |
| C-1.5-c | Canonical present only in  | FAIL | HIGH | CANONICAL\_IN\_BODY |
| C-1.5-d | Canonical value is relative | WARN | MEDIUM | CANONICAL\_RELATIVE — resolvable, but Google’s guidance is to use absolute URLs |
| C-1.5-e | Canonical value is empty or unparseable | FAIL | HIGH | CANONICAL\_INVALID |
| C-1.5-f | Canonical target returns 4xx/5xx | FAIL | HIGH | CANONICAL\_TARGET\_BROKEN |
| C-1.5-g | Canonical target redirects | FAIL | MEDIUM | CANONICAL\_TO\_REDIRECT |
| C-1.5-h | Canonical target is noindex | FAIL | HIGH | CANONICAL\_TO\_NOINDEX |
| C-1.5-i | Canonical target is robots-disallowed for Googlebot | FAIL | HIGH | CANONICAL\_TO\_BLOCKED |
| C-1.5-j | Canonical loop | FAIL | HIGH | CANONICAL\_LOOP |
| C-1.5-k | Canonical chain (target’s canonical is a third URL) | WARN | MEDIUM | CANONICAL\_CHAIN |
| C-1.5-l | Cross-canonical whose target does not reciprocate or include this URL’s content | WARN | MEDIUM | CANONICAL\_NON\_RECIPROCAL |
| C-1.5-m | Canonical absent from both RAW and RENDERED and no Link header | WARN | MEDIUM | CANONICAL\_ABSENT — legal; Google will choose one. Report as risk, not breakage. |
| C-1.5-n | Present in RENDERED only | WARN | HIGH | CANONICAL\_JS\_INJECTED |
| C-1.5-o | RAW and RENDERED canonicals differ | FAIL | HIGH | CANONICAL\_RAW\_RENDERED\_MISMATCH |
| C-1.5-p | HTTP Link header and HTML canonical disagree | FAIL | HIGH | CANONICAL\_HEADER\_HTML\_CONFLICT |
| C-1.5-q | Canonical differs from page URL only by protocol, www, trailing slash or case | WARN | MEDIUM | CANONICAL\_NORMALISATION\_MISMATCH |
| C-1.5-r | Canonical contains a fragment | WARN | LOW | CANONICAL\_HAS\_FRAGMENT |
| C-1.5-s | Two distinct sampled pages declare the same canonical | WARN | MEDIUM | CANONICAL\_CLUSTER |
| C-1.5-t | Canonical points off canonical\_origin | WARN | HIGH | CANONICAL\_CROSS\_DOMAIN |

Every result on this check carries the standing caveat: **“A declared canonical is a strong signal, not an instruction; Google may select a different canonical.”**

### **EXCEPTIONAL CONDITIONS**

* E-1.5-1 — **Paginated series** where page 2+ self-canonicalises. Correct current practice. PASS.

* E-1.5-2 — **Faceted/filtered URL canonicalising to the unfiltered parent.** Legitimate. CROSS → PASS when the target is 200 and indexable.

* E-1.5-3 — **Syndicated content canonicalising to an external origin.** C-1.5-t applies as WARN, with the note that this is intentional in syndication.

* E-1.5-4 — **AMP pages** canonicalising to the non-AMP original. Correct. PASS.

* E-1.5-5 — **Canonical on a** **noindex** **page.** Conflicting but not fatal — noindex wins. Report as MEDIUM note, and cross-reference C-1.6.

* E-1.5-6 — **Duplicate identical** **link\[rel=canonical\]** **elements with the same value.** Sloppy but unambiguous. WARN / LOW (CANONICAL\_DUPLICATED\_IDENTICAL), never C-1.5-b.

* E-1.5-7 — **Canonical injected by a tag manager.** Detect via RENDERED-only presence → C-1.5-n. Note in the finding that a rendering failure would leave the page with no canonical at all.

* E-1.5-8 — **Non-HTML resource (PDF) using the** **Link** **header.** The documented mechanism for non-HTML. PASS.

* E-1.5-9 — **Canonical with tracking parameters stripped.** Correct and desirable.

* E-1.5-10 — **Canonical to a URL that is itself the hreflang cluster leader.** Cross-check with C-3.2: within an hreflang cluster the canonical must point to a page in the same language.

### **BACKUP PLANS**

* B-1.5-1 — RAW parse fails → use a tolerant HTML parser (html5-compliant tree builder) before declaring absence.

* B-1.5-2 — RENDERED unavailable → evaluate RAW \+ Link header only; attach the JS caveat; C-1.5-n/C-1.5-o become NOT\_TESTABLE.

* B-1.5-3 — Canonical target unfetchable (timeout) → report the declared value with target validation NOT\_TESTABLE; do not assume the target is broken.

* B-1.5-4 — Malformed head (e.g. 

* before  breaking the head) → report HEAD\_MALFORMED\_CANONICAL\_AT\_RISK and evaluate against the parsed tree, since that is what a browser and Google will see.

### **FAILING & STOPPING PLAN**

* F-1.5-1 — Canonical-chain resolution stops at depth 3\. Deeper → CANONICAL\_CHAIN\_DEEP.

* F-1.5-2 — Never fetch a canonical target more than once per run.

* F-1.5-3 — Never report CANONICAL\_ABSENT as FAIL. It is a legal state.

* F-1.5-4 — Never resolve a conflict between sources by picking a winner. Report all sources and their disagreement.

* F-1.5-5 — Never claim to know Google’s *chosen* canonical without GSC URL Inspection data. Without cap.gsc\_api, all statements are about the *declared* canonical only.

---

## **C-1.6 — Meta Robots**

**Scope:** page · **Profile:** RAW **and** RENDERED

### **RULES**

* R-1.6-1 — Collect directives from three sources, kept separate:

1. in

2. ,

* , and any other crawler-specific name

3. X-Robots-Tag HTTP response header(s), including per-user-agent form X-Robots-Tag: googlebot: noindex

* R-1.6-2 — Tokenise content on commas; trim; lowercase. Field names, agent names and values are case-insensitive.

* R-1.6-3 — Recognised directive set (anything else → UNKNOWN\_DIRECTIVE, reported, never acted on): all, noindex, nofollow, none, nosnippet, indexifembedded, max-snippet:\[n\], max-image-preview:\[none|standard|large\], max-video-preview:\[n\], notranslate, noimageindex, unavailable\_after:\[date\]. Additionally recognised but **documented as no longer used by Google Search**, so reported as ineffective rather than as controls: noarchive, nocache, nositelinkssearchbox.

* R-1.6-4 — **Resolution:** compute the effective directive set for Googlebot as the union of the negative rules across name=“robots” and name=“googlebot”. On conflict, the **more restrictive** rule wins (nosnippet beats max-snippet:50).

* R-1.6-5 — **Crawl-dependency rule.** If the URL is Disallowed for Googlebot in robots.txt, any noindex on it is undiscoverable and therefore ineffective. This combination must be reported explicitly — it is the classic “blocked page still appearing in search” cause.

* R-1.6-6 — Compare RAW vs RENDERED. A noindex present in RAW may cause Google to skip rendering and JavaScript execution entirely, so removing it with JavaScript is unreliable; that specific pattern (RAW=noindex, RENDERED=index) must be reported as HIGH.

* R-1.6-7 — Validate unavailable\_after parses as RFC 822 / RFC 850 / ISO 8601; flag past dates.

* R-1.6-8 — Detect data-nosnippet attributes on ,

* ,

* and count them. Flag any occurrence on other elements as ineffective.

* R-1.6-9 — **AI-surface impact.** Record whether nosnippet or max-snippet is present, and state in the finding that these directives also limit or prevent the page’s content being used as a direct input for Google’s AI Overviews and AI Mode. Feed to C-5.1.

* R-1.6-10 — Detect

* placed in

* — ignored, same logic as R-1.5-2.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-1.6-a | No indexing-restrictive directive for Googlebot from any source | PASS | — | — |
| C-1.6-b | Effective noindex or none for Googlebot on a page intended to rank | FAIL | CRITICAL | NOINDEX\_PRESENT |
| C-1.6-c | noindex present **and** URL robots-disallowed for Googlebot | FAIL | CRITICAL | NOINDEX\_UNREACHABLE |
| C-1.6-d | nofollow site-wide or on a hub/category page | WARN | HIGH | NOFOLLOW\_PRESENT |
| C-1.6-e | RAW has noindex, RENDERED does not | FAIL | HIGH | NOINDEX\_REMOVED\_BY\_JS |
| C-1.6-f | RENDERED has noindex, RAW does not | FAIL | HIGH | NOINDEX\_ADDED\_BY\_JS |
| C-1.6-g | X-Robots-Tag and meta tag conflict | WARN | HIGH | ROBOTS\_DIRECTIVE\_CONFLICT — resolved to most restrictive; report both |
| C-1.6-h | nosnippet present | WARN | MEDIUM | NOSNIPPET\_PRESENT — suppresses search snippets and blocks use as direct input to AI Overviews and AI Mode |
| C-1.6-i | max-snippet:0 | WARN | MEDIUM | MAX\_SNIPPET\_ZERO — equivalent to nosnippet in effect |
| C-1.6-j | max-image-preview:none | WARN | LOW | NO\_IMAGE\_PREVIEW |
| C-1.6-k | unavailable\_after in the past | FAIL | HIGH | UNAVAILABLE\_AFTER\_EXPIRED |
| C-1.6-l | Meta robots in  | WARN | MEDIUM | META\_ROBOTS\_IN\_BODY — ignored by Google |
| C-1.6-m | Multiple meta name=“robots” with conflicting values | WARN | HIGH | MULTIPLE\_META\_ROBOTS — most restrictive applies |
| C-1.6-n | data-nosnippet on an unsupported element | WARN | LOW | DATA\_NOSNIPPET\_INVALID\_ELEMENT |

### **EXCEPTIONAL CONDITIONS**

* E-1.6-1 — **noindex** **on an intentionally private page** (thank-you, cart, search results, /wp-admin). Correct. When page\_type is such a page, or the operator declares expected\_noindex\_paths\[\], → PASS with note NOINDEX\_INTENTIONAL.

* E-1.6-2 — **noindex, follow.** Valid combination; only the indexing half is a finding.

* E-1.6-3 — **nofollow** **on a login or user-generated page.** Legitimate. Downgrade to informational.

* E-1.6-4 — **max-snippet:-1** **/** **max-video-preview:-1.** These *grant* maximum length. Never a finding.

* E-1.6-5 — **all.** Explicit default. PASS.

* E-1.6-6 — **X-Robots-Tag** **on a PDF or image.** Documented mechanism for non-HTML. PASS unless it is noindex on a page meant to rank.

* E-1.6-7 — **Per-UA** **X-Robots-Tag** **targeting a non-Google bot** (X-Robots-Tag: otherbot: noindex). Not a Googlebot directive. Must not fire C-1.6-b.

* E-1.6-8 — **Staging environment with site-wide** **noindex.** With env \= staging → WARN / STAGING\_NOINDEX\_EXPECTED.

* E-1.6-9 — **notranslate.** Rarely a defect. Informational only.

* E-1.6-10 — **noindex** **in a**  **block.** Parsed as part of the document; report as META\_ROBOTS\_IN\_NOSCRIPT with HIGH severity, since behaviour is inconsistent and the intent is almost always wrong.

### **BACKUP PLANS**

* B-1.6-1 — RENDERED unavailable → RAW \+ headers only; C-1.6-e/C-1.6-f → NOT\_TESTABLE; attach the JS caveat.

* B-1.6-2 — Headers unavailable (fetched from cache) → re-fetch with no\_cache once; if still unavailable, evaluate meta only and caveat.

* B-1.6-3 — Malformed content attribute → attempt token extraction; unparseable → UNKNOWN\_ROBOTS\_DIRECTIVE, never silently ignore.

* B-1.6-4 — If cap.gsc\_api is available, corroborate the effective indexing state with URL Inspection and report both. GSC is corroboration, never a substitute for reading the directives.

### **FAILING & STOPPING PLAN**

* F-1.6-1 — Never emit NOINDEX\_PRESENT without quoting the exact source (element or header) in evidence.

* F-1.6-2 — Never act on noindex in robots.txt — it is unsupported. Report it under C-1.1-j as ineffective.

* F-1.6-3 — Never resolve a conflict silently. Report every source, then the computed effective set.

* F-1.6-4 — If C-1.6-b fires on the homepage, escalate to a run-level headline finding; do not let it sit inside a section table.

* F-1.6-5 — Never treat a crawler-specific meta tag as applying to all crawlers.

---

## **C-1.7 — Indexability**

**Scope:** page · **Profile:** RAW **and** RENDERED · **Depends on:** C-1.1, C-1.3, C-1.4, C-1.5, C-1.6

This is a **composite** check. It computes a single verdict from the upstream signals, so that a reader does not have to assemble five results themselves. It introduces no new fetching.

### **RULES**

* R-1.7-1 — A page is INDEXABLE only if **all** of the following hold:

1. Not Disallowed for Googlebot in robots.txt.

2. Final HTTP status is 200\.

3. Effective robots directives for Googlebot contain neither noindex nor none.

4. Canonical is SELF, or ABSENT, or CROSS to a URL that is itself indexable **and** the operator has not marked the page as one that should rank in its own right.

5. Not a detected soft 404\.

6. Content is present in RAW **or** (with a caveat) in RENDERED.

* R-1.7-2 — Emit indexability\_state ∈ {INDEXABLE, BLOCKED\_ROBOTS, NOINDEX, NON\_200, CANONICALISED\_AWAY, SOFT\_404, NO\_CONTENT, CONFLICTED}.

* R-1.7-3 — CONFLICTED when two signals disagree in a way that makes the outcome unpredictable: e.g. noindex \+ robots-disallow; canonical to X while X canonicalises here; RAW/RENDERED directive mismatch.

* R-1.7-4 — Compute blocking\_signal\_chain\[\]: the ordered list of every signal that prevents indexing, so remediation is sequenced correctly (fixing noindex is pointless while robots.txt blocks the crawl).

* R-1.7-5 — Report the **rendered-content dependency**: if the page’s main content exists only in RENDERED, indexability is contingent on successful rendering. Record render\_dependent \= true and caveat.

* R-1.7-6 — When cap.gsc\_api is enabled and the property is verified, call URL Inspection for each sampled URL and record coverageState, indexingState, googleCanonical, userCanonical, crawledAs, lastCrawlTime. Present it as corroboration alongside the computed state; where they disagree, report both and explain the likely cause. Never overwrite the computed state.

* R-1.7-7 — Aggregate to a site-level ratio: indexable\_sampled / total\_sampled, with the sample-size caveat.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-1.7-a | indexability\_state \= INDEXABLE | PASS | — | — |
| C-1.7-b | BLOCKED\_ROBOTS | FAIL | CRITICAL | NOT\_INDEXABLE\_ROBOTS |
| C-1.7-c | NOINDEX | FAIL | CRITICAL | NOT\_INDEXABLE\_NOINDEX |
| C-1.7-d | NON\_200 | FAIL | CRITICAL | NOT\_INDEXABLE\_STATUS |
| C-1.7-e | SOFT\_404 | FAIL | HIGH | NOT\_INDEXABLE\_SOFT\_404 |
| C-1.7-f | CANONICALISED\_AWAY on a page that should rank | FAIL | HIGH | NOT\_INDEXABLE\_CANONICAL |
| C-1.7-g | CANONICALISED\_AWAY by design (duplicate/facet) | PASS | — | CANONICALISED\_BY\_DESIGN |
| C-1.7-h | NO\_CONTENT | FAIL | CRITICAL | NOT\_INDEXABLE\_EMPTY |
| C-1.7-i | CONFLICTED | FAIL | HIGH | INDEXABILITY\_CONFLICT |
| C-1.7-j | INDEXABLE but render\_dependent \= true | WARN | HIGH | INDEXABLE\_ONLY\_AFTER\_RENDER |
| C-1.7-k | Computed state and GSC state disagree | WARN | MEDIUM | GSC\_STATE\_DIVERGENCE |
| C-1.7-l | Homepage not indexable | FAIL | CRITICAL | HOMEPAGE\_NOT\_INDEXABLE — escalate to run headline |
| C-1.7-m | \< 70% of sampled pages indexable | FAIL | HIGH | LOW\_INDEXABLE\_RATIO |

### **EXCEPTIONAL CONDITIONS**

* E-1.7-1 — **Pages that should not be indexable** (/cart, /checkout, /search?, /tag/ on some sites, login). NOT\_APPLICABLE when the URL matches expected\_noindex\_paths\[\] or the classifier assigns such a type.

* E-1.7-2 — **Newly published page not yet crawled.** Not an indexability defect; GSC “Discovered – currently not indexed” is a scheduling state. If GSC reports it, present it as such, not as FAIL.

* E-1.7-3 — **Page indexable but low quality.** Out of scope here; Section 6 handles content readiness. Do not conflate.

* E-1.7-4 — **Paginated page 2+ that is indexable.** Correct. Not a finding.

* E-1.7-5 — **noindex** **present but robots also blocks** — this is CONFLICTED, and the remediation order in R-1.7-4 matters: unblock the crawl first, let the noindex be seen, then remove it once de-indexed.

* E-1.7-6 — **Non-HTML resource in the sample.** Indexability is evaluated on status \+ X-Robots-Tag only; content rules are NOT\_APPLICABLE.

* E-1.7-7 — **Site with genuine geographic gating.** NOT\_TESTABLE from this vantage point rather than FAIL.

### **BACKUP PLANS**

* B-1.7-1 — Any upstream check is NOT\_TESTABLE → this check is NOT\_TESTABLE for the affected dimension only; compute what can be computed and enumerate which inputs were missing.

* B-1.7-2 — GSC unavailable → computed state stands alone with the caveat “Declared/observable state only; Google’s actual index decision not verified.”

* B-1.7-3 — RENDERED unavailable → evaluate on RAW; render\_dependent becomes NOT\_TESTABLE.

### **FAILING & STOPPING PLAN**

* F-1.7-1 — Never emit INDEXABLE while any of the six R-1.7-1 conditions is NOT\_TESTABLE. Emit NOT\_TESTABLE with the missing input named.

* F-1.7-2 — Never claim a page **is indexed**. This check evaluates *indexability* — whether the page permits indexing. Indexed-ness is not established by this tool’s question and even there is only an observation.

* F-1.7-3 — C-1.7-l (homepage) triggers a run-level headline and forces run\_quality annotation.

* F-1.7-4 — Never let one page’s FAIL short-circuit evaluation of the others.

---

---

# **SECTION 2 — ON-PAGE SEO**

---

## **C-2.1 — Title Tags**

**Scope:** page · **Profile:** RAW **and** RENDERED

### **RULES**

* R-2.1-1 — Extract

* from RAW

* . Record: raw string, character count, count after collapsing whitespace, and the element’s index if multiple exist.

* R-2.1-2 — Extract

* from RENDERED

* . Compare with RAW.

* R-2.1-3 — Extract the fallback sources Google may use to build a title link, so that a missing or poor

* can be reported alongside what Google will likely substitute:

* , og:title, WebSite/WebPage structured-data name, and the dominant anchor text pointing at the page from within the sample.

* R-2.1-4 — Normalise for comparison: collapse whitespace, decode HTML entities, strip a trailing brand suffix delimited by |, \-, –, —, ·, : where the suffix matches a detected site name. Keep both raw and normalised values.

* R-2.1-5 — Cross-page (P6): detect exact duplicates and near-duplicates (normalised Levenshtein ratio ≥ 0.9) across the sample.

* R-2.1-6 — Detect boilerplate-only titles: the normalised title equals the detected site name, or matches a template lexicon (Home, Untitled, New Page, Page, Document, the CMS default).

* R-2.1-7 — Detect keyword stuffing: the same token (≥ 4 chars, not a stop word) repeated ≥ 3 times, or ≥ 4 comma/pipe-delimited fragments with no verb.

* R-2.1-8 — Length reporting: report characters **and** an estimated rendered pixel width at 20px Arial (desktop) so the reader has a truncation proxy. State plainly that Google specifies no character limit and truncation is device-width dependent (R-CFG-1).

* R-2.1-9 — Detect

* outside

* in the parsed tree.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-2.1-a | Exactly one  | PASS | — | — |
| C-2.1-b | No  | FAIL | HIGH | TITLE\_MISSING |
| C-2.1-c |  | FAIL | HIGH | TITLE\_EMPTY |
| C-2.1-d | \> 1  | WARN | MEDIUM | TITLE\_MULTIPLE — browsers and parsers use the first; the rest are dead weight |
| C-2.1-e | Present in RENDERED only | WARN | HIGH | TITLE\_JS\_INJECTED |
| C-2.1-f | RAW and RENDERED titles differ | WARN | MEDIUM | TITLE\_RAW\_RENDERED\_MISMATCH |
| C-2.1-g | Exact duplicate of another sampled page’s title | FAIL | MEDIUM | TITLE\_DUPLICATE |
| C-2.1-h | Near-duplicate (≥ 0.9 similarity) | WARN | MEDIUM | TITLE\_NEAR\_DUPLICATE |
| C-2.1-i | Boilerplate/template default | FAIL | MEDIUM | TITLE\_BOILERPLATE |
| C-2.1-j | Keyword stuffing detected | WARN | MEDIUM | TITLE\_KEYWORD\_STUFFED |
| C-2.1-k |  | WARN | MEDIUM | TITLE\_OUTSIDE\_HEAD |
| C-2.1-l | Title identical to  | WARN | LOW | TITLE\_H1\_BRAND\_ONLY |
| C-2.1-m | Title contains an unresolved template placeholder ({{, %s, \[title\], %%) | FAIL | HIGH | TITLE\_PLACEHOLDER\_LEAK |

### **EXCEPTIONAL CONDITIONS**

* E-2.1-1 — **Title identical to H1 by design.** Common, correct, and often ideal. Only C-2.1-l (brand-only) is a finding; identical descriptive titles are not.

* E-2.1-2 — **Consistent brand suffix across all pages.** Recommended practice, not duplication. R-2.1-4 normalisation must strip it before the duplicate test, or every site will falsely fail C-2.1-g.

* E-2.1-3 — **Non-Latin scripts.** Character count is not a width proxy for CJK, Arabic, Devanagari. Suppress C-2.1-k/C-2.1-l and report width only, with a note.

* E-2.1-4 — **Long titles on legal/reference pages.** Downgrade C-2.1-l to informational for page\_type \= other where content is legal or documentation.

* E-2.1-5 — **Paginated series** (… — Page 2). Not a duplicate. Exclude pagination suffixes from the duplicate test.

* E-2.1-6 — **Locale variants of one template.** Only one is sampled (R-A3-4), so this should not arise; if it does, exclude cross-locale pairs from duplicate detection.

* E-2.1-7 — **Emoji or symbols in the title.** Not a defect. Count graphemes, not code units.

* E-2.1-8 — **Google rewriting the title in the SERP.** Informational. Google uses several sources; a rewrite is not proof the

* is wrong, though a persistent rewrite is worth surfacing.

* E-2.1-9 — **Title set by JS on a genuinely client-rendered app.** Still C-2.1-e WARN — it depends on rendering succeeding.

### **BACKUP PLANS**

* B-2.1-1 — RAW head unparseable → tolerant parse → regex \<title\[^\>\]*\>(.*?)

* as the last resort, flagged TITLE\_EXTRACTED\_BY\_REGEX.

* B-2.1-2 — RENDERED unavailable → RAW only; C-2.1-e/C-2.1-f → NOT\_TESTABLE; JS caveat attached.

* B-2.1-3 — Sample too small for duplicate detection (\< 2 pages) → C-2.1-g/C-2.1-h → NOT\_APPLICABLE / INSUFFICIENT\_SAMPLE.

* B-2.1-4 — Site name undetectable for suffix stripping → fall back to the most common trailing fragment across sampled titles; if none, skip stripping and caveat the duplicate result.

### **FAILING & STOPPING PLAN**

* F-2.1-1 — Never FAIL on length alone (R-CFG-1). Length is WARN, always with the caveat.

* F-2.1-2 — Never report a duplicate without naming the other URL in evidence.

* F-2.1-3 — Never treat a Google SERP rewrite as a title defect.

* F-2.1-4 — Never suggest a replacement title that the tool has not verified is unique within the sample.

---

## **C-2.2 — Meta Descriptions**

**Scope:** page · **Profile:** RAW **and** RENDERED

### **RULES**

* R-2.2-1 — Extract

* from RAW

* . name matching is case-insensitive. Record raw content, length, and element count.

* R-2.2-2 — Extract from RENDERED; compare.

* R-2.2-3 — Extract og:description and twitter:description separately. They are **not** substitutes for the meta description and must never be counted as one; they are reported as adjacent context.

* R-2.2-4 — Cross-page duplicate detection (exact and ≥ 0.9 similarity), as R-2.1-5.

* R-2.2-5 — Detect templated descriptions: ≥ 3 sampled pages sharing a description skeleton once numbers and proper nouns are masked.

* R-2.2-6 — Detect keyword lists: ≥ 5 comma-delimited fragments with no verb, or a token repeated ≥ 4 times.

* R-2.2-7 — Detect truncation-prone length and report characters plus estimated pixel width. State that Google documents no length limit and that Google may not use the meta description at all — snippets are primarily generated from page content.

* R-2.2-8 — Detect unresolved template placeholders, as C-2.1-m.

* R-2.2-9 — Detect the description duplicating the

* verbatim.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-2.2-a | Exactly one, non-empty, unique in sample, not a keyword list | PASS | — | — |
| C-2.2-b | Missing from RAW and RENDERED | WARN | MEDIUM | METADESC\_MISSING — **not** **FAIL**: Google generates snippets from page content and often ignores the tag |
| C-2.2-c | Empty / whitespace-only | WARN | MEDIUM | METADESC\_EMPTY |
| C-2.2-d | \> 1 description element | WARN | LOW | METADESC\_MULTIPLE |
| C-2.2-e | Exact duplicate across sampled pages | WARN | MEDIUM | METADESC\_DUPLICATE |
| C-2.2-f | Near-duplicate / templated | WARN | LOW | METADESC\_TEMPLATED |
| C-2.2-g | Keyword-list shape | WARN | MEDIUM | METADESC\_KEYWORD\_LIST |
| C-2.2-h | Present in RENDERED only | WARN | MEDIUM | METADESC\_JS\_INJECTED |
| C-2.2-i | RAW/RENDERED mismatch | WARN | LOW | METADESC\_RAW\_RENDERED\_MISMATCH |
| C-2.2-j | Contains an unresolved placeholder | FAIL | MEDIUM | METADESC\_PLACEHOLDER\_LEAK |
| C-2.2-k | Identical to  | WARN | LOW | METADESC\_EQUALS\_TITLE |
| C-2.2-l | Page carries nosnippet or max-snippet:0 | NOT\_APPLICABLE | — | SNIPPET\_SUPPRESSED — the description cannot be used; cross-reference C-1.6 |

### **EXCEPTIONAL CONDITIONS**

* E-2.2-1 — **Deliberately omitted on large content sites.** A defensible strategy; Google generates snippets from content. Keep C-2.2-b at WARN/MEDIUM and word the finding as an opportunity, not a defect.

* E-2.2-2 — **Auto-generated from the first paragraph.** Acceptable if unique per page. Only C-2.2-f if the skeleton repeats.

* E-2.2-3 — **og:description** **present, meta description absent.** Still C-2.2-b. Note in the finding that og:description serves social previews, not Google snippets.

* E-2.2-4 — **Non-Latin scripts.** Suppress length conditions; report width with a note (as E-2.1-3).

* E-2.2-5 — **Paginated series sharing a description.** Exclude from duplicate detection where the URL matches a pagination signature.

* E-2.2-6 — **Description differing only by an injected location or product name.** That is templating done correctly; report as INFO, not C-2.2-f, when the variable portion is ≥ 20% of the string.

* E-2.2-7 — **nosnippet** **present.** C-2.2-l takes precedence over every other row; do not also report length or duplication.

### **BACKUP PLANS**

* B-2.2-1 — Head unparseable → tolerant parse → regex extraction, flagged.

* B-2.2-2 — RENDERED unavailable → RAW only, JS caveat, C-2.2-h/C-2.2-i NOT\_TESTABLE.

* B-2.2-3 — Sample \< 2 pages → duplicate conditions NOT\_APPLICABLE.

### **FAILING & STOPPING PLAN**

* F-2.2-1 — **Never** **FAIL** **on a missing meta description.** Google does not require one. Tools that fail here train users to chase a non-issue.

* F-2.2-2 — Never FAIL on length. WARN with caveat only.

* F-2.2-3 — Never count og:description as satisfying this check.

* F-2.2-4 — Never recommend a description for a page carrying nosnippet without first flagging the contradiction.

---

## **C-2.3 — H1 / Headings**

**Scope:** page · **Profile:** RAW **and** RENDERED

### **RULES**

* R-2.3-1 — Extract every h1–h6 in document order from RAW: tag level, text content (trimmed, whitespace-collapsed), DOM depth, whether inside

* /

* /

* /

* , and whether visually hidden (inline display:none, visibility:hidden, or a class matching a screen-reader-only lexicon such as sr-only, visually-hidden, screen-reader-text).

* R-2.3-2 — Extract the same from RENDERED, where computed styles make hidden-state determination reliable. Where the two disagree on hidden-state, RENDERED governs the visibility judgement and the divergence is recorded.

* R-2.3-3 — Compute the outline: the sequence of levels, and every **skip** (a level jump of \> 1 downward, e.g. h2 → h4).

* R-2.3-4 — Count h1 elements in the main content region. Determine the main region by, in order:

* ; \[role=main\]; the largest text-bearing

* /

* ; else the body minus header/nav/footer/aside.

* R-2.3-5 — Compare h1 text with

* (normalised) and record similarity.

* R-2.3-6 — Detect empty headings (no text after trimming, e.g. wrapping only an image or icon) and record whether an alt/aria-label supplies text.

* R-2.3-7 — Detect headings used for layout: a heading whose text is \< 3 characters, or a heading inside a component that repeats \> 5 times on the page.

* R-2.3-8 — Cross-page (P6): duplicate h1 detection across the sample, using the same normalisation as C-2.1.

* R-2.3-9 — Record heading-to-content mapping for C-6.3: for each heading, the word count of the text between it and the next heading of equal or higher level.

* R-2.3-10 — Detect question-form headings (interrogative opener or terminal ?) and pass the list to C-6.4.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-2.3-a | Exactly one visible h1 in the main region, non-empty, no level skips, unique in sample | PASS | — | — |
| C-2.3-b | No h1 in RAW or RENDERED | FAIL | MEDIUM | H1\_MISSING |
| C-2.3-c | h1 present but empty | FAIL | MEDIUM | H1\_EMPTY |
| C-2.3-d | \> 1 h1 in the main region | WARN | LOW | H1\_MULTIPLE — valid HTML5 and not a ranking problem, but it weakens the page’s single-topic signal for extraction |
| C-2.3-e | Only h1 is visually hidden | WARN | MEDIUM | H1\_HIDDEN |
| C-2.3-f | h1 present in RENDERED only | WARN | HIGH | H1\_JS\_INJECTED |
| C-2.3-g | RAW/RENDERED h1 text differs | WARN | MEDIUM | H1\_RAW\_RENDERED\_MISMATCH |
| C-2.3-h | Duplicate h1 across sampled pages | WARN | MEDIUM | H1\_DUPLICATE |
| C-2.3-i | ≥ 1 heading-level skip | WARN | LOW | HEADING\_LEVEL\_SKIP |
| C-2.3-j | Document starts with h2+ before any h1 | WARN | LOW | HEADING\_STARTS\_BELOW\_H1 |
| C-2.3-k | ≥ 3 empty headings | WARN | LOW | HEADINGS\_EMPTY\_MULTIPLE |
| C-2.3-l | Headings used for layout (R-2.3-7) | WARN | LOW | HEADINGS\_LAYOUT\_MISUSE |
| C-2.3-m | Only h1 is the site name/logo | WARN | MEDIUM | H1\_IS\_SITE\_NAME |
| C-2.3-n | Zero headings of any level | FAIL | HIGH | NO\_HEADINGS — cross-reference C-6.3 |
| C-2.3-o | h1 contains an unresolved placeholder | FAIL | HIGH | H1\_PLACEHOLDER\_LEAK |

### **EXCEPTIONAL CONDITIONS**

* E-2.3-1 — **Multiple** **h1s in an HTML5 sectioned document.** Spec-legal. Keep at WARN/LOW and word it as an extraction-clarity issue, never as an error.

* E-2.3-2 — **h1** **in** \*\*

* \*\* **as a site title, plus an** **h1** **in** \*\*

* \*\*\*\*.\*\* R-2.3-4 scoping means only the main-region one counts. Report the header h1 as context.

* E-2.3-3 — **Screen-reader-only** **h1** **on a design-led page.** C-2.3-e WARN; note it is valid for accessibility but weak for extraction, since the visible page offers no equivalent.

* E-2.3-4 — **Heading levels skipped inside a third-party embed** (chat widget, review widget). Exclude subtrees whose root is an  or a known-widget container from R-2.3-3.

* E-2.3-5 — **Homepage with no** **h1** **by design.** Still C-2.3-b; it is a real gap for entity extraction, and C-6.2 will corroborate.

* E-2.3-6 — **Duplicate** **h1** **on paginated list pages.** Exclude pagination signatures from C-2.3-h.

* E-2.3-7 — **h1** **wrapping a logo image with** **alt** **text.** Not empty if alt provides text; record H1\_IMAGE\_ALT and evaluate the alt string as the heading text.

* E-2.3-8 — **Landing pages with an** **h1** **that is a marketing slogan.** Not a defect on its own. Feed to C-6.2 (entity clarity), where it belongs.

* E-2.3-9 — **Framework-injected headings in an SPA.** C-2.3-f applies. Cross-reference C-5.2.

### **BACKUP PLANS**

* B-2.3-1 — RAW parse failure → tolerant parse; regex fallback for h1 only, flagged.

* B-2.3-2 — RENDERED unavailable → hidden-state determination is limited to inline styles; set visibility\_confidence \= LOW and caveat C-2.3-e.

* B-2.3-3 — Main region undeterminable → evaluate over the whole body, record MAIN\_REGION\_UNDETERMINED, and downgrade C-2.3-d to informational, since header/footer headings will inflate the count.

* B-2.3-4 — Sample \< 2 pages → C-2.3-h NOT\_APPLICABLE.

### **FAILING & STOPPING PLAN**

* F-2.3-1 — Never FAIL on multiple h1s. HTML5 permits them.

* F-2.3-2 — Never FAIL on heading-level skips. They are an accessibility and structure signal, not a ranking directive.

* F-2.3-3 — Never declare a heading hidden on RAW evidence alone.

* F-2.3-4 — Never treat role=“heading” \+ aria-level as an h1 for this check; record it separately as ARIA\_HEADING\_PRESENT and note that it is not a native heading element.

---

## **C-2.4 — Internal Links**

**Scope:** page \+ site · **Profile:** RAW **and** RENDERED **Explicit exclusion from the checklist:** *“Ignore if for a single-page website.”*

### **RULES**

* R-2.4-1 — **Applicability gate (evaluated first).** If site\_shape \= single\_page → NOT\_APPLICABLE / SINGLE\_PAGE\_SITE. Emit no sub-findings. If sample\_quality \= SINGLE → NOT\_APPLICABLE / INSUFFICIENT\_SAMPLE.

* R-2.4-2 — For each sampled page, collect internal links per R-A1-1…R-A1-7. Record per link: resolved target, anchor text, rel tokens, link\_zone, position index, whether inside the main region, and whether the target is in the sample.

* R-2.4-3 — Partition into boilerplate (nav/header/footer/aside) and contextual (main region). All ratio metrics are computed on contextual links; boilerplate is counted and reported separately. Mixing the two is the most common way internal-link analysis is made meaningless.

* R-2.4-4 — Validate targets: fetch each **unique** contextual target once (budget links.max\_validations, default 25, prioritised by in-degree). Record the final status only — a target that answers 4xx/5xx is the finding; redirects and noindex on a link target are not evaluated here.

* R-2.4-5 — Anchor-text quality: flag generic anchors against a configurable lexicon (click here, read more, learn more, here, this, more, link, download, continue, plus configured non-English equivalents). Report the count and the ratio against contextual links.

* R-2.4-6 — Detect empty anchors (no text, no aria-label, no alt on a contained image).

* R-2.4-7 — Detect internal rel=“nofollow” and rel=“sponsored”/ugc on internal links.

* R-2.4-8 — Build the sample’s link graph: nodes \= sampled pages \+ all contextual targets; edges \= contextual links. Compute in-degree per sampled page and identify orphans **within the sample** (in-degree 0).

* R-2.4-9 — js\_only\_links\[\] from R-A1-2: links present only after rendering. Report count and ratio; these are discoverable only if rendering succeeds.

* R-2.4-10 — Detect self-links (a page linking to its own URL in the main region) and count them as neutral, not as internal links, for ratio purposes.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-2.4-a | Every sampled page has ≥ 1 contextual internal link; no broken targets; generic-anchor ratio \< 20% | PASS | — | — |
| C-2.4-b | site\_shape \= single\_page | NOT\_APPLICABLE | — | SINGLE\_PAGE\_SITE |
| C-2.4-c | ≥ 1 contextual link target returns 4xx/5xx | FAIL | HIGH | BROKEN\_INTERNAL\_LINK |
| C-2.4-d | A sampled page (other than the homepage) has in-degree 0 within the sample | WARN | MEDIUM | ORPHAN\_IN\_SAMPLE — sample-scoped, **never** a claim about the whole site |
| C-2.4-e | Generic-anchor ratio ≥ 20% | WARN | MEDIUM | GENERIC\_ANCHOR\_TEXT |
| C-2.4-f | ≥ 1 empty anchor | WARN | LOW | EMPTY\_ANCHOR |
| C-2.4-g | Internal rel=“nofollow” present | WARN | MEDIUM | INTERNAL\_NOFOLLOW |
| C-2.4-h | A sampled page has 0 contextual internal links | WARN | MEDIUM | NO\_CONTEXTUAL\_LINKS |
| C-2.4-i | \> 30% of internal links exist only after rendering | FAIL | HIGH | LINKS\_REQUIRE\_JS |
| C-2.4-j | Navigation exists only as non-anchor elements | FAIL | HIGH | NON\_ANCHOR\_NAVIGATION — Google discovers links only from  |

### **EXCEPTIONAL CONDITIONS**

* E-2.4-1 — **Single-page site.** Hard NOT\_APPLICABLE per the checklist. No partial evaluation.

* E-2.4-2 — **Landing pages with intentionally no outbound internal links** (paid-traffic pages). C-2.4-h downgraded to informational when page\_type \= other and the URL matches expected\_standalone\_paths\[\].

* E-2.4-3 — **Orphan status is sample-scoped.** A page with in-degree 0 across 10 sampled pages may be well-linked site-wide. The finding text must say so; C-2.4-d may never be described as a site-wide orphan.

* E-2.4-4 — **rel=“nofollow”** **on login/register/cart links.** Legitimate crawl-budget management. Exclude URLs matching expected\_noindex\_paths\[\] from C-2.4-g.

* E-2.4-5 — **Mega-menus producing 200+ boilerplate links.** Excluded from ratio maths by R-2.4-3; only contextual links count toward the ratio.

* E-2.4-6 — **Anchor text that is a bare URL.** Not “generic” — it names its target. Exclude from the generic lexicon.

* E-2.4-7 — **Image links with descriptive** **alt.** alt is the anchor text. Not empty (C-2.4-f does not fire).

* E-2.4-8 — **Breadcrumb links with short anchors** (“Home”). Exclude breadcrumb containers (detected by BreadcrumbList JSON-LD or nav\[aria-label\*=breadcrumb\]) from the generic-anchor ratio.

* E-2.4-9 — **Links added by a consent-gated script.** They appear only in RENDERED and only after consent; report as js\_only\_links with a note.

* E-2.4-10 — **Pagination links** (rel=“next”/prev or numeric anchors). Excluded from the generic-anchor lexicon; numbers are meaningful here.

### **BACKUP PLANS**

* B-2.4-1 — RENDERED unavailable → RAW links only; C-2.4-i → NOT\_TESTABLE; JS caveat.

* B-2.4-2 — Link-validation budget exhausted → validate the highest in-degree targets first; the remainder are reported as unvalidated\_targets with a count, never assumed healthy.

* B-2.4-3 — Main-region detection fails → compute on all links, set LINK\_ZONING\_DEGRADED, and downgrade all ratio conditions to informational. A ratio computed over unzoned links is not trustworthy enough to fail a site on.

* B-2.4-4 — Rate limiting during validation → reduce to 20 validations and caveat.

### **FAILING & STOPPING PLAN**

* F-2.4-1 — Hard NOT\_APPLICABLE for single-page sites — no partial credit, no sub-findings.

* F-2.4-2 — Never claim a site-wide orphan from sample data.

* F-2.4-3 — Never validate the same target URL twice in one run.

* F-2.4-4 — Never count boilerplate links in contextual ratios.

* F-2.4-5 — Cap total link validations at links.max\_validations; report LINK\_VALIDATION\_CAPPED with the true target count.

* F-2.4-6 — Never recommend a specific internal-link addition without naming both source and target URLs from observed data.

---

# **SECTION 3 — STRUCTURED & INTERNATIONAL**

---

## **C-3.1 — Structured Data**

**Scope:** page · **Profile:** RAW **and** RENDERED **Checklist constraint:** *“we have some fixed schema; check only those”*

### **3.1.0 — The fixed schema set**

The tool validates against a **closed, configurable registry**. Types outside it are detected, inventoried, and reported as INFO — never validated, never failed. This is what “check only those” means in implementation: a bounded validator with an explicit out-of-scope list, not an open-ended schema linter.

**Registry** **schema.fixed\_set** **— default (derived from the organisation’s existing schema standard; every entry is overridable):**

| \# | Type | Applies to | @id convention | Required by tool | Recommended |
| :---- | :---- | :---- | :---- | :---- | :---- |
| S1 | Organization (or a more specific subtype) | homepage \+ about; may appear site-wide | {origin}/\#organization | name, url, logo | description, sameAs\[\], contactPoint, legalName, foundingDate, address |
| S2 | WebSite | homepage; may appear site-wide | {origin}/\#website | name, url, publisher → @id of S1 | inLanguage, description |
| S3 | WebPage / AboutPage / CollectionPage / ProfilePage | every page | {page\_url}\#webpage | @id, url, name, isPartOf → S2 | description, inLanguage, datePublished, dateModified, about → S1, breadcrumb → S4, primaryImageOfPage |
| S4 | BreadcrumbList | every non-home page | {page\_url}\#breadcrumb | itemListElement\[\] with position, name, item | last item may omit item |
| S5 | Article / BlogPosting / NewsArticle | blog\_article, blog\_template\_alt | {page\_url}\#article | headline, datePublished, author, publisher → S1 | dateModified, image, mainEntityOfPage → S3, articleSection, wordCount |
| S6 | Person | author; author of S5 | {origin}/\#person-{slug} or {author\_url}\#person | name | url, jobTitle, sameAs\[\], worksFor → S1, description |
| S7 | Product | product\_main | {page\_url}\#product | name \+ at least one of offers / review / aggregateRating | image, description, sku, brand → S1 |
| S8 | Offer (nested in S7, or on pricing) | product\_main, pricing | — | price (or priceSpecification.price) and priceCurrency | availability, priceValidUntil, url |
| S9 | Service | service\_main, service\_secondary | {page\_url}\#service | name, provider → S1 | serviceType, areaServed, description, offers |
| S10 | FAQPage | any page with a visible Q\&A block | {page\_url}\#faq | mainEntity\[\] of Question with name \+ acceptedAnswer.text | — |

**Binding note on S10:** Google’s FAQ rich result was retired — FAQ rich results stopped appearing in Google Search on **7 May 2026**, with the Search Console appearance filter, rich-result report and Rich Results Test support removed in June 2026 and API support ending August 2026\. Google’s position is that existing FAQ structured data can stay in place and unused structured data does not cause problems. Therefore:

* FAQPage presence is **never** a PASS requirement and its absence is **never** a finding.

* If present and malformed → WARN/LOW only.

* The finding text must state that FAQ markup no longer produces a Google rich result and is retained here for entity/LLM-extraction value only.

**Out-of-scope registry** **schema.inventory\_only** **(detect, count, never validate):** LocalBusiness, Event, Recipe, HowTo, VideoObject, JobPosting, Course, SoftwareApplication, QAPage, ItemList, SearchAction, and anything not in schema.fixed\_set.

### **RULES**

* R-3.1-1 — Extract structured data from RAW and RENDERED separately, in all three syntaxes: JSON-LD (script\[type=“application/ld+json”\]), Microdata (itemscope/itemtype/itemprop), RDFa (typeof/property). Report the syntax mix. JSON-LD is Google’s recommended format and Google reads JSON-LD injected by JavaScript, but a RENDERED-only graph is materially more fragile.

* R-3.1-2 — Parse each JSON-LD block independently. A syntax error in one block invalidates only that block.

* R-3.1-3 — Flatten @graph arrays and top-level arrays into a node list. Resolve @id references into an internal reference map.

* R-3.1-4 — **Reference resolution.** Every @id reference used as a property value (publisher, isPartOf, about, author, provider, brand) must resolve to a node **declared somewhere in the same page’s combined graph**. An unresolved @id is a dangling reference and is the single most common defect in hand-built graphs.

* R-3.1-5 — **@id** **stability.** Compare @id values for S1 and S2 across all sampled pages. They must be byte-identical site-wide. Divergent organisation or website @ids fragment the entity.

* R-3.1-6 — **URL/canonical alignment.** S3’s url and the @id prefix must equal the page’s canonical URL exactly, including trailing slash and protocol.

* R-3.1-7 — **Required-field validation, against the page’s own data.** For each in-scope type, validate only the tool’s **required** list for that type and page\_type. Recommended fields are inventoried in the per-type report and are **never** a finding. A required field is evaluated in three states: **present** (value exists and matches the page); **missing** (the page carries the underlying data in visible content but the property is absent) → FAIL; **not applicable** (the page genuinely has no such data — no price on a non-commercial page, no author on an unbylined page) → NOT\_APPLICABLE for that field, never a FAIL. The tool never asks a page to declare a fact it does not have. Note in the report that Google documents **no strictly required properties for** **Organization** — S1’s required list is this tool’s standard for entity resolution, not a Google requirement, and the finding must say so.

* R-3.1-8 — **Visible-content correspondence.** For a defined field subset, verify the value appears in the page’s visible rendered text: S3 name vs h1/title; S5 headline vs h1; S5 datePublished vs a visible date; S7/S8 price vs a visible price; S10 Question.name and acceptedAnswer.text vs visible Q\&A text. Google’s policy is explicit that content not visible to readers must not be marked up.

* R-3.1-9 — **Type-appropriateness.** Flag misuse: Product on a category/list page (product rich results support pages focused on a single product; markup belongs on product pages, not list or category pages); Article on a non-article template; Organization duplicated with conflicting name/url; Person used for a brand; Service with no provider.

* R-3.1-10 — **Duplicate entity detection.** More than one node of S1 or S2 per page with differing @id or conflicting name/url.

* R-3.1-11 — **Date validation.** datePublished/dateModified must be ISO 8601\. Flag dateModified earlier than datePublished, and future dates. Feed both to C-6.5.

* R-3.1-12 — **Property-casing validation.** schema.org property names are case-sensitive: url is valid, Url is not. Flag any property whose casing does not match a schema.org term. This is a silent-failure class — the markup parses as JSON but the property is meaningless.

* R-3.1-13 — **Placeholder detection.** Flag obvious placeholder values: postalCode: “00000”, telephone: “000…”, “example.com”, “YOUR\_…”, “TODO”, openingHoursSpecification declaring 24/7 on a non-customer-facing business. Google’s guidance is to omit a property rather than supply a placeholder.

* R-3.1-14 — **Blocked-markup check.** If the page is noindex or robots-disallowed, note that its structured data cannot be used at all (Google’s policy is not to block structured-data pages by robots.txt, noindex, or other access controls).

* R-3.1-15 — Emit a machine-readable per-type report: {type, present, syntax, source\_profile, node\_count, required\_missing\[\], required\_not\_applicable\[\], recommended\_present\[\], invalid\_values\[\], id\_value, refs\_resolved, refs\_dangling\[\]}.

* R-3.1-16 — **Entity-node presence.** Verify an Organization (or, on a personal site, Person) node exists in the page graph. Its absence is the root cause of most entity-resolution failures and is reported here, not in Section 6\.

* R-3.1-17 — **FAQPage** **correspondence.** Where FAQPage markup exists (S10), verify every marked-up Question/acceptedAnswer pair appears in visible content, and conversely that visible Q\&A blocks are marked up. The FAQ rich result is retired; this is an extraction-quality and content-policy check, not a rich-result eligibility check.

* R-3.1-18 — **speakable** **selector resolution.** Where a speakable specification is present, verify each selector resolves to an element in the rendered DOM. A speakable selector that resolves to nothing is worse than none.

* R-3.1-19 — **Identity anchoring.** Organization.sameAs must be present and carry at least schema.min\_sameas (default 2\) resolving profile URLs. An entity name that is a common word, or that collides with a well-known different entity, raises the requirement: without sameAs there is nothing for a retrieval system to resolve against. Where page\_type is blog\_article or author, an author named in visible text must also carry a Person node referenced from the Article’s author property.

* R-3.1-20 — **Schema/visible date parity.** A datePublished or dateModified present in markup but not shown anywhere in the rendered page is a weaker signal than one a reader can see. Report the parity; the date’s *value* is assessed in C-6.5.

* R-3.1-21 — **Corrected-markup output.** For every FAIL, emit a minimal corrected JSON-LD fragment containing only the fields the tool observed or can derive from the page. Never invent a value. Fields that cannot be derived are emitted as “\<REQUIRED — supply value\>” placeholders in a clearly-labelled template, never as fabricated data.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-3.1-a | All in-scope types expected for this page\_type are present, parse, have required fields, resolved @ids, and align with visible content | PASS | — | — |
| C-3.1-b | No structured data of any kind on the page | FAIL | HIGH | NO\_STRUCTURED\_DATA |
| C-3.1-c | JSON-LD block fails to parse | FAIL | HIGH | JSONLD\_PARSE\_ERROR |
| C-3.1-d | An in-scope type is missing a tool-required field | FAIL | HIGH | SCHEMA\_REQUIRED\_FIELD\_MISSING |
| C-3.1-e | @id reference does not resolve within the page graph | FAIL | HIGH | SCHEMA\_DANGLING\_REFERENCE |
| C-3.1-f | S1/S2 @id differs across sampled pages | FAIL | HIGH | SCHEMA\_UNSTABLE\_ENTITY\_ID |
| C-3.1-g | \> 1 Organization or WebSite node with conflicting values on one page | FAIL | HIGH | SCHEMA\_DUPLICATE\_ENTITY |
| C-3.1-h | S3 url ≠ page canonical | FAIL | MEDIUM | SCHEMA\_URL\_CANONICAL\_MISMATCH |
| C-3.1-i | Marked-up value absent from visible content (R-3.1-8) | FAIL | HIGH | SCHEMA\_CONTENT\_MISMATCH — violates Google’s structured-data policy |
| C-3.1-j | Type used on an inappropriate page (R-3.1-9) | FAIL | MEDIUM | SCHEMA\_TYPE\_MISUSE |
| C-3.1-k | Property casing invalid (Url, Name, …) | FAIL | MEDIUM | SCHEMA\_INVALID\_PROPERTY\_CASE |
| C-3.1-l | Placeholder value detected | WARN | MEDIUM | SCHEMA\_PLACEHOLDER\_VALUE |
| C-3.1-m | Date invalid, or dateModified \< datePublished, or future-dated | WARN | MEDIUM | SCHEMA\_INVALID\_DATE |
| C-3.1-n | Structured data present in RENDERED only | WARN | HIGH | SCHEMA\_JS\_INJECTED |
| C-3.1-o | RAW and RENDERED graphs differ materially | WARN | MEDIUM | SCHEMA\_RAW\_RENDERED\_MISMATCH |
| C-3.1-p | Page is noindex/robots-blocked and carries structured data | WARN | MEDIUM | SCHEMA\_ON\_BLOCKED\_PAGE |
| C-3.1-q | Out-of-scope type present | INFO → PASS | — | SCHEMA\_OUT\_OF\_SCOPE\_DETECTED — inventoried only, never validated |
| C-3.1-r | FAQPage present but malformed | WARN | LOW | FAQ\_MARKUP\_INVALID — no rich result since 7 May 2026; retained for extraction value only |
| C-3.1-s | Expected in-scope type absent for this page\_type (e.g. no BreadcrumbList on a deep page) | WARN | MEDIUM | SCHEMA\_TYPE\_ABSENT |
| C-3.1-t | No Organization (or Person, on a personal site) node anywhere in the page graph | FAIL | HIGH | NO\_ENTITY\_MARKUP |
| C-3.1-u | FAQPage markup does not correspond to visible Q\&A | FAIL | HIGH | FAQ\_MARKUP\_CONTENT\_MISMATCH — violates Google’s structured-data content policy |
| C-3.1-v | Visible Q\&A block with no FAQPage markup | WARN | LOW | FAQ\_NOT\_MARKED\_UP — no rich result available since 7 May 2026; extraction value only |
| C-3.1-w | speakable selector resolves to nothing | FAIL | MEDIUM | SPEAKABLE\_SELECTOR\_UNRESOLVED |
| C-3.1-x | sameAs absent, or fewer than schema.min\_sameas resolving profiles | WARN | MEDIUM | WEAK\_ENTITY\_ANCHORING |
| C-3.1-y | Entity name is ambiguous and sameAs is absent | WARN | HIGH | AMBIGUOUS\_ENTITY\_UNANCHORED |
| C-3.1-z | Author named in visible text but no Person node referenced from author | WARN | LOW | NO\_AUTHOR\_MARKUP |
| C-3.1-aa | Date present in markup but not visible on the page | WARN | LOW | DATE\_NOT\_USER\_VISIBLE |

### **EXCEPTIONAL CONDITIONS**

* E-3.1-1 — **Organization** **on the homepage only.** Google recommends placing it on the home page or a single page describing the organisation, and says it need not be on every page. Absence on inner pages is **not** a finding. Only S3’s about/publisher reference to S1’s @id is expected there.

* E-3.1-2 — **A more specific** **Organization** **subtype** (OnlineStore, LocalBusiness, NGO, EducationalOrganization). Google recommends the most specific matching subtype. Accept any subtype of Organization as satisfying S1.

* E-3.1-3 — **Multiple** **Article** **nodes on a list page.** Not S5 misuse if the page is a category template and the nodes are inside an ItemList. Exclude from C-3.1-j.

* E-3.1-4 — **Product** **on a category page inside** **ItemList.** Legitimate list markup. C-3.1-j fires only for a standalone Product node on a list template.

* E-3.1-5 — **FAQPage** **absent.** Never a finding (see S10 note).

* E-3.1-6 — **BreadcrumbList** **absent on the homepage.** Correct — the homepage is the breadcrumb root. C-3.1-s applies only to non-home pages.

* E-3.1-7 — **@id** **without a fragment** (e.g. “@id”: “https://example.com/about/” rather than …\#webpage). Valid JSON-LD. Report as WARN/LOW SCHEMA\_ID\_NO\_FRAGMENT — it risks collision with the WebPage’s url and with other node types on the same URL — never as FAIL.

* E-3.1-8 — **Schema injected by a CMS plugin (Yoast, RankMath, Slice, etc.) alongside a theme-level block.** Duplicates are real findings (C-3.1-g), but the remediation text must recommend modifying the plugin’s graph through its supported filters rather than emitting a second

* block.

* E-3.1-9 — **sameAs** **pointing to profiles on platforms the tool cannot reach** (login-gated). Do not FAIL on unreachability; validate URL shape only, and caveat.

* E-3.1-10 — **Prices differing between markup and visible text because of currency/locale switching.** Compare the numeric value and currency code; ignore formatting and separators. Where a locale switcher is detected, downgrade C-3.1-i for price to WARN.

* E-3.1-11 — **dateModified** **equal to** **datePublished.** Correct for a never-updated page. Not a finding. (C-6.5 handles freshness.)

* E-3.1-12 — **A single-page site declaring S1, S2 and S3 on one URL.** Correct. All three are expected on the one page.

* E-3.1-13 — **Person** **node used as** **author** **referencing an off-site profile.** Valid. C-3.1-e does not fire when the @id is an absolute URL that is declared as a node elsewhere in the same graph; it does fire when nothing declares it.

* E-3.1-15 — **sameAs** **profiles that are login-gated.** Shape-valid but unreachable. Count toward the profile total, with an unverified note.

* E-3.1-14 — **Structured data inside** **.** Detect and report as SCHEMA\_IN\_NOSCRIPT; treat as present but flag the unusual placement.

### **BACKUP PLANS**

* B-3.1-1 — JSON-LD parse fails → attempt a lenient parse (trailing commas, unescaped newlines, HTML entities in strings, single quotes). If lenient parsing succeeds, report JSONLD\_PARSE\_ERROR at WARN with the specific syntax fault named and continue validating the recovered object. Google’s parser is not lenient; the status must not be upgraded to PASS.

* B-3.1-2 — RENDERED unavailable → validate RAW only; C-3.1-n/C-3.1-o → NOT\_TESTABLE; JS caveat.

* B-3.1-3 — Visible-content extraction fails (heavy JS, consent wall) → C-3.1-i → NOT\_TESTABLE, never PASS.

* B-3.1-4 — Cross-page @id comparison impossible (\< 2 pages sampled) → C-3.1-f → NOT\_APPLICABLE / INSUFFICIENT\_SAMPLE.

* B-3.1-5 — Microdata/RDFa extraction library unavailable → report JSON-LD findings and set SYNTAX\_COVERAGE\_PARTIAL; do not claim “no structured data” when other syntaxes were not inspected.

### **FAILING & STOPPING PLAN**

* F-3.1-1 — **Never validate a type outside** **schema.fixed\_set.** Out-of-scope types are inventoried only. This is the checklist’s explicit boundary.

* F-3.1-2 — Never invent field values in remediation output. Underivable fields are labelled placeholders.

* F-3.1-3 — Never report a Google *rich-result* eligibility claim for a type whose rich result has been retired. FAQ findings must carry the retirement note.

* F-3.1-4 — Never call the tool’s required-field list a Google requirement where Google documents none (notably Organization).

* F-3.1-5 — A parse failure in one JSON-LD block never aborts evaluation of the others.

* F-3.1-6 — Never recommend adding a second JSON-LD block where a plugin already emits one; recommend modifying the existing graph.

* F-3.1-7 — Never claim validation by Google’s Rich Results Test or the schema.org validator unless those tools were actually called; if they were not, say the validation is this tool’s own.

---

## **C-3.2 — Hreflang**

**Scope:** site \+ page · **Profile:** RAW \+ headers **Checklist constraint:** *“Check only for the multilingual Website otherwise ignore”*

**Standing caveat, mandatory on every result where** **is\_multilingual \= true:** “Hreflang findings reflect HTML

and HTTP Link header annotations only.”

### **RULES**

* R-3.2-1 — **Applicability gate, evaluated first.** If is\_multilingual \= false per R-A0-7 → NOT\_APPLICABLE / MONOLINGUAL\_SITE. Emit no sub-findings, no score contribution. Record which detection signals were evaluated and all returned negative, so the decision is auditable.

* R-3.2-2 — Collect annotations from the two in-scope mechanisms, kept separate:

1.  in

2. Link: ; rel=“alternate”; hreflang=“…” response headers

* R-3.2-3 — **Do not mix mechanisms for one URL set.** Where two mechanisms both annotate the same URL, record it and check for agreement; disagreement is a finding.

* R-3.2-4 — **Value validation.** hreflang must be: a valid ISO 639-1 language code; optionally \- plus a valid ISO 3166-1 Alpha-2 region; or the literal x-default. A region code alone is invalid. Explicitly reject the common invalid values UK (the region code is GB), EU, UN, and any 3-letter language code where a 2-letter ISO 639-1 code exists.

* R-3.2-5 — **Self-reference.** Every page in a cluster must include an annotation pointing at itself with its own language code.

* R-3.2-6 — **Return links (bidirectionality).** For every annotated alternate, fetch it and confirm it annotates back to the source with the source’s language code. If two pages do not both point to each other, the annotations are ignored — this is the single most consequential hreflang rule.

* R-3.2-7 — **URL form.** All href values must be fully-qualified absolute URLs including the transport method. Protocol-relative (//host/path) and relative values are invalid.

* R-3.2-8 — **Target health.** Each alternate must return 200, not be noindex, not be robots-disallowed, and not redirect.

* R-3.2-9 — **Canonical consistency.** Within a cluster, each page’s canonical must point to a page in the same language (its own URL in the normal case). A canonical pointing at another language’s URL collapses the cluster.

* R-3.2-10 — **x-default.** Report presence. Absence is a WARN, not a FAIL — it is recommended, not required.

* R-3.2-11 — **Duplicate codes.** The same hreflang value pointing at two different URLs within one cluster is a conflict.

* R-3.2-12 — \*\*

* \*\* **consistency.** Compare the page’s declared hreflang self-reference with its

* attribute; mismatch is a WARN.

* R-3.2-13 — **Cluster assembly.** Build clusters from the union of all annotations across sampled pages, then compute per-cluster: member count, reciprocity matrix, missing return links, and orphaned members.

* R-3.2-14 — Budget: fetch at most hreflang.max\_alternates (default 15\) alternate URLs per run for return-link verification, prioritised by cluster size.

* R-3.2-15 — **Report routing.** Four conditions in this check describe crawl- and index-level breakage rather than internationalisation quality, and are emitted with report\_section \= “Crawl & Indexing”: C-3.2-d (HREFLANG\_NO\_RETURN\_LINK), C-3.2-i (HREFLANG\_TARGET\_BROKEN), C-3.2-k (HREFLANG\_CANONICAL\_CONFLICT) and C-3.2-l (HREFLANG\_DUPLICATE\_CODE). They are detected here, reported under Section 1, and scored into Section 1 (R-SCORE-9). Every other condition in this check reports under Structured & International. A finding is never counted in both sections.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-3.2-a | is\_multilingual \= false | NOT\_APPLICABLE | — | MONOLINGUAL\_SITE |
| C-3.2-b | Multilingual, annotations present, all codes valid, all self-referencing, all return links present, all targets 200 and indexable | PASS | — | — |
| C-3.2-c | Multilingual signals present but no hreflang annotations in HTML  | WARN | HIGH | HREFLANG\_NOT\_FOUND\_IN\_HTML\_OR\_HEADERS — WARN, not FAIL: absence from the two evaluated mechanisms does not prove hreflang is undeclared |
| C-3.2-d | ≥ 1 missing return link, where the alternate publishes its own HTML/header hreflang set and that set omits the source | FAIL | CRITICAL | HREFLANG\_NO\_RETURN\_LINK — non-reciprocal annotations are ignored entirely · **reported under Section 1 — Crawl & Indexing** (R-3.2-15) |
| C-3.2-e | Missing self-reference | FAIL | HIGH | HREFLANG\_NO\_SELF\_REFERENCE |
| C-3.2-f | Invalid language or region code | FAIL | HIGH | HREFLANG\_INVALID\_CODE |
| C-3.2-g | Region code without a language (hreflang=“us”) | FAIL | HIGH | HREFLANG\_REGION\_ONLY |
| C-3.2-h | href relative or protocol-relative | FAIL | HIGH | HREFLANG\_RELATIVE\_URL |
| C-3.2-i | Alternate returns 4xx/5xx | FAIL | HIGH | HREFLANG\_TARGET\_BROKEN · **reported under Section 1 — Crawl & Indexing** (R-3.2-15) |
| C-3.2-j | Alternate is noindex or robots-blocked | FAIL | HIGH | HREFLANG\_TARGET\_NONINDEXABLE |
| C-3.2-k | Canonical points to a different language within the cluster | FAIL | CRITICAL | HREFLANG\_CANONICAL\_CONFLICT · **reported under Section 1 — Crawl & Indexing** (R-3.2-15) |
| C-3.2-l | Same code mapped to two URLs in one cluster | FAIL | HIGH | HREFLANG\_DUPLICATE\_CODE · **reported under Section 1 — Crawl & Indexing** (R-3.2-15) |
| C-3.2-m | No x-default in the cluster | WARN | LOW | HREFLANG\_NO\_X\_DEFAULT |
| C-3.2-n |  | WARN | MEDIUM | HREFLANG\_HTML\_LANG\_MISMATCH |
| C-3.2-o | Two mechanisms annotate the same URL with different sets | WARN | HIGH | HREFLANG\_MECHANISM\_CONFLICT |
| C-3.2-p | Annotations present in RENDERED only | WARN | HIGH | HREFLANG\_JS\_INJECTED |
| C-3.2-q | Cluster has only one member | WARN | MEDIUM | HREFLANG\_SINGLETON\_CLUSTER |
| C-3.2-r | hreflang in  | FAIL | HIGH | HREFLANG\_IN\_BODY |
| C-3.2-s | The alternate publishes no HTML or header hreflang at all, so no return link can be verified for that pair | NOT\_TESTABLE for that pair | — | HREFLANG\_RETURN\_LINK\_UNVERIFIABLE |

### **EXCEPTIONAL CONDITIONS**

* E-3.2-1 — **Monolingual site with a single** \*\*

* \*\* **and no alternates.** NOT\_APPLICABLE. Do not manufacture a finding.

* E-3.2-2 — **A site with two languages served on separate ccTLDs.** Cross-host annotations are correct and expected. Never flag as cross-domain misuse.

* E-3.2-3 — **x-default** **pointing to a language selector page.** Its documented purpose. PASS.

* E-3.2-4 — **en** **and** **en-GB** **both present.** Valid: a language-only and a language-region entry may coexist.

* E-3.2-5 — **Return link present in the other in-scope mechanism** (source uses HTML, target uses a Link header, or vice versa). Reciprocity is satisfied. R-3.2-6 must check both in-scope mechanisms before declaring a missing return link — checking only HTML produces mass false positives. A return link that could exist only in a sitemap is handled by C-3.2-s, never by C-3.2-d.

* E-3.2-6 — **Alternate temporarily unreachable.** NOT\_TESTABLE for that alternate, not C-3.2-i. Only a definite 4xx/5xx counts.

* E-3.2-7 — **Partial translation** — some pages exist in only one language. Correct; the cluster simply has fewer members. Only a *declared* alternate that is missing is a finding.

* E-3.2-8 — **Geo-IP redirect on alternates.** The tool crawls from one location; an alternate may redirect it. Record HREFLANG\_GEO\_REDIRECT and note that Google generally crawls from the US and is subject to the same behaviour, which is why geo-redirects are discouraged alongside hreflang.

* E-3.2-9 — **hreflang** **on a paginated series.** Each page annotates its own translation, not page 1\. Not a finding.

* E-3.2-10 — **Script subtags** (zh-Hant, zh-Hans). Valid BCP-47 beyond the language-region pattern. Accept script subtags; do not reject as invalid.

* E-3.2-11 — **More than 40 alternates in a cluster.** Budget cap applies; verify a prioritised subset and report HREFLANG\_VERIFICATION\_SAMPLED with the true count.

### **BACKUP PLANS**

* B-3.2-1 — HTML annotations absent → check response headers before declaring C-3.2-c.

* B-3.2-2 — Return-link verification blocked by rate limiting → verify the largest cluster only; the rest NOT\_TESTABLE / HREFLANG\_VERIFICATION\_INCOMPLETE.

* B-3.2-3 — is\_multilingual detection ambiguous (exactly one weak signal, e.g. a single /es/ path with no annotations) → run the check in **advisory mode**: report the observed multilingual signal and the absence of hreflang as WARN/MEDIUM HREFLANG\_POSSIBLY\_MISSING, never FAIL.

### **FAILING & STOPPING PLAN**

* F-3.2-1 — Hard NOT\_APPLICABLE for monolingual sites. No partial scoring, no advisory noise.

* F-3.2-2 — Never emit C-3.2-d without having actually fetched the alternate and inspected both in-scope mechanisms (HTML

* , Link header) on it — and never when the alternate publishes neither (C-3.2-s).

* F-3.2-3 — Cap alternate fetches at hreflang.max\_alternates; report the cap.

* F-3.2-4 — Never recommend hreflang for a site that has one language.

* F-3.2-5 — Never treat a valid script subtag as an invalid code.

* F-3.2-6 — If C-3.2-k fires, the corresponding C-1.5 result must carry a cross-reference — a canonical conflict inside an hreflang cluster is a canonical finding as much as an international one.

---

# **SECTION 4 — PERFORMANCE**

---

## **C-4.1 — Core Web Vitals**

**Scope:** page \+ origin · **Data sources:** CrUX field data → PSI → local Lighthouse **Confidence:** THIRD\_PARTY (field) / MODELLED (lab)

**Standing caveats, mandatory on every result:**

* Field data is a **28-day rolling aggregate** of real users, updated daily, lagging roughly two days, and segmented by form factor. It is not a live measurement and does not reflect changes made this week.

* Lab data is a **single synthetic run** from one location on one simulated device. It **does not** determine whether a page passes Core Web Vitals. It is diagnostic only.

* A page or origin with insufficient traffic has **no** field data. That is not a performance failure; it is an absence of data.

### **4.1.0 — Metrics and thresholds**

| Metric | Good | Needs improvement | Poor | Assessed at |
| :---- | :---- | :---- | :---- | :---- |
| **LCP** — Largest Contentful Paint | ≤ 2,500 ms | 2,500–4,000 ms | \> 4,000 ms | 75th percentile |
| **INP** — Interaction to Next Paint | ≤ 200 ms | 200–500 ms | \> 500 ms | 75th percentile |
| **CLS** — Cumulative Layout Shift | ≤ 0.10 | 0.10–0.25 | \> 0.25 | 75th percentile |

INP replaced FID as the responsiveness Core Web Vital and became a stable Core Web Vital in 2024; FID must not be reported as a current Core Web Vital. Assessment is at the 75th percentile, segmented across mobile and desktop. Supporting (non-Core) metrics the tool may report for diagnosis but must never score: TTFB, FCP, and Lighthouse’s lab-only composite performance score.

R-4.1-0 — The tool must not invent, anticipate, or score against unannounced metric changes. If the threshold registry is updated, it is updated in §2.3 with a dated source, and the report states which threshold set was applied.

### **RULES**

* R-4.1-1 — **Form factors.** Evaluate PHONE and DESKTOP independently and report both. Never blend them into one verdict — Google assesses them separately.

* R-4.1-2 — **Data ladder, per URL** (stop at the first that returns data; record which rung supplied it):

1. **CrUX URL-level field data** for that exact URL — the authoritative source.

2. **CrUX origin-level field data** — clearly labelled as origin, not page.

3. **PSI lab (Lighthouse) run** — diagnostic only.

4. **Local Lighthouse run** — diagnostic only, and additionally caveated for network variance.

* R-4.1-3 — **CrUX request shape.** POST https://chromeuxreport.googleapis.com/v1/records:queryRecord with {url | origin}, formFactor ∈ {PHONE, DESKTOP, TABLET}, and metrics: \[largest\_contentful\_paint, interaction\_to\_next\_paint, cumulative\_layout\_shift, first\_contentful\_paint, experimental\_time\_to\_first\_byte\]. Read record.metrics\[\*\].percentiles.p75, the histogram densities, record.key, collectionPeriod.firstDate/lastDate, and urlNormalizationDetails. Rate limit: 150 queries per minute per project — the tool must stay under it, not discover it.

* R-4.1-4 — **PSI request shape.** GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed with url, strategy ∈ {mobile, desktop}, category=performance, key. Read loadingExperience (URL-level field), originLoadingExperience (origin-level field), and lighthouseResult (lab). overall\_category ∈ {FAST, AVERAGE, SLOW, NONE}; NONE means no field data, which the tool must render as “no field data”, never as a poor score.

* R-4.1-5 — **URL normalisation.** CrUX normalises URLs and does not follow redirects. Always query the page’s **final, canonical** URL. If urlNormalizationDetails shows the queried URL was altered, report the normalised URL that actually supplied the data.

* R-4.1-6 — **Never mix rungs within one verdict.** A page’s verdict comes from one rung. If LCP has field data and INP does not, report LCP as field and INP as NO\_FIELD\_DATA — do not substitute a lab INP into a field verdict.

* R-4.1-7 — **Verdict computation.** A form factor passes only when all three Core Web Vitals are in the Good band at p75. Any metric in Needs improvement or Poor fails the assessment; report the specific metric and its p75 value.

* R-4.1-8 — **Distribution reporting.** Always report the good / needs-improvement / poor density split alongside p75. A p75 just over a threshold with 74% good is a different problem from one with 40% good, and the p75 alone hides that.

* R-4.1-9 — **Lab diagnostics.** When a lab run is available, extract the actionable audits — LCP element and its subparts (TTFB, resource load delay, load duration, render delay), render-blocking resources, unsized images and injected elements causing shifts, long tasks, total blocking time, third-party script weight. These are diagnosis, never scoring.

* R-4.1-10 — **Budget.** Cap total CWV API calls at cwv.max\_calls (default 24 \= up to 10 URLs × 2 form factors \+ origin queries \+ margin). Prioritise: origin (both form factors) → homepage → the remaining sampled pages in page\_type rank order.

* R-4.1-11 — Record collectionPeriod on every field result and surface it in the report. A reader must be able to see the window the numbers describe.

* R-4.1-12 — Report navigation\_types and form\_factors fractions where available, since a high proportion of cache- or back-forward navigations materially changes how LCP should be read.

### **CONDITIONS**

Evaluated per URL per form factor.

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-4.1-a | Field data present; LCP ≤ 2500, INP ≤ 200, CLS ≤ 0.10 at p75 | PASS | — | — |
| C-4.1-b | Field data present; any metric in the Poor band | FAIL | HIGH | CWV\_POOR (+ metric name) |
| C-4.1-c | Field data present; any metric in Needs-improvement, none Poor | WARN | MEDIUM | CWV\_NEEDS\_IMPROVEMENT (+ metric name) |
| C-4.1-d | No URL-level field data; origin-level available and all Good | PASS | — | CWV\_ORIGIN\_LEVEL\_ONLY — verdict describes the origin, not this page |
| C-4.1-e | No URL-level field data; origin-level available and failing | WARN | MEDIUM | CWV\_ORIGIN\_LEVEL\_FAILING — page-specific verdict unavailable |
| C-4.1-f | No field data at any level; lab data available | NOT\_TESTABLE for assessment; lab reported as diagnostics | — | CWV\_NO\_FIELD\_DATA |
| C-4.1-g | No field data, no lab data | NOT\_TESTABLE | — | CWV\_NO\_DATA |
| C-4.1-h | CrUX returns 404 (record not found) | Fall to next rung | — | CRUX\_RECORD\_NOT\_FOUND — expected for low-traffic URLs, **not** an error |
| C-4.1-i | API quota exhausted / 429 | NOT\_TESTABLE | — | CWV\_QUOTA\_EXHAUSTED |
| C-4.1-j | API key missing or invalid | NOT\_TESTABLE | — | CWV\_NO\_API\_KEY |
| C-4.1-k | Lab run fails (page did not load, timed out) | NOT\_TESTABLE | — | LAB\_RUN\_FAILED |
| C-4.1-l | Field p75 Good but \> 25% of samples in Poor | WARN | LOW | CWV\_LONG\_TAIL — passes assessment, but a quarter of visits are poor |
| C-4.1-m | Mobile passes, desktop fails (or vice versa) | Report both; overall \= worse of the two |  | CWV\_FORM\_FACTOR\_DIVERGENCE |
| C-4.1-n | collectionPeriod ends \> 5 days before run date | WARN | LOW | CWV\_DATA\_STALE |

R-4.1-13 — The site-level CWV verdict is the **origin-level** field assessment, not an average of sampled pages. Averaging page verdicts produces a number that corresponds to nothing Google computes.

### **EXCEPTIONAL CONDITIONS**

* E-4.1-1 — **New or low-traffic site.** No field data is the norm, not a defect. C-4.1-f, and the report says so plainly: “Insufficient real-user traffic for field data. Lab diagnostics only.”

* E-4.1-2 — **Page behind authentication or a paywall.** Lab run will fail; field data may exist. Report field only; LAB\_RUN\_FAILED is expected, not a finding.

* E-4.1-3 — **URL normalisation changed the queried URL.** Report the normalised URL; not a defect.

* E-4.1-4 — **Origin data exists, URL data does not.** Extremely common. C-4.1-d/C-4.1-e, always labelled as origin-scope.

* E-4.1-5 — **CLS 0 with no layout-shift entries.** Legitimate for static pages. Not suspicious.

* E-4.1-6 — **INP absent from field data** (very low interaction volume). Report LCP/CLS verdicts and INP as NO\_FIELD\_DATA. Do not fail the page for a metric with no samples.

* E-4.1-7 — **A/B tests or personalisation** producing lab variance between runs. Note LAB\_VARIANCE\_POSSIBLE; never average multiple lab runs into a pseudo-field number.

* E-4.1-8 — **Consent banner suppressing LCP content in lab.** Record LAB\_CONSENT\_INTERFERENCE; lab LCP is unreliable here and must be labelled so.

* E-4.1-9 — **A redirecting URL.** Query the final URL (R-4.1-5). Querying the redirecting URL returns nothing and would be misreported as no data.

* E-4.1-10 — **TABLET form factor.** Available in CrUX but not part of the standard assessment. Report only if explicitly requested.

* E-4.1-11 — **The page is a PDF or non-HTML.** NOT\_APPLICABLE — Core Web Vitals do not apply.

### **BACKUP PLANS**

* B-4.1-1 — CrUX URL-level 404 → CrUX origin-level.

* B-4.1-2 — CrUX unavailable entirely → PSI, which returns loadingExperience/originLoadingExperience (the same CrUX data) plus lab in one call.

* B-4.1-3 — PSI unavailable → local Lighthouse (Chromium already provisioned), with the strongest caveat: local network conditions differ from PSI’s, so lab numbers are not comparable to PSI’s.

* B-4.1-4 — All sources unavailable → C-4.1-g. Report the mechanism failure, not a site failure.

* B-4.1-5 — Quota exhausted mid-run → prioritise origin \+ homepage; remaining pages NOT\_TESTABLE / CWV\_QUOTA\_EXHAUSTED.

* B-4.1-6 — Transient 5xx from an API → standard retry ladder before declaring unavailability.

### **FAILING & STOPPING PLAN**

* F-4.1-1 — **Never present lab data as a Core Web Vitals assessment.** Lab is diagnostic. Any UI or export that shows a lab number in a pass/fail position is a defect.

* F-4.1-2 — **Never report FID** as a current Core Web Vital.

* F-4.1-3 — Never average p75 values across pages into a “site score”.

* F-4.1-4 — Never report absence of field data as poor performance.

* F-4.1-5 — Never exceed the CrUX rate limit (150 queries/minute/project) or cwv.max\_calls.

* F-4.1-6 — Never omit collectionPeriod from a field result.

* F-4.1-7 — Never mix form factors in a single verdict.

* F-4.1-8 — Never make a performance recommendation that is not traceable to a specific lab audit or field metric in evidence.

---

# **SECTION 5 — LLM / AI ACCESS**

**Section-wide accuracy note, which must appear in the report once:** Google states there are no additional requirements to appear in AI Overviews or AI Mode, and that publishers do not need to create new machine-readable files, “AI text files”, or markup for those surfaces. llms.txt and an AI-instructions page are therefore scored here as **optional, additive practices** aimed at non-Google assistants and at retrieval clarity — never as Google requirements. Any finding in this section that implies otherwise is a defect in the tool.

---

## **C-5.1 — AI Crawler Access**

**Scope:** site · **Profile:** RAW · **Depends on:** C-1.1

### **5.1.0 — Agent registry**

ai\_agents.registry — configurable; defaults below. Each entry: {token, vendor, purpose, respects\_robots, verification\_source}.

| Token | Vendor | Purpose | Respects robots.txt | Verification |
| :---- | :---- | :---- | :---- | :---- |
| GPTBot | OpenAI | Foundation-model training | Yes | openai.com/gptbot.json |
| OAI-SearchBot | OpenAI | Surfacing sites in ChatGPT search | Yes | openai.com/searchbot.json |
| ChatGPT-User | OpenAI | User-initiated fetches | **Vendor states robots.txt rules may not apply**, as actions are user-initiated | openai.com/chatgpt-user.json |
| OAI-AdsBot | OpenAI | Ad landing-page safety validation | Yes | openai.com/adsbot.json |
| ClaudeBot | Anthropic | Model training | Yes | claude.com/crawling/bots.json |
| Claude-SearchBot | Anthropic | Search-quality analysis | Yes | same |
| Claude-User | Anthropic | User-initiated fetches | Yes | same |
| PerplexityBot | Perplexity | Search indexing/linking; not model training | Yes | perplexity.com/perplexitybot.json |
| Perplexity-User | Perplexity | User-initiated fetches | **Vendor states it generally ignores robots.txt** | perplexity.com/perplexity-user.json |
| Google-Extended | Google | **Control token only** — governs use of crawled content for Gemini training and grounding | n/a — see note | — |
| Applebot | Apple | Siri/Spotlight search | Yes | — |
| Applebot-Extended | Apple | **Control token only** — governs training use of already-crawled content | n/a — see note | — |
| CCBot | Common Crawl | Open crawl corpus (a common upstream for AI training sets) | Yes | index.commoncrawl.org/ccbot.json |
| Bytespider, Amazonbot, meta-externalagent, cohere-ai, Diffbot, omgili, Timpibot | various | Training / retrieval | varies | vendor-published |

**Binding notes the tool must reproduce in findings, because they are the two most-misunderstood entries:**

* Google-Extended has **no separate HTTP user-agent string**; crawling is done with existing Google user agents and the robots.txt token acts purely as a control. Disallowing it **does not** affect a site’s inclusion in Google Search and is **not** a ranking signal. It governs Gemini training and grounding.

* Applebot-Extended **does not crawl**. Pages that disallow it can still appear in Apple search surfaces.

Consequently: blocking either token is a **content-licensing decision, not an SEO defect**, and must be reported as an informational disclosure with its actual consequence stated — never as a FAIL.

### **RULES**

* R-5.1-1 — For every token in the registry, evaluate / and each sampled page path against the parsed robots.txt using R-A2-1 group selection. Produce a matrix: {token × path → ALLOWED | DISALLOWED | NO\_RULE}.

* R-5.1-2 — Distinguish three states, never two: an explicit Allow, an explicit Disallow, and no rule at all (which means allowed, but signals no deliberate decision).

* R-5.1-3 — Detect blocking outside robots.txt, since robots.txt is only the polite layer:

* X-Robots-Tag per-agent directives naming an AI token.

* Where cap.ua\_probe \= true: fetch the homepage with each of up to ai\_agents.max\_probes (default 6\) vendor UA strings and compare status and body hash against the baseline. A differing status (403/404/429) or a materially different body indicates server- or WAF-level blocking. **This probe is a diagnostic only** — it uses an unverified UA, so the finding carries the R-FETCH-7 caveat and confidence \= DERIVED.

* R-5.1-4 — Parse Content-Signal: declarations (search, ai-input, ai-train, each yes/no) within each user-agent group. Report them as declarations of intent. They are advisory: they express permission, they do not enforce it.

* R-5.1-5 — Cross-reference C-1.6: nosnippet and max-snippet limit or prevent content being used as a direct input for Google’s AI Overviews and AI Mode. A site can therefore be fully crawlable and still be excluded from those surfaces by its own snippet directives. Surface this explicitly.

* R-5.1-6 — Detect the coverage gap where robots.txt has a Googlebot group and a \* group but no AI-specific groups — meaning AI agents inherit \*, usually unintentionally.

* R-5.1-7 — Compute a per-vendor access\_posture ∈ {OPEN, PARTIAL, BLOCKED, UNDECLARED} and a site-level summary. UNDECLARED is its own state and must not be rendered as OPEN.

* R-5.1-8 — Detect blocks on paths that matter for retrieval (/blog/, /docs/, /resources/) versus paths that do not (/cart/, /account/). A block on the latter is normal hygiene.

* R-5.1-9 — Report crawl-delay values aimed at AI tokens: some vendors honour them, Google does not support the directive at all. Report per-vendor rather than as a single verdict.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-5.1-a | All retrieval-oriented agents (OAI-SearchBot, Claude-SearchBot, PerplexityBot, Applebot) allowed on content paths | PASS | — | — |
| C-5.1-b | ≥ 1 retrieval-oriented agent blocked site-wide | FAIL | HIGH | AI\_RETRIEVAL\_AGENT\_BLOCKED |
| C-5.1-c | All AI agents blocked site-wide | FAIL | HIGH | ALL\_AI\_AGENTS\_BLOCKED — legitimate if deliberate; the finding must ask whether it is |
| C-5.1-d | Training-only agents (GPTBot, ClaudeBot, CCBot) blocked; retrieval agents allowed | PASS | — | AI\_TRAINING\_BLOCKED\_BY\_CHOICE — a licensing decision, reported not scored |
| C-5.1-e | Google-Extended disallowed | PASS | — | GOOGLE\_EXTENDED\_DISALLOWED — informational; no effect on Google Search inclusion or ranking |
| C-5.1-f | Applebot-Extended disallowed | PASS | — | APPLEBOT\_EXTENDED\_DISALLOWED — informational; no effect on Apple search visibility |
| C-5.1-g | No AI-specific groups; agents inherit \* which is permissive | WARN | LOW | AI\_ACCESS\_UNDECLARED |
| C-5.1-h | No AI-specific groups; \* group is Disallow: / | FAIL | CRITICAL | AI\_BLOCKED\_BY\_WILDCARD — usually unintended collateral of a Googlebot-focused rule |
| C-5.1-i | UA probe shows a 403/404 where robots.txt allows | WARN | HIGH | AI\_BLOCKED\_AT\_SERVER — carries the unverified-UA caveat |
| C-5.1-j | nosnippet / max-snippet:0 on sampled content pages | WARN | HIGH | AI\_INPUT\_SUPPRESSED\_BY\_SNIPPET\_DIRECTIVE |
| C-5.1-k | Content-Signal present and internally consistent | PASS | — | CONTENT\_SIGNAL\_DECLARED |
| C-5.1-l | Content-Signal contradicts the robots rules in the same group (e.g. ai-train=yes while GPTBot is disallowed) | WARN | LOW | CONTENT\_SIGNAL\_CONTRADICTION |
| C-5.1-m | Blocking rules target content paths that carry the site’s substantive material | FAIL | HIGH | AI\_BLOCKED\_ON\_CONTENT\_PATHS |
| C-5.1-n | robots.txt unavailable | NOT\_TESTABLE | — | ROBOTS\_UNAVAILABLE |

### **EXCEPTIONAL CONDITIONS**

* E-5.1-1 — **Deliberate AI blocking as policy** (publishers, licensed data). Report the posture accurately; do not recommend unblocking. Where policy.ai\_blocking\_intentional \= true, C-5.1-b/C-5.1-c downgrade to INFO.

* E-5.1-2 — **Blocking training agents while allowing retrieval agents.** A coherent and increasingly common posture. Never a defect (C-5.1-d).

* E-5.1-3 — **ChatGPT-User** **/** **Perplexity-User** **disallowed.** Both vendors document that user-initiated fetchers may not apply robots.txt rules. Report the declaration and note that it may not be honoured for user-triggered requests. Do not present the rule as effective.

* E-5.1-4 — **A CDN-managed robots.txt** (e.g. a managed AI-bot ruleset). Detect the signature and note that rules may be platform-managed rather than authored by the site owner — remediation goes through the platform’s dashboard.

* E-5.1-5 — **WAF challenge rather than a hard block.** UA probe returns 503 or a JS challenge. Report as AI\_CHALLENGE\_NOT\_BLOCK; whether an agent passes it is unknown and must be stated as unknown.

* E-5.1-6 — **New agent token not in the registry.** Detect unknown User-agent tokens in robots.txt and list them as UNKNOWN\_AGENT\_RULES. Never guess a vendor.

* E-5.1-7 — **Case variance in tokens** (gptbot, GPTBot). Robots user-agent matching is case-insensitive; treat as the same token.

* E-5.1-8 — **Disallow: /** **for an AI token accompanied by narrower** **Allow:** **rules.** Longest-match/least-restrictive resolution applies; posture is PARTIAL, not BLOCKED.

* E-5.1-9 — **Staging environment.** env \= staging → all blocking findings downgrade to INFO.

### **BACKUP PLANS**

* B-5.1-1 — robots.txt unparseable → tolerant scan for User-agent/Disallow pairs; caveat that group resolution is approximate.

* B-5.1-2 — cap.ua\_probe disabled or probes rate-limited → robots.txt analysis only; C-5.1-i → NOT\_TESTABLE. This is the safe default.

* B-5.1-3 — Vendor IP-range JSON unreachable → skip verification; it affects only log-based confirmation, which is out of scope for an initial audit.

* B-5.1-4 — Registry stale (a vendor renamed a token) → unknown tokens are reported via E-5.1-6 rather than silently dropped.

### **FAILING & STOPPING PLAN**

* F-5.1-1 — **Never** send a UA string impersonating a vendor crawler outside the explicitly-enabled, logged, caveated probe in R-5.1-3. Never use one to obtain content the site withholds from the auditor.

* F-5.1-2 — Never report Google-Extended or Applebot-Extended blocking as harming search visibility. Both vendors document the opposite.

* F-5.1-3 — Never recommend unblocking an agent the operator has deliberately blocked.

* F-5.1-4 — Cap UA probes at ai\_agents.max\_probes; each counts toward host rate limits.

* F-5.1-5 — Never present a robots.txt rule for a user-initiated fetcher as an enforced control.

* F-5.1-6 — Never conflate crawl access with AI-surface eligibility: C-5.1-j exists because a fully-crawlable site can still be excluded by its own snippet directives.

---

## **C-5.2 — Content accessible with JavaScript disabled**

**Scope:** page · **Profiles:** RAW vs RENDERED (both required)

### **RULES**

* R-5.2-1 — Requires both profiles. If cap.render\_js \= false → NOT\_TESTABLE / RENDER\_UNAVAILABLE. A raw-only comparison against nothing is meaningless.

* R-5.2-2 — Extract main-content text from each profile using the same extractor and the same main-region rule as R-2.3-4. Same algorithm on both sides is essential — a different extractor per side would manufacture a difference.

* R-5.2-3 — Normalise: strip script/style/template/noscript, collapse whitespace, remove boilerplate zones (header, nav, footer, aside), lowercase for comparison.

* R-5.2-4 — Compute:

* raw\_words, rendered\_words

* text\_ratio \= raw\_words / max(rendered\_words, 1\)

* content\_similarity \= token-level Jaccard on shingles of length 5

* missing\_blocks\[\] — headings and paragraphs present in RENDERED but absent from RAW

* R-5.2-5 — Element-level presence comparison across both profiles for every element that carries retrieval weight: title, meta\[name=description\], h1–h3, link\[rel=canonical\], meta\[name=robots\], link\[rel=alternate\]\[hreflang\], JSON-LD blocks,

* text,  count,  count.

* R-5.2-6 — Detect the SPA shell signature: RAW body contains only a mount node (\#root, \#app, \#\_\_next) plus scripts, with raw\_words \< 50\.

* R-5.2-7 — Evaluate : whether it exists, and whether it contains substantive content or only a “please enable JavaScript” message.

* R-5.2-8 — Determine render\_strategy ∈ {SSR, SSG, HYDRATED, CSR, HYBRID} from the evidence: text\_ratio ≥ 0.9 with a hydration marker → HYDRATED; ≥ 0.9 without → SSR/SSG; \< 0.3 with a mount node → CSR; otherwise HYBRID.

* R-5.2-9 — Record which specific checks elsewhere in the audit are render-dependent for this page, and stamp their results with the dependency. This is the check that determines how much of the rest of the audit can be trusted for a JS-heavy site.

* R-5.2-10 — Report the retrieval consequence in plain terms, differentiated by consumer: Google renders with an evergreen Chromium and will generally see rendered content on a second pass; many AI crawlers and fetchers do not execute JavaScript at all. Content that exists only after rendering is therefore at materially higher risk for AI retrieval than for Google indexing, and the finding must say which risk it is describing.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-5.2-a | text\_ratio ≥ 0.90 and content\_similarity ≥ 0.85 and all R-5.2-5 elements present in RAW | PASS | — | — |
| C-5.2-b | text\_ratio \< th.raw\_text\_ratio\_fail (0.30) | FAIL | CRITICAL | CONTENT\_REQUIRES\_JS |
| C-5.2-c | 0.30 ≤ text\_ratio \< 0.70 | FAIL | HIGH | CONTENT\_PARTIALLY\_REQUIRES\_JS |
| C-5.2-d | 0.70 ≤ text\_ratio \< 0.90 | WARN | MEDIUM | CONTENT\_MOSTLY\_RAW |
| C-5.2-e | SPA shell detected (R-5.2-6) | FAIL | CRITICAL | SPA\_SHELL\_ONLY |
| C-5.2-f | h1 absent in RAW, present in RENDERED | FAIL | HIGH | H1\_REQUIRES\_JS |
| C-5.2-g | title absent in RAW | FAIL | HIGH | TITLE\_REQUIRES\_JS |
| C-5.2-h | Canonical absent in RAW, present in RENDERED | WARN | HIGH | CANONICAL\_REQUIRES\_JS |
| C-5.2-i | \> 30% of internal links only in RENDERED | FAIL | HIGH | LINKS\_REQUIRE\_JS |
| C-5.2-j |  contains only an enable-JS message | WARN | LOW | NOSCRIPT\_NOT\_SUBSTANTIVE |
| C-5.2-k | RAW content exceeds RENDERED (text\_ratio \> 1.2) | WARN | MEDIUM | CONTENT\_REMOVED\_BY\_JS — content present at fetch time is stripped at render time |
| C-5.2-l | Both profiles empty | FAIL | CRITICAL | NO\_CONTENT\_EITHER\_PROFILE |
| C-5.2-m | cap.render\_js \= false | NOT\_TESTABLE | — | RENDER\_UNAVAILABLE |
| C-5.2-n | RENDERED fetch failed on this page | NOT\_TESTABLE | — | RENDER\_FAILED |

### **EXCEPTIONAL CONDITIONS**

* E-5.2-1 — **Lazy-loaded below-the-fold content.** Present in the rendered DOM after network idle even without scrolling for most implementations. Where it is not, record LAZY\_CONTENT\_BELOW\_FOLD and exclude it from missing\_blocks\[\] rather than counting it as JS-gated.

* E-5.2-2 — **Cookie/consent banner suppressing content in one profile.** Detect the banner and, if content is gated behind it in both profiles equally, mark CONSENT\_GATED\_CONTENT and set the comparison NOT\_TESTABLE rather than reporting a false ratio.

* E-5.2-3 — **Hydration that reorders but does not add text.** text\_ratio ≈ 1.0, content\_similarity high. PASS. Do not fail on DOM structure differences.

* E-5.2-4 — **A/B test or personalisation changing rendered content.** Record RENDER\_VARIANCE\_POSSIBLE; a second rendered fetch may be used to confirm, budget permitting.

* E-5.2-5 — **Comment sections, chat widgets, review widgets loaded by JS.** Third-party embeds are not main content. Exclude known-widget containers from R-5.2-2 extraction.

* E-5.2-6 — **Interactive tools whose** ***output*** **is necessarily JS-generated** (calculators, configurators). The surrounding explanatory content must still be in RAW. Judge on the static content only; note the interactive portion separately.

* E-5.2-7 —  **carrying full content.** Genuinely mitigates the risk. Upgrade C-5.2-b/C-5.2-c by one severity band and record NOSCRIPT\_SUBSTANTIVE.

* E-5.2-8 — **Dynamic rendering / prerendering for bots.** If a UA probe (where enabled) shows the auditor receiving a shell while a bot UA receives full HTML, record DYNAMIC\_RENDERING\_DETECTED and note that the measured ratio reflects the auditor’s UA, not a crawler’s.

* E-5.2-9 — **Content behind a client-side paywall.** RAW may legitimately hold more than RENDERED (C-5.2-k). Note the pattern rather than treating it as a bug.

### **BACKUP PLANS**

* B-5.2-1 — RENDERED fails once → one further attempt if the remaining URL budget covers render.budget\_ms; the render cap itself is never raised.

* B-5.2-2 — Headless browser unavailable for the whole run → NOT\_TESTABLE for this check; **and** every check with a RENDERED dependency inherits cap.render\_js \= false handling and the JS caveat. The audit does not silently continue as if rendering had been checked.

* B-5.2-3 — Extraction fails on one profile → compare

* text as a coarse proxy, flag EXTRACTION\_DEGRADED, and cap the achievable status at WARN.

* B-5.2-4 — Ratio is ambiguous because of a consent wall → E-5.2-2 path.

### **FAILING & STOPPING PLAN**

* F-5.2-1 — Never run this check with only one profile. One-sided evidence produces a fabricated ratio.

* F-5.2-2 — Never claim Google cannot see JS content. Google renders with an evergreen Chromium. The finding is about risk, rendering budget, and non-Google AI fetchers — word it that way.

* F-5.2-3 — Never use different extractors for the two profiles.

* F-5.2-4 — Never report CONTENT\_REQUIRES\_JS when the true cause is a consent wall or a failed render.

* F-5.2-5 — When this check FAILs, every content-dependent result (Sections 2 and 6\) for that page must carry the cross-reference.

---

## **C-5.3 — llms.txt**

**Scope:** site · **Profile:** RAW

llms.txt is a community specification, not a search-engine requirement, and Google states no such file is needed for its AI features. It is evaluated here as an optional retrieval aid. Absence is WARN/LOW at most, never FAIL.

### **RULES**

* R-5.3-1 — Fetch {canonical\_origin}/llms.txt. Record status, Content-Type, byte length, redirect chain.

* R-5.3-2 — Validate against the specification’s structure:

1. An **H1** with the name of the project or site — the only required section.

2. Optionally, a **blockquote** with a short summary containing the key information needed to understand the rest of the file.

3. Zero or more markdown sections of any type **except headings**, giving more detail.

4. Zero or more **H2**\-delimited “file list” sections, each a markdown list whose items are a required hyperlink [name](http://url), optionally followed by : and notes.

5. An H2 section literally named **Optional** carries, by convention, secondary links an agent may skip when a shorter context is needed.

* R-5.3-3 — Validate every link: absolute or resolvable; returns 2xx; not robots-disallowed for the AI agents in C-5.1; not noindex. Budget llms.max\_link\_checks (default 25).

* R-5.3-4 — Cross-reference coverage: what fraction of the sampled page set, and of the discovered top-level sections, appear in llms.txt.

* R-5.3-5 — Detect the common malformations: HTML served instead of markdown; a 200 that is actually the site’s 404 page; the file being an unstructured prose dump with no H1 or link lists; links to pages that no longer exist.

* R-5.3-6 — Detect and report a **markdown twin** convention where present: the same URL served as markdown under content negotiation (Accept: text/markdown, ideally with Vary: Accept) and/or at a .md path. The spec recommends providing clean markdown versions of linked pages, either at the same URL with .md appended or with the extension replaced. Probe .md variants for up to 3 sampled URLs.

* R-5.3-7 — Detect a citation/attribution preferences block if present (how the site asks to be quoted and linked). Advisory; report as a positive when present, never a finding when absent.

* R-5.3-8 — Compare the site/entity description in llms.txt against the Organization description from C-3.1 and the homepage h1. Divergence between the three is an entity-consistency signal, reported here and fed to C-6.2.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-5.3-a | 200, markdown, valid H1, ≥ 1 H2 link section, all sampled links resolve | PASS | — | — |
| C-5.3-b | 404 / absent | WARN | LOW | LLMS\_TXT\_ABSENT — optional practice; state plainly it is not required by Google |
| C-5.3-c | 200 but Content-Type: text/html or an HTML body | FAIL | MEDIUM | LLMS\_TXT\_IS\_HTML |
| C-5.3-d | 200 but no H1 | FAIL | MEDIUM | LLMS\_TXT\_NO\_H1 — the only required element of the spec |
| C-5.3-e | 200 but no H2 link sections | WARN | MEDIUM | LLMS\_TXT\_NO\_LINK\_SECTIONS |
| C-5.3-f | ≥ 1 link returns 4xx/5xx | FAIL | MEDIUM | LLMS\_TXT\_BROKEN\_LINKS |
| C-5.3-g | ≥ 1 link is robots-blocked for AI agents | FAIL | MEDIUM | LLMS\_TXT\_LINKS\_BLOCKED — the file advertises what the site forbids |
| C-5.3-h | Coverage \< 50% of sampled pages | WARN | LOW | LLMS\_TXT\_LOW\_COVERAGE |
| C-5.3-i | 5xx | NOT\_TESTABLE | — | LLMS\_TXT\_UNREACHABLE |
| C-5.3-j | 200 returning the site’s 404 page | FAIL | MEDIUM | LLMS\_TXT\_SOFT\_404 |
| C-5.3-k | No blockquote summary | WARN | LOW | LLMS\_TXT\_NO\_SUMMARY |
| C-5.3-l | Description conflicts with Organization.description / homepage h1 | WARN | MEDIUM | LLMS\_TXT\_ENTITY\_INCONSISTENT |
| C-5.3-m | Markdown twins available under content negotiation or .md paths | PASS | — | MARKDOWN\_TWINS\_PRESENT — positive signal, recorded not required |
| C-5.3-n | llms.txt present but /robots.txt blocks the AI agents entirely | WARN | MEDIUM | LLMS\_TXT\_CONTRADICTS\_ROBOTS |

### **EXCEPTIONAL CONDITIONS**

* E-5.3-1 — **Absent on a small brochure site.** Expected. C-5.3-b LOW, phrased as an option.

* E-5.3-2 — **Present at a subpath** (/docs/llms.txt). Valid per the spec, which allows the root path or any subpath. Probe /docs/llms.txt and /documentation/llms.txt before concluding absence.

* E-5.3-3 — **Served as** **text/plain** **rather than** **text/markdown.** Acceptable; content is what matters. INFO only.

* E-5.3-4 — **Very large file.** Not itself a defect; note the size and that the spec’s Optional section exists precisely to let agents shorten context.

* E-5.3-5 — **Links to external documentation** (docs on a different host). Valid. Validate reachability; do not require same-origin.

* E-5.3-6 — **A file that is only a flat list of URLs, with no descriptions or section structure** (a sitemap-style dump). Detected from the file’s own content; no comparison against any XML sitemap is made. Technically conformant, low value. WARN/LOW LLMS\_TXT\_SITEMAP\_CLONE with a note on what a useful file would contain instead.

* E-5.3-7 — **Optional** **section present.** Correct use of the convention. Positive note.

* E-5.3-8 — **llms.txt** **referenced from** **Organization.sameAs.** Misuse of sameAs — flag under C-3.1-l, not here.

### **BACKUP PLANS**

* B-5.3-1 — Root 404 → probe /docs/llms.txt, /documentation/llms.txt, /.well-known/llms.txt before concluding.

* B-5.3-2 — Markdown parser unavailable → structural regex validation (H1, H2, list-item link shape) with PARSER\_DEGRADED.

* B-5.3-3 — Link-validation budget exhausted → validate the first 10 links and report the remainder as unvalidated with a count.

* B-5.3-4 — Transient failure → standard retry ladder before C-5.3-i.

### **FAILING & STOPPING PLAN**

* F-5.3-1 — **Never** **FAIL** **on absence.** It is optional and Google explicitly does not require it.

* F-5.3-2 — Never claim llms.txt is consumed by any specific assistant unless that vendor documents it. Report it as an emerging convention.

* F-5.3-3 — Cap link validations at llms.max\_link\_checks.

* F-5.3-4 — Never recommend creating one for a site whose robots.txt blocks all AI agents without first surfacing that contradiction.

---

---

## **C-5.4 — AI Instructions Page**

**Scope:** domain, root level · **Profile:** RAW \+ RENDERED **Reference implementations:** wellows.com/ai-info, peec.ai/ai-instructions

An HTML page written for AI assistants: what the organisation is, what it does, who it competes with, and how it should be described. Like llms.txt, it is an optional additive practice, not a Google requirement.

### **RULES**

* R-5.4-1 — **Domain scope, outside the sample.** This check runs against the domain at **root level only**, on canonical\_origin. The page it finds is fetched independently of Module A: it is **never** added to the selected page set, never counted toward the 1–10 sample or its quality band, and never evaluated by any page-level check (Sections 1.3–1.7, 2\.*, 3\.*, 4\.*, 5.2, 6\.*). Its fetches do not draw on the page-sampling budget. Findings from this check are site-level.

* R-5.4-2 — **Discovery ladder**, in order, stopping at the first 2xx page that passes R-5.4-3 classification:

1. Root-level conventional paths on canonical\_origin: /ai-info, /ai-instructions, /ai, /for-ai, /ai-overview, /llm, /llms, /ai-facts. Single-segment paths only — a nested candidate such as /about/ai is not probed.

2. Links from llms.txt, if present, whose anchor text matches an AI-instructions lexicon and whose target is root level on canonical\_origin.

* R-5.4-3 — **Classification.** A candidate qualifies as an AI-instructions page when it scores ≥ 4 on: \+2 the page addresses AI systems explicitly (a heading or paragraph containing “AI assistants”, “language models”, “for AI”, “AI instructions”); \+2 it contains a definitional statement of what the organisation is; \+1 it names competitors or the category; \+1 it states pricing or product facts in a structured form; \+1 it includes a “key facts” or “instructions” block; \+1 it carries a last-updated date; \+1 it lists people/founders; \+1 it contains a Q\&A block.

* R-5.4-4 — **Content-completeness rubric.** Score presence of each element (report as a checklist, one row per element):

| Element | Weight | Detection |
| :---- | :---- | :---- |
| Definitional sentence (what the organisation is, in one sentence) | 3 | First paragraph or a “Basic Information” block containing an “X is a Y that Z” pattern |
| What it does / core offerings | 3 | A section heading matching an offerings lexicon |
| Who it is for | 2 | Audience/ICP heading |
| Category and named alternatives/competitors | 2 | A comparison table, or ≥ 2 competitor proper nouns in a category section |
| Pricing or commercial model | 2 | Currency values or a plan table |
| Explicit instructions to AI assistants | 3 | A heading matching “instructions for AI” plus an ordered/unordered list |
| Key facts block | 2 | A heading matching “key facts” |
| People / founders | 1 | Names with roles |
| Q\&A / FAQ | 1 | ≥ 3 question-form headings with answers |
| Last-updated date | 2 | An explicit date string, or dateModified in schema |
| When it is *not* the right fit | 1 | A negative-scoping heading |
| Contact / demo path | 1 | A link to contact, demo, or trial |

completeness \= Σ(present weights) / 23\.

* R-5.4-5 — **Consistency verification.** The definitional sentence must be consistent with: Organization.description (C-3.1), the llms.txt summary (C-5.3), the homepage h1, and the homepage meta description. Report each pairwise agreement. Inconsistent self-description across these surfaces is the single most damaging thing this check can find, because it is what an assistant resolves against.

* R-5.4-6 — **Verifiability.** Any claim on the page that is a checkable fact about the site itself (pricing, product names, page links) is verified against the live site where cheaply possible. Unverifiable claims are not judged.

* R-5.4-7 — **Accessibility to AI.** The page must be: indexable, not robots-disallowed for the AI agents in C-5.1, present in RAW (not JS-only), and linked from at least one crawlable page or listed in llms.txt. Indexability and robots state are evaluated for this URL directly, not inherited from the sample. The inbound-link test reads the links already harvested in Module A; it does not add this page to the sample. An unlinked, unlisted page is effectively invisible.

* R-5.4-8 — Detect competitor naming explicitly and report it as present/absent. Both reference implementations name competitors; a page without them answers fewer of the questions assistants actually get asked.

* R-5.4-9 — Detect structured data on the page (WebPage/AboutPage/FAQPage/Organization) and cross-reference C-3.1.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-5.4-a | Page found, completeness ≥ 0.70, accessible, consistent with other surfaces | PASS | — | — |
| C-5.4-b | No page found after the full ladder | WARN | MEDIUM | AI\_INSTRUCTIONS\_PAGE\_ABSENT — optional practice; never FAIL |
| C-5.4-c | Found, completeness \< 0.40 | WARN | MEDIUM | AI\_INSTRUCTIONS\_PAGE\_THIN |
| C-5.4-d | Found but noindex or robots-blocked | FAIL | HIGH | AI\_INSTRUCTIONS\_PAGE\_BLOCKED — the page exists for machines that are forbidden from reading it |
| C-5.4-e | Found but present only in RENDERED | FAIL | HIGH | AI\_INSTRUCTIONS\_PAGE\_REQUIRES\_JS |
| C-5.4-f | Found but orphaned (no internal link from any crawled page, and not in llms.txt) | WARN | HIGH | AI\_INSTRUCTIONS\_PAGE\_ORPHANED |
| C-5.4-g | Definitional sentence conflicts with Organization.description or homepage h1 | FAIL | HIGH | ENTITY\_DESCRIPTION\_CONFLICT |
| C-5.4-h | No last-updated date | WARN | LOW | AI\_INSTRUCTIONS\_NO\_DATE |
| C-5.4-i | No competitors or category named | WARN | LOW | AI\_INSTRUCTIONS\_NO\_COMPETITIVE\_CONTEXT |
| C-5.4-j | No explicit instructions block | WARN | LOW | AI\_INSTRUCTIONS\_NO\_DIRECTIVES |
| C-5.4-k | A verifiable claim contradicts the live site (e.g. a price that does not match the pricing page) | FAIL | HIGH | AI\_INSTRUCTIONS\_CLAIM\_CONTRADICTED |
| C-5.4-l | Last-updated date older than th.freshness\_stale\_days | WARN | MEDIUM | AI\_INSTRUCTIONS\_STALE |
| C-5.4-m | Multiple candidate pages found | WARN | LOW | AI\_INSTRUCTIONS\_MULTIPLE — split authority; consolidate |

### **EXCEPTIONAL CONDITIONS**

* E-5.4-1 — **Absent on a small site.** Fine. C-5.4-b MEDIUM at most, phrased as an opportunity.

* E-5.4-2 — **An About page that serves the purpose without addressing AI explicitly.** Score it under R-5.4-4; if completeness ≥ 0.70, record AI\_INSTRUCTIONS\_SERVED\_BY\_ABOUT and PASS. The function matters more than the URL.

* E-5.4-3 — **The content lives in** **llms.txt** **rather than an HTML page.** Acceptable substitute for C-5.4-b; note that an HTML page is additionally citable and linkable, which a text file is not.

* E-5.4-4 — **Instructions that ask assistants to make claims the site cannot support.** Out of scope for verification, but where R-5.4-6 finds a direct contradiction with the live site, C-5.4-k fires.

* E-5.4-5 — **The page names competitors unfavourably.** Not the tool’s business. Detect presence only; never evaluate sentiment.

* E-5.4-6 — **Page is very long.** Not a defect. Report word count as context.

* E-5.4-7 — **Localised variants.** Evaluate the x-default or primary-language version only; note the others exist.

### **BACKUP PLANS**

* B-5.4-1 — Conventional paths all 404 → run ladder steps 2–4 before concluding absence.

* B-5.4-2 — Classification is borderline (score 3\) → record as AI\_INSTRUCTIONS\_CANDIDATE\_UNCERTAIN and evaluate it, but cap the achievable status at WARN and state the uncertainty.

* B-5.4-3 — cap.llm\_judge disabled → run only the deterministic detections in R-5.4-4; the completeness score is then structural and is labelled structural completeness.

* B-5.4-4 — Consistency verification impossible (no Organization schema, no llms.txt) → compare against the homepage h1 and meta description alone; caveat.

### **FAILING & STOPPING PLAN**

* F-5.4-1 — Never FAIL on absence.

* F-5.4-2 — Cap discovery probes at ai\_page.max\_probes (default 12).

* F-5.4-3 — Never evaluate the truth of business claims beyond what is checkable against the site itself.

* F-5.4-4 — Never judge tone, sentiment or competitive positioning.

* F-5.4-5 — Never recommend an AI-instructions page for a site that blocks all AI agents without surfacing the contradiction first.

---

---

# **SECTION 6 — LLM CONTENT READINESS**

**Section-wide method note, mandatory in the report:** Every check in this section runs a **deterministic gate first**. Only what the gate cannot decide is passed to an LLM rubric, and only when cap.llm\_judge \= true. Any sub-score produced by the rubric is confidence \= MODELLED and carries the caveat: *“Modelled estimate against a fixed rubric; not a measurement of retrieval behaviour by any specific AI system. No public API exposes whether a given model retrieved or cited a page.”* Where only raw HTML was available, results additionally carry: *“Evaluated on raw HTML; JavaScript-rendered content was not assessed.”*

**Shared rubric protocol (binding for every LLM-judged sub-score in this section):**

* R-S6-1 — The judge receives only: the extracted main-content text (max 12,000 characters), the heading outline, the page URL, page\_type, and the specific rubric. It never receives the site’s marketing claims, the tool’s other findings, or a desired outcome.

* R-S6-2 — Temperature 0\. Fixed prompt version string recorded in evidence (rubric\_version).

* R-S6-3 — The judge returns a strict JSON object with an integer sub-score per criterion (0–3), a one-sentence justification per criterion, and a quote field containing the verbatim page text the score rests on. A criterion scored above 0 with no quote is discarded and re-scored once; if it fails again, that criterion becomes NOT\_TESTABLE.

* R-S6-4 — The judge never sees another page’s score. No cross-page normalisation.

* R-S6-5 — Deterministic gate results always override the judge on anything the gate can measure. The judge cannot promote a page whose gate found no headings.

---

## **C-6.1 — Raw Content Availability**

**Scope:** page · **Profiles:** RAW primary, RENDERED comparative **Relationship to** **C-5.2:** C-5.2 asks *does the content exist without JavaScript*. C-6.1 asks *is the content that exists actually extractable as clean text by a non-browser fetcher*. Two different failures, and a page can pass one and fail the other.

### **RULES**

* R-6.1-1 — From RAW, run three independent extractions and compare:

1. **Naive** — strip tags, collapse whitespace.

2. **Main-region** —

* /\[role=main\]/largest

* , boilerplate removed.

3. **Readability-style** — density-based main-content extraction.

* R-6.1-2 — Compute extraction\_agreement \= mean pairwise Jaccard over 5-token shingles across the three outputs. Low agreement means the page’s content boundaries are ambiguous to any extractor, which is precisely the condition that degrades retrieval.

* R-6.1-3 — Compute text\_to\_html\_ratio \= extracted main-content bytes ÷ total HTML bytes.

* R-6.1-4 — Compute boilerplate\_ratio \= boilerplate-zone words ÷ total words.

* R-6.1-5 — Detect content locked inside structures a text extractor cannot read: text baked into images with no adjacent equivalent; text inside

* / without accessible text; content inside same-origin s; content behind tabs or accordions whose panels are absent from RAW; text supplied only via CSS ::before/::after.

* R-6.1-6 — Detect encoding correctness: declared charset, Content-Type charset, and actual byte patterns must agree. Mojibake (â€™, Ã©) is detected by pattern and reported — it silently corrupts every downstream extraction.

* R-6.1-7 — Detect semantic HTML availability: presence of

* ,

* ,

* ,

* ,

* ,

* ,

* . A document that is entirely

* s forces every extractor to guess.

* R-6.1-8 — Word count of extracted main content, and the ratio of that to the rendered equivalent.

* R-6.1-9 — Detect whether a markdown twin is served under content negotiation (Accept: text/markdown) or at a .md path — cross-reference C-5.3. Where present, this removes extraction ambiguity entirely and is recorded as a strong positive.

* R-6.1-10 — Where cap.ua\_probe is enabled, compare the RAW body served to the auditor UA against that served to a generic non-browser UA (e.g. curl/8.x). A material difference indicates UA-conditional serving that will affect non-browser AI fetchers. Carries the R-FETCH-7 caveat.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-6.1-a | extraction\_agreement ≥ 0.80, main content ≥ th.min\_words\_content\_page (150), semantic HTML present, encoding correct | PASS | — | — |
| C-6.1-b | Main content \< 50 words in RAW | FAIL | CRITICAL | RAW\_CONTENT\_ABSENT |
| C-6.1-c | Main content 50–149 words | WARN | MEDIUM | RAW\_CONTENT\_THIN |
| C-6.1-d | extraction\_agreement \< 0.50 | FAIL | HIGH | CONTENT\_BOUNDARIES\_AMBIGUOUS |
| C-6.1-e | 0.50 ≤ extraction\_agreement \< 0.80 | WARN | MEDIUM | CONTENT\_BOUNDARIES\_UNCLEAR |
| C-6.1-f | boilerplate\_ratio \> 0.60 | WARN | MEDIUM | BOILERPLATE\_DOMINANT |
| C-6.1-g | Substantive content only inside images (R-6.1-5) | FAIL | HIGH | CONTENT\_IN\_IMAGES |
| C-6.1-h | Substantive content only inside same-origin iframes | WARN | HIGH | CONTENT\_IN\_IFRAME |
| C-6.1-i | Tab/accordion panel content absent from RAW | WARN | MEDIUM | CONTENT\_IN\_HIDDEN\_PANELS |
| C-6.1-j | Encoding mismatch / mojibake detected | FAIL | HIGH | ENCODING\_CORRUPTION |
| C-6.1-k | No semantic HTML landmarks at all | WARN | MEDIUM | NO\_SEMANTIC\_HTML |
| C-6.1-l | text\_to\_html\_ratio \< 0.05 | WARN | LOW | LOW\_TEXT\_TO\_HTML\_RATIO |
| C-6.1-m | Markdown twin available | PASS | — | MARKDOWN\_TWIN\_AVAILABLE — recorded as a positive |
| C-6.1-n | UA-conditional content difference detected | WARN | HIGH | UA\_CONDITIONAL\_CONTENT |
| C-6.1-o | RAW fetch failed | NOT\_TESTABLE | — | RAW\_FETCH\_FAILED |

### **EXCEPTIONAL CONDITIONS**

* E-6.1-1 — **Legitimately short pages** (contact, pricing table, a tool). page\_type of pricing/other where a structured data table is present → C-6.1-c downgrades to INFO; a pricing table is content even at 80 words.

* E-6.1-2 — **Image-heavy portfolio or gallery pages.** C-6.1-g requires that *substantive* text be image-locked. Captions and alt text count as text; a gallery with descriptive alt is not a finding.

* E-6.1-3 — **Tabs whose panels are all in** **RAW** **but hidden by CSS.** Present to extractors. Not C-6.1-i.

* E-6.1-4 — \*\*

* \*\*\*\*-only markup on an otherwise clean page\*\* with high extraction agreement. C-6.1-k LOW only; the outcome matters more than the tag names.

* E-6.1-5 — **Non-Latin scripts.** Word counting must be grapheme- and script-aware (segment CJK by character-count heuristics, not spaces). Applying space-delimited word counts to Chinese produces nonsense.

* E-6.1-6 — **Documentation pages with large code blocks.** Code is content. Count it, but report code\_ratio separately so a reader is not misled about prose volume.

* E-6.1-7 — **Landing pages that are deliberately terse.** Report the word count factually; do not moralise about length.

* E-6.1-8 — **Consent wall in** **RAW.** NOT\_TESTABLE, not C-6.1-b (cross-reference E-A0-5).

* E-6.1-9 — **PDF or non-HTML in the sample.** NOT\_APPLICABLE for HTML-structure rules; word count may still be reported.

### **BACKUP PLANS**

* B-6.1-1 — One extractor fails → compute agreement over the remaining two, flag EXTRACTION\_PARTIAL, and cap the achievable status at WARN.

* B-6.1-2 — All extractors fail → fall to

* text, EXTRACTION\_DEGRADED, status capped at WARN.

* B-6.1-3 — Encoding undeterminable → attempt UTF-8, then the declared charset, then chardet-style detection; report which succeeded.

* B-6.1-4 — cap.ua\_probe off → C-6.1-n NOT\_TESTABLE. Default and safe.

### **FAILING & STOPPING PLAN**

* F-6.1-1 — Never report RAW\_CONTENT\_ABSENT when the cause is a consent wall, a failed fetch, or a bot challenge.

* F-6.1-2 — Never apply space-delimited word counts to non-space-delimited scripts.

* F-6.1-3 — Never count boilerplate as main content.

* F-6.1-4 — Never fail a page for brevity alone where its page\_type legitimately implies brevity.

---

## **C-6.2 — Entity Clarity**

**Scope:** page \+ site · **Method:** deterministic gate \+ optional rubric

Can a machine determine, from this page alone, **what entity it is about** and **who published it** — and does that answer agree with every other place the site states it?

### **RULES — deterministic gate**

* R-6.2-1 — Extract candidate entity names from, in order: Organization.name (C-3.1), WebSite.name, homepage h1, og:site\_name, the

* brand suffix, the logo alt, and the llms.txt H1.

* R-6.2-2 — **Name consistency matrix.** Compute pairwise exact-match and normalised-match across all sources found. Report the matrix; any disagreement is a finding, because these are the strings an assistant reconciles when deciding what the site is.

* R-6.2-3 — **Definitional statement detection.** Locate a sentence matching an “X is a Y that Z” pattern where X matches the entity name, within the first 200 words of main content on the homepage and on any AI-instructions page. Record it verbatim.

* R-6.2-4 — **Description consistency.** Compare the definitional statement against Organization.description, the meta description, and the llms.txt blockquote summary. Report pairwise similarity.

* R-6.2-5 — **Page-level subject.** For each sampled page: does an h1 exist, does the

* share ≥ 1 significant token with it, and does the main content’s most frequent significant noun phrase appear in the h1? This is a proxy for “the page declares its subject”, not a topical-relevance model.

* R-6.2-6 — **Ambiguity detection.** Flag an entity name that is a common word or collides with a well-known different entity (configurable list), since disambiguation then depends entirely on sameAs and context.

* R-6.2-7 — **Author attribution (where** **page\_type** **is** **blog\_article/author).** Is an author named in visible text? Markup for that author is validated in C-3.1 (R-3.1-19), not here. Person node, does it carry sameAs or an author-page link.

### **RULES — rubric (only when the gate leaves something undecidable, and cap.llm\_judge \= true)**

* R-6.2-8 — Criteria, each 0–3, each requiring a verbatim quote:

* **E1 Subject identifiability** — can the page’s primary subject be named from the first 150 words?

* **E2 Publisher identifiability** — can the publishing organisation be named from the page alone?

* **E3 Category placement** — does the page state what category/class the entity belongs to?

* **E4 Disambiguation** — does the page distinguish the entity from similarly-named or adjacent things?

* R-6.2-9 — entity\_clarity\_score \= Σ / 12, MODELLED, with the standing caveat.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-6.2-a | Consistent name across ≥ 3 sources, definitional statement present, page-level subject declared | PASS | — | — |
| C-6.2-b | Entity name differs across sources | FAIL | HIGH | ENTITY\_NAME\_INCONSISTENT |
| C-6.2-c | No definitional statement on the homepage | WARN | MEDIUM | NO\_DEFINITIONAL\_STATEMENT |
| C-6.2-d | Description differs materially across schema / meta / llms.txt / AI page | FAIL | HIGH | ENTITY\_DESCRIPTION\_INCONSISTENT |
| C-6.2-e | Page has no h1, or h1 shares no token with  | WARN | MEDIUM | PAGE\_SUBJECT\_UNCLEAR |
| C-6.2-f | Article without a named author | WARN | LOW | NO\_AUTHOR\_ATTRIBUTION |
| C-6.2-g | entity\_clarity\_score \< 0.50 | WARN | MEDIUM | LOW\_ENTITY\_CLARITY (MODELLED) |
| C-6.2-h | cap.llm\_judge \= false | Gate results only | — | RUBRIC\_DISABLED — the deterministic findings still stand |

### **EXCEPTIONAL CONDITIONS**

* E-6.2-1 — **Legal name vs trading name** (Wellows / Wellows Ltd). Not an inconsistency when legalName and name are used correctly. Exclude the legalName↔name pair from C-6.2-b.

* E-6.2-2 — **Deliberate rebranding in progress.** Where policy.rebranding \= true, C-6.2-b downgrades to WARN with a note.

* E-6.2-3 — **A personal site where the entity is a** **Person, not an** **Organization.** C-3.1-t accepts a Person node in place of Organization; this check becomes NOT\_APPLICABLE; evaluate the Person node instead.

* E-6.2-4 — **Multi-brand sites** where one host serves several brands. Detect multiple Organization nodes with distinct stable @ids and a clear page-to-brand mapping; that is architecture, not inconsistency. C-6.2-b does not fire where the mapping is consistent.

* E-6.2-5 — **Non-English content.** The definitional-pattern detector must be language-aware or disabled; where it is disabled, C-6.2-c → NOT\_TESTABLE, never a false WARN.

* E-6.2-6 — **Title-suffix brand differing in case or punctuation only.** Normalised match. Not a finding.

* E-6.2-7 — **Category pages with no single subject.** C-6.2-e downgrades to INFO for page\_type \= category.

### **BACKUP PLANS**

* B-6.2-1 — No Organization schema → build the name-consistency matrix from og:site\_name, title suffix and logo alt alone; caveat the reduced source set.

* B-6.2-2 — cap.llm\_judge off → gate-only; report entity\_clarity\_score as NOT\_TESTABLE while keeping every deterministic finding.

* B-6.2-3 — Judge returns malformed JSON → one retry; then NOT\_TESTABLE / RUBRIC\_PARSE\_FAILED.

* B-6.2-4 — Judge quotes text absent from the page → discard that criterion per R-S6-3.

* B-6.2-5 — Sample \< 2 pages → C-3.1-f (@id stability) NOT\_APPLICABLE.

### **FAILING & STOPPING PLAN**

* F-6.2-1 — Never emit a MODELLED score without the caveat.

* F-6.2-2 — Never let the rubric overturn a deterministic gate finding.

* F-6.2-3 — Never claim knowledge of how any AI system resolves this entity. No public API exposes that.

* F-6.2-4 — Never treat a legal-name/trading-name pair as an inconsistency.

* F-6.2-5 — Cap judge calls at llm.max\_calls\_per\_run (default 20). On exhaustion, remaining pages are gate-only.

---

## **C-6.3 — Content Structure**

**Scope:** page · **Method:** deterministic (rubric optional)

### **RULES**

* R-6.3-1 — From the heading map (R-2.3-9), compute: heading count by level; mean and max words per section; sections exceeding structure.max\_section\_words (default 400); sections under 20 words; heading-level skips.

* R-6.3-2 — Compute paragraph statistics: count, mean and max words per paragraph, paragraphs over structure.max\_para\_words (default 150).

* R-6.3-3 — Detect structural elements:

* /

* count and item counts;

* count with

* presence;

* count;

* ; /

* ;

* /

* .

* R-6.3-4 — Compute chunk\_viability: split main content at heading boundaries, then at paragraph boundaries where a section exceeds the cap. A chunk is *viable* when it is 40–400 words **and** its first sentence is self-contained (contains a proper noun or a concrete noun phrase, not opening with an unresolved pronoun or a bare demonstrative — “It does this by…”, “This means…”). chunk\_viability \= viable ÷ total.

* R-6.3-5 — Detect the wall-of-text pattern: main content ≥ 500 words with fewer than 2 headings and no lists or tables.

* R-6.3-6 — Detect tables used for layout (a

* with no

* , no caption, and containing block-level layout elements) versus tables presenting data.

* R-6.3-7 — Detect a table of contents or on-page anchor navigation.

* R-6.3-8 — Detect list abuse: a list whose items average \> 60 words is prose in list clothing and does not chunk any better than a paragraph.

* R-6.3-9 — Compute mean sentence length and the share of sentences over 40 words.

* R-6.3-10 — Where cap.llm\_judge \= true, one rubric criterion only: **S1 — could each top-level section be lifted out and still make sense on its own?** 0–3, quote required. Everything else in this check is measurable and must not be delegated.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-6.3-a | ≥ 2 headings, no section \> 400 words, chunk\_viability ≥ 0.70, ≥ 1 list or table where content ≥ 300 words | PASS | — | — |
| C-6.3-b | Wall of text (R-6.3-5) | FAIL | HIGH | NO\_CONTENT\_STRUCTURE |
| C-6.3-c | chunk\_viability \< 0.40 | FAIL | HIGH | POOR\_CHUNK\_VIABILITY |
| C-6.3-d | 0.40 ≤ chunk\_viability \< 0.70 | WARN | MEDIUM | MODERATE\_CHUNK\_VIABILITY |
| C-6.3-e | ≥ 1 section \> 400 words | WARN | MEDIUM | OVERLONG\_SECTIONS |
| C-6.3-f | ≥ 3 paragraphs \> 150 words | WARN | LOW | OVERLONG\_PARAGRAPHS |
| C-6.3-g | Only 1 heading on a page ≥ 800 words | WARN | MEDIUM | INSUFFICIENT\_HEADINGS |
| C-6.3-h | Layout tables detected | WARN | LOW | LAYOUT\_TABLES |
| C-6.3-i | Data table without  | WARN | LOW | TABLE\_NO\_HEADERS |
| C-6.3-j | Heading-level skips ≥ 3 | WARN | LOW | HEADING\_HIERARCHY\_BROKEN |
| C-6.3-k | Main content \< 150 words | NOT\_APPLICABLE | — | INSUFFICIENT\_CONTENT\_FOR\_STRUCTURE — defer to C-6.1 |

### **EXCEPTIONAL CONDITIONS**

* E-6.3-1 — **Short pages.** C-6.3-k — structure rules do not apply below 150 words. C-6.1 already reported the length.

* E-6.3-2 — **Documentation with long code blocks.** Exclude

* / from section word counts; a 600-word code sample is not an overlong prose section.

* E-6.3-3 — **Legal pages** (terms, privacy). Long numbered sections are the correct form. Downgrade C-6.3-e/C-6.3-f to INFO where the page matches a legal lexicon.

* E-6.3-4 — **Landing pages** built as visual sections with few headings. Downgrade C-6.3-g to INFO for page\_type \= homepage/service\_\* where the visual sections carry h2s that the extractor found.

* E-6.3-5 — **Pricing tables.** Data tables without

* are common in styled pricing components; C-6.3-i stays LOW.

* E-6.3-6 — **Non-Latin scripts.** Word- and sentence-length thresholds are calibrated to English. For other scripts, report values and suppress the threshold-based conditions with a note.

* E-6.3-7 — **Single-topic pages** where one section is legitimately the whole page (a definition page). C-6.3-g INFO where content \< 400 words.

* E-6.3-8 — **FAQ pages** — many short sections. High chunk\_viability naturally. Not a defect.

### **BACKUP PLANS**

* B-6.3-1 — Heading extraction failed → derive structure from paragraph boundaries alone; STRUCTURE\_ANALYSIS\_DEGRADED; cap status at WARN.

* B-6.3-2 — Sentence segmentation unavailable for the language → report the remaining structure metrics and caveat the gap.

* B-6.3-3 — cap.llm\_judge off → deterministic conditions only; S1 NOT\_TESTABLE. This check loses little without the judge, by design.

* B-6.3-4 — Content extraction degraded (C-6.1) → inherit the cap and the caveat.

### **FAILING & STOPPING PLAN**

* F-6.3-1 — Never apply English-calibrated thresholds to other scripts without stating it.

* F-6.3-2 — Never FAIL a short page on structure.

* F-6.3-3 — Never count code blocks as prose.

* F-6.3-4 — Never delegate a measurable property to the LLM judge.

---

## **C-6.4 — Answer Extractability**

**Scope:** page · **Method:** deterministic gate \+ rubric

Can a self-contained answer be lifted from this page and still be true and attributable outside the page’s context? That is what retrieval does to content, so it is what this check simulates.

### **RULES — deterministic gate**

* R-6.4-1 — Identify question-form headings (R-2.3-10): interrogative opener (what, how, why, when, where, who, which, can, does, is, are, should) or a terminal ?.

* R-6.4-2 — For each question heading, extract the immediately following content up to the next heading of equal or higher level. Compute: word count, whether the first sentence answers directly (declarative, contains a concrete term from the question, does not open with a filler clause), and whether the answer is ≤ 3 sentences.

* R-6.4-3 — **Standalone-sentence analysis over main content.** For each of the first 20 sentences following a heading, determine self-containment: no sentence-initial unresolved pronoun (It, This, They, These, That) without a preceding antecedent in the same sentence; no bare deictic reference (the above, as mentioned, see below); contains at least one proper noun or concrete noun phrase. standalone\_ratio \= self-contained ÷ evaluated.

* R-6.4-4 — **Definitional extractability.** Presence of at least one sentence matching a definitional pattern for the page’s primary subject.

* R-6.4-5 — **Factual density.** Count sentences containing a number, date, named entity, or measurable claim, as a ratio of total sentences.

* R-6.4-6 — **Attribution scaffolding.** Presence of visible author, publish date, and — where the page makes factual claims — source links or citations. A claim with no provenance is extractable but not trustable, and the two are different findings.

* R-6.4-7 — **List and table answers.** Count structures that directly answer a heading question (a “steps” list under a “how to” heading, a comparison table under a “vs” heading).

* R-6.4-8 — **Anti-pattern detection.** Flag answers that begin with throat-clearing (“In today’s fast-paced world…”, “Before we dive in…”), answers that defer (“we’ll cover this below”), and answers that require the preceding section to parse.

### **RULES — rubric**

* R-6.4-9 — Criteria, each 0–3, quote required:

* **A1 Direct answering** — does the content answer the questions its headings pose, immediately beneath them?

* **A2 Excerpt survivability** — would a 2–3 sentence excerpt remain accurate and comprehensible with the rest of the page removed?

* **A3 Claim specificity** — are claims concrete and checkable rather than vague?

* **A4 Attribution clarity** — is it clear who is asserting this and on what basis?

* R-6.4-10 — extractability\_score \= Σ / 12, MODELLED, standing caveat.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-6.4-a | standalone\_ratio ≥ 0.70, ≥ 1 question heading answered within 3 sentences (or a definitional sentence present), attribution present | PASS | — | — |
| C-6.4-b | standalone\_ratio \< 0.40 | FAIL | HIGH | CONTENT\_NOT\_SELF\_CONTAINED |
| C-6.4-c | 0.40 ≤ standalone\_ratio \< 0.70 | WARN | MEDIUM | WEAK\_SELF\_CONTAINMENT |
| C-6.4-d | Question headings present but none answered within 3 sentences | WARN | MEDIUM | QUESTIONS\_NOT\_DIRECTLY\_ANSWERED |
| C-6.4-e | No definitional sentence for the page subject | WARN | MEDIUM | NO\_DEFINITIONAL\_ANSWER |
| C-6.4-f | Factual density \< 0.10 on a page making factual claims | WARN | LOW | LOW\_FACTUAL\_DENSITY |
| C-6.4-g | Factual claims with no source, author or date | WARN | MEDIUM | NO\_ATTRIBUTION\_SCAFFOLDING |
| C-6.4-h | ≥ 3 throat-clearing or deferring answer openings | WARN | LOW | ANSWER\_ANTIPATTERNS |
| C-6.4-i | extractability\_score \< 0.50 | WARN | MEDIUM | LOW\_EXTRACTABILITY (MODELLED) |
| C-6.4-j | Content \< 150 words | NOT\_APPLICABLE | — | INSUFFICIENT\_CONTENT |
| C-6.4-k | cap.llm\_judge \= false | Gate only | — | RUBRIC\_DISABLED |

### **EXCEPTIONAL CONDITIONS**

* E-6.4-1 — **Narrative or brand-story content.** Self-containment is a lower priority by genre. Downgrade C-6.4-b/C-6.4-c one band for page\_type \= about where the page is explicitly a story.

* E-6.4-2 — **Product pages.** Specifications and prices are the answers; prose self-containment matters less. Weight R-6.4-5 (factual density) higher and downgrade C-6.4-e.

* E-6.4-3 — **Pages that are lists by nature** (a directory, a glossary). Naturally high self-containment. Not gaming.

* E-6.4-4 — **Legitimate progressive explanation** where later sections build on earlier ones. Some dependency is correct pedagogy. C-6.4-b requires \< 0.40, which a well-written tutorial will not hit.

* E-6.4-5 — **Non-English content.** Pronoun and definitional detection are language-specific. Where the language is unsupported, gate items → NOT\_TESTABLE rather than producing false ratios; the rubric may still run if the judge supports the language.

* E-6.4-6 — **Marketing pages with deliberately vague claims.** Report A3 factually; do not editorialise.

* E-6.4-7 — **Pages without question headings.** C-6.4-d NOT\_APPLICABLE; R-6.4-4 still applies.

* E-6.4-8 — **FAQPage** **absent entirely.** Never a finding (see C-3.1 S10 note).

### **BACKUP PLANS**

* B-6.4-1 — Sentence segmentation unavailable → gate items depending on it → NOT\_TESTABLE; rubric may still run.

* B-6.4-2 — cap.llm\_judge off → gate only; extractability\_score NOT\_TESTABLE.

* B-6.4-3 — Content extraction degraded → inherit the cap and caveat from C-6.1.

### **FAILING & STOPPING PLAN**

* F-6.4-1 — Never claim a page will or will not be cited by any AI system. No public API exposes that, and any such claim is unfalsifiable.

* F-6.4-2 — Never emit a MODELLED score without the caveat.

* F-6.4-3 — Never recommend adding FAQPage markup for rich results; the rich result was retired on 7 May 2026\.

* F-6.4-4 — Never run language-specific heuristics on unsupported languages.

* F-6.4-5 — Never let the rubric overturn a gate finding.

---

## **C-6.5 — Content Freshness**

**Scope:** page \+ site · **Method:** deterministic, plus one optional LLM currency check (R-6.5-10)

### **RULES**

* R-6.5-1 — Collect date signals, kept separate and never merged:

1. datePublished / dateModified from Article/BlogPosting/WebPage JSON-LD (C-3.1).

2. Visible published/updated dates in the rendered DOM ( preferred; else a date pattern adjacent to a “published”/“updated” label).

3. Last-Modified response header.

4. og:updated\_time / article:modified\_time.

* R-6.5-2 — Normalise all to UTC ISO 8601\. Record source and raw string for each.

* R-6.5-3 — Compute content\_age\_days from the most authoritative available signal, in this precedence: visible dateModified → schema dateModified → visible datePublished → schema datePublished → Last-Modified header. Record which was used.

* R-6.5-4 — **Build-timestamp detection.** Flag when dateModified equals the fetch date, or is within 24 hours of it, on more than half the sampled pages. Real editorial updates do not cluster on the crawl date.

* R-6.5-5 — **Date validity.** Flag future dates, dateModified earlier than datePublished, and unparseable values.

* R-6.5-6 — **Visibility.** A date present only in schema and not visible to a reader is weaker than one shown on the page. Report whether the date is user-visible.

* R-6.5-7 — **Site-level distribution.** Report the distribution of content\_age\_days across sampled pages, plus median and the count over th.freshness\_stale\_days.

* R-6.5-8 — **Content-type sensitivity.** Apply staleness thresholds only to page types where recency carries meaning: blog\_article, blog\_template\_alt, pricing, product\_main, and any page whose content contains year references or version numbers. Never apply them to about, author, or evergreen service\_\* pages.

* R-6.5-9 — **Stale-content signals inside the text.** Detect explicit year references in headings or title (“… in 2024”), copyright years, “last updated” strings in body text, and version numbers — and compare against content\_age\_days. A page whose title says 2024 is self-reporting its own staleness regardless of its metadata.

* R-6.5-10 — **Content currency check (LLM, deliberately shallow).** Runs only when cap.llm\_judge \= true and the page type is date-sensitive under R-6.5-8. The judge receives the extracted main content (R-S6-1 limits apply) and answers one question: **does this page state anything that more recent, widely-established information contradicts?** For each such claim it returns the verbatim quote, a one-sentence statement of what is the case now, and a reference URL supporting the correction. Bounds, all binding: at most currency.max\_claims (default 5\) claims per page; no multi-source corroboration, no deep research, no attempt to date the claim precisely. This is an initial-audit signal, not fact-checking. A claim returned without both a verbatim quote and a resolving reference URL is discarded and never reported. Output is MODELLED and carries the Section 6 caveat.

### **CONDITIONS**

| \# | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| C-6.5-a | ≥ 1 date signal present, valid, consistent across sources, and content\_age\_days within threshold for the page type | PASS | — | — |
| C-6.5-b | No date signal from any source on a date-sensitive page type | WARN | MEDIUM | NO\_DATE\_SIGNAL |
| C-6.5-c | dateModified earlier than datePublished | FAIL | MEDIUM | DATE\_LOGIC\_INVALID |
| C-6.5-d | Future date | FAIL | MEDIUM | DATE\_IN\_FUTURE |
| C-6.5-e | Unparseable date value | FAIL | LOW | DATE\_UNPARSEABLE |
| C-6.5-f | Build-timestamp pattern (R-6.5-4) | WARN | HIGH | DATEMODIFIED\_IS\_BUILD\_TIMESTAMP — the freshness signal carries no information |
| C-6.5-g | content\_age\_days \> th.freshness\_stale\_days (540) on a date-sensitive page | WARN | MEDIUM | CONTENT\_STALE |
| C-6.5-h | content\_age\_days \> th.freshness\_warn\_days (365) on a date-sensitive page | WARN | LOW | CONTENT\_AGEING |
| C-6.5-i | Title/heading contains a year ≥ 2 years old | WARN | MEDIUM | SELF\_REPORTED\_STALENESS |
| C-6.5-j | Median sampled content\_age\_days \> th.freshness\_stale\_days | WARN | MEDIUM | SITE\_CONTENT\_STALE |
| C-6.5-k | Page type is not date-sensitive | NOT\_APPLICABLE | — | EVERGREEN\_PAGE\_TYPE |
| C-6.5-l | ≥ 1 page claim contradicted by more recent information (R-6.5-10) | WARN | MEDIUM | CONTENT\_FACTUALLY\_OUTDATED (MODELLED) — evidence carries the quote, the one-sentence correction and the reference URL |
| C-6.5-m | cap.llm\_judge \= false | Deterministic findings only | — | RUBRIC\_DISABLED — the currency check did not run |

### **EXCEPTIONAL CONDITIONS**

* E-6.5-1 — **Genuinely evergreen content.** C-6.5-k — an About page from 2019 that is still accurate is not stale. Never apply age thresholds to it.

* E-6.5-2 — **dateModified** **\=** **datePublished.** Correct for content never revised. Not a finding.

* E-6.5-3 — **News archives.** Old dates are the point. Where the URL matches an archive/date signature, C-6.5-g → INFO.

* E-6.5-4 — **Date formats that are locale-ambiguous** (03/04/2026). Where the locale cannot be determined, record both interpretations and set DATE\_AMBIGUOUS; never pick one silently, and use the more conservative interpretation for content\_age\_days.

* E-6.5-5 — **A page legitimately updated today.** Not a build-timestamp artefact. C-6.5-f requires the pattern across *more than half* the sample.

### **BACKUP PLANS**

* B-6.5-1 — No schema date → visible date → Last-Modified header, in that order, recording which supplied the value.

* B-6.5-2 — No date anywhere → C-6.5-b; do not infer age from content, archive services, or domain registration.

* B-6.5-3 — Ambiguous format → E-6.5-4 path.

* B-6.5-4 — RENDERED unavailable → visible-date detection is limited to RAW; caveat, and C-6.5-i NOT\_TESTABLE.

### **FAILING & STOPPING PLAN**

* F-6.5-1 — Never infer a date the page does not state. No third-party archive lookups, no domain-age proxies.

* F-6.5-2 — Never apply staleness thresholds to evergreen page types.

* F-6.5-3 — Never recommend updating dateModified without a genuine content change — dateModified should represent a real modification, not a template run, and a tool that encourages otherwise is training the site to emit a meaningless signal.

* F-6.5-4 — Never treat a single recent dateModified as a build artefact; the pattern requires a majority of the sample.

* F-6.5-5 — Never merge date signals into one “best” value without recording which source supplied it.

* F-6.5-6 — Never emit CONTENT\_FACTUALLY\_OUTDATED without both a verbatim quote from the page and a resolving reference URL. Never paraphrase the page’s claim beyond the one-sentence correction, and never expand the currency check into general fact-checking or claim-by-claim verification.

* F-6.5-7 — Never let the currency check change content\_age\_days, CONTENT\_STALE or any date-derived finding. It is an independent signal reported alongside them.

---

# **APPENDIX A — Scoring**

R-SCORE-1 — Score is computed **per section**, then rolled up. It is never computed as a flat percentage of all checks, because a CRITICAL crawl block and a long meta description are not commensurable.

**Per-check points:** PASS \= 1.0 · WARN \= 0.5 − (0.1 × severity\_rank) where rank is LOW=0, MEDIUM=1, HIGH=2, CRITICAL=3, floored at 0.1 · FAIL \= 0.0 · NOT\_APPLICABLE / NOT\_TESTABLE / ERROR \= **excluded from both numerator and denominator**.

R-SCORE-2 — For page-level checks, the check’s score is the mean across sampled pages, and the report shows the per-page breakdown, never only the mean.

R-SCORE-3 — Section score \= Σ points ÷ Σ eligible checks. Report alongside it: checks\_evaluated, checks\_not\_applicable, checks\_not\_testable. A section score of 1.0 over 2 evaluated checks and 6 untestable ones must not look like a section score of 1.0 over 8\.

R-SCORE-4 — Overall score is a weighted mean of section scores. Default weights, configurable: Crawl & Indexing 30, On-Page 15, Structured & International 20, Performance 10, LLM/AI Access 10, LLM Content Readiness 15\.

R-SCORE-5 — **Gating rule.** Any CRITICAL FAIL caps the overall score at 40 and forces audit\_verdict \= BLOCKED. A site Googlebot cannot crawl does not get a good score for having tidy titles.

R-SCORE-6 — If checks\_not\_testable \> 25% of in-scope checks, the overall score is suppressed entirely and replaced by INSUFFICIENT\_EVIDENCE, with the list of missing inputs. A score computed over a quarter-blind audit is worse than no score.

R-SCORE-7 — Scores derived even partly from MODELLED inputs carry the section-level caveat. Section 6’s score is always MODELLED-tainted when the judge ran.

R-SCORE-8 — No score is emitted for any check whose status is NOT\_TESTABLE (F-NEVER-6).

R-SCORE-9 — **Report-section routing.** A finding is scored in the section named by its report\_section, which defaults to the section its check lives in. Where a rule assigns a different report\_section (R-3.2-15), the finding counts toward that section’s numerator and denominator and toward no other. The report lists it once, under the section it was routed to, with the originating check ID retained in evidence.

---

# **APPENDIX B — Output contract**

{

“run”: {

“run\_id”: “uuid”,

“started\_at”: “ISO-8601”,

“finished\_at”: “ISO-8601”,

“run\_status”: “COMPLETED | ABORTED | PARTIAL”,

“run\_quality”: “OK | DEGRADED”,

“abort\_reason”: “reason\_code | null”,

“tool\_version”: “1.1.0”,

“rubric\_version”: “s6-2026-09”,

“threshold\_set\_version”: “2026-09”,

“capabilities”: { “render\_js”: true, “serp\_api”: false, “psi\_api”: true,

              "crux\_api": true, "commoncrawl": true, "gsc\_api": false,

              "llm\_judge": true, "ua\_probe": false },

“flags”: \[“SCOPE\_SUBPATH”, “DISCOVERY\_DEGRADED”\]

},

“target”: {

“seed”: “example.com”,

“canonical\_origin”: “https://www.example.com”,

“origin\_variants”: \[{ “url”: “…”, “final\_url”: “…”, “status”: 301, “hops”: 1 }\],

“site\_shape”: “multi\_page | single\_page”,

“is\_multilingual”: false,

“multilingual\_signals”: \[\],

“render\_strategy”: “SSR | SSG | HYDRATED | CSR | HYBRID”,

“env”: “production | staging”

},

“discovery”: {

“links\_harvested”: 128,

“groups”: \[{ “signature”: “/blog/\*“,”member\_count”: 20, “true\_member\_count”: 412,

         "saturated": true, "example\_url": "…", "depth": 2,

         "discovery\_methods": \["homepage\_link"\] }\],

“robots\_blocked\_candidates”: \[\],

“auditor\_blocked\_only”: \[\],

“fetch\_count”: 47,

“unresponsive\_urls”: \[\],

“budget\_class\_applied”: “primary | secondary”,

“caps\_hit”: \[\]

},

“sitemap\_access”: {

“variant\_scope”: “apex\_www | host\_only | canonical\_only”,

“candidates”: \[{ “url”: “https://www.example.com/sitemap\_index.xml”, “source”: “robots\_txt | fixed\_path”,

             "class": "SAME\_DOMAIN | CROSS\_HOST | INVALID", "reachable": true }\],

“located\_sitemaps”: \[“/sitemap\_index.xml”\],

“matrix”: \[{ “path”: “/sitemap\_index.xml”, “variant”: “http://example.com”,

         "request\_url": "http://example.com/sitemap\_index.xml",

         "chain": \[{ "url": "http://example.com/sitemap\_index.xml", "status": 301,

                     "location": "https://www.example.com/sitemap\_index.xml" }\],

         "final\_url": "https://www.example.com/sitemap\_index.xml", "final\_status": 200,

         "hop\_count": 1, "final\_path\_differs": false, "final\_off\_domain": false,

         "verdict": "OPEN", "variant\_failure": null }\],

“requests\_used”: 9,

“caps\_hit”: \[\]

},

“sample”: {

“quality”: “FULL | PARTIAL | MINIMAL | SINGLE”,

“pages”: \[{

“url”: “https://www.example.com/pricing”,

“page\_type”: “pricing”,

“alt\_types”: \[\],

“pattern\_signature”: “/pricing”,

“group\_member\_count”: 1,

“discovery\_method”: “homepage\_link”,

“selection\_reason”: “highest score in group; fills rank-5 slot”,

“score\_breakdown”: { “depth”: 3, “one\_click”: 2, “schema”: 2 },

“final\_status”: 200,

“indexability\_state”: “INDEXABLE”

}\],

“page\_type\_absent”: \[{ “page\_type”: “author”, “reason”: “NO\_QUALIFYING\_CANDIDATE” }\]

},

“results”: \[{

“check\_id”: “C-1.5”,

“check\_name”: “Canonical Tags”,

“section”: “1”,

“scope”: “page”,

“target\_url”: “https://www.example.com/pricing”,

“status”: “FAIL”,

“severity”: “HIGH”,

“confidence”: “OBSERVED”,

“reason\_code”: “CANONICAL\_TO\_REDIRECT”,

“caveat”: null,

“summary”: “Canonical points to a URL that 301-redirects.”,

“sources”: \[

{ “ref”: “G7”, “publisher”: “Google”, “title”: “How to specify a canonical with rel=canonical and other methods”,

"url": "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls",

"tier": "VENDOR\_DOC", "note": "A canonical should point at a URL that returns 200, not at a redirect." },

{ “ref”: “SEJ1”, “publisher”: “Search Engine Journal”, “title”: “…”, “url”: “…”,

"tier": "INDUSTRY\_COMMENTARY", "note": "Corroborating practitioner analysis; does not affect status (R-SRC-3)." }

\],

“evidence”: \[{

“kind”: “dom\_node”,

“source\_url”: “https://www.example.com/pricing”,

“fetch\_profile”: “RAW”,

“selector\_or\_key”: “head \> link\[rel=canonical\]”,

“observed\_value”: “”,

“expected\_value”: “https://www.example.com/pricing”,

“observed\_at”: “2026-09-08T11:04:12Z”

}\],

“remediation”: {

“action”: “Point the canonical at the redirect target.”,

“current”: “https://example.com/pricing”,

“proposed”: “https://www.example.com/pricing”,

“confidence”: “DERIVED”

},

“cross\_references”: \[“C-1.4”, “C-1.7”\]

}\],

“scores”: {

“sections”: \[{ “section”: “1”, “score”: 0.62, “evaluated”: 8,

           "not\_applicable": 0, "not\_testable": 0, "weight": 30 }\],

“overall”: 0.58,

“verdict”: “BLOCKED | NEEDS\_WORK | HEALTHY | INSUFFICIENT\_EVIDENCE”,

“gated\_by”: \[“C-1.1: ROBOTS\_BLOCKS\_GOOGLEBOT\_SITEWIDE”\],

“caveats”: \[“Section 6 sub-scores are modelled estimates…”\]

}

}

R-OUT-1 — Renderers must never drop caveat, confidence, or not\_testable counts. R-OUT-2 — remediation.proposed is present only where derivable from observed data. Never fabricated. R-OUT-3 — Every FAIL/WARN populates cross\_references where another check bears on the same cause.

---

# **APPENDIX C — Additions beyond the checklist**

Recommended for a future scope expansion. Each is out of scope for this release and must not be built until the checklist items above are complete and passing their own tests. They are listed because they are the gaps a reader of this audit will notice first.

| \# | Addition | Why it belongs in a technical \+ LLM-visibility audit |
| :---- | :---- | :---- |
| A1 | **Pagination handling** — rel=next/prev presence (Google no longer uses it for indexing, but it remains a UX/discovery signal), crawlable pagination links, canonical behaviour on paginated series | Faceted and paginated sets are where crawl budget is actually lost |
| A2 | **Faceted-navigation / parameter analysis** — parameter inventory, combinatorial URL explosion, Disallow/canonical strategy | The single largest crawl-budget failure mode on e-commerce |
| A3 | **Log-file analysis** — real Googlebot and AI-agent hit distribution, crawl frequency by template, wasted crawl on non-200s | The only way to measure crawl budget rather than infer it. Requires operator-supplied logs; belongs in a follow-up engagement, not an initial audit |
| A4 | **Crawler verification** — reverse DNS and vendor IP-range JSON matching for Googlebot, GPTBot, ClaudeBot, PerplexityBot, CCBot | Distinguishes real agents from spoofed UAs in logs; pairs with A3 |
| A5 | **Mobile parity** — content, links and structured data compared between mobile and desktop rendering | Mobile-first indexing means the mobile rendering is the indexed one |
| A6 | **Image and media SEO** — alt coverage, filename semantics, loading=lazy on above-fold LCP images, next-gen formats | LCP diagnosis and multimodal retrieval both depend on it |
| A7 | **Accessibility overlap** — landmark regions, heading order, alt text, lang attributes | Every one of these is also an extraction signal; the overlap is free value |
| A8 | **Security headers** — HSTS, CSP, X-Content-Type-Options, mixed-content detection | Mixed content breaks rendering and therefore indexing |
| A9 | **/.well-known/** **inventory** — security.txt, agents.json and similar emerging agent-interface declarations | The machine-readable-interface layer is where the AI-access conversation is heading |
| A10 | **Content-negotiation / markdown-twin verification** — Accept: text/markdown support with Vary: Accept, .md path availability | Removes extraction ambiguity for non-browser fetchers entirely; partially covered in C-5.3/C-6.1, worth a first-class check |
| A11 | **Duplicate-content clustering across the sample** — shingle-based near-duplicate detection between sampled pages | Catches template-generated thin pages that canonical analysis alone misses |
| A12 | **Entity** **sameAs** **verification** — confirming linked profiles actually reference back to the site | A one-way sameAs is a claim, not a corroboration |
| A13 | **Breadcrumb/URL-taxonomy coherence** — does BreadcrumbList match the URL hierarchy and the visible navigation | Three independent statements of site structure that frequently disagree |
| A14 | **X-Robots-Tag** **coverage on non-HTML assets** — PDFs, images, downloads | The most-forgotten indexing surface |
| A15 | **Redirect-map export** — full observed chain map as CSV | Makes remediation actionable rather than descriptive |

---

# **APPENDIX D — reason\_code registry**

Every code emitted anywhere in this document is registered here. Codes are stable identifiers: never renamed, never reused for a different meaning. New codes are appended.

**Each code additionally carries its source mapping** — one or more refs into Appendix E, with the tier that governs the maximum status the code may carry (R-SRC-1, R-SRC-3). The mapping lives beside the code in the implementation registry, not in this table, and is validated at build: a code with no mapped source fails the build. A code whose only mapped sources are INDUSTRY\_STUDY or INDUSTRY\_COMMENTARY may not be declared with status FAIL or severity CRITICAL anywhere in this document.

**Run-level:** SEED\_DNS\_FAILURE, ORIGIN\_UNREACHABLE, ACCESS\_DENIED, RATE\_LIMITED\_BY\_TARGET, BOT\_PROTECTION\_DETECTED, BUDGET\_EXHAUSTED, ROBOTS\_UNAVAILABLE\_CONSERVATIVE\_MODE, EMPTY\_HOMEPAGE, NO\_SELECTABLE\_PAGES, DISCOVERY\_CAP\_REACHED, DISCOVERY\_DEGRADED, SCOPE\_SUBPATH, CONSENT\_WALL\_RAW, SITE\_PLACEHOLDER, HOMEPAGE\_IS\_SELECTOR, INSUFFICIENT\_EVIDENCE.

**Discovery / sampling:** SINGLE\_PAGE\_SITE, NAV\_REQUIRES\_JS, NON\_ANCHOR\_NAVIGATION, PAGINATION\_REQUIRES\_INTERACTION, GROUP\_EXPLOSION, GROUP\_DOMINANCE, GROUPING\_DEGRADED\_TO\_DEPTH, TRAILING\_SLASH\_REDIRECT, QUERY\_DRIVEN\_GROUP, NO\_QUALIFYING\_CANDIDATE, CAP\_REACHED, SELECTION\_REPLACED, SAMPLE\_INCLUDES\_NONINDEXABLE, GATED\_EXCLUDED, PATH\_PROBE, COMMON\_CRAWL, OPERATOR\_SUPPLIED, INSUFFICIENT\_SAMPLE, CONTENT\_ON\_EXTERNAL\_HOST, MULTIPLE\_LIVE\_ORIGINS.

**§1 robots/sitemap:** ROBOTS\_BLOCKS\_GOOGLEBOT\_SITEWIDE, ROBOTS\_BLOCKS\_AUDITED\_URL, ROBOTS\_UNAVAILABLE, ROBOTS\_IS\_HTML, ROBOTS\_ABSENT\_TREATED\_AS\_ALLOW\_ALL, ROBOTS\_REDIRECT\_CHAIN, ROBOTS\_OVERSIZE, ROBOTS\_MALFORMED\_LINES, ROBOTS\_UNSUPPORTED\_DIRECTIVE, ROBOTS\_BLOCKS\_RENDER\_RESOURCES, ROBOTS\_EMPTY, ROBOTS\_ENCODING, ROBOTS\_CROSS\_HOST, ROBOTS\_CHECK\_ERROR, ROBOTS\_HTTP\_ONLY, STAGING\_BLOCK\_EXPECTED, BLOCKED\_BY\_ROBOTS\_FOR\_AUDITOR, AUDITOR\_BLOCKED\_ONLY, NO\_SITEMAP\_FOUND, SITEMAP\_UNREACHABLE, SITEMAP\_CROSS\_HOST, SITEMAP\_VARIANT\_NOT\_OPEN, SITEMAP\_VARIANT\_INCONCLUSIVE, SITEMAP\_LOCATE\_INCONCLUSIVE, SITEMAP\_DECLARATION\_INVALID, HREFLANG\_NO\_RETURN\_LINK, HREFLANG\_TARGET\_BROKEN, HREFLANG\_CANONICAL\_CONFLICT, HREFLANG\_DUPLICATE\_CODE.

**§1 status/redirect/canonical/robots-meta/indexability:** SERVER\_ERROR, CLIENT\_ERROR, PAGE\_NOT\_FOUND, SOFT\_404\_HANDLING, SOFT\_404\_PAGE, ACCESS\_RESTRICTED, RATE\_LIMITED, TLS\_INVALID, NO\_HTTPS\_REDIRECT, RESPONSE\_EXCEEDS\_2MB, RESPONSE\_EXCEEDS\_15MB, EMPTY\_RESPONSE, UNEXPECTED\_CONTENT\_TYPE, REDIRECT\_LOOP, TRUNCATED\_RESPONSE, AUDITOR\_UA\_BLOCKED, MAINTENANCE\_MODE, GEO\_RESTRICTED, CDN\_ERROR, REDIRECT\_CHAIN\_LONG, REDIRECT\_HOPS\_EXCEEDED, REDIRECT\_CHAIN, HTTPS\_DOWNGRADE, TEMPORARY\_REDIRECT\_FOR\_PERMANENT\_MOVE, REDIRECT\_TO\_HOME, META\_REFRESH\_REDIRECT, JS\_ONLY\_REDIRECT, REDIRECT\_TARGET\_BROKEN, REDIRECT\_TARGET\_NONINDEXABLE, CLIENT\_SIDE\_REDIRECT\_DIVERGENCE, RELATIVE\_LOCATION\_HEADER, MALFORMED\_REDIRECT, JS\_REDIRECT, BOT\_PROTECTION, UNKNOWN\_DIRECTIVE, MULTIPLE\_CANONICALS, CANONICAL\_IN\_BODY, CANONICAL\_RELATIVE, CANONICAL\_INVALID, CANONICAL\_TARGET\_BROKEN, CANONICAL\_TO\_REDIRECT, CANONICAL\_TO\_NOINDEX, CANONICAL\_TO\_BLOCKED, CANONICAL\_LOOP, CANONICAL\_CHAIN, CANONICAL\_CHAIN\_DEEP, CANONICAL\_NON\_RECIPROCAL, CANONICAL\_ABSENT, CANONICAL\_JS\_INJECTED, CANONICAL\_RAW\_RENDERED\_MISMATCH, CANONICAL\_HEADER\_HTML\_CONFLICT, CANONICAL\_NORMALISATION\_MISMATCH, CANONICAL\_HAS\_FRAGMENT, CANONICAL\_CLUSTER, CANONICAL\_CROSS\_DOMAIN, CANONICAL\_DUPLICATED\_IDENTICAL, HEAD\_MALFORMED\_CANONICAL\_AT\_RISK, NOINDEX\_PRESENT, NOINDEX\_UNREACHABLE, NOFOLLOW\_PRESENT, NOINDEX\_REMOVED\_BY\_JS, NOINDEX\_ADDED\_BY\_JS, ROBOTS\_DIRECTIVE\_CONFLICT, NOSNIPPET\_PRESENT, MAX\_SNIPPET\_ZERO, NO\_IMAGE\_PREVIEW, UNAVAILABLE\_AFTER\_EXPIRED, META\_ROBOTS\_IN\_BODY, META\_ROBOTS\_IN\_NOSCRIPT, MULTIPLE\_META\_ROBOTS, DATA\_NOSNIPPET\_INVALID\_ELEMENT, NOINDEX\_INTENTIONAL, STAGING\_NOINDEX\_EXPECTED, NOT\_INDEXABLE\_ROBOTS, NOT\_INDEXABLE\_NOINDEX, NOT\_INDEXABLE\_STATUS, NOT\_INDEXABLE\_SOFT\_404, NOT\_INDEXABLE\_CANONICAL, CANONICALISED\_BY\_DESIGN, NOT\_INDEXABLE\_EMPTY, INDEXABILITY\_CONFLICT, INDEXABLE\_ONLY\_AFTER\_RENDER, GSC\_STATE\_DIVERGENCE, HOMEPAGE\_NOT\_INDEXABLE, LOW\_INDEXABLE\_RATIO, PAGE\_NOT\_RESPONDING.

**§2:** TITLE\_MISSING, TITLE\_EMPTY, TITLE\_MULTIPLE, TITLE\_JS\_INJECTED, TITLE\_RAW\_RENDERED\_MISMATCH, TITLE\_DUPLICATE, TITLE\_NEAR\_DUPLICATE, TITLE\_BOILERPLATE, TITLE\_KEYWORD\_STUFFED, TITLE\_OUTSIDE\_HEAD, TITLE\_H1\_BRAND\_ONLY, TITLE\_PLACEHOLDER\_LEAK, TITLE\_EXTRACTED\_BY\_REGEX, METADESC\_MISSING, METADESC\_EMPTY, METADESC\_MULTIPLE, METADESC\_DUPLICATE, METADESC\_TEMPLATED, METADESC\_KEYWORD\_LIST, METADESC\_JS\_INJECTED, METADESC\_RAW\_RENDERED\_MISMATCH, METADESC\_PLACEHOLDER\_LEAK, METADESC\_EQUALS\_TITLE, SNIPPET\_SUPPRESSED, H1\_MISSING, H1\_EMPTY, H1\_MULTIPLE, H1\_HIDDEN, H1\_JS\_INJECTED, H1\_RAW\_RENDERED\_MISMATCH, H1\_DUPLICATE, HEADING\_LEVEL\_SKIP, HEADING\_STARTS\_BELOW\_H1, HEADINGS\_EMPTY\_MULTIPLE, HEADINGS\_LAYOUT\_MISUSE, H1\_IS\_SITE\_NAME, NO\_HEADINGS, H1\_PLACEHOLDER\_LEAK, H1\_IMAGE\_ALT, ARIA\_HEADING\_PRESENT, MAIN\_REGION\_UNDETERMINED, BROKEN\_INTERNAL\_LINK, ORPHAN\_IN\_SAMPLE, GENERIC\_ANCHOR\_TEXT, EMPTY\_ANCHOR, INTERNAL\_NOFOLLOW, NO\_CONTEXTUAL\_LINKS, LINKS\_REQUIRE\_JS, LINK\_ZONING\_DEGRADED, LINK\_VALIDATION\_CAPPED.

**§3:** NO\_STRUCTURED\_DATA, JSONLD\_PARSE\_ERROR, SCHEMA\_REQUIRED\_FIELD\_MISSING, SCHEMA\_DANGLING\_REFERENCE, SCHEMA\_UNSTABLE\_ENTITY\_ID, SCHEMA\_DUPLICATE\_ENTITY, SCHEMA\_URL\_CANONICAL\_MISMATCH, SCHEMA\_CONTENT\_MISMATCH, SCHEMA\_TYPE\_MISUSE, SCHEMA\_INVALID\_PROPERTY\_CASE, SCHEMA\_PLACEHOLDER\_VALUE, SCHEMA\_INVALID\_DATE, SCHEMA\_JS\_INJECTED, SCHEMA\_RAW\_RENDERED\_MISMATCH, SCHEMA\_ON\_BLOCKED\_PAGE, SCHEMA\_OUT\_OF\_SCOPE\_DETECTED, FAQ\_MARKUP\_INVALID, SCHEMA\_TYPE\_ABSENT, SCHEMA\_ID\_NO\_FRAGMENT, SCHEMA\_IN\_NOSCRIPT, SYNTAX\_COVERAGE\_PARTIAL, MONOLINGUAL\_SITE, HREFLANG\_NO\_SELF\_REFERENCE, HREFLANG\_INVALID\_CODE, HREFLANG\_REGION\_ONLY, HREFLANG\_RELATIVE\_URL, HREFLANG\_TARGET\_NONINDEXABLE, HREFLANG\_NO\_X\_DEFAULT, HREFLANG\_HTML\_LANG\_MISMATCH, HREFLANG\_MECHANISM\_CONFLICT, HREFLANG\_JS\_INJECTED, HREFLANG\_SINGLETON\_CLUSTER, HREFLANG\_IN\_BODY, HREFLANG\_GEO\_REDIRECT, HREFLANG\_VERIFICATION\_SAMPLED, HREFLANG\_VERIFICATION\_INCOMPLETE, HREFLANG\_POSSIBLY\_MISSING, HREFLANG\_NOT\_FOUND\_IN\_HTML\_OR\_HEADERS, HREFLANG\_RETURN\_LINK\_UNVERIFIABLE, NO\_ENTITY\_MARKUP, FAQ\_MARKUP\_CONTENT\_MISMATCH, FAQ\_NOT\_MARKED\_UP, SPEAKABLE\_SELECTOR\_UNRESOLVED, WEAK\_ENTITY\_ANCHORING, AMBIGUOUS\_ENTITY\_UNANCHORED, NO\_AUTHOR\_MARKUP, DATE\_NOT\_USER\_VISIBLE.

**§4:** CWV\_POOR, CWV\_NEEDS\_IMPROVEMENT, CWV\_ORIGIN\_LEVEL\_ONLY, CWV\_ORIGIN\_LEVEL\_FAILING, CWV\_NO\_FIELD\_DATA, CWV\_NO\_DATA, CRUX\_RECORD\_NOT\_FOUND, CWV\_QUOTA\_EXHAUSTED, CWV\_NO\_API\_KEY, LAB\_RUN\_FAILED, CWV\_LONG\_TAIL, CWV\_FORM\_FACTOR\_DIVERGENCE, CWV\_DATA\_STALE, LAB\_VARIANCE\_POSSIBLE, LAB\_CONSENT\_INTERFERENCE.

**§5:** AI\_RETRIEVAL\_AGENT\_BLOCKED, ALL\_AI\_AGENTS\_BLOCKED, AI\_TRAINING\_BLOCKED\_BY\_CHOICE, GOOGLE\_EXTENDED\_DISALLOWED, APPLEBOT\_EXTENDED\_DISALLOWED, AI\_ACCESS\_UNDECLARED, AI\_BLOCKED\_BY\_WILDCARD, AI\_BLOCKED\_AT\_SERVER, AI\_INPUT\_SUPPRESSED\_BY\_SNIPPET\_DIRECTIVE, CONTENT\_SIGNAL\_DECLARED, CONTENT\_SIGNAL\_CONTRADICTION, AI\_BLOCKED\_ON\_CONTENT\_PATHS, AI\_CHALLENGE\_NOT\_BLOCK, UNKNOWN\_AGENT\_RULES, CONTENT\_REQUIRES\_JS, CONTENT\_PARTIALLY\_REQUIRES\_JS, CONTENT\_MOSTLY\_RAW, SPA\_SHELL\_ONLY, H1\_REQUIRES\_JS, TITLE\_REQUIRES\_JS, CANONICAL\_REQUIRES\_JS, NOSCRIPT\_NOT\_SUBSTANTIVE, NOSCRIPT\_SUBSTANTIVE, CONTENT\_REMOVED\_BY\_JS, NO\_CONTENT\_EITHER\_PROFILE, RENDER\_UNAVAILABLE, RENDER\_FAILED, RENDER\_VARIANCE\_POSSIBLE, LAZY\_CONTENT\_BELOW\_FOLD, CONSENT\_GATED\_CONTENT, DYNAMIC\_RENDERING\_DETECTED, EXTRACTION\_DEGRADED, LLMS\_TXT\_ABSENT, LLMS\_TXT\_IS\_HTML, LLMS\_TXT\_NO\_H1, LLMS\_TXT\_NO\_LINK\_SECTIONS, LLMS\_TXT\_BROKEN\_LINKS, LLMS\_TXT\_LINKS\_BLOCKED, LLMS\_TXT\_LOW\_COVERAGE, LLMS\_TXT\_UNREACHABLE, LLMS\_TXT\_SOFT\_404, LLMS\_TXT\_NO\_SUMMARY, LLMS\_TXT\_ENTITY\_INCONSISTENT, MARKDOWN\_TWINS\_PRESENT, LLMS\_TXT\_CONTRADICTS\_ROBOTS, LLMS\_TXT\_SITEMAP\_CLONE, PARSER\_DEGRADED, AI\_INSTRUCTIONS\_PAGE\_ABSENT, AI\_INSTRUCTIONS\_PAGE\_THIN, AI\_INSTRUCTIONS\_PAGE\_BLOCKED, AI\_INSTRUCTIONS\_PAGE\_REQUIRES\_JS, AI\_INSTRUCTIONS\_PAGE\_ORPHANED, ENTITY\_DESCRIPTION\_CONFLICT, AI\_INSTRUCTIONS\_NO\_DATE, AI\_INSTRUCTIONS\_NO\_COMPETITIVE\_CONTEXT, AI\_INSTRUCTIONS\_NO\_DIRECTIVES, AI\_INSTRUCTIONS\_CLAIM\_CONTRADICTED, AI\_INSTRUCTIONS\_STALE, AI\_INSTRUCTIONS\_MULTIPLE, AI\_INSTRUCTIONS\_SERVED\_BY\_ABOUT, AI\_INSTRUCTIONS\_CANDIDATE\_UNCERTAIN, RENDER\_NOT\_REQUIRED, RENDER\_BUDGET\_UNAVAILABLE.

**§6:** RAW\_CONTENT\_ABSENT, RAW\_CONTENT\_THIN, CONTENT\_BOUNDARIES\_AMBIGUOUS, CONTENT\_BOUNDARIES\_UNCLEAR, BOILERPLATE\_DOMINANT, CONTENT\_IN\_IMAGES, CONTENT\_IN\_IFRAME, CONTENT\_IN\_HIDDEN\_PANELS, ENCODING\_CORRUPTION, NO\_SEMANTIC\_HTML, LOW\_TEXT\_TO\_HTML\_RATIO, MARKDOWN\_TWIN\_AVAILABLE, UA\_CONDITIONAL\_CONTENT, RAW\_FETCH\_FAILED, EXTRACTION\_PARTIAL, ENTITY\_NAME\_INCONSISTENT, NO\_DEFINITIONAL\_STATEMENT, ENTITY\_DESCRIPTION\_INCONSISTENT, PAGE\_SUBJECT\_UNCLEAR, NO\_AUTHOR\_ATTRIBUTION, LOW\_ENTITY\_CLARITY, RUBRIC\_DISABLED, RUBRIC\_PARSE\_FAILED, NO\_CONTENT\_STRUCTURE, POOR\_CHUNK\_VIABILITY, MODERATE\_CHUNK\_VIABILITY, OVERLONG\_SECTIONS, OVERLONG\_PARAGRAPHS, INSUFFICIENT\_HEADINGS, LAYOUT\_TABLES, TABLE\_NO\_HEADERS, HEADING\_HIERARCHY\_BROKEN, INSUFFICIENT\_CONTENT\_FOR\_STRUCTURE, STRUCTURE\_ANALYSIS\_DEGRADED, CONTENT\_NOT\_SELF\_CONTAINED, WEAK\_SELF\_CONTAINMENT, QUESTIONS\_NOT\_DIRECTLY\_ANSWERED, NO\_DEFINITIONAL\_ANSWER, LOW\_FACTUAL\_DENSITY, NO\_ATTRIBUTION\_SCAFFOLDING, ANSWER\_ANTIPATTERNS, LOW\_EXTRACTABILITY, INSUFFICIENT\_CONTENT, NO\_DATE\_SIGNAL, DATE\_LOGIC\_INVALID, DATE\_IN\_FUTURE, DATE\_UNPARSEABLE, DATEMODIFIED\_IS\_BUILD\_TIMESTAMP, CONTENT\_STALE, CONTENT\_AGEING, SELF\_REPORTED\_STALENESS, SITE\_CONTENT\_STALE, EVERGREEN\_PAGE\_TYPE, DATE\_AMBIGUOUS, CONTENT\_FACTUALLY\_OUTDATED.

**C-1.2** **variant\_failure** **values** (DNS\_UNRESOLVED, CONNECTION\_REFUSED, CONNECT\_TIMEOUT\_HOST\_UP, TLS\_INVALID, HTTP\_4XX, HTTP\_5XX, NON\_200\_SUCCESS, HTTP\_3XX\_UNRESOLVED, REDIRECT\_LOOP, REDIRECT\_HOPS\_EXCEEDED, MALFORMED\_REDIRECT, CONNECT\_TIMEOUT, READ\_TIMEOUT, DNS\_ERROR, RATE\_LIMITED, BOT\_PROTECTION, GEO\_RESTRICTED, AUTH\_DENIED, CAP\_REACHED) are an evidence-field enum defined in R-1.2-7, not reason\_codes.

---

# **APPENDIX E — Source register**

Every threshold, behaviour and directive asserted in this PRD, and every finding the tool emits, traces to an entry here. Entries are governed by §4.1: each carries a tier, and the tier caps what a finding resting on it may claim. Where a source is a vendor’s own documentation about its own crawler, that is noted — it is a declaration of intent, not an independently verifiable fact.

**URL column.** Entries marked *capture at build* have no URL asserted in this document. Under R-SRC-4 a source URL is never guessed from a title; it is resolved and recorded when the registry is built, and the build fails if it does not resolve.

### **Standards**

| Ref | Publisher | Source | Tier | URL |
| :---- | :---- | :---- | :---- | :---- |
| R1 | IETF / ISO | RFC 9309 (Robots Exclusion Protocol), RFC 3986 (URI), RFC 4122 (UUID), RFC 7231 (HTTP semantics), RFC 6797 (HSTS), ISO 8601, ISO 639-1, ISO 3166-1 | STANDARD | capture at build |
| G6 | sitemaps.org | *Sitemaps XML format — protocol* | STANDARD | https://www.sitemaps.org/protocol.html |
| P1 | Mozilla Foundation | Public Suffix List | STANDARD | https://publicsuffix.org/ |
| SO1 | schema.org | Vocabulary — type and property definitions, case sensitivity | STANDARD | https://schema.org/ |

### **Vendor documentation**

| Ref | Publisher | Source | Tier | URL |
| :---- | :---- | :---- | :---- | :---- |
| G1 | Google | *How Google interprets the robots.txt specification* | VENDOR\_DOC | https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec |
| G2 | Google | *HTTP status codes, network and DNS errors* | VENDOR\_DOC | capture at build |
| G3 | Google | *Googlebot* | VENDOR\_DOC | https://developers.google.com/search/docs/crawling-indexing/googlebot |
| G4 | Google | *Google’s common crawlers* | VENDOR\_DOC | https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers |
| G5 | Google | *Build and submit a sitemap* | VENDOR\_DOC | capture at build |
| G7 | Google | *How to specify a canonical with rel=canonical and other methods* | VENDOR\_DOC | https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls |
| G8 | Google | *Robots meta tag, data-nosnippet and X-Robots-Tag specifications* | VENDOR\_DOC | https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag |
| G9 | Google | *JavaScript SEO basics* | VENDOR\_DOC | capture at build |
| G10 | Google | *Localized versions of your pages* | VENDOR\_DOC | https://developers.google.com/search/docs/specialty/international/localized-versions |
| G11 | Google | *General structured data guidelines* | VENDOR\_DOC | https://developers.google.com/search/docs/appearance/structured-data/sd-policies |
| G12 | Google | *Organization structured data* | VENDOR\_DOC | https://developers.google.com/search/docs/appearance/structured-data/organization |
| G13 | Google | *Product snippet structured data* | VENDOR\_DOC | https://developers.google.com/search/docs/appearance/structured-data/product-snippet |
| G14 | Google | *FAQPage structured data* — rich-result deprecation | VENDOR\_DOC | https://developers.google.com/search/docs/appearance/structured-data/faqpage |
| G15 | Google | *Title links* and *Snippets* | VENDOR\_DOC | capture at build |
| G16 | Google | *Top ways to ensure your content performs well in AI features* | VENDOR\_DOC | capture at build |
| W1 | Google / web.dev | *Web Vitals* | VENDOR\_DOC | capture at build |
| W2 | Google / Chrome | *CrUX API* | VENDOR\_DOC | capture at build |
| W3 | Google | *PageSpeed Insights API* | VENDOR\_DOC | capture at build |
| L1 | llmstxt.org | llms.txt proposal | VENDOR\_DOC — proposed, not adopted by any engine | https://llmstxt.org/ |
| C1 | Common Crawl | *CCBot* and index documentation; pywb *CDX Server API* | VENDOR\_DOC | capture at build |
| V1 | OpenAI | *Bots* (vendor declaration) | VENDOR\_DOC | capture at build |
| V2 | Anthropic | Crawler support article (vendor declaration) | VENDOR\_DOC | capture at build |
| V3 | Perplexity | *Bots* (vendor declaration) | VENDOR\_DOC | capture at build |
| V4 | Apple | *Applebot* (vendor declaration) | VENDOR\_DOC | capture at build |
| S1 | Cloudflare | Content Signals Policy, as implemented in the managed robots.txt | VENDOR\_DOC | capture at build |

### **Vendor statements**

A named employee of the vendor speaking in an official channel. A post in a public help community by someone who does not work for the vendor is **not** a registrable source at this tier, or at any tier.

| Ref | Publisher | Source | Tier | URL |
| :---- | :---- | :---- | :---- | :---- |
| GB1 | Google | Search Central Blog | VENDOR\_STATEMENT | https://developers.google.com/search/blog |
| GB2 | Google | *Search Off the Record* podcast | VENDOR\_STATEMENT | capture at build |
| G17 | Google | Search Relations (Gary Illyes) on the site: operator — “the site thing shows me some of the pages that are indexed” | VENDOR\_STATEMENT | capture at build |

### **Third-party research and commentary**

Registered so findings can be corroborated and the reader can go deeper. Under R-SRC-3 these never raise a finding’s status, and INDUSTRY\_COMMENTARY is never the sole basis for any status. Each citation is to a **specific dated article**, captured at registry build — the publisher root below is the starting point, not the citation.

| Ref | Publisher | Scope | Tier | Root |
| :---- | :---- | :---- | :---- | :---- |
| M1 | Moz | Learn SEO guides and Whiteboard Friday; published ranking-factor and crawl studies | INDUSTRY\_STUDY for studies with a stated method; INDUSTRY\_COMMENTARY otherwise | https://moz.com/learn/seo |
| A1 | Ahrefs | Blog research on crawl, index coverage, link and content patterns, at index scale | INDUSTRY\_STUDY for studies with a stated method and sample; INDUSTRY\_COMMENTARY otherwise | https://ahrefs.com/blog/ |
| SR1 | Semrush | Blog research and industry benchmark studies | INDUSTRY\_STUDY for studies with a stated method and sample; INDUSTRY\_COMMENTARY otherwise | https://www.semrush.com/blog/ |
| SEJ1 | Search Engine Journal | Reporting and practitioner analysis, including coverage of Google statements | INDUSTRY\_COMMENTARY | https://www.searchenginejournal.com/ |
| SER1 | Search Engine Roundtable | Reporting of Google statements and SERP behaviour changes | INDUSTRY\_COMMENTARY | https://www.seroundtable.com/ |
| SEL1 | Search Engine Land | Reporting and practitioner analysis | INDUSTRY\_COMMENTARY | https://searchengineland.com/ |

* R-SRC-8 — **Citing a third-party source that reports a vendor statement.** Cite both: the commentary entry for the reporting, and the vendor entry for the statement itself where one exists. Where the vendor has published nothing, the finding rests on VENDOR\_STATEMENT at best and is capped accordingly — a well-written article about a Googler’s remark does not turn that remark into documentation.

* R-SRC-9 — **Tool policy.** Any assertion in this PRD with no external source is registered as TOOL\_POLICY under ref T1, and the finding text must say so. T1 currently covers: the S1 required-field list for Organization, the redirect-chain warn/fail thresholds, the title and meta-description advisory bands, the content-structure thresholds, and every request and time budget in §2.2 and §2.3.

**Currency note:** thresholds and vendor behaviours in this document reflect the sources as of **8 September 2026**, and the register is re-resolved on the R-SRC-5 schedule thereafter. §2.3 carries a threshold\_set\_version; when a source changes, the registry is updated with a dated note and the version string is incremented. The tool must never score against an unannounced or anticipated change (R-4.1-0).



# **ADDENDUM A — Changes since v2.0, as implemented**

This addendum records every behaviour in the built tool that v2.0 does not describe. It is written
to be merged into the body of the PRD; until it is, this section is the specification for the items
it lists. Every rule here is either an **operator rule** (a decision taken during a live audit,
marked as such) or a **registry row for an exception v2.0 already defines** but never gave a row.

Nothing in this addendum introduces an SEO rule from outside the register. Where a threshold or a
severity is this tool's judgement rather than a documented requirement, the row says so and the
finding text repeats it.

**Implemented in TOOL\_VERSION 1.2.0.** Threshold set `2026-09`; rubric `s6-2026-09` (unchanged).

---

## **ADD-1 — Nine checkpoint rows added to the register**

Each of these reason codes was being emitted by the engine under a **borrowed checkpoint id**.
Because R-SRC resolution looks up the checkpoint before the reason code, every one of them resolved
to the row of a *different* rule, and the Reference affordance displayed that other rule's condition
text and sources. That is the failure F-SRC-2 names, so each now has an id and a row of its own.

| Checkpoint | reason\_code | Status | Severity | Provenance |
| :---- | :---- | :---- | :---- | :---- |
| C-1.1-l | STAGING\_BLOCK\_EXPECTED | WARN | LOW | E-1.1-12 |
| ~~C-1.2-i~~ | ~~SITEMAP\_VARIANT\_HOST\_MISMATCH~~ | — | — | **Withdrawn — see ADD-8** |
| C-1.3-s | MAINTENANCE\_MODE | WARN | MEDIUM | E-1.3-3 |
| C-1.4-p | TRAILING\_SLASH\_BOTH\_LIVE | FAIL | HIGH | **Operator rule** |
| C-1.5-u | CANONICAL\_DUPLICATED\_IDENTICAL | WARN | LOW | E-1.5-6 |
| C-1.6-o | STAGING\_NOINDEX\_EXPECTED | WARN | LOW | E-1.6-8 |
| C-1.6-p | META\_ROBOTS\_IN\_NOSCRIPT | WARN | HIGH | E-1.6-10 |
| C-3.2-t | HREFLANG\_POSSIBLY\_MISSING | WARN | MEDIUM | B-3.2-3 |
| C-5.3-o | LLMS\_TXT\_SITEMAP\_CLONE | WARN | LOW | C-5.3 quality judgement |

### **The two operator rules in full**

* **C-1.2-i — SITEMAP\_VARIANT\_HOST\_MISMATCH. Withdrawn.** It required every sitemap variant to
  reach 200 *at* the canonical host. The revised C-1.2 specification (ADD-8) states the opposite —
  a sitemap answering 200 on several hostnames must not fail the check — so the rule and its
  register row have been removed. Hostname consolidation is scored under C-1.4 and C-1.5, where it
  was already assessed.

* **C-1.4-p — TRAILING\_SLASH\_BOTH\_LIVE.** *Condition:* both the trailing-slash and the no-slash form
  return 2xx and neither redirects to the other. *Sources:* G7, G2. Google documents that the same
  content reachable at several URLs must be consolidated to one canonical form; **the document does
  not assign a severity**, so FAIL / HIGH is tool policy. Cross-references C-1.5. Where one form
  redirects to the other, the correct-consolidation note is emitted instead (E-1.4-4); where the
  opposite form returns 4xx, only one form is served and nothing is raised.

---

## **ADD-2 — Configuration added to section 2**

* **R-CFG-1 — `gate.robots_mode`**, one of `prd` or `strict`. Default **`strict`**.
  * `prd` — the v2.0 behaviour: a robots.txt failure halts the pipeline, but the control-file checks
    (C-1.2, C-5.3) still run, per F-RUN-6 / F-RUN-8.
  * `strict` — an **operator directive**: a robots.txt failure halts *everything*, and every other
    factor receives a halted result. This is the deployed default, because the execution protocol
    requires that no factor be evaluated after a gate failure.
  * A robots.txt that returns **404 still passes the gate** in both modes. An absent file is a valid
    "everything is allowed" state, not a failure.

* **R-CFG-2 — `sitemap.require_canonical_host`. Removed.** It enabled C-1.2-i, which ADD-8 withdraws. Hostname convergence is not a sitemap condition.

* **R-CFG-3 — `operator_urls[]` and `operator_urls_only`.** The operator may supply URLs directly.
  With `operator_urls_only = true`, discovery is skipped and only the supplied URLs are audited; the
  Min 1 / Max 10 bound and the robots.txt intersection (MODULE A.2) still apply to them. A single supplied
  URL does not make the site single-page: `site_shape` is still determined by A.0.

* **R-CFG-4 — `llm.request_timeout_ms` (120 000 ms) and `llm.max_retries` (1).** See ADD-4.

---

## **ADD-3 — Verdict vocabulary: BLOCKED is split**

v2.0 R-SCORE-5 forces verdict **BLOCKED** on any CRITICAL FAIL. In practice this labelled a site that
had been crawled completely, and whose critical failure was a content problem, as though the crawler
had been unable to reach it at all.

* **R-SCORE-5a** — a CRITICAL FAIL whose reason\_code is in the **crawl-blocking set** yields
  **BLOCKED**. That set is: ROBOTS\_BLOCKS\_GOOGLEBOT\_SITEWIDE, ROBOTS\_UNAVAILABLE,
  NOT\_INDEXABLE\_ROBOTS, NOT\_INDEXABLE\_NOINDEX, NOINDEX\_PRESENT, NOINDEX\_UNREACHABLE,
  HOMEPAGE\_NOT\_INDEXABLE, NOT\_INDEXABLE\_STATUS, SERVER\_ERROR, REDIRECT\_LOOP,
  REDIRECT\_HOPS\_EXCEEDED, HTTPS\_DOWNGRADE, TLS\_INVALID, AI\_BLOCKED\_BY\_WILDCARD,
  ORIGIN\_UNREACHABLE, ACCESS\_DENIED, NOT\_INDEXABLE\_EMPTY.
* **R-SCORE-5b** — any other CRITICAL FAIL yields **CRITICAL\_ISSUES**.
* The 40-point cap of R-SCORE-5 applies identically to both. Only the label changes.
* An aborted run whose gate failed remains **BLOCKED** regardless.

---

## **ADD-4 — The Section 6 LLM budget is a time budget as well as a call budget**

`llm.max_calls_per_run` bounds spend but not duration. The run deadline (`run.max_minutes`) is only
tested between operations, so a single unanswered request can outlast it and abort the run with
BUDGET\_EXHAUSTED — losing the entire report for the sake of one rubric.

* **R-S6-6** — every judge call carries an explicit wall-clock timeout (`llm.request_timeout_ms`) and
  a retry cap (`llm.max_retries`). The SDK defaults — a 10-minute timeout with 2 retries — permit
  30 minutes of silence for a single call and must not be relied on.
* **R-S6-7** — the judge refuses to **start** a call when less than `request_timeout_ms` remains
  before the run deadline, and emits `llm_budget` with reason `RUN_TIME_BUDGET` once. The remaining
  sub-scores become NOT\_TESTABLE, which R-SCORE-1 already excludes from numerator and denominator,
  and which R-SCORE-6 suppresses entirely above 25 %. Degrading the section is correct; losing the
  report is not.

---

## **ADD-5 — C-4.1 presentation when there is no field data**

No change to assessment. R-4.1-9 and F-4.1-1 stand: lab data never occupies a pass/fail position,
and a finding with no field data at any level remains **NOT\_TESTABLE** and outside the score.

* **R-4.1-14 — presentation.** Lab results are **displayed** on the C-4.1 finding whenever they
  exist, accompanied by a statement that they are one synthetic run from a single location on a
  simulated device, that the numbers move between runs, and that none of it is scored. They are
  rendered as a diagnostic panel without pass / warn / fail colouring, so that no reader can
  mistake a diagnostic for a verdict.

  Displayed per form factor: the four PageSpeed Insights **category scores** (Performance,
  Accessibility, Best Practices, SEO) in PSI's own bands — under 50 poor, 50–89 needs improvement,
  90 and above good — the **Agentic Browsing** result, and the lab Core Web Vitals measurements
  (LCP, CLS, TBT, Speed Index).

* **R-4.1-15 — the PSI request.** PageSpeed Insights returns only the `performance` category unless
  the others are named in the request. All five are requested in the one call:
  `performance`, `accessibility`, `best-practices`, `seo`, `agentic-browsing`.

* **R-4.1-16 — Agentic Browsing is reported as a count, not a percentage.** Its checks cover the
  agent accessibility tree, `llms.txt`, WebMCP form coverage, registered tools and schema validity,
  and `ai-catalog.json`. Most are `notApplicable` to most sites, and a page with no WebMCP
  integration is **not failing** those checks — it has nothing for them to read. So the result is
  given as *passed of applicable*, with the not-applicable checks named and the reason stated. This
  mirrors what PSI itself shows and is the only honest reading.

  Because `cumulative-layout-shift` is one of the applicable checks, this count can move between
  runs on the same page. That is a property of a single lab run, not a change in the site.

* **F-4.1-9 — none of R-4.1-14's figures may enter a score.** The category scores, the Agentic
  Browsing count and the lab metrics are lab measurements. Google's Core Web Vitals thresholds are
  defined against the 75th percentile of real users, and the remaining categories are not field
  measurements at all. A finding with no field data stays NOT\_TESTABLE and outside the score no
  matter how complete the lab panel beside it is.

---

## **ADD-6 — Report provenance**

* **R-RUN-9** — `run.tool_version` identifies the code that produced the report, and must be
  incremented whenever a change can alter a verdict, a score or a citation. A report produced by an
  earlier version is not comparable with a current one, and publication tooling must refuse it by
  default. 1.2.0 covers: the ADD-3 verdict split, C-1.4-p, the ADD-1 registry rows, the ADD-4
  budget bounds, and the revised C-1.2 specification in ADD-8.

---

## **ADD-7 — Items listed in the checklist but not specified**

These three appear in the audit checklist and are **displayed in the report**, but v2.0 defines no
rules, conditions, reason codes or sources for them. They are **never evaluated and never scored** —
they cannot raise or lower a percentage — and the report states why.

| Id | Item | Section | What is missing |
| :---- | :---- | :---- | :---- |
| ~~X-1.8~~ | ~~Googlebot Access (using SERP)~~ | 1 | **Now specified — see ADD-9.** |
| X-5.3b | LLms-full.txt | 5 | No conditions, and no registered specification for the file. |
| X-5.5 | Common Crawl presence | 5 | No conditions, and no threshold for what presence or absence would mean. |

**To specify any of them**, supply: the condition rows, the status and severity for each condition,
the reason codes, and at least one registered source per reason code (R-SRC-1). Without a source a
finding cannot be rendered under the attribution contract, and inventing one is forbidden by 4.1.

---

## **ADD-8 — C-1.2 XML Sitemap, revised specification**

This replaces the C-1.2 rules in the body of the PRD. The previous specification scored the check on
**variant reachability**: every protocol x host combination of the sitemap path had to answer 200,
and one that did not was a FAIL. That asks the wrong question. A sitemap either can be located and
fetched or it cannot; *which* hostnames also serve it is a consolidation question, already scored
under C-1.4 and C-1.5. Scoring it twice failed ordinary, working setups.

### **ADD-8.1 — Purpose and scope**

C-1.2 verifies that a usable **parent** sitemap can be located and fetched. It does **not**:

* crawl child sitemaps;
* extract or read sitemap URLs;
* compare sitemap URLs against the sampled pages;
* use sitemap URLs for page sampling;
* validate `lastmod`, `changefreq` or `priority`;
* compute sitemap coverage.

### **ADD-8.2 — Discovery order**

1. `Sitemap:` directives in robots.txt
2. `https://<canonical-host>/sitemap.xml`
3. `https://<canonical-host>/sitemap_index.xml`
4. `https://<canonical-host>/sitemap-index.xml`
5. `https://<canonical-host>/wp-sitemap.xml`

The first parent sitemap located is recorded. Items 4 and 5 are new in this revision.

### **ADD-8.3 — Variant check (optional, never decisive)**

For the located path the tool may test `https://www.`, `https://`, `http://www.` and `http://`
forms, recording `request_url`, `initial_status`, `redirect_chain`, `final_url`, `final_status` and
`hop_count`. These are recorded for the reader. **They do not determine the status.**

### **ADD-8.4 — PASS**

**PASS when at least one legitimately discovered or declared parent sitemap reaches a final HTTP
200**, whether directly or through a redirect chain. `200` passes; `301 → https → 200` passes;
`308 → canonical host → 200` passes. A sitemap returning 200 on **both** www and non-www **passes**.

### **ADD-8.5 — Conditions that must never fail this check**

Each of the following is recorded as an unscored note:

| Observation | Treatment |
| :---- | :---- |
| A non-canonical variant returns 200 | `SITEMAP_VARIANT_NOT_CANONICAL` — note |
| A non-canonical variant redirects to the canonical sitemap | Acceptable; nothing raised |
| An optional variant returns 404/410 while a valid sitemap exists | `SITEMAP_VARIANT_UNAVAILABLE` — note |
| An `http://` sitemap redirects to `https://` | Acceptable; nothing raised |
| The sitemap answers 200 at several addresses | `SITEMAP_MULTIPLE_ADDRESSES` — note |
| Redirect-chain quality | Scored under **C-1.4**, not here |
| Canonical-host consistency | Scored under **C-1.4 / C-1.5**, not here |

### **ADD-8.6 — WARN**

* **C-1.2-b — SITEMAP\_NOT\_FOUND (WARN / LOW).** No parent sitemap found through robots.txt or any
  supported standard location. **This must not be a FAIL**: Google does not require a site to have a
  sitemap.
* **C-1.2-j — SITEMAP\_PARTIALLY\_BROKEN (WARN / MEDIUM).** A declared sitemap is unavailable on every
  variant, while another valid declared or standard-location parent sitemap returns 200.

### **ADD-8.7 — FAIL**

FAIL only on clear evidence of a broken sitemap setup.

* **C-1.2-c — DECLARED\_SITEMAP\_UNAVAILABLE (FAIL / HIGH).** robots.txt explicitly declares a sitemap,
  **and** it returns 404/410/5xx or a network failure on every variant, **and** no other declared or
  standard-location parent sitemap is usable. All three conditions are required.
* **C-1.2-k — SITEMAP\_UNAVAILABLE (FAIL / HIGH).** A sitemap endpoint responds but never reaches a
  successful response — a 5xx, or a redirect chain resolving to a 4xx. This is distinct from a clean
  404 at a standard location, which means no sitemap is published there and is only ADD-8.6's
  warning.

### **ADD-8.8 — NOT\_TESTABLE**

Reserved for cases where **the tool itself** could not establish whether a sitemap works: the request
cap was reached before any sitemap was validated, a timeout, a DNS/network/tool failure, or a fetch
capability failure (C-1.2-g, SITEMAP\_LOCATE\_INCONCLUSIVE).

**Where one valid sitemap has already returned 200** and an *optional* variant later hits the cap or
times out, the result stays **PASS** with the note `VARIANT_CHECK_INCOMPLETE`. It must not become
NOT\_TESTABLE.

### **ADD-8.9 — Scoring**

| Status | Points |
| :---- | :---- |
| PASS | 100 % |
| WARN | **70 %** |
| FAIL | 0 % |
| NOT\_TESTABLE | excluded from the score |

Notes and informational findings never reduce the score.

The 70 % WARN value **overrides R-SCORE-2** for this check, which would otherwise derive the value
from severity and yield 30-40 %. It is registered as a fixed per-check value.

### **ADD-8.10 — Register changes**

| Row | Change |
| :---- | :---- |
| C-1.2-a | Reworded: PASS is one parent sitemap returning 200, nothing more |
| C-1.2-b | FAIL / HIGH `NO_SITEMAP_FOUND` → **WARN / LOW `SITEMAP_NOT_FOUND`** |
| C-1.2-c | Reworded as `DECLARED_SITEMAP_UNAVAILABLE`; now requires that nothing else serves |
| C-1.2-d | **Deleted** — a variant that does not answer is now an unscored note |
| C-1.2-f | **Deleted** — now `VARIANT_CHECK_INCOMPLETE`, an unscored note |
| C-1.2-i | **Deleted** — the canonical-host operator rule is withdrawn |
| C-1.2-j | **Added** — WARN / MEDIUM `SITEMAP_PARTIALLY_BROKEN` |
| C-1.2-k | **Added** — FAIL / HIGH `SITEMAP_UNAVAILABLE` |

`sitemap.require_canonical_host` is removed from §2 configuration; the rule it governed no longer
exists.


---

## **ADD-9 — X-1.8 Googlebot Access (using SERP), specified**

X-1.8 was listed in the checklist and never evaluated: v2.0 defined no conditions for it, and there
was no SERP data to evaluate. Both gaps are now closed. The operator supplied a SERP provider, and
the conditions below are deliberately the narrowest the evidence supports.

### **ADD-9.1 — What the check is for**

Every other factor in Section 1 establishes that Google **can** reach the site: robots.txt permits
it, pages return 200, nothing carries noindex. X-1.8 asks whether Google **did**. Those are
different questions, and every precondition can pass while the site is absent from the index.

### **ADD-9.2 — Method**

One request per run: a `site:<canonical-host>` query through the configured SERP provider. Results
whose host is the audited host, or a subdomain of it, are counted. Nothing else about the result set
is read.

### **ADD-9.3 — What this evidence can and cannot carry**

Google documents the `site:` operator and states that its result counts are **estimates**. A query
returns a sample, not an index report. So:

* it **can** separate "Google holds pages from this domain" from "Google holds none";
* it **cannot** measure coverage, or identify which pages are missing.

Only the binary outcome is scored. The caveat is attached to every finding, and it names Google
Search Console as the authoritative source — which only the site owner can authorise.

### **ADD-9.4 — Conditions**

| Checkpoint | Condition | Status | Severity | reason\_code |
| :---- | :---- | :---- | :---- | :---- |
| X-1.8-a | At least one organic result belongs to the canonical host | PASS | — | — |
| X-1.8-b | No organic result belongs to the canonical host | FAIL | CRITICAL | SITE\_NOT\_IN\_INDEX |
| X-1.8-c | The lookup could not be completed | NOT\_TESTABLE | — | SERP\_LOOKUP\_UNAVAILABLE |

**X-1.8-b is CRITICAL** because a site absent from the index cannot rank at all, whatever else is
configured correctly. The severity is tool policy; the inference itself rests on Google's own
documentation of the operator. It cross-references C-1.1, C-1.6 and C-1.7, which are where the
cause usually lies.

**X-1.8-c covers** a missing or rejected key, exhausted quota, a timeout, and `cap.serp_api = false`.
A lookup the tool could not complete says nothing about the site, so it is excluded from the score
rather than reported as absence.

### **ADD-9.5 — Configuration**

* **R-CFG-5 — `cap.serp_api`** (default **true**). With no key configured the check reports
  NOT\_TESTABLE rather than guessing, and `capabilities.serp_api` in the output contract now reports
  what the run could actually use instead of being hard-coded false.
* **R-CFG-6 — `serp.country`** (default `US`) and **`serp.timeout_ms`** (default 45 000).
  The country must be an upper-case ISO-3166 code; the provider rejects lower case with a validation
  error.

### **ADD-9.6 — Sources added to the register**

| Ref | Source | Tier | What it carries |
| :---- | :---- | :---- | :---- |
| GSO | Google — Refine web searches (search operators) | VENDOR\_DOC | Documents `site:`, and that counts are estimates |
| GSC | Google Search Central — Get started with Search Console | VENDOR\_DOC | The authoritative coverage report, cited wherever the SERP sample stands in for it |
| CLR | Cloro — SERP API | data provider | The route through which the query runs. A data source, not an authority |

CLR is registered as a provider rather than a documentary source, so it cannot carry a finding on
its own — which is why X-1.8-b rests on GSO and GSC.

### **ADD-9.7 — Still unspecified**

**X-5.3b (LLms-full.txt)** and **X-5.5 (Common Crawl presence)** remain listed, displayed and never
scored. Neither has conditions or a registered source, and ADD-7's requirement stands for both.

[^1]:  0-9a-f

[^2]:  a-z
---

