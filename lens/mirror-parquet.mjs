import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
export async function mirrorParquet(assets, download) {
  const dist=path.join(import.meta.dirname,'node_modules/@duckdb/duckdb-wasm/dist');
  const imported=await import(pathToFileURL(path.join(dist,'duckdb-node-blocking.cjs')).href);
  const api=imported.default||imported;
  const bundles={mvp:{mainModule:path.join(dist,'duckdb-mvp.wasm')},eh:{mainModule:path.join(dist,'duckdb-eh.wasm')}};
  const db=await api.createDuckDB(bundles,new api.VoidLogger(),api.NODE_RUNTIME);
  await db.instantiate(()=>{});
  const connection=db.connect();
  try {
    const version=db.getVersion(),platform=String(connection.query('PRAGMA platform').getChildAt(0).get(0));
    if(!/^v?\d+\.\d+\.\d+/.test(version)||platform!=='wasm_eh')throw new Error(`Unexpected DuckDB build: ${version} ${platform}`);
    // Verified against the bundled engine's actual extension request (v1.4.3 omits the old duckdb-wasm prefix).
    const relative=`${version}/${platform}/parquet.duckdb_extension.wasm`;
    const destination=path.join(assets,relative);await mkdir(path.dirname(destination),{recursive:true});
    const url=`https://extensions.duckdb.org/${relative}`;
    console.log(`Mirroring signed Parquet extension: ${url}`);
    await download(url,destination);
    await writeFile(path.join(assets,'duckdb-extension-info.json'),JSON.stringify({version,platform,url,signatureVerification:true},null,2));
  } finally { connection.close(); }
}
