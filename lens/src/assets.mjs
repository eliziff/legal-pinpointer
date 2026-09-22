const urls = new Map();
export function assetURL(name) {
  if (urls.has(name)) return urls.get(name);
  const embedded = [...document.querySelectorAll('script[data-asset]')].filter(n=>n.dataset.asset===name);
  let url;
  if (embedded.length) {
    const parts = embedded.map(node => {
      const bytes=Uint8Array.from(atob(node.textContent.trim()),c=>c.charCodeAt(0));
      node.remove(); return bytes;
    });
    url=URL.createObjectURL(new Blob(parts,{type:name.endsWith('.mjs')||name.endsWith('.js')?'text/javascript':name.endsWith('.json')?'application/json':name.endsWith('.wasm')?'application/wasm':'application/octet-stream'}));
  } else url=new URL(`assets/${name}`,import.meta.url).href;
  urls.set(name,url); return url;
}
export function saveBlob(blob,name) {
  const url=URL.createObjectURL(blob),a=document.createElement('a'); a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60_000);
}
export function createDecisions(onStatus=()=>{}) {
  let worker=null,init=null,next=0; const pending=new Map();
  async function start() {
    if(init) return init;
    worker=new Worker(assetURL('decision-worker.js'));
    worker.onmessage=({data})=>{
      if(data.status) { onStatus(data.status); return; }
      const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(new Error(data.error)):p.resolve(data.result);
    };
    worker.onerror=e=>{for(const p of pending.values())p.reject(new Error(e.message||'Decision worker failed.'));pending.clear();worker?.terminate();worker=null;init=null;};
    init=request('init',{assets:Object.fromEntries(['model.onnx','tokenizer.json','tokenizer_config.json','rl_agent_config.json','ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm'].map(n=>[n,assetURL(n)]))});
    return init;
  }
  function request(type,payload) { const id=++next;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker.postMessage({id,type,...payload});}); }
  return { async decide(state,question,signal) { if(signal?.aborted)throw new DOMException('Cancelled','AbortError');await start();if(signal?.aborted)throw new DOMException('Cancelled','AbortError');const result=await request('decide',{state,question});if(signal?.aborted)throw new DOMException('Cancelled','AbortError');return result; },start,
    close(){worker?.terminate();for(const p of pending.values())p.reject(new DOMException('Closed','AbortError'));pending.clear();worker=null;init=null;}
  };
}
