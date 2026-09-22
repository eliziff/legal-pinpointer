import test from 'node:test';import assert from 'node:assert/strict';
import {sameEvent,collateEvents,ungroup,createCatalogue,validateCatalogue} from '../src/chronology.mjs';
test('explicit identifiers constrain even an erroneous same-event judgment',async()=>{
 let calls=0;const decisions={decide:async()=>{calls++;return {noul:1};}};
 for(const [a,b]of [['Inspector 0 visited the warehouse on 8 April 2026.','Inspector 8 visited the warehouse on 8 April 2026.'],['Invoice 17 was paid on 3 May 2026.','Invoice 93 was paid on 3 May 2026.']])assert.equal(await sameEvent({text:a,date:'2026-04-08'},{text:b,date:'2026-04-08'},decisions),false);
 assert.equal(calls,0);
});
test('ungroup retains every source and gives a saved edit only to its owning entry',async()=>{
 const text='Construction commenced on 3 May 2026.',sources=['a','b'].map(id=>({id,blocks:[{id:'p',text}]}));
 const cat=createCatalogue();cat.mentions=sources.map(s=>({id:s.id,sourceId:s.id,blockId:'p',start:0,end:text.length,quote:text,text,date:'2026-05-03',dateEnd:''}));
 const decisions={decide:async()=>{throw Error('Exact copies do not need a model');}};
 await collateEvents(cat,decisions);assert.equal(cat.events.length,1);const e=cat.events[0];Object.assign(e,{edited:true,text:'Saved description',note:'Saved note'});
 ungroup(cat,e);await collateEvents(cat,decisions);assert.equal(cat.events.length,2);assert.equal(new Set(cat.events.map(e=>e.id)).size,2);assert.equal(cat.events.filter(e=>e.text==='Saved description').length,1);assert.equal(cat.events[0].note,'Saved note');validateCatalogue(cat,sources);
 await collateEvents(cat,decisions);assert.equal(cat.events.length,2);
 cat.mentions[0].quote='Changed quotation';assert.throws(()=>validateCatalogue(cat,sources),/original source/);
});
