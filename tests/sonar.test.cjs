'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../find-core.js');
const { createBroker } = require('../find-worker.js');

function fixture() {
  const tabs = [
    { id: 1, windowId: 10, groupId: 7, index: 0, url: 'https://ordinary.test/article', title: 'Ordinary', incognito: false },
    { id: 2, windowId: 10, groupId: 7, index: 1, url: 'http://other.test/page', title: 'Other', incognito: false },
    { id: 3, windowId: 11, groupId: 8, index: 0, url: 'https://third.test/page', title: 'Third', incognito: false },
    { id: 4, windowId: 10, groupId: -1, index: 2, url: 'chrome://settings', title: 'Settings', incognito: false },
    { id: 5, windowId: 10, groupId: -1, index: 3, url: 'https://sleep.test', title: 'Sleeping', discarded: true, incognito: false },
    { id: 6, windowId: 12, groupId: -1, index: 0, url: 'https://private.test', title: 'Private', incognito: true }
  ];
  const storage = {}, calls = [], navigations = [];
  const sender = { id: 'extension', tab: tabs[0], frameId: 0, documentId: 'doc1', url: tabs[0].url };
  const api = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}` },
    storage: { session: { async get(key) { return structuredClone(key ? { [key]: storage[key] } : storage); },
      async set(values) { Object.assign(storage, structuredClone(values)); }, async remove(key) { delete storage[key]; } } },
    tabs: { async get(id) { const tab = tabs.find(t => t.id === id); if (!tab) throw new Error('Closed tab'); return { ...tab }; },
      async query(query) { return tabs.filter(t => Object.entries(query).every(([k, v]) => t[k] === v)); },
      async update(id) { navigations.push(id); return this.get(id); } },
    windows: { async update(id) { return { id }; } },
    action: { async setBadgeText() {}, async setTitle() {} },
    scripting: { async executeScript(options) {
      const { tabId, documentIds } = options.target;
      calls.push(options);
      if (documentIds && documentIds[0] !== `doc${tabId}`) throw new Error('Wrong document');
      if (options.files || !options.args) return [{ documentId: `doc${tabId}`, result: true }];
      const [method] = options.args;
      const value = method === 'search' ? { title: `Page ${tabId}`, url: tabs.find(t => t.id === tabId).url, limited: false,
        results: [{ index: 0, preview: 'Privilege waiver.', marks: [{ start: 0, end: 9 }], locator: '' }] } : true;
      return [{ documentId: `doc${tabId}`, result: typeof method === 'string' ? { ok: true, value } : value }];
    } }
  };
  return { api, tabs, calls, storage, sender, navigations, broker: createBroker(api) };
}
const request = (scope, sequence = 1) => ({ type: 'SONAR_SEARCH', query: 'privileg* waiv*', mode: 'p', scope, sequence });

test('one broker searches arbitrary HTTP/HTTPS sites in current, all-window and exact group scopes', async () => {
  const f = fixture();
  for (const [scope, sequence, ids] of [['current', 1, [1]], ['all', 2, [1, 2, 3]], ['group', 3, [1, 2]]]) {
    const result = await f.broker.handle(request(scope, sequence), f.sender);
    assert.deepEqual(result.results.map(r => r.tabId), ids);
    assert.equal(result.searched, ids.length);
    if (scope === 'all') { assert.equal(result.total, 5); assert.equal(result.skipped.length, 2); }
  }
  assert.equal(f.navigations.length, 0, 'Preview/search must not activate tabs');
  f.tabs[0].groupId = -1;
  const none = await f.broker.handle(request('group', 4), f.sender);
  assert.equal(none.total, 0); assert.match(none.note, /not in a tab group/);
});

test('sender validation and issued-result handles protect cross-tab navigation', async () => {
  const f = fixture();
  for (const sender of [{ ...f.sender, id: 'other' }, { ...f.sender, frameId: 2 }, { ...f.sender, documentId: null }, { ...f.sender, tab: null }]) {
    await assert.rejects(f.broker.handle(request('all'), sender), /sender/);
  }
  const result = await f.broker.handle(request('all'), f.sender);
  const go = { type: 'SONAR_GO', session: result.session, ticket: result.ticket, id: 1 };
  await assert.rejects(f.broker.handle({ ...go, ticket: 'forged' }, f.sender), /expired/);
  await assert.rejects(f.broker.handle({ ...go, id: 500 }, f.sender), /Choose/);
  await f.broker.handle(go, f.sender); assert.deepEqual(f.navigations, [2]);
  f.tabs[1].url += '/changed';
  await assert.rejects(f.broker.handle(go, f.sender), /navigated/);
});

test('group changes, closed tabs and broker restarts do not redirect to stale passages', async () => {
  const f = fixture(); const result = await f.broker.handle(request('group'), f.sender);
  const go = { type: 'SONAR_GO', session: result.session, ticket: result.ticket, id: 1 };
  const restarted = createBroker(f.api);
  await restarted.handle(go, f.sender); assert.deepEqual(f.navigations, [2]);
  f.tabs[1].groupId = 55; await assert.rejects(restarted.handle(go, f.sender), /left this group/);
  f.tabs.splice(1, 1); await assert.rejects(restarted.handle(go, f.sender), /Closed tab/);
});

test('return restores the destination scroll and focuses only the exact origin document', async () => {
  const f = fixture(); const result = await f.broker.handle(request('all'), f.sender);
  const target = { ...f.sender, tab: f.tabs[1], documentId: 'doc2', url: f.tabs[1].url };
  await f.broker.handle({ type: 'SONAR_RETURN', session: result.session }, target);
  assert.deepEqual(f.navigations, [1]);
  assert.ok(f.calls.some(call => call.args?.[0] === 'restore' && call.target.documentIds[0] === 'doc2'));
  await f.broker.handle({ type: 'SONAR_CLOSE', sequence: 2 }, f.sender);
  assert.equal(Object.keys(f.storage).length, 0);
  await assert.rejects(f.broker.handle({ type: 'SONAR_RETURN', session: result.session }, target), /no longer open/);
});

test('latest query wins, and close during search cancels publication of results', async () => {
  const f = fixture(); const execute = f.api.scripting.executeScript;
  let unblock;
  f.api.scripting.executeScript = async function(options) {
    if (options.args?.[0] === 'search' && options.args[1][0].query === 'slow') await new Promise(resolve => { unblock = resolve; });
    return execute.call(this, options);
  };
  const first = f.broker.handle({ ...request('current'), query: 'slow' }, f.sender);
  while (!unblock) await new Promise(setImmediate);
  const newest = await f.broker.handle(request('current', 2), f.sender);
  unblock(); assert.equal((await first).stale, true);
  assert.equal(f.storage[newest.session].ticket, newest.ticket);
  const pending = f.broker.handle({ ...request('current', 3), query: 'slow' }, f.sender);
  const oldUnblock = unblock;
  while (unblock === oldUnblock) await new Promise(setImmediate);
  await f.broker.handle({ type: 'SONAR_CLOSE', sequence: 4 }, f.sender);
  unblock(); assert.equal((await pending).stale, true); assert.equal(Object.keys(f.storage).length, 0);
  assert.equal((await f.broker.handle(request('current', 5), f.sender)).results.length, 1);
});

test('empty queries do not inspect pages, errors and result caps remain visible', async () => {
  const f = fixture();
  await f.broker.handle({ ...request('all'), query: '' }, f.sender); assert.equal(f.calls.length, 0);
  f.api.scripting.executeScript = async () => { throw new Error('Site access denied'); };
  const result = await f.broker.handle(request('current', 2), f.sender);
  assert.equal(result.searched, 0); assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /access denied/);
});

test('replacement keeps eligible indexes warm, avoids reinjection, and stores only handles', async () => {
  const f = fixture();
  const first = await f.broker.handle(request('all'), f.sender);
  const second = await f.broker.handle(request('group', 2), f.sender);
  await new Promise(setImmediate);
  assert.equal(f.calls.filter(c => c.files).length, 0, 'Warm-page probe does not reload modules');
  for (const id of [1, 2, 3]) {
    assert.ok(f.calls.some(c => c.target.tabId === id && c.args?.[0] === 'release' &&
      c.args[1][0] === first.ticket && c.args[1][1] === (id !== 3)));
  }
  assert.ok(second.results[0].preview);
  assert.deepEqual(Object.keys(f.storage[second.session].results[0]).sort(), ['documentId', 'index', 'tabId', 'url', 'windowId']);
});

test('cross-tab batches stop at the aggregate result and text budgets', async () => {
  for (const budget of ['results', 'text']) {
    const f = fixture(), execute = f.api.scripting.executeScript;
    f.tabs.splice(1);
    for (let id = 2; id <= 40; id++) f.tabs.push({ ...f.tabs[0], id, index: id, url: `https://tab${id}.test/` });
    let active = 0, maximum = 0, scanned = 0;
    f.api.scripting.executeScript = async options => {
      const entries = await execute(options);
      if (options.args?.[0] !== 'search') return entries;
      scanned++; maximum = Math.max(maximum, ++active);
      await new Promise(setImmediate); active--;
      const value = entries[0].result.value;
      value.characters = budget === 'text' ? 4_000_000 : 10;
      if (budget === 'results') value.results = Array.from({ length: 200 }, (_, index) => ({ ...value.results[0], index }));
      return entries;
    };
    const result = await f.broker.handle(request('all'), f.sender);
    assert.equal(maximum, 4);
    assert.equal(scanned, 8, 'Do not read the remaining 32 tabs after exhausting a budget');
    assert.equal(result.results.length, budget === 'results' ? 1000 : 8);
    assert.equal(result.skipped.length, 32);
    assert.equal(result.limited, true);
  }
});

