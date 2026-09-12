'use strict';

(function exposeFind(global) {
  const WORD = '[\\p{L}\\p{N}\\p{M}_]';
  const BLOCK = 'p, li, dd, dt, td, th, pre, blockquote, h1, h2, h3, h4, h5, h6, div, section';
  const segmenters = new Map();
  const HIGHLIGHTS = ['legal-pinpointer-find-hits', 'legal-pinpointer-find-current'];

  function parseQuery(value) {
    const query = String(value || '').replace(/[“”]/g, '"');
    if (query.length > 2048) throw new Error('Use a query of at most 2,048 characters.');
    const tokens = query.match(/"[^"\n]*"|\S+/gu) || [];
    const terms = [];
    let mode = '';
    for (const token of tokens) {
      if (/^\/[ps]$/i.test(token)) {
        const next = token.slice(1).toLowerCase();
        if (mode && mode !== next) throw new Error('Use one proximity mode; Tab switches /p and /s.');
        mode = next;
        continue;
      }
      const quoted = token.startsWith('"') && token.endsWith('"') && token.length > 1;
      if (token.includes('"') && !quoted) throw new Error('Close the quotation marks around your phrase.');
      const text = (quoted ? token.slice(1, -1) : token).trim();
      if (!text) continue;
      if (!quoted && /^(?:AND|OR|NOT|\/.*)$/.test(text)) {
        throw new Error('Use words, "quoted phrases", and trailing *; combine all terms with /p or /s.');
      }
      const prefix = text.endsWith('*');
      const literal = prefix ? text.slice(0, -1) : text;
      if (!literal || literal.includes('*')) throw new Error('Use * only at the end of a word or phrase.');
      let pattern = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      if (/^[\p{L}\p{N}\p{M}_]/u.test(literal)) pattern = `(?<!${WORD})${pattern}`;
      if (prefix) pattern += `${WORD}*`;
      if (prefix || /[\p{L}\p{N}\p{M}_]$/u.test(literal)) pattern += `(?!${WORD})`;
      terms.push(new RegExp(pattern, 'giu'));
    }
    if (terms.length > 32) throw new Error('Use at most 32 search terms.');
    return { terms, mode };
  }

  // Intl handles punctuation/locale; join common legal-reference and title splits.
  // This is sentence detection, not a reproduction of CanLII's server tokenizer.
  function sentenceSpans(text, locale = 'en') {
    if (!global.Intl || !Intl.Segmenter) throw new Error('Sentence mode requires a Chrome version with Intl.Segmenter.');
    if (!segmenters.has(locale)) segmenters.set(locale, new Intl.Segmenter(locale, { granularity: 'sentence' }));
    const segments = Array.from(segmenters.get(locale).segment(text));
    const spans = [];
    for (const segment of segments) {
      const previous = spans[spans.length - 1];
      const before = previous ? text.slice(previous.start, previous.end).trimEnd() : '';
      const after = segment.segment.trimStart();
      const title = /\b(?:Mr|Mrs|Ms|Dr|Mme|Mlle|Hon|Me)\.$/u.test(before);
      const reference = /\b(?:ss?|pp?|paras?|arts?|nos?|par)\.$/iu.test(before) && /^[\d([]/u.test(after);
      const versus = /\b(?:v|c)\.$/u.test(before);
      const initials = /(?:\b[A-Z]\.){2,}$/u.test(before) && /^[\d([]/u.test(after);
      if (previous && (title || reference || versus || initials)) previous.end = segment.index + segment.segment.length;
      else spans.push({ start: segment.index, end: segment.index + segment.segment.length });
    }
    return spans;
  }

  function searchParagraphs(paragraphs, parsed, mode, locale = 'en') {
    const results = [];
    if (!parsed.terms.length) return results;
    for (const paragraph of paragraphs) {
      const spans = mode === 's'
        ? (paragraph.sentences || (paragraph.sentences = sentenceSpans(paragraph.text, locale)))
        : [{ start: 0, end: paragraph.text.length }];
      for (const span of spans) {
        const text = paragraph.text.slice(span.start, span.end);
        const hits = [];
        let matches = true;
        for (const term of parsed.terms) {
          term.lastIndex = 0;
          const occurrences = Array.from(text.matchAll(term));
          if (!occurrences.length) { matches = false; break; }
          for (const hit of occurrences) hits.push({ start: span.start + hit.index, end: span.start + hit.index + hit[0].length });
        }
        if (matches) results.push({ paragraph, ...span, hits });
      }
    }
    return results;
  }

  function collectParagraphs(base, fragments) {
    const root = base.root;
    const document = root.ownerDocument;
    const index = fragments.buildTextIndex(root);
    const cuts = new Set([0, index.text.length]);
    const owners = new WeakMap();
    let previous = null;
    let previousNode = null;
    const positions = [];
    // Physical paragraphs remain separate, including unnumbered quotations.
    // Inline markup does not introduce a boundary. No document nodes are edited.
    for (let i = 0; i < index.points.length; i += 1) {
      const point = index.points[i];
      if (!point || point.node === previousNode) continue;
      previousNode = point.node;
      positions.push({ point, offset: i });
      let owner = owners.get(point.node);
      if (!owner) {
        owner = point.node.parentElement.closest(BLOCK) || root;
        owners.set(point.node, owner);
      }
      if (previous && owner !== previous) cuts.add(i);
      previous = owner;
    }
    // Older CanLII documents can expose standalone anchors instead of <p> tags.
    for (const marker of base.nativeNodes || []) {
      if (marker.kind !== 'paragraph' || !root.contains(marker.element)) continue;
      const boundary = document.createRange();
      boundary.setStartBefore(marker.element);
      boundary.collapse(true);
      let low = 0;
      let high = positions.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        const { point } = positions[mid];
        if (boundary.comparePoint(point.node, point.start) < 0) low = mid + 1;
        else high = mid;
      }
      if (low < positions.length) cuts.add(positions[low].offset);
    }
    const sorted = Array.from(cuts).sort((a, b) => a - b);
    const paragraphs = [];
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const start = sorted[i];
      const text = index.text.slice(start, sorted[i + 1]);
      if (text.trim()) paragraphs.push({ text, start, index });
    }
    return paragraphs;
  }

  function domRange(document, paragraph, hit) {
    const points = paragraph.index.points;
    let start = paragraph.start + hit.start;
    let end = paragraph.start + hit.end - 1;
    while (start <= end && !points[start]) start += 1;
    while (end >= start && !points[end]) end -= 1;
    if (start > end || !points[start].node.isConnected || !points[end].node.isConnected) return null;
    const range = document.createRange();
    range.setStart(points[start].node, points[start].start);
    range.setEnd(points[end].node, points[end].end);
    return range;
  }

  function install(document, location) {
    if (!['canlii.org', 'www.canlii.org'].includes(location.hostname.toLowerCase())) return;
    if (document.getElementById('legal-pinpointer-find')) return;
    const view = document.defaultView;
    let panel, input, modeButton, status, previousButton, nextButton;
    let open = false, mode = 'p', current = -1, results = [], paragraphs = [];
    let root = null, observer = null, dirty = true, timer = 0, returnFocus = null;
    const locale = /^fr\b/i.test(document.documentElement.lang) ? 'fr' : 'en';

    function clearHighlights() {
      for (const name of HIGHLIGHTS) view.CSS?.highlights?.delete(name);
    }

    function make(tag, className, text, parent) {
      const element = document.createElement(tag);
      element.className = className;
      if (text) element.textContent = text;
      parent.appendChild(element);
      return element;
    }

    function updateMode() {
      modeButton.textContent = `/${mode}`;
      modeButton.setAttribute('aria-label', `${mode === 'p' ? 'Same paragraph' : 'Same sentence'}; switch mode`);
      input.placeholder = mode === 'p' ? 'Terms in the same paragraph' : 'Terms in the same sentence';
    }

    function showCurrent(scroll = true) {
      const result = results[current];
      previousButton.disabled = nextButton.disabled = !result;
      view.CSS?.highlights?.delete(HIGHLIGHTS[1]);
      if (!result) return;
      const active = new view.Highlight();
      active.priority = 2;
      for (const hit of result.hits) {
        const range = domRange(document, result.paragraph, hit);
        if (range) active.add(range);
      }
      view.CSS.highlights.set(HIGHLIGHTS[1], active);
      status.textContent = `${current + 1} of ${results.length} ${mode === 'p' ? 'paragraph' : 'sentence'}${results.length === 1 ? '' : 's'}`;
      const first = active.values().next().value;
      if (scroll && first) {
        const rect = first.getBoundingClientRect();
        view.scrollBy({ top: rect.top - Math.max(140, view.innerHeight / 3), behavior: 'instant' });
      }
    }

    function refreshIndex() {
      const base = global.LegalPinpointerProviders.inspectCanlii(document, location);
      if (!base?.root || base.root === document.body || !base.root.isConnected) {
        throw new Error('No CanLII document text found on this page.');
      }
      root = base.root;
      paragraphs = collectParagraphs(base, global.LegalPinpointerTextFragments);
      dirty = false;
      observer?.disconnect();
      observer = new view.MutationObserver(() => {
        dirty = true;
        clearHighlights();
        schedule();
      });
      observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'class', 'style'] });
    }

    function search(scroll = true) {
      view.clearTimeout(timer);
      timer = 0;
      if (!open) return;
      clearHighlights();
      results = [];
      current = -1;
      previousButton.disabled = nextButton.disabled = true;
      input.removeAttribute('aria-invalid');
      try {
        const parsed = parseQuery(input.value);
        if (parsed.mode) mode = parsed.mode;
        updateMode();
        if (!parsed.terms.length) { status.textContent = 'Enter words or "quoted phrases"; trailing * matches word endings.'; return; }
        if (!view.CSS?.highlights || !view.Highlight) throw new Error('Update Chrome to use in-page search highlighting.');
        if (dirty || !root?.isConnected) refreshIndex();
        results = searchParagraphs(paragraphs, parsed, mode, locale);
        if (!results.length) { status.textContent = `No matching ${mode === 'p' ? 'paragraphs' : 'sentences'}`; return; }
        const all = new view.Highlight();
        for (const result of results) {
          for (const hit of result.hits) {
            const range = domRange(document, result.paragraph, hit);
            if (range) all.add(range);
          }
        }
        view.CSS.highlights.set(HIGHLIGHTS[0], all);
        current = 0;
        showCurrent(scroll);
      } catch (error) {
        clearHighlights();
        results = [];
        current = -1;
        input.setAttribute('aria-invalid', 'true');
        status.textContent = error.message || 'Search could not read this document.';
      }
    }

    function schedule() {
      view.clearTimeout(timer);
      timer = view.setTimeout(() => search(), 100);
    }

    function toggleMode() {
      mode = mode === 'p' ? 's' : 'p';
      // Update explicit operators too, but never text inside a quoted phrase.
      input.value = input.value.replace(/[“”]/g, '"').replace(/"[^"\n]*"|(?:^|\s)\/[ps](?=\s|$)/gi, token => token.startsWith('"') ? token : token.replace(/\/[ps]$/i, `/${mode}`));
      search();
      input.focus({ preventScroll: true });
    }

    function move(delta) {
      if (timer || dirty || !root?.isConnected) { search(); return; }
      if (!results.length) return;
      current = (current + delta + results.length) % results.length;
      showCurrent();
    }

    function close() {
      const restoreFocus = panel.contains(document.activeElement);
      open = false;
      panel.hidden = true;
      view.clearTimeout(timer);
      timer = 0;
      observer?.disconnect();
      clearHighlights();
      results = [];
      paragraphs = [];
      root = null;
      dirty = true;
      if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    }

    function show() {
      if (!panel) {
        panel = make('section', 'legal-pinpointer-find', '', document.documentElement);
        panel.id = 'legal-pinpointer-find';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Legal Pinpointer find in page');
        const row = make('div', 'legal-pinpointer-find__row', '', panel);
        input = make('input', 'legal-pinpointer-find__input', '', row);
        input.type = 'text';
        input.maxLength = 2048;
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-label', 'Find terms in this CanLII document');
        input.setAttribute('aria-describedby', 'legal-pinpointer-find-status legal-pinpointer-find-help');
        modeButton = make('button', 'legal-pinpointer-find__mode', '/p', row);
        previousButton = make('button', 'legal-pinpointer-find__button', '↑', row);
        nextButton = make('button', 'legal-pinpointer-find__button', '↓', row);
        const dismiss = make('button', 'legal-pinpointer-find__button', '×', row);
        for (const [button, label, action] of [
          [modeButton, 'Switch paragraph/sentence mode (Tab)', toggleMode],
          [previousButton, 'Previous match (Shift+Enter)', () => move(-1)],
          [nextButton, 'Next match (Enter)', () => move(1)],
          [dismiss, 'Close (Escape)', close]
        ]) {
          button.type = 'button';
          button.title = label;
          button.setAttribute('aria-label', label);
          button.addEventListener('click', action);
        }
        status = make('div', 'legal-pinpointer-find__status', '', panel);
        status.id = 'legal-pinpointer-find-status';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        const help = make('div', 'legal-pinpointer-find__help', 'Tab: /p ↔ /s · Enter: next · Shift+Enter: previous · Esc: close', panel);
        help.id = 'legal-pinpointer-find-help';
        input.addEventListener('input', schedule);
      }
      if (!open) returnFocus = document.activeElement;
      open = true;
      panel.hidden = false;
      updateMode();
      search(false);
      input.focus({ preventScroll: true });
      input.select();
    }

    document.addEventListener('keydown', event => {
      if (event.isComposing) return;
      const shortcut = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 's';
      const inside = open && panel.contains(event.target);
      let action = null;
      if (shortcut) action = show;
      else if (open && event.key === 'Escape') action = close;
      else if (inside && !event.ctrlKey && !event.altKey && !event.metaKey) {
        if (event.key === 'Tab' && !event.shiftKey && event.target === input) action = toggleMode;
        if (event.key === 'Enter' && event.target === input) action = () => move(event.shiftKey ? -1 : 1);
      }
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) action();
    }, true);
  }

  const api = { parseQuery, sentenceSpans, searchParagraphs, collectParagraphs, domRange, install };
  global.LegalPinpointerFind = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (global.document) install(global.document, global.location);
})(globalThis);
