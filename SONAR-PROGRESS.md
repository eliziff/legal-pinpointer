# Tab Sonar speed work (in progress; delete when done)

Goal: warm first results < 50 ms, reranked < 500 ms at 4x; R@10 >= ~0.80; memory low (panel,
workers, tab pages) and reported everywhere.

## Done (commit 160ebed, 269ea28)
- In-panel index worker `sonar-index.js` (UTF-8 text, compact postings, hash-keyed word forms,
  incremental BM25 over tabs in scope). Broker: SONAR_UNITS (read tab text, registry per
  workspace), SONAR_ISSUE (ranked handles = tab, document, unit, text hash). Page: `units()`
  (drops its own index after reading), ranked handles revalidated by unit text hash on
  preview/jump/copy. Panel reads tabs in idle time, origin first; tab events and
  SONAR_INVALIDATED re-read one tab. Rerank worker: one batched session.run, progressive
  (8, then rest), score cache, idle release after 3 min.
- Offline quality (n=38, scratch sonar-fast/quality.json): K=30 needed for R@10;
  L6 whole .836, L4 256/whole .839, L2 whole .813, tiny 192 .789; K20 <= .786.
- bench2.json (19:58-20:03) is NOT trustworthy at 4x for the early columns: the PowerShell
  throttler compiles Add-Type for ~1-2 s after launch, so tiny:wasm:4 at "4x" (b30 126 ms, spin
  unchanged) ran unthrottled. 1x numbers are fine: WASM int8 b30 (192 tok) tiny 131, L2 595,
  L4 854, L6 1298 ms; WebGPU fp16 b30 tiny 49, L2 189, L4 366, L6 557 ms. WebGPU renderer
  private 420-557 MB vs WASM 190-277 MB (needs an idle baseline; bench3 has one).
- Machine: i3-1315U (6C/8T), Intel UHD (gen-12lp) WebGPU with shader-f16, 12 GB, loaded.

## In progress (second agent, 2026-09-23 20:30)
- slow-process.ps1 now writes <stop>.started once throttling; bench3.cjs waits for it and
  checks a worker spin loop slowed >= 2.5x (field `throttled`).
- quality3.cjs: candidates from the product's own index.search (windows as shipped), scores
  cached in scores3/, report = K 20/30/40/50 x (ce, rrf, rank-z fusion).
- quality3 DONE (quality3.json / quality3.report.txt), through the product's index, R@10/MRR
  n=38: bm25 .698/.503; L6 620ch/192tok K30 .836/.724 (= whole paragraph .836/.685); L4 620/192
  K30 .813/.714 (K50 .839); L2 620/192 K30 .784 (whole .813); tiny 620/192 K30 .763 (whole .737).
  Fusions (RRF, rank-z) do not help reliably (noise, lower MRR). K40/K50 add nothing for L6.
  So: L6 at 620/192 K30 is the quality pick; tiny cannot reach .80. The fp16-on-node-CPU run was
  killed (3.2 GB RSS); check fp16 quality in the extension run instead.
- bench3.cjs (running): fresh browser per spec, product candidates, bucketed batches (sort by
  length), WASM int8/fp32/quantized, WebGPU fp16 asyncify vs jspi builds, memory idle/loaded/peak.
  First row, tiny WASM int8 4 threads: 4x b30 516 ms, 3 length buckets 457 ms; renderer private
  idle 45 -> loaded 204 -> after runs 234 MB, peak 409 MB (ORT runtime, not the 4.5 MB model).
- tiny fp32/quantized/uint8 and L2 fp32/quantized downloaded to models/ (pinned Xenova revs).
- rerank-core.js words(): whole-text regex passes instead of per-character tests; 30 pairs
  cold 55 -> 17 ms (node), identical ids on 5,024 texts (tokbench2.cjs); unit tests pass. UNCOMMITTED.
- bench3 DONE (bench3.json; renderer MB over idle: loaded/after/peak; 30 pairs, 192 tok,
  3 length-sorted runs "b30s3"): WebGPU fp16 jspi: L4 1x 365 / 4x 345 ms, +304/+229/+470 MB;
  L6 522/575 ms (over budget even at 1x: GPU-bound on UHD); asyncify build same speed but
  +402/+257/+606 MB -> jspi. WASM int8 4 threads: tiny plain 101/457 ms, tiny jspi 92/241 ms
  (+171/+182/+296 MB); L2 542/1599; L6 (what shipped) 1477/4062 ms, +237/+445/+742 MB.
  Progressive 8-then-22 costs more in total than one pass -> dropped.
- DECISION (implemented, uncommitted): runtime = ORT 1.30 JSPI build only (WebGPU + WASM EPs;
  needs Chrome 137+, else no rerank = BM25 order); GPU with shader-f16 -> MiniLM-L4 fp16
  (model-gpu.onnx), else TinyBERT-L2 int8 on WASM (model-cpu.onnx); K=30, 620 chars, 192 tok,
  one reorder. Files: rerank-worker.js, sonar.js (RERANK_DEPTH 30, no RERANK_FIRST/partial),
  tools/fetch-rerank-model.cjs (new pins, deletes stale vendor files; vendor refetched),
  extension test checks model-cpu.onnx. npm test + test:extension pass (21:01).
- eval-fast.cjs: waits for the throttler (.started), logs device, reports GPU process and
  peak memory per process group. Running 30 tabs 1x (fast-30-x1.json, eval-30-x1.log).

- worker-eval.cjs: the shipped rerank-worker.js + vendor in headless Chromium, 38 queries,
  product top 30. WebGPU L4: R@10 .809 MRR .711; 1x p50 361 / p95 493 ms, 4x p50 406 /
  p95 477 ms; first query 468 ms (shader warm-up at load, added); renderer +316 MB loaded,
  +241-257 after; GPU process +148 loaded, +176 after. WASM tiny: R@10 .737 MRR .585; 1x p50
  103 / p95 125, 4x p50 440 / p95 755 ms; renderer +195 loaded, +147-161 after. Worker now
  uses 1 WASM thread on the GPU path (saves ~30 MB).
- eval-fast.cjs fixes: panel found on a fresh CDP connection (the old lookup never saw it),
  --tabs < 30 honored, async memory sampler (samples.max), --abort-mb, --processes.
  12-tab 1x run: cold first results 59 ms; after read extension 302 MB (rerank worker 148,
  index 13 MB heap), peak 640; then aborted (machine < 600 MB free: another agent's paint gate
  holds 2.3 GB). index-bench (node, 30 tabs, depth 30): search p50 5.7 / p95 11.9 ms.
- FIND.md mechanism text, vendor and caps paragraphs rewritten; measurement table pending.
  THIRD_PARTY_NOTICES.md updated. All of this is staged, not committed.

## Next
- eval-fast 30 tabs at 1x and 4x once > 3.3 GB free; fill the FIND.md table (replace the
  L6 table and its paragraph), fold these notes in, delete this file; npm test +
  test:extension; commit; push; ff codex/pinpointer-lens-event-strip.

## Commands (scratch = $TEMP/claude/.../scratchpad)
- heavy: python scratch/heavy.py "<label>" -- <cmd>
- node scratch/sonar-fast/quality3.cjs score <specs> ; quality3.cjs report > quality3.json
- node scratch/sonar-fast/bench3.cjs "<specs>" > bench3.json
- node scratch/sonar-fast/eval-fast.cjs --tabs 30 --rate 4; index-bench.cjs
