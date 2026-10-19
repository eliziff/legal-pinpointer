'use strict';

// CanLII legislation identity: the packaged index (tools/build-canlii-legislation-index.cjs) holds
// every CanLII statute and regulation keyed by common-law-cite's canlii_citation_key of CanLII's own
// printed citation, so a provider page's citation resolves exactly by the keys the same engine
// derives for it (legislationLookup). Titles only break ties or stand in for a missing citation.
(function exposeCanliiLegislation(global) {
  const PATHS = new Set(['stat', 'regu', 'astat', 'hstat', 'const']);
  // Consolidated text first: an act printed in both the consolidation and the annual volume is the same act.
  const PATH_RANK = { stat: 0, regu: 1, const: 2, hstat: 3, astat: 4 };
  function fold(value) {
    return String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function normalizeTitle(value) {
    return fold(value)
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  // A looser title for fallback matching only: no leading article, no trailing year.
  function looseTitle(value) {
    return normalizeTitle(value).replace(/^(?:the|la|le|les|l) /, '').replace(/ (?:18|19|20)\d{2}$/, '')
      .replace(/\bregulations\b/g, 'regulation').replace(/\breglements\b/g, 'reglement');
  }

  // Index lines: id, databaseId, path, citation key ('' when it equals the id), title key. Only the
  // citation map is built up front; the id and title maps are built on the first fallback lookup.
  function parseIndex(text) {
    const rows = [], byCitation = new Map();
    const source = String(text || '');
    for (let start = 0, end; start < source.length; start = end + 1) {
      end = source.indexOf('\n', start);
      if (end < 0) end = source.length;
      if (end === start || source.charCodeAt(start) === 35) continue;
      const fields = source.slice(start, end).split('\t');
      if (fields.length < 4 || !PATHS.has(fields[2])) continue;
      const row = { id: fields[0], databaseId: fields[1], path: fields[2], title: fields[4] || '' };
      rows.push(row);
      const key = fields[3] || row.id, list = byCitation.get(key);
      if (list) list.push(row); else byCitation.set(key, [row]);
    }
    return { rows, byCitation, maps: null };
  }

  function lookupMaps(index) {
    if (!index.maps) {
      const byId = new Map(), byTitle = new Map(), byLoose = new Map();
      const add = (map, key, row) => { const list = map.get(key); if (list) list.push(row); else map.set(key, [row]); };
      for (const row of index.rows) {
        add(byId, row.id, row);
        if (row.title) { add(byTitle, row.title, row); add(byLoose, looseTitle(row.title), row); }
      }
      index.maps = { byId, byTitle, byLoose };
    }
    return index.maps;
  }

  function rowUrl(row, language) {
    const lang = String(language || '').toLowerCase().startsWith('fr') ? 'fr' : 'en';
    const jurisdiction = row.databaseId.slice(0, 2);
    return `https://www.canlii.org/${lang}/${jurisdiction}/laws/${row.path}/${row.id}/latest/${row.id}.html`;
  }

  // One instrument among rows: best path rank, then the title, else abstain.
  function choose(rows, titleKey) {
    if (!rows || !rows.length) return null;
    const best = Math.min(...rows.map((row) => PATH_RANK[row.path] ?? 9));
    let ranked = rows.filter((row) => (PATH_RANK[row.path] ?? 9) === best);
    if (new Set(ranked.map((row) => row.id)).size === 1) return ranked[0];
    if (titleKey) {
      const titled = ranked.filter((row) => row.title === titleKey);
      if (new Set(titled.map((row) => row.id)).size === 1) return titled[0];
      ranked = rows.filter((row) => row.title === titleKey);
      if (new Set(ranked.map((row) => row.id)).size === 1) return ranked[0];
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
      const row = choose(index.byCitation.get(key), titleKey);
      if (row && similarTitles(row.title, titleKey)) return rowUrl(row, language);
    }
    // 2. Identifier candidates the shared citation engine derives.
    const candidates = (lookup && lookup.candidates) || [];
    for (const id of candidates) {
      const row = choose(lookupMaps(index).byId.get(id), titleKey);
      if (row && similarTitles(row.title, titleKey)) return rowUrl(row, language);
    }
    if (!titleKey) return '';
    // 3. A unique title, narrowed to the citation's jurisdiction where one is known.
    const jurisdiction = lookup && lookup.jurisdiction;
    const { byTitle, byLoose } = lookupMaps(index);
    for (const rows of [byTitle.get(titleKey), byLoose.get(looseTitle(title))]) {
      let pool = rows || [];
      if (jurisdiction) pool = pool.filter((row) => row.databaseId.startsWith(jurisdiction));
      const ids = new Set(pool.map((row) => row.id));
      if (ids.size === 1) return rowUrl(choose(pool, titleKey) || pool[0], language);
      if (ids.size > 1 && !jurisdiction) break;
    }
    return '';
  }

  const api = { looseTitle, normalizeTitle, parseIndex, resolve, rowUrl };
  global.LegalPinpointerCanliiLegislation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
