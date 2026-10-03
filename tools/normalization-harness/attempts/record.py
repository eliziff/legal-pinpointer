#!/usr/bin/env python3
"""Append-only local experiment receipts; no parser or evaluator mutation."""
import argparse, datetime, difflib, hashlib, json, os, pathlib, subprocess
ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
SOURCES = ['legal-pinpointer/lens/src/core.mjs', 'legal-pinpointer/lens/test/core.test.mjs', 'legal-browser-ocr/text-layer.js', 'legal-browser-ocr/text-layer.test.mjs']
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def hashes(): return {p:digest(WORKSPACE/p) for p in SOURCES}
def append(row):
    row.update(time_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(), origin='machine_test', run_id=os.environ.get('NORMALIZATION_RUN_ID', 'machine_test-local'))
    with (ROOT/'attempts/ledger.jsonl').open('a') as f: f.write(json.dumps(row,sort_keys=True)+'\n')
p=argparse.ArgumentParser();p.add_argument('action',choices=['begin','finish']);p.add_argument('attempt');p.add_argument('--reason',required=True);p.add_argument('--decision');p.add_argument('--receipt');a=p.parse_args()
d=ROOT/'attempts'/a.attempt
if a.action=='begin':
    if d.exists(): raise SystemExit('Attempt already exists')
    d.mkdir()
    for s in SOURCES:
        target=d/'before'/s;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((WORKSPACE/s).read_bytes());target.chmod(0o444)
    append(dict(event='begin',attempt=a.attempt,reason=a.reason,source_hashes=hashes()))
else:
    if not d.exists(): raise SystemExit('Missing attempt start')
    patch=[]
    for s in SOURCES:
        before=(d/'before'/s).read_text().splitlines(keepends=True);after=(WORKSPACE/s).read_text().splitlines(keepends=True)
        patch.extend(difflib.unified_diff(before,after,fromfile='a/'+s,tofile='b/'+s))
    (d/'candidate.patch').write_text(''.join(patch))
    row=dict(event='finish',attempt=a.attempt,reason=a.reason,decision=a.decision,source_hashes=hashes(),patch_sha256=digest(d/'candidate.patch'))
    if a.receipt:
        receipt=pathlib.Path(a.receipt);row.update(receipt=str(receipt.relative_to(ROOT)),receipt_sha256=digest(receipt),result=json.loads(receipt.read_text()))
    append(row)
