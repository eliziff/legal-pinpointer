'use strict';

globalThis.LegalPinpointerCitationCall = citationCall;

importScripts('legal-structure.js', 'engine-abi.js', 'core.js', 'canlii-legislation.js', 'find-core.js', 'find-worker.js', 'sonar-launcher.js');

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
let caseAliasPromise;

async function loadEngine() {
  if (!enginePromise) {
    enginePromise = fetch(chrome.runtime.getURL('legal-structure.wasm'))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Legal structure engine failed to load (${response.status}).`);
        const bytes = await response.arrayBuffer();
        return legalStructureInit({ module_or_path: bytes });
      })
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

// Reporter/alias citation key -> CanLII target, built by tools/build-canlii-case-aliases.py.
async function loadCaseAliasIndex() {
  if (!caseAliasPromise) {
    caseAliasPromise = fetch(chrome.runtime.getURL('canlii-case-aliases.tsv'))
      .then((response) => {
        if (!response.ok) throw new Error(`CanLII case alias index failed to load (${response.status}).`);
        return response.text();
      })
      .then((text) => new Map(text.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => line.split('\t'))))
      .catch((error) => {
        caseAliasPromise = undefined;
        throw error;
      });
  }
  return caseAliasPromise;
}

async function resolveCase(input) {
  const keys = input && Array.isArray(input.keys) ? input.keys : null;
  if (!keys || keys.length > 50 || keys.some((key) => typeof key !== 'string' || key.length > 200)) {
    throw new Error('The CanLII case request is invalid or too large.');
  }
  const index = await loadCaseAliasIndex();
  return Array.from(new Set(keys.map((key) => index.get(key)).filter(Boolean)));
}

function validSender(sender) {
  try {
    if (!sender || sender.id !== chrome.runtime.id || !sender.tab || !sender.url) return false;
    const url = new URL(sender.url);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(host)) return false;
    if (host === 'canlii.org' || host === 'www.canlii.org') return /\/(?:doc|laws)\//i.test(url.pathname);
    if (host === 'advance.lexis.com') return /^\/(?:document|search)\//i.test(url.pathname);
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
  return invokeEngine('legal_structure_analyze', input);
}

async function citationCall(method, request) {
  if (typeof method !== 'string' || method.length > 80 || !request || typeof request !== 'object'
      || JSON.stringify(request).length > MAX_TEXT_LENGTH) {
    throw new Error('The citation request is invalid or too large.');
  }
  const response = await invokeEngine('legal_citations_call', { method, request });
  return response.result;
}

async function invokeEngine(operation, input) {
  return globalThis.LegalPinpointerEngineCall(await loadEngine(), operation, input);
}

async function resolveLegislation(input) {
  if (!input || typeof input.title !== 'string' || input.title.length > 2000
      || typeof input.citation !== 'string' || input.citation.length > 5000
      || (input.language && (typeof input.language !== 'string' || input.language.length > 20))) {
    throw new Error('The CanLII legislation request is invalid or too large.');
  }
  const [index, lookup] = await Promise.all([loadLegislationIndex(),
    citationCall('legislationLookup', { text: input.citation })]);
  return canliiLegislation.resolve(index, input.title, input.citation, input.language, lookup);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !['LEGAL_PINPOINTER_DERIVE_STRUCTURE', 'LEGAL_PINPOINTER_RESOLVE_LEGISLATION', 'LEGAL_PINPOINTER_RESOLVE_CASE', 'LEGAL_PINPOINTER_CITATION_CALL'].includes(message.type)) return false;
  if (!validSender(sender)) {
    sendResponse({ ok: false, message: 'Legal Pinpointer requests are limited to supported document pages.' });
    return false;
  }
  const task = message.type === 'LEGAL_PINPOINTER_CITATION_CALL'
    ? citationCall(message.method, message.request).then(result => ({ ok: true, result }))
    : message.type === 'LEGAL_PINPOINTER_DERIVE_STRUCTURE'
    ? derive(message.input)
    : message.type === 'LEGAL_PINPOINTER_RESOLVE_CASE'
      ? resolveCase(message.input).then((targets) => ({ ok: true, targets }))
      : resolveLegislation(message.input).then((url) => ({ ok: true, url }));
  task.then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, message: error.message || 'Legal Pinpointer request failed.' }));
  return true;
});
