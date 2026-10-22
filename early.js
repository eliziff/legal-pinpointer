'use strict';

// First thing on the pages Pinpointer decorates (document_start, before the page's own scripts):
// - on Westlaw and Lexis, warms the citation engine while the page is still loading, so the title's
//   CanLII button does not wait for it (CanLII pages need it only for a copy: page-ui.js warms it
//   when one looks likely);
// - routes presses on Pinpointer's own controls (any element with data-lp-action, in the light DOM
//   or an open shadow root) from a window capture listener registered before any page listener, so
//   a provider's click handlers, drag code or selection menus never see or swallow them;
// - marks <html> when titles (or CanLII's breadcrumbs) are to be left as the provider draws them,
//   before the first paint, so the default styles (content.css) never switch on or off under the reader.
(function startEarly() {
  if (globalThis.LegalPinpointerActions) return;
  const actions = globalThis.LegalPinpointerActions = new Map();
  const top = window === window.top;
  const { hostname, pathname } = location;
  const documentPage = /canlii\.org$/.test(hostname) ? /\/(?:doc|laws)\//.test(pathname)
    : hostname === 'advance.lexis.com' ? /^\/(?:document|search)\//.test(pathname)
      : /^\/Document\//.test(pathname);
  if (top && documentPage && !/canlii\.org$/.test(hostname)) chrome.runtime.sendMessage({ type: 'LEGAL_PINPOINTER_WARM' }).catch(() => {});

  // The page UI's settings, read now so they are in hand by the time page-ui.js runs (at
  // document_end, when a storage read would wait behind the page's own start-up scripts).
  const PAGE_SETTINGS = { unitCopyButtons: true, canliiHeader: true, cleanTitles: true, canliiButton: true, caseMarker: true };
  globalThis.LegalPinpointerEarlySettings = new Promise((resolve) => chrome.storage.local.get(PAGE_SETTINGS, (stored) => {
    if (top && !/canlii\.org$/.test(hostname)) document.documentElement.classList.toggle('lp-raw-titles', stored.cleanTitles === false);
    if (top && /canlii\.org$/.test(hostname)) document.documentElement.classList.toggle('lp-no-canlii-name', stored.canliiHeader === false);
    globalThis.LegalPinpointerEarlySettingsValue = stored;
    resolve(stored);
  }));

  function control(event) {
    for (const node of event.composedPath()) {
      if (node.nodeType !== 1) return null;
      if (node.hasAttribute('data-lp-action')) return node;
    }
    return null;
  }

  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick']) {
    window.addEventListener(type, (event) => {
      const element = control(event);
      if (!element) return;
      event.stopImmediatePropagation();
      // Pressing a control keeps the reader's selection (the controls copy it).
      if (type === 'mousedown') event.preventDefault();
      if (type !== 'click') return;
      const handler = actions.get(element.getAttribute('data-lp-action'));
      // A handler returns false to let the element's default (a link opening) go ahead.
      if (handler && handler(element, event) !== false) event.preventDefault();
    }, true);
  }

  // Westlaw's title is a link back to the same document: the first click of a drag or a triple-click
  // reloads the page, and its drag code takes the press. While titles are clean it is plain text:
  // presses on it reach only the browser's own text selection.
  // Presses and selection changes reach page-ui.js (which keeps a drag that starts in the title
  // inside it, and gets ready to copy once text is selected) before any page listener, or the
  // selection-menu guard, which hides them from the page, can stop them.
  const selectionHooks = globalThis.LegalPinpointerSelectionHooks = new Set();
  window.addEventListener('selectionchange', () => { for (const hook of selectionHooks) hook(); }, { capture: true, passive: true });
  if (top && !/canlii\.org$/.test(hostname)) {
    window.addEventListener('mousedown', (event) => globalThis.LegalPinpointerTitlePress?.(event), { capture: true, passive: true });
    window.addEventListener('mouseup', () => globalThis.LegalPinpointerTitlePress?.(null), { capture: true, passive: true });
  }

  if (top && /westlaw\.com$/.test(hostname)) {
    const TITLE_LINK = '#co_docHeaderTitleLine a, #titleInfo a';
    for (const type of ['mousedown', 'pointerdown', 'click', 'dblclick', 'auxclick', 'dragstart']) {
      window.addEventListener(type, (event) => {
        if (document.documentElement.classList.contains('lp-raw-titles') || !event.target.closest?.(TITLE_LINK)) return;
        event.stopImmediatePropagation();
        if (type === 'click' || type === 'dblclick' || type === 'auxclick' || type === 'dragstart') event.preventDefault();
      }, true);
    }
  }
})();
