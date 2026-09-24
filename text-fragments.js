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
  // CanLII renders scanned reporter pages as one positioned span per printed line.
  const LINE_ELEMENTS = '.pdf-viewer-line';

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return null;
    }
  }

  // A text directive as Chromium parses it (TextFragmentSelector::FromTextDirective): at most four
  // comma-separated terms, a prefix marked by a trailing '-' and a suffix by a leading '-', no other
  // raw '-', valid percent-escapes, and every term used exactly as decoded, never trimmed.
  function parseDirective(directive) {
    const value = String(directive || '');
    if (!value.startsWith('text=')) return null;
    const body = value.slice(5);
    if (/%(?![0-9A-Fa-f]{2})/.test(body)) return null;
    const parts = body.split(',');
    if (parts.length > 4) return null;
    const valid = (term) => Boolean(term) && !term.includes('-');
    let prefix = '';
    let suffix = '';
    if (parts[0].endsWith('-')) {
      prefix = parts.shift().slice(0, -1);
      if (!valid(prefix) || !parts.length) return null;
    }
    if (parts[parts.length - 1].startsWith('-')) {
      suffix = parts.pop().slice(1);
      if (!valid(suffix) || !parts.length) return null;
    }
    if (parts.length > 2 || !parts.every(valid)) return null;
    const decoded = [prefix, parts[0], parts[1] || '', suffix].map(safeDecode);
    if (decoded.some((term) => term === null) || !decoded[1]) return null;
    return { prefix: decoded[0], start: decoded[1], end: decoded[2], suffix: decoded[3] };
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

  function isHidden(element, view, cache, selector = NON_SEARCHABLE) {
    if (!element) return false;
    if (cache.has(element)) return cache.get(element);
    let result = Boolean(element.closest && element.closest(selector));
    if (!result && view && typeof view.getComputedStyle === 'function') {
      const style = view.getComputedStyle(element);
      result = style.display === 'none' || style.visibility === 'hidden';
    }
    cache.set(element, result);
    return result;
  }

  // Newlines inside preformatted text (CanLII's <pre style="white-space: pre-wrap"> judgments) are
  // visible line breaks.
  function isPreformatted(element, view, cache) {
    if (!element) return false;
    if (cache.has(element)) return cache.get(element);
    const style = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(element).whiteSpace : '';
    const result = Boolean(element.closest('pre')) || /^pre/.test(style || '');
    cache.set(element, result);
    return result;
  }

  // ---- What the browser searches ----------------------------------------------------------------
  // Chromium matches text directives against FindBuffer (blink/renderer/core/editing/finder/
  // find_buffer.cc); this index reproduces it, as checked case by case against Chrome by
  // tools/fragment-quirks.cjs:
  // - the whole <body> is searched, in flat-tree order, so open shadow roots are included;
  // - the text is laid-out text: whitespace collapses as CSS white-space says, a non-breaking space
  //   never collapses, and preserved newlines and <br> are line feeds that no term matches across;
  // - every block-level box (anything but display inline, contents or ruby, so inline-block, floats,
  //   positioned boxes and flex or grid items too) is a buffer of its own, and no term spans two;
  // - display: none subtrees, <noscript>, unrendered SVG, and the contents of script, style, img,
  //   iframe, object, video, audio, canvas, meter, progress, select and void elements are skipped
  //   (ShouldIgnoreContents); aria-hidden, off-screen and hidden=until-found text is searched, and a
  //   text control's value is searched as a block of its own;
  // - text that is laid out but not visible (visibility, inert) is left out of the buffer after
  //   layout has collapsed whitespace around it, so "a <hidden>b</hidden> c" searches as "a  c";
  // - a laid-out ignored element inside a line (an inline <img>) stops any term matching across it,
  //   written here as U+FFFC; nothing else is there, so a prefix or suffix still reaches past it.
  // `permissive` models newer Chromium (FindBufferMatchAcrossIgnoredNodes and
  // FindBufferCollapseSkippedSpace, stable on main after Chrome 153): terms match across ignored
  // elements and the spaces around skipped text collapse. Built links must land under both.
  // `text` holds '\n' at every block boundary and line break; `runs` map the rest back to the DOM.
  const INLINE_DISPLAY = /^(?:inline|contents|ruby|ruby-base|ruby-text|ruby-base-container|ruby-text-container)$/;
  const IGNORED_CONTENTS = new Set([
    'AREA', 'AUDIO', 'BASE', 'CANVAS', 'COL', 'EMBED', 'HR', 'IFRAME', 'IMG', 'LINK', 'META', 'METER',
    'OBJECT', 'PARAM', 'PROGRESS', 'SCRIPT', 'SELECT', 'SOURCE', 'STYLE', 'TRACK', 'VIDEO', 'WBR'
  ]);
  const TEXT_INPUT_TYPES = /^(?:text|search|email|url|tel|number|submit|reset|button)$/;
  const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
  const SVG_UNRENDERED = new Set([
    'clipPath', 'defs', 'desc', 'filter', 'linearGradient', 'marker', 'mask', 'metadata', 'pattern',
    'radialGradient', 'script', 'style', 'symbol', 'title'
  ]);
  const OBJECT = String.fromCharCode(0xFFFC);
  const NBSP = /\xA0/g;

  function flatChildren(element) {
    let shadow = element.shadowRoot;
    const dom = global.chrome && global.chrome.dom;
    if (!shadow && dom && typeof dom.openOrClosedShadowRoot === 'function') {
      try {
        shadow = dom.openOrClosedShadowRoot(element);
      } catch (_) {
        shadow = null;
      }
    }
    if (shadow) return shadow.childNodes;
    if (element.tagName === 'SLOT' && typeof element.assignedNodes === 'function') {
      const assigned = element.assignedNodes();
      if (assigned.length) return assigned;
    }
    return element.childNodes;
  }

  function whitespaceMode(style) {
    const collapse = style.whiteSpaceCollapse;
    if (collapse) {
      return {
        spaces: collapse === 'collapse' || collapse === 'preserve-breaks',
        breaks: collapse === 'preserve' || collapse === 'preserve-breaks' || collapse === 'break-spaces'
      };
    }
    const value = style.whiteSpace || 'normal';
    return { spaces: /^(?:normal|nowrap|pre-line)$/.test(value), breaks: !/^(?:normal|nowrap)$/.test(value) };
  }

  const isCssSpace = (code) => code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
  // Characters no term contains and the browser steps over between a prefix, a term and a suffix.
  const isGap = (code) => isCssSpace(code) || code === 0xFFFC;

  function buildTextIndex(root, options = {}) {
    const permissive = Boolean(options.permissive);
    const document = root.ownerDocument || root;
    const view = document.defaultView;
    const chunks = [];
    const runs = [];
    const lineBreaks = new Set();
    let length = 0;
    let lineStart = true;
    let pending = null;
    // Inline elements open around the current node within its block, and those that end in a stop.
    let openInline = [];
    const separatedAtEnd = new Set();
    // Whether newer Chromium would search this page differently (invisible text, inline images).
    let differsWhenPermissive = false;

    function push(value, node, offset) {
      if (node) {
        const last = runs[runs.length - 1];
        if (last && last.node === node && last.offset + last.length === offset && last.at + last.length === length) {
          last.length += value.length;
        } else {
          runs.push({ at: length, node, offset, length: value.length });
        }
      }
      chunks.push(value);
      length += value.length;
      lineStart = false;
    }

    // A collapsible space is kept only once something follows it on the same line, and is searched
    // only if its own text is visible.
    function flush() {
      if (!pending) return;
      const space = pending;
      pending = null;
      if (space.visible) push(' ', space.node, space.offset);
    }

    function lineBreak() {
      pending = null;
      lineBreaks.add(length);
      chunks.push('\n');
      length += 1;
      lineStart = true;
    }

    function blockBoundary() {
      pending = null;
      if (!lineStart) {
        chunks.push('\n');
        length += 1;
      }
      lineStart = true;
    }

    function appendText(node, mode, visible) {
      const value = node.nodeValue || '';
      for (let offset = 0; offset < value.length;) {
        const code = value.charCodeAt(offset);
        if (isCssSpace(code)) {
          if (mode.breaks && code === 10) {
            if (visible) lineBreak();
            else {
              pending = null;
              lineStart = true;
            }
          } else if (mode.breaks && code === 13) {
            // A carriage return belongs to the line break that follows it.
          } else if (mode.spaces) {
            if (!pending && !lineStart) pending = { node, offset, visible };
          } else {
            flush();
            if (visible) push(code === 9 ? '\t' : ' ', node, offset);
            else lineStart = false;
          }
          offset += 1;
          continue;
        }
        let end = offset + 1;
        while (end < value.length && !isCssSpace(value.charCodeAt(end))) end += 1;
        flush();
        if (visible) push(value.slice(offset, end).replace(NBSP, ' '), node, offset);
        else lineStart = false;
        offset = end;
      }
    }

    function controlText(element) {
      if (element.tagName === 'TEXTAREA') return element.value;
      return TEXT_INPUT_TYPES.test(element.type) ? element.value : '';
    }

    function visit(node, style, inert) {
      if (node.nodeType === 3) {
        if (!style) return;
        const visible = style.visibility === 'visible' && !inert;
        if (!visible) differsWhenPermissive = true;
        if (visible || !permissive) appendText(node, whitespaceMode(style), visible);
        return;
      }
      if (node.nodeType === 11) {
        for (const child of node.childNodes) visit(child, style, inert);
        return;
      }
      if (node.nodeType !== 1 || node.tagName === 'NOSCRIPT') return;
      const own = view.getComputedStyle(node);
      if (own.display === 'none') return;
      const isInert = inert || node.inert === true;
      const visible = own.visibility === 'visible' && !isInert;
      if (node.tagName === 'BR') {
        if (visible) lineBreak();
        return;
      }
      const svg = node.namespaceURI === SVG_NAMESPACE;
      // SVG lays out only its text elements; titles, descriptions and definitions have no box.
      if (svg && SVG_UNRENDERED.has(node.localName)) return;
      const block = !INLINE_DISPLAY.test(own.display) || (svg && node.localName === 'text');
      if (block) blockBoundary();
      if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
        const value = visible ? String(controlText(node) || '').replace(/\r/g, '').replace(NBSP, ' ') : '';
        if (value.trim()) {
          blockBoundary();
          push(value, null);
          blockBoundary();
        }
      } else if (IGNORED_CONTENTS.has(node.tagName)) {
        // Chrome 153 also stops terms at the end of every inline element around a laid-out one.
        if (!block && !permissive && node.tagName !== 'WBR') {
          differsWhenPermissive = true;
          flush();
          push(OBJECT, null);
          openInline.forEach((element) => separatedAtEnd.add(element));
        }
      } else if (!(own.contentVisibility === 'hidden' && node.getAttribute('hidden') !== 'until-found')) {
        const enclosing = openInline;
        openInline = block ? [] : [...enclosing, node];
        for (const child of flatChildren(node)) visit(child, own, isInert);
        openInline = enclosing;
        if (separatedAtEnd.has(node)) {
          flush();
          push(OBJECT, null);
        }
      }
      if (block) blockBoundary();
    }

    visit(root, null, false);
    return { text: chunks.join(''), runs, lineBreaks, root, permissive, differsWhenPermissive };
  }

  // The run holding index offset `at`, or null for a synthetic character (line break, control text).
  function runAt(index, at) {
    const runs = index.runs;
    let low = 0;
    let high = runs.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (runs[middle].at <= at) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const run = runs[found];
    return run && at < run.at + run.length ? run : null;
  }

  // Index offset of a DOM boundary: the first searchable character at or after it (start), or the
  // offset just past the last searchable character before it (end).
  function indexOffset(index, container, offset, end) {
    const document = container.ownerDocument || container;
    const boundary = document.createRange();
    boundary.setStart(container, offset);
    const home = container.getRootNode();
    // Shadow-tree text compares by its host's place in the boundary's tree.
    const compare = (node, nodeOffset) => {
      let target = node;
      while (target.getRootNode() !== home && target.getRootNode().host) target = target.getRootNode().host;
      try {
        return target === node ? boundary.comparePoint(node, nodeOffset) : boundary.comparePoint(target, 0);
      } catch (_) {
        return 1;
      }
    };
    const runs = index.runs;
    if (!end) {
      let low = 0;
      let high = runs.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        const run = runs[middle];
        if (compare(run.node, run.offset + run.length - 1) >= 0) high = middle;
        else low = middle + 1;
      }
      if (low === runs.length) return index.text.length;
      const run = runs[low];
      const skip = run.node === container ? Math.max(0, offset - run.offset) : 0;
      return run.at + Math.min(skip, run.length - 1);
    }
    let low = -1;
    let high = runs.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      const run = runs[middle];
      if (compare(run.node, run.offset + 1) <= 0) low = middle;
      else high = middle - 1;
    }
    if (low < 0) return 0;
    const run = runs[low];
    const keep = run.node === container ? Math.min(run.length, offset - run.offset) : run.length;
    return run.at + Math.max(1, keep);
  }

  // DOM boundary of an index offset: the start of the character at `at`, or the end of the one
  // before it.
  function domPoint(index, at, end) {
    const run = runAt(index, end ? at - 1 : at);
    return run ? { node: run.node, offset: run.offset + at - run.at } : null;
  }

  const samePoint = (a, b) => Boolean(a && b && a.node === b.node && a.offset === b.offset);

  // DOM range for index offsets [start, end), snapped inward to searchable characters.
  function domRange(document, index, match) {
    let first = null;
    for (let at = match.start; at < match.end && !first; at += 1) {
      const run = runAt(index, at);
      if (run) first = { node: run.node, offset: run.offset + at - run.at };
    }
    let last = null;
    for (let at = match.end - 1; at >= match.start && !last; at -= 1) {
      const run = runAt(index, at);
      if (run) last = { node: run.node, offset: run.offset + at - run.at + 1 };
    }
    if (!first || !last) return null;
    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset);
    return range;
  }

  // ---- How the browser compares text --------------------------------------------------------------
  // Chromium searches case-insensitively with an ICU collator at primary strength
  // (text_searcher_icu.cc), after folding single and double quotation marks (curly, low-9 and
  // reversed) to straight ones and soft hyphens away (FoldQuoteMarksAndSoftHyphens). Primary strength
  // ignores case, accents and other marks, and compatibility differences (ligatures, full-width forms,
  // non-breaking and typographic spaces), and treats a few letters as their base letters
  // (legal-structure's browser_key). Format and control characters are ignorable. Whitespace and
  // punctuation stay significant: primes, guillemets, dashes and the dotless i do not fold.
  const FOLDS = new Map([
    ['æ', 'ae'], ['œ', 'oe'], ['ø', 'o'], ['ł', 'l'], ['ŀ', 'l'], ['ð', 'd'], ['đ', 'd'], ['ħ', 'h'],
    ['ß', 'ss'], ['ς', 'σ'],
    ['“', '"'], ['”', '"'], ['„', '"'], ['‟', '"'], ['״', '"'],
    ['‘', "'"], ['’', "'"], ['‚', "'"], ['‛', "'"], ['׳', "'"]
  ]);
  const IGNORABLE = /[\p{M}\p{Cf}\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;

  function foldCharacter(character) {
    const code = character.charCodeAt(0);
    if (code < 0x80) {
      if (code >= 65 && code <= 90) return String.fromCharCode(code + 32);
      return (code < 32 && code !== 9 && code !== 10) || code === 127 ? '' : character;
    }
    let value = '';
    for (const lower of character.toLowerCase()) value += FOLDS.has(lower) ? FOLDS.get(lower) : lower;
    return value.normalize('NFKD').replace(IGNORABLE, '');
  }

  function browserKey(value) {
    let key = '';
    for (const character of String(value || '')) key += foldCharacter(character);
    return key;
  }

  // Folded search text, with `map` from folded units to index offsets and `inverse` back.
  const PRINTABLE_ASCII = /[\t\n\x20-\x7E]+/y;

  function folded(index) {
    if (index.folded) return index.folded;
    const text = index.text;
    const pieces = [];
    let map = new Int32Array(text.length + 16);
    const inverse = new Int32Array(text.length + 1);
    let size = 0;
    const reserve = (units) => {
      if (size + units < map.length) return;
      const grown = new Int32Array(Math.max(map.length * 2, size + units + 1));
      grown.set(map);
      map = grown;
    };
    for (let offset = 0; offset < text.length;) {
      // Printable ASCII folds by lowercasing alone, one unit per character.
      PRINTABLE_ASCII.lastIndex = offset;
      const plain = PRINTABLE_ASCII.exec(text);
      if (plain) {
        const run = plain[0];
        pieces.push(run.toLowerCase());
        reserve(run.length);
        for (let unit = 0; unit < run.length; unit += 1) {
          map[size + unit] = offset + unit;
          inverse[offset + unit] = size + unit;
        }
        size += run.length;
        offset += run.length;
        continue;
      }
      const code = text.codePointAt(offset);
      const width = code > 0xFFFF ? 2 : 1;
      inverse[offset] = size;
      if (width === 2) inverse[offset + 1] = size;
      const key = foldCharacter(text.slice(offset, offset + width));
      pieces.push(key);
      reserve(key.length);
      for (let unit = 0; unit < key.length; unit += 1) map[size + unit] = offset;
      size += key.length;
      offset += width;
    }
    inverse[text.length] = size;
    reserve(1);
    map[size] = text.length;
    index.folded = { value: pieces.join(''), map: map.subarray(0, size + 1), inverse, occurrences: new Map() };
    return index.folded;
  }

  // Word boundaries as ICU's word break iterator finds them (Chromium's FindWordStartBoundary and
  // FindWordEndBoundary); Intl.Segmenter runs the same rules. Whitespace always bounds a word.
  const wordSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null;
  const WORD_CHARACTER = /[\p{L}\p{N}]/u;

  function isWordBoundary(index, offset) {
    const text = index.text;
    if (offset <= 0 || offset >= text.length) return true;
    const before = text.charCodeAt(offset - 1);
    const after = text.charCodeAt(offset);
    if (before === 32 && after === 32) return false;
    if (isGap(before) || isGap(after)) return true;
    if (!wordSegmenter) return !(WORD_CHARACTER.test(text[offset - 1]) && WORD_CHARACTER.test(text[offset]));
    let start = offset - 1;
    while (start > 0 && !isGap(text.charCodeAt(start - 1))) start -= 1;
    if (!index.words) index.words = new Map();
    let boundaries = index.words.get(start);
    if (!boundaries) {
      let end = offset + 1;
      while (end < text.length && !isGap(text.charCodeAt(end))) end += 1;
      boundaries = new Set([end]);
      for (const segment of wordSegmenter.segment(text.slice(start, end))) boundaries.add(start + segment.index);
      index.words.set(start, boundaries);
    }
    return boundaries.has(offset);
  }

  function occurrences(fold, term) {
    let list = fold.occurrences.get(term);
    if (!list) {
      list = [];
      for (let at = fold.value.indexOf(term); at >= 0; at = fold.value.indexOf(term, at + 1)) list.push(at);
      fold.occurrences.set(term, list);
    }
    return list;
  }

  // First occurrence of `term` at or after folded offset `from` (FindBuffer::FindMatchInRange with
  // the requested word-bounded start and end). Offsets are folded offsets.
  function findTerm(index, term, from, startBounded, endBounded) {
    const fold = folded(index);
    const { value, map } = fold;
    const list = occurrences(fold, term);
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (list[middle] < from) low = middle + 1;
      else high = middle;
    }
    for (let at = low; at < list.length; at += 1) {
      const start = list[at];
      const end = start + term.length;
      // A match starts and ends on whole characters, never inside a folded expansion.
      if (start > 0 && map[start - 1] === map[start]) continue;
      if (end < value.length && map[end] === map[end - 1]) continue;
      if (startBounded && !isWordBoundary(index, map[start])) continue;
      if (endBounded && !isWordBoundary(index, map[end])) continue;
      return { start, end };
    }
    return null;
  }

  // TextFragmentFinder::NextTextPosition: the first character after `at` that is not whitespace
  // (an ignored element in between has no characters to step over).
  function nextTextPosition(index, at) {
    const value = folded(index).value;
    let cursor = at;
    while (cursor < value.length && isGap(value.charCodeAt(cursor))) cursor += 1;
    return cursor;
  }

  // FirstWordBoundaryAfter: one position past the end of the word that starts at `at`.
  function afterWord(index, at) {
    const fold = folded(index);
    let offset = fold.map[at] + 1;
    while (offset < index.text.length && !isWordBoundary(index, offset)) offset += 1;
    return fold.inverse[Math.min(index.text.length, offset + 1)];
  }

  // TextFragmentFinder's state machine, run from folded offset `from`: prefix, then the start term
  // right after it, then the first end term after the start, then the suffix right after that. An
  // exact match whose suffix does not follow restarts from the next word; a range match keeps its
  // start and looks for a later end.
  function findFrom(index, terms, from) {
    const length = folded(index).value.length;
    const endAtWord = Boolean(terms.end) || !terms.suffix;
    let matchStart = from;
    for (;;) {
      if (matchStart >= length) return null;
      let start;
      if (terms.prefix) {
        const prefix = findTerm(index, terms.prefix, matchStart, true, false);
        if (!prefix) return null;
        matchStart = afterWord(index, prefix.start);
        const expected = nextTextPosition(index, prefix.end);
        start = findTerm(index, terms.start, expected, false, endAtWord);
        if (!start) return null;
        if (start.start !== expected) continue;
      } else {
        start = findTerm(index, terms.start, matchStart, true, endAtWord);
        if (!start) return null;
        matchStart = afterWord(index, start.start);
      }
      let end = start.end;
      let searchEnd = start.end;
      for (;;) {
        if (terms.end) {
          const found = findTerm(index, terms.end, searchEnd, true, !terms.suffix);
          if (!found) return null;
          end = found.end;
        }
        if (!terms.suffix) return { start: start.start, end };
        const expected = nextTextPosition(index, end);
        const suffix = findTerm(index, terms.suffix, expected, false, true);
        if (!suffix) return null;
        if (suffix.start === expected) return { start: start.start, end };
        if (!terms.end) break;
        searchEnd = end;
      }
    }
  }

  // Where the browser lands for a directive: its first match (index offsets) and whether it is the
  // only one, which Chromium decides by searching again from the end of the first match.
  function findDirective(index, directive) {
    const terms = {};
    for (const name of ['prefix', 'start', 'end', 'suffix']) {
      terms[name] = browserKey(directive[name]);
      // A term made only of ignorable characters matches nothing.
      if (directive[name] && !terms[name]) return null;
    }
    if (!terms.start) return null;
    const first = findFrom(index, terms, 0);
    if (!first) return null;
    const { map } = folded(index);
    return { start: map[first.start], end: map[first.end], unique: !findFrom(index, terms, first.end) };
  }

  // Same bytes as legal-structure's encode_text_fragment: only ASCII letters, digits and _ . ~ stay
  // literal, so dash, ampersand and comma can never collide with directive syntax.
  function encodeTerm(value) {
    return Array.from(new TextEncoder().encode(String(value || '')), (byte) => (
      /[A-Za-z0-9_.~]/.test(String.fromCharCode(byte)) && byte < 0x80
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    )).join('');
  }

  function directiveText(directive) {
    return `text=${directive.prefix ? `${encodeTerm(directive.prefix)}-,` : ''}${encodeTerm(directive.start)}`
      + `${directive.end ? `,${encodeTerm(directive.end)}` : ''}${directive.suffix ? `,-${encodeTerm(directive.suffix)}` : ''}`;
  }

  const lineStartOf = (text, at) => text.lastIndexOf('\n', at - 1) + 1;
  const lineEndOf = (text, at) => {
    const end = text.indexOf('\n', at);
    return end < 0 ? text.length : end;
  };
  // No term spans a line break or an ignored element, so builder segments stop at both.
  const segmentStartOf = (text, at) => Math.max(text.lastIndexOf('\n', at - 1), text.lastIndexOf(OBJECT, at - 1)) + 1;
  const segmentEndOf = (text, at) => Math.min(lineEndOf(text, at), ...[text.indexOf(OBJECT, at)].filter((end) => end >= 0));
  const isGapAt = (text, at) => at >= 0 && at < text.length && isGap(text.charCodeAt(at));

  function tokensIn(text, from, to) {
    const tokens = [];
    const pattern = new RegExp(`[^\\s${OBJECT}]+`, 'g');
    pattern.lastIndex = from;
    for (let match = pattern.exec(text); match && match.index < to; match = pattern.exec(text)) {
      tokens.push({ start: match.index, end: Math.min(to, match.index + match[0].length) });
    }
    return tokens;
  }

  // Passage edges the reference planner drops as fragile (legal-structure text_fragment.rs,
  // adjust_span_edges): leading paragraph and provision labels, an order's "[n]AND CONSIDERING",
  // a numbered item's "n – ", and trailing footnote-range artifacts; and, as there, punctuation
  // standing alone at either edge and a final line holding only the next passage's label.
  const LEADING_LABELS = [
    /^\[\s*[0-9]{1,4}\s*\]\s*/u,
    /^[0-9]{1,4}\]\s*/u,
    /^[0-9]{1,4}(?:\.[0-9]{1,4})*\s*(?:\(\s*[A-Za-z0-9]{1,5}\s*\)\s*)+(?:[.;:]\s*(?:\(\s*[A-Za-z0-9]{1,5}\s*\)\s*)*)?/u,
    // A parenthesised year opening a footnote ("(1961), 1961 CanLII 523") is citation text.
    /^\((?!\s*[12][0-9]{3}\s*\))\s*[A-Za-z0-9]{1,5}\s*\)\s*/u
  ];
  // An item letter needs the wide spacing of a list ("b.   Pay"); "s. 50.4" is an abbreviation.
  const BLOCK_NUMBER = /^(?:[0-9]{1,4}\.\s+|(?:[a-z]|[ivxl]{1,6})\.(?:\s{2,}|\t))/u;
  const LEADING_ATTACHED = [/^(\[\s*\d{1,4}\s*\])AND\s+CONSIDERING\b/u, /^(\d{1,4}\s+[–—]\s+)\p{Lu}/u];
  const TRAILING_ARTIFACT = /\s*[.,;:]?\[\s*[0-9]{1,4}(?:\s*[-–—,;]\s*[0-9]{1,4})+\s*\]\s*$/u;
  const LONE_LABEL = /^(?:\[\s*\d{1,4}\s*\]|\d{1,4}\]|\d{1,4}(?:\.\d{1,4})*\.?|\(\s*[A-Za-z0-9]{1,5}\s*\))$/u;

  function trimEdges(text, from, to) {
    const trim = (start, end) => {
      let a = start;
      let b = end;
      while (a < b && isGapAt(text, a)) a += 1;
      while (b > a && isGapAt(text, b - 1)) b -= 1;
      return [a, b];
    };
    let [start, end] = trim(from, to);
    // Labels are markers only where a passage opens its block; "20(1) of the Act" inside a sentence
    // is text. A number or item letter opening a block ("33.   The whole", "b.   Pay") is one too.
    if (!text.slice(segmentStartOf(text, start), start).trim()) {
      const attached = LEADING_ATTACHED.map((pattern) => pattern.exec(text.slice(start, end))).find(Boolean);
      if (attached) start += attached[1].length;
      for (;;) {
        const value = text.slice(start, end);
        const rest = value.trimEnd().length;
        const label = [...LEADING_LABELS, BLOCK_NUMBER].map((pattern) => pattern.exec(value)).find((found) => found && found[0].length < rest);
        if (!label) break;
        start += label[0].length;
      }
    }
    for (let artifact = TRAILING_ARTIFACT.exec(text.slice(start, end)); artifact && end - artifact[0].length > start;
      artifact = TRAILING_ARTIFACT.exec(text.slice(start, end))) {
      end -= artifact[0].length;
    }
    const lastLine = text.lastIndexOf('\n', end - 1);
    if (lastLine > start && LONE_LABEL.test(text.slice(lastLine + 1, end).trim())) end = lastLine;
    [start, end] = trim(start, end);
    const detached = (token) => !WORD_CHARACTER.test(text.slice(token.start, token.end));
    for (let tokens = tokensIn(text, start, end); tokens.length > 1 && detached(tokens[0]); tokens.shift()) start = tokens[1].start;
    for (let tokens = tokensIn(text, start, end); tokens.length > 1 && detached(tokens[tokens.length - 1]); tokens.pop()) {
      end = tokens[tokens.length - 2].end;
    }
    return start < end ? [start, end] : trim(from, to);
  }

  // Chromium's TextFragmentSelectorGenerator: exact text up to 300 characters inside one block, at
  // least 20 characters before it may stand without context, and range ends and context that start
  // at three words and grow a word at a time to ten. Those ten-word ceilings are generator
  // preferences, not limits of the search, so here both keep growing (by half again) up to their
  // whole block when a passage repeats (a quotation quoted twice), within the reference planner's
  // 8,192-character URL bound and a fixed number of candidates.
  const EXACT_MAX_CHARS = 300;
  const NO_CONTEXT_MIN_CHARS = 20;
  const MIN_WORDS = 3;
  const MAX_DIRECTIVE_LENGTH = 7000;
  const MAX_CANDIDATES = 600;

  function growingSizes(first, available) {
    const sizes = [];
    for (let words = first; words < available; words = words < 10 ? words + 1 : Math.ceil(words * 1.5)) sizes.push(words);
    if (available) sizes.push(available);
    return sizes;
  }

  // Builds a text directive for `range` on this page, verified against the browser's own search
  // for both current Chrome and Chromium's newer, more permissive search: the passage (whole words,
  // fragile edges dropped) must be the directive's first match. A directive whose match is also the
  // only one is preferred (Chromium's generator insists on it); otherwise, as in the reference
  // planner, it is enough that the passage is the first match. Candidates follow Chromium's generator
  // (exact text, then range ends of growing length, then context of growing length) with the
  // reference planner's safeguards for short range ends: the start is unique under its prefix, the
  // end is unique under its suffix, and, with no suffix, the end does not also occur inside the
  // passage. Context comes
  // only from `contextRoot` (the document, not page chrome, whose counts and dates change).
  // Returns { directive, range } or null.
  function buildPassageLink(range, options = {}) {
    const document = range.startContainer.ownerDocument;
    const index = options.index || buildTextIndex(document.body);
    const contextRoot = options.contextRoot || document.body;
    const text = index.text;
    let from = indexOffset(index, range.startContainer, range.startOffset, false);
    let to = indexOffset(index, range.endContainer, range.endOffset, true);
    if (!(from < to)) return null;
    // Whole words, as Chromium's AdjustSelection and the planner's whitespace atoms take them.
    if (!isGapAt(text, from)) while (from > 0 && !isGapAt(text, from - 1)) from -= 1;
    if (!isGapAt(text, to - 1)) while (to < text.length && !isGapAt(text, to)) to += 1;
    [from, to] = trimEdges(text, from, to);
    const tokens = tokensIn(text, from, to);
    if (!tokens.length) return null;

    const slice = (list) => (list.length ? text.slice(list[0].start, list[list.length - 1].end) : '');
    const firstLineEnd = segmentEndOf(text, from);
    const sameLine = firstLineEnd >= to;
    const head = tokens.filter((token) => token.end <= firstLineEnd);
    const tail = tokens.filter((token) => token.start >= segmentStartOf(text, to));

    const cores = [];
    if (sameLine && to - from <= EXACT_MAX_CHARS) {
      // The planner never lets a single word stand bare.
      cores.push({ start: slice(tokens), end: '', bare: tokens.length > 1 && to - from >= NO_CONTEXT_MIN_CHARS });
    }
    if (tokens.length > 1) {
      // Start and end may not overlap; on one line they share its words.
      const available = sameLine ? Math.floor(tokens.length / 2) : Math.max(head.length, tail.length);
      const first = sameLine ? Math.min(MIN_WORDS, available) : MIN_WORDS;
      let previous = '';
      for (const words of growingSizes(first, available)) {
        const start = head.slice(0, words);
        const end = tail.slice(-words);
        const key = `${slice(start)}\n${slice(end)}`;
        if (key === previous) continue;
        previous = key;
        cores.push({ start: slice(start), end: slice(end), headWords: start.length, tailStart: end[0].start, bare: true });
      }
    }

    // Context: the words just before and after the passage, each from its own single block and
    // from the document itself.
    const inRoot = (token) => {
      const run = runAt(index, token.start);
      return Boolean(run && contextRoot.contains(run.node));
    };
    let before = from;
    while (before > 0 && isGapAt(text, before - 1)) before -= 1;
    const prefixTokens = before > 0 ? tokensIn(text, segmentStartOf(text, before), before) : [];
    while (prefixTokens.length && !inRoot(prefixTokens[0])) prefixTokens.shift();
    let after = to;
    while (after < text.length && isGapAt(text, after)) after += 1;
    const suffixTokens = after < text.length ? tokensIn(text, after, segmentEndOf(text, after)) : [];
    while (suffixTokens.length && !inRoot(suffixTokens[suffixTokens.length - 1])) suffixTokens.pop();

    const fold = folded(index);
    let permissive = options.permissiveIndex || null;
    // 'unique' when the passage is the only match, 'first' when it is the first of several, else ''.
    const landing = (directive, start, end) => {
      const found = findDirective(index, directive);
      if (!found || found.start !== start || found.end !== end) return '';
      permissive = permissive || (index.differsWhenPermissive ? buildTextIndex(document.body, { permissive: true }) : index);
      const later = findDirective(permissive, directive);
      if (!later || !samePoint(domPoint(permissive, later.start, false), domPoint(index, start, false))
        || !samePoint(domPoint(permissive, later.end, true), domPoint(index, end, true))) return '';
      return found.unique && later.unique ? 'unique' : 'first';
    };
    const safeRange = (core, prefix, suffix) => {
      if (!core.end || core.headWords >= MIN_WORDS) return true;
      if (landing({ prefix, start: core.start, end: '', suffix: '' }, from, from + core.start.length) !== 'unique') return false;
      if (landing({ prefix: '', start: core.end, end: '', suffix }, core.tailStart, to) !== 'unique') return false;
      // With a suffix the browser passes over earlier ends that lack it (as the search above does).
      if (suffix) return true;
      const key = browserKey(core.end);
      const earliest = fold.inverse[from + core.start.length];
      const latest = fold.inverse[core.tailStart];
      return !occurrences(fold, key).some((at) => at >= earliest && at < latest
        && isWordBoundary(index, fold.map[at]) && isWordBoundary(index, fold.map[at + key.length]));
    };

    const tried = new Set();
    let fallback = null;
    const accept = (core, prefix, suffix) => {
      const directive = { prefix, start: core.start, end: core.end, suffix };
      const encoded = directiveText(directive);
      if (tried.has(encoded) || encoded.length > MAX_DIRECTIVE_LENGTH || tried.size >= MAX_CANDIDATES) return '';
      tried.add(encoded);
      const landed = landing(directive, from, to);
      if (!landed || !safeRange(core, prefix, suffix)) return '';
      if (landed === 'first') {
        fallback = fallback || encoded;
        return '';
      }
      return encoded;
    };
    const found = (encoded) => ({ directive: encoded, range: domRange(document, index, { start: from, end: to }) });
    for (const core of cores) {
      const encoded = core.bare && accept(core, '', '');
      if (encoded) return found(encoded);
    }
    for (const words of growingSizes(MIN_WORDS, Math.max(prefixTokens.length, suffixTokens.length))) {
      const prefix = slice(prefixTokens.slice(-words));
      const suffix = slice(suffixTokens.slice(0, words));
      for (const core of cores) {
        for (const [p, s] of [[prefix, ''], ['', suffix], [prefix, suffix]]) {
          if (!p && !s) continue;
          const encoded = accept(core, p, s);
          if (encoded) return found(encoded);
        }
      }
    }
    return fallback ? found(fallback) : null;
  }

  // The passage at a DOM point as the browser's search sees it: the block (or line) holding the
  // point, and in preformatted or <br>-broken text the lines between blank lines.
  function passageRange(node, offset, index = buildTextIndex(node.ownerDocument.body)) {
    const document = node.ownerDocument;
    const text = index.text;
    const at = indexOffset(index, node, offset, false);
    let start = lineStartOf(text, at);
    let end = lineEndOf(text, at);
    const blank = (from, to) => !text.slice(from, to).trim();
    if (blank(start, end)) return null;
    while (start > 0 && index.lineBreaks.has(start - 1)) {
      const previous = lineStartOf(text, start - 1);
      if (blank(previous, start - 1)) break;
      start = previous;
    }
    while (end < text.length && index.lineBreaks.has(end)) {
      const next = lineEndOf(text, end + 1);
      if (blank(end + 1, next)) break;
      end = next;
    }
    return domRange(document, index, { start, end });
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

    const preformattedCache = new WeakMap();
    const preformatted = (element) => isPreformatted(element, view, preformattedCache);

    function appendText(node) {
      const value = node.nodeValue || '';
      const keepLines = value.includes('\n') && preformatted(node.parentElement);
      for (let offset = 0; offset < value.length;) {
        const codePoint = value.codePointAt(offset);
        const width = codePoint > 0xFFFF ? 2 : 1;
        const character = value.slice(offset, offset + width);
        const point = { node, start: offset, end: offset + width };
        if (keepLines && character === '\n') {
          appendNewline();
        } else if (/\s/u.test(character)) {
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
      const block = BLOCK_TAGS.has(node.tagName) || node.matches(LINE_ELEMENTS);
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

  // Boundary of a structure-plane offset (buildStructureIndex).
  function boundaryPoint(index, offset) {
    const at = Math.max(0, Math.min(index.points.length, Number(offset) || 0));
    const after = mappedPoint(index.points, at, 1);
    if (after) return { node: after.node, offset: after.start };
    const before = mappedPoint(index.points, at - 1, -1);
    return before ? { node: before.node, offset: before.end } : null;
  }

  // The passage a text-fragment URL highlights on this page: each directive's first match in the
  // whole body (where the browser searches), combined into one range.
  function resolveUrl(value, root) {
    const directives = directivesFromUrl(value);
    if (!directives.length || !root) return null;
    const document = root.ownerDocument || root;
    const index = buildTextIndex(document.body || root);
    const matches = directives.map((directive) => findDirective(index, directive)).filter(Boolean);
    if (!matches.length) return null;
    const combined = {
      start: Math.min(...matches.map((match) => match.start)),
      end: Math.max(...matches.map((match) => match.end))
    };
    const range = domRange(document, index, combined);
    if (!range) return null;
    return { range, matches, url: String(value).trim(), text: range.toString() };
  }

  const api = {
    boundaryPoint,
    browserKey,
    buildPassageLink,
    buildStructureIndex,
    buildTextIndex,
    directivesFromUrl,
    documentIdentity,
    extractUrl,
    findDirective,
    isForDocument,
    parseDirective,
    passageRange,
    resolveUrl,
    scalarToUtf16Map
  };

  global.LegalPinpointerTextFragments = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
