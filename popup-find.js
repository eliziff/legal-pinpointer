'use strict';

document.getElementById('find-in-page').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'LEGAL_PINPOINTER_OPEN_FIND' });
    if (!result?.ok) throw new Error(result?.message || 'The finder could not be opened.');
    window.close();
  } catch (error) {
    document.getElementById('status').textContent = error.message;
    button.disabled = false;
  }
});
