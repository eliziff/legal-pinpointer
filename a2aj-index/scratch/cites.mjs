// Spot-check of the builder's citation extraction: matches in a few documents, their keys, and what they resolve to.
//   node scratch/cites.mjs <case id>...
import {DatabaseSync} from 'node:sqlite';
const base = process.env.LOCALAPPDATA + '/OpenLegalProducts/LegalData/providers/a2aj/';
const dbs = ['cases', 'laws'].map(k => new DatabaseSync(`${base}a2aj-${k}-fulltext.sqlite`, {readOnly: true}));
const CITE = /\b(?:18|19|20)\d{2}\s+[A-Z][A-Z0-9-]{1,15}\s+\d+\b|\[(?:18|19|20)\d{2}\]\s+\d+\s+(?:S\.?\s?C\.?\s?R|R\.?\s?C\.?\s?S)\.?\s+\d+|\b(?:R\.?\s?)?S\.?\s?(?:[A-Z]\.?\s?){1,3}\s*(?:18|19|20)\d{2},?\s+c\.?\s*[A-Z]{0,2}-?\d+(?:\.\d+)?/g;
const look = dbs.map(db => db.prepare('SELECT document_id d FROM citation_lookup WHERE citation_key = ?'));
const name = dbs.map(db => db.prepare('SELECT citation_en c, name_en n FROM document WHERE id = ?'));
for (const id of process.argv.slice(2).map(Number)) {
  const {t, c} = dbs[0].prepare('SELECT unofficial_text_en t, citation_en c FROM document WHERE id = ?').get(id);
  const seen = new Map();
  for (const m of t.matchAll(CITE)) { const k = m[0].toLowerCase().replace(/[^a-z0-9]/g, ''); if (!seen.has(k)) seen.set(k, m[0]); }
  let hit = 0; const miss = [];
  console.log(`\n## ${c}: ${seen.size} distinct citation strings`);
  for (const [k, raw] of seen) {
    const r = look.flatMap((q, i) => q.all(k).map(x => [i, x.d]));
    if (r.length === 1) { hit++; const x = name[r[0][0]].get(r[0][1]); if (hit <= 6) console.log(`  ${raw.replace(/\s+/g, ' ')} -> ${x.c} | ${(x.n || '').slice(0, 50)}`); }
    else miss.push(raw.replace(/\s+/g, ' ') + (r.length ? ` (${r.length} docs)` : ''));
  }
  console.log(`  resolved ${hit}; unresolved ${miss.length}: ${miss.slice(0, 12).join('; ')}`);
}
