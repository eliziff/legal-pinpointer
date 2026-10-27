'use strict';

// Case Marker: coloured circles on CanLII search results and document titles, on the Westlaw and
// Lexis title, and on court decision pages (Lexum/Decisia), filed into any number of the current
// project's nested folders (a circle shows its deepest filing's path as nested rings; the picker is
// marker-core.js, Beaver's label editor). One identity across
// providers: a document's CanLII path ("ca/scc/doc/2016/2016scc27/2016scc27.html"), which Westlaw,
// Lexis and court pages resolve to, so a case filed on one shows as filed on the others; a decision
// with no CanLII version is keyed by its court page ("site:...") or else its citation ("cite:...").
// The data format is the original Case Marker's (canliiFolders, canliiMarkers, canliiProjects).
//
// Registered only while Case Marker is on (engine-worker.js), at document_start: circles are placed
// as the page is parsed, before its first paint, and never inserted or removed under the reader.
// A circle's size never depends on what is filed (badges float), so stored state can arrive later.
(function startCaseMarker() {
  if (globalThis.LegalPinpointerCaseMarker) return;
  const onCanlii = /(?:^|\.)canlii\.org$/.test(location.hostname);
  const onProvider = /(?:^|\.)(?:lexis|westlaw)\.com$/.test(location.hostname);
  const onCourtSite = !onCanlii && !onProvider;
  // Frames: only a court site's document frame (Decisia renders the decision in an iframe).
  if (window !== window.top && !onCourtSite) return;

  const core = globalThis.LegalPinpointerMarkerCore;
  const KEYS = ['caseMarker', 'canliiFolders', 'canliiMarkers', 'canliiProjects', 'canliiCurrentProject', 'canliiHotkeySlot1', 'canliiHotkeySlot2'];
  const state = { enabled: true, folders: {}, markers: {}, projects: {}, project: 'default', slot1: null, slot2: null };
  const wraps = new Map(); // key -> Set of circle wraps on this page
  const labels = new Map(); // key -> the name and citation shown on this page
  let editor = null, editorKey = null, hoveredKey = null, saveTimer = 0, ownWrite = false;

  const docKey = (href) => {
    try { return new URL(href, location.origin).pathname.replace(/^\/(?:en|fr)\//, ''); } catch (_) { return ''; }
  };
  // Past versions of legislation carry a numeric version id instead of /latest/.
  const currentVersion = (key) => !/\/laws\/[^/]+\/[^/]+\/\d+\//.test(key);
  const isDocument = (key) => /^[a-z]{2}\/[a-z]+\/doc\/\d{4}\/|^[a-z]{2}\/laws\/|^commentary\/doc\//.test(key);
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  // ---------------------------------------------------------------------------
  // State

  function load(stored) {
    state.enabled = stored.caseMarker !== false;
    state.folders = stored.canliiFolders || {};
    state.markers = stored.canliiMarkers || {};
    state.projects = stored.canliiProjects || {};
    if (!Object.keys(state.projects).length) state.projects = { default: { name: 'Default project', order: 0 } };
    state.project = state.projects[stored.canliiCurrentProject] ? stored.canliiCurrentProject
      : Object.entries(state.projects).sort((a, b) => (a[1].order || 0) - (b[1].order || 0))[0][0];
    state.slot1 = stored.canliiHotkeySlot1 || null;
    state.slot2 = stored.canliiHotkeySlot2 || null;
  }

  function save(delay = 0) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      ownWrite = true;
      chrome.storage.local.set({ canliiMarkers: state.markers }, () => { ownWrite = false; });
    }, delay);
  }

  function entry(key, create) {
    const marker = state.markers[key];
    if (!create) return marker?.byProject?.[state.project] || null;
    // Storage reloads replace the markers; the page's own label is attached whenever one is filed.
    if (labels.has(key)) remember(key, labels.get(key).text, labels.get(key).meta);
    const target = state.markers[key] ||= {};
    target.byProject ||= {};
    return target.byProject[state.project] ||= { folderPath: [] };
  }

  function prune(key) {
    const marker = state.markers[key];
    const data = marker?.byProject?.[state.project];
    if (data && !data.folderPath?.length && !data.folderIds?.length && !data.note && !data.badge) delete marker.byProject[state.project];
    if (marker && !Object.keys(marker.byProject || {}).length) delete state.markers[key];
  }

  const filed = (key) => core.filings(entry(key), state.folders, state.project);

  function remember(key, label, meta) {
    const marker = state.markers[key] ||= {};
    const text = clean(label);
    if (text && text.length >= (marker.fullDisplayText || '').length) marker.displayText = marker.fullDisplayText = text;
    const year = (text.match(/\b(?:18|19|20)\d{2}\b/) || key.match(/\/doc\/(\d{4})\//) || [])[0];
    if (year && !marker.year) marker.year = year.replace(/\D/g, '').slice(0, 4);
    if (meta) marker.meta = { ...(marker.meta || {}), ...meta };
  }

  // ---------------------------------------------------------------------------
  // Circles

  function circle(key) {
    const ids = filed(key), outer = core.circle(state.folders, ids);
    outer.dataset.key = key;
    outer.title = [core.filingNames(state.folders, ids).join(' · '), entry(key)?.note].filter(Boolean).join('\n') || 'File this document';
    return outer;
  }

  function render(wrap) {
    const key = wrap.dataset.key;
    const data = entry(key);
    const parts = [];
    const others = filed(key).length - 1;
    if (others > 0) {
      // Floats like the badge, so the circle's box never changes; drawn from the attribute, so it is never copied.
      const more = document.createElement('span');
      more.className = 'lpm-more';
      more.dataset.more = `+${others}`;
      parts.push(more);
    }
    if (data?.badge?.text) {
      const badge = document.createElement('span');
      badge.className = 'lpm-badge';
      badge.style.background = data.badge.color || '#5b6670';
      // Drawn by CSS from the attribute: the title Pinpointer cites from must not contain the badge's text.
      badge.dataset.badge = data.badge.text;
      parts.push(badge);
    }
    parts.push(circle(key));
    wrap.replaceChildren(...parts);
  }

  function attach(key, label, place, meta) {
    if (!key || !currentVersion(key)) return;
    // Only a filed document keeps its label in storage; others keep it here until they are filed.
    labels.set(key, { text: clean(label), meta });
    if (state.markers[key]) remember(key, label, meta);
    const wrap = document.createElement('span');
    wrap.className = 'lpm-wrap';
    wrap.setAttribute('data-lp-ui', '');
    wrap.dataset.key = key;
    wrap.dataset.label = clean(label);
    render(wrap);
    place(wrap);
    let set = wraps.get(key);
    if (!set) wraps.set(key, set = new Set());
    set.add(wrap);
  }

  function refresh(key) {
    for (const wrap of wraps.get(key) || []) {
      if (wrap.isConnected) render(wrap); else wraps.get(key).delete(wrap);
    }
  }

  function refreshAll() {
    for (const key of wraps.keys()) refresh(key);
  }

  // CanLII: search results and the open document's title, as the parser or CanLII's own scripts add
  // them. Called from a MutationObserver, so a circle is in place before the first paint that shows
  // its result or title.
  let seen = new WeakSet();
  function scanCanlii() {
    if (!state.enabled) return;
    if (location.hash.startsWith('#search/')) {
      for (const result of document.querySelectorAll('.searchResult[data-lbh-path]')) {
        if (seen.has(result)) continue;
        seen.add(result);
        const key = docKey(result.getAttribute('data-lbh-path'));
        if (!isDocument(key)) continue;
        const name = result.querySelector('.titleContainer .name');
        const label = clean(name ? name.textContent : result.getAttribute('data-lbh-title'));
        const number = result.parentElement?.querySelector('span[data-result-number]');
        attach(key, label, (wrap) => {
          if (number) { wrap.classList.add('lpm-index'); number.before(wrap); }
          else result.querySelector('.titleContainer')?.prepend(wrap);
        }, { type: result.getAttribute('data-lbh-type') || '' });
      }
    }
    const key = docKey(location.href);
    const title = isDocument(key) && document.querySelector('#title-container h1.main-title, h1.main-title');
    if (title && !seen.has(title)) {
      seen.add(title);
      const meta = { citation: document.querySelector('meta[name="lbh-citation"]')?.content || '',
        date: document.querySelector('meta[name="lbh-decision-date"]')?.content || '' };
      attach(key, title.textContent, (wrap) => { wrap.classList.add('lpm-title'); title.prepend(wrap); }, meta);
    }
  }

  // A court's Lexum/Decisia decision page: the circle starts on the page's own identity and moves to
  // the decision's CanLII identity once the engine has read the citations the page lists.
  const siteKey = (url) => {
    const match = String(url || '').match(/^https:\/\/([^/?#]+)\/([^/?#]+\/[^/?#]+)\/(?:en|fr)\/item\/(\d+)\//);
    return match ? `site:${match[1]}/${match[2]}/item/${match[3]}` : '';
  };
  function scanCourtSite() {
    if (!state.enabled) return;
    const title = document.querySelector('h3.title');
    if (!title || seen.has(title)) return;
    const key = siteKey(location.href);
    if (!key) return;
    seen.add(title);
    attach(key, title.textContent, (wrap) => { wrap.classList.add('lpm-title'); title.prepend(wrap); },
      { url: location.href.split(/[?#]/)[0], provider: 'court' });
    // The metadata table is parsed after the title; read it once the document is complete.
    const resolve = () => {
      const text = Array.from(document.querySelectorAll('.metadata td'), (cell) => clean(cell.textContent)).filter(Boolean).join(' | ').slice(0, 4000);
      if (!text) return;
      chrome.runtime.sendMessage({ type: 'LEGAL_PINPOINTER_CASE_IDENTITY', text }).then((response) => {
        const canliiKey = response?.ok && response.canliiUrl ? docKey(response.canliiUrl) : '';
        if (!canliiKey || !isDocument(canliiKey)) return;
        const label = labels.get(key);
        for (const wrap of wraps.get(key) || []) {
          wrap.dataset.key = canliiKey;
          if (label) labels.set(canliiKey, label);
          let set = wraps.get(canliiKey);
          if (!set) wraps.set(canliiKey, set = new Set());
          set.add(wrap);
          render(wrap);
        }
        wraps.delete(key);
      }, () => {});
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resolve, { once: true }); else resolve();
  }

  const scan = onCanlii ? scanCanlii : onCourtSite ? scanCourtSite : () => {};

  // The identity a provider page files under: its CanLII document path, else its court page, else
  // its citation.
  function identity(canliiUrl, citation, siteUrl) {
    const key = canliiUrl ? docKey(canliiUrl) : '';
    if (key && isDocument(key)) return key;
    const site = siteKey(siteUrl);
    if (site) return site;
    const cite = clean(citation).toLowerCase();
    return cite ? `cite:${cite}` : '';
  }

  // A circle for a document shown on another provider, placed by the caller; replaces any earlier one.
  function attachExternal(slot, canliiUrl, citation, label, meta, siteUrl) {
    const key = identity(canliiUrl, citation, siteUrl);
    const existing = slot.querySelector('.lpm-wrap');
    if (existing && existing.dataset.key === key) return;
    existing?.remove();
    if (!key || !state.enabled) return;
    attach(key, label, (wrap) => { wrap.classList.add('lpm-title'); slot.appendChild(wrap); }, meta);
  }

  globalThis.LegalPinpointerCaseMarker = { attachExternal, identity, enabled: () => state.enabled };

  function removeAll() {
    for (const set of wraps.values()) for (const wrap of set) wrap.remove();
    wraps.clear();
    seen = new WeakSet();
    hidePicker();
  }

  // ---------------------------------------------------------------------------
  // Picker

  function hidePicker() {
    editor?.close();
  }

  function showPicker(key, anchor) {
    hidePicker();
    editorKey = key;
    editor = core.openEditor({
      anchor, folders: state.folders, project: state.project, data: entry(key) || {},
      // A press on a circle is the circle's own: it toggles this editor or opens another.
      inside: (event) => Boolean(circleIn(event)),
      onChange({ folderIds, note, badge }) {
        const data = entry(key, true);
        core.setFilings(data, folderIds, state.folders);
        if (note) data.note = note; else delete data.note;
        if (badge) data.badge = badge; else delete data.badge;
        prune(key);
        save();
        refresh(key);
      },
      onClose() { editor = editorKey = null; }
    });
    editor.project = state.project;
  }

  // ---------------------------------------------------------------------------
  // Events: one listener each, on the window in the capture phase, registered before the page's own.

  // A document's circle; the editor's own small circles carry no key.
  const circleIn = (event) => event.composedPath().find((node) => node.nodeType === 1 && node.classList.contains('lpm-circle') && node.dataset.key);
  window.addEventListener('mousedown', (event) => {
    if (circleIn(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  window.addEventListener('click', (event) => {
    const target = circleIn(event);
    if (target) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const key = target.dataset.key;
      if (editorKey === key) hidePicker(); else showPicker(key, target);
    }
  }, true);

  window.addEventListener('pointerover', (event) => {
    hoveredKey = event.target.closest?.('.lpm-wrap')?.dataset.key || null;
  }, { capture: true, passive: true });

  // C and V file the hovered circle into the two hotkey folders; N clears it.
  window.addEventListener('keydown', (event) => {
    if (!hoveredKey || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !['KeyC', 'KeyV', 'KeyN'].includes(event.code)) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    const folder = event.code === 'KeyC' ? state.slot1 : event.code === 'KeyV' ? state.slot2 : null;
    if (event.code !== 'KeyN' && !folder) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    core.setFilings(entry(hoveredKey, true), folder && state.folders[folder]?.projectId === state.project ? [folder] : [], state.folders);
    prune(hoveredKey);
    save();
    refresh(hoveredKey);
  }, true);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !KEYS.some((key) => changes[key])) return;
    if (changes.canliiMarkers && ownWrite && Object.keys(changes).length === 1) return;
    chrome.storage.local.get(KEYS, (stored) => {
      const wasEnabled = state.enabled;
      load(stored);
      if (!state.enabled) return removeAll();
      if (!wasEnabled) return scan();
      refreshAll();
      if (editor && editor.project !== state.project) hidePicker(); else editor?.refresh(state.folders);
    });
  });

  // Circles go in as the page is parsed (and, on CanLII's search page, as results arrive): the
  // observer's callback runs before the browser paints what was just added. A document page stops
  // watching once its title has its circle, or once it has finished loading without one.
  if (onProvider) {
    chrome.storage.local.get(KEYS, (stored) => { load(stored); refreshAll(); });
    return;
  }
  let watching = false;
  const observer = new MutationObserver(() => {
    scan();
    if (!location.hash.startsWith('#search/') && (document.querySelector('.lpm-title') || document.readyState === 'complete')) {
      observer.disconnect();
      watching = false;
    }
  });
  const watch = () => { if (!watching) { watching = true; observer.observe(document, { childList: true, subtree: true }); } };
  watch();
  addEventListener('hashchange', () => { if (location.hash.startsWith('#search/')) { watch(); scan(); } });
  chrome.storage.local.get(KEYS, (stored) => {
    load(stored);
    refreshAll();
    scan();
  });
})();
