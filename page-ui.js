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

  const settings = { unitCopyButtons: true, unitCopyStyle: 'numbers', canliiCitedBy: true, canliiHeader: true, providerHeader: true, cleanTitles: true, canliiButton: true, caseMarker: true };
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
    if (control?.lpElement) run(page.copyControl(control.lpElement, control.lpLocator, button.dataset.mode), null);
  });
  actions?.set('citedby', (button) => {
    const control = button.parentElement;
    if (control?.lpTools) run(openCitedBy(control.lpTools), button);
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

  let metadata = null, warmed = false, fullModel = null;
  function warm() {
    if (warmed) return;
    warmed = true;
    idle(() => page.model(false).then((model) => { fullModel = model; }, () => { warmed = false; }), 150);
  }
  page.onInvalidate?.(() => { warmed = false; fullModel = null; });
  document.addEventListener('pointerover', (event) => {
    if (!warmed && (event.target.closest?.('[data-lp-ui]') || (numbersOn() && numberFrom(event.target)))) warm();
  }, { capture: true, passive: true });
  document.addEventListener('keydown', (event) => {
    if (!warmed && (event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta')) warm();
  }, { capture: true, passive: true });
  (globalThis.LegalPinpointerSelectionHooks || { add: (hook) => document.addEventListener('selectionchange', hook) }).add(() => {
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

  const KIND_LABEL = { paragraph: 'para', page: 'page', section: 's', rule: 'r', article: 'art', pilcrow: '¶', silcrow: '§' };
  const NEAR = 1; // viewports above and below the screen whose units have controls
  const SIZE = 20, GAP = 1; // a button (content.css draws it this size), and the space between controls
  const view = {
    units: [], order: null, sortedTops: null, xs: null, ys: null, modes: null,
    overlay: null, live: new Map(), pool: [], hot: null,
    frame: 0, syncFrame: 0, syncTimer: 0, measureTimer: 0, resize: null, mutations: null
  };
  let template = null, citedTemplate = null;

  // The buttons style: the pinpoint and the pinpoint with its text. The numbers style: the pinpoint
  // only for a unit whose number cannot be clicked (its number is the control otherwise). Either
  // way, CanLII's Cited by follows where the paragraph is cited (setCited).
  const numbersStyle = () => settings.unitCopyStyle !== 'buttons';
  const unitButtons = (unit) => (numbersStyle() ? (unit.numbered ? 0 : 1) : 2) + (unit.cited ? 1 : 0);
  function control() {
    const style = numbersStyle() ? 'numbers' : 'buttons';
    if (template && template.dataset.style !== style) { template = null; view.pool.length = 0; }
    if (!template) {
      template = document.createElement('span');
      template.className = 'lp-unit';
      template.dataset.style = style;
      template.setAttribute('role', 'group');
      template.innerHTML = '<button type="button" class="lp-unit-pin" data-lp-action="unit" data-mode="pinpoint"></button>'
        + (style === 'buttons' ? '<button type="button" class="lp-unit-quote" data-lp-action="unit" data-mode="quote" data-tip="Copy with text (Ctrl+Shift+X)" aria-label="Copy pinpoint with text"></button>' : '');
    }
    return view.pool.pop() || template.cloneNode(true);
  }

  // CanLII's paragraph tools: the menu its pen icon opens holds the paragraph's Cited by (the decisions citing it),
  // and the icon carries how many there are. With canliiCitedBy, that is a third button in the paragraph's group
  // (the icon itself is not drawn unless html.lp-no-cited-by, content.css), opening CanLII's own Cited by link in a new tab.
  const citedBy = () => provider === 'canlii' && settings.canliiCitedBy && settings.unitCopyButtons;
  // A judgment's paragraph sits in its wrapper with the tools; a statute's provision anchors come
  // before its section's wrapper (and marginal note), so a section's tools are found by the section
  // number CanLII gives them (data-with-parag), read once per page into a map, for its first unit.
  const TOOLS = ':scope > .viibes-marker-toolbox [data-bs-toggle="dropdown"]';
  function canliiTools(element) {
    return element.closest?.('.paragWrapper')?.querySelector(TOOLS) || null;
  }
  let toolsCache = null;
  function sectionTools() {
    if (toolsCache && [...toolsCache.values()].slice(0, 3).every((trigger) => trigger.isConnected)) return toolsCache;
    const map = toolsCache = new Map();
    for (const box of document.querySelectorAll('.viibes-marker-toolbox[data-with-parag]')) {
      const trigger = box.querySelector('[data-bs-toggle="dropdown"]');
      if (trigger && !map.has(box.dataset.withParag)) map.set(box.dataset.withParag, trigger);
    }
    return map;
  }
  const citedCount = (trigger) => Math.max(0, Number(trigger?.dataset.noteupCount || 0));
  function setCited(node, count) {
    let button = node.querySelector(':scope > .lp-unit-cited');
    if (!count) { button?.remove(); return; }
    if (!button) {
      if (!citedTemplate) {
        citedTemplate = document.createElement('button');
        citedTemplate.type = 'button';
        citedTemplate.className = 'lp-unit-cited';
        citedTemplate.setAttribute('data-lp-action', 'citedby');
      }
      button = node.appendChild(citedTemplate.cloneNode());
    }
    const shown = node.lpTools?.dataset.noteupCountDisplay || String(count);
    button.dataset.count = shown;
    const label = `${shown} citing ${shown === '1' ? 'document' : 'documents'} (CanLII, in a new tab)`;
    button.dataset.tip = label;
    button.setAttribute('aria-label', label);
  }
  // CanLII fills a paragraph's menu with its links when the menu opens; the Cited by link is taken from there, so it
  // is CanLII's own address, whatever form CanLII gives it.
  async function openCitedBy(trigger) {
    const menu = trigger?.parentElement.querySelector('.dropdown-menu');
    if (!menu) throw new Error('CanLII lists no Cited by for this paragraph.');
    const find = () => Array.from(menu.querySelectorAll('a[href]'))
      .find((link) => /cit|noteup/i.test(`${link.textContent} ${link.getAttribute('href')}`));
    let link = find();
    if (!link) {
      trigger.click();
      for (let wait = 0; wait < 30 && !(link = find()); wait += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      if (menu.classList.contains('show')) trigger.click();
    }
    if (!link) throw new Error('CanLII did not give this paragraph’s Cited by list.');
    window.open(link.href, '_blank', 'noopener');
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
    wrapWestlawNumbers();
    wrapCanliiBrackets();
    wrapCanliiStatuteNumbers();
    let found;
    try { found = providers.quickUnits(document, location); } catch (_) { return; }
    const units = [], seen = new Set(), cited = citedBy(), stated = provider === 'canlii' ? numberedLocators() : null;
    const bySection = cited ? sectionTools() : null, sectionsUsed = new Set();
    for (const unit of found) {
      if (!unit.element?.isConnected || seen.has(unit.element)) continue; // two units on one element: the first keeps it
      seen.add(unit.element);
      let tools = cited ? canliiTools(unit.element) : null;
      if (cited && unit.kind !== 'paragraph') {
        // A statute's count is the section's (CanLII repeats it in each subsection's wrapper): once
        // per section, on its first unit.
        const section = String(unit.locator).split('(')[0];
        if (sectionsUsed.has(section)) tools = null;
        else { sectionsUsed.add(section); tools ||= bySection.get(section) || null; }
      }
      const label = stated?.get(unit.locator) || null;
      const record = { ...unit, tools, label, cited: citedCount(tools), numbered: numbersOn() && Boolean(label || numberIn(unit.element)) };
      // Only units with something in the margin are kept and measured: with the numbers as the
      // controls, that is the cited ones and the odd unnumbered one, not every provision.
      if (unitButtons(record)) units.push(record);
    }
    const same = units.length === view.units.length
      && units.every((unit, i) => unit.element === view.units[i].element && unit.cited === view.units[i].cited && unit.numbered === view.units[i].numbered);
    if (same && view.overlay?.isConnected) return;
    for (const node of view.live.values()) node.remove();
    view.pool.push(...view.live.values());
    view.live.clear();
    view.units = units;
    if (!units.length) return;
    if (!view.overlay?.isConnected && !mountOverlay(units[0].element)) return;
    measure();
  }

  // Where every control goes, decided in one pass over the page's layout:
  // - On CanLII, a paragraph or provision with CanLII's own tools button (the icon in the right
  //   margin) gets its controls right under that button.
  // - Everything else lines up in one column: CanLII's button column where the page has one;
  //   otherwise just right of the text column, or just left of it when the right has no room
  //   (a narrow window, or a provider's panel over the margin), or in the text column's edge.
  // - The two buttons are always one column, pinpoint on top (never side by side, so nothing
  //   changes shape as the window narrows). A unit too close to the next for both shows the
  //   pinpoint alone, and the second button under it while the pointer is on that unit.
  // Every read is a lookup in the frame's own layout; nothing is written until all are done.
  function measure() {
    view.measureTimer = 0;
    const { units, overlay } = view;
    if (!units.length || !overlay?.isConnected) return;
    const origin = overlay.getBoundingClientRect();
    const count = units.length, xs = new Float64Array(count), ys = new Float64Array(count), modes = new Array(count);
    const unitRights = new Float64Array(count), unitLefts = new Float64Array(count);
    const shown = [], rights = [], lefts = [], blockRects = new Map();
    for (let i = 0; i < count; i += 1) {
      // Hidden (a collapsed section) has no place; an empty anchor (CanLII's <a name>) has a
      // zero-size box, but its position is the provision's.
      const anchor = units[i].element, label = units[i].label?.isConnected ? units[i].label : null;
      const element = label && (label.checkVisibility ? label.checkVisibility() : label.getClientRects().length) ? label : anchor;
      if (element.checkVisibility ? !element.checkVisibility() : !element.getClientRects().length) continue;
      const rect = element.getBoundingClientRect();
      ys[i] = rect.top - origin.top;
      // Provisions that start on the same line (s 2 and s 2(1)) share one control: the first's.
      const previous = shown[shown.length - 1];
      if (previous !== undefined && Math.abs(ys[previous] - ys[i]) < 3) continue;
      shown.push(i);
      const block = element.closest('p, li, dd, blockquote, td, div') || element;
      let box = blockRects.get(block);
      if (!box) blockRects.set(block, box = block.getBoundingClientRect());
      unitRights[i] = Math.max(box.right, rect.right) - origin.left;
      unitLefts[i] = Math.min(box.left, rect.left) - origin.left;
      if (box.width > 0) { rights.push(box.right - origin.left); lefts.push(Math.min(box.left, rect.left) - origin.left); }
    }
    for (let k = shown.length - 1; k >= 0; k -= 1) if (!unitButtons(units[shown[k]])) shown.splice(k, 1);
    if (!shown.length) { view.order = null; return; }
    const median = (values) => { const sorted = values.slice().sort((a, b) => a - b); return sorted[sorted.length >> 1] ?? 0; };
    const colRight = median(rights), colLeft = median(lefts);

    // CanLII's own tools buttons, top to bottom.
    const tools = [];
    for (const button of document.querySelectorAll('.viibes-marker-toolbox')) {
      const rect = button.getBoundingClientRect();
      if (rect.width && rect.height) tools.push({ top: rect.top - origin.top, bottom: rect.bottom - origin.top, center: (rect.left + rect.right) / 2 - origin.left, used: false });
    }
    tools.sort((a, b) => a.top - b.top);
    const toolTops = tools.map((tool) => tool.top);

    // The column: CanLII's button column, else right of the text if that margin is clear, else left.
    const box = view.overlay.dataset.in === 'box' ? view.overlay.parentElement.getBoundingClientRect() : null;
    const clipRight = (box ? box.right : document.documentElement.clientWidth) - origin.left - 4;
    const clipLeft = (box ? box.left : 0) - origin.left + 4;
    const clear = (x) => {
      // A provider's fixed panel over the margin (Westlaw's right rail) covers the spot.
      const hit = document.elementFromPoint(x + origin.left + SIZE / 2, Math.min(innerHeight - 10, Math.max(10, innerHeight / 2)));
      if (!hit || hit === document.documentElement || hit === document.body || hit.closest('[data-lp-ui]')) return true;
      const box = hit.closest('*:not(span):not(a):not(i):not(img)') || hit;
      if (!['fixed', 'sticky'].includes(getComputedStyle(box).position)) return true;
      const area = box.getBoundingClientRect();
      return area.width >= innerWidth * 0.9 && area.height >= innerHeight * 0.9;
    };
    // Controls stay in the margin, never over the text: a margin needs room for one button's width, and a page whose
    // text leaves no such room on either side shows none (the hotkeys still copy).
    // CanLII draws its citation-weight bars just right of the text: the margin starts clear of them
    // (a few on the page are read; they all stand at the same place).
    let MARGIN = 12;
    if (provider === 'canlii') {
      const bars = document.querySelectorAll('.viibes-marker');
      for (let k = 0; k < Math.min(bars.length, 12); k += 1) {
        const bar = bars[k].getBoundingClientRect();
        if (bar.width) MARGIN = Math.max(MARGIN, Math.round(bar.right - origin.left - colRight) + 10);
      }
    }
    let column, side = 'right';
    if (tools.length) column = median(tools.map((tool) => tool.center)) - SIZE / 2;
    // CanLII draws its citation-weight bar just right of the text: the controls keep clear of it.
    else if (colRight + MARGIN + SIZE <= clipRight && clear(colRight + MARGIN)) column = colRight + MARGIN;
    else if (colLeft - 12 - SIZE >= clipLeft) { column = colLeft - 12 - SIZE; side = 'left'; }
    else {
      // Controls placed while there was a margin (before the window narrowed) come down too.
      for (const node of view.live.values()) node.remove();
      view.pool.push(...view.live.values());
      view.live.clear();
      view.order = null;
      return;
    }
    // A unit's buttons, one column: its count of shown buttons (unitButtons).
    for (const i of shown) {
      // The nearest unused CanLII button level with the unit's start.
      let tool = null;
      if (tools.length) {
        let k = lowerBound(toolTops, ys[i] - 20);
        for (; k < tools.length && tools[k].top < ys[i] + 70; k += 1) if (!tools[k].used) { tool = tools[k]; break; }
      }
      if (tool) { tool.used = true; xs[i] = tool.center - SIZE / 2; ys[i] = tool.bottom + GAP; } else xs[i] = column;
    }
    shown.sort((a, b) => ys[a] - ys[b]);
    for (let k = 0; k < shown.length; k += 1) {
      const i = shown[k], n = unitButtons(units[i]), room = k + 1 < shown.length ? ys[shown[k + 1]] - ys[i] : Infinity;
      modes[i] = room >= n * SIZE + n * GAP ? 'stack' : 'peek';
      // Never over its own unit's text, however wide that unit runs: beside it, on the margin's side.
      if (side === 'right') xs[i] = Math.max(xs[i], unitRights[i] + 4);
      else xs[i] = Math.min(xs[i], unitLefts[i] - 4 - SIZE);
    }
    view.xs = xs;
    view.ys = ys;
    view.modes = modes;
    view.order = Int32Array.from(shown);
    view.sortedTops = Float64Array.from(shown, (i) => ys[i]);
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

  // The live controls stack in the overlay in page order, each moved to its place by margins: in
  // normal flow, so none has a paint layer of its own (a positioned element would). Rebuilt only when
  // the set changes. Margins are important, like the stylesheet's `all: initial`, which would win.
  function stack(from, to) {
    const nodes = [];
    let bottom = 0;
    for (let k = from; k < to; k += 1) {
      const i = view.order[k], node = view.live.get(i);
      if (!node) continue;
      const top = Math.round(view.ys[i]);
      node.style.setProperty('margin', `${top - bottom}px 0 0 ${Math.round(view.xs[i])}px`, 'important');
      node.dataset.place = view.modes[i];
      bottom = top + unitButtons(view.units[i]) * (SIZE + GAP) - GAP; // a peeking group keeps its space (hidden, not removed)
      nodes.push(node);
    }
    view.overlay.replaceChildren(...nodes);
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
    const from = lowerBound(sortedTops, offset - height * NEAR), to = lowerBound(sortedTops, offset + height * (1 + NEAR));
    const wanted = new Set();
    for (let k = from; k < to; k += 1) wanted.add(order[k]);
    let changed = remeasured === true;
    for (const [i, node] of view.live) {
      if (wanted.has(i)) continue;
      view.live.delete(i);
      view.pool.push(node);
      changed = true;
    }
    for (const i of wanted) {
      if (view.live.has(i)) continue;
      const unit = view.units[i], node = control();
      node.dataset.place = view.modes[i];
      node.dataset.kind = unit.kind;
      node.classList.remove('hot');
      node.lpElement = unit.element;
      node.lpLocator = unit.locator;
      node.lpTools = unit.tools;
      const label = `Copy pinpoint (Ctrl+X) · ${KIND_LABEL[unit.kind] || unit.kind} ${unit.locator}`;
      node.firstChild.dataset.tip = label;
      node.firstChild.setAttribute('aria-label', label);
      node.firstChild.hidden = numbersStyle() && unit.numbered;
      setCited(node, unit.cited);
      view.live.set(i, node);
      changed = true;
    }
    if (changed) stack(from, to);
  }

  document.addEventListener('scroll', () => {
    if (view.order && !view.frame) view.frame = requestAnimationFrame(update);
  }, { capture: true, passive: true });
  addEventListener('resize', scheduleMeasure, { passive: true });
  document.fonts?.addEventListener?.('loadingdone', scheduleMeasure);

  // The unit under the pointer (the last control at or above it, by position, so a provision whose
  // anchor is an empty <a name> counts too) shows its controls in full, and a crowded unit's hidden
  // pair appears. Off the document's units, the last one stays lit so the pointer can reach it.
  let pointerY = 0, hoverFrame = 0;
  function hoverUnit() {
    hoverFrame = 0;
    if (!view.order || !view.overlay?.isConnected) return;
    const y = pointerY - view.overlay.getBoundingClientRect().top;
    const k = lowerBound(view.sortedTops, y + 4) - 1;
    const node = k >= 0 ? view.live.get(view.order[k]) || null : null;
    if (node === view.hot) return;
    view.hot?.classList.remove('hot');
    node?.classList.add('hot');
    view.hot = node;
  }
  document.addEventListener('pointermove', (event) => {
    if (!view.order || event.target.closest?.('.lp-units')) return;
    pointerY = event.clientY;
    if (!hoverFrame) hoverFrame = requestAnimationFrame(hoverUnit);
  }, { capture: true, passive: true });

  // ---------------------------------------------------------------------------
  // Paragraph and provision numbers as the copy control (Settings: "Copy from paragraph numbers",
  // the default): a click on a number copies its pinpoint, and a reader's own copy of a selection
  // links every whole number inside it to its paragraph or provision, so a quote carries its links.
  //
  // The numbers are the provider's own elements, drawn as buttons by the stylesheet from the first
  // paint (content.css), so nothing is written to the page and nothing changes once it is in:
  // CanLII's statute labels (canlii_section "45", canlii_section_with_subsection and
  // canlii_subsection "(1)" with section and subsection attributes, federal sectionLabel and
  // lawlabel "(a)") and a judgment's paragraph anchor (the "5" of "[5]"), and Lexis's PARA_ spans.
  // Westlaw alone writes a number as plain text at the start of its paragraph: that number is put in
  // a span of its own (span.lp-num) just before its paragraph's controls are placed.
  const NUMBER = provider === 'canlii'
    ? 'a.reflex-paragAnchor[name], .canlii_section_with_subsection, .canlii_subsection, .canlii_section, span.sectionLabel, .SectionNumber, span.lawlabel, .lp-num'
    : provider === 'lexis' ? '[id^="PARA_"]' : '.lp-num';
  const numbersOn = () => settings.unitCopyButtons && settings.unitCopyStyle !== 'buttons';
  const LABELS = '.canlii_section_with_subsection, .canlii_subsection, .canlii_section, span.sectionLabel, .SectionNumber, span.lawlabel';
  const SECTION_LABEL = '.canlii_section, span.sectionLabel, .SectionNumber';

  // A judgment's "[5]": CanLII writes the brackets as plain text around the paragraph anchor, so each
  // is put in a span of its own (span.lp-br, styled with the number in content.css). Text and layout
  // are unchanged; runs once as the script starts, then for anchors added later.
  const bracketed = new WeakSet();
  function wrapCanliiBrackets() {
    if (provider !== 'canlii') return;
    const wrap = (text, at) => {
      const piece = at ? text.splitText(at) : text;
      if (!at && piece.length > 1) piece.splitText(1);
      const span = document.createElement('span');
      span.className = 'lp-br';
      piece.replaceWith(span);
      span.appendChild(piece);
    };
    for (const anchor of document.getElementsByClassName('reflex-paragAnchor')) {
      if (bracketed.has(anchor)) continue;
      bracketed.add(anchor);
      const before = anchor.previousSibling, after = anchor.nextSibling;
      if (before?.nodeType !== 3 || !before.data.endsWith('[') || after?.nodeType !== 3 || !after.data.startsWith(']')) continue;
      wrap(before, before.length - 1);
      wrap(after, 0);
    }
  }
  wrapCanliiBrackets();

  /** The number an event's target is, or whose bracket it is. */
  function numberFrom(target) {
    const number = target?.closest?.(NUMBER);
    if (number) return number;
    const bracket = target?.closest?.('.lp-br');
    if (!bracket) return null;
    const sibling = bracket.previousElementSibling?.matches(NUMBER) ? bracket.previousElementSibling : bracket.nextElementSibling;
    return sibling?.matches(NUMBER) ? sibling : null;
  }

  function wrapWestlawNumbers() {
    if (provider !== 'westlaw' || !numbersOn()) return;
    for (const text of document.querySelectorAll('.crsw_labeledParagraph .co_paragraphText:not([data-lp-num])')) {
      text.setAttribute('data-lp-num', '');
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      let first = walker.nextNode();
      while (first && !first.data.trim()) first = walker.nextNode();
      const match = first?.data.match(/^(\s*)(\d+[.)]?)/);
      if (!match) continue;
      const number = first.splitText(match[1].length);
      number.splitText(match[2].length);
      const span = document.createElement('span');
      span.className = 'lp-num';
      number.replaceWith(span);
      span.appendChild(number);
    }
  }

  // A CanLII statute's provision numbers that CanLII writes as plain text (a BC, Alberta or Ontario
  // Act's "(2)", "(a)", "(i)", most sections of some Acts): each put in a span.lp-num of its own, so
  // every number on the page is red and copies on a click, as CanLII's labelled ones do. Which
  // numbers count is content.js's statute copy's own reading. Text and layout are unchanged (the
  // span only colours the number; its weight stays the page's, as it may come after the first
  // paint, so no line rewraps). A whole Act is never read (the Criminal Code has 40,000 blocks):
  // only the blocks from a screen above the window to two below it, found from the page's own hit
  // test at the window, not a search, with the rest of the page UI and then in the frame of a
  // scroll, before it paints, as the margin controls are. A text that does not start with a digit
  // or "(" is passed over on its first character.
  // Not table cells: a schedule's or an amendment table's numbers are references, not provisions.
  const TEXT_BLOCKS = 'p, li, dd, dt, div';
  const STATUTE_ROOT = '#originalDocument, #docCont, #documentContent';
  const readBlocks = new WeakSet();
  const statuteNumbers = () => provider === 'canlii' && numbersOn() && /\/laws\//.test(location.pathname) && Boolean(page.statuteNumberIn);
  function startsNumber(data) {
    for (let i = 0; i < data.length; i += 1) {
      const code = data.charCodeAt(i);
      if (code <= 32 || code === 160) continue;
      return code === 40 || (code >= 48 && code <= 57);
    }
    return false;
  }
  /** A block's first text with words in it: a few steps down its first children, no walker. */
  function firstText(block) {
    const after = (node) => {
      for (let at = node; at && at !== block; at = at.parentNode) if (at.nextSibling) return at.nextSibling;
      return null;
    };
    for (let node = block.firstChild; node;) {
      if (node.nodeType === 3 && node.data.trim()) return node;
      node = node.nodeType === 1 && node.firstChild ? node.firstChild : after(node);
    }
    return null;
  }
  const BLOCK_FILTER = { acceptNode: (element) => (element.matches(TEXT_BLOCKS) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) };
  /** The blocks from a screen above the window to two below it, in page order. */
  function blocksNearView(root) {
    const box = root.getBoundingClientRect();
    if (box.bottom < -innerHeight || box.top > 2 * innerHeight) return [];
    const x = Math.round(Math.min(innerWidth - 2, Math.max(1, box.left + Math.min(160, box.width / 4))));
    // The text at a point of the window (a hit on a page-tall container would start the walk at its top).
    let hit = null;
    for (const fraction of [0.05, 0.3, 0.55, 0.8, 0.98]) {
      const at = document.caretRangeFromPoint?.(x, innerHeight * fraction)?.startContainer;
      const element = at?.nodeType === 3 ? at.parentElement : at;
      if (element && root.contains(element) && element !== root && element.getBoundingClientRect().height < innerHeight) { hit = element; break; }
    }
    if (!hit) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, BLOCK_FILTER), before = [], after = [];
    // Blocks around the hit: a container of it (taller than the window) is passed over, not stopped at.
    walker.currentNode = hit;
    for (let block = walker.previousNode(), steps = 0; block && steps < 3000; block = walker.previousNode(), steps += 1) {
      if (block.contains(hit)) continue;
      if (block.getBoundingClientRect().bottom < -innerHeight) break;
      before.push(block);
    }
    walker.currentNode = hit;
    const own = hit.closest(TEXT_BLOCKS);
    for (let block = walker.nextNode(), steps = 0; block && steps < 3000; block = walker.nextNode(), steps += 1) {
      const rect = block.getBoundingClientRect();
      if (rect.top > 2 * innerHeight) break;
      if (rect.bottom >= -innerHeight) after.push(block);
    }
    return [...before.reverse(), ...(own && root.contains(own) ? [own] : []), ...after];
  }
  let wrappedAt = null, wrapFrame = 0;
  function wrapCanliiStatuteNumbers() {
    if (!statuteNumbers()) return;
    const root = document.querySelector(STATUTE_ROOT);
    if (!root) return;
    wrappedAt = scrollY;
    // Read before anything is wrapped: a wrap splits the text it is in.
    const wraps = [];
    for (const block of blocksNearView(root)) {
      if (readBlocks.has(block)) continue;
      const text = firstText(block);
      if (!text || !startsNumber(text.data)) continue;
      // The block's own first words (an inner block reads its own), not already a number.
      const parent = text.parentElement;
      if (parent.closest(TEXT_BLOCKS) !== block || parent.closest(`${NUMBER}, [data-lp-ui], .lp-br, table`)) continue;
      readBlocks.add(block);
      const found = page.statuteNumberIn(block, text);
      if (found) wraps.push([text, found]);
    }
    for (const [text, found] of wraps) {
      const number = found.lead ? text.splitText(found.lead) : text;
      if (number.length > found.length) number.splitText(found.length);
      const span = document.createElement('span');
      span.className = 'lp-num lp-num-text';
      number.replaceWith(span);
      span.appendChild(number);
    }
  }
  // Half a screen of scrolling (or a jump to a provision) reads the blocks newly near the window.
  const wrapSoon = () => {
    if (!wrapFrame && wrappedAt !== null && statuteNumbers()) {
      wrapFrame = requestAnimationFrame(() => {
        wrapFrame = 0;
        if (Math.abs(scrollY - wrappedAt) > innerHeight / 2) wrapCanliiStatuteNumbers();
      });
    }
  };
  addEventListener('scroll', wrapSoon, { passive: true });
  addEventListener('resize', () => { wrappedAt = Infinity; wrapSoon(); }, { passive: true });

  /** The locator a number's own markup states (CanLII statutes), or ''. */
  function statedLocator(number) {
    const label = number.matches('[section]') ? number : number.querySelector('[section][subsection]:not([subsection="null"])') || number.querySelector('[section]');
    if (label) {
      const section = label.getAttribute('section'), subsection = label.getAttribute('subsection');
      return subsection && subsection !== 'null' ? `${section}(${subsection})` : section;
    }
    const text = number.textContent.replace(/\s+/g, '');
    return provider === 'canlii' && number.matches(SECTION_LABEL) ? text : '';
  }
  /** A statute's numbers by the locator they state (one pass): which units have a number of their
   *  own (no margin pinpoint button) and where it is (the unit's controls sit on its line). */
  let numberedCache = null;
  function numberedLocators() {
    if (numberedCache && [...numberedCache.values()].slice(0, 3).every((label) => label.isConnected)) return numberedCache;
    const found = numberedCache = new Map();
    if (provider !== 'canlii') return found;
    // Sections and subsections only: a paragraph's "(a)" (lawlabel, the bulk of a big Act's labels) decides nothing here.
    for (const label of document.querySelectorAll('[section], span.sectionLabel, .SectionNumber')) {
      const section = label.getAttribute('section'), subsection = label.getAttribute('subsection');
      const locator = section ? (subsection && subsection !== 'null' ? `${section}(${subsection})` : section)
        : label.matches(SECTION_LABEL) ? label.textContent.replace(/\s+/g, '') : '';
      if (locator && !found.has(locator)) found.set(locator, label);
    }
    return found;
  }
  /** A unit's clickable number, in its element (judgments, Lexis, Westlaw). */
  function numberIn(element) {
    if (!element) return null;
    return element.matches?.(NUMBER) ? element : element.querySelector?.(NUMBER) || null;
  }
  const cleanHere = () => `${location.origin}${location.pathname}`;

  function numberAt(event) {
    return numbersOn() ? numberFrom(event.target) : null;
  }

  /** The unit a number stands for: the locator its markup states (a statute's "45 (1)" is s 45(1),
   *  "(a)" the paragraph after its subsection), else the unit it sits in. */
  const locatorTables = new WeakMap();
  function unitFor(model, number) {
    const nodes = model.structure?.nodes || [];
    const stated = statedLocator(number);
    if (stated) {
      // One table per model, so linking a long selection's numbers is not a search per number.
      let byLocator = locatorTables.get(model);
      if (!byLocator) {
        locatorTables.set(model, byLocator = new Map());
        for (const candidate of nodes) if (candidate.element?.isConnected && !byLocator.has(candidate.locator)) byLocator.set(candidate.locator, candidate);
      }
      const node = byLocator.get(stated);
      if (node) return node;
    }
    const inside = page.unitAt(model, number);
    const own = number.textContent.replace(/\s+/g, '').match(/^\(([^()]+)\)$/);
    if (inside && own) {
      // A paragraph label: the first unit after the one it sits in whose locator ends in it.
      const start = nodes.indexOf(inside);
      const child = nodes.slice(start).find((candidate) => candidate.locator.endsWith(`(${own[1]})`) && candidate.locator.startsWith(inside.locator.split('(')[0]));
      if (child) return child;
    }
    return inside;
  }

  document.addEventListener('click', (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const number = numberAt(event);
    // A click that ends a selection is the selection's.
    if (!number || !getSelection().isCollapsed) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // On CanLII the number says what it is: copied at once, without the page's model.
    const slow = () => page.model(false).then(async (model) => {
      fullModel = model;
      // The unit the number states first; where that unit holds no text of its own (a statute's s 45
      // and s 45(1) anchors sit at one spot), the unit the number sits in, which copies as s 45(1).
      const candidates = [unitFor(model, number), page.unitAt(model, number)].filter((node, i, all) => node && all.indexOf(node) === i);
      if (!candidates.length) throw new Error('This passage is no longer on the page.');
      for (const [i, node] of candidates.entries()) {
        try { return await page.copyUnit(model, node, 'pinpoint'); } catch (error) { if (i === candidates.length - 1) throw error; }
      }
    });
    let quick = null;
    try { quick = page.quickNumberCopy?.(number) || null; } catch (_) { quick = null; }
    run((quick ? quick.catch(slow) : slow()).then(() => flashNumber(number)), null);
  }, true);

  // The copied number flashes solid red (content.css), then fades back: the label as a whole, not a
  // part inside it.
  let flashed = null, flashTimer = 0, fadeTimer = 0, doneTimer = 0;
  function flashNumber(number) {
    let target = number;
    for (let outer = target.parentElement?.closest(NUMBER); outer; outer = outer.parentElement?.closest(NUMBER)) target = outer;
    clearTimeout(flashTimer);
    clearTimeout(fadeTimer);
    clearTimeout(doneTimer);
    const again = flashed === target && target.classList.contains('lp-num-done');
    flashed?.classList.remove('lp-num-copied', 'lp-num-fade', 'lp-num-done');
    flashed = target;
    target.classList.add('lp-num-copied');
    // A second click of the same number plays the ring and label again (from the next frame, so the
    // animation restarts without forcing the page's layout).
    const done = () => { target.classList.add('lp-num-done'); doneTimer = setTimeout(() => target.classList.remove('lp-num-done'), 1000); };
    if (again) requestAnimationFrame(done); else done();
    flashTimer = setTimeout(() => {
      target.classList.add('lp-num-fade');
      target.classList.remove('lp-num-copied');
      fadeTimer = setTimeout(() => { target.classList.remove('lp-num-fade'); if (flashed === target) flashed = null; }, 300);
    }, 140);
  }

  // Where a number links: its unit's pinpoint target from the page's model; on CanLII, before the
  // model is built, the document's own anchor.
  function numberUrl(number) {
    if (fullModel && page.current(fullModel)) {
      const node = unitFor(fullModel, number);
      if (node) { try { return page.linkFor(fullModel, node); } catch (_) { /* fall through */ } }
    }
    if (provider !== 'canlii') return '';
    const stated = statedLocator(number);
    const anchor = number.querySelector?.('a[name]')?.getAttribute('name')
      || (stated ? `sec${stated.replace(/\((.+?)\)/, 'subsec$1')}` : '');
    return anchor && document.getElementsByName(anchor).length ? `${cleanHere()}#${encodeURIComponent(anchor)}` : '';
  }

  const LINKABLE = NUMBER;
  let copies = 0;
  document.addEventListener('copy', (event) => {
    if (globalThis.LegalPinpointerWritingClipboard) return;
    const selection = getSelection();
    if (selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    // Statute text: its provisions as indented paragraphs, as the quote copy writes them (content.js).
    const copyId = ++copies;
    const ready = fullModel && page.current(fullModel);
    const statute = page.quickStatuteCopy?.(range) || (ready ? page.statuteCopy?.(fullModel, range) : null);
    if (statute) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.clipboardData.setData('text/plain', statute.plain);
      event.clipboardData.setData('text/html', statute.html);
      return;
    }
    // A copy made before the page's model is built (a quick select and Ctrl+C on a long statute):
    // the browser's own copy goes in now, and once the model is in, a statute's indented copy
    // replaces it, unless something else was copied meanwhile.
    if (!ready && provider !== 'canlii' && page.settings?.statuteCopyIndent !== false && page.statuteCopy && page.writeClipboard) {
      const saved = range.cloneRange(), started = Date.now();
      warm();
      const finish = (model) => {
        fullModel = model;
        if (copyId !== copies || Date.now() - started > 8000) return;
        const late = page.statuteCopy(model, saved);
        if (late) return page.writeClipboard(late);
      };
      // This copy's own number links change the page for a moment; a build they overlap is retried.
    }
    if (!numbersOn() || !LINKABLE) return;
    const common = range.commonAncestorContainer;
    const root = common.nodeType === 1 ? common : common.parentElement;
    if (!root || root.closest('[data-lp-ui]')) return;
    // Every link is worked out before any is added: the page's model is current only while the page is untouched.
    const links = [];
    for (const number of root.querySelectorAll(LINKABLE)) {
      // Only numbers wholly inside the selection; a boundary inside one stays as it is.
      if (!range.intersectsNode(number) || number.contains(range.startContainer) || number.contains(range.endContainer)) continue;
      if (number.closest('a[href]') || number.querySelector('a[href]') || number.querySelector(NUMBER)) continue; // a label holding a label: the inner one
      const url = numberUrl(number);
      if (url) links.push([number, url]);
      if (links.length >= 5000) break;
    }
    const quietly = page.quietly || ((change) => change());
    const undo = quietly(() => links.map(([number, url]) => {
      // A number that is (or holds) the page's own anchor: the anchor takes the link.
      const anchor = number.tagName === 'A' ? number : number.querySelector(':scope > a[name]:not([href])');
      if (anchor) {
        anchor.setAttribute('href', url);
        return () => anchor.removeAttribute('href');
      }
      const link = document.createElement('a');
      link.href = url;
      while (number.firstChild) link.appendChild(number.firstChild);
      number.appendChild(link);
      return () => { while (link.firstChild) number.insertBefore(link.firstChild, link); link.remove(); };
    }));
    // The numbers' button look is the page's, not the text's: off while the browser copies the
    // selection's styles, so a paste shows the numbers as the page's own text (linked).
    // Only the copied region is restyled (a class on its common ancestor), never the whole page.
    root.classList.add('lp-copying');
    undo.push(() => root.classList.remove('lp-copying'));
    // The browser serializes the selection after this event; the page is back as it was before it paints.
    setTimeout(() => quietly(() => { for (const restore of undo) restore(); }), 0);
  }, true);

  // One tooltip for every control, shown after a short hover.
  let tip = null, tipTimer = 0;
  function hideTip() {
    clearTimeout(tipTimer);
    if (tip) tip.hidden = true;
  }
  document.addEventListener('pointerover', (event) => {
    const number = numbersOn() ? numberFrom(event.target) : null;
    const button = number || event.target;
    const text = number ? 'Copy the pinpoint' : button.dataset?.tip;
    if (!number && (!button.parentElement?.classList?.contains('lp-unit') || !text)) return hideTip();
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'lp-tip';
        tip.setAttribute('data-lp-ui', '');
        tip.setAttribute('role', 'tooltip');
        document.documentElement.appendChild(tip);
      }
      tip.textContent = text;
      const rect = button.getBoundingClientRect();
      tip.hidden = false;
      tip.style.left = `${Math.max(6, Math.round(rect.left + rect.width / 2 - tip.offsetWidth / 2))}px`;
      tip.style.top = `${Math.round(rect.top - tip.offsetHeight - 6)}px`;
    }, 300);
  }, { capture: true, passive: true });
  document.addEventListener('pointerdown', hideTip, { capture: true, passive: true });
  addEventListener('scroll', hideTip, { capture: true, passive: true });

  // Pages that render or replace the document after load (Lexis): the page is read again only when
  // something added carries a paragraph or section anchor (checked on the added content alone, so a
  // provider redrawing its panels and menus all the time costs nothing), in the next frame and no
  // more than every quarter second. Pinpointer's own insertions do not count.
  const ANCHORS = provider === 'canlii'
    ? 'a[name^="par"], a.reflex-paragAnchor, [id^="par"], a[name^="sec"], a[id^="sec"], a[name^="art"], a[id^="art"], a[name^="rule"], a[id^="rule"], [id^="se:"], .viibes-marker-toolbox'
    : provider === 'lexis' ? '[id^="PARA_"], [id^="SECTION_"], [id^="RULE_"], [id^="ARTICLE_"]'
      : '[id^="crsw_paragraph_num_"], [data-section-number], [data-rule-number], [data-article-number]';
  function watchUnits() {
    if (view.mutations) return;
    view.mutations = new MutationObserver((records) => {
      if (view.syncTimer || !settings.unitCopyButtons) return;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1 || node.hasAttribute('data-lp-ui') || node.classList.contains('lp-num') || node.classList.contains('lp-br') || !(node.matches(ANCHORS) || node.querySelector(ANCHORS))) continue;
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
      units: [], order: null, sortedTops: null, xs: null, ys: null, modes: null,
      overlay: null, live: new Map(), pool: [], hot: null, placedAt: undefined,
      frame: 0, syncFrame: 0, syncTimer: 0, measureTimer: 0, resize: null, mutations: null
    });
    hideTip();
  }

  // ---------------------------------------------------------------------------
  // CanLII: the document's name in place of the last breadcrumb in CanLII's sticky header. The
  // breadcrumbs already fill the header's free width (content.css); the name wraps onto as many
  // lines as it needs, and a header grown taller than CanLII's own 80px keeps CanLII's side panels
  // (toolbar, sidebar, heatmap: sticky at --header-default-size) below it.

  let crumb = null;

  function mountCrumb() {
    const name = document.querySelector('#canlii-breadcrumbs > span:last-of-type [itemprop="name"]');
    const title = document.querySelector('#title-container h1.main-title, h1.main-title');
    if (!name || !title) return;
    const text = title.textContent.replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (!crumb || crumb.name !== name) {
      crumb = { name, original: name.textContent, button: null, marker: null };
      // Case Marker's circle for this document, small, before the name (hidden while empty).
      const marker = document.createElement('span');
      marker.className = 'lp-crumb-marker';
      marker.setAttribute('data-lp-ui', '');
      name.before(marker);
      crumb.marker = marker;
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
    const caseMarker = globalThis.LegalPinpointerCaseMarker;
    if (caseMarker && settings.caseMarker) caseMarker.banner(crumb.marker); else crumb.marker.replaceChildren();
    // The tab, too, is titled with the full style of cause or statute name.
    crumb.tabTitle ??= document.title;
    if (document.title !== text) document.title = text;
    fitHeader();
  }

  let headerObserver = null;
  function fitHeader() {
    const header = document.getElementById('canlii-header');
    if (!header || headerObserver) return;
    headerObserver = new ResizeObserver(([entry]) => {
      const height = Math.ceil(entry.borderBoxSize?.[0]?.blockSize ?? header.getBoundingClientRect().height);
      if (height > 80) document.documentElement.style.setProperty('--header-default-size', `${height}px`);
      else document.documentElement.style.removeProperty('--header-default-size');
    });
    headerObserver.observe(header);
  }

  function unmountCrumb() {
    if (!crumb) return;
    crumb.button.remove();
    crumb.marker.remove();
    crumb.name.textContent = crumb.original;
    crumb.name.removeAttribute('title');
    headerObserver?.disconnect();
    headerObserver = null;
    document.documentElement.style.removeProperty('--header-default-size');
    if (crumb.tabTitle !== undefined) document.title = crumb.tabTitle;
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

  // A drag that starts in the title stays in it: while the button is down, the rest of the page
  // cannot be selected (lp-title-drag, content.css), so the browser itself stops the selection at
  // the title's last (or first) character instead of running into the citation line and the text
  // below; the selection is also corrected should anything slip past.
  let titleDrag = null;
  const titlePress = (event) => {
    titleDrag = event && settings.cleanTitles && event.button === 0 && !event.shiftKey ? event.target.closest?.(TITLES.join(', ')) || null : null;
    // The rest of the page stays locked until the next press (the browser settles the selection
    // after the release), which unlocks it before its own selection starts.
    if (event) document.documentElement.classList.toggle('lp-title-drag', Boolean(titleDrag));
  };
  // early.js reports every press and release, ahead of the page's own listeners.
  globalThis.LegalPinpointerTitlePress = titlePress;
  window.addEventListener('mouseup', () => titlePress(null), { capture: true, passive: true });
  (globalThis.LegalPinpointerSelectionHooks || { add: (hook) => document.addEventListener('selectionchange', hook) }).add(() => {
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
      border: 1px solid #e5e7eb; border-radius: 7px; background: #fff; opacity: 0; transform: scale(.9); pointer-events: none;
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

  // The citation bar takes the floating button's place while it is on.
  function floatVisibility() {
    floating?.classList.toggle('ready', settings.canliiButton && !settings.providerHeader && !toolsVisible);
    barVisibility();
  }

  function watchTools() {
    toolsObserver?.disconnect();
    toolsVisible = true;
    // A title with no box at all (a hidden copy, a pane not shown yet) counts as in view: the bar is
    // for a title scrolled away, never one the provider is not drawing.
    toolsObserver = new IntersectionObserver(([entry]) => {
      toolsVisible = entry.isIntersecting || !entry.target.getClientRects().length;
      floatVisibility();
    });
    toolsObserver.observe(tools.title);
  }

  // The citation bar (Settings: Citation bar on Westlaw & Lexis): frozen along the top of the
  // document's scrolling area while the title is out of view, with the CanLII button, the citation
  // and Copy link. Fixed, in its own shadow root, and click-through outside the bar: it never moves
  // the page, the provider's CSS never reaches it, and it covers nothing while the title shows.
  const BAR_CSS = `
    :host { all: initial; }
    .bar { position: fixed; top: 0; left: 0; display: flex; align-items: center; gap: 8px; box-sizing: border-box; min-height: 38px;
      padding: 5px 8px; border-bottom: 1px solid #e5e7eb; background: #fff; color: #111827;
      box-shadow: 0 1px 3px rgb(0 0 0 / 6%), 0 6px 16px -10px rgb(0 0 0 / 18%);
      font: 600 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
      opacity: 0; transform: translateY(-100%); pointer-events: none; transition: opacity 120ms, transform 140ms ease-out; }
    .bar.ready { opacity: 1; transform: none; pointer-events: auto; }
    .cite { flex: 1; min-width: 0; overflow-wrap: break-word; user-select: text; cursor: text; }
    a { display: grid; flex: none; place-items: center; box-sizing: border-box; width: 26px; height: 26px; border: 1px solid #e5e7eb;
      border-radius: 6px; background: #fff; cursor: pointer; transition: border-color 80ms, box-shadow 80ms; }
    a::before { content: ""; width: 16px; height: 16px; background: ${CANLII_ICON} center / contain no-repeat; }
    a.site::before { background-image: ${COURT_ICON}; }
    a.live:hover { border-color: #f3b4ae; box-shadow: 0 1px 4px rgb(213 43 30 / 18%); }
    a.dead { opacity: .42; filter: grayscale(1); cursor: default; }
    a.pending { opacity: .25; filter: grayscale(1); cursor: default; }
    a[hidden], .marker[hidden] { display: none; }
    .marker { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 20px; height: 26px; }
    button { all: unset; display: inline-flex; flex: none; align-items: center; gap: 6px; box-sizing: border-box; height: 28px; padding: 0 8px;
      border-radius: 6px; color: #374151; font: 500 12px/1 inherit; font-family: inherit; cursor: pointer; transition: background-color 80ms, color 80ms; }
    button:hover { background: #fff1f0; color: #b72016; }
    button:focus-visible, a:focus-visible { outline: 2px solid #d52b1e; outline-offset: 1px; }
    button svg { width: 15px; height: 15px; }
    button.done { color: #111827; background: #f3f4f6; }
    button.done span::after { content: "Copied"; }
    button:not(.done) span::after { content: "Copy link"; }
    @media print { .bar { display: none; } }
  `;
  const LINK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';
  let bar = null;

  function mountBar() {
    if (bar) return bar;
    const host = document.createElement('div');
    host.setAttribute('data-lp-ui', '');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483645';
    const shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(BAR_CSS);
    shadow.adoptedStyleSheets = [sheet];
    const element = document.createElement('div');
    element.className = 'bar';
    element.setAttribute('role', 'toolbar');
    element.setAttribute('aria-label', 'Citation');
    // Case Marker's circle is the host's own child (Case Marker's styles and clicks reach it there),
    // shown in the bar's slot; the slot shows only while it holds one.
    element.innerHTML = '<a class="pending" data-lp-action="canlii" aria-label="CanLII" title="Looking for a CanLII version"></a>'
      + '<span class="marker" hidden><slot></slot></span><span class="cite"></span>'
      + `<button type="button" data-lp-action="citation" aria-label="Copy the linked citation" title="Copy the linked citation (Alt+X)">${LINK_ICON}<span></span></button>`;
    shadow.appendChild(element);
    document.documentElement.appendChild(host);
    const marker = element.querySelector('.marker'), slot = marker.firstChild;
    slot.addEventListener('slotchange', () => { marker.hidden = !slot.assignedElements().length; });
    bar = { host, element, canlii: element.firstChild, cite: element.querySelector('.cite') };
    return bar;
  }

  /** The bar's small Case Marker circle, for the page's document (Case Marker places it). */
  function barMarker() {
    const caseMarker = globalThis.LegalPinpointerCaseMarker;
    if (caseMarker && settings.caseMarker) caseMarker.banner(bar.host); else bar.host.replaceChildren();
  }

  // Along the top of the box the title scrolls in (an app's document pane), else of the window below
  // the provider's own fixed or sticky bars (measured once each time the bar shows).
  const pinned = (node) => {
    for (let at = node; at && at !== document.documentElement; at = at.parentElement) if (/fixed|sticky/.test(getComputedStyle(at).position)) return true;
    return false;
  };
  function windowTop() {
    const x = document.documentElement.clientWidth / 2;
    for (let y = 0; y < Math.min(240, innerHeight / 3); y += 4) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || !pinned(hit)) return y;
    }
    return 0;
  }
  function placeBar() {
    const box = tools?.title && scrollBox(tools.title);
    const rect = box ? box.getBoundingClientRect() : { top: windowTop(), left: 0, width: document.documentElement.clientWidth };
    Object.assign(bar.element.style, { top: `${Math.max(0, Math.round(rect.top))}px`, left: `${Math.round(rect.left)}px`, width: `${Math.round(rect.width)}px` });
  }

  function barVisibility() {
    if (!bar) return;
    const ready = settings.providerHeader && !toolsVisible;
    if (ready) placeBar();
    bar.element.classList.toggle('ready', ready);
  }
  addEventListener('resize', () => { if (bar?.element.classList.contains('ready')) placeBar(); }, { passive: true });
  // A provider's header that grows or shrinks as the page scrolls (Lexis): placed again once scrolling settles.
  let settleTimer = 0;
  addEventListener('scroll', () => {
    if (!bar?.element.classList.contains('ready')) return;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => requestAnimationFrame(placeBar), 150);
  }, { capture: true, passive: true });

  function paintBar(current, fallback = '') {
    mountBar();
    bar.cite.textContent = current.citation?.plain || fallback;
    bar.cite.title = bar.cite.textContent;
    if (current.citation) paintLink(bar.canlii, current); else paintLink(bar.canlii, {});
    bar.canlii.removeAttribute('data-tip');
    bar.canlii.title = bar.canlii.classList.contains('live') ? (current.canliiUrl ? 'Open on CanLII' : 'Open on the court’s site') : 'No CanLII version found';
    bar.canlii.hidden = !settings.canliiButton;
    barMarker();
    barVisibility();
  }

  function unmountBar() {
    bar?.host.remove();
    bar = null;
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
    if (settings.providerHeader) paintBar(current, titleText());
    if (settings.canliiButton && current.documentType === 'case') {
      paintLink(mountFloating(), current);
      floatVisibility();
    }
  }
  // The tools hold no text, so the title's text is the title alone.
  const titleText = () => (findTitle()?.textContent || '').replace(/\s+/g, ' ').trim();

  function unmountFloating() {
    floating?.lpHost.remove();
    floating = null;
  }

  // ---------------------------------------------------------------------------

  let applying = 0;
  async function apply() {
    const ticket = ++applying;
    document.documentElement.classList.toggle('lp-no-numbers', !numbersOn());
    if (settings.unitCopyButtons) {
      // A changed style redraws every control from its own template.
      if (view.style !== settings.unitCopyStyle) { removeUnits(); view.style = settings.unitCopyStyle; }
      queueSync();
      watchUnits();
    } else removeUnits();
    if (provider === 'canlii') {
      document.documentElement.classList.toggle('lp-no-canlii-name', !settings.canliiHeader);
      document.documentElement.classList.toggle('lp-no-cited-by', !citedBy());
      if (settings.canliiHeader) mountCrumb(); else unmountCrumb();
    } else {
      document.documentElement.classList.toggle('lp-raw-titles', !settings.cleanTitles);
      tameTitle();
      if (settings.cleanTitles || settings.canliiButton || settings.caseMarker || settings.providerHeader) mountTools(); else unmountTools();
      if (!settings.canliiButton) unmountFloating();
      if (!settings.providerHeader) unmountBar();
      // The bar is there at once with the title; the citation replaces it when the model is in.
      else if (tools && !bar) { mountBar(); bar.cite.textContent = titleText(); bar.canlii.hidden = !settings.canliiButton; barMarker(); barVisibility(); }
      if (tools || settings.canliiButton) {
        try {
          const current = metadata && page.current(metadata) ? metadata : (metadata = await page.model(true));
          if (ticket === applying) paintTools(current);
        } catch (_) {
          // Not a legal document (a results list or an error page): the tools stay grey, and the bar
          // carries the title.
          if (tools && ticket === applying) paintLink(tools.canlii, {});
          if (tools && settings.providerHeader && ticket === applying) paintBar({}, titleText());
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
  // (early.js reads the copy's settings too: only the page UI's own are taken.)
  const take = (stored) => { for (const key of Object.keys(settings)) if (key in stored) settings[key] = stored[key]; };
  const early = globalThis.LegalPinpointerEarlySettingsValue;
  if (early) { take(early); apply(); }
  else (globalThis.LegalPinpointerEarlySettings || new Promise((resolve) => chrome.storage.local.get(settings, resolve)))
    .then((stored) => { take(stored); apply(); });
})();
