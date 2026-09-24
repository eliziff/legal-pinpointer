import fs from 'node:fs'; import {terms} from '../src/tokenize.mjs';
const docs = JSON.parse(fs.readFileSync('C:/Users/elias/AppData/Local/Temp/claude/C--Users-elias-Desktop-MikeOSS-Fork/1f20d775-c0b0-4f05-b9bf-1a656c0b4e6c/scratchpad/search-bench/data/tabs-docs.json','utf8'));
let chars=0,n=0; const t=performance.now(); const vocab=new Map();
for (const d of docs) { chars+=d.text.length; for (const p of d.text.split('\n')) { const ts=terms(p); n+=ts.length; for (const x of ts) if(!vocab.has(x)) vocab.set(x,vocab.size);} }
const ms=performance.now()-t; console.log({chars,n,ms, mbps: chars/ms/1000, vocab: vocab.size});
