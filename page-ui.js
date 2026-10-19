'use strict';

// In-page controls: a copy bar beside the hovered paragraph or provision, CanLII's sticky header
// naming the document, a clean selectable title on Westlaw and Lexis, and a CanLII button there.
// Speed rules: one overlay layer for everything floating; hover work runs only when the hovered
// element changes (pointerover, once per frame) and is cached per element; positions are
// compositor transforms; the document model is the content script's own, built in idle time.
(function startPageUi() {
  const page = globalThis.LegalPinpointerPage;
  if (!page || globalThis.LegalPinpointerPageUi) return;
  globalThis.LegalPinpointerPageUi = true;

  const hostname = location.hostname.replace(/^www\./, '');
  const provider = hostname === 'canlii.org' ? 'canlii' : hostname === 'advance.lexis.com' ? 'lexis'
    : /(?:^|\.)nextcanada\.westlaw\.com$/.test(hostname) ? 'westlaw' : '';
  if (!provider) return;

  const settings = { unitCopyButtons: true, canliiHeader: true, cleanTitles: true, canliiButton: true };
  const idle = (callback, timeout = 1200) => (window.requestIdleCallback
    ? requestIdleCallback(callback, { timeout }) : setTimeout(callback, 16));
  const svg = (body) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const ICONS = {
    quote: svg('<path d="M3 9.5h3.2V13H3zM3 9.5C3 6.2 4.2 4.4 6.4 3.6M9.8 9.5H13V13H9.8zM9.8 9.5c0-3.3 1.2-5.1 3.4-5.9"/>'),
    link: svg('<path d="M6.6 9.4a2.9 2.9 0 0 0 4.1 0l2.2-2.2a2.9 2.9 0 0 0-4.1-4.1l-.9.9M9.4 6.6a2.9 2.9 0 0 0-4.1 0L3.1 8.8a2.9 2.9 0 0 0 4.1 4.1l.9-.9"/>'),
    copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V3.6c0-.9-.7-1.6-1.6-1.6H3.6C2.7 2 2 2.7 2 3.6v5.3c0 .9.7 1.6 1.6 1.6h1.9"/>'),
    check: svg('<path d="M3.2 8.6 6.4 11.6 12.8 4.6"/>')
  };

  const CANLII_CSS = `
    .canlii {
      position: relative; display: grid; place-items: center; flex: 0 0 auto; width: 44px; height: 44px; border-radius: 50%;
      text-decoration: none; letter-spacing: -0.02em; font: 800 11px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
      transition: transform 120ms ease-out, opacity 120ms, box-shadow 120ms;
    }
    .canlii.live { background: #c8102e; color: #fff; box-shadow: 0 2px 8px rgb(200 16 46 / 32%); cursor: pointer; }
    .canlii.live:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgb(200 16 46 / 42%); }
    .canlii.dead { background: #eef0ef; color: #a1a9a5; box-shadow: inset 0 0 0 1px #d9dedb; cursor: default; }
    .canlii.pending { background: #f4f5f4; color: #c3c9c5; box-shadow: inset 0 0 0 1px #e3e7e4; }
    .canlii::after {
      content: attr(data-tip); position: absolute; left: calc(100% + 10px); top: 50%; transform: translateY(-50%);
      padding: 6px 9px; border-radius: 6px; background: #17241e; color: #fff; white-space: nowrap;
      font: 500 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; opacity: 0; pointer-events: none; transition: opacity 80ms;
    }
    .canlii:hover::after { opacity: 1; transition-delay: 200ms; }
  `;

  function sheet(css) {
    const style = new CSSStyleSheet();
    style.replaceSync(css);
    return style;
  }

  // ---------------------------------------------------------------------------
  // The overlay layer: one fixed, zero-size host whose shadow root holds every floating control.

  const LAYER_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    button, a { font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .bar {
      position: fixed; left: 0; top: 0; display: flex; flex-direction: column; gap: 2px; padding: 3px;
      background: #fff; border: 1px solid rgb(16 40 30 / 14%); border-radius: 9px;
      box-shadow: 0 1px 2px rgb(16 40 30 / 8%), 0 4px 14px rgb(16 40 30 / 10%);
      opacity: 0; pointer-events: none; transition: opacity 90ms ease-out; contain: layout paint style;
      will-change: transform, opacity;
    }
    .bar.on { opacity: 1; pointer-events: auto; }
    .bar button {
      position: relative; display: grid; place-items: center; min-width: 26px; height: 26px; padding: 0 4px;
      border: 0; border-radius: 6px; background: transparent; color: #33463d; cursor: pointer;
      font-variant-numeric: tabular-nums; letter-spacing: -0.01em;
    }
    .bar button:hover { background: #e9f2ed; color: #154a33; }
    .bar button:active { background: #d7e8de; }
    .bar button.done { color: #187243; }
    .bar button::after {
      content: attr(data-tip); position: absolute; left: calc(100% + 8px); top: 50%; transform: translateY(-50%);
      padding: 5px 8px; border-radius: 6px; background: #17241e; color: #fff; white-space: nowrap;
      font-weight: 500; opacity: 0; pointer-events: none; transition: opacity 80ms;
    }
    .bar button:hover::after { opacity: 1; transition-delay: 250ms; }
    /* No gutter beside the text: a strip above the unit's first line instead of over its words. */
    .bar.row { flex-direction: row; }
    .bar.row button::after { left: 50%; top: calc(100% + 7px); transform: translateX(-50%); }
    .float { position: fixed; left: 16px; bottom: 18px; opacity: 0; transform: scale(.9); pointer-events: none; }
    .float.ready { opacity: 1; transform: none; pointer-events: auto; }
    @media print { .bar, .float { display: none; } }
  ` + CANLII_CSS;

  let layerRoot = null;
  let layerHost = null;
  function layer() {
    if (layerRoot) return layerRoot;
    layerHost = document.createElement('div');
    layerHost.setAttribute('data-lp-ui', '');
    layerHost.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646';
    layerRoot = layerHost.attachShadow({ mode: 'open' });
    layerRoot.adoptedStyleSheets = [sheet(LAYER_CSS)];
    document.documentElement.appendChild(layerHost);
    return layerRoot;
  }

  function flash(button) {
    const previous = button.innerHTML;
    button.classList.add('done');
    if (!button.dataset.label) button.innerHTML = ICONS.check;
    setTimeout(() => { button.classList.remove('done'); if (!button.dataset.label) button.innerHTML = previous; }, 900);
  }

  function run(task, button) {
    task.then(() => button && flash(button), (error) => page.toast(error.message || 'Legal Pinpointer could not copy that.', true));
  }

  // ---------------------------------------------------------------------------
  // Model: metadata for titles and the CanLII button, the full structure for the copy bar.

  let model = null, metadata = null, loading = null, units = new WeakMap(), unsupported = '';

  function fullModel() {
    if (model && page.current(model)) return Promise.resolve(model);
    // A page that is not a legal document (a results list) is not inspected again until it navigates.
    if (unsupported === location.href) return Promise.reject(new Error('Not a supported document.'));
    loading ||= page.model(false).then((value) => {
      model = value; metadata = value; units = new WeakMap(); rootLeft = null;
      return value;
    }, (error) => { unsupported = location.href; throw error; }).finally(() => { loading = null; });
    return loading;
  }

  // ---------------------------------------------------------------------------
  // The copy bar beside the hovered unit.

  const bar = { el: null, label: null, node: null, target: null, frame: 0, hide: 0, over: false };
  let rootLeft = null;

  function buildBar() {
    const el = document.createElement('div');
    el.className = 'bar';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', 'Copy this passage');
    el.innerHTML = `<button type="button" data-mode="pinpoint" data-label="1" data-tip="Copy pinpoint"></button>`
      + `<button type="button" data-mode="quote" data-tip="Copy quote">${ICONS.quote}</button>`
      + `<button type="button" data-mode="link" data-tip="Copy link">${ICONS.link}</button>`;
    el.addEventListener('pointerenter', () => { bar.over = true; clearTimeout(bar.hide); });
    el.addEventListener('pointerleave', () => { bar.over = false; scheduleHide(); });
    el.addEventListener('mousedown', (event) => event.preventDefault());
    el.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button || !bar.node || !model) return;
      run(page.copyUnit(model, bar.node, button.dataset.mode), button);
    });
    layer().appendChild(el);
    bar.el = el;
    bar.label = el.firstElementChild;
  }

  function unitFor(target) {
    const element = target && (target.nodeType === 1 ? target : target.parentElement);
    if (!element || !model || !model.root.contains(element)) return null;
    let node = units.get(element);
    if (node === undefined) {
      node = page.unitAt(model, element) || null;
      units.set(element, node);
    }
    return node;
  }

  function unitRect(node) {
    const start = page.unitStart(node);
    const rect = start && start.startContainer.nodeType === Node.TEXT_NODE ? start.getClientRects()[0] : null;
    return rect || node.element.getBoundingClientRect();
  }

  function place() {
    if (!bar.node || !bar.el) return;
    const rect = unitRect(bar.node);
    if (rootLeft === null) rootLeft = model.root.getBoundingClientRect().left;
    const gutter = Math.min(rootLeft, rect.left);
    const row = gutter < 44;
    bar.el.classList.toggle('row', row);
    const x = row ? Math.max(4, rect.left) : gutter - 40;
    const y = row ? Math.max(4, rect.top - 36) : rect.top - 4;
    bar.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  function label(node) {
    const kind = model.structure.kind;
    const short = node.locator.length <= 5 ? node.locator : kind === 'paragraph' || kind === 'pilcrow' ? '¶' : '§';
    bar.label.textContent = short;
    bar.label.dataset.tip = `Copy pinpoint · ${kind === 'paragraph' ? 'para' : kind === 'page' ? 'page' : kind === 'section' ? 's' : kind} ${node.locator}`;
  }

  function show(node) {
    if (!bar.el) buildBar();
    bar.node = node;
    label(node);
    place();
    bar.el.classList.add('on');
  }

  function scheduleHide() {
    clearTimeout(bar.hide);
    bar.hide = setTimeout(() => {
      if (bar.over || !bar.el) return;
      bar.el.classList.remove('on');
      bar.node = null;
    }, 380);
  }

  function hover() {
    bar.frame = 0;
    const target = bar.target;
    if (!settings.unitCopyButtons || !target || target === layerHost) return;
    if (!model || !page.current(model)) { if (unsupported !== location.href && !loading) idle(() => fullModel().catch(() => {})); return; }
    const node = unitFor(target);
    if (!node) { if (bar.node) scheduleHide(); return; }
    clearTimeout(bar.hide);
    if (node !== bar.node) show(node);
  }

  document.addEventListener('pointerover', (event) => {
    if (!settings.unitCopyButtons || event.pointerType === 'touch') return;
    bar.target = event.target;
    if (!bar.frame) bar.frame = requestAnimationFrame(hover);
  }, { capture: true, passive: true });

  let scrollFrame = 0;
  const follow = () => { scrollFrame = 0; place(); };
  document.addEventListener('scroll', () => {
    if (bar.node && !scrollFrame) scrollFrame = requestAnimationFrame(follow);
  }, { capture: true, passive: true });
  window.addEventListener('resize', () => { rootLeft = null; if (bar.node && !scrollFrame) scrollFrame = requestAnimationFrame(follow); }, { passive: true });

  function unmountBar() {
    bar.el?.classList.remove('on');
    bar.node = null;
  }

  // ---------------------------------------------------------------------------
  // CanLII: the document's name in CanLII's own sticky header.

  let banner = null, headerObserver = null;

  function mountBanner(current) {
    const header = document.getElementById('canlii-header');
    if (!header || !['case', 'legislation'].includes(current.documentType)) return;
    if (!banner || !banner.isConnected) {
      banner = document.createElement('div');
      banner.className = 'lp-banner d-print-none';
      banner.setAttribute('data-lp-ui', '');
      banner.innerHTML = '<span class="lp-banner-title"></span><span class="lp-banner-actions">'
        + `<button type="button" data-act="citation" title="Copy the linked citation (Alt+X)">${ICONS.copy}<span>Citation</span></button>`
        + `<button type="button" data-act="link" title="Copy a link to this document">${ICONS.link}<span>Link</span></button></span>`;
      banner.addEventListener('mousedown', (event) => { if (event.target.closest('button')) event.preventDefault(); });
      banner.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        run(button.dataset.act === 'citation' ? page.copyCitation() : copyLink(), button);
      });
      header.appendChild(banner);
      // CanLII positions its side toolbar under the header from the header's height.
      headerObserver?.disconnect();
      headerObserver = new ResizeObserver(([entry]) => {
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
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
    banner?.remove();
    banner = null;
  }

  function copyLink() {
    const url = (metadata && metadata.cleanUrl) || location.href.split('#')[0];
    const escaped = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return page.copyPayload({ plain: url, html: `<a href="${escaped}">${escaped}</a>` }, 'Copied link to this document');
  }

  // ---------------------------------------------------------------------------
  // Westlaw and Lexis: the title as a roomy, selectable block, away from the header's controls.

  const CARD_CSS = `
    :host { all: initial; display: block; margin: 0 0 18px; }
    .card {
      display: flex; gap: 14px; align-items: flex-start; justify-content: space-between; padding: 14px 16px;
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
    @media (max-width: 760px) { .card { flex-direction: column; } .actions { justify-content: flex-start; } }
    .card .canlii { margin-top: 1px; }
    .card .canlii[hidden] { display: none; }
    @media print { :host { display: none; } }
  ` + CANLII_CSS;

  let card = null;

  function cardAnchor(current) {
    const root = current.root;
    return root && root !== document.body && root.isConnected ? root : null;
  }

  function mountCard(current) {
    const anchor = cardAnchor(current);
    if (!anchor || !current.citation) return;
    if (!card || !card.host.isConnected) {
      const host = document.createElement('div');
      host.setAttribute('data-lp-ui', '');
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.adoptedStyleSheets = [sheet(CARD_CSS)];
      shadow.innerHTML = '<section class="card" aria-label="Document title"><a class="canlii pending" data-tip="Looking for a CanLII version">CanLII</a>'
        + '<div class="text"><h2 class="name"></h2><p class="cite"></p></div>'
        + '<div class="actions">'
        + `<button type="button" data-act="name" title="Copy the name">${ICONS.copy}<span>Name</span></button>`
        + `<button type="button" data-act="citation" title="Copy the linked citation (Alt+X)">${ICONS.copy}<span>Citation</span></button>`
        + `<button type="button" data-act="link" title="Copy a link to this document">${ICONS.link}<span>Link</span></button>`
        + '</div></section>';
      shadow.addEventListener('mousedown', (event) => { if (event.target.closest('button')) event.preventDefault(); });
      shadow.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button || !metadata) return;
        const act = button.dataset.act;
        if (act === 'citation') return run(page.copyCitation(), button);
        if (act === 'link') return run(copyLink(), button);
        const name = metadata.citation.title || metadata.citation.plain;
        const escaped = name.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        const italic = ['case', 'legislation'].includes(metadata.documentType);
        run(page.copyPayload({ plain: name, html: italic ? `<i>${escaped}</i>` : escaped }, `Copied name: ${name}`), button);
      });
      card = { host, name: shadow.querySelector('.name'), cite: shadow.querySelector('.cite'), canlii: shadow.querySelector('.canlii') };
      card.canlii.addEventListener('click', noCanlii);
      anchor.before(host);
      watchCard();
    }
    const name = current.citation.title || current.citation.plain;
    card.name.textContent = name;
    card.name.classList.toggle('case', current.documentType === 'case');
    card.cite.textContent = current.citation.citation || '';
    card.cite.hidden = !current.citation.citation;
    card.canlii.hidden = !settings.canliiButton;
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
  // Westlaw and Lexis: CanLII, lit when the document has a reliable CanLII version.

  // The button sits at the left of the title card; a floating copy appears in the bottom-left
  // corner once the card scrolls out of view (or always, when titles are not cleaned up).
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
      floating.textContent = 'CanLII';
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
    const wantsMetadata = provider === 'canlii' ? settings.canliiHeader : settings.cleanTitles || settings.canliiButton;
    if (!settings.unitCopyButtons) unmountBar();
    if (provider === 'canlii' && !settings.canliiHeader) unmountBanner();
    if (provider !== 'canlii') {
      if (!settings.cleanTitles) unmountCard();
      if (!settings.canliiButton) unmountCanliiButton();
      tameNativeTitle(settings.cleanTitles);
    }
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
    if (settings.unitCopyButtons) idle(() => fullModel().catch(() => {}), 2500);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.keys(settings).some((key) => changes[key])) return;
    for (const key of Object.keys(settings)) if (changes[key]) settings[key] = changes[key].newValue ?? settings[key];
    apply();
  });
  window.addEventListener('pageshow', (event) => { if (event.persisted) apply(); });
  chrome.storage.local.get(settings, (stored) => {
    Object.assign(settings, stored);
    idle(apply, 400);
  });
})();
