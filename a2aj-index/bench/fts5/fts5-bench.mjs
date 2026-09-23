// Arm (a) latency: FTS5 contentless index in the browser (sqlite-wasm, File VFS), same queries and terms as the static index.
//   node bench/fts5/fts5-bench.mjs <fts5.sqlite> <tag>
import {chromium} from 'playwright'; import * as esbuild from 'esbuild'; import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), dist = path.join(here, 'dist'), root = path.resolve(here, '../..');
const [dbFile, tag] = process.argv.slice(2);
fs.mkdirSync(dist, {recursive: true});
await esbuild.build({entryPoints: [path.join(here, 'fts5-worker.mjs')], bundle: true, format: 'esm', outfile: path.join(dist, 'fts5-worker.js'), logLevel: 'error'});
await esbuild.build({entryPoints: [path.join(here, 'fts5-page.mjs')], bundle: true, format: 'esm', outfile: path.join(dist, 'fts5-page.js'), logLevel: 'error'});
fs.copyFileSync(path.join(root, 'node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm'), path.join(dist, 'sqlite3.wasm'));
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><meta charset=utf-8><input type=file id=files><script type=module src=./fts5-page.js></script>');
const types = {'.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm'};
const server = await new Promise(ok => { const s = http.createServer((req, res) => { const f = path.join(dist, new URL(req.url, 'http://x').pathname); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, {'content-type': types[path.extname(f)] || 'application/octet-stream'}); fs.createReadStream(f).pipe(res); }).listen(8811, '127.0.0.1', () => ok(s)); });
const queries = JSON.parse(fs.readFileSync(path.join(root, 'bench/queries.json'), 'utf8'));
const browser = await chromium.launch({headless: true}); const page = await browser.newPage(); page.setDefaultTimeout(0);
page.on('
