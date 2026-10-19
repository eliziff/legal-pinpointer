'use strict';

// The service worker routes requests; the engine itself lives in the engine host (engine-host.js),
// an offscreen document that stays loaded while this worker is suspended and restarted.
globalThis.LegalPinpointerCitationCall = (method, request) => host('citation', { method, request });

importScripts('core.js', 'find-core.js', 'find-worker.js', 'sonar-launcher.js');

const MAX_TEXT_LENGTH = 12_000_000;
const ALLOWED_HOSTS = new Set(['canlii.org', 'www.canlii.org', 'advance.lexis.com', 'nextcanada.westlaw.com', 'www.nextcanada.westlaw.com']);
let creating = null, hostKnown = false;

async function ensureHost() {
  if (hostKnown) return;
  if (await chrome.offscreen.hasDocument()) { hostKnown = true; return; }
  creating ||= chrome.offscreen.createDocument({
    url: 'engine-host.html',
    reasons: ['WORKERS', 'CLIPBOARD'],
    justification: 'Keeps the citation engine loaded between requests and copies PDF text-fragment links.'
  }).catch((error) => { if (!/single offscreen document/i.test(error.message)) throw error; })
    .finally(() => { creating = null; });
  await creating;
}

async function host(op, input) {
  for (let attempt = 0; ; attempt += 1) {
    await ensureHost();
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'LEGAL_PINPOINTER_ENGINE_HOST', op, input });
      if (!reply) throw new Error('The engine host did not answer.');
      if (!reply.ok) throw Object.assign(new Error(reply.message), { fromHost: true });
      return reply.value;
    } catch (error) {
      if (error.fromHost || attempt) throw error;
      hostKnown = false;
    }
  }
}

function validSender(sender) {
  try {
    if (!sender || sender.id !== chrome.runtime.id || !sender.tab || !sender.url) return false;
    const url = new URL(sender.url);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(hostname)) return false;
    if (hostname.endsWith('canlii.org')) return /\/(?:doc|laws)\//i.test(url.pathname);
    if (hostname === 'advance.lexis.com') return /^\/(?:document|search)\//i.test(url.pathname);
    return /^\/Document\//.test(url.pathname);
  } catch (_) {
    return false;
  }
}

function structureInput(input) {
  if (!input || (input.source_kind !== 'cases' && input.source_kind !== 'laws') || typeof input.text !== 'string'
      || input.text.length > MAX_TEXT_LENGTH || typeof input.citation !== 'string' || input.citation.length > 5000
      || (input.name && (typeof input.name !== 'string' || input.name.length > 2000))) {
    throw new Error('The legal structure request is invalid or too large.');
  }
  return input;
}

function citationInput(message) {
  if (typeof message.method !== 'string' || message.method.length > 80 || !message.request || typeof message.request !== 'object'
      || JSON.stringify(message.request).length > MAX_TEXT_LENGTH) throw new Error('The citation request is invalid or too large.');
  return { method: message.method, request: message.request };
}

function legislationInput(input) {
  if (!input || typeof input.title !== 'string' || input.title.length > 2000 || typeof input.citation !== 'string'
      || input.citation.length > 5000 || (input.language && (typeof input.language !== 'string' || input.language.length > 20))) {
    throw new Error('The CanLII legislation request is invalid or too large.');
  }
  return input;
}

function caseInput(input) {
  const keys = input && Array.isArray(input.keys) ? input.keys : null;
  if (!keys || keys.length > 50 || keys.some((key) => typeof key !== 'string' || key.length > 200)) {
    throw new Error('The CanLII case request is invalid or too large.');
  }
  return { keys };
}

const ROUTES = {
  LEGAL_PINPOINTER_CITATION_CALL: (message) => host('citation', citationInput(message)).then((result) => ({ ok: true, result })),
  LEGAL_PINPOINTER_DERIVE_STRUCTURE: (message) => host('derive', structureInput(message.input)),
  LEGAL_PINPOINTER_RESOLVE_LEGISLATION: (message) => host('legislation', legislationInput(message.input)).then((url) => ({ ok: true, url })),
  LEGAL_PINPOINTER_RESOLVE_CASE: (message) => host('case', caseInput(message.input)).then((targets) => ({ ok: true, targets }))
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const route = message && ROUTES[message.type];
  if (!route) return false;
  if (!validSender(sender)) {
    sendResponse({ ok: false, message: 'Legal Pinpointer requests are limited to supported document pages.' });
    return false;
  }
  Promise.resolve().then(() => route(message)).then(sendResponse)
    .catch((error) => sendResponse({ ok: false, message: error.message || 'Legal Pinpointer request failed.' }));
  return true;
});