test('close during late injection cannot start a page search afterward', async () => {
  const f = fixture(), execute = f.api.scripting.executeScript;
  let resolveProbe;
  f.api.scripting.executeScript = async options => {
    if (!options.files && !options.args) await new Promise(resolve => { resolveProbe = resolve; }); // the install probe
    return execute(options);
  };
  const pending = f.broker.handle(request('current'), f.sender);
  while (!resolveProbe) await new Promise(setImmediate);
  await f.broker.handle({ type: 'SONAR_CLOSE', sequence: 2 }, f.sender);
  resolveProbe();
  assert.equal((await pending).stale, true);
  assert.equal(f.calls.filter(c => c.args?.[0] === 'search').length, 0);
  assert.equal(Object.keys(f.storage).length, 0);
});

test('slow session writes and stale closes cannot overwrite a newer query', async () => {
  const f = fixture(), set = f.api.storage.session.set;
  let unblock, once = true;
  f.api.storage.session.set = async values => {
    if (once) { once = false; await new Promise(resolve => { unblock = resolve; }); }
    await set(values);
  };
  const old = f.broker.handle(request('current'), f.sender);
  while (!unblock) await new Promise(setImmediate);
  const next = f.broker.handle(request('current', 5), f.sender);
  unblock();
  assert.equal((await old).stale, true);
  const latest = await next;
  assert.equal(f.storage[latest.session].ticket, latest.ticket);
  const restarted = createBroker(f.api), releases = f.calls.filter(c => c.args?.[0] === 'release').length;
  await restarted.handle({ type: 'SONAR_CLOSE', sequence: 2 }, f.sender);
  assert.equal(f.storage[latest.session].ticket, latest.ticket);
  assert.equal(f.calls.filter(c => c.args?.[0] === 'release').length, releases);
  await restarted.handle({ type: 'SONAR_GO', session: latest.session, ticket: latest.ticket, id: 0 }, f.sender);
  await assert.rejects(restarted.handle({ type: 'SONAR_GO', session: latest.session, ticket: latest.ticket, id: '0' }, f.sender), /Choose/);
});

test('cancel aborts the actual outstanding page job, not just its returned results', async () => {
  const f = fixture(), execute = f.api.scripting.executeScript;
  let aborted, ticket;
  f.api.scripting.executeScript = async options => {
    if (options.args?.[0] === 'search') {
      ticket = options.args[1][0].ticket;
      await new Promise((_, reject) => { aborted = () => reject(new Error('Search cancelled')); });
    }
    if (options.args?.[0] === 'release' && options.args[1][0] === ticket) aborted();
    return execute(options);
  };
  const pending = f.broker.handle(request('current'), f.sender);
  while (!aborted) await new Promise(setImmediate);
  await f.broker.handle({ type: 'SONAR_CANCEL', sequence: 2 }, f.sender);
  assert.equal((await pending).stale, true);
  await f.broker.handle({ type: 'SONAR_CLOSE', sequence: 3 }, f.sender);
  assert.equal(Object.keys(f.storage).length, 0);
});
