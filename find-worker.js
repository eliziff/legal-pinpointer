'use strict';

(function exposeSonarBroker(global) {
  function createBroker(api) {
    const prefix = 'pinpointer-sonar:';
    const pending = new Map();
    const messageTypes = new Set(['SONAR_SEARCH', 'SONAR_GO', 'SONAR_RETURN', 'SONAR_CLOSE']);
    const sessionKey = sender => `${prefix}${sender.tab.id}:${sender.documentId}`;
    const supported = tab => /^(https?|file):/.test(tab.url || '');
    const keyFor = target => ({ tabId: target.tabId, documentIds: [target.documentId] });
    const load = async key => (await api.storage.session.get(key))[key];
    const save = async (key, state) => api.storage.session.set({ [key]: state });
    async function invoke(target, method, args) {
      const [entry] = await api.scripting.executeScript({ target: keyFor(target),
        func: (name, values) => globalThis.LegalPinpointerSearchPage[name](...values), args: [method, args] });
      if (!entry) throw new Error('The document is no longer available.');
      return entry.result;
    }
    async function install(tabId, ui = false) {
      const files = ['find-core.js', 'find-page.js'];
      if (ui) files.push('find.js');
      const [entry] = await api.scripting.executeScript({ target: { tabId }, files });
      if (!entry?.documentId) throw new Error('Cannot read this page.');
      return { tabId, documentId: entry.documentId };
    }
    async function dispose(state) {
      await Promise.allSettled((state?.targets || []).map(target => invoke(target, 'release', [state.ticket])));
    }
    function timeout(promise, ms = 5000) {
      let timer;
      return Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Tab did not respond; it may be suspended.')), ms);
      })]).finally(() => clearTimeout(timer));
    }
    async function search(message, sender) {
      if (typeof message.query !== 'string' || message.query.length > 1024 || !['p', 's'].includes(message.mode) ||
          !['current', 'all', 'group'].includes(message.scope) || !Number.isSafeInteger(message.sequence)) throw new Error('Invalid search request.');
      const compiled = global.LegalPinpointerFindCore.compile(message.query, message.mode);
      const origin = await api.tabs.get(sender.tab.id), key = sessionKey(sender);
      const existing = await load(key);
      if (Math.max(existing?.sequence || 0, pending.get(key) || 0) >= message.sequence) return { stale: true };
      pending.set(key, message.sequence);
      const state = { ticket: crypto.randomUUID(), sequence: message.sequence, origin: { tabId: origin.id, documentId: sender.documentId },
        groupId: origin.groupId, windowId: origin.windowId, incognito: Boolean(origin.incognito), scope: message.scope,
        targets: [], results: [], updated: Date.now() };
      await save(key, state);
      // Release old ranges without changing the user's selection or reading position.
      await dispose(existing);
      const tabs = message.scope === 'current' ? [origin]
        : message.scope === 'group' ? (origin.groupId < 0 ? [] : await api.tabs.query({ groupId: origin.groupId, windowId: origin.windowId }))
          : await api.tabs.query({});
      const candidates = tabs.filter(t => Boolean(t.incognito) === state.incognito)
        .sort((a, b) => (b.id === origin.id) - (a.id === origin.id) || a.windowId - b.windowId || a.index - b.index);
      const skipped = [], pages = new Array(candidates.length), deadline = Date.now() + 18_000;
      let cursor = 0, searched = 0, limited = false;
      async function visit() {
        while (cursor < candidates.length && pending.get(key) === message.sequence) {
          const position = cursor++, tab = candidates[position];
          let reason = !supported(tab) ? 'Browser-restricted or unsupported page' : tab.discarded || tab.frozen ? 'Discarded or frozen; open it and refresh' :
            tab.status === 'loading' ? 'Still loading; refresh when ready' : Date.now() > deadline ? 'Search time limit; refresh to retry' : '';
          if (!compiled.tree) break;
          if (!reason) {
            try {
              const page = await timeout((async () => {
                const target = await install(tab.id);
                // Record the target before starting work so a close can clean it up.
                state.targets.push(target);
                const value = await invoke(target, 'search', [{ query: message.query, mode: compiled.mode, ticket: state.ticket }]);
                return { target, value };
              })());
              searched++; limited ||= page.value.limited;
              pages[position] = page.value.results.map(result => ({ ...result, ...page.target,
                title: String(page.value.title || tab.title || 'Untitled page').slice(0, 300), url: page.value.url }));
            } catch (error) { reason = `Unavailable: ${String(error.message || error).slice(0, 180)}`; }
          }
          if (reason) skipped.push({ title: String(tab.title || tab.url || `Tab ${tab.id}`).slice(0, 200), reason });
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, visit));
      if (pending.get(key) !== message.sequence || (await load(key))?.ticket !== state.ticket) {
        await dispose(state); return { stale: true };
      }
      const results = pages.flat().filter(Boolean);
      if (results.length > 1000) limited = true;
      state.results = results.slice(0, 1000); state.updated = Date.now();
      await save(key, state); 
      return { session: key, ticket: state.ticket, results: state.results, mode: compiled.mode,
        searched, total: candidates.length, skipped, limited,
        note: message.scope === 'group' && origin.groupId < 0 ? 'This tab is not in a tab group. No other ungrouped tabs were searched.' : '' };
    }
    async function go(message, sender) {
      const state = await load(message.session);
      if (!state || state.ticket !== message.ticket || message.session !== sessionKey(sender)) throw new Error('Search expired. Refresh the results.');
      const result = state.results[message.id];
      if (!result) throw new Error('Choose a search result.');
      const tab = await api.tabs.get(result.tabId);
      if (tab.url !== result.url || Boolean(tab.incognito) !== state.incognito ||
          (state.scope === 'group' && (tab.groupId !== state.groupId || tab.windowId !== state.windowId))) {
        throw new Error('The tab navigated or left this group. Refresh the search.');
      }
      if (result.tabId === state.origin.tabId) await invoke(result, 'preview', [state.ticket, result.index, true]);
      else await invoke(result, 'reveal', [state.ticket, result.index, message.session]);
      await api.tabs.update(result.tabId, { active: true });
      await api.windows.update(tab.windowId, { focused: true });
      return { opened: true };
    }
    async function returnToSearch(message, sender) {
      const state = await load(message.session);
      if (!state || !state.targets.some(t => t.tabId === sender.tab.id && t.documentId === sender.documentId)) throw new Error('Search is no longer open.');
      // Target the exact original document; never navigate the tab to an old URL.
      await api.scripting.executeScript({ target: keyFor(state.origin), func: () => globalThis.LegalPinpointerFind?.focus() });
      await invoke({ tabId: sender.tab.id, documentId: sender.documentId }, 'restore', []);
      const tab = await api.tabs.update(state.origin.tabId, { active: true });
      await api.windows.update(tab.windowId, { focused: true });
      return {};
    }
    async function handle(message, sender) {
      if (!messageTypes.has(message?.type)) return null;
      if (sender?.id !== api.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0 ||
          typeof sender.documentId !== 'string' || !/^(https?|file):/.test(sender.url || '')) throw new Error('Invalid search sender.');
      if (message.type === 'SONAR_SEARCH') return search(message, sender);
      if (message.type === 'SONAR_CLOSE') message = { ...message, session: sessionKey(sender) };
      if (typeof message.session !== 'string' || !message.session.startsWith(prefix)) throw new Error('Invalid search session.');
      if (message.type === 'SONAR_GO') return go(message, sender);
      if (message.type === 'SONAR_RETURN') return returnToSearch(message, sender);
      if (message.session !== sessionKey(sender)) throw new Error('Cannot close another tab’s search.');
      if (!Number.isSafeInteger(message.sequence)) throw new Error('Invalid close request.');
      pending.set(message.session, Math.max(pending.get(message.session) || 0, message.sequence));
      const state = await load(message.session);
      await api.storage.session.remove(message.session); await dispose(state);
      return {};
    }
    async function open(tab) {
      if (!Number.isInteger(tab?.id)) throw new Error('No active tab is available.');
      const target = await install(tab.id, true);
      await api.scripting.executeScript({ target: keyFor(target), func: () => globalThis.LegalPinpointerFind.open() });
      await api.action.setBadgeText({ tabId: tab.id, text: '' });
      await api.action.setTitle({ tabId: tab.id, title: 'Legal Pinpointer' });
      // Session storage is RAM-only and extension-private. Expire abandoned sessions.
      const stored = await api.storage.session.get(null);
      for (const [key, value] of Object.entries(stored)) if (key.startsWith(prefix) && Date.now() - value.updated > 15 * 60_000) {
        await api.storage.session.remove(key); await dispose(value);
      }
    }
    return { handle, open };
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { createBroker }; return; }
  const broker = createBroker(chrome);
  const activeTab = async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  async function open(tab) {
    try { await broker.open(tab); }
    catch (error) {
      const message = 'Tab Sonar cannot access this page. Check site access; browser pages and the built-in PDF viewer are restricted.';
      if (tab?.id) {
        await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
        await chrome.action.setTitle({ tabId: tab.id, title: message });
      }
      throw new Error(message, { cause: error });
    }
  }
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === 'find-in-page') Promise.resolve(tab || activeTab()).then(open).catch(error => console.warn(error.message));
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    let task;
    if (message?.type === 'LEGAL_PINPOINTER_OPEN_FIND') {
      if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('popup.html')) return false;
      task = activeTab().then(open);
    } else if (['SONAR_SEARCH', 'SONAR_GO', 'SONAR_RETURN', 'SONAR_CLOSE'].includes(message?.type)) task = broker.handle(message, sender);
    else return false;
    task.then(result => respond({ ok: true, ...result })).catch(error => respond({ ok: false, message: error.message }));
    return true;
  });
})(globalThis);
