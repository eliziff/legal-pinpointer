// On-disk format shared by the builder and the search engine.
//
// Postings of one term (df postings, nb = ceil(df / B) blocks):
//   if nb > 1: skip table = lastPid u32[nb] | endOffset u32[nb] (relative to the first block) | maxQ u8[nb]
//   blocks: w u8 | (pid - prevPid - 1) packed in w bits each (prevPid = -1 before the first posting) | q packed 4 bits each
// q is the BM25 term-frequency component tf*(k1+1)/(tf + k1*(1-b+b*len/avglen)) quantized to 1..15.
export const B = 128, K1 = 1.2, BM25_B = 0.75, QMAX = 15;
export const quantize = w => Math.max(1, Math.min(QMAX, Math.round(w / (K1 + 1) * QMAX)));

const bitsFor = v => (v === 0 ? 0 : 32 - Math.clz32(v));

// Encode one block into out (Uint8Array with enough room) at pos; returns new pos.
export function encodeBlock(out, pos, pids, qs, from, to, prev) {
  let max = 0;
  for (let i = from; i < to; i++) { const g = pids[i] - prev - 1; if (g > max) max = g; prev = pids[i]; }
  const w = bitsFor(max); out[pos++] = w;
  if (w) {
    let acc = 0, nacc = 0; prev = from > 0 ? pids[from - 1] : -1;
    for (let i = from; i < to; i++) {
      let g = pids[i] - prev - 1; prev = pids[i]; let left = w;
      while (left > 0) { const take = Math.min(left, 8 - nacc); acc |= (g & ((1 << take) - 1)) << nacc; g >>>= take; left -= take; nacc += take; if (nacc === 8) { out[pos++] = acc; acc = 0; nacc = 0; } }
    }
    if (nacc) out[pos++] = acc;
  }
  for (let i = from; i < to; i += 2) out[pos++] = qs[i] | ((i + 1 < to ? qs[i + 1] : 0) << 4);
  return pos;
}

// Decode block of n postings starting at buf[pos]; prev = last pid before the block (-1 for the first).
// Fills pids/qs (Int32Array/Uint8Array, length >= n); returns byte position after the block.
export function decodeBlock(buf, pos, n, prev, pids, qs) {
  const w = buf[pos++];
  if (w === 0) { for (let i = 0; i < n; i++) pids[i] = ++prev; }
  else if (w <= 24) {
    const mask = (1 << w) - 1; let acc = 0, nacc = 0;
    for (let i = 0; i < n; i++) {
      while (nacc < w) { acc |= buf[pos++] << nacc; nacc += 8; }
      prev += (acc & mask) + 1; pids[i] = prev; acc >>>= w; nacc -= w;
    }
  } else {
    let acc = 0, nacc = 0; const p = 2 ** w;
    for (let i = 0; i < n; i++) {
      while (nacc < w) { acc += buf[pos++] * 2 ** nacc; nacc += 8; }
      prev += (acc % p) + 1; pids[i] = prev; acc = Math.floor(acc / p); nacc -= w;
    }
  }
  for (let i = 0; i < n; i += 2) { const b = buf[pos++]; qs[i] = b & 15; if (i + 1 < n) qs[i + 1] = b >> 4; }
  return pos;
}

export const blockBytes = (w, n) => 1 + Math.ceil(n * w / 8) + Math.ceil(n / 2);

// Varints (unsigned, < 2^53) for the dictionary.
export function putVarint(out, pos, v) { while (v >= 128) { out[pos++] = (v % 128) | 128; v = Math.floor(v / 128); } out[pos++] = v; return pos; }
export function getVarint(buf, st) { let v = 0, m = 1, b; do { b = buf[st.pos++]; v += (b & 127) * m; m *= 128; } while (b & 128); return v; }
