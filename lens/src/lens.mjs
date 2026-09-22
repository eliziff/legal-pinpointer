import {assetURL, createDecisions} from './assets.mjs';
const $ = id => document.getElementById(id), PAGE = 30;
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const decisions = createDecisions(), pending = new Map();
let originId = Number(new URL(location.href).searchParams.get('origin')) || null;
let worker, dbReady, requestId = 0, controller, queryId, tabItems = [], corpusCount = 0, rankedCorpus = 0;
let page = 0, items = [], selected, renderId = 0;
function status(message = '') { $('status').textContent = message; $('status').parentElement.hidden = !message; }
function check(signal) { signal?.throwIfAborted(); }
function busy(value) {
  for (const id of ['search','query','use-tabs','use-corpus','options-button','files-button','add-folder','add-parquet','index-all']) $(id).disabled = value;
  $('stop').disabled = !value; $('stop').hidden = !value;
}
function request(type, payload = {}, progress) {
  const id = ++requestId;
  return new Promise((resolve,reject) => { pending.set(id,{resolve,reject,progress}); worker.postMessage({id,type,...payload}); });
}
function corpus() {
  if (dbReady) return dbReady;
  worker = new Worker(assetURL('corpus-worker.js'));
  worker.onmessage = ({data}) => {
    const p = pending.get(data.id); if (!p) return;
    if (data.event) { p.progress?.(data); return; }
    pending.delete(data.id);
    if (data.error) { const error = new Error(data.error); error.name = data.name || 'Error'; p.reject(error); }
    else p.resolve(data.result);
  };
  worker.onerror = event => {
    for (const p of pending.values()) p.reject(new Error(event.message || 'Corpus worker failed.'));
    pending.clear(); worker.terminate(); dbReady = null;
  };
  dbReady = request('init',{assets:Object.fromEntries(['duckdb-browser-eh.worker.js','duckdb-eh.wasm'].map(n => [n,assetURL(n)]))})
    .catch(error => { worker.terminate(); dbReady = null; throw error; });
  return dbReady;
}
const compare = (a,b) => b.score-a.score || a.seq-b.seq;
async function refresh() {
  const generation = ++renderId, limit = (page+1)*PAGE;
  const rows = [...tabItems].sort(compare).slice(0,limit);
  if (queryId && rankedCorpus) {
    const saved = await request('page',{queryId,offset:0,limit,sort:'fit'});
    rows.push(...saved.filter(r => Number.isFinite(r.score)).map(r => ({...r,connector:'A2AJ'})));
  }
  if (generation !== renderId) return;
  items = rows.sort(compare).slice(page*PAGE,limit);
  const total = tabItems.length+rankedCorpus;
  $('count').textContent = total ? total.toLocaleString() : '';
  $('pager').hidden = total <= PAGE;
  $('prev').disabled = page === 0; $('next').disabled = limit >= total;
  $('page-info').textContent = `${page*PAGE+1}–${Math.min(total,limit)}`;
  $('results').replaceChildren();
  for (const r of items) {
    const row = document.createElement('article'); row.className = 'result'; row.tabIndex = 0;
    row.innerHTML = `<h3>${escape(r.citation || r.title)}</h3><p>${escape(r.text)}</p><div class="meta">${escape(r.pinpoint || r.locator)} · ${r.connector}</div>`;
    row.onclick = () => select(r); row.onkeydown = e => { if (e.key === 'Enter') select(r); };
    $('results').append(row);
  }
}
async function invoke(tabId,bridge,method,args = [],documentId) {
  const target = documentId ? {tabId,documentIds:[documentId]} : {tabId};
  const [result] = await chrome.scripting.executeScript({target,func:async (name,method,args) => {
    try { return {value:await globalThis[name][method](...args)}; }
    catch (error) { return {error:error.message}; }
  },args:[bridge,method,args]});
  if (!result?.result || result.result.error) throw new Error(result?.result?.error || 'The source tab is unavailable.');
  return {value:result.result.value,documentId:result.documentId};
}
async function collect(tab) {
  const [installed] = await chrome.scripting.executeScript({target:{tabId:tab.id},func:() => !!globalThis.LegalPinpointerLensBridge});
  if (!installed?.result) await chrome.scripting.executeScript({target:{tabId:tab.id},files:['canlii-courts.js','core.js','text-fragments.js','providers.js','content.js']});
  try {
    const result = await invoke(tab.id,'LegalPinpointerLensBridge','collect');
    if (result.value.units?.length) return result;
  } catch (error) { console.debug('Pinpointer structure unavailable:',error.message); }
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:['lens-dist/page.js']});
  const result = await invoke(tab.id,'PinpointerLensPage','collect');
  return {...result,plain:true};
}
async function tabSearch(query,signal) {
  const all = await chrome.tabs.query({});
  const origin = all.find(t => t.id === originId) || all.find(t => t.active && /^https?:/.test(t.url || ''));
  originId = origin?.id || originId;
  const scope = $('scope').value;
  if (scope === 'group' && (!origin || origin.groupId < 0)) throw new Error('The source tab is not in a group. Choose another tab scope.');
  const targets = all.filter(t => /^https?:/.test(t.url || '') && (!origin || !!t.incognito === !!origin.incognito) &&
    (scope === 'all' || scope === 'current' && t.id === originId || scope === 'group' && t.groupId === origin.groupId && t.windowId === origin.windowId));
  let unavailable = 0;
  for (const tab of targets) {
    check(signal);
    let snapshot;
    try { snapshot = await collect(tab); } catch { unavailable++; continue; }
    const process = async unit => {
      check(signal);
      const r = {...unit,id:`${tab.id}:${unit.index}`,seq:tabItems.length,tabId:tab.id,windowId:tab.windowId,
        documentId:snapshot.documentId,handle:snapshot.value,plain:snapshot.plain,connector:'Tabs',
        title:tab.title,citation:snapshot.value.citation || '',url:tab.url};
      const decision = await decisions.rank(r.text,query,`${r.citation || r.title} ${r.pinpoint || r.locator}`,signal);
      check(signal); r.score = decision.score; tabItems.push(r);
      if (tabItems.length % 4 === 0) await refresh();
    };
    if (snapshot.plain) {
      for (let offset=0; offset<snapshot.value.count; offset+=64) {
        const {value} = await invoke(tab.id,'PinpointerLensPage','slice',[offset,64],snapshot.documentId);
        for (const unit of value) await process(unit);
      }
    } else for (const unit of snapshot.value.units) await process(unit);
    await refresh();
  }
  return unavailable;
}
// The corpus connector supplies broad lexical candidates; Laya ranks them.
// Tabs intentionally have no lexical prerequisite.
function corpusQuery(query) {
  if (/["*]|\b(?:AND|OR|NOT)\b|\/[ps]\b/.test(query)) return query;
  const terms = [...new Set(query.match(/[\p{L}\p{N}]+/gu) || [])].filter(w => w.length > 2);
  return (terms.length ? terms : [query]).map(w => `"${w.replaceAll('"','')}"`).join(' OR ');
}
async function corpusSearch(query,signal) {
  await corpus(); check(signal);
  if (!(await request('list')).length) throw new Error('Choose your A2AJ files before searching that source.');
  const result = await request('search',{query:corpusQuery(query),queryId,filters:{language:$('language').value,dataset:$('dataset').value.trim(),from:$('from').value,to:$('to').value}});
  corpusCount = result.total;
  for (let offset=0; offset<corpusCount; offset+=PAGE) {
    check(signal);
    const batch = await request('page',{queryId,offset,limit:PAGE});
    for (const r of batch) {
      const answer = await decisions.rank(r.text,query,`${r.citation || r.title} ${r.locator}`,signal);
      check(signal); r.score = answer.score; delete r.status; delete r.error;
      await request('update',{item:r}); rankedCorpus++;
      if (rankedCorpus % 4 === 0) await refresh();
    }
  }
  return result.errors.length;
}
async function search() {
  if (controller) return;
  const query = $('query').value.trim(), tabs = $('use-tabs').checked, local = $('use-corpus').checked;
  if (!query) { $('query').focus(); return; }
  if (!tabs && !local) { status('Choose Open tabs, Local A2AJ, or both.'); return; }
  const previous = queryId;
  queryId = crypto.randomUUID(); page = 0; tabItems = []; corpusCount = rankedCorpus = 0; selected = null;
  $('preview').replaceChildren(); controller = new AbortController(); const signal = controller.signal;
  busy(true); status('Searching…'); await refresh();
  if (previous && worker && dbReady) await request('clear',{queryId:previous}).catch(() => {});
  const jobs = [];
  try {
    await decisions.start(); check(signal);
    if (tabs) jobs.push(tabSearch(query,signal));
    if (local) jobs.push(corpusSearch(query,signal));
    const problems = (await Promise.all(jobs)).reduce((n,x) => n+x,0);
    status(problems ? 'Some sources could not be searched. Results are incomplete.' : tabItems.length+rankedCorpus ? '' : 'No passages found.');
  } catch (error) {
    const stopped = signal.aborted;
    controller.abort(); worker?.postMessage({type:'cancel'}); await Promise.allSettled(jobs);
    if (!stopped) {
      console.error('Pinpointer search failed:',error);
      tabItems = []; rankedCorpus = 0;
      decisions.close();
    }
    status(stopped ? 'Search stopped.' : 'Search could not finish. Please retry.');
  } finally { controller = null; busy(false); await refresh(); }
}
async function sourceAction(r,mode) {
  if (r.tabId) {
    if (mode === 'open') { await chrome.windows.update(r.windowId,{focused:true}); await chrome.tabs.update(r.tabId,{active:true}); }
    if (!r.plain) return invoke(r.tabId,'LegalPinpointerLensBridge',mode === 'open' ? 'open' : 'copy',mode === 'open' ? [r.index,r.text] : [r.index,r.text,mode],r.documentId);
    return invoke(r.tabId,'PinpointerLensPage','go',[r.handle,r.index,0,r.text.length,r.text],r.documentId);
  }
  const source = await request('read',{item:r});
  $('preview').querySelector('pre').textContent = source.text.slice(Math.max(0,source.start-1000),source.end+1000);
  if (/^https?:/.test(r.url)) await chrome.tabs.create({url:r.url});
}
function select(r) {
  selected = r;
  if (!$('passage').open) $('passage').showModal();
  $('preview').innerHTML = `<h3>${escape(r.citation || r.title)}</h3><p class="small">${escape(r.pinpoint || r.locator)}</p><pre>${escape(r.text)}</pre><div class="tools"></div>`;
  const modes = [['open','Open passage']];
  if (r.tabId && !r.plain) modes.push(['pinpoint','Copy pinpoint'],['quote','Copy quotation'],['citation','Copy citation']);
  for (const [mode,label] of modes) {
    const button = document.createElement('button'); button.textContent = label;
    button.onclick = async () => { try { await sourceAction(r,mode); status(mode === 'open' ? '' : 'Copied.'); } catch { status('The source changed or is unavailable. Search again.'); } };
    $('preview').querySelector('.tools').append(button);
  }
}
async function showCatalog() {
  try {
    await corpus(); const files = await request('list');
    $('catalog-status').textContent = files.length ? `${files.length} files selected.` : 'No files selected.';
    $('file-list').innerHTML = files.map(f => `<p>${escape(f.path)} <button data-remove="${f.id}">Remove</button></p>`).join('');
    for (const button of $('file-list').querySelectorAll('[data-remove]')) button.onclick = async () => { await request('remove',{fileId:button.dataset.remove}); await showCatalog(); };
  } catch { $('catalog-status').textContent = 'Could not open the local corpus.'; }
}
async function addEntries(entries) {
  busy(true);
  try {
    await corpus(); const result = await request('add',{entries}); await showCatalog();
    if (result.errors.length) $('catalog-status').textContent = `${result.errors.length} files could not be added.`;
  } catch { $('catalog-status').textContent = 'The files could not be added.'; }
  finally { busy(false); }
}
$('semantic-form').onsubmit = e => { e.preventDefault(); search(); };
$('stop').onclick = () => { controller?.abort(); worker?.postMessage({type:'cancel'}); status('Stopping…'); };
$('prev').onclick = () => { page--; refresh(); }; $('next').onclick = () => { page++; refresh(); };
$('options-button').onclick = () => $('options').showModal();
$('files-button').onclick = () => { showCatalog(); $('catalog').showModal(); };
for (const id of ['options','catalog','passage']) $(id).querySelector('.close').onclick = () => $(id).close();
$('scope').value = 'all';
$('use-corpus').onchange = () => { $('files-button').hidden = !$('use-corpus').checked; };
$('use-corpus').onchange();
$('origin').onclick = async () => {
  const tabs = await chrome.tabs.query({active:true}), tab = tabs.find(t => /^https?:/.test(t.url || ''));
  if (tab) originId = tab.id;
};
$('wide').onclick = () => chrome.tabs.create({url:chrome.runtime.getURL(`lens-dist/lens.html?origin=${originId || ''}`)});
$('add-folder').onclick = async () => {
  try {
    const root = await showDirectoryPicker({id:'a2aj-corpus',mode:'read'}), entries = [];
    async function walk(handle,prefix) { for await (const [name,child] of handle.entries()) {
      if (child.kind === 'directory') await walk(child,prefix+name+'/');
      else if (/\.parquet$/i.test(name)) entries.push({path:prefix+name,handle:child});
    } }
    await walk(root,root.name+'/'); await addEntries(entries);
  } catch (error) { if (error.name !== 'AbortError') $('catalog-status').textContent = 'Could not open that folder.'; }
};
$('add-parquet').onclick = () => $('parquets').click();
$('parquets').onchange = e => addEntries([...e.target.files].map(file => ({path:file.webkitRelativePath || file.name,file})));
$('index-all').onclick = async () => {
  if (controller) return;
  controller = new AbortController(); busy(true); status('Indexing…');
  try { await corpus(); const result = await request('index'); status(result.errors.length ? 'Some files could not be indexed.' : 'Index ready.'); }
  catch { status(controller.signal.aborted ? 'Indexing paused.' : 'Indexing could not finish.'); }
  finally { controller = null; busy(false); showCatalog(); }
};
window.PinpointerLens = {search,decisions,corpus,request};
status();
