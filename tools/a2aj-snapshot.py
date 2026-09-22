"""Fetch all three published A2AJ repositories at pinned revisions. No sampling."""
import sys, os, json, hashlib, time, urllib.request, urllib.parse
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
BASE='https://huggingface.co'
def request(url):
    last=None
    for attempt in range(5):
        try:return urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Legal-Pinpointer-local-snapshot/1.0'}),timeout=180)
        except Exception as e:last=e;time.sleep(2**attempt)
    raise last
if sys.argv[1]=='inventory':
    manifest={'format':'a2aj-local-snapshot-v1','downloaded_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'repositories':[],'groups':[]}
    for name in ['canadian-case-law','canadian-laws','hansard']:
        meta=json.load(request(f'{BASE}/api/datasets/a2aj/{name}?blobs=true'))
        revision=meta['sha'];entries=meta['siblings']
        repo={'name':name,'revision':revision,'files':entries};manifest['repositories'].append(repo)
        groups=[];files=[];size=0
        for item in sorted(entries,key=lambda f:f['rfilename']):
            n=item.get('size',0)
            if files and size+n>350*1024**2:
                groups.append(files);files=[];size=0
            files.append(item);size+=n
        if files:groups.append(files)
        for i,items in enumerate(groups):manifest['groups'].append({'id':f'{name}-{i+1:02}','repository':name,'revision':revision,'files':items})
    Path('snapshot-manifest.json').write_text(json.dumps(manifest,indent=2))
    ids=[g['id'] for g in manifest['groups']]
    with open(os.environ['GITHUB_OUTPUT'],'a') as f:f.write('groups='+json.dumps(ids,separators=(',',':'))+'\n')
    print(json.dumps({'groups':ids,'bytes':sum(f.get('size',0) for r in manifest['repositories'] for f in r['files'])},indent=2))
else:
    manifest=json.loads(Path('snapshot-manifest.json').read_text());group=next(g for g in manifest['groups'] if g['id']==sys.argv[2]);root=Path('snapshot');root.mkdir(exist_ok=True)
    def download(item):
        rel=Path(item['rfilename'])
        if rel.is_absolute() or '..' in rel.parts:raise ValueError('Unsafe upstream path')
        dest=root/group['repository']/rel;dest.parent.mkdir(parents=True,exist_ok=True)
        url=f"{BASE}/datasets/a2aj/{group['repository']}/resolve/{group['revision']}/{urllib.parse.quote(item['rfilename'])}"
        expected=item.get('lfs',{}).get('sha256');last=None
        for attempt in range(5):
            try:
                h=hashlib.sha256();size=0
                with request(url) as r,open(str(dest)+'.partial','wb') as out:
                    while block:=r.read(2*1024**2):out.write(block);h.update(block);size+=len(block)
                if item.get('size') and size!=item['size']:raise ValueError(f'Size mismatch {rel}: {size}')
                if expected and h.hexdigest()!=expected:raise ValueError('SHA256 mismatch '+str(rel))
                os.replace(str(dest)+'.partial',dest)
                print(f'{rel} {size} {h.hexdigest()}',flush=True)
                return {'path':f"{group['repository']}/{rel.as_posix()}",'bytes':size,'sha256':h.hexdigest()}
            except Exception as e:last=e;time.sleep(2**attempt)
        raise last
    with ThreadPoolExecutor(max_workers=3) as pool:results=list(pool.map(download,group['files']))
    (root/(group['id']+'-manifest.json')).write_text(json.dumps({'repository':group['repository'],'revision':group['revision'],'files':results},indent=2))
    (root/'READ-ME.txt').write_text('A2AJ published snapshot. Extract all parts into the SAME folder; no files are sampled or omitted. Original filenames and bytes are preserved. Select the resulting folder in Pinpointer Lens. Source and upstream licences remain in dataset cards and each row. Unofficial legal reproductions: use their source links to inspect authoritative versions.\n')
