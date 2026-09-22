// Source offsets, dates, search grammar and export are independent of model inference.
export const norm = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('en-CA');
export const words = text => norm(text).match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) || [];
export const uid = () => crypto.randomUUID();
export const pause = () => new Promise(resolve => setTimeout(resolve, 0));
export const cancelled = signal => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); };
export const csvCell = value => '"' + (/^[=+@\-\t\r]/.test(String(value ?? '')) ? "'" : '') + String(value ?? '').replaceAll('"', '""') + '"';
export const csv = (head, rows) => '\ufeff' + [head, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
export const escapeHTML = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const sqlValue = text => "'" + String(text ?? '').replaceAll("'", "''") + "'";
export const sqlName = text => '"' + String(text).replaceAll('"', '""') + '"';

export function compileQuery(input) {
  const tokens = [], source = String(input).trim(); let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    if ('()'.includes(source[i])) { tokens.push({kind:source[i++]}); continue; }
    if (source[i] === '"') {
      const start = ++i; while (i < source.length && source[i] !== '"') i++;
      if (i === source.length) throw new Error('Close the quoted phrase.');
      const term = source.slice(start, i++); if (!term.trim()) throw new Error('A quoted phrase cannot be empty.');
      tokens.push({kind:'term', text:term, phrase:true}); continue;
    }
    const start=i; while(i<source.length && !/[\s()]/.test(source[i])) i++;
    const text=source.slice(start,i), upper=text.toUpperCase();
    if (['AND','OR','NOT'].includes(upper)) tokens.push({kind:upper});
    else { if (text.slice(0,-1).includes('*')) throw new Error('Use * only at the end of a word.'); tokens.push({kind:'term',text,phrase:false}); }
  }
  let at=0;
  function atom() {
    const t=tokens[at++]; if(!t) throw new Error('Missing a search term.');
    if(t.kind==='NOT') return {kind:'not',child:atom()};
    if(t.kind==='(') { const x=or(); if(tokens[at++]?.kind!==')') throw new Error('Close the search group.'); return x; }
    if(t.kind!=='term') throw new Error('Expected a word or quoted phrase.');
    const prefix=!t.phrase && t.text.endsWith('*'), parts=words(prefix?t.text.slice(0,-1):t.text);
    if(!parts.length) throw new Error('Search terms must contain a letter or number.');
    return {kind:'term',text:norm(t.text),parts,prefix,phrase:t.phrase};
  }
  function and() {
    let x=atom(); while(at<tokens.length && ![')', 'OR'].includes(tokens[at].kind)) { if(tokens[at].kind==='AND') at++; x={kind:'and',left:x,right:atom()}; } return x;
  }
  function or() { let x=and(); while(tokens[at]?.kind==='OR') { at++; x={kind:'or',left:x,right:and()}; } return x; }
  const tree=tokens.length?or():null; if(at!==tokens.length) throw new Error('Unexpected closing parenthesis.');
  const evaluate=(node, text, terms) => {
    if(!node) return true;
    if(node.kind==='and') return evaluate(node.left,text,terms)&&evaluate(node.right,text,terms);
    if(node.kind==='or') return evaluate(node.left,text,terms)||evaluate(node.right,text,terms);
    if(node.kind==='not') return !evaluate(node.child,text,terms);
    if(node.phrase || node.parts.length>1) return text.includes(node.text);
    return node.prefix ? terms.some(t=>t.startsWith(node.parts[0])) : terms.includes(node.parts[0]);
  };
  return {tree, test:text=>evaluate(tree,norm(text),words(text))};
}

export function passageWindows(text, maxChars=1800) {
  const result=[];
  const segmenter=new Intl.Segmenter('en',{granularity:'sentence'});
  let start=0, end=0;
  for(const segment of segmenter.segment(text)) {
    const s=segment.index, e=s+segment.segment.length;
    if(end>start && e-start>maxChars) { result.push({start,end,text:text.slice(start,end)}); start=s; }
    if(e-s>maxChars) {
      if(s>start) result.push({start,end:s,text:text.slice(start,s)});
      for(let p=s;p<e;p+=maxChars) result.push({start:p,end:Math.min(e,p+maxChars),text:text.slice(p,Math.min(e,p+maxChars)),split:true});
      start=e;
    }
    end=e;
  }
  if(end>start) result.push({start,end,text:text.slice(start,end)});
  return result;
}

export function* paragraphSpans(text) {
  let start=0;
  for(const match of text.matchAll(/\n\s*\n|\r?\n(?=\s*(?:\[\d+\]|\d+[.)]))/g)) {
    if(match.index>start)yield {start,end:match.index,text:text.slice(start,match.index)};
    start=match.index+match[0].length;
  }
  if(start<text.length)yield {start,end:text.length,text:text.slice(start)};
}

