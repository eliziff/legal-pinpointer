import {createDecisions} from './assets.mjs';
import {TabsConnector,A2AJConnector} from './connectors.mjs';
import {rankPassages,selectSentence} from './ranking.mjs';
import {externalCopy,writeClipboard} from './copy.mjs';
import {pinpoint} from './structure.mjs';
import {escapeHTML as esc} from './core.mjs';
const $=id=>document.getElementById(id),PAGE=20,decisions=createDecisions();
const tabs=new TabsConnector(Number(new URL(location.href).searchParams.get('origin'))||null),a2aj=new A2AJConnector();
let controller=null,items=[],page=0,selected=null,more=false,seen=new Set(),run=null,issues=[];
function status(text=''){ $('status').textContent=text;$('status').parentElement.hidden=!text; }
function busy(value){for(const id of ['search','use-tabs','use-corpus','add-folder','add-parquet','index-all'])$(id).disabled=value;$('stop').hidden=!value; $('stop').disabled=!value;}
function sourceLabel(r){const name=r.citation&&r.title&&!r.title.includes(r.citation)?`${r.title}, ${r.citation}`:r.citation||r.title;return name+(r.locator?' '+pinpoint(r.kind,r.locator):'');}
function render(){
  const scroll=$('results'),top=scroll.scrollTop,rows=items.slice(page*PAGE,(page+1)*PAGE);
  scroll.replaceChildren();$('count').textContent=items.length?String(items.length):'';
  for(const r of rows){
    const row=document.createElement('article');row.className='result';row.dataset.id=r.id;row.tabIndex=0;
    row.innerHTML=`<h3>${esc(sourceLabel(r))}</h3><p>${esc(r.text)}</p>${run?.tabs&&run?.corpus?`<small>${r.connector==='tabs'?'Open tab':'A2AJ'}</small>`:''}`;
    row.onclick=e=>{if(!e.target.closest('button,select,details,summary'))select(r,row);};row.onkeydown=e=>{if(e.key==='Enter'&&e.target===row)select(r,row);};
    scroll.append(row);
    if(selected===r.id)row.classList.add('selected');
  }
  if(!rows.length)scroll.innerHTML='<div class="empty">'+(controller?'Searching…':'Enter a question to find passages.')+'</div>';
  $('pager').hidden=items.length<=PAGE&&!more;$('prev').disabled=page===0;
  $('next').disabled=(page+1)*PAGE>=items.length&&!more;
  $('next').textContent=(page+1)*PAGE>=items.length&&more?'Find more':'→';
  $('page-info').textContent=items.length?`${page*PAGE+1}–${Math.min(items.length,(page+1)*PAGE)}`:'';
  scroll.scrollTop=top;
  $('issues').hidden=!issues.length;
}
async function search(extend=false){
  if(controller){controller.abort();return;}
  if(!extend){
    const query=$('query').value.trim();if(!query)return;
    const previousQueryId=run?.queryId;
    run={query,tabs:$('use-tabs').checked,corpus:$('use-corpus').checked,exact:$('exact').checked,scope:$('scope').value,
      filters:{language:$('language').value,dataset:$('dataset').value.trim(),from:$('from').value,to:$('to').value},queryId:crypto.randomUUID()};
    if(!run.tabs&&!run.corpus){status('Choose Open tabs, Local A2AJ, or both.');return;}
    if(a2aj.worker&&previousQueryId)a2aj.request('clear',{queryId:previousQueryId}).catch(()=>{});
    items=[];seen=new Set();issues=[];more=false;page=0;selected=null;
  }
  const active=run;controller=new AbortController();const signal=controller.signal;busy(true);status('Searching…');render();
  try{
    if(!active.exact)await decisions.start();signal.throwIfAborted();
    const candidates=[];
    if(active.tabs&&!extend){const result=await tabs.search({...active,signal});candidates.push(...result.items);issues.push(...result.errors);}
    if(active.corpus){
      const result=await a2aj.search({...active,limit:24,exclude:[...seen],signal,onProgress:d=>{if(d.phase==='semantic-index')status('Preparing A2AJ search…');}});
      candidates.push(...result.items);issues.push(...(result.errors||[]));more=result.more;
    }
    signal.throwIfAborted();status('Searching…');
    const fresh=candidates.filter(r=>!seen.has(r.id));
    if(active.exact){items.push(...fresh);fresh.forEach(r=>seen.add(r.id));}
    else{
      let published=0;
      await rankPassages(active.query,fresh,decisions,{signal,onResult:r=>{items.push(r);seen.add(r.id);if(++published%4===0){items.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));render();}}});
      items.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
    }
    status(issues.length?'Some sources could not be searched.':items.length?'':'No passages found.');
  }catch(e){
    if(e.name==='AbortError')status('Search stopped.');
    else{console.error(e);issues.push({path:'Search',error:e.message});status('Search could not finish. Details');}
  }finally{controller=null;busy(false);render();}
}
async function select(r,row){
  if(controller)return;
  if(row.classList.contains('expanded')){row.classList.remove('expanded');row.querySelector('.actions')?.remove();return;}
  for(const other of $('results').querySelectorAll('.expanded')){other.classList.remove('expanded');other.querySelector('.actions')?.remove();}
  selected=r.id;row.classList.add('expanded');
  const actions=document.createElement('div');actions.className='actions';
  actions.innerHTML=`<button class="open">Open passage ↗</button><select aria-label="Copy format"><option value="source">Passage + source</option><option value="quote">Quotation</option><option value="pinpoint">Pinpoint</option><option value="citation">Citation</option><option value="link">Link only</option></select><button class="copy">Copy</button><details><summary>Copy options</summary><label>Text <select class="extent"><option value="whole">Whole passage</option><option value="match">Matching sentence</option></select></label><label>Link <select class="link"><option value="native">Native pinpoint</option><option value="text">Text-fragment link</option></select></label><label>Pinpoint <select class="wording"><option value="">Pinpointer setting</option><option value="full">Full</option><option value="short">Short</option><option value="bare">Numbers only</option></select></label></details>`;
  row.append(actions);
  const opts=()=>({extent:actions.querySelector('.extent').value,link:actions.querySelector('.link').value,wording:actions.querySelector('.wording').value});
  actions.querySelector('.copy').onclick=async()=>{
    try{
      const mode=actions.querySelector('select').value,options=opts();
      if(options.extent==='match'&&!r.focus){r.focus=await selectSentence(run.query,r,decisions);if(!r.focus)throw new Error('No matching sentence was identified. Copy the whole passage.');}
      await writeClipboard((r.connector==='tabs'?tabs:a2aj).copy(r,mode,options));status('Copied.');
    }catch(e){status(e.message);}
  };
  actions.querySelector('.open').onclick=async()=>{
    try{
      if(r.connector==='tabs')await tabs.open(r);
      else{
        const source=await a2aj.read(r),payload=externalCopy(r,source.text,'link',{extent:'match',link:'text'});
        await chrome.tabs.create({url:payload.plain});
      }
      status();
    }catch(e){status(e.message);}
  };
  try{
    if(r.connector==='tabs')row.querySelector('p').textContent=r.unitText;
    else{const s=await a2aj.read(r);row.querySelector('p').textContent=s.text.slice(r.unitStart??r.start,r.unitEnd??r.end);}
  }catch(e){status(e.message);}
}
async function showCatalog(){
  try{const files=await a2aj.list();$('catalog-status').textContent=files.length?`${files.length} files selected.`:'Choose your A2AJ folder.';
    $('file-list').replaceChildren();
    for(const file of files){const p=document.createElement('p');p.textContent=file.path+' ';const b=document.createElement('button');b.textContent='Remove';b.onclick=async()=>{await a2aj.remove(file.id);showCatalog();};p.append(b);$('file-list').append(p);}
  }catch(e){$('catalog-status').textContent=e.message;}
}
async function addEntries(entries){busy(true);try{const result=await a2aj.add(entries);issues.push(...result.errors);await showCatalog();if(result.errors.length)$('catalog-status').textContent=result.errors.map(x=>`${x.path}: ${x.error}`).join('\n');}catch(e){$('catalog-status').textContent=e.message;}finally{busy(false);}}
$('semantic-form').onsubmit=e=>{e.preventDefault();search();};$('stop').onclick=()=>controller?.abort();
$('prev').onclick=()=>{page--;selected=null;render();};$('next').onclick=async()=>{if((page+1)*PAGE>=items.length&&more)await search(true);if((page+1)*PAGE<items.length)page++;selected=null;render();};
$('options-button').onclick=()=>$('options').showModal();$('files-button').onclick=()=>{$('catalog').showModal();showCatalog();};
for(const b of document.querySelectorAll('dialog .close'))b.onclick=()=>b.closest('dialog').close();
$('use-corpus').onchange=()=>{$('files-button').hidden=!$('use-corpus').checked;};$('use-corpus').onchange();
$('wide').onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL(`lens-dist/lens.html?origin=${tabs.originId||''}`)});
$('scope').value='all';$('origin').onclick=async()=>{const all=await chrome.tabs.query({active:true});tabs.originId=all.find(t=>/^https?:/.test(t.url||''))?.id||tabs.originId;};
$('add-folder').onclick=async()=>{try{const folder=await showDirectoryPicker({id:'a2aj-corpus',mode:'read'}),entries=[];async function walk(d,p){for await(const [name,h]of d.entries()){if(h.kind==='directory')await walk(h,p+name+'/');else if(/\.parquet$/i.test(name))entries.push({path:p+name,handle:h});}}await walk(folder,folder.name+'/');await addEntries(entries);}catch(e){if(e.name!=='AbortError')$('catalog-status').textContent=e.message;}};
$('add-parquet').onclick=()=>$('parquets').click();$('parquets').onchange=e=>{addEntries([...e.target.files].map(file=>({path:file.webkitRelativePath||file.name,file})));e.target.value='';};
$('index-all').onclick=async()=>{if(controller)return;controller=new AbortController();busy(true);status('Preparing A2AJ search…');try{const result=await a2aj.index(undefined,controller.signal);issues.push(...result.errors);status(result.errors.length?'Some files could not be indexed.':'A2AJ search ready.');}catch(e){status(e.name==='AbortError'?'Indexing paused.':e.message);}finally{controller=null;busy(false);showCatalog();}};
$('issues').onclick=()=>{$('issue-list').replaceChildren();for(const i of issues){const p=document.createElement('p');p.textContent=`${i.path}: ${i.error}`;$('issue-list').append(p);}$('issue-dialog').showModal();};
window.PinpointerLens={search,decisions,a2aj,tabs,get items(){return items;},get busy(){return !!controller;},corpus:()=>a2aj.start(),request:(...args)=>a2aj.request(...args)};
status();render();
