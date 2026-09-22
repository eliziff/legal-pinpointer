import {build} from 'esbuild';import {readFile,writeFile,copyFile,readdir,mkdir} from 'node:fs/promises';import {createReadStream,createWriteStream} from 'node:fs';import {createHash} from 'node:crypto';import path from 'node:path';
const root=import.meta.dirname,repo=path.resolve(root,'..'),out=path.join(repo,'lens-dist'),assets=path.join(out,'assets'),dist=path.join(root,'dist');await mkdir(dist,{recursive:true});
const common={bundle:true,minify:true,legalComments:'inline',target:'chrome116',platform:'browser'};
for(const name of ['decision-worker','corpus-worker'])await build({...common,entryPoints:[path.join(root,`src/${name}.mjs`)],format:'iife',outfile:path.join(assets,name+'.js')});
await build({...common,entryPoints:[path.join(root,'src/lens.mjs')],format:'esm',outfile:path.join(out,'lens.mjs')});
const event=await build({...common,entryPoints:[path.join(root,'src/event-strip.mjs')],format:'esm',write:false});
for(const n of ['lens.html','ui.css','page.js'])await copyFile(path.join(root,'src',n),path.join(out,n));
const template=await readFile(path.join(root,'src/event-strip.html'),'utf8'),css=await readFile(path.join(root,'src/ui.css'),'utf8'),script=event.outputFiles[0].text.replaceAll('</script','<\\/script');
const [before,after]=template.replace('/* INLINE_CSS */',()=>css).replace('/* INLINE_APP */',()=>script).split('<!-- PACKAGED_ASSETS -->');
const stream=createWriteStream(path.join(dist,'event-strip.html'));async function emit(text){if(!stream.write(text))await new Promise(r=>stream.once('drain',r));}await emit(before);
for(const e of await readdir(assets,{withFileTypes:true})){if(!e.isFile()||e.name.startsWith('duckdb')||e.name==='corpus-worker.js')continue;let part=0;for await(const chunk of createReadStream(path.join(assets,e.name),{highWaterMark:3*256*1024}))await emit(`<script type="application/octet-stream" data-asset="${e.name}" data-part="${part++}">${chunk.toString('base64')}</script>\n`);}
await emit(after);await new Promise(r=>stream.end(r));
if(!process.env.SKIP_ARCHIVE){
 const {spawnSync}=await import('node:child_process');
 const result=spawnSync(process.env.PYTHON||'python3',[path.join(root,'archive.py'),repo,path.join(dist,'legal-pinpointer-lens.zip')],{stdio:'inherit'});
 if(result.status!==0)throw new Error('Extension archive failed.');
}
const sums=[];for(const name of process.env.SKIP_ARCHIVE?['event-strip.html']:['event-strip.html','legal-pinpointer-lens.zip']){const h=createHash('sha256');for await(const c of createReadStream(path.join(dist,name)))h.update(c);sums.push(h.digest('hex')+'  '+name);}await writeFile(path.join(dist,'SHA256SUMS.txt'),sums.join('\n')+'\n');console.log(sums.join('\n'));
