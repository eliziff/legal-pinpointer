'use strict';

// Case Marker: coloured circles on CanLII search results and document titles, on the Westlaw and
// Lexis title, and on court decision pages (Lexum/Decisia), filed into the current project's folders
// (up to three levels; a circle shows the folder path as nested rings). One identity across
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

  const RING = ['', '62%', '52%'];
  const BADGE_MAX = 19;
  const KEYS = ['caseMarker', 'canliiFolders', 'canliiMarkers', 'canliiProjects', 'canliiCurrentProject', 'canliiHotkeySlot1', 'canliiHotkeySlot2'];
  const state = { enabled: true, folders: {}, markers: {}, projects: {}, project: 'default', slot1: null, slot2: null };
  const wraps = new Map(); // key -> Set of circle wraps on this page
  const labels = new Map(); // key -> the name and citation shown on this page
  let picker = null, pickerKey = null, hoveredKey = null, saveTimer = 0, ownWrite = false;

  const docKey = (href) => {
    try { return new URL(href, location.origin).pathname.replace(/^\/(?:en|fr)\//, ''); } catch (_) { return ''; }
  };
  // Past versions of legislation carry a numeric version id instead of /latest/.
  const currentVersion = (key) => !/\/laws\/[^/]+\/[^/]+\/\d+\//.test(key);
  const isDocument = (key) => /^[a-z]{2}\/[a-z]+\/doc\/\d{4}\/|^[a-z]{2}\/laws\/|^commentary\/doc\//.test(key);
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const escapeHtml = (value) => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
    if (data && !data.folderPath?.length && !data.note && !data.badge) delete marker.byProject[state.project];
    if (marker && !Object.keys(marker.byProject || {}).length) delete state.markers[key];
  }

  function children(parentId) {
    return Object.entries(state.folders)
      .filter(([, folder]) => (folder.parentId || null) === parentId && folder.projectId === state.project)
      .sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
  }

  function validPath(path) {
    const valid = [];
    for (const id of path || []) {
      const folder = state.folders[id];
      if (!folder || folder.projectId !== state.project || (folder.parentId || null) !== (valid[valid.length - 1] || null)) break;
      valid.push(id);
    }
    return valid;
  }

  function pathTo(id) {
    const path = [];
    for (let at = id; at && state.folders[at]; at = state.folders[at].parentId) path.unshift(at);
    return validPath(path);
  }

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
    const path = validPath(entry(key)?.folderPath);
    const outer = document.createElement('span');
    outer.className = 'lpm-circle';
    outer.dataset.key = key;
    if (!path.length) outer.classList.add('lpm-empty');
    let parent = outer;
    path.slice(0, 3).forEach((id, depth) => {
      const ring = depth ? document.createElement('span') : outer;
      ring.style.background = state.folders[id].color || '#9aa5b1';
      if (depth) {
        ring.className = 'lpm-ring';
        ring.style.width = ring.style.height = RING[depth];
        parent.appendChild(ring);
      }
      parent = ring;
    });
    const data = entry(key);
    outer.title = data?.note || (path.length ? path.map((id) => state.folders[id].name).join(' › ') : 'Mark this document');
    return outer;
  }

  function render(wrap) {
    const key = wrap.dataset.key;
    const data = entry(key);
    const parts = [];
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
    if (picker) picker.hidden = true;
    pickerKey = null;
  }

  function folderRows(parentId, depth, selected, rows) {
    for (const [id, folder] of children(parentId)) {
      rows.push(`<button type="button" class="lpm-row${selected.includes(id) ? ' lpm-on' : ''}" data-folder="${id}" style="--depth:${depth}">`
        + `<span class="lpm-dot" style="background:${escapeHtml(folder.color || '#9aa5b1')}"></span><span>${escapeHtml(folder.name)}</span></button>`);
      if (depth < 2) folderRows(id, depth + 1, selected, rows);
    }
    return rows;
  }

  function showPicker(key, anchor) {
    if (!picker) {
      picker = document.createElement('div');
      picker.className = 'lpm-picker';
      picker.setAttribute('data-lp-ui', '');
      picker.addEventListener('click', onPickerClick);
      picker.addEventListener('input', onPickerInput);
      document.body.appendChild(picker);
    }
    pickerKey = key;
    const data = entry(key) || {};
    const path = validPath(data.folderPath);
    const rows = folderRows(null, 0, path, []);
    picker.innerHTML = `<div class="lpm-head"><span>${escapeHtml(state.projects[state.project]?.name || 'Project')}</span><button type="button" class="lpm-x" data-close aria-label="Close">×</button></div>`
      + `<div class="lpm-list"><button type="button" class="lpm-row${path.length ? '' : ' lpm-on'}" data-folder=""><span class="lpm-dot lpm-none"></span><span>None</span></button>`
      + (rows.length ? rows.join('') : '<p class="lpm-help">Create folders in the Legal Pinpointer menu (Marker tab).</p>') + '</div>'
      + `<textarea class="lpm-note" rows="2" placeholder="Note" maxlength="2000">${escapeHtml(data.note || '')}</textarea>`
      + `<div class="lpm-badge-row"><input class="lpm-badge-text" maxlength="${BADGE_MAX}" placeholder="Badge" value="${escapeHtml(data.badge?.text || '')}">`
      + `<input class="lpm-badge-color" type="color" value="${escapeHtml(data.badge?.color || '#5b6670')}" title="Badge colour"></div>`;
    picker.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const width = 260, height = picker.offsetHeight;
    const left = Math.min(Math.max(8, rect.left), innerWidth - width - 8);
    const top = rect.bottom + height + 8 > innerHeight ? Math.max(8, rect.top - height - 6) : rect.bottom + 6;
    picker.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  function onPickerClick(event) {
    if (event.target.closest('[data-close]')) return hidePicker();
    const row = event.target.closest('[data-folder]');
    if (!row || !pickerKey) return;
    const data = entry(pickerKey, true);
    data.folderPath = row.dataset.folder ? pathTo(row.dataset.folder) : [];
    prune(pickerKey);
    save();
    refresh(pickerKey);
    for (const other of picker.querySelectorAll('.lpm-row')) other.classList.toggle('lpm-on', data.folderPath.includes(other.dataset.folder) || (!data.folderPath.length && !other.dataset.folder));
  }

  function onPickerInput(event) {
    if (!pickerKey) return;
    const data = entry(pickerKey, true);
    if (event.target.classList.contains('lpm-note')) data.note = event.target.value.trim();
    if (event.target.matches('.lpm-badge-text, .lpm-badge-color')) {
      const text = picker.querySelector('.lpm-badge-text').value.trim().slice(0, BADGE_MAX);
      if (text) data.badge = { text, color: picker.querySelector('.lpm-badge-color').value };
      else delete data.badge;
    }
    prune(pickerKey);
    save(400);
    refresh(pickerKey);
  }

  // ---------------------------------------------------------------------------
  // Events: one listener each, on the window in the capture phase, registered before the page's own.

  const circleIn = (event) => event.composedPath().find((node) => node.nodeType === 1 && node.classList.contains('lpm-circle'));
  window.addEventListener('mousedown', (event) => {
    if (circleIn(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  window.addEventListener('click', (event) => {
    const target = circleIn(event);
    if (target) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const key = target.dataset.key;
      if (pickerKey === key && picker && !picker.hidden) hidePicker(); else showPicker(key, target);
      return;
    }
    if (picker && !picker.hidden && !picker.contains(event.target)) hidePicker();
  }, true);

  window.addEventListener('pointerover', (event) => {
    hoveredKey = event.target.closest?.('.lpm-wrap')?.dataset.key || null;
  }, { capture: true, passive: true });

  // C and V file the hovered circle into the two hotkey folders; N clears it.
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && picker && !picker.hidden) { hidePicker(); return; }
    if (!hoveredKey || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !['KeyC', 'KeyV', 'KeyN'].includes(event.code)) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    const folder = event.code === 'KeyC' ? state.slot1 : event.code === 'KeyV' ? state.slot2 : null;
    if (event.code !== 'KeyN' && !folder) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    entry(hoveredKey, true).folderPath = folder ? pathTo(folder) : [];
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
      if (picker && !picker.hidden && pickerKey) showPicker(pickerKey, document.querySelector(`.lpm-circle[data-key="${CSS.escape(pickerKey)}"]`) || picker);
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
