'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { compile, matches, sentences, switchScope } = require('../find-core.js');
const hit = (query, text) => matches(compile(query).tree, text).map((range) => text.slice(range.start, range.end));

test('terms AND together, phrases cross whitespace, prefixes and Unicode keep source offsets', () => {
  assert.deepEqual(hit('privileg* waiv*', 'The WAIVER of solicitor-client privilege.'), ['WAIVER', 'privilege']);
  assert.deepEqual(hit('privilege waived', 'Privilege remains.'), []);
  assert.deepEqual(hit('"duty of care"', 'A duty\n of\tcare exists.'), ['duty\n of\tcare']);
  assert.deepEqual(hit('été préjudic*', '😀 ÉTÉ et préjudice.'), ['ÉTÉ', 'préjudice']);
  assert.deepEqual(hit('law', 'lawful flaws outlaw law'), ['law']);
  assert.deepEqual(hit('"[42]"', '[42] is literal.'), ['[42]']);
});

test('Boolean grouping and exclusions evaluate within the selected unit', () => {
  assert.deepEqual(hit('(privilege OR confidentiality) waiver NOT implied', 'A waiver of confidentiality.'), ['waiver', 'confidentiality']);
  assert.deepEqual(hit('(privilege OR confidentiality) waiver NOT implied', 'An implied waiver of privilege.'), []);
  assert.deepEqual(hit('privilege privilege', 'Privilege'), ['Privilege']);
  assert.deepEqual(hit('NOT NOT privilege', 'Privilege'), ['Privilege']);
  assert.deepEqual(hit('privilege OR (waiver proof)', 'Privilege and waiver without evidence.'), ['Privilege']);
});

test('inline scope sets the mode and Tab rewrites operators but not literal phrases', () => {
  assert.equal(compile('privilege /s waiver', 'p').mode, 's');
  assert.equal(compile('privilege /p waiver', 's').mode, 'p');
  assert.equal(switchScope('privilege /p "literal /s" /p waiver', 's'), 'privilege /s "literal /s" /s waiver');
  assert.equal(compile('privilege waiver', 's').mode, 's');
});

test('invalid syntax is rejected instead of silently returning misleading results', () => {
  for (const query of ['"unclosed', 'foo /p bar /s baz', 'foo /5 bar', 'foo AND', '(foo', 'foo)', '*', 'a*b', 'NOT foo', 'foo OR NOT bar', '""', 'OR foo']) {
    assert.throws(() => compile(query), undefined, query);
  }
  assert.throws(() => compile('x'.repeat(1025)));
  assert.equal(compile('').tree, null);
});

test('sentence boundaries do not split common legal abbreviations or cross full stops', () => {
  for (const text of ['Dr. Smith waived privilege. No costs.', 'In R. v. Smith, privilege was waived. No costs.', 'See para. 42 and s. 7. Privilege was waived.']) {
    assert.equal(sentences(text).length, 2, text);
  }
  const text = 'Privilege was asserted. Waiver was denied.';
  assert.equal(sentences(text).length, 2);
  assert.equal(sentences(text).some((unit) => hit('privilege waiver', text.slice(unit.start, unit.end)).length), false);
  assert.equal(sentences('M. Tremblay invoque le secret. Il ne renonce pas.', 'fr').length, 2);
  assert.equal(sentences('One. Two.', 'not_a_valid_locale').length, 2);
});


test('repeated-term highlight caps are explicit without changing match existence', () => {
  const result = matches(compile('word').tree, 'word '.repeat(6000));
  assert.equal(result.length, 5000);
  assert.equal(result.limited, true);
});

