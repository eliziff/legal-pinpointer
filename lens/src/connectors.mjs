import { assetURL } from './assets.mjs';
import { cancelled, compileQuery, pause } from './core.mjs';
import { externalCopy } from './copy.mjs';

export class A2AJConnector {
  constructor() { this.id='a2aj'; this.pending=new Map(); this.next=0; this.ready=null; this.worker=null; }
  start() {
    if(this.ready)return this.ready;
    this.worker=new Worker(assetURL('corpus-worker.js'));
    this.worker.onmessage=({data})=>{
      const task=this.pending.get(data.id);if(!task)return;
      if(data.event){task.progress?.(data);return;}
      this.pending.delete(data.id);
      if(data.error){const error=new Error(data.error);error.name=data.name||'Error';task.reject(error);}
      else task.resolve(data.result);
    };
    this.worker.onerror=event=>{this.worker.terminate();for(const p of this.pending.values())p.reject(new Error(event.message||'A2AJ reader failed.'));this.pending.clear();this.ready=null;};
    this.ready=this.request('init',{assets:Object.fromEntries(['duckdb-browser-eh.worker.js','duckdb-eh.wasm'].map(n=>[n,assetURL(n)]))}).catch(e=>{this.worker.terminate();this.ready=null;throw e;});
    return this.ready;
  }
  request(type,payload={},progress) {
    const id=++this.next;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject,progress});this.worker.postMessage({id,type,...payload});});
  }
  async search({query,exact=false,queryId,filters,limit=64,exclude=[],signal,onProgress}) {
    await this.start();cancelled(signal);
    const stop=()=>this.worker.postMessage({type:'cancel'});signal?.addEventListener('abort',stop,{once:true});
    try {
      if(exact){
        const result=this.lastExact?.queryId===queryId?this.lastExact:await this.request('search',{query,queryId,filters},onProgress);
        this.lastExact={...result,queryId};
        const items=await this.request('page',{queryId,offset:exclude.filter(x=>!x.startsWith('tabs:')).length,limit});
        return {...result,items,more:result.total>items.length+exclude.filter(x=>!x.startsWith('tabs:')).length,queryId};
      }
      return await this.request('semantic-search',{query,filters,limit,exclude},onProgress);
    } finally { signal?.removeEventListener('abort',stop); }
  }
  async read(item) { await this.start();return this.request('read',{item}); }
  async list() { await this.start();return this.request('list'); }
  async add(entries,onProgress) { await this.start();return this.request('add',{entries},onProgress); }
  async remove(fileId) {await this.start();return this.request('remove',{fileId});}
  async index(onProgress,signal) {
    await this.start();const stop=()=>this.worker.postMessage({type:'cancel'});signal?.addEventListener('abort',stop,{once:true});
    try {return await this.request('semantic-index',{},onProgress);}finally{signal?.removeEventListener('abort',stop);}
  }
  async copy(item,mode,options) {
    const original=await this.read(item);
    return externalCopy(item,original.text,mode,options);
  }
}

async function execute(tabId,documentId,method,args,bridge='LegalPinpointerLensBridge') {
  const [result]=await chrome.scripting.executeScript({target:documentId?{tabId,documentIds:[documentId]}:{tabId},
    func:async (name,method,args)=>{try{return {value:await globalThis[name][method](...args)};}catch(e){return {error:e.message};}},args:[bridge,method,args]});
  if(!result?.result||result.result.error)throw new Error(result?.result?.error||'The source tab is no longer available.');
  return {value:result.result.value,documentId:result.documentId};
}

