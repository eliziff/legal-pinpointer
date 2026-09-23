import fs from 'node:fs'; import {tokens, term, terms} from '../src/tokenize.mjs';
const docs = JSON.parse(fs.readFileSync('C:/Users/elias/AppData/Local/Temp/claude/C--Users-elias-Desktop-MikeOSS-Fork/1f20d775-c0b0-4f05-b9bf-1a656c0b4e6c/scratchpad/search-bench/data/tabs-docs.json','utf8'));
const paras = docs.flatMap(d => d.text.split('\n'));
for (let r=0;r<3;r++){ let t=performance.now(); let n=0; for (const p of paras) tokens(p, tok => { if (term(tok)) n++; }); console.log('scan+term', performance.now()-t, n); }
console.log(terms("L'arrêt de la Cour d'appel — Crown's duty to consult; R. v. Jordan, 2016 SCC 27, s. 11(b) ﬁnal Ⅻ"));
