'use strict';

// How many saved Westlaw and Lexis case pages resolve to a CanLII (or court-site) version: loads each
// page with the unpacked extension at its real URL (page scripts blocked) and asks the content script
// for its metadata, as the popup does. Prints one line per page and a summary.
// Usage: node tools/check-canlii-resolution.cjs <pinpointer-corpus-dir> [provider ...]
// Requires Playwright: set PLAYWRIGHT_MODULE (and CHROME_PATH) as for tools/check-page-ui.cjs.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const [corpus, ...providerArgs] = process.argv.slice(2);
if (!corpus) { process.stderr.write('Usage: node tools/check-canlii-resolution.cjs <corpus-dir> [provider ...]\n'); process.exit(2); }
const providers = providerArgs.length ? providerArgs : ['westlaw', 'lexis'];

function samples(provider) {
  const base = path.join(corpus, provider);
  return fs.readdirSync(base).map((dir) => {
    const folder = path.join(base, dir);
    const capture = JSON.parse(fs.readFileSync(path.join(folder, 'capture.json'), 'utf8'));
    const file = ['raw.html', 'rendered.html'].map((name) => path.join(folder, name)).find((name) => fs.existsSync(name));
    return file ? { provider, url: capture.url, file, name: dir.split('__')[1] || dir } : null;
  }).filter(Boolean);
}

(async () => {
  const pages = providers.flatMap(samples);
  const context = await chromium.launchPersistentContext('', {
    headless: true, channel: 'chromium', viewport: { width: 1280, height: 800 },
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  let current = null;
  await context.route('**/*', (route) => {
    const request = route.request();
    if (!/^https?:/.test(request.url())) return route.continue();
    if (request.resourceType() === 'document' && current) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(current.file, 'utf8') });
    return route.abort();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const tally = { case: 0, found: 0, other: 0, failed: 0 };
  const page = await context.newPage();
  for (const sample of pages) {
    current = sample;
    await page.goto(sample.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const result = await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url: url.split('#')[0] });
      if (!tab) return { ok: false, message: 'no tab' };
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          return await chrome.tabs.sendMessage(tab.id, { type: 'LEGAL_PINPOINTER_INSPECT', metadataOnly: true });
        } catch (_) { await new Promise((resolve) => setTimeout(resolve, 150)); }
      }
      return { ok: false, message: 'no content script' };
    }, sample.url);
    if (!result?.ok) { tally.failed += 1; console.log(`FAIL  ${sample.provider} ${sample.name}: ${result?.message}`); continue; }
    if (result.documentType !== 'case') { tally.other += 1; continue; }
    tally.case += 1;
    if (result.canliiAvailable) tally.found += 1; else if (result.siteUrl) tally.site = (tally.site || 0) + 1;
    console.log(`${result.canliiAvailable ? 'found' : 'MISS '} ${sample.provider} ${result.citation}${result.siteUrl ? `  -> ${result.siteUrl}` : ''}`);
  }
  console.log(JSON.stringify(tally));
  await context.close();
})().catch((error) => { console.error(error); process.exit(1); });
