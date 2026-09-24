'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../find-core.js');
const { createBroker } = require('../find-worker.js');
const { createIndex } = require('../sonar-index.js');
const { createTokenizer, looksFrench } = require('../rerank-core.js');

test('plain words rank; quotes, operators, prefixes, parentheses and /s stay exact', () => {
  for (const query of ['duty of care', 'privilege or waiver', 'not guilty', 'employer’s duty to accommodate']) assert.equal(core.ranked(query), true, query);
  for (const query of ['"duty of care"', 'privileg*', 'privilege AND waiver', 'privilege OR waiver', 'NOT implied waiver', '(privilege)', 'privilege /p waiver', '']) {
    assert.equal(core.ranked(query), false, query);
  }
  assert.equal(core.ranked('duty of care', 's'), false);
});

test('folding lowers case, drops accents and light English/French inflections', () => {
  const same = (a, b) => assert.equal(core.fold(a), core.fold(b), `${a} ~ ${b}`);
  same('Waivers', 'waiver'); same('policies', 'policy'); same('accommodated', 'accommodate'); same('accommodating', 'accommodate');
  same('Employées', 'employée'); same('employees', 'employee'); same('généraux', 'general'); same('privilège', 'privilege');
  assert.notEqual(core.fold('bus'), core.fold('bu')); assert.notEqual(core.fold('class'), core.fold('clas'));
  const { terms, marked } = core.rankTerms('The duty of the employer');
  assert.deepEqual(terms, ['the', 'duty', 'of', 'employer']);
  assert.deepEqual([...marked], ['duty', 'employer']);
});

test('words are scanned exactly like the Unicode word pattern', () => {
  const text = 'L’Employeur a renoncé — s. 7(1)(b) Charter; 中文 é̀x 𝐀bc 😀word \uD800x \uDC00y naïve café_x 12ab\uD835';
  const words = []; core.eachWord(text, (word, at) => words.push([word, at]));
  assert.deepEqual(words, [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)].map(m => [m[0], m.index]));
});

test('the panel index ranks the tabs in scope with corpus-wide BM25, incrementally', async () => {
  const index = createIndex(core);
  const page = (tabId, units, paras = units.map(() => 0)) => ({ tabId, documentId: `doc${tabId}`, windowId: 10, url: `https://site${tabId}.test/`,
    title: `Page ${tabId}`, revision: `r${tabId}`, text: units.join('\n'), paras });
  // Tab 1 is all about waiver, so waiver is common and the passage with the rare
  // term, privilege, must rank first although it says waiver only once.
  await index.put(page(1, ['Waiver waiver of rights.', 'A waiver was given.', 'Nothing here.'], [1, 0, 3]));
  await index.put(page(2, ['The privilege and waiver.', 'Costs.']));
  let found = index.search({ query: 'waiver and privilege', tabIds: [1, 2], depth: 2 });
  assert.deepEqual(found.results.map(r => [r.tabId, r.unit]), [[2, 0], [1, 0], [1, 1]]);
  assert.deepEqual([found.searched, found.limited], [2, false]);
  const top = found.results[0];
  assert.deepEqual([top.preview, top.hash, top.documentId, top.url], ['The privilege and waiver.', core.hash('The privilege and waiver.'), 'doc2', 'https://site2.test/']);
  assert.deepEqual(top.marks, [{ start: 4, end: 13 }, { start: 18, end: 24 }], 'marked words only: "and" is not highlighted');
  assert.equal(found.results[1].locator, 'para 1');
  assert.deepEqual(found.passages, [{ id: 0, key: top.hash, text: 'The privilege and waiver.' }, { id: 1, key: found.results[1].hash, text: 'Waiver waiver of rights.' }]);
  // Statistics come from the tabs in scope only.
  assert.deepEqual(index.search({ query: 'waiver and privilege', tabIds: [1] }).results.map(r => r.unit), [0, 1]);
  // Equal scores keep tab order, then document order.
  await index.put(page(3, ['Estoppel applies.'])); await index.put(page(4, ['Estoppel applies.']));
  assert.deepEqual(index.search({ query: 'estoppel', tabIds: [4, 3] }).results.map(r => r.tabId), [4, 3]);
  // The reranker reads a window around the densest query words.
  const long = `${'Background facts about the contract and the parties. '.repeat(40)}Here the insurer argued waiver of privilege by disclosure. ${'Costs follow the event in the ordinary course. '.repeat(40)}`;
  await index.put(page(5, [long]));
  const [window] = index.search({ query: 'privilege waiver disclosure', tabIds: [5], depth: 1, window: 300 }).passages;
  assert.ok(window.text.length <= 300 && window.text.includes('waiver of privilege by disclosure'), window.text);
  // Replacing or dropping one tab changes only that tab.
  await index.put(page(2, ['Costs only.'])); index.drop(1);
  assert.deepEqual(index.search({ query: 'waiver privilege', tabIds: [1, 2] }).results, []);
  assert.equal(index.meta({ tabId: 2, documentId: 'doc2b', windowId: 11, url: 'https://site2.test/#x', title: 'Moved' }), true);
  assert.equal(index.search({ query: 'costs', tabIds: [2] }).results[0].windowId, 11);
});

