# Initial Technical SEO + LLM Visibility Audit

Processing engine, sequential pipeline and dashboard for the audit specified in
**`technicalaudittoolPRD_v2.md`** (PRD v2.0), the checklist in
**`Website Technical SEO + LLM Optimization & Visibility Audit Framework.docx`**, and the
**`technicalaudittoolPRD_v2_source_register.xlsx`** source register.

No rule, threshold or condition in this tool comes from anywhere but those three files. Where the
checklist names a factor the PRD gives no rules for, the tool displays it and refuses to score it
rather than inventing a rule.

---

## Running it

```bash
npm start            # dashboard at http://localhost:4317
```

Previous audits are listed on the start screen and reopen instantly — no need to re-run one to show
it to someone. Any report can be deep-linked as `http://localhost:4317/#run=<id>`, printed to PDF,
or downloaded as JSON. **`HOW-TO-READ-THIS-REPORT.md`** is a one-page explainer for whoever receives
the output rather than runs it.

```bash
npm run audit -- example.com --json report.json
```

```bash
npm test
```

**CLI flags:** `--json <file>` write the full report · `--gate prd|strict` · `--url <url>` add an
operator-supplied page (repeatable) · `--staging` · `--no-render` · `--no-llm` · `--ua-probe` ·
`--force-crawl` · `--quiet`.

### Requirements

- **Node.js 20+**. No build step.
- **Chrome or Edge** for the RENDERED profile. Found automatically on Windows/macOS/Linux; override
  with `AUDIT_CHROME_PATH`. Without it the run is raw-HTML-only and every affected result says so.
- **`GOOGLE_API_KEY`** for Core Web Vitals. Without it C-4.1 is `NOT_TESTABLE / CWV_NO_API_KEY` —
  recorded as a missing input, never as a site defect. See the note below.
- **`ANTHROPIC_API_KEY`** (optional) for the Section 6 rubric. Without it the deterministic gates
  still run and the modelled sub-scores are `NOT_TESTABLE / RUBRIC_DISABLED`.

Keys live in **`.env`** (gitignored). Copy `.env.example` to `.env` on each machine. They are read
from the environment only and never written to a report, a log or the UI.

### Enable the Chrome UX Report API for faster, better CWV

The configured key currently works for **PageSpeed Insights** but not **CrUX** — the Chrome UX
Report API is not enabled on its Google Cloud project. The tool handles this exactly as the PRD's
B-4.1-2 ladder specifies: it falls through to PSI, which returns the same CrUX field data plus lab
diagnostics in one call, and `capabilities.crux_api` reports `false` with the reason attached.

Enabling CrUX is still worth doing: PSI runs a real Lighthouse pass per call, so a ten-page audit
spends about five minutes in C-4.1, where CrUX answers in under a second and also supplies the
`collectionPeriod` that PSI omits. Enable "Chrome UX Report API" on the same project at
`console.cloud.google.com/apis/library/chromeuxreport.googleapis.com` and the tool uses it
automatically — no config change.

---

## The gate

Execution begins at **1. Crawl & Indexing › robots.txt**. Two modes, set in
`config/audit.config.json`:

| Mode | Behaviour when robots.txt fails, is incomplete or errors |
| --- | --- |
| **`strict`** (default) | Every remaining factor is marked `NOT_TESTABLE`, flagged `halted`, and the run aborts with verdict `BLOCKED`. Nothing else is fetched. |
| **`prd`** | PRD F-RUN-6 / F-RUN-8: page crawling halts but the control-file checks (C-1.1, C-1.2, C-5.3) continue, because a robots rule cannot conceal the file being audited. |

A **404 robots.txt passes the gate** (C-1.1-f): Google treats it as no restrictions, and the PRD
calls the opposite reading "the single most common false positive in audit tooling".

---

## Pipeline

```
P0  Target intake & normalisation      probe order, canonical_origin, site shape
P1  Control files                      robots.txt ── GATE ──┐
P2  Page discovery & sampling          harvest → robots intersection → group → select 1–10
P3  Per-page acquisition               RAW always; RENDERED conditionally (R-FETCH-3a)
P4  Site-level checks                  1.1, 1.2, 3.2, 5.1, 5.3, 5.4
P5  Page-level checks                  1.3–1.7, 2.*, 3.1, 4.1, 5.2, 6.*
P6  Cross-page reconciliation          duplicate titles/H1s, canonical clusters, @id stability
P7  Scoring, caveats, report
```

