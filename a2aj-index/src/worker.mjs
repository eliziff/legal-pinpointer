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

// The first `show` documents, each with its best `maxPerDoc` passages.
async function results(r, {maxPerDoc = 2, show = 20} = {}) {
  const out = [];
  for (const d of r.docs.slice(0, show)) {
    const passages = [];
    for (const h of d.hits.slice(0, maxPerDoc)) passages.push({pid: h.pid, score: h.score, text: await eng.passageText(h.pid)});
    out.push({doc: d.doc, score: d.score, meta: await eng.doc(d.doc), passages});
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
      const opts = arg.opts || {}, t = performance.now(), r = await eng.search(arg.query, opts);
      const shown = await results(r, opts);
      const docIds = arg.withDocIds ? await Promise.all(r.docs.slice(0, 20).map(async d => { const m = await eng.doc(d.doc); return m.src + ':' + m.id; })) : undefined;
      value = {searchMs: r.ms, totalMs: performance.now() - t, reads: r.reads, bytes: r.bytes, decoded: r.decoded, terms: r.terms, missing: r.missing,
        candidates: r.candidates, evaluated: r.hits.evaluated, pids: r.hits.map(h => h.pid), shownPids: shown.flatMap(d => d.passages.map(p => p.pid)), docIds, results: shown};
    }
    postMessage({id, value});
  } catch (e) { postMessage({id, error: String(e && e.stack || e)}); }
};
