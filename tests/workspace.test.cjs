'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
require('../find-core.js');
const {createBroker} = require('../find-worker.js');
const {createLauncher, canliiURL} = require('../sonar-launcher.js');
const {visibleRange} = require('../sonar-results.js');
const UUID = '12345678-1234-1234-1234-123456789abc';
function fixture() {
  const tabs = [
    { id: 1, windowId: 10, index: 0, groupId: 7, url: 'https://ordinary.test/a', incognito: false },
    { id: 2, windowId: 10, index: 1, groupId: 7, url: 'https://second.test/b', incognito: false },
    { id: 3, windowId: 11, index: 0, groupId: -1, url: 'https://third.test/c', incognito: false },
    { id: 4, windowId: 12, index: 0, groupId: 7, url: 'https://private.test/', incognito: true },
    { id: 5, windowId: 10, index: 2, groupId: -1, url: 'chrome://newtab/', incognito: false }
  ];
  const store = {}, calls = [];
  const api = {
    runtime: {id:'extension', getURL: path => `chrome-extension://extension/${path}`},
    storage: {session:{async get(k){return structuredClone(k?{[k]:store[k]}:store)},async set(v){Object.assign(store,structuredClone(v))},async remove(k){delete store[k]}}},
    tabs: {async get(id){const tab=tabs.find(t=>t.id===id);if(!tab)throw Error('Tab closed');return {...tab}},
      async query(q){return tabs.filter(t=>Object.entries(q).every(([k,v])=>k==='active'||k==='currentWindow'||t[k]===v))},
      async update(id,values){calls.push(['activate',id]);return this.get(id)},async create(o){calls.push(['create',o]);return {id:6,...o}}},
    windows: {WINDOW_ID_CURRENT:-2,async get(id){return {id,incognito:id===12}},async update(id){calls.push(['focus',id]);return {id}}},
    sidePanel:{open(o){calls.push(['panel',o]);return Promise.resolve()}},action:{async setBadgeText(){},async setTitle(){}},
    scripting:{async executeScript(o){calls.push(['inject',o]);const id=o.target.tabId;
      if(o.target.documentIds && o.target.documentIds[0]!==`doc${id}`) throw Error('Document replaced');
      if(o.files || !o.args || typeof o.args[0] === 'boolean')return [{documentId:`doc${id}`,result:true}];
      return [{documentId:`doc${id}`,result:{ok:true,value:o.args[0]==='search'?{url:tabs.find(t=>t.id===id).url,title:`Title ${id}`,characters:100,limited:false,results:[{index:0,preview:'Privilege and waiver.',marks:[{start:0,end:9}]}]}:true}}];}}
  };
  return {api,tabs,store,calls,broker:createBroker(api),panel:{id:'extension',url:api.runtime.getURL('sonar.html'),origin:'chrome-extension://extension'}};
}
const request = (scope='all',sequence=1) => ({type:'SONAR_SEARCH',query:'privileg* waiv*',mode:'p',scope,sequence,originTabId:1,workspace:UUID,incognito:false});

test('browser-level launch works without page access, including blank/new/browser tabs', async()=>{
  for(const url of ['chrome://newtab/','about:blank','chrome://settings/','https://ordinary.test/']) {
    const f=fixture(),launcher=createLauncher(f.api,f.broker),tab={id:9,windowId:10,url};
    const task=launcher.launch(tab,'canlii');
    assert.deepEqual(f.calls[0],['panel',{windowId:10}], 'open in original user gesture, before any await');
    await task;
    assert.equal(f.store['sonar-launch:10'].route,'canlii');
    assert.equal(f.calls.some(([type])=>type==='inject'||type==='create'||type==='activate'),false,'opening search must not access/replace the source page');
  }
});

