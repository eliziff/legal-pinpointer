'use strict';

// Main-thread cost of the in-page UI on saved CanLII, Westlaw and Lexis pages, with the extension
// loaded and without it, under CPU throttling: long tasks in the first seconds after load, time
// until the paragraph controls appear, frame times while scrolling, and JS heap.
// Usage: node tools/benchmark-page-ui.cjs <corpus-dir> [throttle=4] [settings-json] [provider:name,...]
// (corpus layout as for tools/check-page-ui.cjs; set PLAYWRIGHT_MODULE / CHROME_PATH as needed)
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const [corpus, throttleArg, settingsArg, pagesArg] = process.argv.slice(2);
const overrides = settingsArg && settingsArg !== '-' ? JSON.parse(settingsArg) : null;
const throttle = Number(throttleArg || 4);
const PAGES = pagesArg ? pagesArg.split(',').map((item) => item.split(':'))
  : [['canlii', 'Chouhan'], ['canlii', 'Competition-Act'], ['westlaw', 'Sommerer'], ['westlaw', 'Superior-Propane-Inc-Westlaw'], ['lexis', 'Royes']];

function sample(provider, match) {
  const base = path.join(corpus, provider);
  const dir = fs.readdirSync(base).find((name) => name.includes(match));
  const folder = path.join(base, dir);
  const capture = JSON.parse(fs.readFileSync(path.join(folder, 'capture.json'), 'utf8'));
  const file = ['raw.html', 'rendered.html'].map((name) => path.join(folder, name)).find((name) => fs.existsSync(name));
  let html = fs.readFileSync(file, 'utf8');
  const styles = path.join(folder, 'styles.css');
  if (fs.existsSync(styles) && provider !== 'canlii') html = html.replace(/<\/head>/i, `<style>${fs.readFileSync(styles, 'utf8')}</style></head>`);
  return { provider, name: match, url: capture.url, html };
}

// Long tasks, layout shifts, first paint, DOMContentLoaded and when each piece of page UI appeared
// (ms since navigation start), recorded from before the page's first byte.
const OBSERVE = () => {
  window.__long = [];
  window.__shift = 0;
  const seen = window.__seen = {};
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__long.push(entry.duration); })
    .observe({ type: 'longtask', buffered: true });
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__shift += entry.value; })
    .observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (entry.name === 'first-contentful-paint') seen.fcp = Math.round(entry.startTime); })
    .observe({ type: 'paint', buffered: true });
  document.addEventListener('DOMContentLoaded', () => { seen.dcl = Math.round(performance.now()); });
  const watch = { units: '.lp-unit', tools: '.lp-tools', crumb: '.lp-crumb-copy', circle: '.lpm-circle' };
  new MutationObserver(() => {
    for (const [name, selector] of Object.entries(watch)) if (seen[name] === undefined && document.querySelector(selector)) seen[name] = Math.round(performance.now());
  }).observe(document, { childList: true, subtree: true });
};

async function measure(withExtension, page) {
  const context = await chromium.launchPersistentContext('', {
    headless: true, channel: 'chromium', viewport: { width: 1360, height: 900 },
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: withExtension ? [`--disable-extensions-except=${root}`, `--load-extension=${root}`] : ['--disable-extensions']
  });
  await context.route('**/*', (route) => {
    const request = route.request();
    if (!/^https?:/.test(request.url())) return route.continue();
    if (request.resourceType() === 'document') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: page.html });
    return route.abort();
  });
  if (withExtension) {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    if (overrides) await worker.evaluate((values) => chrome.storage.local.set(values), overrides);
  }
  // Warm once (engine host, caches), then measure a fresh load.
  const warm = await context.newPage();
  await warm.goto(page.url, { waitUntil: 'load' });
  await warm.waitForTimeout(2500);
  await warm.close();
  const tab = await context.newPage();
  await tab.addInitScript(OBSERVE);
  const cdp = await context.newCDPSession(tab);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await cdp.send('Performance.enable');
  await tab.goto(page.url, { waitUntil: 'load' });
  await tab.waitForTimeout(4000);
  const settle = await tab.evaluate(() => ({ count: window.__long.length, total: Math.round(window.__long.reduce((a, b) => a + b, 0)), max: Math.round(Math.max(0, ...window.__long)) }));
  const timeline = await tab.evaluate(() => ({ ...window.__seen, cls: +window.__shift.toFixed(4) }));
  // Scroll the document 12,000 px in steps and time frames, and count long tasks meanwhile.
  const frames = await tab.evaluate(async () => {
    const before = window.__long.length;
    const scroller = document.scrollingElement;
    const times = [];
    let last = performance.now();
    for (let step = 0; step < 120; step += 1) {
      scroller.scrollTop += 100;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = performance.now();
      times.push(now - last);
      last = now;
    }
    times.sort((a, b) => a - b);
    const long = window.__long.slice(before);
    return { p50: Math.round(times[60]), p95: Math.round(times[114]), max: Math.round(times[119]), over50: times.filter((t) => t > 50).length, longTotal: Math.round(long.reduce((a, b) => a + b, 0)) };
  });
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const result = { timeline, longTasks: settle, scrollFrames: frames, heapMB: +(metrics.JSHeapUsedSize / 1e6).toFixed(1), nodes: metrics.Nodes, mounted: await tab.locator('.lp-unit').count() };
  await context.close();
  return result;
}

(async () => {
  for (const [provider, match] of PAGES) {
    const page = sample(provider, match);
    const off = await measure(false, page);
    const on = await measure(true, page);
    console.log(JSON.stringify({ page: `${provider} ${match}`, throttle, off, on }));
  }
})().catch((error) => { console.error(error); process.exit(1); });
