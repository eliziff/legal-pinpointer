'use strict';
// Focused lifecycle regressions. Runs the actual panel, index and page agent in
// Node VM contexts with browser/DOM doubles; not an installed-Chrome UI test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
require('../find-core.js');
const core = globalThis.LegalPinpointerFindCore;
const { createIndex } = require('../sonar-index.js');
const root = process.env.SONAR_ROOT || path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate, message = 'condition', timeout = 3000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) assert.fail(`Timed out: ${message}`); await sleep(5); }
}
function timers() {
  const all = new Set();
  return { setTimeout(fn, ms) { const id = setTimeout(() => { all.delete(id); fn(); }, ms); id.unref(); all.add(id); return id; },
    clearTimeout(id) { clearTimeout(id); all.delete(id); }, close() { for (const id of all) clearTimeout(id); } };
}
function panelFixture() {
  const time = timers(), elements = new Map(), calls = [], storage = {}, workers = [], changes = event(), messages = event();
  let now = Date.now(), list, unitsHook, storageHook, issueHook;
  const tabs = [1, 2, 3].map(id => ({ id, windowId: id === 3 ? 11 : 10, groupId: id === 3 ? 8 : 7, index: id,
    title: `Source ${id}`, url: `https://source${id}.test/`, incognito: false, active: id === 1, status: 'complete',
    text: id === 2 ? 'Nothing relevant here.' : `Privilege in source ${id}.`, documentId: `doc${id}` }));
  class Element {
    constructor(id = '') { this.id = id; this.textContent = ''; this.value = ''; this.dataset = {}; this.children = []; this.attrs = {}; this.handlers = {}; this.scrollTop = 0; this.classList = { toggle() {} }; }
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
    emit(type, extra = {}) { for (const fn of this.handlers[type] || []) fn({ target: this, preventDefault() {}, ...extra }); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k]; }
    removeAttribute(k) { delete this.attrs[k]; }
    replaceChildren(...children) { this.children = children; }
    contains(el) { return el === this; }
    focus() { const previous = document.activeElement; document.activeElement = this; if (previous !== this) previous?.emit('focusout'); }
    select() {}
    matches() { return false; }
  }
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  const document = { body: { dataset: {} }, activeElement: null, getElementById: $, createElement: () => new Element(),
    querySelector: selector => selector === 'label[for=query]' ? $('label') : null, querySelectorAll: () => [], addEventListener() {} };
  $('scope').children = ['all', 'group', 'current'].map(scope => Object.assign(new Element(), { dataset: { scope } }));
  class Worker {
    constructor(name) {
      if (name !== 'sonar-index.js') throw Error('Optional reranker omitted in lifecycle checks');
      this.index = createIndex(core); workers.push(this); this.queue = Promise.resolve();
      queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }));
    }
    postMessage(data) {
      calls.push({ ...data, type: `index:${data.type}` });
      this.queue = this.queue.then(async () => {
        let reply = {};
        if (data.type === 'put') await this.index.put(data.page);
        else if (data.type === 'meta') { if (!this.index.meta(data.meta)) throw Error('Not indexed.'); }
        else if (data.type === 'drop') this.index.drop(data.tabId);
        else reply = this.index[data.type](data);
        if (data.type !== 'drop') this.onmessage?.({ data: { id: data.id, type: data.type, ...reply } });
      }).catch(error => this.onmessage?.({ data: { id: data.id, error: error.message } }));
    }
    terminate() {}
  }
  const chrome = {
    windows: { getCurrent: async () => ({ id: 10, incognito: false }) },
    tabs: { query: async query => tabs.filter(tab => Object.entries(query).every(([key, value]) => tab[key] === value)).map(tab => ({ ...tab })),
      get: async id => { const tab = tabs.find(tab => tab.id === id); if (!tab) throw Error('No tab'); return { ...tab }; },
      onUpdated: event(), onRemoved: event(), onReplaced: event(), onAttached: event(), onDetached: event() },
    storage: { onChanged: changes, session: { get: async key => ({ [key]: storage[key] }), set: async values => { await storageHook?.(values); Object.assign(storage, values); }, remove: async key => { delete storage[key]; } } },
    sidePanel: { open: async () => {}, close: async () => {} },
    runtime: { id: 'extension', getURL: name => `chrome-extension://extension/${name}`, onMessage: messages,
      async sendMessage(message) {
        calls.push(message);
        if (message.type === 'SONAR_UNITS') {
          const tab = tabs.find(tab => tab.id === message.tabIds[0]);
          const overridden = await unitsHook?.(message, tab);
          if (overridden) return { ok: true, pages: [overridden] };
          if (!tab) return { ok: true, pages: [{ tabId: message.tabIds[0], skipped: 'Closed' }] };
          const revision = `${tab.text.split('\n').length}:${core.hash(tab.text)}`;
          const meta = { tabId: tab.id, documentId: tab.documentId, title: tab.title, windowId: tab.windowId, url: tab.url, revision };
          return { ok: true, pages: [message.known[tab.id] === revision ? { ...meta, same: true } :
            { ...meta, text: tab.text, paras: tab.text.split('\n').map(() => 0) }] };
        }
        if (message.type === 'SONAR_ISSUE') { await issueHook?.(); return { ok: true, session: `pinpointer-sonar:workspace:${message.workspace}`, ticket: `ticket${message.sequence}` }; }
        if (message.type === 'SONAR_COPY') return { ok: true, plain: 'Fixture passage', html: '<p>Fixture passage</p>' };
        if (message.type === 'SONAR_SEARCH') return { ok: true, results: [], skipped: [], ticket: `ticket${message.sequence}` };
        return { ok: true };
      } }
  };
  const context = vm.createContext({ document, chrome, crypto: { randomUUID }, LegalPinpointerFindCore: core, Blob,
    ClipboardItem: class { constructor(values) { this.values = values; } },
    navigator: { clipboard: { write: async items => { await Promise.all(items.flatMap(item => Object.values(item.values))); } } },
    LegalPinpointerRerankCore: { looksFrench: () => false }, Worker, console, ...time,
    Date: class extends Date { static now() { return now; } },
    LegalPinpointerResults: { ResultsList: class {
      constructor(viewport, _spacer, _rows, callbacks) { Object.assign(this, { viewport, results: [], ...callbacks }); list = this; }
      setResults(results) { this.results = results; }
      select() {} redraw() {}
    } } });
  vm.runInContext(source('sonar.js'), context, { filename: 'sonar.js' });
  return { tabs, calls, chrome, $, document, workers, close: time.close, advance: ms => { now += ms; },
    get results() { return list.results; }, set unitsHook(fn) { unitsHook = fn; },
    set storageHook(fn) { storageHook = fn; },
    set issueHook(fn) { issueHook = fn; },
    async ready() { await until(() => workers.length && calls.filter(call => call.type === 'SONAR_UNITS').length >= tabs.length, 'initial tab reads'); await sleep(20); },
    async search(query = 'privilege') {
      const count = calls.filter(call => call.type === 'index:search').length;
      $('query').focus(); $('query').value = query; $('query').emit('input');
      await until(() => calls.filter(call => call.type === 'index:search').length > count && $('list-viewport').getAttribute('aria-busy') === 'false', `search: ${$('notice').textContent}`);
      return list.results;
    },
    async scope(scope) { $('scope').onclick({ target: { closest: () => ({ dataset: { scope } }) } }); await until(() => $('list-viewport').getAttribute('aria-busy') === 'false', 'scope search'); },
    invalidate(tabId) { const workspace = calls.find(call => call.type === 'SONAR_UNITS').workspace; messages.emit({ type: 'SONAR_INVALIDATED', workspace }, { id: 'extension', tab: { id: tabId } }); },
    otherSearch(sequence) { const workspace = calls.find(call => call.type === 'SONAR_UNITS').workspace;
      changes.emit({ [`pinpointer-sonar:workspace:${workspace}`]: { newValue: { sequence, ticket: 'other-panel' } } }, 'session'); },
    launch(tab, route = 'tabs', handoff) { const launch = { nonce: randomUUID(), created: now, route, origin: tab, handoff }; storage['sonar-launch:10'] = launch; changes.emit({ 'sonar-launch:10': { newValue: launch } }, 'session'); },
    choose(index, action) { list.choose(index, action); }
  };
}

