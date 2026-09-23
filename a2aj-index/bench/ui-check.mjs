// Drives dist/a2aj-search.html like a user (file://, folder input, typed queries, court and date filters) in headless
// Chromium and saves screenshots.   node bench/ui-check.mjs --index <dir> --out <screenshot dir>
import {chromium} from 'playwright'; import fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url';
const argv = process.argv.slice(2), opt = n => argv[argv.indexOf(n) + 1];
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const out = path.resolve(opt('--out')); fs.mkdirSync(out, {recursive: true});
const browser = await chromium.launch({headless: true});
const page = await browser.newPage({viewport: {width: 1100, height: 1400}}); page.setDefaultTimeout(120000);
const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
await page.goto(pathToFileURL(path.join(root, 'dist', 'a2aj-search.html')).href);
await page.setInputFiles('#dir', path.resolve(opt('--index')));
await page.waitForFunction(() => !document.getElementById('q').disabled || /Missing|rror/.test(document.getElementById('status').textContent));
console.log('status:', await page.textContent('#status'));
const search = async (q, court, from, to, shot) => {
  await page.fill('#q', q);
  if (court !== undefined) await page.selectOption('#court', court);
  await page.fill('#from', from || ''); await page.fill('#to', to || '');
  await page.evaluate(() => { document.getElementById('meta').textContent = ''; });
  await page.click('#f button');
  await page.waitForFunction(() => /ms/.test(document.getElementById('meta').textContent));
  const rows = await page.$$eval('#results li', lis => lis.map(li => ({cite: li.querySelector('.head a')?.textContent, href: li.querySelector('.head a')?.href,
    name: li.querySelector('.name')?.textContent, sub: li.querySelector('.sub')?.textContent, marks: li.querySelectorAll('mark').length, text: li.querySelector('p')?.textContent.slice(0, 90)})));
  console.log(`\n## ${q} | court=${court || 'all'} ${from || ''}..${to || ''} | ${await page.textContent('#meta')} | ${rows.length} results`);
  for (const r of rows.slice(0, 4)) console.log(' ', r.cite, '|', r.name, '|', r.sub, '| marks', r.marks, '|', r.href, '|', r.text);
  if (shot) await page.screenshot({path: path.join(out, shot), fullPage: false});
  return rows;
};
await search('"duty to consult"', '', '', '', 'phrase.png');
const scc = await search('reasonable expectation of privacy in text messages', 'SCC', '', '', 'nl-scc.png');
if (scc.some(r => !/Supreme Court/.test(r.sub))) errors.push('court filter leaked non-SCC results');
const dated = await search('limitation period discoverability', '', '2020-01-01', '2021-12-31', 'dated.png');
if (dated.some(r => !/202[01]-/.test(r.sub))) errors.push('date filter leaked results outside 2020-2021');
await search('impaired driving blood alcohol', 'LEGISLATION-FED', '', '', 'statute.png');
await page.setViewportSize({width: 390, height: 900}); await page.screenshot({path: path.join(out, 'phone.png')});
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
if (overflow) errors.push('horizontal overflow at 390 px');
await browser.close();
console.log('\nerrors:', errors.length ? errors : 'none');
process.exit(errors.length ? 1 : 0);
