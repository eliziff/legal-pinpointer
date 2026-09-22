(() => {
  if (globalThis.PinpointerLensPage) return;
  let blocks=[],revision=0,built=-1,stopped=false;const id=crypto.randomUUID();
  new MutationObserver(()=>{revision++;}).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','aria-hidden','class','style','open','inert']});
  async function collect(){
    stopped=false;if(built===revision)return {id,revision,count:blocks.length,title:document.title,url:location.href};
    if(document.contentType==='application/pdf')throw new Error('Import this PDF in Lens to search native text or OCR. Chrome’s built-in PDF viewer is not an HTML page.');
    const v=revision,root=document.querySelector('#originalDocument,#documentContent,#docCont')||document.body;
    if(!root)throw new Error('No document body.');const styles=new WeakMap(),output=[];let owner=null,current=null,visited=0;
    const visible=n=>{for(let p=n.parentElement;p&&p!==root.parentElement;p=p.parentElement){if(p.matches('script,style,noscript,template,input,textarea,select,[hidden],[aria-hidden="true"],[inert]')||p.isContentEditable)return false;let s=styles.get(p);if(!s){s=getComputedStyle(p);styles.set(p,s);}if(s.display==='none'||s.visibility==='hidden'||s.contentVisibility==='hidden')return false;}return true;};
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
    while(node=walker.nextNode()){
      if(stopped)throw new Error('Page scan cancelled.');if(revision!==v)throw new Error('Page changed during extraction; search again.');
      if(++visited%600===0)await new Promise(r=>setTimeout(r,0));if(!node.nodeValue.trim()||!visible(node))continue;
      const next=node.parentElement.closest('p,li,td,dd,dt,pre,blockquote,h1,h2,h3,h4,h5,h6,section,article,div')||root;
      if(next!==owner){owner=next;current={text:'',parts:[],locator:next.id?'#'+next.id:`Text block ${output.length+1}`};output.push(current);}
      const text=node.nodeValue.replace(/\s/g,' ');if(current.text&&!/\s$/.test(current.text)&&!/^\s/.test(text))current.text+=' ';
      current.parts.push({node,start:current.text.length,end:current.text.length+text.length});current.text+=text;
    }
    blocks=output;built=v;return {id,revision:v,count:blocks.length,title:document.title,url:location.href};
  }
  function slice(offset,count=64){if(built!==revision)throw new Error('Document changed. Search again.');return blocks.slice(offset,offset+count).map((b,i)=>({index:offset+i,text:b.text,locator:b.locator}));}
  function go(handle,index,start,end,expected){
    if(handle.id!==id||handle.revision!==revision||built!==revision)throw new Error('Stale document. Search again.');const b=blocks[index];if(!b||b.text.slice(start,end)!==expected)throw new Error('The passage no longer matches.');
    const first=b.parts.find(p=>p.end>start),last=[...b.parts].reverse().find(p=>p.start<end);if(!first||!last||!first.node.isConnected||!last.node.isConnected)throw new Error('Passage was removed.');
    const r=document.createRange();r.setStart(first.node,Math.max(0,start-first.start));r.setEnd(last.node,Math.min(last.node.length,end-last.start));
    if(CSS.highlights){if(!document.__lensSheet){const sheet=new CSSStyleSheet();sheet.replaceSync('::highlight(pinpointer-lens){background:#f2df8a;color:inherit}');document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];document.__lensSheet=sheet;}CSS.highlights.set('pinpointer-lens',new Highlight(r));}
    const rect=r.getBoundingClientRect();window.scrollBy({top:rect.top-window.innerHeight*.3,behavior:'instant'});return true;
  }
  globalThis.PinpointerLensPage={collect,slice,go,stop(){stopped=true;}};
})();
