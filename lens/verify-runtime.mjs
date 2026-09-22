import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
const assetsRoot=new URL('../lens-dist/assets/',import.meta.url);
const assets={};
for(const name of ['model.onnx','tokenizer.json','tokenizer_config.json','rl_agent_config.json','ort-wasm-simd-threaded.wasm'])assets[name]=new Blob([await readFile(new URL(name,assetsRoot))]);
assets['ort-wasm-simd-threaded.mjs']=new URL('ort-wasm-simd-threaded.mjs',assetsRoot).href;
let id=0;const pending=new Map();globalThis.self=globalThis;globalThis.postMessage=data=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(new Error(data.error)):p.resolve(data.result)};
await import('./src/decision-worker.mjs');
const call=(type,args)=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});self.onmessage({data:{id:n,type,...args}})});
const evidence=[];let start=performance.now();evidence.push({name:'initialization with actual 2/4-option inference',result:await call('init',{assets}),ms:performance.now()-start});
const query='When can someone end an agreement without first telling the other party?';
for(const [name,text] of [
 ['relevant-paraphrase','A contracting party may terminate immediately, without prior notice, if the other party commits a fundamental breach.'],
 ['irrelevant','The orchid greenhouse is maintained at a constant temperature. Water the seedlings once a day.'],
 ['long-passage','The orchid greenhouse is maintained at a constant temperature. '.repeat(150)+'A contracting party may terminate immediately, without prior notice, if the other party commits a fundamental breach.'],
 ['french','Une partie peut résilier le contrat immédiatement, sans préavis, si l’autre partie commet une violation fondamentale.']
]){
 start=performance.now();const result=await call('rank',{text,query,context:''});assert(Number.isFinite(result.score));evidence.push({name,result,ms:performance.now()-start});console.log(name,result.score,result.windows);
}
assert(evidence[1].result.score>evidence[2].result.score,'Paraphrase must outrank unrelated passage');
assert(evidence[3].result.windows>1,'Long passage must run more than one token window');
assert(evidence[3].result.score>evidence[2].result.score,'Relevant tail must not be discarded');
assert(evidence[4].result.score>evidence[2].result.score,'French relevant passage must outrank unrelated passage');
// Additional authored smoke cases; ranking evidence, not a legal benchmark score.
for(const [name,query,yes,no] of [
 ['statute-paraphrase','Who can look at records kept by a public body?','Every person has a right of access to records in the custody or under the control of a public authority.','The minister may prescribe the dimensions of storage cabinets used for archival records.'],
 ['contrary-authority','Can a landlord enter a rented home without asking first?','A landlord must obtain the tenant’s consent before entering the dwelling except in an emergency.','A landlord must keep a separate accounting record for rental income and property taxes.'],
 ['commentary','Why do scholars criticize using insurance to allocate liability?','The author argues that making liability depend on insurance coverage creates arbitrary differences between otherwise identical claims.','The author reviews the history of Roman property registration and the construction of aqueducts.'],
 ['procedural-paraphrase','Must the person affected get a chance to respond?','Procedural fairness requires that the applicant be heard before an adverse determination is made.','The applicant shall file the original document and three copies at the registry counter.']
]){
 const results=[];
 for(const text of [yes,no])results.push(await call('rank',{text,query,context:name}));
 const passed=results[0].score>results[1].score;evidence.push({name,passed,relevant:results[0].score,irrelevant:results[1].score});
 console.log(name,passed,results.map(r=>r.score));
}
const passed=evidence.every(e=>e.passed!==false);
await writeFile(new URL('../runtime-validation.json',import.meta.url),JSON.stringify({runtime:'ONNX Runtime Web WASM in Node; browser installation is a separate gate',passed,evidence},null,2));
assert(passed,'Held-out relevance ordering must pass');
console.log('PASS: actual WASM startup, paraphrases, French, long-tail coverage and held-out relevance ordering');
