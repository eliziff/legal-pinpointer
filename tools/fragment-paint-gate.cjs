'use strict';

// Real-browser proof of built text-fragment links, after MikeOSS Fork's exact paint gate
// (experiments/text-fragment-fidelity/webdriver-exact-gate.py). Each saved corpus page is served
// locally with scripts blocked and ::target-text painted pure green; the extension builds links for
// sampled passages on one load of the page, and every link is then opened by a fresh navigation.
// A link passes only as "exact-match": Chrome's first viewport lands on the passage, at least 25
// green pixels fall inside it, its first and last words are both painted (at least 10 each), and no
// more than max(25, 5% of inside) green pixels fall anywhere else.
// Usage: node tools/fragment-paint-gate.cjs [--providers canlii,westlaw,lexis] [--pages 30]
//          [--trials 6] [--seed 7] [--keys k1,k2] [--out results.jsonl]
//        node tools/fragment-paint-gate.cjs --replay links.jsonl
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, at, all) => (
  value.startsWith('--') ? [...pairs, [value.slice(2), all[at + 1]]] : pairs), []));
const corpus = process.env.PINPOINTER_CORPUS
  || path.join(process.env.LOCALAPPDATA || os.homedir(), 'OpenLegalData', 'pinpointer-corpus');
const providers = (args.providers || 'canlii,westlaw,lexis').split(',');
const pagesPerProvider = Number(args.pages || 20);
const trials = Number(args.trials || 6);
const out = args.out || path.join(corpus, 'results', 'fragment-paint-gate.jsonl');
const projectRoot = path.resolve(__dirname, '..');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PAINT_RETRY_DELAYS = [30, 60, 120, 240, 480, 960];
const VIEWPORT = { width: 1280, height: 900 };

let seed = Number(args.seed || 7);
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

function pickPages() {
  const rows = fs.readFileSync(path.join(corpus, 'index.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  if (args.keys) {
    const keys = new Set(args.keys.split(','));
    return rows.filter((row) => keys.has(row.key));
  }
  // Shuffled per provider, then interleaved so every provider is covered from the start.
  const pools = providers.map((provider) => {
    const pool = rows.filter((row) => row.provider === provider);
    for (let at = pool.length - 1; at > 0; at -= 1) {
      const other = Math.floor(random() * (at + 1));
      [pool[at], pool[other]] = [pool[other], pool[at]];
    }
    return pool.slice(0, pagesPerProvider);
  });
  const picked = [];
  for (let at = 0; pools.some((pool) => at < pool.length); at += 1) {
    for (const pool of pools) if (at < pool.length) picked.push(pool[at]);
  }
  return picked;
}

// Pages are DOM snapshots served as UTF-8, scripts blocked, highlight painted green.
function serve(pages) {
  const byKey = new Map(pages.map((page) => [page.key, page]));
  const server = http.createServer((request, response) => {
    const key = decodeURIComponent(new URL(request.url, 'http://x').pathname.replace(/^\/page\//, ''));
    const page = byKey.get(key);
    if (!page) {
      response.writeHead(404);
      response.end();
      return;
    }
    const dir = path.join(corpus, page.dir);
    const file = ['rendered.html', 'raw.html'].map((name) => path.join(dir, name)).find((name) => fs.existsSync(name));
    let html = fs.readFileSync(file, 'utf8');
    const cssPath = path.join(dir, 'styles.css');
    const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8').replace(/<\/style/gi, '<\\/style') : '';
    const paint = `<style id="captured-styles">${css}</style>`
      + '<style id="fragment-proof-style">::target-text{background:rgb(0,255,0)!important;color:rgb(0,0,0)!important}</style>';
    html = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (head) => `${head}${paint}`) : `${paint}${html}`;
    const body = Buffer.from(html, 'utf8');
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'Content-Length': body.length
    });
    response.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function decodePng(buffer) {
  let at = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const data = [];
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('ascii', at + 4, at + 8);
    const chunk = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      if (chunk[8] !== 8 || chunk[12] !== 0) throw new Error('Unsupported PNG');
      colorType = chunk[9];
    } else if (type === 'IDAT') data.push(chunk);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const above = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = above ? above[x] : 0;
      const corner = above && x >= channels ? above[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - corner;
        const [a, b, c] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - corner)];
        value += a <= b && a <= c ? left : (b <= c ? up : corner);
      }
      row[x] = value & 255;
    }
  }
  return { width, height, channels, pixels };
}

