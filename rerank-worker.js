// On-device cross-encoder scoring for Tab Sonar's ranked mode. Runs in a
// dedicated worker of the side panel; all assets ship in vendor/rerank/. A GPU
// with 16-bit shaders runs the MiniLM-L4 cross-encoder through WebGPU; other
// machines run the much smaller TinyBERT-L2 on WASM threads.
import './rerank-core.js';
import * as ort from './vendor/rerank/ort.jspi.min.mjs';

const base = new URL('vendor/rerank/', self.location.href).href;
// Multi-threaded WASM needs the panel's cross-origin isolation; otherwise one thread.
const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 2)) : 1;
const cache = new Map();
let loading = null, job = 0;

const asset = name => fetch(base + name).then(response => { if (!response.ok) throw new Error('Reranker is not included in this build.'); return response; });
async function open(name, device) {
  const bytes = new Uint8Array(await (await asset(name)).arrayBuffer());
  // Idle pool threads sleep instead of spinning, so a rerank never busy-waits
  // on cores that the panel and the tabs need.
  return ort.InferenceSession.create(bytes, { executionProviders: [device], graphOptimizationLevel: 'all',
    extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } } });
}
function load() {
  loading ||= (async () => {
    const vocab = asset('tokenizer.json').then(response => response.json());
    const adapter = await navigator.gpu?.requestAdapter().catch(() => null), gpu = adapter?.features.has('shader-f16');
    // The GPU path needs no WASM thread pool (each pool thread is a worker of its own).
    ort.env.wasm.wasmPaths = base; ort.env.wasm.numThreads = gpu ? 1 : threads;
    let session = null, device = 'webgpu';
    if (gpu) { ort.env.webgpu.adapter = adapter; session = await open('model-gpu.onnx', device).catch(() => null); }
    if (!session) { device = 'wasm'; session = await open('model-cpu.onnx', device); }
    const model = { tokenizer: globalThis.LegalPinpointerRerankCore.createTokenizer((await vocab).model.vocab), session, device, threads: ort.env.wasm.numThreads };
    // The first GPU runs compile shaders: do that now, at search-like shapes, not in the first search.
    if (device === 'webgpu') await score(model, 'warm up', Array.from({ length: 12 }, (_, i) => ({ text: 'shader '.repeat(20 + i * 12) })), 192);
    return model;
  })();
  return loading;
}

// Pairs sorted by length, in three runs each padded only to its own longest.
async function score({ tokenizer, session }, query, passages, maxLength) {
  const pairs = passages.map((passage, at) => ({ at, ...tokenizer.pair(query, passage.text, maxLength) })).sort((a, b) => a.ids.length - b.ids.length);
  const scores = [], runs = Math.min(3, pairs.length);
  for (let k = 0; k < runs; k++) {
    const group = pairs.slice(Math.round(k * pairs.length / runs), Math.round((k + 1) * pairs.length / runs));
    const count = group.length, width = group.at(-1).ids.length;
    const ids = new BigInt64Array(count * width), mask = new BigInt64Array(count * width), types = new BigInt64Array(count * width);
    group.forEach((pair, row) => pair.ids.forEach((id, i) => {
      ids[row * width + i] = BigInt(id); mask[row * width + i] = 1n; types[row * width + i] = BigInt(pair.types[i]);
    }));
    const tensor = values => new ort.Tensor('int64', values, [count, width]), inputs = { input_ids: tensor(ids), attention_mask: tensor(mask), token_type_ids: tensor(types) };
    const output = await session.run(Object.fromEntries(session.inputNames.map(name => [name, inputs[name]])));
    output[session.outputNames[0]].data.forEach((value, row) => { scores[group[row].at] = Number(value); });
  }
  return scores;
}

self.onmessage = async ({ data }) => {
  if (data?.type === 'cancel') { job = 0; return; }
  if (data?.type !== 'warm' && data?.type !== 'score') return;
  let model;
  try { model = await load(); }
  catch (error) { self.postMessage({ type: 'unavailable', message: String(error.message || error) }); return; }
  if (data.type === 'warm') { self.postMessage({ type: 'ready', device: model.device, threads: model.threads }); return; }
  job = data.job;
  const started = performance.now();
  // Scores are kept per (query, passage text), so a repeated query costs nothing.
  const scores = [], todo = data.passages.filter(passage => {
    const known = cache.get(`${data.query}\u0000${passage.key}`);
    if (known !== undefined) scores.push([passage.id, known]);
    return known === undefined;
  });
  try {
    if (todo.length) {
      (await score(model, data.query, todo, data.maxLength || 192)).forEach((value, i) => {
        scores.push([todo[i].id, value]);
        cache.set(`${data.query}\u0000${todo[i].key}`, value);
        if (cache.size > 2000) cache.delete(cache.keys().next().value);
      });
    }
  } catch (error) { self.postMessage({ type: 'failed', job: data.job, message: String(error.message || error) }); return; }
  if (job === data.job) self.postMessage({ type: 'scores', job: data.job, scores, ms: performance.now() - started, device: model.device, threads: model.threads });
};