test('CanLII document text is encoded exactly, never as an authority-name or script URL',()=>{
  const text='"duty of care" /p breach & été #1';
  assert.equal(canliiURL(text),`https://www.canlii.org/en/#search/text=${encodeURIComponent(text)}`);
  assert.equal(new URL(canliiURL('javascript:alert(1)')).hostname,'www.canlii.org');
  assert.throws(()=>canliiURL(' '));assert.throws(()=>canliiURL('x'.repeat(4097)));
});

test('panel workspace searches exact scopes and does not retarget when a result is visited',async()=>{
  const f=fixture();
  for(const [scope,sequence,ids] of [['current',1,[1]],['all',2,[1,2,3]],['group',3,[1,2]]]){
    const r=await f.broker.handle(request(scope,sequence),f.panel);
    assert.deepEqual(r.results.map(x=>x.tabId),ids);
    assert.equal(r.origin.tabId,1);
    assert.equal(r.results[0].windowId,10);
    await f.broker.handle({...request(),type:'SONAR_GO',session:r.session,ticket:r.ticket,id:ids.length-1},f.panel);
    assert.equal(f.calls.some(([type,o])=>type==='inject'&&o.args?.[0]==='reveal'),false,'native panel navigation must not add a second floating return UI');
  }
});

test('only the packaged panel can share workspaces; page senders cannot forge one',async()=>{
  const f=fixture();
  const bad=[{...f.panel,url:'https://evil.test'},{...f.panel,id:'other'},{...f.panel,tab:f.tabs[0],frameId:0}];
  for(const sender of bad)await assert.rejects(f.broker.handle(request(),sender),/sender/);
  await assert.rejects(f.broker.handle({...request(),workspace:'bad'},f.panel),/workspace/);
  await assert.rejects(f.broker.handle({...request(),incognito:true},f.panel),/private/);
});

test('exact navigation survives worker restart and panel handoff, but rejects stale URLs, groups and document IDs',async()=>{
  const f=fixture(),r=await f.broker.handle(request(),f.panel),restarted=createBroker(f.api);
  const go={...request(),type:'SONAR_GO',session:r.session,ticket:r.ticket,id:2};
  await restarted.handle(go,f.panel);
  assert.ok(f.calls.some(([type,id])=>type==='activate'&&id===3));
  f.tabs[2].windowId=14; await assert.rejects(restarted.handle(go,f.panel),/navigated/);f.tabs[2].windowId=11;
  f.tabs[2].url+='/changed'; await assert.rejects(restarted.handle(go,f.panel),/navigated/);f.tabs[2].url=r.results[2].url;
  f.store[r.session].results[2].documentId='expired';await assert.rejects(restarted.handle(go,f.panel),/replaced/);
  await assert.rejects(restarted.handle({...go,ticket:'forged'},f.panel),/expired/);
});

test('back to start restores exact source ranges and clear releases shared workspace',async()=>{
  const f=fixture(),r=await f.broker.handle(request(),f.panel);
  await f.broker.handle({...request(),type:'SONAR_BACK',session:r.session,ticket:r.ticket,id:2},f.panel);
  assert.equal(f.calls.filter(([type,o])=>type==='inject'&&o.args?.[0]==='restore').length,2);
  await f.broker.handle({...request(),type:'SONAR_CLOSE',sequence:10},f.panel);
  assert.equal(Object.keys(f.store).length,0);
});

test('virtual list work is proportional to viewport size, not the result count',()=>{
  for(const size of [1,200,1000])for(const top of [0,1000,131000]){
    const {start,end}=visibleRange(size,top,440);
    assert.ok(end-start<=10);assert.ok(start>=0&&end<=size&&end>=start);
  }
});


test('current-tab preview highlights without changing tab activation or focus',async()=>{
  const f=fixture(),r=await f.broker.handle(request('current'),f.panel);
  await f.broker.handle({...request(),type:'SONAR_PREVIEW',session:r.session,ticket:r.ticket,id:0},f.panel);
  assert.equal(f.calls.some(([type])=>type==='activate'||type==='focus'),false);
  assert.ok(f.calls.some(([type,o])=>type==='inject'&&o.args?.[0]==='preview'));
});
