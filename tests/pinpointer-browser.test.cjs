'use strict';
// Real DOM/provider/copy paths, with deterministic provider HTML and a stubbed
// engine message boundary. This is not a live provider or native WASM test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
async function withPage(run) {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage();
    // Managed Chromium may disallow navigation even to intercepted fixture URLs.
    await page.setContent('<html lang="en"><head><title>Test v Test, 2024 SCC 1 | CanLII</title></head><body><main id="originalDocument"></main></body></html>');
    await page.evaluate(() => {
      // Only these route identities are exercised here; production tables stay unchanged.
      globalThis.LegalPinpointerCanliiCourts = { routes: { SCC: 'ca/scc', ABQB: 'ab/abqb' }, frenchRoutes: {} };
      globalThis.engineCalls = 0;
      globalThis.ClipboardItem = class { constructor(types) { this.types = types; } async getType(name) { return this.types[name]; } };
      globalThis.chrome = { runtime: { id: 'test', lastError: null,
        sendMessage(message, callback) {
          if (message.type === 'LEGAL_PINPOINTER_DERIVE_STRUCTURE') {
            engineCalls++;
            callback({ ok: true, offset_unit: 'utf16', nodes: [] });
          } else callback({ ok: true, url: '' });
        }, onMessage: { addListener(listener) { globalThis.listener = listener; } } },
        storage: { local: { get(defaults, callback) { callback(defaults); } } } };
    });
    for (const name of ['core.js', 'text-fragments.js', 'providers.js']) await page.addScriptTag({ content: source(name) });
    await page.evaluate(() => {
      const inspect = LegalPinpointerProviders.inspect;
      const testLocation = new URL('https://www.canlii.org/en/ca/scc/doc/2024/2024scc1/2024scc1.html');
      LegalPinpointerProviders.inspect = (doc, location, ...args) => inspect(doc, location.hostname ? location : testLocation, ...args);
    });
    await run(page);
  } finally { await browser.close(); }
}

test('compact maps preserve every boundary and Unicode offset of the original mapper', async () => withPage(async page => {
  const result = await page.evaluate(() => {
    const root = document.querySelector('main');
    root.innerHTML = '<p>  😀 A\tB <em>İ Σ ﬃ C</em><br>D &amp; E.</p><div><p hidden>hidden</p><p>F <span>  G  </span>H\nI\u00a0J.</p></div>';
    for (let i = 0; i < 100; i++) {
      const p = document.createElement('p');
      p.innerHTML = ` [${i}] Alpha <b>β😀\t\nhello</b> world.<br><br>Tail <span hidden>skip</span>`;
      root.append(p);
    }
    const f = LegalPinpointerTextFragments;
    let checks = 0;
    for (const fn of ['buildTextIndex', 'buildStructureIndex']) {
      const old = f[fn](root), fast = f[fn](root, true);
      if (old.text !== fast.text) throw new Error(`${fn}: normalized text differs`);
      for (let at = 0; at <= old.text.length; at++) {
        const a = f.boundaryPoint(old, at), b = f.boundaryPoint(fast, at);
        if (a?.node !== b?.node || a?.offset !== b?.offset) throw new Error(`${fn}: boundary ${at} differs`);
        checks++;
      }
      if (fast.runs.length >= old.points.length) throw new Error('Compact map did not reduce mapping records');
    }
    const textOnly = f.buildStructureIndex(root, 'text');
    if (textOnly.runs.length || textOnly.text !== f.buildStructureIndex(root).text) throw new Error('Text-only evidence changed');
    // The sparse engine-offset bridge must agree for UTF-16 and Unicode scalar inputs.
    const plane = f.buildStructureIndex(root, true); plane.root = root;
    const start = plane.text.indexOf('Alpha'), end = start + 'Alpha β😀'.length;
    const base = { provider: 'canlii', documentType: 'case', nativeNodes: [], citation: { title: 'Test' } };
    const make = unit => LegalPinpointerProviders.engineStructure(base, plane, { offset_unit: unit, nodes: [{ kind: 'paragraph', label: 'par1',
      range: { start: unit === 'utf16' ? start : [...plane.text.slice(0,start)].length, end: unit === 'utf16' ? end : [...plane.text.slice(0,end)].length } }] }).nodes[0];
    const a = make('utf16'), b = make('unicode_scalar');
    if (a.startPoint.node !== b.startPoint.node || a.startPoint.offset !== b.startPoint.offset || a.endPoint.offset !== b.endPoint.offset) throw new Error('Sparse Unicode offsets differ');
    // Reporter page nodes may start at the literal marker, not after it.
    const pagesRoot = document.createElement('div');
    pagesRoot.innerHTML = '<p>[page 11] Alpha.</p><p>[page 12] Beta.</p><p>[page 13] Gamma.</p>';
    root.append(pagesRoot);
    const pagesPlane = f.buildStructureIndex(pagesRoot, true); pagesPlane.root = pagesRoot;
    const pageStarts = [11, 12, 13].map(n => pagesPlane.text.indexOf(`[page ${n}]`));
    const pageNodes = pageStarts.map((start, i) => ({ kind: 'page', label: `page${11+i}`,
      range: { start, end: pageStarts[i+1] ?? pagesPlane.text.length } }));
    const structure = LegalPinpointerProviders.engineStructure(base, pagesPlane, { offset_unit: 'utf16', nodes: pageNodes });
    if (structure.kind !== 'page' || structure.nodes.map(n => n.locator).join(',') !== '11,12,13') throw new Error('Literal reporter-page markers were lost');
    const sourceStart = f.boundaryPoint(pagesPlane, 0);
    if (structure.nodes[0].startPoint.node !== sourceStart.node || structure.nodes[0].startPoint.offset !== sourceStart.offset) throw new Error('Page boundary shifted');
    return checks;
  });
  assert.ok(result > 5000);
}));

