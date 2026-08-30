'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

test('the extension permission and host surface is frozen to the minimum contract', () => {
  assert.deepEqual(manifest.permissions, ['clipboardRead', 'clipboardWrite', 'storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.update_url, undefined);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    'https://www.canlii.org/*/doc/*',
    'https://www.canlii.org/*/laws/*',
    'https://canlii.org/*/doc/*',
    'https://canlii.org/*/laws/*',
    'https://advance.lexis.com/document/*',
    'https://nextcanada.westlaw.com/Document/*',
    'https://www.nextcanada.westlaw.com/Document/*'
  ]);
  assert.equal(
    manifest.content_security_policy.extension_pages,
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );
});

test('runtime scripts contain no remote-code or network primitives', () => {
  const ordinaryRuntime = ['canlii-courts.js', 'canlii-legislation.js', 'core.js', 'text-fragments.js', 'providers.js', 'content.js', 'popup.js']
    .map((filename) => fs.readFileSync(path.join(root, filename), 'utf8'))
    .join('\n');
  assert.doesNotMatch(ordinaryRuntime, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|eval|Function|sendBeacon)\s*\(/);
  const popup = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
  assert.doesNotMatch(popup, /<(?:script|link|img|iframe)[^>]+(?:src|href)=["']https?:/i);
  assert.doesNotMatch(popup, /\son[a-z]+\s*=/i);

  const worker = fs.readFileSync(path.join(root, 'engine-worker.js'), 'utf8');
  assert.equal((worker.match(/\bfetch\s*\(/g) || []).length, 2);
  assert.match(worker, /fetch\(chrome\.runtime\.getURL\('legal-structure\.wasm'\)\)/);
  assert.match(worker, /fetch\(chrome\.runtime\.getURL\('canlii-legislation\.tsv'\)\)/);
  assert.equal((worker.match(/\bimportScripts\s*\(/g) || []).length, 1);
  assert.match(worker, /importScripts\('canlii-legislation\.js'\)/);
  assert.doesNotMatch(worker, /\b(?:XMLHttpRequest|WebSocket|EventSource|eval|Function|sendBeacon)\s*\(/);
});

test('clipboard data is accessed only in the user-invoked copy path and is never persisted', () => {
  const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  assert.equal((content.match(/navigator\.clipboard\.readText\s*\(/g) || []).length, 1);
  assert.equal((content.match(/navigator\.clipboard\.write\s*\(/g) || []).length, 1);
  assert.match(content, /async function copySource[\s\S]*?await clipboardFragment\(model\)/);
  assert.doesNotMatch(content, /chrome\.storage\.(?:local|sync)\.set\([^)]*(?:clipboard|rememberedFragment)/is);
});

test('the packaged parser imports no host, network, filesystem, or clock functions', () => {
  const bytes = fs.readFileSync(path.join(root, 'legal-structure.wasm'));
  const module = new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
});
