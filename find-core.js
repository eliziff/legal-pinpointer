'use strict';

(function exposeFindCore(global) {
  if (global.LegalPinpointerFindCore && typeof module === 'undefined') return;
  // Exact mode never stems; ranked mode folds words for scoring only. Offsets
  // always refer to the original page text. Nothing is searched remotely.
  const segmenters = new Map();
  const WORD = '[\\p{L}\\p{N}\\p{M}_]';
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function tokenize(query) {
    if (query.length > 1024) throw new Error('Keep the query under 1,024 characters.');
    const tokens = [];
    const pattern = /\s+|"[^"]*"|[()]|[^\s()"]+/gy;
    let offset = 0;
    while (offset < query.length) {
      pattern.lastIndex = offset;
      const match = pattern.exec(query);
      if (!match) throw new Error('Close the quotation mark.');
      offset = pattern.lastIndex;
      const value = match[0];
      if (!value.trim()) continue;
      const type = value[0] === '"' ? 'term'
        : /^(?:AND|OR|NOT)$/i.test(value) ? value.toUpperCase()
          : /^(?:\/p|\/s)$/i.test(value) ? 'scope'
            : value === '(' || value === ')' ? value : 'term';
      tokens.push({ type, value, start: match.index, end: offset });
    }
    if (tokens.length > 64) throw new Error('Use at most 64 query terms and operators.');
    return tokens;
  }

  function compile(query, mode = 'p') {
    const tokens = tokenize(String(query).replace(/[“”]/g, '"'));
    const scopes = new Set(tokens.filter((token) => token.type === 'scope').map((token) => token.value.toLowerCase()[1]));
    if (scopes.size > 1) throw new Error('Use one scope, /p or /s. Tab switches the whole query.');
    mode = scopes.values().next().value || mode;
    if (!['p', 's'].includes(mode)) throw new Error('Choose paragraph or sentence mode.');
    let position = 0;
    let positiveTerms = 0;

    function primary(negated = false) {
      const token = tokens[position++];
      if (!token) throw new Error('Add a term after the operator.');
      if (token.type === 'NOT') return { type: 'NOT', child: primary(!negated) };
      if (token.type === '(') {
        const node = expression(negated);
        if (tokens[position++]?.type !== ')') throw new Error('Close the parenthesis.');
        return node;
      }
      if (token.type !== 'term') throw new Error('Expected a word or a quoted phrase.');
      const quoted = token.value[0] === '"';
      let term = quoted ? token.value.slice(1, -1).trim() : token.value;
      if (!term) throw new Error('Add text inside the quotation marks.');
      if (!quoted && /^\//.test(term)) throw new Error('Only /p and /s proximity operators are supported.');
      const wildcard = !quoted && term.endsWith('*');
      if (wildcard) term = term.slice(0, -1);
      if (!quoted && (!term || term.includes('*'))) throw new Error('Use * only after a word, for example privileg*.');
      if (!negated) positiveTerms += 1;
      const begin = /^[\p{L}\p{N}\p{M}_]/u.test(term) ? `(?<!${WORD})` : '';
      const end = wildcard || /[\p{L}\p{N}\p{M}_]$/u.test(term) ? `(?!${WORD})` : '';
      const source = term.split(/\s+/u).map(escape).join('\\s+');
      return { type: 'term', pattern: new RegExp(`${begin}${source}${wildcard ? `${WORD}*` : ''}${end}`, 'giu') };
    }

    function conjunction(negated) {
      let node = primary(negated);
      while (position < tokens.length && !['OR', ')'].includes(tokens[position].type)) {
        if (['AND', 'scope'].includes(tokens[position].type)) position += 1;
        node = { type: 'AND', left: node, right: primary(negated) };
      }
      return node;
    }

    function expression(negated = false) {
      let node = conjunction(negated);
      while (tokens[position]?.type === 'OR') {
        position += 1;
        node = { type: 'OR', left: node, right: conjunction(negated) };
      }
      return node;
    }

    const tree = tokens.length ? expression() : null;
    if (position !== tokens.length) throw new Error('Unexpected closing parenthesis.');
    function anchored(node, negated = false) {
      if (node.type === 'term') return !negated;
      if (node.type === 'NOT') return anchored(node.child, !negated);
      const conjunction = (node.type === 'AND') !== negated;
      return conjunction ? anchored(node.left, negated) || anchored(node.right, negated)
        : anchored(node.left, negated) && anchored(node.right, negated);
    }
    if (tree && (!positiveTerms || !anchored(tree))) throw new Error('Each alternative must require a positive search term.');
    return { tree, mode };
  }

  function switchScope(query, mode) {
    // Replace only standalone operators, never a literal /p or /s inside quotes.
    return String(query).replace(/"[^"]*"|“[^”]*”|(^|\s)\/[ps](?=\s|$|[()])/gi,
      (match, prefix) => prefix === undefined ? match : `${prefix}/${mode}`);
  }

  function matches(tree, text, rangeLimit = 5000) {
    if (!tree) return [];
    // First establish Boolean truth with existence checks. In particular, do not
    // allocate thousands of ranges for a common word before a later term fails.
    const truth = new Map();
    function test(node) {
      if (truth.has(node)) return truth.get(node);
      let value;
      if (node.type === 'term') {
        node.pattern.lastIndex = 0;
        value = node.pattern.test(text);
      } else if (node.type === 'NOT') value = !test(node.child);
      else value = node.type === 'AND' ? test(node.left) && test(node.right) : test(node.left) || test(node.right);
      truth.set(node, value);
      return value;
    }
    if (!test(tree)) return [];
    const patterns = new Set();
    function collect(node, negated = false) {
      if (test(node) === negated) return;
      if (node.type === 'term') { if (!negated) patterns.add(node.pattern.source); return; }
      if (node.type === 'NOT') collect(node.child, !negated);
      else { collect(node.left, negated); collect(node.right, negated); }
    }
    collect(tree);
    // A bounded merge of regex iterators keeps the first ranges in source order,
    // regardless of query order. Allocation is O(terms + rangeLimit), not hits.
    const cursors = [...patterns].map(source => {
      const pattern = new RegExp(source, 'giu');
      return { pattern, hit: pattern.exec(text) };
    });
    const merged = [];
    let limited = false;
    while (true) {
      let cursor;
      for (const candidate of cursors) if (candidate.hit && (!cursor || candidate.hit.index < cursor.hit.index)) cursor = candidate;
      if (!cursor) break;
      const range = { start: cursor.hit.index, end: cursor.hit.index + cursor.hit[0].length };
      const previous = merged[merged.length - 1];
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else {
        if (merged.length >= rangeLimit) { limited = true; break; }
        merged.push(range);
      }
      cursor.hit = cursor.pattern.exec(text);
    }
    merged.limited = limited;
    return merged;
  }

  function* sentenceUnits(text, locale = 'en') {
    let segmenter = segmenters.get(locale);
    if (!segmenter) {
      try { segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' }); }
      catch (_) { segmenter = new Intl.Segmenter('en', { granularity: 'sentence' }); }
      if (segmenters.size >= 8) segmenters.clear();
      segmenters.set(locale, segmenter);
    }
    let previous = null;
    // ICU sentence boundaries plus a small, explicit legal/title abbreviation guard.
    // This is not a guarantee of linguistic sentence parsing (see README).
    const abbreviation = /\b(?:Mr|Mrs|Ms|Dr|Prof|Mme|Mlle|M|Me|Mtre|vs?|No|Nos|para|paras|ss?|art|arts|al)\.\s*$/iu;
    for (const part of segmenter.segment(text)) {
      const before = previous && text.slice(previous.start, previous.end);
      if (previous && (abbreviation.test(before) || (/(?:\b[A-Z]\.){2,}\s*$/.test(before) && /^\s*\d/.test(part.segment)))) {
        previous.end = part.index + part.segment.length;
      } else {
        if (previous) yield previous;
        previous = { start: part.index, end: part.index + part.segment.length };
      }
    }
    if (previous) yield previous;
  }

  function sentences(text, locale = 'en') { return [...sentenceUnits(text, locale)]; }

  // Ranked mode: plain words (no quotes, parentheses, *, /p, /s or upper-case
  // AND/OR/NOT) in paragraph mode are ranked by BM25 instead of matched exactly.
  // Words not worth highlighting. They still count in BM25, where IDF weighs them.
  const QUIET = new Set(('a an and are as at be but by for from has have he her his i in is it its of on or she that the their them they this to was were ' +
    'which who will with not no what why how when where whether does do did can le la les un une des du de et ou en au aux ce ces cette est sont pas ' +
    'par pour sur dans que qui ne se sa son ses il elle ils elles l d s qu').split(' '));
  function ranked(query, mode = 'p') {
    return mode === 'p' && !/["“”()*]/.test(query) && /[\p{L}\p{N}]/u.test(query) &&
      !String(query).split(/\s+/).some(word => /^(?:AND|OR|NOT)$/.test(word) || /^\//.test(word));
  }
  // Lower case, no accents, light English/French inflection folding (measured:
  // pool A R@30 0.735 -> 0.867 over plain lower case; see FIND.md).
  function fold(word) {
    let w = word.toLowerCase();
    if (/[^\x00-\x7f]/.test(w)) w = w.normalize('NFD').replace(/\p{M}/gu, '');
    if (w.length > 4 && /ies$/.test(w) && !/[ae]ies$/.test(w)) w = `${w.slice(0, -3)}y`;
    else if (w.length > 4 && /aux$/.test(w)) w = `${w.slice(0, -3)}al`;
    else if (w.length > 3 && /(?:eau|eu|au)x$/.test(w)) w = w.slice(0, -1);
    else if (w.length > 3 && /es$/.test(w) && !/[aeo]es$/.test(w)) w = w.slice(0, -1);
    else if (w.length > 3 && /s$/.test(w) && !/(?:us|ss|is)$/.test(w)) w = w.slice(0, -1);
    if (w.length > 5 && /ing$/.test(w)) w = w.slice(0, -3);
    else if (w.length > 4 && /ed$/.test(w) && !/eed$/.test(w)) w = w.slice(0, -2);
    if (w.length > 4 && /e$/.test(w)) w = w.slice(0, -1);
    return w;
  }
  // Words are [\p{L}\p{N}][\p{L}\p{N}\p{M}]*, scanned by character code with an
  // ASCII fast path (3-4x faster than the equivalent regex on judgment text).
  const LETTER = /^[\p{L}\p{N}]$/u, PART = /^[\p{L}\p{N}\p{M}]$/u;
  const ascii = c => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57);
  // Each word of text[from, to) as visit(start, end, hashA, hashB): two 32-bit
  // FNV-style hashes of its code units, so an index can find a known word form
  // without making a string of it.
  function eachWordAt(text, visit, from = 0, to = text.length) {
    const width = (at, c) => {
      if (c < 0xd800 || c > 0xdbff) return 1;
      const next = text.charCodeAt(at + 1);
      return next >= 0xdc00 && next <= 0xdfff && at + 1 < to ? 2 : 1;
    };
    for (let i = from; i < to;) {
      let c = text.charCodeAt(i), size = width(i, c);
      if (!(c < 128 ? ascii(c) : LETTER.test(text.substr(i, size)))) { i += size; continue; }
      let j = i, a = 0x811c9dc5, b = 0x9747b28c;
      do {
        for (let k = 0; k < size; k++) { const unit = text.charCodeAt(j + k); a = Math.imul(a ^ unit, 16777619); b = Math.imul(b ^ unit, 0x5bd1e995); }
        j += size;
        if (j >= to) break;
        c = text.charCodeAt(j); size = width(j, c);
      } while (c < 128 ? ascii(c) : PART.test(text.substr(j, size)));
      visit(i, j, a, b);
      i = j;
    }
  }
  function eachWord(text, visit) {
    text = String(text);
    eachWordAt(text, (start, end) => visit(text.slice(start, end), start));
  }
  // Unique folded query terms; `marked` are the ones worth highlighting.
  function rankTerms(query) {
    const terms = [], seen = new Set();
    eachWord(String(query), word => { const term = fold(word); if (!seen.has(term)) { seen.add(term); terms.push(term); } });
    const quiet = terms.filter(term => QUIET.has(term));
    return { terms: terms.slice(0, 64), marked: new Set(quiet.length === terms.length ? terms : terms.filter(term => !QUIET.has(term))) };
  }
  // Okapi BM25 (k1 1.2, b 0.75) of one unit from corpus-wide statistics.
  function bm25(tfs, length, dfs, units, averageLength) {
    let score = 0;
    const norm = 1.2 * (0.25 + 0.75 * length / (averageLength || 1));
    for (let i = 0; i < tfs.length; i++) {
      if (!tfs[i] || !dfs[i]) continue;
      score += Math.log(1 + (units - dfs[i] + 0.5) / (dfs[i] + 0.5)) * tfs[i] * 2.2 / (tfs[i] + norm);
    }
    return score;
  }

  // Offsets of the query words worth marking in one unit or, when none occurs,
  // of any query word: at most `limit`, in text order. `termOf` may cache fold.
  function rankHits(text, terms, marked, limit = 100, termOf = fold) {
    const hits = [], loose = [];
    eachWord(text, (word, at) => {
      if (hits.length >= limit) return;
      const term = termOf(word);
      if (marked.has(term)) hits.push({ start: at, end: at + word.length });
      else if (!hits.length && loose.length < limit && terms.has(term)) loose.push({ start: at, end: at + word.length });
    });
    return hits.length ? hits : loose;
  }
  // The hit that starts the window (`lead` characters before it, `width` long)
  // holding the most distinct matched words (hits in text order). The window
  // slides forward, so each hit enters and leaves it once.
  function densest(text, hits, lead = 90, width = 460) {
    const words = hits.map(hit => text.slice(hit.start, hit.end).toLowerCase()), counts = new Map();
    let anchor = hits[0]?.start ?? 0, best = 0, first = 0, next = 0;
    for (const hit of hits) {
      const from = hit.start - lead;
      for (; next < hits.length && hits[next].end <= from + width; next++) counts.set(words[next], (counts.get(words[next]) || 0) + 1);
      for (; first < next && hits[first].start < from; first++) { const left = counts.get(words[first]) - 1; if (left) counts.set(words[first], left); else counts.delete(words[first]); }
      if (counts.size > best) { best = counts.size; anchor = hit.start; }
    }
    return anchor;
  }
  // A 460-character excerpt of text[from, to) starting 90 characters before
  // `anchor`, with the hits inside it as marks.
  function excerpt(text, hits, anchor, from = 0, to = text.length) {
    const start = Math.max(from, anchor - 90), end = Math.min(to, start + 460);
    return { preview: text.slice(start, end), leading: start > from, trailing: end < to,
      marks: hits.map(h => ({ start: h.start - start, end: Math.min(end, h.end) - start }))
        .filter(h => h.start >= 0 && h.start < end - start).slice(0, 50) };
  }
  // cyrb53: a 53-bit hash naming a unit's exact text in result handles.
  function hash(text) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  const api = { compile, matches, sentences, sentenceUnits, switchScope, ranked, fold, eachWord, eachWordAt, rankTerms, bm25, rankHits, densest, excerpt, hash };
  global.LegalPinpointerFindCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
