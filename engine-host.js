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
  let enginePromise, legislationPromise, caseAliasPromise, courtSitePromise, engineMemory = null, idleTimer = 0;

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

  // Citation key -> the decision on its court's Lexum/Decisia site, built by
  // tools/build-a2aj-case-index.cjs from A2AJ metadata; loaded only when CanLII has no version.
  function loadCourtSites() {
    courtSitePromise ||= once(async () => {
      const prefixes = [], map = new Map();
      for (const line of (await (await gunzip('case-court-sites.tsv.gz')).text()).split('\n')) {
        const tab = line.indexOf('\t');
        if (tab < 0) continue;
        if (line.startsWith('#p')) prefixes[Number(line.slice(2, tab))] = line.slice(tab + 1);
        else if (line[0] !== '#') map.set(line.slice(0, tab), line.slice(tab + 1));
      }
      return { prefixes, map };
    }, () => { courtSitePromise = undefined; });
    return courtSitePromise;
  }

  async function courtSites(keys) {
    const { prefixes, map } = await loadCourtSites();
    const sites = {};
    for (const key of keys) {
      const value = map.get(key);
      if (!value) continue;
      const colon = value.indexOf(':');
      sites[key] = `${prefixes[Number(value.slice(0, colon))]}${value.slice(colon + 1)}/index.do`;
    }
    return sites;
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

  // A Lexum/Decisia decision's CanLII page, from the citations its page lists: a routed neutral
  // citation directly, else the one CanLII target its keyed citations agree on.
  async function identity(input) {
    const direct = await citation('canliiCitationUrl', { text: input.text, language: 'en' });
    if (direct) return direct;
    const found = await citation('extract', { text: input.text, options: { resolve: false, parallel: false } });
    const keys = Array.from(new Set(found.citations.filter((item) => item.form === 'full' && item.key).map((item) => item.key)));
    const index = await loadCaseAliases();
    const targets = Array.from(new Set(keys.map((key) => index.get(key)).filter(Boolean)));
    if (targets.length !== 1) return '';
    const target = await citation('canliiAliasTargetInfo', { target: targets[0], language: 'en' });
    return target && target.url ? target.url : '';
  }

  async function resolveCase(input) {
    const index = await loadCaseAliases();
    const targets = Array.from(new Set(input.keys.map((key) => index.get(key)).filter(Boolean)));
    return { targets, sites: input.sites ? await courtSites(input.keys) : {} };
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
    identity,
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