test('ranked search covers other windows; origin stays pinned during ordinary activation', async t => {
  const f = panelFixture(); t.after(f.close); await f.ready();
  assert.deepEqual((await f.search()).map(row => row.tabId), [1, 3]);
  f.tabs[0].active = false; f.tabs[1].active = true;
  await f.scope('current'); assert.deepEqual(f.results.map(row => row.tabId), [1]);
  await f.scope('group'); assert.deepEqual(f.results.map(row => row.tabId), [1]);
  f.tabs[0].groupId = -1; await f.search(); assert.equal(f.results.length, 0);
});

test('closed and replaced origins recover without reload', async t => {
  const f = panelFixture(); t.after(f.close); f.tabs[1].text = 'Privilege in the remaining tab.';
  await f.ready(); await f.search(); await f.scope('current');
  f.tabs.splice(0, 1); f.tabs[0].active = true;
  f.chrome.tabs.onRemoved.emit(1);
  await until(() => f.results.some(row => row.tabId === 2), 'closed origin recovery');
  assert.match(f.$('origin').textContent, /Source 2/);
  const tab = f.tabs[0]; tab.id = 22; tab.documentId = 'doc22'; tab.title = 'Replacement';
  f.chrome.tabs.onReplaced.emit(22, 2);
  await until(() => f.results.some(row => row.tabId === 22), 'replacement origin recovery');
  assert.match(f.$('origin').textContent, /Replacement/);
});

