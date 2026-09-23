'use strict';

// Installed-extension gate: the unpacked extension in real Chromium, the real
// side panel opened by a real click, real tabs, real clipboard. Nothing is
// simulated. Needs Playwright: npm install --no-save --package-lock=false playwright
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');

const judgment = (name, cite, paragraphs) => `<!doctype html><html lang="en"><head><title>${name}, ${cite} (CanLII) | CanLII</title>
<meta name="lbh-title" content="${name}, ${cite} (CanLII)"></head><body><main id="originalDocument"><h1>${name}</h1>
<p>Headnote: the appellant raised waiver of privilege at trial.</p>
${paragraphs.map((text, i) => `<p><a name="par${i + 1}"></a>[${i + 1}] ${text}</p>`).join('\n')}
<div style="height:4000px"></div><p><a name="par${paragraphs.length + 1}"></a>[${paragraphs.length + 1}] Litigation privilege ends with the litigation.</p></main></body></html>`;
const pages = {
  'https://www.canlii.org/en/ca/scc/doc/2024/2024scc1/2024scc1.html': judgment('Alpha v Beta', '2024 SCC 1',
    ['The facts are not disputed.', 'Solicitor-client privilege was waived by disclosure to the insurer.', 'Costs follow the event.']),
  'https://www.canlii.org/en/ca/scc/doc/2024/2024scc2/2024scc2.html': judgment('Gamma v Delta', '2024 SCC 2',
    ['Waiver of privilege requires an intention to waive.', 'The appeal is dismissed.'])
};

test('Tab Sonar searches, opens and copies passages in the installed extension', { timeout: 120_000 }, async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<title>Plain notes</title><p>Intro.</p><p>Implied waiver of privilege may arise from fairness.</p><p>End.</p>');
  }).listen(0);
  const port = server.address().port, debug = 9500 + Math.floor(Math.random() * 400);
  const context = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, `--remote-debugging-port=${debug}`] });
  let cdp;
  try {
    await context.route('https://www.canlii.org/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: pages[route.request().url()] || '' }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host, tabs = [];
    for (const url of [...Object.keys(pages), `http://127.0.0.1:${port}/notes`]) { const tab = await context.newPage(); await tab.goto(url); tabs.push(tab); }
    for (const blank of context.pages().filter(page => page.url() === 'about:blank')) await blank.close();
    // A real click is the user gesture sidePanel.open requires.
    const opener = await context.newPage(); await opener.goto(`chrome-extension://${id}/popup.html`);
    await opener.evaluate(() => document.addEventListener('click', () => chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }), { capture: true }));
    await tabs[0].bringToFront(); await opener.mouse.click(2, 2); await opener.close(); await tabs[0].bringToFront();
    cdp = await chromium.connectOverCDP(`http://127.0.0.1:${debug}`);
    let panel;
    for (let i = 0; i < 50 && !panel; i++, await new Promise(r => setTimeout(r, 100))) {
      panel = cdp.contexts().flatMap(c => c.pages()).find(p => p.url().endsWith('/sonar.html'));
    }
    assert.ok(panel, 'the native side panel opened');
    const errors = []; panel.on('pageerror', error => errors.push(error.message));
    const search = async text => {
      await panel.fill('#query', text);
      await panel.waitForFunction(() => /matching|could not/i.test(document.querySelector('#summary').textContent), null, { timeout: 20_000 });
      return panel.evaluate(() => ({ summary: document.querySelector('#summary').textContent, detail: document.querySelector('#detail').textContent,
        rows: [...document.querySelectorAll('#result-rows > *')].map(row => row.textContent) }));
    };
    const clipboard = () => panel.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      return { plain: await (await item.getType('text/plain')).text(), html: await (await item.getType('text/html')).text() };
    });

    let found = await search('waiv* privilege');
    assert.match(found.summary, /^2 matching/, 'current tab: headnote and para 2');
    await panel.click('#scope');
    found = await search('waiv* privilege');
    assert.match(found.detail, /^3\/3 tabs searched/);
    assert.equal(found.rows.length, 5);

    // Jump to a passage in another tab: the tab activates and the passage is highlighted.
    const other = found.rows.findIndex(row => row.includes('requires an intention'));
    await panel.locator('#result-rows > *').nth(other).click({ position: { x: 4, y: 4 } });
    await panel.waitForFunction(() => /Opened the exact passage/.test(document.querySelector('#notice').textContent));
    assert.equal(await tabs[1].evaluate(() => document.visibilityState), 'visible');
    assert.ok(await tabs[1].evaluate(() => CSS.highlights.has('legal-pinpointer-sonar-active')));

    // Copy uses Pinpointer's own formats and native paragraph links.
    await panel.click('#copy-pinpoint'); await panel.waitForFunction(() => /^Copied/.test(document.querySelector('#notice').textContent));
    let copied = await clipboard();
    assert.equal(copied.plain, 'at para 1');
    assert.match(copied.html, /href="https:\/\/www\.canlii\.org\/en\/ca\/scc\/doc\/2024\/2024scc2\/2024scc2\.html#par1"/);
    await panel.click('#copy-quote'); await panel.waitForFunction(() => /^Copied: \[1\]/.test(document.querySelector('#notice').textContent));
    copied = await clipboard();
    assert.match(copied.plain, /^\[1\] Waiver of privilege requires an intention to waive\.$/);
    await panel.click('#copy-link'); await panel.waitForFunction(() => /^Copied: https/.test(document.querySelector('#notice').textContent));
    copied = await clipboard();
    assert.match(copied.plain, /2024scc2\.html#:~:text=/);

    // A page without legal structure copies the passage with a text-fragment link.
    const plain = found.rows.findIndex(row => row.includes('Plain notes'));
    await panel.locator('#result-rows > *').nth(plain).click({ position: { x: 4, y: 4 } });
    await panel.waitForFunction(() => /Opened the exact passage/.test(document.querySelector('#notice').textContent));
    await panel.click('#copy-quote'); await panel.waitForFunction(() => /^Copied: \[Link\]/.test(document.querySelector('#notice').textContent));
    copied = await clipboard();
    assert.equal(copied.plain, '[Link]: Implied waiver of privilege may arise from fairness.');
    assert.match(copied.html, /notes#:~:text=/);

    // Current tab group scope.
    await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.canlii.org/*' });
      await chrome.tabs.group({ tabIds: tabs.map(tab => tab.id) });
    });
    await tabs[0].bringToFront();
    await panel.click('#use-active');
    await panel.click('#scope');
    found = await search('waiv* privilege');
    assert.match(found.detail, /^2\/2 tabs searched/);
    assert.deepEqual(errors, []);
  } finally {
    await cdp?.close().catch(() => {});
    await context.close(); server.close();
  }
});
