'use strict';

// Westlaw (every variant), Lexis Advance, Lexis+ and Practical Law open a small menu (highlight,
// add note, add to folder, copy with reference) whenever text is selected. Their menus listen for
// the release that ends a selection; this window-level capture listener runs before any page
// listener and stops that release from reaching them while text is selected. Clicks on links,
// buttons and fields pass through. Menus opened some other way are hidden by their selectors.
(function guardSelection() {
  if (globalThis.LegalPinpointerSelectionGuard) return;
  globalThis.LegalPinpointerSelectionGuard = true;
  const MENUS = [
    'aside.doccontextmenu', '.doccontextmenu', '.lx-text-selection-menu', '[data-testid="selection-menu"]',
    '[class*="SelectionMenu"]', '[class*="selectionMenu"]', '[class*="selection-menu"]', '[class*="TextSelection"]',
    '[class*="textSelection"]', '[class*="text-selection"]', '[id*="SelectionMenu"]', '[id*="selectionMenu"]',
    '#co_selectionPopup', '.co_selectionPopup', '#co_annotationsSelectionMenu', '.co_textSelectionMenu'
  ].join(', ');
  let enabled = true, style = null;

  function apply() {
    if (enabled && !style) {
      style = document.createElement('style');
      style.setAttribute('data-lp-ui', '');
      style.textContent = `${MENUS} { display: none !important; }`;
      (document.head || document.documentElement).appendChild(style);
    } else if (!enabled && style) {
      style.remove();
      style = null;
    }
  }
  apply();
  chrome.storage.local.get({ suppressSelectionMenus: true }, (stored) => { enabled = stored.suppressSelectionMenus !== false; apply(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.suppressSelectionMenus) { enabled = changes.suppressSelectionMenus.newValue !== false; apply(); }
  });

  const CONTROLS = 'a[href], button, input, select, textarea, label, summary, [role="button"], [role="menu"], [role="menuitem"], [role="dialog"], [contenteditable]:not([contenteditable="false"]), [data-lp-ui]';
  function selecting(event) {
    if (!enabled) return false;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !String(selection).trim()) return false;
    const target = event.composedPath ? event.composedPath()[0] : event.target;
    const element = target && (target.nodeType === 1 ? target : target.parentElement);
    return Boolean(element && !element.closest(CONTROLS));
  }
  const stop = (event) => { if (selecting(event)) event.stopImmediatePropagation(); };
  for (const type of ['mouseup', 'pointerup', 'touchend', 'click', 'dblclick', 'selectionchange']) {
    window.addEventListener(type, stop, true);
  }
  // Keyboard selection (Shift+arrows) ends with a key release on the document.
  window.addEventListener('keyup', (event) => { if (event.shiftKey || event.key === 'Shift') stop(event); }, true);
})();
