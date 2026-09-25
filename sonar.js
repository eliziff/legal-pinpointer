'use strict';

(async function startWorkspace() {
  const $ = id => document.getElementById(id), core = LegalPinpointerFindCore;
  const window = await chrome.windows.getCurrent(), windowId = window.id, incognito = Boolean(window.incognito);
  const launchKey = `sonar-launch:${windowId}`;
  let workspace = crypto.randomUUID(), origin = null, route = 'tabs', scope = 'all';
  let query = '', canliiQuery = '', result = null, current = -1, sequence = Date.now();
  let timer = 0, flight = 0, busy = false, opening = false, nonce = '', noticeTimer = 0, focusOnResults = false;
  // Ranked mode: BM25 order from the panel's own index shows at once; the
  // cross-encoder then reorders the top results once, but never while the
  // pointer is on the list or after the user has moved the selection, so
  // nothing jumps under them.
  const RERANK_DEPTH = 30, RERANK_TOKENS = 192, RERANK_WINDOW = 620, RERANK_IDLE = 3 * 60_000;
  let reranker = null, rerankUnavailable = false, rerankJob = 0, rerankIdle = 0, pendingOrder = null, navigated = false, pointerInList = false;
  // The ranked index (sonar-index.js): every eligible tab's paragraphs, read in
  // idle time after the panel opens and again only when that tab changes. Jump
  // and copy still go to the page through issued, revalidated handles.
  const MAX_INDEX_CHARS = 32_000_000, reads = new Map(), readQueue = [], indexWaiting = new Map();
  let indexer = null, indexReady = false, indexCalls = 0, reading = 0, contact = 0;
  const favicon = url => url ? `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=16` : '';
  const list = new LegalPinpointerResults.ResultsList($('list-viewport'), $('result-spacer'), $('result-rows'),
    { choose: (index, action) => choose(index, action), icon: favicon, leave: () => $('query').focus() });
  const inList = () => $('list-viewport').contains(document.activeElement);
  function nextSequence() { sequence = Math.max(sequence + 2, Date.now()); return sequence; }
  function tell(text, error = false) {
    clearTimeout(noticeTimer);
    $('notice').textContent = text; $('notice').title = text; $('notice').classList.toggle('error', error);
    if (text && !error) noticeTimer = setTimeout(() => tell(''), 2800);
  }
  function message(type, values = {}) {
    return { type, workspace, incognito, ...values };
  }
  async function send(type, values) {
    const reply = await chrome.runtime.sendMessage(message(type, values));
    if (!reply?.ok) throw new Error(reply?.message || 'Pinpointer is unavailable. Reload the extension.');
    return reply;
  }
  function labels() {
    document.body.dataset.route = route;
    $('tabs-route').setAttribute('aria-pressed', route === 'tabs'); $('canlii-route').setAttribute('aria-pressed', route === 'canlii');
    for (const button of $('scope').children) button.setAttribute('aria-pressed', button.dataset.scope === scope);
    $('query').placeholder = route === 'tabs' ? 'Search open tabs' : 'Search CanLII';
    $('query').maxLength = route === 'tabs' ? 1024 : 4096;
    document.querySelector('label[for=query]').textContent = $('query').placeholder;
    // The origin carries the title its results do (its citation, once read).
    const from = reads.get(origin?.id)?.title || origin?.title || 'the active tab';
    $('origin').textContent = `From ${from}`; $('origin').title = from;
  }
  // Only tabs that could have been searched are worth listing; restricted pages never can.
  function details() {
    const skipped = (result?.skipped || []).filter(item => !/^Browser-restricted/.test(item.reason));
    $('issues').hidden = route !== 'tabs' || !(skipped.length || result?.limited);
    $('issues').textContent = skipped.length ? 'Skipped tabs' : 'Partial results';
    $('limit-detail').textContent = result?.limited ? 'A text, time, result or highlight limit was reached. Narrow the query or scope.' : '';
    $('issue-list').replaceChildren(...skipped.map(item => {
      const li = document.createElement('li'); li.textContent = `${item.title}: ${item.reason}`; return li;
    }));
  }
  function show(results) {
    list.setResults(results, current);
    $('empty').hidden = route !== 'tabs' || busy || results.length > 0 || !query.trim();
  }
  function cancel() {
    clearTimeout(timer); const seq = nextSequence();
    pendingOrder = null; navigated = false; if (rerankJob) { rerankJob = 0; reranker?.postMessage({ type: 'cancel' }); }
    if (flight) { flight = 0; send('SONAR_CANCEL', { sequence: seq - 1 }).catch(() => {}); }
    return seq;
  }
  // Earlier results stay in place until the new ones replace them.
  function schedule(delay = 140, refresh = false) {
    const token = cancel(); busy = true; $('list-viewport').setAttribute('aria-busy', true); tell('');
    // Ranked queries run in the panel's own index: no debounce is needed.
    if (!refresh && route === 'tabs' && indexer && core.ranked(query)) delay = 0;
    timer = setTimeout(() => search(token, refresh), delay);
  }
  async function search(token, refresh) {
    try {
      if (!origin) await useActive(false);
      if (token !== sequence || route !== 'tabs') return;
      const ranked = core.ranked(query);
      $('query').removeAttribute('aria-invalid');
      let response;
      if (ranked) response = await rankSearch(token, refresh);
      else {
        flight = token;
        response = await send('SONAR_SEARCH', { query, scope, sequence: token, originTabId: origin.id, refresh });
      }
      if (token !== sequence || route !== 'tabs') return;
      if (response.stale) throw new Error('This workspace was updated in another window. Search again.');
      result = response; busy = false; current = -1;
      result.results.forEach((item, id) => { item.id = id; });
      document.body.dataset.order = result.ranked ? 'ranked' : 'document';
      show(result.results); details();
      if (result.note) tell(result.note);
      if (focusOnResults) { focusOnResults = false; focusFirst(); }
      if (result.ranked) { issue(result); rerank(token); fillExcerpts(result); }
    } catch (error) {
      if (token !== sequence || route !== 'tabs') return;
      busy = false; result = null; current = -1; focusOnResults = false; show([]); $('empty').hidden = true; details();
      $('query').setAttribute('aria-invalid', 'true'); tell(error.message, true);
    } finally {
      if (flight === token) flight = 0;
      if (token === sequence) $('list-viewport').setAttribute('aria-busy', busy);
    }
  }
  // Tabs a search covers, in the broker's order: origin, then window and position.
  // One tabs query answers every scope (each browser round trip delays results).
  async function scopeTabs() {
    const all = await chrome.tabs.query({}), start = all.find(tab => tab.id === origin.id);
    if (!start) throw new Error(`No tab with id: ${origin.id}.`);
    if (Boolean(start.incognito) !== incognito) throw new Error('Cannot mix private and normal windows.');
    const tabs = scope === 'current' ? [start] : scope === 'group' ? all.filter(tab => start.groupId >= 0 && tab.groupId === start.groupId && tab.windowId === start.windowId) : all;
    return { start, tabs: tabs.filter(tab => Boolean(tab.incognito) === incognito).sort((a, b) => (b.id === start.id) - (a.id === start.id) || a.windowId - b.windowId || a.index - b.index) };
  }
  async function rankSearch(token, refresh) {
    if (!indexer) throw new Error('Ranked search is unavailable. Reload the extension.');
    const { start, tabs } = await scopeTabs();
    // Wait only for tabs never read yet; changed tabs are re-read in the background.
    const waiting = tabs.map(tab => want(tab.id, true, refresh)).filter((done, i) => refresh || !reads.get(tabs[i].id)?.revision);
    // Pages stop watching for changes after Close or 15 idle minutes; re-read (cheaply, by revision) first.
    if (contact && Date.now() - contact > 10 * 60_000) { for (const tab of tabs) if (reads.get(tab.id)?.state === 'ready') want(tab.id, false, true); }
    if (waiting.length) await Promise.all(waiting);
    if (token !== sequence) return { stale: true };
    const indexed = tabs.filter(tab => reads.get(tab.id)?.revision);
    const reply = await indexCall({ type: 'search', query, tabIds: indexed.map(tab => tab.id), depth: RERANK_DEPTH, window: RERANK_WINDOW, eager: RERANK_DEPTH });
    const skipped = tabs.filter(tab => !reads.get(tab.id)?.revision).map(tab => ({ title: String(tab.title || tab.url || `Tab ${tab.id}`).slice(0, 200),
      reason: reads.get(tab.id)?.reason || 'Still reading; search again when ready' }));
    const windows = new Map(tabs.map(tab => [tab.id, tab.windowId]));
    for (const item of reply.results) item.windowId = windows.get(item.tabId) ?? item.windowId;
    return { ranked: true, results: reply.results, passages: reply.passages, tag: reply.tag, searched: reply.searched, total: tabs.length, skipped, limited: reply.limited,
      sequence: token, note: scope === 'group' && start.groupId < 0 ? 'This tab is not in a tab group. No other ungrouped tabs were searched.' : '' };
  }
  // Excerpts of the rows past the first screenfuls arrive just after the list.
  function fillExcerpts(target) {
    const items = target.results.slice();
    indexCall({ type: 'excerpts', tag: target.tag }).then(({ excerpts }) => {
      for (const { position, ...excerpt } of excerpts) Object.assign(items[position], excerpt);
      if (result === target && excerpts.length) list.redraw();
    }, () => {});
  }
  // Issued handles for ranked results; jump and copy wait for them.
  function issue(target) {
    target.issued = send('SONAR_ISSUE', { sequence: target.sequence, scope, originTabId: origin.id, query,
      results: target.results.map(({ tabId, documentId, unit, hash }) => ({ tabId, documentId, unit, hash })) }).then(reply => {
      if (reply.stale) throw new Error('This workspace was updated in another window. Search again.');
      Object.assign(target, { session: reply.session, ticket: reply.ticket, origin: reply.origin });
    });
    target.issued.catch(() => {});
  }
  function indexCall(values) {
    const id = ++indexCalls;
    return new Promise((resolve, reject) => { indexWaiting.set(id, { resolve, reject }); indexer.postMessage({ ...values, id }); });
  }
  function startIndex() {
    try { indexer = new Worker('sonar-index.js'); } catch (_) { return; }
    indexer.onerror = () => {
      indexer?.terminate(); indexer = null; indexReady = false;
      for (const waiting of indexWaiting.values()) waiting.reject(new Error('Ranked search is unavailable. Reload the extension.'));
      indexWaiting.clear();
    };
    indexer.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        indexReady = true;
        (globalThis.requestIdleCallback || setTimeout)(() => readAll().catch(() => {}), { timeout: 300 });
        return;
      }
      const waiting = indexWaiting.get(data.id);
      if (!waiting) return;
      indexWaiting.delete(data.id);
      if (data.error) waiting.reject(new Error(data.error)); else waiting.resolve(data);
    };
  }
  // Streams every eligible tab into the index, origin first, four pages at a time.
  async function readAll() {
    if (!indexReady || !origin) return;
    const tabs = (await chrome.tabs.query({})).filter(tab => Boolean(tab.incognito) === incognito);
    const open = new Set(tabs.map(tab => tab.id));
    for (const tabId of reads.keys()) if (!open.has(tabId)) forget(tabId);
    tabs.sort((a, b) => (b.id === origin.id) - (a.id === origin.id) || (b.windowId === windowId) - (a.windowId === windowId) || a.windowId - b.windowId || a.index - b.index);
    await Promise.all(tabs.map(tab => want(tab.id)));
    warmReranker(); // After the tabs, so the model never competes with reading them.
  }
  // Queue a (re)read of one tab; resolves once it is indexed or skipped.
  function want(tabId, first = false, again = false) {
    let entry = reads.get(tabId);
    if (!entry) reads.set(tabId, entry = { state: 'new', revision: '' });
    if (again) entry.dirty = true;
    if (entry.state === 'queued' || entry.state === 'reading') {
      if (first && entry.state === 'queued') { readQueue.splice(readQueue.indexOf(tabId), 1); readQueue.unshift(tabId); }
      return entry.done;
    }
    if (entry.state !== 'new' && !entry.dirty) return Promise.resolve();
    entry.state = 'queued'; entry.dirty = false;
    entry.done = new Promise(resolve => { entry.settle = resolve; });
    if (first) readQueue.unshift(tabId); else readQueue.push(tabId);
    pump();
    return entry.done;
  }
  function pump() {
    while (reading < 4 && readQueue.length) {
      const tabId = readQueue.shift(), entry = reads.get(tabId);
      if (entry?.state !== 'queued') continue;
      entry.state = 'reading'; entry.dirty = false; reading++;
      readTab(tabId, entry).finally(() => { reading--; entry.settle(); pump(); });
    }
  }
  async function readTab(tabId, entry) {
    let page;
    try { [page] = (await send('SONAR_UNITS', { tabIds: [tabId], known: entry.revision ? { [tabId]: entry.revision } : {} })).pages; }
    catch (error) { page = { tabId, skipped: `Unavailable: ${error.message}` }; }
    contact = Date.now();
    if (reads.get(tabId) !== entry || !indexer) return;
    const used = [...reads.values()].reduce((sum, other) => sum + (other !== entry && other.revision ? other.characters : 0), 0);
    if (!page.skipped && !page.same && used + page.text.length > MAX_INDEX_CHARS) page = { tabId, skipped: 'Text budget; narrow the scope' };
    const changed = !page.skipped && !page.same;
    try {
      if (page.skipped) {
        if (entry.revision) indexer.postMessage({ type: 'drop', tabId });
        Object.assign(entry, { revision: '', reason: page.skipped });
      } else {
        const { text, paras, ...meta } = page;
        await indexCall(page.same ? { type: 'meta', meta } : { type: 'put', page });
        Object.assign(entry, { revision: page.revision, reason: '', title: page.title }, changed ? { characters: text.length } : {});
        if (origin?.id === tabId) labels();
      }
    } catch (error) { Object.assign(entry, { revision: '', reason: `Unavailable: ${error.message}` }); }
    entry.state = entry.revision ? 'ready' : 'skipped';
    // A ranked list that shows passages from the changed current tab searches it
    // again, unless the user is in the list; stale passages refuse to open.
    if (changed && entry.seen && result?.ranked && !busy && result.results.some(item => item.tabId === tabId) && scope === 'current' && route === 'tabs' && !inList()) schedule(0);
    entry.seen = true;
    if (entry.dirty) setTimeout(() => want(tabId), 1000); // Changed again while reading.
  }
  function forget(tabId) {
    const entry = reads.get(tabId);
    reads.delete(tabId);
    if (entry) indexer?.postMessage({ type: 'drop', tabId });
    entry?.settle?.();
  }
  // A tab that navigates is dropped at once; one that finishes loading or
  // changes its text is read again.
  chrome.tabs.onUpdated?.addListener((tabId, change) => {
    if (!indexReady) return;
    if (change.status === 'loading') { forget(tabId); return; }
    if (change.status === 'complete' || change.url !== undefined || change.discarded === false || change.frozen === false) want(tabId, false, true);
  });
  chrome.tabs.onRemoved?.addListener(tabId => forget(tabId));
  chrome.tabs.onReplaced?.addListener((added, removed) => { forget(removed); if (indexReady) want(added); });
  async function useActive(run = true) {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (!tab) throw new Error('No active tab is available.');
    origin = { id: tab.id, windowId: tab.windowId, title: tab.title || 'Current browser tab', url: tab.url || '', incognito: Boolean(tab.incognito) };
    labels(); if (run) schedule(0, true);
  }
  function switchRoute(next) {
    if (route === next) { $('query').focus(); return; }
    cancel(); busy = false; focusOnResults = false;
    if (route === 'tabs') query = $('query').value; else canliiQuery = $('query').value;
    route = next; $('query').value = route === 'tabs' ? query : canliiQuery;
    $('query').removeAttribute('aria-invalid'); tell(''); labels(); details(); show(result?.results || []);
    $('query').focus({ preventScroll: true }); $('query').select();
  }
  // Selecting never moves the browser; only Open (or Enter on a result) does.
  // The copy buttons copy that result, as its hotkeys do.
  function choose(index, action = '', byUser = true) {
    if (route !== 'tabs' || !result?.results[index]) return;
    if (byUser) navigated = true;
    current = index; list.select(index);
    if (action === 'open') visit(); else if (action) copyPassage(action);
  }
  // Enter in the search box: keyboard focus on the first result, nothing opened.
  function focusFirst() {
    if (busy) { focusOnResults = true; return; }
    if (!result?.results.length) return;
    $('list-viewport').focus({ preventScroll: true }); choose(0, '', false);
  }
  // The model loads in idle time and is released after a few idle minutes.
  function warmReranker() {
    if (reranker || rerankUnavailable) return;
    try { reranker = new Worker('rerank-worker.js', { type: 'module' }); }
    catch (_) { rerankUnavailable = true; return; }
    reranker.onerror = () => { rerankUnavailable = true; reranker.terminate(); reranker = null; rerankJob = 0; };
    reranker.postMessage({ type: 'warm' });
    idleRelease();
  }
  function idleRelease() {
    clearTimeout(rerankIdle);
    rerankIdle = setTimeout(() => { if (!rerankJob) { reranker?.terminate(); reranker = null; } else idleRelease(); }, RERANK_IDLE);
  }
  function rerank(token) {
    const expected = result, passages = result.passages;
    if (rerankUnavailable || !passages || passages.length < 2 || LegalPinpointerRerankCore.looksFrench(query)) return;
    warmReranker();
    if (!reranker) return;
    idleRelease();
    const base = result.results.slice(), job = rerankJob = token;
    reranker.onmessage = ({ data }) => {
      if (data.type === 'unavailable') { rerankUnavailable = true; reranker?.terminate(); reranker = null; rerankJob = 0; return; }
      if (data.job !== job || rerankJob !== job || result !== expected) return;
      if (data.type === 'failed') { rerankJob = 0; return; }
      if (data.type !== 'scores') return;
      rerankJob = 0;
      // Scored passages by cross-encoder score; the rest keep BM25 order after them.
      const scores = new Map(data.scores), scored = base.filter(item => scores.has(item.id)).sort((a, b) => scores.get(b.id) - scores.get(a.id));
      pendingOrder = [...scored, ...base.filter(item => !scores.has(item.id))];
      applyOrder();
    };
    reranker.postMessage({ type: 'score', job, query, passages, maxLength: RERANK_TOKENS });
  }
  // A first result focused from the search box stays first: the best one after reordering.
  function applyOrder() {
    if (!pendingOrder || navigated || pointerInList || busy || !result) return;
    const order = pendingOrder;
    result.results = order; pendingOrder = null; current = current >= 0 ? 0 : -1;
    show(result.results);
    document.body.dataset.order = 'reranked';
  }
  $('list-viewport').addEventListener('pointerenter', () => { pointerInList = true; });
  $('list-viewport').addEventListener('pointerleave', () => { pointerInList = false; applyOrder(); });
  function snapshot() {
    const { issued, passages, ...transfer } = result;
    return { workspace, origin, query, canliiQuery, scope, sequence, result: transfer, current, scrollTop: list.viewport.scrollTop };
  }
  async function visit() {
    if (busy || opening || result?.stale || route !== 'tabs' || current < 0 || !result) return;
    const destination = result.results[current].windowId;
    // Cross-window sidePanel.open must remain in this click/key gesture; never
    // defer it until after tab activation or a service-worker response.
    const panelOpen = destination === windowId ? Promise.resolve() : chrome.sidePanel.open({ windowId: destination });
    opening = true; const token = sequence, target = result, id = result.results[current].id;
    try {
      await panelOpen;
      await target.issued;
      if (destination !== windowId) await chrome.storage.session.set({ [`sonar-launch:${destination}`]: {
        nonce: crypto.randomUUID(), created: Date.now(), route: 'tabs', origin, handoff: snapshot()
      } });
      await send('SONAR_GO', { session: target.session, ticket: target.ticket, id });
    } catch (error) { if (token === sequence) tell(error.message, true); }
    finally { opening = false; }
  }
  // The clipboard write starts inside the click/key gesture; its contents resolve
  // once the source tab has built them with Pinpointer's formatting.
  async function copyPassage(mode) {
    if (busy || result?.stale || route !== 'tabs' || current < 0 || !result) return;
    const token = sequence, target = result, id = result.results[current].id;
    const request = Promise.resolve(target.issued).then(() => send('SONAR_COPY', { session: target.session, ticket: target.ticket, id, mode }));
    const blob = type => request.then(reply => new Blob([type === 'text/html' ? reply.html : reply.plain], { type }));
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob('text/plain'), 'text/html': blob('text/html') })]);
      const { plain } = await request;
      if (token === sequence) tell(`Copied: ${plain.length > 90 ? `${plain.slice(0, 90)}…` : plain}`);
    } catch (error) {
      const reason = await request.then(() => error, failure => failure);
      if (token === sequence) tell(reason.message || 'Could not copy.', true);
    }
  }
  async function externalSearch() {
    if (opening) return;
    canliiQuery = $('query').value;
    if (!canliiQuery.trim()) { $('query').focus(); return; }
    opening = true;
    try { await send('SONAR_CANLII_SEARCH', { query: canliiQuery, windowId }); close(); }
    catch (error) { tell(error.message, true); }
    finally { opening = false; }
  }
  // Escape and a CanLII search close the panel; page caches are released first
  // (they also have a bounded lifetime).
  function close() {
    void send('SONAR_CLOSE', { sequence: cancel() }).catch(() => {});
    // sidePanel.close is Chrome 141+; earlier, a side panel page may close itself.
    Promise.resolve().then(() => chrome.sidePanel.close({ windowId })).catch(() => globalThis.close());
  }
  async function consumeLaunch(launch) {
    if (!launch || launch.nonce === nonce || Date.now() - launch.created > 60_000) return;
    nonce = launch.nonce;
    const transfer = launch.handoff;
    if (transfer && launch.origin?.incognito === incognito && transfer.result?.results?.length <= 1000) {
      cancel(); workspace = transfer.workspace; origin = transfer.origin; query = transfer.query; canliiQuery = transfer.canliiQuery || '';
      scope = transfer.scope; sequence = Math.max(sequence, transfer.sequence + 2); result = transfer.result;
      current = transfer.current; route = 'tabs'; busy = false; $('query').value = query;
      labels(); list.setResults(result.results, current, transfer.scrollTop); $('empty').hidden = true; details();
    } else {
      const changed = origin?.id !== launch.origin?.id;
      if (!origin || (launch.route === 'tabs' && changed)) origin = launch.origin;
      switchRoute(launch.route === 'canlii' ? 'canlii' : 'tabs'); labels();
      if (route === 'tabs' && changed && query.trim()) schedule(0);
    }
    $('query').focus({ preventScroll: true }); $('query').select();
    const latest = (await chrome.storage.session.get(launchKey))[launchKey];
    if (latest?.nonce === nonce) await chrome.storage.session.remove(launchKey);
  }
  $('query').addEventListener('input', event => {
    focusOnResults = false;
    if (route === 'canlii') { canliiQuery = $('query').value; tell(''); return; }
    query = $('query').value; if (!event.isComposing) schedule();
  });
  $('query').addEventListener('compositionend', () => { if (route === 'tabs') { query = $('query').value; schedule(); } });
  $('search-form').addEventListener('submit', event => { event.preventDefault(); if (route === 'canlii') externalSearch(); else focusFirst(); });
  $('scope').onclick = event => {
    const next = event.target.closest('[data-scope]')?.dataset.scope;
    if (next && next !== scope) { scope = next; labels(); schedule(0); }
  };
  // The operator table shows while the pointer is on ?, and stays once ? is clicked.
  let hovering = false;
  const operators = $('operators'), help = $('help');
  help.addEventListener('pointerenter', () => { if (!operators.matches(':popover-open')) { hovering = true; operators.showPopover({ source: help }); } });
  for (const element of [help, operators]) element.addEventListener('pointerleave', () => setTimeout(() => {
    if (hovering && !help.matches(':hover') && !operators.matches(':hover')) { hovering = false; operators.hidePopover(); }
  }));
  // Pressing ? may light-dismiss the table before the click, so the click acts
  // on what was showing at pointerdown: a pinned table closes, anything else pins.
  let pinnedAtPress = false;
  help.addEventListener('pointerdown', () => { pinnedAtPress = operators.matches(':popover-open') && !hovering; });
  help.onclick = event => {
    const pinned = event.detail ? pinnedAtPress : operators.matches(':popover-open') && !hovering;
    hovering = false;
    if (pinned) operators.hidePopover(); else if (!operators.matches(':popover-open')) operators.showPopover({ source: help });
  };
  // Tab order: search box, then the results, then the other controls; Shift+Tab reverses it.
  function focusOrder() {
    const elements = [...document.querySelectorAll('input,button,[tabindex="0"]')].filter(el => el.tabIndex >= 0 && !el.disabled &&
      !el.closest('[hidden],[popover]') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const listAt = elements.indexOf($('list-viewport'));
    if (listAt >= 0) {
      elements.splice(listAt, 1);
      if (result?.results.length) elements.splice(elements.indexOf($('query')) + 1, 0, $('list-viewport'));
    }
    return elements;
  }
  $('tabs-route').onclick = () => switchRoute('tabs'); $('canlii-route').onclick = () => switchRoute('canlii');
  $('use-active').onclick = () => useActive().catch(error => tell(error.message, true));
  $('issues').onclick = () => $('issue-popover').showPopover();
  document.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      if (document.querySelector(':popover-open')) return; // Escape closes the popover first.
      event.preventDefault(); close();
    } else if ((event.key === 'Tab' || event.key === 'F6') && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const elements = focusOrder(), at = elements.indexOf(document.activeElement);
      const next = elements[(at + (event.shiftKey ? -1 : 1) + elements.length) % elements.length];
      if (next === $('list-viewport')) { if (current < 0) focusFirst(); else next.focus({ preventScroll: true }); } else next?.focus();
    } else if (route === 'tabs' && inList() && event.code === 'KeyX' && !event.metaKey && (event.ctrlKey !== event.altKey)) {
      // Pinpointer's shortcuts on the focused passage: Ctrl+X pinpoint, Ctrl+Shift+X quote, Alt+X citation.
      event.preventDefault(); copyPassage(event.altKey ? 'citation' : event.shiftKey ? 'quote' : 'pinpoint');
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    if (changes[launchKey]?.newValue) consumeLaunch(changes[launchKey].newValue).catch(error => tell(error.message, true));
    const state = changes[`pinpointer-sonar:workspace:${workspace}`];
    // This panel's own ranked handles arrive after its list is shown.
    if (state && result && !busy && !(result.ranked && state.newValue?.sequence === result.sequence) &&
        (!state.newValue || state.newValue.ticket !== result.ticket || state.newValue.sequence > sequence)) {
      result.stale = true; tell('This search changed in another window. Search again.', true);
    }
  });
  chrome.runtime.onMessage.addListener((change, sender) => {
    if (sender.id !== chrome.runtime.id || change?.type !== 'SONAR_INVALIDATED') return;
    if (change.workspace === workspace && Number.isInteger(sender.tab?.id) && indexReady) setTimeout(() => want(sender.tab.id, false, true), 250);
    if (change.ticket !== result?.ticket || result?.ranked) return;
    if (scope === 'current' && route === 'tabs' && !inList()) schedule(220);
  });
  labels();
  const launch = (await chrome.storage.session.get(launchKey))[launchKey];
  if (launch) await consumeLaunch(launch);
  if (!origin) await useActive(false);
  startIndex();
  $('query').focus({ preventScroll: true });
})().catch(error => {
  document.getElementById('notice').textContent = error.message;
});
