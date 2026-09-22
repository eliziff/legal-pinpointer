import {dateCandidates, cancelled, pause} from './core.mjs';

export const ENGINE_VERSION='events-1';
const clean=s=>String(s).replace(/\s+/gu,' ').trim();
const normalized=s=>clean(s).normalize('NFKC').toLocaleLowerCase();
const idFor=(source,block,start,end)=>`${source.id}:${block.id}:${start}:${end}`;
const entropyMargin=r=>{const p=Object.values(r.probabilities).sort((a,b)=>b-a);return p[0]-(p[1]||0);};
const yes=r=>r.noul??r.probabilities?.true??r.probabilities?.['1'];
function span(text,start,end){while(start<end&&/\s/u.test(text[start]))start++;while(end>start&&/\s/u.test(text[end-1]))end--;return {start,end,text:text.slice(start,end)};}

// Enumerate source language spans, never one row per date occurrence.
export function sentenceUnits(text,language='en'){
  const result=[];
  for(const s of new Intl.Segmenter(language||'en',{granularity:'sentence'}).segment(text)){
    for(const part of s.segment.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g)){
      const from=s.index+part.index,to=from+part[0].length;let start=from;
      while(start<to){let end=Math.min(to,start+1200);if(end<to){const space=text.lastIndexOf(' ',end);if(space>start+600)end=space;}
        const unit=span(text,start,end);if(unit.text)result.push(unit);if(end===to)break;start=end;}
    }
  }
  return result;
}
const EVENT_QUESTIONS={
  en:{type:'choice',instructions:'What does this passage describe?',criteria:{event:'A specific action, occurrence or change',other:'A heading, greeting or general statement'}},
  fr:{type:'choice',instructions:'Que décrit ce passage ?',criteria:{event:'Un événement, une action ou un changement précis',other:'Un titre, une salutation ou une affirmation générale'}}
};
function dateHeading(text){const dates=dateCandidates(text);return dates.length===1&&clean(text.slice(0,dates[0].start)+text.slice(dates[0].end)).replace(/[:,.\[\]()–—-]/g,'')==='';}
async function isEvent(text,decisions,signal,language='en'){
  if(dateHeading(text)||/^(?:kind regards|best regards|regards|sincerely|yours sincerely|cordialement|bien cordialement)[,.!]*$/iu.test(clean(text)))return {include:false,uncertain:false,probability:0,basis:'heading or sign-off'};
  const french=/^fr\b/i.test(language)||(/\b(?:le|la|les|une|des|du|au)\b/iu.test(text)&&/[àâçéèêëîïôùûüœ]/iu.test(text));
  const answer=await decisions.decide(text,EVENT_QUESTIONS[french?'fr':'en'],signal),p=answer.probabilities?.event;
  if(!Number.isFinite(p))throw new Error('Invalid event discovery response.');
  // Preserve borderline candidates for review rather than silently losing events.
  return {include:p>=.35,uncertain:p<.65,probability:p};
}
async function eventSpans(unit,decisions,signal){
  const boundaries=[...unit.text.matchAll(/;\s*|,?\s+(?:and then|and|but|then|et|puis|mais)\s+/giu)];
  const parts=[];let last=0;
  for(const match of boundaries){
    cancelled(signal);const left=unit.text.slice(last,match.index),right=unit.text.slice(match.index+match[0].length);
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
  if(inside.length===2){const [a,b]=inside,join=block.text.slice(a.end,b.start);
    if(/^\s*(?:to|until|through|au|à|–|—|-)\s*$/iu.test(join)&&a.date&&b.date&&a.date<=b.date)
      return [{...a,raw:block.text.slice(a.start,b.end),end:b.end,dateEnd:b.date,range:true}];
  }
  if(inside.length)return inside;
  const nearby=all.filter(d=>d.end<=event.start&&event.start-d.end<260);
  if(!nearby.length){const at=source.blocks.indexOf(block),prev=source.blocks[at-1];
    if(prev&&!prev.quoted&&dateHeading(prev.text)){const d=dateCandidates(prev.text,anchor)[0];nearby.push({...d,blockId:prev.id,heading:true});}}
  return nearby;
}
export async function associateDate(source,block,event,decisions,signal){
  const dates=datePool(source,block,event),matches=[];
  // A sole temporal adjunct inside an already identified event is not a semantic
  // choice: 'on DATE', 'by DATE', or 'from DATE to DATE' has an exact address.
  // Merely seeing one date (for example 'the report dated DATE') is insufficient.
  if(dates.length===1){const d=dates[0],before=block.text.slice(event.start,d.start);
    if(d.blockId===block.id&&d.start>=event.start&&d.end<=event.end&&
       (/\b(?:on|by|from|since|until|le|au|du)\s*$/iu.test(before)||before.trim()===''))
      return resolvedDate(source,d,'explicit temporal adjunct');
  }
  for(let at=0;at<dates.length;at+=6){
    const group=dates.slice(at,at+6),criteria={unknown:'Not stated or ambiguous'};
    group.forEach((d,i)=>criteria[`d${i}`]=d.raw);
    const context=block.text.slice(Math.max(0,event.start-260),Math.min(block.text.length,event.end+100));
    const state=group.every(d=>d.blockId===block.id&&d.start>=event.start&&d.end<=event.end) ? event.text : `Event: ${event.text}\nPrevious context: ${context}\n${group.filter(d=>d.heading).map(d=>`Date heading: ${d.raw}`).join('\n')}`;
    const answer=await decisions.decide(state,{type:'choice',instructions:'Which supplied date belongs to the target event? Do not substitute the date of a document or a different event.',criteria},signal);
    const chosen=/^d(\d+)$/.exec(answer.choice);
    if(chosen&&group[+chosen[1]])matches.push({candidate:group[+chosen[1]],uncertain:entropyMargin(answer)<.15});
  }
  const distinct=[...new Map(matches.map(x=>[`${x.candidate.blockId}:${x.candidate.start}`,x])).values()];
  if(distinct.length!==1||distinct[0].uncertain)return {date:'',dateEnd:'',dateText:'',dateReason:dates.length?'Check which date belongs to this event.':'No event date stated.',dateOptions:dates};
  return {...resolvedDate(source,distinct[0].candidate,'model association'),dateOptions:dates};
}
function resolvedDate(source,d,basis){
  return {date:d.date||'',dateEnd:d.dateEnd||'',dateText:d.raw,dateReason:d.reason||(!d.date?'Invalid or incomplete date.':''),dateOptions:[d],dateBasis:basis,dateEvidence:{sourceId:source.id,blockId:d.blockId,start:d.start,end:d.end}};
}
export function createCatalogue(){return {engine:ENGINE_VERSION,mentions:[],omitted:[],scanned:[],pairs:{},events:[],separations:[]};}
function evidence(source,block,event){return {id:idFor(source,block,event.start,event.end),sourceId:source.id,blockId:block.id,start:event.start,end:event.end,quote:block.text.slice(event.start,event.end),communicated:source.communicated||'',quoted:Boolean(block.quoted),ocr:Boolean(block.ocr),locator:block.locator};}
export async function discoverEvents(sources,catalogue,decisions,{signal,onProgress=()=>{}}={}){
  const completed=new Set(catalogue.scanned),known=new Set(catalogue.mentions.map(m=>m.id));
  for(const source of sources)for(const block of source.blocks)for(const unit of sentenceUnits(block.text,source.language)){
    cancelled(signal);const unitId=idFor(source,block,unit.start,unit.end);if(completed.has(unitId))continue;
    const finding=await isEvent(unit.text,decisions,signal,source.language),added=[],omitted=[];
    if(finding.include){
      const parts=await eventSpans(unit,decisions,signal);
      // The separation judgment has already established distinct happenings in
      // their full sentence. Do not reject an elliptical child for lacking a subject.
      for(const part of parts){const ev=evidence(source,block,part),date=await associateDate(source,block,part,decisions,signal);
        added.push({...ev,...date,text:clean(part.text),uncertain:finding.uncertain,discoveryProbability:finding.probability});}
    }else omitted.push({...evidence(source,block,unit),probability:finding.probability});
    cancelled(signal);
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
  const q={type:'noul',instructions:'Do both passages describe the SAME specific event, with the same participants and outcome, rather than different or conflicting events?',criteria:{true:'Same specific happening',false:'Different, conflicting or uncertain'}};
  for(const [x,y]of [[a,b],[b,a]]){
    const r=await decisions.decide(`A: ${x.text}\nEvent date: ${x.date||'not stated'}\nB: ${y.text}\nEvent date: ${y.date||'not stated'}`,q,signal);
    if(yes(r)<.8)return false;
  }
  return true;
}
export async function collateEvents(catalogue,decisions,{signal,onProgress=()=>{}}={}){
  const groups=[],postings=new Map(),dates=new Map(),exact=new Map(),separate=new Set(catalogue.separations||[]);
  const previous=new Map(catalogue.events.filter(e=>!e.manual).map(e=>[e.mentionIds[0],e]));
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
      // Separately edited entries stay separate; do not discard either edit.
      if(previous.get(m.id)?.edited||group.members.some(x=>previous.get(x.id)?.excluded))continue;
      if(!(p in catalogue.pairs))catalogue.pairs[p]=await sameEvent(group.members[0],m,decisions,signal);
      if(catalogue.pairs[p]){selected=group;break;}
    }
    if(selected)selected.members.push(m);else{selected={index:groups.length,members:[m]};groups.push(selected);}
    const index=selected.index;
    for(const [map,k]of [[exact,key],...(m.date?[[dates,m.date]]:[])]){if(!map.has(k))map.set(k,new Set());map.get(k).add(index);}
    for(const t of tokens){if(!postings.has(t))postings.set(t,new Set());postings.get(t).add(index);}
    onProgress({phase:'collate',events:groups.length});await pause();
  }
  const events=groups.map(g=>{
    const first=g.members[0],old=previous.get(first.id),dated=g.members.find(m=>m.date)||first;
    return {id:first.id,mentionIds:g.members.map(m=>m.id),text:old?.edited?old.text:first.text,
      date:old?.edited?old.date:dated.date,dateEnd:old?.edited?old.dateEnd:dated.dateEnd,
      dateText:dated.dateText,dateReason:old?.edited?'':dated.dateReason,uncertain:g.members.some(m=>m.uncertain),
      note:old?.note||'',edited:Boolean(old?.edited),reviewed:Boolean(old?.reviewed),excluded:Boolean(old?.excluded)};
  });
  for(const e of catalogue.events)if(e.manual)events.push(e);
  catalogue.events=events;return events;
}
export async function makeChronology(sources,catalogue,decisions,options={}){
  await decisions.start();cancelled(options.signal);await discoverEvents(sources,catalogue,decisions,options);return collateEvents(catalogue,decisions,options);
}
export function ungroup(catalogue,event){for(let i=0;i<event.mentionIds.length;i++)for(let j=i+1;j<event.mentionIds.length;j++)catalogue.separations.push([event.mentionIds[i],event.mentionIds[j]].sort().join('\0'));}
export function eventOrder(a,b){return (a.date||'9999').localeCompare(b.date||'9999')||a.text.localeCompare(b.text)||a.id.localeCompare(b.id);}
export function validateCatalogue(catalogue,sources){
  if(catalogue.engine!==ENGINE_VERSION||!Array.isArray(catalogue.events)||!Array.isArray(catalogue.mentions)||!Array.isArray(catalogue.omitted))throw new Error('Unsupported chronology format.');
  const blocks=new Map(sources.flatMap(s=>s.blocks.map(b=>[`${s.id}:${b.id}`,b]))),ids=new Set();
  for(const m of [...catalogue.mentions,...catalogue.omitted]){
    const b=blocks.get(`${m.sourceId}:${m.blockId}`);
    if(!b||!Number.isInteger(m.start)||!Number.isInteger(m.end)||m.start<0||m.end<=m.start||m.end>b.text.length||b.text.slice(m.start,m.end)!==m.quote||ids.has(m.id))throw new Error('A chronology entry does not match its original source.');ids.add(m.id);
  }
  const mentions=new Set(catalogue.mentions.map(m=>m.id)),assigned=new Set(),events=new Set();
  for(const e of catalogue.events){
    if(events.has(e.id)||!Array.isArray(e.mentionIds))throw new Error('Duplicate or invalid chronology entry.');events.add(e.id);
    for(const id of e.mentionIds){if(!mentions.has(id)||assigned.has(id))throw new Error('A chronology entry has missing or duplicate sources.');assigned.add(id);}
  }
  return catalogue;
}
