// Page script: folder picking, search form, results. The index is read by a worker created from inline source.
import {tokens, term, terms} from './tokenize.mjs';

const COURTS = {SCC: 'Supreme Court of Canada', FCA: 'Federal Court of Appeal', FC: 'Federal Court', CMAC: 'Court Martial Appeal Court',
  CHRT: 'Canadian Human Rights Tribunal', CT: 'Competition Tribunal', SCT: 'Specific Claims Tribunal', RAD: 'Refugee Appeal Division',
  RPD: 'Refugee Protection Division', RLLR: 'Refugee Law Lab Reporter', ONCA: 'Ontario Court of Appeal', BCCA: 'BC Court of Appeal',
  BCSC: 'BC Supreme Court', NSCA: 'NS Court of Appeal', NSSC: 'NS Supreme Court', NSPC: 'NS Provincial Court', NSFC: 'NS Family Court',
  NSSM: 'NS Small Claims', YKCA: 'Yukon Court of Appeal'};
const label = code => COURTS[code] || code.replace(/^(LEGISLATION|REGULATIONS)-(.*)$/, (_, k, j) => `${j === 'FED' ? 'Federal' : j} ${k === 'LEGISLATION' ? 'statutes' : 'regulations'}`);

const $ = id => document.getElementById(id);
const worker = new Worker(URL.createObjectURL(new Blob([$('worker-src').textContent], {type: 'text/javascript'})));
let seq = 0; const pending = new Map();
worker.onmessage = ({data: {id, value, error}}) => { const p = pending.get(id); pending.delete(id); error ? p.reject(new Error(error)) : p.resolve(value); };
const call = (op, arg) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, {resolve, reject}); worker.postMessage({id, op, arg}); });

let info = null;
async function openFiles(files) {
  $('status').textContent = 'Opening…';
  try {
    info = await call('open', {files: [...files]});
    if (info.missing.length) throw new Error(`Missing or incomplete files in the folder: ${info.missing.join(', ')}`);
    $('status').textContent = `${info.docs.toLocaleString()} documents, ${info.passages.toLocaleString()} passages · opened in ${info.openMs.toFixed(0)} ms`;
    const sel = $('court'); sel.length = 1;
    const groups = [['Cases', info.datasets.filter(d => !d.code.includes('-'))], ['Legislation', info.datasets.filter(d => d.code.includes('-'))]];
    for (const [g, list] of groups) {
      sel.add(new Option(`All ${g.toLowerCase()}`, list.map(d => d.code).join(',')));
      const og = document.createElement('optgroup'); og.label = g;
      for (const d of list) og.append(new Option(label(d.code), d.code));
      sel.append(og);
    }
    for (const el of $('f').elements) el.disabled = false;
    $('q').focus();
  } catch (e) { $('status').textContent = e.message; info = null; }
  return info;
}

async function pickFolder() {
  if (!window.showDirectoryPicker) return $('dir').click();
  let dir; try { dir = await showDirectoryPicker({mode: 'read'}); } catch { return; }
  const files = [];
  const walk = async (h, depth) => { for await (const e of h.values()) { if (e.kind === 'file') files.push(await e.getFile()); else if (depth < 1) await walk(e, depth + 1); } };
  await walk(dir, 0);
  return openFiles(files);
}

function highlight(text, qterms) {
  const frag = document.createDocumentFragment(); let at = 0;
  tokens(text, (tok, s, e) => { if (qterms.has(term(tok))) { frag.append(text.slice(at, s)); const m = document.createElement('mark'); m.textContent = text.slice(s, e); frag.append(m); at = e; } });
  frag.append(text.slice(at)); return frag;
}

async function search(query, opts = {}) { return call('search', {query, opts}); }

async function run(ev) {
  ev?.preventDefault(); const q = $('q').value.trim(); if (!q || !info) return;
  const court = $('court').value, opts = {k: 100, show: 20, maxPerDoc: 2, datasets: court ? court.split(',') : [], from: $('from').value, to: $('to').value};
  $('meta').textContent = 'Searching…';
  try {
    const r = await search(q, opts), qterms = new Set(terms(q.replace(/"/g, ' ')));
    $('meta').textContent = `${r.results.length ? '' : 'No results. '}${r.searchMs.toFixed(0)} ms` + (r.missing.length ? ` · not in index: ${r.missing.join(', ')}` : '');
    const ol = $('results'); ol.replaceChildren();
    for (const h of r.results) {
      const li = document.createElement('li'), head = document.createElement('div'), a = document.createElement('a'), p = document.createElement('p');
      head.className = 'head'; a.href = h.meta.url || '#'; a.target = '_blank'; a.rel = 'noopener'; a.textContent = h.meta.citation || h.meta.name;
      const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = h.meta.citation ? h.meta.name : '';
      const sub = document.createElement('span'); sub.className = 'sub'; sub.textContent = [label(h.meta.dataset), h.meta.date].filter(Boolean).join(' · ');
      head.append(a, nm, sub); p.append(highlight(h.text, qterms)); li.append(head, p); ol.append(li);
    }
  } catch (e) { $('meta').textContent = e.message; }
}

$('pick').onclick = pickFolder;
$('dir').onchange = () => openFiles($('dir').files);
$('f').onsubmit = run;
window.a2aj = {openFiles, search, raw: arg => call('search', arg), info: () => info};
