// On-device cross-encoder scoring for Tab Sonar's ranked mode. Runs in a
// dedicated worker of the side panel; all assets ship in vendor/rerank/.
import './rerank-core.js';
import * as ort from './vendor/rerank/ort.wasm.min.mjs';

const base = new URL('vendor/rerank/', self.location.href).href;
// Multi-threaded WASM needs the panel's cross-origin isolation; otherwise one thread.
const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 2)) : 1;
const cache = new Map();
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
    // on cores that the panel and the tabs need.
    const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all',
      extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } } });
    return { tokenizer: globalThis.LegalPinpointerRerankCore.createTokenizer(tokenizer.model.vocab), session };
  })();
  return loading;
}

// All pairs in one session.run, padded to the longest (windows keep them short).
async function score({ tokenizer, session }, query, passages, maxLength) {
  const pairs = passages.map(passage => tokenizer.pair(query, passage.text, maxLength));
  const count = pairs.length, width = Math.max(...pairs.map(pair => pair.ids.length));
  const ids = new BigInt64Array(count * width), mask = new BigInt64Array(count * width), types = new BigInt64Array(count * width);
  pairs.forEach((pair, row) => pair.ids.forEach((id, i) => {
    ids[row * width + i] = BigInt(id); mask[row * width + i] = 1n; types[row * width + i] = BigInt(pair.types[i]);
  }));
  const tensor = values => new ort.Tensor('int64', values, [count, width]), inputs = { input_ids: tensor(ids), attention_mask: tensor(mask), token_type_ids: tensor(types) };
  const output = await session.run(Object.fromEntries(session.inputNames.map(name => [name, inputs[name]])));
  return Array.from(output[session.outputNames[0]].data, Number);
}

self.onmessage = async ({ data }) => {
  if (data?.type === 'cancel') { job = 0; return; }
  if (data?.type !== 'warm' && data?.type !== 'score') return;
  let model;
  try { model = await load(); }
  catch (error) { self.postMessage({ type: 'unavailable', message: String(error.message || error) }); return; }
  if (data.type === 'warm') { self.postMessage({ type: 'ready', threads }); return; }
  job = data.job;
  const started = performance.now(), first = data.first || data.passages.length;
  // Progressive: the first few passages, then the rest. Scores are kept per
  // (query, passage text), so a repeated query costs nothing.
  const stages = [data.passages.slice(0, first), data.passages.slice(first)].filter(stage => stage.length);
  for (const [at, stage] of stages.entries()) {
    if (job !== data.job) return;
    const scores = [], todo = stage.filter(passage => {
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
    if (job === data.job) self.postMessage({ type: 'scores', job: data.job, scores, done: at === stages.length - 1, ms: performance.now() - started, threads });
  }
};
