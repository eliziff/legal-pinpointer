// Builds the static A2AJ passage index from the local A2AJ full-text SQLite files (read-only).
//
//   node --max-old-space-size=3500 build/build-index.mjs --out <dir> [--config build/datasets.json]
//        [--sample N] [--eval-docs targets.json --eval-out eval-passages.json] [--fts5 <dir>]
//
// Output (every file <= 2,000,000,000 bytes, so each can be a GitHub release asset):
//   manifest.json  counts, parameters, file list, per-dataset sizes
//   meta.bin       deflate-raw: arrays loaded when the folder is opened (doc->passage ranges, dates, courts,
//                  text/docs block offsets, first term of every dictionary block)
//   dict.bin       sorted term dictionary in blocks of 64 front-coded entries (df, postings location, max impact)
//   post-NNN.bin   postings (block-packed passage ids + 4-bit BM25 impacts, skip table per term)
//   text-NNN.bin   passage text, ~64 KB blocks, deflate-raw (DecompressionStream in the browser)
//   docs.bin       per-document metadata (citation, style of cause, date, URL), 64 docs per deflate-raw block
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import zlib from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {tokens, term} from '../src/tokenize.mjs';
import {B, K1, BM25_B, quantize, encodeBlock, putVarint} from '../src/format.mjs';

