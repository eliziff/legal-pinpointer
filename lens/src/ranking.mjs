import {cancelled} from './core.mjs';
// Jev-specific precedent: hev/reranker and uehaj/jev-semgrep. Each original
// passage receives a typed relevance judgment. Laya uses bounded independent
// encodings rather than pretending to share Jev's multi-question state cache.
export async function rankPassages(query,candidates,decisions,{signal,onResult=()=>{}}={}) {
  const ranked=[];
  for(const item of candidates){
    cancelled(signal);
    const answer=await decisions.rank(item.text,query,'',signal);
    if(!Number.isFinite(answer.noul))throw new Error('Invalid relevance result.');
    const result={...item,score:answer.noul};ranked.push(result);onResult(result);
  }
  return ranked.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
}
export function sentenceSpans(text) {
  return [...new Intl.Segmenter(undefined,{granularity:'sentence'}).segment(text)]
    .filter(s=>s.segment.trim()).map(s=>({text:s.segment,start:s.index,end:s.index+s.segment.length}));
}
export async function selectSentence(query,item,decisions,signal) {
  const spans=sentenceSpans(item.text);let best=null;
  for(const s of spans){
    cancelled(signal);
    const answer=await decisions.rank(s.text,query,item.text.slice(Math.max(0,s.start-300),s.start),signal);
    if(!Number.isFinite(answer.noul))throw new Error('Invalid sentence relevance result.');
    if(!best||answer.noul>best.score)best={start:s.start,end:s.end,score:answer.noul};
  }
  return best&&{start:best.start,end:best.end};
}
