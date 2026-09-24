'use strict';

// Evaluates an expression on a saved corpus page served exactly as the paint gate serves it, with
// the extension's fragment scripts loaded. Usage:
//   node tools/fragment-probe.cjs <corpus-key> "<expression>" [fragment-directive]
// With a directive, the page is opened at #:~:<directive> and the expression runs after Chrome's
// text search has had time to finish (window.__landed holds scrollY).
const fs = require('node:fs');
const path = require('node:path');
const { launch, extensionScripts, corpus } = require('./fragment-paint-gate.cjs');

const [key, expression, directive] = process.argv.slice(2);

async function main() {
  const rows = fs.readFileSync(path.join(corpus, 'index.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const page = rows.find((row) => row.key === key);
  if (!page) throw new Error(`No corpus page ${key}`);
  const browser = await launch([page]);
  try {
    const tab = await browser.tab();
    await tab.load(`${browser.origin}/page/${encodeURIComponent(key)}${directive ? `?probe=1#:~:${directive}` : ''}`);
    if (directive) await new Promise((resolve) => setTimeout(resolve, 1500));
    for (const source of extensionScripts) await tab.evaluate(source);
    const value = await tab.evaluate(expression);
    process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 1)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
