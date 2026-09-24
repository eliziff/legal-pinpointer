// Scores chronology rows with the small fine-tuned classifier (arctic-embed-xs, int8 ONNX, trained on
// the court-record-exhibits benchmark): the probability that a found row is an event a litigator puts
// in the chronology. Input text is "<document title> | <date or undated> | <row text>", 128 tokens.
import * as ort from 'onnxruntime-web/wasm';
import {Tokenizer} from '@huggingface/tokenizers';

let session = null, tok = null, config = null;
async function initialize(assets) {
  const read = async key => { const item = assets[key]; if (item instanceof Blob) return item; const r = await fetch(item); if (!r.ok) throw new Error(`Cannot read packaged ${key}`); return r.blob(); };
  const json = async key => JSON.parse(await (await read(key)).text());
  config = await json('rowmodel.json');
  tok = new Tokenizer(await json('rowmodel-tokenizer.json'), await json('rowmodel-tokenizer_config.json'));
  ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
  const runtime = assets['ort-wasm-simd-threaded.mjs'];
  ort.env.wasm.wasmPaths = {mjs: runtime instanceof Blob ? URL.createObjectURL(runtime) : runtime};
  ort.env.wasm.wasmBinary = await (await read('ort-wasm-simd-threaded.wasm')).arrayBuffer();
  session = await ort.InferenceSession.create(new Uint8Array(await (await read('rowmodel.onnx')).arrayBuffer()), {executionProviders: ['wasm'], graphOptimizationLevel: 'all'});
  return {threshold: config.threshold};
}
async function score(texts) {
  const out = [];
  for (const text of texts) {
    let ids = tok.encode(text, {add_special_tokens: true}).ids;
    if (ids.length > config.max_length) ids = ids.slice(0, config.max_length - 1).concat(ids[ids.length - 1]);
    const n = ids.length, feeds = {input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, n]), attention_mask: new ort.Tensor('int64', new BigInt64Array(n).fill(1n), [1, n])};
    if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(n), [1, n]);
    const logit = (await session.run(feeds)).logits.data[0];
    out.push(1 / (1 + Math.exp(-logit)));
  }
  return out;
}
self.onmessage = async ({data}) => {
  try {
    const result = data.type === 'init' ? await initialize(data.assets) : await score(data.texts);
    self.postMessage({id: data.id, result});
  } catch (e) { self.postMessage({id: data.id, error: String(e.message || e)}); }
};