// The reference's "html" target mask: r <= 35, g >= 220, b <= 35.
function greenMask(image) {
  const mask = new Uint8Array(image.width * image.height);
  for (let p = 0, q = 0; p < mask.length; p += 1, q += image.channels) {
    const [r, g, b] = [image.pixels[q], image.pixels[q + 1], image.pixels[q + 2]];
    mask[p] = r <= 35 && g >= 220 && b <= 35 ? 1 : 0;
  }
  return mask;
}

function countIn(mask, image, rects, padding) {
  const seen = new Uint8Array(mask.length);
  let count = 0;
  for (const rect of rects) {
    const x0 = Math.max(0, Math.floor(rect.x - padding));
    const x1 = Math.min(image.width, Math.ceil(rect.x + rect.width + padding));
    const y0 = Math.max(0, Math.floor(rect.y - padding));
    const y1 = Math.min(image.height, Math.ceil(rect.y + rect.height + padding));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const p = y * image.width + x;
        if (!seen[p]) {
          seen[p] = 1;
          count += mask[p];
        }
      }
    }
  }
  return count;
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = [];
  let id = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) task.reject(new Error(message.error.message));
      else task.resolve(message.result);
    } else if (message.method) listeners.forEach((listener) => listener(message));
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
    on(listener) { listeners.push(listener); },
    close() { socket.close(); }
  };
}

async function openTab(port, browser) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const tab = connect(list.find((target) => target.id === targetId).webSocketDebuggerUrl);
  await tab.send('Page.enable');
  await tab.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
  let loaded = null;
  tab.on((message) => { if (message.method === 'Page.loadEventFired' && loaded) loaded(); });
  tab.targetId = targetId;
  tab.load = async (url) => {
    const done = new Promise((resolve) => { loaded = resolve; });
    await tab.send('Page.navigate', { url });
    await Promise.race([done, delay(30000)]);
    loaded = null;
  };
  tab.evaluate = async (expression) => {
    const result = await tab.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception ? result.exceptionDetails.exception.description : result.exceptionDetails.text);
    }
    return result.result.value;
  };
  tab.screenshot = async () => {
    const { data } = await tab.send('Page.captureScreenshot', { format: 'png' });
    return decodePng(Buffer.from(data, 'base64'));
  };
  return tab;
}

const extensionScripts = ['canlii-courts.js', 'core.js', 'text-fragments.js']
  .map((name) => fs.readFileSync(path.join(projectRoot, name), 'utf8'));

// In-page: choose passages inside the document root (the root selectors mirror providers.js) and
// build their links with the extension's own builder.
const BUILD = `async (provider, trials, seedValue) => {
  const F = window.LegalPinpointerTextFragments;
  const selectors = {
    canlii: ['#originalDocument', '#documentContent', '#docCont', 'main'],
    lexis: ['#document', '.document-text', '.SS_contentdocument', 'main'],
    westlaw: ['#co_document_0', '.co_document', 'main']
  }[provider] || [];
  const root = selectors.map((selector) => document.querySelector(selector)).find(Boolean) || document.body;
  let seed = seedValue;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const started = performance.now();
  const index = F.buildTextIndex(document.body);
  const permissiveIndex = F.buildTextIndex(document.body, { permissive: true });
  const indexMs = performance.now() - started;
  const pathOf = (node) => {
    const steps = [];
    for (let current = node; current.parentNode; current = current.parentNode) {
      steps.unshift(Array.prototype.indexOf.call(current.parentNode.childNodes, current));
    }
    return steps;
  };
  const points = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const pattern = /\\S+/g;
    for (let match = pattern.exec(text.nodeValue); match; match = pattern.exec(text.nodeValue)) {
      points.push({ node: text, start: match.index, end: match.index + match[0].length });
    }
  }
  const visible = (point) => {
    const style = getComputedStyle(point.node.parentElement);
    return style.visibility === 'visible' && point.node.parentElement.getClientRects().length > 0;
  };
  const out = [];
  if (points.length < 20) return { out, indexMs, words: points.length };
  for (let attempt = 0; out.length < trials && attempt < trials * 6; attempt += 1) {
    const kind = ['words', 'words', 'span', 'span', 'block', 'partial'][out.length % 6];
    let range = document.createRange();
    const first = Math.floor(random() * (points.length - 2));
    const a = points[first];
    if (!visible(a)) continue;
    if (kind === 'block') {
      range = F.passageRange(a.node, a.start);
      if (!range) continue;
    } else {
      const length = kind === 'words' ? 1 + Math.floor(random() * 10) : 10 + Math.floor(random() * 70);
      const b = points[Math.min(points.length - 1, first + length)];
      if (kind === 'partial') {
        range.setStart(a.node, a.start + Math.floor(random() * (a.end - a.start)));
        range.setEnd(b.node, b.start + 1 + Math.floor(random() * (b.end - b.start - 1)));
      } else {
        range.setStart(a.node, a.start);
        range.setEnd(b.node, b.end);
      }
    }
    const buildStarted = performance.now();
    let link = null;
    let error = '';
    try {
      link = F.buildPassageLink(range, { contextRoot: root, index, permissiveIndex });
    } catch (caught) {
      error = String(caught && caught.stack || caught);
    }
    const buildMs = performance.now() - buildStarted;
    const selected = range.toString().replace(/\\s+/g, ' ').trim().slice(0, 100);
    if (!link) {
      const selection = {
        start: pathOf(range.startContainer), startOffset: range.startOffset,
        end: pathOf(range.endContainer), endOffset: range.endOffset
      };
      out.push({ kind, selected, directive: null, error, buildMs, selection });
      continue;
    }
    out.push({
      kind, selected, buildMs, directive: link.directive,
      passage: link.range.toString().replace(/\\s+/g, ' ').trim().slice(0, 160),
      expected: {
        start: pathOf(link.range.startContainer), startOffset: link.range.startOffset,
        end: pathOf(link.range.endContainer), endOffset: link.range.endOffset
      }
    });
  }
  return { out, indexMs, words: points.length };
}`;

