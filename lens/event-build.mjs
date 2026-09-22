import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const root=import.meta.dirname,repo=path.resolve(root,'..'),assets=path.join(repo,'lens-dist/assets'),dist=path.join(root,'dist');await mkdir(dist,{recursive:true});
const common={bundle:true,minify:true,legalComments:'inline',target:'chrome116',platform:'browser'};
await build({...common,entryPoints:[path.join(root,'src/decision-worker.mjs')],format:'iife',outfile:path.join(assets,'decision-worker.js')});
const app=await build({...common,entryPoints:[path.join(root,'src/event-strip.mjs')],format:'esm',write:false});
const template=await readFile(path.join(root,'src/event-strip.html'),'utf8');
const [before,after]=template.replace('/* INLINE_CSS */','').replace('/* INLINE_APP */',()=>app.outputFiles[0].text.replaceAll('</script','<\\/script')).split('<!-- PACKAGED_ASSETS -->');
if(after==null)throw new Error('Missing asset insertion point');
const info={application:'Event Strip',version:'0.4.0',engine:'events-1',commit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),built:new Date().toISOString(),model:{repository:'soyelmismo/laya-multilingual-onnx',revision:'0966c4fa58da6878b39e7e14cb5e93313b82d828'},workflow:'Event discovery, source-span date association, duplicate mention collation. No event-type taxonomy.'};
await writeFile(path.join(assets,'build-info.json'),JSON.stringify(info,null,2));await writeFile(path.join(dist,'event-build-info.json'),JSON.stringify(info,null,2));
const names=['decision-worker.js','model.onnx','tokenizer.json','tokenizer_config.json','rl_agent_config.json','ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm','pdf.worker.min.mjs','tesseract-worker.js','tesseract-core-simd-lstm.wasm.js','NOTICES.txt','build-info.json'];
const stream=createWriteStream(path.join(dist,'event-strip.html'));stream.on('error',e=>{throw e;});
async function emit(text){if(!stream.write(text))await new Promise(r=>stream.once('drain',r));}
await emit(before);
for(const name of names){let part=0;for await(const bytes of createReadStream(path.join(assets,name),{highWaterMark:3*256*1024}))await emit(`<script type="application/octet-stream" data-asset="${name}" data-part="${part++}">${bytes.toString('base64')}</script>\n`);}
await emit(after);await new Promise(r=>stream.end(r));
const h=createHash('sha256');for await(const bytes of createReadStream(path.join(dist,'event-strip.html')))h.update(bytes);
await writeFile(path.join(dist,'event-SHA256SUMS.txt'),h.digest('hex')+'  event-strip.html\n');console.log('Built single offline chronology HTML',info.commit);
