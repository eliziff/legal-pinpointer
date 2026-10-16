import test from 'node:test';import assert from 'node:assert/strict';
import {compileQuery,dateCandidates,eventCandidates,passageWindows,csv,paragraphSpans} from '../src/core.mjs';
test('Boolean retrieval, phrases and prefixes retain negation and French text',()=>{assert.equal(compileQuery('indemni* AND (negligence OR négligence)').test('indemnité pour sa propre négligence'),true);assert.equal(compileQuery('receipt NOT dispatch').test('receipt following dispatch'),false);assert.equal(compileQuery('"own negligence"').test('own negligence'),true);assert.throws(()=>compileQuery('a OR'));assert.throws(()=>compileQuery('"open'));});
test('Date occurrences remain distinct; ambiguity is not guessed',()=>{const d=dateCandidates('Sent 10 March 2026, scheduled 13 March 2026; denied on 13 March 2026.');assert.deepEqual(d.map(x=>x.date),['2026-03-10','2026-03-13','2026-03-13']);assert.equal(new Set(d.map(x=>x.id)).size,3);assert.equal(dateCandidates('03/04/2026')[0].date,null);assert.deepEqual(dateCandidates('03/04/2026')[0].alternatives,['2026-04-03','2026-03-04']);assert.equal(dateCandidates('31/03/2026')[0].date,'2026-03-31');assert.equal(dateCandidates('10 mars 2026')[0].date,'2026-03-10');assert.equal(dateCandidates('March 10')[0].date,null);assert.equal(dateCandidates('yesterday','2026-03-12')[0].date,'2026-03-11');});
test('Chronology does not substitute sent date for event date',()=>{const [a,b]=eventCandidates({id:'s',communicated:'2026-03-12',blocks:[{id:'b',text:'Collected on 10 March 2026. Delivery is scheduled for 13 March 2026.'}]});assert.equal(a.date,'2026-03-10');assert.equal(b.date,'2026-03-13');assert.equal(a.communicated,'2026-03-12');assert.equal(b.status,'unreviewed');});
test('Long text is covered without silently dropping characters',()=>{const text='x'.repeat(6000);const p=passageWindows(text,1800);assert.equal(p.map(x=>x.text).join(''),text);assert.equal(p[0].start,0);assert.equal(p.at(-1).end,text.length);});
test('CSV safely escapes active spreadsheet cells and literal quotes',()=>{const value=csv(['Text'],[['=HYPERLINK("https://example.invalid")']]);assert.match(value,/'=HYPERLINK/);assert.match(value,/""https/);});
test('paragraph addresses preserve separators and duplicate occurrences',()=>{const text='Same text.\n\nSame text.\n[3] Third.';const p=[...paragraphSpans(text)];assert.deepEqual(p.map(x=>x.start),[0,12,23]);for(const x of p)assert.equal(text.slice(x.start,x.end),x.text);});

test('paragraph separators preserve complete CRLF and Unicode source boundaries',()=>{
  const first='Québec 🦫 — « pièce E\u0301 ».', last='The orchard register remains sealed.';
  for(const separator of ['\n\n','\r\n\r\n','\r\r','\u2028\u2028','\u2029','\r\n \t\u00a0\r\n']) {
    const text=first+separator+last;
    assert.deepEqual([...paragraphSpans(text)],[
      {start:0,end:first.length,text:first},
      {start:first.length+separator.length,end:text.length,text:last},
    ]);
  }
  const wrapped=first+'\r\n'+last;
  assert.deepEqual([...paragraphSpans(wrapped)],[{start:0,end:wrapped.length,text:wrapped}]);
});

test('numbered paragraphs work across line endings and retain indentation',()=>{
  const paragraphs=['[7] The orchard lease is renewed.','\u202f8. Les frais sont réservés.','\t9) The register is closed.'];
  for(const separator of ['\n','\r\n','\r','\u2028']) {
    const text=paragraphs.join(separator), spans=[...paragraphSpans(text)];
    assert.deepEqual(spans.map(span=>span.text),paragraphs);
    for(const span of spans)assert.equal(text.slice(span.start,span.end),span.text);
  }
});

test('consecutive dotted sections remain distinct while wrapped decimals stay in prose',()=>{
  const sections=['4.1 The orchard lease begins.','4.2 Le registre demeure accessible.','4.3 The schedule ends.'];
  for(const separator of ['\n','\r\n','\r','\u2028']) {
    const text=sections.join(separator);
    assert.deepEqual([...paragraphSpans(text)].map(span=>span.text),sections);
  }
  for(const continuation of ['12.4 of the orchard regulation.','8.625 hectares were recorded.','2.apples were mentioned.']) {
    const text='The register refers to\n'+continuation;
    assert.deepEqual([...paragraphSpans(text)],[{start:0,end:text.length,text}]);
  }
});

test('passage windows preserve supplementary scalars and contiguous UTF-16 offsets',()=>{
  const text='A😀BC🦫D', windows=passageWindows(text,3);
  assert.deepEqual(windows,[
    {start:0,end:3,text:'A😀',split:true},
    {start:3,end:5,text:'BC',split:true},
    {start:5,end:8,text:'🦫D',split:true},
  ]);
  assert.equal(windows.map(window=>window.text).join(''),text);
  for(const window of windows)assert.equal(text.slice(window.start,window.end),window.text);
  assert.deepEqual(passageWindows('A😀B',2).map(window=>window.text),['A','😀','B']);
  assert.deepEqual(passageWindows('😀A',1).map(window=>window.text),['😀','A']);
});

test('passage budgets retain combining scalars and sentence boundaries without normalizing text',()=>{
  assert.deepEqual(passageWindows('ABe\u0301CD',3),[
    {start:0,end:3,text:'ABe',split:true},
    {start:3,end:6,text:'\u0301CD',split:true},
  ]);
  assert.deepEqual(passageWindows('First. Next.',9),[
    {start:0,end:7,text:'First. '},
    {start:7,end:12,text:'Next.'},
  ]);
});

test('invalid passage budgets fail instead of leaving a non-advancing split loop',()=>{
  for(const limit of [0,-1,1.5,NaN,Infinity])assert.throws(()=>passageWindows('Orchard record',limit),RangeError);
});

test('physical line wraps do not restart long passage windows',()=>{
  for(const separator of ['\n','\r\n','\r','\u2028']) {
    const text=['Orchard records','stay sealed','until review'].join(separator);
    const windows=passageWindows(text,12);
    assert.deepEqual(windows.map(({start,end})=>[start,end]),[[0,12],[12,24],[24,36],[36,text.length]]);
    assert.equal(windows.map(window=>window.text).join(''),text);
    for(const window of windows) {
      assert.equal(window.text,text.slice(window.start,window.end));
      assert.equal(window.split,true);
    }
  }
});

test('passage detection retains punctuation and explicit paragraph breaks',()=>{
  assert.deepEqual(passageWindows('First.\r\nSecond.',9),[
    {start:0,end:8,text:'First.\r\n'},
    {start:8,end:15,text:'Second.'},
  ]);
  for(const separator of ['\n\n','\r\n \t\r\n','\r\r','\u2028\u2028','\u2029']) {
    const first='Orchard records'+separator, last='stay sealed', text=first+last;
    assert.deepEqual(passageWindows(text,24),[
      {start:0,end:first.length,text:first},
      {start:first.length,end:text.length,text:last},
    ]);
  }
});
