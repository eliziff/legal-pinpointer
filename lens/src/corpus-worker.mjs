import {loadEmbeddings,packVectors,packedCosine,TopK} from './embeddings.mjs';
import {structureEngine,sourceWindows} from './structure.mjs';
import * as duckdb from '@duckdb/duckdb-wasm';
import {words,compileQuery,sqlName,sqlValue,pause} from './core.mjs';
import {all,get,put,putBatch,range,remove,deleteWhere,scorePage,postingRows,deleteRange,atomic,scanBlocks} from './store.mjs';
let db,conn,current=null,embeddingPromise,parseStructure,assetBase;const liveFiles=new Map();let lane=Promise.resolve();
const check=job=>{if(job?.cancelled)throw new DOMException('Cancelled','AbortError');};
const notify=(job,info)=>postMessage({event:true,id:job.id,...info});
const identity=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');
async function init(assets){
  const w=new Worker(assets['duckdb-browser-eh.worker.js']);db=new duckdb.AsyncDuckDB(new duckdb.VoidLogger(),w);
  await db.instantiate(assets['duckdb-eh.wasm']);conn=await db.connect();
  assetBase=new URL('.',assets['duckdb-eh.wasm']).href;
  parseStructure=await structureEngine(new URL('../../legal-structure.wasm',assetBase));
  const repository=assetBase.replace(/\/$/,'');
  await conn.query(`SET custom_extension_repository=${sqlValue(repository)}; LOAD parquet;`);
  await conn.query("SET memory_limit='512MB'; SET threads=1; SET preserve_insertion_order=true; SET autoinstall_known_extensions=false; SET autoload_known_extensions=false;");
  return all('files');
}
function schemaProjection(names,path){
  const map=new Map(names.map(n=>[n.toLowerCase(),n]));const field=(...keys)=>{const found=keys.map(k=>map.get(k.toLowerCase())).filter(Boolean);return found.length?`COALESCE(${found.map(x=>`NULLIF(CAST(${sqlName(x)} AS VARCHAR),'')`).join(',')},'')`:"''";};
  let en=field('unofficial_text_en','text_en'),fr=field('unofficial_text_fr','text_fr');
  if(en==="''"&&fr==="''"){const generic=field('Intervention','speech_text','text','content'),french=`lower(${field('language')}) IN ('fr','fra','french','français','francais')`;if(generic!=="''"){en=`CASE WHEN ${french} THEN '' ELSE ${generic} END`;fr=`CASE WHEN ${french} THEN ${generic} ELSE '' END`;}}
  if(en==="''"&&fr==="''")throw new Error(`No recognized text column in ${path}. Columns: ${names.join(', ')}`);
  return `file_row_number AS row_id, ${en} AS text_en, ${fr} AS text_fr, ${field('name_en','name_fr','SubjectofBusiness','title','name')} AS title, ${field('citation_en','citation_fr','ID','id')} AS citation, ${field('document_date_en','document_date_fr','Date','date')} AS date, ${field('dataset','jurisdiction')} AS dataset, ${field('url_en','source_url','url_fr','url')} AS url, ${field('upstream_license')} AS license, ${field('PersonSpeaking','speaker')} AS speaker, ${field('name_fr','name_en','SubjectofBusiness','title','name')} AS title_fr, ${field('citation_fr','citation_en','ID','id')} AS citation_fr, ${field('url_fr','url_en','source_url','url')} AS url_fr, ${field('document_date_fr','document_date_en','Date','date')} AS date_fr`;
}
async function register(entry){
  let file=entry.file;
  if(!file&&entry.handle){if(await entry.handle.queryPermission({mode:'read'})!=='granted')throw new Error(`Reauthorize ${entry.path}`);file=await entry.handle.getFile();}
  if(!file)file=liveFiles.get(entry.id);if(!file)throw new Error(`Select the corpus folder again to reopen ${entry.path}`);
  const sample=new Uint8Array(await new Blob([await file.slice(0,65536).arrayBuffer(),await file.slice(Math.max(0,file.size-65536)).arrayBuffer()]).arrayBuffer());
  const fingerprint=[...new Uint8Array(await crypto.subtle.digest('SHA-256',sample))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const actual=await identity(`${entry.path}\0${file.size}\0${file.lastModified}\0${fingerprint}`);
  if(entry.id&&entry.id!==actual)throw new Error(`${entry.path} changed; reselect the folder to replace its index.`);
  const id=actual,virtual=`local-${id}.parquet`;liveFiles.set(id,file);
  await db.registerFileHandle(virtual,file,duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,true);
  try {
    const desc=await conn.query(`DESCRIBE SELECT * FROM read_parquet(${sqlValue(virtual)},file_row_number=true)`);
    const names=desc.toArray().map(r=>r.column_name),projection=schemaProjection(names,entry.path);
    const count=Number((await conn.query(`SELECT count(*) AS n FROM read_parquet(${sqlValue(virtual)})`)).toArray()[0].n);
    const previous=await get('files',id),info={...previous,id,path:entry.path,size:file.size,lastModified:file.lastModified,handle:entry.handle||previous?.handle||null,virtual,projection,documentType:names.some(n=>['Intervention','PersonSpeaking'].includes(n))?'secondary':/laws|legislat/i.test(entry.path)?'legislation':'case',count,processed:previous?.processed||0,indexed:Boolean(previous?.indexed),error:null};
    await put('files',id,info);return info;
  }catch(e){await db.dropFile(virtual);throw e;}
}
async function release(file){await db.dropFile(file.virtual).catch(()=>{});}
async function add(entries,job){const added=[],errors=[];for(const entry of entries){check(job);try{const f=await register(entry);added.push(f);await release(f);}catch(e){errors.push({path:entry.path,error:e.message});}notify(job,{phase:'register',done:added.length+errors.length,total:entries.length,errors});}return {files:added,errors};}
async function indexFile(file,job){
  file=await register(file);let batch=new Map(),rowsInBatch=0,processed=file.processed,chunk=Math.floor(processed/64);
  const flush=async()=>{
    if(!rowsInBatch)return;check(job);
    file.processed=processed;await atomic([...batch].map(([term,rows])=>({store:'index',key:[file.id,term,chunk],value:Uint32Array.from(rows)})).concat({store:'files',key:file.id,value:file}));batch=new Map();rowsInBatch=0;chunk++;
    notify(job,{phase:'index',path:file.path,processed,total:file.count});await pause();
  };
  try {
    const reader=await conn.send(`SELECT ${file.projection} FROM read_parquet(${sqlValue(file.virtual)},file_row_number=true) WHERE file_row_number>=${processed}`,true);
    for await(const rb of reader)for(const row of rb){check(job);const rowId=Number(row.row_id),terms=new Set(words(`${row.title}\n${row.citation}\n${row.text_en}\n${row.text_fr}`));for(const term of terms){let list=batch.get(term);if(!list)batch.set(term,list=[]);list.push(rowId);}processed=rowId+1;rowsInBatch++;if(rowsInBatch>=64)await flush();}
    await flush();file.indexed=true;file.processed=file.count;file.error=null;await put('files',file.id,file);
  }finally{await release(file);}
}
async function indexAll(job){const errors=[];for(const file of await all('files')){check(job);if(file.indexed)continue;try{await indexFile(file,job);}catch(e){if(e.name==='AbortError')throw e;errors.push({path:file.path,error:e.message});const latest=await get('files',file.id);await put('files',file.id,{...latest,error:e.message});notify(job,{phase:'error',path:file.path,error:e.message});}}return {files:await all('files'),errors};}
async function termSet(node,file){
  if(!node||node.kind==='not')return null;
  if(node.kind==='and'||node.kind==='or'){
    const a=await termSet(node.left,file),b=await termSet(node.right,file);
    if(node.kind==='and')return a===null?b:b===null?a:new Set([...a].filter(x=>b.has(x)));
    if(a===null||b===null)return null;return new Set([...a,...b]);
  }
  let result=null;
  for(const token of node.parts){const rows=await postingRows(file.id,token,node.prefix);result=result===null?rows:new Set([...result].filter(x=>rows.has(x)));}return result;
}
async function search({query,queryId,filters},job){
  const compiled=compileQuery(query),errors=[];let total=0,documents=0,filesDone=0;
  for(let file of await all('files')){
    check(job);let opened=false;
    try{
      file=await register(file);opened=true;const candidates=await termSet(compiled.tree,file);
      await conn.query('CREATE OR REPLACE TEMP TABLE chosen (row_id BIGINT)');
      if(candidates!==null)for(let at=0,ids=[...candidates];at<ids.length;at+=2048){check(job);await conn.query('INSERT INTO chosen VALUES '+ids.slice(at,at+2048).map(id=>`(${id})`).join(','));}
      const where=candidates===null?'TRUE':`(file_row_number IN (SELECT row_id FROM chosen)${file.indexed?'':` OR file_row_number>=${file.processed}`})`;
      const sql=`SELECT * FROM (SELECT ${file.projection} FROM read_parquet(${sqlValue(file.virtual)},file_row_number=true) WHERE ${where}) d WHERE ${filters?.dataset?`contains(lower(dataset),lower(${sqlValue(filters.dataset)}))`:'TRUE'}${filters?.from?` AND date>=${sqlValue(filters.from)}`:''}${filters?.to?` AND substr(date,1,10)<=${sqlValue(filters.to)}`:''}`;
      const reader=await conn.send(sql,true);let pending=[];
      for await(const rb of reader)for(const row of rb){
        check(job);documents++;const langs=filters?.language&&filters.language!=='both'?[filters.language]:['en','fr'];
        for(const lang of langs){const text=String(row[`text_${lang}`]||'');if(!text)continue;
          const meta=rowMetadata(row,file,lang);let nodes=[];try{nodes=parseStructure(text,meta);}catch{}
          for(const w of sourceWindows(text,nodes)){
            if(!compiled.test(`${row.title}\n${row.citation}\n${w.text}`))continue;
            const seq=total++,item={connector:'a2aj',queryId,seq,id:`${file.id}:${row.row_id}:${lang}:${w.start}`,fileId:file.id,rowId:Number(row.row_id),language:lang,...meta,text:w.text,start:w.start,end:w.end,locator:w.locator||'',kind:w.kind||'',unitStart:w.unitStart,unitEnd:w.unitEnd,path:file.path,score:null,rank:1};
            pending.push([[queryId,seq],item]);if(pending.length>=16){await putBatch('results',pending);pending=[];notify(job,{phase:'search',queryId,total,documents,filesDone,path:file.path});await pause();}
          }
        }
        if(documents%64===0)await pause();
      }
      if(pending.length)await putBatch('results',pending);filesDone++;notify(job,{phase:'search',queryId,total,documents,filesDone,path:file.path});
    }catch(e){if(e.name==='AbortError')throw e;errors.push({path:file.path,error:e.message});notify(job,{phase:'error',path:file.path,error:e.message});}
    finally{if(opened)await release(file);}
  }
  return {total,documents,filesDone,errors,complete:errors.length===0};
}
async function readResult(result){const entry=await get('files',result.fileId);if(!entry)throw new Error('This corpus file is no longer registered.');const file=await register(entry);try{const table=await conn.query(`SELECT ${file.projection} FROM read_parquet(${sqlValue(file.virtual)},file_row_number=true) WHERE file_row_number=${Number(result.rowId)}`);const row=table.toArray()[0];if(!row)throw new Error('The original row is no longer present.');const text=String(row[`text_${result.language}`]||''),start=result.start;if(text.slice(start,result.end)!==result.text)throw new Error('The source changed: the exact passage no longer matches.');return {text,start,end:start+result.text.length,license:row.license};}finally{await release(file);}}

function embeddings() { return embeddingPromise ||= loadEmbeddings(new URL('potion/',assetBase)).then(m=>({...m,fingerprint:m.fingerprint+':pinpointer-utf16-w120-o24-v1'})).catch(e=>{embeddingPromise=null;throw e;}); }
function rowMetadata(row, file, language) {
  const fr=language==='fr';
  return { title:String((fr?row.title_fr:row.title)||row.title||row.citation||file.path),
    citation:String((fr?row.citation_fr:row.citation)||''), date:String((fr?row.date_fr:row.date)||''),
    dataset:String(row.dataset||''),url:String((fr?row.url_fr:row.url)||''),license:String(row.license||''),
    speaker:String(row.speaker||''),documentType:file.documentType||'case',language };
}
function accepted(meta, filters={}) {
  return (!filters.language||filters.language==='both'||meta.language===filters.language)
    && (!filters.dataset||meta.dataset.toLocaleLowerCase().includes(filters.dataset.toLocaleLowerCase()))
    && (!filters.from||meta.date>=filters.from) && (!filters.to||meta.date.slice(0,10)<=filters.to);
}
async function buildSemanticFile(file, job, consume=()=>{}) {
  const model=await embeddings();file=await register(file);
  try {
    if(file.semanticFingerprint!==model.fingerprint){
      await deleteRange('vectors',[file.id,0],[file.id,Number.MAX_SAFE_INTEGER]);
      file.semanticProcessed=0;file.semanticBlocks=0;file.semanticComplete=false;file.semanticFingerprint=model.fingerprint;
      await put('files',file.id,file);
    }
    for await(const block of scanBlocks('vectors',file.id)){check(job);await consume(block,file);}
    if(file.semanticComplete)return file;
    let refs=[],vectors=[],metadata={},next=file.semanticProcessed||0,blockNo=file.semanticBlocks||0;
    const flush=async()=>{
      check(job);const packed=packVectors(vectors,model.dimension),block={...packed,refs,metadata,fingerprint:model.fingerprint};
      file.semanticProcessed=next;file.semanticBlocks=blockNo+1;
      await atomic([{store:'vectors',key:[file.id,blockNo],value:block},{store:'files',key:file.id,value:file}]);
      blockNo++;await consume(block,file);refs=[];vectors=[];metadata={};
      notify(job,{phase:'semantic-index',path:file.path,processed:next,total:file.count});await pause();
    };
    const reader=await conn.send(`SELECT ${file.projection} FROM read_parquet(${sqlValue(file.virtual)},file_row_number=true) WHERE file_row_number>=${next}`,true);
    for await(const batch of reader)for(const row of batch){
      check(job);const rowId=Number(row.row_id);
      for(const language of ['en','fr']){
        const text=String(row[`text_${language}`]||'');if(!text.trim())continue;
        const meta=rowMetadata(row,file,language),key=`${rowId}:${language}`;metadata[key]=meta;
        let nodes=[];try{if(meta.documentType!=='secondary')nodes=parseStructure(text,meta);}catch(error){file.structureWarning=error.message;}
        for(const part of sourceWindows(text,nodes)){
          check(job);vectors.push(model.encode(part.text));
          refs.push({rowId,language,start:part.start,end:part.end,unitStart:part.unitStart,unitEnd:part.unitEnd,kind:part.kind,locator:part.locator});
        }
      }
      next=rowId+1;
      if(refs.length>=1024||next%64===0)await flush();
      if(next%8===0)await pause();
    }
    if(refs.length||next!==(file.semanticProcessed||0))await flush();
    file.semanticComplete=true;file.semanticProcessed=file.count;file.error=null;await put('files',file.id,file);return file;
  } finally { await release(file); }
}
async function semanticIndex(job){
  const errors=[];for(const file of await all('files')){check(job);try{await buildSemanticFile(file,job);}catch(e){if(e.name==='AbortError')throw e;errors.push({path:file.path,error:e.message});}}
  return {files:await all('files'),errors};
}
async function semanticSearch({query,limit=64,filters={},exclude=[]},job){
  if(!query.trim())throw new Error('Enter what you want to find.');
  if(!Number.isSafeInteger(limit)||limit<1)throw new Error('Invalid search page size.');
  const model=await embeddings(),vector=model.encode(query),top=new TopK(limit),errors=[],excluded=new Set(exclude);
  let examined=0,filesDone=0;
  for(const file of await all('files')){
    check(job);
    try {
      await buildSemanticFile(file,job,block=>{
        for(let i=0;i<block.refs.length;i++){
          const ref=block.refs[i],meta=block.metadata[`${ref.rowId}:${ref.language}`];
          if(!accepted(meta,filters))continue;
          const id=`${file.id}:${ref.rowId}:${ref.language}:${ref.start}`;examined++;
          if(excluded.has(id))continue;
          top.add({id,value:packedCosine(vector,block,i),ref,fileId:file.id,path:file.path,meta});
        }
      });filesDone++;
      notify(job,{phase:'semantic-search',path:file.path,filesDone,examined});
    }catch(e){if(e.name==='AbortError')throw e;errors.push({path:file.path,error:e.message});notify(job,{phase:'error',path:file.path,error:e.message});}
  }
  const selected=top.sorted(),grouped=new Map();
  for(const item of selected){let items=grouped.get(item.fileId);if(!items)grouped.set(item.fileId,items=[]);items.push(item);}
  const passages=[];
  for(const [fileId,candidates]of grouped){
    check(job);const entry=await get('files',fileId);let file;
    try{
      file=await register(entry);const ids=[...new Set(candidates.map(c=>c.ref.rowId))];
      const table=await conn.query(`SELECT ${file.projection} FROM read_parquet(${sqlValue(file.virtual)},file_row_number=true) WHERE file_row_number IN (${ids.join(',')})`);
      const texts=new Map(table.toArray().map(r=>[Number(r.row_id),r]));
      for(const candidate of candidates){const {ref,meta}=candidate,row=texts.get(ref.rowId);if(!row)throw new Error('A retrieved source row is missing.');
        const text=String(row[`text_${ref.language}`]||'').slice(ref.start,ref.end);
        passages.push({connector:'a2aj',id:candidate.id,fileId,path:file.path,...ref,...meta,text,semantic:candidate.value});
      }
    }catch(e){errors.push({path:entry.path,error:e.message});}finally{if(file)await release(file);}
  }
  passages.sort((a,b)=>b.semantic-a.semantic);
  return {items:passages,examined,filesDone,errors,more:examined-excluded.size>passages.length};
}
self.onmessage=({data})=>{
  if(data.type==='cancel'){if(current){current.cancelled=true;conn?.cancelSent().catch(()=>{});}return;}
  if(data.type==='page'){(data.sort==='fit'?scorePage(data.queryId,data.offset,data.limit):range('results',[data.queryId,data.offset],[data.queryId,data.offset+data.limit-1]).then(x=>x.map(a=>a[1]))).then(x=>postMessage({id:data.id,result:x}),e=>postMessage({id:data.id,error:e.message}));return;}
  if(data.type==='update'){data.item.rank=-(data.item.score??-1);put('results',[data.item.queryId,data.item.seq],data.item).then(()=>postMessage({id:data.id,result:true}),e=>postMessage({id:data.id,error:e.message}));return;}
  lane=lane.catch(()=>{}).then(async()=>{const job={id:data.id,cancelled:false};current=job;try{let result;if(data.type==='init')result=await init(data.assets);else if(data.type==='add')result=await add(data.entries,job);else if(data.type==='index')result=await indexAll(job);else if(data.type==='semantic-search')result=await semanticSearch(data,job);else if(data.type==='semantic-index')result=await semanticIndex(job);else if(data.type==='search')result=await search(data,job);else if(data.type==='read')result=await readResult(data.item);else if(data.type==='list')result=await all('files');else if(data.type==='remove'){await remove('files',data.fileId);liveFiles.delete(data.fileId);await deleteRange('index',[data.fileId,'',0],[data.fileId,'\uffff',Number.MAX_SAFE_INTEGER]);await deleteRange('vectors',[data.fileId,0],[data.fileId,Number.MAX_SAFE_INTEGER]);await deleteWhere('results',(key,value)=>value.fileId===data.fileId);result=true;}else if(data.type==='clear'){await deleteRange('results',[data.queryId,0],[data.queryId,Number.MAX_SAFE_INTEGER]);result=true;}else throw new Error('Unknown corpus operation');postMessage({id:data.id,result});}catch(e){postMessage({id:data.id,error:e.message,name:e.name});}finally{if(current===job)current=null;}});
};
