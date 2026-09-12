'use strict';
// Renderer-only paired benchmark. Optional Playwright is a test driver, not an
// extension runtime dependency. Baseline is a separate, unmodified checkout.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const candidate = path.resolve(__dirname, '..');
const baseline = process.argv[2] && path.resolve(process.argv[2]);
if (!baseline) throw new Error('Pass a baseline checkout: node tools/benchmark-text-hotpaths.cjs /path/to/063ad13');
const median = values => {
  const sorted = values.slice().sort((a, b) => a - b), half = sorted.length >> 1;
  return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
};
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const observations = { baseline: [], candidate: [] };
  try {
    for (let trial = 0; trial < 5; trial++) {
      const variants = [['baseline', baseline], ['candidate', candidate]];
      if (trial % 2) variants.reverse();
      for (const [variant, root] of variants) {
        const page = await browser.newPage();
        try {
          await page.setContent('<main></main>');
          await page.evaluate(() => { globalThis.LegalPinpointerCore = {}; });
          await page.evaluate(fs.readFileSync(path.join(root, 'text-fragments.js'), 'utf8'));
          const sample = await page.evaluate(() => {
            const root = document.querySelector('main'), api = LegalPinpointerTextFragments;
            const paragraphs = Array.from({ length: 4000 }, (_, i) => `[${i + 1}] ` +
              'The privilege remains with the client. The applicant must provide evidence to the court. '.repeat(3).trim());
            const nodes = document.createDocumentFragment();
            for (const text of paragraphs) { const p = document.createElement('p'); p.textContent = text; nodes.append(p); }
            root.append(nodes); void root.offsetHeight;
            const expected = paragraphs.join('\n'), times = [], textOnly = [];
            let count = 0;
            for (let i = 0; i < 6; i++) {
              let start = performance.now();
              const index = api.buildStructureIndex(root, true);
              if (i) times.push(performance.now() - start);
              if (index.text !== expected) throw new Error('Structural text changed');
              count = index.runs.length;
              start = performance.now();
              const text = api.buildStructureIndex(root, 'text').text;
              if (i) textOnly.push(performance.now() - start);
              if (text !== expected) throw new Error('Text-only output changed');
            }
            const characters = expected.length;
            root.replaceChildren(document.createElement('p'));
            const p = root.firstChild;
            const fragments = {};
            for (const [name, text, directive] of [
              ['missingSuffix', 'required ' + 'start end '.repeat(1200) + 'finish', 'start,end,-required'],
              ['latePrefix', 'start end '.repeat(1200) + 'required start end after', 'required-,start,end,-after'],
              ['ordinaryHit', 'before The privilege remains with the client. after', 'The%20privilege,client.']
            ]) {
              p.textContent = text;
              const start = performance.now();
              const match = api.resolveUrl(`https://example.test/#:~:text=${directive}`, root);
              fragments[name] = { ms: performance.now() - start, matches: match?.matches || null };
              if (name === 'missingSuffix' ? match !== null : !match) throw new Error('Fragment result changed');
            }
            return { characters, records: count, mapMs: times, textOnlyMs: textOnly, fragments };
          });
          observations[variant].push(sample);
        } finally { await page.close(); }
      }
    }
    for (let i = 0; i < 5; i++) {
      const left = observations.baseline[i], right = observations.candidate[i];
      for (const name of Object.keys(left.fragments)) {
        if (JSON.stringify(left.fragments[name].matches) !== JSON.stringify(right.fragments[name].matches)) throw new Error('Match offsets changed');
      }
    }
    const summary = Object.fromEntries(Object.entries(observations).map(([key, runs]) => [key, {
      structuralMapMs: median(runs.flatMap(r => r.mapMs)), textOnlyMs: median(runs.flatMap(r => r.textOnlyMs)),
      missingSuffixMs: median(runs.map(r => r.fragments.missingSuffix.ms)),
      latePrefixMs: median(runs.map(r => r.fragments.latePrefix.ms)),
      ordinaryHitMs: median(runs.map(r => r.fragments.ordinaryHit.ms))
    }]));
    console.log(JSON.stringify({ browser: browser.version(), node: process.version, trials: 5,
      note: 'Synthetic foreground renderer, 4000 paragraphs; excludes extension IPC, parser, OS clipboard and live sites. Times have no regression thresholds.',
      summary, observations }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
