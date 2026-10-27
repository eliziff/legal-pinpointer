'use strict';

// The popup: Copy (this document), Marker (Case Marker projects and folders) and Settings.
// It paints from static HTML, reads storage once, and renders the Marker tab only when opened.
(() => {
  const $ = (id) => document.getElementById(id);
  const SETTINGS = {
    pinpointStyle: 'full', linkFullTextFragmentPinpoint: false, buildTextFragmentWithoutStructure: false, copyShortcuts: true,
    unitCopyButtons: true, canliiHeader: true, cleanTitles: true, canliiButton: true, suppressSelectionMenus: true,
    sonarWakeTabs: true, providerHeader: true, caseMarker: true, pdfFragments: true, pdfLinkFormat: 'url', popupTab: 'marker'
  };
  const MARKER = { canliiFolders: {}, canliiMarkers: {}, canliiProjects: {}, canliiCurrentProject: null, canliiHotkeySlot1: null, canliiHotkeySlot2: null };
  // Folders take the next unused colour of this palette instead of all starting the same.
  const PALETTE = ['#3b7ddd', '#e0533d', '#2f9e6e', '#e3a21a', '#8b5cf6', '#db4f9a', '#1aa3a3', '#ef7d22', '#5f6f86', '#7cb32a'];
  const settings = { ...SETTINGS };
  const marker = { folders: {}, markers: {}, projects: {}, project: 'default', slot1: null, slot2: null };
  let markerRendered = false, nameMode = null, statusTimer = 0;
  let supported = false, canliiAvailable = false, busy = false;

  function status(text, error = false) {
    clearTimeout(statusTimer);
    $('status').textContent = text;
    $('status').classList.toggle('error', error);
    if (text && !error) statusTimer = setTimeout(() => { $('status').textContent = ''; }, 3200);
  }

  const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const id = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  // ---------------------------------------------------------------------------
  // Tabs

  function selectTab(tab) {
    if (!['marker', 'copy', 'settings'].includes(tab)) tab = 'marker';
    document.body.dataset.tab = tab;
    for (const button of document.querySelectorAll('.tabs [data-tab]')) button.setAttribute('aria-selected', button.dataset.tab === tab);
    for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== tab;
    if (tab === 'marker' && !markerRendered) renderMarker();
    if (tab === 'settings') renderSlots();
    if (settings.popupTab !== tab) { settings.popupTab = tab; chrome.storage.local.set({ popupTab: tab }); }
  }
  document.querySelector('.tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (button) selectTab(button.dataset.tab);
  });

  // ---------------------------------------------------------------------------
  // Copy

  const activeTab = () => chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (!tab || typeof tab.id !== 'number') throw new Error('No active tab is available.');
    return tab;
  });

  function send(tabId, message) {
    return new Promise((resolve, reject) => chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error('Open a CanLII, Lexis or Westlaw document to copy from it.'));
      else resolve(response);
    }));
  }

  function setBusy(value) {
    busy = value;
    for (const button of document.querySelectorAll('[data-copy]')) button.disabled = busy || !supported;
    $('open-canlii').disabled = busy || !supported || !canliiAvailable;
  }

  async function inspect() {
    try {
      const tab = await activeTab();
      const result = await send(tab.id, { type: 'LEGAL_PINPOINTER_INSPECT', metadataOnly: true });
      if (!result?.ok) throw new Error(result?.message || 'This page is not a supported legal document.');
      const provider = { canlii: 'CanLII', lexis: 'Lexis', westlaw: 'Westlaw' }[result.provider] || result.provider;
      $('doc-kind').textContent = `${provider} · ${result.documentType}${result.selectedPinpoint ? ` · selection ${result.selectedPinpoint}` : ''}${result.provider !== 'canlii' ? (result.canliiAvailable ? ' · on CanLII' : ' · not found on CanLII') : ''}`;
      $('doc-cite').textContent = result.citation;
      supported = true;
      canliiAvailable = result.canliiAvailable && result.provider !== 'canlii';
    } catch (error) {
      $('doc-kind').textContent = error.message;
      $('doc-cite').textContent = '';
      supported = canliiAvailable = false;
    }
    setBusy(busy);
  }

  async function copy(mode) {
    if (busy || !supported) return;
    setBusy(true);
    try {
      const tab = await activeTab();
      const result = await send(tab.id, { type: 'LEGAL_PINPOINTER_COPY', mode, source: 'popup' });
      if (!result?.ok) throw new Error(result?.message || 'Copy failed.');
      status(result.message);
    } catch (error) {
      status(error.message, true);
    } finally {
      setBusy(false);
    }
  }

  document.querySelector('.grid').addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.copy) return copy(button.dataset.copy);
    setBusy(true);
    try {
      const tab = await activeTab();
      const result = await send(tab.id, { type: 'LEGAL_PINPOINTER_OPEN_CANLII', source: 'popup' });
      if (!result?.ok) throw new Error(result?.message || 'CanLII could not be opened.');
      window.close();
    } catch (error) { status(error.message, true); setBusy(false); }
  });

  for (const input of document.querySelectorAll('input[name="pinpointStyle"]')) {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      settings.pinpointStyle = input.value;
      chrome.storage.local.set({ pinpointStyle: input.value });
      status(input.value === 'bare' ? 'Bare pinpoints: 12–14, 7(2)–(4)' : 'Full pinpoints: at paras 12–14, ss 7(2)–(4)');
    });
  }

  document.querySelector('.list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-launch]');
    if (!button) return;
    button.disabled = true;
    try {
      const reply = await chrome.runtime.sendMessage({ type: button.dataset.launch });
      if (!reply?.ok) throw new Error(reply?.message || 'That could not be opened.');
      if (button.dataset.launch === 'LEGAL_PINPOINTER_PDF_LINK') status(reply.message || 'Copied the link.');
      else window.close();
    } catch (error) { status(error.message, true); }
    finally { button.disabled = false; }
  });

  chrome.commands.getAll().then((commands) => {
    const missing = commands.filter((command) => ['find-in-page', 'canlii-text-search', 'pdf-fragment-link'].includes(command.name) && !command.shortcut);
    if (!missing.length) return;
    $('shortcut-hint').hidden = false;
    $('shortcut-hint').textContent = `${missing.length === 1 ? 'A shortcut is' : 'Some shortcuts are'} unassigned or taken by another extension. Settings → Change keyboard shortcuts.`;
  }).catch(() => {});

  // ---------------------------------------------------------------------------
  // Settings

  function renderSettings() {
    for (const input of document.querySelectorAll('[data-setting]')) input.checked = Boolean(settings[input.dataset.setting]);
    for (const select of document.querySelectorAll('[data-setting-select]')) select.value = settings[select.dataset.settingSelect];
    const style = document.querySelector(`input[name="pinpointStyle"][value="${settings.pinpointStyle === 'bare' ? 'bare' : 'full'}"]`);
    if (style) style.checked = true;
  }

  // Settings live in the Settings tab and, for Case Marker, in the Marker tab's own settings.
  const onSettingChange = (event) => {
    const target = event.target;
    if (target.dataset.setting) {
      settings[target.dataset.setting] = target.checked;
      chrome.storage.local.set({ [target.dataset.setting]: target.checked });
    } else if (target.dataset.settingSelect) {
      settings[target.dataset.settingSelect] = target.value;
      chrome.storage.local.set({ [target.dataset.settingSelect]: target.value });
    } else if (target.dataset.slot) {
      const key = target.dataset.slot;
      marker[key === 'canliiHotkeySlot1' ? 'slot1' : 'slot2'] = target.value || null;
      chrome.storage.local.set({ [key]: target.value || null });
    }
  };
  document.querySelector('[data-panel="settings"]').addEventListener('change', onSettingChange);
  $('marker-settings').addEventListener('change', onSettingChange);
  $('marker-settings-toggle').addEventListener('click', () => {
    const open = $('marker-settings').hidden;
    $('marker-settings').hidden = !open;
    $('marker-settings-toggle').setAttribute('aria-expanded', open);
    if (open) renderSlots();
  });

  $('shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

  $('export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ canliiFolders: marker.folders, canliiMarkers: marker.markers, canliiProjects: marker.projects,
      canliiCurrentProject: marker.project, canliiHotkeySlot1: marker.slot1, canliiHotkeySlot2: marker.slot2 }, null, 1)], { type: 'application/json' });
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `case-marker-${new Date().toISOString().slice(0, 10)}.json` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  });
  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async () => {
    const file = $('import-file').files[0];
    $('import-file').value = '';
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      if (!imported || typeof imported !== 'object' || (!imported.canliiFolders && !imported.canliiMarkers)) throw new Error('That file has no Case Marker folders or markers.');
      Object.assign(marker.projects, imported.canliiProjects || {});
      Object.assign(marker.folders, imported.canliiFolders || {});
      for (const [key, value] of Object.entries(imported.canliiMarkers || {})) {
        const existing = marker.markers[key];
        marker.markers[key] = existing ? { ...existing, ...value, byProject: { ...(existing.byProject || {}), ...(value.byProject || {}) } } : value;
      }
      ensureProject();
      await saveMarker(true);
      markerRendered = false;
      renderSlots();
      status(`Imported ${Object.keys(imported.canliiFolders || {}).length} folders and ${Object.keys(imported.canliiMarkers || {}).length} documents.`);
    } catch (error) { status(error.message || 'That file could not be imported.', true); }
  });

  // ---------------------------------------------------------------------------
  // Case Marker

  function ensureProject() {
    if (!Object.keys(marker.projects).length) marker.projects = { default: { name: 'Default project', order: 0 } };
    if (!marker.projects[marker.project]) marker.project = projects()[0][0];
  }

  const projects = () => Object.entries(marker.projects).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
  const children = (parentId) => Object.entries(marker.folders)
    .filter(([, folder]) => (folder.parentId || null) === parentId && folder.projectId === marker.project)
    .sort((a, b) => (a[1].order || 0) - (b[1].order || 0));

  function saveMarker(all = false) {
    const values = { canliiFolders: marker.folders, canliiProjects: marker.projects, canliiCurrentProject: marker.project };
    if (all) Object.assign(values, { canliiMarkers: marker.markers, canliiHotkeySlot1: marker.slot1, canliiHotkeySlot2: marker.slot2 });
    return chrome.storage.local.set(values);
  }

  function nextColor(parentId) {
    const used = new Set(children(parentId).map(([, folder]) => folder.color));
    if (parentId) used.add(marker.folders[parentId]?.color);
    const start = Object.values(marker.folders).filter((folder) => folder.projectId === marker.project).length;
    for (let step = 0; step < PALETTE.length; step += 1) {
      const color = PALETTE[(start + step) % PALETTE.length];
      if (!used.has(color)) return color;
    }
    return PALETTE[start % PALETTE.length];
  }

  // The folder tree is Beaver's source tree (ResearchLabelTree.tsx + ResearchTree.tsx): folders nest
  // without limit, each document hangs under every folder it is filed in (and not again above a
  // deeper one), and folders and documents move by drag, by their menu or by Alt+arrows.
  const core = globalThis.LegalPinpointerMarkerCore;
  const FOLDER_DRAG = 'application/x-lp-folder', DOCUMENT_DRAG = 'application/x-lp-document';
  const closed = new Set(); // folders start open
  let selected = null, adding, renaming = null, dragged = null, editor = null, colorTimer = 0;
  const tree = () => core.folderChildren(marker.folders, marker.project);
  const projectData = (key) => marker.markers[key]?.byProject?.[marker.project];
  const documentFilings = (key) => core.filings(projectData(key), marker.folders, marker.project);
  const documentTitle = (key) => marker.markers[key]?.fullDisplayText || marker.markers[key]?.displayText || key;
  const inside = (id, ancestor) => core.folderPath(marker.folders, id).includes(ancestor);
  const pathName = (id) => core.filingNames(marker.folders, [id])[0];

  function sortDocuments(keys) {
    const sort = $('viewer-sort').value;
    if (sort === 'alpha') keys.sort((a, b) => documentTitle(a).localeCompare(documentTitle(b)));
    if (sort === 'newest') keys.sort((a, b) => (marker.markers[b].year || '').localeCompare(marker.markers[a].year || ''));
    return keys;
  }
  const projectDocuments = () => Object.keys(marker.markers).filter((key) => projectData(key));
  /** In a folder or anywhere below it (all documents for the root): Copy links. */
  const within = (folderId) => sortDocuments(projectDocuments().filter((key) => !folderId || documentFilings(key).some((id) => inside(id, folderId))));
  /** One pass over the documents per render: the documents shown under each folder (filed there and
   *  not also deeper inside it; the root holds the unfiled ones) and each folder's count (filed in it
   *  or below). A render costs documents x depth, never folders x documents. */
  function treeIndex() {
    const paths = new Map(), shown = new Map(), counts = new Map(), unfiled = [];
    const path = (id) => { let value = paths.get(id); if (!value) paths.set(id, value = core.folderPath(marker.folders, id)); return value; };
    const documents = sortDocuments(projectDocuments());
    for (const key of documents) {
      const ids = documentFilings(key);
      if (!ids.length) { unfiled.push(key); continue; }
      const reached = new Set();
      for (const id of ids) {
        for (const ancestor of path(id)) reached.add(ancestor);
        if (ids.some((other) => other !== id && path(other).includes(id))) continue;
        if (!shown.has(id)) shown.set(id, []);
        shown.get(id).push(key);
      }
      for (const id of reached) counts.set(id, (counts.get(id) || 0) + 1);
    }
    return { folders: tree(), shown, counts, unfiled, total: documents.length };
  }

  function saveDocuments() {
    return chrome.storage.local.set({ canliiMarkers: marker.markers });
  }

  function renderProjects() {
    $('project').innerHTML = projects().map(([projectId, project]) =>
      `<option value="${escapeHtml(projectId)}"${projectId === marker.project ? ' selected' : ''}>${escapeHtml(project.name)}</option>`).join('');
  }

  // The tree is virtualized: every row is ROW px tall, the tree is one flat list of rows (a folder,
  // the folders and documents under it, an add field), and only the rows in or near the visible part
  // of the popup are in the page. Screen readers get the flat-tree attributes (aria-level, set size,
  // position). 3,000 documents in 300 folders render as fast as ten.
  const ROW = 28, OVERSCAN = 8, scroller = document.querySelector('main');
  let rows = [], drawFrame = 0;

  // The index changes only with the data; opening or closing a folder re-flattens the cached one.
  let cachedIndex = null;
  function flatten(reindex) {
    const index = cachedIndex = reindex || !cachedIndex ? treeIndex() : cachedIndex, list = [{ kind: 'root', depth: 0, total: index.total }];
    const walk = (parentId, depth) => {
      const siblings = index.folders.get(parentId) || [];
      siblings.forEach(([folderId, folder], position) => {
        const documents = index.shown.get(folderId) || [];
        const hasChildren = (index.folders.get(folderId) || []).length > 0 || documents.length > 0, open = !closed.has(folderId);
        list.push({ kind: 'folder', id: folderId, folder, depth, hasChildren, open, count: index.counts.get(folderId) || 0, position: position + 1, size: siblings.length });
        if (!open) return;
        walk(folderId, depth + 1);
        for (const key of documents) list.push({ kind: 'document', key, depth: depth + 1 });
        if (adding === folderId) list.push({ kind: 'add', depth: depth + 1 });
      });
    };
    walk(null, 0);
    for (const key of index.unfiled) list.push({ kind: 'document', key, depth: 0 });
    if (adding === null) list.push({ kind: 'add', depth: 0 });
    return { list, index };
  }

  // Row icons are CSS masks (ui.css .ico): a row is plain spans, with no SVG to parse.
  const ICON = (name, style = '') => `<span class="ico i-${name} ticon"${style ? ` style="${style}"` : ''}></span>`;
  const GLYPH = (key) => key.includes('/laws/') ? 'scroll' : key.startsWith('commentary/') ? 'file' : 'gavel';

  function rowHtml(row, at) {
    const place = `class="tvrow" data-at="${at}" style="top:${at * ROW}px;padding-inline-start:${row.depth * 16}px" aria-level="${row.depth + 1}"`;
    if (row.kind === 'root') {
      return `<div role="treeitem" ${place} aria-selected="${selected === null}"><button type="button" class="trow troot" data-select="" data-root aria-pressed="${selected === null}">`
        + `<span class="tspace"></span><span class="tname">All documents</span><span class="tcount">${row.total || ''}</span><span class="tactions"></span></button></div>`;
    }
    if (row.kind === 'add') return `<div role="treeitem" ${place}><div class="tadd"><input class="tname-input" data-add maxlength="80" placeholder="Folder name" aria-label="Folder name"></div></div>`;
    if (row.kind === 'document') {
      const key = row.key, title = escapeHtml(documentTitle(key)), note = projectData(key)?.note || '', url = documentUrl(key);
      return `<div role="treeitem" ${place} aria-label="${title}"><div class="trow" data-document="${escapeHtml(key)}" draggable="true" title="${note ? `${title}\n${escapeHtml(note)}` : title}">`
        + `<span class="tspace"></span><span class="tglyph">${ICON(GLYPH(key))}</span>`
        + (url ? `<a class="tname" href="${escapeHtml(url)}" target="_blank" rel="noopener">${title}</a>` : `<span class="tname">${title}</span>`)
        + `<span class="tactions"><button type="button" class="tmore" data-menu aria-label="${title} options">${ICON('more')}</button></span></div></div>`;
    }
    const { id: folderId, folder, open } = row, color = escapeHtml(folder.color || '#9aa5b1'), name = escapeHtml(folder.name), chosen = selected === folderId;
    const label = renaming === folderId
      ? `<input class="tname-input" data-rename value="${name}" maxlength="80" aria-label="Folder name">`
      : `<button type="button" class="tname" data-select="${folderId}" aria-pressed="${chosen}" title="${escapeHtml(pathName(folderId))}">${name}</button>`;
    return `<div role="treeitem" ${place} aria-label="${name}" aria-selected="${chosen}" aria-setsize="${row.size}" aria-posinset="${row.position}"${row.hasChildren ? ` aria-expanded="${open}"` : ''}>`
      + `<div class="trow${chosen ? ' is-selected' : ''}" data-folder="${folderId}" draggable="${renaming !== folderId}">`
      + (row.hasChildren ? `<button type="button" class="tchev${open ? ' open' : ''}" data-toggle aria-label="${open ? 'Collapse' : 'Expand'} ${name}">${ICON('chevron')}</button>` : '<span class="tspace"></span>')
      // Filled in the folder's colour; the chevron already says open or closed.
      + `<label class="tglyph" title="${name} colour">${ICON('folder', `color:${color}`)}<input type="color" value="${color}" data-color aria-label="${name} colour"></label>`
      + `${label}<span class="tcount">${row.count || ''}</span>`
      + `<span class="tactions"><button type="button" class="tmore" data-menu aria-label="${name} options">${ICON('more')}</button></span></div></div>`;
  }

  // The rows in the page are one contiguous block, in index order (so Tab order follows the tree).
  // A frame only makes sure the rows in view (and NEAR beyond) are there; rows up to FAR beyond are
  // built in idle time, a few at a time, so scrolling usually finds them ready and a frame does
  // nothing. Rows well past FAR are dropped.
  const NEAR = 2, FAR = 30, drawnRows = new Map();
  let blockStart = 0, blockEnd = 0, fillHandle = 0;
  function rowsFrom(start, end) {
    const indices = Array.from({ length: end - start }, (_, i) => start + i), template = document.createElement('template');
    template.innerHTML = indices.map((at) => rowHtml(rows[at], at)).join('');
    [...template.content.children].forEach((element, i) => drawnRows.set(indices[i], element));
    return template.content;
  }
  function inView() {
    const tree = $('tree'), offset = scroller.getBoundingClientRect().top - tree.getBoundingClientRect().top;
    return [Math.max(0, Math.floor(offset / ROW) - NEAR), Math.min(rows.length, Math.ceil((offset + scroller.clientHeight) / ROW) + NEAR)];
  }
  function extend(start, end) {
    const tree = $('tree');
    if (start < blockStart) { tree.prepend(rowsFrom(start, blockStart)); blockStart = start; }
    if (end > blockEnd) { tree.append(rowsFrom(blockEnd, end)); blockEnd = end; }
  }
  function draw(force = false) {
    const tree = $('tree');
    if (!tree.offsetParent) return;
    const [start, end] = inView();
    if (force || end <= blockStart || start >= blockEnd) {
      const focused = force && document.activeElement && tree.contains(document.activeElement) ? document.activeElement.closest('[data-select]') : null;
      drawnRows.clear();
      tree.replaceChildren(rowsFrom(start, end));
      [blockStart, blockEnd] = [start, end];
      if (focused) tree.querySelector(`[data-select="${CSS.escape(focused.dataset.select)}"]`)?.focus({ preventScroll: true });
    } else extend(start, end);
    for (; blockStart < start - FAR * 2; blockStart++) { drawnRows.get(blockStart)?.remove(); drawnRows.delete(blockStart); }
    for (; blockEnd > end + FAR * 2; blockEnd--) { drawnRows.get(blockEnd - 1)?.remove(); drawnRows.delete(blockEnd - 1); }
    if (!fillHandle) fillHandle = requestIdleCallback(fill, { timeout: 250 });
  }
  function fill(deadline) {
    fillHandle = 0;
    if (!$('tree').offsetParent) return;
    const [start, end] = inView(), low = Math.max(0, start - FAR), high = Math.min(rows.length, end + FAR);
    while (deadline.timeRemaining() > 3 && (blockStart > low || blockEnd < high)) {
      if (blockEnd < high && (blockEnd - end <= start - blockStart || blockStart <= low)) extend(blockStart, Math.min(high, blockEnd + 6));
      else extend(Math.max(low, blockStart - 6), blockEnd);
    }
    if (blockStart > low || blockEnd < high) fillHandle = requestIdleCallback(fill, { timeout: 250 });
  }
  scroller.addEventListener('scroll', () => {
    if (!drawFrame) drawFrame = requestAnimationFrame(() => { drawFrame = 0; draw(); });
  }, { passive: true });

  /** Scrolls a row into view (drawing it) and returns its element. */
  function reveal(at) {
    if (at < 0) return null;
    const tree = $('tree'), offset = scroller.getBoundingClientRect().top - tree.getBoundingClientRect().top;
    if (at * ROW < offset) scroller.scrollTop -= offset - at * ROW;
    else if ((at + 1) * ROW > offset + scroller.clientHeight) scroller.scrollTop += (at + 1) * ROW - (offset + scroller.clientHeight);
    draw();
    return drawnRows.get(at) || null;
  }

  /** `reindex: false` when only what is open changed (the data did not). */
  function renderTree({ reindex = true } = {}) {
    const active = document.activeElement?.closest?.('#tree [data-select]')?.dataset.select;
    const { list, index } = flatten(reindex);
    rows = list;
    $('tree').style.height = `${rows.length * ROW}px`;
    $('tree-empty').hidden = Boolean(index.folders.size || index.total || adding !== undefined);
    $('copy-links').title = `Copy the links in ${selected ? marker.folders[selected]?.name : 'all documents'}`;
    draw(true);
    const editing = rows.findIndex((row) => row.kind === 'add' || (row.kind === 'folder' && row.id === renaming));
    if (editing >= 0) { reveal(editing)?.querySelector('input.tname-input')?.focus(); return; }
    if (active !== undefined) focusFolder(active);
  }
  /** Focuses a folder's row (or "All documents" for ''), scrolling it into view. */
  function focusFolder(id) {
    const at = rows.findIndex((row) => id ? row.kind === 'folder' && row.id === id : row.kind === 'root');
    reveal(at)?.querySelector('[data-select]')?.focus({ preventScroll: true });
  }

  function renderMarker() {
    markerRendered = true;
    renderProjects();
    renderTree();
  }

  // Folders: name, nest, order, delete.

  function canMove(id, parentId) {
    return marker.folders[id]?.projectId === marker.project && (!parentId || marker.folders[parentId]?.projectId === marker.project && !inside(parentId, id));
  }
  /** Puts a folder at `position` among `parentId`'s children and renumbers them. */
  function move(id, parentId, position) {
    if (!canMove(id, parentId)) return;
    const siblings = (tree().get(parentId) || []).map(([siblingId]) => siblingId).filter((siblingId) => siblingId !== id);
    siblings.splice(Math.max(0, Math.min(position, siblings.length)), 0, id);
    marker.folders[id].parentId = parentId;
    siblings.forEach((siblingId, order) => { marker.folders[siblingId].order = order; });
    if (parentId) closed.delete(parentId);
    saveMarker();
    renderTree();
    focusFolder(id);
  }
  function moveKey(id, key) {
    const folder = marker.folders[id], parentId = folder.parentId || null;
    const siblings = (tree().get(parentId) || []).map(([siblingId]) => siblingId), index = siblings.indexOf(id);
    if (key === 'ArrowUp' && index > 0) move(id, parentId, index - 1);
    if (key === 'ArrowDown' && index < siblings.length - 1) move(id, parentId, index + 1);
    if (key === 'ArrowRight' && index > 0) move(id, siblings[index - 1], (tree().get(siblings[index - 1]) || []).length);
    if (key === 'ArrowLeft' && parentId) {
      const grandparent = marker.folders[parentId].parentId || null;
      move(id, grandparent, (tree().get(grandparent) || []).findIndex(([siblingId]) => siblingId === parentId) + 1);
    }
  }

  function commitName(input) {
    const name = input.value.trim();
    if (input.hasAttribute('data-add')) {
      if (adding === undefined) return;
      const parentId = adding;
      adding = undefined;
      if (name) {
        const folderId = id();
        marker.folders[folderId] = { name, color: nextColor(parentId), parentId, projectId: marker.project, order: (tree().get(parentId) || []).length };
        if (parentId) closed.delete(parentId);
        saveMarker();
        renderSlots();
      }
    } else {
      if (!renaming) return;
      const folder = marker.folders[renaming];
      renaming = null;
      if (folder && name && name !== folder.name) { folder.name = name; saveMarker(); renderSlots(); }
    }
    renderTree();
  }
  function cancelName() {
    adding = undefined;
    renaming = null;
    renderTree();
  }

  function deleteFolder(folderId) {
    const gone = new Set([folderId, ...projectFolders().filter((other) => inside(other, folderId))]);
    for (const goneId of gone) delete marker.folders[goneId];
    for (const key of projectDocuments()) {
      const data = projectData(key);
      core.setFilings(data, core.filings(data, marker.folders, marker.project), marker.folders);
    }
    if (gone.has(selected)) selected = null;
    if (gone.has(marker.slot1)) marker.slot1 = null;
    if (gone.has(marker.slot2)) marker.slot2 = null;
    saveMarker(true);
    renderTree();
    renderSlots();
  }
  const projectFolders = () => Object.keys(marker.folders).filter((folderId) => marker.folders[folderId].projectId === marker.project);

  // Documents: file, remove.

  function file(key, folderIds) {
    const data = projectData(key);
    if (!data) return;
    core.setFilings(data, folderIds, marker.folders);
    saveDocuments();
    renderTree();
  }
  function removeDocument(key) {
    delete marker.markers[key].byProject[marker.project];
    if (!Object.keys(marker.markers[key].byProject).length) delete marker.markers[key];
    saveDocuments();
    renderTree();
  }
  function label(key, anchor) {
    editor?.close();
    editor = core.openEditor({
      anchor, folders: marker.folders, project: marker.project, data: projectData(key),
      onChange({ folderIds, note, badge }) {
        const data = projectData(key);
        if (!data) return;
        core.setFilings(data, folderIds, marker.folders);
        if (note) data.note = note; else delete data.note;
        if (badge) data.badge = badge; else delete data.badge;
        saveDocuments();
        renderTree();
      },
      onClose() { editor = null; }
    });
  }

  // The row menu (Beaver's MoreActionsMenu): one at a time; Delete and Remove ask once more.

  function openMenu(button) {
    closeMenu();
    const row = button.closest('.trow'), folderId = row.dataset.folder, key = row.dataset.document;
    let items;
    if (folderId) {
      const folder = marker.folders[folderId], siblings = (tree().get(folder.parentId || null) || []).map(([siblingId]) => siblingId);
      items = [['rename', 'Rename'], ['sub', 'New folder inside'], ['up', 'Move up', siblings[0] === folderId],
        ['down', 'Move down', siblings[siblings.length - 1] === folderId], ...(folder.parentId ? [['out', 'Move out']] : []), ['delete', 'Delete']];
    } else items = [['label', 'Folders and note'], ['remove', 'Remove']];
    const menu = $('menu');
    menu.innerHTML = items.map(([action, text, disabled]) => `<button type="button" role="menuitem" data-action="${action}"${disabled ? ' disabled' : ''}>${text}</button>`).join('');
    menu.hidden = false;
    menu.target = { folderId, key, button };
    const rect = button.getBoundingClientRect();
    menu.style.left = `${Math.max(6, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 6))}px`;
    menu.style.top = `${rect.bottom + menu.offsetHeight + 4 > innerHeight ? Math.max(6, rect.top - menu.offsetHeight - 4) : rect.bottom + 4}px`;
    button.setAttribute('aria-expanded', 'true');
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  function closeMenu(refocus = false) {
    const menu = $('menu');
    if (menu.hidden) return;
    menu.hidden = true;
    menu.target?.button.removeAttribute('aria-expanded');
    if (refocus && menu.target?.button.isConnected) menu.target.button.focus();
  }
  $('menu').addEventListener('click', (event) => {
    const item = event.target.closest('[data-action]');
    if (!item || item.disabled) return;
    const { folderId, key, button } = $('menu').target, action = item.dataset.action;
    if ((action === 'delete' || action === 'remove') && !item.dataset.armed) {
      item.dataset.armed = 'true';
      item.textContent = action === 'delete' ? 'Delete with its subfolders?' : 'Remove from this project?';
      return;
    }
    closeMenu();
    if (action === 'rename') { renaming = folderId; renderTree(); }
    else if (action === 'sub') { closed.delete(folderId); adding = folderId; renderTree(); }
    else if (action === 'up') moveKey(folderId, 'ArrowUp');
    else if (action === 'down') moveKey(folderId, 'ArrowDown');
    else if (action === 'out') moveKey(folderId, 'ArrowLeft');
    else if (action === 'delete') deleteFolder(folderId);
    else if (action === 'label') label(key, button.closest('.trow'));
    else if (action === 'remove') removeDocument(key);
  });
  $('menu').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); return; }
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const items = [...$('menu').querySelectorAll('button:not(:disabled)')], index = items.indexOf(document.activeElement);
    items[(index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus();
  });
  addEventListener('pointerdown', (event) => { if (!$('menu').hidden && !$('menu').contains(event.target) && !event.target.closest('[data-menu]')) closeMenu(); }, true);

  // Tree events.

  $('tree').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const row = button.closest('.trow'), folderId = row?.dataset.folder;
    if (button.hasAttribute('data-menu')) { if ($('menu').target?.button === button && !$('menu').hidden) closeMenu(); else openMenu(button); }
    else if (button.hasAttribute('data-toggle')) { if (!closed.delete(folderId)) closed.add(folderId); renderTree({ reindex: false }); }
    else if (button.hasAttribute('data-select')) {
      // Choosing a folder changes only which row is marked: redraw the rows in view.
      selected = button.dataset.select || null;
      $('copy-links').title = `Copy the links in ${selected ? marker.folders[selected]?.name : 'all documents'}`;
      draw(true);
    }
  });

  // Colour changes repaint the folder at once and save when the picker settles.
  $('tree').addEventListener('input', (event) => {
    if (!event.target.hasAttribute('data-color')) return;
    marker.folders[event.target.closest('.trow').dataset.folder].color = event.target.value;
    event.target.previousElementSibling.style.color = event.target.value;
    clearTimeout(colorTimer);
    colorTimer = setTimeout(saveMarker, 250);
  });

  $('tree').addEventListener('keydown', (event) => {
    if (event.target.matches('.tname-input')) {
      if (event.key === 'Enter') { event.preventDefault(); commitName(event.target); }
      if (event.key === 'Escape') { event.preventDefault(); cancelName(); }
      return;
    }
    const button = event.target.closest('[data-select]');
    if (!button || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const folderId = button.dataset.select, hasChildren = folderId && tree().has(folderId);
    if (event.altKey && folderId) return moveKey(folderId, event.key);
    if (event.key === 'ArrowRight' && hasChildren) { closed.delete(folderId); renderTree({ reindex: false }); focusFolder(folderId); return; }
    if (event.key === 'ArrowLeft' && folderId) {
      if (hasChildren && !closed.has(folderId)) { closed.add(folderId); renderTree({ reindex: false }); focusFolder(folderId); }
      else focusFolder(marker.folders[folderId].parentId || '');
      return;
    }
    // Up and down walk "All documents" and the folders in the whole list, drawn or not.
    const ids = rows.flatMap((row) => row.kind === 'root' ? [''] : row.kind === 'folder' ? [row.id] : []), index = ids.indexOf(folderId);
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : index + (event.key === 'ArrowUp' ? -1 : 1);
    focusFolder(ids[Math.max(0, Math.min(ids.length - 1, target))]);
  });
  $('tree').addEventListener('focusout', (event) => { if (event.target.matches?.('.tname-input')) commitName(event.target); });

  // Drag: a folder before, inside or after another (or to the top level on "All documents"); a
  // document onto a folder files it there.
  $('tree').addEventListener('dragstart', (event) => {
    const row = event.target.closest?.('.trow');
    if (!row) return;
    dragged = row.dataset.folder ? { folder: row.dataset.folder } : { document: row.dataset.document };
    event.dataTransfer.setData(dragged.folder ? FOLDER_DRAG : DOCUMENT_DRAG, dragged.folder || dragged.document);
    event.dataTransfer.effectAllowed = 'move';
  });
  /** The drop line or ring is a class on the row, never a re-render: the dragged row must survive. */
  function markDrop(target) {
    for (const row of $('tree').querySelectorAll('.drop-before, .drop-inside, .drop-after')) row.classList.remove('drop-before', 'drop-inside', 'drop-after');
    if (target) $('tree').querySelector(target.id ? `.trow[data-folder="${CSS.escape(target.id)}"]` : '.troot')?.classList.add(`drop-${target.mode}`);
  }
  $('tree').addEventListener('dragend', () => { dragged = null; markDrop(null); });
  $('tree').addEventListener('dragleave', (event) => { if (!$('tree').contains(event.relatedTarget)) markDrop(null); });
  function dropTarget(event) {
    const row = event.target.closest?.('.trow[data-folder], .troot');
    if (!row || !dragged) return null;
    if (row.classList.contains('troot')) return dragged.folder && canMove(dragged.folder, null) ? { id: '', mode: 'inside' } : null;
    const folderId = row.dataset.folder, folder = marker.folders[folderId];
    if (dragged.document) return { id: folderId, mode: 'inside' };
    const box = row.getBoundingClientRect(), y = box.height ? (event.clientY - box.top) / box.height : 0.5;
    const mode = y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside';
    return canMove(dragged.folder, mode === 'inside' ? folderId : folder.parentId || null) ? { id: folderId, mode } : null;
  }
  $('tree').addEventListener('dragover', (event) => {
    const target = dropTarget(event);
    markDrop(target);
    if (target) event.preventDefault();
  });
  $('tree').addEventListener('drop', (event) => {
    const target = dropTarget(event);
    event.preventDefault();
    markDrop(null);
    if (!target) return;
    if (dragged.document) return file(dragged.document, [target.id]);
    if (!target.id) return move(dragged.folder, null, (tree().get(null) || []).length);
    const folder = marker.folders[target.id], parentId = folder.parentId || null;
    if (target.mode === 'inside') return move(dragged.folder, target.id, (tree().get(target.id) || []).length);
    const siblings = (tree().get(parentId) || []).map(([siblingId]) => siblingId).filter((siblingId) => siblingId !== dragged.folder);
    move(dragged.folder, parentId, siblings.indexOf(target.id) + (target.mode === 'after' ? 1 : 0));
  });

  $('add-folder').addEventListener('click', () => { adding = null; renderTree(); });
  $('viewer-sort').addEventListener('change', renderTree);

  function documentUrl(key) {
    if (key.startsWith('cite:') || key.startsWith('site:')) return marker.markers[key]?.meta?.url || '';
    return `https://www.canlii.org/en/${key.replace(/^\/+/, '')}`;
  }

  $('copy-links').addEventListener('click', async () => {
    const items = within(selected).map((key) => ({ key, title: documentTitle(key), note: projectData(key)?.note || '' }));
    if (!items.length) return status('Nothing to copy.', true);
    const plain = items.map((item) => `${item.title}${item.note ? ` — ${item.note}` : ''}\n${documentUrl(item.key)}`).join('\n');
    const html = items.map((item) => `<a href="${escapeHtml(documentUrl(item.key))}">${escapeHtml(item.title)}</a>${item.note ? ` — ${escapeHtml(item.note)}` : ''}`).join('<br>');
    try {
      // A copy event: Chrome's async write wraps the HTML in a document of its own, which Word
      // pastes as a paragraph of its own.
      let copied = false;
      const onCopy = (event) => { event.preventDefault(); event.clipboardData.setData('text/plain', plain); event.clipboardData.setData('text/html', html); copied = true; };
      document.addEventListener('copy', onCopy, { once: true, capture: true });
      try { document.execCommand('copy'); } finally { document.removeEventListener('copy', onCopy, true); }
      if (!copied) await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([plain], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' })
      })]);
      status(`Copied ${items.length} link${items.length === 1 ? '' : 's'}`);
    } catch (error) { status('The browser denied clipboard access.', true); }
  });

  function renderSlots() {
    const options = ['<option value="">—</option>'], folders = tree();
    const walk = (parentId, prefix) => {
      for (const [folderId, folder] of folders.get(parentId) || []) {
        options.push(`<option value="${folderId}">${escapeHtml(prefix + folder.name)}</option>`);
        walk(folderId, `${prefix}${folder.name} › `);
      }
    };
    walk(null, '');
    for (const select of document.querySelectorAll('[data-slot]')) {
      select.innerHTML = options.join('');
      select.value = (select.dataset.slot === 'canliiHotkeySlot1' ? marker.slot1 : marker.slot2) || '';
    }
  }

  function askName(mode, initial = '') {
    nameMode = mode;
    $('name-form').hidden = false;
    $('name-input').value = initial;
    $('name-input').placeholder = mode.kind === 'project-add' ? 'New project name' : 'Project name';
    $('name-input').focus();
    $('name-input').select();
  }

  $('name-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('name-input').value.trim();
    $('name-form').hidden = true;
    if (!name || !nameMode) return;
    if (nameMode.kind === 'project-add') {
      const projectId = id();
      marker.projects[projectId] = { name, order: projects().length };
      marker.project = projectId;
      selected = null;
    } else if (nameMode.kind === 'project-rename' && marker.projects[marker.project]) {
      marker.projects[marker.project].name = name;
    }
    nameMode = null;
    saveMarker();
    renderMarker();
    renderSlots();
  });
  $('name-cancel').addEventListener('click', () => { $('name-form').hidden = true; nameMode = null; });

  $('project').addEventListener('change', () => {
    marker.project = $('project').value;
    selected = null;
    editor?.close();
    saveMarker();
    renderMarker();
    renderSlots();
  });

  let armedProject = 0;
  const trashIcon = document.querySelector('[data-project="delete"]').innerHTML;
  const disarm = (button) => { button.innerHTML = trashIcon; button.classList.remove('text-brand-text', 'w-auto', 'px-2'); };
  document.querySelector('.project').addEventListener('click', (event) => {
    const button = event.target.closest('[data-project]');
    if (!button) return;
    const act = button.dataset.project;
    if (act === 'add') return askName({ kind: 'project-add' });
    if (act === 'rename') return askName({ kind: 'project-rename' }, marker.projects[marker.project]?.name || '');
    if (projects().length < 2) return status('Keep at least one project.', true);
    if (!armedProject) {
      button.textContent = 'Delete?';
      button.classList.add('text-brand-text', 'w-auto', 'px-2');
      armedProject = setTimeout(() => { armedProject = 0; disarm(button); }, 2500);
      return;
    }
    clearTimeout(armedProject);
    armedProject = 0;
    for (const [folderId, folder] of Object.entries(marker.folders)) if (folder.projectId === marker.project) delete marker.folders[folderId];
    for (const value of Object.values(marker.markers)) delete value?.byProject?.[marker.project];
    delete marker.projects[marker.project];
    ensureProject();
    selected = null;
    saveMarker(true);
    renderMarker();
    renderSlots();
    disarm(button);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.canliiMarkers) return;
    marker.markers = changes.canliiMarkers.newValue || {};
    if (markerRendered && !$('tree').querySelector('.tname-input')) renderTree();
  });

  // ---------------------------------------------------------------------------

  chrome.storage.local.get({ ...SETTINGS, ...MARKER }, (stored) => {
    for (const key of Object.keys(SETTINGS)) settings[key] = stored[key];
    marker.folders = stored.canliiFolders || {};
    marker.markers = stored.canliiMarkers || {};
    marker.projects = stored.canliiProjects || {};
    marker.project = stored.canliiCurrentProject;
    marker.slot1 = stored.canliiHotkeySlot1;
    marker.slot2 = stored.canliiHotkeySlot2;
    ensureProject();
    renderSettings();
    selectTab(settings.popupTab);
  });
  setBusy(false);
  inspect();
})();
