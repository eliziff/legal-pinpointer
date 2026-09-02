'use strict';

(function exposeCore(global) {
  const canliiCourts = global.LegalPinpointerCanliiCourts;
  if (!canliiCourts) throw new Error('canlii-courts.js must load before core.js');

  const PLATFORM_SUFFIXES = [
    /\s*\|\s*CanLII\s*$/i,
    /\s*\|\s*Westlaw(?:\s+Advantage)?(?:\s+Canada)?\s*$/i,
    /\s*[-|]\s*Lexis(?:Nexis|\+)?(?:\s+Canada)?\s*$/i
  ];

  function normalizeSpace(value) {
    return String(value || '')
      .replace(/[\u00a0\u2007\u202f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function cleanPlatformTitle(value) {
    let title = normalizeSpace(value);
    let prior;
    do {
      prior = title;
      for (const suffix of PLATFORM_SUFFIXES) title = title.replace(suffix, '').trim();
    } while (title !== prior);
    return title.replace(/\s*\(CanLII\)\s*$/i, '').trim();
  }

  function splitCaseHeading(value) {
    const heading = cleanPlatformTitle(value);
    const match = heading.match(/^(.*?),\s*((?:\[(?:18|19|20)\d{2}\]|(?:18|19|20)\d{2}\s+[A-Za-z]).*)$/);
    if (!match) return { name: heading, citation: '' };
    return { name: match[1].trim(), citation: match[2].trim() };
  }

  function cleanCaseName(value) {
    let name = splitCaseHeading(value).name;
    name = name
      .replace(/\s+v\.\s+/gi, ' v ')
      .replace(/\s+c\.\s+/gi, ' c ')
      .replace(/^R\.\s+/i, 'R ')
      .replace(/\s+\((?:S\.?C\.?C\.?|C\.?S\.?C\.?)\)\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    return name;
  }

  function normalizeCitation(value) {
    return normalizeSpace(value)
      .replace(/\s*\(CanLII\)\s*/gi, ' ')
      .replace(/S\.C\.R\./g, 'SCR')
      .replace(/R\.C\.S\./g, 'RCS')
      .replace(/F\.C\.R\./g, 'FCR')
      .replace(/R\.C\.F\./g, 'RCF')
      .replace(/D\.L\.R\./g, 'DLR')
      .replace(/C\.C\.C\./g, 'CCC')
      .replace(/W\.W\.R\./g, 'WWR')
      .replace(/A\.C\.W\.S\./g, 'ACWS')
      .replace(/\bNo\.\s*/g, 'No ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function splitLegislationHeading(value) {
    const heading = cleanPlatformTitle(value);
    const citationStart = /^(?:(?:(?:R\.?S\.?|S\.?|L\.?R\.?|L\.?)?[A-Z.]{2,8}|C\.?C\.?S\.?M\.?|C\.?P\.?L\.?M\.?|C\.?Q\.?L\.?R\.?|R\.?L\.?R\.?Q\.?),?\s+(?:\(?\d{4}\)?|c\b)|(?:[A-Z][A-Za-z.]*\s+){0,3}Reg\.?\s+\d|(?:SOR|SI|DORS|TR)[/-]\d|C\.?R\.?C\.?,?\s+c\b)/;
    const comma = /,\s*/g;
    let match;
    while ((match = comma.exec(heading))) {
      const suffix = heading.slice(match.index + match[0].length);
      if (citationStart.test(suffix)) {
        return { title: heading.slice(0, match.index).trim(), citation: suffix.trim() };
      }
    }
    return { title: heading, citation: '' };
  }

  function legislationCitationCore(value) {
    return normalizeCitation(value)
      .replace(/,\s*(?:(?:ss?|sections?)|(?:rr?|rules?)|(?:arts?|articles?)|\u00a7{1,2})\.?\s+.+$/i, '')
      .trim();
  }

  function neutralCitations(value) {
    const text = normalizeSpace(value);
    const matches = text.matchAll(/\b((?:18|19|20)\d{2})\s+([A-Z][A-Z0-9-]{1,15})\s+(\d+)\b/g);
    const seen = new Set();
    const output = [];
    for (const match of matches) {
      const code = match[2];
      if (code === 'CARSWELL' || code === 'CANLII') continue;
      const cite = `${match[1]} ${code} ${match[3]}`;
      if (!seen.has(cite)) {
        seen.add(cite);
        output.push(cite);
      }
    }
    return output;
  }

  function reporterCandidates(value) {
    const segments = String(value || '')
      .split(/[|;\n]|,(?=\s*(?:\[|\d{3,4}\s|\d+\s+[A-Z]))/)
      .map(normalizeCitation)
      .filter(Boolean);
    const output = [];
    const seen = new Set();

    for (const segment of segments) {
      if (/\b(?:Carswell|CanLII)\b/i.test(segment) || /\bNo\s+\d+/i.test(segment)) continue;
      const bracketed = segment.match(/\[(?:18|19|20)\d{2}\]\s+(?:\d+\s+)?[A-Z][A-Z.\s]{0,18}\s+\d+\b/);
      const numbered = segment.match(/\b\d+\s+[A-Z][A-Z.]{1,12}(?:\s*\(\d+(?:st|nd|rd|th)?\))?\s+\d+\b/i);
      const candidate = normalizeCitation((bracketed || numbered || [])[0] || '');
      if (candidate && !seen.has(candidate)) {
        seen.add(candidate);
        output.push(candidate);
      }
    }
    return output;
  }

  function reporterScore(value, language) {
    const cite = value.toUpperCase();
    let score = 0;
    if (/\b(?:SCR|RCS|FCR|RCF)\b/.test(cite)) score += 30;
    if (language.startsWith('fr') && /\b(?:RCS|RCF)\b/.test(cite)) score += 5;
    if (!language.startsWith('fr') && /\b(?:SCR|FCR)\b/.test(cite)) score += 5;
    return score;
  }

  function chooseCaseCitation(values, language, fallback) {
    const texts = Array.isArray(values) ? values : [values];
    const lang = String(language || 'en').toLowerCase();
    const neutrals = [];
    const reporters = [];
    for (const value of texts) {
      neutrals.push(...neutralCitations(value));
      reporters.push(...reporterCandidates(value));
    }

    if (neutrals.length) {
      const preferred = lang.startsWith('fr') ? ['CSC', 'CAF', 'CF'] : ['SCC', 'FCA', 'FC'];
      for (const code of preferred) {
        const match = neutrals.find((cite) => cite.split(' ')[1] === code);
        if (match) return match;
      }
      return neutrals[0];
    }

    if (reporters.length) {
      return reporters
        .map((cite, index) => ({ cite, index, score: reporterScore(cite, lang) }))
        .sort((left, right) => right.score - left.score || left.index - right.index)[0].cite;
    }

    return normalizeCitation(fallback || '');
  }

  function makeCitation(documentType, title, citation) {
    const type = documentType || 'secondary';
    let rawTitle = type === 'case' ? cleanCaseName(title) : cleanPlatformTitle(title);
    let cite = normalizeCitation(citation);
    if (type === 'legislation' && !cite) {
      const parts = splitLegislationHeading(rawTitle);
      rawTitle = parts.title;
      cite = normalizeCitation(parts.citation);
    }
    if (type === 'legislation') cite = legislationCitationCore(cite);
    const plain = cite ? `${rawTitle}, ${cite}` : rawTitle;
    const italicize = type === 'case' || type === 'legislation';
    const titleHtml = italicize ? `<i>${escapeHtml(rawTitle)}</i>` : escapeHtml(rawTitle);
    const html = cite ? `${titleHtml}, ${escapeHtml(cite)}` : titleHtml;
    return { title: rawTitle, citation: cite, plain, html };
  }

  function literalPageMarker(value) {
    const match = String(value || '').trim().match(/^\[page\s+(\d+)\]$/i);
    return match ? match[1] : null;
  }

  function decodeCanliiProvisionToken(value) {
    const token = String(value || '').replace(/^#/, '');
    const root = token.match(/^(?:sec|section|art|article|rule)(\d+(?:\.\d+)*)(.*)$/i);
    if (!root) return null;

    let locator = root[1];
    let tail = root[2];
    const component = /^(?:subsec|subsection|para|paragraph|subpara|subparagraph|clause|subclause)([A-Za-z0-9.-]+)/i;
    while (tail) {
      const match = tail.match(component);
      if (!match) return null;
      locator += `(${match[1]})`;
      tail = tail.slice(match[0].length);
    }
    return locator;
  }

  function parseLocator(value) {
    const raw = normalizeSpace(value);
    const match = raw.match(/^(\d+(?:\.\d+)*)(.*)$/);
    if (!match) return null;
    const suffixes = [];
    let tail = match[2];
    while (tail) {
      const suffix = tail.match(/^\(([^()]+)\)/);
      if (!suffix) return null;
      suffixes.push(suffix[1]);
      tail = tail.slice(suffix[0].length);
    }
    return {
      raw,
      root: match[1],
      rootParts: match[1].split('.').map(Number),
      suffixes
    };
  }

  function romanNumber(value) {
    const table = { i: 1, v: 5, x: 10, l: 50, c: 100 };
    const text = String(value || '').toLowerCase();
    if (!/^[ivxlc]+$/.test(text)) return null;
    let total = 0;
    for (let index = 0; index < text.length; index += 1) {
      const current = table[text[index]];
      const next = table[text[index + 1]] || 0;
      total += current < next ? -current : current;
    }
    return total;
  }

  function alphabetNumber(value) {
    const text = String(value || '').toLowerCase();
    if (!/^[a-z]+$/.test(text)) return null;
    let total = 0;
    for (const character of text) total = total * 26 + character.charCodeAt(0) - 96;
    return total;
  }

  function consecutiveAtomic(leftValue, rightValue) {
    if (/^\d+$/.test(leftValue) && /^\d+$/.test(rightValue)) {
      return Number(rightValue) === Number(leftValue) + 1;
    }
    const bothRoman = /^[ivxlc]+$/i.test(leftValue) && /^[ivxlc]+$/i.test(rightValue);
    if (bothRoman && (leftValue.length > 1 || rightValue.length > 1)) {
      return romanNumber(rightValue) === romanNumber(leftValue) + 1;
    }
    const leftAlphabet = alphabetNumber(leftValue);
    const rightAlphabet = alphabetNumber(rightValue);
    return leftAlphabet !== null && rightAlphabet === leftAlphabet + 1;
  }

  function sameArray(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function isConsecutiveLocator(leftValue, rightValue) {
    const left = parseLocator(leftValue);
    const right = parseLocator(rightValue);
    if (!left || !right) return false;

    if (!left.suffixes.length && !right.suffixes.length) {
      if (left.rootParts.length !== right.rootParts.length) return false;
      const prefixLength = left.rootParts.length - 1;
      if (!sameArray(left.rootParts.slice(0, prefixLength), right.rootParts.slice(0, prefixLength))) return false;
      return right.rootParts[prefixLength] === left.rootParts[prefixLength] + 1;
    }

    if (left.root !== right.root || left.suffixes.length !== right.suffixes.length) return false;
    const prefixLength = left.suffixes.length - 1;
    if (!sameArray(left.suffixes.slice(0, prefixLength), right.suffixes.slice(0, prefixLength))) return false;
    return consecutiveAtomic(left.suffixes[prefixLength], right.suffixes[prefixLength]);
  }

  function shortenedRangeEnd(leftValue, rightValue) {
    const left = parseLocator(leftValue);
    const right = parseLocator(rightValue);
    if (!left || !right || left.root !== right.root || !right.suffixes.length) return rightValue;
    const prefixLength = right.suffixes.length - 1;
    if (!sameArray(left.suffixes.slice(0, prefixLength), right.suffixes.slice(0, prefixLength))) return rightValue;
    return `(${right.suffixes[prefixLength]})`;
  }

  function collapseLocatorRanges(values) {
    const locators = [];
    for (const value of values || []) {
      const locator = normalizeSpace(value);
      if (locator && locators[locators.length - 1] !== locator) locators.push(locator);
    }
    const groups = [];
    for (let start = 0; start < locators.length;) {
      let end = start;
      while (end + 1 < locators.length && isConsecutiveLocator(locators[end], locators[end + 1])) end += 1;
      groups.push(end > start
        ? `${locators[start]}-${shortenedRangeEnd(locators[start], locators[end])}`
        : locators[start]);
      start = end + 1;
    }
    return groups.join(', ');
  }

  function locatorGroups(values) {
    const locators = [];
    for (const value of values || []) {
      const locator = normalizeSpace(value);
      if (locator && locators[locators.length - 1] !== locator) locators.push(locator);
    }
    const groups = [];
    for (let start = 0; start < locators.length;) {
      let end = start;
      while (end + 1 < locators.length && isConsecutiveLocator(locators[end], locators[end + 1])) end += 1;
      groups.push({
        start,
        end,
        first: locators[start],
        last: locators[end],
        lastDisplay: end > start ? shortenedRangeEnd(locators[start], locators[end]) : locators[start]
      });
      start = end + 1;
    }
    return groups;
  }

  function pinpointPrefix(kind, count, style) {
    if (kind === 'pilcrow') return '\u00b6 ';
    if (kind === 'silcrow') return '\u00a7 ';
    if (style !== 'full') return '';
    if (kind === 'page') return 'at p. ';
    if (kind === 'section') return `${count === 1 ? 's' : 'ss'} `;
    if (kind === 'rule') return `${count === 1 ? 'r' : 'rr'} `;
    if (kind === 'article') return `${count === 1 ? 'art' : 'arts'} `;
    return `${count === 1 ? 'para' : 'paras'} `;
  }

  function formatPinpoint(kind, values, style) {
    const locators = [];
    for (const value of values || []) {
      const locator = normalizeSpace(value);
      if (locator && !locators.includes(locator)) locators.push(locator);
    }
    if (!locators.length) return '';
    const collapsed = collapseLocatorRanges(locators);
    return `${pinpointPrefix(kind, locators.length, style)}${collapsed}`;
  }

  function provisionDepth(value) {
    const locator = parseLocator(value);
    return locator ? locator.suffixes.length : 0;
  }

  function isProvisionAncestor(ancestorValue, descendantValue) {
    const ancestor = parseLocator(ancestorValue);
    const descendant = parseLocator(descendantValue);
    if (!ancestor || !descendant || ancestor.root !== descendant.root) return false;
    if (ancestor.suffixes.length >= descendant.suffixes.length) return false;
    return sameArray(ancestor.suffixes, descendant.suffixes.slice(0, ancestor.suffixes.length));
  }

  function removeRedundantProvisionAncestors(nodes) {
    return (nodes || []).filter((node, index, all) => !all.some((other, otherIndex) => (
      otherIndex !== index && isProvisionAncestor(node.locator, other.locator)
    )));
  }

  function makeTextFragment(value) {
    return `#:~:text=${encodeURIComponent(normalizeSpace(value))}`;
  }

  function withFragment(baseUrl, fragment) {
    const url = new URL(baseUrl);
    url.hash = '';
    if (!fragment) return url.toString();
    return `${url.toString().replace(/#$/, '')}${fragment.startsWith('#') ? fragment : `#${fragment}`}`;
  }

  function cleanProviderUrl(provider, value) {
    const url = new URL(value);
    url.hash = '';

    if (provider === 'lexis') {
      const keep = ['pdmfid', 'pddocfullpath', 'pdcontentcomponentid', 'pdtocnodeidentifier'];
      const clean = new URL(`${url.origin}${url.pathname}`);
      for (const key of keep) {
        if (url.searchParams.has(key)) clean.searchParams.set(key, url.searchParams.get(key));
      }
      return clean.toString();
    }

    url.search = '';
    return url.toString();
  }

  function canliiCourtRoute(rawCode, language) {
    const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
    const englishToFrench = { SCC: 'CSC', FCA: 'CAF', FC: 'CF', TCC: 'CCI', CMAC: 'CACM' };
    const wantsFrench = String(language || '').toLowerCase().startsWith('fr') || Boolean(canliiCourts.frenchRoutes[code]);
    const routeCode = wantsFrench && englishToFrench[code] ? englishToFrench[code] : code;
    const route = canliiCourts.frenchRoutes[routeCode] || canliiCourts.routes[routeCode];
    return route ? { path: route, code: routeCode, language: wantsFrench ? 'fr' : 'en' } : null;
  }

  function canliiUrlForCitation(value, language) {
    const text = normalizeSpace(value);
    const canlii = text.match(/\b((?:18|19|20)\d{2})\s+CanLII\s+(\d+)\s*\(([A-Z0-9. -]+)\)/i);
    const neutral = text.match(/\b((?:18|19|20)\d{2})\s+([A-Z][A-Z0-9-]{1,15})\s+(\d+)\b/);
    const match = canlii || neutral;
    if (!match) return '';

    const year = match[1];
    const code = canlii ? match[3] : match[2];
    if (!canlii && /^(?:CANLII|CARSWELL)$/i.test(code)) return '';
    const route = canliiCourtRoute(code, language);
    if (!route) return '';
    const slug = canlii
      ? `${year}canlii${match[2]}`.toLowerCase()
      : `${year}${route.code}${match[3]}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    return `https://www.canlii.org/${route.language}/${route.path}/doc/${year}/${slug}/${slug}.html`;
  }

  function canliiAnchorForLocator(kind, locator) {
    const value = normalizeSpace(locator);
    if (kind === 'page') return makeTextFragment(`[page ${value}]`);
    if (kind === 'paragraph' || kind === 'pilcrow') return `#par${encodeURIComponent(value)}`;
    if (!['section', 'rule', 'article', 'silcrow'].includes(kind)) return '';

    const parsed = parseLocator(value);
    if (!parsed) return '';
    if (parsed.suffixes.length > 1) return '';
    const prefix = kind === 'article' ? 'art' : kind === 'rule' ? 'rule' : 'sec';
    const tail = parsed.suffixes.length ? `subsec${parsed.suffixes[0]}` : '';
    return `#${prefix}${parsed.root}${tail}`;
  }

  function outputLink(text, htmlText, url) {
    const safeUrl = escapeHtml(url);
    return {
      plain: text,
      html: `<a href="${safeUrl}">${htmlText || escapeHtml(text)}</a>`
    };
  }

  function outputCitationLink(citation, url) {
    const coreHtml = escapeHtml(citation.citation || '');
    if (!coreHtml) return outputLink(citation.plain, citation.html, url);
    const index = citation.html.lastIndexOf(coreHtml);
    if (index < 0) return outputLink(citation.plain, citation.html, url);
    const linked = outputLink(citation.citation, coreHtml, url).html;
    return {
      plain: citation.plain,
      html: `${citation.html.slice(0, index)}${linked}${citation.html.slice(index + coreHtml.length)}`
    };
  }

  const api = {
    canliiAnchorForLocator,
    canliiUrlForCitation,
    chooseCaseCitation,
    cleanCaseName,
    cleanPlatformTitle,
    cleanProviderUrl,
    collapseLocatorRanges,
    decodeCanliiProvisionToken,
    escapeHtml,
    formatPinpoint,
    isProvisionAncestor,
    isConsecutiveLocator,
    literalPageMarker,
    locatorGroups,
    makeCitation,
    makeTextFragment,
    neutralCitations,
    normalizeCitation,
    normalizeSpace,
    outputLink,
    outputCitationLink,
    parseLocator,
    pinpointPrefix,
    provisionDepth,
    removeRedundantProvisionAncestors,
    reporterCandidates,
    splitCaseHeading,
    withFragment
  };

  global.LegalPinpointerCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
