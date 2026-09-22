const core=()=>globalThis.LegalPinpointerCore;
const esc=value=>core().escapeHtml(String(value??''));
export function textLink(url,whole,start,end) {
  const target=new URL(url);if(!['http:','https:'].includes(target.protocol))throw new Error('The source has no web link.');
  const encode=s=>encodeURIComponent(s).replace(/-/g,'%2D');
  const clean=s=>s.replace(/\s+/g,' ').trim(),quote=clean(whole.slice(start,end));
  const prefix=clean(whole.slice(Math.max(0,start-180),start)).split(/\s+/).slice(-8).join(' ');
  const suffix=clean(whole.slice(end,end+180)).split(/\s+/).slice(0,8).join(' ');
  target.hash=':~:text='+(prefix?encode(prefix)+'-,':'')+encode(quote)+(suffix?',-'+encode(suffix):'');
  return target.href;
}
export function externalCopy(item,whole,mode,options={}) {
  const c=core(),us=item.unitStart??item.start,ue=item.unitEnd??item.end;
  const start=options.extent==='match'?item.start+(item.focus?.start||0):us;
  const end=options.extent==='match'?item.start+(item.focus?.end??item.text.length):ue;
  const quote=whole.slice(start,end),citation=c.makeCitation(item.documentType||'secondary',item.title||'',item.citation||'');
  let target=item.url;
  if(target){const u=new URL(target);if(!['http:','https:'].includes(u.protocol))throw new Error('Invalid source URL.');
    if(options.link==='text')target=textLink(target,whole,start,end);
    else if(/(^|\.)canlii\.org$/.test(u.hostname)&&item.locator)target=c.withFragment(target,c.canliiAnchorForLocator(item.kind,item.locator));
  }
  const link=(label,html=esc(label))=>target?`<a href="${esc(target)}">${html}</a>`:html;
  if(mode==='link'){if(!target)throw new Error('This record has no source URL.');return {plain:target,html:link(target)};}
  const cite=target?c.outputCitationLink(citation,item.url):{plain:citation.plain,html:citation.html};
  if(mode==='citation')return cite;
  const pin=item.locator?c.formatPinpoint(item.kind,[item.locator],options.wording||'full'):'';
  if(mode==='pinpoint')return pin?{plain:pin,html:link(pin)}:{plain:'[Link]',html:link('[Link]')};
  const marker=item.kind==='paragraph'&&item.locator?`[${item.locator}]`:pin||'[Link]';
  const stripped=quote.replace(item.kind==='paragraph'?new RegExp('^\\s*\\['+item.locator.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\]\\s*'):/^$/,'');
  const body=(start>us?'… ':'')+stripped;
  const q={plain:`${marker}${item.locator?' ':': '}${body}`,html:`<p>${link(marker)}${item.locator?' ':': '}${esc(body).replace(/\n/g,'<br>')}</p>`};
  if(mode==='quote')return q;
  return {plain:`${cite.plain}${pin?' '+pin:''}\n${q.plain}`,html:`<p>${cite.html}${pin?' '+link(pin):''}</p>${q.html}`};
}
export async function writeClipboard(payloadPromise) {
  const value=Promise.resolve(payloadPromise);
  if(globalThis.ClipboardItem&&navigator.clipboard?.write){
    await navigator.clipboard.write([new ClipboardItem({'text/plain':value.then(p=>new Blob([p.plain],{type:'text/plain'})),
      'text/html':value.then(p=>new Blob([p.html],{type:'text/html'}))})]);
  }else await navigator.clipboard.writeText((await value).plain);
}
