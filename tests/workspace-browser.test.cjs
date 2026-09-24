'use strict';
// Real renderer/page/broker/launcher code; Chrome's privileged APIs are simulated.
// This test is NOT a native side-panel or OS accelerator certification.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
require('../find-core.js');
const {createBroker} = require('../find-worker.js');
const {createLauncher} = require('../sonar-launcher.js');
const {ROW_HEIGHT} = require('../sonar-results.js');
const root = path.resolve(__dirname,'..');

test('persistent workspace navigates real ranges across documents with stable layout, plus new-tab CanLII launch', {timeout:60000}, async()=>{
  const browser = await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const errors=[], panels=new Map(), sources=new Map(), storage={}, calls=[];
  const tabs=[
    {id:1,windowId:10,index:0,groupId:7,url:'https://ordinary.test/article',title:'Source A — fictional fixture',incognito:false},
    {id:2,windowId:10,index:1,groupId:7,url:'https://other.test/article',title:'Source B — fictional fixture',incognito:false},
    {id:3,windowId:11,index:0,groupId:8,url:'https://third.test/article',title:'Source C — fictional fixture',incognito:false},
    {id:4,windowId:10,index:2,groupId:-1,url:'chrome://newtab/',title:'New tab',incognito:false}
  ];
  let active=1, lastExternal=null;
  const api={
    runtime:{id:'extension',getURL:p=>`chrome-extension://extension/${p}`},
    storage:{session:{
      async get(key){return structuredClone(key?{[key]:storage[key]}:storage)},
      async set(values){
        const changes={};for(const[k,v]of Object.entries(values)){changes[k]={oldValue:storage[k],newValue:structuredClone(v)};storage[k]=structuredClone(v)}
        await Promise.all([...panels.values()].map(p=>p.evaluate(changes=>{for(const fn of __storageListeners)fn(changes,'session')},changes)));
      },
      async remove(key){const old=storage[key];delete storage[key];await Promise.all([...panels.values()].map(p=>p.evaluate(({key,old})=>{for(const fn of __storageListeners)fn({[key]:{oldValue:old}},'session')},{key,old})));}
    }},
    tabs:{async get(id){const tab=tabs.find(t=>t.id===id);if(!tab)throw Error('Tab closed');return {...tab}},
      async query(q){return tabs.filter(t=>Object.entries(q).every(([k,v])=>k==='active'?t.id===active:k==='currentWindow'?true:t[k]===v))},
      async update(id){active=id;calls.push(['activate',id]);return this.get(id)},
      async create(value){lastExternal=value;calls.push(['external',value]);return {id:50,...value}}},
    windows:{WINDOW_ID_CURRENT:-2,async get(id){return {id,incognito:false}},async update(id){calls.push(['focus',id])}},
    sidePanel:{open(value){calls.push(['panel',value]);return Promise.resolve()}},
    action:{async setBadgeText(){},async setTitle(){}},
    scripting:{async executeScript(options){
      const p=sources.get(options.target.tabId),tabId=options.target.tabId;calls.push(['inject',tabId,options.args?.[0]]);
      if(!p || options.target.documentIds && options.target.documentIds[0]!==`doc${tabId}`)throw Error('Document unavailable');
      let result;
      if(options.files){for(const f of options.files)await p.evaluate(fs.readFileSync(path.join(root,f),'utf8'))}
      else result=await p.evaluate(`(${options.func.toString()})(...${JSON.stringify(options.args||[])})`);
      if(options.args?.[0]==='search'&&result?.ok) result.value.url=tabs.find(t=>t.id===tabId).url;
      return [{documentId:`doc${tabId}`,result}];
    }}
  };
  let broker=createBroker(api),launcher=createLauncher(api,broker);
  function dispatch(message,sender){return new Promise(resolve=>{if(!launcher.onMessage(message,sender,resolve))resolve({ok:false,message:'Unknown message'})})}
  try{
    for(const tab of tabs.slice(0,3)){
      const p=await browser.newPage({viewport:{width:1100,height:800}});sources.set(tab.id,p);p.on('pageerror',e=>errors.push(e.message));
      await p.setContent(`<html><head><title>${tab.title}</title></head><body style="font:18px/1.8 system-ui;margin:50px 80px"><h1>${tab.title}</h1>${tab.id===1?'<p>Privilege exists. Waiver is disputed.</p><p id="destination">[<a id="par42">42</a>] A <em>waiver</em> of privilege was established.</p>':`<p style="margin-top:1500px" id="destination">[<a id="par${tab.id}">${tab.id}</a>] Privilege and waiver appear together.</p>`}<p style="height:1000px">End.</p></body></html>`);
      await p.exposeFunction('__notify',async message=>{
        const sender={id:'extension',tab,documentId:`doc${tab.id}`,frameId:0,url:tab.url};
        for(const panel of panels.values())await panel.evaluate(({message,sender})=>{for(const fn of __messageListeners)fn(message,sender)},{message,sender});
      });
      await p.evaluate(()=>{globalThis.chrome={runtime:{sendMessage:message=>__notify(message)}}});
    }
    async function newPanel(windowId){
      const p=await browser.newPage({viewport:{width:400,height:900}});p.on('pageerror',e=>errors.push(e.message));
      await p.setContent(fs.readFileSync(path.join(root,'sonar.html'),'utf8').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]+>/g,''));
      await p.addStyleTag({content:fs.readFileSync(path.join(root,'sonar.css'),'utf8')});
      await p.exposeFunction('__send',m=>dispatch(m,{id:'extension',url:api.runtime.getURL('sonar.html')}));
      await p.exposeFunction('__get',k=>api.storage.session.get(k));await p.exposeFunction('__set',v=>api.storage.session.set(v));await p.exposeFunction('__remove',k=>api.storage.session.remove(k));
      await p.exposeFunction('__tabs',q=>api.tabs.query(q));await p.exposeFunction('__open',v=>api.sidePanel.open(v));
      await p.evaluate(windowId=>{
        globalThis.__storageListeners=[];globalThis.__messageListeners=[];
        // about:blank is not the extension's secure origin; supply its UUID API in the fixture.
        let uuid=windowId;
        crypto.randomUUID ||= () => `00000000-0000-4000-8000-${(++uuid).toString(16).padStart(12,'0')}`;
        globalThis.chrome={windows:{getCurrent:async()=>({id:windowId,incognito:false})},tabs:{query:q=>__tabs(q)},
          storage:{session:{get:k=>__get(k),set:v=>__set(v),remove:k=>__remove(k)},onChanged:{addListener:f=>__storageListeners.push(f)}},
          runtime:{id:'extension',getURL:p=>`chrome-extension://extension/${p}`,sendMessage:m=>__send(m),onMessage:{addListener:f=>__messageListeners.push(f)}},sidePanel:{open:v=>__open(v),close:async()=>{globalThis.__closed=true}}};
      },windowId);
      panels.set(windowId,p);
      for(const f of ['find-core.js','sonar-results.js','sonar.js'])await p.evaluate(fs.readFileSync(path.join(root,f),'utf8'));
      await p.waitForFunction(()=>document.querySelector('#origin').textContent.includes('Source')||document.querySelector('#origin').textContent.includes('browser tab'),null,{timeout:5000});
      return p;
    }
    const p=await newPanel(10),other=sources.get(2);
    const until=async(f,label)=>{for(let i=0;i<100&&!f();i++)await new Promise(r=>setTimeout(r,50));assert.ok(f(),label)};
    const rows=n=>p.waitForFunction(([n,h])=>document.getElementById('list-viewport').getAttribute('aria-busy')==='false'&&document.getElementById('result-spacer').style.height===`${n*h}px`,[n,ROW_HEIGHT]);
    const fill=async text=>{await p.locator('#query').fill(text);};
    const geometry=()=>p.evaluate(()=>['query','list-viewport','notice'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,x:r.x,y:r.y,height:r.height}}));
    const opened=()=>calls.filter(([type,,method])=>type==='inject'&&method==='preview').length;
    const baseGeometry=await geometry();
    await fill('privileg* waiv*');await rows(2);
    await p.locator('#query').press('Tab');await rows(1);
    assert.equal(await p.locator('#mode').textContent(),'/s');
    await p.locator('#query').press('Shift+Tab');await rows(3);
    assert.equal(await p.locator('#scope').textContent(),'All tabs');
    assert.equal(await p.locator('#issues').isHidden(),true,'A restricted new tab is not reported as skipped');
    await p.locator('#query').press('Shift+Tab');await rows(2);
    assert.equal(await p.locator('#scope').textContent(),'Current tab group');
    await p.locator('#query').press('Shift+Tab');await rows(1);
    await p.locator('#query').press('Shift+Tab');await rows(3);
    await p.evaluate(()=>globalThis.__inputBefore=document.getElementById('query'));
    const sourceBefore=await other.locator('body').innerHTML();
    // Enter in the search box focuses the first result; clicking a row selects it. Neither opens anything.
    await p.locator('#query').press('Enter');
    await p.waitForFunction(()=>document.activeElement.id==='list-viewport'&&document.querySelector('.result-row[aria-selected=true]')?.dataset.result==='0');
    await p.locator('.result-row[data-result="1"] .result-text').click();
    assert.equal(await p.locator('.result-row[aria-selected=true]').getAttribute('data-result'),'1');
    await p.waitForTimeout(150);
    assert.equal(active,1);assert.equal(opened(),0,'Selecting a result never moves a page');
    // Enter on the focused result opens it.
    await p.keyboard.press('Enter');
    await other.waitForFunction(()=>CSS.highlights.has('legal-pinpointer-sonar-active'));
    assert.equal(active,2);assert.ok(await other.evaluate(()=>scrollY)>0);
    assert.equal(await other.evaluate(()=>[...CSS.highlights.get('legal-pinpointer-sonar-active')].map(r=>r.toString()).join('|')),'Privilege|waiver');
    assert.equal(await p.locator('#query').inputValue(),'privileg* waiv*');
    assert.equal(await p.evaluate(()=>__inputBefore===document.getElementById('query')),true);
    assert.deepEqual(await geometry(),baseGeometry,'Search and list geometry never move when results change');
    assert.equal(await other.locator('body').innerHTML(),sourceBefore);
    // An other-window result's Open button opens that window's panel in the original click
    // gesture, with a restarted broker loading the issued handles.
    broker=createBroker(api);launcher=createLauncher(api,broker);
    await p.locator('.result-row[data-result="2"] .result-open').click();
    await until(()=>active===3&&storage['sonar-launch:11']?.handoff,'Open activates the other window\'s tab and hands off the search');
    assert.ok(calls.some(([type,o])=>type==='panel'&&o.windowId===11));
    const second=await newPanel(11);
    await second.waitForFunction(()=>document.getElementById('query').value==='privileg* waiv*');
    assert.equal(await second.locator('.result-row[aria-selected=true]').getAttribute('data-result'),'2');
    assert.equal(await second.locator('#scope').textContent(),'All tabs');
    // Source invalidation is observed, not silently resolved against changed words.
    await other.locator('#destination').evaluate(el=>el.firstChild.textContent='Changed.');
    await p.locator('.result-row[data-result="1"] .result-open').click();
    await p.waitForFunction(()=>document.getElementById('notice').classList.contains('error'));
    assert.equal(active,3,'Stale source must not activate a different passage');
    // Alt+Shift+S command route takes no injection path, even from the restricted new tab.
    const beforeCalls=calls.filter(([type])=>type==='inject').length;
    await launcher.launch(tabs[3],'canlii');
    await p.waitForFunction(()=>document.body.dataset.route==='canlii');
    assert.equal(calls.filter(([type])=>type==='inject').length,beforeCalls);
    for(const id of ['mode','scope-row','origin','list-viewport'])assert.equal(await p.locator(`#${id}`).isVisible(),false,`${id} is hidden on the CanLII route`);
    const q='"duty of care" /p breach & été';
    await fill(q);assert.equal(lastExternal,null,'Typing cannot submit a remote search');
    await p.locator('#query').press('Enter');
    await until(()=>lastExternal,'Enter submits the CanLII search');
    assert.equal(lastExternal.url,`https://www.canlii.org/en/#search/text=${encodeURIComponent(q)}`);
    await p.locator('#tabs-route').click();
    assert.equal(await p.locator('#query').inputValue(),'privileg* waiv*','CanLII draft must not overwrite the local query');
    assert.equal(await p.locator('#scope').textContent(),'All tabs');
    assert.deepEqual(await geometry(),baseGeometry);
    // Render stress: 1,000 results, a long excerpt, stable header, bounded live rows.
    const stored=Object.entries(storage).find(([k,v])=>k.startsWith('pinpointer-sonar:')&&v.results?.length);
    const workspace=stored[0].split('workspace:')[1];
    const sample={tabId:1,windowId:10,documentId:'doc1',url:tabs[0].url,title:tabs[0].title,preview:'The privilege remains unless waiver is established. '.repeat(8),marks:[{start:4,end:13}],locator:'para 42'};
    const items=Array.from({length:1000},(_,i)=>({...sample,index:i,locator:`para ${i+1}`}));
    const fake={session:stored[0],ticket:stored[1].ticket,results:items,mode:'s',searched:5,total:5,skipped:[],limited:false};
    await api.storage.session.set({'sonar-launch:10':{nonce:'render-test',created:Date.now(),route:'tabs',origin:tabs[0],handoff:{workspace,origin:tabs[0],query:'privileg* waiv*',mode:'s',scope:'all',sequence:Date.now(),result:fake,current:999,scrollTop:ROW_HEIGHT*998}}});
    await p.waitForFunction(()=>document.querySelector('.result-row[data-result="999"][aria-selected=true]'));
    const mounted=await p.locator('.result-row').count();
    assert.ok(mounted<=await p.evaluate(h=>Math.ceil(document.getElementById('list-viewport').clientHeight/h)+6,ROW_HEIGHT));
    assert.deepEqual(await geometry(),baseGeometry);
    await p.screenshot({path:process.env.SONAR_SCREENSHOT || path.join(root,'..','sonar-finished-preview.png')});
    // Font/viewport changes keep virtualization mathematically aligned.
    await p.setViewportSize({width:320,height:560});await p.waitForTimeout(80);
    assert.equal(await p.locator('.result-row').first().evaluate(el=>el.getBoundingClientRect().height),ROW_HEIGHT);
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    // Escape clears the search and leaves the panel open.
    await p.locator('#query').focus();await p.keyboard.press('Escape');await p.waitForFunction(()=>document.getElementById('query').value==='');
    assert.equal(await p.locator('.result-row').count(),0);
    assert.equal(await p.evaluate(()=>globalThis.__closed),undefined);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({renderer:browser.version(),results:1000,mountedRows:mounted,layoutStable:true}));
  }finally{await browser.close()}
});
