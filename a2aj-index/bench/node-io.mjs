// Node implementation of the engine's io interface (for tests and quick checks outside the browser).
import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib';
export function nodeIO(dir) {
  const fds = new Map(), fd = n => { let f = fds.get(n); if (f === undefined) fds.set(n, f = fs.openSync(path.join(dir, n), 'r')); return f; };
  return {
    size: n => fs.statSync(path.join(dir, n)).size,
    read(n, off, len) { const b = Buffer.allocUnsafe(len); const got = fs.readSync(fd(n), b, 0, len, off); return new Uint8Array(b.buffer, b.byteOffset, got); },
    inflate: async bytes => new Uint8Array(zlib.inflateRawSync(bytes)),
  };
}
