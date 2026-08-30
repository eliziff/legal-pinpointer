'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

test('selection, quote, range-link, text-fragment, and toast workflows pass in Chrome', { timeout: 30_000 }, () => {
  const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const fixture = pathToFileURL(path.join(__dirname, 'browser-fixture.html')).href;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-pinpointer-browser-'));
  try {
    const result = spawnSync(chrome, [
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--disable-gpu',
      '--disable-skia-graphite',
      '--disable-software-rasterizer',
      '--disable-background-networking',
      '--no-first-run',
      '--virtual-time-budget=10000',
      '--dump-dom',
      fixture
    ], { encoding: 'utf8', timeout: 25_000 });
    assert.equal(result.status, 0, result.stderr || `Chrome exited with ${result.status}.`);
    assert.match(result.stdout, /<pre id="result">PASS<\/pre>/, result.stdout.match(/<pre id="result">[\s\S]*?<\/pre>/)?.[0] || 'The browser fixture did not report a result.');
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