try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const argv = process.argv.slice(2), opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = opt('--out'); if (!OUT) throw new Error('--out <dir> required');
const config = JSON.parse(fs.readFileSync(opt('--config', path.join(HERE, 'datasets.json')), 'utf8'));
const SAMPLE = +opt('--sample', 1), FTS5 = opt('--fts5'), EVAL_DOCS = opt('--eval-docs'), EVAL_OUT = opt('--eval-out');
const LIMIT = 2_000_000_000, TEXT_BLOCK = 64 * 1024, DOCS_BLOCK = 64, DICT_BLOCK = 64, SEG = 1 << 24;
const MINW = 60, MAXW = 260, CHUNKW = 180; // passage size in words
const expand = p => p.replace(/%([^%]+)%/g, (_, v) => process.env[v] || '');
fs.mkdirSync(OUT, {recursive: true});
const TMP = path.join(OUT, '_tmp'); fs.mkdirSync(TMP, {recursive: true});
const t0 = Date.now(), lap = label => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${label}`);

// ---------- 0. document list, ordered by dataset then date so a court filter is a passage-id range ----------
const sources = Object.entries(config.sources).map(([name, file]) => ({name, db: new DatabaseSync(expand(file), {readOnly: true})}));
const includeRx = new RegExp('^(' + config.include.map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*$/, '.*')).join('|') + ')$');
const excludes = (config.exclude || []).map(r => ({...r, rx: new RegExp(r.headRegex, 'i'), n: 0}));
const evalDocs = EVAL_DOCS ? new Set(Object.values(JSON.parse(fs.readFileSync(EVAL_DOCS, 'utf8'))).map(Number)) : new Set();
let docs = [];
for (const [si, s] of sources.entries())
  for (const r of s.db.prepare('SELECT id, dataset, document_date_en AS date FROM document').all())
    if (includeRx.test(r.dataset)) docs.push({si, id: r.id, ds: r.dataset, date: r.date || ''});
const dsOrder = [...new Set(docs.map(d => d.ds))].sort((a, b) => (a.includes('-') - b.includes('-')) || a.localeCompare(b));
const dsIndex = new Map(dsOrder.map((d, i) => [d, i]));
docs.sort((a, b) => dsIndex.get(a.ds) - dsIndex.get(b.ds) || a.date.localeCompare(b.date) || a.si - b.si || a.id - b.id);
if (SAMPLE > 1) docs = docs.filter((d, i) => i % SAMPLE === 0 || (d.si === 0 && evalDocs.has(d.id)));
lap(`${docs.length} candidate documents in ${dsOrder.length} datasets`);

// ---------- writers ----------
class Out { // sequential writer with a big buffer
  constructor(file) { this.fd = fs.openSync(file, 'w'); this.buf = Buffer.allocUnsafe(8 << 20); this.n = 0; this.size = 0; }
  write(bytes) {
    if (this.n + bytes.length > this.buf.length) { this.flush(); if (bytes.length > this.buf.length) { fs.writeSync(this.fd, bytes); this.size += bytes.length; return; } }
    this.buf.set(bytes, this.n); this.n += bytes.length; this.size += bytes.length;
  }
  flush() { if (this.n) fs.writeSync(this.fd, this.buf, 0, this.n); this.n = 0; }
  close() { this.flush(); fs.closeSync(this.fd); }
}
class Sharded { // numbered files, a new one before the limit would be crossed; records never straddle files
  constructor(prefix) { this.prefix = prefix; this.files = []; this.open(); }
  open() { this.cur = new Out(path.join(OUT, `${this.prefix}-${String(this.files.length).padStart(3, '0')}.bin`)); this.files.push(this.cur); }
  write(bytes) { if (this.cur.size + bytes.length > LIMIT) { this.cur.close(); this.open(); } const at = [this.files.length - 1, this.cur.size]; this.cur.write(bytes); return at; }
  finish() { this.cur.close(); return this.files.map((f, i) => ({name: `${this.prefix}-${String(i).padStart(3, '0')}.bin`, size: f.size})); }
}
const grow = (a, n) => { if (n <= a.length) return a; const b = new a.constructor(Math.max(n, a.length * 2)); b.set(a); return b; };

// ---------- 1. main pass: passages, text store, docs store, postings segments ----------
const vocab = new Map(), termList = []; let V = 0, df = new Uint32Array(1 << 20), cnt = new Uint32Array(1 << 20);
const tokId = new Map(); // folded token -> term id (-1 = not indexed); bounded memo
let lens = new Uint16Array(1 << 22), P = 0; // passage lengths (indexed terms)
let segT = new Uint32Array(SEG), segP = new Uint32Array(SEG), segF = new Uint8Array(SEG), nSeg = 0; const segFiles = [];
const text = new Sharded('text'), tb = {firstPid: [], file: [], off: [], len: []};
let tbParts = [], tbBytes = 0, tbFirst = 0, tbDs = new Map();
const docsOut = new Out(path.join(OUT, 'docs.bin')), docBlockOff = [0]; let docRows = [];
const docFirstPid = [], docDate = [], docDs = [], dsStats = dsOrder.map(code => ({code, docs: 0, passages: 0, chars: 0, textBytes: 0, postings: 0, postBytes: 0, firstPid: 0, endPid: 0, firstDoc: 0, endDoc: 0}));
const evalMap = {}; let fts;
if (FTS5) {
  fs.mkdirSync(FTS5, {recursive: true});
  fts = ['none', 'column'].map(detail => {
    const f = path.join(FTS5, `fts5-${detail}.sqlite`); fs.rmSync(f, {force: true});
    const db = new DatabaseSync(f); db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA page_size=4096;
      CREATE VIRTUAL TABLE p USING fts5(t, content='', detail=${detail}, tokenize='unicode61 remove_diacritics 0'); BEGIN;`);
    return {db, ins: db.prepare('INSERT INTO p(rowid, t) VALUES (?, ?)'), f};
  });
}

