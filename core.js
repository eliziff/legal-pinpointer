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

  // A browser title may put the citation before or after the case name. Only
  // split at a recognized citation, never at a comma within a party's full name.
  function splitCaseHeading(value) {
    const heading = cleanPlatformTitle(value);
    const cite = /(?:\[(?:18|19|20)\d{2}\]|(?:18|19|20)\d{2}\s+(?:CanLII|[A-Z][A-Za-z0-9.-]*)\s+\d+\b)/;
    const comma = /,\s*|\s+[|—–]\s+/g;
    for (const match of heading.matchAll(comma)) {
      const rest = heading.slice(match.index + match[0].length);
      if (cite.test(rest) && cite.exec(rest).index === 0) {
        return { name: heading.slice(0, match.index).trim(), citation: rest };
      }
    }
    const prefix = heading.match(/^((?:18|19|20)\d{2}\s+(?:CanLII|[A-Z][A-Za-z0-9.-]*)\s+\d+(?:\s*\([^)]*\))?)\s*(?:\||[—–]|-\s)\s*(.+)$/);
    if (prefix) return { name: prefix[2].trim(), citation: prefix[1].trim() };
    return { name: heading, citation: '' };
  }

  // McGill 3.3: the Crown is "R", "Attorney General" is "AG", and abbreviations take no periods.
  const CROWN = /^(?:R\.?|Rex|Regina|Reginam|The (?:King|Queen)|(?:Her|His) Majesty (?:the )?(?:King|Queen)(?: in right of [^,]+)?|Sa Majesté (?:la Reine|le Roi))$/i;

  function mcgillParty(value) {
    const party = normalizeSpace(value);
    if (CROWN.test(party)) return 'R';
    return party
      .replace(/,?\s+et al\.?$/i, '')
      .replace(/\((?:the )?Attorney General(?: of)?\)/gi, '(AG)')
      .replace(/\((?:the )?Attorney General of ([^)]+)\)/gi, '(AG $1)')
      .replace(/^(?:The )?Attorney General of ([A-Z][A-Za-z ]*?)(?=\s*\(|$)/i, '$1 (AG)')
      .replace(/\(Procureur(?:e)? général(?:e)?(?: du ([^)]+))?\)/gi, (_m, of) => (of ? `(PG du ${of})` : '(PG)'))
      .replace(/\b((?:[A-Z]\.){2,})(?=[\s,)]|$)/g, (initials) => initials.replace(/\./g, ''))
      .replace(/\b([A-Z])\.(?=\s|[,)]|$)/g, '$1')
      .replace(/\b(Ltd|Ltée|Inc|Co|Corp|Cie|Assn|Assoc|Bros|Dept|Govt|Mfg|Intl|Ins|Mun|Twp|Ry|No|St|Ste|Mr|Mrs|Ms|Dr|Jr|Sr|Comm|Commn|Admin|Bd|Cty|Gen|Hosp|Prov|Reg|Soc|Univ|Ass)\./g, '$1')
      .replace(/\b((?:[a-z]\.){2,})(?=[\s,)]|$)/g, (initials) => initials.replace(/\./g, ''))
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanCaseName(value) {
    const name = splitCaseHeading(value).name
      .replace(/\s+\((?:S\.?C\.?C\.?|C\.?S\.?C\.?)\)\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    // McGill 3.3.4: "Re" precedes the subject ("Re Eurig Estate"), whichever form the provider uses.
    const matter = name.match(/^(.+?)(?:,\s*Re|\s+\(Re\))$/i);
    if (matter && !/\s(?:v|c)\.?\s/.test(matter[1])) return `Re ${mcgillParty(matter[1])}`;
    const parts = name.split(/\s+(v|c)\.?\s+/);
    if (parts.length < 3) return mcgillParty(name);
    const output = [];
    for (let index = 0; index < parts.length; index += 2) {
      if (index) output.push(parts[index - 1]);
      output.push(mcgillParty(parts[index]));
    }
    return output.join(' ');
  }

  function normalizeCitation(value) {
    // McGill reporter and database abbreviations carry no periods ("[1964] SCR 642", "[2002] BCJ No 12").
    return normalizeSpace(value)
      .replace(/\s*\(CanLII\)\s*/gi, ' ')
      .replace(/([A-Za-zÀ-ÿ])\.(?=\s*[A-Za-zÀ-ÿ(]|\s+\d|\s*$)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // McGill 3.8: database citations name the service they come from.
  function databaseCitation(value) {
    const cite = normalizeCitation(value);
    if (/\bCarswell[A-Za-z]+\s+\d+$/i.test(cite)) return `${cite} (WL Can)`;
    if (/^\[(?:18|19|20)\d{2}\]\s+[A-Z][A-Za-z ]*\s+No\s+\d+$/.test(cite)) return `${cite} (QL)`;
    return cite;
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
      if (!canliiCourts.routes[code] && !canliiCourts.frenchRoutes[code]) continue;
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

    // Digests and database services are not printed law reports.
    const notReporter = /\bCarswell[A-Za-z]*\s|\b(?:CanLII|ACWS|WCB|AWLD|BCWLD|OWLD|WDFL|DTE|JE|EYB|AZ)\b|\bNo\s+\d+/i;
    const series = String.raw`[A-Z][A-Za-zÀ-ÿ]*(?:\s+[A-Z][A-Za-zÀ-ÿ]*){0,4}(?:\s*\((?:\d+(?:st|nd|d|rd|th|e)|NS|ns)\))?`;
    for (const segment of segments) {
      if (notReporter.test(segment)) continue;
      // Pages may carry thousands separators ("88 CLLC 14,044").
      const bracketed = segment.match(new RegExp(String.raw`\[(?:18|19|20)\d{2}\]\s+(?:\d+\s+)?${series}\s+\d+(?:,\d{3})*\b`));
      const numbered = segment.match(new RegExp(String.raw`\b\d+\s+${series}\s+\d+(?:,\d{3})*\b`));
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

  function canliiCitations(value) {
    return Array.from(normalizeSpace(value).matchAll(/\b(?:18|19|20)\d{2}\s+CanLII\s+\d+\b(?:\s*\([A-Z0-9. -]+\))?/gi),
      (match) => normalizeCitation(match[0]).replace(/canlii/i, 'CanLII'));
  }

  function inHouseCitations(value) {
    return Array.from(normalizeSpace(value).matchAll(/\b(?:18|19|20)\d{2}\s+Carswell[A-Za-z]+\s+\d+\b|\[(?:18|19|20)\d{2}\]\s+[A-Z][A-Z.]{0,15}\s+No\.?\s+\d+\b/gi),
      (match) => normalizeCitation(match[0]));
  }

  function chooseCaseCitation(values, language, fallback, provider) {
    const texts = [...(Array.isArray(values) ? values : [values]), fallback];
    const lang = String(language || 'en').toLowerCase();
    const neutrals = texts.flatMap(neutralCitations);
    if (neutrals.length) {
      // Prefer the document's first citation, changing language only for its equivalent.
      const equivalents = { SCC: 'CSC', FCA: 'CAF', FC: 'CF', CSC: 'SCC', CAF: 'FCA', CF: 'FC' };
      const [year, code, number] = neutrals[0].split(' ');
      const translated = `${year} ${equivalents[code]} ${number}`;
      const wantsTranslation = lang.startsWith('fr') ? ['SCC', 'FCA', 'FC'].includes(code) : ['CSC', 'CAF', 'CF'].includes(code);
      return wantsTranslation && neutrals.includes(translated) ? translated : neutrals[0];
    }
    // McGill 3.1-3.8: without a neutral citation, a printed reporter precedes any online database.
    const reporters = texts.flatMap(reporterCandidates);
    if (reporters.length) {
      return reporters
        .map((cite, index) => ({ cite, index, score: reporterScore(cite, lang) }))
        .sort((left, right) => right.score - left.score || left.index - right.index)[0].cite;
    }
    const canlii = texts.flatMap(canliiCitations);
    if (canlii.length) return canlii[0];
    const inHouse = texts.flatMap(inHouseCitations);
    if (inHouse.length) {
      return databaseCitation(inHouse.find((cite) => provider === 'westlaw' ? /Carswell/i.test(cite)
        : provider === 'lexis' ? /\bNo /i.test(cite) : false) || inHouse[0]);
    }
    return databaseCitation(fallback || '');
  }

  function makeCitation(documentType, title, citation) {
    const type = documentType || 'secondary';
    let rawTitle = type === 'case' ? cleanCaseName(title) : cleanPlatformTitle(title);
    let cite = normalizeCitation(citation);
    if (type === 'legislation') {
      const parts = splitLegislationHeading(rawTitle);
      rawTitle = parts.title;
      cite ||= normalizeCitation(parts.citation);
    }
    if (type === 'legislation') cite = legislationCitationCore(cite);
    if (cite && normalizeCitation(rawTitle) === cite) rawTitle = '';
    const plain = cite ? (rawTitle ? `${rawTitle}, ${cite}` : cite) : rawTitle;
    const italicize = type === 'case' || type === 'legislation';
    const titleHtml = italicize ? `<i>${escapeHtml(rawTitle)}</i>` : escapeHtml(rawTitle);
    const html = cite ? (rawTitle ? `${titleHtml}, ${escapeHtml(cite)}` : escapeHtml(cite)) : titleHtml;
    return { title: rawTitle, citation: cite, plain, html };
  }

  // McGill 6.1: Author, "Title" (Year) Volume:Issue Journal FirstPage; unpublished online papers
  // keep the service's own document citation after the year.
  function articleCitation(fields) {
    const authors = (fields.authors || []).map(normalizeSpace).filter(Boolean);
    const author = authors.length > 3 ? `${authors[0]} et al` : authors.length > 1
      ? `${authors.slice(0, -1).join(', ')} & ${authors[authors.length - 1]}` : authors[0] || '';
    const title = normalizeSpace(fields.title);
    const year = normalizeSpace(fields.year).slice(0, 4);
    const volume = [fields.volume, fields.issue].map(normalizeSpace).filter(Boolean).join(':');
    const tail = fields.journal
      ? [volume, normalizeSpace(fields.journal), normalizeSpace(fields.firstPage)].filter(Boolean).join(' ')
      : '';
    const located = tail ? `(${year}) ${tail}` : [year && `(${year})`, fields.docCitation].filter(Boolean).join(', ');
    const plain = [author, `“${title}” ${located}`.trim()].filter(Boolean).join(', ');
    return { title, citation: '', plain, html: escapeHtml(plain) };
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
    return locatorGroups(values)
      .map((group) => (group.end > group.start ? `${group.firstDisplay}-${group.lastDisplay}` : group.firstDisplay))
      .join(', ');
  }

  // McGill states a shared section number once: "ss 20(a), (b)(i)".
  function sharedRootDisplay(previous, locator) {
    const left = parseLocator(previous);
    const right = parseLocator(locator);
    return left && right && left.suffixes.length && right.suffixes.length && left.root === right.root
      ? locator.slice(right.root.length)
      : locator;
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
        firstDisplay: start ? sharedRootDisplay(locators[start - 1], locators[start]) : locators[start],
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
    if (kind === 'page') return 'at ';
    if (kind === 'section') return `${count === 1 ? 's' : 'ss'} `;
    if (kind === 'rule') return `${count === 1 ? 'r' : 'rr'} `;
    if (kind === 'article') return `${count === 1 ? 'art' : 'arts'} `;
    return `at ${count === 1 ? 'para' : 'paras'} `;
  }

  function formatPinpoint(kind, values, style) {
    const locators = [], seen = new Set();
    for (const value of values || []) {
      const locator = normalizeSpace(value);
      if (locator && !seen.has(locator)) { seen.add(locator); locators.push(locator); }
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

  // Enumerate strict ancestors once, instead of comparing every pair of nodes.
  // Root spelling and suffix case intentionally retain parseLocator's semantics.
  function provisionAncestors(value) {
    const parsed = parseLocator(value);
    if (!parsed) return [];
    const ancestors = [];
    let prefix = parsed.root;
    for (const suffix of parsed.suffixes) {
      ancestors.push(prefix);
      prefix += `(${suffix})`;
    }
    return ancestors;
  }

  function removeRedundantProvisionAncestors(nodes) {
    const input = nodes || [];
    const ancestors = new Set();
    for (const node of input) {
      for (const ancestor of provisionAncestors(node.locator)) ancestors.add(ancestor);
    }
    return input.filter(node => !ancestors.has(normalizeSpace(node.locator)));
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

  // Must match tools/build-canlii-case-aliases.py key().
  function citationKey(value) {
    return String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // Alias-index targets are a neutral citation or "jurisdiction/database/caseId".
  function canliiUrlForAliasTarget(target, language) {
    const value = normalizeSpace(target);
    const path = value.match(/^([a-z]{2})\/([a-z0-9-]+)\/((\d{4})[a-z0-9]+)$/);
    if (!path) return canliiUrlForCitation(value, language);
    const code = Object.keys(canliiCourts.routes).find((candidate) => canliiCourts.routes[candidate] === `${path[1]}/${path[2]}`);
    const route = code ? canliiCourtRoute(code, language) : null;
    const lang = route ? route.language : 'en';
    const routePath = route ? route.path : `${path[1]}/${path[2]}`;
    return `https://www.canlii.org/${lang}/${routePath}/doc/${path[4]}/${path[3]}/${path[3]}.html`;
  }

  function canliiAnchorForLocator(kind, locator, canliiUrl) {
    const value = normalizeSpace(locator);
    if (kind === 'page') return makeTextFragment(`[page ${value}]`);
    if (kind === 'paragraph' || kind === 'pilcrow') return `#par${encodeURIComponent(value)}`;
    if (!['section', 'rule', 'article', 'silcrow'].includes(kind)) return '';

    const parsed = parseLocator(value);
    if (!parsed) return '';
    // Quebec statutes carry LégisQuébec section ids ("se:18_1"); deeper units have no stable id.
    if (/\/\/[^/]+\/(?:en|fr)\/qc\/laws\//.test(String(canliiUrl || ''))) {
      return `#se:${parsed.root.replace(/\./g, '_')}`;
    }
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
    articleCitation,
    canliiUrlForAliasTarget,
    citationKey,
    databaseCitation,
    canliiAnchorForLocator,
    canliiUrlForCitation,
    chooseCaseCitation,
    canliiCitations,
    inHouseCitations,
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
    provisionAncestors,
    provisionDepth,
    removeRedundantProvisionAncestors,
    reporterCandidates,
    splitCaseHeading,
    withFragment
  };

  global.LegalPinpointerCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
