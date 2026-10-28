'use strict';

// Whether the paragraph and provision copy buttons ever cover the page's text: loads saved CanLII, Westlaw and Lexis
// pages with the unpacked extension at their real URLs (page scripts blocked) at several window widths, scrolls each
// through, and wherever a copy button is shown checks the page's own text lines under it. Prints each page that has a
// covered line (with the button's side and the text it covers) and a summary per width.
// Usage: node tools/check-unit-margins.cjs <pinpointer-corpus-dir> [per-provider-limit] [width ...]
// Requires Playwright: set PLAYWRIGHT_MODULE (and CHROME_PATH) as for tools/check-page-ui.cjs.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const [corpus, limitArg, ...widthArgs] = process.argv.slice(2);
if (!corpus) { process.stderr.write('Usage: node tools/check-unit-margins.cjs <corpus-dir> [per-provider-limit] [width ...]\n'); process.exit(2); }
const limit = Number(limitArg || 40);
const widths = widthArgs.length ? widthArgs.map(Number) : [1440, 1100, 820, 640];

function samples(provider) {
  const base = path.join(corpus, provider);
  return fs.readdirSync(base).sort().slice(0, limit).map((dir) => {
    const folder = path.join(base, dir);
    const capture = JSON.parse(fs.readFileSync(path.join(folder, 'capture.json'), 'utf8'));
    const file = ['raw.html', 'rendered.html'].map((name) => path.join(folder, name)).find((name) => fs.existsSync(name));
    if (!file) return null;
    let html = fs.readFileSync(file, 'utf8');
    const styles = path.join(folder, 'styles.css');
    if (fs.existsSync(styles) && provider !== 'canlii') html = html.replace(/<\/head>/i, `<style>${fs.readFileSync(styles, 'utf8')}</style></head>`);
    return { provider, url: capture.url, html, name: dir.split('__')[1] || dir };
  }).filter(Boolean);
}

// In the page: every shown copy button whose box a line of the page's own text crosses.
function coveredText() {
  const hits = [];
  // A control shown only under the pointer ("peek") covers what a hover over its unit would show it over.
  for (const node of document.querySelectorAll('.lp-unit[data-place="peek"]')) node.classList.add('hot');
  const ui = (node) => node.parentElement?.closest('[data-lp-ui], .lp-unit, .lp-units');
  for (const button of document.querySelectorAll('.lp-unit button')) {
    const box = button.getBoundingClientRect();
    if (!box.width || !box.height || getComputedStyle(button).visibility === 'hidden' || getComputedStyle(button.parentElement).opacity === '0') continue;
    if (box.bottom < 0 || box.top > innerHeight) continue;
    const inset = 2;
    const seen = new Set();
    for (const [fx, fy] of [[0.5, 0.5], [0.15, 0.2], [0.85, 0.2], [0.15, 0.8], [0.85, 0.8]]) {
      for (const element of document.elementsFromPoint(box.left + box.width * fx, box.top + box.height * fy)) {
        if (element.closest('[data-lp-ui], .lp-unit, .lp-units') || seen.has(element)) continue;
        seen.add(element);
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent.trim() || ui(node)) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const line of range.getClientRects()) {
            if (line.right > box.left + inset && line.left < box.right - inset && line.bottom > box.top + inset && line.top < box.bottom - inset) {
              hits.push({ side: Math.round(box.left), text: node.textContent.trim().slice(0, 60) });
              break;
            }
          }
          if (hits.length && hits[hits.length - 1].text === node.textContent.trim().slice(0, 60)) break;
        }
      }
    }
  }
  return hits;
}

(async () => {
  const pages = ['canlii', 'westlaw', 'lexis'].flatMap(samples);
  const summary = [];
  for (const width of widths) {
    const context = await chromium.launchPersistentContext('', {
      headless: true, channel: 'chromium', viewport: { width, height: 900 },
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    });
    let current = null;
    await context.route('**/*', (route) => {
      const request = route.request();
      if (!/^https?:/.test(request.url())) return route.continue();
      if (request.resourceType() === 'document' && current) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: current.html });
      return route.abort();
    });
    const page = context.pages()[0] || await context.newPage();
    let covered = 0, withControls = 0;
    for (const sample of pages) {
      current = sample;
      try {
        await page.goto(sample.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForSelector('.lp-unit', { timeout: 4000 }).catch(() => {});
        if (!(await page.$('.lp-unit'))) continue;
        withControls++;
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        const hits = [];
        for (let y = 0; y < height; y += 700) {
          await page.evaluate((top) => window.scrollTo(0, top), y);
          await page.waitForTimeout(120);
          hits.push(...await page.evaluate(coveredText));
          if (hits.length > 5) break;
        }
        if (hits.length) {
          covered++;
          console.log(`${width} ${sample.provider} ${sample.name}: ${hits.length} covered, e.g. at x=${hits[0].side}: ${JSON.stringify(hits[0].text)}`);
        }
      } catch (error) {
        console.log(`${width} ${sample.provider} ${sample.name}: ${error.message.split('\n')[0]}`);
      }
    }
    summary.push(`${width}px: ${covered} of ${withControls} pages with copy buttons have one over text`);
    await context.close();
  }
  console.log('\n' + summary.join('\n'));
})();
