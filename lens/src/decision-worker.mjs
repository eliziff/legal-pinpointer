import * as ort from 'onnxruntime-web/wasm';
import { Tokenizer } from '@huggingface/tokenizers';
// Sequence layout follows upstream Laya and receptron/laya (MIT). No generated text.
let session,tok,config,ids;const cache=new Map();let lane=Promise.resolve();
const softmax=xs=>{const m=Math.max(...xs),es=xs.map(x=>Math.exp(x-m)),s=es.reduce((a,b)=>a+b,0);return es.map(x=>x/s);};
function render(q) {
  if(q.type==='noul')return ['false: '+(q.criteria?.false||'no, the statement does not hold'),'true: '+(q.criteria?.true||'yes, the statement holds')];
  if(q.type==='score')return q.criteria.map((x,i)=>`level ${i}: ${x}`);
  return Object.entries(q.criteria).map(([k,v])=>v?`${k}: ${v}`:k);
}
function pack(state,q) {
  const encode=s=>tok.encode(String(s).split(ids.maskText).join(' '),{add_special_tokens:false}).ids;
  const opts=render(q),optIds=opts.map(s=>[ids.mask,...encode(' '+s)]);
  if(!opts.length||opts.length>20)throw new Error('Choose between 1 and 20 candidate options.');
  if(optIds.some(a=>a.length>49))throw new Error('An option exceeds the model input budget; shorten its description.');
  const budget=config.head_max_len-optIds.reduce((n,x)=>n+x.length,0),head=encode(`${q.type} question: ${q.instructions}`);
  if(head.length>Math.max(8,budget))throw new Error('Question and options exceed the model head budget. Nothing was truncated.');
  const seq=[ids.cls,...head,ids.sep],markers=[];
  for(const option of optIds){markers.push(seq.length);seq.push(...option);}seq.push(ids.sep);
  const data=encode(state);if(seq.length+data.length+1>config.max_len)throw new Error(`Context exceeds ${config.max_len} tokens. Split this passage; it was not judged or silently truncated.`);
  seq.push(...data,ids.sep);return {seq,markers,k:opts.length};
}
async function initialize(assets) {
  postMessage({status:'Loading local Laya weights…'});
  const json=async key=>{const r=await fetch(assets[key]);if(!r.ok)throw new Error(`Missing packaged asset: ${key}`);return r.json();};
  const [tokenizer,tc,c]=await Promise.all(['tokenizer.json','tokenizer_config.json','rl_agent_config.json'].map(json));config=c;
  tok=new Tokenizer(tokenizer,tc);
  const token=(name,fallback)=>typeof tc[name]==='string'?tc[name]:tc[name]?.content||fallback;
  const special=(name,fallback)=>{const text=token(name,fallback),id=tok.token_to_id(text);if(id==null)throw new Error(`Missing ${name} in packaged tokenizer`);return [text,id];};
  const mask=special('mask_token','[MASK]');ids={cls:special('cls_token','[CLS]')[1],sep:special('sep_token','[SEP]')[1],pad:special('pad_token','[PAD]')[1],mask:mask[1],maskText:mask[0]};
  ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;
  ort.env.wasm.wasmPaths={mjs:assets['ort-wasm-simd-threaded.mjs'],wasm:assets['ort-wasm-simd-threaded.wasm']};
  const bytes=new Uint8Array(await (await fetch(assets['model.onnx'])).arrayBuffer());
  session=await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'basic'});
  for(const key of ['input_ids','attention_mask','marker_pos','marker_mask','qtype'])if(!session.inputNames.includes(key))throw new Error(`Incompatible model: missing ${key}`);
  postMessage({status:'Laya multilingual · local INT8 · ready'});return {model:'Laya multilingual INT8',maxTokens:config.max_len};
}
async function decide(state,q) {
  if(!session)throw new Error('Local decision model is not loaded.');
  const key=state+'\0'+JSON.stringify(q);if(cache.has(key))return cache.get(key);
  const {seq,markers,k}=pack(state,q),qt={choice:0,score:1,noul:2}[q.type];if(qt==null)throw new Error('Unsupported decision type.');
  const feeds={input_ids:new ort.Tensor('int64',BigInt64Array.from(seq,BigInt),[1,seq.length]),attention_mask:new ort.Tensor('int64',new BigInt64Array(seq.length).fill(1n),[1,seq.length]),marker_pos:new ort.Tensor('int64',BigInt64Array.from(markers,BigInt),[1,k]),marker_mask:new ort.Tensor('bool',new Uint8Array(k).fill(1),[1,k]),qtype:new ort.Tensor('int64',BigInt64Array.of(BigInt(qt)),[1])};
  const out=await session.run(feeds);const logits=Array.from(out.logits.data).slice(0,k);
  if(logits.some(x=>!Number.isFinite(x)))throw new Error('The model returned non-finite scores.');
  const bucket=k<=2?'2':k<=5?'3-5':k<=10?'6-10':'11+';
  const temperature=config.temperature_by_options?.[`${q.type}:${bucket}`]??config.temperature?.[qt]??config.temperature?.[q.type]??1;
  const probs=softmax(logits.map(x=>x/temperature)),best=probs.indexOf(Math.max(...probs));
  const keys=q.type==='choice'?Object.keys(q.criteria):probs.map((_,i)=>String(i));
  const result={type:q.type,choice:keys[best],probabilities:Object.fromEntries(keys.map((key,i)=>[key,probs[i]])),score:probs.reduce((s,p,i)=>s+p*i,0),noul:probs[1],margin:[...probs].sort((a,b)=>b-a)[0]-([...probs].sort((a,b)=>b-a)[1]||0),tokens:seq.length};
  cache.set(key,result);if(cache.size>512)cache.delete(cache.keys().next().value);
  for(const tensor of Object.values(feeds))tensor.dispose?.();for(const tensor of Object.values(out))tensor.dispose?.();return result;
}
self.onmessage=({data})=>{lane=lane.catch(()=>{}).then(async()=>{try{const result=data.type==='init'?await initialize(data.assets):await decide(data.state,data.question);postMessage({id:data.id,result});}catch(e){postMessage({id:data.id,error:e.message||String(e)});}});};
