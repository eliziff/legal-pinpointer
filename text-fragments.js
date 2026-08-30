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

  function buildTextIndex(root) {
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

  function buildStructureIndex(root) {
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

  function occurrences(haystack, needle, from) {
    const output = [];
    if (!needle) return output;
    let index = haystack.indexOf(needle, from || 0);
    while (index >= 0) {
      output.push(index);
      index = haystack.indexOf(needle, index + Math.max(needle.length, 1));
    }
    return output;
  }

  function contextMatches(text, start, end, directive) {
    const prefix = normalizeTerm(directive.prefix).toLocaleLowerCase();
    const suffix = normalizeTerm(directive.suffix).toLocaleLowerCase();
    const before = text.slice(0, start).trimEnd();
    const after = text.slice(end).trimStart();
    return (!prefix || before.endsWith(prefix)) && (!suffix || after.startsWith(suffix));
  }

  function matchDirective(index, directive) {
    const searchable = index.text.toLocaleLowerCase();
    const startTerm = normalizeTerm(directive.start).toLocaleLowerCase();
    const endTerm = normalizeTerm(directive.end).toLocaleLowerCase();
    const starts = occurrences(searchable, startTerm, 0);

    for (const start of starts) {
      const startEnd = start + startTerm.length;
      if (!endTerm) {
        if (contextMatches(searchable, start, startEnd, directive)) return { start, end: startEnd };
        continue;
      }
      for (const endStart of occurrences(searchable, endTerm, startEnd)) {
        const end = endStart + endTerm.length;
        if (contextMatches(searchable, start, end, directive)) return { start, end };
      }
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
    const index = buildTextIndex(root);
    const matches = directives.map((directive) => matchDirective(index, directive)).filter(Boolean);
    if (!matches.length) return null;
    const combined = {
      start: Math.min(...matches.map((match) => match.start)),
      end: Math.max(...matches.map((match) => match.end))
    };
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
