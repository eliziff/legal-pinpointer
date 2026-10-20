'use strict';

// In-page controls: copy controls beside every paragraph and provision, the document's name in
// CanLII's own header, and on Westlaw and Lexis the native title made plain selectable text with a
// CanLII (or court-site) button, the Case Marker circle and a copy-link button at its end.
//
// Nothing here moves the page. Every control is out of flow (absolutely positioned at its spot) or
// fills space reserved by static CSS that is in place before the first paint (content.css).
// Nothing here waits for the engine either: controls attach to the provider's own paragraph and
// section anchors as soon as the page has them, in one animation frame, and are never touched by
// scrolling. The document model a copy needs is built in idle time behind them.
(function startPageUi() {
  const page = globalThis.LegalPinpointerPage;
  const providers = globalThis.LegalPinpointerProviders;
  const actions = globalThis.LegalPinpointerActions;
  if (!page || !providers || globalThis.LegalPinpointerPageUi) return;
  globalThis.LegalPinpointerPageUi = true;

  const hostname = location.hostname.replace(/^www\./, '');
  const provider = hostname === 'canlii.org' ? 'canlii' : hostname === 'advance.lexis.com' ? 'lexis'
    : /(?:^|\.)nextcanada\.westlaw\.com$/.test(hostname) ? 'westlaw' : '';
  if (!provider) return;

  const settings = { unitCopyButtons: true, canliiHeader: true, cleanTitles: true, canliiButton: true, caseMarker: true };
  const idle = (callback, timeout) => (window.requestIdleCallback
    ? requestIdleCallback(callback, { timeout }) : setTimeout(callback, 50));

  // CanLII's maple leaf (from its own wordmark) and, for a decision found only on its court's
  // Lexum/Decisia site, a courthouse: inlined, so nothing is fetched or exposed to the page.
  const CANLII_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="2640.1 4.7 685.6 685.6"><g transform="matrix(1.33,0,0,-1.33,-51.85,911.22)"><g><g><g transform="translate(1366.69,215.90)"></g><g transform="translate(1822.88,431.36)"></g><g transform="translate(908.24,339.35)"></g><g transform="translate(1697.10,238.79)"></g><g transform="translate(504.64,273.00)"></g><g transform="translate(237.02,626.65)"></g><g transform="translate(506.37,271.47)"></g><g transform="translate(1974.78,669.64)"></g><g transform="translate(500.98,275.13)"></g><g transform="translate(502.71,273.59)"></g><g transform="translate(2488.91,367.05)"><path d="m 0,0 49.26,65.91 -79.71,2.34 0.29,52.55 -83.35,-34.54 71.16,113.27 -61.84,10.96 -9.15,102.98 -83.89,-74.10 -49.20,43.22 -20.25,-145.77 -40.78,99.91 -39.88,-41.18 -54.08,49.81 -7.68,-88.29 -55.23,-4.56 91.47,-139.03 5.77,-9.82 -31.36,-46.42 110.42,-20.47 -57.34,-109.91 62.40,-27.90 41.29,120.43 99.02,-63.83 -1.18,67.44 172.52,37.22 z" style="fill:#bb2119;fill-rule:nonzero"></path></g><g transform="translate(2489.93,368.69)"><path d="m 0,0 48.95,66.14 -79.72,1.96 0.04,52.55 -83.18,-34.93 70.62,113.61 -61.89,10.66 -9.64,102.94 -83.54,-74.49 -49.40,42.99 -19.57,-145.87 -41.25,99.72 -39.68,-41.37 -54.32,49.55 -7.27,-88.32 -55.21,-4.82 92.12,-138.60 5.82,-9.79 -31.14,-46.56 110.51,-19.95 -56.82,-110.18 62.53,-27.60 40.72,120.63 99.32,-63.36 -1.50,67.43 172.34,38.03 z" style="fill:#bb2119;fill-rule:nonzero"></path></g><g transform="translate(2195.26,379.91)"></g><g transform="translate(2363.50,463.28)"></g></g></g></g></svg>`;
  const COURT_LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#3d5a73" stroke-width="1.4" stroke-linejoin="round"><path d="M2 6.2 8 2.6l6 3.6zM3.4 6.6v5.6M6.2 6.6v5.6M9.8 6.6v5.6M12.6 6.6v5.6M2 13.6h12"/></svg>';
  const icon = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  const CANLII_ICON = icon(CANLII_LOGO), COURT_ICON = icon(COURT_LOGO);

  function flash(button) {
    button.classList.add('done');
    setTimeout(() => button.classList.remove('done'), 900);
  }

  function run(task, button) {
    task.then(() => button && flash(button), (error) => page.toast(error.message || 'Legal Pinpointer could not copy that.', true));
  }

  // Routed by early.js before any page listener sees the press.
  actions?.set('unit', (button) => {
    const control = button.parentElement;
    if (control?.lpElement) run(page.copyControl(control.lpElement, control.lpLocator, button.dataset.mode), button);
  });
  actions?.set('citation', (button) => run(page.copyCitation(), button));
  actions?.set('canlii', (link) => {
    if (link.classList.contains('live')) return false;
    if (link.classList.contains('dead')) page.toast('No reliable CanLII version was found for this document.', true);
    return true;
  });

  // ---------------------------------------------------------------------------
  // The document model a copy needs is built at the first sign of one: the pointer on a Pinpointer
  // control, a modifier key (the hotkeys), or text selected. A page that is only read never builds it.

  let metadata = null, warmed = false;
  function warm() {
    if (warmed) return;
    warmed = true;
    if (provider === 'canlii') chrome.runtime.sendMessage({ type: 'LEGAL_PINPOINTER_WARM' }).catch(() => {});
    idle(() => page.model(false).catch(() => { warmed = false; }), 150);
  }
  page.onInvalidate?.(() => { warmed = false; });
  document.addEventListener('pointerover', (event) => {
    if (!warmed && event.target.closest?.('[data-lp-ui]')) warm();
  }, { capture: true, passive: true });
  document.addEventListener('keydown', (event) => {
    if (!warmed && (event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta')) warm();
  }, { capture: true, passive: true });
  document.addEventListener('selectionchange', () => {
    if (!warmed && !getSelection().isCollapsed) warm();
  });

  // ---------------------------------------------------------------------------
  // Copy controls. One per unit element, inserted once; each holds two buttons (pinpoint, and
  // pinpoint with text) that copy the selection when there is one, as the hotkeys do.

  const BLOCKS = new Set(['P', 'LI', 'DIV', 'BLOCKQUOTE', 'DD', 'DT', 'TD', 'TH', 'SECTION', 'ARTICLE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const KIND_LABEL = { paragraph: 'para', page: 'page', section: 's', rule: 'r', article: 'art', pilcrow: '¶', silcrow: '§' };
  const controls = new Map(); // unit element -> control
  let template = null, place = '', shift = 0, syncQueued = 0, unitObserver = null;

  // The room left of the text inside the nearest ancestor that clips it decides where controls sit:
  // a row in the margin, a narrow column, or a row in the space above the unit's first line.
  // Read once per page, in the first frame, before any control is inserted.
  function placement(element, overhanging) {
    const left = element.getBoundingClientRect().left - overhanging;
    let edge = 0;
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.overflowX !== 'visible') { edge = parent.getBoundingClientRect().left + (parseFloat(style.borderLeftWidth) || 0); break; }
    }
    const room = left - edge;
    return room >= 66 ? 'row' : room >= 34 ? 'column' : 'above';
  }

  // How far a unit's first text starts left of the line start a control sits at (Westlaw hangs the
  // paragraph number into the margin): the controls move left by as much. Read once, with placement.
  function overhang(element) {
    const parent = BLOCKS.has(element.tagName) ? element : element.parentElement;
    if (!parent) return 0;
    const style = getComputedStyle(parent);
    const lineStart = parent.getBoundingClientRect().left + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let left = Infinity;
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.data.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      left = range.getClientRects()[0]?.left ?? Infinity;
      break;
    }
    for (const rect of element.getClientRects()) left = Math.min(left, rect.left);
    return Number.isFinite(left) ? Math.min(80, Math.max(0, Math.round(lineStart - left))) : 0;
  }

  function controlTemplate() {
    if (template) return template;
    template = document.createElement('span');
    template.className = 'lp-unit';
    template.setAttribute('data-lp-ui', '');
    template.setAttribute('role', 'group');
    template.contentEditable = 'false';
    template.innerHTML = '<button type="button" class="lp-unit-pin" data-lp-action="unit" data-mode="pinpoint"></button>'
      + '<button type="button" class="lp-unit-quote" data-lp-action="unit" data-mode="quote" data-tip="Copy with text (Ctrl+Shift+X)" aria-label="Copy pinpoint with text"></button>';
    return template;
  }

  // Reads the provider's anchors and inserts controls for new units. It runs in an animation frame,
  // so its one layout read (where the text starts, which units are in view) is that frame's own
  // layout, not an extra one. Each batch reads everything first and then writes, so a batch costs one
  // style and layout pass: the units in view go in before this frame is painted, the rest in idle
  // batches behind it.
  const BATCH = 150;
  let backlog = [], backlogTask = 0;

  function syncUnits() {
    syncQueued = 0;
    if (!settings.unitCopyButtons) return;
    let units;
    try { units = providers.quickUnits(document, location); } catch (_) { return; }
    for (const [element, control] of controls) if (!element.isConnected) { control.remove(); controls.delete(element); }
    const queued = new Set(backlog.map((unit) => unit.element));
    const fresh = units.filter((unit) => unit.element && unit.element.isConnected && !controls.has(unit.element) && !queued.has(unit.element));
    if (!fresh.length) return;
    if (!place) {
      shift = overhang(fresh[0].element);
      place = placement(fresh[0].element, shift);
      if (place === 'above') shift = 0;
    }
    // The first unit whose bottom is in or below the viewport (units are in document order).
    let low = 0, high = fresh.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (fresh[middle].element.getBoundingClientRect().bottom < 0) low = middle + 1; else high = middle;
    }
    const first = Math.max(0, low - 8), last = Math.min(fresh.length, low + 40);
    insertUnits(fresh.slice(first, last));
    backlog.push(...fresh.slice(last), ...fresh.slice(0, first));
    drainBacklog();
  }

  function drainBacklog() {
    if (backlogTask || !backlog.length) return;
    backlogTask = idle(() => {
      backlogTask = 0;
      insertUnits(backlog.splice(0, BATCH).filter((unit) => unit.element.isConnected));
      drainBacklog();
    }, 400);
  }

  function insertUnits(units) {
    const base = controlTemplate();
    // Read: where each control goes, and whether that parent lays its children out as flex or grid
    // items (a float there would be an item, so the control is positioned out of flow instead).
    const plan = [];
    const seen = new Set();
    for (const unit of units) {
      if (controls.has(unit.element) || seen.has(unit.element)) continue; // two units on one element: the first keeps it
      seen.add(unit.element);
      const parent = BLOCKS.has(unit.element.tagName) ? unit.element : unit.element.parentElement;
      if (!parent) continue;
      const display = getComputedStyle(parent).display;
      plan.push({ unit, parent, absolute: /flex|grid/.test(display) });
    }
    // Write.
    for (const { unit, parent, absolute } of plan) {
      const control = base.cloneNode(true);
      control.dataset.place = place;
      control.dataset.kind = unit.kind;
      if (shift) control.style.setProperty('--lp-shift', `${shift}px`);
      if (absolute) control.dataset.flow = 'absolute';
      control.lpElement = unit.element;
      control.lpLocator = unit.locator;
      const label = `Copy pinpoint (Ctrl+X) · ${KIND_LABEL[unit.kind] || unit.kind} ${unit.locator}`;
      control.firstChild.dataset.tip = label;
      control.firstChild.setAttribute('aria-label', label);
      if (parent === unit.element) parent.insertBefore(control, parent.firstChild);
      else unit.element.before(control);
      controls.set(unit.element, control);
    }
  }

  // One tooltip for every control, shown after a short hover.
  let tip = null, tipTimer = 0;
  function hideTip() {
    clearTimeout(tipTimer);
    if (tip) tip.hidden = true;
  }
  document.addEventListener('pointerover', (event) => {
    const button = event.target;
    if (!button.parentElement?.classList?.contains('lp-unit') || !button.dataset.tip) return hideTip();
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'lp-tip';
        tip.setAttribute('data-lp-ui', '');
        tip.setAttribute('role', 'tooltip');
        document.documentElement.appendChild(tip);
      }
      tip.textContent = button.dataset.tip;
      const rect = button.getBoundingClientRect();
      tip.hidden = false;
      tip.style.left = `${Math.max(6, Math.round(rect.left + rect.width / 2 - tip.offsetWidth / 2))}px`;
      tip.style.top = `${Math.round(rect.top - tip.offsetHeight - 6)}px`;
    }, 300);
  }, { capture: true, passive: true });
  document.addEventListener('pointerdown', hideTip, { capture: true, passive: true });
  addEventListener('scroll', hideTip, { capture: true, passive: true });

  // Pages that render the document after load (Lexis) or swap it in place: new anchors get their
  // controls in the same frame they are painted in. Only added elements wake this; Pinpointer's own
  // insertions do not.
  function watchUnits() {
    if (unitObserver) return;
    unitObserver = new MutationObserver((records) => {
      if (syncQueued || !settings.unitCopyButtons) return;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && !node.hasAttribute('data-lp-ui')) { syncQueued = requestAnimationFrame(syncUnits); return; }
        }
      }
    });
    unitObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  function removeUnits() {
    unitObserver?.disconnect();
    unitObserver = null;
    cancelAnimationFrame(syncQueued);
    syncQueued = 0;
    (window.cancelIdleCallback || clearTimeout)(backlogTask);
    backlogTask = 0;
    backlog = [];
    hideTip();
    for (const control of controls.values()) control.remove();
    controls.clear();
    place = '';
    shift = 0;
  }

  // ---------------------------------------------------------------------------
  // CanLII: the document's name in place of the last breadcrumb in CanLII's sticky header. The
  // breadcrumbs already fill the header's free width (content.css), so the name only fills it in.

  let crumb = null;

  function mountCrumb() {
    const name = document.querySelector('#canlii-breadcrumbs > span:last-of-type [itemprop="name"]');
    const title = document.querySelector('#title-container h1.main-title, h1.main-title');
    if (!name || !title) return;
    const text = title.textContent.replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (!crumb || crumb.name !== name) {
      crumb = { name, original: name.textContent, button: null };
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lp-crumb-copy';
      button.setAttribute('data-lp-ui', '');
      button.setAttribute('data-lp-action', 'citation');
      button.setAttribute('data-tip', 'Copy the linked citation (Alt+X)');
      button.setAttribute('aria-label', 'Copy the linked citation');
      name.after(button);
      crumb.button = button;
    }
    if (name.textContent !== text) name.textContent = text;
    name.title = text;
  }

  function unmountCrumb() {
    if (!crumb) return;
    crumb.button.remove();
    crumb.name.textContent = crumb.original;
    crumb.name.removeAttribute('title');
    crumb = null;
  }

  // ---------------------------------------------------------------------------
  // Westlaw and Lexis: tools at the end of the native title, out of flow; the title itself is made
  // plain selectable text by content.css.

  // The document's own title, in order of preference (Lexis repeats it, hidden, in its page header).
  const TITLES = provider === 'westlaw' ? ['#co_docHeaderTitleLine'] : ['#SS_DocumentTitle', '.documentheadertitle h1'];
  const findTitle = () => {
    for (const selector of TITLES) { const element = document.querySelector(selector); if (element) return element; }
    return null;
  };
  let tools = null, floating = null, toolsObserver = null, toolsVisible = true;

  function mountTools() {
    const title = findTitle();
    if (!title) return null;
    if (tools && tools.title === title && tools.element.isConnected) return tools;
    tools?.element.remove();
    const element = document.createElement('span');
    element.className = 'lp-tools';
    element.setAttribute('data-lp-ui', '');
    element.contentEditable = 'false';
    element.innerHTML = '<a class="lp-tool lp-canlii pending" data-lp-action="canlii" data-tip="Looking for a CanLII version" aria-label="CanLII"></a>'
      + '<span class="lp-tool-marker"></span>'
      + '<button type="button" class="lp-tool lp-link" data-lp-action="citation" data-tip="Copy the linked citation (Alt+X)" aria-label="Copy the linked citation"></button>';
    element.style.setProperty('--lp-canlii', CANLII_ICON);
    element.style.setProperty('--lp-court', COURT_ICON);
    title.appendChild(element);
    tools = { title, element, canlii: element.firstChild, marker: element.children[1] };
    tools.canlii.hidden = !settings.canliiButton;
    tools.marker.hidden = !settings.caseMarker || !globalThis.LegalPinpointerCaseMarker;
    watchTools();
    return tools;
  }

  function unmountTools() {
    toolsObserver?.disconnect();
    toolsObserver = null;
    tools?.element.remove();
    tools = null;
    toolsVisible = false;
    floatVisibility();
  }

  // The title made inert as a link: Westlaw's is a draggable self-link, so a press starts a drag
  // and a click reloads the document.
  function tameTitle() {
    if (provider !== 'westlaw' || !settings.cleanTitles) return;
    for (const link of document.querySelectorAll('#co_docHeaderTitleLine a, #titleInfo a')) {
      if (link.lpTamed) continue;
      link.lpTamed = true;
      link.draggable = false;
      link.addEventListener('click', (event) => { if (settings.cleanTitles && !getSelection().isCollapsed) event.preventDefault(); }, true);
    }
  }

  function paintLink(link, current) {
    const url = current.canliiUrl || current.siteUrl || '';
    link.classList.remove('pending');
    link.classList.toggle('live', Boolean(url));
    link.classList.toggle('dead', !url);
    link.classList.toggle('site', !current.canliiUrl && Boolean(current.siteUrl));
    if (url) {
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.dataset.tip = current.canliiUrl ? 'Open on CanLII' : `No CanLII version; open on ${new URL(url).hostname}`;
    } else {
      link.removeAttribute('href');
      link.dataset.tip = 'No CanLII version found';
    }
  }

  // One fixed, click-through layer for the floating CanLII button (bottom left), shown while the
  // title is out of view.
  const LAYER_CSS = `
    :host { all: initial; }
    a { position: fixed; left: 16px; bottom: 18px; display: grid; place-items: center; box-sizing: border-box; width: 30px; height: 30px;
      border: 1px solid #d5dee6; border-radius: 7px; background: #fff; opacity: 0; transform: scale(.9); pointer-events: none;
      transition: opacity 120ms, transform 120ms; box-shadow: 0 1px 2px rgb(0 0 0 / 10%); }
    a.ready { opacity: 1; transform: none; pointer-events: auto; }
    a.ready.dead { opacity: .42; filter: grayscale(1); }
    a.ready.pending { opacity: .25; filter: grayscale(1); }
    a::before { content: ""; width: 18px; height: 18px; background: ${CANLII_ICON} center / contain no-repeat; }
    a.site::before { background-image: ${COURT_ICON}; }
    @media print { a { display: none; } }
  `;

  function mountFloating() {
    if (floating) return floating;
    const host = document.createElement('div');
    host.setAttribute('data-lp-ui', '');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646';
    const shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(LAYER_CSS);
    shadow.adoptedStyleSheets = [sheet];
    floating = document.createElement('a');
    floating.className = 'pending';
    floating.setAttribute('aria-label', 'CanLII');
    floating.setAttribute('data-lp-action', 'canlii');
    shadow.appendChild(floating);
    document.documentElement.appendChild(host);
    floating.lpHost = host;
    return floating;
  }

  function floatVisibility() {
    floating?.classList.toggle('ready', settings.canliiButton && !toolsVisible);
  }

  function watchTools() {
    toolsObserver?.disconnect();
    toolsVisible = true;
    toolsObserver = new IntersectionObserver(([entry]) => { toolsVisible = entry.isIntersecting; floatVisibility(); });
    toolsObserver.observe(tools.title);
  }

  function paintTools(current) {
    if (tools) {
      paintLink(tools.canlii, current);
      tools.canlii.hidden = !settings.canliiButton;
      const marker = globalThis.LegalPinpointerCaseMarker;
      tools.marker.hidden = !marker || !settings.caseMarker;
      if (marker && settings.caseMarker) {
        marker.attachExternal(tools.marker, current.canliiUrl, current.citation.citation || current.citation.plain, current.citation.plain,
          { url: current.cleanUrl, citation: current.citation.citation || '', provider }, current.siteUrl);
      } else tools.marker.replaceChildren();
    }
    if (settings.canliiButton && current.documentType === 'case') {
      paintLink(mountFloating(), current);
      floatVisibility();
    }
  }

  function unmountFloating() {
    floating?.lpHost.remove();
    floating = null;
  }

  // ---------------------------------------------------------------------------

  let applying = 0;
  async function apply() {
    const ticket = ++applying;
    if (settings.unitCopyButtons) { if (!syncQueued) syncQueued = requestAnimationFrame(syncUnits); watchUnits(); } else removeUnits();
    if (provider === 'canlii') {
      if (settings.canliiHeader) mountCrumb(); else unmountCrumb();
    } else {
      document.documentElement.classList.toggle('lp-raw-titles', !settings.cleanTitles);
      tameTitle();
      if (settings.cleanTitles || settings.canliiButton || settings.caseMarker) mountTools(); else unmountTools();
      if (!settings.canliiButton) unmountFloating();
      if (tools || settings.canliiButton) {
        try {
          const current = metadata && page.current(metadata) ? metadata : (metadata = await page.model(true));
          if (ticket === applying) paintTools(current);
        } catch (_) {
          // Not a legal document (a results list or an error page): the tools stay grey.
          if (tools && ticket === applying) paintLink(tools.canlii, {});
        }
      }
    }
  }

  // The page navigated in place or its document was replaced: apply again once it settles.
  let refreshTimer = 0;
  function refresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { metadata = null; apply(); }, 120);
  }
  page.onInvalidate?.(() => { if (provider !== 'canlii' && tools && !tools.element.isConnected) refresh(); });
  window.navigation?.addEventListener('navigatesuccess', refresh);
  window.addEventListener('popstate', refresh);
  window.addEventListener('pageshow', (event) => { if (event.persisted) refresh(); });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.keys(settings).some((key) => changes[key])) return;
    for (const key of Object.keys(settings)) if (changes[key]) settings[key] = changes[key].newValue ?? settings[key];
    apply();
  });
  // Settings early.js read at document_start are normally in hand already, so the page UI applies
  // at once; otherwise as soon as they arrive.
  const early = globalThis.LegalPinpointerEarlySettingsValue;
  if (early) { Object.assign(settings, early); apply(); }
  else (globalThis.LegalPinpointerEarlySettings || new Promise((resolve) => chrome.storage.local.get(settings, resolve)))
    .then((stored) => { Object.assign(settings, stored); apply(); });
})();
