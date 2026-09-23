import {openIndex} from '../src/engine.mjs'; import {nodeIO} from '../bench/node-io.mjs';
const dir = process.argv[2]; const eng = await openIndex(nodeIO(dir));
console.log('open ms', eng.openMs.toFixed(1), eng.manifest.passages);
for (const q of process.argv.slice(3)) {
  const r = await eng.search(q, {k: 20});
  console.log('\n##', q, '|', r.ms.toFixed(1), 'ms reads', r.reads, 'bytes', r.bytes, 'decoded', r.decoded, 'eval', r.hits.evaluated, 'cands', r.candidates, 'terms', JSON.stringify(r.terms));
  for (const h of r.hits.slice(0, 3)) { const d = await eng.doc(h.doc); console.log(h.score.toFixed(2), d.citation, '|', d.name?.slice(0,60), '|', (await eng.passageText(h.pid)).slice(0, 160).replace(/\n/g, ' ')); }
}
