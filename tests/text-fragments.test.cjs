'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
global.LegalPinpointerCanliiCourts = require('../canlii-courts.js');
global.LegalPinpointerCore = require('../core.js');
const fragments = require('../text-fragments.js');

test('parses WICG text directives, including range bounds and context', () => {
  assert.deepEqual(fragments.parseDirective('text=before-,first%20words,last%20words,-after'), {
    prefix: 'before',
    start: 'first words',
    end: 'last words',
    suffix: 'after'
  });
});

test('extracts every text directive and ignores unrelated fragment directives', () => {
  assert.deepEqual(
    fragments.directivesFromUrl('https://example.test/doc#:~:text=alpha,beta&foo=bar&text=gamma'),
    [
      { prefix: '', start: 'alpha', end: 'beta', suffix: '' },
      { prefix: '', start: 'gamma', end: '', suffix: '' }
    ]
  );
});

test('recognizes only current-document text fragment URLs', () => {
  assert.equal(fragments.isForDocument('https://example.test/doc#:~:text=alpha', ['https://example.test/doc?ignored=1']), true);
  assert.equal(fragments.isForDocument('https://example.test/other#:~:text=alpha', ['https://example.test/doc']), false);
});

test('scalar offsets map to UTF-16 offsets across astral characters', () => {
  assert.deepEqual(fragments.scalarToUtf16Map('A😀B'), [0, 1, 3, 4]);
});
