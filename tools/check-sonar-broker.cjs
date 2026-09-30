'use strict';

// Focused, dependency-free lifecycle checks. Chrome APIs are simulated here;
// this does not certify native side-panel, DOM highlight, or clipboard behavior.
// Run: node tools/check-sonar-broker.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
require('../find-core.js');
const { createBroker } = require('../find-worker.js');

const WORKSPACE = '12345678-1234-1234-1234-123456789abc';
const OTHER = '12345678-1234-1234-1234-123456789def';
const unitKey = workspace => `pinpointer-sonar:units:${workspace}`;
const sessionKey = workspace => `pinpointer-sonar:workspace:${workspace}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const tabs = [
    { id: 1, windowId: 10, index: 0, groupId: 7, url: 'https://one.test/', incognito: false },
    { id: 2, windowId: 10, index: 1, groupId: 7, url: 'https://two.test/', incognito: false },
    { id: 3, windowId: 11, index: 0, groupId: -1, url: 'https://three.test/', incognito: false },
    { id: 4, windowId: 12, index: 0, groupId: 7, url: 'https://private.test/', incognito: true }
  ];
  const store = {}, calls = [], hooks = {}, documents = new Map(tabs.map(tab => [tab.id, `doc-${tab.id}`]));
  const api = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}` },
    storage: { session: {
      async get(key) { return structuredClone(key ? { [key]: store[key] } : store); },
      async set(values) { await hooks.set?.(values); Object.assign(store, structuredClone(values)); },
      async remove(key) { await hooks.remove?.(key); delete store[key]; }
    } },
    tabs: {
      async get(id) { const tab = tabs.find(value => value.id === id); if (!tab) throw new Error('Tab closed'); return { ...tab }; },
      async query(query) { return tabs.filter(tab => Object.entries(query).every(([key, value]) => tab[key] === value)); },
      async update(id) { calls.push({ method: 'activate', id }); return this.get(id); }
    },
    windows: { async update(id) { calls.push({ method: 'focus', id }); } },
    scripting: { async executeScript(options) {
      const tabId = options.target.tabId, documentId = documents.get(tabId), [method, args] = options.args || [];
      if (!documentId || (options.target.documentIds && options.target.documentIds[0] !== documentId)) throw new Error('Document replaced');
      calls.push({ method: method || 'probe', args, target: structuredClone(options.target) });
      if (!options.args || options.files) return [{ documentId, result: true }];
      let value;
      if (method === 'units') {
        await hooks.units?.(tabId, args[0]);
        const tab = await api.tabs.get(tabId);
        value = { url: tab.url, title: `Source ${tabId}`, revision: '1:42', text: 'Privilege and waiver.', paras: [12], limited: false };
      } else if (method === 'search') {
        const tab = await api.tabs.get(tabId);
        value = { url: tab.url, title: `Source ${tabId}`, characters: 21, results: [{ index: 0, preview: 'Privilege and waiver.', marks: [{ start: 0, end: 9 }] }] };
      } else if (['release', 'preview', 'reveal', 'restore'].includes(method)) { await hooks[method]?.(tabId, args); value = true; }
      else value = { plain: '[Link]: Privilege and waiver.', html: '<a href="https://one.test/">[Link]</a>: Privilege and waiver.' };
      return [{ documentId, result: { ok: true, value } }];
    } }
  };
  const panel = { id: api.runtime.id, url: api.runtime.getURL('sonar.html') };
  const broker = createBroker(api);
  const request = (type, values = {}) => ({ type, workspace: WORKSPACE, incognito: false, ...values });
  const send = (type, values) => broker.handle(request(type, values), panel);
  const read = (values = {}) => send('SONAR_UNITS', { tabIds: [1], known: {}, ...values });
  const ranked = (values = {}) => send('SONAR_ISSUE', { sequence: 1, originTabId: 1, scope: 'all', query: 'privilege waiver',
    results: [{ tabId: 1, documentId: 'doc-1', unit: 0, hash: 42 }], ...values });
  return { api, broker, panel, request, send, read, ranked, tabs, store, calls, hooks, documents };
}

