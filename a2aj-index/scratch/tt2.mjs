import fs from 'node:fs'; import {fold, term} from '../src/tokenize.mjs';
const docs = JSON.parse(fs.readFileSync((process.env.BENCHMARK_INPUT ?? ".tmp/inputs/input.json"),'utf8'));
const paras = docs.flatMap(d => d.text.split('\n'));
let t=performance.now(); const f = paras.map(fold); console.log('fold', performance.now()-t);
const W=/[\p{L}\p{N}]+/gu; t=performance.now(); const toks=f.map(s=>s.match(W)||[]); console.log('match', performance.now()-t);
const W2=/[a-z0-9\u00c0-\uffff]+/g; t=performance.now(); f.map(s=>s.match(W2)||[]); console.log('match ascii-ish', performance.now()-t);
t=performance.now(); let n=0; for (const ts of toks) for (const x of ts) if (term(x)) n++; console.log('term', performance.now()-t, n);
t=performance.now(); for (const ts of toks) for (const x of ts) if (term(x)) n++; console.log('term warm', performance.now()-t, n);
