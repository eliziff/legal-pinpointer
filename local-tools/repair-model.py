"""Remove an upstream two-candidate shape restriction; validate actual execution."""
import json, hashlib, time
from pathlib import Path
import numpy as np
import onnx
import onnxruntime as ort
from tokenizers import Tokenizer
p=Path('vendor/laya_int8.onnx')
m=onnx.load(str(p))
before={v.name:[d.dim_param or d.dim_value for d in v.type.tensor_type.shape.dim] for v in m.graph.input}
for v in list(m.graph.input)+list(m.graph.output):
    if v.name in ('marker_pos','marker_mask','logits'):
        v.type.tensor_type.shape.dim[1].ClearField('dim_value')
        v.type.tensor_type.shape.dim[1].dim_param='candidate_count'
# Intermediate shape annotations were traced with two options. Runtime operations
# must determine these sizes; changing annotations does not change trained weights.
del m.graph.value_info[:]
onnx.checker.check_model(m)
onnx.save(m,str(p))
opts=ort.SessionOptions();opts.intra_op_num_threads=2
session=ort.InferenceSession(str(p),opts,providers=['CPUExecutionProvider'])
tok=Tokenizer.from_file('vendor/tokenizer.json')
encode=lambda text:tok.encode(text,add_special_tokens=False).ids
cls,sep,mask=(tok.token_to_id(x) for x in ('[CLS]','[SEP]','[MASK]'))
rows=[]
for options in (['completed','scheduled'],['completed','scheduled','requested','denied'],['completed','intended','scheduled','requested','denied','conditional','deadline','unclear']):
    ids=[cls]+encode('choice question: Classify delivery on 13 March 2026.')+[sep]
    pos=[]
    for option in options:pos.append(len(ids));ids += [mask]+encode(' '+option)
    ids += [sep]+encode('The courier collected the notice on 10 March 2026. Delivery is scheduled for 13 March 2026.')+[sep]
    feeds={'input_ids':np.array([ids],np.int64),'attention_mask':np.ones((1,len(ids)),np.int64),'marker_pos':np.array([pos],np.int64),'marker_mask':np.ones((1,len(pos)),bool),'qtype':np.array([0],np.int64)}
    start=time.perf_counter()
    try:
        out=session.run(None,feeds)[0]
        assert out.shape==(1,len(options)),out.shape
        assert np.isfinite(out).all()
        rows.append({'candidates':len(options),'tokens':len(ids),'logits':out.tolist(),'seconds':time.perf_counter()-start})
    except Exception as e:
        print('MODEL VALIDATION FAILED',repr(e),flush=True)
        for n in m.graph.node[-55:]:
            print(n.op_type,n.name,list(n.input),list(n.output))
        Path('vendor/model-validation.json').write_text(json.dumps({'inputs_before':before,'results':rows,'error':str(e)},indent=2))
        raise
Path('vendor/model-validation.json').write_text(json.dumps({'inputs_before':before,'results':rows,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()},indent=2))
print(Path('vendor/model-validation.json').read_text())
