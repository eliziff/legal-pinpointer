import JSZip from 'jszip';
import PostalMime from 'postal-mime';
import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import {createWorker} from 'tesseract.js';
import {assetURL} from './assets.mjs';
import {uid,dateCandidates,cancelled,pause} from './core.mjs';
pdfjs.GlobalWorkerOptions.workerSrc=assetURL('pdf.worker.min.mjs');
let ocr=null;const pdfs=new Map();
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function htmlText(html){const doc=new DOMParser().parseFromString(html,'text/html');for(const n of doc.querySelectorAll('script,style,iframe,object,svg,math,form'))n.remove();for(const n of doc.querySelectorAll('br'))n.replaceWith('\n');for(const n of doc.querySelectorAll('p,div,li,tr,blockquote'))n.append('\n');return doc.body.textContent||'';}
export function boundedZip(bytes){
  const view=new DataView(bytes);let count=0,total=0;
  for(let p=Math.max(0,bytes.byteLength-65557);p+22<=bytes.byteLength;p++)if(view.getUint32(p,true)===0x06054b50){
    const n=view.getUint16(p+10,true),offset=view.getUint32(p+16,true);let at=offset;
    if(n===65535||offset===0xffffffff)throw new Error('ZIP64 document packages are not supported.');
    for(let i=0;i<n;i++){if(at+46>bytes.byteLength||view.getUint32(at,true)!==0x02014b50)throw new Error('Invalid ZIP directory.');const size=view.getUint32(at+24,true);total+=size;if(size>128*1024*1024||total>512*1024*1024)throw new Error('Expanded document package exceeds the 512 MB safety budget.');at+=46+view.getUint16(at+28,true)+view.getUint16(at+30,true)+view.getUint16(at+32,true);count++;}if(count>10000)throw new Error('Document package has more than 10,000 parts.');return;
  }throw new Error('Missing ZIP directory.');
}
function paragraphs(text){const blocks=[];let quoted=false;for(const part of text.split(/\r?\n\s*\r?\n/)){if(/^\s*(?:On .+wrote:|Le .+écrit\s*:|[-_]{3,}\s*(?:Original Message|Forwarded)|From:\s+.+\nSent:)/im.test(part))quoted=true;if(part.trim())blocks.push({id:uid(),text:part,locator:`Body paragraph ${blocks.length+1}`,quoted:quoted||/^\s*>/m.test(part)});}return blocks;}
function communicationDate(raw){if(!raw)return '';const found=dateCandidates(String(raw));return found.find(x=>x.date)?.date||(/^\d{4}-\d{2}-\d{2}/.test(raw)?String(raw).slice(0,10):'');}
function wordParagraph(node,revision){let text='';const walk=n=>{if(n.nodeType!==1)return;const tag=n.localName;if((revision==='current'&&tag==='del')||(revision==='original'&&tag==='ins'))return;if(tag==='t'||(tag==='delText'&&revision==='original'))text+=n.textContent;else if(tag==='tab')text+='\t';else if(tag==='br'||tag==='cr')text+='\n';else for(const child of n.children)walk(child);};walk(node);return text;}
export async function pdfDocument(source){if(!pdfs.has(source.id)){const bytes=new Uint8Array(await source.file.arrayBuffer());pdfs.set(source.id,pdfjs.getDocument({data:bytes,useSystemFonts:true,disableFontFace:true,isEvalSupported:false}).promise);}return pdfs.get(source.id);}
async function recognize(canvas,progress){
  if(!ocr){progress('Loading packaged OCR…');ocr=await createWorker('eng',1,{workerPath:assetURL('tesseract-worker.js'),corePath:assetURL('tesseract-core-simd-lstm.wasm.js')+'#core.js',langPath:'https://offline.invalid',workerBlobURL:false,gzip:true,logger:m=>{if(m.status)progress(`OCR · ${m.status} ${Math.round((m.progress||0)*100)}%`);}});}
  const {data}=await ocr.recognize(canvas,{}, {text:true,blocks:true});return data;
}
export async function closeDocuments(){await ocr?.terminate();ocr=null;for(const p of pdfs.values()){const doc=await p.catch(()=>null);await doc?.destroy();}pdfs.clear();}
export async function importDocument(file,{revision='current',useOCR=true,signal,progress=()=>{},depth=0,parent=''}={}) {
  cancelled(signal);if(depth>12)throw new Error('Nested email depth exceeds the safety limit.');
  const ext=file.name.split('.').pop().toLowerCase(),source={id:uid(),name:parent?`${parent} / ${file.name}`:file.name,file,kind:ext,blocks:[],communicated:'',from:'',warnings:[],language:'en',revision};const sources=[source];
  progress(`Reading ${source.name}`);
  if(ext==='eml'){
    const bytes=await file.arrayBuffer(),rawHeaders=new TextDecoder('utf-8').decode(bytes.slice(0,32768)).split(/\r?\n\r?\n/)[0];
    if(/application\/(?:pkcs7-mime|x-pkcs7-mime)|multipart\/encrypted/i.test(rawHeaders))throw new Error('Encrypted email must be decrypted before import.');
    const mail=await PostalMime.parse(bytes,{attachmentEncoding:'arraybuffer'});
    source.subject=mail.subject||'';source.from=mail.from?[mail.from.name,mail.from.address].filter(Boolean).join(' '):'';source.messageId=mail.messageId||'';source.rawDate=mail.date||'';source.communicated=communicationDate(mail.date);source.to=(mail.to||[]).map(x=>x.address||x.name).join('; ');source.blocks=paragraphs(mail.text||htmlText(mail.html||''));
    if(!source.blocks.length)source.warnings.push('Email has no readable body.');
    for(const attachment of mail.attachments||[]){cancelled(signal);const name=attachment.filename||`attachment-${sources.length}`,type=name.split('.').pop().toLowerCase();if(['eml','pdf','docx','txt','md'].includes(type)){
      try{const f=new File([attachment.content],name,{type:attachment.mimeType});sources.push(...await importDocument(f,{revision,useOCR,signal,progress,depth:depth+1,parent:source.name}));}catch(e){if(e.name==='AbortError')throw e;source.warnings.push(`${name}: ${e.message}`);}
    }else source.warnings.push(`Attachment not processed: ${name} (${attachment.mimeType||'unknown type'})`);}
  }else if(ext==='docx'){
    const bytes=await file.arrayBuffer();boundedZip(bytes);const zip=await JSZip.loadAsync(bytes);const parts=['word/document.xml','word/footnotes.xml','word/endnotes.xml','word/comments.xml'];
    for(const part of parts){if(!zip.file(part))continue;const xml=new DOMParser().parseFromString(await zip.file(part).async('string'),'application/xml');if(xml.querySelector('parsererror'))throw new Error(`Malformed XML in ${part}`);
      let number=0;for(const p of xml.getElementsByTagNameNS(W,'p')){cancelled(signal);number++;const text=wordParagraph(p,revision);if(!text.trim())continue;const id=p.getAttributeNS('http://schemas.microsoft.com/office/word/2010/wordml','paraId');let table=false;for(let n=p.parentElement;n;n=n.parentElement)if(n.localName==='tc')table=true;source.blocks.push({id:uid(),text,part,paragraph:number,locator:`${part} · ${table?'table cell, ':''}paragraph ${number}${id?' ['+id+']':''}`,quoted:false});}if(xml.getElementsByTagNameNS(W,'ins').length||xml.getElementsByTagNameNS(W,'del').length)source.warnings.push(`Tracked revisions present; imported ${revision==='current'?'current (insertions included, deletions excluded)':'original (deletions included, insertions excluded)'} text from ${part}.`);
    }if(!source.blocks.length)throw new Error('No readable Word paragraphs were found.');
  }else if(ext==='pdf'){
    const doc=await pdfDocument(source);source.pages=doc.numPages;
    for(let pageNo=1;pageNo<=doc.numPages;pageNo++){cancelled(signal);progress(`${file.name} · page ${pageNo}/${doc.numPages}`);const page=await doc.getPage(pageNo),content=await page.getTextContent(),lines=[];let line=null;
      for(const item of content.items){if(typeof item.str!=='string')continue;const x=item.transform[4],y=item.transform[5],h=Math.abs(item.height)||12;
        if(!line||Math.abs(line.y-y)>h*.5){line={y,text:'',x,width:0,height:h};lines.push(line);}if(line.text&&!/\s$/.test(line.text))line.text+=' ';line.text+=item.str;line.width=Math.max(line.width,x+(item.width||0)-line.x);if(item.hasEOL)line=null;}
      const text=lines.map(x=>x.text).join('\n');
      if(text.trim().length>=20)source.blocks.push({id:uid(),text,locator:`PDF page ${pageNo}`,page:pageNo,lines,quoted:false});
      else if(useOCR){const viewport=page.getViewport({scale:2}),canvas=document.createElement('canvas');canvas.width=viewport.width;canvas.height=viewport.height;await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;cancelled(signal);const data=await recognize(canvas,progress);canvas.width=canvas.height=1;if(data.text.trim())source.blocks.push({id:uid(),text:data.text,locator:`PDF page ${pageNo} · OCR`,page:pageNo,ocr:true,quoted:false});else source.warnings.push(`Page ${pageNo}: OCR did not recover text.`);}
      else source.warnings.push(`Page ${pageNo}: no usable native text; OCR was disabled.`);
      page.cleanup();await pause();
    }
  }else if(['txt','md','html','htm'].includes(ext)){source.blocks=paragraphs(ext.startsWith('ht')?htmlText(await file.text()):await file.text());}
  else throw new Error(`Unsupported input: .${ext}. Use .eml, .pdf, .docx or plain text.`);
  for(const s of sources)if(!s.blocks.length&&!s.warnings.length)s.warnings.push('No text extracted.');
  return sources;
}
export async function renderSource(source,block,container,selection){
  container.replaceChildren();const heading=document.createElement('h3');heading.textContent=`${source.name} · ${block.locator}`;container.append(heading);
  const pre=document.createElement('pre');pre.className='source-text';const text=block.text,start=selection?.start??0,end=selection?.end??0;
  if(end>start){pre.append(document.createTextNode(text.slice(0,start)));const mark=document.createElement('mark');mark.textContent=text.slice(start,end);pre.append(mark,document.createTextNode(text.slice(end)));}else pre.textContent=text;container.append(pre);
  const open=document.createElement('button');open.textContent='Open original file';open.onclick=()=>{const url=URL.createObjectURL(source.file);window.open(url+(block.page?`#page=${block.page}`:''),'_blank','noopener');setTimeout(()=>URL.revokeObjectURL(url),60_000);};container.append(open);
  if(source.kind==='pdf'&&block.page){const canvas=document.createElement('canvas');canvas.className='pdf-page';container.append(canvas);const page=await(await pdfDocument(source)).getPage(block.page),viewport=page.getViewport({scale:1.15});canvas.width=viewport.width;canvas.height=viewport.height;await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;}
  pre.querySelector('mark')?.scrollIntoView({block:'center'});
}
export {JSZip};
