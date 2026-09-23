'use strict';

// Vendors the on-device reranker into vendor/rerank/: onnxruntime-web's WASM
// runtime and the int8 MiniLM-L6 ms-marco cross-encoder. Every byte is pinned by
// SHA-256; nothing is fetched at extension runtime. Usage: npm run fetch:rerank
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const out = path.resolve(__dirname, '..', 'vendor', 'rerank');
const ORT = {
  url: 'https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.30.0.tgz',
  sha256: 'd2228df7e4616bc3348bf504ee888f3bec43789a273f0a63f3e68d203ce3bf71',
  files: {
    'package/dist/ort.wasm.min.mjs': ['ort.wasm.min.mjs', '219e6a1fc8a9938268d18efca3c91d310bd2f4a59bbd13744df5b2b7fc6cee3b'],
    'package/dist/ort-wasm-simd-threaded.mjs': ['ort-wasm-simd-threaded.mjs', 'e13f7f94fc51b4ca72b12faeb1ee95f4ace6dfbc8939bc718aabdc0a27c4299b'],
    'package/dist/ort-wasm-simd-threaded.wasm': ['ort-wasm-simd-threaded.wasm', '3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2']
  }
};
const MODEL = 'https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/a09144355adeed5f58c8ed011d209bf8ee5a1fec/';
const DIRECT = [
  [`${MODEL}onnx/model_int8.onnx`, 'model.onnx', 'a13ec391ca99f49886694e12d3e800521f36d4267d7d448c34421c541a2baf50'],
  [`${MODEL}tokenizer.json`, 'tokenizer.json', 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66']
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
  console.log('Reranker assets verified in vendor/rerank/.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