**Page selection** follows the checklist literally: harvest every `<a href>` on the homepage, drop
fragment-only links, exclude anything robots.txt disallows for Googlebot, group by URL pattern
(`/blog/*`, `/product/*/*`), stop fetching a group at 20 members, and take **one page per group
before any group contributes a second**. Target slate: homepage, two service pages, product,
pricing, category, blog article, a different blog template, author, about. An unfilled slot is
reported with its reason and is never padded with an unrelated page.

---

## Source attribution

Every factor and every child finding carries a **Reference** button. Hovering it reads the
`.xlsx` register **at runtime** and shows the publisher, the source tier, the document title and a
resolving link, plus what that source establishes for that specific finding.

The register also constrains what a finding may claim (R-SRC-3): a `FAIL` whose only support is
industry research or commentary is automatically capped to `WARN` with the reason stated, and a
threshold the register marks as tool policy says so on the finding.

Three rules keep a citation trustworthy, because a reference the reader cannot check is worse than
no reference at all:

- **Each source states what it itself establishes**, in the register's own words. Passing one shared
  note to every source made three different documents display identical text — and on a keyword-
  stuffing finding that text was about character limits.
- **The scope is stated plainly.** The register marks 251 of its 322 rows as inheriting the
  factor-level source, so most findings are supported at factor level rather than against the exact
  condition. The popover says which, rather than implying a specificity the register does not claim.
- **A source that does not address the condition is not cited on it** (F-SRC-2). A ~155–160
  character length study says nothing about a keyword-list finding. Only the corroborating tiers are
  filtered this way — standards, vendor documentation and tool policy are the register's
  authoritative mapping and are never dropped — and anything set aside is still named, with the
  reason, so nothing is hidden. Across the register this affects 42 of 298 findings.

Hovering resolves against the **live register**, not the copy stored in the report, so a report
opened weeks later reflects any re-dated or moved entry (R-SRC-5).

`src/engine/checkpoints.generated.json` is a frozen copy of the 322 condition rows, so editing the
spreadsheet cannot silently change audit logic. `npm test` fails if the two drift apart; rebuild
with `npm run build:checkpoints`.

---

## Scoring

Per section, then a weighted roll-up — never a flat percentage of all checks.

- `PASS` 1.0 · `WARN` 0.5 − (0.1 × severity rank) · `FAIL` 0.0
- `NOT_APPLICABLE`, `NOT_TESTABLE` and `ERROR` are excluded from **both** numerator and denominator
  and reported separately, so 1.0 over two checks never looks like 1.0 over eight.
- Weights: Crawl & Indexing 30, On-Page 15, Structured & International 20, Performance 10,
  LLM/AI Access 10, LLM Content Readiness 15.
- **Any CRITICAL FAIL caps the overall score at 40 and forces `BLOCKED`.**
- **More than 25% not-testable suppresses the score entirely**, replacing it with
  `INSUFFICIENT_EVIDENCE` and the list of missing inputs.

---

## Core Web Vitals data ladder

Per URL and per form factor, stopping at the first rung that returns data and recording which one
did (R-4.1-2). Rungs are never mixed inside one verdict (R-4.1-6).

1. **CrUX URL-level** field data — the authoritative source.
2. **CrUX origin-level** — clearly labelled as origin, not page.
3. **PageSpeed Insights** — carries the same CrUX field data (`loadingExperience` /
   `originLoadingExperience`) plus a Lighthouse run, in one call.
4. **Local Lighthouse** — not provisioned; reported as unavailable rather than silently skipped.

Lab data is extracted for diagnosis — LCP element, render-blocking resources, unsized images, long
tasks, total blocking time, third-party weight — and **never occupies a pass/fail position**
(F-4.1-1). On wellows.com the field LCP is 3.1 s while the lab LCP is 7.1 s, which is precisely why
the PRD forbids scoring the lab number.

## Structured data: what gets validated

Only the ten types in `config/schema.fixed_set.json` (S1–S10). Everything else is inventoried and
reported as INFO, never validated — that is what the checklist's "we have some fixed schema; check
only those" means in implementation.

Nodes sharing an `@id` are **merged before validation**, because in JSON-LD they are one entity and
a real graph routinely splits it: a full declaration in one block, an augmentation carrying a single
extra property in another. A nested node that carries nothing beyond identity keys under a
reference-bearing property (`publisher`, `author`, `creator`, …) is a pointer, not a declaration,
and a node under a descriptor property (`hasPart`, `itemListElement`, …) describes a *different*
resource. Validating any of those as declarations reports fields as missing from fragments that
never carried them — three separate false positives during testing, now covered by regression tests.

