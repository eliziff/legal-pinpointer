'use strict';

// In-page controls: copy controls on every paragraph and provision, CanLII's sticky header naming
// the document, a clean selectable title on Westlaw and Lexis, and a CanLII button there.
// Speed and memory: the controls exist only for units near the viewport (an IntersectionObserver
// mounts and recycles a small pool), contain no text, and sit out of flow, so the page never
// re-lays out; the document model is the content script's own, built once in idle time.
(function startPageUi() {
  const page = globalThis.LegalPinpointerPage;
  if (!page || globalThis.LegalPinpointerPageUi) return;
  globalThis.LegalPinpointerPageUi = true;

  const hostname = location.hostname.replace(/^www\./, '');
  const provider = hostname === 'canlii.org' ? 'canlii' : hostname === 'advance.lexis.com' ? 'lexis'
    : /(?:^|\.)nextcanada\.westlaw\.com$/.test(hostname) ? 'westlaw' : '';
  if (!provider) return;

  const settings = { unitCopyButtons: true, canliiHeader: true, cleanTitles: true, canliiButton: true, caseMarker: true };
  const idle = (callback, timeout = 1200) => (window.requestIdleCallback
    ? requestIdleCallback(callback, { timeout }) : setTimeout(callback, 16));
  const svg = (body) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const ICONS = {
    link: svg('<path d="M6.6 9.4a2.9 2.9 0 0 0 4.1 0l2.2-2.2a2.9 2.9 0 0 0-4.1-4.1l-.9.9M9.4 6.6a2.9 2.9 0 0 0-4.1 0L3.1 8.8a2.9 2.9 0 0 0 4.1 4.1l.9-.9"/>'),
    check: svg('<path d="M3.2 8.6 6.4 11.6 12.8 4.6"/>')
  };

  function sheet(css) {
    const style = new CSSStyleSheet();
    style.replaceSync(css);
    return style;
  }

  // CanLII's maple leaf, from its own wordmark, inlined: nothing is exposed to the page.
  const CANLII_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="2640.1 4.7 685.6 685.6"><g transform="matrix(1.33,0,0,-1.33,-51.85,911.22)"><g><g><g transform="translate(1366.69,215.90)"></g><g transform="translate(1822.88,431.36)"></g><g transform="translate(908.24,339.35)"></g><g transform="translate(1697.10,238.79)"></g><g transform="translate(504.64,273.00)"></g><g transform="translate(237.02,626.65)"></g><g transform="translate(506.37,271.47)"></g><g transform="translate(1974.78,669.64)"></g><g transform="translate(500.98,275.13)"></g><g transform="translate(502.71,273.59)"></g><g transform="translate(2488.91,367.05)"><path d="m 0,0 49.26,65.91 -79.71,2.34 0.29,52.55 -83.35,-34.54 71.16,113.27 -61.84,10.96 -9.15,102.98 -83.89,-74.10 -49.20,43.22 -20.25,-145.77 -40.78,99.91 -39.88,-41.18 -54.08,49.81 -7.68,-88.29 -55.23,-4.56 91.47,-139.03 5.77,-9.82 -31.36,-46.42 110.42,-20.47 -57.34,-109.91 62.40,-27.90 41.29,120.43 99.02,-63.83 -1.18,67.44 172.52,37.22 z" style="fill:#bb2119;fill-rule:nonzero"></path></g><g transform="translate(2489.93,368.69)"><path d="m 0,0 48.95,66.14 -79.72,1.96 0.04,52.55 -83.18,-34.93 70.62,113.61 -61.89,10.66 -9.64,102.94 -83.54,-74.49 -49.40,42.99 -19.57,-145.87 -41.25,99.72 -39.68,-41.37 -54.32,49.55 -7.27,-88.32 -55.21,-4.82 92.12,-138.60 5.82,-9.79 -31.14,-46.56 110.51,-19.95 -56.82,-110.18 62.53,-27.60 40.72,120.63 99.32,-63.36 -1.50,67.43 172.34,38.03 z" style="fill:#bb2119;fill-rule:nonzero"></path></g><g transform="translate(2195.26,379.91)"></g><g transform="translate(2363.50,463.28)"></g></g></g></g></svg>`;
  const CANLII_CSS = `
    .canlii {
      position: relative; display: grid; place-items: center; flex: 0 0 auto; box-sizing: border-box; width: 30px; height: 30px;
      border: 1px solid #d5dee6; border-radius: 7px; background: #fff; text-decoration: none;
      transition: transform 120ms ease-out, opacity 120ms, box-shadow 120ms, filter 120ms;
    }
    .canlii::before {
      content: ""; width: 18px; height: 18px;
      background: url("data:image/svg+xml,${encodeURIComponent(CANLII_LOGO)}") center / contain no-repeat;
    }
    .canlii.live { cursor: pointer; box-shadow: 0 1px 2px rgb(187 33 25 / 12%); }
    .canlii.live:hover { border-color: #e2a19c; box-shadow: 0 2px 8px rgb(187 33 25 / 20%); }
    .canlii.dead { filter: grayscale(1); opacity: .42; cursor: default; }
    .canlii.pending { filter: grayscale(1); opacity: .25; }
    .canlii::after {
      content: attr(data-tip); position: absolute; left: calc(100% + 10px); top: 50%; transform: translateY(-50%);
      padding: 6px 9px; border-radius: 6px; background: #17241e; color: #fff; white-space: nowrap;
      font: 500 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; opacity: 0; pointer-events: none; transition: opacity 80ms;
    }
    .canlii:hover::after { opacity: 1; transition-delay: 200ms; }
  `;

  // One fixed host for the floating CanLII button.
  const LAYER_CSS = `
    :host { all: initial; }
    .canlii.float { position: fixed; left: 16px; bottom: 18px; opacity: 0; transform: scale(.9); pointer-events: none; }
    .canlii.float.ready { opacity: 1; transform: none; pointer-events: auto; }
    @media print { .float { display: none; } }
  ` + CANLII_CSS;

  let layerRoot = null;
  function layer() {
    if (layerRoot) return layerRoot;
    const host = document.createElement('div');
    host.setAttribute('data-lp-ui', '');
    // Full-viewport and click-through, so the button's corner is the viewport's corner.
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646';
    layerRoot = host.attachShadow({ mode: 'open' });
    layerRoot.adoptedStyleSheets = [sheet(LAYER_CSS)];
    document.documentElement.appendChild(host);
    return layerRoot;
  }

  function flash(button) {
    button.classList.add('done');
    if (button.dataset.icon !== 'css') {
      const previous = button.innerHTML;
      button.innerHTML = ICONS.check;
      setTimeout(() => { button.classList.remove('done'); button.innerHTML = previous; }, 900);
    } else setTimeout(() => button.classList.remove('done'), 900);
  }

  function run(task, button) {
    task.then(() => button && flash(button), (error) => page.toast(error.message || 'Legal Pinpointer could not copy that.', true));
  }

  // ---------------------------------------------------------------------------
  // The document model: metadata for titles and the CanLII button, structure for the controls.

  let metadata = null, loading = null, unsupported = '';

  function fullModel() {
    // A page that is not a legal document (a results list) is not inspected again until it navigates.
    if (unsupported === location.href) return Promise.reject(new Error('Not a supported document.'));
    loading ||= page.model(false).then((value) => { metadata = value; return value; },
      (error) => { unsupported = location.href; throw error; }).finally(() => { loading = null; });
    return loading;
  }

  // ---------------------------------------------------------------------------
  // Copy controls on each paragraph and provision. With text selected they copy the selection
  // (a range, as the hotkeys do); otherwise their own unit. Pinpoint, quote, link.

  const BLOCKS = new Set(['P', 'LI', 'DIV', 'BLOCKQUOTE', 'DD', 'DT', 'TD', 'TH', 'SECTION', 'ARTICLE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const KIND_LABEL = { paragraph: 'para', page: 'page', section: 's', rule: 'r', article: 'art', pilcrow: '¶', silcrow: '§' };
  const units = { model: null, observer: null, nodes: new Map(), mounted: new Map(), pool: [], place: 'row' };

  // The room left of the text inside the nearest ancestor that clips it decides where controls sit:
  // a row in the margin, a narrow column, or a row in the space above the unit's first line.
  function placement(root) {
    const left = root.getBoundingClientRect().left;
    let edge = 0;
    for (let element = root.parentElement; element && element !== document.body; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.overflowX !== 'visible') { edge = element.getBoundingClientRect().left + (parseFloat(style.borderLeftWidth) || 0); break; }
    }
    const room = left - edge;
    return room >= 66 ? 'row' : room >= 34 ? 'column' : 'above';
  }

  function createControl() {
    const control = document.createElement('span');
    control.className = 'lp-unit';
    control.setAttribute('data-lp-ui', '');
    control.setAttribute('role', 'group');
    control.contentEditable = 'false';
    control.innerHTML = '<button type="button" class="lp-unit-pin" data-mode="pinpoint" data-icon="css"></button>'
      + '<button type="button" class="lp-unit-quote" data-mode="quote" data-icon="css" data-tip="Copy with text (Ctrl+Shift+X)" aria-label="Copy pinpoint with text"></button>';
    return control;
  }

  function attach(element) {
    const node = units.nodes.get(element);
    if (!node || units.mounted.has(element) || !element.isConnected) return;
    const control = units.pool.pop() || createControl();
    const kind = units.model.structure.kind;
    control.dataset.place = units.place;
    control.dataset.kind = kind;
    control.lpNode = node;
    const pin = control.firstElementChild;
    const label = `Copy pinpoint (Ctrl+X) · ${KIND_LABEL[kind] || kind} ${node.locator}`;
    pin.dataset.tip = label;
    pin.setAttribute('aria-label', label);
    if (BLOCKS.has(element.tagName)) element.insertBefore(control, element.firstChild);
    else element.before(control);
    units.mounted.set(element, control);
  }

  function detach(element) {
    const control = units.mounted.get(element);
    if (!control) return;
    units.mounted.delete(element);
    control.remove();
    control.lpNode = null;
    if (units.pool.length < 64) units.pool.push(control);
  }

  function unmountUnits() {
    units.observer?.disconnect();
    units.observer = null;
    for (const element of [...units.mounted.keys()]) detach(element);
    units.nodes.clear();
    units.model = null;
  }

  function mountUnits(model) {
    unmountUnits();
    const nodes = model.structure?.nodes || [];
    if (!nodes.length) return;
    units.model = model;
    units.place = placement(model.root);
    // One control per element: units that share an element (a preformatted block) keep the first.
    for (const node of nodes) {
      const element = node.element;
      if (element && element.isConnected && model.root.contains(element) && !units.nodes.has(element)) units.nodes.set(element, node);
    }
    units.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) (entry.isIntersecting ? attach : detach)(entry.target);
    }, { rootMargin: '1200px 0px' });
    for (const element of units.nodes.keys()) units.observer.observe(element);
  }

  // Delegated, in the capture phase: the provider's own handlers never see these presses, and the
  // selection survives the press.
  document.addEventListener('mousedown', (event) => {
    if (!event.target.closest?.('.lp-unit')) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('.lp-unit > button');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const node = button.parentElement.lpNode;
    if (node && units.model) run(page.copyUnit(units.model, node, button.dataset.mode), button);
  }, true);

  // ---------------------------------------------------------------------------
  // CanLII: the document's name in CanLII's own sticky header.

  let banner = null, headerObserver = null, headerHeight = 0;

  function mountBanner(current) {
    const header = document.getElementById('canlii-header');
    if (!header || !['case', 'legislation'].includes(current.documentType)) return;
    if (!banner || !banner.isConnected) {
      banner = document.createElement('div');
      banner.className = 'lp-banner d-print-none';
      banner.setAttribute('data-lp-ui', '');
      banner.innerHTML = '<span class="lp-banner-title"></span><span class="lp-banner-actions">'
        + `<button type="button" title="Copy the linked citation (Alt+X)">${ICONS.link}<span>Copy link</span></button></span>`;
      banner.addEventListener('mousedown', (event) => { if (event.target.closest('button')) event.preventDefault(); });
      banner.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (button) run(page.copyCitation(), button);
      });
      header.appendChild(banner);
      // CanLII positions its side toolbar under the header from the header's height. React only to
      // a real change in height, so the resize event this sends cannot feed back into itself.
      headerObserver?.disconnect();
      headerObserver = new ResizeObserver(([entry]) => {
        const height = Math.round(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
        if (Math.abs(height - headerHeight) < 1) return;
        headerHeight = height;
        window.dispatchEvent(new Event('resize'));
        for (const side of document.querySelectorAll('.main > .toolbar, .main > .canlii-sidebar, .main > .heatmap, .toolbar.bootstrap')) {
          if (side.style.top && Math.abs(parseFloat(side.style.top) - height) > 1) {
            side.style.top = `${height}px`;
            side.style.height = `${window.innerHeight - height}px`;
          }
        }
      });
      headerObserver.observe(header);
    }
    const title = banner.firstElementChild;
    if (title.textContent !== current.citation.plain) title.textContent = current.citation.plain;
  }

  function unmountBanner() {
    headerObserver?.disconnect();
    headerObserver = null;
    headerHeight = 0;
    banner?.remove();
    banner = null;
  }

  // ---------------------------------------------------------------------------
  // Westlaw and Lexis: the title as a roomy, selectable block, away from the header's controls.

  const CARD_CSS = `
    :host { all: initial; display: block; margin: 0 0 18px; }
    .card {
      display: flex; gap: 14px; align-items: flex-start; padding: 14px 16px;
      border: 1px solid #dde3df; border-radius: 10px; background: #fbfcfb; color: #16211b;
      font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .text { min-width: 0; flex: 1 1 auto; cursor: text; }
    .name { margin: 0; font: 600 20px/1.3 Georgia, "Times New Roman", serif; letter-spacing: -0.005em;
      user-select: text; -webkit-user-drag: none; overflow-wrap: anywhere; }
    .name.case { font-style: italic; }
    .cite { margin: 4px 0 0; color: #44544b; user-select: text; overflow-wrap: anywhere; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; flex: 0 0 auto; padding-top: 2px; }
    button {
      display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border: 1px solid #cfd8d3;
      border-radius: 7px; background: #fff; color: #1f3d30; font: 600 12.5px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
      cursor: pointer; transition: background 80ms, border-color 80ms;
    }
    button:hover { background: #eef5f1; border-color: #9fbcad; }
    button:active { background: #e1ede6; }
    button.done { color: #187243; border-color: #7fb597; }
    .card .canlii { margin-top: 2px; }
    .marker { display: contents; }
    ::slotted([slot="marker"]) { display: inline-flex; flex: 0 0 auto; align-items: center; min-height: 44px; }
    .card .canlii[hidden] { display: none; }
    @media (max-width: 760px) { .card { flex-wrap: wrap; } .actions { justify-content: flex-start; } }
    @media print { :host { display: none; } }
  ` + CANLII_CSS;

  let card = null;

  function mountCard(current) {
    const anchor = current.root && current.root !== document.body && current.root.isConnected ? current.root : null;
    if (!anchor || !current.citation) return;
    if (!card || !card.host.isConnected) {
      const host = document.createElement('div');
      host.setAttribute('data-lp-ui', '');
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.adoptedStyleSheets = [sheet(CARD_CSS)];
      shadow.innerHTML = '<section class="card" aria-label="Document title"><a class="canlii pending" data-tip="Looking for a CanLII version" aria-label="CanLII"></a>'
        + '<span class="marker"><slot name="marker"></slot></span>'
        + '<div class="text"><h2 class="name"></h2><p class="cite"></p></div><div class="actions">'
        + `<button type="button" title="Copy the linked citation (Alt+X)">${ICONS.link}<span>Copy link</span></button>`
        + '</div></section>';
      shadow.addEventListener('mousedown', (event) => { if (event.target.closest('button')) event.preventDefault(); });
      shadow.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (button) run(page.copyCitation(), button);
      });
      // Case Marker's circle is light DOM slotted into the block, so Case Marker's own styles reach it.
      const marker = document.createElement('span');
      marker.slot = 'marker';
      host.appendChild(marker);
      card = { host, marker, name: shadow.querySelector('.name'), cite: shadow.querySelector('.cite'), canlii: shadow.querySelector('.canlii') };
      card.canlii.addEventListener('click', noCanlii);
      anchor.before(host);
      watchCard();
    }
    card.name.textContent = current.citation.title || current.citation.plain;
    card.name.classList.toggle('case', current.documentType === 'case');
    card.cite.textContent = current.citation.citation || '';
    card.cite.hidden = !current.citation.citation;
    card.canlii.hidden = !settings.canliiButton;
    const caseMarker = globalThis.LegalPinpointerCaseMarker;
    if (caseMarker && settings.caseMarker) {
      caseMarker.attachExternal(card.marker, current.canliiUrl, current.citation.citation || current.citation.plain, current.citation.plain,
        { url: current.cleanUrl, citation: current.citation.citation || '', provider });
    } else card.marker.replaceChildren();
  }

  function unmountCard() {
    cardObserver?.disconnect();
    cardObserver = null;
    card?.host.remove();
    card = null;
    cardVisible = false;
    floatVisibility();
  }

  // Westlaw's title is a draggable link: a press on it starts a drag, not a selection, and a click
  // reloads the document. Make it plain selectable text.
  function tameNativeTitle(on) {
    document.documentElement.classList.toggle('lp-clean-titles', on);
    if (provider !== 'westlaw') return;
    for (const link of document.querySelectorAll('#co_docHeaderTitleLine a, #titleInfo a')) {
      link.draggable = !on;
      if (!link.lpTamed) {
        link.lpTamed = true;
        link.addEventListener('click', (event) => {
          if (settings.cleanTitles && !getSelection().isCollapsed) event.preventDefault();
        }, true);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Westlaw and Lexis: CanLII, lit when the document has a reliable CanLII version. It sits at the
  // left of the title block; a floating copy appears in the bottom-left corner once that block
  // scrolls out of view (or always, when titles are not cleaned up).

  let floating = null, cardObserver = null, cardVisible = false;

  function noCanlii(event) {
    if (event.currentTarget.classList.contains('live')) return;
    event.preventDefault();
    if (event.currentTarget.classList.contains('dead')) page.toast('No reliable CanLII version was found for this document.', true);
  }

  function paintCanlii(button, url) {
    button.classList.remove('pending');
    button.classList.toggle('live', Boolean(url));
    button.classList.toggle('dead', !url);
    if (url) {
      button.href = url;
      button.target = '_blank';
      button.rel = 'noopener';
      button.dataset.tip = 'Open on CanLII';
    } else {
      button.removeAttribute('href');
      button.dataset.tip = 'No CanLII version found';
    }
  }

  function floatVisibility() {
    floating?.classList.toggle('ready', settings.canliiButton && !cardVisible);
  }

  function watchCard() {
    cardObserver?.disconnect();
    cardObserver = new IntersectionObserver(([entry]) => { cardVisible = entry.isIntersecting; floatVisibility(); });
    cardObserver.observe(card.host);
  }

  function mountCanliiButton(current) {
    if (!floating) {
      floating = document.createElement('a');
      floating.className = 'canlii float';
      floating.setAttribute('aria-label', 'CanLII');
      floating.addEventListener('click', noCanlii);
      layer().appendChild(floating);
    }
    paintCanlii(floating, current.canliiUrl);
    if (card) paintCanlii(card.canlii, current.canliiUrl);
    requestAnimationFrame(floatVisibility);
  }

  function unmountCanliiButton() {
    floating?.remove();
    floating = null;
    if (card) card.canlii.hidden = true;
  }

  // ---------------------------------------------------------------------------

  let applying = 0;
  async function apply() {
    const ticket = ++applying;
    if (!settings.unitCopyButtons) unmountUnits();
    if (provider === 'canlii' && !settings.canliiHeader) unmountBanner();
    if (provider !== 'canlii') {
      if (!settings.cleanTitles) unmountCard();
      if (!settings.canliiButton) unmountCanliiButton();
      tameNativeTitle(settings.cleanTitles);
    }
    const wantsMetadata = provider === 'canlii' ? settings.canliiHeader : settings.cleanTitles || settings.canliiButton;
    if (wantsMetadata) {
      try {
        const current = metadata && page.current(metadata) ? metadata : (metadata = await page.model(true));
        if (ticket !== applying) return;
        if (provider === 'canlii' && settings.canliiHeader) mountBanner(current);
        if (provider !== 'canlii' && settings.cleanTitles) mountCard(current);
        if (provider !== 'canlii' && settings.canliiButton) mountCanliiButton(current);
      } catch (_) {
        // Not a supported legal document (a search page or an error page): nothing to show.
      }
    }
    if (settings.unitCopyButtons) whenVisible(() => idle(() => fullModel().then((model) => {
      if (ticket === applying && settings.unitCopyButtons && units.model !== model) mountUnits(model);
    }, () => {}), 2500));
  }

  // A tab opened or restored in the background reads its document only once it is shown.
  function whenVisible(callback) {
    if (document.visibilityState === 'visible') return callback();
    document.addEventListener('visibilitychange', function shown() {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', shown);
      callback();
    });
  }

  // The document changed (or the page navigated in place): re-mount once things settle. A page
  // that keeps changing its text backs off, so it is never re-read more than every few seconds.
  let refreshes = [];
  let refreshTimer = 0;
  function refresh() {
    clearTimeout(refreshTimer);
    const now = Date.now();
    refreshes = refreshes.filter((at) => now - at < 30_000);
    refreshTimer = setTimeout(() => { refreshes.push(Date.now()); metadata = null; apply(); }, refreshes.length > 3 ? 8000 : 500);
  }
  page.onInvalidate?.(refresh);
  window.navigation?.addEventListener('navigatesuccess', refresh);
  window.addEventListener('popstate', refresh);
  window.addEventListener('pageshow', (event) => { if (event.persisted) refresh(); });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.keys(settings).some((key) => changes[key])) return;
    for (const key of Object.keys(settings)) if (changes[key]) settings[key] = changes[key].newValue ?? settings[key];
    if (changes.caseMarker) setTimeout(apply, 60); else apply();
  });
  chrome.storage.local.get(settings, (stored) => {
    Object.assign(settings, stored);
    idle(apply, 400);
  });
})();
