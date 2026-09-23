// On-device cross-encoder scoring for Tab Sonar's ranked mode. Runs in a
// dedicated worker of the side panel; all assets ship in vendor/rerank/.
import './rerank-core.js';
import * as ort from './vendor/rerank/ort.wasm.min.mjs';

const base = new URL('vendor/rerank/', self.location.href).href;
// Multi-threaded WASM needs the panel's cross-origin isolation; otherwise one thread.
const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 2)) : 1;
let loading = null, job = 0;

function load() {
  loading ||= (async () => {
    ort.env.wasm.wasmPaths = base;
    ort.env.wasm.numThreads = threads;
    const [tokenizer, model] = await Promise.all([
      fetch(`${base}tokenizer.json`).then(response => { if (!response.ok) throw new Error('Reranker is not included in this build.'); return response.json(); }),
      fetch(`${base}model.onnx`).then(response => { if (!response.ok) throw new Error('Reranker is not included in this build.'); return response.arrayBuffer(); })
    ]);
    // Idle pool threads sleep instead of spinning, so a rerank never busy-waits
    // on cores that the tabs being searched need.
    const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all',
      extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } } });
    return { tokenizer: globalThis.LegalPinpointerRerankCore.createTokenizer(tokenizer.model.vocab), session };
  })();
  return loading;
}

async function score({ tokenizer, session }, query, text, maxLength) {
  const { ids, types } = tokenizer.pair(query, text, maxLength), n = ids.length;
  const tensor = values => new ort.Tensor('int64', BigInt64Array.from(values, BigInt), [1, n]);
  const output = await session.run({ input_ids: tensor(ids), attention_mask: tensor(ids.map(() => 1)), token_type_ids: tensor(types) });
  return output[session.outputNames[0]].data[0];
}

self.onmessage = async ({ data }) => {
  if (data?.type === 'cancel') { job = 0; return; }
  if (data?.type !== 'warm' && data?.type !== 'score') return;
  let model;
  try { model = await load(); }
  catch (error) { self.postMessage({ type: 'unavailable', message: String(error.message || error) }); return; }
  if (data.type === 'warm') { self.postMessage({ type: 'ready', threads }); return; }
  job = data.job;
  const started = performance.now();
  for (const passage of data.passages) {
    if (job !== data.job) return;
    try { self.postMessage({ type: 'score', job: data.job, id: passage.id, score: await score(model, data.query, passage.text, data.maxLength || 512) }); }
    catch (error) { self.postMessage({ type: 'failed', job: data.job, message: String(error.message || error) }); return; }
  }
  if (job === data.job) self.postMessage({ type: 'done', job: data.job, ms: performance.now() - started, threads });
};
