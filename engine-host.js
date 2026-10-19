'use strict';

// The engine host: an offscreen document that keeps the legal-structure WASM and the CanLII
// indexes loaded while they are in use. The service worker is suspended after 30 idle seconds;
// before, every suspension cost a fresh WASM compile and the legislation index parse. The host
// is created on first use and asks to be closed after ten idle minutes (sooner once a very large
// document has grown the engine's memory, which WASM never returns), so idle browsing holds none
// of it. Only the service worker talks to this page, so a request is never answered twice.
(function startEngineHost() {
  const legislation = globalThis.LegalPinpointerCanliiLegislation;
  const workerUrl = chrome.runtime.getURL('engine-worker.js');
  const IDLE_CLOSE = 10 * 60_000, LARGE_CLOSE = 20_000, LARGE_MEMORY = 96 * 1024 * 1024;
  let enginePromise, legislationPromise, caseAliasPromise, engineMemory = null, idleTimer = 0;

  function touch() {
    clearTimeout(idleTimer);
    const large = engineMemory && engineMemory.buffer.byteLength > LARGE_MEMORY;
    idleTimer = setTimeout(() => chrome.runtime.sendMessage({ type: 'LEGAL_PINPOINTER_ENGINE_IDLE' }).catch(() => {}),
      large ? LARGE_CLOSE : IDLE_CLOSE);
  }

  function gunzip(name) {
    return fetch(chrome.runtime.getURL(name)).then((response) => {
      if (!response.ok) throw new Error(`${name} failed to load (${response.status}).`);
      return new Response(response.body.pipeThrough(new DecompressionStream('gzip')));
    });
  }

  function once(load, reset) {
    return load().catch((error) => { reset(); throw error; });
  }

  function loadEngine() {
    enginePromise ||= once(async () => {
      const response = await gunzip('legal-structure.wasm.gz');
      const engine = await legalStructureInit({ module_or_path: await response.arrayBuffer() });
      engineMemory = engine.memory;
      return engine;
    }, () => { enginePromise = undefined; });
    return enginePromise;
  }

  function loadLegislation() {
    legislationPromise ||= once(async () => legislation.parseIndex(await (await gunzip('canlii-legislation.tsv.gz')).text()),
      () => { legislationPromise = undefined; });
    return legislationPromise;
  }

  // Reporter/alias citation key -> CanLII target, built by tools/build-canlii-case-aliases.py.
  function loadCaseAliases() {
    caseAliasPromise ||= once(async () => {
      const map = new Map();
      for (const line of (await (await gunzip('canlii-case-aliases.tsv.gz')).text()).split('\n')) {
        if (!line || line[0] === '#') continue;
        const tab = line.indexOf('\t');
        if (tab > 0) map.set(line.slice(0, tab), line.slice(tab + 1).replace(/\r$/, ''));
      }
      return map;
    }, () => { caseAliasPromise = undefined; });
    return caseAliasPromise;
  }

  async function invoke(operation, input) {
    return globalThis.LegalPinpointerEngineCall(await loadEngine(), operation, input);
  }

  async function citation(method, request) {
    return (await invoke('legal_citations_call', { method, request })).result;
  }

  async function resolveLegislation(input) {
    const [index, lookup] = await Promise.all([loadLegislation(),
      input.citation ? citation('legislationLookup', { text: input.citation }) : { candidates: [], jurisdiction: '' }]);
    return legislation.resolve(index, input.title, input.citation, input.language, lookup);
  }

  async function resolveCase(input) {
    const index = await loadCaseAliases();
    return Array.from(new Set(input.keys.map((key) => index.get(key)).filter(Boolean)));
  }

  // The rich clipboard for pages the extension cannot script (Chrome's PDF viewer).
  function clipboard(input) {
    const area = document.getElementById('clipboard');
    if (input.op === 'read') {
      area.value = '';
      area.focus();
      document.execCommand('paste');
      return area.value;
    }
    const onCopy = (event) => {
      event.preventDefault();
      event.clipboardData.setData('text/plain', input.plain);
      if (input.html) event.clipboardData.setData('text/html', input.html);
    };
    document.addEventListener('copy', onCopy, { once: true });
    area.value = input.plain || ' ';
    area.select();
    const copied = document.execCommand('copy');
    document.removeEventListener('copy', onCopy);
    if (!copied) throw new Error('The browser denied clipboard access.');
    return true;
  }

  const handlers = {
    derive: (input) => invoke('legal_structure_analyze', input),
    citation: (input) => citation(input.method, input.request),
    legislation: resolveLegislation,
    case: resolveCase,
    clipboard: async (input) => clipboard(input),
    ping: async () => true
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'LEGAL_PINPOINTER_ENGINE_HOST' || sender.id !== chrome.runtime.id
        || sender.tab || sender.url !== workerUrl || !handlers[message.op]) return false;
    handlers[message.op](message.input || {})
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, message: error.message || 'Legal Pinpointer engine request failed.' }))
      .finally(touch);
    return true;
  });

  // The host opens for a request; warm the engine's tables and the case index behind it. The
  // legislation index loads on the first legislation page.
  setTimeout(() => {
    loadEngine().then(() => citation('formatDocument', { documentType: 'case', title: 'A v B', citation: '2016 SCC 27' }))
      .then(loadCaseAliases).catch(() => {});
  }, 50);
  touch();
})();