function flushTextBlock() {
  if (!tbParts.length) return;
  const raw = Buffer.from(tbParts.join('\0'), 'utf8'), z = zlib.deflateRawSync(raw, {level: 9});
  const [file, off] = text.write(z);
  tb.firstPid.push(tbFirst); tb.file.push(file); tb.off.push(off); tb.len.push(z.length);
  for (const [ds, chars] of tbDs) dsStats[ds].textBytes += z.length * chars / tbBytes;
  tbParts = []; tbBytes = 0; tbDs = new Map();
}
function flushDocs() {
  if (!docRows.length) return;
  const z = zlib.deflateRawSync(Buffer.from(JSON.stringify(docRows), 'utf8'), {level: 9});
  docsOut.write(z); docBlockOff.push(docsOut.size); docRows = [];
}
function flushSegment() {
  if (!nSeg) return;
  // counting sort by term id; stable, so passage ids stay increasing within a term
  const count = new Uint32Array(V + 1); for (let i = 0; i < nSeg; i++) count[segT[i] + 1]++;
  for (let t = 0; t < V; t++) count[t + 1] += count[t];
  const perm = new Uint32Array(nSeg), at = count.slice(0, V);
  for (let i = 0; i < nSeg; i++) perm[at[segT[i]]++] = i;
  const out = new Out(path.join(TMP, `seg-${segFiles.length}.bin`)), buf = new Uint8Array(1 << 16);
  let lastT = -1;
  for (let t = 0; t < V; t++) {
    const s = count[t], e = count[t + 1]; if (s === e) continue;
    let pos = putVarint(buf, 0, t - lastT); pos = putVarint(buf, pos, e - s); lastT = t; out.write(buf.subarray(0, pos));
    let prev = -1;
    for (let j = s; j < e; j += 4096) { // chunks keep buf small
      pos = 0; const end = Math.min(e, j + 4096);
      for (let k = j; k < end; k++) { const i = perm[k]; pos = putVarint(buf, pos, segP[i] - prev - 1); prev = segP[i]; buf[pos++] = segF[i]; }
      out.write(buf.subarray(0, pos));
    }
  }
  out.close(); segFiles.push(out); nSeg = 0;
}

function words(s, from, to) { // count whitespace-separated words in s[from, to)
  let n = 0, inw = false;
  for (let i = from; i < to; i++) { const c = s.charCodeAt(i); const ws = c === 32 || c === 9 || c === 13 || c === 10 || c === 160; if (!ws && !inw) n++; inw = !ws; }
  return n;
}
function cutAfterWords(s, from, to, k) { // offset just after the k-th word starting at from
  let n = 0, inw = false;
  for (let i = from; i < to; i++) { const c = s.charCodeAt(i); const ws = c === 32 || c === 9 || c === 13 || c === 10 || c === 160; if (!ws && !inw) { if (n === k) return i; n++; } inw = !ws; }
  return to;
}
// Passages: consecutive lines (A2AJ text has one paragraph per line) merged to >= MINW words;
// lines over MAXW words are cut into ~CHUNKW-word pieces. Returns [start, end) offsets.
function segment(s) {
  const out = []; let ps = -1, pe = 0, pw = 0, pos = 0;
  const flush = () => { if (ps >= 0) out.push([ps, pe, pw]); ps = -1; pw = 0; };
  while (pos <= s.length) {
    let nl = s.indexOf('\n', pos); if (nl < 0) nl = s.length;
    const w = words(s, pos, nl);
    if (w > MAXW) {
      flush(); let a = pos;
      while (a < nl) { const rest = words(s, a, nl); const b = rest > MAXW ? cutAfterWords(s, a, nl, CHUNKW) : nl; out.push([a, b, Math.min(rest, CHUNKW)]); a = b; }
    } else if (w > 0) {
      if (pw + w > MAXW) flush();
      if (ps < 0) ps = pos; pe = nl; pw += w;
      if (pw >= MINW) flush();
    }
    pos = nl + 1;
  }
  if (ps >= 0) { const last = out[out.length - 1]; if (pw < MINW / 2 && last && last[2] + pw <= MAXW) { last[1] = pe; last[2] += pw; } else flush(); }
  return out.map(([a, b]) => { while (a < b && /\s/.test(s[a])) a++; while (b > a && /\s/.test(s[b - 1])) b--; return [a, b]; }).filter(([a, b]) => b > a);
}

