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
  const QUOTE_BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DT', 'FIGCAPTION', 'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'P', 'PRE', 'SECTION', 'TD', 'TH', 'TR']);

  document.addEventListener('pointerover', (event) => {
    lastHoverTarget = event.target instanceof Element ? event.target : event.target.parentElement;
  }, true);
  document.addEventListener('pointermove', (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };
  }, { capture: true, passive: true });

  function storageGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }

  function ownOverlay(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(element?.closest('#legal-pinpointer-status, [data-pinpointer-sonar]'));
  }

  function invalidateModels(records) {
    if (!modelCache.size || !records.some(record => !ownOverlay(record.target) && (
      record.type !== 'childList' || [...record.addedNodes, ...record.removedNodes].some(node => !ownOverlay(node))
    ))) return;
    documentRevision += 1;
    modelCache.clear();
  }

  function flushModels() {
    if (!modelObserver) {
      modelObserver = new MutationObserver(invalidateModels);
      // Arm only on first use, and invalidate cheaply; never parse in the observer.
      // Headers and metadata outside the document root affect citation identity too.
      modelObserver.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['id', 'name', 'content', 'href', 'class', 'style', 'hidden', 'aria-hidden',
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

  async function inspectPage(metadataOnly = false) {
    flushModels();
    const url = window.location.href, revision = documentRevision;
    const level = metadataOnly ? 'metadata' : 'structure';
    let entry = modelCache.get(level);
    if (!entry || entry.url !== url || entry.revision !== revision) {
      entry = { url, revision, promise: providers.inspect(document, window.location, undefined, { metadataOnly }) };
      modelCache.set(level, entry);
    }
    try {
      const model = await entry.promise;
      if (!model?.citation?.plain || !model.root?.isConnected) {
        throw new Error('This page does not expose a supported legal document.');
      }
      flushModels();
      if (revision !== documentRevision || url !== window.location.href) {
        throw new Error('The document changed during this operation. Please try again.');
      }
      modelStamps.set(model, { revision, url });
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
      nodes = core.removeRedundantProvisionAncestors(nodes);
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

  function nativeCanliiTarget(model, node) {
    if (!model.canliiUrl || !['case', 'legislation'].includes(model.documentType)) return '';
    const fragment = core.canliiAnchorForLocator(model.structure.kind, node.locator, model.canliiUrl);
    if (!fragment || fragment.includes(':~:text=')) return '';
    return core.withFragment(model.canliiUrl, fragment);
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

  function pinpointMarkup(model, sourceInfo, inputNodes, style, linkFullTextFragmentPinpoint) {
    const nodes = uniqueLocatorNodes(inputNodes);
    const plain = core.formatPinpoint(model.structure.kind, nodes.map((node) => node.locator), style);
    if (sourceInfo.kind === 'text-fragment') {
      const prefix = core.pinpointPrefix(model.structure.kind, nodes.length, style);
      const locators = core.collapseLocatorRanges(nodes.map((node) => node.locator));
      return {
        plain,
        html: linkFullTextFragmentPinpoint
          ? anchorHtml(plain, sourceInfo.url)
          : `${core.escapeHtml(prefix)}${anchorHtml(locators, sourceInfo.url)}`
      };
    }
    const groups = core.locatorGroups(nodes.map((node) => node.locator));
    const pieces = groups.map((group) => {
      const first = anchorHtml(group.firstDisplay, targetForNode(model, sourceInfo, nodes[group.start]));
      if (group.end === group.start) return first;
      const last = anchorHtml(group.lastDisplay, targetForNode(model, sourceInfo, nodes[group.end]));
      return `${first}-${last}`;
    });
    const prefix = core.pinpointPrefix(model.structure.kind, nodes.length, style);
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
    if (kind === 'page') return new RegExp(`^\\s*\\[page\\s+${value}\\]\\s*`, 'i');
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
      if (node.nodeType === Node.ELEMENT_NODE && (
        node.matches('script, style, noscript, template, [hidden], [aria-hidden="true"]')
      )) return { plain: '', html: '' };
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') return { plain: '\n', html: '<br>' };
      const children = Array.from(node.childNodes).map(render);
      let plain = children.map((child) => child.plain).join('');
      let html = children.map((child) => child.html).join('');
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return { plain, html };
      const tag = QUOTE_INLINE.get(node.tagName);
      if (tag) html = `<${tag}>${html}</${tag}>`;
      if (QUOTE_BLOCK.has(node.tagName) && (plain || html)) {
        plain = `\n${plain}\n`;
        html = `<br>${html}<br>`;
      }
      return { plain, html };
    }

    const rendered = render(fragment);
    return {
      plain: normalizeQuoteText(rendered.plain),
      html: rendered.html
        .replace(/^(?:\s|<br>)+|(?:\s|<br>)+$/g, '')
        .replace(/(?:<br>){2,}/g, '<br>')
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

  function quoteMarkup(model, sourceInfo, range, nodes) {
    const provision = ['section', 'rule', 'article', 'silcrow'].includes(model.structure.kind);
    // Indent relative to the shallowest quoted unit: a lone (b)(i) is flush, its children nest.
    const baseDepth = provision ? Math.min(...nodes.map((node) => core.provisionDepth(node.locator))) : 0;
    const pieces = nodes.map((node, index) => {
      const unitRange = intersectNodeUnit(model, range, node);
      if (!unitRange) return null;
      const markerState = leadingMarkerState(model, unitRange, node);
      const leading = index === 0 && markerState.omitted;
      const content = quoteContent(unitRange, markerState.strip);
      const marker = quoteMarker(model.structure.kind, node);
      const depth = provision ? core.provisionDepth(node.locator) - baseDepth : 0;
      const continuationPlain = '\t'.repeat(depth + 1);
      const lead = leading ? ' \u2026' : '';
      const bodyPlain = content.plain ? ` ${content.plain.replace(/\n/g, `\n${continuationPlain}`)}` : '';
      const bodyHtml = content.html ? ` ${content.html}` : '';
      const markerHtml = anchorHtml(marker, targetForNode(model, sourceInfo, node));
      const markerColumn = Math.max(2, Math.ceil((Array.from(marker).length + 1) * 5) / 10);
      const provisionHtml = `<span style="display:inline-block;margin:0 0 0 ${depth * 2 + markerColumn}em;text-indent:-${markerColumn}em"><span style="display:inline-block;width:${markerColumn}em;text-indent:0">${markerHtml}&nbsp;</span>${lead.trimStart()}${leading && bodyHtml ? ' ' : ''}${bodyHtml.trimStart()}</span>`;
      return {
        plain: `${'\t'.repeat(depth)}${marker}${lead}${bodyPlain}`,
        html: `${'&emsp;'.repeat(depth)}${markerHtml}${lead}${bodyHtml}`,
        provisionHtml
      };
    }).filter(Boolean);
    const paragraphBlocks = ['paragraph', 'pilcrow', 'silcrow'].includes(model.structure.kind);
    const quote = {
      plain: pieces.map((piece) => piece.plain).join('\n'),
      html: provision
        ? pieces.map((piece) => piece.provisionHtml).join('<br>')
        : paragraphBlocks
        ? pieces.map((piece) => piece.html).join('<br>')
        : pieces.map((piece) => piece.html).join('<br>')
    };
    return quote;
  }

  async function clipboardWrite(payload) {
    if (navigator.clipboard && typeof navigator.clipboard.write === 'function' && typeof ClipboardItem === 'function') {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([payload.plain], { type: 'text/plain' }),
          'text/html': new Blob([payload.html], { type: 'text/html' })
        })]);
        return;
      } catch (_) {
        // Some provider frames reject this API even with extension clipboard permission.
      }
    }

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
    try { executed = document.execCommand('copy'); }
    finally { document.removeEventListener('copy', onCopy, true); }
    if (!executed || !copied) throw new Error('The browser denied clipboard access.');
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
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 2800);
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

  // A passage (Tab Sonar result) replaces the selection/hover/clipboard source
  // and returns the payload for the caller to write instead of writing it here.
  async function copy(mode, showFeedback = true, passage = null) {
    const model = await inspectPage(mode === 'citation');
    let payload;
    let message;
    let fragmentSource = null;

    if (passage && mode === 'link') {
      const target = fragments.urlForRange(passage, model.root, model.cleanUrl);
      payload = { plain: target, html: anchorHtml(target, target) };
      message = 'Copied passage link';
    } else if (mode === 'citation') {
      const target = model.canliiUrl || model.cleanUrl;
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
        const target = model.canliiUrl || model.cleanUrl;
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
      const pinpoint = pinpointMarkup(
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

    assertCurrentModel(model);
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
      structureKind: model.structure ? model.structure.kind : '',
      structureSource: model.structure ? model.structure.source : metadataOnly ? 'not-inspected' : 'none',
      structureCount: model.structure ? model.structure.nodes.length : metadataOnly ? null : 0,
      selectedPinpoint: model.structure
        ? core.formatPinpoint(model.structure.kind, selected.map((node) => node.locator), settings.pinpointStyle)
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
        pinpoint:core.formatPinpoint(model.structure.kind,[node.locator],settings.pinpointStyle),
        kind:model.structure.kind,text,target:targetForNode(model,{kind:'lens'},node)});
    }
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
    const pin=pinpointMarkup(model,sourceInfo,[node],options.wording||settings.pinpointStyle,settings.linkFullTextFragmentPinpoint);
    let payload;
    if(mode==='link')payload={plain:target,html:anchorHtml(target,target)};
    else if(mode==='citation')payload=core.outputCitationLink(model.citation,model.canliiUrl||model.cleanUrl);
    else if(mode==='pinpoint')payload=pin;
    else if(mode==='quote'||mode==='source'){
      const quote=quoteMarkup(model,sourceInfo,range,[node]);
      if(mode==='quote')payload=quote;
      else{const citation=core.outputCitationLink(model.citation,model.canliiUrl||model.cleanUrl);
        payload={plain:`${citation.plain} ${pin.plain}\n${quote.plain}`,html:`<p>${citation.html} ${pin.html}</p>${quote.html}`};}
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

  globalThis.LegalPinpointerSonarCopy = (range, mode) => copy(mode, false, range);

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

  async function openCanlii() {
    const model = await inspectPage(true);
    if (!model.canliiUrl) throw new Error('No reliable CanLII version was detected.');
    const target = new URL(model.canliiUrl);
    if (target.protocol !== 'https:' || !['canlii.org', 'www.canlii.org'].includes(target.hostname.toLowerCase())) {
      throw new Error('Legal Pinpointer refused an invalid CanLII navigation target.');
    }
    window.location.assign(target.href);
  }

  document.addEventListener('keydown', (event) => {
    if (event.repeat || !/^(?:www\.)?(?:canlii\.org|advance\.lexis\.com|nextcanada\.westlaw\.com)$/.test(location.hostname)) return;
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