import {build} from 'esbuild';
import {readFile,writeFile,mkdir,copyFile,readdir,stat,rm} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
import JSZip from 'jszip';
const root=import.meta.dirname,repo=path.resolve(root,'..'),out=path.join(repo,'lens-dist'),assets=path.join(out,'assets'),dist=path.join(root,'dist');
await mkdir(assets,{recursive:true});await mkdir(dist,{recursive:true});
const manifest=[];
async function digest(file){const h=createHash('sha256');for await(const c of createReadStream(file))h.update(c);return h.digest('hex');}
async function download(url,file){
  let error;for(let i=0;i<4;i++){try{const response=await fetch(url,{signal:AbortSignal.timeout(600000)});if(!response.ok)throw new Error(`${response.status} ${url}`);await pipeline(Readable.fromWeb(response.body),createWriteStream(file+'.tmp'));await rm(file,{force:true});await (await import('node:fs/promises')).rename(file+'.tmp',file);manifest.push({file:path.basename(file),url,sha256:await digest(file),bytes:(await stat(file)).size});return;}catch(e){error=e;await new Promise(r=>setTimeout(r,1000*(i+1)));}}throw error;
}
const hfRepo='soyelmismo/laya-multilingual-onnx';
const metadata=await(await fetch(`https://huggingface.co/api/models/${hfRepo}`)).json();if(!metadata.sha)throw new Error('Cannot resolve the published Laya snapshot.');
const revision=process.env.LAYA_REVISION||metadata.sha;const base=`https://huggingface.co/${hfRepo}/resolve/${revision}`;
await download(`${base}/model.onnx`,path.join(assets,'model.onnx'));
for(const [file,candidates]of [['tokenizer.json',['tokenizer.json','tokenizer/tokenizer.json']],['tokenizer_config.json',['tokenizer/tokenizer_config.json','tokenizer_config.json']],['rl_agent_config.json',['rl_agent_config.json']]]){
  let success=false,error;for(const candidate of candidates){try{await download(`${base}/${candidate}`,path.join(assets,file));success=true;break;}catch(e){error=e;}}if(!success)throw error;
}
const config=JSON.parse(await readFile(path.join(assets,'rl_agent_config.json'),'utf8'));if(!config.max_len||!config.head_max_len)throw new Error('Laya config is missing its input budgets.');
async function copy(from,name){await copyFile(path.join(root,'node_modules',from),path.join(assets,name));}
for(const n of ['ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm'])await copy('onnxruntime-web/dist/'+n,n);
for(const n of ['duckdb-browser-eh.worker.js','duckdb-eh.wasm'])await copy('@duckdb/duckdb-wasm/dist/'+n,n);
await copy('pdfjs-dist/build/pdf.worker.min.mjs','pdf.worker.min.mjs');
const engine='tesseract-core-simd-lstm';
const coreWasm=await readFile(path.join(root,`node_modules/tesseract.js-core/${engine}.wasm`));
let coreJS=await readFile(path.join(root,`node_modules/tesseract.js-core/${engine}.wasm.js`),'utf8');
const dataURI='data:application/octet-stream;base64,'+coreWasm.toString('base64');
coreJS=coreJS.replaceAll(`"${engine}.wasm"`,JSON.stringify(dataURI)).replaceAll(`'${engine}.wasm'`,JSON.stringify(dataURI));
if(!coreJS.includes(dataURI))throw new Error('OCR core no longer contains the expected WASM reference.');
await writeFile(path.join(assets,`${engine}.wasm.js`),coreJS);
await download('https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/eng.traineddata',path.join(assets,'eng.traineddata'));
const language=gzipSync(await readFile(path.join(assets,'eng.traineddata'))).toString('base64');
const workerPrefix=`const nativeFetch=self.fetch.bind(self);self.fetch=(url,options)=>{if(String(url).includes('eng.traineddata'))return Promise.resolve(new Response(Uint8Array.from(atob(${JSON.stringify(language)}),c=>c.charCodeAt(0))));if(!/^(blob:|data:)/.test(String(url))&&!String(url).startsWith(self.location.origin+'/'))return Promise.reject(new Error('Offline OCR blocked an external request'));return nativeFetch(url,options);};\n`;
await writeFile(path.join(assets,'tesseract-worker.js'),workerPrefix+await readFile(path.join(root,'node_modules/tesseract.js/dist/worker.min.js'),'utf8'));await rm(path.join(assets,'eng.traineddata'));
const common={bundle:true,minify:true,legalComments:'inline',target:'chrome116',platform:'browser'};
for(const name of ['decision-worker','corpus-worker'])await build({...common,entryPoints:[path.join(root,`src/${name}.mjs`)],format:'iife',outfile:path.join(assets,name+'.js')});
await build({...common,entryPoints:[path.join(root,'src/lens.mjs')],format:'esm',outfile:path.join(out,'lens.mjs')});
const event=await build({...common,entryPoints:[path.join(root,'src/event-strip.mjs')],format:'esm',write:false});
for(const name of ['lens.html','ui.css','page.js'])await copyFile(path.join(root,'src',name),path.join(out,name));
const sourcePackage=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
let notices='PINPOINTER LENS / EVENT STRIP\nApplication code: MIT.\nLaya weights: Convai Innovations, Apache-2.0.\nLaya ONNX INT8 conversion: soyelmismo/laya-multilingual-onnx (Apache-2.0).\nPrompt sequence implementation follows upstream Laya and receptron/laya (MIT).\nModels make reviewable predictions, not findings of fact.\n\n';
for(const dependency of Object.keys(sourcePackage.dependencies)){
  const dir=path.join(root,'node_modules',dependency),pkg=JSON.parse(await readFile(path.join(dir,'package.json'),'utf8'));notices+=`\n${dependency} ${pkg.version} — ${pkg.license||'see package'}\n`;
  for(const name of ['LICENSE','LICENSE.txt','LICENSE.md','LICENSE-MIT','COPYING']){try{notices+=await readFile(path.join(dir,name),'utf8')+'\n';break;}catch{}}
}
try{notices+='\n'+await readFile('/usr/share/common-licenses/Apache-2.0','utf8');}catch{notices+='\nApache-2.0: https://www.apache.org/licenses/LICENSE-2.0\n';}
await writeFile(path.join(assets,'NOTICES.txt'),notices);
const info={application:'Pinpointer Lens + Event Strip',version:'0.1.0',gitCommit:process.env.GITHUB_SHA||'local',built:new Date().toISOString(),model:{repository:hfRepo,revision,max_len:config.max_len,head_max_len:config.head_max_len},assets:manifest,dependencies:sourcePackage.dependencies};
await writeFile(path.join(assets,'build-info.json'),JSON.stringify(info,null,2));
const template=await readFile(path.join(root,'src/event-strip.html'),'utf8'),css=await readFile(path.join(root,'src/ui.css'),'utf8'),script=event.outputFiles[0].text.replaceAll('</script','<\\/script');
const prepared=template.replace('/* INLINE_CSS */',css).replace('/* INLINE_APP */',script),[before,after]=prepared.split('<!-- PACKAGED_ASSETS -->');
const htmlFile=path.join(dist,'event-strip.html'),stream=createWriteStream(htmlFile);async function emit(text){if(!stream.write(text))await new Promise(resolve=>stream.once('drain',resolve));}
await emit(before);
// Base64 is chunked and decoded lazily in the browser; no giant model string is parsed as JavaScript.
const eventAssets=(await readdir(assets)).filter(n=>!n.startsWith('duckdb')&&n!=='corpus-worker.js');
for(const name of eventAssets){let part=0;for await(const chunk of createReadStream(path.join(assets,name),{highWaterMark:3*256*1024}))await emit(`<script type="application/octet-stream" data-asset="${name}" data-part="${part++}">${chunk.toString('base64')}</script>\n`);}
await emit(after);await new Promise(resolve=>stream.end(resolve));
// Distribute an unpackable extension, not remote runtime URLs or Git LFS pointer files.
const zip=new JSZip();async function addDirectory(directory,prefix){for(const entry of await readdir(directory,{withFileTypes:true})){if(['.git','node_modules','lens'].includes(entry.name))continue;const full=path.join(directory,entry.name),name=prefix+entry.name;if(entry.isDirectory())await addDirectory(full,name+'/');else zip.file(name,createReadStream(full));}}
await addDirectory(repo,'');await pipeline(zip.generateNodeStream({type:'nodebuffer',streamFiles:true,compression:'DEFLATE',compressionOptions:{level:1}}),createWriteStream(path.join(dist,'legal-pinpointer-lens.zip')));
const sums=[];for(const name of ['event-strip.html','legal-pinpointer-lens.zip'])sums.push(`${await digest(path.join(dist,name))}  ${name}`);await writeFile(path.join(dist,'SHA256SUMS.txt'),sums.join('\n')+'\n');await writeFile(path.join(dist,'build-info.json'),JSON.stringify(info,null,2));console.log(sums.join('\n'));
