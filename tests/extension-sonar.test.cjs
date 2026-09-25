'use strict';

// Installed-extension gate: the unpacked extension in real Chromium, the real
// side panel opened by a real click, real tabs, real clipboard. Nothing is
// simulated. Needs Playwright: npm install --no-save --package-lock=false playwright
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
    const openPanel = async () => {
      const opener = await context.newPage(); await opener.goto(`chrome-extension://${id}/popup.html`);
      await opener.evaluate(() => document.addEventListener('click', () => chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }), { capture: true }));
      await tabs[0].bringToFront(); await opener.mouse.click(2, 2); await opener.close(); await tabs[0].bringToFront();
      await cdp?.close().catch(() => {}); cdp = await chromium.connectOverCDP(`http://127.0.0.1:${debug}`);
      let found;
      for (let i = 0; i < 50 && !found; i++, await new Promise(r => setTimeout(r, 100))) {
        found = cdp.contexts().flatMap(c => c.pages()).find(p => p.url().endsWith('/sonar.html') && !p.isClosed());
      }
      assert.ok(found, 'the native side panel opened');
      return found;
    };
    let panel = await openPanel();
    const errors = []; panel.on('pageerror', error => errors.push(error.message));
    // Rows are the only search feedback: wait for the search to settle, then read them.
    const search = async text => {
      await panel.fill('#query', text);
      await panel.waitForFunction(() => document.querySelector('#list-viewport').getAttribute('aria-busy') === 'false' &&
        (document.querySelector('#result-rows [data-result]') || document.querySelector('#notice.error') || !document.querySelector('#empty').hidden), null, { timeout: 20_000 });
      return rows();
    };
    const rows = () => panel.evaluate(() => [...document.querySelectorAll('#result-rows [data-result]')].map(row => ({ at: row.dataset.result,
      title: row.querySelector('.result-title').textContent, text: row.querySelector('.result-text').textContent.replace(/^…|…$/g, '') })));
    const row = at => panel.locator(`#result-rows [data-result="${at}"]`);
    const clipboard = () => panel.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      return { plain: await (await item.getType('text/plain')).text(), html: await (await item.getType('text/html')).text() };
    });
    // Pinpointer's own hotkeys on a passage selected in the list.
    const copy = async (at, keys) => {
      await panel.evaluate(() => { document.querySelector('#notice').textContent = ''; });
      await row(at).locator('.result-text').click();
      await panel.keyboard.press(keys);
      await panel.waitForFunction(() => /^Copied/.test(document.querySelector('#notice').textContent));
      return clipboard();
    };
    // Headless tabs all report visible: the active tab and the passage highlight show a jump.
    const active = () => worker.evaluate(async () => (await chrome.tabs.query({ active: true })).map(tab => tab.url));
    const jumped = async tab => {
      await tab.waitForFunction(() => CSS.highlights.has('legal-pinpointer-sonar-active'));
      for (let i = 0; i < 50 && !(await active()).includes(tab.url()); i++) await new Promise(r => setTimeout(r, 100));
      assert.ok((await active()).includes(tab.url()), `${tab.url()} is the active tab`);
    };
    const unmoved = async (tab, label) => {
      await panel.waitForTimeout(300);
      assert.ok(!(await active()).includes(tab.url()), label);
      assert.equal(await tab.evaluate(() => CSS.highlights.has('legal-pinpointer-sonar-active')), false, label);
    };
    // A result's own copy buttons.
    const copyButton = async (at, label) => {
      await panel.evaluate(() => { document.querySelector('#notice').textContent = ''; });
      await row(at).getByRole('button', { name: label, exact: true }).click();
      await panel.waitForFunction(() => /^Copied/.test(document.querySelector('#notice').textContent));
      return clipboard();
    };
    const opened = async (tab, at) => {
      await tab.evaluate(() => CSS.highlights.delete('legal-pinpointer-sonar-active'));
      await row(at).locator('.result-open').click();
      await jumped(tab);
    };
    const shot = name => process.env.SONAR_SHOTS && panel.screenshot({ path: path.join(process.env.SONAR_SHOTS, `${name}.png`) });

    // All tabs by default; This tab narrows to the origin. /p is written, not toggled.
    assert.equal(await panel.locator('#scope [aria-pressed=true]').textContent(), 'All tabs');
    let found = await search('waiv* /p privilege');
    assert.equal(found.length, 5);
    await panel.waitForFunction(() => document.querySelector('#origin').textContent === 'From Alpha v Beta, 2024 SCC 1');
    await panel.getByRole('button', { name: 'This tab', exact: true }).click();
    found = await search('waiv* /p privilege');
    assert.equal(found.length, 2, 'this tab: headnote and para 2');
    // CanLII grammar: /s, NOT (page-level) and EXACT( ).
    assert.equal((await search('waiver /s trial')).length, 1);
    assert.equal((await search('waiver /s nowhere')).length, 0);
    assert.equal((await search('privilege NOT waiver')).length, 0, 'NOT excludes the whole page');
    await panel.getByRole('button', { name: 'All tabs', exact: true }).click();
    found = await search('waiv* /p privilege');
    assert.equal(found.length, 5);
    // Titles are the citations Pinpointer copies, each with its page's icon.
    assert.ok(found.every(item => !/CanLII\)|\| CanLII/.test(item.title)), found.map(item => item.title).join(' / '));
    await panel.waitForFunction(() => [...document.querySelectorAll('.result-icon')].every(icon => icon.complete && icon.naturalWidth > 0));
    await shot('all-tabs');

    // Selecting a result opens nothing; its Open button jumps to the exact passage.
    const other = found.findIndex(item => item.text.includes('requires an intention'));
    await row(other).locator('.result-text').click();
    assert.equal(await row(other).getAttribute('aria-selected'), 'true');
    await unmoved(tabs[1], 'clicking a result does not open it');
    await opened(tabs[1], other);

    // Hotkeys copy in Pinpointer's own formats with native paragraph links.
    let copied = await copy(other, 'Control+x');
    assert.equal(copied.plain, 'at para 1');
    assert.match(copied.html, /href="https:\/\/www\.canlii\.org\/en\/ca\/scc\/doc\/2024\/2024scc2\/2024scc2\.html#par1"/);
    copied = await copy(other, 'Control+Shift+x');
    assert.match(copied.plain, /^\[1\] Waiver of privilege requires an intention to waive\.$/);
    copied = await copy(other, 'Alt+x');
    assert.equal(copied.plain, found[other].title, 'the title is the citation Alt+X copies');
    // The same three copies from the result's buttons, plus its passage link.
    copied = await copyButton(other, 'Copy pinpoint');
    assert.equal(copied.plain, 'at para 1');
    copied = await copyButton(other, 'Copy quote');
    assert.match(copied.plain, /^\[1\] Waiver of privilege requires an intention to waive\.$/);
    assert.doesNotMatch(copied.html, /<br|<p/i, 'a one-paragraph quote pastes with no line break');
    copied = await copyButton(other, 'Copy link');
    assert.match(copied.plain, /2024scc2\.html#:~:text=/);

    // A page without legal structure copies the passage with a text-fragment link.
    copied = await copy(found.findIndex(item => item.title === 'Plain notes'), 'Control+Shift+x');
    assert.equal(copied.plain, '[Link]: Implied waiver of privilege may arise from fairness.');
    assert.match(copied.html, /notes#:~:text=/);

    // Tab moves from the search box to the results; Shift+Tab goes back.
    await panel.focus('#query'); await panel.keyboard.press('Tab');
    await panel.waitForFunction(() => document.activeElement.id === 'list-viewport' && document.querySelector('[data-result][aria-selected=true]'));
    await panel.keyboard.press('Shift+Tab');
    assert.equal(await panel.evaluate(() => document.activeElement.id), 'query');
    assert.equal(await panel.locator('#scope [aria-pressed=true]').textContent(), 'All tabs', 'Tab never changes the scope');

    // ? shows the operators on hover and keeps them once clicked; Escape then closes only them.
    const operators = () => panel.evaluate(() => document.querySelector('#operators').matches(':popover-open'));
    await panel.hover('#help'); await panel.waitForFunction(() => document.querySelector('#operators').matches(':popover-open'));
    await shot('operators');
    await panel.mouse.move(5, (await panel.evaluate(() => innerHeight)) - 4); await panel.waitForTimeout(100);
    assert.equal(await operators(), false, 'leaving ? hides the operators');
    await panel.click('#help'); await panel.mouse.move(5, (await panel.evaluate(() => innerHeight)) - 4); await panel.waitForTimeout(100);
    assert.equal(await operators(), true, 'a click keeps them open');
    await panel.keyboard.press('Escape');
    assert.equal(await operators(), false); assert.equal(panel.isClosed(), false);

    // Current tab group scope.
    await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.canlii.org/*' });
      await chrome.tabs.group({ tabIds: tabs.map(tab => tab.id) });
    });
    await tabs[0].bringToFront();
    await panel.click('#use-active');
    await panel.getByRole('button', { name: 'This group', exact: true }).click();
    found = await search('waiv* /p privilege');
    assert.equal(found.length, 4, 'headnote and one paragraph in each grouped judgment');

    // Plain words rank by relevance across the group; jump and copy use the same handles.
    assert.equal(await panel.evaluate(() => crossOriginIsolated), true, 'the panel is cross-origin isolated for threaded WASM');
    found = await search('intention to waive privilege');
    assert.match(found[0].text, /requires an intention to waive/);
    if (fs.existsSync(path.join(root, 'vendor/rerank/model-cpu.onnx'))) {
      await panel.waitForFunction(() => document.body.dataset.order === 'reranked', null, { timeout: 60_000 });
      assert.match((await rows())[0].text, /requires an intention to waive/);
    }
    // Enter in the search box puts keyboard focus on the first result without opening it;
    // Enter there opens it.
    await tabs[0].bringToFront();
    await tabs[1].evaluate(() => CSS.highlights.delete('legal-pinpointer-sonar-active'));
    await panel.focus('#query'); await panel.keyboard.press('Enter');
    await panel.waitForFunction(() => document.activeElement.id === 'list-viewport' && document.querySelector('[data-result="0"]').getAttribute('aria-selected') === 'true');
    await unmoved(tabs[1], 'Enter in the search box does not open a result');
    await panel.keyboard.press('Enter');
    await jumped(tabs[1]);
    copied = await copy(0, 'Control+x');
    assert.equal(copied.plain, 'at para 1');
    assert.match(copied.html, /2024scc2\.html#par1"/);
    await shot('ranked');
    // Every row of the ranked (possibly reordered) list opens and copies its own passage.
    const ranked = await rows();
    assert.ok(ranked.length >= 3);
    for (const item of ranked) {
      await opened(item.title.startsWith('Alpha') ? tabs[0] : tabs[1], item.at);
      copied = await copy(item.at, 'Control+Shift+x');
      assert.ok(copied.plain.includes(item.text), `row ${item.at} copies its own passage: ${copied.plain}`);
      assert.match(copied.html, item.title.startsWith('Alpha') ? /2024scc1\.html/ : /2024scc2\.html/, `row ${item.at} links its own judgment`);
    }

    // The CanLII route is the search box (and ?) alone; Enter opens CanLII and closes the panel.
    await panel.click('#canlii-route');
    for (const id of ['scope-row', 'origin', 'list-viewport']) assert.equal(await panel.locator(`#${id}`).isVisible(), false, `${id} is hidden on the CanLII route`);
    await shot('canlii');
    assert.deepEqual(errors, []);
    await panel.fill('#query', 'levy /p probate'); await panel.keyboard.press('Enter');
    await panel.waitForEvent('close', { timeout: 10_000 });
    assert.ok((await active()).some(url => url.startsWith('https://www.canlii.org/en/#search/text=levy')), 'CanLII search opened');
    // Escape closes the panel.
    panel = await openPanel();
    await panel.focus('#query'); await panel.keyboard.press('Escape');
    await panel.waitForEvent('close', { timeout: 10_000 });
  } finally {
    await cdp?.close().catch(() => {});
    await context.close(); server.close();
  }
});
