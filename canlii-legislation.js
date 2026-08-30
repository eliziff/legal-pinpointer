'use strict';

(function exposeCanliiLegislation(global) {
  const PATHS = new Set(['stat', 'regu', 'astat', 'hstat', 'const']);
  const SERIES = new Set([
    'rsc', 'sc', 'rso', 'so', 'rsbc', 'sbc', 'rsa', 'sa', 'rss', 'ss',
    'rsm', 'sm', 'rsnb', 'snb', 'rsns', 'sns', 'rsnl', 'snl', 'rspei',
    'spei', 'rsnwt', 'snwt', 'rsy', 'sy', 'cqlr', 'rlrq', 'ccsm', 'cplm',
    'lrc', 'lc', 'lro', 'lo', 'lrm', 'lm', 'rsq', 'lq'
  ]);
  const REGULATION_PREFIXES = new Map([
    ['bc', 'bc'], ['britishcolumbia', 'bc'],
    ['alta', 'alta'], ['alberta', 'alta'],
    ['o', 'o'], ['ont', 'o'], ['ontario', 'o'],
    ['man', 'man'], ['manitoba', 'man'],
    ['nb', 'nb'], ['newbrunswick', 'nb'],
    ['ns', 'ns'], ['novascotia', 'ns'],
    ['nl', 'nl'], ['newfoundlandandlabrador', 'nl'],
    ['pei', 'pei'], ['princeedwardisland', 'pei'],
    ['nwt', 'nwt'], ['northwestterritories', 'nwt'],
    ['nu', 'nu'], ['nunavut', 'nu'],
    ['sask', 'sask'], ['saskatchewan', 'sask']
  ]);
  const SERIES_JURISDICTIONS = new Map([
    ['rsc', 'ca'], ['sc', 'ca'], ['lrc', 'ca'], ['lc', 'ca'],
    ['rsa', 'ab'], ['sa', 'ab'], ['rsbc', 'bc'], ['sbc', 'bc'],
    ['rso', 'on'], ['so', 'on'], ['lro', 'on'], ['lo', 'on'],
    ['rss', 'sk'], ['ss', 'sk'], ['rsm', 'mb'], ['sm', 'mb'],
    ['ccsm', 'mb'], ['cplm', 'mb'], ['rsnb', 'nb'], ['snb', 'nb'],
    ['rsns', 'ns'], ['sns', 'ns'], ['rsnl', 'nl'], ['snl', 'nl'],
    ['rspei', 'pe'], ['spei', 'pe'], ['rsnwt', 'nt'], ['snwt', 'nt'],
    ['rsy', 'yk'], ['sy', 'yk'], ['cqlr', 'qc'], ['rlrq', 'qc'],
    ['rsq', 'qc'], ['lq', 'qc']
  ]);

  function normalizeTitle(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function seriesKey(value) {
    return String(value || '').replace(/[^A-Za-z]/g, '').toLowerCase();
  }

  function legislationIdCandidates(value) {
    const citation = String(value || '').normalize('NFKC').replace(/[\u2010-\u2015]/g, '-');
    const output = [];
    const add = (value) => {
      const candidate = String(value || '').toLowerCase();
      if (candidate && !output.includes(candidate)) output.push(candidate);
    };

    for (const match of citation.matchAll(/\b([A-Z.]{1,10})\s+(\d{4}(?:-\d{2,4}){0,2})\s*,?\s*c(?:h)?\.?\s*([A-Z0-9][A-Z0-9.-]*)/gi)) {
      const series = seriesKey(match[1]);
      if (!SERIES.has(series)) continue;
      const chapter = match[3].toLowerCase();
      add(`${series}-${match[2]}-c-${chapter}`);
      add(`${series}-${match[2]}-c-${chapter.replace(/\./g, '-')}`);
      add(`${series}-${match[2]}-c-${chapter.replace(/[.-]/g, '')}`);
    }

    const regulation = citation.match(/\b([A-Za-z. ]{1,28}?)\s+Reg\.?\s+(\d+)\s*\/\s*(\d{2,4})\b/i);
    if (regulation) {
      const prefix = REGULATION_PREFIXES.get(seriesKey(regulation[1]));
      if (prefix) add(`${prefix}-reg-${regulation[2]}-${regulation[3]}`);
    }

    const instrument = citation.match(/\b(SOR|DORS|SI|TR)[/-](\d{2}|\d{4})-(\d+)\b/i);
    if (instrument) add(`${instrument[1]}-${instrument[2]}-${instrument[3]}`);
    const crc = citation.match(/\bC\.?R\.?C\.?,?\s+c\.?\s*(\d+)\b/i);
    if (crc) add(`crc-c-${crc[1]}`);
    return output;
  }

  function jurisdictionFromCitation(value) {
    const citation = String(value || '');
    const statute = citation.match(/\b([A-Z.]{1,10})\s+\d{4}(?:-\d{2,4}){0,2}\s*,?\s*c/i);
    if (statute) return SERIES_JURISDICTIONS.get(seriesKey(statute[1])) || '';
    const regulation = citation.match(/\b([A-Za-z. ]{1,28}?)\s+Reg\.?\s+\d+\s*\/\s*\d{2,4}\b/i);
    if (regulation) {
      const prefix = REGULATION_PREFIXES.get(seriesKey(regulation[1])) || '';
      return prefix === 'alta' ? 'ab' : prefix === 'o' ? 'on' : prefix === 'man' ? 'mb' : prefix === 'sask' ? 'sk' : prefix;
    }
    return /\b(?:SOR|DORS|SI|TR)[/-]\d/i.test(citation) || /\bC\.?R\.?C\.?\b/i.test(citation) ? 'ca' : '';
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

  function resolve(index, title, citation, language) {
    const titleKey = normalizeTitle(title);
    if (!index || !titleKey) return '';
    const candidates = legislationIdCandidates(citation);
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
      const jurisdiction = jurisdictionFromCitation(citation);
      if (jurisdiction) rows = rows.filter((row) => row.databaseId.startsWith(jurisdiction));
      if (rows.length === 1) return rowUrl(rows[0], language);
    }
    return '';
  }

  const api = { legislationIdCandidates, normalizeTitle, parseIndex, resolve };
  global.LegalPinpointerCanliiLegislation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
