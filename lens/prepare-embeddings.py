"""Reproduce the pinned, per-token INT8 Model2Vec table used by the browser."""
import hashlib,json,pathlib,sys,urllib.request
import numpy as np
from safetensors.numpy import load_file
from tokenizers import Tokenizer
root=pathlib.Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
repo='minishlab/potion-multilingual-128M';revision='73908c3438cf03b6a01bcb9611d62b23d0726f08'
expected={'model.safetensors':'14b5eb39cb4ce5666da8ad1f3dc6be4346e9b2d601c073302fa0a31bf7943397','tokenizer.json':'19f1909063da3cfe3bd83a782381f040dccea475f4816de11116444a73e1b6a1','config.json':'595e4cab2093732efd5dbe084fd5c1826b5eea693b73b4c1fd971672867d2e54','README.md':'9505454b6a3efbb25257124de875cb73e02bd663a822528525a3c29b1c4d91ac'}
sources=[]
for name,digest in expected.items():
 url=f'https://huggingface.co/{repo}/resolve/{revision}/{name}'
 with urllib.request.urlopen(url,timeout=600) as response,open(root/(name+'.tmp'),'wb') as out:
  while chunk:=response.read(1024*1024):out.write(chunk)
 temp=root/(name+'.tmp')
 with temp.open('rb') as f:actual=hashlib.file_digest(f,'sha256').hexdigest()
 if actual!=digest:raise RuntimeError('Unexpected published bytes: '+name)
 temp.replace(root/name);sources.append({'path':name,'sha256':digest,'bytes':(root/name).stat().st_size})
matrix=load_file(root/'model.safetensors')['embeddings'].astype(np.float32)
scales=np.maximum(np.max(np.abs(matrix),axis=1)/127,np.finfo(np.float32).tiny).astype('<f4')
quant=np.clip(np.rint(matrix/scales[:,None]),-127,127).astype('int8')
quant.tofile(root/'potion.i8');scales.tofile(root/'potion.scales')
tokenizer=Tokenizer.from_file(str(root/'tokenizer.json'));reference=[]
for text in ['A party is not responsible for loss caused by its own negligence.','The indemnity includes the protected party’s own negligent acts.','Notice takes effect when it is received, rather than sent.','The Minister discusses actual receipt of notice.','The courier collected the notice.','The indemnity does not cover losses caused by the indemnitee’s negligence.','L’avis prend effet à sa réception et non à son envoi.','Cette indemnité vise la négligence de la partie protégée.']:
 ids=[i for i in tokenizer.encode(text,add_special_tokens=False).ids if i!=tokenizer.token_to_id('[UNK]')]
 a=matrix[ids].mean(0);a/=max(np.linalg.norm(a),1e-12)
 b=(quant[ids].astype(np.float32)*scales[ids,None]).mean(0);b/=max(np.linalg.norm(b),1e-12)
 cosine=float(a@b)
 if cosine<.999:raise RuntimeError('Quantization fidelity failed')
 reference.append({'text':text,'ids':ids,'vector':b.tolist(),'fidelityCosine':cosine})
(root/'potion.json').write_text(json.dumps({'repository':repo,'revision':revision,'dimensions':matrix.shape[1],'vocabulary':matrix.shape[0],'tensor':'embeddings','config':json.loads((root/'config.json').read_text()),'quantization':'per-row symmetric int8 with float32 scale','minimumFixtureCosine':min(r['fidelityCosine'] for r in reference),'sources':sources},indent=2))
(root/'potion.reference.json').write_text(json.dumps(reference));(root/'model.safetensors').unlink()
print('Prepared and checked multilingual embeddings',flush=True)