// In-page on the fragment load: document-space rectangles of the expected passage and of its first
// and last words, plus the landing viewport.
const GEOMETRY = `(expected) => {
  const nodeAt = (steps) => steps.reduce((node, step) => node && node.childNodes[step], document);
  const startNode = nodeAt(expected.start);
  const endNode = nodeAt(expected.end);
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, expected.startOffset);
  range.setEnd(endNode, expected.endOffset);
  const rects = (target) => Array.from(target.getClientRects())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => ({ x: rect.left, y: rect.top + scrollY, width: rect.width, height: rect.height }));
  // The first and last words of the passage that are laid out inside the viewport's width (a
  // hanging paragraph number can sit left of it, where no paint can be seen).
  const edgeWord = (forward) => {
    const container = range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (range.intersectsNode(node)) nodes.push(node);
    if (!forward) nodes.reverse();
    for (const node of nodes) {
      const low = node === startNode ? expected.startOffset : 0;
      const high = node === endNode ? expected.endOffset : node.nodeValue.length;
      const words = [...node.nodeValue.slice(low, high).matchAll(/\\S+/g)].map((match) => [low + match.index, low + match.index + match[0].length]);
      if (!forward) words.reverse();
      for (const [a, b] of words) {
        const piece = document.createRange();
        piece.setStart(node, a);
        piece.setEnd(node, b);
        const seen = rects(piece).filter((rect) => rect.x + rect.width > 0 && rect.x < innerWidth);
        if (seen.length) return seen;
      }
    }
    return [];
  };
  return {
    rects: rects(range), first: edgeWord(true), last: edgeWord(false),
    scrollY, innerHeight, text: range.toString().slice(0, 60)
  };
}`;

function assess(image, geometry, scrollY) {
  const shift = (rects) => rects.map((rect) => ({ ...rect, y: rect.y - scrollY }));
  const mask = greenMask(image);
  const total = mask.reduce((sum, value) => sum + value, 0);
  const inside = countIn(mask, image, shift(geometry.rects), 4);
  return {
    inside,
    outside: Math.max(0, total - inside),
    endpoints: [countIn(mask, image, shift(geometry.first), 2), countIn(mask, image, shift(geometry.last), 2)],
    total
  };
}

function status(metrics) {
  if (metrics.inside < 25) return 'paint-missed-exact-range';
  if (Math.min(...metrics.endpoints) < 10) return 'paint-did-not-cover-range';
  if (metrics.outside > Math.max(25, metrics.inside * 0.05)) return 'paint-extraneous';
  return 'exact-match';
}

