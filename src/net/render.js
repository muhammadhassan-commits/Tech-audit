// RENDERED fetch profile — R-FETCH-2: headless Chromium, JS enabled, 412×915 mobile viewport,
// network idle or render.budget_ms hard cap. Uses a locally installed Chrome/Edge via playwright-core.
import fs from 'node:fs';

const CANDIDATES = [
  process.env.AUDIT_CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export function findBrowser() {
  return CANDIDATES.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

export class Renderer {
  constructor(cfg) {
    this.cfg = cfg;
    this.browser = null;
    this.available = null;
    this.unavailableReason = null;
  }

  async init() {
    if (this.available !== null) return this.available;
    if (!this.cfg.cap.render_js) {
      this.available = false;
      this.unavailableReason = 'cap.render_js=false';
      return false;
    }
    const exe = findBrowser();
    if (!exe) {
      this.available = false;
      this.unavailableReason = 'No Chromium-family browser found (set AUDIT_CHROME_PATH)';
      return false;
    }
    try {
      const { chromium } = await import('playwright-core');
      this.browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--disable-gpu', '--no-first-run'] });
      this.available = true;
    } catch (e) {
      this.available = false;
      this.unavailableReason = `Browser launch failed: ${e.message.split('\n')[0]}`;
    }
    return this.available;
  }

  /**
   * Render a URL. Resolves with a RENDERED record or { error }.
   * The caller guarantees elapsed + render.budget_ms fits inside the URL budget (R-FETCH-2).
   */
  async render(url) {
    if (!(await this.init())) return { error: { code: 'RENDER_UNAVAILABLE', message: this.unavailableReason } };
    const budget = this.cfg.render.budget_ms;
    const t0 = Date.now();
    let context;
    try {
      context = await this.browser.newContext({
        userAgent: this.cfg.net.user_agent_resolved, // truthful UA, R-FETCH-7
        viewport: this.cfg.render.viewport,
        isMobile: true,
        hasTouch: true,
        javaScriptEnabled: true,
        ignoreHTTPSErrors: false,
      });
      const page = await context.newPage();
      const navigations = [];
      page.on('framenavigated', (f) => {
        if (f === page.mainFrame()) navigations.push({ url: f.url(), at: Date.now() - t0 });
      });
      let resp = null;
      let timedOut = false;
      try {
        resp = await page.goto(url, { waitUntil: 'networkidle', timeout: budget });
      } catch (e) {
        if (/Timeout/i.test(e.message)) timedOut = true;
        else throw e;
      }
      const remaining = Math.max(0, budget - (Date.now() - t0));
      const html = await withTimeout(page.content(), Math.max(1000, remaining));
      const dom = await withTimeout(page.evaluate(collectRenderedFacts), Math.max(1000, remaining)).catch(() => null);
      const record = {
        profile: 'RENDERED',
        requested_url: url,
        final_url: page.url(),
        status: resp ? resp.status() : null,
        html: html || '',
        dom,
        navigations,
        timed_out_network_idle: timedOut,
        elapsed_ms: Date.now() - t0,
        observed_at: new Date().toISOString(),
      };
      return record;
    } catch (e) {
      return { error: { code: 'RENDER_FAILED', message: e.message.split('\n')[0] }, elapsed_ms: Date.now() - t0 };
    } finally {
      if (context) await context.close().catch(() => {});
    }
  }

  async close() {
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
  }
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), ms))]);
}

/** Runs in the page: computed-style facts that only RENDERED can establish (R-2.3-2, R-3.1-18). */
function collectRenderedFacts() {
  const vis = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 && r.height <= 1) return false;
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)') return false;
    return true;
  };
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({
    level: Number(h.tagName[1]),
    text: (h.innerText || h.textContent || '').replace(/\s+/g, ' ').trim(),
    visible: vis(h),
  }));
  return {
    headings,
    // innerText is what a reader sees without interacting: it omits collapsed panels.
    visibleText: (document.body?.innerText || '').slice(0, 400000),
    // textContent additionally carries text inside expandable sections (accordions, <details>),
    // which a reader can reveal without leaving the page. Structured-data correspondence is checked
    // against this, so markup matching a collapsed FAQ answer is not reported as invisible.
    availableText: (document.body?.textContent || '').replace(/\s+/g, ' ').slice(0, 400000),
    title: document.title,
  };
}
