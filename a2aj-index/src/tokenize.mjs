// Shared by the index builder (Node) and the search page (browser): both sides must produce identical terms.
// Tokens: maximal runs of letters/digits/marks, diacritics folded (NFD, marks dropped), lowercased.
// Terms: tokens of length 2..32 that are not English stopwords; purely alphabetic tokens are Porter-stemmed.
import {stemmer} from 'stemmer';

export const STOP = new Set(('a an and are as at be been but by for from had has have he her hers him his i if in into is it its ' +
  'me my no nor not of on or our she so such than that the their them then there these they this those to too us was we were ' +
  'what when where which while who whom why will with would you your yours can could did do does done may might must shall should ' +
  'also any all both each few more most other some own same very just about above after again against before below between ' +
  'during further here how once only out over through under until up down off whether upon').split(' '));

const WORDCHAR = /[\p{L}\p{N}\p{M}]/u, MARKS = /\p{M}/gu, ALPHA = /^[a-z]+$/;
const ASCII = new Uint8Array(128); // 1 = word char, 2 = uppercase
for (let c = 48; c < 58; c++) ASCII[c] = 1;
for (let c = 97; c < 123; c++) ASCII[c] = 1;
for (let c = 65; c < 91; c++) ASCII[c] = 2;
const wide = new Map();
const isWord = c => { let v = wide.get(c); if (v === undefined) wide.set(c, v = WORDCHAR.test(String.fromCodePoint(c))); return v; };

export const fold = s => s.normalize('NFD').replace(MARKS, '').toLowerCase();

// Calls cb(token, start, end) for each folded token in text (start/end: offsets in text).
export function tokens(text, cb) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    let c = text.charCodeAt(i);
    if (c < 128 ? !ASCII[c] : !isWord(c >= 0xd800 && c < 0xdc00 ? text.codePointAt(i) : c)) { i++; continue; }
    const start = i; let plain = true;
    while (i < n) {
      c = text.charCodeAt(i);
      if (c < 128) { const k = ASCII[c]; if (!k) break; if (k === 2) plain = false; i++; }
      else { const cp = c >= 0xd800 && c < 0xdc00 ? text.codePointAt(i) : c; if (!isWord(cp)) break; plain = false; i += cp > 0xffff ? 2 : 1; }
    }
    const raw = text.slice(start, i);
    cb(plain ? raw : fold(raw), start, i);
  }
}

const memo = new Map();
export function term(tok) { // tok: a folded token; returns the indexed term or null
  let t = memo.get(tok);
  if (t !== undefined) return t;
  t = tok.length < 2 || tok.length > 32 || STOP.has(tok) ? null : ALPHA.test(tok) ? stemmer(tok) : tok;
  if (memo.size > 1 << 21) memo.clear();
  memo.set(tok, t);
  return t;
}

// All indexed terms of a text, in order (duplicates kept).
export function terms(text) {
  const out = [];
  tokens(text, tok => { const t = term(tok); if (t) out.push(t); });
  return out;
}

// Normalized form used for exact-phrase verification: folded tokens joined by single spaces, padded.
export function phraseNorm(text) {
  const out = [];
  tokens(text, tok => out.push(tok));
  return ' ' + out.join(' ') + ' ';
}
