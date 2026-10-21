'use strict';

// Round-trips every packaged CanLII instrument: its own citation (and title) must resolve back to
// it, unless a higher-ranked version of the same instrument (the consolidation) wins.
// Usage: npm run audit:legislation
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const legislation = require('../canlii-legislation.js');

const text = zlib.gunzipSync(fs.readFileSync(path.resolve(__dirname, '..', 'canlii-legislation.tsv.gz'))).toString('utf8');
const started = performance.now();
const index = legislation.parseIndex(text);
const parsed = performance.now() - started;
let exact = 0, consolidated = 0, ambiguous = 0, wrong = 0;
const samples = [];
const byKey = new Map();
for (const [key, found] of legislation.entries(index)) (byKey.get(key) || byKey.set(key, []).get(key)).push(found);
for (const [key, rows] of byKey) {
  for (const row of rows) {
    const resolved = legislation.resolve(index, row.title, key, 'en', { keys: [key], candidates: [] });
    if (resolved === legislation.rowUrl(row, 'en')) exact += 1;
    else if (!resolved) { ambiguous += 1; if (samples.length < 12) samples.push(`abstained: ${key} ${row.id} ${row.title}`); }
    else if (resolved.includes(`/${row.id}/latest/`) || rows.some((other) => legislation.rowUrl(other, 'en') === resolved && legislation.looseTitle(other.title) === legislation.looseTitle(row.title))) consolidated += 1;
    else { wrong += 1; if (samples.length < 12) samples.push(`other: ${key} ${row.id} -> ${resolved}`); }
  }
}
console.log(JSON.stringify({ records: index.starts.length, citationKeys: index.byCitation.size, parseMs: Math.round(parsed),
  exact, consolidated, ambiguous, wrong }, null, 2));
for (const sample of samples) console.log(sample);
process.exitCode = wrong ? 1 : 0;
