// Query engine over the static passage index. Environment-neutral: the caller supplies
//   io.read(name, offset, length) -> Uint8Array   (synchronous; FileReaderSync in a browser worker)
//   io.inflate(bytes) -> Promise<Uint8Array>        (raw deflate; DecompressionStream in a browser)
import {B, QMAX, decodeBlock, getVarint} from './format.mjs';
import {terms, phraseNorm} from './tokenize.mjs';

// Default document ranking (see rankDocs); the page uses it, bench/quality.mjs sweeps it.
export const RANKING = {title: 0, authority: 1, titleOnly: 20};
const WHOLE_LIST = 512 * 1024, CHUNK = 256 * 1024, td = new TextDecoder();

export async function openIndex(io) {
  const t0 = performance.now();
  const manifest = JSON.parse(td.decode(io.read('manifest.json', 0, io.size('manifest.json'))));
  const metaBytes = await io.inflate(io.read('meta.bin', 0, io.size('meta.bin')));
  const A = {};
  for (const [k, {type, offset, length}] of Object.entries(manifest.layout)) {
    const C = globalThis[type]; A[k] = new C(metaBytes.buffer, metaBytes.byteOffset + offset, length);
  }
  const dictFirst = td.decode(A.dictFirst).split('\n');
  const postNames = manifest.files.filter(f => f.name.startsWith('post-')).map(f => f.name);
  const textNames = manifest.files.filter(f => f.name.startsWith('text-')).map(f => f.name);
  const N = manifest.passages, D = manifest.docs;
  const stats = {reads: 0, bytes: 0};
  const read = (name, off, len) => { stats.reads++; stats.bytes += len; return io.read(name, off, len); };
  const lru = (max) => { const m = new Map(); return {get(k) { const v = m.get(k); if (v !== undefined) { m.delete(k); m.set(k, v); } return v; }, set(k, v) { m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); }}; };
  const dictCache = lru(4096), textCache = lru(64), docCache = lru(64);

  function lookup(t) {
    let lo = 0, hi = dictFirst.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (dictFirst[mid] <= t) lo = mid; else hi = mid - 1; }
    if (dictFirst[lo] > t) return null;
    let entries = dictCache.get(lo);
    if (!entries) {
      const buf = read('dict.bin', A.dictOff[lo], A.dictOff[lo + 1] - A.dictOff[lo]), st = {pos: 0}; entries = []; let prev = '';
      while (st.pos < buf.length) {
        const p = buf[st.pos++], sl = buf[st.pos++], term = prev.slice(0, p) + td.decode(buf.subarray(st.pos, st.pos + sl)); st.pos += sl;
        const df = getVarint(buf, st), file = buf[st.pos++], off = getVarint(buf, st), len = getVarint(buf, st), maxQ = buf[st.pos++];
        const tdf = getVarint(buf, st), title = tdf ? {tdf, file: buf[st.pos++], off: getVarint(buf, st), len: getVarint(buf, st)} : null;
        entries.push({term, df, file, off, len, maxQ, tdf, title}); prev = term;
      }
      dictCache.set(lo, entries);
    }
    return entries.find(e => e.term === t) || null;
  }

  const docOf = pid => { let lo = 0, hi = D - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (A.docFirstPid[m] <= pid) lo = m; else hi = m - 1; } return lo; };

  async function passageText(pid) {
    let lo = 0, hi = A.tbOff.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (A.tbFirstPid[m] <= pid) lo = m; else hi = m - 1; }
    let parts = textCache.get(lo);
    if (!parts) { parts = td.decode(await io.inflate(read(textNames[A.tbFile[lo]], A.tbOff[lo], A.tbLen[lo]))).split('\0'); textCache.set(lo, parts); }
    return parts[pid - A.tbFirstPid[lo]];
  }

  async function doc(d) {
    const b = Math.floor(d / manifest.params.docsBlock);
    let rows = docCache.get(b);
    if (!rows) { rows = JSON.parse(td.decode(await io.inflate(read('docs.bin', A.docBlockOff[b], A.docBlockOff[b + 1] - A.docBlockOff[b])))); docCache.set(b, rows); }
    const [src, id, dataset, date, citation, citation2, name, url] = rows[d % manifest.params.docsBlock];
    return {d, src, id, dataset, date, citation, citation2, name, url};
  }

  // Allowed passage-id ranges for court / date filters (documents are ordered by court, then date).
  function ranges({datasets, from, to} = {}) {
    const f = from ? +from.replace(/-/g, '').padEnd(8, '0') : 0, t = to ? +to.replace(/-/g, '').padEnd(8, '9') : 99999999;
    const sel = manifest.datasets.filter(s => !datasets?.length || datasets.includes(s.code));
    if (!datasets?.length && !from && !to) return null;
    const out = [];
    for (const s of sel) {
      let a = s.firstDoc, b = s.endDoc;
      if (from) { let lo = a, hi = b; while (lo < hi) { const m = (lo + hi) >> 1; if (A.docDate[m] < f) lo = m + 1; else hi = m; } a = lo; }
      if (to) { let lo = a, hi = b; while (lo < hi) { const m = (lo + hi) >> 1; if (A.docDate[m] <= t) lo = m + 1; else hi = m; } b = lo; }
      if (b > a) out.push([A.docFirstPid[a], A.docFirstPid[b]]);
    }
    return out;
  }

  class Cursor {
    constructor(e, idf) {
      Object.assign(this, e); this.idf = idf; this.ub = idf * e.maxQ; this.nb = Math.ceil(e.df / B);
      this.name = postNames[e.file]; this.skipLen = this.nb > 1 ? this.nb * 9 : 0;
      if (e.len <= WHOLE_LIST) { this.buf = read(this.name, e.off, e.len); this.bufAt = 0; }
      else { this.buf = read(this.name, e.off, this.skipLen); this.bufAt = -1; }
      if (this.nb > 1) {
        const skip = this.buf.slice(0, this.skipLen), dv = new DataView(skip.buffer);
        this.last = new Int32Array(this.nb); this.end = new Uint32Array(this.nb); this.bmax = skip.subarray(this.nb * 8);
        for (let b = 0; b < this.nb; b++) { this.last[b] = dv.getUint32(b * 4, true); this.end[b] = dv.getUint32(this.nb * 4 + b * 4, true); }
      }
      this.pids = new Int32Array(B); this.qs = new Uint8Array(B); this.b = -1; this.cur = -1; this.load(0); this.i = 0; this.cur = this.pids[0];
    }
    blockBytes(b) { // bytes + position of block b
      const s = this.skipLen + (b ? this.end[b - 1] : 0), e = this.nb > 1 ? this.skipLen + this.end[b] : this.len;
      if (this.bufAt === 0) return [this.buf, s];
      if (this.chunk && s >= this.chunkAt && e <= this.chunkAt + this.chunk.length) return [this.chunk, s - this.chunkAt];
      this.chunkAt = s; this.chunk = read(this.name, this.off + s, Math.min(this.len - s, Math.max(CHUNK, e - s)));
      return [this.chunk, 0];
    }
    load(b) {
      this.b = b; this.n = b === this.nb - 1 ? this.df - b * B : B;
      const [buf, pos] = this.blockBytes(b);
      decodeBlock(buf, pos, this.n, b ? this.last[b - 1] : -1, this.pids, this.qs);
      this.i = 0; this.cur = this.pids[0]; stats.decoded = (stats.decoded || 0) + this.n;
    }
    next() { if (++this.i < this.n) this.cur = this.pids[this.i]; else if (this.b + 1 < this.nb) this.load(this.b + 1); else this.cur = Infinity; }
    seek(t) { // first posting >= t
      if (this.cur >= t) return;
      if (this.nb > 1 && t > this.last[this.b]) {
        let b = this.b + 1; if (b >= this.nb || t > this.last[this.nb - 1]) { this.cur = Infinity; return; }
        let step = 1; while (b + step < this.nb && this.last[b + step] < t) { b += step; step *= 2; }
        let lo = b, hi = Math.min(this.nb - 1, b + step); while (lo < hi) { const m = (lo + hi) >> 1; if (this.last[m] < t) lo = m + 1; else hi = m; }
        this.load(lo);
      }
      while (this.i < this.n && this.pids[this.i] < t) this.i++;
      if (this.i < this.n) this.cur = this.pids[this.i]; else this.cur = Infinity;
    }
    score() { return this.idf * this.qs[this.i]; }
  }

  const idf = e => Math.log(1 + (N - e.df + 0.5) / (e.df + 0.5));
  const docAllowed = (d, rs) => { if (!rs) return true; const p = A.docFirstPid[d]; return rs.some(([a, b]) => p >= a && p < b); };
  function titleDocs(e) { // documents whose style of cause or citation holds the term
    const buf = read(postNames[e.title.file], e.title.off, e.title.len), st = {pos: 0}, out = new Uint32Array(e.tdf); let prev = -1;
    for (let i = 0; i < e.tdf; i++) out[i] = prev += getVarint(buf, st) + 1;
    return out;
  }
  function bestInDocs(list, ents) { // best passage of each listed document for the query terms
    const out = new Map(), cs = ents.filter(e => e.df).map(e => new Cursor(e, idf(e)));
    for (const d of [...list].sort((a, b) => a - b)) {
      const a = A.docFirstPid[d], b = A.docFirstPid[d + 1], acc = new Map();
      for (const c of cs) { c.seek(a); while (c.cur < b) { acc.set(c.cur, (acc.get(c.cur) || 0) + c.score()); c.next(); } }
      let best = {pid: a, score: 0}; for (const [pid, score] of acc) if (score > best.score) best = {pid, score};
      out.set(d, best);
    }
    return out;
  }
  // Documents from passages: score = best passage + QMAX * (title * sum of title idf over query terms in the style of
  // cause / citation + authority * log10(1 + number of indexed documents citing it)). Documents whose title matches but
  // that have no passage in the top k are scored on their own passages (the strongest `titleOnly` of them).
  function rankDocs(hits, ents, rs, phrase, {title = RANKING.title, authority = RANKING.authority, titleOnly = RANKING.titleOnly} = {}) {
    const docs = new Map();
    for (const h of hits) { h.doc = docOf(h.pid); let d = docs.get(h.doc); if (!d) docs.set(h.doc, d = {doc: h.doc, best: h.score, hits: [], title: 0}); d.hits.push(h); }
    if (title > 0) {
      const ts = new Map();
      for (const e of ents) if (e.tdf) { const w = Math.log(1 + (D - e.tdf + 0.5) / (e.tdf + 0.5)); for (const d of titleDocs(e)) ts.set(d, (ts.get(d) || 0) + w); }
      for (const [d, s] of ts) { const x = docs.get(d); if (x) x.title = s; }
      if (!phrase && titleOnly) {
        const extra = [...ts].filter(([d]) => !docs.has(d) && docAllowed(d, rs)).sort((a, b) => b[1] - a[1]).slice(0, titleOnly), best = bestInDocs(extra.map(x => x[0]), ents);
        for (const [d, s] of extra) { const b = best.get(d); docs.set(d, {doc: d, best: b.score, hits: [b], title: s}); }
      }
    }
    for (const x of docs.values()) x.score = x.best + QMAX * (title * x.title + authority * Math.log10(1 + (A.docCitedBy?.[x.doc] || 0)));
    return [...docs.values()].sort((a, b) => b.score - a.score);
  }

  // Top-k over passages, then documents. query: free text; "quoted phrases" are required and verified against the text.
  async function search(query, opts = {}) {
    const {k = 100, datasets, from, to, maxVerify = 3000} = opts;
    const t0 = performance.now(), s0 = {...stats};
    const phrases = [...query.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    const free = query.replace(/"[^"]*"/g, ' ');
    const req = new Set(phrases.flatMap(terms)), all = [...new Set([...terms(free), ...req])];
    const cursors = [], missing = [], ents = [];
    for (const t of all) {
      const e = lookup(t); if (!e) { missing.push(t); continue; }
      ents.push(e); if (e.df) cursors.push(Object.assign(new Cursor(e, idf(e)), {req: req.has(t), t}));
    }
    const rs = ranges({datasets, from, to});
    let ri = 0; const allowed = d => { if (!rs) return d; while (ri < rs.length && rs[ri][1] <= d) ri++; return ri < rs.length ? Math.max(d, rs[ri][0]) : Infinity; };
    let hits = [], verified = 0, checked = 0;
    const needed = cursors.filter(c => c.req);
    if (phrases.length && (needed.length < req.size || !needed.length)) hits = []; // a required term is absent (or phrase is all stopwords)
    else if (phrases.length) {
      needed.sort((a, b) => a.df - b.df); const lead = needed[0], opt = cursors.filter(c => !c.req);
      const cands = [];
      for (;;) {
        let d = allowed(lead.cur); if (d === Infinity) break; if (d !== lead.cur) { lead.seek(d); continue; }
        let ok = true;
        for (let j = 1; j < needed.length; j++) { const c = needed[j]; c.seek(d); if (c.cur !== d) { ok = false; if (c.cur === Infinity) d = Infinity; else lead.seek(c.cur); break; } }
        if (d === Infinity) break;
        if (!ok) continue;
        let s = 0; for (const c of needed) s += c.score();
        for (const c of opt) { c.seek(d); if (c.cur === d) s += c.score(); }
        cands.push([s, d]); lead.next();
      }
      cands.sort((a, b) => b[0] - a[0]);
      const norms = phrases.map(phraseNorm);
      for (const [s, d] of cands) {
        if (hits.length >= k || checked >= maxVerify) break;
        checked++; const txt = phraseNorm(await passageText(d));
        if (norms.every(p => txt.includes(p))) hits.push({pid: d, score: s});
      }
      verified = hits.length; hits.total = cands.length;
    } else if (cursors.length) {
      // MaxScore: lists sorted by upper bound; the low-bound prefix whose sum cannot beat the threshold is only probed
      cursors.sort((a, b) => a.ub - b.ub);
      const n = cursors.length, ubSum = []; let acc = 0; for (const c of cursors) ubSum.push(acc += c.ub);
      const heap = []; let theta = 0, ess = 0;
      const push = (s, d) => {
        if (heap.length < k) { heap.push([s, d]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } }
        else { heap[0] = [s, d]; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < k && heap[l][0] < heap[m][0]) m = l; if (r < k && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
        if (heap.length === k) { theta = heap[0][0]; while (ess < n && ubSum[ess] <= theta) ess++; }
      };
      let evaluated = 0;
      for (;;) {
        if (ess >= n) break;
        let d = Infinity; for (let j = ess; j < n; j++) if (cursors[j].cur < d) d = cursors[j].cur;
        if (d === Infinity) break;
        const a = allowed(d); if (a !== d) { if (a === Infinity) break; for (let j = ess; j < n; j++) cursors[j].seek(a); continue; }
        let s = 0;
        for (let j = ess; j < n; j++) { const c = cursors[j]; if (c.cur === d) { s += c.score(); c.next(); } }
        for (let j = ess - 1; j >= 0; j--) {
          if (s + ubSum[j] <= theta) break;
          const c = cursors[j]; c.seek(d); if (c.cur === d) s += c.score();
        }
        evaluated++;
        if (heap.length < k || s > theta) push(s, d);
      }
      hits = heap.sort((a, b) => b[0] - a[0]).map(([score, pid]) => ({pid, score}));
      hits.evaluated = evaluated;
    }
    const docs = rankDocs(hits, ents, rs, phrases.length > 0, opts);
    return {hits, docs, terms: cursors.map(c => ({t: c.t, df: c.df})), missing, phrases, candidates: hits.total, checked, verified,
      ms: performance.now() - t0, reads: stats.reads - s0.reads, bytes: stats.bytes - s0.bytes, decoded: (stats.decoded || 0) - (s0.decoded || 0)};
  }

  return {manifest, search, passageText, doc, docOf, lookup, stats, openMs: performance.now() - t0};
}
