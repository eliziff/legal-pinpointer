'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let enginePromise;

async function engine() {
  if (!enginePromise) {
    enginePromise = WebAssembly.instantiate(fs.readFileSync(path.join(__dirname, '..', 'legal-structure.wasm')))
      .then(({ instance }) => instance.exports);
  }
  return enginePromise;
}

async function analyze(input) {
  const exports = await engine();
  const encoded = new TextEncoder().encode(JSON.stringify(input));
  const pointer = exports.legal_structure_alloc(encoded.length);
  new Uint8Array(exports.memory.buffer, pointer, encoded.length).set(encoded);
  exports.legal_structure_analyze(pointer, encoded.length);
  exports.legal_structure_dealloc(pointer, encoded.length);
  const output = new Uint8Array(
    exports.memory.buffer,
    exports.legal_structure_output_pointer(),
    exports.legal_structure_output_length()
  );
  return JSON.parse(new TextDecoder().decode(output));
}

const paragraph = (number) => `[${number}] This is substantive numbered judgment text with enough words to establish flowing body prose.\n`;

test('the packaged exact engine rejects an incidental quoted page marker', async () => {
  const result = await analyze({
    citation: 'Example v Example, 2024 SCC 1',
    source_kind: 'cases',
    text: `${paragraph(1)}A quotation mentions [page 207] only incidentally.\n${paragraph(2)}${paragraph(3)}${paragraph(4)}${paragraph(5)}`
  });
  assert.equal(result.ok, true);
  assert.equal(result.nodes.some((node) => node.kind === 'page'), false);
  assert.equal(result.nodes.some((node) => node.kind === 'paragraph'), true);
});

test('a page-delimited case outranks its paragraph sequence', async () => {
  const result = await analyze({
    citation: 'Example v Example, 2024 SCC 1, [2024] 2 SCR 353',
    source_kind: 'cases',
    text: `[page 353]\n${paragraph(1)}[page 354]\n${paragraph(2)}[page 355]\n${paragraph(3)}`
  });
  assert.equal(result.ok, true);
  assert.equal(result.offset_unit, 'utf16');
  assert.deepEqual(result.nodes.filter((node) => node.kind === 'page').map((node) => node.label), ['page353', 'page354']);
  assert.match(result.engine_source_sha256, /^[a-f0-9]{64}$/);
});

test('the exact laws grammar derives nested sections', async () => {
  const result = await analyze({
    citation: 'Example Rules',
    source_kind: 'laws',
    text: '1. Definitions\nWords have their ordinary meaning.\n\n2. Application\n(1) These Rules apply.\n(2) A court may order otherwise.\n\n3. Filing\nA document must be filed.\n\n4. Service\nA filed document must be served.'
  });
  assert.equal(result.ok, true);
  const labels = result.nodes.filter((node) => node.kind === 'section').map((node) => node.label);
  assert.ok(labels.includes('sec2'));
  assert.ok(labels.includes('sec2(1)'));
  assert.ok(labels.includes('sec2(2)'));
});

test('ordered provider evidence promotes a single legislation excerpt', async () => {
  const body = [
    'Definitions',
    '1 In this Act,',
    '(a) "agent" means an agent as defined in the Personal Directives Act;',
    '(b) "assisted person" means',
    '(i) an assisted adult, and',
    '(ii) a person named in an order;'
  ].join('\n');
  const result = await analyze({
    provider: 'lexis',
    citation: 'ADULT GUARDIANSHIP AND TRUSTEESHIP ACT, SA 2008, c A-4.2, s 1',
    source_kind: 'laws',
    text: `Part 1\nInterpretation\nSECTION 1\n${body}`,
    section_map: [['1', body]]
  });
  assert.equal(result.ok, true);
  const sections = result.nodes.filter((node) => node.kind === 'section');
  assert.equal(sections.filter((node) => node.label === 'sec1').length, 1);
  assert.ok(sections.some((node) => node.label === 'sec1(a)'));
  assert.ok(sections.some((node) => node.label === 'sec1(b)(i)'));
});
