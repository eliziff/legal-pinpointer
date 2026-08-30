'use strict';

importScripts('canlii-legislation.js');

const canliiLegislation = globalThis.LegalPinpointerCanliiLegislation;

const MAX_TEXT_LENGTH = 12_000_000;
const ALLOWED_HOSTS = new Set([
  'canlii.org',
  'www.canlii.org',
  'advance.lexis.com',
  'nextcanada.westlaw.com',
  'www.nextcanada.westlaw.com'
]);

let enginePromise;
let legislationPromise;

async function loadEngine() {
  if (!enginePromise) {
    enginePromise = fetch(chrome.runtime.getURL('legal-structure.wasm'))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Legal structure engine failed to load (${response.status}).`);
        const bytes = await response.arrayBuffer();
        return WebAssembly.instantiate(bytes);
      })
      .then(({ instance }) => instance.exports)
      .catch((error) => {
        enginePromise = undefined;
        throw error;
      });
  }
  return enginePromise;
}

async function loadLegislationIndex() {
  if (!legislationPromise) {
    legislationPromise = fetch(chrome.runtime.getURL('canlii-legislation.tsv'))
      .then((response) => {
        if (!response.ok) throw new Error(`CanLII legislation index failed to load (${response.status}).`);
        return response.text();
      })
      .then(canliiLegislation.parseIndex)
      .catch((error) => {
        legislationPromise = undefined;
        throw error;
      });
  }
  return legislationPromise;
}

function validSender(sender) {
  try {
    if (!sender || sender.id !== chrome.runtime.id || !sender.tab || !sender.url) return false;
    const url = new URL(sender.url);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(host)) return false;
    if (host === 'canlii.org' || host === 'www.canlii.org') return /\/(?:doc|laws)\//i.test(url.pathname);
    if (host === 'advance.lexis.com') return /^\/document\//i.test(url.pathname);
    return /^\/Document\//.test(url.pathname);
  } catch (_) {
    return false;
  }
}

function validInput(input) {
  return Boolean(
    input
    && (input.source_kind === 'cases' || input.source_kind === 'laws')
    && typeof input.text === 'string'
    && input.text.length <= MAX_TEXT_LENGTH
    && typeof input.citation === 'string'
    && input.citation.length <= 5000
    && (!input.name || (typeof input.name === 'string' && input.name.length <= 2000))
  );
}

async function derive(input) {
  if (!validInput(input)) throw new Error('The legal structure request is invalid or too large.');
  const engine = await loadEngine();
  const encoded = new TextEncoder().encode(JSON.stringify(input));
  const pointer = engine.legal_structure_alloc(encoded.length);
  if (!pointer && encoded.length) throw new Error('The legal structure engine could not allocate input memory.');

  try {
    new Uint8Array(engine.memory.buffer, pointer, encoded.length).set(encoded);
    engine.legal_structure_analyze(pointer, encoded.length);
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

async function resolveLegislation(input) {
  if (!input || typeof input.title !== 'string' || input.title.length > 2000
      || typeof input.citation !== 'string' || input.citation.length > 5000
      || (input.language && (typeof input.language !== 'string' || input.language.length > 20))) {
    throw new Error('The CanLII legislation request is invalid or too large.');
  }
  const index = await loadLegislationIndex();
  return canliiLegislation.resolve(index, input.title, input.citation, input.language);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !['LEGAL_PINPOINTER_DERIVE_STRUCTURE', 'LEGAL_PINPOINTER_RESOLVE_LEGISLATION'].includes(message.type)) return false;
  if (!validSender(sender)) {
    sendResponse({ ok: false, message: 'Legal Pinpointer requests are limited to supported document pages.' });
    return false;
  }
  const task = message.type === 'LEGAL_PINPOINTER_DERIVE_STRUCTURE'
    ? derive(message.input)
    : resolveLegislation(message.input).then((url) => ({ ok: true, url }));
  task.then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, message: error.message || 'Legal Pinpointer request failed.' }));
  return true;
});
