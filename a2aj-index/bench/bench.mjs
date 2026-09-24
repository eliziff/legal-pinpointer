// Headless Chromium benchmark of dist/a2aj-search.html opened from file:// with the index folder picked.
//   node bench/bench.mjs --index <dir> --eval <eval-passages.json> --tag <name> [--passes 2] [--only nl,phrase] [--cold-copy <tmpdir>]
// Pass 1 is the first run after launch (cold JS, empty caches). With --cold-copy the index is first copied to <tmpdir>
// with robocopy /J (unbuffered I/O, so none of it is in the OS file cache), benchmarked there, and the copy deleted:
// pass 1 is then also cold-disk. Pass 2 repeats the queries (warm).
import {chromium} from 'playwright'; import fs from 'node:fs'; import path from 'node:path'; import {execSync, spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url'; import {quality} from './metrics.mjs';
const argv = process.argv.slice(2), opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const src = path.resolve(opt('--index')), tag = opt('--tag', path.basename(src)), passes = +opt('--passes', 2), coldCopy = opt('--cold-copy');
let dir = src;
if (coldCopy) {
  dir = path.resolve(coldCopy); fs.rmSync(dir, {recursive: true, force: true});
  const t = Date.now(), r = spawnSync('robocopy', [src, dir, '/J', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XD', '_tmp']);
  if (r.status >= 8) throw new Error('robocopy failed ' + r.status + ' ' + r.stdout);
  console.log(`cold copy (unbuffered) in ${((Date.now() - t) / 1000).toFixed(0)} s`);
}
const ranking = JSON.parse(opt('--ranking', '{}')); // e.g. '{"title":0}'; default: engine RANKING
const evalMap = opt('--eval') ? JSON.parse(fs.readFileSync(opt('--eval'), 'utf8')) : {};
let queries = JSON.parse(fs.readFileSync(path.join(root, 'bench', 'queries.json'), 'utf8'));
if (opt('--only')) queries = queries.filter(q => opt('--only').split(',').includes(q.type));
const html = pathToFileURL(path.join(root, 'dist', 'a2aj-search.html')).href;
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(1); };

const browser = await chromium.launch({headless: true, args: ['--enable-precise-memory-info']});
const page = await browser.newPage(); page.setDefaultTimeout(0);
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(html);
const t0 = Date.now();
await page.setInputFiles('#dir', dir);
await page.waitForFunction(() => window.a2aj.info() || /Missing|Error/.test(document.getElementById('status').textContent));
const openWallMs = Date.now() - t0, info = await page.evaluate(() => window.a2aj.info());
if (!info) throw new Error(await page.textContent('#status'));
console.log(`opened ${info.docs} docs / ${info.passages} passages: worker ${info.openMs.toFixed(0)} ms, wall incl. file list ${openWallMs} ms`);
const runs = [];
for (let pass = 1; pass <= passes; pass++) {
  for (const q of queries) {
    const r = await page.evaluate(arg => window.a2aj.raw(arg), {query: q.query, opts: {show: 20, maxPerDoc: 2, ...ranking}, withDocIds: true});
    runs.push({pass, id: q.id, type: q.type, set: q.set, searchMs: r.searchMs, totalMs: r.totalMs, reads: r.reads, bytes: r.bytes, decoded: r.decoded,
      candidates: r.candidates, evaluated: r.evaluated, pids: r.pids, shownPids: r.shownPids, docIds: r.docIds, n: r.pids.length});
  }
  console.log(`pass ${pass} done`);
}
let mem = null;
try { mem = JSON.parse(execSync(`powershell -NoProfile -Command "Get-Process chrome,chrome-headless-shell -ErrorAction SilentlyContinue | Where-Object {$_.Path -like '*ms-playwright*'} | Select-Object Id,PeakWorkingSet64,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json"`).toString()); } catch {}
const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize || 0);
await browser.close();
if (coldCopy) fs.rmSync(dir, {recursive: true, force: true});

// quality
const summary = {tag, index: src, coldCopy: !!coldCopy, ranking, openMs: +info.openMs.toFixed(1), openWallMs, docs: info.docs, passages: info.passages};
const qual = quality(queries, runs.filter(r => r.pass === passes), evalMap);
const lat = {};
for (let pass = 1; pass <= passes; pass++) for (const type of ['phrase', 'keyword', 'nl']) {
  const xs = runs.filter(r => r.pass === pass && r.type === type); if (!xs.length) continue;
  lat[`pass${pass}:${type}`] = {n: xs.length, p50: pct(xs.map(x => x.totalMs), 50), p95: pct(xs.map(x => x.totalMs), 95), max: pct(xs.map(x => x.totalMs), 100),
    searchP50: pct(xs.map(x => x.searchMs), 50), searchP95: pct(xs.map(x => x.searchMs), 95), mbReadP50: pct(xs.map(x => x.bytes / 1e6), 50), mbReadP95: pct(xs.map(x => x.bytes / 1e6), 95)};
}
const procs = [].concat(mem || []);
Object.assign(summary, {latency: lat, quality: qual, memory: {jsHeapMB: +(heap / 1e6).toFixed(1), peakWorkingSetMBMax: Math.max(0, ...procs.map(p => p.PeakWorkingSet64 / 1e6 | 0)), peakWorkingSetMBSum: procs.reduce((a, p) => a + p.PeakWorkingSet64 / 1e6, 0) | 0}});
fs.mkdirSync(path.join(root, 'bench', 'results'), {recursive: true});
fs.writeFileSync(path.join(root, 'bench', 'results', tag + '.json'), JSON.stringify({summary, runs}, null, 1));
console.log(JSON.stringify(summary, null, 1));
