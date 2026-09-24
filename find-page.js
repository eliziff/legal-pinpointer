'use strict';

(function installPageSearch(global) {
  if (global.LegalPinpointerSearchPage) return;
  const core = global.LegalPinpointerFindCore;
  const HIT = 'legal-pinpointer-sonar-hits', ACTIVE = 'legal-pinpointer-sonar-active';
  const MAX_CHARS = 4_000_000, MAX_NODES = 150_000, MAX_RESULTS = 200, MAX_PARAGRAPH = 65_536, MAX_PAINT = 2000;
  // `onChange` is the in-page find UI's callback; `watching` names the side panel
  // workspace and/or exact-search ticket told (once per read) when the page changes.
  let revision = 0, index = null, indexing = null, expiry = 0, onChange = null, watching = null, notified = false;
  const caches = new Map(), jobs = new Map(), observers = [], sheets = new Map();
  let returnHost = null, savedScroll = null, painted = null;
  // Prefer scheduler continuations: chained timers are throttled in background tabs.
  const pause = () => global.scheduler?.yield ? global.scheduler.yield()
    : global.scheduler?.postTask ? global.scheduler.postTask(() => {})
      : new Promise(resolve => setTimeout(resolve, 0));
  const ownUI = node => node.nodeType === 1 && node.hasAttribute('data-pinpointer-sonar');

  function clearPaint() {
    painted = null;
    CSS.highlights?.delete(HIT); CSS.highlights?.delete(ACTIVE);
    for (const [root, sheet] of sheets) root.adoptedStyleSheets = root.adoptedStyleSheets.filter(s => s !== sheet);
    sheets.clear();
  }
  function invalidate(records) {
    if (records?.every(r => ownUI(r.target) || (r.type === 'childList' &&
        [...r.addedNodes, ...r.removedNodes].every(ownUI)))) return;
    const had = Boolean(index || caches.size);
    revision++; index = null; caches.clear(); clearPaint();
    if (had) onChange?.();
    if (watching && !notified) {
      notified = true;
      void chrome.runtime.sendMessage({ type: 'SONAR_INVALIDATED', ...watching }).catch(() => {});
    }
  }
  function observe(roots, reset = false) {
    if (reset) observers.splice(0).forEach(o => o.disconnect());
    const observer = observers[0] || new MutationObserver(invalidate);
    if (!observers.length) observers.push(observer);
    for (const root of roots) {
      observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'open', 'inert', 'contenteditable', 'slot', 'name'] });
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
    const output = [], roots = new Set([document.documentElement]), styles = new WeakMap();
    const styleOf = node => {
      if (!styles.has(node)) styles.set(node, getComputedStyle(node));
      return styles.get(node);
    };
    observe(roots, true);
    const version = revision;
    let text = '', parts = [], treeRoot = null, chars = 0, visited = 0, lastBreak = false;
    let deadline = performance.now() + 8, limited = false, oversized = false, budgetStopped = false;
    const flush = () => {
      if (!oversized && text.trim()) output.push({ text, parts, root: treeRoot });
      text = ''; parts = []; treeRoot = null; lastBreak = false; oversized = false;
    };
    const stack = [{ node: root, paragraph: false }];
    while (stack.length) {
      if (version !== revision) throw new Error('Page changed while reading; search again.');
      if (++visited > MAX_NODES || chars >= MAX_CHARS) { limited = budgetStopped = true; break; }
      if (performance.now() > deadline) {
        await pause();
        if (![...jobs.values()].some(job => !job.cancelled && Date.now() <= job.deadline)) throw new Error('Search cancelled or timed out.');
        deadline = performance.now() + 8;
      }
      const item = stack.pop();
      // Keep one child iterator per depth instead of allocating a stack entry
      // for every sibling on giant/hostile DOMs before the node budget is checked.
      if (item.children) {
        if (item.cursor < item.children.length) {
          stack.push(item);
          stack.push({ node: item.children[item.cursor++], paragraph: item.paragraph });
        }
        continue;
      }
      if (item.exit) { flush(); continue; }
      const node = item.node;
      if (node.nodeType === Node.TEXT_NODE) {
        const raw = node.nodeValue;
        if (oversized || text.length + raw.length > MAX_PARAGRAPH) {
          // Never truncate a paragraph into a false NOT match or false sentence.
          // Omit this whole pathological unit and explicitly report partial results.
          oversized = limited = true; chars += raw.length; text = ''; parts = [];
          continue;
        }
        const value = raw.replace(/\s/g, ' ');
        if (!value.trim() && !text) continue;
        if (node.parentElement && styleOf(node.parentElement).visibility !== 'visible') continue;
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
      const style = styleOf(node);
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
      if (node.shadowRoot) { roots.add(node.shadowRoot); observe([node.shadowRoot]); children = node.shadowRoot.childNodes; }
      else if (node.tagName === 'SLOT') { const assigned = node.assignedNodes({ flatten: true }); children = assigned.length ? assigned : node.childNodes; }
      else children = node.childNodes;
      stack.push({ children, cursor: 0, paragraph: paragraph || item.paragraph });
    }
    if (budgetStopped) { oversized = true; } // Do not publish a budget-truncated final unit.
    flush();
    if (version !== revision) throw new Error('Page changed while reading; search again.');
    return { paragraphs: output, characters: Math.min(chars, MAX_CHARS), limited, version, url: location.href };
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
  function flushMutations() {
    for (const observer of observers) {
      const records = observer.takeRecords();
      if (records.length) invalidate(records);
    }
  }
  function rangesFor(result) {
    if (!result.ranges) {
      result.ranges = result.hits.map(h => rangeFor(result.paragraph, h.start, h.end)).filter(Boolean);
      result.expected = result.ranges.map(r => r.toString());
    }
    return result.ranges;
  }
  async function search({ query, mode, ticket, deadline = Date.now() + 5000, refresh = false }) {
    const job = { cancelled: false, deadline };
    jobs.get(ticket)?.abort?.();
    job.abort = () => { job.cancelled = true; };
    jobs.set(ticket, job);
    const check = () => {
      if (job.cancelled || Date.now() > deadline) throw new Error('Search cancelled or timed out.');
    };
    clearTimeout(expiry); expiry = setTimeout(releaseAll, 15 * 60_000);
    try {
      const compiled = core.compile(query, mode), snapshot = await ensureIndex(check, refresh);
      const found = [];
      let limited = snapshot.limited, hitCount = 0, sliceEnd = performance.now() + 8;
      outer: for (const paragraph of snapshot.paragraphs) {
        check();
        if (performance.now() > sliceEnd) { await pause(); check(); sliceEnd = performance.now() + 8; }
        const sentenceCache = compiled.mode === 's' && !paragraph.sentences ? [] : null;
        const units = compiled.mode === 'p' ? [{ start: 0, end: paragraph.text.length }]
          : (paragraph.sentences || core.sentenceUnits(paragraph.text, document.documentElement.lang || 'en'));
        for (const unit of units) {
          if (sentenceCache) sentenceCache.push(unit);
          if (performance.now() > sliceEnd) { await pause(); check(); sliceEnd = performance.now() + 8; }
          const hits = core.matches(compiled.tree, paragraph.text.slice(unit.start, unit.end), 100);
          if (!hits.length) continue;
          limited ||= hits.limited;
          if (found.length === MAX_RESULTS) { limited = true; break outer; }
          const result = passageResult(paragraph, unit, hits.map(h => ({ start: unit.start + h.start, end: unit.start + h.end })));
          if (!result) continue;
          hitCount += hits.length;
          found.push(result);
        }
        if (sentenceCache) paragraph.sentences = sentenceCache;
      }
      return publish(snapshot, ticket, check, found, limited || hitCount > MAX_PAINT, { title: await pageTitle() });
    } finally {
      if (jobs.get(ticket) === job) jobs.delete(ticket);
    }
  }
  async function ensureIndex(check, refresh = false) {
    flushMutations();
    if (refresh) { revision++; index = null; caches.clear(); clearPaint(); }
    check();
    if (!index || index.url !== location.href) {
      if (!indexing || indexing.version !== revision) {
        const work = { version: revision };
        work.promise = buildIndex().finally(() => { if (indexing === work) indexing = null; });
        indexing = work;
      }
      const ready = await indexing.promise;
      check();
      if (ready.version !== revision) throw new Error('Page changed; refresh the search.');
      index = ready;
    }
    return index;
  }
  // Work outside a search (panel reads, ranked handles) keeps DOM reads alive.
  async function withJob(task, ms = 8000) {
    const job = { cancelled: false, deadline: Date.now() + ms }, key = Symbol('job');
    job.abort = () => { job.cancelled = true; };
    jobs.set(key, job);
    clearTimeout(expiry); expiry = setTimeout(releaseAll, 15 * 60_000);
    try { return await task(() => { if (job.cancelled || Date.now() > job.deadline) throw new Error('Search cancelled or timed out.'); }); }
    finally { jobs.delete(key); }
  }
  // Exact searches keep the page index warm for the next exact search; ranked
  // work does not need it once the panel has the text.
  const exactCaches = () => [...caches.values()].some(cache => !cache.units);
  // The observed paragraph number around a text node, for example `para 12`.
  function paraNumber(node) {
    const container = node?.parentElement?.closest('p, li, [role="paragraph"]');
    const marker = container?.querySelector('a[name^="par"], a[id^="par"], [id^="PARA_"]');
    return +(/^(?:par(?:ag)?|PARA_)(\d+)/i.exec(marker?.getAttribute('name') || marker?.id || '')?.[1] || 0);
  }
  const locatorOf = node => { const number = paraNumber(node); return number ? `para ${number}` : ''; };
  // The citation Pinpointer's Alt+X copies on supported legal pages, else the page title.
  async function pageTitle() {
    try { return (await global.LegalPinpointerSonarCitation?.()) || document.title; } catch (_) { return document.title; }
  }
  // Every paragraph's text for the side panel's own ranked index, joined by
  // newlines (units never contain one). The revision names the exact text, so an
  // unchanged page answers `same` without sending it. The page then drops its
  // index: the panel holds the only copy, and a jump or copy re-reads the page.
  function units({ known = '', workspace, deadline = Date.now() + 8000 }) {
    // Watch first: a page that changes while it is read says so, and is read again.
    watching = { ...watching, workspace }; notified = false;
    return withJob(async check => {
      const snapshot = await ensureIndex(check), texts = snapshot.paragraphs.map(p => p.text), text = texts.join('\n');
      const reply = { url: location.href, title: await pageTitle(), revision: `${texts.length}:${core.hash(text)}` };
      if (!exactCaches() && index === snapshot) index = null;
      if (known === reply.revision) return { ...reply, same: true };
      return { ...reply, text, paras: snapshot.paragraphs.map(p => paraNumber(p.parts[0]?.node)), characters: snapshot.characters, limited: snapshot.limited };
    }, Math.max(1, deadline - Date.now()));
  }
  // One result: absolute hit ranges in the paragraph, a 460-character preview
  // starting 90 characters before `anchor`, and the observed paragraph number.
  function passageResult(paragraph, unit, hits, anchor = hits[0].start) {
    const first = rangeFor(paragraph, hits[0].start, hits[0].end);
    if (!first) return null;
    return { paragraph, unit, hits, locator: locatorOf(first.startContainer), ...core.excerpt(paragraph.text, hits, anchor, unit.start, unit.end) };
  }
  function publish(snapshot, ticket, check, found, limited, extra = {}) {
    check();
    if (snapshot.version !== revision || snapshot.url !== location.href) throw new Error('Page changed; refresh the search.');
    caches.set(ticket, { results: found, version: revision, url: location.href });
    while (caches.size > 3) caches.delete(caches.keys().next().value);
    return { url: location.href, title: document.title, characters: snapshot.characters, limited, ...extra, results: found.map((r, i) => ({
      index: i, preview: r.preview, leading: r.leading, trailing: r.trailing, marks: r.marks, locator: r.locator, ...r.stats
    })) };
  }
  // `key` is an exact search's result position, or a ranked result from the
  // panel's index: its unit must still hold the exact text that was ranked (same
  // hash). Its hits are recomputed here, as are those of its siblings in this
  // tab for the background highlight.
  async function selected(ticket, key) {
    flushMutations();
    let cache = caches.get(ticket), result;
    if (typeof key === 'number') result = cache?.results[key];
    else {
      if (!cache?.units || cache.version !== revision || cache.url !== location.href) {
        const snapshot = await withJob(check => ensureIndex(check)), { terms, marked } = core.rankTerms(key.query), words = new Set(terms);
        cache = { version: revision, url: location.href, units: new Map(), results: [] };
        for (const { unit, hash } of [key, ...(key.others || [])]) {
          const paragraph = snapshot.paragraphs[unit];
          if (!paragraph || core.hash(paragraph.text) !== hash) continue;
          const hits = core.rankHits(paragraph.text, words, marked), found = hits.length && passageResult(paragraph, { start: 0, end: paragraph.text.length }, hits);
          if (found) { cache.units.set(unit, found); cache.results.push(found); }
        }
        // The resolved passages keep what they need; drop the rest of the page text.
        if (!exactCaches() && index === snapshot) index = null;
        caches.set(ticket, cache);
        while (caches.size > 3) caches.delete(caches.keys().next().value);
      }
      result = cache.units.get(key.unit);
    }
    if (!result || cache.version !== revision || cache.url !== location.href || !rangesFor(result).length || result.ranges.some((r, i) =>
      !r.startContainer.isConnected || !r.endContainer.isConnected || r.toString() !== result.expected[i])) {
      throw new Error('This passage changed or expired. Refresh the search before opening it.');
    }
    return { cache, result };
  }
  async function preview(ticket, position, scroll = false) {
    const { cache, result } = await selected(ticket, position);
    function ensureSheet(root) {
      if (sheets.has(root)) return;
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`::highlight(${HIT}) {background:#ffe096;color:#24201a} ::highlight(${ACTIVE}) {background:#17685b;color:white}`);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      sheets.set(root, sheet);
    }
    if (painted !== cache) {
      clearPaint();
      const all = new Highlight();
      for (const match of cache.results) {
        if (all.size >= MAX_PAINT) break;
        for (const range of rangesFor(match)) { if (all.size >= MAX_PAINT) break; all.add(range); }
        ensureSheet(match.paragraph.root);
      }
      CSS.highlights.set(HIT, all); painted = cache;
    }
    ensureSheet(result.paragraph.root);
    const active = new Highlight(); active.priority = 2;
    result.ranges.forEach(r => active.add(r)); CSS.highlights.set(ACTIVE, active);
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
  // The whole matching paragraph/sentence, trimmed, for copying and linking.
  async function passage(ticket, position) {
    const { result } = await selected(ticket, position), text = result.paragraph.text;
    let start = result.unit.start, end = result.unit.end;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    const range = rangeFor(result.paragraph, start, end);
    if (!range) throw new Error('This passage changed or expired. Refresh the search before copying it.');
    return range;
  }
  // Pages without Pinpointer's legal structure: the passage with a text-fragment link.
  function plainCopy(range, mode) {
    const escape = value => value.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const page = location.href.replace(/#.*$/, '');
    let url = page;
    try { url = global.LegalPinpointerTextFragments.urlForRange(range, document.body, page); } catch (_) { if (mode === 'link') throw _; }
    const anchor = label => `<a href="${escape(url)}">${escape(label)}</a>`;
    const text = range.toString().replace(/\s+/g, ' ').trim();
    if (mode === 'link') return { plain: url, html: anchor(url) };
    if (mode === 'citation') return { plain: document.title, html: `<a href="${escape(page)}">${escape(document.title)}</a>` };
    if (mode === 'pinpoint') return { plain: '[Link]', html: anchor('[Link]') };
    return { plain: `[Link]: ${text}`, html: `${anchor('[Link]')}: ${escape(text)}` };
  }
  function restore() {
    for (const { node, x, y } of savedScroll || []) node.scrollTo({ left: x, top: y, behavior: 'instant' });
    savedScroll = null; returnHost?.remove(); returnHost = null; clearPaint();
  }
  async function reveal(ticket, position, origin) {
    await preview(ticket, position, true);
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
  function release(ticket, keepIndex = false) {
    jobs.get(ticket)?.abort();
    const cache = caches.get(ticket);
    caches.delete(ticket);
    if (cache && painted === cache) {
      clearPaint(); returnHost?.remove(); returnHost = null;
    }
    if (!keepIndex && !caches.size && ![...jobs.values()].some(job => !job.cancelled)) releaseAll();
  }
  function releaseAll() {
    revision++; jobs.forEach(job => job.abort()); caches.clear(); index = null; savedScroll = null; clearTimeout(expiry); watching = null;
    observers.splice(0).forEach(o => o.disconnect()); clearPaint(); returnHost?.remove(); returnHost = null;
  }
  window.addEventListener('pagehide', releaseAll);
  global.LegalPinpointerSearchPage = { search, units, preview, reveal, passage, plainCopy, restore, release, releaseAll, clearPaint, setOnChange(fn) { onChange = fn; },
    watch(ticket) { watching = { ...watching, ticket }; notified = false; } };
})(globalThis);
