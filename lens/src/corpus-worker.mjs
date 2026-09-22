import * as duckdb from '@duckdb/duckdb-wasm';
import {words,compileQuery,passageWindows,paragraphSpans,sqlName,sqlValue,pause} from './core.mjs';
import {all,get,put,putBatch,range,remove,deleteWhere,scorePage,postingRows,deleteRange} from './store.mjs';
let db,conn,current=null;const liveFiles=new Map();let lane=Promise.resolve();
const check=job=>{if(job?.cancelled)throw new DOMException('Cancelled','AbortError');};
const notify=(job,info)=>postMessage({event:true,id:job.id,...info});
const identity=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');
async function init(assets){const w=new Worker(assets['duckdb-browser-eh.worker.js']);db=new duckdb.AsyncDuckDB(new duckdb.VoidLogger(),w);await db.instantiate(assets['duckdb-eh.wasm']);conn=await db.connect();await conn.query("SET memory_limit='512MB'; SET threads=1; SET preserve_insertion_order=true; SET autoinstall_known_extensions=false; SET autoload_known_extensions=false;");return all('files');}
function schemaProjection(names,path){
  const map=new Map(names.map(n=>[n.toLowerCase(),n]));const field=(...keys)=>{const found=keys.map(k=>map.get(k.toLowerCase())).filter(Boolean);return found.length?`COALESCE(${found.map(x=>`NULLIF(CAST(${sqlName(x)} AS VARCHAR),'')`).join(',')},'')`:"''";};
  let en=field('unofficial_text_en','text_en'),fr=field('unofficial_text_fr','text_fr');
  if(en==="''"&&fr==="''"){const generic=field('Intervention','speech_text','text','content'),french=`lower(${field('language')}) IN ('fr','fra','french','français','francais')`;if(generic!=="''"){en=`CASE WHEN ${french} THEN '' ELSE ${generic} END`;fr=`CASE WHEN ${french} THEN ${generic} ELSE '' END`;}}
  if(en==="''"&&fr==="''")throw new Error(`No recognized text column in ${path}. Columns: ${names.join(', ')}`);
  return `file_row_number AS row_id, ${en} AS text_en, ${fr} AS text_fr, ${field('name_en','name_fr','SubjectofBusiness','title','name')} AS title, ${field('citation_en','citation_fr','ID','id')} AS citation, ${field('document_date_en','document_date_fr','Date','date')} AS date, ${field('dataset','jurisdiction')} AS dataset, ${field('url_en','source_url','url_fr','url')} AS url, ${field('upstream_license')} AS license, ${field('PersonSpeaking','speaker')} AS speaker`;
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
    const previous=await get('files',id),info={id,path:entry.path,size:file.size,lastModified:file.lastModified,handle:entry.handle||previous?.handle||null,virtual,projection,count,processed:previous?.processed||0,indexed:Boolean(previous?.indexed),error:null};
    await put('files',id,info);return info;
  }catch(e){await db.dropFile(virtual);throw e;}
}
async function release(file){await db.dropFile(file.virtual).catch(()=>{});}
async function add(entries,job){const added=[],errors=[];for(const entry of entries){check(job);try{const f=await register(entry);added.push(f);await release(f);}catch(e){errors.push({path:entry.path,error:e.message});}notify(job,{phase:'register',done:added.length+errors.length,total:entries.length,errors});}return {files:added,errors};}
async function indexFile(file,job){
  file=await register(file);let batch=new Map(),rowsInBatch=0,processed=file.processed,chunk=Math.floor(processed/64);
  const flush=async()=>{
    if(!rowsInBatch)return;check(job);
    await putBatch('index',[...batch].map(([term,rows])=>[[file.id,term,chunk],Uint32Array.from(rows)]));
    file.processed=processed;await put('files',file.id,file);batch=new Map();rowsInBatch=0;chunk++;
    notify(job,{phase:'index',path:file.path,processed,total:file.count});await pause();
  };
  try {
    const reader=await conn.send(`SELECT ${file.projection} FROM read_parquet(${sqlValue(file.virtual)},file_row_number=true) WHERE file_row_number>=${processed}`,true);
    for await(const rb of reader)for(const row of rb){check(job);const rowId=Number(row.row_id),terms=new Set(words(`${row.title}\n${row.citation}\n${row.text_en}\n${row.text_fr}`));for(const term of terms){let list=batch.get(term);if(!list)batch.set(term,list=[]);list.push(rowId);}processed=rowId+1;rowsInBatch++;if(rowsInBatch>=64)await flush();}
    await flush();file.indexed=true;file.processed=file.count;file.error=null;await put('files',file.id,file);
  }finally{await release(file);}
}
async function indexAll(job){const errors=[];for(const file of await all('files')){check(job);if(file.indexed)continue;try{await indexFile(file,job);}catch(e){if(e.name==='AbortError')throw e;errors.push({path:file.path,error:e.message});file.error=e.message;await put('files',file.id,file);notify(job,{phase:'error',path:file.path,error:e.message});}}return {files:await all('files'),errors};}
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
      // Row IDs avoid a giant IN list; every unindexed tail remains searchable.
      await conn.query('CREATE OR REPLACE TEMP TABLE chosen (row_id BIGINT)');
      if(candidates!==null)for(let at=0,ids=[...candidates];at<ids.length;at+=2048){check(job);await conn.query('INSERT INTO chosen VALUES '+ids.slice(at,at+2048).map(id=>`(${id})`).join(','));}
      const where=candidates===null?'TRUE':`(file_row_number IN (SELECT row_id FROM chosen)${file.indexed?'':` OR file_row_number>=${file.processed}`})`;
      const sql=`SELECT * FROM (SELECT ${file.projection} FROM read_parquet(${sqlValue(file.virtual)},file_row_number=true) WHERE ${where}) d WHERE ${filters?.dataset?`contains(lower(dataset),lower(${sqlValue(filters.dataset)}))`:'TRUE'}${filters?.from?` AND date>=${sqlValue(filters.from)}`:''}${filters?.to?` AND substr(date,1,10)<=${sqlValue(filters.to)}`:''}`;
      const reader=await conn.send(sql,true);let pending=[];
      for await(const rb of reader)for(const row of rb){
        check(job);documents++;const langs=filters?.language&&filters.language!=='both'?[filters.language]:['en','fr'];
        for(const lang of langs){const text=String(row[`text_${lang}`]||'');if(!text)continue;let para=0;
          for(const paragraph of paragraphSpans(text)){
            const offset=paragraph.start;para++;for(const w of passageWindows(paragraph.text)){
              if(!compiled.test(`${row.title}\n${row.citation}\n${w.text}`))continue;
              const seq=total++,item={queryId,seq,id:`${file.id}:${row.row_id}:${lang}:${offset+w.start}`,fileId:file.id,rowId:Number(row.row_id),language:lang,title:String(row.title||row.citation||file.path),citation:String(row.citation||''),date:String(row.date||''),dataset:String(row.dataset||''),url:String(row.url||''),license:String(row.license||''),speaker:String(row.speaker||''),text:w.text,start:offset+w.start,end:offset+w.end,locator:`Text paragraph ${para}`,path:file.path,score:null,rank:1,status:'Not yet judged'};
              pending.push([[queryId,seq],item]);if(pending.length>=16){await putBatch('results',pending);pending=[];notify(job,{phase:'search',queryId,total,documents,filesDone,path:file.path});await pause();}
            }
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
self.onmessage=({data})=>{
  if(data.type==='cancel'){if(current)current.cancelled=true;return;}
  if(data.type==='page'){(data.sort==='fit'?scorePage(data.queryId,data.offset,data.limit):range('results',[data.queryId,data.offset],[data.queryId,data.offset+data.limit-1]).then(x=>x.map(a=>a[1]))).then(x=>postMessage({id:data.id,result:x}),e=>postMessage({id:data.id,error:e.message}));return;}
  if(data.type==='update'){data.item.rank=-(data.item.score??-1);put('results',[data.item.queryId,data.item.seq],data.item).then(()=>postMessage({id:data.id,result:true}),e=>postMessage({id:data.id,error:e.message}));return;}
  lane=lane.catch(()=>{}).then(async()=>{const job={id:data.id,cancelled:false};current=job;try{let result;if(data.type==='init')result=await init(data.assets);else if(data.type==='add')result=await add(data.entries,job);else if(data.type==='index')result=await indexAll(job);else if(data.type==='search')result=await search(data,job);else if(data.type==='read')result=await readResult(data.item);else if(data.type==='list')result=await all('files');else if(data.type==='remove'){await remove('files',data.fileId);liveFiles.delete(data.fileId);await deleteRange('index',[data.fileId,'',0],[data.fileId,'\uffff',Number.MAX_SAFE_INTEGER]);await deleteWhere('results',(key,value)=>value.fileId===data.fileId);result=true;}else if(data.type==='clear'){await deleteRange('results',[data.queryId,0],[data.queryId,Number.MAX_SAFE_INTEGER]);result=true;}else throw new Error('Unknown corpus operation');postMessage({id:data.id,result});}catch(e){postMessage({id:data.id,error:e.message,name:e.name});}finally{if(current===job)current=null;}});
};