test('full names and historical citations survive provider heading variations without parsing bodies', async () => withPage(async page => {
  const cases = [
    ['https://www.canlii.org/en/ab/abqb/doc/1934/1934canlii376/1934canlii376.html',
      '<title>1934 CanLII 376 (AB QB) | MacMillan v. Brownlee | CanLII</title><meta name="lbh-title" content="1934 CanLII 376 (AB QB)"><main id="originalDocument"><h1>MacMillan v. Brownlee</h1><p>No numbered paragraphs.</p></main>', 'MacMillan v Brownlee, 1934 CanLII 376 (AB QB)'],
    ['https://advance.lexis.com/document/?pddocfullpath=/shared/document/cases-ca/test',
      '<title>MacMillan v. Brownlee, 1934 CanLII 376 (AB QB) | Lexis+</title><h1 id="SS_DocumentTitle">Document</h1><main id="document"><p>A different cited case is 2024 SCC 1.</p></main>', 'MacMillan v Brownlee, 1934 CanLII 376 (AB QB)'],
    ['https://nextcanada.westlaw.com/Document/test',
      '<title>MacMillan v. Brownlee, 1934 CanLII 376 (AB QB) | Westlaw Advantage Canada</title><h1 id="co_docHeaderTitleLine">1934 CanLII 376 (AB QB)</h1><main id="co_document_0" class="crsw_caselaw"><p>Body</p></main>', 'MacMillan v Brownlee, 1934 CanLII 376 (AB QB)'],
    ['https://www.canlii.org/en/ca/laws/stat/rsc-1985-c-c-46/latest/rsc-1985-c-c-46.html',
      '<title>Criminal Code, RSC 1985, c C-46 | CanLII</title><meta name="lbh-title" content="Criminal Code, RSC 1985, c C-46"><meta name="lbh-citation" content="RSC 1985, c C-46"><h1>Section 7</h1><main id="originalDocument">Body</main>', 'Criminal Code, RSC 1985, c C-46'],
    ['https://advance.lexis.com/document/?pddocfullpath=/shared/document/legislation-ca/test',
      '<title>ADULT GUARDIANSHIP AND TRUSTEESHIP ACT, SA 2008, c. A-4.2 | Lexis+</title><h1 id="SS_DocumentTitle">SECTION 1</h1><main id="document"><h2>SECTION 1</h2>Body</main>', 'ADULT GUARDIANSHIP AND TRUSTEESHIP ACT, SA 2008, c. A-4.2'],
    ['https://nextcanada.westlaw.com/Document/statute',
      '<title>Criminal Code, RSC 1985, c C-46 | Westlaw Advantage Canada</title><h1 id="titleInfo">Legislation</h1><div id="citeInfo">RSC 1985, c C-46, s. 7</div><main id="co_document_0" class="crsw_legislation">Body</main>', 'Criminal Code, RSC 1985, c C-46']
  ];
  for (const [url, html, expected] of cases) {
    const result = await page.evaluate(async ({url, html}) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const f = LegalPinpointerTextFragments, build = f.buildStructureIndex;
      f.buildStructureIndex = () => { throw new Error('Metadata must not build a text map'); };
      try {
        const model = await LegalPinpointerProviders.inspect(doc, new URL(url), () => { throw new Error('Metadata must not parse'); }, { metadataOnly: true });
        return model.citation;
      } finally { f.buildStructureIndex = build; }
    }, { url, html });
    assert.equal(result.plain, expected, url);
  }
}));

