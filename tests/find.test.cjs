'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compile, search, matches, sentences, ranked } = require('../find-core.js');
const hit = (query, text) => matches(compile(query).tree, text).map((range) => text.slice(range.start, range.end));
// A page of paragraphs: [[paragraph index, [highlighted text]]].
const page = (query, paragraphs) => search(compile(query).tree, paragraphs).map(({ index, hits }) => [index, hits.map(h => paragraphs[index].slice(h.start, h.end))]);

test('words and phrases match their variants; EXACT( ) and truncation* match the letters given', () => {
  assert.deepEqual(hit('privileg* waiv*', 'The WAIVER of solicitor-client privilege.'), ['WAIVER', 'privilege']);
  assert.deepEqual(hit('privilege waived', 'Privilege remains.'), []);
  assert.deepEqual(hit('"duty of care"', 'A duty\n of\tcare exists.'), ['duty\n of\tcare']);
  assert.deepEqual(hit('"letter of credit"', 'Letters of credit issued.'), ['Letters of credit']);
  assert.deepEqual(hit('EXACT(letter of credit)', 'Letters of credit issued.'), []);
  assert.deepEqual(hit('exact(letters of credit)', 'Letters of credit issued.'), ['Letters of credit']);
  assert.deepEqual(hit('policy', 'Its policies apply.'), ['policies']);
  assert.deepEqual(hit('arret préjudic*', 'Un ARRÊT et le préjudice.'), ['ARRÊT', 'préjudice']);
  assert.deepEqual(hit('law', 'lawful flaws outlaw law laws'), ['law', 'laws']);
  assert.deepEqual(hit('"[42]"', '[42] is literal.'), ['[42]']);
});

test('AND, a space and NOT apply to the whole page; OR binds tightest', () => {
  const paragraphs = ['The waiver of privilege was implied. Costs follow.', 'Contracts for sale. The seller refused.', 'Custody of the child.'];
  assert.deepEqual(page('privilege AND custody', paragraphs), [[0, ['privilege']], [2, ['Custody']]]);
  assert.deepEqual(page('privilege and custody', paragraphs), page('privilege custody', paragraphs));
  assert.deepEqual(page('privilege NOT custody', paragraphs), []);
  assert.deepEqual(page('privilege -custody', paragraphs), []);
  assert.deepEqual(page('privilege NOT absent', paragraphs), [[0, ['privilege']]]);
  assert.deepEqual(page('privilege or seller', paragraphs), [[0, ['privilege']], [1, ['seller']]]);
  assert.deepEqual(page('waiver NOT absent OR custody', paragraphs), []);
});

test('/p, /s and /n pair terms in one paragraph, sentence or word window', () => {
  const paragraphs = ['The waiver of privilege was implied. Costs follow.', 'Contracts for sale. The seller refused.', 'Letters of credit issued by the bank.'];
  assert.deepEqual(page('privilege /s waiver', paragraphs), [[0, ['waiver', 'privilege']]]);
  assert.deepEqual(page('privilege /P costs', paragraphs), [[0, ['privilege', 'Costs']]]);
  assert.deepEqual(page('privilege /s costs', paragraphs), []);
  assert.deepEqual(page('contract /s sale', paragraphs), [[1, ['Contracts', 'sale']]]);
  assert.deepEqual(page('(contract /s sale) OR seller', paragraphs), [[1, ['Contracts', 'sale', 'seller']]]);
  assert.deepEqual(page('contract /s sale OR seller', paragraphs), [[1, ['Contracts', 'sale']]]);
  assert.deepEqual(page('letter /2 credit', paragraphs), [[2, ['Letters', 'credit']]]);
  assert.deepEqual(page('letter /1 credit', paragraphs), []);
  assert.deepEqual(page('waiver /p NOT seller', paragraphs), [[0, ['waiver']]]);
  assert.deepEqual(page('waiver /p NOT costs', paragraphs), []);
});

test('plain words stay ranked; any written operator makes the query Boolean', () => {
  assert.equal(ranked('privilege waiver and costs'), true);
  for (const query of ['tax /s income', 'custody -child', 'custody NOT child', 'a OR b', '"phrase"', 'EXACT(x)', 'constru*']) assert.equal(ranked(query), false, query);
});

test('invalid syntax is rejected instead of silently returning misleading results', () => {
  for (const query of ['"unclosed', 'EXACT(open', 'foo AND', '(foo', 'foo)', '*', 'a*b', 'NOT foo', 'foo OR NOT bar', '""', 'EXACT()', 'OR foo', '/5 x', 'foo /q bar', 'NOT a /p NOT b']) {
    assert.throws(() => compile(query), undefined, query);
  }
  assert.throws(() => compile('x'.repeat(1025)));
  assert.equal(compile('').tree, null);
});

test('sentence boundaries do not split common legal abbreviations or cross full stops', () => {
  for (const text of ['Dr. Smith waived privilege. No costs.', 'In R. v. Smith, privilege was waived. No costs.', 'See para. 42 and s. 7. Privilege was waived.']) {
    assert.equal(sentences(text).length, 2, text);
  }
  assert.deepEqual(page('privilege /s waiver', ['Privilege was asserted. Waiver was denied.']), []);
  assert.equal(sentences('M. Tremblay invoque le secret. Il ne renonce pas.', 'fr').length, 2);
  assert.equal(sentences('One. Two.', 'not_a_valid_locale').length, 2);
});

test('repeated-term highlight caps are explicit without changing match existence', () => {
  const result = matches(compile('word').tree, 'word '.repeat(6000));
  assert.equal(result.length, 5000);
  assert.equal(result.limited, true);
});
