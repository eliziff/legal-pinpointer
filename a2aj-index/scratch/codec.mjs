import {encodeBlock, decodeBlock, blockBytes} from '../src/format.mjs';
for (const [n, maxgap] of [[128, 1], [128, 3], [77, 1000], [128, 5e6], [5, 3e7], [1, 0], [10, 2**27], [3, 2**29]]) {
  const pids = []; let p = -1; for (let i = 0; i < n; i++) { p += 1 + Math.floor(Math.random() * maxgap); pids.push(p); }
  const qs = pids.map(() => 1 + Math.floor(Math.random() * 15));
  const out = new Uint8Array(2000); const end = encodeBlock(out, 0, pids, qs, 0, n, -1);
  const P = new Int32Array(128), Q = new Uint8Array(128); const e2 = decodeBlock(out, 0, n, -1, P, Q);
  const ok = end === e2 && pids.every((x, i) => x === P[i]) && qs.every((x, i) => x === Q[i]);
  console.log(n, maxgap, end, blockBytes(out[0], n), ok);
}
