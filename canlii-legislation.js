'use strict';

// CanLII legislation identity: the packaged index (tools/build-canlii-legislation-index.cjs) holds
// every CanLII statute and regulation keyed by common-law-cite's canlii_citation_key of CanLII's own
// printed citation, so a provider page's citation resolves exactly by the keys the same engine
// derives for it (legislationLookup). Titles only break ties or stand in for a missing citation.
// Memory: the index stays one string; maps hold row numbers, and a row is read only when used.
(function exposeCanliiLegislation(global) {
  // Consolidated text first: an act printed in both the consolidation and the annual volume is the same act.
  const PATH_RANK = { stat: 0, regu: 1, const: 2, hstat: 3, astat: 4 };

  function normalizeTitle(value) {
    return String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  // A looser title for fallback matching only: no leading article, no trailing year.
  function looseTitle(value) {
    return normalizeTitle(value).replace(/^(?:the|la|le|les|l) /, '').replace(/ (?:18|19|20)\d{2}$/, '')
      .replace(/\bregulations\b/g, 'regulation').replace(/\breglements\b/g, 'reglement');
  }

  function add(map, key, row) {
    const value = map.get(key);
    if (value === undefined) map.set(key, row);
    else if (typeof value === 'number') map.set(key, [value, row]);
    else value.push(row);
  }

  // Index lines: id, databaseId, path, citation key ('' when it equals the id), title key.
  function parseIndex(text) {
    const source = String(text || '');
    const starts = [], byCitation = new Map();
    for (let start = 0, end; start < source.length; start = end + 1) {
      end = source.indexOf('\n', start);
      if (end < 0) end = source.length;
      if (end === start || source.charCodeAt(start) === 35) continue;
      const a = source.indexOf('\t', start), b = source.indexOf('\t', a + 1), c = source.indexOf('\t', b + 1);
      const d = source.indexOf('\t', c + 1);
      if (a < 0 || c < 0 || c > end) continue;
      const row = starts.length;
      starts.push(start);
      const key = d > c + 1 && d <= end ? source.slice(c + 1, d) : source.slice(start, a);
      add(byCitation, key, row);
    }
    return { source, starts: Int32Array.from(starts), byCitation, byId: null, byTitle: null, byLoose: null };
  }

  function row(index, at) {
    const start = index.starts[at];
    let end = index.source.indexOf('\n', start);
    if (end < 0) end = index.source.length;
    const [id, databaseId, path, , title = ''] = index.source.slice(start, end).replace(/\r$/, '').split('\t');
    return { id, databaseId, path, title };
  }

  function rows(index, value) {
    return value === undefined ? [] : (typeof value === 'number' ? [value] : value).map((at) => row(index, at));
  }

  function idMap(index) {
    if (!index.byId) {
      index.byId = new Map();
      for (let at = 0; at < index.starts.length; at += 1) {
        const start = index.starts[at];
        add(index.byId, index.source.slice(start, index.source.indexOf('\t', start)), at);
      }
    }
    return index.byId;
  }

  function titleMaps(index) {
    if (!index.byTitle) {
      index.byTitle = new Map();
      index.byLoose = new Map();
      for (let at = 0; at < index.starts.length; at += 1) {
        const { title } = row(index, at);
        if (!title) continue;
        add(index.byTitle, title, at);
        add(index.byLoose, looseTitle(title), at);
      }
    }
    return index;
  }

  function rowUrl(found, language) {
    const lang = String(language || '').toLowerCase().startsWith('fr') ? 'fr' : 'en';
    const jurisdiction = found.databaseId.slice(0, 2);
    return `https://www.canlii.org/${lang}/${jurisdiction}/laws/${found.path}/${found.id}/latest/${found.id}.html`;
  }

  // One instrument among rows: best path rank, then the title, else abstain.
  function choose(candidates, titleKey) {
    if (!candidates.length) return null;
    const best = Math.min(...candidates.map((found) => PATH_RANK[found.path] ?? 9));
    let ranked = candidates.filter((found) => (PATH_RANK[found.path] ?? 9) === best);
    if (new Set(ranked.map((found) => found.id)).size === 1) return ranked[0];
    if (titleKey) {
      const titled = ranked.filter((found) => found.title === titleKey);
      if (new Set(titled.map((found) => found.id)).size === 1) return titled[0];
      ranked = candidates.filter((found) => found.title === titleKey);
      if (new Set(ranked.map((found) => found.id)).size === 1) return ranked[0];
    }
    return null;
  }

  function similarTitles(left, right) {
    if (!left || !right) return true;
    const a = new Set(looseTitle(left).split(' ')), b = new Set(looseTitle(right).split(' '));
    let shared = 0;
    for (const word of a) if (b.has(word)) shared += 1;
    return shared / Math.min(a.size, b.size) >= 0.5;
  }

  function resolve(index, title, citation, language, lookup) {
    if (!index) return '';
    const titleKey = normalizeTitle(title);
    // 1. CanLII's own citation for the instrument.
    for (const key of (lookup && lookup.keys) || []) {
      const found = choose(rows(index, index.byCitation.get(key)), titleKey);
      if (found && similarTitles(found.title, titleKey)) return rowUrl(found, language);
    }
    // 2. Identifier candidates the shared citation engine derives.
    const candidates = (lookup && lookup.candidates) || [];
    if (candidates.length) {
      const byId = idMap(index);
      for (const id of candidates) {
        const found = choose(rows(index, byId.get(id)), titleKey);
        if (found && similarTitles(found.title, titleKey)) return rowUrl(found, language);
      }
    }
    if (!titleKey) return '';
    // 3. A unique title, narrowed to the citation's jurisdiction where one is known.
    const jurisdiction = lookup && lookup.jurisdiction;
    const { byTitle, byLoose } = titleMaps(index);
    for (const value of [byTitle.get(titleKey), byLoose.get(looseTitle(title))]) {
      let pool = rows(index, value);
      if (jurisdiction) pool = pool.filter((found) => found.databaseId.startsWith(jurisdiction));
      const ids = new Set(pool.map((found) => found.id));
      if (ids.size === 1) return rowUrl(choose(pool, titleKey) || pool[0], language);
      if (ids.size > 1 && !jurisdiction) break;
    }
    return '';
  }

  // Every row as [citation key, row] pairs, for audits.
  function* entries(index) {
    for (const [key, value] of index.byCitation) for (const found of rows(index, value)) yield [key, found];
  }

  const api = { entries, looseTitle, normalizeTitle, parseIndex, resolve, rowUrl };
  global.LegalPinpointerCanliiLegislation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
