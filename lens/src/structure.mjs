import {paragraphSpans} from './core.mjs';

// The same packaged parser used by native Pinpointer. Its ranges are UTF-16,
// exactly the unit used by String.slice and browser text nodes.
export async function structureEngine(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Cannot load the packaged legal structure parser.');
  const {instance:{exports:e}} = await WebAssembly.instantiate(await response.arrayBuffer());
  return (text,meta={}) => {
    const bytes = new TextEncoder().encode(JSON.stringify({source_kind:meta.documentType==='legislation'?'laws':'cases',text,citation:meta.citation||'',name:meta.title||''}));
    const pointer=e.legal_structure_alloc(bytes.length);
    if(!pointer&&bytes.length)throw new Error('Legal structure allocation failed.');
    try{new Uint8Array(e.memory.buffer,pointer,bytes.length).set(bytes);e.legal_structure_analyze(pointer,bytes.length);}
    finally{e.legal_structure_dealloc(pointer,bytes.length);}
    const result=JSON.parse(new TextDecoder().decode(new Uint8Array(e.memory.buffer,e.legal_structure_output_pointer(),e.legal_structure_output_length())));
    if(!result.ok||result.offset_unit!=='utf16')throw new Error(result.error||'Invalid structure response.');
    return result.nodes.map(n=>({start:n.range.start,end:n.range.end,kind:n.kind,locator:n.label.replace(/^(?:par|sec|page|rule|art)/,'')}));
  };
}
export function pinpoint(kind,locator) {
  if(!locator)return '';
  return ({paragraph:'at para ',section:'s ',rule:'r ',article:'art ',page:'at p ',pilcrow:'¶ ',silcrow:'§ '}[kind]||'')+locator;
}
// Split only for inference and retrieval; keep the enclosing structural unit for
// display and copying. Adjacent windows overlap, and the last character is covered.
export function sourceWindows(text,nodes=[],maxWords=120) {
  const output=[],units=[];let offset=0;
  const sorted=[...nodes].filter(n=>Number.isInteger(n.start)&&n.start>=0&&n.end>n.start).sort((a,b)=>a.start-b.start||a.end-b.end);
  function plain(start,end){for(const p of paragraphSpans(text.slice(start,end)))units.push({start:start+p.start,end:start+p.end,kind:'',locator:''});}
  for(let ni=0;ni<sorted.length;ni++){const n=sorted[ni];
    if(n.start<offset)continue;
    if(n.start>offset)plain(offset,n.start);
    const next=sorted[ni+1],end=Math.min(next&&next.start>n.start&&next.start<n.end?next.start:n.end,text.length);
    if(end>n.start)units.push({...n,end});offset=end;
  }
  if(offset<text.length)plain(offset,text.length);
  for(const unit of units){
    const value=text.slice(unit.start,unit.end),words=[...value.matchAll(/\S+/gu)];
    if(!words.length)continue;
    for(let at=0;at<words.length;at+=maxWords-24){
      const first=at?words[at].index:0,last=at+maxWords>=words.length?value.length:words[at+maxWords].index;
      const start=unit.start+first,end=unit.start+last;
      output.push({text:text.slice(start,end),start,end,unitStart:unit.start,unitEnd:unit.end,kind:unit.kind,locator:unit.locator});
      if(at+maxWords>=words.length)break;
    }
  }
  return output;
}
