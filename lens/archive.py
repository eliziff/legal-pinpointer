"""Build the installable package with streaming native-zlib compression."""
import sys,zipfile,pathlib
repo=pathlib.Path(sys.argv[1]);target=pathlib.Path(sys.argv[2]);target.parent.mkdir(exist_ok=True,parents=True)
names=[p for p in repo.iterdir() if p.is_file() and p.suffix in {'.js','.html','.css','.json','.wasm','.tsv','.txt'} and p.name not in {'package.json','package-lock.json','runtime-validation.json'}]
names+=[p for p in (repo/'lens-dist').rglob('*') if 'test' not in p.relative_to(repo/'lens-dist').parts]
with zipfile.ZipFile(str(target)+'.tmp','w',zipfile.ZIP_DEFLATED,compresslevel=1,allowZip64=True) as z:
 for p in sorted(names):
  if p.is_file(): z.write(p,str(p.relative_to(repo)))
pathlib.Path(str(target)+'.tmp').replace(target)
print('Archived',target,target.stat().st_size,flush=True)
