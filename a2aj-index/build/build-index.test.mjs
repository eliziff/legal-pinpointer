import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {quality} from '../bench/metrics.mjs';

test('one mixed corpus indexes each document once and keeps citation gold independent of row IDs', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pinpointer-index-'));
  try {
    const filename = path.join(dir, 'a2aj.sqlite'), db = new DatabaseSync(filename);
    db.exec('CREATE TABLE document(id INTEGER PRIMARY KEY,doc_type,dataset,citation_en,citation2_en,name_en,document_date_en,url_en,unofficial_text_en); CREATE TABLE citation_lookup(citation_key,document_id);');
    const text = Array(20).fill('independent invented regulation and court remedy discussion').join(' ');
    const insert = db.prepare('INSERT INTO document VALUES (?,?,?,?,?,?,?,?,?)');
    insert.run(7, 'cases', 'SCC', '2026 SCC 999', null, 'Invented case', '2026-01-01', 'https://example.test/case', text);
    insert.run(41, 'laws', 'LEGISLATION-TEST', 'TEST ACT', null, 'Invented act', '2026-01-01', 'https://example.test/law', text);
    db.exec("INSERT INTO citation_lookup VALUES ('2026scc999',7),('testact',41)"); db.close();
    const config = path.join(dir, 'datasets.json'), queries = path.join(dir, 'queries.json'), output = path.join(dir, 'index'), evaluation = path.join(dir, 'eval.json');
    writeFileSync(config, JSON.stringify({source: filename, include: ['SCC', 'LEGISLATION-*']}));
    writeFileSync(queries, JSON.stringify([{docs: ['c:2026 SCC 999']}]));
    const run = spawnSync(process.execPath, ['--max-old-space-size=256', fileURLToPath(new URL('./build-index.mjs', import.meta.url)), '--out', output, '--config', config, '--eval-docs', queries, '--eval-out', evaluation], {encoding: 'utf8', timeout: 30_000});
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8')).docs, 2);
    const map = JSON.parse(readFileSync(evaluation, 'utf8'));
    assert.ok(map['2026 SCC 999']);
    const result = quality([{id: 'invented', set: 'independent', type: 'keyword', docs: ['c:2026 SCC 999']}], [{id: 'invented', docIds: ['c:2026 SCC 999'], pids: []}], map);
    assert.equal(result['independent:keyword']['docR@20'], 1);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
