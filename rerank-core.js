'use strict';

// BERT uncased WordPiece for the bundled MiniLM cross-encoder, checked token for
// token against Hugging Face tokenizers (tests/rerank.test.cjs). No model code here.
(function exposeRerankCore(global) {
  const CLS = 101, SEP = 102, UNK = 100;
  // Dropped characters (NUL, U+FFFD, controls and formats other than tab and
  // newlines), CJK ideographs (each its own word) and the punctuation BERT splits on.
  const CONTROL = /[\0�]|(?![\t\n\r])[\p{Cc}\p{Cf}]/gu;
  const CJK = /[一-鿿㐀-䶿\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}豈-﫿\u{2f800}-\u{2fa1f}]/gu;
  const PUNCTUATION = /([!-/:-@[-`{-~]|\p{P})/u;

  function createTokenizer(vocabulary) {
    const vocab = vocabulary instanceof Map ? vocabulary : new Map(Object.entries(vocabulary));
    const cache = new Map();
    function words(text) {
      // BertNormalizer: clean text, pad CJK, strip accents, lower case; then split
      // on whitespace and on every punctuation character (whole-text passes, not per character).
      const clean = String(text).replace(CONTROL, '').replace(/\s/gu, ' ').replace(CJK, ' $& ')
        .normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase();
      const out = [];
      for (const piece of clean.split(' ')) if (piece) for (const part of piece.split(PUNCTUATION)) if (part) out.push(part);
      return out;
    }
    function wordPiece(word) {
      const known = cache.get(word);
      if (known) return known;
      let ids = [];
      const chars = [...word];
      if (chars.length > 100) ids = [UNK];
      else {
        for (let start = 0; start < chars.length;) {
          let end = chars.length, id;
          while (start < end) {
            const piece = (start ? '##' : '') + chars.slice(start, end).join('');
            id = vocab.get(piece);
            if (id !== undefined) break;
            end--;
          }
          if (id === undefined) { ids = [UNK]; break; }
          ids.push(id); start = end;
        }
      }
      if (cache.size > 50_000) cache.clear();
      cache.set(word, ids);
      return ids;
    }
    function encode(text) { return words(text).flatMap(wordPiece); }
    // [CLS] query [SEP] passage [SEP]. The query keeps at most 128 tokens and the
    // passage is cut to fit (Hugging Face longest-first truncation for any query
    // shorter than the passage, which is every realistic search).
    function pair(query, passage, maxLength = 512) {
      const a = encode(query).slice(0, 128), b = encode(passage).slice(0, maxLength - 3 - Math.min(a.length, 128));
      const ids = [CLS, ...a, SEP, ...b, SEP];
      const types = ids.map((_, i) => i > a.length + 1 ? 1 : 0);
      return { ids, types };
    }
    return { words, encode, pair };
  }
  // The bundled cross-encoder is English-only; French queries keep BM25 order.
  const FRENCH = new Set('le la les des du une est sont dans pour que qui sur pas au aux avec par ce cette ces il elle ont été être leur selon lors entre'.split(' '));
  function looksFrench(query) {
    const words = String(query).toLowerCase().split(/[^\p{L}']+/u).filter(Boolean).map(word => word.replace(/^[ldjcnsm]'|^qu'/, ''));
    const french = words.filter(word => FRENCH.has(word)).length;
    return french >= 2 || (french >= 1 && /[àâçéèêëîïôûùüÿœ]/.test(String(query).toLowerCase()));
  }
  const api = { createTokenizer, looksFrench };
  global.LegalPinpointerRerankCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
