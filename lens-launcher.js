'use strict';
document.getElementById('lens-route')?.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    const url = chrome.runtime.getURL(`lens-dist/lens.html?origin=${tab?.id || ''}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error('Lens is not built in this checkout. Use the packaged extension release or run npm run build in lens/.');
    location.href = url;
  } catch (error) {
    document.getElementById('notice').textContent = error.message;
  }
});
