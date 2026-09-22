import {chromium} from 'playwright';
import {mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),repo=path.resolve(root,'..'),profile=await mkdtemp(path.join(os.tmpdir(),'lens-'));
const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${repo}`,`--load-extension=${repo}`,'--no-sandbox'],timeout:120000});
const fixtureURL='https://www.canlii.org/en/ca/scc/doc/2024/2024scc1/2024scc1.html';
const errors=[],network=[],checks=[];let modelFixture=null,lens;
context.on('page',p=>{p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')console.error('BROWSER',m.text());});});
context.on('request',r=>{if(/^https?:/.test(r.url())&&r.url()!==fixtureURL)network.push(r.url());});
await context.route(fixtureURL,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><head><title>Research sample, 2024 SCC 1 | CanLII</title><meta name="lbh-title" content="Research sample"><meta name="lbh-citation" content="2024 SCC 1"><meta name="lbh-type" content="CASE"></head><body><main id="originalDocument"><p><a id="par1" name="par1"></a>[1] A contracting party may terminate immediately, without prior notice, if the other party commits a fundamental breach.</p><p><a id="par2" name="par2"></a>[2] The orchid greenhouse is maintained at a constant temperature. Water the seedlings once a day.</p></main></body></html>'}));
async function check(name,fn){const start=performance.now();try{await fn();checks.push({name,passed:true,ms:performance.now()-start});console.log('PASS',name);}catch(e){checks.push({name,passed:false,ms:performance.now()-start,error:e.stack});console.error('FAIL',name,e.stack);}}
const finishSearch=()=>lens.waitForFunction(()=>!document.querySelector('#search').disabled,{},{timeout:120000});
try{
  await check('Full local case/law/Hansard index and bilingual retrieval',async()=>{
    let service=context.serviceWorkers()[0];if(!service)service=await context.waitForEvent('serviceworker',{timeout:30000});const extensionId=new URL(service.url()).host;
    lens=await context.newPage();await lens.goto(`chrome-extension://${extensionId}/lens-dist/lens.html`);
    await lens.waitForFunction(()=>window.PinpointerLens,{},{timeout:15000});
    await lens.locator('#use-tabs').uncheck();await lens.locator('#use-corpus').check();await lens.click('#files-button');
    await lens.locator('#parquets').setInputFiles(['cases.parquet','laws.parquet','hansard.parquet'].map(n=>path.join(root,'test/fixtures',n)));
    await lens.waitForFunction(()=>!document.querySelector('#add-parquet').disabled,{},{timeout:15000});
    const catalog=await lens.evaluate(()=>PinpointerLens.request('list'));assert.equal(catalog.length,3);
    const index=await lens.evaluate(()=>PinpointerLens.request('index'));assert.deepEqual(index.errors,[]);assert.equal(index.files.filter(f=>f.indexed).length,3);
    await lens.click('#catalog .close');await lens.fill('#query','indemni*');await lens.click('#search');await finishSearch();
    assert.equal(await lens.locator('.result').count(),2,'Both languages of row 230 must be found');
    await lens.fill('#query','receipt');await lens.click('#search');await finishSearch();
    assert.equal(await lens.locator('.result').count(),2,'Legislation and Hansard must both be searched');
  });
  await check('Real extension semantic tab search, native pinpoints, both connectors and stale-source protection',async()=>{
    const source=await context.newPage();
    try{
      await source.goto(fixtureURL);await source.waitForSelector('#par1',{state:'attached'});
      await lens.locator('#use-tabs').check();await lens.locator('#use-corpus').uncheck();
      await lens.fill('#query','When can someone end an agreement without first telling the other party?');await lens.click('#search');await finishSearch();
      assert.equal(await lens.locator('.result').count(),2,'Detected paragraphs, not lexical matches');
      assert.match(await lens.locator('.result').first().textContent(),/fundamental breach/);
      assert.equal(await lens.locator('#model-status,#distinction,#judge').count(),0);
      await lens.locator('.result').first().click();
      await lens.getByRole('button',{name:'Open passage',exact:true}).click();
      await source.waitForFunction(()=>CSS.highlights.has('pinpointer-lens'));
      await lens.getByRole('button',{name:'Copy pinpoint',exact:true}).click();
      await lens.waitForFunction(()=>document.querySelector('#status').textContent==='Copied.');
      await source.locator('#par1').evaluate(el=>el.parentElement.append(' Changed source.'));
      await lens.getByRole('button',{name:'Copy pinpoint',exact:true}).click();
      await lens.waitForFunction(()=>document.querySelector('#status').textContent.includes('source changed'));
      await lens.click('#passage .close');await lens.locator('#use-corpus').check();
      await lens.fill('#query','receipt');await lens.click('#search');await finishSearch();
      assert.equal(await lens.locator('.result').count(),4,'Two tab paragraphs plus two corpus passages');
      await lens.bringToFront();
      await lens.screenshot({path:path.join(root,'dist/lens-preview.png'),fullPage:true});
    }finally{await source.close();}
  });
  const event=await context.newPage();
  await check('Self-contained HTML starts from file://',async()=>{
    await event.goto('file://'+path.join(root,'dist/event-strip.html'),{timeout:180000,waitUntil:'domcontentloaded'});
    await event.waitForFunction(()=>window.EventStrip,{},{timeout:30000});
  });
  if(await event.evaluate(()=>Boolean(window.EventStrip))){
    await check('EML event date differs from communication date',async()=>{
      await event.locator('#ocr').uncheck();await event.locator('#files').setInputFiles(path.join(root,'test/fixtures/sample.eml'));
      await event.waitForFunction(()=>!document.querySelector('#add').disabled,{},{timeout:20000});
      const dates=await event.evaluate(()=>EventStrip.rows.map(r=>[r.date,r.communicated]));
      assert.deepEqual(dates,[['2026-03-10','2026-03-12'],['2026-03-13','2026-03-12']]);
    });
    await check('Native PDF and DOCX tracked-revision intake',async()=>{
      await event.locator('#files').setInputFiles(['sample.pdf','sample.docx'].map(n=>path.join(root,'test/fixtures',n)));
      await event.waitForFunction(()=>!document.querySelector('#add').disabled,{},{timeout:30000});
      const parsed=await event.evaluate(()=>EventStrip.sources.map(s=>({kind:s.kind,text:s.blocks.map(b=>b.text).join('\n'),warnings:s.warnings})));
      assert.match(parsed.find(s=>s.kind==='pdf')?.text||'',/10 March 2026/);assert.match(parsed.find(s=>s.kind==='docx')?.text||'',/13 March 2026/);assert.doesNotMatch(parsed.find(s=>s.kind==='docx')?.text||'',/15 March 2026/);
    });
    await check('Embedded OCR recognizes a scanned PDF offline',async()=>{
      await event.locator('#ocr').check();await event.locator('#files').setInputFiles(path.join(root,'test/fixtures/scan.pdf'));
      await event.waitForFunction(()=>!document.querySelector('#add').disabled,{},{timeout:120000});
      const scan=await event.evaluate(()=>EventStrip.sources.find(s=>s.name==='scan.pdf')?.blocks||[]);assert.ok(scan.some(b=>b.ocr&&/13 March 2026/.test(b.text)));
    });
    await check('Actual Laya inference distinguishes scheduled from completed',async()=>{
      modelFixture=await event.evaluate(async()=>EventStrip.decisions.decide('Delivery is scheduled for 13 March 2026.',{type:'choice',instructions:'What is the status of delivery?',criteria:{planned:'Scheduled for the future',completed:'Already occurred'}}));
      assert.equal(Object.keys(modelFixture.probabilities).length,2);assert.ok(Object.values(modelFixture.probabilities).every(Number.isFinite));assert.equal(modelFixture.choice,'planned');
    });
    await event.screenshot({path:path.join(root,'dist/event-strip-preview.png'),fullPage:true});
  }
  await check('No external runtime requests or uncaught page errors',()=>{assert.deepEqual(network,[]);assert.deepEqual(errors,[]);});
  const evidence={passed:checks.every(c=>c.passed),checks,modelFixture,pageErrors:errors,networkRequests:network,sourceFixture:'CanLII-shaped HTML fulfilled locally by Playwright; no live source request'};
  await writeFile(path.join(root,'dist/validation.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
  if(!evidence.passed)process.exitCode=1;
}finally{await context.close();}
