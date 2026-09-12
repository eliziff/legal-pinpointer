'use strict';

(function exposeProviders(global) {
  const core = global.LegalPinpointerCore;
  const fragments = global.LegalPinpointerTextFragments;
  if (!core || !fragments) throw new Error('Legal Pinpointer core modules must load before providers.js');

  function first(document, selectors) {
    for (const selector of selectors) {
      const match = document.querySelector(selector);
      if (match) return match;
    }
    return null;
  }

  function textOf(element) {
    return core.normalizeSpace(element ? element.textContent : '');
  }

  function meta(document, name) {
    const element = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
    return element ? core.normalizeSpace(element.getAttribute('content')) : '';
  }

  function semanticTitle(document, selectors, type = 'case') {
    const candidates = [meta(document, 'lbh-title'), meta(document, 'citation_title'),
      meta(document, 'DC.title'), meta(document, 'dc.title'), meta(document, 'og:title')];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const text = textOf(element);
        const full = element.getAttribute('title');
        candidates.push(/[.…]{3}|…/.test(text) && full && full.length > text.length ? full : text);
      }
    }
    candidates.push(...core.cleanPlatformTitle(document.title || '').split('|'));
    const names = candidates.map(core.cleanPlatformTitle).filter(Boolean);
    function usable(value) {
      if (/^(?:CanLII|Westlaw(?: Advantage)?(?: Canada)?|Lexis(?:Nexis|\+)?|Document|Judgment|Decision|Legislation|Statutes?)$/i.test(value)) return false;
      if (/^(?:\d{4}\s+(?:CanLII|[A-Z][A-Za-z0-9.-]*)\s+\d+|\[\d{4}\])/i.test(value) && !/\s(?:v\.?|c\.?)\s/i.test(value)) return false;
      if (type === 'legislation' && /^(?:s(?:ection)?s?|ss|arts?|articles?|rr?|rules?|§)\.?\s*\d/i.test(value)) return false;
      return true;
    }
    // Prefer an actual style of cause over a provider's citation-only h1/title.
    if (type === 'case') {
      const named = names.find(value => usable(value) && /\s(?:v\.?|c\.?)\s|\(Re\)|^Reference\s/i.test(value));
      if (named) return named;
    }
    if (type === 'legislation') {
      const instrument = names.find(value => usable(value) && /\b(?:Act|Code|Regulations?|Rules?|Loi|Règlement|Règles)\b/i.test(value));
      if (instrument) return instrument;
    }
    return names.find(usable) || names[0] || '';
  }

  function boundedTextBefore(root, marker, limit) {
    if (!root) return '';
    if (marker && root.ownerDocument && typeof root.ownerDocument.createRange === 'function') {
      try {
        const range = root.ownerDocument.createRange();
        range.selectNodeContents(root);
        range.setEndBefore(marker);
        return core.normalizeSpace(range.toString()).slice(0, limit || 12000);
      } catch (_) {
        // Provider DOM mutation can detach a marker between discovery and inspection.
      }
    }
    return textOf(root).slice(0, limit || 12000);
  }

  function hidden(element) {
    return Boolean(element && element.closest && element.closest('[hidden], [aria-hidden="true"]'));
  }

  function markerNode(kind, locator, element, options) {
    return {
      kind,
      locator: core.normalizeSpace(locator),
      element,
      anchor: options && options.anchor ? options.anchor : '',
      fragment: options && options.fragment ? options.fragment : '',
      markerText: options && options.markerText ? options.markerText : '',
      source: options && options.source ? options.source : 'provider-native'
    };
  }

  function uniqueNodes(nodes) {
    const seen = new Set();
    return (nodes || []).filter((node) => {
      const key = `${node.kind}\u0000${node.locator}`;
      if (!node.locator || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const PROVIDER_ANCHOR = /^(?:PARA_|SECTION_|RULE_|ARTICLE_|CA_|crsw_paragraph_num_|co_anchor_)/i;
  const PROVIDER_ANCHOR_SELECTOR = [
    '[id^="PARA_"]', '[id^="SECTION_"]', '[id^="RULE_"]', '[id^="ARTICLE_"]',
    '[id^="CA_"]', '[id^="crsw_paragraph_num_"]', '[id^="co_anchor_"]'
  ].join(', ');

  function providerAnchorId(element) {
    const idOf = (candidate) => {
      const id = candidate && candidate.id ? String(candidate.id) : '';
      return PROVIDER_ANCHOR.test(id) ? id : '';
    };
    if (!element) return '';

    const direct = idOf(element)
      || idOf(element.querySelector && element.querySelector(PROVIDER_ANCHOR_SELECTOR))
      || idOf(element.closest && element.closest(PROVIDER_ANCHOR_SELECTOR));
    if (direct) return direct;

    let previous = element.previousElementSibling;
    for (let hops = 0; previous && hops < 3; hops += 1, previous = previous.previousElementSibling) {
      const id = idOf(previous)
        || idOf(previous.querySelector && previous.querySelector(PROVIDER_ANCHOR_SELECTOR));
      if (id) return id;
      if (core.normalizeSpace(previous.textContent)) break;
    }
    return '';
  }

  function engineAnchorId(element, provider) {
    const providerId = providerAnchorId(element);
    if (providerId || provider !== 'canlii' || !element || !element.closest) return providerId;
    const passage = element.closest('p[id], li[id]');
    return passage && passage.id ? passage.id : '';
  }

  function symbolNodes(root) {
    if (!root) return [];
    const groups = { pilcrow: [], silcrow: [] };
    const elements = root.querySelectorAll('p, li, [class*="paragraph"], [class*="Paragraph"], [class*="para"], [class*="Para"]');
    for (const element of elements) {
      if (hidden(element)) continue;
      const text = core.normalizeSpace(element.textContent).slice(0, 120);
      const match = text.match(/^([¶§])\s*(\d+(?:\.\d+)*(?:\([^()]+\))*)(?=\s|$)/);
      if (!match) continue;
      const kind = match[1] === '¶' ? 'pilcrow' : 'silcrow';
      groups[kind].push(markerNode(kind, match[2], element, {
        anchor: providerAnchorId(element),
        fragment: core.makeTextFragment(`${match[1]} ${match[2]}`),
        markerText: `${match[1]} ${match[2]}`,
        source: 'symbol-marker'
      }));
    }
    return groups.pilcrow.length >= groups.silcrow.length ? uniqueNodes(groups.pilcrow) : uniqueNodes(groups.silcrow);
  }

  function provisionKind(label, title) {
    const value = `${label || ''} ${title || ''}`;
    if (/\b(?:rule|rules|règle|règles)\b/i.test(value)) return 'rule';
    if (/\b(?:article|articles|art\.)\b/i.test(value)) return 'article';
    return 'section';
  }

  function caseMetadata(document, title, headerText, fallbackCitation) {
    const heading = core.splitCaseHeading(title);
    const citation = core.chooseCaseCitation([headerText, title], document.documentElement.lang || 'en', fallbackCitation || heading.citation);
    return core.makeCitation('case', heading.name, citation);
  }

  function directCanliiLink(container, beforeElement, baseUrl) {
    if (!container) return '';
    for (const anchor of container.querySelectorAll('a[href]')) {
      if (beforeElement && !(anchor.compareDocumentPosition(beforeElement) & 4)) continue;
      try {
        const url = new URL(anchor.getAttribute('href'), baseUrl);
        const host = url.hostname.toLowerCase();
        if (url.protocol !== 'https:' || !['canlii.org', 'www.canlii.org', 'canlii.ca', 'www.canlii.ca'].includes(host)) continue;
        url.search = '';
        url.hash = '';
        return url.toString();
      } catch (_) {
        // Ignore malformed provider-owned links.
      }
    }
    return '';
  }

  function detectedCanliiUrl(document, container, beforeElement, citation, headerText, baseUrl) {
    const direct = directCanliiLink(container, beforeElement, baseUrl);
    if (direct) return direct;
    const language = document.documentElement.lang || 'en';
    return core.canliiUrlForCitation(citation, language)
      || core.canliiUrlForCitation(String(headerText || '').slice(0, 5000), language)
      || '';
  }

  function acceptedDocumentUrls(document, location, cleanUrl) {
    const values = [location.href, cleanUrl];
    for (const element of document.querySelectorAll('link[rel="canonical"][href], a.documentStaticUrl[href]')) {
      try {
        values.push(new URL(element.getAttribute('href'), location.href).toString());
      } catch (_) {
        // Ignore malformed provider metadata.
      }
    }
    return Array.from(new Set(values.filter(Boolean)));
  }

  function canliiDocumentType(document, location) {
    const type = meta(document, 'lbh-type').toLowerCase();
    if (type === 'case' || /^\/[a-z]{2}\/[a-z]{2}\/[^/]+\/doc\/\d{4}\//i.test(location.pathname)) return 'case';
    if (/legislation|statute|regulation|law/.test(type) || /\/laws\//i.test(location.pathname)) return 'legislation';
    return 'secondary';
  }

  function canliiParagraphNodes(document) {
    const output = [];
    const elements = document.querySelectorAll('a.reflex-paragAnchor[name], a[name^="par"], [id^="par"]');
    for (const element of elements) {
      const token = element.getAttribute('name') || element.id || '';
      const match = token.match(/^par(?:ag)?(\d+)$/i);
      if (match && !hidden(element)) {
        output.push(markerNode('paragraph', match[1], element.closest('p') || element, { anchor: token }));
      }
    }
    return uniqueNodes(output);
  }

  function canliiProvisionNodes(document, title) {
    const output = [];
    const elements = document.querySelectorAll('a[name^="sec"], a[id^="sec"], a[name^="art"], a[id^="art"], a[name^="rule"], a[id^="rule"]');
    for (const element of elements) {
      const token = element.getAttribute('name') || element.id || '';
      const locator = core.decodeCanliiProvisionToken(token);
      if (!locator || hidden(element)) continue;
      output.push(markerNode(provisionKind(token, title), locator, element, { anchor: token }));
    }
    return uniqueNodes(output);
  }

  function inspectCanlii(document, location, options = {}) {
    const documentType = canliiDocumentType(document, location);
    const title = semanticTitle(document, ['h1.main-title', 'h1'], documentType);
    const headerText = [meta(document, 'lbh-citation'), meta(document, 'citation_reference'), document.title, textOf(first(document, ['h1.main-title', '.documentMeta']))].filter(Boolean).join(' | ');
    const citation = documentType === 'case'
      ? caseMetadata(document, title, headerText, meta(document, 'lbh-citation'))
      : core.makeCitation(documentType, title, meta(document, 'lbh-citation') || meta(document, 'citation_reference'));
    const root = first(document, ['#originalDocument', '#documentContent', '#docCont', 'main']) || document.body;
    const nativeNodes = options.metadataOnly ? [] : documentType === 'case'
      ? canliiParagraphNodes(document)
      : documentType === 'legislation'
        ? canliiProvisionNodes(document, citation.title)
        : [];
    const cleanUrl = core.cleanProviderUrl('canlii', location.href);
    return {
      provider: 'canlii', documentType, citation, canliiUrl: cleanUrl, cleanUrl,
      documentUrls: acceptedDocumentUrls(document, location, cleanUrl), root, nativeNodes
    };
  }

  function lexisDocumentType(location, document) {
    let documentPath = '';
    try {
      documentPath = new URL(location.href).searchParams.get('pddocfullpath') || '';
    } catch (_) {
      // Saved/provider-mutated pages are classified from the DOM below.
    }
    const path = `${documentPath} ${location.search || ''} ${location.href || ''}`;
    if (/\/cases-ca\//i.test(path)) return 'case';
    if (/\/legislation-ca\//i.test(path)) return 'legislation';
    if (/\/(?:analytical-materials|secondary|commentary|texts?)-/i.test(path)) return 'secondary';
    if (document.querySelector('[id^="PARA_"]')) return 'case';
    return 'secondary';
  }

  function lexisParagraphNodes(document) {
    const output = [];
    for (const element of document.querySelectorAll('[id^="PARA_"]')) {
      const match = element.id.match(/^PARA_(\d+)(?:_|$)/i);
      if (match && !hidden(element)) {
        const paragraph = element.closest('p, li, [role="paragraph"]') || element;
        output.push(markerNode('paragraph', match[1], paragraph, { anchor: element.id }));
      }
    }
    return uniqueNodes(output);
  }

  function lexisProvisionNodes(document, title) {
    const output = [];
    for (const element of document.querySelectorAll('[id^="SECTION_"], [id^="RULE_"], [id^="ARTICLE_"]')) {
      const match = element.id.match(/^(SECTION|RULE|ARTICLE)_(\d+(?:\.\d+)*(?:_[A-Za-z0-9.-]+)*)/i);
      if (!match || hidden(element)) continue;
      const locator = match[2].split('_').reduce((value, part, index) => index ? `${value}(${part})` : part, '');
      output.push(markerNode(provisionKind(match[1], title), locator, element, { anchor: element.id }));
    }
    return uniqueNodes(output);
  }

  function lexisSectionMap(document, root) {
    const sections = [];
    const headings = root ? root.querySelectorAll('h1, h2, h3, [class*="Heading"]') : [];
    for (const heading of headings) {
      const match = textOf(heading).match(/^\s*(?:SECTION|RULE|ARTICLE)\s+(\S+)/i);
      if (!match || hidden(heading)) continue;

      const body = document.createElement('div');
      for (let sibling = heading.nextSibling; sibling; sibling = sibling.nextSibling) {
        if (sibling.nodeType === 1) {
          const text = textOf(sibling);
          const nextProvision = sibling.matches('h1, h2, h3, [class*="Heading"]')
            && /^(?:SECTION|RULE|ARTICLE)\s+/i.test(text);
          if (nextProvision || sibling.matches('[data-id="HideShow_HistoryNotes"]')) break;
        }
        body.appendChild(sibling.cloneNode(true));
      }
      const text = fragments.buildStructureIndex(body, 'text').text;
      if (text) sections.push([match[1], text]);
    }
    return sections;
  }

  function lexisAliasText(root) {
    if (!root) return '';
    const boundary = root.querySelector('.SS_Heading, [id^="PARA_"]');
    if (!boundary) return ''; // Do not promote citations from an unbounded body to document identity.
    const aliases = [];
    for (const block of root.querySelectorAll('.SS_LeftAlign > div')) {
      if (boundary && !(block.compareDocumentPosition(boundary) & 4)) continue;
      const separated = Array.from(block.childNodes).map((node) => core.normalizeSpace(node.textContent)).filter(Boolean).join(' | ');
      if (core.neutralCitations(separated).length || core.reporterCandidates(separated).length) {
        aliases.push(separated);
        break;
      }
    }
    for (const anchor of root.querySelectorAll('a.SS_EmbeddedLink')) {
      if (boundary && !(anchor.compareDocumentPosition(boundary) & 4)) continue;
      const value = textOf(anchor);
      if (value) aliases.push(value);
    }
    return aliases.join(' | ');
  }

  function lexisSecondaryCitation(document, fallbackTitle) {
    const information = Array.from(document.querySelectorAll('.SS_DocumentHeader .SS_DocumentInfo'))
      .map(textOf)
      .filter(Boolean);
    const sourceTitle = information[0] || '';
    const author = information[1] || '';
    if (!sourceTitle) return core.makeCitation('secondary', fallbackTitle, '');
    const titleHtml = `<i>${core.escapeHtml(sourceTitle)}</i>`;
    return {
      title: sourceTitle,
      citation: '',
      plain: author ? `${author}, ${sourceTitle}` : sourceTitle,
      html: author ? `${core.escapeHtml(author)}, ${titleHtml}` : titleHtml
    };
  }

  function lexisSecondaryNodes(document, root, title) {
    const headings = [title, ...Array.from(document.querySelectorAll('#SS_DocumentTitle, h1, h2')).map(textOf)];
    for (const heading of headings) {
      const match = String(heading || '').match(/^\s*\u00a7\s*(\d+(?:\.\d+)*(?:\([^()]+\))*)\b/);
      if (!match) continue;
      return [markerNode('silcrow', match[1], root, {
        markerText: `\u00a7 ${match[1]}`,
        source: 'provider-native'
      })];
    }
    return [];
  }

  function inspectLexis(document, location, options = {}) {
    const documentType = lexisDocumentType(location, document);
    const title = semanticTitle(document, ['#SS_DocumentTitle', '[data-testid="document-title"]', '.SS_DocumentHeader .SS_DocumentInfo', 'h1'], documentType);
    const root = first(document, ['#document', '.document-text', '.SS_contentdocument', 'main']) || document.body;
    const firstParagraph = document.querySelector('[id^="PARA_"]');
    const header = first(document, ['.SS_DocumentHeader', '[data-testid="document-header"]']);
    const boundary = firstParagraph || root.querySelector('.SS_Heading, .SS_Heading2, [id^="SECTION_"]');
    const headerText = [meta(document, 'citation_reference'), title, document.title, lexisAliasText(root),
      header ? textOf(header) : boundary ? boundedTextBefore(root, boundary, 14000) : ''].filter(Boolean).join(' | ');
    const heading = core.splitCaseHeading(title);
    const citation = documentType === 'case'
      ? caseMetadata(document, heading.name, headerText, heading.citation)
      : documentType === 'secondary'
        ? lexisSecondaryCitation(document, title)
        : core.makeCitation(documentType, title, meta(document, 'citation_reference'));
    const nativeNodes = options.metadataOnly ? [] : documentType === 'legislation'
      ? lexisProvisionNodes(document, citation.title)
      : documentType === 'secondary'
        ? lexisSecondaryNodes(document, root, title)
        : lexisParagraphNodes(document);
    const cleanUrl = core.cleanProviderUrl('lexis', location.href);
    return {
      provider: 'lexis', documentType, citation,
      sectionMap: !options.metadataOnly && documentType === 'legislation' ? lexisSectionMap(document, root) : [],
      canliiUrl: documentType === 'case'
        ? detectedCanliiUrl(document, root, firstParagraph, citation.citation, headerText, location.href)
        : '',
      cleanUrl, documentUrls: acceptedDocumentUrls(document, location, cleanUrl), root, nativeNodes
    };
  }

  function westlawDocumentType(document) {
    if (document.querySelector('.crsw_caselaw, [data-document-type="case"], [id^="crsw_paragraph_num_"]')) return 'case';
    if (document.querySelector('.crsw_legislation, [data-document-type="legislation"], [data-section-number], [data-rule-number], [data-article-number]')) return 'legislation';
    return 'secondary';
  }

  function westlawParagraphNodes(document) {
    const output = [];
    for (const element of document.querySelectorAll('[id^="crsw_paragraph_num_"]')) {
      const match = element.id.match(/^crsw_paragraph_num_(\d+)$/i);
      if (match && !hidden(element)) output.push(markerNode('paragraph', match[1], element, { anchor: element.id }));
    }
    return uniqueNodes(output);
  }

  function westlawProvisionNodes(document, title) {
    const output = [];
    const selectors = '[data-section-number], [data-rule-number], [data-article-number]';
    for (const element of document.querySelectorAll(selectors)) {
      const attribute = ['data-section-number', 'data-rule-number', 'data-article-number'].find((name) => element.hasAttribute(name));
      const locator = element.getAttribute(attribute);
      const anchor = element.id || '';
      output.push(markerNode(provisionKind(attribute, title), locator, element, {
        anchor,
        fragment: anchor ? '' : core.makeTextFragment(locator)
      }));
    }
    return uniqueNodes(output);
  }

  function inspectWestlaw(document, location, options = {}) {
    const documentType = westlawDocumentType(document);
    const title = semanticTitle(document, ['#co_docHeaderTitleLine', '#titleInfo', '.crsw_shortTitle', 'h1'], documentType);
    const root = first(document, ['#co_document_0', '.co_document', 'main']) || document.body;
    const prelimElement = first(document, ['.crsw_prelim', '#co_docHeader']);
    const prelim = textOf(prelimElement);
    const toolbarCitation = textOf(first(document, ['#citeInfo', '.co_cites']));
    const headerText = `${prelim} | ${toolbarCitation} | ${document.title}`;
    const citation = documentType === 'case'
      ? caseMetadata(document, title, headerText, toolbarCitation)
      : core.makeCitation(documentType, title, toolbarCitation);
    const nativeNodes = options.metadataOnly ? [] : documentType === 'legislation'
      ? westlawProvisionNodes(document, citation.title)
      : westlawParagraphNodes(document);
    const cleanUrl = core.cleanProviderUrl('westlaw', location.href);
    return {
      provider: 'westlaw', documentType, citation,
      canliiUrl: documentType === 'case'
        ? detectedCanliiUrl(document, prelimElement || root, null, citation.citation, headerText, location.href)
        : '',
      cleanUrl, documentUrls: acceptedDocumentUrls(document, location, cleanUrl), root, nativeNodes
    };
  }

  function adapterFor(location) {
    const hostname = String(location.hostname || '').toLowerCase();
    if (hostname === 'www.canlii.org' || hostname === 'canlii.org') return inspectCanlii;
    if (hostname === 'advance.lexis.com') return inspectLexis;
    if (hostname === 'nextcanada.westlaw.com' || hostname === 'www.nextcanada.westlaw.com') return inspectWestlaw;
    return null;
  }

  function inspectBase(document, location, options) {
    const adapter = adapterFor(location);
    return adapter ? adapter(document, location, options) : null;
  }

  function requestEngine(input) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'LEGAL_PINPOINTER_DERIVE_STRUCTURE', input }, (response) => {
        if (chrome.runtime.lastError) reject(new Error('The local legal structure engine did not respond.'));
        else if (!response || response.ok !== true) reject(new Error(response && response.message ? response.message : 'Legal structure derivation failed.'));
        else resolve(response);
      });
    });
  }

  function requestLegislationUrl(citation, language) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'LEGAL_PINPOINTER_RESOLVE_LEGISLATION',
        input: { title: citation.title, citation: citation.citation, language }
      }, (response) => {
        if (chrome.runtime.lastError || !response || response.ok !== true) resolve('');
        else resolve(response.url || '');
      });
    });
  }

  function engineInput(base, plane) {
    const input = {
      citation: base.citation.plain,
      source_kind: base.documentType === 'legislation' ? 'laws' : 'cases',
      text: plane.text,
      id: `legal-pinpointer:${base.provider}:${base.citation.plain}`,
      url: base.cleanUrl,
      name: base.citation.title,
      provider: base.provider
    };
    if (base.sectionMap && base.sectionMap.length) input.section_map = base.sectionMap;
    return input;
  }

  function locatorFromLabel(kind, label) {
    const prefix = kind === 'page' ? 'page' : kind === 'paragraph' ? 'par' : 'sec';
    const locator = String(label || '').startsWith(prefix) ? String(label).slice(prefix.length) : '';
    return core.parseLocator(locator) ? locator : '';
  }

  function pointElement(point, root) {
    if (!point) return null;
    const element = point.node.nodeType === 1 ? point.node : point.node.parentElement;
    return element && root.contains(element) ? element : null;
  }

  function pointPassage(point, root) {
    const marker = pointElement(point, root);
    return marker && marker.closest ? (marker.closest('p, li, [role="paragraph"]') || marker) : marker;
  }

  function markerText(kind, locator, plane, start, contentStart) {
    if (Number.isInteger(contentStart) && contentStart > start) {
      const exact = plane.text.slice(start, contentStart).trim();
      if (exact) return exact.slice(0, 120);
    }
    const excerpt = plane.text.slice(start, start + 160);
    const escaped = String(locator).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = kind === 'paragraph'
      ? new RegExp(`^\\s*(?:\\[\\s*${escaped}\\s*\\]|${escaped}\\.)(?=\\s|$)`, 'i')
      : new RegExp(`^\\s*(?:(?:s(?:ection)?|r(?:ule)?|art(?:icle)?)\\.?\\s*)?${escaped}[.):.-]?(?=\\s|$)`, 'i');
    const match = excerpt.match(pattern);
    if (match) return match[0].trim();
    return kind === 'paragraph' ? `[${locator}]` : locator;
  }

  function engineNode(node, kind, plane, offsetAt, structureKind, provider) {
    const locator = locatorFromLabel(kind, node.label);
    if (!locator || !node.range || !Number.isInteger(node.range.start) || !Number.isInteger(node.range.end)) return null;
    const start = offsetAt(node.range.start);
    const end = offsetAt(node.range.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
    const contentStart = node.content_start == null ? null : offsetAt(node.content_start);
    const startPoint = fragments.boundaryPoint(plane, start);
    const endPoint = fragments.boundaryPoint(plane, end);
    const contentStartPoint = Number.isInteger(contentStart) ? fragments.boundaryPoint(plane, contentStart) : null;
    const text = markerText(kind, locator, plane, start, contentStart);
    const element = pointPassage(startPoint, plane.root);
    if (!startPoint || !endPoint || !element) return null;
    return {
      kind: structureKind, locator, element, startPoint, endPoint, contentStartPoint,
      anchor: engineAnchorId(element, provider),
      fragment: core.makeTextFragment(text), markerText: text,
      source: 'legal-structure', engineId: node.id, parentId: node.parent_id || ''
    };
  }

  function mergeProvisionNodes(exactNodes, nativeNodes) {
    const nativeByLocator = new Map(nativeNodes.map((node) => [node.locator, node]));
    const merged = exactNodes.map((node) => {
      const native = nativeByLocator.get(node.locator);
      return native && native.anchor ? { ...node, anchor: native.anchor } : node;
    });
    const seen = new Set(merged.map((node) => node.locator));
    merged.push(...nativeNodes.filter((node) => !seen.has(node.locator)));
    return uniqueNodes(merged.sort((left, right) => {
      if (!left.element || !right.element || left.element === right.element) {
        return core.provisionDepth(left.locator) - core.provisionDepth(right.locator);
      }
      const position = left.element.compareDocumentPosition(right.element);
      if (position & 4) return -1;
      if (position & 2) return 1;
      return 0;
    }));
  }

  function exactPageMarkerBefore(text, contentStart, locator) {
    const from = Math.max(0, contentStart - 100);
    const prefix = text.slice(from, contentStart);
    const match = prefix.match(new RegExp(`\\[page[ \\t]+${locator}\\][ \\t\\r\\n]*$`, 'i'));
    if (!match) return null;
    return { start: from + match.index, end: contentStart, text: `[page ${locator}]` };
  }

  function exactPageMarkerAt(text, start, locator) {
    const match = text.slice(start, start + 100)
      .match(new RegExp(`^\\[page[ \\t]+${locator}\\][ \\t\\r\\n]*`, 'i'));
    return match ? { start, end: start + match[0].length, text: `[page ${locator}]` } : null;
  }

  function pageNodes(engine, plane, offsetAt) {
    const raw = (engine.nodes || []).filter((node) => node.kind === 'page');
    const nodes = [];
    for (const node of raw) {
      const locator = locatorFromLabel('page', node.label);
      const contentStart = node.range && offsetAt(node.range.start);
      const end = node.range && offsetAt(node.range.end);
      if (!locator || !Number.isInteger(contentStart) || !Number.isInteger(end)) continue;
      const marker = exactPageMarkerBefore(plane.text, contentStart, locator)
        || exactPageMarkerAt(plane.text, contentStart, locator);
      if (!marker) continue;
      const startPoint = fragments.boundaryPoint(plane, marker.start);
      const endPoint = fragments.boundaryPoint(plane, end);
      const element = pointElement(startPoint, plane.root);
      if (!startPoint || !endPoint || !element) continue;
      nodes.push({
        kind: 'page', locator, element, startPoint, endPoint,
        fragment: core.makeTextFragment(marker.text), markerText: marker.text,
        source: 'legal-structure', engineId: node.id, parentId: '', endOffset: end
      });
    }

    if (nodes.length) {
      const last = nodes[nodes.length - 1];
      const expected = String(Number(last.locator) + 1);
      const match = plane.text.slice(last.endOffset, last.endOffset + 100)
        .match(new RegExp(`^\\[page[ \\t]+${expected}\\]`, 'i'));
      if (match) {
        const start = last.endOffset;
        const startPoint = fragments.boundaryPoint(plane, start);
        const endPoint = fragments.boundaryPoint(plane, plane.text.length);
        const element = pointElement(startPoint, plane.root);
        if (startPoint && endPoint && element) {
          nodes.push({
            kind: 'page', locator: expected, element, startPoint, endPoint,
            fragment: core.makeTextFragment(`[page ${expected}]`), markerText: `[page ${expected}]`,
            source: 'legal-structure', engineId: `${last.engineId}:trailing`, parentId: ''
          });
        }
      }
    }

    const consecutive = nodes.length >= 3 && nodes.every((node, index) => (
      index === 0 || Number(node.locator) === Number(nodes[index - 1].locator) + 1
    ));
    return consecutive ? nodes.map(({ endOffset, ...node }) => node) : [];
  }

  function engineOffsets(text, engine) {
    const valid = offset => Number.isInteger(offset) && offset >= 0 && offset <= text.length;
    if (engine.offset_unit === 'utf16') return offset => valid(offset) ? offset : undefined;
    if (engine.offset_unit !== 'unicode_scalar') return null;
    const wanted = new Set();
    for (const node of engine.nodes || []) {
      for (const offset of [node.range?.start, node.range?.end, node.content_start]) {
        if (valid(offset)) wanted.add(offset);
      }
    }
    const mapped = new Map();
    let scalar = 0, utf16 = 0;
    for (const offset of [...wanted].sort((a, b) => a - b)) {
      while (scalar < offset && utf16 < text.length) {
        utf16 += text.codePointAt(utf16) > 0xffff ? 2 : 1;
        scalar += 1;
      }
      if (scalar === offset) mapped.set(offset, utf16);
    }
    return offset => mapped.get(offset);
  }

  function engineStructure(base, plane, engine) {
    const offsetAt = engineOffsets(plane.text, engine);
    if (!offsetAt) return { kind: '', nodes: [], source: 'none' };
    const pages = pageNodes(engine, plane, offsetAt);
    if (pages.length) return { kind: 'page', nodes: pages, source: 'legal-structure' };
    if (base.documentType !== 'legislation' && base.nativeNodes.length) {
      return { kind: base.nativeNodes[0].kind, nodes: uniqueNodes(base.nativeNodes), source: 'provider-native' };
    }

    const engineKind = base.documentType === 'legislation' ? 'section' : 'paragraph';
    const structureKind = engineKind === 'section' ? provisionKind('', base.citation.title) : 'paragraph';
    const nodes = (engine.nodes || [])
      .filter((node) => node.kind === engineKind)
      .map((node) => engineNode(node, engineKind, plane, offsetAt, structureKind, base.provider))
      .filter(Boolean);
    const merged = base.documentType === 'legislation'
      ? mergeProvisionNodes(nodes, base.nativeNodes)
      : uniqueNodes(nodes);
    return {
      kind: merged.length ? (merged[0].kind || structureKind) : structureKind,
      nodes: merged,
      source: nodes.length ? 'legal-structure' : merged.length ? 'provider-native' : 'none'
    };
  }

  async function inspect(document, location, deriveEngine, options = {}) {
    const base = inspectBase(document, location, options);
    if (!base) return null;

    if (base.documentType === 'legislation' && base.provider !== 'canlii') {
      base.canliiUrl = await requestLegislationUrl(base.citation, document.documentElement.lang || 'en');
    }

    // Citation copying/navigation and an unselected popup need metadata, not
    // text-to-DOM maps, secondary markers, section clones, or a WASM parse.
    if (options.metadataOnly) return base;

    if (base.documentType === 'secondary') {
      const symbols = symbolNodes(base.root);
      const nodes = symbols.length ? symbols : base.nativeNodes;
      if (nodes.length) {
        return { ...base, structure: { kind: nodes[0].kind, nodes, source: symbols.length ? 'symbol-marker' : 'provider-native' }, engineRevision: '' };
      }
    }

    const plane = fragments.buildStructureIndex(base.root, true);
    plane.root = base.root;
    const engine = await (deriveEngine || requestEngine)(engineInput(base, plane));
    return {
      ...base,
      structure: engineStructure(base, plane, engine),
      engineRevision: engine.engine_source_sha256 || ''
    };
  }

  const api = {
    adapterFor,
    engineInput,
    engineStructure,
    inspect,
    inspectBase,
    inspectCanlii,
    inspectLexis,
    inspectWestlaw,
    providerAnchorId,
    symbolNodes
  };

  global.LegalPinpointerProviders = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
