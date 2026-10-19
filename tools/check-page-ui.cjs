'use strict';

// Loads the unpacked extension in Chromium and serves saved CanLII, Westlaw and Lexis pages at
// their real URLs (page scripts blocked), then checks and times the in-page controls: CanLII's
// header banner, the Westlaw/Lexis title card and CanLII button, the hover copy bar and its
// clipboard output, the toast and the popup. Screenshots go to the output directory.
// Usage: node tools/check-page-ui.cjs <pinpointer-corpus-dir> [output-dir]
// (corpus layout: <provider>/<key>__<slug>/{capture.json, raw.html | rendered.html, styles.css})
// Requires Playwright: set PLAYWRIGHT_MODULE to its path if it is not installed locally.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const [corpus, outArg] = process.argv.slice(2);
if (!corpus) { process.stderr.write('Usage: node tools/check-page-ui.cjs <corpus-dir> [output-dir]\n'); process.exit(2); }
const out = path.resolve(outArg || fs.mkdtempSync(path.join(os.tmpdir(), 'lp-page-ui-')));
fs.mkdirSync(out, { recursive: true });

function samples(provider, limit) {
  const base = path.join(corpus, provider);
  return fs.readdirSync(base).slice(0, limit).map((dir) => {
    const folder = path.join(base, dir);
    const capture = JSON.parse(fs.readFileSync(path.join(folder, 'capture.json'), 'utf8'));
    const file = ['raw.html', 'rendered.html'].map((name) => path.join(folder, name)).find((name) => fs.existsSync(name));
    let html = fs.readFileSync(file, 'utf8');
    const styles = path.join(folder, 'styles.css');
    if (fs.existsSync(styles) && provider !== 'canlii') html = html.replace(/<\/head>/i, `<style>${fs.readFileSync(styles, 'utf8')}</style></head>`);
    return { provider, url: capture.url, html, name: dir.split('__')[1] || dir };
  });
}


const SEARCH_URL = 'https://www.canlii.org/en/';
const SEARCH_PAGE = `<!doctype html><html lang="en"><head><title>Search Results | CanLII</title></head><body>
${[['/en/ab/abqb/doc/2031/2031abqb101/2031abqb101.html', 'Alpha Holdings v Beta Mills', '2031 ABQB 101', 'CASE'],
   ['/en/ab/laws/stat/sa-2030-c-z-9/latest/sa-2030-c-z-9.html', 'Zeta Fisheries Act', 'SA 2030, c Z-9', 'LEGISLATION']].map(([path, name, cite, type], index) => `
