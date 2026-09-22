import test from 'node:test';import assert from 'node:assert/strict';import JSZip from 'jszip';import {boundedZip} from '../src/zip.mjs';
test('session ZIP validation ignores an original DOCX end-of-directory inside a member',async()=>{
 const doc=new JSZip();doc.file('word/document.xml','<document>Original source</document>');
 const inner=await doc.generateAsync({type:'uint8array',compression:'STORE'});
 const session=new JSZip();session.file('session.json','{}');session.file('sources/original.docx',inner);
 const outer=await session.generateAsync({type:'arraybuffer',compression:'STORE'});
 assert.doesNotThrow(()=>boundedZip(outer));
 const restored=await JSZip.loadAsync(outer);assert.deepEqual(await restored.file('sources/original.docx').async('uint8array'),inner);
 const damaged=outer.slice(0);new DataView(damaged).setUint32(damaged.byteLength-6,0xffffffff,true);
 assert.throws(()=>boundedZip(damaged),/ZIP64/);
});
