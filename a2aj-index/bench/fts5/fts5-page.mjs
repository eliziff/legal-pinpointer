import {terms} from '../../src/tokenize.mjs';
window.runFts = (queries, passes = 2) => new Promise((ok, bad) => {
  const file = document.getElementById('files').files[0];
  const qs = queries.map(q => {
    const phrases = [...q.query.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    const req = [...new Set(phrases.flatMap(terms))], free = [...new Set(terms(q.query.replace(/"[^"]*"/g, ' ')))].filter(t => !req.includes(t));
    const fts = req.length ? req.map(t => `"${t}"`).join(' AND ') : free.map(t => `"${t}"`).join(' OR ');
    return {id: q.id, type: q.type, fts: fts || '"zzzzzz"'};
  });
  const all = []; let pass = 0;
  const w = new Worker('./fts5-worker.js', {type: 'module'});
  w.onmessage = e => { if (e.data.error) return bad(new Error(e.data.error)); all.push({pass: pass + 1, ...e.data}); if (++pass < passes) w.postMessage({file, queries: qs}); else { w.terminate(); ok(all); } };
  w.postMessage({file, queries: qs});
});
