'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuery, searchParagraphs, sentenceSpans } = require('../find.js');
const find = (texts, query, mode = 'p', locale = 'en') => {
  const parsed = parseQuery(query);
  return searchParagraphs(texts.map(text => ({ text })), parsed, parsed.mode || mode, locale);
};

test('/p and /s require every term in one unit, in either order', () => {
  const texts = ['Privilege exists. Waiver does not.', 'Waiver of privilege follows.', 'Privilege only.', 'Waiver only.'];
  assert.equal(find(texts, 'privilege waiver').length, 2);
  assert.equal(find(texts, 'privilege /s waiver').length, 1);
  assert.equal(find(texts, 'waiver /p privilege').length, 2);
  assert.equal(find(['Privilege.', 'Waiver.'], 'privilege waiver').length, 0);
  assert.equal(find(['Privilege waiver. Privilege waiver.'], 'privilege waiver', 's').length, 2);
});

test('phrases, word-ending wildcards, Unicode words and literal regex characters', () => {
  assert.equal(find(['A DUTY   of care was waived.'], '"duty of care" waiv*').length, 1);
  assert.equal(find(['Privileges were waived.'], 'privileg* waiv*').length, 1);
  assert.equal(find(['Disprivileged waivers.'], 'privileg* waiver').length, 0);
  assert.equal(find(['Un secret est révélé.'], 'secret révélé', 's', 'fr').length, 1);
  assert.equal(find(['Révélée.'], 'révélé').length, 0);
  assert.equal(find(['Costs are $5.00 (net).'], '"$5.00" "(net)"').length, 1);
  assert.equal(find(['A duty of care exists.'], '“duty of care”').length, 1);
});

test('query mistakes report errors instead of executing a different search', () => {
  for (const query of ['"unclosed phrase', 'a /p b /s c', '*', 'wa*ver', 'a OR b', 'a /12 b']) {
    assert.throws(() => parseQuery(query), Error, query);
  }
  assert.equal(find(['Anything.'], '').length, 0);
  assert.equal(parseQuery('a /P b /P c').mode, 'p');
  assert.throws(() => parseQuery('a'.repeat(2049)), /2,048/);
});

test('sentence detection handles common legal abbreviations without merging ordinary sentences', () => {
  const text = 'Mr. Smith relied on s. 7 and para. 12 in R. v. Jones. Waiver followed.';
  const spans = sentenceSpans(text);
  // ICU may split after R.; searching the operative sentence must still work.
  assert.equal(find([text], 'Smith Jones', 's').length, 1);
  assert.equal(find([text], 'Jones Waiver', 's').length, 0);
  assert.equal(find(['Le juge applique l’art. 7. Le secret demeure.'], 'juge secret', 's', 'fr').length, 0);
  assert.equal(spans[spans.length - 1].end, text.length);
});

test('hit offsets refer to the source text, including astral characters and inline-space normalization', () => {
  const text = '😀 Privilege and WAIVER; privilege survives.';
  const result = find([text], 'privilege waiver')[0];
  assert.deepEqual(result.hits.map(hit => text.slice(hit.start, hit.end)), ['Privilege', 'privilege', 'WAIVER']);
  const sentence = find(['Unrelated. 😀 Privilege and waiver.'], 'privilege waiver', 's')[0];
  assert.deepEqual(sentence.hits.map(hit => sentence.paragraph.text.slice(hit.start, hit.end)), ['Privilege', 'waiver']);
});