test('transient skipped tabs retry on the next query after a bounded cooldown', async t => {
  const f = panelFixture(); t.after(f.close);
  let failures = 1;
  f.unitsHook = (_message, tab) => tab.id === 3 && failures-- > 0 ? { tabId: 3, skipped: 'Unavailable: suspended' } : null;
  await f.ready(); assert.deepEqual((await f.search()).map(row => row.tabId), [1]);
  f.advance(1001); assert.deepEqual((await f.search('privilege source')).map(row => row.tabId), [1, 3]);
});

test('fresh reads from one tab cannot mask another tab’s expired watcher', async t => {
  const f = panelFixture(); t.after(f.close); await f.ready(); await f.search();
  f.advance(11 * 60_000); f.tabs[0].text += ' New text.'; f.invalidate(1);
  await until(() => f.calls.filter(call => call.type === 'SONAR_UNITS' && call.tabIds[0] === 1).length > 1, 'active tab reread');
  f.tabs[2].text = 'A quiet expired source now mentions estoppel.';
  assert.deepEqual((await f.search('estoppel')).map(row => row.tabId), [3]);
});

test('mutation in a formerly zero-hit tab refreshes All tabs, without reordering during interaction', async t => {
  const f = panelFixture(); t.after(f.close); await f.ready(); await f.search();
  f.$('list-viewport').focus(); f.$('list-viewport').emit('pointerenter');
  f.tabs[1].text = 'Privilege now appears in the second source.'; f.invalidate(2);
  await sleep(250); assert.deepEqual(f.results.map(row => row.tabId), [1, 3]);
  assert.match(f.$('notice').textContent, /Tabs changed/);
  f.$('query').focus(); f.$('list-viewport').emit('pointerleave');
  await until(() => f.results.some(row => row.tabId === 2), 'new match appears');
});

test('launch from CanLII retargets local search and same-tab reopen rereads stale text', async t => {
  const f = panelFixture(); t.after(f.close); await f.ready(); await f.search(); await f.scope('current');
  f.tabs[1].text = 'Privilege from the new launch target.';
  f.launch({ ...f.tabs[1] }, 'canlii'); await until(() => f.document.body.dataset.route === 'canlii', 'CanLII route');
  f.$('tabs-route').onclick(); await until(() => f.results.some(row => row.tabId === 2), 'launch origin retarget');
  f.tabs[1].text = 'Privilege updated after a same-tab reopening.';
  f.launch({ ...f.tabs[1] }); await until(() => f.results.some(row => row.preview.includes('same-tab')), 'same-tab refresh');
});