test('Close rejects a late units response without resurrecting its registry; reopening can read again', async () => {
  const f = fixture(), started = deferred(), release = deferred();
  f.hooks.units = async () => { started.resolve(); await release.promise; };
  const reading = f.read(), rejected = assert.rejects(reading, /Search closed/);
  await started.promise;
  await f.send('SONAR_CLOSE', { sequence: 10 });
  assert.equal(f.store[unitKey(WORKSPACE)], undefined);
  release.resolve();
  await rejected;
  assert.equal(f.store[unitKey(WORKSPACE)], undefined);
  delete f.hooks.units;
  assert.equal((await f.read()).pages[0].documentId, 'doc-1');
  assert.equal(f.store[unitKey(WORKSPACE)].workspace, WORKSPACE);
});

test('A new read can register after Close while an older generation is still responding', async () => {
  const f = fixture(), started = deferred(), release = deferred();
  f.hooks.units = async () => { started.resolve(); await release.promise; };
  const reading = f.read(), rejected = assert.rejects(reading, /Search closed/);
  await started.promise;
  await f.send('SONAR_CLOSE', { sequence: 10 });
  delete f.hooks.units;
  await f.read({ tabIds: [2] });
  const reopened = structuredClone(f.store[unitKey(WORKSPACE)]);
  release.resolve();
  await rejected;
  assert.deepEqual(f.store[unitKey(WORKSPACE)], reopened);
  assert.deepEqual(reopened.targets.map(target => target.tabId), [2]);
});

test('Close waits behind an active units storage write and removes its completed registry', async () => {
  const f = fixture(), writing = deferred(), release = deferred(), removedSession = deferred();
  f.hooks.set = async values => { if (values[unitKey(WORKSPACE)]) { writing.resolve(); await release.promise; } };
  f.hooks.remove = key => { if (key === sessionKey(WORKSPACE)) removedSession.resolve(); };
  const reading = f.read(), rejected = assert.rejects(reading, /Search closed/);
  await writing.promise;
  const closing = f.send('SONAR_CLOSE', { sequence: 10 });
  await removedSession.promise;
  release.resolve();
  await Promise.all([closing, rejected]);
  assert.equal(f.store[unitKey(WORKSPACE)], undefined);
  assert.ok(f.calls.some(call => call.method === 'release' && call.args[2] === WORKSPACE));
});

