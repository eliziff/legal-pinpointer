import {readFile,writeFile,mkdir,copyFile,readdir,stat,rm} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {gzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {mirrorParquet} from './mirror-parquet.mjs';
const root=import.meta.dirname,repo=path.resolve(root,'..'),out=path.join(repo,'lens-dist'),assets=path.join(out,'assets'),dist=path.join(root,'dist');
await import('./preload-ocr.mjs');
await mkdir(assets,{recursive:true});await mkdir(dist,{recursive:true});
const manifest=[];
async function digest(file){const h=createHash('sha256');for await(const c of createReadStream(file))h.update(c);return h.digest('hex');}
async function download(url,file){
  let error;for(let i=0;i<4;i++){try{const response=await fetch(url,{signal:AbortSignal.timeout(600000)});if(!response.ok)throw new Error(`${response.status} ${url}`);await pipeline(Readable.fromWeb(response.body),createWriteStream(file+'.tmp'));await rm(file,{force:true});await (await import('node:fs/promises')).rename(file+'.tmp',file);manifest.push({file:path.relative(assets,file),url,sha256:await digest(file),bytes:(await stat(file)).size});return;}catch(e){error=e;await new Promise(r=>setTimeout(r,1000*(i+1)));}}throw error;
}
await mirrorParquet(assets,download);
const hfRepo='soyelmismo/laya-multilingual-onnx';
const revision='0966c4fa58da6878b39e7e14cb5e93313b82d828';const base=`https://huggingface.co/${hfRepo}/resolve/${revision}`;
await download(`${base}/model.onnx`,path.join(assets,'model.onnx'));
if(await digest(path.join(assets,'model.onnx'))!=='d389d2304822a59569387e257067360a84e016aed43b407f1cfde87dadb7e485')throw new Error('Laya model checksum mismatch.');
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
coreJS=coreJS.replaceAll(`"${engine}.wasm"`,()=>JSON.stringify(dataURI)).replaceAll(`'${engine}.wasm'`,()=>JSON.stringify(dataURI));
if(!coreJS.includes(dataURI))throw new Error('OCR core no longer contains the expected WASM reference.');
await writeFile(path.join(assets,`${engine}.wasm.js`),coreJS);
await download('https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/eng.traineddata',path.join(assets,'eng.traineddata'));
const language=gzipSync(await readFile(path.join(assets,'eng.traineddata'))).toString('base64');
const workerPrefix=`const nativeFetch=self.fetch.bind(self);self.fetch=(url,options)=>{if(String(url).includes('eng.traineddata'))return Promise.resolve(new Response(Uint8Array.from(atob(${JSON.stringify(language)}),c=>c.charCodeAt(0))));if(!/^(blob:|data:)/.test(String(url))&&!String(url).startsWith(self.location.origin+'/'))return Promise.reject(new Error('Offline OCR blocked an external request'));return nativeFetch(url,options);};\n`;
await writeFile(path.join(assets,'tesseract-worker.js'),workerPrefix+await readFile(path.join(root,'node_modules/tesseract.js/dist/worker.min.js'),'utf8'));await rm(path.join(assets,'eng.traineddata'));
const {spawnSync}=await import('node:child_process');
const prepared=spawnSync(process.env.PYTHON||'python3',[path.join(root,'prepare-embeddings.py'),path.join(assets,'potion')],{stdio:'inherit'});
if(prepared.status!==0)throw new Error('Embedding conversion failed.');
const sourcePackage=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
let notices='PINPOINTER LENS / EVENT STRIP\nApplication code: MIT.\nLaya weights: Convai Innovations, Apache-2.0.\nLaya ONNX INT8 conversion: soyelmismo/laya-multilingual-onnx (Apache-2.0).\nPrompt sequence implementation follows upstream Laya and receptron/laya (MIT).\nModel2Vec/potion-multilingual-128M: MinishLab (MIT).\nSearch pattern follows actual Jev applications: hev/reranker (Apache-2.0), uehaj/jev-semgrep, kylemclaren/jevsearch, hotchpotch/jev-reranker. The independent browser implementation does not call their hosted APIs.\nModels make reviewable predictions, not findings of fact.\n\n';
for(const dependency of Object.keys(sourcePackage.dependencies)){
  const dir=path.join(root,'node_modules',dependency),pkg=JSON.parse(await readFile(path.join(dir,'package.json'),'utf8'));notices+=`\n${dependency} ${pkg.version} — ${pkg.license||'see package'}\n`;
  for(const name of ['LICENSE','LICENSE.txt','LICENSE.md','LICENSE-MIT','COPYING']){try{notices+=await readFile(path.join(dir,name),'utf8')+'\n';break;}catch{}}
}
try{notices+='\n'+await readFile('/usr/share/common-licenses/Apache-2.0','utf8');}catch{notices+='\nApache-2.0: https://www.apache.org/licenses/LICENSE-2.0\n';}
await writeFile(path.join(assets,'NOTICES.txt'),notices);
const info={application:'Pinpointer Lens + Event Strip',version:'0.3.0',gitCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),built:new Date().toISOString(),model:{repository:hfRepo,revision,max_len:config.max_len,head_max_len:config.head_max_len},embeddings:JSON.parse(await readFile(path.join(assets,'potion/potion.json'),'utf8')),assets:manifest,dependencies:sourcePackage.dependencies};
await writeFile(path.join(assets,'build-info.json'),JSON.stringify(info,null,2));
await import('./assemble-local.mjs');
await copyFile(path.join(assets,'build-info.json'),path.join(dist,'build-info.json'));
