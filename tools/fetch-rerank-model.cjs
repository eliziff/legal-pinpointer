'use strict';

// Vendors the on-device reranker into vendor/rerank/: onnxruntime-web's JSPI
// runtime (WebGPU and WASM), the fp16 MiniLM-L4 ms-marco cross-encoder for GPUs
// and the int8 TinyBERT-L2 one for CPUs. Every byte is pinned by SHA-256; nothing
// is fetched at extension runtime. Usage: npm run fetch:rerank
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const out = path.resolve(__dirname, '..', 'vendor', 'rerank');
const ORT = {
  url: 'https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.30.0.tgz',
  sha256: 'd2228df7e4616bc3348bf504ee888f3bec43789a273f0a63f3e68d203ce3bf71',
  files: {
    'package/dist/ort.jspi.min.mjs': ['ort.jspi.min.mjs', 'bc57179d923fda2d88d4a395359c8df44399dde087bf9ff44fc0e40ab398e4d9'],
    'package/dist/ort-wasm-simd-threaded.jspi.mjs': ['ort-wasm-simd-threaded.jspi.mjs', '270e2c6da9f297239d301d329782b6446641cb1e16a77967690adcfca35f3268'],
    'package/dist/ort-wasm-simd-threaded.jspi.wasm': ['ort-wasm-simd-threaded.jspi.wasm', 'a54c76f86b0f0d9572380cf1c6292a7b3903716ffcbcd6b0e5c7050bf430eb93']
  }
};
const GPU = 'https://huggingface.co/Xenova/ms-marco-MiniLM-L-4-v2/resolve/e8fdba61d478d042b338f7bcf7ba4e48ed7d46d7/';
const CPU = 'https://huggingface.co/Xenova/ms-marco-TinyBERT-L-2-v2/resolve/b76bb5e1fefd66aa36cd108622d768e86c015ff1/';
const DIRECT = [
  [`${GPU}onnx/model_fp16.onnx`, 'model-gpu.onnx', '9ed87a768b2d6d204674c2278199c8cd353a0fdacfb3bb1acad464c42cbdd576'],
  [`${CPU}onnx/model_int8.onnx`, 'model-cpu.onnx', 'f24d6dcf08df3d26b8fba3886942575b64856deba7ac2aa0962c2fb2ccd6d895'],
  // Both models share this uncased BERT vocabulary (identical files).
  [`${GPU}tokenizer.json`, 'tokenizer.json', 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66']
];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fresh = (name, hash) => { try { return sha256(fs.readFileSync(path.join(out, name))) === hash; } catch (_) { return false; } };

async function download(url, hash) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== hash) throw new Error(`${url}: SHA-256 ${sha256(bytes)} does not match the pinned ${hash}`);
  return bytes;
}
function untar(archive) {
  const files = new Map();
  for (let at = 0; at + 512 <= archive.length;) {
    const name = archive.toString('utf8', at, at + 100).replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(archive.toString('utf8', at + 124, at + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    files.set(name, archive.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
function write(name, bytes, hash) {
  if (sha256(bytes) !== hash) throw new Error(`${name}: SHA-256 ${sha256(bytes)} does not match the pinned ${hash}`);
  fs.writeFileSync(path.join(out, `${name}.tmp`), bytes);
  fs.renameSync(path.join(out, `${name}.tmp`), path.join(out, name));
  console.log(`vendor/rerank/${name} ${bytes.length} bytes, sha256 ${hash}`);
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  if (!Object.values(ORT.files).every(([name, hash]) => fresh(name, hash))) {
    const files = untar(zlib.gunzipSync(await download(ORT.url, ORT.sha256)));
    for (const [from, [name, hash]] of Object.entries(ORT.files)) {
      if (!files.has(from)) throw new Error(`${from} is missing from ${ORT.url}`);
      write(name, files.get(from), hash);
    }
  }
  for (const [url, name, hash] of DIRECT) if (!fresh(name, hash)) write(name, await download(url, hash), hash);
  // Earlier runtimes and models are removed so they are not packaged.
  const keep = new Set([...Object.values(ORT.files).map(([name]) => name), ...DIRECT.map(([, name]) => name)]);
  for (const name of fs.readdirSync(out)) if (!keep.has(name)) fs.rmSync(path.join(out, name));
  console.log('Reranker assets verified in vendor/rerank/.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
