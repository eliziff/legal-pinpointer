'use strict';

(function exposeTextFragments(global) {
  const core = global.LegalPinpointerCore;
  if (!core) throw new Error('LegalPinpointerCore must load before text-fragments.js');

  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
    'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
    'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
  ]);
  const NON_SEARCHABLE = 'script, style, noscript, template, [hidden], [aria-hidden="true"]';

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return '';
    }
  }

  function parseDirective(directive) {
    if (!String(directive || '').startsWith('text=')) return null;
    const parts = directive.slice(5).split(',');
    let prefix = '';
    let suffix = '';
    if (parts.length && parts[0].endsWith('-')) prefix = parts.shift().slice(0, -1);
    if (parts.length && parts[parts.length - 1].startsWith('-')) suffix = parts.pop().slice(1);
    if (parts.length < 1 || parts.length > 2) return null;

    const parsed = {
      prefix: safeDecode(prefix).trim(),
      start: safeDecode(parts[0]).trim(),
      end: safeDecode(parts[1] || '').trim(),
      suffix: safeDecode(suffix).trim()
    };
    return parsed.start ? parsed : null;
  }

  function directivesFromUrl(value) {
    const text = String(value || '').trim();
    const hash = text.indexOf('#');
    if (hash < 0) return [];
    const marker = text.indexOf(':~:', hash);
    if (marker < 0) return [];
    return text.slice(marker + 3)
      .split('&')
      .filter((part) => part.startsWith('text='))
      .map(parseDirective)
      .filter(Boolean);
  }

  function asFragmentUrl(value) {
    const candidate = String(value || '').trim();
    try {
      const url = new URL(candidate);
      return /^https?:$/i.test(url.protocol) && directivesFromUrl(candidate).length ? candidate : '';
    } catch (_) {
      return '';
    }
  }

  function unwrap(value) {
    let text = String(value || '').trim();
    const pairs = new Map([['<', '>'], ['(', ')'], ['[', ']'], ['{', '}'], ['"', '"'], ["'", "'"]]);
    while (text.length > 1 && pairs.get(text[0]) === text[text.length - 1]) text = text.slice(1, -1).trim();
    return text;
  }

  function extractUrl(value) {
    const text = String(value || '').trim();
    const direct = asFragmentUrl(unwrap(text));
    if (direct) return direct;

    const matches = text.matchAll(/https?:\/\/[^\s<>"']+/g);
    for (const match of matches) {
      let candidate = match[0];
      const wrapper = new Map([['(', ')'], ['[', ']'], ['{', '}']]).get(text[match.index - 1]);
      if (wrapper && candidate.endsWith(wrapper)) candidate = candidate.slice(0, -1);
      if (candidate !== text) candidate = candidate.replace(/[.,;]+$/g, '');
      const found = asFragmentUrl(candidate);
      if (found) return found;
    }
    return '';
  }

  function providerForUrl(url) {
    const host = url.hostname.toLowerCase();
    if (host === 'advance.lexis.com') return 'lexis';
    if (host.endsWith('westlaw.com')) return 'westlaw';
    if (host === 'canlii.org' || host === 'www.canlii.org') return 'canlii';
    return 'generic';
  }

  function documentIdentity(value) {
    try {
      const url = new URL(value);
      const provider = providerForUrl(url);
      const clean = provider === 'generic'
        ? new URL(`${url.origin}${url.pathname}`)
        : new URL(core.cleanProviderUrl(provider, url.href));
      clean.hash = '';
      if (clean.pathname.length > 1) clean.pathname = clean.pathname.replace(/\/+$/, '');
      return clean.toString();
    } catch (_) {
      return '';
    }
  }

  function isForDocument(fragmentUrl, acceptedUrls) {
    if (!directivesFromUrl(fragmentUrl).length) return false;
    const wanted = documentIdentity(fragmentUrl);
    return Boolean(wanted && (acceptedUrls || []).some((value) => documentIdentity(value) === wanted));
  }

  function normalizeTerm(value) {
    return String(value || '').replace(/\s+/gu, ' ').trim();
  }

  function isHidden(element, view, cache) {
    if (!element) return false;
    if (cache.has(element)) return cache.get(element);
    let result = Boolean(element.closest && element.closest(NON_SEARCHABLE));
    if (!result && view && typeof view.getComputedStyle === 'function') {
      const style = view.getComputedStyle(element);
      result = style.display === 'none' || style.visibility === 'hidden';
    }
    cache.set(element, result);
    return result;
  }

  // Internal fast path: one mapping record per source run, not per character.
  // The public default still exposes the legacy points array for existing tools.
  function buildCompactIndex(root, structural, mapPoints = true) {
    const chunks = [], runs = [], hiddenCache = new WeakMap();
    const view = root.ownerDocument && root.ownerDocument.defaultView;
    let length = 0, last = '', pending = null;
    function append(text, point) {
      if (point && mapPoints) {
        const prior = runs.at(-1);
        if (prior && prior.node === point.node && prior.to === length
            && prior.offset + prior.to - prior.from === point.offset) prior.to += text.length;
        else runs.push({ from: length, to: length + text.length, ...point });
      }
      chunks.push(text); length += text.length; last = text.slice(-1);
    }
    function separator() {
      pending = null;
      if (structural && last === ' ') {
        chunks.pop(); length -= 1;
        if (runs.at(-1)?.from === length) runs.pop();
        last = chunks.at(-1)?.slice(-1) || '';
      }
      const value = structural ? '\n' : ' ';
      if (length && last !== value) append(value);
    }
    function textNode(node) {
      const value = node.nodeValue || '';
      // Ordinary prose already has single ASCII spaces. Append that source run
      // once rather than allocating a regex result and chunk for every word.
      // Irregular/Unicode whitespace retains the exact normalization path below.
      if (structural && value && !/[^\S ]| {2}/u.test(value)) {
        const from = value[0] === ' ' ? 1 : 0;
        const to = value.endsWith(' ') ? value.length - 1 : value.length;
        if (from) pending ||= { node, offset: 0 };
        if (to > from) {
          if (pending && length && last !== ' ' && last !== '\n') append(' ', pending);
          pending = null;
          append(value.slice(from, to), { node, offset: from });
        }
        if (to < value.length) pending ||= { node, offset: Math.max(0, to) };
        return;
      }
      for (const match of value.matchAll(/\s+|\S+/gu)) {
        const text = match[0];
        if (/^\s/u.test(text)) {
          if (structural) pending ||= { node, offset: match.index };
          else separator();
        } else {
          if (structural && pending && length && last !== ' ' && last !== '\n') append(' ', pending);
          pending = null;
          append(text, { node, offset: match.index });
        }
      }
    }
    const stack = [{ node: root }];
    while (stack.length) {
      const item = stack.pop();
      if (item.children) {
        if (item.at < item.children.length) {
          stack.push(item);
          stack.push({ node: item.children[item.at++] });
        }
        continue;
      }
      if (item.exit) { separator(); continue; }
      const node = item.node;
      if (node.nodeType === 3) {
        if (!isHidden(node.parentElement, view, hiddenCache)) textNode(node);
        continue;
      }
      if (node.nodeType !== 1 || isHidden(node, view, hiddenCache)) continue;
      const block = BLOCK_TAGS.has(node.tagName);
      if (block || node.tagName === 'BR') separator();
      if (block) stack.push({ exit: true });
      if (node.tagName !== 'BR') stack.push({ children: node.childNodes, at: 0 });
    }
    if (structural && last === '\n') { chunks.pop(); length -= 1; }
    return { text: chunks.join(''), runs };
  }

  function compactBoundary(index, offset) {
    const at = Math.max(0, Math.min(index.text.length, Number(offset) || 0));
    if (!Number.isInteger(at)) return null;
    const runs = index.runs;
    let low = 0, high = runs.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (runs[middle].to <= at) low = middle + 1;
      else high = middle;
    }
    const run = runs[low];
    if (!run) {
      const before = runs.at(-1);
      return before ? { node: before.node, offset: before.offset + before.to - before.from } : null;
    }
    let position = run.offset + Math.max(0, at - run.from);
    // Both code units of a surrogate pair map to its original start, as before.
    const text = run.node.nodeValue;
    if (position > run.offset && /[\uDC00-\uDFFF]/.test(text[position]) && /[\uD800-\uDBFF]/.test(text[position - 1])) position -= 1;
    return { node: run.node, offset: position };
  }

  function buildTextIndex(root, compact = false) {
    if (compact) return buildCompactIndex(root, false);
    const characters = [];
    const points = [];
    const view = root.ownerDocument && root.ownerDocument.defaultView;
    const hiddenCache = new WeakMap();

    function appendSpace() {
      if (characters.length && characters[characters.length - 1] !== ' ') {
        characters.push(' ');
        points.push(null);
      }
    }

    function appendText(node) {
      const value = node.nodeValue || '';
      for (let offset = 0; offset < value.length;) {
        const codePoint = value.codePointAt(offset);
        const width = codePoint > 0xFFFF ? 2 : 1;
        const character = value.slice(offset, offset + width);
        if (/\s/u.test(character)) {
          appendSpace();
        } else {
          characters.push(character);
          for (let unit = 0; unit < width; unit += 1) {
            points.push({ node, start: offset, end: offset + width });
          }
        }
        offset += width;
      }
    }

    function visit(node) {
      if (node.nodeType === 3) {
        if (!isHidden(node.parentElement, view, hiddenCache)) appendText(node);
        return;
      }
      if (node.nodeType !== 1 || isHidden(node, view, hiddenCache)) return;
      const block = BLOCK_TAGS.has(node.tagName);
      if (block || node.tagName === 'BR') appendSpace();
      if (node.tagName !== 'BR') {
        for (const child of node.childNodes) visit(child);
      }
      if (block) appendSpace();
    }

    visit(root);
    return { text: characters.join(''), points };
  }

  function buildStructureIndex(root, compact = false) {
    if (compact) return buildCompactIndex(root, true, compact !== 'text');
    const characters = [];
    const points = [];
    const view = root.ownerDocument && root.ownerDocument.defaultView;
    const hiddenCache = new WeakMap();
    let pendingSpace = null;

    function appendNewline() {
      pendingSpace = null;
      if (characters[characters.length - 1] === ' ') {
        characters.pop();
        points.pop();
      }
      if (characters.length && characters[characters.length - 1] !== '\n') {
        characters.push('\n');
        points.push(null);
      }
    }

    function flushSpace() {
      if (!pendingSpace || !characters.length || [' ', '\n'].includes(characters[characters.length - 1])) {
        pendingSpace = null;
        return;
      }
      characters.push(' ');
      points.push(pendingSpace);
      pendingSpace = null;
    }

    function appendText(node) {
      const value = node.nodeValue || '';
      for (let offset = 0; offset < value.length;) {
        const codePoint = value.codePointAt(offset);
        const width = codePoint > 0xFFFF ? 2 : 1;
        const character = value.slice(offset, offset + width);
        const point = { node, start: offset, end: offset + width };
        if (/\s/u.test(character)) {
          if (!pendingSpace) pendingSpace = point;
        } else {
          flushSpace();
          characters.push(character);
          for (let unit = 0; unit < width; unit += 1) points.push(point);
        }
        offset += width;
      }
    }

    function visit(node) {
      if (node.nodeType === 3) {
        if (!isHidden(node.parentElement, view, hiddenCache)) appendText(node);
        return;
      }
      if (node.nodeType !== 1 || isHidden(node, view, hiddenCache)) return;
      const block = BLOCK_TAGS.has(node.tagName);
      if (block || node.tagName === 'BR') appendNewline();
      if (node.tagName !== 'BR') {
        for (const child of node.childNodes) visit(child);
      }
      if (block) appendNewline();
    }

    visit(root);
    pendingSpace = null;
    while (characters.length && /\s/u.test(characters[characters.length - 1])) {
      characters.pop();
      points.pop();
    }
    return { text: characters.join(''), points };
  }

  function scalarToUtf16Map(value) {
    const map = [0];
    let offset = 0;
    for (const character of String(value || '')) {
      offset += character.length;
      map.push(offset);
    }
    return map;
  }

  function matchDirective(searchable, directive) {
    const startTerm = normalizeTerm(directive.start).toLocaleLowerCase();
    const endTerm = normalizeTerm(directive.end).toLocaleLowerCase();
    const prefix = normalizeTerm(directive.prefix).toLocaleLowerCase();
    const suffix = normalizeTerm(directive.suffix).toLocaleLowerCase();
    if (!startTerm) return null;
    // buildTextIndex normalizes whitespace to ASCII spaces. Inspect only the
    // context-sized window, not a slice of the whole document for each candidate.
    const hasPrefix = start => {
      if (!prefix) return true;
      while (start > 0 && searchable[start - 1] === ' ') start -= 1;
      return start >= prefix.length && searchable.slice(start - prefix.length, start) === prefix;
    };
    const hasSuffix = end => {
      if (!suffix) return true;
      while (searchable[end] === ' ') end += 1;
      return searchable.startsWith(suffix, end);
    };
    // Memoize dead endpoint chains. Repeated starts no longer rescan every end
    // when suffix context is absent. Exact non-overlapping occurrence order is
    // preserved even for self-overlapping terms (e.g. "aa" in "aaaaa").
    const failedEnds = new Set();
    let firstEnd = -1;
    for (let start = searchable.indexOf(startTerm); start >= 0;
      start = searchable.indexOf(startTerm, start + startTerm.length)) {
      if (!hasPrefix(start)) continue;
      const startEnd = start + startTerm.length;
      if (!endTerm) {
        if (hasSuffix(startEnd)) return { start, end: startEnd };
        continue;
      }
      if (firstEnd < startEnd) firstEnd = searchable.indexOf(endTerm, startEnd);
      if (firstEnd < 0) return null; // Later starts cannot have an endpoint either.
      if (failedEnds.has(firstEnd)) continue;
      const visited = [];
      for (let at = firstEnd; at >= 0 && !failedEnds.has(at);
        at = searchable.indexOf(endTerm, at + endTerm.length)) {
        const end = at + endTerm.length;
        if (hasSuffix(end)) return { start, end };
        visited.push(at);
      }
      for (const at of visited) failedEnds.add(at);
    }
    return null;
  }

  function mappedPoint(points, offset, direction) {
    if (direction > 0) {
      for (let index = Math.max(0, offset); index < points.length; index += 1) {
        if (points[index]) return points[index];
      }
    } else {
      for (let index = Math.min(points.length - 1, offset); index >= 0; index -= 1) {
        if (points[index]) return points[index];
      }
    }
    return null;
  }

  function boundaryPoint(index, offset) {
    if (index.runs) return compactBoundary(index, offset);
    const at = Math.max(0, Math.min(index.points.length, Number(offset) || 0));
    const after = mappedPoint(index.points, at, 1);
    if (after) return { node: after.node, offset: after.start };
    const before = mappedPoint(index.points, at - 1, -1);
    return before ? { node: before.node, offset: before.end } : null;
  }

  function domRange(document, index, match) {
    const start = boundaryPoint(index, match.start);
    const end = boundaryPoint(index, match.end);
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }

  function resolveUrl(value, root) {
    const directives = directivesFromUrl(value);
    if (!directives.length || !root) return null;
    const index = buildTextIndex(root, true);
    // All directives share this single case-folded view; it is not retained.
    const searchable = index.text.toLocaleLowerCase();
    const matches = directives.map((directive) => matchDirective(searchable, directive)).filter(Boolean);
    if (!matches.length) return null;
    const combined = { start: matches[0].start, end: matches[0].end };
    for (const match of matches) {
      combined.start = Math.min(combined.start, match.start);
      combined.end = Math.max(combined.end, match.end);
    }
    const range = domRange(root.ownerDocument, index, combined);
    if (!range) return null;
    return { range, matches, url: String(value).trim(), text: range.toString() };
  }

  const api = {
    boundaryPoint,
    buildStructureIndex,
    buildTextIndex,
    directivesFromUrl,
    documentIdentity,
    extractUrl,
    isForDocument,
    parseDirective,
    resolveUrl,
    scalarToUtf16Map
  };

  global.LegalPinpointerTextFragments = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
