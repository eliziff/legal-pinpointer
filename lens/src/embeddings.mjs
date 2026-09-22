import { Tokenizer } from '@huggingface/tokenizers';

// Model2Vec's token lookup -> mean -> L2 normalize, adapted from MinishLab/model2vec
// (MIT). These are trained multilingual vectors, not word counts or hash embeddings.
export async function loadEmbeddings(base) {
  const read = async name => {
    const response = await fetch(new URL(name, base));
    if (!response.ok) throw new Error(`Cannot load local semantic-search asset ${name}.`);
    return response;
  };
  const [info, vocabulary, weights, scales] = await Promise.all([
    read('potion.json').then(r => r.json()), read('tokenizer.json').then(r => r.json()),
    read('potion.i8').then(r => r.arrayBuffer()), read('potion.scales').then(r => r.arrayBuffer())
  ]);
  const tokenizer = new Tokenizer(vocabulary, {});
  const table = new Int8Array(weights), scale = new Float32Array(scales);
  const dimension = info.dimensions, unknown = vocabulary.model.unk_id ?? tokenizer.token_to_id('[UNK]');
  if (table.length !== dimension * info.vocabulary || scale.length !== info.vocabulary)
    throw new Error('The packaged embedding model is incomplete.');
  const encode = text => {
    const vector = new Float32Array(dimension);
    const ids = tokenizer.encode(text, { add_special_tokens: false }).ids;
    for (const id of ids) {
      if (id === unknown) continue;
      if (id < 0 || id >= scale.length) throw new Error('Embedding tokenizer/weight mismatch.');
      const offset = id * dimension, factor = scale[id];
      for (let j = 0; j < dimension; j++) vector[j] += table[offset + j] * factor;
    }
    // Division by token count cancels under L2 normalization.
    let squared = 0;
    for (const x of vector) squared += x * x;
    if (squared) { const inverse = 1 / Math.sqrt(squared); for (let j = 0; j < dimension; j++) vector[j] *= inverse; }
    return vector;
  };
  return { encode, dimension, fingerprint: `${info.repository}@${info.revision}:row-int8-v1` };
}

export function packVectors(vectors, dimension) {
  const data = new Int8Array(vectors.length * dimension), norms = new Float32Array(vectors.length);
  vectors.forEach((v, i) => {
    let squared = 0;
    for (let j = 0; j < dimension; j++) {
      const value = Math.round(Math.max(-1, Math.min(1, v[j])) * 127);
      data[i * dimension + j] = value; squared += value * value;
    }
    norms[i] = squared ? 1 / Math.sqrt(squared) : 0;
  });
  return { data, norms };
}

export function packedCosine(query, block, index) {
  let dot = 0; const offset = index * query.length;
  for (let j = 0; j < query.length; j++) dot += query[j] * block.data[offset + j];
  return dot * block.norms[index];
}

// Bounded min-heap. Every vector is examined; only the requested result page is retained.
export class TopK {
  constructor(k) { this.k = k; this.items = []; }
  add(item) {
    const a = this.items;
    if (a.length < this.k) {
      a.push(item); let i = a.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (a[p].value <= a[i].value) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
    } else if (item.value > a[0].value) {
      a[0] = item; let i = 0;
      for (;;) { let j = 2 * i + 1; if (j >= a.length) break; if (j + 1 < a.length && a[j + 1].value < a[j].value) j++; if (a[i].value <= a[j].value) break; [a[i], a[j]] = [a[j], a[i]]; i = j; }
    }
  }
  sorted() { return this.items.sort((a, b) => b.value - a.value); }
}
