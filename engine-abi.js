'use strict';

(function (global) {
function invokeEngine(engine, operation, input) {
  const encoded = new TextEncoder().encode(JSON.stringify(input));
  const pointer = engine.legal_structure_alloc(encoded.length);
  if (!pointer && encoded.length) throw new Error('The legal structure engine could not allocate input memory.');

  try {
    new Uint8Array(engine.memory.buffer, pointer, encoded.length).set(encoded);
    engine[operation](pointer, encoded.length);
  } finally {
    engine.legal_structure_dealloc(pointer, encoded.length);
  }

  const outputPointer = engine.legal_structure_output_pointer();
  const outputLength = engine.legal_structure_output_length();
  const output = new Uint8Array(engine.memory.buffer, outputPointer, outputLength);
  const result = JSON.parse(new TextDecoder().decode(output));
  if (!result || result.ok !== true) throw new Error(result && result.error ? result.error : 'Legal structure derivation failed.');
  return result;
}
  global.LegalPinpointerEngineCall = invokeEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = invokeEngine;
})(globalThis);
