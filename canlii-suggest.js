'use strict';

// CanLII's name suggestions (the "Case name, citation or title" box): with the advanced setting
// "Alberta first among same-named Acts" (early.js marks <html data-lp-alberta-first>), legislation
// suggestions that share one exact title ("Business Corporations Act" in several provinces) list
// Alberta's first. Nothing else moves: a different title, a case, or a group without an Alberta
// Act keeps CanLII's order.
//
// Runs in the page's own world, because CanLII keeps each suggestion's data (its path, so its
// jurisdiction and type) on the suggestion through jQuery. It does nothing until a name box gets
// focus, then watches only the suggestion menu. Moving a suggestion's element keeps its data, so
// picking it (click or keyboard) opens the same document.
(function startCanliiSuggest() {
  if (window.LegalPinpointerSuggest) return;
  window.LegalPinpointerSuggest = true;
  const MENU = 'tt-id-dropdown-menu';
  let observer = null, sorting = false;

  const on = () => document.documentElement.hasAttribute('data-lp-alberta-first');
  const titleOf = (datum, element) => String(datum?.text || element.textContent || '')
    .split(',')[0].replace(/\s+/g, ' ').trim().toLowerCase();

  function sort(menu) {
    if (!on() || sorting) return;
    const $ = window.jQuery;
    for (const list of menu.querySelectorAll('.tt-dataset-id-dataset2 .tt-suggestions, .tt-dataset-id-dataset2')) {
      const items = [...list.children].filter((child) => child.classList.contains('tt-suggestion'));
      if (items.length < 2) continue;
      const groups = new Map();
      for (const element of items) {
        const datum = $ ? $(element).data('ttDatum') : null;
        const path = String(datum?.path || '');
        if (!/\/laws\//.test(path)) continue;
        const title = titleOf(datum, element);
        if (!title) continue;
        if (!groups.has(title)) groups.set(title, []);
        groups.get(title).push({ element, alberta: /^\/(?:en|fr)\/ab\//.test(path) });
      }
      sorting = true;
      try {
        for (const group of groups.values()) {
          if (group.length < 2 || group[0].alberta) continue;
          const alberta = group.find((entry) => entry.alberta);
          if (alberta) list.insertBefore(alberta.element, group[0].element);
        }
      } finally { sorting = false; }
    }
  }

  function watch() {
    const menu = document.getElementById(MENU);
    if (!menu || observer) return;
    observer = new MutationObserver(() => sort(menu));
    observer.observe(menu, { childList: true, subtree: true });
    sort(menu);
  }
  document.addEventListener('focusin', (event) => {
    if (on() && !observer && event.target?.matches?.('input.idAutocomplete, input.typeahead')) watch();
  }, true);
})();
