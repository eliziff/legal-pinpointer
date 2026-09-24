import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(path.resolve('.build/package.json'));
const {build}=require('esbuild');
const root=path.resolve('.build/node_modules'), out=path.resolve('vendor');
await fs.mkdir(out,{recursive:true});
const put=async(n,b)=>{await fs.mkdir(path.dirname(path.join(out,n)),{recursive:true});await fs.writeFile(path.join(out,n),b);};
const copy=async(n,p)=>put(n,await fs.readFile(path.join(root,p)));
async function bundle(name,source){await build({stdin:{contents:source,resolveDir:path.resolve('.build'),sourcefile:name},outfile:path.join(out,name),bundle:true,format:'esm',platform:'browser',target:'chrome120',minify:true,legalComments:'eof'});}
await bundle('duckdb.mjs','export * from "@duckdb/duckdb-wasm";');
await bundle('tokenizer.mjs','export {PreTrainedTokenizer} from "@huggingface/transformers";');
await bundle('postal-mime.mjs','export {default} from "postal-mime";');
for(const [n,p] of Object.entries({
 'duckdb.worker.js':'@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js',
 'duckdb.wasm':'@duckdb/duckdb-wasm/dist/duckdb-eh.wasm',
 'pdf.mjs':'pdfjs-dist/build/pdf.mjs',
 'pdf.worker.mjs':'pdfjs-dist/build/pdf.worker.mjs',
 'ort.mjs':'onnxruntime-web/dist/ort.min.mjs',
 'ort-wasm-simd-threaded.mjs':'onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
 'ort-wasm-simd-threaded.wasm':'onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
 'jszip.min.js':'jszip/dist/jszip.min.js',
 'tesseract.raw.js':'tesseract.js/dist/tesseract.min.js',
 'tesseract.raw.worker.js':'tesseract.js/dist/worker.min.js',
 'tesseract.raw.core.js':'tesseract.js-core/tesseract-core-lstm.wasm.js',
 'tesseract.raw.core.wasm':'tesseract.js-core/tesseract-core-lstm.wasm'
}))await copy(n,p);
for(const lang of ['eng','fra']){
 const prefix=path.join(root,'@tesseract.js-data',lang);
 const candidates=['4.0.0_best_int','4.0.0'];let found=false;
 for(const d of candidates)try{await put(lang+'.traineddata.gz',await fs.readFile(path.join(prefix,d,lang+'.traineddata.gz')));found=true;break;}catch{}
 if(!found)throw Error('Missing OCR language '+lang);
}
const languages={};for(const lang of ['eng','fra'])languages[lang]=(await fs.readFile(path.join(out,lang+'.traineddata.gz'))).toString('base64');
const prelude='const localLanguages='+JSON.stringify(languages)+';self.addEventListener("message",e=>{const m=e.data;if(m?.action==="loadLanguage"){const ls=typeof m.payload.langs==="string"?m.payload.langs.split("+"):m.payload.langs;m.payload.langs=ls.map(l=>{const code=typeof l==="string"?l:l.code;const raw=atob(localLanguages[code]||"");return {code,data:Uint8Array.from(raw,c=>c.charCodeAt(0))};});}});\n';
await put('ocr.mjs',(await fs.readFile(path.join(out,'tesseract.raw.js'),'utf8'))+'\nexport const createWorker=globalThis.Tesseract.createWorker;\n');
await put('tesseract.worker.js',prelude+(await fs.readFile(path.join(out,'tesseract.raw.worker.js'),'utf8')));
await put('tesseract-core.wasm.js',(await fs.readFile(path.join(out,'tesseract.raw.core.js'),'utf8'))+'\n{const original=self.TesseractCore;const payload='+JSON.stringify((await fs.readFile(path.join(out,'tesseract.raw.core.wasm'))).toString('base64'))+';self.TesseractCore=options=>original({...options,wasmBinary:Uint8Array.from(atob(payload),c=>c.charCodeAt(0))});}\n');
for(const n of ['tesseract.raw.js','tesseract.raw.worker.js','tesseract.raw.core.js','tesseract.raw.core.wasm'])await fs.unlink(path.join(out,n));
const revision='a7f385bd51d35f5cbeb88e8bc4f0c7e7c0f24c44';
for(const name of ['tokenizer.json','tokenizer_config.json','README.md','int8/laya_int8.onnx']){
 const url=`https://huggingface.co/Mattepiu/laya-onnx/resolve/${revision}/${name}`;
 let error;for(let attempt=0;attempt<4;attempt++)try{const r=await fetch(url,{signal:AbortSignal.timeout(180000)});if(!r.ok)throw Error(r.status+' '+url);const bytes=Buffer.from(await r.arrayBuffer());if(name.endsWith('.onnx')){const hash=createHash('sha256').update(bytes).digest('hex');if(hash!=='50dd3f0a1585fd8bf931faf457921754183603ac0976cc5cce197cb55627233a')throw Error('Model SHA256 mismatch '+hash);}await put(path.basename(name)==='README.md'?'notices/LAYA-MODEL.md':path.basename(name),bytes);console.log(name,bytes.length);error=null;break;}catch(e){error=e;await new Promise(r=>setTimeout(r,1000*(attempt+1)));}if(error)throw error;
}
for(const pkg of ['@duckdb/duckdb-wasm','onnxruntime-web','pdfjs-dist','@huggingface/transformers','tesseract.js','tesseract.js-core','@tesseract.js-data/eng','@tesseract.js-data/fra','postal-mime','jszip']){
 for(const name of await fs.readdir(path.join(root,pkg)))if(/^(LICENSE|NOTICE)/i.test(name)){const file=path.join(root,pkg,name);if((await fs.stat(file)).isFile())await put('notices/'+pkg.replaceAll('/','_')+'_'+name,await fs.readFile(file));}
}
const records=[];for(const n of await fs.readdir(out)){const p=path.join(out,n);if((await fs.stat(p)).isFile()){const b=await fs.readFile(p);records.push({name:n,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});}}
await put('assets-lock.json',JSON.stringify({model:'Mattepiu/laya-onnx',revision,assets:records},null,2)+'\n');console.log('Assets complete');
