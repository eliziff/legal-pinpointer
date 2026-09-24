import fs from 'node:fs'; import zlib from 'node:zlib';
const dir = process.argv[2]; const m = JSON.parse(fs.readFileSync(dir + '/manifest.json'));
// re-inflate the whole text store to get raw passages
const meta = zlib.inflateRawSync(fs.readFileSync(dir + '/meta.bin')); const L = m.layout;
const arr = (k, C) => new C(meta.buffer, meta.byteOffset + L[k].offset, L[k].length);
const off = arr('tbOff', Uint32Array), len = arr('tbLen', Uint32Array); const tf = fs.readFileSync(dir + '/text-000.bin');
const raws = []; for (let i = 0; i < off.length; i++) raws.push(zlib.inflateRawSync(tf.subarray(off[i], off[i] + len[i])));
const all = Buffer.concat(raws.slice(0, 600)); console.log('raw MB', all.length / 1e6);
const blocks = sz => { const out = []; for (let i = 0; i < all.length; i += sz) out.push(all.subarray(i, i + sz)); return out; };
const test = (name, sz, f) => { const t = performance.now(); let n = 0; for (const b of blocks(sz)) n += f(b).length; console.log(name, sz >> 10, 'KB ratio', (all.length / n).toFixed(2), 'ms', (performance.now() - t).toFixed(0)); };
test('deflate9', 65536, b => zlib.deflateRawSync(b, {level: 9}));
test('deflate9', 262144, b => zlib.deflateRawSync(b, {level: 9}));
const br = q => b => zlib.brotliCompressSync(b, {params: {[zlib.constants.BROTLI_PARAM_QUALITY]: q, [zlib.constants.BROTLI_PARAM_LGWIN]: 22, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length}});
test('brotli11', 65536, br(11)); test('brotli11', 262144, br(11)); test('brotli11', 1 << 20, br(11));
if (zlib.zstdCompressSync) { const z = lvl => b => zlib.zstdCompressSync(b, {params: {[zlib.constants.ZSTD_c_compressionLevel]: lvl}}); test('zstd19', 65536, z(19)); test('zstd19', 262144, z(19)); test('zstd19', 1<<20, z(19)); }
