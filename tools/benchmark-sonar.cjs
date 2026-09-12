'use strict';
// Optional test driver only. No browser dependency is shipped by the extension.
// Pass an old checkout to compare the old release-on-query lifecycle fairly.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const currentRoot = path.resolve(__dirname, '..');
const baselineRoot = process.argv[2] && path.resolve(process.argv[2]);
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const variants = baselineRoot ? { baseline: baselineRoot, current: currentRoot } : { current: currentRoot };
  const runs = Object.fromEntries(Object.keys(variants).map(key => [key, []]));
  try {
    for (let trial = 0; trial < 5; trial++) {
      const order = Object.entries(variants); if (trial % 2) order.reverse();
      for (const [variant, root] of order) {
        const page = await browser.newPage();
        try {
          await page.setContent('<html lang="en"><body></body></html>');
          await page.evaluate(() => {
            const fragment = document.createDocumentFragment();
            for (let i = 0; i < 6000; i++) {
              const p = document.createElement('p');
              p.textContent = `Paragraph ${i}. ` + 'The privilege remains with the client. The applicant must provide evidence to the court. '.repeat(3);
              if (i % 100 === 0) p.append(' Waiver of privilege was considered.');
              fragment.append(p);
            }
            document.body.append(fragment); void document.body.offsetHeight;
          });
          for (const file of ['find-core.js', 'find-page.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(root, file), 'utf8') });
          const result = await page.evaluate(async keepIndex => {
            const agent = LegalPinpointerSearchPage, readStyle = getComputedStyle;
            let reads = 0, prior, initialReads;
            window.getComputedStyle = (...args) => { reads++; return readStyle(...args); };
            const times = [], counts = [];
            for (let i = 0; i < 7; i++) {
              if (prior) agent.release(prior, keepIndex);
              const ticket = `trial${i}`, start = performance.now();
              const value = await agent.search({ query: i % 2 ? 'privilege waiver' : 'privilege missingneedle',
                mode: 'p', ticket, deadline: Date.now() + 20000 });
              times.push(performance.now() - start); counts.push(value.results.length); prior = ticket;
              if (i === 0) initialReads = reads;
            }
            const queryReads = reads;
            const hits = await agent.search({ query: 'privilege waiver', mode: 'p', ticket: 'paint', deadline: Date.now() + 20000 });
            agent.preview('paint', 0, false);
            const sheet = document.adoptedStyleSheets.at(-1), all = CSS.highlights.get('legal-pinpointer-sonar-hits');
            const start = performance.now();
            for (let i = 0; i < 300; i++) agent.preview('paint', i % hits.results.length, false);
            return { characters: document.body.textContent.length, paragraphs: 6000, times, counts,
              coldStyleReads: initialReads, repeatStyleReads: queryReads - initialReads,
              paint300: performance.now() - start,
              paintReused: sheet === document.adoptedStyleSheets.at(-1) && all === CSS.highlights.get('legal-pinpointer-sonar-hits') };
          }, variant !== 'baseline');
          if (result.counts.some((count, i) => count !== (i % 2 ? 60 : 0))) throw new Error('Benchmark changed search results.');
          runs[variant].push(result);
        } finally { await page.close(); }
      }
    }
    const summaries = Object.fromEntries(Object.entries(runs).map(([variant, data]) => [variant, {
      coldMs: median(data.map(r => r.times[0])), repeatMs: median(data.flatMap(r => r.times.slice(1))),
      paint300Ms: median(data.map(r => r.paint300)),
      coldStyleReads: data.map(r => r.coldStyleReads), repeatStyleReads: data.map(r => r.repeatStyleReads),
      paintReused: data.every(r => r.paintReused)
    }]));
    console.log(JSON.stringify({ browser: browser.version(), node: process.version, trials: 5,
      note: 'Synthetic foreground HTML; renderer search/paint only, no tab IPC, OS shortcut or live websites. No timing assertions.',
      summaries, runs }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
