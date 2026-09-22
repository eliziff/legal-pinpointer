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
function workerAsset(name){return embeddedBlob(name)||assetURL(name);}
export function saveBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
export function createDecisions(onStatus=()=>{}){
  let worker=null,init=null,next=0;const pending=new Map();
  function fail(error){for(const p of pending.values())p.reject(error);pending.clear();worker?.terminate();worker=null;init=null;}
  function request(type,payload,signal){
    if(signal?.aborted)return Promise.reject(new DOMException('Cancelled','AbortError'));
    const id=++next;
    return new Promise((resolve,reject)=>{
      const done=fn=>value=>{signal?.removeEventListener('abort',abort);fn(value);};
      const abort=()=>{pending.delete(id);worker?.postMessage({type:'cancel',id});done(reject)(new DOMException('Cancelled','AbortError'));};
      pending.set(id,{resolve:done(resolve),reject:done(reject)});
      signal?.addEventListener('abort',abort,{once:true});
      try{worker.postMessage({id,type,...payload});}catch(e){pending.delete(id);done(reject)(e);}
    });
  }
  function start(){
    if(init)return init;
    try{
      worker=new Worker(assetURL('decision-worker.js'));
      worker.onmessage=({data})=>{if(data.status)return;const p=pending.get(data.id);if(!p)return;pending.delete(data.id);if(data.error){const e=new Error(data.error);e.name=data.name||'Error';p.reject(e);}else p.resolve(data.result);};
      worker.onerror=e=>fail(new Error(e.message||'Search worker failed.'));
      worker.onmessageerror=()=>fail(new Error('Invalid search worker response.'));
      onStatus('Preparing search…');
      init=request('init',{assets:Object.fromEntries(['model.onnx','tokenizer.json','tokenizer_config.json','rl_agent_config.json','ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm'].map(n=>[n,workerAsset(n)]))})
        .then(result=>{onStatus('Ready.');return result;}).catch(e=>{fail(e);throw e;});
      return init;
    }catch(e){fail(e);return Promise.reject(e);}
  }
  async function call(type,payload,signal){await start();return request(type,payload,signal);}
  return {start,decide:(state,question,signal)=>call('decide',{state,question},signal),rank:(text,query,context,signal)=>call('rank',{text,query,context},signal),close(){fail(new DOMException('Closed','AbortError'));}};
}
