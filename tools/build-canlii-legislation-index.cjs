'use strict';

// Builds canlii-legislation.tsv.gz from a CanLII legislation metadata export (CSV with databaseId,
// legislationId, title, citation and type columns). Each instrument is keyed by the packaged
// engine's canlii_citation_key of CanLII's own citation (legislationLookup keys[0]), the same
// function the extension applies to a provider page's citation, so the two cannot drift apart.
// Rebuild after refreshing the engine.
// Usage: node tools/build-canlii-legislation-index.cjs <canlii_legislation.csv> [--output <path>]
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const legislation = require('../canlii-legislation.js');
const engine = require('./engine-node.cjs');

const TYPE_PATH = { STATUTE: 'stat', REGULATION: 'regu', ANNUAL_STATUTE: 'astat', REVISED_STATUTE: 'hstat', CONSTITUTION: 'const' };
const RANK = { STATUTE: 0, REGULATION: 1, REVISED_STATUTE: 2, CONSTITUTION: 3, ANNUAL_STATUTE: 4 };

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); field = '';
      if (row.length > 1 || row[0]) rows.push(row);
      row = [];
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const args = process.argv.slice(2);
const source = args.find((value) => !value.startsWith('--'));
const outputIndex = args.indexOf('--output');
const output = path.resolve(outputIndex >= 0 ? args[outputIndex + 1] : path.join(__dirname, '..', 'canlii-legislation.tsv.gz'));
if (!source) {
  process.stderr.write('Usage: node tools/build-canlii-legislation-index.cjs <canlii_legislation.csv> [--output <path>]\n');
  process.exit(2);
}
const bytes = fs.readFileSync(source);
const [header, ...records] = parseCsv(bytes.toString('utf8'));
const column = Object.fromEntries(header.map((name, index) => [name.trim(), index]));
for (const name of ['databaseId', 'legislationId', 'title', 'citation', 'type']) {
  if (!(name in column)) throw new Error(`The CSV has no ${name} column.`);
}
const dash = (value) => String(value || '').replace(/[‐-―]/g, '-').trim();
const lines = records
  .filter((record) => TYPE_PATH[record[column.type]])
  .sort((a, b) => dash(a[column.legislationId]).localeCompare(dash(b[column.legislationId]))
    || RANK[a[column.type]] - RANK[b[column.type]])
  .map((record) => {
    const id = dash(record[column.legislationId]);
    const key = engine.citation('legislationLookup', { text: record[column.citation] }).keys[0] || '';
    const title = legislation.normalizeTitle(record[column.title]);
    return [id, record[column.databaseId].trim(), TYPE_PATH[record[column.type]], key === id ? '' : key, title].join('\t');
  });
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
const text = `# legal-pinpointer-canlii-legislation-v2\tsha256=${digest}\n${lines.join('\n')}\n`;
fs.writeFileSync(output, zlib.gzipSync(text, { level: 9 }));
console.log(`Wrote ${lines.length.toLocaleString()} records to ${path.relative(process.cwd(), output)} (${fs.statSync(output).size.toLocaleString()} bytes)`);
