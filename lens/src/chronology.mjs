import {dateCandidates, cancelled, pause} from './core.mjs';

export const ENGINE_VERSION='events-1';
const clean=s=>String(s).replace(/\s+/gu,' ').trim();
const normalized=s=>clean(s).normalize('NFKC').toLocaleLowerCase();
const idFor=(source,block,start,end)=>`${source.id}:${block.id}:${start}:${end}`;
const entropyMargin=r=>{const p=Object.values(r.probabilities).sort((a,b)=>b-a);return p[0]-(p[1]||0);};
const yes=r=>r.noul??r.probabilities?.true??r.probabilities?.['1'];
function span(text,start,end){while(start<end&&/\s/u.test(text[start]))start++;while(end>start&&/\s/u.test(text[end-1]))end--;return {start,end,text:text.slice(start,end)};}

// Enumerate language spans first. Dates never create events or rows.
export function sentenceUnits(text,language='en'){
  const result=[];
  for(const s of new Intl.Segmenter(language,{granularity:'sentence'}).segment(text)){
    // A PDF page or a plain-text diary can contain multiple paragraphs/headings.
    for(const part of s.segment.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g)){
      const from=s.index+part.index,to=from+part[0].length;
      // Bounded, overlapping context for unusually long unpunctuated text.
      let start=from;
      while(start<to){let end=Math.min(to,start+1200);if(end<to){const space=text.lastIndexOf(' ',end);if(space>start+600)end=space;}
        const unit=span(text,start,end);if(unit.text)result.push(unit);if(end===to)break;start=end;}
    }
  }
  return result;
}
const EVENT_QUESTION={type:'noul',instructions:'Does this text describe a specific event, action or change that belongs in a chronology?',criteria:{true:'A particular occurrence or action',false:'Only a heading, greeting, general rule or background description'}};
async function isEvent(text,decisions,signal){
  const answer=await decisions.decide(text,EVENT_QUESTION,signal),p=yes(answer);
  if(!Number.isFinite(p))throw new Error('Invalid event discovery response.');
  return {include:p>=.35,uncertain:p<.65,probability:p};
}
async function eventSpans(unit,decisions,signal){
  // Coordination is only a possible boundary. Laya decides whether it actually
  // separates happenings; names, lists and a single event's details stay intact.
  const boundaries=[...unit.text.matchAll(/;\s*|,?\s+(?:and then|and|but|then|et|puis|mais)\s+/giu)];
  const parts=[];let last=0;
  for(const match of boundaries){
    cancelled(signal);
    const left=unit.text.slice(last,match.index),right=unit.text.slice(match.index+match[0].length);
    if(left.trim().split(/\s+/).length<2||right.trim().split(/\s+/).length<3)continue;
    const answer=await decisions.decide(`Before: ${left}\nAfter: ${right}`,{type:'noul',instructions:'Do these phrases describe two distinct events or milestones rather than parts or details of one event?',criteria:{true:'Separate happenings',false:'One happening, a name or a list'}},signal);
    if(yes(answer)<.7)continue;
    parts.push(span(unit.text,last,match.index));last=match.index+match[0].length;
  }
  parts.push(span(unit.text,last,unit.text.length));
  return parts.filter(p=>p.text).map(p=>({...p,start:unit.start+p.start,end:unit.start+p.end}));
}
function datePool(source,block,event){
  const anchor=block.quoted?null:source.communicated;
  const all=dateCandidates(block.text,anchor).map(d=>({...d,blockId:block.id}));
  const inside=all.filter(d=>d.start>=event.start&&d.end<=event.end);
  // Explicit textual intervals are single date attributes, not two date rows.
  if(inside.length===2){const [a,b]=inside,join=block.text.slice(a.end,b.start);
    if(/^\s*(?:to|until|through|–|—|-)\s*$/iu.test(join)&&a.date&&b.date&&a.date<=b.date)
      return [{...a,raw:block.text.slice(a.start,b.end),end:b.end,dateEnd:b.date,range:true}];
  }
  if(inside.length)return inside;
  const nearby=all.filter(d=>d.end<=event.start&&event.start-d.end<260);
  // A standalone date heading can anchor the following DOCX paragraph, but
  // a date on an earlier narrative paragraph is not borrowed indiscriminately.
  if(!nearby.length){const at=source.blocks.indexOf(block),prev=source.blocks[at-1];
    if(prev&&!prev.quoted){const ds=dateCandidates(prev.text,anchor);
      if(ds.length===1&&clean(prev.text.replace(ds[0].raw,'' )).replace(/[:,.\[\]()–—-]/g,'')==='')nearby.push({...ds[0],blockId:prev.id,heading:true});}
  }
  return nearby;
}
export async function associateDate(source,block,event,decisions,signal){
  const dates=datePool(source,block,event),matches=[];
  // Every candidate in the bounded source context is considered. Batches keep
  // arbitrary document dates from overflowing Laya's fixed choice header.
  for(let at=0;at<dates.length;at+=6){
    const group=dates.slice(at,at+6),criteria={unknown:'Not stated or ambiguous'};
    group.forEach((d,i)=>criteria[`d${i}`]=d.raw);
    const context=block.text.slice(Math.max(0,event.start-260),Math.min(block.text.length,event.end+100));
    const state=`Context: ${context}\nTarget event: ${event.text}\nCandidate dates:\n${group.map((d,i)=>`d${i}: ${d.raw}${d.heading?' (preceding date heading)':''}`).join('\n')}`;
    const answer=await decisions.decide(state,{type:'choice',instructions:'Which supplied date belongs to the target event? Do not substitute the date of a document or a different event.',criteria},signal);
    const chosen=/^d(\d+)$/.exec(answer.choice);
    if(chosen&&group[+chosen[1]])matches.push({candidate:group[+chosen[1]],uncertain:entropyMargin(answer)<.15});
  }
  const distinct=[...new Map(matches.map(x=>[`${x.candidate.blockId}:${x.candidate.start}`,x])).values()];
  if(distinct.length!==1||distinct[0].uncertain)return {date:'',dateEnd:'',dateText:'',dateReason:dates.length?'Check which date belongs to this event.':'No event date stated.',dateOptions:dates};
  const d=distinct[0].candidate;
  return {date:d.date||'',dateEnd:d.dateEnd||'',dateText:d.raw,dateReason:d.reason||(!d.date?'Invalid or incomplete date.':''),dateOptions:dates,dateEvidence:{sourceId:source.id,blockId:d.blockId,start:d.start,end:d.end}};
}
export function createCatalogue(){return {engine:ENGINE_VERSION,mentions:[],omitted:[],scanned:[],pairs:{},events:[],separations:[]};}
function evidence(source,block,event){return {id:idFor(source,block,event.start,event.end),sourceId:source.id,blockId:block.id,start:event.start,end:event.end,quote:block.text.slice(event.start,event.end),communicated:source.communicated||'',quoted:Boolean(block.quoted),ocr:Boolean(block.ocr),locator:block.locator};}
export async function discoverEvents(sources,catalogue,decisions,{signal,onProgress=()=>{}}={}){
  const completed=new Set(catalogue.scanned),known=new Set(catalogue.mentions.map(m=>m.id));
  for(const source of sources)for(const block of source.blocks)for(const unit of sentenceUnits(block.text,source.language)){
    cancelled(signal);const unitId=idFor(source,block,unit.start,unit.end);if(completed.has(unitId))continue;
    const finding=await isEvent(unit.text,decisions,signal);
    const added=[],omitted=[];
    if(finding.include){
      const parts=await eventSpans(unit,decisions,signal);
      for(const part of parts){
        const judged=parts.length===1?finding:await isEvent(part.text,decisions,signal);
        const ev=evidence(source,block,part);
        if(!judged.include){omitted.push({...ev,probability:judged.probability});continue;}
        const date=await associateDate(source,block,part,decisions,signal);
        added.push({...ev,...date,text:clean(part.text),uncertain:judged.uncertain,discoveryProbability:judged.probability});
      }
    }else omitted.push({...evidence(source,block,unit),probability:finding.probability});
    cancelled(signal);
    // Commit a source unit only when all its event/date decisions have completed.
    for(const m of added)if(!known.has(m.id)){known.add(m.id);catalogue.mentions.push(m);}
    catalogue.omitted.push(...omitted);catalogue.scanned.push(unitId);completed.add(unitId);
    onProgress({phase:'discover',source:source.name,events:catalogue.mentions.length});await pause();
  }
}
const stop=new Set('the a an and or to of in on at by for from with was were is are has had have been it this that as its be'.split(' '));
function terms(text){return new Set((normalized(text).match(/[\p{L}\p{N}]+/gu)||[]).filter(w=>w.length>2&&!stop.has(w)));}
function compatible(a,b){return !(a.date&&b.date&&(a.date!==b.date||(a.dateEnd||'')!==(b.dateEnd||'')));}
export async function sameEvent(a,b,decisions,signal){
  if(!compatible(a,b))return false;
  if(normalized(a.text)===normalized(b.text))return true;
  // Direct and reversed checks reduce accidental grouping. Model disagreement
  // leaves separate entries; a group never discards its original mentions.
  const q={type:'noul',instructions:'Do both passages describe the SAME specific event, with the same participants and outcome, rather than different or conflicting events?',criteria:{true:'Same specific happening',false:'Different, conflicting or uncertain'}};
  for(const [x,y]of [[a,b],[b,a]]){
    const r=await decisions.decide(`A: ${x.text}\nEvent date: ${x.date||'not stated'}\nB: ${y.text}\nEvent date: ${y.date||'not stated'}`,q,signal);
    if(yes(r)<.8)return false;
  }
  return true;
}
export async function collateEvents(catalogue,decisions,{signal,onProgress=()=>{}}={}){
  const groups=[],postings=new Map(),dates=new Map(),exact=new Map(),separate=new Set(catalogue.separations||[]);
  const previous=new Map(catalogue.events.flatMap(e=>e.mentionIds.map(id=>[id,e])));
  const pairKey=(a,b)=>[a,b].sort().join('\0');
  for(const m of catalogue.mentions){
    cancelled(signal);const candidates=new Map(),tokens=terms(m.text),key=normalized(m.text);
    for(const i of exact.get(key)||[])candidates.set(i,1000);
    if(m.date)for(const i of dates.get(m.date)||[])candidates.set(i,2);
    for(const t of tokens)for(const i of postings.get(t)||[])candidates.set(i,(candidates.get(i)||0)+1);
    let selected=null;
    for(const [i,overlap]of [...candidates].sort((a,b)=>b[1]-a[1])){
      if(overlap<2)continue;const group=groups[i],p=pairKey(group.members[0].id,m.id);
      if(group.members.some(other=>!compatible(other,m)||separate.has(pairKey(other.id,m.id))))continue;
      if(!(p in catalogue.pairs))catalogue.pairs[p]=await sameEvent(group.members[0],m,decisions,signal);
      if(catalogue.pairs[p]){selected=group;break;}
    }
    if(selected)selected.members.push(m);
    else{selected={members:[m]};groups.push(selected);}
    const index=groups.indexOf(selected);
    for(const [map,k]of [[exact,key],...(m.date?[[dates,m.date]]:[])]){if(!map.has(k))map.set(k,new Set());map.get(k).add(index);}
    for(const t of tokens){if(!postings.has(t))postings.set(t,new Set());postings.get(t).add(index);}
    onProgress({phase:'collate',events:groups.length});await pause();
  }
  const events=groups.map(g=>{
    const first=g.members[0],old=g.members.map(m=>previous.get(m.id)).find(e=>e?.edited)||previous.get(first.id);
    const dated=g.members.find(m=>m.date)||first;
    return {id:old?.id||first.id,mentionIds:g.members.map(m=>m.id),text:old?.edited?old.text:first.text,
      date:old?.edited?old.date:dated.date,dateEnd:old?.edited?old.dateEnd:dated.dateEnd,
      dateText:dated.dateText,dateReason:old?.edited?'':dated.dateReason,uncertain:g.members.some(m=>m.uncertain),
      note:old?.note||'',edited:Boolean(old?.edited),reviewed:Boolean(old?.reviewed),excluded:Boolean(old?.excluded)};
  });
  for(const e of catalogue.events)if(e.manual)events.push(e);
  catalogue.events=events;return events;
}
export async function makeChronology(sources,catalogue,decisions,options={}){
  await decisions.start();cancelled(options.signal);
  await discoverEvents(sources,catalogue,decisions,options);
  return collateEvents(catalogue,decisions,options);
}
export function ungroup(catalogue,event){
  for(let i=0;i<event.mentionIds.length;i++)for(let j=i+1;j<event.mentionIds.length;j++)catalogue.separations.push([event.mentionIds[i],event.mentionIds[j]].sort().join('\0'));
}
export function eventOrder(a,b){return (a.date||'9999').localeCompare(b.date||'9999')||a.text.localeCompare(b.text)||a.id.localeCompare(b.id);}
export function validateCatalogue(catalogue,sources){
  if(catalogue.engine!==ENGINE_VERSION||!Array.isArray(catalogue.events)||!Array.isArray(catalogue.mentions)||!Array.isArray(catalogue.omitted))throw new Error('Unsupported chronology format.');
  const blocks=new Map(sources.flatMap(s=>s.blocks.map(b=>[`${s.id}:${b.id}`,b])));
  const mentions=new Set();
  for(const m of [...catalogue.mentions,...catalogue.omitted]){
    const b=blocks.get(`${m.sourceId}:${m.blockId}`);
    if(!b||!Number.isInteger(m.start)||!Number.isInteger(m.end)||m.start<0||m.end<=m.start||m.end>b.text.length||b.text.slice(m.start,m.end)!==m.quote)throw new Error('A chronology entry does not match its original source.');
    mentions.add(m.id);
  }
  for(const e of catalogue.events)if(!e.manual&&e.mentionIds.some(id=>!mentions.has(id)))throw new Error('A chronology entry has missing sources.');
  return catalogue;
}
