'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const [provider, capturePath, originalUrl] = process.argv.slice(2);
if (!['canlii', 'lexis', 'westlaw'].includes(provider) || !capturePath || (provider === 'canlii' && !originalUrl)) {
  process.stderr.write('Usage: node tools/inspect-capture.cjs <canlii|lexis|westlaw> <saved-page-path> [original-document-URL]\n');
  process.exit(2);
}

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const projectRoot = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-pinpointer-capture-'));
const fileUrl = pathToFileURL(path.resolve(capturePath)).href;
const syntheticUrl = originalUrl || (provider === 'canlii'
  ? originalUrl
  : provider === 'lexis'
  ? 'https://advance.lexis.com/document/?pdmfid=1505209&pddocfullpath=%2Fshared%2Fdocument%2Fcases-ca%2Furn%3AcontentItem%3Atest&pdcontentcomponentid=281027'
  : 'https://nextcanada.westlaw.com/Document/Icapture');

async function analyzeEngine(input) {
  const bytes = fs.readFileSync(path.join(projectRoot, 'legal-structure.wasm'));
  const { instance } = await WebAssembly.instantiate(bytes);
  const encoded = new TextEncoder().encode(JSON.stringify(input));
  const pointer = instance.exports.legal_structure_alloc(encoded.length);
  new Uint8Array(instance.exports.memory.buffer, pointer, encoded.length).set(encoded);
  instance.exports.legal_structure_analyze(pointer, encoded.length);
  instance.exports.legal_structure_dealloc(pointer, encoded.length);
  const output = new Uint8Array(
    instance.exports.memory.buffer,
    instance.exports.legal_structure_output_pointer(),
    instance.exports.legal_structure_output_length()
  );
  return JSON.parse(new TextDecoder().decode(output));
}

const chrome = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-features=Vulkan',
  '--disable-background-networking',
  '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  fileUrl
], { stdio: 'ignore' });

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function port() {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(portFile)) {
      try {
        const value = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
        if (value) return value;
      } catch (_) {
        // Chrome can briefly hold the newly created port file open on Windows.
      }
    }
    if (chrome.exitCode != null) throw new Error(`Chrome exited before opening DevTools (${chrome.exitCode}).`);
    await delay(50);
  }
  throw new Error('Chrome did not open DevTools.');
}

function connection(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let sequence = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const task = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error.message));
    else task.resolve(message.result);
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('DevTools WebSocket failed.')), { once: true });
  });
  return {
    async send(method, params = {}) {
      await opened;
      const id = ++sequence;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() { socket.close(); }
  };
}

async function main() {
  const devtoolsPort = await port();
  let pages = [];
  for (let attempt = 0; attempt < 100 && !pages.length; attempt += 1) {
    pages = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`).then((response) => response.json());
    if (!pages.length) await delay(50);
  }
  const page = pages.find((candidate) => candidate.type === 'page');
  if (!page) throw new Error('Chrome did not expose the capture page.');
  const cdp = connection(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await delay(500);

  for (const filename of ['canlii-courts.js', 'core.js', 'text-fragments.js', 'providers.js']) {
    const expression = fs.readFileSync(path.join(projectRoot, filename), 'utf8');
    const loaded = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true });
    if (loaded.exceptionDetails) throw new Error(`${filename} did not load in the capture.`);
  }

  const expression = `(() => {
    const url = new URL(${JSON.stringify(syntheticUrl)});
    const locationLike = { href: url.href, hostname: url.hostname, pathname: url.pathname, search: url.search };
    window.__captureBase = LegalPinpointerProviders.inspectBase(document, locationLike);
    window.__capturePlane = LegalPinpointerTextFragments.buildStructureIndex(window.__captureBase.root);
    window.__capturePlane.root = window.__captureBase.root;
    const result = window.__captureBase;
    return {
      input: LegalPinpointerProviders.engineInput(result, window.__capturePlane),
      summary: {
        provider: result.provider,
        documentType: result.documentType,
        title: result.citation.title,
        citation: result.citation.citation,
        citationPlain: result.citation.plain,
        cleanUrl: result.cleanUrl,
        canliiUrl: result.canliiUrl,
        root: result.root && (result.root.id || result.root.className || result.root.tagName),
        nativeKind: result.nativeNodes[0] && result.nativeNodes[0].kind,
        nativeCount: result.nativeNodes.length,
        firstNativeLocator: result.nativeNodes[0] && result.nativeNodes[0].locator,
        lastNativeLocator: result.nativeNodes.at(-1) && result.nativeNodes.at(-1).locator
      }
    };
  })()`;
  const evaluated = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception.description);
  const engineResult = await analyzeEngine(evaluated.result.value.input);
  if (!engineResult.ok) throw new Error(engineResult.error || 'The legal structure engine rejected the capture.');
  const structured = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const structure = LegalPinpointerProviders.engineStructure(window.__captureBase, window.__capturePlane, ${JSON.stringify(engineResult)});
      const deepest = structure.nodes.reduce((best, node) => (
        LegalPinpointerCore.provisionDepth(node.locator) > LegalPinpointerCore.provisionDepth(best && best.locator)
          ? node
          : best
      ), null);
      const hoverTarget = deepest && deepest.contentStartPoint && deepest.contentStartPoint.node
        ? (deepest.contentStartPoint.node.parentElement || deepest.element)
        : deepest && deepest.element;
      const hoverMatches = hoverTarget ? structure.nodes
        .filter((node) => node.element && (node.element === hoverTarget || node.element.contains(hoverTarget)))
        .map((node) => node.locator) : [];
      return {
        kind: structure.kind,
        source: structure.source,
        count: structure.nodes.length,
        firstLocator: structure.nodes[0] && structure.nodes[0].locator,
        firstAnchor: structure.nodes[0] && structure.nodes[0].anchor,
        lastLocator: structure.nodes.at(-1) && structure.nodes.at(-1).locator,
        deepest: deepest && {
          locator: deepest.locator,
          anchor: deepest.anchor,
          element: deepest.element && {
            tag: deepest.element.tagName,
            id: deepest.element.id,
            className: deepest.element.className
          },
          hoverTarget: hoverTarget && {
            tag: hoverTarget.tagName,
            id: hoverTarget.id,
            className: hoverTarget.className
          },
          hoverMatches
        },
        provisionSamples: structure.nodes
          .filter((node) => ['1(s)', '1(t)', '1(u)', '1(u)(i)'].includes(node.locator))
          .map((node) => ({
            locator: node.locator,
            markerText: node.markerText,
            hasContentStart: Boolean(node.contentStartPoint)
          }))
      };
    })()`,
    returnByValue: true
  });
  if (structured.exceptionDetails) throw new Error(structured.exceptionDetails.exception.description);
  process.stdout.write(`${JSON.stringify({
    ...evaluated.result.value.summary,
    structure: structured.result.value,
    enginePageLabels: engineResult.nodes.filter((node) => node.kind === 'page').map((node) => node.label).slice(0, 20),
    enginePageRanges: engineResult.nodes.filter((node) => node.kind === 'page').slice(0, 3).map((node) => ({ label: node.label, range: node.range })),
    engineRevision: engineResult.engine_source_sha256
  }, null, 2)}\n`);
  await cdp.send('Browser.close');
  cdp.close();
}

async function cleanup() {
  if (chrome.exitCode == null) {
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    await Promise.race([exited, delay(2000)]);
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 9) throw error;
      await delay(100);
    }
  }
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  })
  .finally(cleanup);
