'use strict';

// Case Marker's model and filing picker, shared by the page (marker.js) and the popup (popup.js).
// The interaction is Beaver's Sources workspace, ported without React so a change there maps here
// one to one (frontend/src/app/components/legal/ in the Beaver repo):
//   folderChildren  <- researchLabelChildren (ResearchLabelPicker.tsx)
//   folderPath      <- researchLabelPath (lib/researchFiles.ts)
//   waterfall       <- ResearchLabelWaterfall (ResearchLabelPicker.tsx)
//   openEditor      <- ResearchLabelEditor (ResearchLabelPicker.tsx)
//   the popup tree  <- ResearchLabelTree.tsx + ResearchTree.tsx (popup.js)
// Case Marker keeps its own glyph: a coloured circle, its rings the folder path.
(function startMarkerCore() {
  if (globalThis.LegalPinpointerMarkerCore) return;
  const RING = ['', '62%', '52%'];
  const BADGE_MAX = 19;
  const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // lucide icons, as Beaver draws them.
  const PATHS = {
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    gavel: '<path d="m14.5 12.5-8 8a2.119 2.119 0 1 1-3-3l8-8"/><path d="m16 16 6-6"/><path d="m8 8 6-6"/><path d="m9 7 8 8"/><path d="m21 11-8-8"/>',
    scroll: '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/>'
  };
  const icon = (name, className = '', style = '', filled = false) => `<svg class="${className}" style="${style}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
  const folderIcon = (color, className, style = '') => color
    ? icon('folder', className, `color:${escapeHtml(color)};${style}`, true) : icon('folder', className, `color:#9ca3af;${style}`);

  // ---------------------------------------------------------------------------
  // Model: a project's folders nest without limit; a document is filed under any number of them.

  /** One project's folders grouped under their parent, each level in its saved order. */
  function folderChildren(folders, project) {
    const map = new Map();
    Object.entries(folders).filter(([, folder]) => folder.projectId === project)
      .sort((a, b) => (a[1].order || 0) - (b[1].order || 0) || String(a[1].name).localeCompare(String(b[1].name)))
      .forEach((entry) => { const parent = entry[1].parentId || null; if (!map.has(parent)) map.set(parent, []); map.get(parent).push(entry); });
    return map;
  }

  /** Root first; stops at a missing parent or a cycle. */
  function folderPath(folders, id) {
    const path = [];
    for (let at = id; at && folders[at] && !path.includes(at); at = folders[at].parentId) path.unshift(at);
    return path;
  }

  /** The folders a document is filed under in this project. Filings saved before a document could be
   *  filed in several folders are its folder path, filed under the deepest. */
  function filings(data, folders, project) {
    const ids = Array.isArray(data?.folderIds) ? data.folderIds : data?.folderPath?.length ? [data.folderPath[data.folderPath.length - 1]] : [];
    return [...new Set(ids)].filter((id) => folders[id]?.projectId === project);
  }

  /** `folderPath` keeps the first filing's path, the format the original Case Marker reads. */
  function setFilings(data, ids, folders) {
    data.folderIds = [...new Set(ids)];
    data.folderPath = data.folderIds.length ? folderPath(folders, data.folderIds[0]) : [];
    if (!data.folderIds.length) delete data.folderIds;
  }

  // ---------------------------------------------------------------------------
  // The circle: the deepest filing's path as nested rings (three at most); "+N" for the others.

  function circle(folders, ids, className = 'lpm-circle') {
    const sorted = ids.slice().sort((a, b) => folderPath(folders, b).length - folderPath(folders, a).length);
    const path = sorted.length ? folderPath(folders, sorted[0]) : [];
    const outer = document.createElement('span');
    outer.className = className;
    if (!path.length) outer.classList.add('lpm-empty');
    let parent = outer;
    path.slice(0, 3).forEach((id, depth) => {
      const ring = depth ? document.createElement('span') : outer;
      ring.style.background = folders[id].color || '#9aa5b1';
      if (depth) {
        ring.className = 'lpm-ring';
        ring.style.width = ring.style.height = RING[depth];
        parent.appendChild(ring);
      }
      parent = ring;
    });
    return outer;
  }
  const filingNames = (folders, ids) => ids.map((id) => folderPath(folders, id).map((at) => folders[at].name).join(' / '));

  // ---------------------------------------------------------------------------
  // Waterfall: the top level as chips; choosing one reveals its children on the row below.

  function waterfall(folders, project, selectedId) {
    const tree = folderChildren(folders, project);
    const path = selectedId && folders[selectedId] ? folderPath(folders, selectedId) : [];
    if (!tree.size) return '<p class="lpm-help">No folders yet. Add them in the Legal Pinpointer menu (Marker tab).</p>';
    return [null, ...path].map((parent, row) => {
      const items = tree.get(parent) || [], active = path[row] || null;
      if (!items.length) return '';
      const size = [12, 13, 10][row] || 10;
      const chips = items.map(([id, folder]) => `<button type="button" class="lpm-chip" data-folder="${escapeHtml(id)}" aria-pressed="${active === id}" title="${escapeHtml(folder.name)}">`
        + `${folderIcon(folder.color || '#9aa5b1', 'lpm-chip-icon', `width:${size}px;height:${size}px`)}<span>${escapeHtml(folder.name)}</span></button>`).join('');
      const none = row ? '' : `<button type="button" class="lpm-chip" data-folder="" aria-pressed="${!selectedId}">${folderIcon('', 'lpm-chip-icon', 'width:12px;height:12px')}<span>None</span></button>`;
      return `<div class="lpm-level${row ? ' lpm-sub' : ''}" role="group" aria-label="Folder level ${row + 1}" style="margin-inline-start:${row ? 8 + (row - 1) * 20 : 0}px">${none}${chips}</div>`;
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // The editor: "Filed under" slots, the waterfall for the active slot, the note (and Case Marker's
  // badge). Every change saves itself; it closes on Escape, the close button or a press outside it.

  function openEditor({ anchor, folders, project, data, root = document.body, badge = true, onChange, onClose, inside = () => false }) {
    let slots = filings(data, folders, project), activeSlot = 0, noteTimer = 0, closed = false;
    // Where the anchor is, read before anything is inserted: the page's layout is still clean, so
    // this costs nothing even on a long judgment (after an insertion it would lay the page out).
    const anchorRect = anchor.getBoundingClientRect();
    const element = document.createElement('div');
    element.className = 'lpm-picker';
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-label', 'Folders and note');
    element.setAttribute('data-lp-ui', '');
    element.innerHTML = `<button type="button" class="lpm-x" data-close aria-label="Close">${icon('x', 'lpm-x-icon')}</button>`
      + '<div class="lpm-slots" aria-label="Filed under"></div><div class="lpm-waterfall"></div>'
      + `<textarea class="lpm-note" rows="1" placeholder="Note" maxlength="2000" aria-label="Note">${escapeHtml(data?.note || '')}</textarea>`
      + (badge ? `<div class="lpm-badge-row"><input class="lpm-badge-text" maxlength="${BADGE_MAX}" placeholder="Badge" aria-label="Badge" value="${escapeHtml(data?.badge?.text || '')}">`
        + `<input class="lpm-badge-color" type="color" value="${escapeHtml(data?.badge?.color || '#5b6670')}" title="Badge colour" aria-label="Badge colour"></div>` : '');
    root.appendChild(element);

    const value = () => {
      const result = { folderIds: slots.slice(), note: element.querySelector('.lpm-note').value.trim() };
      if (badge) {
        const text = element.querySelector('.lpm-badge-text').value.trim().slice(0, BADGE_MAX);
        result.badge = text ? { text, color: element.querySelector('.lpm-badge-color').value } : null;
      }
      return result;
    };
    const emit = () => { clearTimeout(noteTimer); onChange(value()); };
    function render() {
      const strip = [...slots, ''].map((id, index) => {
        const name = id ? filingNames(folders, [id])[0] : '';
        return `<button type="button" class="lpm-slot" data-slot="${index}" aria-pressed="${index === activeSlot}" aria-label="${id ? `Filed under ${escapeHtml(name)}` : 'Add a folder'}" title="${escapeHtml(name || 'Add a folder')}">`
          + `<span class="lpm-slot-circle"></span><span class="lpm-slot-name">${id ? escapeHtml(folders[id].name) : 'Add folder'}</span></button>`;
      }).join('');
      const stripElement = element.querySelector('.lpm-slots');
      stripElement.innerHTML = strip;
      stripElement.querySelectorAll('.lpm-slot-circle').forEach((slot, index) => slot.replaceWith(circle(folders, slots[index] ? [slots[index]] : [], 'lpm-circle lpm-mini')));
      element.querySelector('.lpm-waterfall').innerHTML = waterfall(folders, project, slots[activeSlot] || null);
    }
    /** The slot being filled always wins: a repeat leaves the other slot, never strands this one. */
    function put(id) {
      const kept = slots.filter((value, index) => index !== activeSlot && value !== id), at = Math.min(activeSlot, kept.length);
      slots = [...kept.slice(0, at), ...(id ? [id] : []), ...kept.slice(at)];
      activeSlot = at;
      render();
      emit();
    }
    // Below the anchor at once, from its rect and the picker's known width; its height is read a
    // frame later, when layout is clean, and only then does it move above an anchor too low for it.
    const width = Math.min(446, innerWidth - 12);
    function place(rect = anchor.getBoundingClientRect()) {
      const left = Math.min(Math.max(6, rect.left), innerWidth - width - 6), below = rect.bottom + 6;
      element.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(below)}px, 0)`;
      requestAnimationFrame(() => {
        if (closed) return;
        const height = element.offsetHeight;
        if (below + height + 6 <= innerHeight) return;
        const top = Math.max(6, Math.min(rect.top - height - 6, innerHeight - height - 6));
        element.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
      });
    }
    function close() {
      if (closed) return;
      closed = true;
      if (noteTimer) emit();
      removeEventListener('pointerdown', outside, true);
      removeEventListener('keydown', escape, true);
      element.remove();
      onClose?.();
    }
    const outside = (event) => { if (!event.composedPath().includes(element) && !inside(event)) close(); };
    const escape = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    element.addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) return close();
      const slot = event.target.closest('[data-slot]');
      if (slot) { activeSlot = Number(slot.dataset.slot); return render(); }
      const chip = event.target.closest('[data-folder]');
      if (chip) put(chip.dataset.folder || null);
    });
    element.addEventListener('input', (event) => {
      if (event.target.matches('.lpm-badge-text, .lpm-badge-color')) return emit();
      clearTimeout(noteTimer);
      noteTimer = setTimeout(emit, 300);
    });
    element.addEventListener('focusout', (event) => { if (event.target.matches('.lpm-note') && noteTimer) emit(); });
    addEventListener('pointerdown', outside, true);
    addEventListener('keydown', escape, true);
    render();
    place(anchorRect);
    return {
      element, close, place,
      /** New folders from storage: keeps the note being typed, drops filings whose folder is gone. */
      refresh(nextFolders) { folders = nextFolders; slots = slots.filter((id) => folders[id]?.projectId === project); activeSlot = Math.min(activeSlot, slots.length); render(); }
    };
  }

  globalThis.LegalPinpointerMarkerCore = { escapeHtml, icon, folderIcon, folderChildren, folderPath, filings, setFilings, circle, filingNames, waterfall, openEditor, BADGE_MAX };
})();
