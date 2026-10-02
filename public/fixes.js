// What to do about each finding, in plain language.
//
// This replaces the raw "Measurements" dump, which printed the tool's internal numbers and told a
// reader nothing they could act on. Every finding now says what the problem costs and what to do
// about it.
//
// `kind` is the honest part. A fix is only ever one of two things:
//
//   EXACT     the engine generated this from the page itself — the values are yours, not a sample.
//             Only findings that carry a `remediation.proposed` block qualify.
//   GUIDANCE  what to do, written generally. The diagnosis is specific to your page; the wording of
//             the fix is not, because the right title or heading depends on the page's purpose.
//
// Nothing here invents a rule. These are the actions implied by the registered source behind each
// finding, restated for a reader who does not work in search.

export const FIX_KIND = {
  EXACT: 'Ready to use — generated from this page',
  GUIDANCE: 'What to do — adapt the wording to your page',
};

export const FIXES = {
  // ── Crawling and indexing ───────────────────────────────────────────────
  ROBOTS_BLOCKS_GOOGLEBOT_SITEWIDE: {
    why: 'Search engines are being told to stay off the whole site, so none of it can appear in results.',
    how: 'Open robots.txt and remove the "Disallow: /" line that applies to Googlebot. If the site is meant to be private, that is fine — but it will not be found in search.',
  },
  ROBOTS_BLOCKS_RENDER_RESOURCES: {
    why: 'Files the page needs to display properly are blocked, so a search engine sees a broken version of it.',
    how: 'In robots.txt, allow the CSS and JavaScript folders. Blocking them does not protect anything and makes the page look broken to a crawler.',
  },
  SITEMAP_NOT_FOUND: {
    why: 'A sitemap is the simplest way to tell a search engine which pages matter. There is not one.',
    how: 'Publish a sitemap at /sitemap.xml and add a "Sitemap:" line to robots.txt pointing at it. Most CMS platforms generate one automatically.',
  },
  SITEMAP_PARTIALLY_BROKEN: {
    why: 'robots.txt points at a sitemap that is not there. Another one works, so nothing is lost, but the instruction is wrong.',
    how: 'Update the "Sitemap:" line in robots.txt to the address that actually serves, or restore the missing file.',
  },
  DECLARED_SITEMAP_UNAVAILABLE: {
    why: 'The sitemap the site advertises to search engines does not load, and there is no working alternative.',
    how: 'Restore the sitemap at the address named in robots.txt, or change that line to point at one that works.',
  },
  SITEMAP_UNAVAILABLE: {
    why: 'A sitemap address responds but never loads successfully, so crawlers get an error where they expect a list of pages.',
    how: 'Check the server error behind that address. A sitemap that errors is worse than none, because crawlers keep retrying it.',
  },
  TRAILING_SLASH_BOTH_LIVE: {
    why: 'The same page is live at two addresses, one with a slash on the end and one without. Search engines may treat them as two pages competing with each other.',
    how: 'Pick one form as the real one and make the other redirect to it with a 301. Most web servers and CMS platforms have a single setting for this.',
  },
  REDIRECT_CHAIN: {
    why: 'Visitors and crawlers pass through more than one hop to reach the page. Each hop costs time and loses a little ranking signal.',
    how: 'Point the first redirect straight at the final address, so there is one hop instead of several.',
  },
  REDIRECT_TO_HOME: {
    why: 'A deep page redirects to the homepage. Google treats that as a missing page, not a move.',
    how: 'Redirect to the closest equivalent page. If there is no equivalent, return a 404 or 410 instead — that is the honest answer and it is handled better.',
  },
  HTTPS_DOWNGRADE: {
    why: 'A secure address hands visitors to an insecure one somewhere in the chain.',
    how: 'Make every redirect in the chain stay on https. Check the server rules and any CDN in front of it.',
  },
  CANONICAL_MISMATCH: {
    why: 'The page tells search engines its real address is somewhere else, so this version may be dropped from results.',
    how: 'Set the canonical tag to this page’s own address, unless it really is a duplicate of another page.',
  },
  NOINDEX_PRESENT: {
    why: 'The page carries an instruction telling search engines not to list it.',
    how: 'Remove the noindex tag if the page is meant to be found. If it is not, leave it — but check it is not blocked in robots.txt as well, or the instruction can never be read.',
  },

  // ── On-page ─────────────────────────────────────────────────────────────
  TITLE_DUPLICATE: {
    why: 'Several pages share the same title, so search results cannot tell them apart and neither can a reader.',
    how: 'Give each page a title describing that page specifically. Put the distinguishing words first.',
  },
  TITLE_MISSING: {
    why: 'The page has no title, so search engines will invent one from the content.',
    how: 'Add a title tag of roughly 50–60 characters that says what the page is for.',
  },
  METADESC_DUPLICATE: {
    why: 'Several pages share the same description, so the snippet under each search result says the same thing.',
    how: 'Write a distinct description for each page — one or two sentences on what that page offers.',
  },
  METADESC_KEYWORD_LIST: {
    why: 'The description reads as a list of keywords rather than a sentence, which is unconvincing to a human deciding whether to click.',
    how: 'Rewrite it as a sentence a person would read: what the page offers and why it is worth opening.',
  },
  METADESC_MISSING: {
    why: 'There is no description, so search engines will pull an arbitrary fragment of the page instead.',
    how: 'Add a description of roughly 120–155 characters summarising the page.',
  },
  H1_MISSING: {
    why: 'The page has no main heading, so there is no clear statement of what it is about.',
    how: 'Add one H1 near the top saying what the page covers.',
  },
  H1_IS_SITE_NAME: {
    why: 'The main heading is the company name rather than the subject of the page, so every page appears to be about the same thing.',
    how: 'Change the H1 to describe this page. Put the company name in the logo or the title tag instead.',
  },
  HEADING_LEVEL_SKIP: {
    why: 'Headings jump a level (H1 straight to H3), which breaks the outline that screen readers and AI assistants follow.',
    how: 'Use heading levels in order. If a heading looks wrong at the correct level, change its appearance with styling, not by changing the level.',
  },
  HEADING_HIERARCHY_BROKEN: {
    why: 'The heading structure does not form a consistent outline, so the page’s shape is unclear to anything reading it programmatically.',
    how: 'Lay the page out as a simple outline: one H1, H2 for each section, H3 for points inside a section.',
  },
  HEADINGS_LAYOUT_MISUSE: {
    why: 'Heading tags are being used to make text big rather than to mark sections, which confuses the outline.',
    how: 'Use headings only for real section titles. For large text that is not a heading, use styling.',
  },
  EMPTY_ANCHOR: {
    why: 'Links with no text — icons and image links with nothing to read — tell a search engine nothing about where they lead.',
    how: 'Give each one visible text, or an aria-label, or alt text on the image inside it.',
  },
  ORPHAN_IN_SAMPLE: {
    why: 'No other page checked here links to this one in its content, so it is harder to find and carries less weight.',
    how: 'Link to it from a related page, inside the body text rather than only from the menu. Worth confirming against the whole site, since only a sample was checked.',
  },
  NO_CONTEXTUAL_LINKS: {
    why: 'The page links onward only from its menu and footer. Links inside the content are what carry a reader, and a crawler, deeper into the site.',
    how: 'Add a few links in the body text to genuinely related pages.',
  },
  BROKEN_INTERNAL_LINK: {
    why: 'Links in the content point at pages that return an error. Visitors hit a dead end and crawl budget is wasted.',
    how: 'Update each link to the correct address, or remove it.',
  },
  INTERNAL_NOFOLLOW: {
    why: 'Links to your own pages are tagged to tell search engines not to follow them, which blocks the signal you were trying to pass.',
    how: 'Remove rel="nofollow" from links pointing to your own site. It is for untrusted external links.',
  },

  // ── Structured data and international ───────────────────────────────────
  NO_STRUCTURED_DATA: {
    why: 'The page carries no machine-readable description of what it is, so search engines and AI assistants have to guess from the text.',
    how: 'Add JSON-LD structured data describing the page — Organization and WebSite on the homepage, and the matching type elsewhere (Product, Article, LocalBusiness).',
  },
  SCHEMA_REQUIRED_FIELD_MISSING: {
    why: 'The structured data is present but missing fields that make it usable.',
    how: 'Add the named fields to the existing block. Do not add a second block — edit the one that is there.',
  },
  SCHEMA_TYPE_ABSENT: {
    why: 'A type of structured data expected for this kind of page is missing.',
    how: 'Add the missing type to the existing structured-data block.',
  },
  SCHEMA_UNSTABLE_ENTITY_ID: {
    why: 'The identifiers in the structured data change between pages, so search engines cannot tell that the entries describe the same organisation.',
    how: 'Give each entity a fixed @id (for example https://example.com/#organization) and use the identical value on every page.',
  },
  JSONLD_PARSE_ERROR: {
    why: 'The structured data contains a syntax error, so all of it is ignored.',
    how: 'Validate the JSON-LD block and fix the error. One stray comma discards the whole block.',
  },
  HREFLANG_NOT_FOUND_IN_HTML_OR_HEADERS: {
    why: 'The site appears to have more than one language, but nothing tells search engines which version suits which audience.',
    how: 'Add hreflang annotations listing every language version, including the page itself. Every version must point back at all the others.',
  },
  HREFLANG_SINGLETON_CLUSTER: {
    why: 'A language version names itself but no counterparts, so the connection between versions is incomplete.',
    how: 'Make each version list all the others as well as itself. The set must agree in both directions.',
  },

  // ── Performance ─────────────────────────────────────────────────────────
  CWV_NEEDS_IMPROVEMENT: {
    why: 'Real visitors are experiencing the page as slower than Google’s threshold for a good experience.',
    how: 'Start with the largest element on screen: compress the hero image, serve it in a modern format, and size it correctly. That is usually the single biggest gain.',
  },
  CWV_POOR: {
    why: 'Real visitors are experiencing the page as slow enough to fall in Google’s poor band, which affects both ranking and conversion.',
    how: 'Look at the biggest image and the scripts loading before the page can display. Compressing the main image and deferring non-essential scripts usually moves this most.',
  },

  // ── AI access ───────────────────────────────────────────────────────────
  AI_ACCESS_UNDECLARED: {
    why: 'robots.txt says nothing about AI crawlers, so each one applies its own default and you have made no decision.',
    how: 'Decide whether you want AI assistants to use your content, then say so explicitly in robots.txt for the named AI user-agents. Either answer is valid; silence is not a decision.',
  },
  AI_BLOCKED_BY_WILDCARD: {
    why: 'A catch-all rule blocks AI crawlers along with everything else, so assistants cannot cite the site.',
    how: 'If you want to appear in AI answers, add explicit rules allowing the AI user-agents you accept.',
  },
  LLMS_TXT_ABSENT: {
    why: 'There is no llms.txt. It is a proposed convention, not a requirement, and no search engine uses it yet.',
    how: 'Optional. If you want to try it, publish /llms.txt with a heading, a one-line description of the site, and a short list of the pages that matter most. Treat it as an experiment.',
  },
  AI_INSTRUCTIONS_PAGE_ABSENT: {
    why: 'There is no page stating how you want AI systems to use your content.',
    how: 'Optional. A short page setting out your position is useful mostly as a public statement of intent.',
  },
  AI_INSTRUCTIONS_PAGE_THIN: {
    why: 'The AI instructions page exists but says very little.',
    how: 'Say plainly what is allowed, what is not, and how to attribute the content.',
  },
  CONTENT_PARTIALLY_REQUIRES_JS: {
    why: 'Some content appears only after scripts run. Anything that reads the page without running scripts will miss it.',
    how: 'Send the important content in the initial HTML. Server-side rendering or static generation both achieve this.',
  },
  NOSCRIPT_NOT_SUBSTANTIVE: {
    why: 'With scripts disabled the page has almost nothing on it.',
    how: 'Make sure the main content is in the HTML the server sends, rather than assembled in the browser.',
  },
  RAW_CONTENT_ABSENT: {
    why: 'The page is effectively empty until scripts run. Many AI crawlers do not run scripts, so they see nothing at all.',
    how: 'Render the content on the server. This is the most consequential item on this list for AI visibility.',
  },

  // ── Content readiness ───────────────────────────────────────────────────
  LOW_TEXT_TO_HTML_RATIO: {
    why: 'The page is mostly markup with little text, so there is not much for anything to read or quote.',
    how: 'Usually a page-builder issue rather than a writing one. More substantive copy helps; so does simplifying the template.',
  },
  CONTENT_BOUNDARIES_UNCLEAR: {
    why: 'The main content cannot be told apart from the furniture around it, so an assistant may quote a menu item as though it were content.',
    how: 'Wrap the page content in a <main> element, and the navigation, header and footer in their own tags. One change, and it makes the page legible to machines.',
  },
  PAGE_SUBJECT_UNCLEAR: {
    why: 'The page title and the main heading share no significant words, so what the page is about is ambiguous.',
    how: 'Make the heading and title agree on the subject. They may be worded differently, but they should describe the same thing.',
  },
  ENTITY_NAME_INCONSISTENT: {
    why: 'The organisation is named differently in different places, so search engines may not connect them.',
    how: 'Use one exact name everywhere — structured data, headings, title tags and the About page.',
  },
  LOW_ENTITY_CLARITY: {
    why: 'It is hard to establish what the organisation is from the page itself.',
    how: 'State plainly, near the top, who you are and what you do. One sentence an assistant could quote verbatim.',
  },
  NO_DEFINITIONAL_STATEMENT: {
    why: 'Nothing on the homepage says what the organisation is in a form an assistant could quote.',
    how: 'Add a sentence in the first paragraph of the pattern "X is a Y that Z". Slogans do not serve this purpose.',
  },
  NO_DEFINITIONAL_ANSWER: {
    why: 'The page poses a subject but never answers it directly, so there is no passage to quote.',
    how: 'Answer the question in the first sentence under the heading, then expand. Do not build up to it.',
  },
  QUESTIONS_NOT_DIRECTLY_ANSWERED: {
    why: 'Headings ask questions the text does not then answer plainly, so an assistant has nothing it can lift.',
    how: 'Answer each question in the first sentence beneath its heading, in one or two lines, before any elaboration.',
  },
  POOR_CHUNK_VIABILITY: {
    why: 'The page does not divide into self-contained sections, so an assistant quoting any part of it loses the meaning.',
    how: 'Give each section a clear heading and make sure it reads on its own, without depending on the paragraph before it.',
  },
  MODERATE_CHUNK_VIABILITY: {
    why: 'Some sections stand on their own and some do not.',
    how: 'Look at the sections that depend on what came before, and give each one enough context to be read alone.',
  },
  OVERLONG_SECTIONS: {
    why: 'Sections run long enough that an assistant must truncate them, and may cut mid-argument.',
    how: 'Break long sections with subheadings every few paragraphs.',
  },
  WEAK_SELF_CONTAINMENT: {
    why: 'Sections rely on earlier text, so they do not survive being quoted in isolation.',
    how: 'Repeat the subject by name rather than referring back with "it" or "this".',
  },
  LOW_EXTRACTABILITY: {
    why: 'There is little on the page an assistant could quote cleanly as an answer.',
    how: 'Add direct statements: definitions, short answers under question headings, and specific facts rather than general claims.',
  },
  NO_ATTRIBUTION_SCAFFOLDING: {
    why: 'Claims on the page have nothing supporting them, so an assistant has no reason to repeat them.',
    how: 'Attribute specifics — name the source of a figure, date a claim, or cite the study.',
  },
  NO_AUTHOR_ATTRIBUTION: {
    why: 'The article names no author, which weakens it for both readers and the systems assessing credibility.',
    how: 'Add a visible author name, and mark it up with structured data.',
  },
  NO_DATE_SIGNAL: {
    why: 'Nothing says when the page was written or updated, so its currency cannot be judged.',
    how: 'Show a published or updated date, and include it in the structured data.',
  },
  CONTENT_AGEING: {
    why: 'The page has not been updated in a while, on a subject where currency matters.',
    how: 'Review and refresh it, then update the date. Changing the date alone is not a fix.',
  },
  CONTENT_STALE: {
    why: 'The content is old enough that it may now be wrong.',
    how: 'Rewrite the parts that have dated, or retire the page and redirect it to something current.',
  },
};

/** The fix for a finding, or null when none is registered. */
export function fixFor(result) {
  if (result?.remediation?.proposed) {
    return {
      kind: 'EXACT',
      label: FIX_KIND.EXACT,
      why: null,
      how: result.remediation.action,
      code: result.remediation.proposed,
    };
  }
  const f = FIXES[result?.reason_code];
  if (!f) return null;
  return {
    kind: 'GUIDANCE',
    label: FIX_KIND.GUIDANCE,
    why: f.why,
    how: result?.remediation?.action || f.how,
    code: null,
  };
}
