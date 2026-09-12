'use strict';

(function exposeFindCore(global) {
  // No stemming or remote search: offsets always refer to the original page text.
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

  function matches(tree, text) {
    let limited = false;
    function evaluate(node, negated = false) {
      if (node.type === 'term') {
        node.pattern.lastIndex = 0;
        const ranges = [];
        for (const match of text.matchAll(node.pattern)) {
          if (ranges.length === 5000) { limited = true; break; }
          ranges.push({ start: match.index, end: match.index + match[0].length });
        }
        return negated ? { ok: ranges.length === 0, ranges: [] } : { ok: ranges.length > 0, ranges };
      }
      if (node.type === 'NOT') return evaluate(node.child, !negated);
      const conjunction = (node.type === 'AND') !== negated;
      const left = evaluate(node.left, negated);
      if (conjunction && !left.ok) return { ok: false, ranges: [] };
      const right = evaluate(node.right, negated);
      const ok = conjunction ? left.ok && right.ok : left.ok || right.ok;
      return { ok, ranges: ok ? [...(left.ok ? left.ranges : []), ...(right.ok ? right.ranges : [])] : [] };
    }
    if (!tree) return [];
    const result = evaluate(tree);
    if (!result.ok) return [];
    // Merge overlapping terms so repeated query terms do not duplicate highlights.
    const merged = [];
    for (const range of result.ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
      const previous = merged[merged.length - 1];
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push({ ...range });
    }
    merged.limited = limited;
    return merged;
  }

  function sentences(text, locale = 'en') {
    let segmenter = segmenters.get(locale);
    if (!segmenter) {
      try { segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' }); }
      catch (_) { segmenter = new Intl.Segmenter('en', { granularity: 'sentence' }); }
      if (segmenters.size >= 8) segmenters.clear();
      segmenters.set(locale, segmenter);
    }
    const units = [];
    // ICU sentence boundaries plus a small, explicit legal/title abbreviation guard.
    // This is not a guarantee of linguistic sentence parsing (see README).
    const abbreviation = /\b(?:Mr|Mrs|Ms|Dr|Prof|Mme|Mlle|M|Me|Mtre|vs?|No|Nos|para|paras|ss?|art|arts|al)\.\s*$/iu;
    for (const part of segmenter.segment(text)) {
      const previous = units[units.length - 1];
      const before = previous && text.slice(previous.start, previous.end);
      if (previous && (abbreviation.test(before) || (/(?:\b[A-Z]\.){2,}\s*$/.test(before) && /^\s*\d/.test(part.segment)))) {
        previous.end = part.index + part.segment.length;
      } else {
        units.push({ start: part.index, end: part.index + part.segment.length });
      }
    }
    return units;
  }

  const api = { compile, matches, sentences, switchScope };
  global.LegalPinpointerFindCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