test('structureless selections copy literal linked label and safe text; metadata cache invalidates without eager parses', async () => withPage(async page => {
  await page.evaluate(() => {
    document.querySelector('main').innerHTML = '<div id="quote">A <em>selected</em> quotation &amp; &lt;literal&gt;.<script>bad()</script><span hidden>hidden</span></div>';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      async readText() { return globalThis.clipboardInput || ''; },
      async write(items) {
        const item = items[0];
        globalThis.copied = { plain: await (await item.getType('text/plain')).text(), html: await (await item.getType('text/html')).text() };
      }
    } });
  });
  await page.addScriptTag({ content: source('content.js') });
  const result = await page.evaluate(async () => {
    const send = message => new Promise(resolve => listener({ ...message, source: 'popup' }, { id: 'test' }, resolve));
    const citation = await send({ type: 'LEGAL_PINPOINTER_COPY', mode: 'citation' });
    if (!citation.ok || engineCalls !== 0) throw new Error('Citation-only copy parsed the body');
    const q = document.querySelector('#quote'), range = document.createRange(); range.selectNodeContents(q);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    const before = q.innerHTML;
    const fallback = await send({ type: 'LEGAL_PINPOINTER_COPY', mode: 'quote' });
    if (!fallback.ok) throw new Error(fallback.message);
    const output = { ...copied }, calls = engineCalls;
    const repeat = await send({ type: 'LEGAL_PINPOINTER_COPY', mode: 'quote' });
    if (!repeat.ok || engineCalls !== calls) throw new Error('Unchanged quote reparsed');
    if (q.innerHTML !== before || getSelection().isCollapsed) throw new Error('Quote changed source DOM/selection');
    document.title = 'Other v Other, 2024 SCC 2 | CanLII';
    const updated = await send({ type: 'LEGAL_PINPOINTER_COPY', mode: 'citation' });
    if (!updated.ok || !copied.plain.includes('Other v Other, 2024 SCC 2')) throw new Error('Stale citation after metadata mutation');
    if (engineCalls !== calls) throw new Error('Metadata mutation eagerly reparsed the document');
    const original = LegalPinpointerProviders.inspect;
    document.title = 'Before v After, 2024 SCC 3 | CanLII';
    LegalPinpointerProviders.inspect = async (...args) => {
      const model = await original(...args); document.title = 'Changed mid operation'; return model;
    };
    const stale = await send({ type: 'LEGAL_PINPOINTER_COPY', mode: 'citation' });
    return { output, calls, stale };
  });
  assert.equal(result.output.plain, '[Link]: A selected quotation & <literal>.');
  assert.match(result.output.html, /^<a href="https:\/\/www\.canlii\.org\/.+">\[Link\]<\/a>: A <em>selected<\/em> quotation &amp; &lt;literal&gt;\.$/);
  assert.equal(result.calls, 1);
  assert.equal(result.stale.ok, false);
  assert.match(result.stale.message, /document changed/i);
}));

test('existing clipboard fixture preserves ranges, provision indentation, text fragments and secondary sources', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage();
    const routes = 'globalThis.LegalPinpointerCanliiCourts = {routes:{SCC:"ca/scc",ABQB:"ab/abqb"},frenchRoutes:{}};';
    const html = fs.readFileSync(path.join(__dirname, 'browser-fixture.html'), 'utf8')
      .replace(/<script src="\.\.\/([^"]+)"><\/script>/g, (_, file) => `<script>${file === 'canlii-courts.js' ? routes : source(file)}</script>`);
    await page.setContent(html);
    await page.waitForFunction(() => /^(PASS|FAIL:)/.test(document.querySelector('#result').textContent));
    assert.equal(await page.locator('#result').textContent(), 'PASS');
  } finally { await browser.close(); }
});
