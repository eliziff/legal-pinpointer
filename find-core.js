'use strict';

(function exposeFindCore(global) {
  if (global.LegalPinpointerFindCore && typeof module === 'undefined') return;
  // Exact mode never stems; ranked mode folds words for scoring only. Offsets
  // always refer to the original page text. Nothing is searched remotely.
  const segmenters = new Map();
  const WORD = '[\\p{L}\\p{N}\\p{M}_]';
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // CanLII's document-text grammar. A document is one page; its paragraphs are
  // the passages shown. AND (or a space), NOT and a leading - apply to the whole
  // page; /p, /s and /n pair terms in one paragraph, sentence or n-word window.
  // Operators bind as on CanLII: OR, /n, /s, /p, NOT, then AND. Words and
  // "phrases" match their variants (the fold ranked mode uses); EXACT(...) and
  // truncation* match the letters given.
  const ACCENTS = new Map();
  for (const c of 'àáâãäåāăąçćĉċčèéêëēĕėęěìíîïĩīĭįñńņňòóôõöøōŏőùúûüũūŭůűųýÿŷœæ') {
    const base = c.normalize('NFD')[0];
    ACCENTS.set(base, (ACCENTS.get(base) || base) + c);
  }
  const loose = (text) => Array.from(text, c => ACCENTS.has(c) ? `[${ACCENTS.get(c)}]` : escape(c)).join('');

  function tokenize(query) {
    if (query.length > 1024) throw new Error('Keep the query under 1,024 characters.');
    const tokens = [], pattern = /\s+|"[^"]*"|exact\([^)]*\)|[()]|-(?=["(])|[^\s()"]+/giy;
    for (let offset = 0; offset < query.length;) {
      pattern.lastIndex = offset;
      const match = pattern.exec(query);
      if (!match) throw new Error(/^exact\(/i.test(query.slice(offset)) ? 'Close the EXACT( parenthesis.' : 'Close the quotation mark.');
      offset = pattern.lastIndex;
      let value = match[0];
      if (!value.trim()) continue;
      if (value[0] === '-' && value.length > 1 && value !== '-') { tokens.push({ type: 'NEG' }); value = value.slice(1); }
      const near = /^\/(\d{1,3}|s|p)$/i.exec(value);
      tokens.push(value === '-' ? { type: 'NEG' } : value[0] === '"' ? { type: 'term', text: value.slice(1, -1), variants: true }
        : /^exact\(/i.test(value) ? { type: 'term', text: value.slice(6, -1), exact: true }
          : /^(?:and|or)$/i.test(value) ? { type: value.toUpperCase() } : value === 'NOT' ? { type: 'NOT' }
            : near ? { type: 'NEAR', op: near[1].toLowerCase() } : value === '(' || value === ')' ? { type: value }
              : { type: 'term', text: value, variants: true, bare: true });
    }
    if (tokens.length > 64) throw new Error('Use at most 64 query terms and operators.');
    return tokens;
  }

  function term(token) {
    const text = token.text.trim();
    if (!text) throw new Error(token.exact ? 'Add text inside EXACT( ).' : 'Add text inside the quotation marks.');
    if (token.bare && /^\//.test(text)) throw new Error('Use /p, /s or a number of words such as /5.');
    const truncated = token.bare && text.endsWith('*'), body = truncated ? text.slice(0, -1) : text;
    if (token.bare && (!body || body.includes('*'))) throw new Error('Use * only after a word, for example privileg*.');
    const words = [];
    const source = body.split(/(\s+)/u).map(piece => /^\s+$/u.test(piece) ? '\\s+' : piece.split(new RegExp(`(${WORD}+)`, 'u')).map((part, i) => {
      if (!(i % 2)) return escape(part);
      if (token.exact) return escape(part);
      if (truncated) return loose(part.toLowerCase());
      const folded = fold(part);
      words.push(folded);
      return `(${loose(folded.slice(0, Math.max(1, folded.length - 2)))}${WORD}*)`;
    }).join('')).join('');
    const begin = new RegExp(`^${WORD}`, 'u').test(body) ? `(?<!${WORD})` : '';
    const end = truncated || new RegExp(`${WORD}$`, 'u').test(body) ? `(?!${WORD})` : '';
    return { type: 'term', words, pattern: new RegExp(`${begin}${source}${truncated ? `${WORD}*` : ''}${end}`, 'giu') };
  }

  function compile(query) {
    const tokens = tokenize(String(query).replace(/[“”]/g, '"'));
    let position = 0;
    const peek = () => tokens[position]?.type;
    function primary() {
      const token = tokens[position++];
      if (!token) throw new Error('Add a term after the operator.');
      if (token.type === 'NOT' || token.type === 'NEG') return { type: 'NOT', child: primary() };
      if (token.type === '(') {
        const node = conjunction();
        if (tokens[position++]?.type !== ')') throw new Error('Close the parenthesis.');
        return node;
      }
      if (token.type !== 'term') throw new Error('Expected a word or a quoted phrase.');
      return term(token);
    }
    const level = (next, accepts, build) => () => {
      let node = next();
      while (accepts(tokens[position])) { const token = tokens[position++]; node = build(node, next(), token); }
      return node;
    };
    const or = level(primary, t => t?.type === 'OR', (left, right) => ({ type: 'OR', left, right }));
    const near = op => (next) => level(next, t => t?.type === 'NEAR' && (op === 'n' ? /^\d/.test(t.op) : t.op === op),
      (left, right, t) => ({ type: 'NEAR', op: op === 'n' ? Number(t.op) : op, left, right }))();
    const words = () => near('n')(or), sentence = () => near('s')(words), paragraph = () => near('p')(sentence);
    const not = level(paragraph, t => t?.type === 'NOT', (left, right) => ({ type: 'AND', left, right: { type: 'NOT', child: right } }));
    function conjunction() {
      let node = not();
      while (position < tokens.length && peek() !== ')') {
        if (peek() === 'AND') position++;
        node = { type: 'AND', left: node, right: not() };
      }
      return node;
    }
    const tree = tokens.length ? conjunction() : null;
    if (position !== tokens.length) throw new Error('Unexpected closing parenthesis.');
    if (tree) check(tree);
    return { tree };
  }
  // Every page-level branch needs a positive term; NOT pairs with a positive
  // term in AND, or with a proximity partner (a /p NOT b: a without b nearby).
  function check(node, top = true) {
    if (node.type === 'term') return;
    if (node.type === 'NOT') { if (top) throw new Error('Each alternative must require a positive search term.'); check(node.child, false); return; }
    if (node.type === 'OR') {
      if (node.left.type === 'NOT' || node.right.type === 'NOT') throw new Error('NOT cannot be an OR alternative.');
      check(node.left, false); check(node.right, false); return;
    }
    const negative = [node.left, node.right].filter(side => side.type === 'NOT');
    if (negative.length === 2) throw new Error('Each alternative must require a positive search term.');
    for (const side of [node.left, node.right]) side.type === 'NOT' ? check(side.child, false) : check(side, node.type === 'AND' && top);
  }

  // Passages of one page matching `tree`: [{ index, hits: [{ start, end }] }] in
  // paragraph order, or [] when the page does not match. `sentencesOf(index)`
  // returns a paragraph's sentence units (only /s asks).
  function search(tree, paragraphs, { sentencesOf = index => sentences(paragraphs[index]), rangeLimit = 5000 } = {}) {
    if (!tree) return [];
    const words = new Map(), sentenceCache = new Map(), memo = new Map();
    const position = (starts, offset) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >>> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; } return lo; };
    const wordAt = (index, offset) => {
      if (!words.has(index)) { const starts = []; eachWordAt(paragraphs[index], start => starts.push(start)); words.set(index, starts); }
      return position(words.get(index), offset);
    };
    const sentenceAt = (index, offset) => {
      if (!sentenceCache.has(index)) sentenceCache.set(index, sentencesOf(index).map(unit => unit.start));
      return position(sentenceCache.get(index), offset);
    };
    const near = (op, index, a, b) => op === 'p' ? true
      : op === 's' ? sentenceAt(index, a.start) <= sentenceAt(index, b.end - 1) && sentenceAt(index, b.start) <= sentenceAt(index, a.end - 1)
        : Math.max(wordAt(index, b.start) - wordAt(index, a.end - 1), wordAt(index, a.start) - wordAt(index, b.end - 1)) <= op;
    // Each node: Map(paragraph index -> spans { start, end, hits }).
    function spans(node) {
      if (memo.has(node)) return memo.get(node);
      let out = new Map();
      if (node.type === 'term') {
        paragraphs.forEach((text, index) => {
          const found = [];
          node.pattern.lastIndex = 0;
          for (let match; (match = node.pattern.exec(text));) {
            if (!match[0]) { node.pattern.lastIndex++; continue; }
            if (node.words.every((word, i) => fold(match[i + 1]) === word)) found.push({ start: match.index, end: match.index + match[0].length, hits: [{ start: match.index, end: match.index + match[0].length }] });
            else node.pattern.lastIndex = match.index + 1;
          }
          if (found.length) out.set(index, found);
        });
      } else if (node.type === 'OR') {
        out = new Map(spans(node.left));
        for (const [index, list] of spans(node.right)) out.set(index, [...(out.get(index) || []), ...list]);
      } else if (node.type === 'AND') {
        const sides = [node.left, node.right];
        if (sides.every(side => side.type === 'NOT' ? !spans(side.child).size : spans(side).size)) {
          for (const side of sides) if (side.type !== 'NOT') for (const [index, list] of spans(side)) out.set(index, [...(out.get(index) || []), ...list]);
        }
      } else if (node.type === 'NEAR') {
        const negative = node.right.type === 'NOT' ? node.right : node.left.type === 'NOT' ? node.left : null;
        const left = spans(negative === node.left ? node.right : node.left), right = spans(negative ? negative.child : node.right);
        for (const [index, list] of left) {
          const partners = right.get(index) || [], kept = [];
          for (const a of list) {
            if (negative) { if (!partners.some(b => near(node.op, index, a, b))) kept.push(a); continue; }
            for (const b of partners) {
              if (kept.length >= 1000) break;
              if (near(node.op, index, a, b)) kept.push({ start: Math.min(a.start, b.start), end: Math.max(a.end, b.end), hits: [...a.hits, ...b.hits] });
            }
          }
          if (kept.length) out.set(index, kept);
        }
      }
      memo.set(node, out);
      return out;
    }
    const passages = [];
    let total = 0, limited = false;
    for (const [index, list] of [...spans(tree)].sort((a, b) => a[0] - b[0])) {
      const merged = [];
      for (const hit of list.flatMap(span => span.hits).sort((a, b) => a.start - b.start || a.end - b.end)) {
        const previous = merged[merged.length - 1];
        if (previous && hit.start <= previous.end) previous.end = Math.max(previous.end, hit.end);
        else merged.push({ ...hit });
      }
      if (total + merged.length > rangeLimit) { merged.length = rangeLimit - total; limited = true; }
      total += merged.length;
      if (merged.length) passages.push({ index, hits: merged });
      if (limited) break;
    }
    passages.limited = limited;
    return passages;
  }
  // One text as a one-paragraph page: its highlight ranges.
  function matches(tree, text, rangeLimit = 5000) {
    const found = search(tree, [text], { rangeLimit }), ranges = found[0]?.hits || [];
    ranges.limited = found.limited;
    return ranges;
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

  // Ranked mode: plain words (no quotes, parentheses, *, EXACT( ), /n, /s, /p,
  // -word or upper-case AND/OR/NOT) are ranked by BM25 instead of matched exactly.
  // Words not worth highlighting. They still count in BM25, where IDF weighs them.
  const QUIET = new Set(('a an and are as at be but by for from has have he her his i in is it its of on or she that the their them they this to was were ' +
    'which who will with not no what why how when where whether does do did can le la les un une des du de et ou en au aux ce ces cette est sont pas ' +
    'par pour sur dans que qui ne se sa son ses il elle ils elles l d s qu').split(' '));
  function ranked(query) {
    return !/["“”()*]/.test(query) && /[\p{L}\p{N}]/u.test(query) &&
      !String(query).split(/\s+/).some(word => /^(?:AND|OR|NOT)$/.test(word) || /^[/-]/.test(word));
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

  const api = { compile, search, matches, sentences, sentenceUnits, ranked, fold, eachWord, eachWordAt, rankTerms, bm25, rankHits, densest, excerpt, hash };
  global.LegalPinpointerFindCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
