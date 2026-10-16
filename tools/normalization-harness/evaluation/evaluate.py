#!/usr/bin/env python3
"""Frozen exact-output evaluator. No candidate-derived fixture expectations."""
import argparse, collections, datetime, hashlib, json, os, pathlib, subprocess, sys, time
ROOT=pathlib.Path(__file__).resolve().parent
CHECKS=('execution_success','exact_output','expected_count','source_preservation','valid_utf16','unicode_hex_exact','protected_text','family_count_invariant')
HARD=('source_preservation','valid_utf16','protected_text')

def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def load(p): return json.loads(p.read_text())
def u16bytes(s): return s.encode('utf-16-le','surrogatepass')
def u16len(s): return len(u16bytes(s))//2
def u16slice(s,a,b): return u16bytes(s)[a*2:b*2].decode('utf-16-le','surrogatepass')
def valid(s): return not any(0xD800<=ord(c)<=0xDFFF for c in s)
def strings(x):
    if isinstance(x,str): yield x
    elif isinstance(x,list):
        for v in x: yield from strings(v)
    elif isinstance(x,dict):
        for v in x.values(): yield from strings(v)
def count(value,op):
    if op=='normalization': return len(value['words'])
    return len(value)
def exact_projection(value,op):
    # The split metadata is an implementation hint; source spans/text define exact output.
    if op in ['paragraph','passage']:
        return [{k:row[k] for k in ['start','end','text']} for row in value]
    return value

def preservation(case,value):
    op=case['operation']; text=case['text']
    if op in ['paragraph','passage']:
        end=0; output=[]
        for span in value:
            a,b=span.get('start'),span.get('end')
            if not isinstance(a,int) or not isinstance(b,int) or not 0<=a<b<=u16len(text) or a<end:return False
            gap=u16slice(text,end,a)
            if op=='passage' and gap:return False
            if op=='paragraph' and gap.strip():return False
            if u16slice(text,a,b)!=span.get('text'):return False
            if not valid(span['text']):return False
            if op=='passage' and b-a>case['max_chars']:return False
            output.append(span['text']);end=b
        remainder=u16slice(text,end,u16len(text))
        return not remainder if op=='passage' else not remainder.strip()
    if op=='normalization':
        return value.get('norm')==case['expected']['norm'] and all(valid(w) for w in value.get('words',[]))
    if op=='clean':return value==case['expected']
    if op=='positioned':
        # Geometry and text are separately observable; source fidelity checks exact line text.
        return [r.get('text') for r in value]==[r['text'] for r in case['expected']]
    return False

def protection(case,value):
    op=case['operation']
    if op in ['paragraph','passage']:
        # Reconstruct the indexed source, retaining delimiter gaps for exact protected spans.
        source=case['text']; result=''; end=0
        for row in value:
            a,b=row['start'],row['end']
            gap=u16slice(source,end,a)
            result+=(gap if not gap.strip() else '')+row['text'];end=b
        tail=u16slice(source,end,u16len(source))
        result+=tail if not tail.strip() else ''
        target=source
    elif op=='positioned':result='\n'.join(x['text'] for x in value);target='\n'.join(x['text'] for x in case['expected'])
    elif op=='clean':result=value;target=case['expected']
    else:return True
    return all(result.count(p)==target.count(p) for p in case['protected'])

def score(cases,responses):
    results=[]; byid={r.get('id'):r for r in responses}; response_counts=collections.Counter(r.get('id') for r in responses)
    families=collections.defaultdict(list)
    for c in cases:
        r=byid.get(c['id'],{});checks=dict.fromkeys(CHECKS,False);value=r.get('value');checks['execution_success']=bool(r.get('ok') and response_counts[c['id']]==1 and r.get('run_id')==c['run_id'])
        if checks['execution_success']:
            try:
                checks['exact_output']=exact_projection(value,c['operation'])==exact_projection(c['expected'],c['operation'])
                checks['expected_count']=count(value,c['operation'])==c['expected_count']
                checks['source_preservation']=preservation(c,value)
                checks['valid_utf16']=all(valid(s) for s in strings(value))
                checks['unicode_hex_exact']=r.get('unicode_hex')==c['unicode_hex']
                checks['protected_text']=protection(c,value)
            except (KeyError,IndexError,TypeError,ValueError,UnicodeError):pass
        results.append({'id':c['id'],'family':c['family'],'operation':c['operation'],'checks':checks,'failures':[k for k,v in checks.items() if not v]})
        families[c['family']].append((c,value,results[-1]))
    for rows in families.values():
        invariant=all(row[0]['count_invariant'] for row in rows)
        try: ok=not invariant or len({count(v,c['operation']) for c,v,r in rows})==1
        except (KeyError,TypeError):ok=False
        for c,value,r in rows:
            r['checks']['family_count_invariant']=ok
            r['failures']=[k for k,v in r['checks'].items() if not v]
            r['passed']=not r['failures']
    return results

