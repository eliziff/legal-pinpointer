'use strict';

// First thing on the pages Pinpointer decorates (document_start, before the page's own scripts):
// - on Westlaw and Lexis, warms the citation engine while the page is still loading, so the title's
//   CanLII button does not wait for it (CanLII pages need it only for a copy: page-ui.js warms it
//   when one looks likely);
// - routes presses on Pinpointer's own controls (any element with data-lp-action, in the light DOM
//   or an open shadow root) from a window capture listener registered before any page listener, so
//   a provider's click handlers, drag code or selection menus never see or swallow them;
// - marks <html> when titles are to be left as the provider draws them, before the first paint, so
//   the default clean-title styles (content.css) never switch on or off under the reader.
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
})();
