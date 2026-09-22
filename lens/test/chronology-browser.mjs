import {chromium} from 'playwright';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),network=[],errors=[],checks=[];
const context=await chromium.launchPersistentContext(await mkdtemp(path.join(os.tmpdir(),'event-strip-')),{headless:true,args:['--no-sandbox'],acceptDownloads:true,viewport:{width:1380,height:960}});
await context.route(/^https?:\/\//,r=>{network.push(r.request().url());return r.abort();});
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
const check=async(name,fn)=>{const start=performance.now();try{await fn();checks.push({name,passed:true,ms:performance.now()-start});console.log('PASS',name);}catch(e){checks.push({name,passed:false,error:e.stack});console.error('FAIL',name,e.stack);}};
const ready=()=>page.waitForFunction(()=>!EventStrip.busy,{},{timeout:300000});
try{
 await check('A real file:// product starts with no model-status UI or event taxonomy',async()=>{
  await page.goto(pathToFileURL(path.join(root,'dist/event-strip.html')).href,{waitUntil:'domcontentloaded',timeout:180000});await page.waitForFunction(()=>window.EventStrip,{},{timeout:120000});
  assert.deepEqual(await page.locator('thead th').allTextContents(),['Date','Event','Sources']);
  assert.equal(await page.locator('#edit-status').count(),0);assert.equal(await page.locator('#filter option').filter({hasText:'Proposed'}).count(),0);
 });
 await check('Add documents, then make a general chronology without requiring a focus',async()=>{
  await page.locator('#files').setInputFiles(['sample.eml','sample.pdf','sample.docx'].map(n=>path.join(root,'test/fixtures',n)));await ready();
  assert.equal(await page.evaluate(()=>EventStrip.sources.length),3);assert.equal(await page.evaluate(()=>EventStrip.rows.length),0);
  await page.click('#build');await ready();const state=await page.evaluate(()=>({rows:EventStrip.rows,mentions:EventStrip.catalogue.mentions,status:document.querySelector('#status').textContent}));
  assert.ok(state.rows.length>=2,JSON.stringify(state));assert.ok(state.mentions.every(m=>m.quote&&m.sourceId&&m.blockId));
  assert.ok(state.mentions.some(m=>m.date==='2026-03-10'));assert.ok(state.mentions.some(m=>m.date==='2026-03-13'));
  assert.ok(!state.rows.some(r=>'status' in r));
 });
 await check('Undated events, separate milestones and repeated mentions flow through the actual HTML',async()=>{
  await page.evaluate(()=>EventStrip.addFiles([new File(['Construction commenced on 3 May 2026 and was substantially complete by 18 September 2026.\n\nThe pump failed.'],'project.txt'),new File(['Work on the building began on 3 May 2026.'],'progress.txt')]));
  await page.click('#build');await ready();const events=await page.evaluate(()=>EventStrip.rows);
  assert.ok(events.some(e=>e.date==='2026-05-03'&&e.mentionIds.length>=2));assert.ok(events.some(e=>e.date==='2026-09-18'));
  assert.ok(events.some(e=>/pump failed/.test(e.text)&&!e.date));
 });
 await check('Event edits retain exact supporting text and survive a rebuild',async()=>{
  const id=await page.evaluate(()=>EventStrip.rows.find(e=>e.date==='2026-05-03').id);await page.evaluate(id=>EventStrip.inspect(id),id);
  await page.fill('#edit-event','Construction started.');await page.fill('#edit-note','Checked against the progress report.');await page.click('#apply-edit');
  assert.match(await page.locator('#source-preview').innerText(),/Construction commenced|building began/);
  await page.click('#build');await ready();assert.equal(await page.evaluate(id=>EventStrip.rows.find(e=>e.id===id)?.text,id),'Construction started.');
 });
 await check('Focus is optional and changes the view without rediscovering source events',async()=>{
  const scanned=await page.evaluate(()=>EventStrip.catalogue.scanned.length);await page.fill('#focus','Construction of the building');await page.click('#build');await ready();
  assert.equal(await page.locator('#filter').inputValue(),'focus');assert.equal(await page.evaluate(()=>EventStrip.catalogue.scanned.length),scanned);
  await page.selectOption('#filter','all');assert.ok(await page.evaluate(()=>EventStrip.visible().some(e=>/pump failed/.test(e.text))));
  await page.fill('#focus','');await page.click('#build');await ready();
 });
 await check('Save and restore originals, grouped source mentions, edits and cached discovery',async()=>{
  const before=await page.evaluate(()=>({events:EventStrip.rows.length,mentions:EventStrip.catalogue.mentions.length,scanned:EventStrip.catalogue.scanned.length}));
  await page.locator('details.menu summary').click();const download=page.waitForEvent('download');await page.click('#save');const zip=await download;const file=path.join(root,'dist/chronology-session.zip');await zip.saveAs(file);await ready();
  await page.locator('#session').setInputFiles(file);await ready();assert.match(await page.locator('#status').innerText(),/restored/);
  const after=await page.evaluate(()=>({events:EventStrip.rows.length,mentions:EventStrip.catalogue.mentions.length,scanned:EventStrip.catalogue.scanned.length}));assert.deepEqual(after,before);
  assert.ok(await page.evaluate(()=>EventStrip.rows.some(e=>e.text==='Construction started.'&&e.note==='Checked against the progress report.')));
  const csvPromise=page.waitForEvent('download');await page.click('#export');const csv=await csvPromise;const csvPath=path.join(root,'dist/chronology-export.csv');await csv.saveAs(csvPath);assert.match(await readFile(csvPath,'utf8'),/Construction started/);
  await page.locator('details.menu summary').click();
 });
 await check('Grouped mentions can be separated without losing sources',async()=>{
  const id=await page.evaluate(()=>EventStrip.rows.find(e=>e.mentionIds.length>1).id);const count=await page.evaluate(()=>EventStrip.catalogue.mentions.length);
  await page.evaluate(id=>EventStrip.inspect(id),id);await page.click('#ungroup');await ready();
  const rows=await page.evaluate(()=>EventStrip.rows);assert.equal(new Set(rows.map(e=>e.id)).size,rows.length);assert.equal(rows.reduce((n,e)=>n+e.mentionIds.length,0),count);
 });
 await check('OCR is embedded and scanned-PDF events use the same discovery path',async()=>{
  await page.locator('#files').setInputFiles(path.join(root,'test/fixtures/scan.pdf'));await ready();await page.click('#build');await ready();
  assert.ok(await page.evaluate(()=>EventStrip.sources.some(s=>s.name==='scan.pdf'&&s.blocks.some(b=>b.ocr))));
  const scan=await page.evaluate(()=>{const s=EventStrip.sources.find(s=>s.name==='scan.pdf');return EventStrip.catalogue.mentions.filter(m=>m.sourceId===s.id);});assert.ok(scan.length>0);
 });
 await check('Cancellation retains completed work and a subsequent build completes',async()=>{
  await page.evaluate(()=>EventStrip.addFiles([new File([Array.from({length:24},(_,i)=>`Inspector ${i} visited the warehouse on 8 April 2026.`).join('\n\n')],'additional.txt')]));
  await page.click('#build');await page.waitForFunction(()=>EventStrip.busy);await page.click('#stop');await ready();
  const before=await page.evaluate(()=>EventStrip.catalogue.mentions.length);await page.click('#build');await ready();assert.ok(await page.evaluate(n=>EventStrip.catalogue.mentions.length>=n,before));
 });
 await check('No HTTP(S) requests or uncaught page errors',async()=>{assert.deepEqual(network,[]);assert.deepEqual(errors,[]);});
 await page.selectOption('#filter','all');await page.screenshot({path:path.join(root,'dist/chronology.png'),fullPage:true});
 const result={passed:checks.every(c=>c.passed),checks,network,errors};await writeFile(path.join(root,'dist/chronology-browser.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));assert.ok(result.passed,'Standalone chronology acceptance failed');
}finally{await context.close();}
