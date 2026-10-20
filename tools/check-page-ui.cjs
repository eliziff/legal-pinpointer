'use strict';

// Loads the unpacked extension in Chromium and serves saved CanLII, Westlaw and Lexis pages at
// their real URLs (page scripts blocked, and stood in for by click- and copy-swallowing handlers),
// then uses every in-page control and checks its clipboard output: CanLII's header name and copy
// button, the Westlaw/Lexis title tools (CanLII or court-site button, Case Marker circle, copy
// link), Alt+X, both paragraph buttons with and without a selection, Ctrl+X, the floating CanLII
// button, Case Marker on search results and titles, the popup. It also records when each piece
// appeared, every layout shift, and frame times while scrolling. Screenshots go to the output
// directory.
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

function samples(provider, names) {
  const base = path.join(corpus, provider);
  const dirs = fs.readdirSync(base);
  return names.map((name) => dirs.find((dir) => dir.includes(name))).filter(Boolean).map((dir) => {
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
  const pages = [...samples('canlii', ['Chouhan', 'Competition-Act']), ...samples('westlaw', ['Sommerer', 'Sparrow', 'Superior-Propane-Inc-Westlaw']),
    ...samples('lexis', ['Cullinane', 'Superior-Propane-Inc-2002'])];
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

    // Timestamps (ms since navigation start) of the first paint, DOMContentLoaded and each piece of
    // page UI, and every layout shift, recorded from before the page's first byte.
    await context.addInitScript(() => {
      const seen = window.__lpSeen = {};
      window.__lpShifts = [];
      const describe = (node) => !node ? '?' : node.nodeType === 1 ? `${node.tagName}#${node.id}.${String(node.className).slice(0, 30)}` : `text in ${node.parentElement?.tagName}#${node.parentElement?.id}`;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.hadRecentInput) continue;
          window.__lpShifts.push(entry.value);
          (window.__lpShiftSources ||= []).push(`${Math.round(entry.startTime)}ms ${entry.value.toFixed(4)}: ${entry.sources.map((source) => `${describe(source.node)} y${Math.round(source.previousRect.y)}->${Math.round(source.currentRect.y)}`).join(', ')}`);
        }
      }).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) seen[entry.name] ??= Math.round(entry.startTime); })
        .observe({ type: 'paint', buffered: true });
      document.addEventListener('DOMContentLoaded', () => { seen.dcl = Math.round(performance.now()); });
      const watch = { units: '.lp-unit', tools: '.lp-tools', crumb: '.lp-crumb-copy', circle: '.lpm-circle' };
      new MutationObserver(() => {
        for (const [name, selector] of Object.entries(watch)) if (seen[name] === undefined && document.querySelector(selector)) seen[name] = Math.round(performance.now());
      }).observe(document, { childList: true, subtree: true });
    });

    const readClipboard = (page) => page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const text = async (type) => item.types.includes(type) ? (await item.getType(type)).text() : '';
      return { plain: await text('text/plain'), html: (await text('text/html')).replace(/^[\s\S]*?<body[^>]*>|<\/body>[\s\S]*$/gi, '').replace(/<!--(?:Start|End)Fragment-->/g, '') };
    });
    // Runs an action and waits for its toast; the clipboard and the time it took.
    const copied = async (page, action) => {
      await page.evaluate(() => { const toast = document.getElementById('legal-pinpointer-status'); if (toast) { toast.textContent = ''; toast.classList.remove('legal-pinpointer-toast--error'); } navigator.clipboard.writeText('-'); });
      const at = Date.now();
      await action();
      await page.waitForFunction(() => /^Copied/.test(document.getElementById('legal-pinpointer-status')?.textContent || '')
        || (document.getElementById('legal-pinpointer-status')?.classList.contains('legal-pinpointer-toast--error')
          && document.getElementById('legal-pinpointer-status').textContent), null, { timeout: 8000 });
      const ms = Date.now() - at;
      const toast = await page.locator('#legal-pinpointer-status').innerText();
      const clip = await readClipboard(page);
      return { ms, toast: toast.slice(0, 120), plain: clip.plain.slice(0, 140), html: clip.html.slice(0, 160),
        plainBreaks: (clip.plain.match(/\n/g) || []).length, ownMarkup: /lp-unit|data-lp-ui|lp-tools/.test(clip.html) };
    };

    for (const sample of pages) {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const started = Date.now();
      await page.goto(sample.url, { waitUntil: 'load' });
      const label = `${sample.provider} ${sample.name}`;
      // Provider scripts are blocked here; stand in for their worst habits: a window click handler
      // that swallows every click, and copy handlers that take over the clipboard.
      await page.evaluate(() => {
        window.addEventListener('click', (event) => event.stopImmediatePropagation(), true);
        window.addEventListener('mousedown', (event) => event.stopImmediatePropagation(), true);
        document.addEventListener('copy', (event) => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
      });
      await sleep(sample.provider === 'canlii' ? 300 : 1500);
      log(`${label}: timeline ms`, await page.evaluate(() => window.__lpSeen));
      log(`${label}: layout shift (CLS)`, await page.evaluate(() => ({ cls: +window.__lpShifts.reduce((sum, value) => sum + value, 0).toFixed(4), sources: window.__lpShiftSources || [] })));

      if (sample.provider === 'canlii') {
        log(`${label}: header name`, await page.locator('#canlii-breadcrumbs > span:last-of-type [itemprop="name"]').innerText().catch(() => 'MISSING'));
        if (await page.locator('.lp-crumb-copy').count()) {
          log(`${label}: header copy link`, await copied(page, () => page.locator('.lp-crumb-copy').click()));
        } else log(`${label}: header copy link`, 'MISSING');
      } else {
        try {
          await page.waitForSelector('.lp-tools .lp-canlii:not(.pending)', { timeout: 15_000 });
          const link = page.locator('.lp-tools .lp-canlii');
          log(`${label}: title CanLII button`, `${await link.getAttribute('class')} ${await link.getAttribute('href') || ''}`);
        } catch (_) { log(`${label}: title CanLII button`, 'MISSING'); }
        log(`${label}: title text selectable`, await page.evaluate(() => {
          const title = document.querySelector('#co_docHeaderTitleLine, #SS_DocumentTitle');
          return title ? { text: title.innerText.trim().slice(0, 80), userSelect: getComputedStyle(title).userSelect, tools: Boolean(title.querySelector('.lp-tools')),
            toolsInFlow: getComputedStyle(title.querySelector('.lp-tools') || title).position !== 'absolute' } : 'no title';
        }));
        // Selecting the title: a drag from its first character that overshoots past its end, and a
        // triple-click, each select the title and nothing else, and the page stays where it is.
        const titleBox = await page.evaluate(() => {
          const title = document.querySelector('#co_docHeaderTitleLine, #SS_DocumentTitle');
          if (!title || !title.getClientRects().length) return null;
          title.scrollIntoView({ block: 'center' });
          const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
          let first = null, last = null;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.data.trim() && !node.parentElement.closest('[data-lp-ui]')) { first ||= node; last = node; }
          const range = document.createRange(); range.setStart(first, 0); range.setEnd(last, last.length);
          const rects = [...range.getClientRects()];
          return { x1: rects[0].left + 2, y1: rects[0].top + rects[0].height / 2, x2: rects.at(-1).right, y2: rects.at(-1).top + rects.at(-1).height / 2, text: title.innerText.trim() };
        });
        if (titleBox) {
          const selected = () => page.evaluate(() => getSelection().toString().replace(/\s+/g, ' ').trim());
          await page.mouse.move(titleBox.x1, titleBox.y1); await page.mouse.down();
          await page.mouse.move(titleBox.x2 + 250, titleBox.y2 + 70, { steps: 10 }); await page.mouse.up();
          const drag = await selected();
          await page.mouse.click(titleBox.x1 + 6, titleBox.y1, { clickCount: 3 });
          log(`${label}: title selection`, { drag, triple: await selected(), stayed: page.url() === sample.url });
          await page.evaluate(() => { getSelection().removeAllRanges(); scrollTo(0, 0); });
        }
        log(`${label}: title Case Marker circle`, await page.locator('.lp-tools .lpm-circle').count());
        if (await page.locator('.lp-tools .lp-link').isVisible()) log(`${label}: title copy link`, await copied(page, () => page.locator('.lp-tools .lp-link').click()));
        else log(`${label}: title copy link`, 'not shown: the saved page does not display its document');
        log(`${label}: Alt+X`, await copied(page, async () => { await page.locator('body').click({ position: { x: 5, y: 300 } }).catch(() => {}); await page.keyboard.press('Alt+X'); }));
      }

      // Paragraph controls: count, then both buttons on a paragraph in the middle, with and
      // without a selection spanning into the next paragraph.
      const units = await page.evaluate(() => {
        const controls = [...document.querySelectorAll('.lp-unit')];
        const control = controls[Math.min(4, controls.length - 1)];
        if (!control) return { controls: 0 };
        control.scrollIntoView({ block: 'center' });
        window.__lpControl = control;
        window.__lpNextControl = controls[Math.min(5, controls.length - 1)];
        return { controls: controls.length, place: control.dataset.place, kind: control.dataset.kind, locator: control.lpLocator };
      });
      log(`${label}: paragraph controls`, units);
      if (units.controls && !await page.evaluate(() => window.__lpControl.getClientRects().length)) {
        log(`${label}: paragraph controls`, 'not shown: the saved page does not display its document');
      } else if (units.controls) {
        await page.screenshot({ path: path.join(out, `${sample.provider}-${sample.name.slice(0, 40)}-units.png`) });
        // As a reader does: the pointer moves onto the button, then presses it.
        const press = async (mode) => {
          const box = await (await page.evaluateHandle((mode) => window.__lpControl.querySelector(`button[data-mode="${mode}"]`), mode)).asElement().boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
          await page.mouse.down();
          await page.mouse.up();
        };
        for (const mode of ['pinpoint', 'quote']) log(`${label}: unit ${mode}`, await copied(page, () => press(mode)));
        await page.evaluate(() => {
          const block = window.__lpControl.parentElement, next = window.__lpNextControl?.parentElement;
          const walk = (root, last) => { const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node, found = null;
            while ((node = walker.nextNode())) if (node.data.trim().length > 20 && !node.parentElement.closest('[data-lp-ui]')) { found = node; if (!last) break; } return found; };
          const start = walk(block, false), end = walk(next && next !== block ? next : block, true) || start;
          const range = document.createRange();
          range.setStart(start, Math.min(5, start.length)); range.setEnd(end, Math.min(20, end.length));
          getSelection().removeAllRanges(); getSelection().addRange(range);
        });
        for (const mode of ['pinpoint', 'quote']) log(`${label}: selection ${mode}`, await copied(page, () => press(mode)));
        log(`${label}: selection Ctrl+X`, await copied(page, () => page.keyboard.press('Control+X')));
        await page.evaluate(() => getSelection().removeAllRanges());
      }

      // Scrolling does no work: long tasks and frame times while scrolling the whole document.
      log(`${label}: scroll`, await page.evaluate(async () => {
        let long = 0;
        const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) long += entry.duration; });
        observer.observe({ type: 'longtask' });
        const times = [];
        let last = performance.now();
        scrollTo(0, 0);
        for (let step = 0; step < 80; step += 1) {
          document.scrollingElement.scrollTop += 200;
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const now = performance.now();
          times.push(now - last);
          last = now;
        }
        observer.disconnect();
        times.sort((a, b) => a - b);
        return { p50: Math.round(times[40]), p95: Math.round(times[76]), longTaskMs: Math.round(long) };
      }));
      if (sample.provider !== 'canlii') {
        await sleep(200);
        log(`${label}: floating CanLII button after scrolling`, await page.evaluate(() => {
          const host = [...document.documentElement.children].find((element) => element.shadowRoot?.querySelector('a'));
          const link = host?.shadowRoot.querySelector('a');
          return link ? `${link.className} ${link.getAttribute('href') || ''}` : 'none';
        }));
      }
      await page.evaluate(() => scrollTo(0, 0));
      await sleep(150);
      await page.screenshot({ path: path.join(out, `${sample.provider}-${sample.name.slice(0, 40)}-top.png`) });
      if (sample.provider === 'canlii' && await page.locator('h1.main-title .lpm-circle').count()) {
        await page.locator('h1.main-title .lpm-circle').click();
        log(`${label}: title circle opens picker`, await page.locator('.lpm-picker:not([hidden])').count());
        await page.keyboard.press('Escape');
      }
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
    await popup.waitForSelector('.tabs [aria-selected="true"]');
    log('popup ms to first paint', Date.now() - popupStart);
    log('popup tabs (first is the default)', await popup.evaluate(() => [...document.querySelectorAll('.tabs [data-tab]')].map((tab) => `${tab.dataset.tab}${tab.getAttribute('aria-selected') === 'true' ? '*' : ''}`)));
    log('popup scrollbar space reserved', await popup.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter));
    for (const tab of ['marker', 'copy', 'settings']) {
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
