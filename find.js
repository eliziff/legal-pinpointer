'use strict';

(function installSonarUI(global) {
  if (global.LegalPinpointerFind) return;
  const core = global.LegalPinpointerFindCore, page = global.LegalPinpointerSearchPage;
  const scopes = ['current', 'all', 'group'], labels = ['Current tab', 'All tabs', 'Current tab group'];
  let host, shadow, input, status, modeButton, scopeButton, preview, title, counter, openButton, skipped, controls;
  let opened = false, mode = 'p', scope = 'current', query = '', result = null, current = -1;
  let sequence = Date.now(), timer = 0, busy = false, scrubbing = false, lastWheel = 0, focusBefore, flight = 0, opening = false;
  const css = `
    :host {color-scheme:light dark} * {box-sizing:border-box}
    section {width:min(580px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;
      padding:14px;background:#fff;color:#172e28;border:1px solid #cad6d0;border-radius:13px;
      box-shadow:0 12px 45px #152c3035;font:13px/1.5 system-ui,sans-serif;text-align:left}
    header,.row,footer {display:flex;align-items:center;gap:7px} header {margin-bottom:9px}
    strong {flex:1;letter-spacing:.2px} input {min-width:0;flex:1;padding:9px 10px;font:15px system-ui;
      border:1px solid #9cafa5;border-radius:7px;background:#fff;color:#142d25}
    button {font:inherit;cursor:pointer;border:0;border-radius:6px;padding:7px 10px;background:#edf3ef;color:#175749}
    button:hover {background:#dae9e1} button:disabled {opacity:.45;cursor:default}
    :focus-visible {outline:2px solid #1d8067;outline-offset:2px} #mode {font-weight:750;min-width:41px}
    #status {margin:9px 0 4px;font-size:12px} .error {color:#a32222} #preview {margin:10px 0;
      border-top:1px solid #dce5df;padding-top:10px} #title {font-weight:650;overflow-wrap:anywhere}
    blockquote {font:15px/1.65 Georgia,serif;margin:8px 0 12px;white-space:pre-wrap;overflow-wrap:anywhere;
      max-height:210px;overflow:auto} mark {background:#ffdf86;color:#332600}
    footer {justify-content:space-between} #help,summary {font-size:11px;color:#566d62}
    #help {margin:9px 0 0;white-space:pre-line} details {margin-top:5px} ul {padding-left:18px;font-size:12px}
    [hidden] {display:none!important}
    @media(prefers-color-scheme:dark) {section {background:#142920;color:#eaf4ee;border-color:#496455}
      input {background:#0c1c15;color:#ecf6ee;border-color:#597364} button {background:#294939;color:#e2f7e9}
      button:hover {background:#365f49} #help,summary {color:#b8cbbb} .error {color:#ffbbb0}}
    @media(forced-colors:active) {section,input,button {border:1px solid CanvasText} }
  `;
  function make(tag, text = '', attrs = {}) {
    const node = document.createElement(tag); node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }
  function setup() {
    host = make('div', '', { 'data-pinpointer-sonar': '', popover: 'manual' });
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:12px 12px auto auto!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;z-index:2147483647!important;overflow:visible!important';
    shadow = host.attachShadow({ mode: 'closed' }); const sheet = new CSSStyleSheet(); sheet.replaceSync(css); shadow.adoptedStyleSheets = [sheet];
    const panel = make('section', '', { role: 'dialog', 'aria-label': 'Tab Sonar find in page', 'aria-modal': 'false' });
    const header = make('header'), dismiss = make('button', '×', { type: 'button', 'aria-label': 'Close (Escape)' });
    scopeButton = make('button', '', { type: 'button', id: 'scope' });
    header.append(make('strong', 'Tab Sonar'), scopeButton, dismiss);
    input = make('input', '', { id: 'query', type: 'text', placeholder: 'privileg* waiv*', autocomplete: 'off',
      spellcheck: 'false', maxlength: '1024', 'aria-label': 'Search words or quoted phrases', 'aria-describedby': 'status help' });
    modeButton = make('button', '/p', { type: 'button', id: 'mode' });
    const previous = make('button', '↑', { type: 'button', 'aria-label': 'Previous match (Shift+Enter)' });
    const next = make('button', '↓', { type: 'button', 'aria-label': 'Next match (Enter)' });
    const row = make('div', '', { class: 'row' }); row.append(input, modeButton, previous, next);
    status = make('p', '', { id: 'status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    skipped = make('details');
    preview = make('div', '', { id: 'preview', hidden: '' }); title = make('div', '', { id: 'title' });
    const quote = make('blockquote', '', { id: 'quote' }); counter = make('span');
    openButton = make('button', 'Open passage ↵', { type: 'button', id: 'open', title: 'Ctrl+Enter opens the selected passage' });
    const footer = make('footer'); footer.append(counter, openButton); preview.append(title, quote, footer);
    const refresh = make('button', 'Refresh', { type: 'button', title: 'Re-read open tabs and group membership' });
    const help = make('p', 'Tab: /p ↔ /s · Shift+Tab: scope · Enter: next · Ctrl+Enter: open\nAlt+wheel: preview; release Alt to open · F6: controls · Esc: close', { id: 'help' });
    panel.append(header, row, status, skipped, preview, refresh, help); shadow.append(panel);
    controls = [input, modeButton, scopeButton, previous, next, openButton, refresh, dismiss];
    dismiss.onclick = close; modeButton.onclick = toggleMode; scopeButton.onclick = toggleScope;
    previous.onclick = () => move(-1); next.onclick = () => move(1); openButton.onclick = openSelected;
    refresh.onclick = () => schedule(0, true); input.oninput = () => { query = input.value; schedule(); };
  }
  function label() {
    modeButton.textContent = `/${mode}`; modeButton.title = `Same ${mode === 'p' ? 'paragraph' : 'sentence'} (Tab to switch)`;
    modeButton.setAttribute('aria-label', modeButton.title);
    scopeButton.textContent = labels[scopes.indexOf(scope)]; scopeButton.title = 'Shift+Tab: Current tab → All tabs → Current tab group';
    scopeButton.setAttribute('aria-label', `${scopeButton.textContent}; ${scopeButton.title}`);
  }
  function tell(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
  async function send(message) {
    const reply = await chrome.runtime.sendMessage(message);
    if (!reply?.ok) throw new Error(reply?.message || 'Extension unavailable. Reload this page after updating Pinpointer.');
    return reply;
  }
  function toggleMode() {
    mode = mode === 'p' ? 's' : 'p'; query = core.switchScope(input.value, mode); input.value = query;
    label(); schedule(0); input.focus({ preventScroll: true });
  }
  function toggleScope() { scope = scopes[(scopes.indexOf(scope) + 1) % scopes.length]; label(); schedule(0); input.focus({ preventScroll: true }); }
  function schedule(delay = 140, refresh = false) {
    clearTimeout(timer); sequence += 2;
    if (flight) {
      flight = 0;
      // Cancel once per outstanding request, not once per keystroke. The next
      // debounced query gets a newer sequence than this cancellation barrier.
      send({ type: 'SONAR_CANCEL', sequence: sequence - 1 }).catch(() => {});
    } busy = true; scrubbing = false; current = -1;
    preview.hidden = true; page.clearPaint(); tell('Searching…');
    const token = sequence; timer = setTimeout(() => search(token, refresh), delay);
  }
  async function search(token, refresh) {
    try {
      const compiled = core.compile(input.value, mode); mode = compiled.mode; label();
      flight = token;
      const response = await send({ type: 'SONAR_SEARCH', query: input.value, mode, scope, sequence: token, refresh });
      if (!opened || token !== sequence || response.stale) return;
      result = response; busy = false; current = result.results.length ? 0 : -1;
      const unit = mode === 'p' ? 'paragraphs' : 'sentences';
      tell(!input.value.trim() ? 'Enter words or "quoted phrases"; trailing * matches word endings.' :
        `${result.results.length}${result.limited ? '+' : ''} matching ${unit} · ${result.searched}/${result.total} tabs searched` +
        (result.skipped.length ? ` · ${result.skipped.length} skipped` : '') + (result.limited ? ' · Partial search / result limit.' : '') +
        (result.note ? ` · ${result.note}` : ''));
      skipped.replaceChildren(); skipped.hidden = !result.skipped.length;
      if (result.skipped.length) {
        skipped.append(make('summary', 'Skipped tabs — details'));
        const list = make('ul'); for (const item of result.skipped) list.append(make('li', `${item.title}: ${item.reason}`)); skipped.append(list);
      }
      render();
    } catch (error) {
      if (!opened || token !== sequence) return;
      busy = false; current = -1; preview.hidden = true; skipped.hidden = true; page.clearPaint(); tell(error.message, true);
    } finally { if (flight === token) flight = 0; }
  }
  function render() {
    const selected = result?.results[current]; preview.hidden = !selected;
    if (!selected) return;
    let site = ''; try { site = new URL(selected.url).hostname; } catch (_) { /* Display only. */ }
    title.textContent = `${selected.title} · ${selected.locator || site || 'Page text'}`;
    const quote = shadow.querySelector('#quote'); quote.replaceChildren();
    if (selected.leading) quote.append(document.createTextNode('…'));
    let offset = 0;
    for (const mark of selected.marks) {
      quote.append(document.createTextNode(selected.preview.slice(offset, mark.start)));
      quote.append(make('mark', selected.preview.slice(mark.start, mark.end))); offset = mark.end;
    }
    quote.append(document.createTextNode(selected.preview.slice(offset))); if (selected.trailing) quote.append(document.createTextNode('…'));
    counter.textContent = `${current + 1} / ${result.results.length}`;
    if (scope === 'current') {
      page.preview(result.ticket, selected.index, true).catch(error => tell(error.message, true));
    }
  }
  function move(delta) {
    if (busy || !result?.results.length) return;
    current = (current + delta + result.results.length) % result.results.length; render();
  }
  async function openSelected() {
    if (busy || opening || current < 0 || !result) return;
    const token = sequence; opening = true;
    try {
      await send({ type: 'SONAR_GO', session: result.session, ticket: result.ticket, id: current });
    } catch (error) { if (token === sequence && opened) tell(error.message, true); }
    finally { opening = false; }
  }
  function onKey(event) {
    if (!opened || event.isComposing) return;
    if (event.key === 'Alt' && !event.ctrlKey) window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
    if (!event.composedPath().includes(host)) return;
    // Isolate the search input from Pinpointer's source-copy shortcuts, not native editing.
    event.stopImmediatePropagation();
    if (event.key === 'F6') {
      event.preventDefault(); const index = controls.indexOf(shadow.activeElement);
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
    } else if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault(); event.shiftKey ? toggleScope() : toggleMode();
    } else if (event.key === 'Enter' && shadow.activeElement === input && !event.altKey && !event.metaKey) {
      event.preventDefault(); event.ctrlKey ? openSelected() : move(event.shiftKey ? -1 : 1);
    }
  }
  function onWheel(event) {
    if (!opened || !event.altKey || event.ctrlKey || busy || !result?.results.length || !event.deltaY) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (performance.now() - lastWheel < 85) return;
    lastWheel = performance.now(); scrubbing = true; move(event.deltaY > 0 ? 1 : -1);
  }
  function onKeyUp(event) {
    if (event.key === 'Alt') window.removeEventListener('wheel', onWheel, true);
    if (event.key === 'Alt' && scrubbing) { event.preventDefault(); event.stopImmediatePropagation(); scrubbing = false; openSelected(); }
  }
  function onBlur() { scrubbing = false; window.removeEventListener('wheel', onWheel, true); }
  function focus() { if (opened) { input.focus({ preventScroll: true }); } }
  function open() {
    if (opened) { focus(); input.select(); return; }
    if (!host) setup();
    focusBefore = document.activeElement; opened = true; result = null;
    input.value = query; label(); document.documentElement.append(host);
    try { host.showPopover(); } catch (_) { /* Fixed-position fallback. */ }
    focus(); input.select();
    window.addEventListener('keydown', onKey, true); window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    page.setOnChange(() => { if (opened && scope === 'current') schedule(220); });
    schedule(0);
  }
  function close() {
    if (!opened) return;
    opened = false; sequence += 2; flight = 0; clearTimeout(timer); scrubbing = false; page.setOnChange(null); page.clearPaint();
    host.remove(); window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('wheel', onWheel, true); window.removeEventListener('blur', onBlur);
    send({ type: 'SONAR_CLOSE', sequence }).catch(() => {});
    result = null; if (focusBefore?.isConnected) focusBefore.focus({ preventScroll: true });
  }
  global.LegalPinpointerFind = { open, close, focus };
})(globalThis);
