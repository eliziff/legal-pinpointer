'use strict';

(function installPageSearch(global) {
  if (global.LegalPinpointerSearchPage) return;
  const core = global.LegalPinpointerFindCore;
  const HIT = 'legal-pinpointer-sonar-hits', ACTIVE = 'legal-pinpointer-sonar-active';
  const MAX_CHARS = 4_000_000, MAX_NODES = 150_000, MAX_RESULTS = 200;
  let revision = 0, index = null, indexing = null, expiry = 0, onChange = null;
  const caches = new Map(), observers = [], sheets = new Map();
  let returnHost = null, savedScroll = null;
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  const ownUI = node => node.nodeType === 1 && node.hasAttribute('data-pinpointer-sonar');

  function clearPaint() {
    CSS.highlights?.delete(HIT); CSS.highlights?.delete(ACTIVE);
    for (const [root, sheet] of sheets) root.adoptedStyleSheets = root.adoptedStyleSheets.filter(s => s !== sheet);
    sheets.clear();
  }
  function invalidate(records) {
    if (records?.every(r => ownUI(r.target) || (r.type === 'childList' &&
        [...r.addedNodes, ...r.removedNodes].every(ownUI)))) return;
    revision++; index = null; clearPaint(); onChange?.();
  }
  function observe(roots) {
    observers.splice(0).forEach(o => o.disconnect());
    for (const root of roots) {
      const observer = new MutationObserver(invalidate);
      observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'open'] });
      observers.push(observer);
    }
  }
  function documentRoot() {
    // Only this optional root preference is provider-specific; matching is universal.
    if (/^(www\.)?canlii\.org$/i.test(location.hostname)) {
      const source = document.querySelector('#originalDocument, #documentContent, #docCont');
      if (source) return source;
    }
    return document.body;
  }
  async function buildIndex() {
    const root = documentRoot();
    if (!root || document.contentType === 'application/pdf') throw new Error('No searchable HTML text.');
    const output = [], roots = new Set([root]);
    observe(roots);
    const version = revision;
    let text = '', parts = [], treeRoot = null, chars = 0, visited = 0, lastBreak = false;
    let deadline = performance.now() + 12, limited = false;
    const flush = () => {
      if (text.trim()) output.push({ text, parts, root: treeRoot });
      text = ''; parts = []; treeRoot = null; lastBreak = false;
    };
    const stack = [{ node: root, paragraph: false }];
    while (stack.length) {
      if (version !== revision) throw new Error('Page changed while reading; search again.');
      if (++visited > MAX_NODES || chars >= MAX_CHARS) { limited = true; break; }
      if (performance.now() > deadline) { await pause(); deadline = performance.now() + 12; }
      const item = stack.pop();
      if (item.exit) { flush(); continue; }
      const node = item.node;
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.nodeValue.replace(/\s/g, ' ');
        if (!value.trim() && !text) continue;
        if (node.parentElement && getComputedStyle(node.parentElement).visibility !== 'visible') continue;
        const nodeRoot = node.getRootNode();
        if (treeRoot && treeRoot !== nodeRoot) flush();
        treeRoot = nodeRoot;
        const accepted = value.slice(0, MAX_CHARS - chars);
        parts.push({ node, start: text.length, end: text.length + accepted.length });
        text += accepted; chars += accepted.length;
        if (accepted.trim()) lastBreak = false;
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || ownUI(node)) continue;
      if (node.matches('script, style, noscript, template, input, textarea, select, [hidden], [aria-hidden="true"], [inert]') || node.isContentEditable) {
        if (/^(P|DIV|LI|SECTION|BR)$/.test(node.tagName)) flush();
        continue;
      }
      if (node.tagName === 'DETAILS' && !node.open) {
        const summary = node.querySelector(':scope > summary');
        if (summary) stack.push({ node: summary, paragraph: false });
        continue;
      }
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.contentVisibility === 'hidden') continue;
      if (node.tagName === 'BR') {
        if (lastBreak) flush(); else { text += ' '; lastBreak = true; }
        continue;
      }
      if (!item.paragraph && node.matches('a[name], a[id]') && /^par(?:ag)?\d+$/i.test(node.getAttribute('name') || node.id)) flush();
      const paragraph = node.tagName === 'P' || node.getAttribute('role') === 'paragraph';
      const block = !item.paragraph && (paragraph || /^(?:block|flow-root|flex|grid|list-item|table)/.test(style.display));
      if (block) { flush(); stack.push({ exit: true }); }
      let children;
      if (node.shadowRoot) { roots.add(node.shadowRoot); children = node.shadowRoot.childNodes; }
      else if (node.tagName === 'SLOT') { const assigned = node.assignedNodes({ flatten: true }); children = assigned.length ? assigned : node.childNodes; }
      else children = node.childNodes;
      for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], paragraph: paragraph || item.paragraph });
    }
    flush();
    if (version !== revision) throw new Error('Page changed while reading; search again.');
    observe(roots);
    return { paragraphs: output, limited, version, url: location.href };
  }
  function rangeFor(paragraph, start, end) {
    const lookup = offset => {
      let lo = 0, hi = paragraph.parts.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1, part = paragraph.parts[mid];
        if (offset < part.start) hi = mid - 1;
        else if (offset >= part.end) lo = mid + 1;
        else return part;
      }
      return null;
    };
    const first = lookup(start), last = lookup(end - 1);
    if (!first?.node.isConnected || !last?.node.isConnected) return null;
    const range = document.createRange();
    range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start);
    return range;
  }
  async function search({ query, mode, ticket }) {
    clearTimeout(expiry); expiry = setTimeout(releaseAll, 15 * 60_000);
    const compiled = core.compile(query, mode);
    if (!index || index.url !== location.href) {
      if (!indexing) indexing = buildIndex().finally(() => { indexing = null; });
      index = await indexing;
    }
    const snapshot = index, found = [];
    let limited = snapshot.limited, deadline = performance.now() + 12;
    outer: for (const paragraph of snapshot.paragraphs) {
      if (performance.now() > deadline) { await pause(); deadline = performance.now() + 12; }
      const units = compiled.mode === 'p' ? [{ start: 0, end: paragraph.text.length }]
        : (paragraph.sentences ||= core.sentences(paragraph.text, document.documentElement.lang || 'en'));
      for (const unit of units) {
        const hits = core.matches(compiled.tree, paragraph.text.slice(unit.start, unit.end));
        if (!hits.length) continue;
        if (found.length === MAX_RESULTS) { limited = true; break outer; }
        const ranges = hits.slice(0, 100).map(h => rangeFor(paragraph, unit.start + h.start, unit.start + h.end)).filter(Boolean);
        if (!ranges.length) continue;
        const start = Math.max(unit.start, unit.start + hits[0].start - 90), end = Math.min(unit.end, start + 460);
        const container = ranges[0].startContainer.parentElement?.closest('p, li, [role="paragraph"]');
        const marker = container?.querySelector('a[name^="par"], a[id^="par"], [id^="PARA_"]');
        const number = /^(?:par(?:ag)?|PARA_)(\d+)/i.exec(marker?.getAttribute('name') || marker?.id || '');
        found.push({ paragraph, ranges, expected: ranges.map(r => r.toString()),
          preview: paragraph.text.slice(start, end), leading: start > unit.start, trailing: end < unit.end,
          locator: number ? `para ${number[1]}` : '',
          marks: hits.map(h => ({ start: unit.start + h.start - start, end: unit.start + h.end - start }))
            .filter(h => h.start >= 0 && h.start < end - start).slice(0, 50) });
      }
    }
    if (snapshot.version !== revision || snapshot.url !== location.href) throw new Error('Page changed; refresh the search.');
    caches.set(ticket, { results: found, version: revision, url: location.href });
    while (caches.size > 3) caches.delete(caches.keys().next().value);
    return { url: location.href, title: document.title, limited, results: found.map((r, i) => ({
      index: i, preview: r.preview, leading: r.leading, trailing: r.trailing, marks: r.marks, locator: r.locator
    })) };
  }
  function selected(ticket, position) {
    const cache = caches.get(ticket), result = cache?.results[position];
    if (!result || cache.version !== revision || cache.url !== location.href || result.ranges.some((r, i) =>
      !r.startContainer.isConnected || !r.endContainer.isConnected || r.toString() !== result.expected[i])) {
      throw new Error('This passage changed or expired. Refresh the search before opening it.');
    }
    return { cache, result };
  }
  function preview(ticket, position, scroll = false) {
    const { cache, result } = selected(ticket, position);
    clearPaint();
    const all = new Highlight(), active = new Highlight(); active.priority = 2;
    for (const match of cache.results) {
      for (const range of match.ranges) all.add(range);
      if (!sheets.has(match.paragraph.root)) {
        const sheet = new CSSStyleSheet(); sheet.replaceSync(`::highlight(${HIT}) {background:#ffe096;color:#24201a} ::highlight(${ACTIVE}) {background:#17685b;color:white}`);
        match.paragraph.root.adoptedStyleSheets = [...match.paragraph.root.adoptedStyleSheets, sheet];
        sheets.set(match.paragraph.root, sheet);
      }
    }
    result.ranges.forEach(r => active.add(r)); CSS.highlights.set(HIT, all); CSS.highlights.set(ACTIVE, active);
    if (scroll) {
      const range = result.ranges[0], parent = range.startContainer.parentElement;
      if (!savedScroll) {
        savedScroll = [{ node: window, x: scrollX, y: scrollY }];
        for (let e = parent; e; e = e.parentElement || e.getRootNode().host) {
          if (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth) savedScroll.push({ node: e, x: e.scrollLeft, y: e.scrollTop });
        }
      }
      parent?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      for (let e = parent; e && e !== document.body; e = e.parentElement || e.getRootNode().host) {
        if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight) {
          e.scrollTop += range.getBoundingClientRect().top - e.getBoundingClientRect().top - e.clientHeight / 2;
        }
      }
      window.scrollBy({ top: range.getBoundingClientRect().top - innerHeight / 2, behavior: 'instant' });
    }
    return true;
  }
  function restore() {
    for (const { node, x, y } of savedScroll || []) node.scrollTo({ left: x, top: y, behavior: 'instant' });
    savedScroll = null; returnHost?.remove(); returnHost = null; clearPaint();
  }
  function reveal(ticket, position, origin) {
    preview(ticket, position, true);
    returnHost?.remove();
    returnHost = document.createElement('div'); returnHost.setAttribute('data-pinpointer-sonar', '');
    returnHost.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647';
    const shadow = returnHost.attachShadow({ mode: 'closed' }), button = document.createElement('button');
    button.textContent = '← Return to Tab Sonar'; button.style.cssText = 'padding:10px 16px;border-radius:10px;border:1px solid #78988b;background:#fff;color:#154c42;font:14px system-ui;cursor:pointer';
    button.onclick = async () => {
      try {
        const reply = await chrome.runtime.sendMessage({ type: 'SONAR_RETURN', session: origin });
        if (!reply?.ok) button.textContent = reply?.message || 'Search is no longer open.';
      } catch (_) { button.textContent = 'Search is no longer open.'; }
    };
    shadow.append(button); document.documentElement.append(returnHost);
    return true;
  }
  function release(ticket) { caches.delete(ticket); clearPaint(); returnHost?.remove(); returnHost = null; if (!caches.size) releaseAll(); }
  function releaseAll() {
    revision++; caches.clear(); index = null; savedScroll = null; clearTimeout(expiry);
    observers.splice(0).forEach(o => o.disconnect()); clearPaint(); returnHost?.remove(); returnHost = null;
  }
  global.LegalPinpointerSearchPage = { search, preview, reveal, restore, release, clearPaint, setOnChange(fn) { onChange = fn; } };
})(globalThis);
