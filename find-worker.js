'use strict';

(function exposeSonarBroker(global) {
  function createBroker(api) {
    const prefix = 'pinpointer-sonar:', TTL = 15 * 60_000, MAX_RESULTS = 1000, CONCURRENCY = 4, MAX_INDEX_CHARS = 32_000_000;
    const pending = new Map(), running = new Map(), gates = new Map();
    const messageTypes = new Set(['SONAR_SEARCH', 'SONAR_GO', 'SONAR_RETURN', 'SONAR_CLOSE', 'SONAR_CANCEL']);
    const sessionKey = sender => `${prefix}${sender.tab.id}:${sender.documentId}`;
    const supported = tab => /^(https?|file):/.test(tab.url || '');
    const keyFor = target => ({ tabId: target.tabId, documentIds: [target.documentId] });
    const load = async key => (await api.storage.session.get(key))[key];
    const save = (key, state) => api.storage.session.set({ [key]: state });

    // Serialize only session transitions, never a scan. This prevents a slow
    // storage write or delayed Close from overwriting a newer query's state.
    function exclusive(key, task) {
      const next = (gates.get(key) || Promise.resolve()).catch(() => {}).then(task);
      gates.set(key, next);
      return next.finally(() => { if (gates.get(key) === next) gates.delete(key); });
    }
    function timeout(promise, ms = 5000) {
      let timer;
      return Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Tab did not respond; it may be suspended.')), ms);
      })]).finally(() => clearTimeout(timer));
    }
    async function invoke(target, method, args) {
      const [entry] = await api.scripting.executeScript({ target: keyFor(target),
        func: async (name, values) => {
          try { return { ok: true, value: await globalThis.LegalPinpointerSearchPage[name](...values) }; }
          catch (error) { return { ok: false, message: String(error.message || error).slice(0, 240) }; }
        }, args: [method, args] });
      if (!entry?.result?.ok) throw new Error(entry?.result?.message || 'The document is no longer available.');
      return entry.result.value;
    }
    async function install(tabId, ui = false) {
      // Warm tabs keep their module instances and sentence/index caches. A probe
      // also obtains the current document ID, so same-URL reloads are not trusted.
      const [probe] = await api.scripting.executeScript({ target: { tabId },
        func: needsUI => Boolean(globalThis.LegalPinpointerSearchPage && (!needsUI || globalThis.LegalPinpointerFind)), args: [ui] });
      if (probe?.documentId && probe.result === true) return { tabId, documentId: probe.documentId };
      const files = ['find-core.js', 'find-page.js'];
      if (ui) files.push('find.js');
      const [entry] = await api.scripting.executeScript({ target: { tabId }, files });
      if (!entry?.documentId) throw new Error('Cannot read this page.');
      return { tabId, documentId: entry.documentId };
    }
    async function dispose(state, warm = new Set()) {
      if (!state) return;
      const targets = state.targets || [];
      for (let offset = 0; offset < targets.length; offset += CONCURRENCY) {
        await Promise.allSettled(targets.slice(offset, offset + CONCURRENCY).map(target =>
          timeout(invoke(target, 'release', [state.ticket, warm === true || (warm instanceof Set && warm.has(target.tabId))]), 1000)));
      }
    }
    function claim(key, sequence) {
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid search sequence.');
      if ((pending.get(key)?.sequence ?? -1) >= sequence) return false;
      pending.set(key, { sequence, updated: Date.now() });
      const previous = running.get(key);
      if (previous) {
        previous.cancelled = true;
        // The in-flight state includes targets that a close/replacement may not
        // yet have seen in session storage. Abort their actual page jobs too.
        void dispose(previous.state, true);
      }
      return true;
    }
    function current(key, sequence) { return pending.get(key)?.sequence === sequence; }
    function pageResults(value, tab, target) {
      if (!value || value.url !== tab.url || !Array.isArray(value.results)) throw new Error('Page changed or returned invalid results.');
      return value.results.slice(0, 200).map(result => {
        if (!Number.isInteger(result.index) || result.index < 0 || result.index >= 200 || typeof result.preview !== 'string') {
          throw new Error('Page returned an invalid passage.');
        }
        const preview = result.preview.slice(0, 460), marks = [];
        for (const mark of (Array.isArray(result.marks) ? result.marks : []).slice(0, 50)) {
          if (Number.isInteger(mark.start) && Number.isInteger(mark.end) && mark.start >= (marks.at(-1)?.end || 0) &&
              mark.start >= 0 && mark.start < preview.length && mark.end > mark.start) {
            marks.push({ start: mark.start, end: Math.min(mark.end, preview.length) });
          }
        }
        return { ...target, index: result.index, url: value.url, preview, marks,
          title: String(value.title || tab.title || 'Untitled page').slice(0, 300),
          locator: typeof result.locator === 'string' ? result.locator.slice(0, 80) : '',
          leading: Boolean(result.leading), trailing: Boolean(result.trailing) };
      });
    }
    async function search(message, sender) {
      if (typeof message.query !== 'string' || message.query.length > 1024 || !['p', 's'].includes(message.mode) ||
          !['current', 'all', 'group'].includes(message.scope) || (message.refresh !== undefined && typeof message.refresh !== 'boolean')) {
        throw new Error('Invalid search request.');
      }
      const compiled = global.LegalPinpointerFindCore.compile(message.query, message.mode), key = sessionKey(sender);
      if (!claim(key, message.sequence)) return { stale: true };
      const run = { cancelled: false, state: null };
      running.set(key, run);
      const alive = () => !run.cancelled && current(key, message.sequence);
      let state;
      try {
        const origin = await api.tabs.get(sender.tab.id);
        const tabs = !compiled.tree ? [] : message.scope === 'current' ? [origin]
          : message.scope === 'group' ? (origin.groupId < 0 ? [] : await api.tabs.query({ groupId: origin.groupId, windowId: origin.windowId }))
            : await api.tabs.query({});
        const candidates = tabs.filter(t => Boolean(t.incognito) === Boolean(origin.incognito))
          .sort((a, b) => (b.id === origin.id) - (a.id === origin.id) || a.windowId - b.windowId || a.index - b.index);
        const warm = new Set(candidates.filter(t => supported(t) && !t.discarded && !t.frozen && t.status !== 'loading').map(t => t.id));
        await exclusive(key, async () => {
          const existing = await load(key);
          if (!alive() || (existing?.sequence ?? -1) >= message.sequence) { run.cancelled = true; return; }
          state = { ticket: crypto.randomUUID(), sequence: message.sequence,
            origin: { tabId: origin.id, documentId: sender.documentId }, groupId: origin.groupId,
            windowId: origin.windowId, incognito: Boolean(origin.incognito), scope: message.scope,
            // Retained warm indexes must also be discoverable by Close/restart.
            targets: (existing?.targets || []).filter(t => warm.has(t.tabId)), results: [], updated: Date.now() };
          run.state = state;
          await save(key, state);
          void dispose(existing, warm);
        });
        if (!alive() || !state) return { stale: true };
        const results = [], skipped = [], deadline = Date.now() + 18_000;
        let searched = 0, limited = false, characters = 0;
        const skip = (tab, reason) => skipped.push({ title: String(tab.title || tab.url || `Tab ${tab.id}`).slice(0, 200), reason });
        // Fixed batches cap running page jobs, intermediate results, and storage
        // writes. Stop launching work once the aggregate result budget is full.
        for (let offset = 0; offset < candidates.length && alive(); offset += CONCURRENCY) {
          if (results.length >= MAX_RESULTS || characters >= MAX_INDEX_CHARS || Date.now() >= deadline) {
            limited = true;
            for (const tab of candidates.slice(offset)) skip(tab, results.length >= MAX_RESULTS ? 'Result limit; narrow the search' : characters >= MAX_INDEX_CHARS ? 'Text budget; narrow the scope' : 'Search time limit; refresh to retry');
            break;
          }
          const batch = await Promise.all(candidates.slice(offset, offset + CONCURRENCY).map(async tab => {
            const reason = !supported(tab) ? 'Browser-restricted or unsupported page' : tab.discarded || tab.frozen
              ? 'Discarded or frozen; open it and refresh' : tab.status === 'loading' ? 'Still loading; refresh when ready' : '';
            if (reason) { skip(tab, reason); return null; }
            try {
              const target = await timeout(install(tab.id), Math.min(5000, Math.max(1, deadline - Date.now())));
              return alive() ? { tab, target } : null;
            } catch (error) { skip(tab, `Unavailable: ${String(error.message || error).slice(0, 180)}`); return null; }
          }));
          if (!alive()) break;
          const ready = batch.filter(Boolean);
          for (const { target } of ready) if (!state.targets.some(t => t.tabId === target.tabId && t.documentId === target.documentId)) state.targets.push(target);
          // Register exact document IDs before starting jobs; a worker restart or
          // Close can now clean up every index/result, not only completed tabs.
          await exclusive(key, async () => { if (alive()) await save(key, state); });
          if (!alive()) break;
          const pages = await Promise.all(ready.map(async ({ tab, target }) => {
            const end = Math.min(deadline, Date.now() + 5000);
            try {
              const value = await timeout(invoke(target, 'search', [{ query: message.query, mode: compiled.mode,
                ticket: state.ticket, deadline: end, refresh: Boolean(message.refresh) }]), Math.max(1, end - Date.now()));
              if (!alive()) return [];
              const normalized = pageResults(value, tab, target);
              characters += Number.isSafeInteger(value.characters) ? Math.max(0, Math.min(4_000_000, value.characters)) : 0;
              searched++; limited ||= Boolean(value.limited) || value.results.length > 200;
              return normalized;
            } catch (error) {
              // Promise.race alone does not cancel an executeScript job.
              void timeout(invoke(target, 'release', [state.ticket, true]), 1000).catch(() => {});
              skip(tab, `Unavailable: ${String(error.message || error).slice(0, 180)}`);
              return [];
            }
          }));
          for (const page of pages) {
            if (results.length + page.length > MAX_RESULTS) limited = true;
            results.push(...page.slice(0, MAX_RESULTS - results.length));
          }
        }
        if (!alive()) { await dispose(state, true); return { stale: true }; }
        // Store issued navigation handles, not snippets/marks. Reading one result
        // after a worker restart need not deserialize a megabyte of preview text.
        state.results = results.map(({ tabId, documentId, index, url }) => ({ tabId, documentId, index, url }));
        state.updated = Date.now();
        await exclusive(key, async () => { if (alive()) await save(key, state); });
        if (!alive()) return { stale: true };
        return { session: key, ticket: state.ticket, results, mode: compiled.mode,
          searched, total: candidates.length, skipped, limited,
          note: message.scope === 'group' && origin.groupId < 0 ? 'This tab is not in a tab group. No other ungrouped tabs were searched.' : '' };
      } finally {
        if (running.get(key) === run) running.delete(key);
        if (run.cancelled && state) void dispose(state, true);
      }
    }
    async function go(message, sender) {
      const state = await load(message.session);
      if (!state || Date.now() - state.updated > TTL || state.ticket !== message.ticket || message.session !== sessionKey(sender)) throw new Error('Search expired. Refresh the results.');
      if (!Number.isInteger(message.id) || message.id < 0) throw new Error('Choose a search result.');
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
      if (!state || Date.now() - state.updated > TTL || !state.targets.some(t => t.tabId === sender.tab.id && t.documentId === sender.documentId)) throw new Error('Search is no longer open.');
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
      if (message.type === 'SONAR_CLOSE' || message.type === 'SONAR_CANCEL') {
        const key = sessionKey(sender), keepIndex = message.type === 'SONAR_CANCEL';
        if (!claim(key, message.sequence)) return { stale: true };
        let state;
        await exclusive(key, async () => {
          if (!current(key, message.sequence)) return;
          const stored = await load(key);
          if (!current(key, message.sequence)) return;
          if ((stored?.sequence ?? -1) > message.sequence) {
            pending.set(key, { sequence: stored.sequence, updated: Date.now() });
            return;
          }
          state = stored;
          if (keepIndex && state) {
            state.results = []; state.sequence = message.sequence; state.updated = Date.now();
            await save(key, state);
          } else await api.storage.session.remove(key);
        });
        await dispose(state, keepIndex);
        return {};
      }
      if (typeof message.session !== 'string' || !message.session.startsWith(prefix)) throw new Error('Invalid search session.');
      if (message.type === 'SONAR_GO') return go(message, sender);
      return returnToSearch(message, sender);
    }
    async function open(tab) {
      if (!Number.isInteger(tab?.id)) throw new Error('No active tab is available.');
      const target = await install(tab.id, true);
      await api.scripting.executeScript({ target: keyFor(target), func: () => globalThis.LegalPinpointerFind.open() });
      await api.action.setBadgeText({ tabId: tab.id, text: '' });
      await api.action.setTitle({ tabId: tab.id, title: 'Legal Pinpointer' });
      const stored = await api.storage.session.get(null);
      for (const [key, value] of Object.entries(stored)) if (key.startsWith(prefix) && Date.now() - value.updated > TTL) {
        await exclusive(key, async () => {
          const latest = await load(key);
          if (latest && Date.now() - latest.updated > TTL) { await api.storage.session.remove(key); void dispose(latest); }
        });
      }
      for (const [key, value] of pending) if (!running.has(key) && Date.now() - value.updated > TTL) pending.delete(key);
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
    } else if (['SONAR_SEARCH', 'SONAR_GO', 'SONAR_RETURN', 'SONAR_CLOSE', 'SONAR_CANCEL'].includes(message?.type)) task = broker.handle(message, sender);
    else return false;
    task.then(result => respond({ ok: true, ...result })).catch(error => respond({ ok: false, message: error.message }));
    return true;
  });
})(globalThis);
