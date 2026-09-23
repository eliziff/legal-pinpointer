// Comparison arm (a): FTS5 (contentless, detail=none|column) over the same passages/terms, read from a picked File
// through a read-only SQLite VFS (File.slice + FileReaderSync), like the earlier whole-document FTS5 measurement.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
let sqlite3; const files = new Map(), handles = new Map(), frs = new FileReaderSync(), stats = {reads: 0, bytes: 0};
const BLOCK = 65536, cache = new Map(), MAXBLOCKS = 1024;
function block(key, file, b) {
  const k = key + ':' + b; let v = cache.get(k); if (v) { cache.delete(k); cache.set(k, v); return v; }
  v = new Uint8Array(frs.readAsArrayBuffer(file.slice(b * BLOCK, b * BLOCK + BLOCK))); stats.reads++; stats.bytes += v.length;
  cache.set(k, v); if (cache.size > MAXBLOCKS) cache.delete(cache.keys().next().value); return v;
}
function install() {
  const {capi, wasm} = sqlite3; const io = new capi.sqlite3_io_methods(); io.$iVersion = 1;
  sqlite3.vfs.installVfs({io: {struct: io, methods: {
    xClose: p => { handles.delete(Number(p)); return 0; },
    xRead: (p, dest, n, off64) => { const h = handles.get(Number(p)), off = Number(off64), heap = wasm.heap8u(), d = Number(dest); let done = 0;
      while (done < n) { const at = off + done, bi = Math.floor(at / BLOCK), blk = block(h.key, h.file, bi), s = at - bi * BLOCK, take = Math.min(n - done, blk.length - s);
        if (take <= 0) { heap.fill(0, d + done, d + n); return capi.SQLITE_IOERR_SHORT_READ; } heap.set(blk.subarray(s, s + take), d + done); done += take; }
      return 0; },
    xWrite: () => capi.SQLITE_READONLY, xTruncate: () => capi.SQLITE_READONLY, xSync: () => 0,
    xFileSize: (p, pSz) => { wasm.poke64(pSz, BigInt(handles.get(Number(p)).file.size)); return 0; },
    xLock: () => 0, xUnlock: () => 0, xCheckReservedLock: (p, pOut) => { wasm.poke32(pOut, 0); return 0; },
    xFileControl: () => capi.SQLITE_NOTFOUND, xSectorSize: () => 4096, xDeviceCharacteristics: () => capi.SQLITE_IOCAP_IMMUTABLE}}});
  const vfs = new capi.sqlite3_vfs(), dv = new capi.sqlite3_vfs(capi.sqlite3_vfs_find(null));
  vfs.$iVersion = 2; vfs.$szOsFile = capi.sqlite3_file.structInfo.sizeof; vfs.$mxPathname = 1024;
  vfs.addOnDispose(vfs.$zName = wasm.allocCString('filevfs')); vfs.$xRandomness = dv.$xRandomness; vfs.$xSleep = dv.$xSleep; dv.dispose();
  sqlite3.vfs.installVfs({vfs: {struct: vfs, methods: {
    xOpen: (pVfs, zName, pFile, flags, pOutFlags) => { const name = zName ? wasm.cstrToJs(zName) : '', file = files.get(name); if (!file) return capi.SQLITE_CANTOPEN;
      handles.set(Number(pFile), {file, key: name}); const f = new capi.sqlite3_file(pFile); f.$pMethods = io.pointer; f.dispose(); wasm.poke32(pOutFlags, capi.SQLITE_OPEN_READONLY); return 0; },
    xDelete: () => 0, xAccess: (pVfs, z, fl, pOut) => { wasm.poke32(pOut, 0); return 0; },
    xFullPathname: (pVfs, z, nOut, pOut) => wasm.cstrncpy(pOut, z, nOut) < nOut ? 0 : capi.SQLITE_CANTOPEN, xGetLastError: () => 0,
    xCurrentTime: (pVfs, pOut) => { wasm.poke(pOut, 2440587.5 + Date.now() / 864e5, 'double'); return 0; },
    xCurrentTimeInt64: (pVfs, pOut) => { wasm.poke(pOut, 0xbfc83e532200 + Date.now(), 'i64'); return 0; }}}});
}
onmessage = async ({data: {file, queries}}) => {
  try {
    if (!sqlite3) { sqlite3 = await sqlite3InitModule(); install(); }
    files.set(file.name, file); cache.clear();
    let t = performance.now();
    const db = new sqlite3.oo1.DB({filename: 'file:' + file.name + '?immutable=1', flags: 'r', vfs: 'filevfs'});
    db.exec('PRAGMA cache_size=-65536; PRAGMA temp_store=memory;');
    db.selectValue('SELECT count(*) FROM sqlite_master');
    const openMs = performance.now() - t, out = [];
    for (const q of queries) {
      const s0 = {...stats}; t = performance.now();
      try {
        const ids = db.selectValues('SELECT rowid FROM p WHERE p MATCH ? ORDER BY rank LIMIT 100', [q.fts]);
        out.push({id: q.id, type: q.type, ms: performance.now() - t, bytes: stats.bytes - s0.bytes, pids: ids});
      } catch (e) { out.push({id: q.id, type: q.type, error: e.message, ms: performance.now() - t}); }
    }
    db.close(); postMessage({openMs, results: out});
  } catch (e) { postMessage({error: e.message + '\n' + e.stack}); }
};