test('cross-window handoff discards registrations belonging to the previous workspace', async t => {
  const f = panelFixture(); t.after(f.close); await f.ready(); await f.search();
  const workspace = randomUUID(), sequence = Date.now() + 100;
  f.launch({ ...f.tabs[0] }, 'tabs', { workspace, origin: { ...f.tabs[0] }, query: 'privilege', scope: 'all', sequence,
    result: { ranked: true, sequence, results: f.results, session: `pinpointer-sonar:workspace:${workspace}`, ticket: 'transferred' }, current: 0 });
  await until(() => f.calls.filter(call => call.type === 'SONAR_UNITS' && call.workspace === workspace).length === 3, 'adopted workspace registration');
  await f.search('privilege source');
  const issued = f.calls.filter(call => call.type === 'SONAR_ISSUE').at(-1);
  assert.equal(issued.workspace, workspace); assert.deepEqual(issued.results.map(row => row.tabId), [1, 3]);
});

test('a late old-document response cannot reattach a navigated source', async t => {
  const f = panelFixture(); t.after(f.close); await f.ready(); await f.search();
  const held = deferred(), started = deferred(); let once = true;
  f.unitsHook = async (_request, tab) => {
    if (tab.id !== 3 || !once) return;
    once = false;
    const old = { tabId: tab.id, documentId: tab.documentId, url: tab.url, windowId: tab.windowId, title: tab.title,
      text: tab.text, paras: [0], revision: `1:${core.hash(tab.text)}` };
    started.resolve(); await held.promise; return old;
  };
  f.invalidate(3); await started.promise;
  const tab = f.tabs[2]; tab.documentId = 'new-doc3'; tab.text = 'Privilege in the new document.';
  f.chrome.tabs.onUpdated.emit(3, { status: 'loading' }, { ...tab, status: 'loading' });
  f.chrome.tabs.onUpdated.emit(3, { status: 'complete' }, tab);
  held.resolve();
  await until(() => f.results.some(row => row.documentId === 'new-doc3'), 'new document indexed');
  assert.ok(!f.results.some(row => row.documentId === 'doc3'));
});

test('mutation during a pending read retries without publishing the dirty snapshot', async t => {
  const f = panelFixture(); t.after(f.close); await f.ready(); await f.search();
  const held = deferred(), started = deferred(); let once = true;
  f.unitsHook = async (_request, tab) => {
    if (tab.id !== 2 || !once) return;
    once = false;
    const old = { tabId: 2, documentId: tab.documentId, url: tab.url, windowId: tab.windowId, title: tab.title,
      text: 'Privilege stale intermediate text.', paras: [0], revision: '1:stale' };
    started.resolve(); await held.promise; return old;
  };
  f.invalidate(2); await started.promise;
  f.tabs[1].text = 'Privilege newest source text.'; f.invalidate(2); held.resolve();
  await until(() => f.results.some(row => row.preview.includes('newest')), 'dirty read recovery');
  assert.ok(!f.results.some(row => row.preview.includes('stale intermediate')));
});

test('the next query advances beyond another panel’s observed sequence', async t => {
  const f = panelFixture(); t.after(f.close); await f.ready(); await f.search();
  const newer = Date.now() + 60_000; f.otherSearch(newer);
  await f.search('privilege source');
  assert.ok(f.calls.filter(call => call.type === 'SONAR_ISSUE').at(-1).sequence > newer);
});

test('changing the search while handoff storage is pending cancels the old navigation', async t => {
  const f = panelFixture(); t.after(f.close); await f.ready(); await f.search();
  const held = deferred(), started = deferred();
  f.storageHook = async () => { started.resolve(); await held.promise; };
  f.choose(f.results.findIndex(row => row.tabId === 3), 'open'); await started.promise;
  await f.search('different query'); held.resolve(); await sleep(20);
  assert.equal(f.calls.filter(call => call.type === 'SONAR_GO').length, 0);
});

