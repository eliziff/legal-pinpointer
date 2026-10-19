'use strict';

// The popup: Copy (this document), Marker (Case Marker projects and folders) and Settings.
// It paints from static HTML, reads storage once, and renders the Marker tab only when opened.
(() => {
  const $ = (id) => document.getElementById(id);
  const SETTINGS = {
    pinpointStyle: 'full', linkFullTextFragmentPinpoint: false, buildTextFragmentWithoutStructure: false, copyShortcuts: true,
    unitCopyButtons: true, canliiHeader: true, cleanTitles: true, canliiButton: true, suppressSelectionMenus: true,
    sonarWakeTabs: true, caseMarker: true, pdfFragments: true, pdfLinkFormat: 'url', popupTab: 'copy'
  };
  const MARKER = { canliiFolders: {}, canliiMarkers: {}, canliiProjects: {}, canliiCurrentProject: null, canliiHotkeySlot1: null, canliiHotkeySlot2: null };
  // Folders take the next unused colour of this palette instead of all starting the same.
  const PALETTE = ['#3b7ddd', '#e0533d', '#2f9e6e', '#e3a21a', '#8b5cf6', '#db4f9a', '#1aa3a3', '#ef7d22', '#5f6f86', '#7cb32a'];
  const settings = { ...SETTINGS };
  const marker = { folders: {}, markers: {}, projects: {}, project: 'default', slot1: null, slot2: null };
  let markerRendered = false, viewerFolder = null, nameMode = null, statusTimer = 0;
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
    if (!['copy', 'marker', 'settings'].includes(tab)) tab = 'copy';
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

  document.querySelector('[data-panel="settings"]').addEventListener('change', (event) => {
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
  const descendants = (folderId) => children(folderId).flatMap(([childId]) => [childId, ...descendants(childId)]);

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

  // Documents filed in each folder of this project (a document in a subfolder counts for its parents).
  function filed() {
    const byFolder = new Map();
    for (const [key, value] of Object.entries(marker.markers)) {
      const path = value?.byProject?.[marker.project]?.folderPath || [];
      for (const folderId of path) {
        if (!byFolder.has(folderId)) byFolder.set(folderId, []);
        byFolder.get(folderId).push([key, value]);
      }
    }
    return byFolder;
  }

  function renderProjects() {
    $('project').innerHTML = projects().map(([projectId, project]) =>
      `<option value="${escapeHtml(projectId)}"${projectId === marker.project ? ' selected' : ''}>${escapeHtml(project.name)}</option>`).join('');
  }

  function renderTree() {
    const counts = filed();
    const rows = [];
    const walk = (parentId, depth) => {
      for (const [folderId, folder] of children(parentId)) {
        const count = counts.get(folderId)?.length || 0;
        rows.push(`<div class="folder${viewerFolder === folderId ? ' open' : ''}" data-id="${folderId}" style="--depth:${depth}">`
          + `<span class="swatch" style="background:${escapeHtml(folder.color)}"><input type="color" value="${escapeHtml(folder.color)}" data-color title="Colour"></span>`
          + `<button type="button" class="folder-name" data-view>${escapeHtml(folder.name)}</button><span class="count">${count || ''}</span>`
          + '<span class="tools">'
          + (depth < 2 ? '<button type="button" data-sub title="New subfolder">+</button>' : '')
          + '<button type="button" data-rename title="Rename">✎</button><button type="button" data-up title="Move up">↑</button>'
          + '<button type="button" data-down title="Move down">↓</button><button type="button" class="danger" data-delete title="Delete">×</button></span></div>');
        if (depth < 2) walk(folderId, depth + 1);
      }
    };
    walk(null, 0);
    $('tree').innerHTML = rows.join('');
  }

  function documentUrl(key) {
    return `https://www.canlii.org/en/${key.replace(/^\/+/, '')}`;
  }

  function viewerItems() {
    const items = (filed().get(viewerFolder) || []).slice();
    const title = ([key, value]) => value.fullDisplayText || value.displayText || key;
    const sort = $('viewer-sort').value;
    if (sort === 'alpha') items.sort((a, b) => title(a).localeCompare(title(b)));
    if (sort === 'newest') items.sort((a, b) => (b[1].year || '').localeCompare(a[1].year || ''));
    return items.map((item) => ({ key: item[0], title: title(item), note: item[1].byProject?.[marker.project]?.note || '' }));
  }

  function renderViewer() {
    const folder = viewerFolder && marker.folders[viewerFolder];
    $('viewer').hidden = !folder;
    if (!folder) return;
    $('viewer-title').textContent = folder.name;
    const items = viewerItems();
    $('viewer-list').innerHTML = items.length ? items.map((item) => `<li><a href="${escapeHtml(documentUrl(item.key))}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>`
      + (item.note ? `<small>${escapeHtml(item.note)}</small>` : '') + '</li>').join('') : '<li class="empty">Nothing filed here yet.</li>';
  }

  function renderMarker() {
    markerRendered = true;
    renderProjects();
    renderTree();
    renderViewer();
  }

  function renderSlots() {
    const options = ['<option value="">—</option>'];
    const walk = (parentId, prefix) => {
      for (const [folderId, folder] of children(parentId)) {
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
      viewerFolder = null;
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
    viewerFolder = null;
    saveMarker();
    renderMarker();
    renderSlots();
  });

  let armedProject = 0;
  document.querySelector('.project').addEventListener('click', (event) => {
    const button = event.target.closest('[data-project]');
    if (!button) return;
    const act = button.dataset.project;
    if (act === 'add') return askName({ kind: 'project-add' });
    if (act === 'rename') return askName({ kind: 'project-rename' }, marker.projects[marker.project]?.name || '');
    if (projects().length < 2) return status('Keep at least one project.', true);
    if (!armedProject) {
      button.textContent = 'Delete?';
      button.style.width = 'auto';
      armedProject = setTimeout(() => { armedProject = 0; button.textContent = '🗑'; button.style.width = ''; }, 2500);
      return;
    }
    clearTimeout(armedProject);
    armedProject = 0;
    for (const [folderId, folder] of Object.entries(marker.folders)) if (folder.projectId === marker.project) delete marker.folders[folderId];
    for (const value of Object.values(marker.markers)) delete value?.byProject?.[marker.project];
    delete marker.projects[marker.project];
    ensureProject();
    viewerFolder = null;
    saveMarker(true);
    renderMarker();
    renderSlots();
    button.textContent = '🗑';
    button.style.width = '';
  });

  function addFolder(parentId) {
    const folderId = id();
    marker.folders[folderId] = { name: 'New folder', color: nextColor(parentId), parentId: parentId || null,
      projectId: marker.project, order: children(parentId).length };
    saveMarker();
    renderTree();
    renameFolder(folderId);
  }
  $('add-folder').addEventListener('click', () => addFolder(null));

  function renameFolder(folderId) {
    const row = $('tree').querySelector(`[data-id="${folderId}"]`);
    const name = row?.querySelector('.folder-name');
    if (!name) return;
    const input = Object.assign(document.createElement('input'), { className: 'folder-edit', value: marker.folders[folderId].name, maxLength: 80 });
    name.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (keep && value) { marker.folders[folderId].name = value; saveMarker(); }
      renderTree();
      renderViewer();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  function move(folderId, step) {
    const siblings = children(marker.folders[folderId].parentId || null).map(([siblingId]) => siblingId);
    const at = siblings.indexOf(folderId), to = at + step;
    if (to < 0 || to >= siblings.length) return;
    [siblings[at], siblings[to]] = [siblings[to], siblings[at]];
    siblings.forEach((siblingId, order) => { marker.folders[siblingId].order = order; });
    saveMarker();
    renderTree();
  }

  const armed = new Map();
  function remove(folderId, button) {
    if (!armed.has(folderId)) {
      button.classList.add('armed');
      button.textContent = 'Delete?';
      armed.set(folderId, setTimeout(() => { armed.delete(folderId); renderTree(); }, 2500));
      return;
    }
    clearTimeout(armed.get(folderId));
    armed.delete(folderId);
    const gone = new Set([folderId, ...descendants(folderId)]);
    for (const goneId of gone) delete marker.folders[goneId];
    for (const value of Object.values(marker.markers)) {
      const data = value?.byProject?.[marker.project];
      if (!data?.folderPath) continue;
      const cut = data.folderPath.findIndex((pathId) => gone.has(pathId));
      if (cut >= 0) data.folderPath = data.folderPath.slice(0, cut);
    }
    if (gone.has(viewerFolder)) viewerFolder = null;
    if (gone.has(marker.slot1)) marker.slot1 = null;
    if (gone.has(marker.slot2)) marker.slot2 = null;
    saveMarker(true);
    renderTree();
    renderViewer();
  }

  $('tree').addEventListener('click', (event) => {
    const row = event.target.closest('.folder');
    if (!row) return;
    const folderId = row.dataset.id;
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-view')) { viewerFolder = viewerFolder === folderId ? null : folderId; renderTree(); renderViewer(); }
    else if (button.hasAttribute('data-sub')) addFolder(folderId);
    else if (button.hasAttribute('data-rename')) renameFolder(folderId);
    else if (button.hasAttribute('data-up')) move(folderId, -1);
    else if (button.hasAttribute('data-down')) move(folderId, 1);
    else if (button.hasAttribute('data-delete')) remove(folderId, button);
  });

  // Colour changes repaint the swatch at once and save when the picker settles.
  let colorTimer = 0;
  $('tree').addEventListener('input', (event) => {
    if (!event.target.hasAttribute('data-color')) return;
    const folderId = event.target.closest('.folder').dataset.id;
    marker.folders[folderId].color = event.target.value;
    event.target.parentElement.style.background = event.target.value;
    clearTimeout(colorTimer);
    colorTimer = setTimeout(saveMarker, 250);
  });

  $('viewer-sort').addEventListener('change', renderViewer);

  $('copy-links').addEventListener('click', async () => {
    const items = viewerItems();
    if (!items.length) return status('Nothing to copy.', true);
    const plain = items.map((item) => `${item.title}${item.note ? ` — ${item.note}` : ''}\n${documentUrl(item.key)}`).join('\n');
    const html = items.map((item) => `<a href="${escapeHtml(documentUrl(item.key))}">${escapeHtml(item.title)}</a>${item.note ? ` — ${escapeHtml(item.note)}` : ''}`).join('<br>');
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([plain], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' })
      })]);
      status(`Copied ${items.length} link${items.length === 1 ? '' : 's'}`);
    } catch (error) { status('The browser denied clipboard access.', true); }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.canliiMarkers) return;
    marker.markers = changes.canliiMarkers.newValue || {};
    if (markerRendered && !document.querySelector('.folder-edit')) { renderTree(); renderViewer(); }
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
