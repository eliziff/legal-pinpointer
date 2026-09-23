import {boundedZip} from './zip.mjs';
export {boundedZip} from './zip.mjs';
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
function paragraphs(text){const blocks=[];let quoted=false;for(const part of text.split(/\r?\n\s*\r?\n/)){if(/^\s*(?:On .+wrote:|Le .+écrit\s*:|[-_]{3,}\s*(?:Original Message|Forwarded)|From:\s+.+\nSent:)/im.test(part))quoted=true;if(part.trim())blocks.push({id:uid(),text:part,locator:`Body paragraph ${blocks.length+1}`,quoted:quoted||/^\s*>/m.test(part)});}return blocks;}
function communicationDate(raw){if(!raw)return '';const found=dateCandidates(String(raw));return found.find(x=>x.date)?.date||(/^\d{4}-\d{2}-\d{2}/.test(raw)?String(raw).slice(0,10):'');}
function wordParagraph(node,revision){let text='';const walk=n=>{if(n.nodeType!==1)return;const tag=n.localName;if((revision==='current'&&tag==='del')||(revision==='original'&&tag==='ins'))return;if(tag==='t'||(tag==='delText'&&revision==='original'))text+=n.textContent;else if(tag==='tab')text+='\t';else if(tag==='br'||tag==='cr')text+='\n';else for(const child of n.children)walk(child);};walk(node);return text;}
// Printed correspondence dates itself: an email header block (From/Sent/To/
// Subject, as mail clients print them, on any page so each message of a chain
// counts) or a letter's standalone date line with its "Re:" line. Offsets
// address the page block's own text so the entry cites exact source words.
const HEADER_KEYED=/^\s*(from|de|sent|envoy[ée]|date|to|[àa]|cc|bcc|cci|reply-to|subject|objet|attachments?|pi[èe]ces? jointes?|importance)\s*:\s*(.*)$/iu,HEADER_BARE=/^\s*(From|Sent|Date|To|Cc|Bcc|Subject|Attachments)(?:\s+([\p{Lu}\p{N}].*))?\s*$/u;
const header=text=>HEADER_KEYED.exec(text)||HEADER_BARE.exec(text);
export function correspondence(lines,at=lines.reduce((o,l,i)=>(o.push(i?o[i-1]+lines[i-1].text.length+1:0),o),[])){
  const found=[];
  for(let i=0;i<lines.length;i++){
    const fields={},first=i;let j=i;
    while(j<lines.length){const m=header(lines[j].text);if(!m)break;const key=m[1].toLocaleLowerCase();let value=(m[2]||'').trim();
      if(!value&&j+1<lines.length&&!header(lines[j+1].text)){value=lines[j+1].text.trim();j++;}
      const k={de:'from',sent:'date','envoyé':'date','envoye':'date','à':'to',a:'to',objet:'subject'}[key]||key;if(!(k in fields))fields[k]=value;j++;}
    const date=fields.date&&dateCandidates(fields.date).find(d=>d.date);
    if(fields.from&&date&&j-first>=3){
      const subject=fields.subject||(first>0&&/^\s*(?:re|fw|fwd|tr)\s*:/iu.test(lines[first-1].text)?lines[first-1].text.trim():'');
      const who=v=>(v||'').replace(/<[^>]*>|\S+@\S+/g,'').replace(/\s+/g,' ').replace(/[;,\s]+$/,'').trim();
      found.push({kind:'email',date:date.date,dateText:date.raw,start:at[first],end:at[j-1]+lines[j-1].text.length,
        text:`Email from ${who(fields.from)||fields.from}${fields.to?` to ${who(fields.to)||fields.to}`:''}${subject?`: ${subject.replace(/\s+/g,' ')}`:''}`});
      i=j-1;continue;
    }
    // A letter: a line that is only a date near the top, then a salutation or
    // "Re:" line. Its addressee and subject come from the lines between.
    const whole=dateCandidates(lines[i].text);
    if(i<25&&whole.length===1&&whole[0].date&&lines[i].text.trim().replace(/[.,]$/,'')===whole[0].raw.trim()){
      const next=lines.slice(i+1,i+45),re=next.findIndex(l=>/^\s*(?:re|objet)\s*:/iu.test(l.text)),dear=next.findIndex(l=>/^\s*(?:dear|cher|ch[èe]re|madame|monsieur|ma[îi]tre)\b/iu.test(l.text));
      if(re>=0||dear>=0){
        const r=i+1+(re>=0?re:dear),after=lines[i+2+dear]?.text.trim()||'';
        const to=next.find(l=>!/^\s*(?:sent|delivered|via|by|privileged|without prejudice|confidential|personal|par|sous toutes r[ée]serves|courriel|e-?mail)\b/iu.test(l.text))?.text.trim()||'';
        const subject=re>=0?lines[r].text.trim().replace(/^\s*(?:re|objet)\s*:\s*/iu,''):after.length<90&&!/[.:]$/.test(after)?after:'';
        const end=re<0&&subject?i+2+dear:r;
        found.push({kind:'letter',date:whole[0].date,dateText:whole[0].raw,start:at[i],end:at[end]+lines[end].text.length,
          text:`Letter dated ${whole[0].raw.trim()}${to&&to!==lines[r].text.trim()?` to ${to}`:''}${subject?`: ${subject}`:''}`.replace(/\s+/g,' ')});i=end;
      }
    }
  }
  return found;
}
// PDF text arrives as printed lines. Rejoin wrapped lines into paragraphs
// (vertical gap, list items and header lines start new ones) so sentences are
// sentences; at[i] is where line i starts in the rebuilt page text.
export function reflow(lines){
  let text='';const at=[];
  lines.forEach((line,i)=>{const prev=lines[i-1];
    if(prev){const gap=prev.y-line.y,height=Math.max(prev.height,line.height)||12;
      const brk=gap<0||gap>height*1.7||header(line.text)||header(prev.text)||/^\s*(?:[-•▪●◦]|\(?[\p{L}\p{N}]{1,3}[.)])\s/u.test(line.text);
      text+=brk?'\n\n':/\p{L}-$/u.test(text)?'':' ';}
    at.push(text.length);text+=line.text;});
  return {text,at};
}
export async function pdfDocument(source){if(!pdfs.has(source.id)){const bytes=new Uint8Array(await source.file.arrayBuffer());pdfs.set(source.id,pdfjs.getDocument({data:bytes,useSystemFonts:true,disableFontFace:true,isEvalSupported:false}).promise);}return pdfs.get(source.id);}
async function recognize(canvas,progress){
  if(!ocr){progress('Reading scanned page…');ocr=await createWorker('eng',1,{workerPath:assetURL('tesseract-worker.js'),corePath:assetURL('tesseract-core-simd-lstm.wasm.js')+'#core.js',langPath:'https://offline.invalid',workerBlobURL:false,gzip:true});}
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
    const head=[['From',mail.from?[mail.from.name,mail.from.address&&`<${mail.from.address}>`].filter(Boolean).join(' '):''],['Date',mail.date||''],['To',(mail.to||[]).map(x=>x.name||x.address).join('; ')],['Subject',mail.subject||'']].filter(([,v])=>v).map(([k,v])=>({text:`${k}: ${v}`}));
    if(head.length>=3){const block={id:uid(),text:head.map(l=>l.text).join('\n'),locator:'Email header',quoted:false,lines:head};block.correspondence=correspondence(head);source.blocks.unshift(block);}
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
      for(const item of content.items){if(typeof item.str!=="string")continue;const x=item.transform[4],y=item.transform[5],h=Math.abs(item.height)||12;
        if(!line||Math.abs(line.y-y)>h*.5){line={y,text:'',x,width:0,height:h};lines.push(line);}if(line.text&&!/\s$/.test(line.text))line.text+=' ';line.text+=item.str;line.width=Math.max(line.width,x+(item.width||0)-line.x);if(item.hasEOL)line=null;}
      const printed=lines.filter(l=>l.text.trim()),{text,at}=reflow(printed);
      if(text.trim().length>=20)source.blocks.push({id:uid(),text,locator:`PDF page ${pageNo}`,page:pageNo,lines:printed,quoted:false,correspondence:correspondence(printed,at)});
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
  const open=document.createElement('button');open.textContent='Open original file';open.onclick=()=>{const url=URL.createObjectURL(source.file);window.open(url+(block.page?`#page=${block.page}`:''),'_blank','noopener');setTimeout(()=>URL.revokeObjectURL(url),60000);};container.append(open);
  if(source.kind==='pdf'&&block.page){const canvas=document.createElement('canvas');canvas.className='pdf-page';container.append(canvas);const page=await(await pdfDocument(source)).getPage(block.page),viewport=page.getViewport({scale:1.15});canvas.width=viewport.width;canvas.height=viewport.height;await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;}
  pre.querySelector('mark')?.scrollIntoView({block:'center'});
}
export {JSZip};
