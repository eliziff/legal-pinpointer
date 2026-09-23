'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../find-core.js');
const { createBroker } = require('../find-worker.js');
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

test('the broker ranks every tab with corpus-wide BM25 and hands out passage text for reranking', async () => {
  const tabs = [1, 2].map(id => ({ id, windowId: 10, groupId: -1, index: id, url: `https://site${id}.test/`, title: `Page ${id}`, incognito: false }));
  const storage = {};
  // Terms: [waiver, privilege]. Tab 1 is all about waiver, so waiver is common
  // corpus-wide and the passage with the rare term, privilege, must rank first.
  const pages = {
    1: { ranked: { units: 50, length: 500, dfs: [40, 0] }, results: [{ index: 0, tfs: [2, 0], length: 10 }, { index: 1, tfs: [1, 0], length: 10 }] },
    2: { ranked: { units: 50, length: 500, dfs: [1, 1] }, results: [{ index: 0, tfs: [0, 1], length: 10 }] }
  };
  const api = {
    runtime: { id: 'extension', getURL: p => `chrome-extension://extension/${p}` },
    storage: { session: { async get(key) { return structuredClone(key ? { [key]: storage[key] } : storage); },
      async set(values) { Object.assign(storage, structuredClone(values)); }, async remove(key) { delete storage[key]; } } },
    tabs: { async get(id) { return { ...tabs.find(t => t.id === id) }; }, async query() { return tabs; } },
    scripting: { async executeScript({ target, args, files }) {
      if (files || !args) return [{ documentId: `doc${target.tabId}`, result: true }];
      const [method, values] = args, page = pages[target.tabId];
      const value = method === 'search' ? { url: `https://site${target.tabId}.test/`, title: `Page ${target.tabId}`, ranked: page.ranked,
        results: page.results.map(r => ({ ...r, preview: `passage ${target.tabId}.${r.index}`, marks: [] })) }
        : method === 'texts' ? values[1].map(i => `text ${target.tabId}.${i}`) : true;
      return [{ documentId: `doc${target.tabId}`, result: { ok: true, value } }];
    } }
  };
  const broker = createBroker(api), sender = { id: 'extension', tab: tabs[0], frameId: 0, documentId: 'doc1', url: tabs[0].url };
  const reply = await broker.handle({ type: 'SONAR_SEARCH', query: 'waiver privilege', mode: 'p', scope: 'all', sequence: 1 }, sender);
  assert.equal(reply.ranked, true);
  assert.deepEqual(reply.results.map(r => r.preview), ['passage 2.0', 'passage 1.0', 'passage 1.1']);
  assert.equal(reply.results[0].tfs, undefined, 'term statistics stay in the broker');
  const { texts } = await broker.handle({ type: 'SONAR_TEXTS', session: reply.session, ticket: reply.ticket, ids: [2, 0] }, sender);
  assert.deepEqual(texts, ['text 1.1', 'text 2.0']);
  await assert.rejects(broker.handle({ type: 'SONAR_TEXTS', session: reply.session, ticket: 'forged', ids: [0] }, sender), /expired/);
  pages[2].ranked.dfs = [1];
  await assert.rejects(broker.handle({ type: 'SONAR_SEARCH', query: 'waiver privilege', mode: 'p', scope: 'current', sequence: 2 }, { ...sender, tab: tabs[1], documentId: 'doc2', url: tabs[1].url })
    .then(r => { if (r.skipped.length) throw new Error(r.skipped[0].reason); }), /invalid term statistics/);
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
