'use strict';

(function startContentScript() {
  const core = globalThis.LegalPinpointerCore;
  const fragments = globalThis.LegalPinpointerTextFragments;
  const providers = globalThis.LegalPinpointerProviders;
  let lastHoverTarget = null;
  let lastPointer = null;
  let modelCache = null;
  let rememberedFragment = null;
  let toastTimer = 0;
  const MAX_CLIPBOARD_TEXT_LENGTH = 1_000_000;
  const COPY_MODES = new Set(['pinpoint', 'quote', 'citation']);

  document.addEventListener('pointerover', (event) => {
    lastHoverTarget = event.target instanceof Element ? event.target : event.target.parentElement;
  }, true);
  document.addEventListener('pointermove', (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };
  }, { capture: true, passive: true });

  function storageGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }

  async function inspectPage() {
    const key = window.location.href;
    if (modelCache && modelCache.key === key && modelCache.promise) {
      const cached = await modelCache.promise;
      if (cached && cached.root && cached.root.isConnected
          && !(cached.documentType === 'legislation' && !cached.citation.citation)) return cached;
    }

    const promise = providers.inspect(document, window.location);
    modelCache = { key, promise };
    try {
      const model = await promise;
      if (!model || !model.citation || !model.citation.plain || !model.root || !model.root.isConnected) {
        throw new Error('This page does not expose a supported legal document.');
      }
      return model;
    } catch (error) {
      if (modelCache && modelCache.promise === promise) modelCache = null;
      throw error;
    }
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
    const previous = model.structure.nodes[model.structure.nodes.indexOf(node) - 1];
    const previousEnd = previous && previous.endPoint && previous.endPoint.node && previous.endPoint.node.isConnected
      ? nodeBoundary(previous, false)
      : null;
    return start && previousEnd && previousEnd.compareBoundaryPoints(Range.START_TO_START, start) < 0 ? previousEnd : start;
  }

  function nodeUnitEnd(model, node) {
    const index = model.structure.nodes.indexOf(node);
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
    const containing = [...nodes].reverse().find((node) => node.element === target || node.element.contains(target));
    if (containing) return containing;

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

    const anchoredNode = node.anchor ? node : model.structure.nodes
      .filter((candidate) => candidate.anchor && core.isProvisionAncestor(candidate.locator, node.locator))
      .sort((left, right) => core.provisionDepth(right.locator) - core.provisionDepth(left.locator))[0];
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
    const inline = new Map([
      ['B', 'strong'], ['STRONG', 'strong'], ['I', 'em'], ['EM', 'em'],
      ['U', 'u'], ['S', 's'], ['STRIKE', 's'], ['SUB', 'sub'], ['SUP', 'sup'],
      ['Q', 'q'], ['CODE', 'code']
    ]);
    const block = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DT', 'FIGCAPTION', 'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'P', 'PRE', 'SECTION', 'TD', 'TH', 'TR']);

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
      const tag = inline.get(node.tagName);
      if (tag) html = `<${tag}>${html}</${tag}>`;
      if (block.has(node.tagName) && (plain || html)) {
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
    const executed = document.execCommand('copy');
    document.removeEventListener('copy', onCopy, true);
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

  // Opt-in fallback for documents with no structure: link the selected passage (or the hovered
  // paragraph) with a text fragment built and verified against this page. A copied fragment link
  // still takes precedence.
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

  async function builtPassageSource(model) {
    const settings = await storageGet({ buildTextFragmentWithoutStructure: false });
    if (!settings.buildTextFragmentWithoutStructure || await clipboardFragment(model)) return null;
    const index = fragments.buildTextIndex(document.body);
    const range = liveSelectionRange() || hoveredPassage(model, index);
    if (!range || !rangeIntersects(range, model.root)) return null;
    const built = fragments.buildPassageLink(range, { contextRoot: model.root, index });
    if (!built || !built.range) {
      throw new Error('No link can single out that passage: its opening words recur elsewhere on the page. Start the selection at the beginning of its paragraph.');
    }
    return { kind: 'text-fragment', range: built.range, url: core.withFragment(model.cleanUrl, `#:~:${built.directive}`) };
  }

  function pageQuote(model, sourceInfo) {
    if (!rangeIntersects(sourceInfo.range, model.root)) throw new Error('Select text within the document first.');
    const passage = renderSelectionFragment(sourceInfo.range.cloneContents());
    if (!passage.plain) throw new Error('The resolved range contains no copyable text.');
    const link = core.outputCitationLink(model.citation, sourceInfo.url || model.canliiUrl || model.cleanUrl);
    return { plain: `${link.plain}, ${passage.plain}`, html: `${link.html}, ${passage.html}` };
  }

  async function copy(mode, showFeedback = true) {
    const model = await inspectPage();
    let payload;
    let message;
    let fragmentSource = null;

    if (mode === 'citation') {
      const target = model.canliiUrl || model.cleanUrl;
      payload = core.outputCitationLink(model.citation, target);
      message = `Copied citation: ${model.citation.plain}`;
    } else if (!model.structure || !model.structure.nodes.length) {
      const target = model.canliiUrl || model.cleanUrl;
      payload = core.outputCitationLink(model.citation, target);
      message = `Copied page: ${model.citation.plain}`;
      const built = await builtPassageSource(model);
      if (built) {
        payload = mode === 'quote' ? pageQuote(model, built) : core.outputCitationLink(model.citation, built.url);
        message = `Copied ${mode === 'quote' ? 'quote with ' : ''}passage link: ${model.citation.plain}`;
      } else if (mode === 'quote') {
        const sourceInfo = await copySource(model, mode);
        if (sourceInfo.kind === 'text-fragment') fragmentSource = sourceInfo;
        payload = pageQuote(model, sourceInfo);
      }
    } else {
      const sourceInfo = await copySource(model, mode);
      if (sourceInfo.kind === 'text-fragment') fragmentSource = sourceInfo;
      const nodes = sourceInfo.range ? nodesForRange(model, sourceInfo.range, mode === 'quote') : [sourceInfo.node];
      if (!nodes.length && mode === 'quote') {
        payload = pageQuote(model, sourceInfo);
        message = `Copied quote from ${model.citation.plain}`;
      } else {
        if (!nodes.length) throw new Error('No page, paragraph, or provision overlaps that range.');
        const settings = await storageGet({ pinpointStyle: 'full', linkFullTextFragmentPinpoint: false });
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
    }

    await clipboardWrite(payload);
    rememberedFragment = fragmentSource
      ? { url: fragmentSource.url, outputPlain: payload.plain }
      : null;
    if (showFeedback) showToast(message, false);
    return { ok: true, message, plain: payload.plain };
  }

  async function inspection() {
    const model = await inspectPage();
    const range = liveSelectionRange();
    const selected = range ? nodesForRange(model, range) : [];
    const settings = await storageGet({ pinpointStyle: 'full' });
    return {
      ok: true,
      provider: model.provider,
      documentType: model.documentType,
      citation: model.citation.plain,
      canliiAvailable: Boolean(model.canliiUrl),
      structureKind: model.structure ? model.structure.kind : '',
      structureSource: model.structure ? model.structure.source : 'none',
      structureCount: model.structure ? model.structure.nodes.length : 0,
      selectedPinpoint: model.structure
        ? core.formatPinpoint(model.structure.kind, selected.map((node) => node.locator), settings.pinpointStyle)
        : ''
    };
  }

  function handleTask(task) {
    task.catch((error) => showToast(error.message || 'Legal Pinpointer could not complete the request.', true));
  }

  async function openCanlii() {
    const model = await inspectPage();
    if (!model.canliiUrl) throw new Error('No reliable CanLII version was detected.');
    const target = new URL(model.canliiUrl);
    if (target.protocol !== 'https:' || !['canlii.org', 'www.canlii.org'].includes(target.hostname.toLowerCase())) {
      throw new Error('Legal Pinpointer refused an invalid CanLII navigation target.');
    }
    window.location.assign(target.href);
  }

  document.addEventListener('keydown', (event) => {
    if (event.repeat || editableTarget(event.target)) return;
    const key = event.key.toLowerCase();
    const copyPinpoint = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && key === 'x';
    const copyQuote = event.ctrlKey && !event.altKey && !event.metaKey && event.shiftKey && key === 'x';
    const copyCitation = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && key === 'x';
    const goCanlii = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && key === 'c';
    if (!copyPinpoint && !copyQuote && !copyCitation && !goCanlii) return;
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
        : inspection();
    task.then(sendResponse).catch((error) => {
      const result = { ok: false, message: error.message || 'Legal Pinpointer could not complete the request.' };
      if (showFeedback) showToast(result.message, true);
      sendResponse(result);
    });
    return true;
  });
})();
