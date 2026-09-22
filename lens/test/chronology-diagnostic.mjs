import {readFile} from 'node:fs/promises';
const base=new URL('../../lens-dist/assets/',import.meta.url),assets={};
for(const name of ['model.onnx','tokenizer.json','tokenizer_config.json','rl_agent_config.json','ort-wasm-simd-threaded.wasm'])assets[name]=new Blob([await readFile(new URL(name,base))]);assets['ort-wasm-simd-threaded.mjs']=new URL('ort-wasm-simd-threaded.mjs',base).href;
let id=0;const pending=new Map();globalThis.self=globalThis;globalThis.postMessage=d=>{const p=pending.get(d.id);if(!p)return;pending.delete(d.id);d.error?p.reject(Error(d.error)):p.resolve(d.result);};await import('../src/decision-worker.mjs');
const call=(type,args)=>new Promise((resolve,reject)=>{const i=++id;pending.set(i,{resolve,reject});self.onmessage({data:{id:i,type,...args}});});await call('init',{assets});
const questions=[
 {type:'noul',instructions:'Does the text describe something that happened?',criteria:{false:'No',true:'Yes'}},
 {type:'noul',instructions:'Does the text describe a specific action or occurrence?',criteria:{false:'No specific occurrence',true:'Describes a specific occurrence'}},
 {type:'choice',instructions:'What does this passage describe?',criteria:{event:'A specific action, occurrence or change',other:'A heading, greeting or general statement'}},
 {type:'choice',instructions:'Is this an event for a timeline?',criteria:{yes:'Yes',no:'No'}}
];
const texts=['Jones inspected the property on 4 April 2026.','The pump failed.','was substantially complete by 18 September 2026.','Patel resigned from the company on 7 July 2026.','Le 8 août 2026, Dupont a rencontré Martin à Montréal.','14 March 2026','This document is confidential.','Kind regards.','The report dated 1 May 2026 states that construction began on 3 May 2026.','Delivery is scheduled for 13 March 2026.'];
for(const text of texts){const answers=[];for(const question of questions){const r=await call('decide',{state:text,question});answers.push({choice:r.choice,probabilities:r.probabilities});}console.log(JSON.stringify({text,answers}));}
