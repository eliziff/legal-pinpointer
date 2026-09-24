# Tab Sonar speed work (in progress; delete when done)

Goal: warm first results < 50 ms, reranked < 500 ms at 4x; R@10 >= ~0.80; memory low (panel,
workers, tab pages) and reported everywhere.

## Done (commit 160ebed)
- In-panel index worker `sonar-index.js` (UTF-8 text, compact postings, hash-keyed word forms,
  incremental BM25 over tabs in scope). Broker: SONAR_UNITS (read tab text, registry per
  workspace), SONAR_ISSUE (ranked handles = tab, document, unit, text hash). Page: `units()`
  (drops its own index after reading), ranked handles revalidated by unit text hash on
  preview/jump/copy. Panel reads tabs in idle time, origin first; tab events and
  SONAR_INVALIDATED re-read one tab. Rerank worker: one batched session.run, progressive
  (8, then rest), score cache, idle release after 3 min.
- Offline quality (n=38, scratch sonar-fast/quality.json): K=30 needed for R@10;
  L6 whole .836, L4 256/whole .839, L2 whole .813, tiny 192 .789; K20 <= .786.
- WASM speed (bench.json, 1x, 4 threads, 20 pairs): tiny 80 ms, L2 417, L4 835, L6 1279.
- DevTools CPU throttling does not apply to workers: 4x = CDP on tab pages plus scratch
  `slow-process.ps1` suspending the extension process 3/4 of every 20 ms.
- Headless Chromium here has WebGPU (Intel gen-12lp).

## Next
- bench2 (WASM threads + WebGPU fp16, external 4x), quality2 (fusion), choose model;
  update tools/fetch-rerank-model.cjs; extension eval 30/60 tabs x 1x/4x; FIND.md.

## Commands (scratch = $TEMP/claude/.../scratchpad)
- heavy: python scratch/heavy.py "<label>" -- <cmd>
- node scratch/sonar-fast/eval-fast.cjs --tabs 30 --rate 4; bench2.cjs; quality2.cjs; index-bench.cjs
