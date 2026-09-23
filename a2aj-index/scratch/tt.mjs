import fs from 'node:fs'; import {terms} from '../src/tokenize.mjs';
const docs = JSON.parse(fs.readFileSync((process.env.BENCHMARK_INPUT ?? ".tmp/inputs/input.json"),'utf8'));
let chars=0,n=0; const t=performance.now(); const vocab=new Map();
for (const d of docs) { chars+=d.text.length; for (const p of d.text.split('\n')) { const ts=terms(p); n+=ts.length; for (const x of ts) if(!vocab.has(x)) vocab.set(x,vocab.size);} }
const ms=performance.now()-t; console.log({chars,n,ms, mbps: chars/ms/1000, vocab: vocab.size});
