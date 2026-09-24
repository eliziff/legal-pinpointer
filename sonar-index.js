'use strict';

// Tab Sonar's ranked index, in a dedicated worker of the side panel. Each tab's
// paragraphs are read once (and again only when that tab changes) and kept here
// as UTF-8 with compact postings; ranked queries never touch the tabs. Scoring
// is Okapi BM25 over the tabs in scope, summed at query time, so adding,
// replacing or dropping one tab is incremental.
(function exposeSonarIndex(global) {
  const RESULTS = 200;
  function createIndex(core) {
    const terms = new Map(), names = [], folds = new Map(), tabs = new Map();
    const encoder = new TextEncoder(), decoder = new TextDecoder();
    let counts = new Int32Array(4096), scores = new Float64Array(0), tally = new Int32Array(4096), last = null, searches = 0;
    // Word forms by their two 32-bit hashes (open addressing), so a known form
    // costs no string and no Map lookup while a tab is indexed.
    let size = 1 << 16, hashA = new Int32Array(size), hashB = new Int32Array(size), formIds = new Int32Array(size).fill(-1), filled = 0;
    function slot(a, b) {
      let at = a & (size - 1);
      while (formIds[at] !== -1 && (hashA[at] !== a || hashB[at] !== b)) at = (at + 1) & (size - 1);
      return at;
    }
    function remember(at, a, b, id) {
      hashA[at] = a; hashB[at] = b; formIds[at] = id;
      if (++filled * 2 <= size) return;
      const oldA = hashA, oldB = hashB, oldIds = formIds;
      size *= 2; hashA = new Int32Array(size); hashB = new Int32Array(size); formIds = new Int32Array(size).fill(-1);
      for (let i = 0; i < oldIds.length; i++) if (oldIds[i] !== -1) { const to = slot(oldA[i], oldB[i]); hashA[to] = oldA[i]; hashB[to] = oldB[i]; formIds[to] = oldIds[i]; }
    }
    // Term id of text[start, end), folding each distinct form once.
    function termAt(text, start, end, a, b) {
      const at = slot(a, b);
      if (formIds[at] !== -1) return formIds[at];
      // A standalone copy: a slice would keep the whole tab text alive in the dictionary.
      const term = JSON.parse(JSON.stringify(core.fold(text.slice(start, end))));
      let id = terms.get(term);
      if (id === undefined) { id = names.length; names.push(term); terms.set(term, id); }
      remember(at, a, b, id);
      return id;
    }
    // Folded form of a word in a result (query time only; a small cache).
    function folded(word) {
      let term = folds.get(word);
      if (term === undefined) { term = core.fold(word); if (folds.size > 50_000) folds.clear(); folds.set(word, term); }
      return term;
    }
    // `page.text` holds the units joined by newlines. `pause` (optional) yields
    // between slices so queries interleave with a large tab being indexed.
    async function put(page, pause) {
      const text = page.text, starts = [0];
      for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
      const count = starts.length, lengths = new Uint16Array(count), touched = [];
      let pairs = new Int32Array(1 << 15), used = 0, total = 0, slice = performance.now() + 8;
      const unitAt = new Uint32Array(count + 1);
      const visit = (start, end, a, b) => {
        const id = termAt(text, start, end, a, b);
        if (id >= tally.length) { const grown = new Int32Array(Math.max(tally.length * 2, id + 1)); grown.set(tally); tally = grown; }
        if (!tally[id]++) touched.push(id);
      };
      for (let u = 0; u < count; u++) {
        if (pause && performance.now() > slice) { await pause(); slice = performance.now() + 8; }
        touched.length = 0;
        core.eachWordAt(text, visit, starts[u], u + 1 < count ? starts[u + 1] - 1 : text.length);
        if (used + touched.length * 2 > pairs.length) { const grown = new Int32Array(Math.max(pairs.length * 2, used + touched.length * 2)); grown.set(pairs); pairs = grown; }
        unitAt[u] = used;
        let length = 0;
        for (const id of touched) { const tf = tally[id]; pairs[used++] = id; pairs[used++] = tf; length += tf; tally[id] = 0; }
        lengths[u] = Math.min(length, 65535); total += length;
      }
      unitAt[count] = used;
      if (counts.length < names.length) counts = new Int32Array(Math.max(names.length, counts.length * 2));
      const present = [];
      for (let at = 0; at < used; at += 2) if (!counts[pairs[at]]++) present.push(pairs[at]);
      const ids = Int32Array.from(present).sort(), offsets = new Uint32Array(ids.length + 1);
      for (let k = 0; k < ids.length; k++) { offsets[k + 1] = offsets[k] + counts[ids[k]]; counts[ids[k]] = offsets[k]; }
      // Postings by term, units ascending; within-tab unit numbers and capped term frequencies.
      const units = count > 65535 ? new Uint32Array(used / 2) : new Uint16Array(used / 2), tfs = new Uint8Array(used / 2);
      for (let u = 0; u < count; u++) {
        for (let at = unitAt[u]; at < unitAt[u + 1]; at += 2) { const slot = counts[pairs[at]]++; units[slot] = u; tfs[slot] = Math.min(pairs[at + 1], 255); }
      }
      for (const id of ids) counts[id] = 0;
      // UTF-8 text with byte offsets per unit (one byte per character for most legal text).
      const bytes = encoder.encode(text), byteStarts = new Uint32Array(count + 1);
      for (let at = 0, u = 1; at < bytes.length && u < count; at++) if (bytes[at] === 10) byteStarts[u++] = at + 1;
      byteStarts[count] = bytes.length + 1;
      // Observed paragraph numbers (0: none), for the `para N` locator, and each
      // unit's text hash, which names it in result handles.
      const paras = Uint32Array.from(page.paras || [], number => Math.min(number, 4294967295));
      const hashes = Float64Array.from(starts, (start, u) => core.hash(text.slice(start, u + 1 < count ? starts[u + 1] - 1 : text.length)));
      if (scores.length < count) scores = new Float64Array(count);
      tabs.set(page.tabId, { tabId: page.tabId, documentId: page.documentId, windowId: page.windowId, url: page.url, title: page.title,
        revision: page.revision, limited: Boolean(page.limited), count, total, lengths, ids, offsets, units, tfs, bytes, byteStarts, paras, hashes });
    }
    function drop(tabId) { tabs.delete(tabId); }
    // An unchanged tab keeps its text; its address or window may have changed.
    function meta({ tabId, documentId, windowId, url, title }) {
      const tab = tabs.get(tabId);
      if (tab) Object.assign(tab, { documentId, windowId, url, title });
      return Boolean(tab);
    }
    const unitText = (tab, u) => decoder.decode(tab.bytes.subarray(tab.byteStarts[u], tab.byteStarts[u + 1] - 1));
    function find(ids, id) {
      let lo = 0, hi = ids.length - 1;
      while (lo <= hi) { const mid = (lo + hi) >>> 1; if (ids[mid] < id) lo = mid + 1; else if (ids[mid] > id) hi = mid - 1; else return mid; }
      return -1;
    }
    // Best first across `tabIds` (in tab priority order): BM25 with statistics
    // summed over those tabs; equal scores keep tab order, then document order.
    // The first `depth` results also carry a window of `window` characters
    // around their densest query words, for the reranker.
    function search({ query, tabIds, depth = 0, window = 0, eager = RESULTS }) {
      const scope = tabIds.map(id => tabs.get(id)).filter(Boolean), { terms: words, marked } = core.rankTerms(query);
      const ids = words.map(word => terms.get(word)), dfs = new Float64Array(words.length);
      let N = 0, L = 0;
      const where = scope.map(tab => {
        N += tab.count; L += tab.total;
        return ids.map((id, i) => { const k = id === undefined ? -1 : find(tab.ids, id); if (k >= 0) dfs[i] += tab.offsets[k + 1] - tab.offsets[k]; return k; });
      });
      const average = L / Math.max(1, N), idf = [...dfs].map(df => df ? Math.log(1 + (N - df + 0.5) / (df + 0.5)) : 0);
      // Bounded min-heap (worst on top) of the best RESULTS as [score, order, unit].
      const heap = [], worse = (a, b) => a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
      const swap = (i, j) => { const t = heap[i]; heap[i] = heap[j]; heap[j] = t; };
      function offer(entry) {
        if (heap.length < RESULTS) {
          heap.push(entry);
          for (let i = heap.length - 1, p; i > 0 && worse(heap[i], heap[p = (i - 1) >> 1]); i = p) swap(i, p);
        } else if (worse(heap[0], entry)) {
          heap[0] = entry;
          for (let i = 0; ;) {
            const l = i * 2 + 1, r = l + 1;
            let low = i;
            if (l < heap.length && worse(heap[l], heap[low])) low = l;
            if (r < heap.length && worse(heap[r], heap[low])) low = r;
            if (low === i) break;
            swap(i, low); i = low;
          }
        }
      }
      scope.forEach((tab, order) => {
        const { offsets, units, tfs, lengths } = tab, touched = [], scale = 0.9 / average;
        where[order].forEach((k, i) => {
          if (k < 0) return;
          // Okapi BM25, k1 1.2, b 0.75: tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * length / average)).
          const weight = idf[i] * 2.2;
          for (let at = offsets[k], end = offsets[k + 1]; at < end; at++) {
            const u = units[at], tf = tfs[at];
            if (!scores[u]) touched.push(u);
            scores[u] += weight * tf / (tf + 0.3 + scale * lengths[u]);
          }
        });
        for (const u of touched) {
          if (heap.length < RESULTS || scores[u] >= heap[0][0]) offer([scores[u], order, u]);
          scores[u] = 0;
        }
      });
      const best = heap.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]), wanted = new Set(words);
      const results = [], passages = [];
      last = { tag: ++searches, wanted, marked, later: [] };
      for (const [, order, u] of best) {
        const tab = scope[order], hash = tab.hashes[u], position = results.length;
        const result = { tabId: tab.tabId, documentId: tab.documentId, windowId: tab.windowId, url: tab.url, title: tab.title,
          unit: u, hash, locator: tab.paras[u] ? `para ${tab.paras[u]}` : '' };
        results.push(result);
        // Excerpts for the first rows now; the rest follow in `excerpts`.
        if (position >= Math.max(eager, depth)) { Object.assign(result, { preview: '', marks: [] }); last.later.push([position, tab, u]); continue; }
        const text = unitText(tab, u), hits = core.rankHits(text, wanted, marked, 100, folded);
        Object.assign(result, core.excerpt(text, hits, hits.length ? core.densest(text, hits) : 0));
        if (position < depth) {
          // The reranker reads a window around the densest query words, a third of it before them.
          let passage = text;
          if (window && text.length > window && hits.length) {
            const lead = Math.round(window / 3);
            let start = Math.max(0, Math.min(core.densest(text, hits, lead, window) - lead, text.length - window));
            while (start > 0 && /\S/.test(text[start - 1])) start--;
            passage = text.slice(start, start + window);
          }
          passages.push({ id: position, key: hash, text: passage.slice(0, window || 3000).replace(/\s+/g, ' ').trim() });
        }
      }
      return { results, passages, tag: last.tag, searched: scope.length, limited: scope.some(tab => tab.limited) };
    }
    // Excerpts of the latest search's remaining results, by position.
    function excerpts({ tag }) {
      if (last?.tag !== tag) return { excerpts: [] };
      const { wanted, marked, later } = last;
      return { excerpts: later.map(([position, tab, u]) => {
        const text = unitText(tab, u), hits = core.rankHits(text, wanted, marked, 100, folded);
        return { position, ...core.excerpt(text, hits, hits.length ? core.densest(text, hits) : 0) };
      }) };
    }
    function stats() {
      let bytes = 0, postings = 0, units = 0;
      for (const tab of tabs.values()) { bytes += tab.bytes.length; postings += tab.units.length; units += tab.count; }
      return { tabs: tabs.size, units, bytes, postings, terms: names.length, forms: filled };
    }
    return { put, drop, meta, search, excerpts, stats };
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { createIndex }; return; }
  // Dedicated worker: messages from sonar.js, answered in order.
  importScripts('find-core.js');
  const index = createIndex(global.LegalPinpointerFindCore), channel = new MessageChannel();
  const pause = () => new Promise(resolve => { channel.port1.onmessage = () => resolve(); channel.port2.postMessage(0); });
  let queue = Promise.resolve();
  global.onmessage = ({ data }) => {
    if (data?.type === 'search') {
      // Queries answer at once, between slices of any tab being indexed.
      try { global.postMessage({ type: 'search', id: data.id, ...index.search(data) }); }
      catch (error) { global.postMessage({ type: 'search', id: data.id, error: String(error.message || error) }); }
    } else if (data?.type === 'put' || data?.type === 'meta') {
      queue = queue.then(() => data.type === 'put' ? index.put(data.page, pause) : index.meta(data.meta) || Promise.reject(new Error('Not indexed.')))
        .then(() => global.postMessage({ type: data.type, id: data.id }), error => global.postMessage({ type: data.type, id: data.id, error: String(error.message || error) }));
    } else if (data?.type === 'drop') { index.drop(data.tabId); queue = queue.then(() => index.drop(data.tabId)); }
    else if (data?.type === "excerpts" || data?.type === "stats") global.postMessage({ type: data.type, id: data.id, ...index[data.type](data) });
  };
  global.postMessage({ type: 'ready' });
})(globalThis);
