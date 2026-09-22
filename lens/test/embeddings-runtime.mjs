import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL,fileURLToPath}from'node:url';import assert from 'node:assert/strict';import{loadEmbeddings}from'../src/embeddings.mjs';
const base=pathToFileURL(path.resolve(import.meta.dirname,'../../lens-dist/assets/potion/')+'/');
globalThis.fetch=async url=>new Response(await fs.readFile(fileURLToPath(url)));
const model=await loadEmbeddings(base);const reference=JSON.parse(await fs.readFile(new URL('potion.reference.json',base),'utf8'));
const checks=reference.map(r=>{const got=model.encode(r.text);let dot=0;for(let j=0;j<got.length;j++)dot+=got[j]*r.vector[j];assert.ok(dot>.99999,`${r.text} ${dot}`);return {text:r.text,cosine:dot};});
console.log(JSON.stringify({passed:true,checks},null,2));