const stmts = sources.map(s => s.db.prepare('SELECT citation_en c, citation2_en c2, name_en n, document_date_en d, url_en u, unofficial_text_en t FROM document WHERE id = ?'));
let D = 0, lastDs = -1, touched = new Uint32Array(1 << 16), chars = 0;
for (const [k, d] of docs.entries()) {
  const r = stmts[d.si].get(d.id); const body = r?.t;
  if (!body || body.trim().length < 50) continue;
  const head = body.slice(0, 5000), ex = excludes.find(x => x.datasets.includes(d.ds) && x.rx.test(head));
  if (ex) { ex.n++; continue; }
  const ds = dsIndex.get(d.ds), st = dsStats[ds];
  if (ds !== lastDs) { if (lastDs >= 0) { dsStats[lastDs].endPid = P; dsStats[lastDs].endDoc = D; } st.firstPid = P; st.firstDoc = D; lastDs = ds; }
  docFirstPid.push(P); docDate.push(+(r.d || '0').slice(0, 10).replace(/-/g, '') || 0); docDs.push(ds);
  docRows.push([sources[d.si].name[0], d.id, d.ds, (r.d || '').slice(0, 10), r.c || '', r.c2 || '', r.n || '', r.u || '']);
  if (docRows.length === DOCS_BLOCK) flushDocs();
  st.docs++; D++;
  const spans = segment(body);
  if (d.si === 0 && evalDocs.has(d.id)) evalMap[d.id] = spans.map(([a, b], i) => [P + i, a, b]);
  for (const [a, b] of spans) {
    const ptext = body.slice(a, b).replace(/\0/g, ' ');
    // terms and term frequencies
    let nt = 0, dl = 0; const ftsTerms = fts ? [] : null;
    tokens(ptext, tok => {
      let id = tokId.get(tok);
      if (id === undefined) {
        const t = term(tok);
        if (t === null) id = -1;
        else { id = vocab.get(t); if (id === undefined) { id = V++; vocab.set(t, id); termList.push(t); if (V > df.length) { df = grow(df, V); cnt = grow(cnt, V); } } }
        if (tokId.size > 1 << 22) tokId.clear();
        tokId.set(tok, id);
      }
      if (id < 0) return;
      dl++; if (ftsTerms) ftsTerms.push(id);
      if (cnt[id]++ === 0) { if (nt === touched.length) touched = grow(touched, nt + 1); touched[nt++] = id; }
    });
    if (nSeg + nt > SEG) flushSegment();
    for (let i = 0; i < nt; i++) { const id = touched[i]; segT[nSeg] = id; segP[nSeg] = P; segF[nSeg++] = Math.min(255, cnt[id]); df[id]++; cnt[id] = 0; }
    st.postings += nt;
    if (fts) { const s = ftsTerms.map(id => termList[id]).join(' '); for (const f of fts) f.ins.run(P, s); }
    if (P === lens.length) lens = grow(lens, P + 1);
    lens[P] = Math.min(65535, dl);
    // text store
    if (!tbParts.length) tbFirst = P;
    tbParts.push(ptext); tbBytes += ptext.length; tbDs.set(ds, (tbDs.get(ds) || 0) + ptext.length);
    if (tbBytes >= TEXT_BLOCK) flushTextBlock();
    st.passages++; st.chars += ptext.length; chars += ptext.length; P++;
  }
  if (k % 5000 === 0) lap(`doc ${k}/${docs.length}: ${D} docs, ${P} passages, ${V} terms, ${(chars / 1e6).toFixed(0)}M chars, ${segFiles.length} segments`);
}
if (lastDs >= 0) { dsStats[lastDs].endPid = P; dsStats[lastDs].endDoc = D; }
docFirstPid.push(P); flushTextBlock(); flushDocs(); docsOut.close(); flushSegment();
const textFiles = text.finish();
segT = segP = segF = null;
if (fts) for (const f of fts) { f.db.exec("COMMIT; INSERT INTO p(p) VALUES('optimize'); VACUUM;"); f.db.close(); }
lap(`main pass done: ${D} docs, ${P} passages, ${V} terms, ${segFiles.length} segments; excluded ${excludes.map(x => x.why + ': ' + x.n).join(', ')}`);

