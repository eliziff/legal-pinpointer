# Sonar ranked mode: progress (delete in final commit)
Done: find-core ranked()/fold/rankTerms/bm25; find-page termIndex+rankSearch+texts; broker global BM25 + SONAR_TEXTS;
panel rerank via rerank-worker.js (module worker, ORT 1.30 WASM, MiniLM int8, K=30, max 512); COI manifest keys;
tools/fetch-rerank-model.cjs (npm run fetch:rerank, sha256 pinned, vendor/ gitignored); extension test extended.
53b2fa6: ranked tabs now count as searched (was 0/30 in the status line); tests/rerank.test.cjs (5 unit tests, in npm test).
Next commit: ORT allow_spinning off; panel no longer warms the model at search start (loads after first results).
Finding (scratchpad sonar-rank/debug-extension.cjs): the earlier 18 s / 25-skipped warm searches were machine starvation
(heavy.py IDLE priority + ~80% CPU from others + available RAM falling to ~400 MB => paging), not a ranked-mode bug:
reranker off -> cold 3.4 s, warm ~350 ms, 30/30; a later run with it on -> warm 0.4-0.6 s first, 1.6-5 s reranked.
Eval harness: scratchpad sonar-rank/eval-extension.cjs [--tabs 30|60] (--ext dir; memory guard start 3.8 GB / abort 0.9 GB;
writes results-<tabs>.json incrementally; exact baseline = identical parse tree with explicit AND, not ranked).
2026-09-23: extension test now opens+copies every ranked row (green, 8.4 s); npm test 59/59.
Eval 30 attempt 05:12: true cold 3.4 s first / 6.0 s reranked, 30/30 tabs, worker 1.76 s/job (4 threads); then killed by
Claude Code's memory-pressure reaper in the warm pass (typeperf min available 1.34 GB). No results-30.json. Re-run only when asked.
Next: run eval 30 tabs (foreground), then 60 (only with enough free RAM), add tables to FIND.md ranked-mode section
(node tables.cjs results-30.json prints them), final commit deleting this file.
Commands: npm test; PLAYWRIGHT_MODULE="C:/Users/elias/Desktop/MikeOSS Fork/node_modules/playwright" python <scratchpad>/heavy.py "x" -- node --test tests/extension-sonar.test.cjs
Eval: python <scratchpad>/heavy.py "sonar eval 30" -- node <scratchpad>/sonar-rank/eval-extension.cjs --tabs 30