test('a pending Copy keeps the clicked workspace when a different handoff arrives', async t => {
  const f = panelFixture(); t.after(f.close); await f.ready();
  const held = deferred(); f.issueHook = () => held.promise;
  await f.search();
  const original = f.calls.find(call => call.type === 'SONAR_ISSUE').workspace;
  f.choose(0, 'quote');
  const workspace = randomUUID(), sequence = Date.now() + 100;
  f.launch({ ...f.tabs[0] }, 'tabs', { workspace, origin: { ...f.tabs[0] }, query: 'privilege', scope: 'all', sequence,
    result: { ranked: true, sequence, results: f.results, session: `pinpointer-sonar:workspace:${workspace}`, ticket: 'transferred' }, current: 0 });
  await until(() => f.calls.some(call => call.type === 'SONAR_UNITS' && call.workspace === workspace), 'handoff adopted');
  held.resolve(); await until(() => f.calls.some(call => call.type === 'SONAR_COPY'), 'copy issued');
  const copy = f.calls.find(call => call.type === 'SONAR_COPY');
  assert.equal(copy.workspace, original); assert.equal(copy.session, `pinpointer-sonar:workspace:${original}`);
});

// Minimal DOM for the actual page text scanner and range/hash validation.
function pageFixture() {
  const time = timers(), notifications = [], observers = [];
  const document = { title: 'Fixture', contentType: 'text/html', adoptedStyleSheets: [], documentElement: { lang: 'en' } };
  const element = tagName => ({ nodeType: 1, tagName, childNodes: [], getAttribute: () => null, hasAttribute: () => false,
    matches: () => false, querySelector: () => null, closest() { return this; }, getRootNode: () => document });
  const p = element('P'), text = { nodeType: 3, nodeValue: 'Privilege remains protected.', parentElement: p, isConnected: true, getRootNode: () => document };
  p.childNodes.push(text); document.body = element('BODY'); document.body.childNodes.push(p);
  document.createRange = () => ({ setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
    setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; },
    toString() { return this.startContainer.nodeValue.slice(this.startOffset, this.endOffset); } });
  class MutationObserver {
    constructor(fn) { this.fn = fn; observers.push(this); } observe() { this.connected = true; } disconnect() { this.connected = false; } takeRecords() { return []; }
  }
  const context = vm.createContext({ LegalPinpointerFindCore: core, document, location: { href: 'https://fixture.test/', hostname: 'fixture.test' },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, MutationObserver, performance, console, ...time,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), CSS: { highlights: new Map() },
    window: { addEventListener() {} }, chrome: { runtime: { sendMessage: async message => { notifications.push(message); } } } });
  vm.runInContext(source('find-page.js'), context, { filename: 'find-page.js' });
  return { page: context.LegalPinpointerSearchPage, notifications, close: time.close,
    mutate(value) { text.nodeValue = value; observers.filter(observer => observer.connected).forEach(observer => observer.fn([{ type: 'characterData', target: text }])); } };
}

test('independent workspace and exact-ticket watchers all receive mutations; Close releases only its owner', async t => {
  const f = pageFixture(); t.after(f.close);
  await f.page.units({ workspace: 'panel-a' }); await f.page.units({ workspace: 'panel-b' });
  f.page.watch('exact-a'); f.page.watch('exact-b');
  f.mutate('Privilege changed.');
  assert.deepEqual(f.notifications.map(item => item.workspace || item.ticket).sort(), ['exact-a', 'exact-b', 'panel-a', 'panel-b']);
  f.notifications.length = 0;
  await f.page.units({ workspace: 'panel-a' }); await f.page.units({ workspace: 'panel-b' });
  f.page.release(undefined, false, 'panel-a'); f.page.release('exact-a'); f.page.release('exact-b');
  f.mutate('Privilege changed again.');
  assert.deepEqual(f.notifications.map(item => item.workspace || item.ticket), ['panel-b']);
  await f.page.units({ workspace: 'panel-b' });
  const key = { unit: 0, hash: core.hash('Privilege changed again.'), query: 'privilege' };
  assert.equal((await f.page.passage('ranked-b', key)).toString(), 'Privilege changed again.');
  f.mutate('Entirely different source text.');
  await assert.rejects(f.page.passage('ranked-b', key), /changed or expired/);
});
