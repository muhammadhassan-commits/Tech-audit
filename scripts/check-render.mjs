// Asserts that this machine can actually render a page, and exits non-zero if it cannot.
//
// The Docker build runs this. Checking that a browser file exists is not enough: a binary that is
// present but will not start produces exactly the same audit as a missing one — every
// JavaScript-injected value invisible, on every page — and nothing errors. The only honest check
// is to launch the browser through the engine's own code path, with the flags production will use.
import { findBrowser, Renderer } from '../src/net/render.js';
import { loadConfig } from '../src/config.js';

const want = process.env.AUDIT_CHROME_PATH;

const exe = findBrowser();
if (!exe) {
  console.error('FAIL: the engine cannot find a browser (set AUDIT_CHROME_PATH)');
  process.exit(1);
}
// findBrowser() falls through to the next candidate when the configured path is missing. That is
// reasonable at runtime, but in an image it would hide the fact that the browser we installed is
// not the one being used — so here the configured path must be the one that resolved.
if (want && exe !== want) {
  console.error(`FAIL: AUDIT_CHROME_PATH is ${want} but the engine resolved ${exe}`);
  process.exit(1);
}

const renderer = new Renderer(loadConfig({}));
if (!(await renderer.init())) {
  console.error(`FAIL: the browser will not launch — ${renderer.unavailableReason}`);
  process.exit(1);
}
await renderer.close();

console.log(`render check: ${exe} launches with ${process.env.AUDIT_CHROME_ARGS || 'no extra args'}`);
