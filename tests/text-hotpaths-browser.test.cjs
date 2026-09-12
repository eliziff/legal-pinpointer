'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = fs.readFileSync(path.resolve(__dirname, '../text-fragments.js'), 'utf8');

test('bulk mapping is boundary-equivalent to the legacy mapper across mixed DOM and whitespace', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<main id="source"></main>');
    // These mapping functions do not use citation or extension APIs.
    await page.evaluate(() => { globalThis.LegalPinpointerCore = {}; });
    await page.evaluate(source);
    const result = await page.evaluate(() => {
      const api = LegalPinpointerTextFragments, root = document.querySelector('#source');
      const words = ['ordinary single spaces', ' two words ', ' ', 'two  spaces', '\n\t', '\u00a0', '😀 astral 𐐀', 'e\u0301 ÉTÉ', 'line\nbreak', '\ud800'];
      let seed = 7367, compared = 0;
      const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 12) % n; };
      for (let trial = 0; trial < 160; trial++) {
        root.replaceChildren();
        for (let i = 0; i < 14; i++) {
          const parent = document.createElement(['p', 'div', 'li', 'blockquote'][random(4)]);
          parent.append(document.createTextNode(words[random(words.length)]));
          const inline = document.createElement(['em', 'strong', 'span'][random(3)]);
          inline.textContent = words[random(words.length)]; parent.append(inline);
          if (random(3) === 0) parent.append(document.createElement('br'));
          parent.append(document.createTextNode(words[random(words.length)]));
          if (random(9) === 0) parent.hidden = true;
          root.append(parent);
        }
        const before = root.innerHTML;
        for (const method of ['buildTextIndex', 'buildStructureIndex']) {
          const legacy = api[method](root), fast = api[method](root, true);
          if (legacy.text !== fast.text) throw new Error(`Text changed: ${trial} ${method}`);
          for (let offset = 0; offset <= fast.text.length; offset++) {
            const a = api.boundaryPoint(legacy, offset), b = api.boundaryPoint(fast, offset);
            if (a?.node !== b?.node || a?.offset !== b?.offset) throw new Error(`Boundary ${offset}: ${trial} ${method}`);
            compared++;
          }
          if (method === 'buildStructureIndex' && api[method](root, 'text').text !== fast.text) throw new Error('Text-only changed');
        }
        if (root.innerHTML !== before) throw new Error('Source was rewritten');
      }
      root.innerHTML = '<p>before <em>first</em> end skip first <strong>end</strong> after final</p>';
      const selected = document.createRange(); selected.selectNodeContents(root.querySelector('em'));
      getSelection().removeAllRanges(); getSelection().addRange(selected);
      const original = root.querySelector('em').firstChild;
      const resolved = api.resolveUrl('https://example.test/#:~:text=first,end,-after', root);
      if (resolved.range.startContainer !== original || getSelection().toString() !== 'first') throw new Error('Selection or original node changed');
      return { compared, text: resolved.text };
    });
    assert.ok(result.compared > 80_000);
    assert.equal(result.text, 'first end skip first end ');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