<div class="row"><div class="col index"><span data-result-number="${index + 1}">${index + 1}.</span></div>
<div class="searchResult col" data-lbh-type="${type}" data-lbh-path="${path}" data-lbh-title="${name}">
<div class="titleContainer"><div class="title"><span class="name"><a href="https://www.canlii.org${path}?searchId=x">${name}</a>, ${cite}</span></div></div>
${index === 1 ? '<div class="onlineVersion"><a href="https://www.canlii.org/en/ab/laws/stat/sa-2030-c-z-9/123456/sa-2030-c-z-9.html">Past version</a></div>' : ''}
</div></div>`).join('')}</body></html>`;
const results = [];
const log = (label, value) => { results.push({ label, value }); console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const pages = [...samples('canlii', 2), ...samples('westlaw', 2), ...samples('lexis', 2)];
  const byUrl = new Map(pages.map((sample) => [sample.url.split('#')[0], sample]));
  const context = await chromium.launchPersistentContext('', {
    headless: true, channel: 'chromium', viewport: { width: 1360, height: 900 },
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    for (const origin of ['https://www.canlii.org', 'https://nextcanada.westlaw.com', 'https://advance.lexis.com']) {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    }
    await context.route('**/*', (route) => {
      const request = route.request();
      if (!/^https?:/.test(request.url())) return route.continue();
      if (request.resourceType() === 'document' && request.url().split('#')[0] === SEARCH_URL) {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: SEARCH_PAGE });
      }
      const sample = request.resourceType() === 'document' && byUrl.get(request.url().split('#')[0]);
      if (sample) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: sample.html });
      if (['script', 'xhr', 'fetch', 'websocket', 'media', 'font'].includes(request.resourceType())) return route.abort();
      if (request.resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Blocked</title>' });
      return route.continue();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20_000 });
    const extensionId = new URL(worker.url()).host;
    await sleep(800);
    log('engine host open', await worker.evaluate(() => chrome.offscreen.hasDocument()));

    for (const sample of pages) {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const started = Date.now();
      await page.goto(sample.url, { waitUntil: 'domcontentloaded' });
      const loaded = Date.now();
      const label = `${sample.provider} ${sample.name}`;
      const ui = sample.provider === 'canlii' ? '#canlii-header > .lp-banner' : '[data-lp-ui] >> .card';
      try {
        await page.waitForSelector(ui, { timeout: 15_000 });
        log(`${label}: title UI ms after DOMContentLoaded`, Date.now() - loaded);
        log(`${label}: title text`, await page.locator(sample.provider === 'canlii' ? '.lp-banner-title' : '.card .name').first().innerText());
      } catch (error) { log(`${label}: title UI`, `MISSING (${error.message.split('\n')[0]})`); }
      if (sample.provider !== 'canlii') {
        try {
          await page.waitForSelector('.card .canlii:not(.pending)', { timeout: 15_000 });
          const button = page.locator('.card .canlii');
          log(`${label}: CanLII button`, `${await button.getAttribute('class')} ${await button.getAttribute('href') || ''}`);
        } catch (_) { log(`${label}: CanLII button`, 'MISSING'); }
      }
      // Hover a paragraph in the middle of the document and time the copy bar.
      const target = await page.evaluateHandle((provider) => {
        const selector = provider === 'canlii' ? 'a[name^="par"]' : provider === 'westlaw' ? '[id^="crsw_paragraph_num_"]' : '[id^="PARA_"]';
        const markers = [...document.querySelectorAll(selector)];
        const marker = markers[Math.min(4, markers.length - 1)];
        const block = marker && (marker.closest('p, li, div') || marker);
        block?.scrollIntoView({ block: 'center' });
        return block;
      }, sample.provider);
      if (await target.evaluate((node) => Boolean(node))) {
        await sleep(2500); // the model is built in idle time after load
        const box = await target.asElement().boundingBox();
        const hoverStart = Date.now();
        await page.mouse.move(box.x + Math.min(200, box.width / 2), box.y + Math.min(10, box.height / 2));
        try {
          await page.waitForSelector('.bar.on', { timeout: 5000 });
          log(`${label}: hover bar ms`, Date.now() - hoverStart);
          log(`${label}: hover bar label`, await page.locator('.bar button[data-mode="pinpoint"]').getAttribute('data-tip'));
          await page.screenshot({ path: path.join(out, `${sample.provider}-${sample.name.slice(0, 40)}-hover.png`) });
          for (const mode of ['pinpoint', 'quote', 'link']) {
            const clickAt = Date.now();
            await page.evaluate(() => { const toast = document.getElementById('legal-pinpointer-status'); if (toast) toast.textContent = ''; });
            await page.locator(`.bar button[data-mode="${mode}"]`).click();
            await page.waitForFunction(() => /^Copied/.test(document.getElementById('legal-pinpointer-status')?.textContent || ''), null, { timeout: 5000 });
            const elapsed = Date.now() - clickAt;
            const clip = await page.evaluate(async () => {
              const [item] = await navigator.clipboard.read();
              const text = async (type) => item.types.includes(type) ? (await item.getType(type)).text() : '';
              return { plain: await text('text/plain'), html: await text('text/html') };
            });
            const fragment = clip.html.replace(/^[\s\S]*?<body[^>]*>|<\/body>[\s\S]*$/gi, '').replace(/<!--(?:Start|End)Fragment-->/g, '');
            log(`${label}: copy ${mode}`, { ms: elapsed, toast: await page.locator('#legal-pinpointer-status').innerText(),
              plain: clip.plain.slice(0, 160), plainBreaks: (clip.plain.match(/\n/g) || []).length,
              htmlBlocks: (fragment.match(/<(?:p|div|br|li|h\d)\b/gi) || []).length, html: fragment.slice(0, 220) });
            await sleep(150);
          }
        } catch (error) { log(`${label}: hover bar`, `MISSING (${error.message.split('\n')[0]})`); }
      } else log(`${label}: hover target`, 'no paragraph markers');
      // Keyboard copy of the hovered unit (the pointer is still on the copy bar).
      await page.evaluate(() => { const toast = document.getElementById('legal-pinpointer-status'); if (toast) toast.textContent = ''; });
      const keyStart = Date.now();
      await page.keyboard.press('Control+x');
      try {
        await page.waitForFunction(() => /Copied pinpoint/.test(document.getElementById('legal-pinpointer-status')?.textContent || ''), null, { timeout: 5000 });
        log(`${label}: Ctrl+X ms`, Date.now() - keyStart);
      } catch (_) { log(`${label}: Ctrl+X`, await page.locator('#legal-pinpointer-status').innerText().catch(() => 'no toast')); }
      await page.evaluate(() => scrollTo(0, 0));
      await sleep(200);
      await page.screenshot({ path: path.join(out, `${sample.provider}-${sample.name.slice(0, 40)}-top.png`) });
      if (errors.length) log(`${label}: page errors`, errors.slice(0, 3));
      log(`${label}: total ms`, Date.now() - started);
      await page.close();
    }

    // Case Marker: circles on current search results only; filing one colours it.
    const search = await context.newPage();
    await search.goto(`${SEARCH_URL}#search/text=fisheries`);
    await search.waitForSelector('.lpm-wrap .lpm-circle', { timeout: 10_000 });
    await sleep(300);
    log('marker circles on search results', await search.locator('.lpm-circle').count());
    await search.screenshot({ path: path.join(out, 'marker-search.png') });

    // PDF links: the copied text becomes a text-fragment link to the active page.
    await search.evaluate(() => navigator.clipboard.writeText('Zeta Fisheries Act'));
    const pdf = await worker.evaluate(async () => pdfFragmentLink((await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]));
    log('pdf link', { ...pdf, clipboard: await search.evaluate(() => navigator.clipboard.readText()) });

    const popup = await context.newPage();
    popup.on('pageerror', (error) => log('popup error', error.message));
    popup.on('console', (message) => { if (message.type() === 'error') log('popup console', message.text()); });
    await popup.setViewportSize({ width: 360, height: 640 });
    const popupStart = Date.now();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForSelector('#doc-kind');
    log('popup ms to first paint', Date.now() - popupStart);
    for (const tab of ['copy', 'marker', 'settings']) {
      await popup.click(`.tabs [data-tab="${tab}"]`);
      if (tab === 'marker') {
        await popup.click('#add-folder'); await popup.keyboard.type('Charter'); await popup.keyboard.press('Enter');
        await popup.click('#add-folder'); await popup.keyboard.type('Remedies'); await popup.keyboard.press('Enter');
        await popup.locator('.folder').first().hover();
        await popup.locator('.folder').first().locator('[data-sub]').click(); await popup.keyboard.type('Section 24(2)'); await popup.keyboard.press('Enter');
      }
      await popup.screenshot({ path: path.join(out, `popup-${tab}.png`), fullPage: true });
    }
    log('folder colours', await popup.evaluate(() => [...document.querySelectorAll('.swatch')].map((swatch) => swatch.style.background)));
    // File the first search result into the first folder from the page's picker.
    await search.bringToFront();
    await search.locator('.lpm-circle').first().click();
    await search.waitForSelector('.lpm-picker:not([hidden])');
    await search.screenshot({ path: path.join(out, 'marker-picker.png') });
    await search.locator('.lpm-row[data-folder]:not([data-folder=""])').first().click();
    await sleep(200);
    log('filed circle colour', await search.locator('.lpm-circle').first().evaluate((circle) => circle.style.background));
    await popup.bringToFront();
    await popup.click('.tabs [data-tab="marker"]');
    await popup.locator('.folder [data-view]').first().click();
    await sleep(150);
    log('folder viewer', await popup.locator('#viewer-list').innerText());
    await popup.screenshot({ path: path.join(out, 'popup-marker-viewer.png'), fullPage: true });
  } finally {
    await context.close();
  }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\nScreenshots and results: ${out}`);
})().catch((error) => { console.error(error); process.exit(1); });
