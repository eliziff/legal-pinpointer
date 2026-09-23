// Search worker: reads the picked index files on demand (File.slice + FileReaderSync); nothing is copied to browser storage.
import {openIndex} from './engine.mjs';

const frs = new FileReaderSync();
let files = new Map(), eng = null;
const io = {
  size: n => file(n).size,
  read: (n, off, len) => new Uint8Array(frs.readAsArrayBuffer(file(n).slice(off, off + len))),
  inflate: async bytes => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()),
};
function file(n) { const f = files.get(n); if (!f) throw new Error(`Missing index file ${n} in the chosen folder`); return f; }

async function results(r, {maxPerDoc = 3, show = 20} = {}) {
  const per = new Map(), out = [];
  for (const h of r.hits) {
    const c = per.get(h.doc) || 0; if (c >= maxPerDoc) continue; per.set(h.doc, c + 1);
    if (out.length >= show) break;
    out.push({...h, text: await eng.passageText(h.pid), meta: await eng.doc(h.doc)});
  }
  return out;
}

onmessage = async ({data: {id, op, arg}}) => {
  try {
    let value;
    if (op === 'open') {
      files = new Map(arg.files.map(f => [f.name, f]));
      eng = await openIndex(io);
      const m = eng.manifest;
      const missing = m.files.filter(f => !files.has(f.name) || files.get(f.name).size !== f.size).map(f => f.name);
      value = {openMs: eng.openMs, passages: m.passages, docs: m.docs, terms: m.terms, datasets: m.datasets.map(d => ({code: d.code, docs: d.docs})), missing, created: m.created};
    } else if (op === 'search') {
      const t = performance.now(), r = await eng.search(arg.query, arg.opts || {});
      const shown = arg.docsOnly ? [] : await results(r, arg.opts || {});
      const docs = []; const seen = new Set();
      for (const h of r.hits) if (!seen.has(h.doc)) { seen.add(h.doc); docs.push(h.doc); }
      const docIds = arg.withDocIds ? await Promise.all(docs.slice(0, 20).map(async d => { const m = await eng.doc(d); return m.src + ':' + m.id; })) : undefined;
      value = {searchMs: r.ms, totalMs: performance.now() - t, reads: r.reads, bytes: r.bytes, decoded: r.decoded, terms: r.terms, missing: r.missing,
        candidates: r.candidates, evaluated: r.hits.evaluated, pids: r.hits.map(h => h.pid), docIds, results: shown,
        heapMB: (performance.memory?.usedJSHeapSize || 0) / 1e6};
    }
    postMessage({id, value});
  } catch (e) { postMessage({id, error: String(e && e.stack || e)}); }
};
