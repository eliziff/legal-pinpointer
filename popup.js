'use strict';

const summary = document.getElementById('document-summary');
const status = document.getElementById('status');
const copyPinpoint = document.getElementById('copy-pinpoint');
const copyQuote = document.getElementById('copy-quote');
const copyCitation = document.getElementById('copy-citation');
const openCanlii = document.getElementById('open-canlii');
const styleInputs = Array.from(document.querySelectorAll('input[name="pinpoint-style"]'));
const linkFullTextFragmentPinpoint = document.getElementById('link-full-text-fragment-pinpoint');
let canliiAvailable = false;

function activeTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else if (!tabs[0] || typeof tabs[0].id !== 'number') reject(new Error('No active tab is available.'));
      else resolve(tabs[0]);
    });
  });
}

function send(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error('Open a supported CanLII, Lexis, or Westlaw document.'));
      else resolve(response);
    });
  });
}

function setBusy(busy) {
  copyPinpoint.disabled = busy;
  copyQuote.disabled = busy;
  copyCitation.disabled = busy;
  openCanlii.disabled = busy || !canliiAvailable;
}

async function inspect() {
  try {
    const tab = await activeTab();
    const result = await send(tab.id, { type: 'LEGAL_PINPOINTER_INSPECT' });
    if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'This document could not be read.');
    const provider = result.provider === 'canlii' ? 'CanLII' : result.provider === 'lexis' ? 'Lexis' : 'Westlaw';
    const selection = result.selectedPinpoint ? ` · selection ${result.selectedPinpoint}` : '';
    summary.textContent = `${provider} ${result.documentType} · ${result.citation}${selection}`;
    canliiAvailable = result.canliiAvailable;
    openCanlii.disabled = !canliiAvailable;
  } catch (error) {
    summary.textContent = error.message;
    copyPinpoint.disabled = true;
    copyQuote.disabled = true;
    copyCitation.disabled = true;
    openCanlii.disabled = true;
  }
}

async function copy(mode) {
  setBusy(true);
  status.textContent = 'Copying…';
  try {
    const tab = await activeTab();
    const result = await send(tab.id, {
      type: 'LEGAL_PINPOINTER_COPY',
      mode,
      source: 'popup'
    });
    if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'Copy failed.');
    status.textContent = result.message;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function navigateToCanlii() {
  setBusy(true);
  status.textContent = 'Opening CanLII…';
  try {
    const tab = await activeTab();
    const result = await send(tab.id, { type: 'LEGAL_PINPOINTER_OPEN_CANLII', source: 'popup' });
    if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'CanLII could not be opened.');
    window.close();
  } catch (error) {
    status.textContent = error.message;
    setBusy(false);
  }
}

chrome.storage.local.get({ pinpointStyle: 'bare', linkFullTextFragmentPinpoint: false }, (settings) => {
  const selected = styleInputs.find((input) => input.value === settings.pinpointStyle) || styleInputs[0];
  selected.checked = true;
  linkFullTextFragmentPinpoint.checked = Boolean(settings.linkFullTextFragmentPinpoint);
});

for (const input of styleInputs) {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    chrome.storage.local.set({ pinpointStyle: input.value }, () => {
      status.textContent = input.value === 'bare' ? 'Bare pinpoints selected.' : 'Full McGill pinpoints selected.';
      inspect();
    });
  });
}

linkFullTextFragmentPinpoint.addEventListener('change', () => {
  chrome.storage.local.set({ linkFullTextFragmentPinpoint: linkFullTextFragmentPinpoint.checked }, () => {
    status.textContent = linkFullTextFragmentPinpoint.checked
      ? 'Full text-fragment pinpoint phrases will be linked.'
      : 'Only text-fragment pinpoint locators will be linked.';
  });
});

copyPinpoint.addEventListener('click', () => copy('pinpoint'));
copyQuote.addEventListener('click', () => copy('quote'));
copyCitation.addEventListener('click', () => copy('citation'));
openCanlii.addEventListener('click', navigateToCanlii);
inspect();
