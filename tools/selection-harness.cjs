'use strict';

// Drives the real content script (providers + structure engine + copy paths) over a saved page in
// headless Chrome and reports what Ctrl+X / Ctrl+Shift+X produce for scripted selections.
// Usage: node tools/selection-harness.cjs <saved-page> <original-url> <scenario-module.cjs>
// The scenario module exports async (page) => results, where page.run(fn, ...args) evaluates fn in
// the page with helpers: window.__select(startText, endText, occurrence), window.__copy(mode).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const [capturePath, originalUrl, scenarioPath] = process.argv.slice(2);
const projectRoot = path.resolve(__dirname, '..');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-pinpointer-harness-'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'
], { stdio: 'ignore' });

async function devtoolsPort() {
  for (let i = 0; i < 200; i += 1) {
    try {
      const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
      if (port) return port;
    } catch (_) {}
    await delay(50);
  }
  throw new Error('Chrome did not open DevTools');
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const events = [];
  let id = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    } else if (message.method) events.forEach((fn) => fn(message));
  });
  const opened = new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  return {
    async send(method, params = {}) {
      await opened;
      id += 1;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    on(fn) { events.push(fn); }
  };
}

const shim = (url, wasmBase64) => `(() => {
  const bytes = Uint8Array.from(atob(${JSON.stringify(wasmBase64)}), (c) => c.charCodeAt(0));
  const enginePromise = WebAssembly.instantiate(bytes).then(({ instance }) => instance.exports);
  async function derive(input) {
    const engine = await enginePromise;
    const encoded = new TextEncoder().encode(JSON.stringify(input));
    const pointer = engine.legal_structure_alloc(encoded.length);
    new Uint8Array(engine.memory.buffer, pointer, encoded.length).set(encoded);
    engine.legal_structure_analyze(pointer, encoded.length);
    engine.legal_structure_dealloc(pointer, encoded.length);
    const out = new Uint8Array(engine.memory.buffer, engine.legal_structure_output_pointer(), engine.legal_structure_output_length());
    return JSON.parse(new TextDecoder().decode(out));
  }
  window.__clipboard = null;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    async readText() { return ''; },
    async write(items) {
      const item = items[0];
      window.__clipboard = { plain: await item.items['text/plain'].text(), html: await item.items['text/html'].text() };
    }
  } });
  window.ClipboardItem = class { constructor(items) { this.items = items; } };
  window.Blob = class { constructor(parts) { this.value = parts.join(''); } async text() { return this.value; } };
  window.chrome = {
    storage: { local: { get(defaults, callback) { callback({ ...defaults, ...(window.__settings || {}) }); }, set(_v, cb) { if (cb) cb(); } } },
    runtime: {
      id: 'harness', lastError: null,
      sendMessage(message, callback) {
        if (message.type === 'LEGAL_PINPOINTER_DERIVE_STRUCTURE') derive(message.input).then(callback, (e) => callback({ ok: false, message: String(e) }));
        else callback({ ok: false });
      },
      onMessage: { addListener(listener) { window.__listener = listener; } }
    }
  };
  window.__fakeLocation = new URL(${JSON.stringify(url)});
})()`;

const helpers = `(() => {
  const providers = window.LegalPinpointerProviders;
  const inspect = providers.inspect;
  const location = { href: __fakeLocation.href, hostname: __fakeLocation.hostname, pathname: __fakeLocation.pathname, search: __fakeLocation.search };
  providers.inspect = (doc) => inspect(doc, location);
  window.__textNodes = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    return nodes;
  };
  // Select from the start of startText to the end of endText (occurrence-th match of startText after the text "after").
  window.__select = (startText, endText, occurrence = 0, after = '') => {
    const nodes = window.__textNodes();
    const text = nodes.map((n) => n.nodeValue).join('');
    let at = after ? text.indexOf(after) : -1;
    if (after && at < 0) return false;
    for (let k = 0; k <= occurrence; k += 1) { at = text.indexOf(startText, at + 1); if (at < 0) return false; }
    const endAt = text.indexOf(endText, at) + endText.length;
    if (endAt < endText.length) return false;
    const locate = (offset, end) => {
      let base = 0;
      for (const n of nodes) {
        const len = n.nodeValue.length;
        if (offset < base + len || (end && offset === base + len)) return [n, offset - base];
        base += len;
      }
      return null;
    };
    const [sn, so] = locate(at, false);
    const [en, eo] = locate(endAt, true);
    const range = document.createRange();
    range.setStart(sn, so);
    range.setEnd(en, eo);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  };
  window.__copy = (mode) => new Promise((resolve) => {
    window.__clipboard = null;
    window.__listener({ type: 'LEGAL_PINPOINTER_COPY', mode, source: 'popup' }, { id: 'harness' }, (response) => {
      resolve(response.ok ? window.__clipboard : { error: response.message });
    });
  });
})()`;

// The saved page is served with its own scripts blocked by CSP. Disabling script execution instead
// would also silence the content script's event listeners (hover tracking).
function servePage() {
  // A capture's stylesheet sits beside it (Westlaw, Lexis); inline it as the paint gate does.
  const stylesheet = path.join(path.dirname(path.resolve(capturePath)), 'styles.css');
  let html = fs.readFileSync(path.resolve(capturePath), 'utf8');
  if (fs.existsSync(stylesheet)) {
    const style = `<style id="captured-styles">${fs.readFileSync(stylesheet, 'utf8').replace(/<\/style/gi, '<\\/style')}</style>`;
    html = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (head) => `${head}${style}`) : `${style}${html}`;
  }
  const body = Buffer.from(html, 'utf8');
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "script-src 'wasm-unsafe-eval'; object-src 'none'" });
    response.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const port = await devtoolsPort();
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const cdp = connect(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  const server = await servePage();
  let loaded;
  cdp.on((m) => { if (m.method === 'Page.loadEventFired' && loaded) loaded(); });
  const done = new Promise((resolve) => { loaded = resolve; });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/page` });
  await Promise.race([done, delay(20000)]);
  server.close();

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception ? result.exceptionDetails.exception.description : result.exceptionDetails.text);
    return result.result.value;
  };
  const wasm = fs.readFileSync(path.join(projectRoot, 'legal-structure.wasm')).toString('base64');
  await evaluate(shim(originalUrl, wasm));
  for (const name of ['canlii-courts.js', 'core.js', 'text-fragments.js', 'providers.js']) {
    await evaluate(fs.readFileSync(path.join(projectRoot, name), 'utf8'));
  }
  await evaluate(helpers);
  await evaluate(fs.readFileSync(path.join(projectRoot, 'content.js'), 'utf8'));

  const page = { run: (fn, ...args) => evaluate(`(${fn})(...${JSON.stringify(args)})`) };
  const scenario = require(path.resolve(scenarioPath));
  const results = await scenario(page);
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  await cdp.send('Browser.close').catch(() => {});
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; })
  .finally(async () => {
    chrome.kill();
    await delay(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  });
