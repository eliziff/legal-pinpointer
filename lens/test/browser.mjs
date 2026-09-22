import {chromium} from 'playwright';import {mkdtemp,writeFile,readFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),repo=path.resolve(root,'..');
const context=await chromium.launchPersistentContext(await mkdtemp(path.join(os.tmpdir(),'lens-')),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${repo}`,`--load-extension=${repo}`,'--no-sandbox'],timeout:120000});
const sourceURL='https://www.canlii.org/en/ca/scc/doc/2024/2024scc1/2024scc1.html';
const genericURL='https://research.example.test/commentary';
const errors=[],network=[],checks=[];let lens,source,modelFixture;
context.on('page',p=>{p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')console.error('PAGE',m.text());});});
context.on('request',r=>{if(/^https?:/.test(r.url())&&![sourceURL,genericURL].includes(r.url()))network.push(r.url());});
await context.route('https://**/*',route=>{
 const url=route.request().url();
 if(url===sourceURL)return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="en"><head><title>Research sample, 2024 SCC 1 | CanLII</title><meta name="lbh-title" content="Research sample"><meta name="lbh-citation" content="2024 SCC 1"><meta name="lbh-type" content="CASE"></head><body><main id="originalDocument"><p><a id="par1" name="par1"></a>[1] The parties met in June. A contracting party may <strong>terminate immediately</strong>, without prior notice, if the other party commits a fundamental breach.</p><p><a id="par2" name="par2"></a>[2] The orchid greenhouse is maintained at a constant temperature. Water the seedlings once a day.</p></main></body></html>`});
 if(url===genericURL)return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Commentary</title><article><p>The author criticizes the proposed exception to the notice requirement.</p></article>'});
 return route.abort();
});
async function check(name,fn){const start=performance.now();try{await fn();checks.push({name,passed:true,ms:performance.now()-start});console.log('PASS',name);}catch(e){checks.push({name,passed:false,ms:performance.now()-start,error:e.stack});console.error('FAIL',name,e.stack);}}
async function search(query){await lens.fill('#query',query);await lens.click('#search');await lens.waitForFunction(()=>!PinpointerLens.busy,{},{timeout:240000});const state=await lens.evaluate(()=>({items:PinpointerLens.items,status:document.querySelector('#status').textContent}));assert.doesNotMatch(state.status,/could not|Some sources/);return state.items;}
const fixture=n=>path.join(root,'test/fixtures',n);
try{
 const sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:30000}),id=new URL(sw.url()).host;
 lens=await context.newPage();await lens.goto(`chrome-extension://${id}/lens-dist/lens.html`);await lens.waitForFunction(()=>window.PinpointerLens);
 await check('Independent A2AJ connector: all three dataset schemas, exact search and late bilingual row',async()=>{
  await lens.locator('#use-tabs').uncheck();await lens.locator('#use-corpus').check();await lens.click('#files-button');
  await lens.locator('#parquets').setInputFiles(['cases.parquet','laws.parquet','hansard.parquet'].map(fixture));
  await lens.waitForFunction(()=>!document.getElementById('add-parquet').disabled,{},{timeout:90000});
  const catalog=await lens.evaluate(()=>PinpointerLens.a2aj.list());assert.equal(catalog.length,3);assert.equal(catalog.reduce((n,f)=>n+f.count,0),233);
  const indexed=await lens.evaluate(()=>PinpointerLens.a2aj.request('index'));assert.deepEqual(indexed.errors,[]);assert.equal(indexed.files.filter(f=>f.indexed).length,3);
  await lens.click('#catalog .close');await lens.click('#options-button');await lens.locator('#exact').check();await lens.click('#options .close');
  const results=await search('indemni*');assert.equal(results.length,2);assert.deepEqual(results.map(x=>x.language).sort(),['en','fr']);assert.ok(results.every(x=>x.rowId===230));
 });
 await check('Actual multilingual vectors retrieve without a required keyword match and persist complete checkpoints',async()=>{
  const result=await lens.evaluate(()=>PinpointerLens.a2aj.search({query:'At which point does a notification become legally operative?',filters:{language:'both'},limit:8}));
  assert.deepEqual(result.errors,[]);assert.ok(result.items.some(x=>/takes effect/.test(x.text)));assert.equal(result.filesDone,3);assert.equal(result.examined,465);
  const files=await lens.evaluate(()=>PinpointerLens.a2aj.list());assert.ok(files.every(f=>f.semanticComplete&&f.semanticProcessed===f.count));
  const again=await lens.evaluate(()=>PinpointerLens.a2aj.search({query:'At which point does a notification become legally operative?',filters:{language:'both'},limit:8}));
  assert.deepEqual(result.items.map(x=>x.id),again.items.map(x=>x.id));
  const more=await lens.evaluate(exclude=>PinpointerLens.a2aj.search({query:'At which point does a notification become legally operative?',filters:{language:'both'},limit:8,exclude}),result.items.map(x=>x.id));
  assert.ok(more.items.every(x=>!result.items.some(y=>x.id===y.id)));
 });
 await check('Natural-language tab search uses actual detected paragraphs and Laya relevance',async()=>{
  source=await context.newPage();await source.goto(sourceURL);await source.waitForSelector('#par1',{state:'attached'});
  await lens.locator('#use-tabs').check();await lens.locator('#use-corpus').uncheck();await lens.click('#options-button');await lens.locator('#exact').uncheck();await lens.click('#options .close');
  const results=await search('When can someone end an agreement without first telling the other party?');
  assert.equal(results.length,2);assert.ok(results.every(r=>r.native&&r.kind==='paragraph'));assert.equal(results[0].locator,'1');assert.match(results[0].text,/fundamental breach/);assert.ok(results.every(r=>Number.isFinite(r.score)));
  assert.equal(await lens.locator('#model-status,#distinction,#judge').count(),0);
  assert.doesNotMatch(await lens.locator('body').innerText(),/not semantically|no model judgment|Exact retrieval|fit \d/);
 });
 await check('Native rich quotation, source citation, pinpoint options, sentence offsets and exact navigation',async()=>{
  const payload=await lens.evaluate(async()=>{const r=PinpointerLens.items[0],t=PinpointerLens.tabs;return {pin:await t.copy(r,'pinpoint',{extent:'whole',link:'native'}),quote:await t.copy(r,'quote',{extent:'whole',link:'native'}),source:await t.copy(r,'source',{extent:'whole',link:'native'}),bare:await t.copy(r,'pinpoint',{extent:'whole',link:'native',wording:'bare'})};});
  assert.match(payload.pin.plain,/at para 1/);assert.match(payload.pin.html,/#par1/);assert.match(payload.quote.html,/<strong>terminate immediately<\/strong>/);assert.match(payload.source.plain,/Research sample/);assert.equal(payload.bare.plain,'1');
  const sentence=await lens.evaluate(async()=>{const r=PinpointerLens.items[0],start=r.text.indexOf('A contracting');return PinpointerLens.tabs.copy({...r,focus:{start,end:r.text.length}},'source',{extent:'match',link:'text'});});
  assert.match(sentence.html,/#:~:text=/);assert.doesNotMatch(sentence.plain,/parties met/);assert.match(sentence.plain,/fundamental breach/);
  await lens.locator('.result').first().click();await lens.getByRole('button',{name:'Open passage ↗',exact:true}).click();await source.waitForFunction(()=>CSS.highlights.has('pinpointer-lens'));
  await lens.bringToFront();await lens.getByRole('button',{name:'Copy',exact:true}).click();await lens.waitForFunction(()=>document.querySelector('#status').textContent==='Copied.');
  await lens.screenshot({path:path.join(root,'dist/lens-preview.png'),fullPage:true});
 });
 await check('Both connectors together, generic commentary fallback, and stale-source rejection',async()=>{
  await lens.locator('#use-corpus').check();const combined=await search('What triggers the effectiveness of a notice?');assert.ok(combined.some(r=>r.connector==='tabs'));assert.ok(combined.some(r=>r.connector==='a2aj'));
  await source.locator('#par1').evaluate(el=>el.parentElement.append(' Changed source.'));
  const rejected=await lens.evaluate(async()=>{try{await PinpointerLens.tabs.copy(PinpointerLens.items.find(r=>r.connector==='tabs'),'pinpoint',{});return false;}catch{return true;}});assert.equal(rejected,true);
  const commentary=await context.newPage();await commentary.goto(genericURL);await lens.locator('#use-corpus').uncheck();await search('Criticism of an exception to notice.');
  const copy=await lens.evaluate(async()=>{const r=PinpointerLens.items.find(x=>x.url.includes('research.example.test'));if(!r)throw Error('Commentary is missing');return PinpointerLens.tabs.copy(r,'quote',{extent:'whole',link:'text'});});
  assert.match(copy.plain,/^\[Link\]:/);assert.match(copy.html,/#:~:text=/);await commentary.close();
 });
 await check('Cancellation stops a request and permits a subsequent genuine inference',async()=>{
  const value=await lens.evaluate(async()=>{const c=new AbortController(),p=PinpointerLens.decisions.rank('A long passage. '.repeat(900),'What changed?','',c.signal);c.abort();let stopped=false;try{await p;}catch(e){stopped=e.name==='AbortError';}const r=await PinpointerLens.decisions.rank('The agreement ends on delivery.','What causes the agreement to end?','');return {stopped,score:r.noul};});assert.equal(value.stopped,true);assert.ok(Number.isFinite(value.score));
 });
 if(source)await source.close();await lens.close();
 const event=await context.newPage();
 await check('Self-contained file:// HTML imports EML and automatically executes chronology classification',async()=>{
  await event.goto(pathToFileURL(path.join(root,'dist/event-strip.html')).href,{timeout:180000,waitUntil:'domcontentloaded'});await event.waitForFunction(()=>window.EventStrip,{},{timeout:90000});
  await event.locator('details.options summary').click();await event.locator('#ocr').uncheck();await event.locator('#files').setInputFiles(fixture('sample.eml'));
  await event.waitForFunction(()=>EventStrip.sources.length===1&&!EventStrip.busy,{},{timeout:240000});
  const r=await event.evaluate(()=>EventStrip.rows.map(r=>({date:r.date,communicated:r.communicated,status:r.status,error:r.error})));
  assert.deepEqual(r.map(x=>[x.date,x.communicated]),[['2026-03-10','2026-03-12'],['2026-03-13','2026-03-12']]);assert.deepEqual(r.map(x=>x.status),['completed','planned']);assert.ok(r.every(x=>!x.error));
 });
 await check('Native PDF, DOCX revision view and offline scanned-PDF OCR with automatic model execution',async()=>{
  await event.locator('#files').setInputFiles(['sample.pdf','sample.docx'].map(fixture));await event.waitForFunction(()=>EventStrip.sources.length===3&&!EventStrip.busy,{},{timeout:240000});
  const parsed=await event.evaluate(()=>EventStrip.sources.map(s=>({kind:s.kind,text:s.blocks.map(b=>b.text).join('\n')})));
  assert.match(parsed.find(s=>s.kind==='pdf').text,/10 March 2026/);assert.match(parsed.find(s=>s.kind==='docx').text,/13 March 2026/);assert.doesNotMatch(parsed.find(s=>s.kind==='docx').text,/15 March 2026/);
  await event.locator('#ocr').check();await event.locator('#files').setInputFiles(fixture('scan.pdf'));await event.waitForFunction(()=>EventStrip.sources.length===4&&!EventStrip.busy,{},{timeout:240000});
  const scan=await event.evaluate(()=>EventStrip.sources.find(s=>s.name==='scan.pdf').blocks);assert.ok(scan.some(b=>b.ocr&&/13 March 2026/.test(b.text)));
  assert.ok(await event.evaluate(()=>EventStrip.rows.every(r=>r.status!=='unreviewed'&&!r.error)));
 });
 await check('Session save/restore keeps source files and human corrections; CSV export stays usable',async()=>{
  await event.locator('#rows tr').first().click();await event.fill('#edit-note','Reviewed against original correspondence.');await event.click('#apply-edit');
  const before=await event.evaluate(()=>({rows:EventStrip.rows.length,sources:EventStrip.sources.length}));
  const savedPromise=event.waitForEvent('download');await event.click('#save');const saved=await savedPromise;const session=path.join(root,'dist/test-session.zip');await saved.saveAs(session);
  await event.locator('#session').setInputFiles(session);await event.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Session restored'),{},{timeout:120000});
  const after=await event.evaluate(()=>({rows:EventStrip.rows.length,sources:EventStrip.sources.length,note:EventStrip.rows.find(r=>r.reviewed)?.note}));assert.equal(after.rows,before.rows);assert.equal(after.sources,before.sources);assert.match(after.note,/Reviewed against/);
  const downloadPromise=event.waitForEvent('download');await event.click('#export');const download=await downloadPromise;const csv=path.join(root,'dist/test-export.csv');await download.saveAs(csv);assert.match(await readFile(csv,'utf8'),/2026-03-10/);
  await event.screenshot({path:path.join(root,'dist/event-strip-preview.png'),fullPage:true});
 });
 await check('Actual Laya probabilities in standalone HTML and zero external runtime requests',async()=>{
  modelFixture=await event.evaluate(()=>EventStrip.decisions.decide('Delivery is scheduled for 13 March 2026.',{type:'choice',instructions:'What is the status of delivery?',criteria:{planned:'Scheduled for the future',completed:'Already occurred'}}));assert.equal(modelFixture.choice,'planned');assert.ok(Object.values(modelFixture.probabilities).every(Number.isFinite));assert.deepEqual(network,[]);assert.deepEqual(errors,[]);
 });
 const evidence={passed:checks.every(c=>c.passed),checks,modelFixture,pageErrors:errors,networkRequests:network,fixture:'Synthetic source pages and tiny multi-format files; no live judicial-content assertion. All three complete downloaded A2AJ snapshots were separately byte-verified.'};
 await writeFile(path.join(root,'dist/validation.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));if(!evidence.passed)process.exitCode=1;
}finally{await context.close();}
