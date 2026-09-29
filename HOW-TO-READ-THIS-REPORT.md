# How to read an audit report

One page, for whoever receives the output rather than runs it.

---

## The headline number

The **Overall Audit Score** is a weighted average of six section scores, not a percentage of checks
passed. Weights: Crawl & Indexing 30, Structured & International 20, On-Page 15, LLM Content
Readiness 15, Performance 10, LLM/AI Access 10.

Two rules change it, and both are deliberate:

- **Any critical failure caps the score at 40** and sets the verdict to `BLOCKED`. A site Google
  cannot crawl does not get a good score for having tidy titles.
- **If more than a quarter of checks could not be tested, no score is shown at all.** You get
  `INSUFFICIENT_EVIDENCE` and a list of what was missing. A score computed over a quarter-blind
  audit is worse than no score.

| Verdict | Meaning |
| --- | --- |
| `HEALTHY` | 85% or above, nothing critical |
| `NEEDS_WORK` | Below 85%, nothing critical |
| `BLOCKED` | At least one critical failure — fix that first, the rest can wait |
| `INSUFFICIENT_EVIDENCE` | Too much was untestable to publish a number |

---

## The six statuses

| Status | Counts toward the score? |
| --- | --- |
| **PASS** | Yes, fully |
| **WARN** | Yes, partially — the weight depends on severity |
| **FAIL** | Yes, as zero |
| **NOT APPLICABLE** | No — the check does not apply here (hreflang on a single-language site) |
| **NOT TESTABLE** | No — it applies, but the evidence could not be obtained |
| **ERROR** | No — a defect in the tool itself. Should always be zero |

**Not applicable and not testable are different things**, and neither is a failure. The tool never
guesses: if it cannot obtain evidence, it says so and excludes the check from the maths rather than
scoring it as a pass or a fail.

---

## Every finding cites its source

Next to every factor and every individual finding there is a **Reference** button. Hover it to see
the publisher, the document, a link, and what that source establishes for that specific finding.

The source also limits what a finding may claim. A finding supported only by industry research is
automatically capped at WARN and says so. Where a threshold is this tool's own standard rather than
a search-engine requirement, the finding states that too — for example, Google documents no required
properties for `Organization`, so that requirement is labelled as tool policy, not as a Google rule.

---

## What the tool deliberately does not do

- **It never claims a page is indexed.** It reports whether a page *permits* indexing. Only Search
  Console can confirm the former.
- **It never treats a missing meta description as a failure.** Google generates snippets from page
  content and often ignores the tag.
- **It never fails a site for a missing robots.txt.** A 404 means "no restrictions", which is how
  Google treats it, and the opposite reading is the most common false positive in audit tooling.
- **It never reports a third-party API having no data as a site defect.**
- **Three checklist items are shown but not scored** — Googlebot Access (SERP), LLms-full.txt and
  Common Crawl presence. The specification defines no rules or sources for them, and the tool does
  not invent rules. They appear as `UNSPECIFIED` with that reason.

---

## Reading a Section 6 score

Section 6 (LLM Content Readiness) mixes two kinds of measurement:

- **Deterministic gates** — heading structure, chunk sizes, self-contained sentences, dates. These
  are measured.
- **Modelled sub-scores** — judged by a language model against a fixed rubric, at most a set number
  of pages per run. Every one carries the label `MODELLED` and a caveat, and every score above zero
  is backed by a verbatim quote from the page.

A modelled score is an estimate against a rubric. It is **not** a measurement of whether any AI
system retrieved or cited the page — no public API exposes that, and the tool says so rather than
implying otherwise.

---

## Pages analysed

Between 1 and 10 pages, chosen by template rather than at random: the tool harvests homepage links,
groups URLs by pattern (`/blog/*`, `/product/*/*`), and takes **one page per group before any group
contributes a second**, because two blog posts tell you the same thing. The table shows each page,
its pattern, how it was found, and why it was selected. Unfilled slots are listed with the reason —
an absent page type is not a site failure by itself.

---

## Exporting

- **Print / save as PDF** — opens every section and disclosure, drops the interactive chrome, and
  prints the full report with sources.
- **Download JSON** — the complete machine-readable report: every finding with its evidence, the
  verbatim observed values, sources, and the scoring breakdown.
