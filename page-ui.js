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
    if (control?.lpElement) run(page.copyControl(control.lpElement, control.lpLocator, button.dataset.mode), button);
  });
  actions?.set('citedby', (button) => {
    const control = button.parentElement;
    if (control?.lpElement) run(openCitedBy(control.lpElement), button);
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
    if (!warmed && (event.target.closest?.('[data-lp-ui]') || (numbersOn() && event.target.closest?.(NUMBER)))) warm();
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
  // (the icon itself is not drawn: html.lp-cited-by, content.css), opening CanLII's own Cited by link in a new tab.
  const citedBy = () => provider === 'canlii' && settings.canliiCitedBy && settings.unitCopyButtons;
  function canliiTools(element) {
    return element.closest?.('.paragWrapper')?.querySelector(':scope > .viibes-marker-toolbox [data-bs-toggle="dropdown"]') || null;
  }
  function citedCount(element) {
    const count = Number(canliiTools(element)?.dataset.noteupCount || 0);
    return count > 0 ? count : 0;
  }
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
    const shown = canliiTools(node.lpElement)?.dataset.noteupCountDisplay || String(count);
    button.dataset.count = shown;
    const label = `Cited by ${shown} (CanLII, in a new tab)`;
    button.dataset.tip = label;
    button.setAttribute('aria-label', label);
  }
  // CanLII fills a paragraph's menu with its links when the menu opens; the Cited by link is taken from there, so it
  // is CanLII's own address, whatever form CanLII gives it.
  async function openCitedBy(element) {
    const trigger = canliiTools(element);
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
    let found;
    try { found = providers.quickUnits(document, location); } catch (_) { return; }
    const units = [], seen = new Set(), cited = citedBy();
    for (const unit of found) {
      if (!unit.element?.isConnected || seen.has(unit.element)) continue; // two units on one element: the first keeps it
      seen.add(unit.element);
      units.push({ ...unit, cited: cited ? citedCount(unit.element) : 0, numbered: numbersOn() && Boolean(numberIn(unit.element)) });
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
      const element = units[i].element;
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
      return !hit || hit === document.documentElement || hit === document.body || hit.closest('[data-lp-ui]')
        || !['fixed', 'sticky'].includes(getComputedStyle(hit.closest('*:not(span):not(a):not(i):not(img)') || hit).position);
    };
    // Controls stay in the margin, never over the text: a margin needs room for one button's width, and a page whose
    // text leaves no such room on either side shows none (the hotkeys still copy).
    let column, side = 'right';
    if (tools.length) column = median(tools.map((tool) => tool.center)) - SIZE / 2;
    else if (colRight + 12 + SIZE <= clipRight && clear(colRight + 12)) column = colRight + 12;
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
  // links every whole number inside it to its paragraph or provision, so a quote carries its links
  // natively. Nothing is written to the page ahead of time: the pointer cursor is static CSS
  // (content.css, under html.lp-numbers), clicks are one capture listener, and links exist only
  // for the moment the browser serializes a copy (added in the copy event, removed right after).
  // Westlaw's numbers are text at the start of the paragraph, found from the caret under the pointer.
  const NUMBER = provider === 'canlii' ? '.lp-num, a.reflex-paragAnchor[name]:not(.lp-num *), .SectionNumber, .canlii_section_with_subsection'
    : provider === 'lexis' ? '[id^="PARA_"]' : '.lp-num';

  // Westlaw writes a paragraph's number as the first text of the paragraph: it is wrapped once in a
  // span of its own (in idle time, a few hundred paragraphs at a time, before the page's model is
  // read), so it can be drawn and clicked like the other providers' numbers. Text and layout are
  // unchanged.
  function wrapCanliiNumbers() {
    const anchors = [...document.querySelectorAll('a.reflex-paragAnchor[name]:not(.lp-num *)')];
    const step = (deadline) => {
      while (anchors.length && (!deadline || deadline.timeRemaining() > 2)) {
        const anchor = anchors.shift(), before = anchor.previousSibling, after = anchor.nextSibling;
        if (before?.nodeType !== 3 || after?.nodeType !== 3 || !/\[\s*$/.test(before.data) || !/^\s*\]/.test(after.data)) continue;
        const open = before.splitText(before.data.lastIndexOf('['));
        after.splitText(after.data.indexOf(']') + 1);
        const span = document.createElement('span');
        span.className = 'lp-num';
        anchor.before(span);
        span.append(open, anchor, after);
      }
      if (anchors.length) idle(step, 200);
      else fullModel = null;
    };
    step(null);
  }

  function wrapWestlawNumbers() {
    if (provider === 'canlii' && numbersOn()) return wrapCanliiNumbers();
    if (provider !== 'westlaw' || !numbersOn()) return;
    const paragraphs = [...document.querySelectorAll('.crsw_labeledParagraph .co_paragraphText:not([data-lp-num])')];
    const step = (deadline) => {
      while (paragraphs.length && (!deadline || deadline.timeRemaining() > 2)) {
        const text = paragraphs.shift();
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
      if (paragraphs.length) idle(step, 200);
      else fullModel = null; // the page model is read again with the numbers in place
    };
    step(null);
  }
  const numbersOn = () => settings.unitCopyButtons && settings.unitCopyStyle !== 'buttons';
  /** A unit's clickable number: in its element, or (a statute's section number) in its block. */
  function numberIn(element) {
    if (!element) return null;
    if (element.matches?.(NUMBER)) return element;
    return element.querySelector?.(NUMBER) || element.closest?.('p, li, div')?.querySelector(NUMBER) || null;
  }
  const cleanHere = () => `${location.origin}${location.pathname}`;

  function numberAt(event) {
    return numbersOn() ? event.target.closest?.(NUMBER) || null : null;
  }
  /** The element the page's model knows the unit by: a statute's section number comes before its anchor. */
  function numberTarget(number) {
    if (number.classList.contains('SectionNumber')) {
      const block = number.closest('p, div, li') || number.parentElement;
      const label = number.textContent.replace(/\s+/g, '');
      return block.querySelector(`a[name="sec${CSS.escape(label)}"]`) || block.querySelector('a[name^="sec"]') || number;
    }
    return number;
  }

  /** The unit a number stands for (a section number that opens with its first subsection is that subsection). */
  const unitFor = (model, number) => page.unitAt(model, numberTarget(number));

  document.addEventListener('click', (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const number = numberAt(event);
    // A click that ends a selection is the selection's.
    if (!number || !getSelection().isCollapsed) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    run(page.model(false).then((model) => {
      fullModel = model;
      const node = unitFor(model, number);
      if (!node) throw new Error('This passage is no longer on the page.');
      return page.copyUnit(model, node, 'pinpoint');
    }).then(() => {
      number.classList.add('lp-number-done');
      setTimeout(() => number.classList.remove('lp-number-done'), 900);
    }), null);
  }, true);

  // Where a number links: its unit's pinpoint target from the page's model; on CanLII, before the
  // model is built, the document's own anchor.
  function numberUrl(number) {
    const target = numberTarget(number);
    if (fullModel && page.current(fullModel)) {
      const node = unitFor(fullModel, number);
      if (node) { try { return page.linkFor(fullModel, node); } catch (_) { /* fall through */ } }
    }
    if (provider !== 'canlii') return '';
    if (target.classList?.contains('lp-num') && target.querySelector('a[name]')) return `${cleanHere()}#${encodeURIComponent(target.querySelector('a[name]').getAttribute('name'))}`;
    const section = target.getAttribute?.('section'), subsection = target.getAttribute?.('subsection');
    const own = section && subsection && subsection !== 'null' ? `sec${section}subsec${subsection}` : '';
    const anchor = (own && document.getElementsByName(own).length ? own : '') || target.getAttribute?.('name')
      || target.previousElementSibling?.getAttribute?.('name') || '';
    return anchor ? `${cleanHere()}#${encodeURIComponent(anchor)}` : '';
  }

  const LINKABLE = NUMBER;
  document.addEventListener('copy', (event) => {
    if (globalThis.LegalPinpointerWritingClipboard) return;
    const selection = getSelection();
    if (selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    // Statute text: its provisions as indented paragraphs, as the quote copy writes them (content.js).
    const statute = fullModel && page.current(fullModel) ? page.statuteCopy?.(fullModel, range) : null;
    if (statute) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.clipboardData.setData('text/plain', statute.plain);
      event.clipboardData.setData('text/html', statute.html);
      return;
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
      if (number.closest('a[href]') || number.querySelector('a[href]')) continue;
      const url = numberUrl(number);
      if (url) links.push([number, url]);
      if (links.length >= 5000) break;
    }
    const undo = links.map(([number, url]) => {
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
    });
    // The numbers' button look is the page's, not the text's: off while the browser copies the
    // selection's styles, so a paste shows the numbers as the page's own text (linked).
    document.documentElement.classList.remove('lp-numbers');
    undo.push(() => document.documentElement.classList.toggle('lp-numbers', numbersOn()));
    // The browser serializes the selection after this event; the page is back as it was before it paints.
    setTimeout(() => { for (const restore of undo) restore(); }, 0);
  }, true);

  // One tooltip for every control, shown after a short hover.
  let tip = null, tipTimer = 0;
  function hideTip() {
    clearTimeout(tipTimer);
    if (tip) tip.hidden = true;
  }
  document.addEventListener('pointerover', (event) => {
    const number = numbersOn() ? event.target.closest?.(NUMBER) : null;
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
          if (node.nodeType !== 1 || node.hasAttribute('data-lp-ui') || !(node.matches(ANCHORS) || node.querySelector(ANCHORS))) continue;
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
    a[hidden] { display: none; }
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
    element.innerHTML = '<a class="pending" data-lp-action="canlii" aria-label="CanLII" title="Looking for a CanLII version"></a><span class="cite"></span>'
      + `<button type="button" data-lp-action="citation" aria-label="Copy the linked citation" title="Copy the linked citation (Alt+X)">${LINK_ICON}<span></span></button>`;
    shadow.appendChild(element);
    document.documentElement.appendChild(host);
    bar = { host, element, canlii: element.firstChild, cite: element.children[1] };
    return bar;
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
    document.documentElement.classList.toggle('lp-numbers', numbersOn());
    if (settings.unitCopyButtons) {
      // A changed style redraws every control from its own template.
      if (view.style !== settings.unitCopyStyle) { removeUnits(); view.style = settings.unitCopyStyle; }
      wrapWestlawNumbers();
      queueSync();
      watchUnits();
    } else removeUnits();
    if (provider === 'canlii') {
      document.documentElement.classList.toggle('lp-no-canlii-name', !settings.canliiHeader);
      document.documentElement.classList.toggle('lp-cited-by', citedBy());
      if (settings.canliiHeader) mountCrumb(); else unmountCrumb();
    } else {
      document.documentElement.classList.toggle('lp-raw-titles', !settings.cleanTitles);
      tameTitle();
      if (settings.cleanTitles || settings.canliiButton || settings.caseMarker || settings.providerHeader) mountTools(); else unmountTools();
      if (!settings.canliiButton) unmountFloating();
      if (!settings.providerHeader) unmountBar();
      // The bar is there at once with the title; the citation replaces it when the model is in.
      else if (tools && !bar) { mountBar(); bar.cite.textContent = titleText(); bar.canlii.hidden = !settings.canliiButton; barVisibility(); }
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
  const early = globalThis.LegalPinpointerEarlySettingsValue;
  if (early) { Object.assign(settings, early); apply(); }
  else (globalThis.LegalPinpointerEarlySettings || new Promise((resolve) => chrome.storage.local.get(settings, resolve)))
    .then((stored) => { Object.assign(settings, stored); apply(); });
})();
