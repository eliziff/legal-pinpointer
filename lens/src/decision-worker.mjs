import * as ort from 'onnxruntime-web/wasm';
import { Tokenizer } from '@huggingface/tokenizers';
// Prompt layout follows upstream Laya and receptron/laya (MIT).
let session, tok, config, ids;
let lane = Promise.resolve();
const cache = new Map(), cancelled = new Set();
const qtypes = {choice: 0, score: 1, noul: 2};
const check = id => { if (cancelled.has(id)) throw new DOMException('Cancelled', 'AbortError'); };
const encode = s => tok.encode(String(s).split(ids.maskText).join(' '), {add_special_tokens: false}).ids;
function header(q) {
  if (!(q.type in qtypes)) throw new Error('Unsupported decision type.');
  const options = q.type === 'noul'
    ? ['false: '+(q.criteria?.false || 'no, the statement does not hold'), 'true: '+(q.criteria?.true || 'yes, the statement holds')]
    : q.type === 'score' ? q.criteria.map((x,i) => `level ${i}: ${x}`)
    : Object.entries(q.criteria).map(([k,v]) => v ? `${k}: ${v}` : k);
  if (!options.length || options.length > 20) throw new Error('Invalid decision options.');
  const seq = [ids.cls, ...encode(`${q.type} question: ${q.instructions}`), ids.sep], markers = [];
  for (const option of options) { markers.push(seq.length); seq.push(ids.mask, ...encode(' '+option)); }
  seq.push(ids.sep);
  if (seq.length > config.head_max_len || seq.length + 1 >= config.max_len)
    throw new Error('The question is too long. Please shorten it.');
  return {seq, markers, k: options.length};
}
function validate(feeds) {
  for (const m of session.inputMetadata) {
    const t = feeds[m.name];
    if (!m.isTensor || !t || t.type !== m.type || t.dims.length !== m.shape.length ||
        m.shape.some((n,i) => typeof n === 'number' && n !== t.dims[i]))
      throw new Error(`Laya input contract mismatch: ${m.name}; expected ${m.type}[${m.shape}], received ${t?.type}[${t?.dims}].`);
  }
}
async function run(h, data, q) {
  const seq = [...h.seq, ...data, ids.sep], k = h.k;
  if (seq.length > config.max_len) throw new Error('The passage exceeds the model context.');
  if (seq.some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('The packaged tokenizer returned an invalid token.');
  const feeds = {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(seq, BigInt), [1,seq.length]),
    attention_mask: new ort.Tensor('int64', new BigInt64Array(seq.length).fill(1n), [1,seq.length]),
    marker_pos: new ort.Tensor('int64', BigInt64Array.from(h.markers, BigInt), [1,k]),
    marker_mask: new ort.Tensor('bool', new Uint8Array(k).fill(1), [1,k]),
    qtype: new ort.Tensor('int64', BigInt64Array.of(BigInt(qtypes[q.type])), [1])
  };
  let out;
  try {
    validate(feeds);
    out = await session.run(feeds);
    if (!out.logits || out.logits.dims.length !== 2 || out.logits.dims[0] !== 1 || out.logits.dims[1] !== k)
      throw new Error('Laya returned an incompatible logits shape.');
    const logits = Array.from(out.logits.data);
    if (logits.length !== k || logits.some(x => !Number.isFinite(x))) throw new Error('Laya returned invalid scores.');
    const bucket = k <= 2 ? '2' : k <= 5 ? '3-5' : k <= 10 ? '6-10' : '11+';
    const temperature = config.temperature_by_options?.[`${q.type}:${bucket}`] ?? config.temperature?.[qtypes[q.type]] ?? config.temperature?.[q.type] ?? 1;
    if (!(temperature > 0) || !Number.isFinite(temperature)) throw new Error('Invalid packaged Laya temperature.');
    const max = Math.max(...logits), exp = logits.map(x => Math.exp((x-max)/temperature)), sum = exp.reduce((a,b) => a+b,0);
    const probs = exp.map(x => x/sum), best = probs.indexOf(Math.max(...probs));
    const keys = q.type === 'choice' ? Object.keys(q.criteria) : probs.map((_,i) => String(i));
    const sorted = [...probs].sort((a,b) => b-a);
    return {type: q.type, choice: keys[best], probabilities: Object.fromEntries(keys.map((key,i) => [key,probs[i]])),
      score: probs.reduce((s,p,i) => s+p*i,0), noul: probs[1], margin: sorted[0]-(sorted[1]||0), tokens: seq.length};
  } catch (e) {
    throw new Error(`Laya inference failed (${seq.length} tokens, ${k} options): ${e.message}`, {cause:e});
  } finally {
    for (const tensor of [...Object.values(feeds), ...Object.values(out || {})]) tensor.dispose();
  }
}
async function initialize(assets) {
  const read = async key => {
    const item = assets[key];
    if (item instanceof Blob) return item;
    if (!item) throw new Error(`Missing packaged asset: ${key}`);
    const r = await fetch(item);
    if (!r.ok) throw new Error(`Cannot read packaged ${key}: ${r.status}`);
    return r.blob();
  };
  const json = async key => JSON.parse(await (await read(key)).text());
  const [tokenizer,tc,c] = await Promise.all(['tokenizer.json','tokenizer_config.json','rl_agent_config.json'].map(json));
  config = c;
  if (!Number.isSafeInteger(c.max_len) || !Number.isSafeInteger(c.head_max_len) || c.head_max_len >= c.max_len || c.head_max_len < 8)
    throw new Error('Invalid packaged model configuration.');
  tok = new Tokenizer(tokenizer,tc);
  const special = (name,fallback) => {
    const text = typeof tc[name] === 'string' ? tc[name] : tc[name]?.content || fallback, id = tok.token_to_id(text);
    if (!Number.isSafeInteger(id)) throw new Error(`Missing ${name} in packaged tokenizer`);
    return [text,id];
  };
  const mask = special('mask_token','[MASK]');
  ids = {cls:special('cls_token','[CLS]')[1], sep:special('sep_token','[SEP]')[1], mask:mask[1], maskText:mask[0]};
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  const runtime = assets['ort-wasm-simd-threaded.mjs'];
  const runtimeURL = runtime instanceof Blob ? URL.createObjectURL(runtime) : runtime;
  try {
    ort.env.wasm.wasmPaths = {mjs:runtimeURL};
    ort.env.wasm.wasmBinary = await (await read('ort-wasm-simd-threaded.wasm')).arrayBuffer();
    session = await ort.InferenceSession.create(new Uint8Array(await (await read('model.onnx')).arrayBuffer()), {executionProviders:['wasm'],graphOptimizationLevel:'basic'});
    // Creating an ONNX session does not prove that its exported graph can run.
    for (const [state,q] of [
      ['A written notice was delivered.', {type:'noul',instructions:'Was notice delivered?',criteria:{false:'No',true:'Yes'}}],
      ['A written notice was delivered. '.repeat(16), {type:'score',instructions:'Relevance to delivery of notice?',criteria:['Unrelated','Vocabulary only','Relevant discussion','Direct answer']}]
    ]) await run(header(q),encode(state),q);
    cache.clear();
    return {model:'Laya multilingual INT8',maxTokens:config.max_len};
  } catch (e) {
    await session?.release(); session = null; throw e;
  } finally {
    if (runtime instanceof Blob) URL.revokeObjectURL(runtimeURL);
  }
}
async function decide(state,q) {
  if (!session) throw new Error('The search runtime is not ready.');
  const key = state+'\0'+JSON.stringify(q);
  if (cache.has(key)) return cache.get(key);
  const result = await run(header(q),encode(state),q);
  cache.set(key,result); if (cache.size > 512) cache.delete(cache.keys().next().value);
  return result;
}
async function rank({id,text,query,context=''}) {
  if (!session) throw new Error('The search runtime is not ready.');
  const q = {type:'noul',instructions:`Does the passage help answer this question? ${query}`,
    criteria:{false:'Not relevant',true:'Relevant'}};
  const h = header(q), prefix = encode(context ? `Document context: ${context}\nSource passage:\n` : 'Source passage:\n').slice(0,96);
  const tokens = encode(text), budget = config.max_len-h.seq.length-prefix.length-1;
  if (budget < 32) throw new Error('The question is too long. Please shorten it.');
  let best = null, windows = 0;
  const step = budget-Math.min(64,Math.floor(budget/4));
  for (let start=0; start<tokens.length || !windows; start+=step) {
    await new Promise(resolve => setTimeout(resolve,0));
    check(id);
    const result = await run(h,[...prefix,...tokens.slice(start,start+budget)],q);
    windows++;
    if (!best || result.score > best.score) best = result;
    if (start+budget >= tokens.length) break;
  }
  check(id);
  return {...best,windows};
}
self.onmessage = ({data}) => {
  if (data.type === 'cancel') { cancelled.add(data.id); return; }
  lane = lane.catch(() => {}).then(async () => {
    try {
      check(data.id);
      const result = data.type === 'init' ? await initialize(data.assets)
        : data.type === 'rank' ? await rank(data)
        : data.type === 'decide' ? await decide(data.state,data.question)
        : (() => { throw new Error('Unknown model operation'); })();
      check(data.id); postMessage({id:data.id,result});
    } catch (e) { postMessage({id:data.id,error:e.message,name:e.name}); }
    finally { cancelled.delete(data.id); }
  });
};
