'use strict';

// Optional browser regression: npm install --no-save --package-lock=false playwright
// No Playwright dependency is loaded by the extension. The broker and page scripts
// are real; Chrome tab/permission APIs are deliberately simulated, not installation-tested.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
require('../find-core.js');
const { createBroker } = require('../find-worker.js');
const root = path.resolve(__dirname, '..');

test('real matcher, page reader, modal and broker cooperate across three Chromium documents', { timeout: 90_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const pages = new Map(), store = {}, navigations = [], errors = [];
    const tabs = [
      { id: 1, title: 'Current article', url: 'https://ordinary.test/article', groupId: 7, windowId: 1, index: 0 },
      { id: 2, title: 'Other article', url: 'http://other.test/article', groupId: 7, windowId: 1, index: 1 },
      { id: 3, title: 'Another window', url: 'https://third.test/article', groupId: 8, windowId: 2, index: 0 },
      { id: 4, title: 'Settings', url: 'chrome://settings', groupId: -1, windowId: 1, index: 2 }
    ];
    const api = {
      runtime: { id: 'extension' },
      storage: { session: {
        async get(key) { return structuredClone(key ? { [key]: store[key] } : store); },
        async set(values) { Object.assign(store, structuredClone(values)); }, async remove(key) { delete store[key]; }
      } },
      tabs: { async query(query) { return tabs.filter(t => Object.entries(query).every(([k, v]) => t[k] === v)); },
        async get(id) { const tab = tabs.find(t => t.id === id); if (!tab) throw new Error('Closed'); return { ...tab }; },
        async update(id) { navigations.push(id); return this.get(id); } },
      windows: { async update() {} }, action: { async setBadgeText() {}, async setTitle() {} },
      scripting: { async executeScript(options) {
        const tabId = options.target.tabId, page = pages.get(tabId);
        if (!page || (options.target.documentIds && options.target.documentIds[0] !== `doc${tabId}`)) throw new Error('Document unavailable');
        let value;
        if (options.files) {
          for (const file of options.files) await page.evaluate(fs.readFileSync(path.join(root, file), 'utf8'));
        } else value = await page.evaluate(`(${options.func.toString()})(...${JSON.stringify(options.args || [])})`);
        // setContent uses about:blank; only tab metadata is simulated here.
        if (options.args?.[0] === 'search' && value?.ok) value.value.url = tabs.find(t => t.id === tabId).url;
        return [{ documentId: `doc${tabId}`, result: value }];
      } }
    };
    let broker = createBroker(api);
    const content = [
      '<p id="p1">Privilege applies. Waiver is disputed.</p><p id="p2">[<a id="par2">2</a>] The <em>privilege</em> was lost by <strong>waiver</strong>.</p><p hidden>Privilege waiver secret.</p><div style="display:none"><p>Privilege waiver secret.</p></div><p id="phrase">A duty <em>of care</em><br>was breached.</p><div id="component"></div>',
      '<p style="margin-top:1600px" id="destination">A waiver of privilege was established.</p><p style="height:1200px">End.</p>',
      '<p>No privilege. Waiver denied.</p>'
    ];
    for (let i = 0; i < content.length; i++) {
      const id = i + 1, page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
      pages.set(id, page); page.on('pageerror', error => errors.push(error.message));
      await page.setContent(`<html lang="en"><head><title>${tabs[i].title} — fictional fixture</title><style>body{margin:100px auto;max-width:900px;font:18px/1.7 system-ui}p{padding:16px 0}</style></head><body><button id="origin">Original focus</button><h1>${tabs[i].title}</h1>${content[i]}</body></html>`);
      await page.exposeFunction('__send', async message => {
        const sender = { id: 'extension', tab: tabs.find(t => t.id === id), frameId: 0, documentId: `doc${id}`, url: tabs.find(t => t.id === id).url };
        try { return { ok: true, ...await broker.handle(message, sender) }; }
        catch (error) { return { ok: false, message: error.message }; }
      });
      await page.evaluate(() => {
        globalThis.chrome = { runtime: { sendMessage: message => globalThis.__send(message) } };
        // Tests retain references to closed test-only roots; runtime UI stays closed.
        const attach = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(options) {
          const shadow = attach.call(this, options);
          if (this.hasAttribute('data-pinpointer-sonar')) globalThis.__sonarShadow = shadow;
          return shadow;
        };
      });
    }
    const page = pages.get(1), other = pages.get(2);
    await page.evaluate(() => document.querySelector('#component').attachShadow({ mode: 'open' }).innerHTML = '<p>Confidentiality concerns another issue.</p>');
    await broker.open(tabs[0]);
    const status = () => page.evaluate(() => __sonarShadow.querySelector('#status').textContent);
    const wait = async pattern => page.waitForFunction(text => globalThis.__sonarShadow?.querySelector('#status').textContent.includes(text), pattern);
    const query = async text => {
      await page.evaluate(text => { const input = __sonarShadow.querySelector('input'); input.value = text; input.dispatchEvent(new Event('input')); input.focus(); }, text);
    };
    await query('privileg* waiv*'); await wait('2 matching paragraphs');
    assert.equal(await page.evaluate(() => CSS.highlights.get('legal-pinpointer-sonar-hits').size), 4);
    const before = await page.locator('#p2').innerHTML();
    await page.keyboard.press('Tab'); await wait('1 matching sentences');
    assert.equal(await page.evaluate(() => __sonarShadow.querySelector('#mode').textContent), '/s');
    await page.keyboard.press('Shift+Tab'); await wait('2 matching sentences · 3/4');
    assert.equal(await page.evaluate(() => __sonarShadow.querySelector('#scope').textContent), 'All tabs');
    assert.match(await status(), /1 skipped/);
    const beforeY = await other.evaluate(() => scrollY);
    assert.equal(navigations.length, 0);
    await page.keyboard.down('Alt'); await page.mouse.wheel(0, 140); await page.waitForTimeout(160);
    assert.equal(navigations.length, 0, 'Wheel previews without activating another tab');
    await page.keyboard.up('Alt');
    await other.waitForFunction(() => CSS.highlights.has('legal-pinpointer-sonar-active'));
    while (!navigations.length) await page.waitForTimeout(20);
    assert.equal(navigations.at(-1), 2);
    assert.ok(await other.evaluate(() => scrollY) > beforeY);
    broker = createBroker(api); // Worker restart: issued handles survive in RAM session storage.
    await other.evaluate(() => __sonarShadow.querySelector('button').click());
    await other.waitForFunction(() => !CSS.highlights.has('legal-pinpointer-sonar-active'));
    assert.equal(await other.evaluate(() => scrollY), beforeY);
    assert.equal(navigations.at(-1), 1);
    await page.keyboard.press('Shift+Tab'); await wait('2 matching sentences · 2/2');
    assert.equal(await page.evaluate(() => __sonarShadow.querySelector('#scope').textContent), 'Current tab group');
    await page.keyboard.press('Shift+Tab'); await wait('1 matching sentences · 1/1');
    await query('privileg* /p waiv*'); await wait('2 matching paragraphs');
    await page.keyboard.press('Tab'); await wait('1 matching sentences');
    assert.equal(await page.evaluate(() => __sonarShadow.querySelector('input').value), 'privileg* /s waiv*');
    await query('"duty of care" breach*'); await wait('1 matching sentences');
    assert.equal(await page.evaluate(() => [...CSS.highlights.get('legal-pinpointer-sonar-active')][0].toString()), 'duty of care');
    await query('privileg* /p waiv*'); await wait('2 matching paragraphs');
    await page.evaluate(() => { const p = document.createElement('p'); p.textContent = 'Privilege and waiver in added text.'; document.body.append(p); });
    await wait('3 matching paragraphs');
    await query('"unterminated'); await wait('Close the quotation');
    assert.equal(await page.evaluate(() => CSS.highlights.has('legal-pinpointer-sonar-hits')), false);
    await query('confidentiality'); await wait('1 matching paragraphs');
    assert.equal(await page.evaluate(() => [...CSS.highlights.get('legal-pinpointer-sonar-active')][0].toString()), 'Confidentiality');
    await query('privileg* waiv*'); await wait('3 matching paragraphs');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => __sonarShadow.querySelector('footer span').textContent), '2 / 3');
    await page.keyboard.press('Shift+Enter');
    assert.equal(await page.locator('#p2').innerHTML(), before, 'Search never rewrites source HTML');
    if (process.env.SONAR_SCREENSHOT) await page.screenshot({ path: process.env.SONAR_SCREENSHOT });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-pinpointer-sonar]').count(), 0);
    await page.waitForTimeout(150);
    assert.equal(Object.keys(store).length, 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('warm indexes and paint are reused; cancellation, mutation and pathological units remain safe', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<html lang="en"><body><p id="first">Privilege and waiver. Another privilege and waiver.</p><p>Privilege waiver.</p></body></html>');
    for (const file of ['find-core.js', 'find-page.js']) await page.evaluate(fs.readFileSync(path.join(root, file), 'utf8'));
    const results = await page.evaluate(async () => {
      const page = LegalPinpointerSearchPage, style = getComputedStyle;
      let reads = 0;
      window.getComputedStyle = (...args) => { reads++; return style(...args); };
      const request = (ticket, mode = 'p', query = 'privileg* waiv*') => ({ ticket, mode, query });
      await page.search(request('cold'));
      page.release('cold', true);
      const baseline = reads;
      await page.search(request('warm', 's'));
      const warmReads = reads - baseline;
      page.preview('warm', 0);
      const highlight = CSS.highlights.get('legal-pinpointer-sonar-hits'), sheet = document.adoptedStyleSheets.at(-1);
      page.preview('warm', 1);
      const reused = highlight === CSS.highlights.get('legal-pinpointer-sonar-hits') && sheet === document.adoptedStyleSheets.at(-1);
      document.querySelector('#first').firstChild.nodeValue = 'Changed text.';
      let staleRejected = false;
      try { page.preview('warm', 0); } catch (_) { staleRejected = true; }
      const big = document.createElement('p');
      big.textContent = 'needle ' + 'word '.repeat(14000) + 'forbidden';
      document.body.append(big);
      const safe = await page.search(request('oversized', 'p', 'needle NOT forbidden'));
      page.releaseAll();
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < 3000; i++) { const p = document.createElement('p'); p.textContent = 'Privilege and waiver.'; fragment.append(p); }
      document.body.append(fragment);
      const cancelled = page.search(request('cancelled'));
      page.release('cancelled');
      let cancelledRejected = false;
      try { await cancelled; } catch (_) { cancelledRejected = true; }
      let resurrected = false;
      try { page.preview('cancelled', 0); resurrected = true; } catch (_) { /* Expected. */ }
      const next = await page.search(request('reopened'));
      // Search highlights can be capped; match existence is never inferred from a
      // truncated paragraph, which would make NOT/AND proximity misleading.
      page.releaseAll();
      return { warmReads, reused, staleRejected, partial: safe.limited, falseMatches: safe.results.length,
        cancelledRejected, resurrected, reopened: next.results.length };
    });
    assert.deepEqual(results, { warmReads: 0, reused: true, staleRejected: true, partial: true,
      falseMatches: 0, cancelledRejected: true, resurrected: false, reopened: 200 });
  } finally { await browser.close(); }
});