// ---------- 2. merge segments into block-packed postings with quantized BM25 impacts ----------
let sumLen = 0; for (let i = 0; i < P; i++) sumLen += lens[i];
const avgdl = sumLen / P, norm = new Float32Array(P);
for (let i = 0; i < P; i++) norm[i] = K1 * (1 - BM25_B + BM25_B * lens[i] / avgdl);
const pidDs = new Uint8Array(P), dsPost = new Float64Array(dsStats.length); for (const [i, s] of dsStats.entries()) if (s.docs) pidDs.fill(i, s.firstPid, s.endPid);
class SegReader {
  constructor(file) { this.fd = fs.openSync(file, 'r'); this.buf = Buffer.allocUnsafe(1 << 20); this.len = 0; this.pos = 0; this.t = -1; this.fill(); this.head(); }
  fill() { const rest = this.len - this.pos; this.buf.copy(this.buf, 0, this.pos, this.len); this.len = rest + fs.readSync(this.fd, this.buf, rest, this.buf.length - rest, null); this.pos = 0; }
  need(n) { if (this.len - this.pos < n) this.fill(); }
  varint() { let v = 0, m = 1, b; do { b = this.buf[this.pos++]; v += (b & 127) * m; m *= 128; } while (b & 128); return v; }
  head() { this.need(16); if (this.pos >= this.len) { this.t = Infinity; fs.closeSync(this.fd); return; } this.t += this.varint(); this.n = this.varint(); }
}
const readers = segFiles.map((_, i) => new SegReader(path.join(TMP, `seg-${i}.bin`)));
const post = new Sharded('post');
const tFile = new Uint8Array(V), tOff = new Uint32Array(V), tLen = new Uint32Array(V), tMaxQ = new Uint8Array(V);
let pids = new Int32Array(1 << 16), qs = new Uint8Array(1 << 16), enc = new Uint8Array(1 << 20), totalPostings = 0;
for (;;) {
  let t = Infinity; for (const r of readers) if (r.t < t) t = r.t;
  if (t === Infinity) break;
  const n = df[t]; if (n > pids.length) { pids = new Int32Array(n); qs = new Uint8Array(n); }
  let m = 0;
  for (const r of readers) {
    if (r.t !== t) continue;
    let prev = -1;
    for (let j = 0; j < r.n; j++) { r.need(8); prev += r.varint() + 1; const tf = r.buf[r.pos++]; pids[m] = prev; qs[m++] = quantize(tf * (K1 + 1) / (tf + norm[prev])); }
    r.head();
  }
  if (m !== n) throw new Error(`df mismatch for term ${t}: ${m} vs ${n}`);
  const nb = Math.ceil(n / B), skip = nb > 1 ? nb * 9 : 0;
  const bound = skip + nb * (1 + 4 * B + B / 2) + 16; if (bound > enc.length) enc = new Uint8Array(bound);
  let pos = skip, maxQ = 0; const dv = new DataView(enc.buffer);
  for (let b = 0; b < nb; b++) {
    const from = b * B, to = Math.min(n, from + B); let bq = 0;
    for (let i = from; i < to; i++) if (qs[i] > bq) bq = qs[i];
    const start = pos; pos = encodeBlock(enc, pos, pids, qs, from, to, from > 0 ? pids[from - 1] : -1);
    const per = (pos - start) / (to - from); for (let i = from; i < to; i++) dsPost[pidDs[pids[i]]] += per;
    if (skip) { dv.setUint32(b * 4, pids[to - 1], true); dv.setUint32(nb * 4 + b * 4, pos - skip, true); enc[nb * 8 + b] = bq; }
    if (bq > maxQ) maxQ = bq;
  }
  if (skip) for (let b = 0; b < nb; b++) dsPost[pidDs[pids[b * B]]] += 9;
  const [file, off] = post.write(enc.subarray(0, pos));
  tFile[t] = file; tOff[t] = off; tLen[t] = pos; tMaxQ[t] = maxQ; totalPostings += n;
}
const postFiles = post.finish();
fs.rmSync(TMP, {recursive: true, force: true});
dsStats.forEach((s, i) => { s.postBytes = dsPost[i]; });
lap(`postings: ${totalPostings} postings, ${postFiles.reduce((a, f) => a + f.size, 0)} bytes`);

