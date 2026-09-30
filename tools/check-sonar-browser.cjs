'use strict';
// Real unpacked extension, native side panels, page injection, DOM ranges and
// clipboard. No Chrome API doubles. Optional test-only dependency: Playwright.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('installed extension recovers stale sources and searches across tabs/windows', { timeout: 150_000 }, async () => {
  const bodies = new Map([
    ['/a', '<title>Source A</title><p>Privilege remains with the client in alpha.</p>'],
    ['/b', '<title>Source B</title><p>Nothing relevant yet.</p>'],
    ['/other', '<title>Other window</title><p>Privilege in another browser window.</p>']
  ]);
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(`<!doctype html><html lang="en"><body>${bodies.get(req.url) || '<title>Empty</title>'}</body></html>`); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, debug = 9400 + Math.floor(Math.random() * 500);
  let context, cdp, panel;
  const errors = [], checks = [];
  const record = label => { checks.push(label); console.log(`PASS ${label}`); };
  try {
    context = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium',
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, `--remote-debugging-port=${debug}`] });
    const legalURL = 'https://www.canlii.org/en/ca/scc/doc/2024/2024scc2/2024scc2.html';
    await context.route('https://www.canlii.org/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><title>Gamma v Delta, 2024 SCC 2 (CanLII) | CanLII</title><meta name="lbh-title" content="Gamma v Delta, 2024 SCC 2 (CanLII)"></head><body><main id="originalDocument"><p><a name="par1"></a>[1] Waiver of privilege requires an intention to waive.</p></main></body></html>` }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20_000 });
    const id = new URL(worker.url()).host;
    const a = await context.newPage(); await a.goto(`${base}/a`);
    const b = await context.newPage(); await b.goto(`${base}/b`);
    const legal = await context.newPage(); await legal.goto(legalURL);
    for (const blank of context.pages().filter(page => page.url() === 'about:blank')) await blank.close();
    const tabFor = url => worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), url);
    const firstWindow = (await tabFor(a.url())).windowId;
    const second = await worker.evaluate(async url => chrome.windows.create({ url, focused: false }), `${base}/other`);
    let other;
    for (let i = 0; i < 100 && !other; i++) { other = context.pages().find(page => page.url() === `${base}/other`); if (!other) await sleep(50); }
    assert.ok(other, 'second-window source opened'); await other.waitForLoadState();

    async function openPanel(windowId, source) {
      // A real click supplies sidePanel.open's required user gesture. The popup
      // is a temporary extension-page tab, not a mocked native API.
      const popupTab = await worker.evaluate(async ({ windowId, url }) => chrome.tabs.create({ windowId, url, active: false }),
        { windowId, url: `chrome-extension://${id}/popup.html` });
      let opener;
      for (let i = 0; i < 100 && !opener; i++) {
        for (const page of context.pages().filter(page => page.url().endsWith('/popup.html'))) {
          if ((await tabFor(page.url()))?.id === popupTab.id) { opener = page; break; }
        }
        if (!opener) await sleep(50);
      }
      assert.ok(opener, 'extension popup opened'); await opener.waitForLoadState();
      await opener.evaluate(windowId => document.addEventListener('click', () => chrome.sidePanel.open({ windowId }), { capture: true, once: true }), windowId);
      await source.bringToFront(); await opener.mouse.click(2, 2); await opener.close(); await source.bringToFront();
      cdp ||= await chromium.connectOverCDP(`http://127.0.0.1:${debug}`);
      for (let i = 0; i < 100; i++) {
        for (const page of cdp.contexts().flatMap(context => context.pages()).filter(page => page.url().endsWith('/sonar.html') && !page.isClosed())) {
          if ((await page.evaluate(() => chrome.windows.getCurrent())).id === windowId) {
            page.on('pageerror', error => errors.push(error.message));
            await page.waitForSelector('#query'); return page;
          }
        }
        await sleep(50);
      }
      throw Error('Native side panel did not open');
    }
    panel = await openPanel(firstWindow, a);
    const rows = page => page.evaluate(() => [...document.querySelectorAll('#result-rows [data-result]')].map(row => ({
      at: +row.dataset.result, title: row.querySelector('.result-title').textContent, text: row.querySelector('.result-text').textContent })));
    const row = (page, at) => page.locator(`[data-result="${at}"]`);
    async function settled(page) {
      await page.waitForFunction(() => document.querySelector('#list-viewport').getAttribute('aria-busy') === 'false', null, { timeout: 20_000 });
      assert.equal(await page.locator('#notice').evaluate(element => element.classList.contains('error')), false, await page.locator('#notice').textContent());
      return rows(page);
    }
    async function search(page, query) { await page.fill('#query', query); return settled(page); }
    const matching = (page, text) => page.waitForFunction(text => [...document.querySelectorAll('.result-text')].some(row => row.textContent.includes(text)), text, { timeout: 20_000 });
    await panel.click('#use-active'); await settled(panel);
    let found = await search(panel, 'privilege');
    assert.equal(found.length, 3); assert.ok(found.some(item => item.title === 'Other window'));
    record('ranked search includes other tabs and browser windows');
    found = await search(panel, 'waiver /p privilege'); assert.equal(found.length, 1);
    record('exact proximity search is preserved');

    await row(panel, found[0].at).getByRole('button', { name: 'Open', exact: true }).click();
    await legal.waitForFunction(() => CSS.highlights.has('legal-pinpointer-sonar-active'));
    assert.ok((await worker.evaluate(() => chrome.tabs.query({ active: true }))).some(tab => tab.url === legalURL));
    const copy = async label => {
      await panel.evaluate(() => { document.querySelector('#notice').textContent = ''; });
      await row(panel, found[0].at).getByRole('button', { name: label, exact: true }).click();
      await panel.waitForFunction(() => document.querySelector('#notice').textContent.startsWith('Copied:'));
      return panel.evaluate(async () => { const [item] = await navigator.clipboard.read(); return {
        plain: await (await item.getType('text/plain')).text(), html: await (await item.getType('text/html')).text() }; });
    };
    let copied = await copy('Copy pinpoint'); assert.equal(copied.plain, 'at para 1'); assert.match(copied.html, /2024scc2\.html#par1/);
    copied = await copy('Copy quote'); assert.match(copied.plain, /Waiver of privilege requires an intention to waive/); assert.match(copied.html, /2024scc2\.html#par1/);
    record('native source activation/highlight and rich/plain pinpoint/quote copy');

    await a.bringToFront(); await panel.click('#use-active'); await settled(panel);
    await panel.getByRole('button', { name: 'This tab', exact: true }).click(); await settled(panel);
    found = await search(panel, 'privilege'); assert.equal(found.length, 1); assert.equal(found[0].title, 'Source A');
    bodies.set('/a', '<title>Source A reloaded</title><p>Privilege survives a same-URL reload.</p>'); await a.reload();
    await matching(panel, 'same-URL reload');
    record('current source refreshes after same-URL navigation');

    await panel.getByRole('button', { name: 'All tabs', exact: true }).click(); await settled(panel); await panel.focus('#query');
    await b.evaluate(() => { document.querySelector('p').textContent = 'Privilege newly appears in a previously zero-hit source.'; });
    await matching(panel, 'previously zero-hit');
    record('background mutation adds previously missing All-tabs matches');
    await b.bringToFront(); await a.close();
    await panel.getByRole('button', { name: 'This tab', exact: true }).click(); found = await settled(panel);
    assert.equal(found.length, 1); assert.equal(found[0].title, 'Source B');
    record('closing the pinned origin reattaches to the remaining active tab');

    const panel2 = await openPanel(second.id, other); await panel2.click('#use-active'); await settled(panel2); await search(panel2, 'privilege');
    await panel.focus('#query'); await panel2.focus('#query');
    await b.evaluate(() => { document.querySelector('p').textContent = 'Privilege broadcast reaches two independent panels.'; });
    await Promise.all([matching(panel, 'two independent panels'), matching(panel2, 'two independent panels')]);
    await panel2.focus('#query'); await Promise.all([panel2.waitForEvent('close'), panel2.keyboard.press('Escape')]);
    await panel.focus('#query'); await b.evaluate(() => { document.querySelector('p').textContent = 'Privilege watcher survives the other panel closing.'; });
    await matching(panel, 'other panel closing');
    record('independent panels receive invalidations and one Close preserves the other watcher');

    await panel.getByRole('button', { name: 'All tabs', exact: true }).click(); found = await settled(panel);
    const destination = found.find(item => item.title === 'Other window'); assert.ok(destination);
    await row(panel, destination.at).getByRole('button', { name: 'Open', exact: true }).click();
    await other.waitForFunction(() => CSS.highlights.has('legal-pinpointer-sonar-active'));
    assert.ok((await worker.evaluate(() => chrome.tabs.query({ active: true }))).some(tab => tab.url.endsWith('/other')));
    record('cross-window Open targets and highlights the original passage');
    assert.deepEqual(errors, []);
  } finally {
    const report = { checks, errors, browser: context?.browser()?.version(), nativeExtension: true };
    fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test-results/sonar-browser.json'), JSON.stringify(report, null, 2));
    if (panel && !panel.isClosed()) await panel.screenshot({ path: path.join(root, 'test-results/sonar-panel.png') }).catch(() => {});
    await cdp?.close().catch(() => {}); await context?.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
  }
});
