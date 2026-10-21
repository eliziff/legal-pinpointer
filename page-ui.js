'use strict';

// In-page controls: copy controls beside every paragraph and provision, the document's name in
// CanLII's own header, and on Westlaw and Lexis the native title made plain selectable text with a
// CanLII (or court-site) button, the Case Marker circle and a copy-link button at its end.
//
// Nothing here moves the page. Every control is out of flow (absolutely positioned at its spot) or
// fills space reserved by static CSS that is in place before the first paint (content.css).
// Nothing here waits for the engine either: controls attach to the provider's own paragraph and
// section anchors as soon as the page has them, in one animation frame, and are never touched by
// scrolling. The document model a copy needs is built in idle time behind them.
(function startPageUi() {
  const page = globalThis.LegalPinpointerPage;
  const providers = globalThis.LegalPinpointerProviders;
  const actions = globalThis.LegalPinpointerActions;
  if (!page || !providers || globalThis.LegalPinpointerPageUi) return;
  globalThis.LegalPinpointerPageUi = true;

  const hostname = location.hostname.replace(/^www\./, '');
  const provider = hostname === 'canlii.org' ? 'canlii' : hostname === 'advance.lexis.com' ? 'lexis'
    : /(?:^|\.)nextcanada\.westlaw\.com$/.test(hostname) ? 'westlaw' : '';
  if (!provider) return;

  const settings = { unitCopyButtons: true, canliiHeader: true, cleanTitles: true, canliiButton: true, caseMarker: true };
  const idle = (callback, timeout) => (window.requestIdleCallback
    ? requestIdleCallback(callback, { timeout }) : setTimeout(callback, 50));

  // CanLII's maple leaf (from its own wordmark) and, for a decision found only on its court's
  // Lexum/Decisia site, a courthouse: inlined, so nothing is fetched or exposed to the page.
  const CANLII_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="2640.1 4.7 685.6 685.6"><g transform="matrix(1.33,0,0,-1.33,-51.85,911.22)"><g><g><g transform="translate(1366.69,215.90)"></g><g transform="translate(1822.88,431.36)"></g><g transform="translate(908.24,339.35)"></g><g transform="translate(1697.10,238.79)"></g><g transform="translate(504.64,273.00)"></g><g transform="translate(237.02,626.65)"></g><g transform="translate(506.37,271.47)"></g><g transform="translate(1974.78,669.64)"></g><g transform="translate(500.98,275.13)"></g><g transform="translate(502.71,273.59)"></g><g transform="translate(2488.91,367.05)"><path d="m 0,0 49.26,65.91 -79.71,2.34 0.29,52.55 -83.35,-34.54 71.16,113.27 -61.84,10.96 -9.15,102.98 -83.89,-74.10 -49.20,43.22 -20.25,-145.77 -40.78,99.91 -39.88,-41.18 -54.08,49.81 -7.68,-88.29 -55.23,-4.56 91.47,-139.03 5.77,-9.82 -31.36,-46.42 110.42,-20.47 -57.34,-109.91 62.40,-27.90 41.29,120.43 99.02,-63.83 -1.18,67.44 172.52,37.22 z" style="fill:#bb2119;fill-rule:nonzero"></path></g><g transform="translate(2489.93,368.69)"><path d="m 0,0 48.95,66.14 -79.72,1.96 0.04,52.55 -83.18,-34.93 70.62,113.61 -61.89,10.66 -9.64,102.94 -83.54,-74.49 -49.40,42.99 -19.57,-145.87 -41.25,99.72 -39.68,-41.37 -54.32,49.55 -7.27,-88.32 -55.21,-4.82 92.12,-138.60 5.82,-9.79 -31.14,-46.56 110.51,-19.95 -56.82,-110.18 62.53,-27.60 40.72,120.63 99.32,-63.36 -1.50,67.43 172.34,38.03 z" style="fill:#bb2119;fill-rule:nonzero"></path></g><g transform="translate(2195.26,379.91)"></g><g transform="translate(2363.50,463.28)"></g></g></g></g></svg>`;
  const COURT_LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#3d5a73" stroke-width="1.4" stroke-linejoin="round"><path d="M2 6.2 8 2.6l6 3.6zM3.4 6.6v5.6M6.2 6.6v5.6M9.8 6.6v5.6M12.6 6.6v5.6M2 13.6h12"/></svg>';
  const icon = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  const CANLII_ICON = icon(CANLII_LOGO), COURT_ICON = icon(COURT_LOGO);

  function flash(button) {
    button.classList.add('done');
    setTimeout(() => button.classList.remove('done'), 900);
  }

  function run(task, button) {
    task.then(() => button && flash(button), (error) => page.toast(error.message || 'Legal Pinpointer could not copy that.', true));
  }

  // Routed by early.js before any page listener sees the press.
  actions?.set('unit', (button) => {
    const control = button.parentElement;
    if (control?.lpElement) run(page.copyControl(control.lpElement, control.lpLocator, button.dataset.mode), button);
  });
  actions?.set('citation', (button) => run(page.copyCitation(), button));
  actions?.set('canlii', (link) => {
    if (link.classList.contains('live')) return false;
    if (link.classList.contains('dead')) page.toast('No reliable CanLII version was found for this document.', true);
    return true;
  });

  // ---------------------------------------------------------------------------
  // The document model a copy needs is built at the first sign of one: the pointer on a Pinpointer
  // control, a modifier key (the hotkeys), or text selected. A page that is only read never builds it.

  let metadata = null, warmed = false;
  function warm() {
    if (warmed) return;
    warmed = true;
    if (provider === 'canlii') chrome.runtime.sendMessage({ type: 'LEGAL_PINPOINTER_WARM' }).catch(() => {});
    idle(() => page.model(false).catch(() => { warmed = false; }), 150);
  }
  page.onInvalidate?.(() => { warmed = false; });
  document.addEventListener('pointerover', (event) => {
    if (!warmed && event.target.closest?.('[data-lp-ui]')) warm();
  }, { capture: true, passive: true });
  document.addEventListener('keydown', (event) => {
    if (!warmed && (event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta')) warm();
  }, { capture: true, passive: true });
  document.addEventListener('selectionchange', () => {
    if (!warmed && !getSelection().isCollapsed) warm();
  });

  // ---------------------------------------------------------------------------
  // Copy controls: two buttons beside each paragraph or provision (the pinpoint, and the pinpoint
  // with its text), which copy the selection when there is one, as the hotkeys do.
  //
  // They live in one overlay: a zero-size, layout-contained box inserted once beside the document's
  // text, so it scrolls with the text natively and nothing inside it can change the page's layout.
  // Every unit's position is measured once, in a frame's own layout (and again only when the
  // document changes size); only the units near the viewport have controls, recycled from a pool as
  // the reader scrolls. A 5,000-section statute costs the same per frame as a short judgment, and
  // scrolling never lays the document out again.

  const BLOCKS = new Set(['P', 'LI', 'DIV', 'BLOCKQUOTE', 'DD', 'DT', 'TD', 'TH', 'SECTION', 'ARTICLE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const KIND_LABEL = { paragraph: 'para', page: 'page', section: 's', rule: 'r', article: 'art', pilcrow: '¶', silcrow: '§' };
  const NEAR = 1.5; // viewports above and below the screen whose units have controls
  const WIDTH = { row: 61, column: 29, above: 0 }; // a control's width plus its gap to the text
  const view = {
    units: [], index: new WeakMap(), order: null, sortedTops: null, tops: null, lefts: null,
    overlay: null, live: new Map(), pool: [], hot: null, place: '', shift: 0,
    frame: 0, syncFrame: 0, syncTimer: 0, measureTimer: 0, resize: null, mutations: null
  };
  let template = null;

  // The room left of the text inside the nearest ancestor that clips it decides where controls sit:
  // a row in the margin, a narrow column, or a row in the space above the unit's first line.
  function placement(element, overhanging) {
    const left = element.getBoundingClientRect().left - overhanging;
    let edge = 0;
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.overflowX !== 'visible') { edge = parent.getBoundingClientRect().left + (parseFloat(style.borderLeftWidth) || 0); break; }
    }
    const room = left - edge;
    return room >= 66 ? 'row' : room >= 34 ? 'column' : 'above';
  }

  // How far a unit's first text starts left of its box (Westlaw hangs the paragraph number into the
  // margin): the controls move left by as much.
  function overhang(element) {
    const parent = BLOCKS.has(element.tagName) ? element : element.parentElement;
    if (!parent) return 0;
    const style = getComputedStyle(parent);
    const lineStart = parent.getBoundingClientRect().left + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let left = Infinity;
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.data.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      left = range.getClientRects()[0]?.left ?? Infinity;
      break;
    }
    for (const rect of element.getClientRects()) left = Math.min(left, rect.left);
    return Number.isFinite(left) ? Math.min(80, Math.max(0, Math.round(lineStart - left))) : 0;
  }

  function control() {
    if (!template) {
      template = document.createElement('span');
      template.className = 'lp-unit';
      template.setAttribute('role', 'group');
      template.innerHTML = '<button type="button" class="lp-unit-pin" data-lp-action="unit" data-mode="pinpoint"></button>'
        + '<button type="button" class="lp-unit-quote" data-lp-action="unit" data-mode="quote" data-tip="Copy with text (Ctrl+Shift+X)" aria-label="Copy pinpoint with text"></button>';
    }
    return view.pool.pop() || template.cloneNode(true);
  }

  // Where the overlay goes so that it scrolls with the text and changes nothing on the page. When the
  // page itself scrolls (CanLII, Westlaw): out of flow on <html>, in document coordinates, with its
  // layout contained. When the text scrolls inside a box (an app's document pane): as the box's first
  // child, a zero-size block (a scroll box starts a new formatting context, and margins collapse
  // through an empty block, so nothing moves) that the box clips and scrolls like the text.
  function scrollBox(element) {
    for (let node = element.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node;
    }
    return null;
  }

  function mountOverlay(first) {
    const box = scrollBox(first);
    const overlay = document.createElement('div');
    overlay.className = 'lp-units';
    overlay.setAttribute('data-lp-ui', '');
    overlay.contentEditable = 'false';
    if (box) {
      overlay.dataset.in = 'box';
      box.insertBefore(overlay, box.firstChild);
    } else document.documentElement.appendChild(overlay);
    view.overlay = overlay;
    view.resize?.disconnect();
    view.resize = new ResizeObserver(() => scheduleMeasure());
    view.resize.observe(first.closest('p, li, div, section, article')?.parentElement || document.body);
    view.resize.observe(document.body);
    return true;
  }

  // Reads the provider's anchors; when they changed, measures them all. Runs in an animation frame,
  // so the reads use that frame's own layout.
  function syncUnits() {
    view.syncFrame = 0;
    if (!settings.unitCopyButtons) return;
    let found;
    try { found = providers.quickUnits(document, location); } catch (_) { return; }
    const units = [], seen = new Set();
    for (const unit of found) {
      if (!unit.element?.isConnected || seen.has(unit.element)) continue; // two units on one element: the first keeps it
      seen.add(unit.element);
      units.push(unit);
    }
    const same = units.length === view.units.length && units.every((unit, i) => unit.element === view.units[i].element);
    if (same && view.overlay?.isConnected) return;
    for (const node of view.live.values()) node.remove();
    view.pool.push(...view.live.values());
    view.live.clear();
    view.units = units;
    view.index = new WeakMap(units.map((unit, i) => [unit.element, i]));
    if (!units.length) return;
    if (!view.overlay?.isConnected && !mountOverlay(units[0].element)) return;
    if (!view.place) {
      view.shift = overhang(units[0].element);
      view.place = placement(units[0].element, view.shift);
      if (view.place === 'above') view.shift = 0;
    }
    measure();
  }

  // Every unit's position relative to the overlay, read in one pass (layout is clean, so each read is
  // a lookup), and the order they stand in down the page.
  function measure() {
    view.measureTimer = 0;
    const { units, overlay } = view;
    if (!units.length || !overlay?.isConnected) return;
    const origin = overlay.getBoundingClientRect();
    const count = units.length, tops = new Float64Array(count), lefts = new Float64Array(count), shown = [];
    // A unit in a list item with a visible bullet keeps clear of the bullet (one style read per list).
    const bullets = new Map();
    const bullet = (element) => {
      const item = element.closest('li');
      const list = item?.parentElement;
      if (!list) return 0;
      if (!bullets.has(list)) {
        const style = getComputedStyle(item);
        bullets.set(list, style.listStyleType !== 'none' && style.listStylePosition === 'outside' ? 18 : 0);
      }
      return bullets.get(list);
    };
    for (let i = 0; i < count; i += 1) {
      // Hidden (a collapsed section) has no place; an empty anchor (CanLII's <a name>) has a
      // zero-size box, but its position is the provision's.
      const element = units[i].element;
      if (element.checkVisibility ? !element.checkVisibility() : !element.getClientRects().length) continue;
      const rect = element.getBoundingClientRect();
      tops[i] = rect.top - origin.top;
      lefts[i] = rect.left - origin.left - bullet(element);
      // Provisions that start on the same line (s 2 and s 2(1)) share one control: the first's.
      const previous = shown[shown.length - 1];
      if (previous !== undefined && Math.abs(tops[previous] - tops[i]) < 2 && Math.abs(lefts[previous] - lefts[i]) < 2) continue;
      shown.push(i);
    }
    shown.sort((a, b) => tops[a] - tops[b]);
    view.tops = tops;
    view.lefts = lefts;
    view.order = Int32Array.from(shown);
    view.sortedTops = Float64Array.from(shown, (i) => tops[i]);
    update(true);
  }

  // The document changed size (images, fonts, an opened section, a narrower window): measure again,
  // at most a few times a second.
  function scheduleMeasure() {
    if (view.measureTimer || !view.units.length) return;
    view.measureTimer = setTimeout(() => requestAnimationFrame(measure), 120);
  }

  function lowerBound(values, target) {
    let low = 0, high = values.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (values[middle] < target) low = middle + 1; else high = middle;
    }
    return low;
  }

  // Important, like the stylesheet's `all: initial`, which would otherwise win.
  function position(node, i) {
    node.style.setProperty('left', `${Math.round(view.lefts[i] - view.shift - WIDTH[view.place])}px`, 'important');
    node.style.setProperty('top', `${Math.round(view.tops[i] - (view.place === 'above' ? 27 : 0))}px`, 'important');
  }

  // Controls for the units within NEAR viewports of the screen; the rest go back to the pool. Only
  // controls that come or go are touched, and only once the reader has moved half a screen from
  // where they were last placed (the margin holds a screen and a half either way). All writes are
  // inside the overlay, whose layout is contained.
  function update(remeasured = false) {
    view.frame = 0;
    const { overlay, order, sortedTops } = view;
    if (!order || !overlay?.isConnected) return;
    const offset = -overlay.getBoundingClientRect().top, height = innerHeight;
    if (remeasured !== true && view.placedAt !== undefined && Math.abs(offset - view.placedAt) < height / 2) return;
    view.placedAt = offset;
    if (remeasured === true) for (const [i, node] of view.live) position(node, i);
    const from = lowerBound(sortedTops, offset - height * NEAR), to = lowerBound(sortedTops, offset + height * (1 + NEAR));
    const wanted = new Set();
    for (let k = from; k < to; k += 1) wanted.add(order[k]);
    for (const [i, node] of view.live) {
      if (wanted.has(i)) continue;
      node.remove();
      view.live.delete(i);
      view.pool.push(node);
    }
    for (const i of wanted) {
      if (view.live.has(i)) continue;
      const unit = view.units[i], node = control();
      node.dataset.place = view.place;
      node.dataset.kind = unit.kind;
      node.classList.remove('hot');
      node.lpElement = unit.element;
      node.lpLocator = unit.locator;
      const label = `Copy pinpoint (Ctrl+X) · ${KIND_LABEL[unit.kind] || unit.kind} ${unit.locator}`;
      node.firstChild.dataset.tip = label;
      node.firstChild.setAttribute('aria-label', label);
      position(node, i);
      overlay.appendChild(node);
      view.live.set(i, node);
    }
  }

  document.addEventListener('scroll', () => {
    if (view.order && !view.frame) view.frame = requestAnimationFrame(update);
  }, { capture: true, passive: true });
  addEventListener('resize', scheduleMeasure, { passive: true });
  document.fonts?.addEventListener?.('loadingdone', scheduleMeasure);

  // The paragraph under the pointer shows its controls in full.
  function hoverUnit(target) {
    let i;
    for (let node = target, depth = 0; node && depth < 12 && i === undefined; node = node.parentElement, depth += 1) i = view.index.get(node);
    const node = i === undefined ? null : view.live.get(i) || null;
    if (node === view.hot) return;
    view.hot?.classList.remove('hot');
    node?.classList.add('hot');
    view.hot = node;
  }

  // One tooltip for every control, shown after a short hover.
  let tip = null, tipTimer = 0;
  function hideTip() {
    clearTimeout(tipTimer);
    if (tip) tip.hidden = true;
  }
  document.addEventListener('pointerover', (event) => {
    const button = event.target;
    if (view.units.length && !button.closest?.('.lp-units')) hoverUnit(button);
    if (!button.parentElement?.classList?.contains('lp-unit') || !button.dataset.tip) return hideTip();
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'lp-tip';
        tip.setAttribute('data-lp-ui', '');
        tip.setAttribute('role', 'tooltip');
        document.documentElement.appendChild(tip);
      }
      tip.textContent = button.dataset.tip;
      const rect = button.getBoundingClientRect();
      tip.hidden = false;
      tip.style.left = `${Math.max(6, Math.round(rect.left + rect.width / 2 - tip.offsetWidth / 2))}px`;
      tip.style.top = `${Math.round(rect.top - tip.offsetHeight - 6)}px`;
    }, 300);
  }, { capture: true, passive: true });
  document.addEventListener('pointerdown', hideTip, { capture: true, passive: true });
  addEventListener('scroll', hideTip, { capture: true, passive: true });

  // Pages that render or replace the document after load (Lexis): new anchors are read in the next
  // frame, and no more than every quarter second. Pinpointer's own insertions do not count.
  function watchUnits() {
    if (view.mutations) return;
    view.mutations = new MutationObserver((records) => {
      if (view.syncTimer || !settings.unitCopyButtons) return;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1 || node.hasAttribute('data-lp-ui')) continue;
          view.syncTimer = setTimeout(() => { view.syncTimer = 0; queueSync(); }, view.units.length ? 250 : 0);
          return;
        }
      }
    });
    view.mutations.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  function queueSync() {
    if (!view.syncFrame) view.syncFrame = requestAnimationFrame(syncUnits);
  }

  function removeUnits() {
    view.mutations?.disconnect();
    view.resize?.disconnect();
    cancelAnimationFrame(view.frame);
    cancelAnimationFrame(view.syncFrame);
    clearTimeout(view.syncTimer);
    clearTimeout(view.measureTimer);
    view.overlay?.remove();
    Object.assign(view, {
      units: [], index: new WeakMap(), order: null, sortedTops: null, tops: null, lefts: null,
      overlay: null, live: new Map(), pool: [], hot: null, place: '', shift: 0,
      frame: 0, syncFrame: 0, syncTimer: 0, measureTimer: 0, resize: null, mutations: null
    });
    hideTip();
  }

  // ---------------------------------------------------------------------------
  // CanLII: the document's name in place of the last breadcrumb in CanLII's sticky header. The
  // breadcrumbs already fill the header's free width (content.css), so the name only fills it in.

  let crumb = null;

  function mountCrumb() {
    const name = document.querySelector('#canlii-breadcrumbs > span:last-of-type [itemprop="name"]');
    const title = document.querySelector('#title-container h1.main-title, h1.main-title');
    if (!name || !title) return;
    const text = title.textContent.replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (!crumb || crumb.name !== name) {
      crumb = { name, original: name.textContent, button: null };
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lp-crumb-copy';
      button.setAttribute('data-lp-ui', '');
      button.setAttribute('data-lp-action', 'citation');
      button.setAttribute('data-tip', 'Copy the linked citation (Alt+X)');
      button.setAttribute('aria-label', 'Copy the linked citation');
      name.after(button);
      crumb.button = button;
    }
    if (name.textContent !== text) name.textContent = text;
    name.title = text;
  }

  function unmountCrumb() {
    if (!crumb) return;
    crumb.button.remove();
    crumb.name.textContent = crumb.original;
    crumb.name.removeAttribute('title');
    crumb = null;
  }

  // ---------------------------------------------------------------------------
  // Westlaw and Lexis: tools at the end of the native title, out of flow; the title itself is made
  // plain selectable text by content.css.

  // The document's own title, in order of preference (Lexis repeats it, hidden, in its page header).
  const TITLES = provider === 'westlaw' ? ['#co_docHeaderTitleLine'] : ['#SS_DocumentTitle', '.documentheadertitle h1'];
  const findTitle = () => {
    for (const selector of TITLES) { const element = document.querySelector(selector); if (element) return element; }
    return null;
  };
  let tools = null, floating = null, toolsObserver = null, toolsVisible = true;

  function mountTools() {
    const title = findTitle();
    if (!title) return null;
    if (tools && tools.title === title && tools.element.isConnected) return tools;
    tools?.element.remove();
    const element = document.createElement('span');
    element.className = 'lp-tools';
    element.setAttribute('data-lp-ui', '');
    element.contentEditable = 'false';
    element.innerHTML = '<a class="lp-tool lp-canlii pending" data-lp-action="canlii" data-tip="Looking for a CanLII version" aria-label="CanLII"></a>'
      + '<span class="lp-tool-marker"></span>'
      + '<button type="button" class="lp-tool lp-link" data-lp-action="citation" data-tip="Copy the linked citation (Alt+X)" aria-label="Copy the linked citation"></button>';
    element.style.setProperty('--lp-canlii', CANLII_ICON);
    element.style.setProperty('--lp-court', COURT_ICON);
    title.appendChild(element);
    tools = { title, element, canlii: element.firstChild, marker: element.children[1] };
    tools.canlii.hidden = !settings.canliiButton;
    tools.marker.hidden = !settings.caseMarker || !globalThis.LegalPinpointerCaseMarker;
    watchTools();
    return tools;
  }

  function unmountTools() {
    toolsObserver?.disconnect();
    toolsObserver = null;
    tools?.element.remove();
    tools = null;
    toolsVisible = false;
    floatVisibility();
  }

  // Westlaw's title is a draggable link back to the same document: a press starts a drag. Its clicks
  // are stopped by early.js; here it stops being draggable.
  function tameTitle() {
    if (provider !== 'westlaw') return;
    for (const link of document.querySelectorAll('#co_docHeaderTitleLine a, #titleInfo a')) link.draggable = !settings.cleanTitles;
  }

  // A drag that starts in the title stays in it: overshooting the end (or the start) selects up to
  // the title's last (or first) character, not the citation line and toolbars beyond.
  let titleDrag = null;
  const titlePress = (event) => {
    titleDrag = settings.cleanTitles && event.button === 0 && !event.shiftKey ? event.target.closest?.(TITLES.join(', ')) || null : null;
  };
  // early.js reports every press, ahead of the page's own listeners.
  globalThis.LegalPinpointerTitlePress = titlePress;
  window.addEventListener('mouseup', () => { titleDrag = null; }, { capture: true, passive: true });
  document.addEventListener('selectionchange', () => {
    if (!titleDrag) return;
    const selection = getSelection();
    if (!selection.anchorNode || !titleDrag.contains(selection.anchorNode) || titleDrag.contains(selection.focusNode)) return;
    const end = document.createRange();
    end.selectNodeContents(titleDrag);
    const tools = titleDrag.querySelector('.lp-tools');
    if (tools) end.setEndBefore(tools);
    const after = selection.anchorNode.compareDocumentPosition(selection.focusNode) & Node.DOCUMENT_POSITION_FOLLOWING;
    if (after) selection.setBaseAndExtent(selection.anchorNode, selection.anchorOffset, end.endContainer, end.endOffset);
    else selection.setBaseAndExtent(selection.anchorNode, selection.anchorOffset, end.startContainer, end.startOffset);
  });

  function paintLink(link, current) {
    const url = current.canliiUrl || current.siteUrl || '';
    link.classList.remove('pending');
    link.classList.toggle('live', Boolean(url));
    link.classList.toggle('dead', !url);
    link.classList.toggle('site', !current.canliiUrl && Boolean(current.siteUrl));
    if (url) {
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.dataset.tip = current.canliiUrl ? 'Open on CanLII' : `No CanLII version; open on ${new URL(url).hostname}`;
    } else {
      link.removeAttribute('href');
      link.dataset.tip = 'No CanLII version found';
    }
  }

  // One fixed, click-through layer for the floating CanLII button (bottom left), shown while the
  // title is out of view.
  const LAYER_CSS = `
    :host { all: initial; }
    a { position: fixed; left: 16px; bottom: 18px; display: grid; place-items: center; box-sizing: border-box; width: 30px; height: 30px;
      border: 1px solid #d5dee6; border-radius: 7px; background: #fff; opacity: 0; transform: scale(.9); pointer-events: none;
      transition: opacity 120ms, transform 120ms; box-shadow: 0 1px 2px rgb(0 0 0 / 10%); }
    a.ready { opacity: 1; transform: none; pointer-events: auto; }
    a.ready.dead { opacity: .42; filter: grayscale(1); }
    a.ready.pending { opacity: .25; filter: grayscale(1); }
    a::before { content: ""; width: 18px; height: 18px; background: ${CANLII_ICON} center / contain no-repeat; }
    a.site::before { background-image: ${COURT_ICON}; }
    @media print { a { display: none; } }
  `;

  function mountFloating() {
    if (floating) return floating;
    const host = document.createElement('div');
    host.setAttribute('data-lp-ui', '');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646';
    const shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(LAYER_CSS);
    shadow.adoptedStyleSheets = [sheet];
    floating = document.createElement('a');
    floating.className = 'pending';
    floating.setAttribute('aria-label', 'CanLII');
    floating.setAttribute('data-lp-action', 'canlii');
    shadow.appendChild(floating);
    document.documentElement.appendChild(host);
    floating.lpHost = host;
    return floating;
  }

  function floatVisibility() {
    floating?.classList.toggle('ready', settings.canliiButton && !toolsVisible);
  }

  function watchTools() {
    toolsObserver?.disconnect();
    toolsVisible = true;
    toolsObserver = new IntersectionObserver(([entry]) => { toolsVisible = entry.isIntersecting; floatVisibility(); });
    toolsObserver.observe(tools.title);
  }

  function paintTools(current) {
    if (tools) {
      paintLink(tools.canlii, current);
      tools.canlii.hidden = !settings.canliiButton;
      const marker = globalThis.LegalPinpointerCaseMarker;
      tools.marker.hidden = !marker || !settings.caseMarker;
      if (marker && settings.caseMarker) {
        marker.attachExternal(tools.marker, current.canliiUrl, current.citation.citation || current.citation.plain, current.citation.plain,
          { url: current.cleanUrl, citation: current.citation.citation || '', provider }, current.siteUrl);
      } else tools.marker.replaceChildren();
    }
    if (settings.canliiButton && current.documentType === 'case') {
      paintLink(mountFloating(), current);
      floatVisibility();
    }
  }

  function unmountFloating() {
    floating?.lpHost.remove();
    floating = null;
  }

  // ---------------------------------------------------------------------------

  let applying = 0;
  async function apply() {
    const ticket = ++applying;
    if (settings.unitCopyButtons) { queueSync(); watchUnits(); } else removeUnits();
    if (provider === 'canlii') {
      if (settings.canliiHeader) mountCrumb(); else unmountCrumb();
    } else {
      document.documentElement.classList.toggle('lp-raw-titles', !settings.cleanTitles);
      tameTitle();
      if (settings.cleanTitles || settings.canliiButton || settings.caseMarker) mountTools(); else unmountTools();
      if (!settings.canliiButton) unmountFloating();
      if (tools || settings.canliiButton) {
        try {
          const current = metadata && page.current(metadata) ? metadata : (metadata = await page.model(true));
          if (ticket === applying) paintTools(current);
        } catch (_) {
          // Not a legal document (a results list or an error page): the tools stay grey.
          if (tools && ticket === applying) paintLink(tools.canlii, {});
        }
      }
    }
  }

  // The page navigated in place or its document was replaced: apply again once it settles.
  let refreshTimer = 0;
  function refresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { metadata = null; apply(); }, 120);
  }
  page.onInvalidate?.(() => { if (provider !== 'canlii' && tools && !tools.element.isConnected) refresh(); });
  window.navigation?.addEventListener('navigatesuccess', refresh);
  window.addEventListener('popstate', refresh);
  window.addEventListener('pageshow', (event) => { if (event.persisted) refresh(); });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.keys(settings).some((key) => changes[key])) return;
    for (const key of Object.keys(settings)) if (changes[key]) settings[key] = changes[key].newValue ?? settings[key];
    apply();
  });
  // Settings early.js read at document_start are normally in hand already, so the page UI applies
  // at once; otherwise as soon as they arrive.
  const early = globalThis.LegalPinpointerEarlySettingsValue;
  if (early) { Object.assign(settings, early); apply(); }
  else (globalThis.LegalPinpointerEarlySettings || new Promise((resolve) => chrome.storage.local.get(settings, resolve)))
    .then((stored) => { Object.assign(settings, stored); apply(); });
})();