Visible-content correspondence (R-3.1-8) is checked against the text a reader can **reach**,
including expandable panels. Checking `innerText` alone reported ten FAQ answers in an accordion as
"not visible" when they were present and one click away.

## Content chunking and entity names

**Sections follow R-2.3-9**: a heading owns the text up to the next heading of *equal or higher*
level, so an h2 contains its h3s. Two counts are kept, because they answer different questions —
`own_words` is the unbroken prose a reader meets before the next subheading (what the overlong-
section test means), and `words` is the whole section including subsections (the retrieval unit).

**Chunks are the maximal sections**, computed by containment rather than by level, so they tile the
page exactly once: nothing is counted twice and nothing is dropped. The leading page-title h1 is
excluded, or the whole page would be one chunk. Headings that appear before any shallower heading
are roots in their own right, which matters on pages that open with h3 cards and reach an h2 later.
Chunking on every heading instead fragmented nested content into sub-40-word pieces and reported
9–17% viability on pages that were structured perfectly well.

**Entity names**: declared fields (`Organization.name`, `WebSite.name`, `og:site_name`, the title
brand suffix) are always name claims. The homepage h1 and the logo alt are inferred, so they count
only when they are shaped like a name — a slogan h1 is recorded as page content instead, per
E-2.3-8, rather than reported as a competing name. Without that, a site whose name is stated
identically in six places still failed on entity consistency because its h1 was a sentence.

## Section 6 and the LLM budget

Every Section 6 check runs a **deterministic gate first**; only what the gate cannot decide goes to
the rubric, and only when a key is configured. Each modelled sub-score carries `MODELLED`, a caveat,
and a verbatim quote from the page — a criterion scored above zero without a quote that appears in
the supplied text is discarded and re-scored once, then becomes `NOT_TESTABLE`.

The run budget (`llm.max_calls_per_run`, default 20) is **reserved per check** rather than spent
first-come: 35% to entity clarity, 35% to answer extractability, 20% to the content-currency check,
10% to section independence, with unspent budget still available to whoever needs it. Without that
split the first check to run consumed the whole budget and every later check was gate-only on every
page.

## Three decisions worth knowing

**1. Three checklist items are displayed but not scored.** *Googlebot Access (using SERP)*,
*LLms-full.txt* and *Common Crawl presence* appear in the checklist, but PRD v2.0 defines no rules,
conditions, reason codes or sources for them, and the output contract ships `serp_api: false`.
They render as `UNSPECIFIED` with the reason shown. Scoring them would mean inventing rules.

**2. The judge model does not accept a temperature.** R-S6-2 asks for temperature 0. The current
model family rejects the parameter, so determinism cannot be pinned that way. The rubric version is
fixed and recorded in evidence instead, and every modelled score carries a caveat saying repeated
runs may differ slightly.

**3. Two places extend the PRD to match its own worked examples.** `/product/12345/red-shoe` →
`/product/*/*` requires collapsing a final slug that follows an identifier segment, which R-A3-1
step 4 alone would not do from a single URL. And infrastructure paths (`/cdn-cgi/`, `/wp-content/`,
feeds) are excluded from selection on the same basis as login-gated pages (E-A4-8), so they cannot
occupy one of the ten slots. Both are deterministic and commented in place.

---

## Layout

```
src/
  config.js              PRD §2 — capabilities, network policy, thresholds, budgets
  cli.js  server.js      CLI and the dashboard server (SSE progress)
  net/http.js            §3 fetch policy: budgets, retries, redirects, PAGE_NOT_RESPONDING
  net/render.js          RENDERED profile (headless Chromium, 412×915 mobile)
  parse/                 robots.txt (RFC 9309 + Google), HTML model, JSON-LD, URL, text
  discovery/             A.0 intake · A.1 harvest · A.3 grouping · A.4 selection · P3 acquisition
  checks/                one module per factor, C-1.1 … C-6.5
  engine/                pipeline, result contract, scoring, catalogue
  sources/               .xlsx reader, register, frozen checkpoint build
  llm/judge.js           Section 6 rubric protocol (R-S6-1…R-S6-5)
public/                  dashboard
test/                    unit tests + end-to-end gate tests against a local fixture site
runs/                    saved reports, one JSON per run
```

Report shape is Appendix B verbatim: `run`, `target`, `discovery`, `sitemap_access`, `sample`,
`results[]` (each with `evidence[]`, `sources[]`, `caveat`, `cross_references[]`), and `scores`.