// ---------- 3. dictionary ----------
const termsArr = termList; vocab.clear(); tokId.clear();
const order = Uint32Array.from({length: V}, (_, i) => i).sort((a, b) => (termsArr[a] < termsArr[b] ? -1 : termsArr[a] > termsArr[b] ? 1 : 0));
const dictOut = new Out(path.join(OUT, 'dict.bin')), dictFirst = [], dictOff = [0], enc2 = new Uint8Array(1 << 16), te = new TextEncoder();
for (let s = 0; s < V; s += DICT_BLOCK) {
  let pos = 0, prev = '';
  for (let i = s; i < Math.min(V, s + DICT_BLOCK); i++) {
    const id = order[i], t = termsArr[id];
    let p = 0; while (p < prev.length && p < t.length && p < 255 && prev[p] === t[p]) p++;
    const suf = te.encode(t.slice(p)); enc2[pos++] = p; enc2[pos++] = suf.length; enc2.set(suf, pos); pos += suf.length;
    pos = putVarint(enc2, pos, df[id]); enc2[pos++] = tFile[id]; pos = putVarint(enc2, pos, tOff[id]); pos = putVarint(enc2, pos, tLen[id]); enc2[pos++] = tMaxQ[id];
    prev = t;
  }
  dictFirst.push(termsArr[order[s]]); dictOut.write(enc2.subarray(0, pos)); dictOff.push(dictOut.size);
}
dictOut.close();
lap(`dictionary: ${V} terms, ${dictOut.size} bytes`);

// ---------- 4. meta.bin + manifest ----------
const arrays = {
  docFirstPid: Uint32Array.from(docFirstPid), docDate: Uint32Array.from(docDate), docDs: Uint8Array.from(docDs),
  docBlockOff: Uint32Array.from(docBlockOff),
  tbFirstPid: Uint32Array.from([...tb.firstPid, P]), tbOff: Uint32Array.from(tb.off), tbLen: Uint32Array.from(tb.len), tbFile: Uint8Array.from(tb.file),
  dictOff: Uint32Array.from(dictOff), dictFirst: te.encode(dictFirst.join('\n')),
};
const layout = {}; let metaLen = 0;
for (const [k, a] of Object.entries(arrays)) { metaLen = Math.ceil(metaLen / 4) * 4; layout[k] = {type: a.constructor.name, offset: metaLen, length: a.length}; metaLen += a.byteLength; }
const meta = new Uint8Array(metaLen); for (const [k, a] of Object.entries(arrays)) meta.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), layout[k].offset);
const metaZ = zlib.deflateRawSync(meta, {level: 9}); fs.writeFileSync(path.join(OUT, 'meta.bin'), metaZ);
const files = [{name: 'meta.bin', size: metaZ.length}, {name: 'dict.bin', size: dictOut.size}, {name: 'docs.bin', size: docsOut.size}, ...textFiles, ...postFiles];
const docBytes = docsOut.size / D;
const datasets = dsStats.filter(s => s.docs).map(s => ({code: s.code, docs: s.docs, passages: s.passages, firstPid: s.firstPid, endPid: s.endPid, firstDoc: s.firstDoc, endDoc: s.endDoc,
  textMB: +(s.chars / 1e6).toFixed(1), packageMB: +((s.textBytes + s.postBytes + s.docs * docBytes) / 1e6).toFixed(1),
  textStoreMB: +(s.textBytes / 1e6).toFixed(1), postingsMB: +(s.postBytes / 1e6).toFixed(1), postings: s.postings}));
const manifest = {format: 'a2aj-passage-index/1', created: new Date().toISOString(), language: 'en', sample: SAMPLE,
  params: {B, K1, b: BM25_B, qmax: 15, minWords: MINW, maxWords: MAXW, chunkWords: CHUNKW, textBlock: TEXT_BLOCK, docsBlock: DOCS_BLOCK, dictBlock: DICT_BLOCK, textCodec: 'deflate-raw'},
  passages: P, docs: D, terms: V, postings: totalPostings, avgdl, layout, datasets,
  excluded: excludes.map(x => ({datasets: x.datasets, why: x.why, docs: x.n})),
  files, totalBytes: files.reduce((a, f) => a + f.size, 0), buildSeconds: Math.round((Date.now() - t0) / 1000)};
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
if (EVAL_OUT) fs.writeFileSync(EVAL_OUT, JSON.stringify(evalMap));
lap(`done: ${(manifest.totalBytes / 1e9).toFixed(2)} GB in ${files.length} files`);
