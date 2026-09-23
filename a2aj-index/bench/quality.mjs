// Ranking ablation in Node (same engine and metrics as the browser bench, no browser):
//   node bench/quality.mjs --index <dir> --eval <eval-passages.json> --arms '[{"title":0,"authority":0},{"title":1}]' [--out file.json]
import fs from 'node:fs'; import path from 'node:path';
import {openIndex, RANKING} from '../src/engine.mjs'; import {nodeIO} from './node-io.mjs'; import {quality} from './metrics.mjs';
const argv = process.argv.slice(2), opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const queries = JSON.parse(fs.readFileSync(path.join(root, 'bench', 'queries.json'), 'utf8')).filter(q => q.docs);
const evalMap = JSON.parse(fs.readFileSync(opt('--eval'), 'utf8')), arms = JSON.parse(opt('--arms', '[{}]'));
const eng = await openIndex(nodeIO(path.resolve(opt('--index')))), out = [];
for (const arm of arms) {
  const ranking = {...RANKING, ...arm}, runs = [], t = performance.now();
  for (const q of queries) {
    const r = await eng.search(q.query, ranking), docIds = [];
    for (const d of r.docs.slice(0, 20)) { const m = await eng.doc(d.doc); docIds.push(m.src + ':' + m.id); }
    runs.push({id: q.id, docIds, pids: r.hits.map(h => h.pid), shownPids: r.docs.slice(0, 20).flatMap(d => d.hits.slice(0, 2).map(h => h.pid))});
  }
  const qual = quality(queries, runs, evalMap);
  out.push({ranking, qual, ms: Math.round(performance.now() - t), ranks: Object.fromEntries(runs.map(r => [r.id, r.docRank]))});
  console.log(JSON.stringify(ranking), Object.entries(qual).map(([k, g]) => `${k} R@20 ${g['docR@20']} MRR ${g.MRR}${g.pn ? ` pR@10 ${g['passageR@10']} shown ${g['shownPassageR@10']}` : ''}`).join(' | '));
}
if (opt('--out')) fs.writeFileSync(opt('--out'), JSON.stringify(out, null, 1));