test('A reopened read waits for old page cleanup and survives a still-pending Close', async () => {
  const f = fixture(), removing = deferred(), remove = deferred(), cleaning = deferred(), clean = deferred();
  await f.read();
  f.hooks.remove = async key => { if (key === sessionKey(WORKSPACE)) { removing.resolve(); await remove.promise; } };
  f.hooks.release = async () => { cleaning.resolve(); await clean.promise; };
  const closing = f.send('SONAR_CLOSE', { sequence: 10 });
  await Promise.all([removing.promise, cleaning.promise]);
  const reopening = f.read({ tabIds: [2] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.some(call => call.method === 'units' && call.target.tabId === 2), false,
    'the new page watch cannot be removed by the older page cleanup');
  clean.resolve();
  await reopening;
  assert.deepEqual(f.store[unitKey(WORKSPACE)].targets.map(target => target.tabId), [2]);
  remove.resolve();
  await closing;
  assert.deepEqual(f.store[unitKey(WORKSPACE)].targets.map(target => target.tabId), [2]);
  const issued = await f.ranked({ sequence: 20, results: [{ tabId: 2, documentId: 'doc-2', unit: 0, hash: 42 }] });
  assert.equal(f.store[issued.session].results[0].tabId, 2);
});

test('Cancel without an issued search preserves an in-flight ranked read', async () => {
  const f = fixture(), started = deferred(), release = deferred();
  f.hooks.units = async () => { started.resolve(); await release.promise; };
  const reading = f.read();
  await started.promise;
  await f.send('SONAR_CANCEL', { sequence: 10 });
  release.resolve();
  await reading;
  assert.equal(f.store[unitKey(WORKSPACE)].targets.length, 1);
});

test('Closing one workspace does not cancel another workspace read', async () => {
  const f = fixture(), started = deferred(), release = deferred();
  f.hooks.units = async () => { started.resolve(); await release.promise; };
  const otherReading = f.read({ workspace: OTHER });
  await started.promise;
  await f.send('SONAR_CLOSE', { sequence: 10 });
  release.resolve();
  await otherReading;
  assert.equal(f.store[unitKey(OTHER)].workspace, OTHER);
  assert.equal(f.store[unitKey(WORKSPACE)], undefined);
});

test('A stale Close after broker restart does not erase newer ranked handles or units', async () => {
  const f = fixture();
  await f.read();
  const issued = await f.ranked({ sequence: 20 });
  const before = structuredClone(f.store);
  await createBroker(f.api).handle(f.request('SONAR_CLOSE', { sequence: 10 }), f.panel);
  assert.deepEqual(f.store, before);
  assert.equal(f.store[issued.session].ticket, issued.ticket);
  assert.equal(f.calls.some(call => call.method === 'release'), false);
});

test('Existing units registries acquire their owner, and Close passes that owner to page release', async () => {
  const f = fixture();
  f.store[unitKey(WORKSPACE)] = { targets: [], incognito: false, updated: Date.now() };
  await f.read();
  assert.equal(f.store[unitKey(WORKSPACE)].workspace, WORKSPACE);
  await f.send('SONAR_CLOSE', { sequence: 10 });
  assert.deepEqual(f.calls.find(call => call.method === 'release').args, [undefined, false, WORKSPACE]);
});

test('Ranked handles preserve the origin, exact document targeting, and both copy formats', async () => {
  const f = fixture();
  await f.read({ tabIds: [1, 2, 3] });
  const issued = await f.ranked({ results: [{ tabId: 3, documentId: 'doc-3', unit: 2, hash: 42 }] });
  const handle = { session: issued.session, ticket: issued.ticket, id: 0 };
  await f.send('SONAR_GO', handle);
  assert.equal(f.store[issued.session].origin.tabId, 1);
  const preview = f.calls.find(call => call.method === 'preview');
  assert.deepEqual(preview.target, { tabId: 3, documentIds: ['doc-3'] });
  assert.equal(preview.args[1].unit, 2);
  assert.equal(preview.args[1].hash, 42);
  assert.equal(f.calls.some(call => call.method === 'reveal'), false);
  const payload = await f.send('SONAR_COPY', { ...handle, mode: 'quote' });
  assert.match(payload.plain, /Privilege and waiver/);
  assert.match(payload.html, /<a href=/);
  f.documents.set(3, 'replacement');
  await assert.rejects(f.send('SONAR_GO', handle), /Document replaced/);
  f.documents.set(3, 'doc-3');
  f.tabs[2].url += 'changed';
  await assert.rejects(f.send('SONAR_COPY', { ...handle, mode: 'quote' }), /navigated/);
});

test('Exact search keeps current/all/group scopes, private-tab filtering, and sender guards', async () => {
  const f = fixture();
  for (const [scope, sequence, ids] of [['current', 1, [1]], ['all', 2, [1, 2, 3]], ['group', 3, [1, 2]]]) {
    const response = await f.send('SONAR_SEARCH', { originTabId: 1, query: 'privileg* waiv*', scope, sequence });
    assert.deepEqual(response.results.map(result => result.tabId), ids);
    assert.equal(response.origin.tabId, 1);
  }
  const page = { id: f.api.runtime.id, tab: f.tabs[0], frameId: 0, documentId: 'doc-1', url: f.tabs[0].url };
  await assert.rejects(f.broker.handle(f.request('SONAR_UNITS', { tabIds: [1], known: {} }), page), /sender/);
  await assert.rejects(f.broker.handle(f.request('SONAR_UNITS', { tabIds: [1], known: {} }), { ...f.panel, id: 'other' }), /sender/);
  assert.match((await f.read({ tabIds: [4] })).pages[0].skipped, /private/);
});
