'use strict';

// Westlaw, Lexis and Practical Law open a menu (highlight, add note, add to folder, copy with
// reference) whenever text is selected. Their menus listen for the release that ends a selection;
// this window-level capture listener runs before any page listener and stops that release from
// reaching them while text is selected. Clicks on controls, editable fields and links pass through.
(function guardSelection() {
  if (globalThis.LegalPinpointerSelectionGuard) return;
  globalThis.LegalPinpointerSelectionGuard = true;
  let enabled = true;
  chrome.storage.local.get({ suppressSelectionMenus: true }, (stored) => { enabled = stored.suppressSelectionMenus !== false; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.suppressSelectionMenus) enabled = changes.suppressSelectionMenus.newValue !== false;
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
  for (const type of ['mouseup', 'pointerup', 'touchend', 'click', 'selectionchange']) {
    window.addEventListener(type, stop, true);
  }
  // Keyboard selection (Shift+arrows) ends with a key release on the document.
  window.addEventListener('keyup', (event) => { if (event.shiftKey || event.key === 'Shift') stop(event); }, true);
})();