def freeze_verify():
    manifest=load(ROOT/'freeze.json');bad=[]
    for name,expected in manifest['files'].items():
        p=ROOT/name
        if not p.exists() or digest(p)!=expected:bad.append(name)
    if bad:raise SystemExit('Frozen evaluator/fixture hash mismatch: '+', '.join(bad))
    return manifest

def source_hashes():
    ws=ROOT.parent.parent
    roots={'pinpointer':pathlib.Path(os.environ.get('EVAL_PINPOINTER_ROOT',ws/'legal-pinpointer')),'ocr':pathlib.Path(os.environ.get('EVAL_OCR_ROOT',ws/'legal-browser-ocr'))}
    paths={'pinpointer/lens/src/core.mjs':roots['pinpointer']/'lens/src/core.mjs','ocr/text-layer.js':roots['ocr']/'text-layer.js'}
    return {name:digest(p) for name,p in paths.items()}

def transport_selftest():
    values=['é', '𐐀😀', 'x\u2028y\u2029z', 'a\r\nb', 'c\rd', 'soft\u00adhyphen']
    program="const r=require('node:readline').createInterface({input:process.stdin,crlfDelay:Infinity}); r.on('line',x=>process.stdout.write(JSON.stringify(JSON.parse(x)).replace(/[\\u2028\\u2029]/g,c=>'\\\\u'+c.charCodeAt(0).toString(16))+'\\n'));"
    output=subprocess.run(['node','-e',program],input=''.join(json.dumps(x,ensure_ascii=True)+'\n' for x in values),text=True,capture_output=True,check=True)
    assert [json.loads(x) for x in output.stdout.split('\n') if x]==values

