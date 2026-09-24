// Prints the report tables (markdown) from an index manifest and a bench result.
//   node bench/tables.mjs --index <dir> --result bench/results/<tag>.json [--baselines bench/baselines.json]
import fs from 'node:fs'; import path from 'node:path';
const argv = process.argv.slice(2), opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const m = JSON.parse(fs.readFileSync(path.join(opt('--index'), 'manifest.json'), 'utf8'));
const {summary: s} = JSON.parse(fs.readFileSync(opt('--result'), 'utf8'));
const base = JSON.parse(fs.readFileSync(opt('--baselines', path.join(root, 'bench', 'baselines.json')), 'utf8'));
const gb = b => (b / 1e9).toFixed(2), f = (x, d = 0) => x == null ? '-' : (+x).toFixed(d);
const row = cells => console.log('| ' + cells.join(' | ') + ' |');

console.log(`## Package: ${gb(m.totalBytes)} GB in ${m.files.length} files (largest ${gb(Math.max(...m.files.map(x => x.size)))} GB), ${m.docs.toLocaleString()} documents, ${m.passages.toLocaleString()} passages, ${m.terms.toLocaleString()} terms; build ${Math.round(m.buildSeconds / 60)} min\n`);
row(['file', 'bytes']); row(['---', '---:']);
for (const x of m.files) row([x.name, x.size.toLocaleString()]);
console.log('\n### Per dataset (text store + postings attributed by passage, docs metadata by document)\n');
row(['dataset', 'docs', 'passages', 'raw text MB', 'package MB']); row(['---', '---:', '---:', '---:', '---:']);
const groups = new Map();
for (const d of m.datasets) {
  const g = d.code.replace(/^(LEGISLATION|REGULATIONS)-.*/, '$1 (all jurisdictions)');
  const a = groups.get(g) || {docs: 0, passages: 0, textMB: 0, packageMB: 0}; groups.set(g, a);
  a.docs += d.docs; a.passages += d.passages; a.textMB += d.textMB; a.packageMB += d.packageMB;
}
for (const [g, a] of groups) row([g, a.docs.toLocaleString(), a.passages.toLocaleString(), f(a.textMB), f(a.packageMB)]);
row(['**total**', m.docs.toLocaleString(), m.passages.toLocaleString(), f(m.datasets.reduce((x, d) => x + d.textMB, 0)), f(m.totalBytes / 1e6)]);
if (m.excluded?.length) console.log('\nExcluded by rule: ' + m.excluded.map(x => `${x.why}: ${x.docs} documents`).join('; '));

console.log(`\n## Latency (headless Chromium, file:// page, ms per query incl. passage text + metadata for 20 results)\n`);
console.log(`Folder open: ${s.openWallMs} ms wall (file list + manifest + meta), worker open ${s.openMs} ms. Pass 1 = ${s.coldCopy ? 'cold disk (unbuffered copy) + ' : ''}fresh browser; pass 2 = warm.\n`);
row(['type', 'n', 'cold p50', 'cold p95', 'warm p50', 'warm p95', 'MB read p50 / p95 (cold)']); row(['---', '---:', '---:', '---:', '---:', '---:', '---:']);
for (const t of ['phrase', 'keyword', 'nl']) {
  const c = s.latency['pass1:' + t], w = s.latency['pass2:' + t]; if (!c) continue;
  row([t, c.n, f(c.p50), f(c.p95), f(w?.p50), f(w?.p95), `${f(c.mbReadP50, 1)} / ${f(c.mbReadP95, 1)}`]);
}
console.log(`\nMemory: peak working set ${s.memory.peakWorkingSetMBMax} MB largest Chromium process, ${s.memory.peakWorkingSetMBSum} MB all Chromium processes.`);

console.log('\n## Quality vs baselines\n');
row(['query set', 'n', 'this: doc R@20', 'MRR', 'passage R@10', ...base.columns]); row(['---', '---:', '---:', '---:', '---:', ...base.columns.map(() => '---:')]);
for (const [k, q] of Object.entries(s.quality)) row([k, q.n, f(q['docR@20'], 3), f(q.MRR, 3), q['passageR@10'] == null ? '-' : f(q['passageR@10'], 3), ...base.columns.map(c => base.rows[k]?.[c] ?? '-')]);
console.log('\n' + base.notes.map(n => '- ' + n).join('\n'));
