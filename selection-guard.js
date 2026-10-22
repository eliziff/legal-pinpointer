'use strict';

// Westlaw (every variant), Lexis Advance, Lexis+ and Practical Law open a small menu (highlight,
// add note, add to folder, copy with reference) when text is selected. The menu must never be drawn,
// so the page is never told that a selection is being made: from window capture listeners that run
// before any page listener (document_start), a press on the document's text and everything that
// follows it (the pointer moving with the button down, the selection starting and changing, the
// release, the click, the double click) stop here, as do selection changes and the key release of a
// keyboard selection. The browser's own selection, and copying it, are untouched. Presses on links,
// buttons, fields and Pinpointer's controls pass through. Menus opened some other way are hidden
// by their selectors.
(function guardSelection() {
  if (globalThis.LegalPinpointerSelectionGuard) return;
  globalThis.LegalPinpointerSelectionGuard = true;
  const MENUS = [
    'aside.doccontextmenu', '.doccontextmenu', '.lx-text-selection-menu', '[data-testid="selection-menu"]',
    '[class*="SelectionMenu"]', '[class*="selectionMenu"]', '[class*="selection-menu"]', '[class*="TextSelection"]',
    '[class*="textSelection"]', '[class*="text-selection"]', '[id*="SelectionMenu"]', '[id*="selectionMenu"]',
    '#co_selectionPopup', '.co_selectionPopup', '#co_annotationsSelectionMenu', '.co_textSelectionMenu',
    '.search-highlight-tooltip'
  ].join(', ');
  let enabled = true, style = null, pressing = false;

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
  const elementOf = (node) => node && (node.nodeType === 1 ? node : node.parentElement);
  const onControl = (event) => Boolean(elementOf(event.composedPath ? event.composedPath()[0] : event.target)?.closest(CONTROLS));

  // A selection outside fields and editable regions, which the page must not hear about.
  function textSelected() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !String(selection).trim()) return false;
    return !elementOf(selection.anchorNode)?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])');
  }

  const hide = (event) => event.stopImmediatePropagation();

  // The press that may start a selection: on the document's text, with the main button.
  for (const type of ['pointerdown', 'mousedown']) {
    window.addEventListener(type, (event) => {
      if (!enabled || event.button !== 0 || onControl(event)) return;
      pressing = true;
      hide(event);
    }, true);
  }
  for (const type of ['pointermove', 'mousemove']) {
    window.addEventListener(type, (event) => { if (pressing && event.buttons & 1) hide(event); }, true);
  }
  for (const type of ['pointerup', 'mouseup']) {
    window.addEventListener(type, (event) => {
      if (!enabled) return;
      if (pressing || (textSelected() && !onControl(event))) hide(event);
      if (type === 'mouseup') pressing = false;
    }, true);
  }
  window.addEventListener('pointercancel', () => { pressing = false; }, true);
  for (const type of ['click', 'dblclick', 'touchend']) {
    window.addEventListener(type, (event) => { if (enabled && textSelected() && !onControl(event)) hide(event); }, true);
  }
  // The selection starting and changing, however it was made (mouse, keyboard, double click).
  window.addEventListener('selectstart', (event) => { if (enabled && (pressing || !onControl(event))) hide(event); }, true);
  window.addEventListener('selectionchange', (event) => { if (enabled && (pressing || textSelected())) hide(event); }, true);
  // Keyboard selection (Shift+arrows) ends with a key release.
  window.addEventListener('keyup', (event) => {
    if (enabled && (event.shiftKey || event.key === 'Shift') && textSelected()) hide(event);
  }, true);
})();
