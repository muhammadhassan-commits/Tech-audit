// Audit checklist catalogue — the exact categories of the process file ("Audit checklist" tab),
// each mapped to its PRD v2 check. Items the checklist names but PRD v2 gives no rules for are
// listed with `unspecified: true`: they are displayed, never evaluated and never scored, because
// no rule may be fabricated outside the PRD and source register.

export const SECTIONS = [
  { id: '1', name: 'Crawl & Indexing' },
  { id: '2', name: 'On-Page SEO' },
  { id: '3', name: 'Structured & International' },
  { id: '4', name: 'Performance' },
  { id: '5', name: 'LLM / AI Access' },
  { id: '6', name: 'LLM Content Readiness' },
];

export const FACTORS = [
  { id: 'C-1.1', section: '1', name: 'robots.txt', scope: 'site', gate: true },
  { id: 'C-1.2', section: '1', name: 'XML Sitemap', scope: 'site' },
  { id: 'C-1.3', section: '1', name: 'HTTP Status Codes', scope: 'page' },
  { id: 'C-1.4', section: '1', name: 'Redirects', scope: 'site+page' },
  { id: 'C-1.5', section: '1', name: 'Canonical Tags', scope: 'page' },
  { id: 'C-1.6', section: '1', name: 'Meta Robots', scope: 'page' },
  { id: 'C-1.7', section: '1', name: 'Indexability', scope: 'page' },
  {
    id: 'X-1.8',
    section: '1',
    name: 'Googlebot Access (using SERP)',
    scope: 'site',
    note: 'Asks Google whether the domain is in its index, rather than whether it could be crawled. Scored on presence only: a site: query is a sample, not an index report.',
  },
  { id: 'C-2.1', section: '2', name: 'Title Tags', scope: 'page' },
  { id: 'C-2.2', section: '2', name: 'Meta Descriptions', scope: 'page' },
  { id: 'C-2.3', section: '2', name: 'H1 / Headings', scope: 'page' },
  { id: 'C-2.4', section: '2', name: 'Internal Links', scope: 'page+site', note: 'Ignored for single-page websites (R-2.4-1).' },
  { id: 'C-3.1', section: '3', name: 'Structured Data', scope: 'page', note: 'Validated against the fixed schema set only (schema.fixed_set).' },
  { id: 'C-3.2', section: '3', name: 'Hreflang', scope: 'site+page', note: 'Evaluated for multilingual websites only (R-3.2-1).' },
  { id: 'C-4.1', section: '4', name: 'Core Web Vitals', scope: 'page+origin' },
  { id: 'C-5.1', section: '5', name: 'AI Crawler Access', scope: 'site' },
  { id: 'C-5.2', section: '5', name: 'JS-disabled content accessibility', scope: 'page' },
  { id: 'C-5.3', section: '5', name: 'llms.txt', scope: 'site' },
  {
    id: 'X-5.3b',
    section: '5',
    name: 'LLms-full.txt',
    unspecified: true,
    note: 'Listed in the audit checklist, but PRD v2.0 defines no rules for llms-full.txt and the source register has no entry for it. Not evaluated and not scored.',
  },
  { id: 'C-5.4', section: '5', name: 'AI Instructions Page', scope: 'site', note: 'Reference implementations: wellows.com/ai-info, peec.ai/ai-instructions.' },
  {
    id: 'X-5.5',
    section: '5',
    name: 'Common Crawl presence',
    unspecified: true,
    note: 'Listed in the audit checklist ("present in the latest Common Crawl data"). PRD v2.0 uses Common Crawl only as a discovery fallback (B-A1-4) and defines no presence check, conditions or reason codes. Not evaluated and not scored.',
  },
  { id: 'C-6.1', section: '6', name: 'Raw Content Availability', scope: 'page' },
  { id: 'C-6.2', section: '6', name: 'Entity Clarity', scope: 'page+site' },
  { id: 'C-6.3', section: '6', name: 'Content Structure', scope: 'page' },
  { id: 'C-6.4', section: '6', name: 'Answer Extractability', scope: 'page' },
  { id: 'C-6.5', section: '6', name: 'Content Freshness', scope: 'page+site' },
];

export const FACTOR_BY_ID = new Map(FACTORS.map((f) => [f.id, f]));
export const sectionOf = (checkId) => FACTOR_BY_ID.get(checkId)?.section || checkId.split('-')[1]?.split('.')[0];
