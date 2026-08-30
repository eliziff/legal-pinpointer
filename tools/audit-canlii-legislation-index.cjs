'use strict';

const fs = require('node:fs');
const path = require('node:path');
const legislation = require('../canlii-legislation.js');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'canlii-legislation.tsv'), 'utf8');
const index = legislation.parseIndex(source);
const records = source.split('\n').filter((line) => line && line[0] !== '#').map((line) => {
  const [id, databaseId, lawPath, title] = line.replace(/\r$/, '').split('\t');
  return { id, databaseId, lawPath, title, titleKey: legislation.normalizeTitle(title) };
});

function url(row) {
  return `https://www.canlii.org/en/${row.databaseId.slice(0, 2)}/laws/${row.lawPath}/${row.id}/latest/${row.id}.html`;
}

function syntheticCitation(id) {
  let match = id.match(/^([a-z]+)-(\d{4}(?:-\d{2,4}){0,2})-c-(.+)$/);
  if (match) {
    const citation = `${match[1].toUpperCase()} ${match[2]}, c ${match[3]}`;
    if (legislation.legislationIdCandidates(citation).includes(id)) return citation;
  }
  match = id.match(/^(bc|alta|o|man|nb|ns|pei|nwt|nu|sask)-reg-(\d+)-(\d{2,4})$/);
  if (match) {
    const names = { bc: 'BC', alta: 'Alta', o: 'O', man: 'Man', nb: 'NB', ns: 'NS', pei: 'PEI', nwt: 'NWT', nu: 'Nu', sask: 'Sask' };
    return `${names[match[1]]} Reg ${match[2]}/${match[3]}`;
  }
  match = id.match(/^(sor|dors|si|tr)-(\d{2}|\d{4})-(\d+)$/);
  if (match) return `${match[1].toUpperCase()}/${match[2]}-${match[3]}`;
  match = id.match(/^crc-c-(\d+)$/);
  return match ? `CRC, c ${match[1]}` : '';
}

const titleGroups = new Map();
for (const row of records) {
  const identities = titleGroups.get(row.titleKey) || new Map();
  if (!identities.has(row.id)) identities.set(row.id, row);
  titleGroups.set(row.titleKey, identities);
}

const failures = [];
let uniqueTitleChecks = 0;
let ambiguousRefusals = 0;
for (const identities of titleGroups.values()) {
  const rows = [...identities.values()];
  if (rows.length === 1) {
    uniqueTitleChecks += 1;
    const actual = legislation.resolve(index, rows[0].title, '', 'en');
    if (actual !== url(rows[0])) failures.push(`unique title ${rows[0].title}: ${actual}`);
  } else {
    ambiguousRefusals += 1;
    const actual = legislation.resolve(index, rows[0].title, '', 'en');
    if (actual) failures.push(`ambiguous title ${rows[0].title}: ${actual}`);
  }
}

let citationChecks = 0;
const checked = new Set();
for (const row of records) {
  const key = `${row.id}\t${row.titleKey}`;
  if (checked.has(key)) continue;
  checked.add(key);
  const citation = syntheticCitation(row.id);
  if (!citation) continue;
  const expectedRow = (index.byId.get(row.id) || []).find((candidate) => candidate.title === row.titleKey);
  if (!expectedRow) {
    failures.push(`missing indexed identity ${row.id}: ${row.title}`);
    continue;
  }
  citationChecks += 1;
  const actual = legislation.resolve(index, row.title, citation, 'en');
  const expected = `https://www.canlii.org/en/${expectedRow.databaseId.slice(0, 2)}/laws/${expectedRow.path}/${expectedRow.id}/latest/${expectedRow.id}.html`;
  if (actual !== expected) failures.push(`citation ${citation}: ${actual} != ${expected}`);
}

if (failures.length) {
  process.stderr.write(`${failures.slice(0, 20).join('\n')}\n${failures.length} failures\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `PASS: ${records.length.toLocaleString()} snapshot rows; `
    + `${uniqueTitleChecks.toLocaleString()} unique-title resolutions; `
    + `${citationChecks.toLocaleString()} citation resolutions; `
    + `${ambiguousRefusals.toLocaleString()} ambiguous-title refusals.\n`
  );
}