// ---------------------------------------------------------------------------
// PDF text-fragment links: Chrome's PDF viewer cannot be scripted, so the copied text is read
// back from the clipboard and the link is written to it again by the engine host.

const PDF_MENU = 'legal-pinpointer-pdf-fragment';

function encodeFragmentText(text) {
  return encodeURIComponent(text).replace(/-/g, '%2D').replace(/&/g, '%26').replace(/,/g, '%2C');
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function flash(tab, text, error) {
  const shown = await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [text, Boolean(error)], func: (message, failed) => {
    const toast = document.getElementById('legal-pinpointer-status') || document.documentElement.appendChild(Object.assign(document.createElement('div'), { id: 'legal-pinpointer-status' }));
    toast.setAttribute('style', `all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:10px 12px;border-radius:8px;background:${failed ? '#7a2424' : '#16352a'};color:#fff;font:600 14px/1.4 system-ui,sans-serif;box-shadow:0 6px 20px rgb(0 0 0/.25);pointer-events:none`);
    toast.textContent = message;
    clearTimeout(toast.lpTimer);
    toast.lpTimer = setTimeout(() => toast.remove(), 2400);
  } }).then(() => true, () => false);
  if (shown) return;
  await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: error ? '#a33' : '#1b6b48' }).catch(() => {});
  await chrome.action.setBadgeText({ tabId: tab.id, text: error ? '!' : '✓' }).catch(() => {});
  setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {}), 2400);
}

async function pdfFragmentLink(tab) {
  const settings = await chrome.storage.local.get({ pdfFragments: true, pdfLinkFormat: 'url' });
  if (!settings.pdfFragments) return { ok: false, message: 'PDF links are turned off in Settings.' };
  if (!tab || !/^(?:https?|file):/.test(tab.url || '')) return { ok: false, message: 'Open a PDF or web page first.' };
  try {
    const copied = String(await host('clipboard', { op: 'read' }) || '').trim().replace(/\s+/g, ' ');
    if (!copied) throw new Error('Copy some text first, then build the link.');
    const url = `${tab.url.split('#')[0]}#:~:text=${encodeFragmentText(copied)}`;
    const link = (label) => `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
    const payload = settings.pdfLinkFormat === 'text' ? { plain: url, html: link(copied) }
      : settings.pdfLinkFormat === 'tag' ? { plain: `${copied} [Link]`, html: `${escapeHtml(copied)} ${link('[Link]')}` }
        : { plain: url, html: '' };
    await host('clipboard', { op: 'write', ...payload });
    await flash(tab, 'Copied a link to the copied text');
    return { ok: true, message: 'Copied a link to the copied text' };
  } catch (error) {
    await flash(tab, error.message || 'The link could not be built.', true);
    return { ok: false, message: error.message || 'The link could not be built.' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'LEGAL_PINPOINTER_PDF_LINK' || sender.id !== chrome.runtime.id || sender.tab
      || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => pdfFragmentLink(tab)).then(sendResponse,
    (error) => sendResponse({ ok: false, message: error.message }));
  return true;
});

async function syncMenus() {
  const { pdfFragments } = await chrome.storage.local.get({ pdfFragments: true });
  await chrome.contextMenus.removeAll();
  if (pdfFragments) chrome.contextMenus.create({ id: PDF_MENU, title: 'Link to the text copied in the clipboard', contexts: ['all'] });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== PDF_MENU) return;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  pdfFragmentLink(tab && tab.id >= 0 ? tab : active);
});
chrome.commands.onCommand.addListener((command, tab) => { if (command === 'pdf-fragment-link') pdfFragmentLink(tab); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.pdfFragments) syncMenus(); });
chrome.runtime.onInstalled.addListener(() => { syncMenus(); ensureHost(); });
chrome.runtime.onStartup.addListener(() => { ensureHost(); });
