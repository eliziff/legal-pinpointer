'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
global.LegalPinpointerCore = {};
const fragments = require('../text-fragments.js');

// Minimal single-text-node fixture; real DOM mapping is checked in the browser
// regression. This isolates fragment matching without adding a DOM dependency.
function resolve(text, directives) {
  const document = { createRange() { return {
    setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
    setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; },
    toString() { return text.slice(this.startOffset, this.endOffset); }
  }; } };
  const root = { nodeType: 1, tagName: 'P', ownerDocument: document, closest: () => null };
  root.childNodes = [{ nodeType: 3, nodeValue: text, parentElement: root }];
  const url = 'https://example.test/doc#:~:' + directives.map(d => {
    const fields = [];
    if (d.prefix) fields.push(`${encodeURIComponent(d.prefix)}-`);
    fields.push(encodeURIComponent(d.start));
    if (d.end) fields.push(encodeURIComponent(d.end));
    if (d.suffix) fields.push(`-${encodeURIComponent(d.suffix)}`);
    return `text=${fields.join(',')}`;
  }).join('&');
  return fragments.resolveUrl(url, root);
}

// Previous matching contract, deliberately kept simple as a differential oracle.
function reference(text, d) {
  const normalize = s => String(s || '').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
  text = normalize(text) + ' ';
  const start = normalize(d.start), end = normalize(d.end), prefix = normalize(d.prefix), suffix = normalize(d.suffix);
  function* occurrences(needle, from) {
    if (!needle) return;
    for (let at = text.indexOf(needle, from); at >= 0; at = text.indexOf(needle, at + needle.length)) yield at;
  }
  const context = (a, b) => (!prefix || text.slice(0, a).trimEnd().endsWith(prefix)) &&
    (!suffix || text.slice(b).trimStart().startsWith(suffix));
  for (const a of occurrences(start, 0)) {
    if (!end) { if (context(a, a + start.length)) return { start: a, end: a + start.length }; }
    else for (const b of occurrences(end, a + start.length)) if (context(a, b + end.length)) return { start: a, end: b + end.length };
  }
  return null;
}

test('fragment matching retains context, occurrence order, overlaps and multiple directives', () => {
  let state = 39173;
  const random = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state >>> 12) % n; };
  const tokens = ['a', 'aa', 'aaa', 'ab', 'end', 'target', 'ÉTÉ', '😀', '[42]', '.', 'notfound'];
  for (let i = 0; i < 700; i++) {
    const text = Array.from({ length: 8 + random(24) }, () => tokens[random(tokens.length - 1)]).join(' ');
    const directive = { start: tokens[random(tokens.length)], end: random(3) ? tokens[random(tokens.length)] : '',
      prefix: random(2) ? tokens[random(tokens.length)] : '', suffix: random(2) ? tokens[random(tokens.length)] : '' };
    const expected = reference(text, directive), result = resolve(text, [directive]);
    assert.deepEqual(result?.matches[0] || null, expected, JSON.stringify({ text, directive }));
  }
  // Adjacent, self-overlapping patterns can follow different endpoint chains.
  for (let i = 0; i < 500; i++) {
    const text = Array.from({ length: 5 + random(28) }, () => 'ab '[random(3)]).join('').trim() || 'a';
    const terms = ['a', 'aa', 'aaa', 'ab', 'ba', 'aba'];
    const directive = { start: terms[random(terms.length)], end: terms[random(terms.length)],
      prefix: random(2) ? terms[random(terms.length)] : '', suffix: terms[random(terms.length)] };
    assert.deepEqual(resolve(text, [directive])?.matches[0] || null, reference(text, directive));
  }
  const result = resolve('before first end skip first end after final', [
    { start: 'first', end: 'end', suffix: 'after' }, { start: 'final' }
  ]);
  assert.deepEqual(result.matches, [{ start: 7, end: 31 }, { start: 38, end: 43 }]);
  assert.equal(result.text, 'first end skip first end after final');
});

test('failed endpoint chains and missing endpoints do not trigger Cartesian rescans', () => {
  for (const size of [200, 800]) {
    for (const end of ['end', 'missing']) {
      const text = 'required ' + 'start end '.repeat(size) + 'last';
      const original = String.prototype.indexOf;
      let calls = 0;
      try {
        String.prototype.indexOf = function(...args) { calls++; return original.apply(this, args); };
        assert.equal(resolve(text, [{ start: 'start', end, suffix: 'required' }]), null);
      } finally { String.prototype.indexOf = original; }
      assert.ok(calls < size * 4 + 30, `${end}: ${calls} searches for ${size} repeated endpoints`);
    }
  }
});

test('all text directives share one case-folded document view', () => {
  const text = 'Prefix Alpha Beta Gamma Delta end.';
  const original = String.prototype.toLocaleLowerCase;
  let fullDocumentFolds = 0;
  try {
    String.prototype.toLocaleLowerCase = function(...args) {
      if (String(this) === text + ' ') fullDocumentFolds++;
      return original.apply(this, args);
    };
    assert.equal(resolve(text, [{ start: 'alpha' }, { start: 'beta' }, { start: 'gamma' }]).matches.length, 3);
  } finally { String.prototype.toLocaleLowerCase = original; }
  assert.equal(fullDocumentFolds, 1);
});
