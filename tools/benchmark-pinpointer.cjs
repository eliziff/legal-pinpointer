'use strict';
// Optional local benchmark. Renderer-only fixtures; no native parser, IPC or live provider timings.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const roots = { before: path.resolve(process.argv[2] || '.'), after: path.resolve(__dirname, '..') };
const median = values => { const sorted = [...values].sort((a,b) => a-b), at = sorted.length >> 1; return sorted.length % 2 ? sorted[at] : (sorted[at-1]+sorted[at])/2; };
const data = { before: [], after: [] };
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (let trial = 0; trial < 5; trial++) {
      for (const variant of (trial % 2 ? ['after','before'] : ['before','after'])) {
        const page = await browser.newPage();
        try {
          await page.setContent('<html><body><main></main></body></html>');
          await page.evaluate(() => {
            globalThis.LegalPinpointerCanliiCourts = {routes:{},frenchRoutes:{}};
            const fragment = document.createDocumentFragment();
            for (let i = 0; i < 4000; i++) {
              const p = document.createElement('p');
              p.textContent = `[${i+1}] ` + 'The applicant asserts privilege. The respondent alleges waiver. '.repeat(4);
              fragment.append(p);
            }
            document.querySelector('main').append(fragment); void document.body.offsetHeight;
          });
          for (const file of ['core.js','text-fragments.js','providers.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(roots[variant],file),'utf8') });
          const result = await page.evaluate(compact => {
            const root = document.querySelector('main'), f = LegalPinpointerTextFragments;
            let start = performance.now();
            const plane = f.buildStructureIndex(root, compact); plane.root = root;
            const mapMs = performance.now()-start;
            const nodes = [...plane.text.matchAll(/\[\d+\]/g)].map((m,i) => ({kind:'paragraph',label:`par${i+1}`,range:{start:m.index,end:Math.min(plane.text.length,m.index+40)}}));
            start=performance.now();
            const structure = LegalPinpointerProviders.engineStructure({provider:'canlii',documentType:'case',nativeNodes:[],citation:{title:'Synthetic'}},plane,{offset_unit:'utf16',nodes});
            const bridgeMs=performance.now()-start;
            const selected = [];
            for (let i=1;i<=300;i++) selected.push({locator:String(i)},{locator:`${i}(1)`},{locator:`${i}(1)(a)`});
            start=performance.now();
            const remaining=LegalPinpointerCore.removeRedundantProvisionAncestors(selected);
            const ancestorsMs=performance.now()-start;
            return {characters:plane.text.length,mapMs,bridgeMs,ancestorsMs,records:plane.runs?.length || plane.points.length,
              structureCount:structure.nodes.length,retained:remaining.length,first:remaining[0].locator,last:remaining.at(-1).locator};
          }, variant==='after');
          if(result.structureCount!==4000 || result.retained!==300 || result.first!=='1(1)(a)' || result.last!=='300(1)(a)') throw new Error('Changed outputs');
          data[variant].push(result);
        } finally { await page.close(); }
      }
    }
    const summary = Object.fromEntries(Object.entries(data).map(([key,runs])=>[key,Object.fromEntries(['mapMs','bridgeMs','ancestorsMs','records'].map(metric=>[metric,median(runs.map(r=>r[metric]))]))]));
    console.log(JSON.stringify({browser:browser.version(),node:process.version,trials:5,summary,data},null,2));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
