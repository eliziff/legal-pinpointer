'use strict';

(function exposeSonarBroker(global) {
  function createBroker(api) {
    const prefix = 'pinpointer-sonar:', TTL = 15 * 60_000, MAX_RESULTS = 1000, RANKED_RESULTS = 200, CONCURRENCY = 4, MAX_INDEX_CHARS = 32_000_000;
    const pending = new Map(), running = new Map(), gates = new Map();
    const messageTypes = new Set(['SONAR_SEARCH', 'SONAR_GO', 'SONAR_RETURN', 'SONAR_CLOSE', 'SONAR_CANCEL', 'SONAR_BACK', 'SONAR_PREVIEW', 'SONAR_COPY', 'SONAR_UNITS', 'SONAR_ISSUE']);
    const sessionKey = sender => sender.workspace
      ? `${prefix}workspace:${sender.workspace}` : `${prefix}${sender.tab.id}:${sender.documentId}`;
    // The documents whose text a side panel has read into its own ranked index.
    const unitsKey = workspace => `${prefix}units:${workspace}`;
    const panelURL = () => api.runtime.getURL('sonar.html');
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
          try {
            const page = globalThis.LegalPinpointerSearchPage;
            if (name === 'search' && values[0].notify) page.watch(values[0].ticket);
            return { ok: true, value: await page[name](...values) };
          }
          catch (error) { return { ok: false, message: String(error.message || error).slice(0, 240) }; }
        }, args: [method, args] });
      if (!entry?.result?.ok) throw new Error(entry?.result?.message || 'The document is no longer available.');
      return entry.result.value;
    }
    async function install(tabId) {
      // Warm tabs keep their module instances and sentence/index caches. A probe
      // also obtains the current document ID, so same-URL reloads are not trusted.
      const [probe] = await api.scripting.executeScript({ target: { tabId },
        func: () => Boolean(globalThis.LegalPinpointerSearchPage) });
      if (probe?.documentId && probe.result === true) return { tabId, documentId: probe.documentId };
      const [entry] = await api.scripting.executeScript({ target: { tabId }, files: ['find-core.js', 'find-page.js'] });
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
        return { ...target, windowId: tab.windowId, index: result.index, url: value.url, preview, marks,
          title: String(value.title || tab.title || 'Untitled page').slice(0, 300),
          locator: typeof result.locator === 'string' ? result.locator.slice(0, 80) : '',
          leading: Boolean(result.leading), trailing: Boolean(result.trailing) };
      });
    }
    async function search(message, sender) {
      if (typeof message.query !== 'string' || message.query.length > 1024 ||
          !['current', 'all', 'group'].includes(message.scope) || (message.refresh !== undefined && typeof message.refresh !== 'boolean')) {
        throw new Error('Invalid search request.');
      }
      // Ranked (plain-word) queries run in the side panel's own index; see SONAR_ISSUE.
      const compiled = global.LegalPinpointerFindCore.compile(message.query), key = sessionKey(sender);
      if (!claim(key, message.sequence)) return { stale: true };
      const run = { cancelled: false, state: null };
      running.set(key, run);
      const alive = () => !run.cancelled && current(key, message.sequence);
      let state;
      try {
        const origin = await api.tabs.get(sender.workspace ? message.originTabId : sender.tab.id);
        if (sender.workspace && Boolean(origin.incognito) !== sender.incognito) throw new Error('Cannot mix private and normal windows.');
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
            origin: { tabId: origin.id, documentId: sender.workspace ? '' : sender.documentId, url: origin.url },
            panel: Boolean(sender.workspace), groupId: origin.groupId,
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
          for (const { target } of ready) {
            if (!state.targets.some(t => t.tabId === target.tabId && t.documentId === target.documentId)) state.targets.push(target);
            if (target.tabId === state.origin.tabId) state.origin.documentId = target.documentId;
          }
          // Register exact document IDs before starting jobs; a worker restart or
          // Close can now clean up every index/result, not only completed tabs.
          await exclusive(key, async () => { if (alive()) await save(key, state); });
          if (!alive()) break;
          const pages = await Promise.all(ready.map(async ({ tab, target }) => {
            const end = Math.min(deadline, Date.now() + 5000);
            try {
              const value = await timeout(invoke(target, 'search', [{ query: message.query,
                ticket: state.ticket, deadline: end, refresh: Boolean(message.refresh), notify: Boolean(state.panel) }]), Math.max(1, end - Date.now()));
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
        state.results = results.map(({ tabId, documentId, windowId, index, url }) => ({ tabId, documentId, windowId, index, url }));
        state.updated = Date.now();
        await exclusive(key, async () => { if (alive()) await save(key, state); });
        if (!alive()) return { stale: true };
        return { session: key, ticket: state.ticket, results,
          searched, total: candidates.length, skipped, limited, origin: state.origin,
          note: message.scope === 'group' && origin.groupId < 0 ? 'This tab is not in a tab group. No other ungrouped tabs were searched.' : '' };
      } finally {
        if (running.get(key) === run) running.delete(key);
        if (run.cancelled && state) void dispose(state, true);
      }
    }
    async function issuedState(message, sender) {
      const state = await load(message.session);
      if (!state || (sender.workspace && state.incognito !== sender.incognito) || Date.now() - state.updated > TTL || state.ticket !== message.ticket || message.session !== sessionKey(sender)) throw new Error('Search expired. Refresh the results.');
      return state;
    }
    async function issued(message, sender) {
      const state = await issuedState(message, sender);
      if (!Number.isInteger(message.id) || message.id < 0) throw new Error('Choose a search result.');
      const result = state.results[message.id];
      if (message.type === 'SONAR_PREVIEW' && (!state.panel || state.scope !== 'current' || result?.tabId !== state.origin.tabId)) throw new Error('Preview is limited to the current source tab.');
      if (!result) throw new Error('Choose a search result.');
      const tab = await api.tabs.get(result.tabId);
      if (tab.url !== result.url || Boolean(tab.incognito) !== state.incognito ||
          (result.windowId !== undefined && tab.windowId !== result.windowId) ||
          (state.scope === 'group' && (tab.groupId !== state.groupId || tab.windowId !== state.windowId))) {
        throw new Error('The tab navigated or left this group. Refresh the search.');
      }
      return { state, result, tab };
    }
    // Paragraph text of up to four eligible tabs for the side panel's own ranked
    // index. The exact documents read are recorded so Close can release them.
    async function units(message, sender) {
      if (!sender.workspace || !Array.isArray(message.tabIds) || !message.tabIds.length || message.tabIds.length > CONCURRENCY ||
          !message.tabIds.every(Number.isInteger) || typeof message.known !== 'object' || !message.known) throw new Error('Invalid read request.');
      const pages = await Promise.all(message.tabIds.map(async tabId => {
        let tab;
        try { tab = await api.tabs.get(tabId); } catch (_) { return { tabId, skipped: 'Closed' }; }
        const title = String(tab.title || tab.url || `Tab ${tab.id}`).slice(0, 300);
        const reason = Boolean(tab.incognito) !== sender.incognito ? 'Cannot mix private and normal windows.' : !supported(tab) ? 'Browser-restricted or unsupported page'
          : tab.discarded || tab.frozen ? 'Discarded or frozen; open it and refresh' : tab.status === 'loading' ? 'Still loading; refresh when ready' : '';
        if (reason) return { tabId, title, skipped: reason };
        try {
          const target = await timeout(install(tab.id));
          const known = typeof message.known[tabId] === 'string' ? message.known[tabId] : '';
          const value = await timeout(invoke(target, 'units', [{ known, workspace: sender.workspace, deadline: Date.now() + 9000 }]), 10_000);
          if (!value || value.url !== tab.url || typeof value.revision !== 'string' || value.revision.length > 40) throw new Error('Page changed or returned invalid text.');
          const page = { tabId, ...target, windowId: tab.windowId, url: value.url, title: String(value.title || title).slice(0, 300), revision: value.revision };
          if (value.same) return { ...page, same: true };
          let count = 0;
          if (typeof value.text === 'string' && value.text.length <= 4_200_000) for (let at = -1; count <= 200_000 && (count++, at = value.text.indexOf('\n', at + 1)) >= 0;);
          if (!count || !value.text || !Array.isArray(value.paras) || value.paras.length !== count) throw new Error('Page returned invalid text.');
          return { ...page, text: value.text, limited: Boolean(value.limited),
            paras: value.paras.map(number => Number.isSafeInteger(number) && number > 0 ? number : 0) };
        } catch (error) { return { tabId, title, skipped: `Unavailable: ${String(error.message || error).slice(0, 180)}` }; }
      }));
      const key = unitsKey(sender.workspace);
      await exclusive(key, async () => {
        const state = (await load(key)) || { targets: [], incognito: sender.incognito };
        for (const page of pages) {
          state.targets = state.targets.filter(t => t.tabId !== page.tabId);
          if (page.documentId) state.targets.push({ tabId: page.tabId, documentId: page.documentId, url: page.url });
        }
        state.updated = Date.now();
        await save(key, state);
      });
      return { pages };
    }
    // Handles for ranked results the side panel found in its own index. Each must
    // name a document this workspace read; the page revalidates the unit's text.
    async function issue(message, sender) {
      const valid = r => Number.isInteger(r?.tabId) && typeof r.documentId === 'string' && Number.isInteger(r.unit) && r.unit >= 0 && Number.isSafeInteger(r.hash);
      if (!sender.workspace || typeof message.query !== 'string' || message.query.length > 1024 || !['current', 'all', 'group'].includes(message.scope) ||
          !Array.isArray(message.results) || message.results.length > RANKED_RESULTS || !message.results.every(valid)) throw new Error('Invalid search request.');
      const key = sessionKey(sender);
      if (!claim(key, message.sequence)) return { stale: true };
      const run = { cancelled: false, state: null };
      running.set(key, run);
      const alive = () => !run.cancelled && current(key, message.sequence);
      try {
        const origin = await api.tabs.get(message.originTabId);
        if (Boolean(origin.incognito) !== sender.incognito) throw new Error('Cannot mix private and normal windows.');
        const read = new Map(((await load(unitsKey(sender.workspace)))?.targets || []).map(t => [t.tabId, t]));
        const windows = new Map();
        for (const tabId of new Set(message.results.map(r => r.tabId))) windows.set(tabId, await api.tabs.get(tabId).then(tab => tab.windowId, () => undefined));
        const results = message.results.map(({ tabId, documentId, unit, hash }) => {
          const target = read.get(tabId);
          if (target?.documentId !== documentId) throw new Error('Search expired. Refresh the results.');
          return { tabId, documentId, windowId: windows.get(tabId), url: target.url, unit, hash };
        });
        let state;
        await exclusive(key, async () => {
          const existing = await load(key);
          if (!alive() || (existing?.sequence ?? -1) >= message.sequence) { run.cancelled = true; return; }
          state = { ticket: crypto.randomUUID(), sequence: message.sequence, origin: { tabId: origin.id, documentId: '', url: origin.url },
            panel: true, groupId: origin.groupId, windowId: origin.windowId, incognito: sender.incognito, scope: message.scope,
            ranked: true, query: message.query, targets: [], results, updated: Date.now() };
          await save(key, state);
          void dispose(existing, true);
        });
        return state && alive() ? { session: key, ticket: state.ticket, origin: state.origin } : { stale: true };
      } finally { if (running.get(key) === run) running.delete(key); }
    }
    // What a page needs to find a result: an exact search's position, or a ranked
    // unit with its text hash, the query, and its siblings in that document.
    function pageKey(state, result) {
      if (!state.ranked) return result.index;
      const others = state.results.filter(r => r !== result && r.tabId === result.tabId && r.documentId === result.documentId);
      return { query: state.query, unit: result.unit, hash: result.hash, others: others.slice(0, 63).map(({ unit, hash }) => ({ unit, hash })) };
    }
    // Copy uses Pinpointer's own quote/pinpoint/link builders where the page has
    // them (content.js on supported legal sites), else a text-fragment link.
    async function copyResult(message, sender) {
      if (!['quote', 'pinpoint', 'link', 'citation'].includes(message.mode)) throw new Error('Invalid copy action.');
      const { state, result } = await issued(message, sender);
      const [probe] = await api.scripting.executeScript({ target: keyFor(result),
        func: () => Boolean(globalThis.LegalPinpointerSonarCopy || globalThis.LegalPinpointerTextFragments) });
      if (!probe?.result) await api.scripting.executeScript({ target: keyFor(result), files: ['canlii-courts.js', 'core.js', 'text-fragments.js'] });
      const [entry] = await api.scripting.executeScript({ target: keyFor(result), args: [state.ticket, pageKey(state, result), message.mode],
        func: async (ticket, key, mode) => {
          try {
            const page = globalThis.LegalPinpointerSearchPage, range = await page.passage(ticket, key);
            if (globalThis.LegalPinpointerSonarCopy) {
              try { return { ok: true, value: (await globalThis.LegalPinpointerSonarCopy(range, mode)).payload }; }
              catch (error) { if (!/supported legal document|No page, paragraph, or provision/.test(error.message)) throw error; }
            }
            return { ok: true, value: page.plainCopy(range, mode) };
          } catch (error) { return { ok: false, message: String(error.message || error).slice(0, 240) }; }
        } });
      if (!entry?.result?.ok) throw new Error(entry?.result?.message || 'The document is no longer available.');
      const { plain, html } = entry.result.value || {};
      if (typeof plain !== 'string' || typeof html !== 'string') throw new Error('The page returned nothing to copy.');
      return { plain: plain.slice(0, 200_000), html: html.slice(0, 400_000) };
    }
    async function go(message, sender) {
      const { state, result, tab } = await issued(message, sender);
      if (state.panel || result.tabId === state.origin.tabId) await invoke(result, 'preview', [state.ticket, pageKey(state, result), true]);
      else await invoke(result, 'reveal', [state.ticket, pageKey(state, result), message.session]);
      if (message.type === 'SONAR_PREVIEW') return { previewed: true };
      await api.tabs.update(result.tabId, { active: true });
      await api.windows.update(tab.windowId, { focused: true });
      return { opened: true, tabId: result.tabId, windowId: tab.windowId };
    }
    async function returnToSearch(message, sender) {
      const state = await load(message.session);
      if (!state || Date.now() - state.updated > TTL || !state.targets.some(t => t.tabId === sender.tab.id && t.documentId === sender.documentId)) throw new Error('Search is no longer open.');
      // Target the exact original document; never navigate the tab to an old URL.
      await invoke({ tabId: sender.tab.id, documentId: sender.documentId }, 'restore', []);
      const tab = await api.tabs.update(state.origin.tabId, { active: true });
      await api.windows.update(tab.windowId, { focused: true });
      return {};
    }
    async function handle(message, sender) {
      if (!messageTypes.has(message?.type)) return null;
      if (sender?.id !== api.runtime.id) throw new Error('Invalid search sender.');
      // Chrome gives the side panel no tab, frame or documentId; page senders always have them.
      if (!sender.tab && sender.url === panelURL()) {
        if (!/^[a-f0-9-]{36}$/.test(message.workspace || '') || typeof message.incognito !== 'boolean') throw new Error('Invalid workspace.');
        if (message.type === 'SONAR_SEARCH' && !Number.isInteger(message.originTabId)) throw new Error('Choose an origin tab.');
        // Only the packaged, non-web-accessible extension page may share a workspace
        // across windows. Page senders are never allowed to supply this identity.
        sender = { ...sender, workspace: message.workspace, incognito: message.incognito };
      } else if (message.workspace !== undefined || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0 || typeof sender.documentId !== 'string' ||
          !/^(https?|file):/.test(sender.url || '')) throw new Error('Invalid search sender.');
      if (message.type === 'SONAR_SEARCH') return search(message, sender);
      if (message.type === 'SONAR_UNITS') return units(message, sender);
      if (message.type === 'SONAR_ISSUE') return issue(message, sender);
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
        if (!keepIndex && sender.workspace) {
          const read = await load(unitsKey(sender.workspace));
          await api.storage.session.remove(unitsKey(sender.workspace));
          await dispose(read);
        }
        return {};
      }
      if (typeof message.session !== 'string' || !message.session.startsWith(prefix)) throw new Error('Invalid search session.');
      if (message.type === 'SONAR_BACK') {
        const state = await load(message.session);
        if (!sender.workspace || !state?.panel || state.incognito !== sender.incognito || message.session !== sessionKey(sender) || state.ticket !== message.ticket || Date.now() - state.updated > TTL) throw new Error('Search expired. Refresh the results.');
        const origin = await api.tabs.get(state.origin.tabId);
        if (origin.url !== state.origin.url || Boolean(origin.incognito) !== state.incognito) throw new Error('The starting tab changed. Use the active tab to start again.');
        if (state.origin.documentId) {
          // Do not restore an old position into a replacement document at the same URL.
          await invoke(state.origin, 'restore', []);
        }
        if (Number.isInteger(message.id) && state.results[message.id]?.tabId !== state.origin.tabId) {
          const visited = state.results[message.id];
          if (visited) await invoke(visited, 'restore', []);
        }
        await api.tabs.update(origin.id, { active: true });
        await api.windows.update(origin.windowId, { focused: true });
        return { returned: true };
      }
      if (message.type === 'SONAR_GO' || message.type === 'SONAR_PREVIEW') return go(message, sender);
      if (message.type === 'SONAR_COPY') return copyResult(message, sender);
      return returnToSearch(message, sender);
    }
    async function prune() {
      const stored = await api.storage.session.get(null);
      for (const [key, value] of Object.entries(stored)) if (key.startsWith(prefix) && Date.now() - value.updated > TTL) {
        await exclusive(key, async () => {
          const latest = await load(key);
          if (latest && Date.now() - latest.updated > TTL) { await api.storage.session.remove(key); void dispose(latest); }
        });
      }
      for (const [key, value] of Object.entries(stored)) if (key.startsWith('sonar-launch:') && Date.now() - value.created > 60_000) await api.storage.session.remove(key);
      for (const [key, value] of pending) if (!running.has(key) && Date.now() - value.updated > TTL) pending.delete(key);
    }
    return { handle, prune };
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { createBroker }; return; }
  global.LegalPinpointerSonarBroker = { createBroker };
})(globalThis);
