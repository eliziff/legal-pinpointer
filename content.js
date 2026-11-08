'use strict';

(function startContentScript() {
  if (globalThis.LegalPinpointerLensBridge) return;
  const core = globalThis.LegalPinpointerCore;
  const fragments = globalThis.LegalPinpointerTextFragments;
  const providers = globalThis.LegalPinpointerProviders;
  let lastHoverTarget = null;
  const modelCache = new Map();
  const modelStamps = new WeakMap();
  const modelLookups = new WeakMap();
  let modelObserver = null, documentRevision = 0;
  let lastPointer = null;
  let rememberedFragment = null;
  let toastTimer = 0;
  const MAX_CLIPBOARD_TEXT_LENGTH = 1_000_000;
  const COPY_MODES = new Set(['pinpoint', 'quote', 'citation']);
  const QUOTE_INLINE = new Map([
      ['B', 'strong'], ['STRONG', 'strong'], ['I', 'em'], ['EM', 'em'],
      ['U', 'u'], ['S', 's'], ['STRIKE', 's'], ['SUB', 'sub'], ['SUP', 'sup'],
      ['Q', 'q'], ['CODE', 'code']
    ]);
  const QUOTE_SKIP = 'script, style, noscript, template, [hidden], [aria-hidden="true"], [data-lp-ui], '
    + '[style*="display: none"], [style*="display:none"], [role="menu"], .a11yDropdown';
  const QUOTE_BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DT', 'FIGCAPTION', 'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'P', 'PRE', 'SECTION', 'TD', 'TH', 'TR']);

  document.addEventListener('pointerover', (event) => {
    const target = event.target instanceof Element ? event.target : event.target.parentElement;
    // The copy bar and title card are Pinpointer's own: hovering them keeps the passage.
    if (target && !target.closest('[data-lp-ui]')) lastHoverTarget = target;
  }, true);
  document.addEventListener('pointermove', (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };
  }, { capture: true, passive: true });

  // Settings are read once and kept current, so no copy waits on a storage round trip.
  const SETTINGS = {
    pinpointStyle: 'full', linkFullTextFragmentPinpoint: false, buildTextFragmentWithoutStructure: false, copyShortcuts: true,
    statuteCopyIndent: true, secondaryTitleDepth: 'last'
  };
  // providers.js reads the secondary-source title setting from here.
  globalThis.LegalPinpointerSettings = SETTINGS;
  // early.js has normally read them already (one read for every script on the page).
  const settingsReady = (globalThis.LegalPinpointerEarlySettings || new Promise((resolve) => chrome.storage.local.get(SETTINGS, resolve)))
    .then((stored) => {
      for (const key of Object.keys(SETTINGS)) if (key in stored) SETTINGS[key] = stored[key];
      return SETTINGS;
    });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const key of Object.keys(SETTINGS)) if (changes[key]) SETTINGS[key] = changes[key].newValue ?? SETTINGS[key];
  });
  function storageGet() {
    return settingsReady;
  }

  function ownOverlay(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(element?.closest('#legal-pinpointer-status, [data-pinpointer-sonar], [data-lp-ui]'));
  }

  // Document identity and structure live in the document root, <head> and the provider's title
  // block. Toolbars, tooltips, menus and panels elsewhere (Lexis redraws headings in its side panels
  // all the time) change constantly and must not force a re-parse.
  const IDENTITY = 'title, meta, #co_docHeader, #citeInfo, .co_cites, #titleInfo, .crsw_prelim, .SS_DocumentHeader, '
    + '#SS_DocumentTitle, .documentheadertitle, #title-container, h1.main-title, .documentMeta, #metas-container';
  const modelRoots = new Set(), invalidationListeners = new Set();
  function affectsModel(node) {
    if (!node || ownOverlay(node)) return false;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element || !element.isConnected || !modelRoots.size || element.closest('head')) return true;
    for (const root of modelRoots) if (!root.isConnected || root.contains(element) || element.contains(root)) return true;
    return Boolean(element.closest(IDENTITY) || (node.nodeType === Node.ELEMENT_NODE && (element.matches(IDENTITY) || element.querySelector?.(IDENTITY))));
  }
  function invalidateModels(records) {
    if (!modelCache.size || !records.some((record) => record.type === 'childList'
      ? affectsModel(record.target) && [...record.addedNodes, ...record.removedNodes].some((node) => !ownOverlay(node) && (node.nodeType !== Node.TEXT_NODE || node.data.trim()))
      : affectsModel(record.target))) return;
    documentRevision += 1;
    modelCache.clear();
    modelRoots.clear();
    for (const listener of invalidationListeners) listener();
  }

  function flushModels() {
    if (!modelObserver) {
      modelObserver = new MutationObserver(invalidateModels);
      // Arm only on first use, and invalidate cheaply; never parse in the observer.
      // Headers and metadata outside the document root affect citation identity too.
      modelObserver.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['id', 'name', 'content', 'href', 'hidden', 'aria-hidden',
          'lang', 'data-document-type', 'data-section-number', 'data-rule-number', 'data-article-number']
      });
    }
    invalidateModels(modelObserver.takeRecords());
  }

  function assertCurrentModel(model) {
    flushModels();
    const stamp = modelStamps.get(model);
    if (!stamp || stamp.revision !== documentRevision || stamp.url !== window.location.href || !model.root.isConnected) {
      throw new Error('The document changed during this operation. Please try again.');
    }
  }

  // Metadata (the citation, the CanLII link) is read again if the page changes while it is being
  // read, and after three tries is used as read: a busy page must not make Alt+X fail.
  async function inspectPage(metadataOnly = false) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await inspectOnce(metadataOnly, metadataOnly && attempt >= 3);
      } catch (error) {
        if (!metadataOnly || !error.documentChanged || attempt >= 3) throw error;
      }
    }
  }

  async function inspectOnce(metadataOnly, acceptChanged) {
    flushModels();
    const url = window.location.href, revision = documentRevision;
    const level = metadataOnly ? 'metadata' : 'structure';
    let entry = modelCache.get(level);
    if (!entry || entry.url !== url || entry.revision !== revision) {
      entry = { url, revision, promise: providers.inspect(document, window.location, undefined, { metadataOnly }).then(withCanliiAnchors) };
      modelCache.set(level, entry);
    }
    try {
      const model = await entry.promise;
      if (!model?.citation?.plain || !model.root?.isConnected) {
        throw new Error('This page does not expose a supported legal document.');
      }
      flushModels();
      if (url !== window.location.href || (revision !== documentRevision && !acceptChanged)) {
        throw Object.assign(new Error('The document changed during this operation. Please try again.'), { documentChanged: true });
      }
      modelStamps.set(model, { revision: documentRevision, url });
      modelRoots.add(model.root);
      return model;
    } catch (error) {
      if (modelCache.get(level) === entry) modelCache.delete(level);
      throw error;
    }
  }

  window.addEventListener('pagehide', () => {
    modelObserver?.disconnect(); modelObserver = null;
    documentRevision += 1; modelCache.clear(); rememberedFragment = null; lastHoverTarget = null;
    clearTimeout(toastTimer);
  });

  function modelLookup(model) {
    const nodes = model.structure.nodes;
    let cached = modelLookups.get(model);
    if (cached?.nodes === nodes && cached.count === nodes.length) return cached;
    const positions = new Map(), anchors = new Map();
    nodes.forEach((node, index) => {
      if (!positions.has(node)) positions.set(node, index);
      const locator = core.parseLocator(node.locator);
      if (node.anchor && locator && !anchors.has(locator.raw)) anchors.set(locator.raw, node);
    });
    cached = { nodes, count: nodes.length, positions, anchors };
    modelLookups.set(model, cached);
    return cached;
  }

  function editableTarget(target) {
    const element = target instanceof Element ? target : target && target.parentElement;
    return Boolean(element && (
      element.matches('input, textarea, select')
      || element.isContentEditable
      || element.closest('[contenteditable]:not([contenteditable="false"])')
    ));
  }

  function nodeBoundary(node, start) {
    const point = start ? node.startPoint : node.endPoint;
    const range = document.createRange();
    if (point && point.node && point.node.isConnected) {
      range.setStart(point.node, point.offset);
      range.collapse(true);
      return range;
    }
    if (!node.element || !node.element.isConnected) return null;
    range.selectNode(node.element);
    range.collapse(start);
    return range;
  }

  function pointIndex(nodes, container, offset, includeEqual) {
    const owner = container.ownerDocument || container;
    const point = owner.createRange();
    point.setStart(container, offset);
    point.collapse(true);
    const containerElement = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    let found = -1;

    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node.element && containerElement && (node.element === containerElement || node.element.contains(containerElement))) {
        found = index;
        continue;
      }
      const marker = nodeBoundary(node, true);
      if (!marker) continue;
      const comparison = marker.compareBoundaryPoints(Range.START_TO_START, point);
      if (comparison < 0 || (includeEqual && comparison === 0)) found = index;
      else break;
    }
    return found;
  }

  function rangeIntersects(range, node) {
    try {
      return range.intersectsNode(node);
    } catch (_) {
      return false;
    }
  }

  // A unit starts at its marker, or earlier where the previous unit's derived range ends before it:
  // the gap is the marginal note or heading introducing this unit.
  function nodeUnitStart(model, node) {
    const start = nodeBoundary(node, true);
    const previous = model.structure.nodes[modelLookup(model).positions.get(node) - 1];
    const previousEnd = previous && previous.endPoint && previous.endPoint.node && previous.endPoint.node.isConnected
      ? nodeBoundary(previous, false)
      : null;
    return start && previousEnd && previousEnd.compareBoundaryPoints(Range.START_TO_START, start) < 0 ? previousEnd : start;
  }

  // A unit runs to the next marker, so a block quote or unnumbered continuation belongs to the
  // paragraph that introduces it (on CanLII, Federal Court block quotes sit outside the <p>).
  function nodeUnitEnd(model, node) {
    const index = modelLookup(model).positions.get(node);
    const next = model.structure.nodes[index + 1];
    if (next) return nodeUnitStart(model, next);
    if (node.endPoint && node.endPoint.node && node.endPoint.node.isConnected) {
      return nodeBoundary(node, false);
    }
    return rootEnd(model.root);
  }

  function intersectNodeUnit(model, range, node) {
    const start = nodeUnitStart(model, node);
    const end = nodeUnitEnd(model, node);
    if (!start || !end) return null;
    try {
      if (start.comparePoint(range.endContainer, range.endOffset) <= 0
          || end.comparePoint(range.startContainer, range.startOffset) >= 0) return null;
      const piece = range.cloneRange();
      if (start.comparePoint(piece.startContainer, piece.startOffset) < 0) {
        piece.setStart(start.startContainer, start.startOffset);
      }
      if (end.comparePoint(piece.endContainer, piece.endOffset) > 0) {
        piece.setEnd(end.startContainer, end.startOffset);
      }
      return piece.collapsed ? null : piece;
    } catch (_) {
      return null;
    }
  }

  function nodesForRange(model, range, preserveProvisionAncestors) {
    if (!model.structure || !range || range.collapsed || !rangeIntersects(range, model.root)) return [];
    let nodes = model.structure.nodes.filter((node) => {
      const piece = intersectNodeUnit(model, range, node);
      return Boolean(piece && normalizeQuoteText(piece.toString()));
    });
    if (!preserveProvisionAncestors && ['section', 'rule', 'article', 'silcrow'].includes(model.structure.kind)) {
      nodes = core.removeRedundantProvisionAncestors(core.collapseCompleteProvisions(nodes, model.structure.nodes));
    }
    return nodes;
  }

  function liveSelectionRange() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    return selection.getRangeAt(0).cloneRange();
  }

  function nodeForTarget(model, target) {
    if (!target || !target.isConnected || !model.root.contains(target)) return null;
    const nodes = model.structure.nodes;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      if (node.element === target || node.element.contains(target)) return node;
    }

    const parent = target.parentNode;
    if (!parent) return null;
    const offset = Array.prototype.indexOf.call(parent.childNodes, target);
    const index = pointIndex(nodes, parent, Math.max(offset, 0), true);
    return index >= 0 ? nodes[index] : null;
  }

  async function clipboardFragment(model) {
    let clipboardText = '';
    try {
      clipboardText = await navigator.clipboard.readText();
    } catch (_) {
      return null;
    }
    if (clipboardText.length > MAX_CLIPBOARD_TEXT_LENGTH) {
      rememberedFragment = null;
      return null;
    }
    let url = fragments.extractUrl(clipboardText);
    if (!url && rememberedFragment
        && clipboardText.replace(/\r\n/g, '\n') === rememberedFragment.outputPlain.replace(/\r\n/g, '\n')) {
      url = rememberedFragment.url;
    }
    if (!url || !fragments.isForDocument(url, model.documentUrls || [model.cleanUrl])) {
      rememberedFragment = null;
      return null;
    }
    const resolved = fragments.resolveUrl(url, model.root);
    if (!resolved) throw new Error('The clipboard text fragment belongs to this page but its range could not be resolved.');
    return { kind: 'text-fragment', range: resolved.range, url: resolved.url };
  }

  async function copySource(model, mode) {
    const fragment = await clipboardFragment(model);
    if (fragment) return fragment;

    const range = liveSelectionRange();
    if (range) return { kind: 'selection', range, url: '' };
    if (mode === 'quote') throw new Error('Select text or copy a current-page text-fragment link first.');

    const node = nodeForTarget(model, lastHoverTarget);
    if (!node) throw new Error('Hover over a numbered passage, select a range, or copy a text-fragment link first.');
    return { kind: 'hover', node, url: '' };
  }

  function uniqueLocatorNodes(nodes) {
    const seen = new Set();
    return nodes.filter((node) => {
      if (seen.has(node.locator)) return false;
      seen.add(node.locator);
      return true;
    });
  }

  // The units' anchors on the document's CanLII page, read once with its structure.
  async function withCanliiAnchors(model) {
    if (!model?.structure?.nodes?.length || !model.canliiUrl || model.provider === 'canlii'
      || !['case', 'legislation'].includes(model.documentType)) return model;
    const locators = [...new Set(model.structure.nodes.map(node => node.locator))];
    const anchors = await core.canliiAnchors(model.canliiUrl, model.structure.kind, locators);
    model.canliiAnchors = new Map(locators.map((locator, index) => [locator, anchors[index]]));
    return model;
  }

  function nativeCanliiTarget(model, node) {
    const anchor = model.canliiAnchors?.get(node.locator);
    return anchor ? core.withFragment(model.canliiUrl, `#${anchor}`) : '';
  }

  function targetForNode(model, sourceInfo, node) {
    if (sourceInfo.kind === 'text-fragment') return sourceInfo.url;

    if (model.provider !== 'canlii') {
      const canlii = nativeCanliiTarget(model, node);
      if (canlii) return canlii;
    }

    const anchors = node.anchor ? null : modelLookup(model).anchors;
    const anchoredNode = node.anchor ? node : core.provisionAncestors(node.locator).reverse()
      .map(locator => anchors.get(locator)).find(Boolean);
    const nativeFragment = anchoredNode && anchoredNode.anchor ? `#${encodeURIComponent(anchoredNode.anchor)}` : '';
    return core.withFragment(model.cleanUrl, nativeFragment || '');
  }

  function anchorHtml(label, url) {
    const target = new URL(url);
    if (target.protocol !== 'https:') throw new Error('Legal Pinpointer refused a non-HTTPS copy target.');
    return `<a href="${core.escapeHtml(target.href)}">${core.escapeHtml(label)}</a>`;
  }

  async function pinpointMarkup(model, sourceInfo, inputNodes, style, linkFullTextFragmentPinpoint) {
    const nodes = uniqueLocatorNodes(inputNodes);
    const [{ plain, prefix, locators, groups }] = await core.pinpointLayouts(
      model.structure.kind, [nodes.map((node) => node.locator)], style);
    assertCurrentModel(model);
    if (sourceInfo.kind === 'text-fragment') {
      return {
        plain,
        html: linkFullTextFragmentPinpoint
          ? anchorHtml(plain, sourceInfo.url)
          : `${core.escapeHtml(prefix)}${anchorHtml(locators, sourceInfo.url)}`
      };
    }
    const pieces = groups.map((group) => {
      const first = anchorHtml(group.firstDisplay, targetForNode(model, sourceInfo, nodes[group.start]));
      if (group.end === group.start) return first;
      const last = anchorHtml(group.lastDisplay, targetForNode(model, sourceInfo, nodes[group.end]));
      return `${first}-${last}`;
    });
    return {
      plain,
      html: `${core.escapeHtml(prefix)}${pieces.join(', ')}`
    };
  }

  function collapsedBoundary(range, start) {
    const boundary = range.cloneRange();
    boundary.collapse(start);
    return boundary;
  }

  function boundaryFromPoint(point) {
    if (!point || !point.node || !point.node.isConnected) return null;
    const boundary = document.createRange();
    boundary.setStart(point.node, point.offset);
    boundary.collapse(true);
    return boundary;
  }

  function rootEnd(root) {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    return range;
  }

  function textBetween(start, end) {
    if (!start || !end || start.compareBoundaryPoints(Range.START_TO_START, end) > 0) return '';
    try {
      const range = document.createRange();
      range.setStart(start.startContainer, start.startOffset);
      range.setEnd(end.startContainer, end.startOffset);
      return range.toString();
    } catch (_) {
      return '';
    }
  }

  // How a unit's selected text relates to its own marker: `strip` is the part of the marker the
  // selection still contains (the quote supplies a clean marker instead), and `omitted` means real
  // text precedes the selection. A selection starting inside the marker ("3]" of "[3]") omits nothing.
  function leadingMarkerState(model, range, node) {
    const selectionStart = collapsedBoundary(range, true);
    const contentStart = boundaryFromPoint(node.contentStartPoint);
    if (contentStart) {
      if (selectionStart.compareBoundaryPoints(Range.START_TO_START, contentStart) <= 0) {
        return { omitted: false, strip: textBetween(selectionStart, contentStart).length };
      }
      return { omitted: Boolean(normalizeQuoteText(textBetween(contentStart, selectionStart))), strip: 0 };
    }
    const structureStart = nodeBoundary(node, true);
    const before = textBetween(structureStart, selectionStart);
    const marker = textBetween(structureStart, nodeUnitEnd(model, node))
      .match(leadingMarkerPattern(model.structure.kind, node.locator));
    const markerLength = marker ? marker[0].length : 0;
    if (before.length < markerLength) return { omitted: false, strip: markerLength - before.length };
    return { omitted: Boolean(normalizeQuoteText(before.slice(markerLength))), strip: 0 };
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function leadingMarkerPattern(kind, locator) {
    const value = escapeRegex(locator);
    const parsed = core.parseLocator(locator);
    const local = parsed && parsed.suffixes.length
      ? escapeRegex(`(${parsed.suffixes[parsed.suffixes.length - 1]})`)
      : value;
    const provisionValue = local === value ? value : `(?:${value}|${local})`;
    // "[page 31]", or CanLII's centred "page 31" on a line of its own.
    if (kind === 'page') return new RegExp(`^\\s*(?:\\[page\\s+${value}\\]|page\\s+${value}(?=[ \\t]*\\n))\\s*`, 'i');
    if (kind === 'section' || kind === 'silcrow') return new RegExp(`^\\s*(?:(?:s(?:ection)?|§)\\.?\\s*)?${provisionValue}[.:]?\\s+`, 'i');
    if (kind === 'rule') return new RegExp(`^\\s*(?:r(?:ule)?\\.?\\s*)?${provisionValue}[.:]?\\s+`, 'i');
    if (kind === 'article') return new RegExp(`^\\s*(?:art(?:icle)?\\.?\\s*)?${provisionValue}[.:]?\\s+`, 'i');
    return new RegExp(`^\\s*(?:\\[\\s*${value}\\s*\\]|¶?\\s*${value}[.)]?)\\s+`, 'i');
  }

  function stripLeadingCharacters(fragment, count) {
    if (!count) return;
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    let remaining = count;
    let node = walker.nextNode();
    while (node && remaining > 0) {
      if (node.nodeValue.length <= remaining) {
        remaining -= node.nodeValue.length;
        node.nodeValue = '';
      } else {
        node.nodeValue = node.nodeValue.slice(remaining);
        remaining = 0;
      }
      node = walker.nextNode();
    }
  }

  function renderSelectionFragment(fragment) {


    function render(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue.replace(/\s+/g, ' ');
        return { plain: text, html: core.escapeHtml(text) };
      }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
        return { plain: '', html: '' };
      }
      // A cloned fragment has no computed style, so hidden provider chrome is recognised by its
      // markup: Westlaw's "View Options / Add To Folder / Add To Outline" menu after every link.
      if (node.nodeType === Node.ELEMENT_NODE && (
        node.matches(QUOTE_SKIP)
      )) return { plain: '', html: '' };
      // A unit's quote is one run of text: line breaks and nested blocks inside it
      // (converted PDFs, wrapper divs) separate words, never lines, when pasted.
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') return { plain: ' ', html: ' ' };
      const children = Array.from(node.childNodes).map(render);
      let plain = children.map((child) => child.plain).join('');
      let html = children.map((child) => child.html).join('');
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return { plain, html };
      const tag = QUOTE_INLINE.get(node.tagName);
      if (tag) html = `<${tag}>${html}</${tag}>`;
      if (QUOTE_BLOCK.has(node.tagName) && (plain || html)) {
        plain = ` ${plain} `;
        html = ` ${html} `;
      }
      return { plain, html };
    }

    const rendered = render(fragment);
    return {
      plain: normalizeQuoteText(rendered.plain).replace(/\n/g, ' '),
      html: rendered.html.replace(/\s+/g, ' ').trim()
    };
  }

  function normalizeQuoteText(value) {
    return String(value || '')
      .replace(/[\u00a0\u2007\u202f]/g, ' ')
      .replace(/[\t ]+/g, ' ')
      .replace(/ *\r?\n */g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  function quoteContent(range, strip) {
    const fragment = range.cloneContents();
    stripLeadingCharacters(fragment, Math.min(strip, (fragment.textContent || '').length));
    return renderSelectionFragment(fragment);
  }

  function quoteMarker(kind, node) {
    if (kind === 'page') return `[page ${node.locator}]`;
    if (kind === 'paragraph') return `[${node.locator}]`;
    if (kind === 'pilcrow') return `\u00b6 ${node.locator}`;
    if (kind === 'silcrow') return `\u00a7 ${node.locator}`;
    const literal = normalizeQuoteText(node.markerText || '');
    if (literal && literal.length <= 120) return literal;
    const parsed = core.parseLocator(node.locator);
    return parsed && parsed.suffixes.length
      ? `(${parsed.suffixes[parsed.suffixes.length - 1]})`
      : node.locator;
  }

  // How deep a provision sits, as the page draws it: a subsection ("(1)", "(1.1)") stands at its
  // section's level ("3(1)" and "(2)" line up), and each paragraph, subparagraph and clause below it
  // ("(a)", "(i)", "(A)") one level further in.
  function provisionLevel(locator) {
    const parsed = core.parseLocator(locator);
    return parsed ? parsed.suffixes.filter((suffix) => !/^\d+(?:\.\d+)*$/.test(suffix)).length : 0;
  }

  function quoteMarkup(model, sourceInfo, range, nodes) {
    const provision = ['section', 'rule', 'article', 'silcrow'].includes(model.structure.kind);
    const indented = provision && SETTINGS.statuteCopyIndent;
    // Levels relative to the shallowest quoted unit: a lone (b)(i) is flush, its children nest.
    const levels = nodes.map((node) => (provision ? provisionLevel(node.locator) : 0));
    const baseLevel = provision ? Math.min(...levels) : 0;
    const pieces = nodes.map((node, index) => {
      const unitRange = intersectNodeUnit(model, range, node);
      if (!unitRange) return null;
      const markerState = leadingMarkerState(model, unitRange, node);
      const leading = index === 0 && markerState.omitted;
      const content = quoteContent(unitRange, markerState.strip);
      const marker = quoteMarker(model.structure.kind, node);
      const depth = levels[index] - baseLevel;
      const lead = leading ? ' …' : '';
      const bodyPlain = content.plain ? ` ${content.plain}` : '';
      const bodyHtml = content.html ? ` ${content.html}` : '';
      // A section whose anchor sits on its first subsection holds no text of its own: that
      // subsection's number ("45 (1)") already carries it.
      if (indented && !content.plain.trim() && !leading && index + 1 < nodes.length) return null;
      return {
        marker, depth, leading, lead, bodyPlain, bodyHtml,
        markerHtml: anchorHtml(marker, targetForNode(model, sourceInfo, node))
      };
    }).filter(Boolean);

    if (indented) {
      // One column for the whole quote, wide enough for its widest number ("45 (1)"), so every level
      // steps in by the same amount and a child's number stands exactly under its parent's text, as
      // on the page. Each provision is a paragraph with a hanging indent: its number in the column, a
      // tab, then the text, wrapped lines kept at the text. Word keeps an indent only in a paragraph's
      // mark, so this copy ends its paste on a new line; the tab lines the text up in Word.
      const width = (label) => Array.from(label).reduce((sum, ch) => sum + (/[\s]/.test(ch) ? 0.28 : /[().,]/.test(ch) ? 0.33 : 0.56), 0);
      const column = Math.min(5, Math.max(2.5, Math.ceil((Math.max(...pieces.map((piece) => width(piece.marker))) + 0.9) * 4) / 4));
      return {
        plain: pieces.map((piece) => `${'\t'.repeat(piece.depth)}${piece.marker}\t${piece.lead.trimStart()}${piece.bodyPlain.trimStart()}`).join('\n'),
        html: pieces.map((piece) => {
          const text = `${piece.lead.trimStart()}${piece.leading && piece.bodyHtml ? ' ' : ''}${piece.bodyHtml.trimStart()}`;
          return `<p style="${quoteIndent(piece.depth + 1, column, true)}">${piece.markerHtml}<span style="mso-tab-count:1">\t</span>${text}</p>`;
        }).join('')
      };
    }
    // Setting off (statuteCopyIndent), and every other kind of document: the inline form, which adds
    // no break of its own.
    return {
      plain: pieces.map((piece) => `${'\t'.repeat(piece.depth)}${piece.marker}${piece.lead}${piece.bodyPlain}`).join('\n'),
      html: pieces.map((piece) => {
        if (!provision) return `${piece.markerHtml}${piece.lead}${piece.bodyHtml}`;
        const markerColumn = Math.max(2, Math.ceil((Array.from(piece.marker).length + 1) * 5) / 10);
        const text = `${piece.lead.trimStart()}${piece.leading && piece.bodyHtml ? ' ' : ''}${piece.bodyHtml.trimStart()}`;
        return `<span style="display:inline-block;margin:0 0 0 ${piece.depth * 2 + markerColumn}em;text-indent:-${markerColumn}em"><span style="display:inline-block;width:${markerColumn}em;text-indent:0">${piece.markerHtml}&nbsp;</span>${text}</span>`;
      }).join('<br>')
    };
  }

  // A copy event, never the async clipboard first: Chrome's async write wraps the HTML in a document
  // of its own, and Word pastes that as a paragraph of its own (a line break after every paste).
  // The engine host's copy event first, which no page script can reach (Lexis and Westlaw intercept
  // copy events on their pages); then a copy event here; the async clipboard only as a last resort.
  // Writes through a copy event, at once; true when the browser took it (needs a click or key press).
  function clipboardWriteNow(payload) {
    let copied = false;
    const onCopy = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.clipboardData.setData('text/plain', payload.plain);
      event.clipboardData.setData('text/html', payload.html);
      copied = true;
    };
    document.addEventListener('copy', onCopy, { once: true, capture: true });
    globalThis.LegalPinpointerWritingClipboard = true;
    let executed = false;
    try { executed = document.execCommand('copy'); }
    finally { document.removeEventListener('copy', onCopy, true); globalThis.LegalPinpointerWritingClipboard = false; }
    return executed && copied;
  }

  async function clipboardWrite(payload) {
    if (navigator.userActivation?.isActive && clipboardWriteNow(payload)) return;
    const hosted = await chrome.runtime.sendMessage({ type: 'LEGAL_PINPOINTER_CLIPBOARD', plain: payload.plain, html: payload.html })
      .catch(() => null);
    if (hosted && hosted.ok) return;

    let copied = false;
    const onCopy = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.clipboardData.setData('text/plain', payload.plain);
      event.clipboardData.setData('text/html', payload.html);
      copied = true;
    };
    document.addEventListener('copy', onCopy, { once: true, capture: true });
    let executed;
    // The page UI links numbers only in the reader's own copies, never in this one.
    globalThis.LegalPinpointerWritingClipboard = true;
    try { executed = document.execCommand('copy'); }
    finally { document.removeEventListener('copy', onCopy, true); globalThis.LegalPinpointerWritingClipboard = false; }
    if (executed && copied) return;
    if (navigator.clipboard && typeof navigator.clipboard.write === 'function' && typeof ClipboardItem === 'function') {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([payload.plain], { type: 'text/plain' }),
        'text/html': new Blob([payload.html], { type: 'text/html' })
      })]);
      return;
    }
    throw new Error('The browser denied clipboard access.');
  }

  function showToast(message, error) {
    let toast = document.getElementById('legal-pinpointer-status');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'legal-pinpointer-status';
      toast.className = 'legal-pinpointer-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      toast.setAttribute('aria-atomic', 'true');
      document.documentElement.appendChild(toast);
    }
    toast.classList.toggle('legal-pinpointer-toast--error', Boolean(error));
    toast.textContent = message;
    clearTimeout(toastTimer);
    toast.lpFade?.cancel();
    // Opacity and transform only: the compositor animates it without a layout pass.
    if (toast.hidden) {
      toast.hidden = false;
      toast.animate?.([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 110, easing: 'ease-out' });
    }
    toastTimer = window.setTimeout(() => {
      const fade = toast.lpFade = toast.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-in' });
      if (fade) fade.onfinish = () => { toast.hidden = true; toast.lpFade = null; }; else toast.hidden = true;
    }, error ? 3600 : 2200);
  }

  // The hovered passage: the block (or preformatted paragraph) under the pointer.
  function hoveredPassage(model, index) {
    if (!lastHoverTarget || !lastHoverTarget.isConnected || !model.root.contains(lastHoverTarget)) return null;
    const caret = lastPointer && typeof document.caretPositionFromPoint === 'function'
      ? document.caretPositionFromPoint(lastPointer.x, lastPointer.y)
      : null;
    if (caret && caret.offsetNode && lastHoverTarget.contains(caret.offsetNode)) {
      return fragments.passageRange(caret.offsetNode, caret.offset, index);
    }
    const walker = document.createTreeWalker(lastHoverTarget, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (text.nodeValue.trim()) return fragments.passageRange(text, text.nodeValue.search(/\S/), index);
    }
    return null;
  }

  // Opt-in for documents with no structure: the selected passage (or the hovered paragraph) with a
  // text fragment built and verified against this page. `url` is empty when no link can single the
  // passage out (its opening words recur elsewhere on the page).
  async function builtPassageSource(model) {
    const settings = await storageGet({ buildTextFragmentWithoutStructure: false });
    if (!settings.buildTextFragmentWithoutStructure) return null;
    const index = fragments.buildTextIndex(document.body);
    const range = liveSelectionRange() || hoveredPassage(model, index);
    if (!range || !rangeIntersects(range, model.root)) return null;
    const built = fragments.buildPassageLink(range, { contextRoot: model.root, index });
    return built && built.range
      ? { range: built.range, url: core.withFragment(model.cleanUrl, `#:~:${built.directive}`) }
      : { range, url: '' };
  }

  // A passage (Tab Search result) replaces the selection/hover/clipboard source
  // and returns the payload for the caller to write instead of writing it here.
  async function copy(mode, showFeedback = true, passage = null) {
    if (mode === 'quote' && !passage) {
      const quick = canliiStatuteQuote(liveSelectionRange());
      if (quick) {
        await clipboardWrite(quick);
        rememberedFragment = null;
        const message = `Copied quote from s ${quick.first}${quick.last && quick.last !== quick.first ? `–${quick.last}` : ''}`;
        if (showFeedback) showToast(message, false);
        return { ok: true, message, plain: quick.plain };
      }
    }
    const model = await inspectPage(mode === 'citation');
    let payload;
    let message;
    let fragmentSource = null;

    if (passage && mode === 'link') {
      const target = fragments.urlForRange(passage, model.root, model.cleanUrl);
      payload = { plain: target, html: anchorHtml(target, target) };
      message = 'Copied passage link';
    } else if (mode === 'citation') {
      const target = model.canliiUrl || model.siteUrl || model.cleanUrl;
      payload = core.outputCitationLink(model.citation, target);
      message = `Copied citation: ${model.citation.plain}`;
    } else if (!model.structure || !model.structure.nodes.length) {
      // No structure is not a reason to discard the user's selected quotation.
      // Retain clipboard text-fragment precedence when it resolves on this page.
      const fragment = passage ? null : await clipboardFragment(model);
      assertCurrentModel(model);
      const built = passage || fragment ? null : await builtPassageSource(model);
      assertCurrentModel(model);
      const selected = passage || fragment?.range || built?.range || liveSelectionRange();
      if (selected && !selected.collapsed && !ownOverlay(selected.startContainer)
          && !ownOverlay(selected.endContainer)) {
        const text = renderSelectionFragment(selected.cloneContents());
        if (!text.plain) throw new Error('The selected range contains no copyable text.');
        let target = fragment?.url || built?.url || model.cleanUrl;
        if (passage) try { target = fragments.urlForRange(passage, model.root, model.cleanUrl); } catch (_) { /* page link */ }
        payload = { plain: `[Link]: ${text.plain}`, html: `${anchorHtml('[Link]', target)}: ${text.html}` };
        message = !built ? 'Copied selected text with source link'
          : built.url ? 'Copied passage with its text-fragment link'
            : 'Copied passage with the page link: its opening words recur elsewhere on the page, so no link can single it out';
        fragmentSource = fragment;
      } else {
        const target = model.canliiUrl || model.siteUrl || model.cleanUrl;
        payload = core.outputCitationLink(model.citation, target);
        message = `Copied page: ${model.citation.plain}`;
      }
    } else {
      const sourceInfo = passage ? { kind: 'selection', range: passage, url: '' } : await copySource(model, mode);
      assertCurrentModel(model);
      if (sourceInfo.kind === 'text-fragment') fragmentSource = sourceInfo;
      const nodes = sourceInfo.range ? nodesForRange(model, sourceInfo.range, mode === 'quote') : [sourceInfo.node];
      if (!nodes.length) throw new Error('No page, paragraph, or provision overlaps that range.');
      const settings = await storageGet({ pinpointStyle: 'full', linkFullTextFragmentPinpoint: false });
      assertCurrentModel(model);
      const pinpoint = await pinpointMarkup(
        model,
        sourceInfo,
        nodes,
        settings.pinpointStyle,
        settings.linkFullTextFragmentPinpoint
      );

      if (mode === 'quote') {
        const quote = quoteMarkup(model, sourceInfo, sourceInfo.range, nodes);
        if (!quote.plain) throw new Error('The resolved range contains no copyable text.');
        payload = quote;
        message = `Copied quote from ${pinpoint.plain}`;
      } else {
        payload = pinpoint;
        message = `Copied pinpoint: ${pinpoint.plain}`;
      }
    }

    // A citation is the document's, whatever else on the page changed meanwhile.
    if (mode !== 'citation') assertCurrentModel(model);
    if (passage) return { ok: true, message, payload };
    await clipboardWrite(payload);
    rememberedFragment = fragmentSource
      ? { url: fragmentSource.url, outputPlain: payload.plain }
      : null;
    if (showFeedback) showToast(message, false);
    return { ok: true, message, plain: payload.plain };
  }

  async function inspection(metadataOnly = false) {
    const range = liveSelectionRange();
    const model = await inspectPage(metadataOnly && !range);
    const selected = range ? nodesForRange(model, range) : [];
    const settings = range ? await storageGet({ pinpointStyle: 'full' }) : { pinpointStyle: 'full' };
    assertCurrentModel(model);
    return {
      ok: true,
      provider: model.provider,
      documentType: model.documentType,
      citation: model.citation.plain,
      canliiAvailable: Boolean(model.canliiUrl),
      siteUrl: model.siteUrl || '',
      structureKind: model.structure ? model.structure.kind : '',
      structureSource: model.structure ? model.structure.source : metadataOnly ? 'not-inspected' : 'none',
      structureCount: model.structure ? model.structure.nodes.length : metadataOnly ? null : 0,
      selectedPinpoint: model.structure
        ? await core.formatPinpoint(model.structure.kind, selected.map((node) => node.locator), settings.pinpointStyle)
        : ''
    };
  }

  function lensRange(model, node) {
    const start = nodeBoundary(node, true), end = nodeUnitEnd(model, node);
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.startContainer, start.startOffset);
    range.setEnd(end.startContainer, end.startOffset);
    return range.collapsed ? null : range;
  }

  async function lensCollect() {
    const model = await inspectPage(false);
    assertCurrentModel(model);
    const settings = await storageGet({ pinpointStyle: 'full' });
    const units = [];
    for (let index = 0; index < model.structure.nodes.length; index++) {
      const node = model.structure.nodes[index], range = lensRange(model, node);
      if (!range) continue;
      const text = normalizeQuoteText(range.toString());
      if (text) units.push({index,locator:node.locator,
        kind:model.structure.kind,text,target:targetForNode(model,{kind:'lens'},node)});
    }
    const layouts = await core.pinpointLayouts(model.structure.kind, units.map(unit => [unit.locator]), settings.pinpointStyle);
    units.forEach((unit, index) => { unit.pinpoint = layouts[index].plain; });
    assertCurrentModel(model);
    return {revision:documentRevision,url:location.href,title:document.title,citation:model.citation.plain,
      documentType:model.documentType,provider:model.provider,structureKind:model.structure.kind,units};
  }

  // Preserve normalized UTF-16 offsets through whitespace cleanup. Build this
  // mapping only for a requested selection, not while collecting every paragraph.
  function lensSubrange(range, start, end) {
    const root = range.commonAncestorContainer;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), points = [];
    const append = node => {
      if (!range.intersectsNode(node)) return;
      const lo = node === range.startContainer ? range.startOffset : 0;
      const hi = node === range.endContainer ? range.endOffset : node.length;
      for (let i=lo;i<hi;i++) points.push({text:node.data[i],node,start:i,end:i+1});
    };
    if (root.nodeType === Node.TEXT_NODE) append(root);
    else { let node; while ((node=walker.nextNode())) append(node); }
    let entries=points;
    function collapse(pattern, value) {
      const text=entries.map(x=>x.text).join(''), result=[]; let last=0;
      for (const match of text.matchAll(pattern)) {
        for (let i=last;i<match.index;i++) result.push(entries[i]);
        const first=entries[match.index], final=entries[match.index+match[0].length-1];
        result.push({...first,text:value,endNode:final.endNode||final.node,end:final.end});
        last=match.index+match[0].length;
      }
      for(let i=last;i<entries.length;i++)result.push(entries[i]); entries=result;
    }
    collapse(/[\u00a0\u2007\u202f]/g,' ');
    collapse(/[\t ]+/g,' ');
    collapse(/ *\r?\n */g,'\n');
    collapse(/\n{2,}/g,'\n');
    const text=entries.map(x=>x.text).join(''), leading=text.length-text.trimStart().length;
    entries=entries.slice(leading,text.trimEnd().length);
    if (entries.map(x=>x.text).join('') !== normalizeQuoteText(range.toString())) throw new Error('The source text cannot be mapped safely.');
    if (!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>entries.length) throw new Error('Invalid passage range.');
    const first=entries[start],last=entries[end-1],selected=document.createRange();
    selected.setStart(first.node,first.start); selected.setEnd(last.endNode||last.node,last.end);
    return selected;
  }

  function lensFragment(range, model) {
    return fragments.urlForRange(range, model.root, model.cleanUrl);
  }

  async function lensResolve(handle,index,expected,options={}) {
    const model=await inspectPage(false); assertCurrentModel(model);
    if(handle.url!==location.href||handle.revision!==documentRevision)throw new Error('The source changed. Search again before copying or opening it.');
    const node=model.structure.nodes[index],whole=node&&lensRange(model,node);
    if(!whole||normalizeQuoteText(whole.toString())!==expected)throw new Error('The source changed. Search again before copying or opening it.');
    const start=options.start??0,end=options.end??expected.length;
    const range=start===0&&end===expected.length?whole:lensSubrange(whole,start,end);
    return {model,node,range};
  }

  async function lensPrepare(handle,index,expected,mode,options={}) {
    const {model,node,range}=await lensResolve(handle,index,expected,options);
    const settings=await storageGet({pinpointStyle:'full',linkFullTextFragmentPinpoint:false});
    const useFragment=options.link==='text';
    const target=useFragment?lensFragment(range,model):targetForNode(model,{kind:'lens'},node);
    const sourceInfo=useFragment?{kind:'text-fragment',range,url:target}:{kind:'lens',range};
    const pin=await pinpointMarkup(model,sourceInfo,[node],options.wording||settings.pinpointStyle,settings.linkFullTextFragmentPinpoint);
    let payload;
    if(mode==='link')payload={plain:target,html:anchorHtml(target,target)};
    else if(mode==='citation')payload=core.outputCitationLink(model.citation,model.canliiUrl||model.siteUrl||model.cleanUrl);
    else if(mode==='pinpoint')payload=pin;
    else if(mode==='quote'||mode==='source'){
      const quote=quoteMarkup(model,sourceInfo,range,[node]);
      if(mode==='quote')payload=quote;
      else{const citation=core.outputCitationLink(model.citation,model.canliiUrl||model.siteUrl||model.cleanUrl);
        payload={plain:`${citation.plain} ${pin.plain}\n${quote.plain}`,html:`${citation.html} ${pin.html}<br>${quote.html}`};}
    }else throw new Error('Invalid copy action.');
    assertCurrentModel(model); return payload;
  }

  async function lensOpen(handle,index,expected,start=0,end=expected.length) {
    const {model,node,range}=await lensResolve(handle,index,expected,{start,end});
    if(globalThis.CSS?.highlights){
      if(!document.__lensSheet){const sheet=new CSSStyleSheet();sheet.replaceSync('::highlight(pinpointer-lens){background:#f2df8a;color:inherit}');document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];document.__lensSheet=sheet;}
      CSS.highlights.set('pinpointer-lens',new Highlight(range));
    }
    window.scrollBy({top:range.getBoundingClientRect().top-window.innerHeight*.3,behavior:'instant'});
    return {ok:true,target:targetForNode(model,{kind:'lens'},node)};
  }

  // One unit's pinpoint, quote or link, copied exactly as selecting the whole unit would.
  // The page's copy controls: the selection when there is one (a range, exactly as the hotkeys
  // copy it, but never displaced by a clipboard text fragment), else the control's own unit.
  function selectionIn(model) {
    const range = liveSelectionRange();
    return range && !ownOverlay(range.startContainer) && rangeIntersects(range, model.root)
      && nodesForRange(model, range, true).length ? range : null;
  }

  async function copyRange(model, range, mode, node) {
    let payload, message;
    if (mode === 'link' && node) {
      const target = targetForNode(model, { kind: 'selection' }, node);
      const [{ plain }] = await core.pinpointLayouts(model.structure.kind, [[node.locator]], SETTINGS.pinpointStyle);
      payload = { plain: target, html: anchorHtml(target, target) };
      message = `Copied link to ${plain}`;
    } else if (mode === 'link') {
      const target = fragments.urlForRange(range, model.root, model.cleanUrl);
      payload = { plain: target, html: anchorHtml(target, target) };
      message = 'Copied a link to the selected text';
    } else {
      ({ payload, message } = await copy(mode, false, range));
    }
    assertCurrentModel(model);
    await clipboardWrite(payload);
    rememberedFragment = null;
    showToast(message, false);
    return payload;
  }

  // A copy control knows its element and locator; the full model maps it to the unit.
  async function copyControl(element, locator, mode) {
    const model = await inspectPage(false);
    const nodes = model.structure?.nodes || [];
    const node = nodes.find((candidate) => candidate.element === element)
      || nodes.find((candidate) => candidate.locator === locator && candidate.element && (candidate.element.contains(element) || element.contains(candidate.element)))
      || nodes.find((candidate) => candidate.locator === locator);
    if (!node) throw new Error('This passage is no longer on the page.');
    return copyUnit(model, node, mode);
  }

  async function copyUnit(model, node, mode) {
    const selected = selectionIn(model);
    if (selected) return copyRange(model, selected, mode, null);
    const range = lensRange(model, node);
    if (!range) throw new Error('This passage is no longer on the page.');
    return copyRange(model, range, mode, node);
  }

  // A CanLII statute's provisions, read from the selected text alone, for Ctrl+C and the quote hotkey
  // alike: a few milliseconds, no model, no layout. CanLII serves each jurisdiction's own markup
  // (federal lists, Alberta's and Ontario's classed paragraphs, BC's, Nova Scotia's unclassed ones),
  // but Canadian drafting numbers every level the same way, and the numbering says the depth: a
  // section ("21", "3(1)") and its subsections ("(2)") stand at one level; then lowercase letters
  // ("(a)"), lowercase roman numerals ("(i)"), capitals ("(A)") and capital roman numerals ("(I)"),
  // each one level further in. Text with no number of its own leads into the provisions after it
  // (a definition before its "(a)") or, starting in lowercase, closes the provision it follows
  // ("whichever is the later"); either way it stands at its provision's text. Headings, marginal
  // notes and Alberta's citation lines are left out.
  const PROVISION_MARKER = /^[\s ]*(\d+(?:\.\d+)*[A-Z]?\.?(?:[\s ]*\([0-9A-Za-z.]+\))*|\([0-9A-Za-z.]+\)(?:\([0-9A-Za-z.]+\))*|\d+°|[a-z]\))(?=[\s ])/;
  const DOCUMENT_ROOT = '#originalDocument, #docCont, #documentContent';
  const TEXT_BLOCK = 'p, li, dd, dt, td, th, h1, h2, h3, h4, h5, h6, blockquote, div';
  const HEADING_CLASS = /(note|heading|title|^citation|^historical|^partnum|^part$|^division$|^chapter|^schedule|^copyright)/i;
  const STATUTE_CHROME = '.viibes-marker-toolbox, .viibes-marker, [data-lp-ui], #legal-pinpointer-status, script, style';
  const ROMAN = /^(?=[ivxlc]+$)c{0,3}(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;

  // Whether the page's sections carry CanLII's labels (read once: they never change).
  let sectionLabels = null;
  const sectionLabelled = () => (sectionLabels ??= Boolean(document.querySelector('[section]')));

  // A statute quote's paragraph in Word's standard hanging indent: each level half an inch further
  // in (Left), the number hanging half an inch (Hanging) with a tab stop at the text, so wrapped
  // lines stay under the text. The column argument is unused: every level steps the standard 0.5".
  function quoteIndent(columns, column, hanging) {
    const left = columns * 36;
    return `margin:0 0 0 ${left}pt${hanging ? `;text-indent:-36pt;tab-stops:${left}pt` : ''}`;
  }

  function canliiStatutePage() {
    return /(^|\.)canlii\.org$/.test(location.hostname) && /\/laws\//.test(location.pathname);
  }

  // The blocks the selection's text sits in, in order (walked from the selection's start, never the
  // whole page); null past the limit.
  function selectedBlocks(range, limit) {
    const container = range.commonAncestorContainer;
    const root = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    if (!root) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      node = range.startContainer;
      walker.currentNode = node;
    } else {
      walker.currentNode = range.startContainer.childNodes[range.startOffset] || range.startContainer;
      node = walker.currentNode.nodeType === Node.TEXT_NODE ? walker.currentNode : walker.nextNode();
    }
    const blocks = [], seen = new Set(), documentRoot = document.querySelector(DOCUMENT_ROOT);
    for (; node; node = walker.nextNode()) {
      if (range.comparePoint(node, 0) > 0) break;
      if (!node.data.trim() || !range.intersectsNode(node)) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest(STATUTE_CHROME)) continue;
      // Text the page does not draw (CanLII's hidden definition terms) is not copied.
      if (!parent.getClientRects().length) continue;
      const block = parent.closest(TEXT_BLOCK);
      if (!block || seen.has(block) || (documentRoot && !documentRoot.contains(block))) continue;
      seen.add(block);
      blocks.push(block);
      if (blocks.length > limit) return null;
    }
    return blocks;
  }

  function isHeading(block, numbered) {
    if (/^H[1-6]$/.test(block.tagName)) return true;
    // A defined term listed on its own before the definition that repeats it.
    if (block.tagName === 'DT' && block.nextElementSibling?.textContent.trim().startsWith(block.textContent.trim())) return true;
    const classed = (element) => element && Array.from(element.classList).some((name) => HEADING_CLASS.test(name.replace(/-e$/, '')));
    if (classed(block) || (!numbered && classed(block.parentElement))) return true;
    if (numbered) return false;
    // A run of bold text alone on its line (Nova Scotia's and BC's headings).
    const text = block.textContent.replace(/[\s ]+/g, '');
    const bold = Array.from(block.querySelectorAll('b, strong'), (b) => b.textContent).join('').replace(/[\s ]+/g, '');
    return Boolean(text) && bold === text;
  }

  function provisionStart(block) {
    const text = block.textContent;
    let match = PROVISION_MARKER.exec(text);
    // Without CanLII's labels, a bare number is a section only when ordinary text follows it (old
    // scanned Acts print page numbers before "CHAPTER" or "Cap.").
    if (match && /^\d+[A-Z]?$/.test(match[1]) && !sectionLabelled()
      && (Number.parseInt(match[1], 10) > 999 || !/^[A-Z][a-z]/.test(text.slice(match[0].length).trimStart()) || /^(Cap|Chap|Sec)/.test(text.slice(match[0].length).trimStart()))) match = null;
    if (!match) return { marker: '', prefix: /^[\s ]*/.exec(text)[0].length };
    return {
      marker: match[1].replace(/[\s ]+/g, ' ').trim(),
      prefix: match[0].length + /^[\s ]*/.exec(text.slice(match[0].length))[0].length
    };
  }

  // A marker's level in the drafting hierarchy. "previous" is the lowercase or capital letter
  // marker just before it, which tells a letter "(i)" (after "(h)") from a roman numeral.
  function markerRank(marker, block, previous) {
    if (/°$/.test(marker)) return 1;
    if (/^[a-z]\)$/.test(marker)) return 2;
    const last = /\(([0-9A-Za-z.]+)\)$/.exec(marker);
    if (!last || /^\d/.test(marker)) {
      // "21", "3(1)", Ontario's "58." with its subsection: the section's level. A bare "1." in a page
      // whose sections carry CanLII's labels is a numbered paragraph inside a subsection.
      if (/^\d+(?:\.\d+)*\.$/.test(marker) && !block.querySelector('[section]') && sectionLabelled()) return 1;
      return 0;
    }
    const token = last[1];
    if (/^\d/.test(token)) return 0;
    const follows = (letter) => previous && previous.length === 1 && letter.length === 1 && letter.charCodeAt(0) === previous.charCodeAt(0) + 1;
    if (/^[a-z]+$/.test(token)) return ROMAN.test(token) && !follows(token) ? 2 : 1;
    if (/^[A-Z]+$/.test(token)) return ROMAN.test(token.toLowerCase()) && !follows(token) ? 4 : 3;
    return 1;
  }
  const letterOf = (marker) => (/\(([a-zA-Z]+)\)$/.exec(marker) || [])[1] || '';

  // The numbered block before this one in the page (for the letter just before a selection's first "(i)").
  function previousProvision(block, steps = 40) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (element) => (element.matches(TEXT_BLOCK) && !element.closest(STATUTE_CHROME) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP)
    });
    walker.currentNode = block;
    for (let previous = walker.previousNode(), count = 0; previous && count < steps; previous = walker.previousNode(), count += 1) {
      if (previous.contains(block)) continue;
      const start = provisionStart(previous);
      if (start.marker && !isHeading(previous, true)) return { block: previous, start };
    }
    return null;
  }

  // The page's own anchor for a provision: its section and subsection labels, an anchor in or just
  // before it, or its id.
  function provisionAnchor(block) {
    const label = block.querySelector('[section]');
    if (label) {
      const section = label.getAttribute('section'), subsection = label.getAttribute('subsection');
      const name = `sec${section}${subsection && subsection !== 'null' ? `subsec${subsection}` : ''}`;
      if (document.getElementsByName(name).length) return name;
    }
    const inside = block.querySelector('a[name]')?.getAttribute('name');
    if (inside) return inside;
    for (let previous = block.previousElementSibling, hops = 0; previous && hops < 3; previous = previous.previousElementSibling, hops += 1) {
      if (previous.matches('a[name]')) return previous.getAttribute('name');
      if (previous.textContent.trim() && !isHeading(previous, false)) break;
    }
    return block.id || '';
  }

  // A provision's pinpoint ("21(1)(a)"): its own number after those of the provisions it sits in,
  // read back up the page to the one that states its section.
  function provisionLocator(block, start) {
    // Inside a definition ("indictment" (a)): the defined term after the section.
    const term = block.closest('dd')?.querySelector('dfn')?.textContent.trim();
    const located = provisionChain(block, start);
    if (!term || !/^\d/.test(located)) return located;
    const at = located.search(/\([a-zA-Z]/);
    return at > 0 ? `${located.slice(0, at)} “${term}” ${located.slice(at)}` : located;
  }

  function provisionChain(block, start) {
    const stated = (element) => {
      const label = element.querySelector?.('[section]');
      if (!label) return '';
      const subsection = label.getAttribute('subsection');
      return `${label.getAttribute('section')}${subsection && subsection !== 'null' ? `(${subsection})` : ''}`;
    };
    let own = stated(block);
    const sub = /^\d+(?:\.\d+)*[A-Z]?\.?\s*(\([0-9A-Za-z.]+\))/.exec(start.marker);
    if (own && sub && !own.includes('(')) own += sub[1];
    if (own) return own;
    // "58. (1)" is s 58(1): no space, and no full stop after a section number.
    const compact = (marker) => marker.replace(/\s+/g, '').replace(/\.(?=\(|$)/g, '');
    const parts = [compact(start.marker)];
    let rank = markerRank(start.marker, block, letterOf(previousProvision(block, 3)?.start.marker || ''));
    if (rank === 0 && /^\d/.test(start.marker)) return parts[0];
    let current = block;
    for (let steps = 0; current && steps < 60 && rank > 0; steps += 1) {
      const found = previousProvision(current, 400);
      if (!found) break;
      current = found.block;
      const before = markerRank(found.start.marker, found.block, letterOf(previousProvision(found.block, 3)?.start.marker || ''));
      if (before >= rank) continue;
      const section = stated(found.block);
      if (section) return section + parts.reverse().join('');
      parts.push(compact(found.start.marker));
      rank = before;
    }
    const chain = parts.reverse().join('');
    if (/^\d/.test(chain)) return chain;
    // A subsection ("(2)", or the "(3)" a paragraph's chain stopped at) stands at its section's level,
    // so the walk above ends on it: its section is the nearest number before it that states one.
    for (let steps = 0; current && steps < 200; steps += 1) {
      const found = previousProvision(current, 400);
      if (!found) break;
      current = found.block;
      // (Not Quebec's "1°", a paragraph.)
      const section = (stated(found.block) || compact(found.start.marker)).match(/^\d+(?:\.\d+)*[A-Z]?(?=\(|$)/);
      if (section) return section[0] + chain;
    }
    return chain;
  }

  function canliiStatuteQuote(range) {
    if (!SETTINGS.statuteCopyIndent || !canliiStatutePage() || !range || range.collapsed) return null;
    if (ownOverlay(range.startContainer) || ownOverlay(range.endContainer)) return null;
    // A whole Act (Ctrl+A) is left to the browser's own copy, at once.
    const blocks = selectedBlocks(range, 2000);
    if (!blocks || !blocks.length) return null;
    const pieces = [];
    let letter = '';
    for (const block of blocks) {
      const start = provisionStart(block);
      if (isHeading(block, Boolean(start.marker))) continue;
      // This block's selected part, and how far into the block the selection starts.
      const part = document.createRange();
      part.selectNodeContents(block);
      let offset = 0;
      if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) {
        const before = document.createRange();
        before.setStart(block, 0);
        before.setEnd(range.startContainer, range.startOffset);
        offset = before.toString().length;
        part.setStart(range.startContainer, range.startOffset);
      }
      if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
      const fragment = part.cloneContents();
      for (const chrome of fragment.querySelectorAll(STATUTE_CHROME)) chrome.remove();
      for (const inner of fragment.querySelectorAll(TEXT_BLOCK)) if (inner.textContent.trim()) inner.remove();
      stripLeadingCharacters(fragment, Math.max(0, start.prefix - offset));
      const content = renderSelectionFragment(fragment);
      const body = {
        plain: content.plain.replace(/^[\s ]+/, ''),
        html: content.html.replace(/<(strong|b|em|i|u|sup|sub|span)>(?:\s|&nbsp;)*<\/\1>/g, '').replace(/^(?:\s|&nbsp;|&#160;| )+/, '')
      };
      let rank = null;
      if (start.marker) {
        if (!pieces.some((piece) => piece.start.marker)) letter = letterOf(previousProvision(block, 3)?.start.marker || '');
        rank = markerRank(start.marker, block, letter);
        letter = letterOf(start.marker) || letter;
      }
      pieces.push({ block, start, offset, body, rank, leading: Boolean(start.marker) && offset > start.prefix });
    }
    // Words from inside one provision stay the browser's own copy: the selection must take in a number.
    if (!pieces.some((piece) => piece.start.marker && (piece.offset === 0 || piece.offset < piece.start.prefix))) return null;
    // A section whose number only heads its first subsection holds no text of its own.
    const kept = pieces.filter((piece, index) => piece.body.plain || (piece.start.marker && index === pieces.length - 1));
    if (!kept.length) return null;

    // Unnumbered text: a lead-in stands at the text of the level above the provisions after it, a
    // closing (lowercase) at the text of the level above the provisions before it.
    kept.forEach((piece, index) => {
      if (piece.rank != null) return;
      const before = kept.slice(0, index).reverse().find((other) => other.rank != null);
      const after = kept.slice(index + 1).find((other) => other.rank != null);
      const closing = /^[a-z]/.test(piece.body.plain);
      const near = closing ? (before || after) : (after || before);
      piece.textRank = Math.max(0, (near ? near.rank : 1) - 1);
    });
    const ranks = kept.map((piece) => (piece.rank != null ? piece.rank : piece.textRank));
    const base = Math.min(...ranks);

    const here = `${location.origin}${location.pathname}`;
    const width = (label) => Array.from(label).reduce((sum, ch) => sum + (/\s/.test(ch) ? 0.28 : /[().,]/.test(ch) ? 0.33 : 0.56), 0);
    const column = Math.min(5, Math.max(2.5, Math.ceil((Math.max(0, ...kept.map((piece) => width(piece.start.marker))) + 0.9) * 4) / 4));
    const lead = (piece) => (piece.leading ? '… ' : '');
    const html = [], plain = [];
    for (const piece of kept) {
      if (piece.rank == null) {
        const depth = piece.textRank - base;
        plain.push(`${'\t'.repeat(depth + 1)}${piece.body.plain}`);
        html.push(`<p style="${quoteIndent(depth + 1, column, false)}">${piece.body.html}</p>`);
        continue;
      }
      const depth = piece.rank - base;
      const anchor = provisionAnchor(piece.block);
      const markerHtml = anchor ? anchorHtml(piece.start.marker, `${here}#${encodeURIComponent(anchor)}`) : core.escapeHtml(piece.start.marker);
      plain.push(`${'\t'.repeat(depth)}${piece.start.marker}\t${lead(piece)}${piece.body.plain}`);
      html.push(`<p style="${quoteIndent(depth + 1, column, true)}">${markerHtml}<span style="mso-tab-count:1">\t</span>${lead(piece)}${piece.body.html}</p>`);
    }
    const numbered = kept.filter((piece) => piece.rank != null);
    const firstPiece = numbered[0], lastPiece = numbered[numbered.length - 1];
    return {
      first: firstPiece ? provisionLocator(firstPiece.block, firstPiece.start) : '',
      last: lastPiece && lastPiece !== firstPiece ? provisionLocator(lastPiece.block, lastPiece.start) : '',
      plain: plain.join('\n'),
      html: html.join('')
    };
  }

  // A click on a CanLII number, copied at once from the page itself (no model): a judgment's
  // "[5]" as its paragraph, a statute's number as its provision. Null where the page cannot say.
  function quickNumberCopy(number) {
    if (!/(^|\.)canlii\.org$/.test(location.hostname)) return null;
    const here = `${location.origin}${location.pathname}`;
    let kind, locator, anchor;
    const paragraph = number.matches('a.reflex-paragAnchor[name]') ? /^par(\d+)$/.exec(number.getAttribute('name')) : null;
    // An anchor on a numbered heading or list item is not a paragraph number: the model says where it is.
    if (paragraph && providers.canliiAnchorsNumberDocument && !providers.canliiAnchorsNumberDocument(document)) return null;
    if (paragraph) {
      kind = 'paragraph'; locator = paragraph[1]; anchor = number.getAttribute('name');
    } else if (canliiStatutePage()) {
      const block = number.closest(TEXT_BLOCK);
      const start = block && provisionStart(block);
      if (!start?.marker) return null;
      kind = 'section'; locator = provisionLocator(block, start); anchor = provisionAnchor(block);
      // No anchor of its own (a paragraph inside a subsection): the nearest one of the provisions it
      // sits in, up to its section's.
      const rankOf = (found) => markerRank(found.start.marker, found.block, letterOf(previousProvision(found.block, 3)?.start.marker || ''));
      let rank = anchor ? 0 : rankOf({ block, start });
      for (let current = block, steps = 0; !anchor && current && steps < 120; steps += 1) {
        const found = previousProvision(current, 400);
        if (!found) break;
        current = found.block;
        const section = /^\d/.test(found.start.marker), level = rankOf(found);
        if (!section && level >= rank) continue; // a sibling or something inside one
        rank = level;
        anchor = provisionAnchor(found.block);
        if (section) break;
      }
    } else return null;
    if (!locator) return null;
    const url = anchor ? `${here}#${encodeURIComponent(anchor)}` : here;
    const prefix = SETTINGS.pinpointStyle === 'bare' ? '' : kind === 'paragraph' ? 'at para ' : 's ';
    const payload = { plain: `${prefix}${locator}`, html: `${core.escapeHtml(prefix)}${anchorHtml(locator, url)}` };
    if (clipboardWriteNow(payload)) {
      rememberedFragment = null;
      showToast(`Copied pinpoint: ${payload.plain}`, false);
      return Promise.resolve({ ok: true, plain: payload.plain });
    }
    return clipboardWrite(payload).then(() => {
      rememberedFragment = null;
      showToast(`Copied pinpoint: ${payload.plain}`, false);
      return { ok: true, plain: payload.plain };
    });
  }

  /** A reader's own copy (Ctrl+C) of statute text, as the quote copy writes it: each provision it
   *  takes in as an indented paragraph, its number linked. Null (the browser's own copy) when the
   *  setting is off, the page has no provisions, the model is stale, or the selection starts no
   *  provision: a few words copied from inside one provision stay plain text. */
  function statuteCopy(model, range) {
    if (canliiStatutePage()) return canliiStatuteQuote(range);
    if (!SETTINGS.statuteCopyIndent || !model?.structure?.nodes?.length || !range || range.collapsed) return null;
    if (!['section', 'rule', 'article', 'silcrow'].includes(model.structure.kind)) return null;
    if (ownOverlay(range.startContainer) || ownOverlay(range.endContainer)) return null;
    try { assertCurrentModel(model); } catch (_) { return null; }
    if (!model.root.contains(range.commonAncestorContainer)) return null;
    const nodes = nodesForRange(model, range, true);
    if (!nodes.length || !nodes.some((node) => node.element?.isConnected && range.isPointInRange(node.element, 0))) return null;
    const quote = quoteMarkup(model, { kind: 'selection', range, url: '' }, range, nodes);
    return quote.plain ? quote : null;
  }

  async function copyPayload(payload, message) {
    await clipboardWrite(payload);
    rememberedFragment = null;
    showToast(message, false);
  }

  // The page UI (page-ui.js) shares this model, these builders and the one toast.
  globalThis.LegalPinpointerPage = {
    settingsReady,
    settings: SETTINGS,
    model: (metadataOnly) => inspectPage(metadataOnly),
    current: (model) => { try { assertCurrentModel(model); return true; } catch (_) { return false; } },
    unitAt: (model, target) => nodeForTarget(model, target),
    /** Where a pinpoint to this node links (its CanLII paragraph or provision where there is one). */
    linkFor: (model, node) => targetForNode(model, { kind: 'node' }, node),
    statuteCopy,
    /** A CanLII statute's indented copy, read from the page alone (no model needed), or null. */
    quickStatuteCopy: (range) => canliiStatuteQuote(range),
    /** A click on a CanLII number, copied from the page itself: a promise, or null where the page cannot say. */
    quickNumberCopy: (number) => quickNumberCopy(number),
    /** A CanLII statute's provision numbers that CanLII writes as plain text ("(2)", "(a)"): for a
     *  block's first text node, the length of the number it starts with (after `lead` spaces), or null. */
    statuteNumberIn: (block, text) => {
      // The cheap test first: most blocks start with no number at all. A number set in an element of
      // its own (BC's <span class="holder">(b)</span>) has the space after it outside its text.
      let probe = text.data;
      if (!/[\s ]$/.test(probe)) {
        const full = block.textContent, at = full.indexOf(probe);
        if (at >= 0) probe += full.charAt(at + probe.length);
      }
      const match = PROVISION_MARKER.exec(probe);
      if (!match || !canliiStatutePage() || isHeading(block, true) || !provisionStart(block).marker) return null;
      const lead = /^[\s ]*/.exec(text.data)[0].length;
      return { lead, length: match[1].length };
    },
    /** Writes plain and HTML text to the clipboard (outside a copy event). */
    writeClipboard: (payload) => clipboardWrite(payload),
    /** Runs a change the caller undoes at once (a copy's number links): the page's model is not
     *  invalidated by it, so a model being built meanwhile stays good. */
    quietly: (change) => {
      flushModels();
      try { return change(); } finally { modelObserver?.takeRecords(); }
    },
    onInvalidate: (listener) => invalidationListeners.add(listener),
    copyUnit,
    copyControl,
    copyPayload,
    copyCitation: () => copy('citation'),
    openCanlii,
    toast: showToast,
    report: handleTask
  };

  globalThis.LegalPinpointerSonarCopy = (range, mode) => copy(mode, false, range);
  // Tab Search titles its results with the citation Alt+X copies.
  globalThis.LegalPinpointerSonarCitation = async () => (await inspectPage(true)).citation.plain;

  globalThis.LegalPinpointerLensBridge={collect:lensCollect,prepare:lensPrepare,open:lensOpen,
    formatRange(range,mode,options={}){
      const model={root:document.body,cleanUrl:location.href};
      const target=options.link==='text'?lensFragment(range,model):location.href;
      const text=renderSelectionFragment(range.cloneContents());
      if(mode==='link')return {plain:target,html:anchorHtml(target,target)};
      if(mode==='citation')return {plain:document.title,html:anchorHtml(document.title,target)};
      if(mode==='pinpoint')return {plain:'[Link]',html:anchorHtml('[Link]',target)};
      return {plain:`[Link]: ${text.plain}`,html:`${anchorHtml('[Link]',target)}: ${text.html}`};
    }};

  function handleTask(task) {
    task.catch((error) => showToast(error.message || 'Legal Pinpointer could not complete the request.', true));
  }

  // CanLII, else the court's own Lexum/Decisia page for the decision.
  async function openCanlii() {
    const model = await inspectPage(true);
    const url = model.canliiUrl || model.siteUrl;
    if (!url) throw new Error('No reliable CanLII version was detected.');
    const target = new URL(url);
    const valid = target.protocol === 'https:' && (model.canliiUrl
      ? ['canlii.org', 'www.canlii.org'].includes(target.hostname.toLowerCase())
      : core.isCourtSiteUrl(target.href));
    if (!valid) throw new Error('Legal Pinpointer refused an invalid navigation target.');
    window.location.assign(target.href);
  }

  document.addEventListener('keydown', (event) => {
    if (event.repeat || !SETTINGS.copyShortcuts || !/^(?:www\.)?(?:canlii\.org|advance\.lexis\.com|nextcanada\.westlaw\.com)$/.test(location.hostname)) return;
    const key = event.key.toLowerCase();
    const copyPinpoint = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && key === 'x';
    const copyQuote = event.ctrlKey && !event.altKey && !event.metaKey && event.shiftKey && key === 'x';
    const copyCitation = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && key === 'x';
    const goCanlii = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && key === 'c';
    if (!copyPinpoint && !copyQuote && !copyCitation && !goCanlii) return;
    if (editableTarget(event.composedPath()[0] || event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (goCanlii) handleTask(openCanlii());
    else handleTask(copy(copyQuote ? 'quote' : copyCitation ? 'citation' : 'pinpoint'));
  }, true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    if (!message || !['LEGAL_PINPOINTER_COPY', 'LEGAL_PINPOINTER_INSPECT', 'LEGAL_PINPOINTER_OPEN_CANLII'].includes(message.type)) return false;
    if (message.type === 'LEGAL_PINPOINTER_COPY' && !COPY_MODES.has(message.mode)) {
      sendResponse({ ok: false, message: 'The requested copy mode is invalid.' });
      return false;
    }
    const showFeedback = message.source !== 'popup';
    const task = message.type === 'LEGAL_PINPOINTER_COPY'
      ? copy(message.mode, showFeedback)
      : message.type === 'LEGAL_PINPOINTER_OPEN_CANLII'
        ? openCanlii().then(() => ({ ok: true }))
        : inspection(message.metadataOnly === true);
    task.then(sendResponse).catch((error) => {
      const result = { ok: false, message: error.message || 'Legal Pinpointer could not complete the request.' };
      if (showFeedback) showToast(result.message, true);
      sendResponse(result);
    });
    return true;
  });
})();