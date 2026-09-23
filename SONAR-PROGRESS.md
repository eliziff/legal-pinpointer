# Sonar ranked mode: progress (delete in final commit)
Done: find-core ranked()/fold/rankTerms/bm25; find-page termIndex+rankSearch+texts; broker global BM25 + SONAR_TEXTS;
panel rerank via rerank-worker.js (module worker, ORT 1.30 WASM, MiniLM int8, K=30, max 512); COI manifest keys;
tools/fetch-rerank-model.cjs (npm run fetch:rerank, sha256 pinned, vendor/ gitignored); extension test extended (passes).
Next: tests/rerank.test.cjs (tokenizer fixture + ranked unit tests); eval harness in scratchpad
(.../scratchpad/sonar-rank/) over pool A 30 tabs + 60-tab stress, headless, via heavy.py; FIND.md update.
Commands: npm test; PLAYWRIGHT_MODULE="C:/Users/elias/Desktop/MikeOSS Fork/node_modules/playwright" python <scratchpad>/heavy.py "x" -- node --test tests/extension-sonar.test.cjs
