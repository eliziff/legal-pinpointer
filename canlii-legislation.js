'use strict';

(function exposeCanliiLegislation(global) {
  const PATHS = new Set(['stat', 'regu', 'astat', 'hstat', 'const']);
  function normalizeTitle(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  let nodeEngine;
  function legislationLookup(value) {
    const text = String(value || '');
    if (!text) return { candidates: [], jurisdiction: '' };
    if (typeof module === 'undefined' || !module.exports) {
      throw new Error('Legislation lookup requires the initialized shared engine.');
    }
    nodeEngine ||= require('./legal-structure.mjs').initSync({
      module: require('node:fs').readFileSync(require('node:path').join(__dirname, 'legal-structure.wasm'))
    });
    return require('./engine-abi.js')(nodeEngine, 'legal_citations_call', {
      method: 'legislationLookup', request: { text }
    }).result;
  }

  function legislationIdCandidates(value) {
    return legislationLookup(value).candidates;
  }

  function parseIndex(text) {
    const byId = new Map();
    const byTitle = new Map();
    for (const line of String(text || '').split('\n')) {
      if (!line || line[0] === '#') continue;
      const [id, databaseId, path, title] = line.replace(/\r$/, '').split('\t');
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(id || '') || !/^[a-z0-9-]+$/.test(databaseId || '') || !PATHS.has(path)) continue;
      const row = { id, databaseId, path, title: normalizeTitle(title) };
      const identified = byId.get(id) || [];
      identified.push(row);
      byId.set(id, identified);
      const titled = byTitle.get(row.title) || [];
      titled.push(row);
      byTitle.set(row.title, titled);
    }
    return { byId, byTitle };
  }

  function rowUrl(row, language) {
    const lang = String(language || '').toLowerCase().startsWith('fr') ? 'fr' : 'en';
    const jurisdiction = row.databaseId.slice(0, 2);
    return `https://www.canlii.org/${lang}/${jurisdiction}/laws/${row.path}/${row.id}/latest/${row.id}.html`;
  }

  function resolve(index, title, citation, language, lookup) {
    const titleKey = normalizeTitle(title);
    if (!index || !titleKey) return '';
    lookup ||= legislationLookup(citation);
    const candidates = lookup.candidates;
    for (const id of candidates) {
      const row = (index.byId.get(id) || []).find((candidate) => candidate.title === titleKey);
      if (row) return rowUrl(row, language);
    }

    let rows = Array.from(
      (index.byTitle.get(titleKey) || []).reduce((unique, row) => {
        if (!unique.has(row.id)) unique.set(row.id, row);
        return unique;
      }, new Map()).values()
    );
    if (rows.length === 1) return rowUrl(rows[0], language);
    if (rows.length > 1) {
      const candidateSet = new Set(candidates);
      const exact = rows.filter((row) => candidateSet.has(row.id));
      if (exact.length === 1) return rowUrl(exact[0], language);
      const jurisdiction = lookup.jurisdiction;
      if (jurisdiction) rows = rows.filter((row) => row.databaseId.startsWith(jurisdiction));
      if (rows.length === 1) return rowUrl(rows[0], language);
    }
    return '';
  }

  const api = { legislationIdCandidates, normalizeTitle, parseIndex, resolve };
  global.LegalPinpointerCanliiLegislation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
