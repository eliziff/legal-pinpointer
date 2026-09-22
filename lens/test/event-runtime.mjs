import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {eventCandidates} from '../src/core.mjs';
import {judgeEvent} from '../src/event-judgment.mjs';
const assetsRoot=new URL('../../lens-dist/assets/',import.meta.url),assets={};
for(const name of ['model.onnx','tokenizer.json','tokenizer_config.json','rl_agent_config.json','ort-wasm-simd-threaded.wasm'])assets[name]=new Blob([await readFile(new URL(name,assetsRoot))]);
assets['ort-wasm-simd-threaded.mjs']=new URL('ort-wasm-simd-threaded.mjs',assetsRoot).href;
let id=0;const pending=new Map();globalThis.self=globalThis;
globalThis.postMessage=data=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(new Error(data.error)):p.resolve(data.result);};
await import('../src/decision-worker.mjs');
const call=(type,args)=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});self.onmessage({data:{id:n,type,...args}});});
await call('init',{assets});
const samples=[
 ['The courier collected the notice on 10 March 2026.','completed'],
 ['Delivery is scheduled for 13 March 2026.','planned'],
 ['On 9 March 2026 we requested an extension, but it has not been agreed.','requested'],
 ['We did not deliver the notice on 10 March 2026.','denied'],
 ['If approval is granted, delivery will occur on 13 March 2026.','conditional'],
 ['Collected on 10 March 2026.','unclear'],
 ['The tenant denied receiving the notice on 10 March 2026.','denied']
];
const evidence=[];
for(const [text,expected]of samples){
 const source={id:'fixture',name:'fixture.eml',communicated:'2026-03-12',blocks:[{id:'body',text,locator:'Body'}]};
 const row=eventCandidates(source)[0];
 const result=await judgeEvent(row,source,{decide:(state,question)=>call('decide',{state,question})});
 assert.equal(result.status,expected,text);assert.ok(Object.values(result.probabilities).every(Number.isFinite));
 evidence.push({text,expected,...result});
}
console.log(JSON.stringify({passed:true,evidence},null,2));
