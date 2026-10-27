'use strict';

// Extends the case indexes from the A2AJ open case-law metadata (https://a2aj.ca, local SQLite copy):
//
// 1. canlii-case-aliases.tsv.gz (built by tools/build-canlii-case-aliases.py) gains every parallel
//    citation A2AJ records for a decision with a neutral citation that CanLII routes, e.g. the SCR
//    citation [2016] 1 SCR 631 -> 2016 SCC 27. Rows already present win; a key A2AJ maps to two
//    decisions is left out.
// 2. case-court-sites.tsv.gz: citation key -> the decision on its court's own Lexum/Decisia site, the
//    fallback when a case has no CanLII version (and the identity Case Marker files it under).
//
// Keys are the packaged engine's identity keys, as A2AJ's citation_lookup table must hold them (the app re-keys it
// when the engine's key version changes).
// Usage: node tools/build-a2aj-case-index.cjs <a2aj.sqlite>
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const engine = require('./engine-node.cjs');

const root = path.resolve(__dirname, '..');
const [databasePath] = process.argv.slice(2);
if (!databasePath) { process.stderr.write('Usage: node tools/build-a2aj-case-index.cjs <a2aj.sqlite>\n'); process.exit(2); }
const database = new DatabaseSync(databasePath, { readOnly: true });

const ALIASES = path.join(root, 'canlii-case-aliases.tsv.gz');
const SITES = path.join(root, 'case-court-sites.tsv.gz');
const DECISIA = /^https:\/\/([a-z0-9.-]+)\/([a-z0-9-]+\/[a-z0-9-]+)\/(en|fr)\/item\/(\d+)\/index\.do$/;

// Re-running keeps every row: rows from an earlier run are present, so they win unchanged.
function readRows(file) {
  const rows = new Map();
  if (!fs.existsSync(file)) return rows;
  for (const line of zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const tab = line.indexOf('\t');
    if (tab > 0) rows.set(line.slice(0, tab), line.slice(tab + 1));
  }
  return rows;
}

function write(file, header, lines) {
  const body = lines.join('');
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(`${header}\tsha256=${digest}\n${body}`, 'utf8'), { level: 9 }));
}

const version = engine.citation('extract', { text: '2016 SCC 27', options: { resolve: false, parallel: false } })
  .citations[0].key.split(':')[0];
const stored = database.prepare('select citation_key from citation_lookup limit 1').get()?.citation_key.split(':')[0];
if (stored !== version) {
  process.stderr.write(`A2AJ's citation keys are version ${stored}, the engine's ${version}: re-key the store first.\n`);
  process.exit(1);
}
const keysOf = new Map();
for (const { citation_key: key, document_id: id } of database.prepare('select citation_key, document_id from citation_lookup').iterate()) {
  const keys = keysOf.get(id);
  if (keys) keys.push(key); else keysOf.set(id, [key]);
}

// 1. Parallel citations of routed neutral citations.
const base = readRows(ALIASES);
const added = new Map(), conflicts = new Set(), routed = new Map();
const canliiRouted = (citation) => {
  const series = citation.replace(/^\d{4}\s+/, '').replace(/\s+\d+$/, '');
  if (!routed.has(series)) routed.set(series, Boolean(engine.citation('canliiCitationUrl', { text: citation, language: 'en' })));
  return routed.get(series);
};
const documents = database.prepare("select id, citation_en, url_en from document where doc_type = 'cases'").all();
for (const { id, citation_en: citation } of documents) {
  if (!/^\d{4} [A-Za-z][A-Za-z .]*[A-Za-z] \d+$/.test(citation || '') || !canliiRouted(citation)) continue;
  for (const key of keysOf.get(id) || []) {
    if (key.startsWith(`${version}:neutral:`) || base.has(key) || conflicts.has(key)) continue;
    if (added.has(key) && added.get(key) !== citation) { added.delete(key); conflicts.add(key); continue; }
    added.set(key, citation);
  }
}
const aliases = new Map([...base, ...added]);
const aliasLines = [...aliases.keys()].sort().map((key) => `${key}\t${aliases.get(key)}\n`);
write(ALIASES, `# legal-pinpointer-canlii-case-aliases-v${version}`, aliasLines);

// 2. Lexum/Decisia court sites, written as <prefix number>:<item id> against a prefix table.
const prefixes = new Map(), sites = new Map(), siteConflicts = new Set();
for (const { id, url_en: url } of documents) {
  const match = DECISIA.exec(url || '');
  if (!match) continue;
  const prefix = `https://${match[1]}/${match[2]}/${match[3]}/item/`;
  if (!prefixes.has(prefix)) prefixes.set(prefix, prefixes.size);
  const value = `${prefixes.get(prefix)}:${match[4]}`;
  for (const key of keysOf.get(id) || []) {
    if (siteConflicts.has(key)) continue;
    if (sites.has(key) && sites.get(key) !== value) { sites.delete(key); siteConflicts.add(key); continue; }
    sites.set(key, value);
  }
}
const siteLines = [...[...prefixes].map(([prefix, number]) => `#p${number}\t${prefix}\n`),
  ...[...sites.keys()].sort().map((key) => `${key}\t${sites.get(key)}\n`)];
write(SITES, '# legal-pinpointer-case-court-sites-v1 (A2AJ open case-law metadata; <prefix>:<item> -> <prefix>/<item>/index.do)', siteLines);

console.log(JSON.stringify({
  aliases: { base: base.size, added: added.size, conflicts: conflicts.size, total: aliases.size, bytes: fs.statSync(ALIASES).size },
  sites: { keys: sites.size, prefixes: prefixes.size, conflicts: siteConflicts.size, bytes: fs.statSync(SITES).size }
}));
