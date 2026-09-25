'use strict';

(function exposeLauncher(global) {
  const keyFor = windowId => `sonar-launch:${windowId}`;
  // CanLII's boxes: document text (text=), case name or title (id=), and noteup,
  // which names the cited document by its CanLII path (origin1=) and keeps the typed text (nquery1=).
  function canliiURL(query, field = 'text') {
    if (typeof query !== 'string' || !query.trim() || query.length > 4096) throw new Error('Enter up to 4,096 characters to search CanLII.');
    const value = query.trim(), search = 'https://www.canlii.org/en/#search/';
    if (field === 'id') return `${search}id=${encodeURIComponent(value)}`;
    if (field !== 'noteup') return `${search}text=${encodeURIComponent(value)}`;
    const cited = global.LegalPinpointerCore?.canliiUrlForCitation(value, 'en');
    if (!cited) throw new Error('Noteup needs a citation CanLII can resolve, such as 2016 SCC 27.');
    return `${search}origin1=${encodeURIComponent(new URL(cited).pathname)}&nquery1=${encodeURIComponent(value)}`;
  }
  function createLauncher(api, broker) {
    const activeTab = async () => (await api.tabs.query({ active: true, currentWindow: true }))[0];
    function launch(tab, route = 'tabs') {
      // MUST happen synchronously in the command/click handler, before storage,
      // tab lookup or injection. In particular, chrome://newtab needs no agent.
      const opened = api.sidePanel.open({ windowId: tab?.windowId ?? api.windows.WINDOW_ID_CURRENT });
      const resolved = tab ? Promise.resolve(tab) : activeTab();
      return Promise.all([opened, resolved]).then(async ([, origin]) => {
        if (!Number.isInteger(origin?.id)) throw new Error('No active browser tab is available.');
        await api.storage.session.set({ [keyFor(origin.windowId)]: {
          route, nonce: crypto.randomUUID(), created: Date.now(),
          origin: { id: origin.id, windowId: origin.windowId, title: origin.title || 'Current tab',
            url: origin.url || '', incognito: Boolean(origin.incognito) }
        } });
        await api.action.setBadgeText({ tabId: origin.id, text: '' });
        void broker.prune().catch(() => {});
      });
    }
    function report(error, tab) {
      if (Number.isInteger(tab?.id)) {
        void api.action.setBadgeText({ tabId: tab.id, text: '!' }).catch(() => {});
        void api.action.setTitle({ tabId: tab.id, title: `Pinpointer: ${error.message}` }).catch(() => {});
      }
    }
    function onCommand(command, tab) {
      if (command !== 'find-in-page' && command !== 'canlii-text-search') return;
      launch(tab, 'canlii').catch(error => report(error, tab));
    }
    function onMessage(message, sender, respond) {
      if (sender?.id !== api.runtime.id) return false;
      const panel = !sender.tab && sender.url === api.runtime.getURL('sonar.html');
      const popup = !sender.tab && sender.url === api.runtime.getURL('popup.html');
      let task;
      if (popup && ['LEGAL_PINPOINTER_OPEN_FIND', 'LEGAL_PINPOINTER_OPEN_CANLII_SEARCH'].includes(message?.type)) {
        task = launch(null, message.type === 'LEGAL_PINPOINTER_OPEN_CANLII_SEARCH' ? 'canlii' : 'tabs');
      } else if (panel && message?.type === 'SONAR_CANLII_SEARCH') {
        task = Promise.resolve().then(async () => {
          const url = canliiURL(message.query, message.field);
          if (!Number.isInteger(message.windowId)) throw new Error('Invalid destination window.');
          const window = await api.windows.get(message.windowId);
          if (Boolean(window.incognito) !== Boolean(message.incognito)) throw new Error('Cannot mix private and normal windows.');
          await api.tabs.create({ windowId: window.id, url, active: true });
          return { opened: true };
        });
      } else if (['SONAR_SEARCH', 'SONAR_GO', 'SONAR_BACK', 'SONAR_PREVIEW', 'SONAR_RETURN', 'SONAR_CLOSE', 'SONAR_CANCEL', 'SONAR_COPY', 'SONAR_UNITS', 'SONAR_ISSUE'].includes(message?.type)) {
        task = broker.handle(message, sender);
      } else return false;
      task.then(value => respond({ ok: true, ...value })).catch(error => respond({ ok: false, message: error.message }));
      return true;
    }
    return { launch, onCommand, onMessage };
  }
  const exported = { createLauncher, canliiURL, keyFor };
  if (typeof module !== 'undefined' && module.exports) { module.exports = exported; return; }
  const launcher = createLauncher(chrome, global.LegalPinpointerSonarBroker.createBroker(chrome));
  chrome.commands.onCommand.addListener(launcher.onCommand);
  chrome.runtime.onMessage.addListener(launcher.onMessage);
})(globalThis);
