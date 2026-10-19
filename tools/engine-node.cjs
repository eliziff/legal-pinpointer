'use strict';

// The packaged engine (legal-structure.wasm.gz) for Node tools: wasm bytes, an initialized
// instance, and a citation call shaped like the extension's (LegalPinpointerCitationCall).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
let engine;

function wasmBytes() {
  return zlib.gunzipSync(fs.readFileSync(path.join(root, 'legal-structure.wasm.gz')));
}

function load() {
  engine ||= require(path.join(root, 'legal-structure.mjs')).initSync({ module: wasmBytes() });
  return engine;
}

function invoke(operation, input) {
  return require(path.join(root, 'engine-abi.js'))(load(), operation, input);
}

function citation(method, request) {
  return invoke('legal_citations_call', { method, request }).result;
}

module.exports = { citation, invoke, load, wasmBytes };