async function prove(tab, url, expected) {
  await tab.load(url);
  let image = null;
  let waited = 0;
  let geometry = null;
  for (const wait of [0, ...PAINT_RETRY_DELAYS]) {
    if (wait) await delay(wait);
    waited += wait;
    image = await tab.screenshot();
    geometry = await tab.evaluate(`(${GEOMETRY})(${JSON.stringify(expected)})`);
    if (!geometry) return { verdict: 'expected-range-unresolved' };
    if (greenMask(image).some(Boolean)) break;
  }
  const top = geometry.scrollY;
  const bottom = top + geometry.innerHeight;
  const landed = geometry.rects.some((rect) => rect.y < bottom && rect.y + rect.height > top);
  if (!landed) return { verdict: 'initial-viewport-missed-passage', waited, scrollY: top };
  const fits = geometry.rects.every((rect) => rect.y >= top && rect.y + rect.height <= bottom);
  let metrics = assess(image, geometry, top);
  if (!fits) {
    // Long passages: prove each end in its own capture, counting green outside the passage in both.
    const capture = async (y) => {
      const scrolled = await tab.evaluate(`(() => { window.scrollTo(0, Math.max(0, ${y} - innerHeight / 2)); return scrollY; })()`);
      await delay(60);
      return assess(await tab.screenshot(), geometry, scrolled);
    };
    const start = await capture(geometry.first[0] ? geometry.first[0].y : geometry.rects[0].y);
    const end = await capture(geometry.last.length ? geometry.last[geometry.last.length - 1].y : geometry.rects[geometry.rects.length - 1].y);
    metrics = {
      inside: Math.min(start.inside, end.inside),
      outside: Math.max(start.outside, end.outside),
      endpoints: [start.endpoints[0], end.endpoints[1]],
      total: Math.max(start.total, end.total)
    };
  }
  return { verdict: status(metrics), waited, ...metrics };
}

async function launch(pages) {
  const server = await serve(pages);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-pinpointer-paint-gate-'));
  const chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, 'about:blank'
  ], { stdio: 'ignore' });
  let port = 0;
  for (let attempt = 0; attempt < 200 && !port; attempt += 1) {
    try {
      port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
    } catch (_) {
      await delay(50);
    }
  }
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
  const browser = connect(version.webSocketDebuggerUrl);
  const close = async () => {
    await browser.send('Browser.close').catch(() => {});
    chrome.kill();
    server.close();
    await delay(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  };
  return { origin, close, tab: () => openTab(port, browser) };
}

async function main() {
  const pages = pickPages();
  const { origin, close, tab } = await launch(pages);
  const builder = await tab();
  const viewer = await tab();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const sink = fs.createWriteStream(out, { flags: 'a' });
  const tally = {};
  let proof = 0;
  try {
    for (const page of pages) {
      const pageUrl = `${origin}/page/${encodeURIComponent(page.key)}`;
      await builder.load(pageUrl);
      for (const source of extensionScripts) await builder.evaluate(source);
      const built = await builder.evaluate(`(${BUILD})(${JSON.stringify(page.provider)}, ${trials}, ${Math.floor(random() * 1e9)})`);
      for (const trial of built.out) {
        const row = { key: page.key, provider: page.provider, documentType: page.documentType, kind: trial.kind,
          selected: trial.selected, passage: trial.passage, directive: trial.directive, buildMs: Math.round(trial.buildMs),
          indexMs: Math.round(built.indexMs) };
        if (!trial.directive) {
          row.verdict = trial.error ? 'build-error' : 'no-directive';
          row.selection = trial.selection;
          if (trial.error) row.error = trial.error.slice(0, 300);
        } else {
          proof += 1;
          Object.assign(row, await prove(viewer, `${pageUrl}?proof=${proof}#:~:${trial.directive}`, trial.expected));
        }
        tally[`${page.provider}:${row.verdict}`] = (tally[`${page.provider}:${row.verdict}`] || 0) + 1;
        sink.write(`${JSON.stringify(row)}\n`);
        if (row.verdict !== 'exact-match') process.stderr.write(`${row.verdict} ${page.provider} ${page.key} ${row.kind} ${String(row.directive).slice(0, 120)}\n`);
      }
    }
  } finally {
    sink.end();
    process.stdout.write(`${JSON.stringify(tally, null, 1)}\n`);
    await close();
  }
}

// --replay <file.jsonl>: prove links built elsewhere (rows with key, directive and expected paths),
// such as those copied through the content script by tools/selection-harness.cjs.
async function replay() {
  const rows = fs.readFileSync(args.replay, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
    .filter((row) => row.directive && row.expected);
  const index = fs.readFileSync(path.join(corpus, 'index.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const { origin, close, tab } = await launch(index.filter((page) => rows.some((row) => row.key === page.key)));
  const viewer = await tab();
  const tally = {};
  try {
    for (const [at, row] of rows.entries()) {
      const url = `${origin}/page/${encodeURIComponent(row.key)}?proof=${at}#:~:${row.directive}`;
      const proof = await prove(viewer, url, row.expected);
      tally[proof.verdict] = (tally[proof.verdict] || 0) + 1;
      process.stdout.write(`${JSON.stringify({ key: row.key, kind: row.kind, directive: row.directive.slice(0, 120), ...proof })}\n`);
    }
  } finally {
    process.stdout.write(`${JSON.stringify(tally)}\n`);
    await close();
  }
}

module.exports = { launch, extensionScripts, corpus };
if (require.main === module) {
  (args.replay ? replay() : main()).catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
}