test('the broker reads tab text for the panel and issues ranked handles only for documents it read', async () => {
  const tabs = [1, 2, 3].map(id => ({ id, windowId: 10, groupId: -1, index: id, url: id === 3 ? 'chrome://newtab/' : `https://site${id}.test/`, title: `Page ${id}`, incognito: false, status: 'complete' }));
  const storage = {}, calls = [];
  const api = {
    runtime: { id: 'extension', getURL: p => `chrome-extension://extension/${p}` },
    storage: { session: { async get(key) { return structuredClone(key ? { [key]: storage[key] } : storage); },
      async set(values) { Object.assign(storage, structuredClone(values)); }, async remove(key) { delete storage[key]; } } },
    tabs: { async get(id) { const tab = tabs.find(t => t.id === id); if (!tab) throw new Error('No tab'); return { ...tab }; }, async query() { return tabs; },
      async update(id) { return { ...tabs.find(t => t.id === id) }; } },
    windows: { async update() {} },
    scripting: { async executeScript({ target, args, files }) {
      if (files || typeof args?.[0] !== 'string') return [{ documentId: `doc${target.tabId}`, result: true }];
      const [method, values] = args;
      calls.push([method, target.tabId, values]);
      const value = method === 'units' ? { url: `https://site${target.tabId}.test/`, title: `Page ${target.tabId}`, revision: 'r1',
        ...(values[0].known === 'r1' ? { same: true } : { text: 'Waiver of privilege.\nCosts.', paras: [1, 0] }) } : true;
      return [{ documentId: `doc${target.tabId}`, result: { ok: true, value } }];
    } }
  };
  const broker = createBroker(api), workspace = '00000000-0000-4000-8000-000000000001';
  const panel = { id: 'extension', url: 'chrome-extension://extension/sonar.html' }, ask = message => broker.handle({ workspace, incognito: false, ...message }, panel);
  const { pages } = await ask({ type: 'SONAR_UNITS', tabIds: [1, 2, 3], known: {} });
  assert.deepEqual(pages.map(p => p.text ?? p.skipped), ['Waiver of privilege.\nCosts.', 'Waiver of privilege.\nCosts.', 'Browser-restricted or unsupported page']);
  assert.deepEqual(pages[0].paras, [1, 0]);
  assert.equal(calls[0][2][0].workspace, workspace, 'the page reports its changes to this workspace');
  assert.equal((await ask({ type: 'SONAR_UNITS', tabIds: [1], known: { 1: 'r1' } })).pages[0].same, true, 'an unchanged page sends no text');
  await assert.rejects(broker.handle({ type: 'SONAR_UNITS', tabIds: [1], known: {} }, { id: 'extension', tab: tabs[0], frameId: 0, documentId: 'doc1', url: tabs[0].url }), /Invalid read request/);
  const results = [{ tabId: 2, documentId: 'doc2', unit: 0, hash: 7 }, { tabId: 2, documentId: 'doc2', unit: 1, hash: 8 }];
  await assert.rejects(ask({ type: 'SONAR_ISSUE', sequence: 1, scope: 'all', originTabId: 1, query: 'waiver', results: [{ ...results[0], documentId: 'forged' }] }), /expired/);
  const issued = await ask({ type: 'SONAR_ISSUE', sequence: 2, scope: 'all', originTabId: 1, query: 'waiver privilege', results });
  await ask({ type: 'SONAR_GO', session: issued.session, ticket: issued.ticket, id: 1 });
  assert.deepEqual(calls.at(-1), ['preview', 2, [issued.ticket, { query: 'waiver privilege', unit: 1, hash: 8, others: [{ unit: 0, hash: 7 }] }, true]]);
  assert.equal((await ask({ type: 'SONAR_ISSUE', sequence: 1, scope: 'all', originTabId: 1, query: 'old', results })).stale, true);
  // Close releases every document the panel read.
  await ask({ type: 'SONAR_CLOSE', sequence: 3 });
  assert.deepEqual(calls.filter(([method]) => method === 'release').map(([, tabId]) => tabId).sort(), [1, 2]);
  assert.equal(Object.keys(storage).some(key => key.includes('units:')), false);
});

test('WordPiece splits like BERT uncased and marks the passage segment', () => {
  const vocab = { '[UNK]': 100, '[CLS]': 101, '[SEP]': 102, waive: 1, '##r': 2, 'l': 3, '’': 4, employ: 5, '##eur': 6, privilege: 7, '.': 8, 'is': 9 };
  const tokenizer = createTokenizer(vocab);
  assert.deepEqual(tokenizer.words('L’Employeur a renoncé au PRIVILÈGE.'), ['l', '’', 'employeur', 'a', 'renonce', 'au', 'privilege', '.']);
  assert.deepEqual(tokenizer.pair('Is waiver', 'L’employeur privilège.'), { ids: [101, 9, 1, 2, 102, 3, 4, 5, 6, 7, 8, 102], types: [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1] });
  assert.deepEqual(tokenizer.encode('xyz'), [100]);
  assert.equal(tokenizer.pair('q', 'waive '.repeat(600), 512).ids.length, 512);
  const bundled = path.join(__dirname, '..', 'vendor', 'rerank', 'tokenizer.json');
  if (fs.existsSync(bundled)) {
    // Expected ids from Hugging Face tokenizers for the bundled tokenizer.json.
    const real = createTokenizer(JSON.parse(fs.readFileSync(bundled, 'utf8')).model.vocab);
    assert.deepEqual(real.pair('Is waiver implied?', 'L’employeur a renoncé au privilège — s. 7(1)(b) Charter; 中文.').ids,
      [101, 2003, 23701, 6299, 13339, 1029, 102, 1048, 1521, 12666, 11236, 1037, 17738, 5897, 8740, 14293, 1517, 1055, 1012, 1021, 1006, 1015, 1007, 1006, 1038, 1007, 6111, 1025, 1746, 1861, 1012, 102]);
  }
});

test('French queries are recognised so the English reranker leaves them alone', () => {
  assert.equal(looksFrench("l'obligation d'accommodement de l'employeur est limitée par la contrainte excessive"), true);
  assert.equal(looksFrench('renonciation au privilège'), true);
  assert.equal(looksFrench('duty to accommodate to the point of undue hardship'), false);
  assert.equal(looksFrench('Des Rosiers v. Canada'), false);
});