export class TabsConnector {
  constructor(originId) {this.id='tabs';this.originId=originId;}
  async search({query,exact=false,scope='all',signal,onProgress}) {
    const tabs=await chrome.tabs.query({});
    let origin=tabs.find(t=>t.id===this.originId);
    if(!origin){origin=tabs.find(t=>t.active&&/^https?:/.test(t.url||''));this.originId=origin?.id;}
    if(scope==='group'&&(!origin||origin.groupId<0))return {items:[],errors:[{path:'Tabs',error:'The source tab is not in a group. Choose All tabs or This tab.'}]};
    const targets=tabs.filter(t=>/^https?:/.test(t.url||'')&&(!origin||Boolean(t.incognito)===Boolean(origin.incognito))
      &&(scope==='all'||scope==='current'&&t.id===this.originId||scope==='group'&&t.groupId===origin.groupId&&t.windowId===origin.windowId));
    const items=[],errors=[],match=exact?compileQuery(query):null;
    for(const tab of targets){
      cancelled(signal);if(tab.discarded||tab.frozen){errors.push({path:tab.title,error:'Activate this sleeping tab and search again.'});continue;}
      try {
        const installed=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>Boolean(globalThis.LegalPinpointerLensBridge)});
        if(!installed[0]?.result)await chrome.scripting.executeScript({target:{tabId:tab.id},files:['canlii-courts.js','core.js','text-fragments.js','providers.js','content.js']});
        let native;
        try{native=await execute(tab.id,null,'collect',[]);}catch{native=null;}
        if(native?.value.units.length){
          const handle=native.value;
          for(const unit of handle.units)for(const part of [{text:unit.text,start:0,end:unit.text.length}]){
            if(match&&!match.test(part.text))continue;
            items.push({connector:'tabs',id:`tabs:${native.documentId}:${unit.index}:${part.start}`,tabId:tab.id,windowId:tab.windowId,documentId:native.documentId,
              handle:{url:handle.url,revision:handle.revision},native:true,index:unit.index,unitText:unit.text,title:handle.title,citation:handle.citation,
              url:handle.url,target:unit.target,documentType:handle.documentType,kind:unit.kind,locator:unit.locator,text:part.text,start:part.start,end:part.end});
          }
        }else{
          await chrome.scripting.executeScript({target:{tabId:tab.id},files:['lens-dist/page.js']});
          const {value:handle,documentId}=await execute(tab.id,null,'collect',[],'PinpointerLensPage');
          for(let offset=0;offset<handle.count;offset+=64){
            cancelled(signal);const {value:blocks}=await execute(tab.id,documentId,'slice',[offset,64],'PinpointerLensPage');
            for(const block of blocks)for(const part of [{text:block.text,start:0,end:block.text.length}]){
              if(match&&!match.test(part.text))continue;
              items.push({connector:'tabs',id:`tabs:${documentId}:${block.index}:${part.start}`,tabId:tab.id,windowId:tab.windowId,documentId,handle,native:false,index:block.index,
                unitText:block.text,title:tab.title,citation:'',url:tab.url,kind:'',locator:'',text:part.text,start:part.start,end:part.end});
            }
          }
        }
        onProgress?.({phase:'tabs',count:items.length});await pause();
      }catch(e){errors.push({path:tab.title,error:e.message});}
    }
    return {items,errors,total:items.length,more:false};
  }
  async open(item) {
    await chrome.windows.update(item.windowId,{focused:true});await chrome.tabs.update(item.tabId,{active:true});
    if(item.native)return execute(item.tabId,item.documentId,'open',[item.handle,item.index,item.unitText,item.start,item.end]);
    return execute(item.tabId,item.documentId,'go',[item.handle,item.index,item.start,item.end,item.text],'PinpointerLensPage');
  }
  async copy(item,mode,options) {
    const start=options.extent==='match' ? item.start+(item.focus?.start||0):0,
      end=options.extent==='match' ? item.start+(item.focus?.end??item.text.length):item.unitText.length;
    if(item.native)return (await execute(item.tabId,item.documentId,'prepare',[item.handle,item.index,item.unitText,mode,{...options,start,end}])).value;
    return (await execute(item.tabId,item.documentId,'prepare',[item.handle,item.index,start,end,item.unitText,mode,options],'PinpointerLensPage')).value;
  }
}
