// C-5.1 §5.1.0 — AI agent registry (ai_agents.registry). Configurable; defaults from the PRD table.
export const AI_AGENTS = [
  { token: 'GPTBot', vendor: 'OpenAI', purpose: 'Foundation-model training', kind: 'training', respects_robots: 'Yes', verification: 'openai.com/gptbot.json' },
  { token: 'OAI-SearchBot', vendor: 'OpenAI', purpose: 'Surfacing sites in ChatGPT search', kind: 'retrieval', respects_robots: 'Yes', verification: 'openai.com/searchbot.json' },
  { token: 'ChatGPT-User', vendor: 'OpenAI', purpose: 'User-initiated fetches', kind: 'user', respects_robots: 'Vendor states robots.txt rules may not apply (user-initiated)', verification: 'openai.com/chatgpt-user.json' },
  { token: 'OAI-AdsBot', vendor: 'OpenAI', purpose: 'Ad landing-page safety validation', kind: 'other', respects_robots: 'Yes', verification: 'openai.com/adsbot.json' },
  { token: 'ClaudeBot', vendor: 'Anthropic', purpose: 'Model training', kind: 'training', respects_robots: 'Yes', verification: 'claude.com/crawling/bots.json' },
  { token: 'Claude-SearchBot', vendor: 'Anthropic', purpose: 'Search-quality analysis', kind: 'retrieval', respects_robots: 'Yes', verification: 'claude.com/crawling/bots.json' },
  { token: 'Claude-User', vendor: 'Anthropic', purpose: 'User-initiated fetches', kind: 'user', respects_robots: 'Yes', verification: 'claude.com/crawling/bots.json' },
  { token: 'PerplexityBot', vendor: 'Perplexity', purpose: 'Search indexing/linking; not model training', kind: 'retrieval', respects_robots: 'Yes', verification: 'perplexity.com/perplexitybot.json' },
  { token: 'Perplexity-User', vendor: 'Perplexity', purpose: 'User-initiated fetches', kind: 'user', respects_robots: 'Vendor states it generally ignores robots.txt', verification: 'perplexity.com/perplexity-user.json' },
  { token: 'Google-Extended', vendor: 'Google', purpose: 'Control token only — governs Gemini training and grounding', kind: 'control', respects_robots: 'n/a', verification: null },
  { token: 'Applebot', vendor: 'Apple', purpose: 'Siri/Spotlight search', kind: 'retrieval', respects_robots: 'Yes', verification: null },
  { token: 'Applebot-Extended', vendor: 'Apple', purpose: 'Control token only — governs training use of crawled content', kind: 'control', respects_robots: 'n/a', verification: null },
  { token: 'CCBot', vendor: 'Common Crawl', purpose: 'Open crawl corpus (common upstream for AI training sets)', kind: 'training', respects_robots: 'Yes', verification: 'index.commoncrawl.org/ccbot.json' },
  { token: 'Bytespider', vendor: 'ByteDance', purpose: 'Training / retrieval', kind: 'other', respects_robots: 'varies', verification: null },
  { token: 'Amazonbot', vendor: 'Amazon', purpose: 'Training / retrieval', kind: 'other', respects_robots: 'varies', verification: null },
  { token: 'meta-externalagent', vendor: 'Meta', purpose: 'Training / retrieval', kind: 'other', respects_robots: 'varies', verification: null },
  { token: 'cohere-ai', vendor: 'Cohere', purpose: 'Training / retrieval', kind: 'other', respects_robots: 'varies', verification: null },
  { token: 'Diffbot', vendor: 'Diffbot', purpose: 'Training / retrieval', kind: 'other', respects_robots: 'varies', verification: null },
  { token: 'omgili', vendor: 'Webz.io', purpose: 'Training / retrieval', kind: 'other', respects_robots: 'varies', verification: null },
  { token: 'Timpibot', vendor: 'Timpi', purpose: 'Training / retrieval', kind: 'other', respects_robots: 'varies', verification: null },
];

export const RETRIEVAL_AGENTS = ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot', 'Applebot'];
export const TRAINING_AGENTS = ['GPTBot', 'ClaudeBot', 'CCBot'];
export const KNOWN_NON_AI = new Set(['*', 'googlebot', 'googlebot-image', 'googlebot-news', 'googlebot-video', 'bingbot', 'adsbot-google', 'mediapartners-google', 'storebot-google', 'google-inspectiontool', 'googleother', 'duckduckbot', 'yandex', 'yandexbot', 'baiduspider', 'slurp', 'ahrefsbot', 'semrushbot', 'mj12bot', 'dotbot', 'petalbot', 'facebookexternalhit', 'twitterbot', 'linkedinbot', 'msnbot', 'applebot', 'rogerbot', 'screaming frog seo spider']);
