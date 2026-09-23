'use strict';
// Lens (semantic search) is a separate page; Tab Sonar never loads it.
document.getElementById('lens-route')?.addEventListener('click', async () => {
  const status = document.getElementById('status');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = chrome.runtime.getURL(`lens-dist/lens.html?origin=${tab?.id || ''}`);
    const built = await fetch(url).then(response => response.ok, () => false);
    if (!built) throw new Error('Lens is not included in this build of the extension.');
    await chrome.tabs.create({ url, index: tab ? tab.index + 1 : undefined });
    window.close();
  } catch (error) { status.textContent = error.message; }
});
