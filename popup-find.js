'use strict';

(function bindSearchActions() {
  for (const [id, type] of [
    ['find-in-page', 'LEGAL_PINPOINTER_OPEN_FIND'],
    ['canlii-text-search', 'LEGAL_PINPOINTER_OPEN_CANLII_SEARCH']
  ]) {
    document.getElementById(id).addEventListener('click', async event => {
      const button = event.currentTarget; button.disabled = true;
      try {
        const reply = await chrome.runtime.sendMessage({ type });
        if (!reply?.ok) throw new Error(reply?.message || 'Could not open search.');
        window.close();
      } catch (error) { document.getElementById('status').textContent = error.message; }
      finally { button.disabled = false; }
    });
  }
  chrome.commands.getAll().then(commands => {
    const missing = commands.filter(c => ['find-in-page', 'canlii-text-search'].includes(c.name) && !c.shortcut);
    if (!missing.length) return;
    const status = document.getElementById('shortcut-status'); status.hidden = false;
    status.textContent = 'A search shortcut is unassigned or in use elsewhere. Assign it at chrome://extensions/shortcuts. The search buttons still work.';
  }).catch(() => {});
})();
