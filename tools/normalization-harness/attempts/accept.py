#!/usr/bin/env python3
"""Stricter keeper gate over frozen evaluator receipts; does not change any oracle."""
import argparse,copy,hashlib,json,pathlib,sys
ROOT=pathlib.Path(__file__).resolve().parents[1];WS=ROOT.parent
def regressions(old,new):
 before={r['id']:r for r in old['results']};after={r['id']:r for r in new['results']}
 return [key+':'+check for key,row in before.items() for check,value in row['checks'].items() if value and not after.get(key,{}).get('checks',{}).get(check,False)]
if '--self-test' in sys.argv:
 baseline=json.loads((ROOT/'evaluation/receipts/baseline.dev.json').read_text())
 assert not regressions(baseline,baseline)
 verified=0
 for check in baseline['results'][0]['checks']:
  probe=copy.deepcopy(baseline);row=next(r for r in probe['results'] if r['checks'][check]);row['checks'][check]=False;probe['score_tuple']=[100,800]
  assert regressions(baseline,probe),check
  verified+=1
 print(json.dumps({'baseline_replay_score':baseline['score_tuple'],'baseline_individual_check_regressions':0,'corrupted_check_types_rejected':verified,'equal_score_is_not_strict_gain':True}))
 sys.exit(0)
p=argparse.ArgumentParser();p.add_argument('attempt');p.add_argument('--candidate',type=pathlib.Path,required=True);p.add_argument('--incumbent',type=pathlib.Path,required=True);a=p.parse_args()
load=lambda p:json.loads(p.read_text());candidate=load(a.candidate);baseline=load(ROOT/'evaluation/receipts/baseline.dev.json');incumbent=load(a.incumbent);gates=load(ROOT/'attempts'/a.attempt/'gates.json');fail=[];comparisons={}
if not gates['pass_all']:fail.append('cheap regression gate failed')
if set(candidate['comparisons'])!={'baseline','incumbent'}:fail.append('both frozen evaluator comparisons required')
for name,old in [('baseline',baseline),('incumbent',incumbent)]:
 if any(candidate[k]!=old[k] for k in ['freeze_sha256','fixture_sha256','split','cases','checks_per_case']):fail.append(name+': incompatible receipt')
 before={r['id']:r for r in old['results']};after={r['id']:r for r in candidate['results']}
 if set(before)!=set(after):fail.append(name+': case identity mismatch')
 lostchecks=regressions(old,candidate)
 lostcases=sorted(set(old['successful_ids'])-set(candidate['successful_ids']))
 strict=candidate['score_tuple']>old['score_tuple']
 comparisons[name]={'lost_checks':lostchecks,'lost_success_ids':lostcases,'strict_gain':strict}
 if lostchecks or lostcases or not strict:fail.append(name+': strict gain / no regression constraint failed')
 if not candidate.get('comparisons',{}).get(name,{}).get('acceptable'):fail.append(name+': frozen evaluator rejected')
source_paths={'pinpointer/lens/src/core.mjs':WS/'legal-pinpointer/lens/src/core.mjs','ocr/text-layer.js':WS/'legal-browser-ocr/text-layer.js'}
actual={k:hashlib.sha256(p.read_bytes()).hexdigest() for k,p in source_paths.items()}
if actual!=candidate['source_hashes']:fail.append('current source differs from candidate evaluated source')
result={'accept':not fail,'score_tuple':candidate['score_tuple'],'constraints':comparisons,'failures':fail,'gate_receipt':str((ROOT/'attempts'/a.attempt/'gates.json').relative_to(ROOT)),'candidate_receipt':str(a.candidate),'source_hashes':actual}
(ROOT/'attempts'/a.attempt/'acceptance.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2));sys.exit(bool(fail))