def selftest(include_sealed=False):
    transport_selftest()
    total=0
    for path in [ROOT/'dev.json']+([ROOT/'sealed/holdout.json'] if include_sealed else []):
        cases=load(path)
        assert len({r['id'] for r in cases})==len(cases)
        assert all(sum(r['family']==f for r in cases)==5 for f in {r['family'] for r in cases})
        assert all(c['max_chars']>=2 for c in cases if c['operation']=='passage')
        ideal=[{'id':c['id'],'run_id':c['run_id'],'ok':True,'value':c['expected'],'unicode_hex':c['unicode_hex']} for c in cases]
        scored=score(cases,ideal)
        assert all(r['passed'] for r in scored),[r for r in scored if not r['passed']]
        total+=len(cases)
    # Reject corrupted scalar, source coordinate and protected quote outputs.
    probe={'id':'probe','family':'probe','operation':'paragraph','text':'[1] “Québec 😀”','expected':[{'start':0,'end':15,'text':'[1] “Québec 😀”'}],'protected':['“Québec 😀”']}
    assert not preservation(probe,[{'start':0,'end':5,'text':'wrong'}])
    assert not valid('\ud83d')
    print(json.dumps({'selftest':'passed','ideal_cases':total,'checks_per_case':len(CHECKS)}))

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--source-root',type=pathlib.Path);ap.add_argument('--split',choices=['dev','holdout'],default='dev');ap.add_argument('--label');ap.add_argument('--reference',type=pathlib.Path);ap.add_argument('--incumbent',type=pathlib.Path);ap.add_argument('--self-test',action='store_true');ap.add_argument('--verify-freeze',action='store_true');ap.add_argument('--sealed-authorized',action='store_true');args=ap.parse_args()
    if args.self_test:selftest(args.sealed_authorized);return
    if args.source_root:
        os.environ['EVAL_PINPOINTER_ROOT']=str((args.source_root/'legal-pinpointer').resolve())
        os.environ['EVAL_OCR_ROOT']=str((args.source_root/'legal-browser-ocr').resolve())
    manifest=freeze_verify()
    if args.verify_freeze:print(json.dumps({'freeze_verified':True,'freeze_sha256':digest(ROOT/'freeze.json')}));return
    if not args.label or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in args.label):raise SystemExit('Supply a unique simple --label')
    if args.split=='holdout' and not args.sealed_authorized:raise SystemExit('SEALED: only evaluator owner may run baseline once and selected final incumbent once')
    path=ROOT/('dev.json' if args.split=='dev' else 'sealed/holdout.json');cases=load(path)
    directory=ROOT/('receipts' if args.split=='dev' else 'sealed/receipts');directory.mkdir(exist_ok=True)
    out=directory/f'{args.label}.{args.split}.json'
    if out.exists():raise SystemExit('Receipt already exists; never overwrite baseline or candidate evidence')
    requests=[{k:v for k,v in c.items() if k in ['id','run_id','submission_origin','operation','text','max_chars','lines','texts']} for c in cases]
    before=source_hashes();started=time.monotonic()
    try:
        process=subprocess.run(['node',str(ROOT/'runner.mjs')],input=''.join(json.dumps(r,ensure_ascii=True)+'\n' for r in requests),capture_output=True,text=True,timeout=30)
        if process.returncode:raise SystemExit('Runner failed: '+process.stderr)
        responses=[json.loads(line) for line in process.stdout.split('\n') if line]
        if collections.Counter(r.get('id') for r in responses)!=collections.Counter(c['id'] for c in cases):raise SystemExit('Invalid JSONL transport: response identifiers/count differ from requests')
    except subprocess.TimeoutExpired:raise SystemExit('Evaluation exceeded frozen 30-second timeout; no valid receipt')
    after=source_hashes()
    if before!=after:raise SystemExit('Production source changed during evaluation; invalid receipt')
    results=score(cases,responses);success=[r['id'] for r in results if r['passed']]
    points=sum(sum(r['checks'].values()) for r in results)
    receipt={'schema':'independent-legal-js-eval-v2','run_id':cases[0]['run_id'],'submission_origin':'machine_test','label':args.label,'split':args.split,'created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_hashes':before,'freeze_sha256':digest(ROOT/'freeze.json'),'fixture_sha256':digest(path),'cases':len(cases),'families':len({c['family'] for c in cases}),'checks_per_case':len(CHECKS),'passed':len(success),'failed':len(cases)-len(success),'check_points':points,'check_points_max':len(cases)*len(CHECKS),'score_tuple':[len(success),points],'exact_rate':len(success)/len(cases),'successful_ids':success,'elapsed_seconds':round(time.monotonic()-started,6),'results':results}
    comparisons={}
    for name,ref in [('baseline',args.reference),('incumbent',args.incumbent)]:
        if ref:
            old=load(ref)
            if old['split']!=args.split or old['fixture_sha256']!=receipt['fixture_sha256'] or old['freeze_sha256']!=receipt['freeze_sha256']:raise SystemExit('Incompatible reference receipt')
            oldrows={r['id']:r for r in old['results']}
            lost=sorted(set(old['successful_ids'])-set(success));invariants=[]
            for row in results:
                for check in HARD:
                    if oldrows[row['id']]['checks'][check] and not row['checks'][check]:invariants.append(row['id']+':'+check)
            comparisons[name]={'reference':str(ref),'lost_success_ids':lost,'hard_invariant_regressions':invariants,'strict_score_gain':receipt['score_tuple']>old['score_tuple'],'nondecreasing_exact':receipt['passed']>=old['passed'],'acceptable':not lost and not invariants and receipt['passed']>=old['passed'] and receipt['score_tuple']>old['score_tuple']}
    receipt['comparisons']=comparisons
    # Detailed raw outputs remain local; developer split is intentionally inspectable.
    (directory/f'{args.label}.{args.split}.outputs.json').write_text(json.dumps(responses,ensure_ascii=True,indent=2)+'\n')
    out.write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
    summary={k:receipt[k] for k in ['label','split','cases','families','passed','failed','score_tuple','exact_rate','elapsed_seconds','source_hashes']}
    summary.update({'receipt':str(out.relative_to(ROOT.parent)),'comparisons':comparisons})
    print(json.dumps(summary,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