const monthNames=[['january','jan','janvier','janv'],['february','feb','février','fevrier','févr','fevr'],['march','mar','mars'],['april','apr','avril','avr'],['may','mai'],['june','jun','juin'],['july','jul','juillet','juil'],['august','aug','août','aout'],['september','sep','sept','septembre'],['october','oct','octobre'],['november','nov','novembre'],['december','dec','décembre','decembre','déc']];
const months=new Map(monthNames.flatMap((list,i)=>list.map(s=>[s,i+1])));
const monthRE=Array.from(months.keys()).sort((a,b)=>b.length-a.length).join('|');
const iso=(y,m,d)=> { const date=new Date(Date.UTC(y,m-1,d)); return date.getUTCFullYear()===y && date.getUTCMonth()===m-1 && date.getUTCDate()===d ? `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}` : null; };
export function dateCandidates(text, anchor=null) {
  const out=[];
  const add=(match,date,reason='',alternatives=[])=> {
    if(out.some(x=>match.index<x.end && match.index+match[0].length>x.start)) return;
    out.push({id:`d${match.index}`,start:match.index,end:match.index+match[0].length,raw:match[0],date,reason,alternatives});
  };
  for(const m of text.matchAll(/\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/g)) add(m,iso(+m[1],+m[2],+m[3]),'');
  for(const m of text.matchAll(/\b(\d{1,2})[\/-](\d{1,2})[\/-]((?:19|20)\d{2})\b/g)) {
    const a=iso(+m[3],+m[2],+m[1]), b=iso(+m[3],+m[1],+m[2]), choices=[...new Set([a,b].filter(Boolean))];
    add(m,choices.length===1?choices[0]:null,choices.length>1?'Ambiguous day/month order':choices.length?'':'Invalid calendar date',choices);
  }
  const patterns=[new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|er)?\\s+(${monthRE})\\.?\\s*,?\\s*((?:19|20)\\d{2})?`,'giu'),new RegExp(`\\b(${monthRE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*((?:19|20)\\d{2}))?`,'giu')];
  patterns.forEach((re,rev)=>{for(const m of text.matchAll(re)) {const d=+(rev?m[2]:m[1]),mon=months.get(norm(rev?m[1]:m[2])); add(m,m[3]?iso(+m[3],mon,d):null,m[3]?'':'Year not stated');}});
  for(const m of text.matchAll(/\b(today|yesterday|tomorrow|aujourd'hui|hier|demain)\b/giu)) {
    const offset={today:0,yesterday:-1,tomorrow:1,"aujourd'hui":0,hier:-1,demain:1}[norm(m[0])];
    const d=anchor && /^\d{4}-\d{2}-\d{2}$/.test(anchor)?new Date(anchor+'T12:00:00Z'):null;
    if(d) d.setUTCDate(d.getUTCDate()+offset);
    add(m,d?d.toISOString().slice(0,10):null,d?'Resolved from communication date; verify attribution':'Relative date without a reliable communication date');
  }
  return out.sort((a,b)=>a.start-b.start);
}

export function eventCandidates(source) {
  const out=[];
  for(const block of source.blocks) {
    const dates=dateCandidates(block.text, block.quoted?null:source.communicated);
    const sentences=[...new Intl.Segmenter(source.language||'en',{granularity:'sentence'}).segment(block.text)];
    for(const s of sentences) {
      const end=s.index+s.segment.length, ds=dates.filter(d=>d.start>=s.index && d.start<end);
      const occurrences=ds.length?ds:[null];
      for(const date of occurrences) out.push({id:uid(),sourceId:source.id,blockId:block.id,start:s.index,end,quote:s.segment.trim(),date:date?.date||'',dateText:date?.raw||'',dateReason:date?.reason||'',dateAlternatives:date?.alternatives||[],dateOffset:date?.start??null,communicated:source.communicated||'',status:'unreviewed',relevance:null,reviewed:false,note:'',quoted:Boolean(block.quoted),occurrences:[]});
    }
  }
  return out;
}

export function rowOrder(a,b) {
  return (a.date||'9999').localeCompare(b.date||'9999') || (a.communicated||'9999').localeCompare(b.communicated||'9999') || a.sourceId.localeCompare(b.sourceId)||a.start-b.start;
}
export const statuses={completed:'Reported completed',planned:'Planned / proposed',requested:'Requested',denied:'Denied',conditional:'Conditional',reported:'Reported / attributed',unclear:'Unclear',not_event:'Not an event',unreviewed:'Not yet judged'};
export function stateForEvent(row,source) {
  const block=source.blocks.find(b=>b.id===row.blockId);
  const from=Math.max(0,row.start-400),to=Math.min(block.text.length,row.end+400);
  return `Document: ${source.name}\nCommunication date: ${row.communicated||'not established'}\nAuthor: ${source.from||'not established'}\nQuoted earlier correspondence: ${row.quoted?'yes':'no'}\nContext:\n${block.text.slice(from,to)}\nTARGET SENTENCE: ${row.quote}\nTARGET DATE OCCURRENCE: ${row.dateText?`${row.dateText} (offset ${row.dateOffset-from} in context)`:'no explicit date in target sentence'}`;
}
