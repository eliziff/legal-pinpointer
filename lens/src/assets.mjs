const urls=new Map(),blobs=new Map();
function embeddedBlob(name){
  if(blobs.has(name))return blobs.get(name);
  const nodes=[...document.querySelectorAll('script[data-asset]')].filter(n=>n.dataset.asset===name);
  if(!nodes.length)return null;
  const parts=nodes.map(node=>{const raw=atob(node.textContent.trim()),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);node.remove();return bytes;});
  const type=/\.m?js$/.test(name)?'text/javascript':name.endsWith('.json')?'application/json':name.endsWith('.wasm')?'application/wasm':'application/octet-stream';
  const blob=new Blob(parts,{type});blobs.set(name,blob);return blob;
}
export function assetURL(name){if(!urls.has(name)){const blob=embeddedBlob(name);urls.set(name,blob?URL.createObjectURL(blob):new URL(`assets/${name}`,import.meta.url).href);}return urls.get(name);}
// Send embedded Blobs, not another opaque origin's URL, across the worker boundary.
function workerAsset(name){return embeddedBlob(name)||assetURL(name);}
export function saveBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
export function createDecisions(onStatus=()=>{}){
  let worker=null,init=null,next=0;const pending=new Map();
  function fail(error){for(const p of pending.values())p.reject(error);pending.clear();worker?.terminate();worker=null;init=null;}
  function request(type,payload){const id=++next;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker.postMessage({id,type,...payload});});}
  function start(){if(init)return init;worker=new Worker(assetURL('decision-worker.js'));worker.onmessage=({data})=>{if(data.status){onStatus(data.status);return;}const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(new Error(data.error)):p.resolve(data.result);};worker.onerror=e=>fail(new Error(e.message||'Decision worker failed.'));
    init=request('init',{assets:Object.fromEntries(['model.onnx','tokenizer.json','tokenizer_config.json','rl_agent_config.json','ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm'].map(n=>[n,workerAsset(n)]))}).catch(e=>{fail(e);throw e;});return init;
  }
  return {start,async decide(state,question,signal){if(signal?.aborted)throw new DOMException('Cancelled','AbortError');await start();if(signal?.aborted)throw new DOMException('Cancelled','AbortError');const result=await request('decide',{state,question});if(signal?.aborted)throw new DOMException('Cancelled','AbortError');return result;},close(){fail(new DOMException('Closed','AbortError'));}};
}
