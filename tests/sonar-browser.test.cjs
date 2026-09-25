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
const root = path.resolve(__dirname, '..');

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
      await page.preview('warm', 0);
      const highlight = CSS.highlights.get('legal-pinpointer-sonar-hits'), sheet = document.adoptedStyleSheets.at(-1);
      await page.preview('warm', 1);
      const reused = highlight === CSS.highlights.get('legal-pinpointer-sonar-hits') && sheet === document.adoptedStyleSheets.at(-1);
      document.querySelector('#first').firstChild.nodeValue = 'Changed text.';
      let staleRejected = false;
      try { await page.preview('warm', 0); } catch (_) { staleRejected = true; }
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
      try { await page.preview('cancelled', 0); resurrected = true; } catch (_) { /* Expected. */ }
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
