#!/usr/bin/env python3
"""Run the frozen cheap syntax and existing-suite regression gate."""
import argparse,datetime,hashlib,json,os,pathlib,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parents[1];WORKSPACE=ROOT.parent
p=argparse.ArgumentParser();p.add_argument('attempt');a=p.parse_args();out=ROOT/'attempts'/a.attempt;out.mkdir(exist_ok=True)
loader=str(ROOT/'inventory/existing-node-packages.mjs')
commands=[('pinpointer-syntax','legal-pinpointer',['node','--check','lens/src/core.mjs']),('ocr-syntax','legal-browser-ocr',['node','--check','text-layer.js']),('pinpointer-unit','legal-pinpointer',['node','--import',loader,'--test','lens/test/core.test.mjs','lens/test/chronology.test.mjs','lens/test/zip.test.mjs']),('ocr-unit','legal-browser-ocr',['node','--import',loader,'--test',*[str(x.relative_to(WORKSPACE/'legal-browser-ocr')) for x in sorted((WORKSPACE/'legal-browser-ocr').glob('*.test.mjs'))]])]
rows=[]
for label,repo,argv in commands:
 t=time.monotonic();done=subprocess.run(argv,cwd=WORKSPACE/repo,capture_output=True,text=True,timeout=45)
 log=out/(label+'.txt');log.write_text(done.stdout+done.stderr)
 rows.append(dict(label=label,argv=argv,cwd=repo,exit_code=done.returncode,seconds=round(time.monotonic()-t,3),output=str(log.relative_to(ROOT)),output_sha256=hashlib.sha256(log.read_bytes()).hexdigest()))
result=dict(origin='machine_test',run_id=os.environ.get('NORMALIZATION_RUN_ID', 'machine_test-local'),time_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),pass_all=all(x['exit_code']==0 for x in rows),checks=rows)
(out/'gates.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
raise SystemExit(0 if result['pass_all'] else 1)
