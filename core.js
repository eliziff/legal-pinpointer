'use strict';

(function exposeCore(global) {
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
    return citationCall('caseHeading', { text: cleanPlatformTitle(value) });
  }

  function chooseCaseCitation(values, language, fallback, provider) {
    return citationCall('chooseCaseCitation', {
      texts: (Array.isArray(values) ? values : [values]).map(value => String(value || '')),
      language: language || 'en', fallback: String(fallback || ''), provider: provider || null
    });
  }

  async function makeCitation(documentType, title, citation) {
    const result = await citationCall('formatDocument', {
      documentType: documentType || 'secondary',
      title: cleanPlatformTitle(title),
      citation: String(citation || '')
    });
    const italicize = documentType === 'case' || documentType === 'legislation';
    const titleHtml = italicize ? `<i>${escapeHtml(result.title)}</i>` : escapeHtml(result.title);
    const html = result.citation ? (result.title ? `${titleHtml}, ${escapeHtml(result.citation)}` : escapeHtml(result.citation)) : titleHtml;
    return { ...result, html };
  }

  // McGill 6.1: Author, "Title" (Year) Volume:Issue Journal FirstPage; unpublished online papers
  // keep the service's own document citation after the year.
  async function articleCitation(fields) {
    const plain = await citationCall('formatArticle', fields);
    return { title: normalizeSpace(fields.title), citation: '', plain, html: escapeHtml(plain) };
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

  function sameArray(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function pinpointLayouts(kind, values, style) {
    return citationCall('pinpointLayouts', { kind, values, style });
  }

  async function formatPinpoint(kind, values, style) {
    return (await pinpointLayouts(kind, [values || []], style))[0].plain;
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

  // A selection that reaches every leaf under a provision cites the provision:
  // 8(1)(a) and 8(1)(b), when (b) ends 8(1), is s 8(1), not ss 8(1)(a)-(b).
  function collapseCompleteProvisions(selected, all) {
    const locators = new Set(all.map(node => normalizeSpace(node.locator)));
    const parents = new Set(), leaves = new Map();
    for (const node of all) for (const ancestor of provisionAncestors(node.locator)) parents.add(ancestor);
    for (const node of all) {
      const locator = normalizeSpace(node.locator);
      if (parents.has(locator)) continue;
      for (const ancestor of provisionAncestors(locator)) {
        if (!leaves.has(ancestor)) leaves.set(ancestor, []);
        leaves.get(ancestor).push(locator);
      }
    }
    const chosen = new Set(selected.map(node => normalizeSpace(node.locator)));
    const complete = new Set();
    for (const [parent, under] of leaves) {
      if (locators.has(parent) && under.some(leaf => chosen.has(leaf)) && under.every(leaf => chosen.has(leaf))) complete.add(parent);
    }
    if (!complete.size) return selected;
    const covered = locator => provisionAncestors(locator).some(ancestor => complete.has(ancestor));
    return all.filter(node => {
      const locator = normalizeSpace(node.locator);
      return complete.has(locator) ? !covered(locator) : chosen.has(locator) && !covered(locator);
    });
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

  function citationCall(method, request) {
    if (global.LegalPinpointerCitationCall) return global.LegalPinpointerCitationCall(method, request);
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'LEGAL_PINPOINTER_CITATION_CALL', method, request }, response => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!response?.ok) reject(new Error(response?.message || 'Citation processing failed.'));
        else resolve(response.result);
      });
    });
  }

  async function canliiUrlForCitation(value, language) {
    const result = await citationCall('url', { text: String(value || ''), language: language || 'en' });
    return result.urls.find(item => item.url?.startsWith('https://www.canlii.org/'))?.url || '';
  }

  // Alias-index targets are a neutral citation or "jurisdiction/database/caseId".
  function canliiUrlForAliasTarget(target, language) {
    return citationCall('canliiAliasTarget', { target: String(target || ''), language: language || 'en' });
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
    citationCall,
    articleCitation,
    canliiUrlForAliasTarget,
    canliiAnchorForLocator,
    canliiUrlForCitation,
    chooseCaseCitation,
    cleanPlatformTitle,
    cleanProviderUrl,
    decodeCanliiProvisionToken,
    escapeHtml,
    formatPinpoint,
    pinpointLayouts,
    isProvisionAncestor,
    literalPageMarker,
    makeCitation,
    makeTextFragment,
    normalizeSpace,
    outputLink,
    outputCitationLink,
    parseLocator,
    provisionAncestors,
    provisionDepth,
    removeRedundantProvisionAncestors,
    collapseCompleteProvisions,
    splitCaseHeading,
    withFragment
  };

  global.LegalPinpointerCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
