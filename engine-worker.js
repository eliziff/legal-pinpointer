'use strict';

// The service worker routes requests; the engine itself lives in the engine host (engine-host.js),
// an offscreen document that stays loaded while this worker is suspended and restarted.
globalThis.LegalPinpointerCitationCall = (method, request) => host('citation', { method, request });

importScripts('core.js', 'find-core.js', 'find-worker.js', 'sonar-launcher.js', 'marker-core.js');

const MAX_TEXT_LENGTH = 12_000_000;
const ALLOWED_HOSTS = new Set(['canlii.org', 'www.canlii.org', 'advance.lexis.com', 'nextcanada.westlaw.com', 'www.nextcanada.westlaw.com']);
let creating = null, hostKnown = false;

async function ensureHost() {
  if (hostKnown) return;
  if (creating) return creating;
  if (await chrome.offscreen.hasDocument()) { hostKnown = true; return; }
  creating ||= chrome.offscreen.createDocument({
    url: 'engine-host.html',
    reasons: ['WORKERS', 'CLIPBOARD'],
    justification: 'Keeps the citation engine loaded between requests and copies PDF text-fragment links.'
  }).catch((error) => { if (!/single offscreen document/i.test(error.message)) throw error; })
    .finally(() => { creating = null; });
  await creating;
}

