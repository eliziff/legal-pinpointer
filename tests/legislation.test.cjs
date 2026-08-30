'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const legislation = require('../canlii-legislation.js');

const snapshot = fs.readFileSync(path.resolve(__dirname, '..', 'canlii-legislation.tsv'), 'utf8');

test('the packaged snapshot resolves exact CanLII legislation identities and refuses mismatches', () => {
  const index = legislation.parseIndex(snapshot);
  assert.ok(index.byId.size > 80_000, `Packaged index is unexpectedly small: ${index.byId.size}`);
  assert.equal(
    legislation.resolve(index, 'Adult Guardianship and Trusteeship Act', 'SA 2008, c. A-4.2, s. 1', 'en'),
    'https://www.canlii.org/en/ab/laws/stat/sa-2008-c-a-4.2/latest/sa-2008-c-a-4.2.html'
  );
  assert.equal(
    legislation.resolve(index, 'Adult Guardianship (Abuse and Neglect) Regulation', 'B.C. Reg. 13/2000, s. 1', 'en'),
    'https://www.canlii.org/en/bc/laws/regu/bc-reg-13-2000/latest/bc-reg-13-2000.html'
  );
  assert.equal(legislation.resolve(index, 'Entirely Different Act', 'SA 2008, c. A-4.2', 'en'), '');
});

test('the actual extension worker resolves packaged legislation only for supported senders', async () => {
  let listener;
  let context;
  context = vm.createContext({
    URL,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    WebAssembly,
    importScripts(filename) {
      assert.equal(filename, 'canlii-legislation.js');
      context.LegalPinpointerCanliiLegislation = legislation;
    },
    async fetch(url) {
      assert.equal(url, 'chrome-extension://test/canlii-legislation.tsv');
      return { ok: true, async text() { return snapshot; } };
    },
    chrome: {
      runtime: {
        id: 'test-extension',
        getURL(filename) { return `chrome-extension://test/${filename}`; },
        onMessage: { addListener(value) { listener = value; } }
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..', 'engine-worker.js'), 'utf8'), context);

  const message = {
    type: 'LEGAL_PINPOINTER_RESOLVE_LEGISLATION',
    input: {
      title: 'Adult Guardianship (Abuse and Neglect) Regulation',
      citation: 'B.C. Reg. 13/2000, s. 1',
      language: 'en'
    }
  };
  const sender = { id: 'test-extension', tab: { id: 1 }, url: 'https://advance.lexis.com/document/?pddocfullpath=legislation-ca' };
  const response = await new Promise((resolve) => assert.equal(listener(message, sender, resolve), true));
  assert.equal(response.ok, true);
  assert.equal(response.url, 'https://www.canlii.org/en/bc/laws/regu/bc-reg-13-2000/latest/bc-reg-13-2000.html');

  let rejected;
  assert.equal(listener(message, { id: 'test-extension', tab: { id: 2 }, url: 'https://example.com/document/' }, (value) => { rejected = value; }), false);
  assert.equal(rejected.ok, false);
});
