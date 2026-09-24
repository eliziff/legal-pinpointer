// Bundles the search page into one self-contained HTML file (works from file://; the worker runs from a blob URL).
//   node build/build-page.mjs [out.html]   (default dist/a2aj-search.html)
import * as esbuild from 'esbuild'; import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const out = process.argv[2] || path.join(root, 'dist', 'a2aj-search.html');
const bundle = async entry => (await esbuild.build({entryPoints: [path.join(root, 'src', entry)], bundle: true, format: 'iife', minify: true, write: false, target: 'chrome110', legalComments: 'none'})).outputFiles[0].text.replace(/<\/script/gi, '<\/script');
const html = fs.readFileSync(path.join(root, 'src', 'page.html'), 'utf8');
const [w, p] = [await bundle('worker.mjs'), await bundle('page.mjs')];
fs.mkdirSync(path.dirname(out), {recursive: true});
fs.writeFileSync(out, html.replace('/*WORKER*/', () => w).replace('/*PAGE*/', () => p));
console.log(out, fs.statSync(out).size, 'bytes');
