'use strict';

(async function startWorkspace() {
  const $ = id => document.getElementById(id), core = LegalPinpointerFindCore;
  const scopeNames = ['Current tab', 'All tabs', 'Current tab group'], scopes = ['current', 'all', 'group'];
  const window = await chrome.windows.getCurrent(), windowId = window.id, incognito = Boolean(window.incognito);
  const launchKey = `sonar-launch:${windowId}`;
  let workspace = crypto.randomUUID(), origin = null, route = 'tabs', mode = 'p', scope = 'current';
  let query = '', canliiQuery = '', result = null, current = -1, sequence = Date.now();
  let desiredPreview = null, previewing = false;
  let timer = 0, flight = 0, busy = false, opening = false, nonce = '', wheelAt = 0, scrubbing = false;
  const list = new LegalPinpointerResults.ResultsList($('list-viewport'), $('result-spacer'), $('result-rows'), (index, open) => choose(index, open));
  function nextSequence() { sequence = Math.max(sequence + 2, Date.now()); return sequence; }
  function tell(text, error = false) { $('notice').textContent = text; $('notice').title = text; $('notice').classList.toggle('error', error); }
  function status(summary, detail) { $('summary').textContent = summary; $('detail').textContent = detail; $('detail').title = detail; }
  function message(type, values = {}) {
    return { type, workspace, incognito, ...values };
  }
  async function send(type, values) {
    const reply = await chrome.runtime.sendMessage(message(type, values));
    if (!reply?.ok) throw new Error(reply?.message || 'Pinpointer is unavailable. Reload the extension.');
    return reply;
  }
  function controls() {
    const ready = route === 'tabs' && !busy && !result?.stale && current >= 0 && Boolean(result?.results[current]);
    for (const id of ['previous', 'next', 'open', 'back', 'copy-quote', 'copy-pinpoint', 'copy-link']) $(id).disabled = !ready;
    $('list-viewport').setAttribute('aria-busy', busy); $('list-viewport').inert = busy || Boolean(result?.stale);
  }
  function labels() {
    document.body.dataset.route = route;
    $('tabs-route').setAttribute('aria-pressed', route === 'tabs'); $('canlii-route').setAttribute('aria-pressed', route === 'canlii');
    $('privacy').textContent = route === 'tabs' ? 'ON DEVICE' : 'CANLII.ORG';
    $('mode').textContent = route === 'tabs' ? `/${mode}` : '↗';
    $('mode').title = route === 'tabs' ? `Same ${mode === 'p' ? 'paragraph' : 'sentence'}; Tab switches proximity` : 'Search CanLII document text';
    $('mode').setAttribute('aria-label', $('mode').title);
    $('scope').textContent = route === 'tabs' ? scopeNames[scopes.indexOf(scope)] : 'Document text';
    $('scope').disabled = route !== 'tabs'; $('use-active').style.visibility = route === 'tabs' ? 'visible' : 'hidden';
    $('refresh').style.visibility = route === 'tabs' ? 'visible' : 'hidden';
    $('query').placeholder = route === 'tabs' ? 'Find terms together…' : 'Search CanLII document text…';
    $('query').maxLength = route === 'tabs' ? 1024 : 4096;
    document.querySelector('label[for=query]').textContent = route === 'tabs' ? 'Find terms in open tabs' : 'Search CanLII document text';
    $('origin').textContent = route === 'tabs' ? `From ${origin?.title || 'the active tab'}` : 'Enter opens results on CanLII in a new tab.';
    $('origin').title = route === 'tabs' ? (origin?.title || '') : 'This searches CanLII, not the current page.';
    const help = $('keyboard-help').querySelectorAll('span');
    help[0].textContent = route === 'tabs' ? 'Tab: proximity · Shift+Tab: scope' : 'Enter: search CanLII document text';
    help[1].textContent = route === 'tabs' ? 'Enter: next · Ctrl+Enter: open · F6: controls' : 'Alt+Shift+C: open from any browser tab';
    controls();
  }
  function empty(title, detail) {
    const host = $('empty'); host.replaceChildren();
    const heading = document.createElement('h2'); heading.textContent = title;
    const paragraph = document.createElement('p'); paragraph.textContent = detail;
    host.append(heading, paragraph); host.hidden = false;
    if (route === 'canlii') {
      const button = document.createElement('button'); button.textContent = 'Search CanLII ↗'; button.className = 'primary'; button.onclick = externalSearch; host.append(button);
    }
  }
  function details() {
    $('issues').hidden = route !== 'tabs' || !(result?.skipped?.length || result?.limited);
    $('issue-list').replaceChildren();
    $('limit-detail').textContent = result?.limited ? 'Partial results: a text, time, result or highlight limit was reached. Narrow the query or search scope to inspect the rest.' : '';
    for (const item of result?.skipped || []) {
      const li = document.createElement('li'); li.textContent = `${item.title}: ${item.reason}`; $('issue-list').append(li);
    }
  }
  function resultStatus() {
    if (!result) { status('Ready to search', 'Loaded page text only. Nothing leaves your browser.'); return; }
    const count = result.results.length;
    status(`${count.toLocaleString()}${result.limited ? '+' : ''} matching ${mode === 'p' ? 'paragraphs' : 'sentences'}`,
      `${result.searched}/${result.total} tabs searched${result.skipped.length ? ` · ${result.skipped.length} skipped` : ''}${result.limited ? ' · Partial' : ''}`);
    if (result.note) tell(result.note);
  }
  function preview() {
    const selected = route === 'tabs' && result?.results[current];
    $('counter').textContent = selected ? `${current + 1} / ${result.results.length}` : '—';
    $('preview-source').textContent = selected ? `${selected.title}${selected.locator ? ` · ${selected.locator}` : ''}` : '';
    const text = $('preview-text'); text.replaceChildren(); text.scrollTop = 0;
    if (selected) {
      if (selected.leading) text.append('…'); text.append(LegalPinpointerResults.markedText(document, selected.preview, selected.marks)); if (selected.trailing) text.append('…');
    } else text.textContent = route === 'tabs'
      ? 'Select a match to inspect the excerpt. Your search and results stay here when you open its source.'
      : 'Only the query you submit is sent to CanLII. Open-tab searches and their excerpts stay local.';
    controls();
    if (selected && scope === 'current' && !busy && !result.stale) {
      desiredPreview = { token: sequence, session: result.session, ticket: result.ticket, id: current };
      if (!previewing) drainPreview();
    }
  }
  async function drainPreview() {
    previewing = true;
    while (desiredPreview) {
      const selected = desiredPreview; desiredPreview = null;
      try { await send('SONAR_PREVIEW', selected); }
      catch (error) { if (selected.token === sequence && selected.id === current) tell(error.message, true); }
    }
    previewing = false;
  }
  function cancel() {
    desiredPreview = null; clearTimeout(timer); const seq = nextSequence();
    if (flight) { flight = 0; send('SONAR_CANCEL', { sequence: seq - 1 }).catch(() => {}); }
    scrubbing = false;
    return seq;
  }
  function schedule(delay = 140, refresh = false) {
    const token = cancel(); busy = true; controls(); tell('');
    status('Searching…', 'Your query and results stay in place.');
    timer = setTimeout(() => search(token, refresh), delay);
  }
  async function search(token, refresh) {
    try {
      if (!origin) await useActive(false);
      if (token !== sequence || route !== 'tabs') return;
      const compiled = core.compile(query, mode); mode = compiled.mode; labels();
      $('query').removeAttribute('aria-invalid'); flight = token;
      const response = await send('SONAR_SEARCH', { query, mode, scope, sequence: token, originTabId: origin.id, refresh });
      if (token !== sequence || route !== 'tabs') return;
      if (response.stale) throw new Error('This workspace was updated in another window. Search again.');
      result = response; busy = false; current = result.results.length ? 0 : -1;
      list.setResults(result.results, current); $('result-spacer').hidden = false;
      $('empty').hidden = Boolean(result.results.length);
      if (!result.results.length) empty(query.trim() ? 'No matching passages' : 'Find the passage, not just the tab.',
        query.trim() ? 'Try broader terms or a different scope. Skipped pages are listed in Details.' : 'Type words or quoted phrases. Tab switches paragraph and sentence proximity.');
      resultStatus(); details(); preview();
    } catch (error) {
      if (token !== sequence || route !== 'tabs') return;
      busy = false; result = null; current = -1; list.setResults([], -1); details(); preview();
      $('query').setAttribute('aria-invalid', 'true');
      status('Search could not finish', 'Your page and selection have not been changed.'); tell(error.message, true);
      empty('Search needs attention', error.message);
    } finally { if (flight === token) flight = 0; }
  }
  async function useActive(run = true) {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (!tab) throw new Error('No active tab is available.');
    origin = { id: tab.id, windowId: tab.windowId, title: tab.title || 'Current browser tab', url: tab.url || '', incognito: Boolean(tab.incognito) };
    labels(); if (run) schedule(0, true);
  }
  function switchRoute(next) {
    if (route === next) { $('query').focus(); return; }
    cancel(); busy = false;
    if (route === 'tabs') query = $('query').value; else canliiQuery = $('query').value;
    route = next; $('query').value = route === 'tabs' ? query : canliiQuery;
    $('query').removeAttribute('aria-invalid'); tell(''); labels(); details(); preview();
    $('result-spacer').hidden = route === 'canlii';
    if (route === 'canlii') {
      status('CanLII document text', 'Nothing is sent until you submit.');
      empty('Search CanLII from here', 'Search the text of cases, legislation and commentary. This is separate from your open-tab search.');
    } else {
      resultStatus(); $('empty').hidden = Boolean(result?.results.length);
      if (!result?.results.length) empty('Find the passage, not just the tab.', 'Type words or quoted phrases. Tab switches proximity; Shift+Tab switches scope.');
    }
    $('query').focus({ preventScroll: true }); $('query').select();
  }
  function choose(index, open = false) {
    if (busy || result?.stale || route !== 'tabs' || !result?.results[index]) return;
    current = index; list.select(index, !open); preview();
    if (open) visit(false);
  }
  function move(delta) {
    if (busy || !result?.results.length) return;
    choose((current + delta + result.results.length) % result.results.length);
  }
  function snapshot() {
    return { workspace, origin, query, canliiQuery, mode, scope, sequence, result, current, scrollTop: list.viewport.scrollTop };
  }
  async function visit(back) {
    if (busy || opening || result?.stale || route !== 'tabs' || current < 0 || !result) return;
    const destination = back ? origin.windowId : result.results[current].windowId;
    // Cross-window sidePanel.open must remain in this click/key gesture; never
    // defer it until after tab activation or a service-worker response.
    const panelOpen = destination === windowId ? Promise.resolve() : chrome.sidePanel.open({ windowId: destination });
    opening = true; const token = sequence;
    try {
      await panelOpen;
      if (destination !== windowId) await chrome.storage.session.set({ [`sonar-launch:${destination}`]: {
        nonce: crypto.randomUUID(), created: Date.now(), route: 'tabs', origin, handoff: snapshot()
      } });
      await send(back ? 'SONAR_BACK' : 'SONAR_GO', { session: result.session, ticket: result.ticket, id: current });
      if (token === sequence) tell(back ? 'Returned to the starting tab.' : 'Opened the exact passage. Results stay here.');
    } catch (error) { if (token === sequence) tell(error.message, true); }
    finally { opening = false; }
  }
  // The clipboard write starts inside the click/key gesture; its contents
  // resolve once the source tab has built them with Pinpointer's formatting.
  async function copyPassage(mode) {
    if (busy || result?.stale || route !== 'tabs' || current < 0 || !result) return;
    const token = sequence, request = send('SONAR_COPY', { session: result.session, ticket: result.ticket, id: current, mode });
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
  async function externalSearch(event) {
    event?.preventDefault(); if (opening) return;
    canliiQuery = $('query').value;
    if (!canliiQuery.trim()) { tell('Enter a document-text query.', true); $('query').focus(); return; }
    opening = true;
    try {
      await send('SONAR_CANLII_SEARCH', { query: canliiQuery, windowId });
      tell('Opened CanLII results in a new tab.');
    } catch (error) { tell(error.message, true); }
    finally { opening = false; }
  }
  async function clear() {
    const seq = cancel();
    if (route === 'canlii') { canliiQuery = ''; $('query').value = ''; tell(''); $('query').focus(); return; }
    busy = false; query = ''; $('query').value = ''; result = null; current = -1;
    list.setResults([], -1); details(); preview(); resultStatus(); tell('');
    empty('Find the passage, not just the tab.', 'Type words or quoted phrases. Search stays local.');
    try { await send('SONAR_CLOSE', { sequence: seq }); } catch (_) { /* Page caches also have a bounded lifetime. */ }
    $('query').focus();
  }
  async function consumeLaunch(launch) {
    if (!launch || launch.nonce === nonce || Date.now() - launch.created > 60_000) return;
    nonce = launch.nonce;
    const transfer = launch.handoff;
    if (transfer && launch.origin?.incognito === incognito && transfer.result?.results?.length <= 1000) {
      cancel(); workspace = transfer.workspace; origin = transfer.origin; query = transfer.query; canliiQuery = transfer.canliiQuery || '';
      mode = transfer.mode; scope = transfer.scope; sequence = Math.max(sequence, transfer.sequence + 2); result = transfer.result;
      current = transfer.current; route = 'tabs'; busy = false; $('query').value = query;
      labels(); list.setResults(result.results, current, transfer.scrollTop); $('result-spacer').hidden = false;
      $('empty').hidden = Boolean(result.results.length); resultStatus(); details(); preview(); tell('Continued from the other window.');
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
    if (route === 'canlii') { canliiQuery = $('query').value; tell(''); return; }
    query = $('query').value; if (!event.isComposing) schedule();
  });
  $('query').addEventListener('compositionend', () => { if (route === 'tabs') { query = $('query').value; schedule(); } });
  $('search-form').addEventListener('submit', event => { event.preventDefault(); if (route === 'canlii') externalSearch(); else move(1); });
  function modeCycle() { mode = mode === 'p' ? 's' : 'p'; query = core.switchScope(query, mode); $('query').value = query; labels(); schedule(0); $('query').focus(); }
  function scopeCycle() { scope = scopes[(scopes.indexOf(scope) + 1) % scopes.length]; labels(); schedule(0); $('query').focus(); }
  $('mode').onclick = () => route === 'canlii' ? externalSearch() : modeCycle();
  $('scope').onclick = scopeCycle;
  $('tabs-route').onclick = () => switchRoute('tabs'); $('canlii-route').onclick = () => switchRoute('canlii');
  $('use-active').onclick = () => useActive().catch(error => tell(error.message, true));
  $('refresh').onclick = () => schedule(0, true);
  $('previous').onclick = () => move(-1); $('next').onclick = () => move(1);
  $('copy-quote').onclick = () => copyPassage('quote'); $('copy-pinpoint').onclick = () => copyPassage('pinpoint');
  $('copy-link').onclick = () => copyPassage('link');
  $('open').onclick = () => visit(false); $('back').onclick = () => visit(true); $('clear').onclick = clear;
  $('issues').onclick = () => $('issue-popover').showPopover();
  document.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      if ($('issue-popover').matches(':popover-open')) return;
      event.preventDefault(); clear().finally(() => chrome.sidePanel.close?.({ windowId }).catch(() => {}));
    } else if (event.key === 'Tab' && route === 'tabs' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault(); event.shiftKey ? scopeCycle() : modeCycle();
    } else if (event.key === 'Enter' && event.target === $('query')) {
      event.preventDefault(); if (route === 'canlii') externalSearch(); else if (event.ctrlKey) visit(false); else move(event.shiftKey ? -1 : 1);
    } else if (route === 'tabs' && event.code === 'KeyX' && !event.metaKey && (event.ctrlKey !== event.altKey)) {
      // Pinpointer's shortcuts: Ctrl+X pinpoint, Ctrl+Shift+X quote, Alt+X citation.
      // A text selection in the query keeps its native cut.
      const input = $('query');
      if (event.ctrlKey && !event.shiftKey && document.activeElement === input && input.selectionStart !== input.selectionEnd) return;
      event.preventDefault(); copyPassage(event.altKey ? 'citation' : event.shiftKey ? 'quote' : 'pinpoint');
    } else if (event.key === 'F6') {
      event.preventDefault(); const elements = Array.from(document.querySelectorAll('input,button,[tabindex="0"]')).filter(el => !el.disabled && !el.hidden && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
      const at = elements.indexOf(document.activeElement); elements[(at + (event.shiftKey ? -1 : 1) + elements.length) % elements.length]?.focus();
    } else if (event.key === 'Alt' && route === 'tabs') document.addEventListener('wheel', scrub, { passive: false });
  });
  function scrub(event) {
    if (!event.altKey || event.ctrlKey || busy || !result?.results.length || !event.deltaY) return;
    event.preventDefault(); if (performance.now() - wheelAt < 85) return;
    wheelAt = performance.now(); scrubbing = true; move(event.deltaY > 0 ? 1 : -1);
  }
  document.addEventListener('keyup', event => {
    if (event.key !== 'Alt') return;
    document.removeEventListener('wheel', scrub);
    if (scrubbing) { event.preventDefault(); scrubbing = false; visit(false); }
  });
  globalThis.addEventListener('blur', () => { scrubbing = false; document.removeEventListener('wheel', scrub); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    if (changes[launchKey]?.newValue) consumeLaunch(changes[launchKey].newValue).catch(error => tell(error.message, true));
    const state = changes[`pinpointer-sonar:workspace:${workspace}`];
    if (state && result && !busy && (!state.newValue || state.newValue.ticket !== result.ticket || state.newValue.sequence > sequence)) {
      result.stale = true; controls(); tell('Search changed in another window. Refresh to search again.');
    }
  });
  chrome.runtime.onMessage.addListener((change, sender) => {
    if (sender.id !== chrome.runtime.id || change?.type !== 'SONAR_INVALIDATED' || change.ticket !== result?.ticket) return;
    if (scope === 'current' && route === 'tabs') schedule(220);
    else tell('A source changed. Refresh to update the results.');
  });
  labels(); preview();
  const launch = (await chrome.storage.session.get(launchKey))[launchKey];
  if (launch) await consumeLaunch(launch);
  if (!origin) await useActive(false);
  $('query').focus({ preventScroll: true });
})().catch(error => {
  document.getElementById('summary').textContent = 'Could not open the workspace';
  document.getElementById('notice').textContent = error.message;
});
