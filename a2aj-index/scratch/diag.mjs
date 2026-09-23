// Why does a target document rank where it does?  node scratch/diag.mjs <index dir> <query id>...
import fs from 'node:fs'; import {openIndex} from '../src/engine.mjs'; import {nodeIO} from '../bench/node-io.mjs';
const [dir, ...ids] = process.argv.slice(2), eng = await openIndex(nodeIO(dir));
const qs = new Map(JSON.parse(fs.readFileSync(new URL('../bench/queries.json', import.meta.url), 'utf8')).map(q => [q.id, q]));
for (const id of ids) {
  const q = qs.get(id), r = await eng.search(q.query, {k: 2000}), want = new Set(q.docs || []);
  const docs = new Map(); for (const [i, h] of r.hits.entries()) { const d = docs.get(h.doc) || {best: h.score, rank: i + 1, n: 0}; d.n++; docs.set(h.doc, d); }
  console.log(`\n## ${id} ${q.query} | ${r.ms.toFixed(0)} ms | terms ${r.terms.map(t => t.t + ':' + t.df).join(' ')}`);
  let dr = 0;
  for (const [d, x] of docs) {
    dr++; const m = await eng.doc(d), key = m.src + ':' + m.id, hit = want.has(key);
    if (dr <= 8 || hit) console.log(`${hit ? '>>' : '  '} doc#${dr} pass#${x.rank} best ${x.best.toFixed(1)} n${x.n} ${m.dataset} ${m.citation} | ${(m.name || '').slice(0, 50)}`);
  }
}