// A host that exists may still be loading its scripts (another request opened it a moment ago):
// until it listens, a message has no receiver, so the request waits briefly and tries again.
async function host(op, input) {
  for (let attempt = 0; ; attempt += 1) {
    await ensureHost();
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'LEGAL_PINPOINTER_ENGINE_HOST', op, input });
      if (!reply) throw new Error('The engine host did not answer.');
      if (!reply.ok) throw Object.assign(new Error(reply.message), { fromHost: true });
      return reply.value;
    } catch (error) {
      if (error.fromHost || attempt >= 40) throw error;
      hostKnown = false;
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

// A decision page on a court's Lexum/Decisia site (Case Marker files it under its CanLII identity).
function courtSiteSender(sender) {
  return Boolean(sender && sender.id === chrome.runtime.id && sender.tab && sender.url
    && LegalPinpointerCore.isCourtSiteUrl(String(sender.url).split(/[?#]/)[0]));
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

function clipboardInput(message) {
  if (typeof message.plain !== 'string' || typeof message.html !== 'string' || message.plain.length + message.html.length > 4_000_000) {
    throw new Error('The clipboard request is invalid or too large.');
  }
  return { op: 'write', plain: message.plain, html: message.html };
}

function caseInput(input) {
  const keys = input && Array.isArray(input.keys) ? input.keys : null;
  if (!keys || keys.length > 50 || keys.some((key) => typeof key !== 'string' || key.length > 200)) {
    throw new Error('The CanLII case request is invalid or too large.');
  }
  return { keys, sites: input.sites === true };
}

const ROUTES = {
  LEGAL_PINPOINTER_CITATION_CALL: (message) => host('citation', citationInput(message)).then((result) => ({ ok: true, result })),
  LEGAL_PINPOINTER_DERIVE_STRUCTURE: (message) => host('derive', structureInput(message.input)),
  LEGAL_PINPOINTER_RESOLVE_LEGISLATION: (message) => host('legislation', legislationInput(message.input)).then((url) => ({ ok: true, url })),
  LEGAL_PINPOINTER_RESOLVE_CASE: (message) => host('case', caseInput(message.input)).then(({ targets, sites }) => ({ ok: true, targets, sites })),
  LEGAL_PINPOINTER_CLIPBOARD: (message) => host('clipboard', clipboardInput(message)).then(() => ({ ok: true })),
  LEGAL_PINPOINTER_METADATA: metadata,
  // A legal page started loading: open the engine host now, so its first answer is ready sooner.
  LEGAL_PINPOINTER_WARM: () => host('ping').then(() => ({ ok: true }))
};

// Document metadata (citation, CanLII or court-site link) by page address and title, for the
// browser session (chrome.storage.session, in memory): the most recent 400 documents.
const METADATA_LIMIT = 400;
async function metadata(message) {
  if (typeof message.key !== 'string' || message.key.length > 2500) throw new Error('The metadata request is invalid.');
  const { lpMetadata = {} } = await chrome.storage.session.get('lpMetadata');
  if (message.value === undefined) return { ok: true, value: lpMetadata[message.key] || null };
  const value = message.value;
  if (!value?.citation?.plain || JSON.stringify(value).length > 20_000) throw new Error('The metadata is invalid.');
  delete lpMetadata[message.key];
  lpMetadata[message.key] = { citation: value.citation, canliiUrl: String(value.canliiUrl || ''), siteUrl: String(value.siteUrl || '') };
  const keys = Object.keys(lpMetadata);
  for (const old of keys.slice(0, Math.max(0, keys.length - METADATA_LIMIT))) delete lpMetadata[old];
  await chrome.storage.session.set({ lpMetadata });
  return { ok: true };
}

const SITE_ROUTES = {
  LEGAL_PINPOINTER_CASE_IDENTITY: (message) => {
    if (typeof message.text !== 'string' || message.text.length > 4000) throw new Error('The identity request is invalid.');
    return host('identity', { text: message.text }).then((canliiUrl) => ({ ok: true, canliiUrl }));
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const siteRoute = message && SITE_ROUTES[message.type];
  if (siteRoute) {
    if (!courtSiteSender(sender)) return false;
    Promise.resolve().then(() => siteRoute(message)).then(sendResponse)
      .catch((error) => sendResponse({ ok: false, message: error.message || 'Legal Pinpointer request failed.' }));
    return true;
  }
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
    toast.setAttribute('style', `all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:10px 12px;border-radius:8px;background:${failed ? '#b72016' : '#111827'};color:#fff;font:600 14px/1.4 system-ui,sans-serif;box-shadow:0 6px 20px rgb(0 0 0/.25);pointer-events:none`);
    toast.textContent = message;
    clearTimeout(toast.lpTimer);
    toast.lpTimer = setTimeout(() => toast.remove(), 2400);
  } }).then(() => true, () => false);
  if (shown) return;
  await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: error ? '#d52b1e' : '#111827' }).catch(() => {});
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
chrome.runtime.onInstalled.addListener(syncMenus);

// Case Marker is registered only while it is on, so a page never draws circles and then removes
// them: they are placed as the page is parsed, before its first paint.
const CASE_MARKER = {
  id: 'legal-pinpointer-case-marker',
  matches: [
    'https://www.canlii.org/*', 'https://canlii.org/*',
    'https://advance.lexis.com/document/*', 'https://advance.lexis.com/search/*',
    'https://nextcanada.westlaw.com/Document/*', 'https://www.nextcanada.westlaw.com/Document/*',
    'https://*.gc.ca/*/item/*', 'https://decisia.lexum.com/*/item/*', 'https://decisions.scc-csc.ca/*/item/*',
    'https://coadecisions.ontariocourts.ca/*/item/*', 'https://decisions.cmac-cacm.ca/*/item/*', 'https://decisions.sct-trp.ca/*/item/*'
  ],
  js: ['marker-core.js', 'marker.js'],
  css: ['marker.css'],
  runAt: 'document_start',
  allFrames: true
};

async function syncCaseMarker() {
  const { caseMarker } = await chrome.storage.local.get({ caseMarker: true });
  const registered = (await chrome.scripting.getRegisteredContentScripts({ ids: [CASE_MARKER.id] })).length > 0;
  if (caseMarker === false) { if (registered) await chrome.scripting.unregisterContentScripts({ ids: [CASE_MARKER.id] }); return; }
  await (registered ? chrome.scripting.updateContentScripts([CASE_MARKER]) : chrome.scripting.registerContentScripts([CASE_MARKER]));
}
chrome.runtime.onInstalled.addListener(() => syncCaseMarker().catch(() => {}));
chrome.runtime.onStartup.addListener(() => syncCaseMarker().catch(() => {}));
// Case Marker stores each document under its own key: a single canliiMarkers object from before is
// split once, when the extension is installed, updated or the browser starts.
chrome.runtime.onInstalled.addListener(() => LegalPinpointerMarkerCore.splitLegacy().catch(() => {}));
chrome.runtime.onStartup.addListener(() => LegalPinpointerMarkerCore.splitLegacy().catch(() => {}));
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.caseMarker) syncCaseMarker().catch(() => {}); });

// The engine host asks to be closed once idle; the next request opens it again.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'LEGAL_PINPOINTER_ENGINE_IDLE' || sender.id !== chrome.runtime.id || sender.tab
      || sender.url !== chrome.runtime.getURL('engine-host.html')) return false;
  hostKnown = false;
  chrome.offscreen.closeDocument().catch(() => {});
  return false;
});
