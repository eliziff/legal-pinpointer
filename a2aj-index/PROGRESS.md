# A2AJ offline search: progress

Goal: a packaged local search over A2AJ (English; scope in `build/datasets.json`) that runs from one self-contained
`dist/a2aj-search.html` opened in Chrome/Edge from file://, over index files the user copies (each <= 2 GB).

Heavy commands go through the shared serial lock (`SP` = the session scratchpad,
`C:/Users/elias/AppData/Local/Temp/claude/C--Users-elias-Desktop-MikeOSS-Fork/1f20d775-c0b0-4f05-b9bf-1a656c0b4e6c/scratchpad`):
`python $SP/heavy.py "<label>" -- <cmd...>`. One headless browser at a time.

## Done
- WIP committed as-is (1b3f279): builder, engine, page, worker, bench.
- Baselines recomputed on the 33 in-scope P-queries (6 targets are OHSTC/TCC/SST, excluded by scope):
  FTS5 12.5 GB doc R@20 0.727 / MRR 0.583 (0.641 / 0.519 on all 39); A2AJ API 0.606 / 0.338 (0.538 on 39).
  Script: `$SP/a2aj-index/baseline-inscope.py`.
- Coordinate oracle: all 39 P-query passage offsets equal the exact SQLite `unofficial_text_en` slices.
- Legal query targets (L01-L49) checked against the DB: each id is the intended leading case or statute.
- Cold-disk protocol verified: a `robocopy /J` copy reads at ~124 us per random 4 KB read (cold) vs ~11 us for a
  buffered copy; `bench.mjs --cold-copy <tmp>` uses it.
- Fixes: eval targets now come from `bench/queries.json` (all case targets, not only P); folder picker falls back to
  the folder input when `showDirectoryPicker` is blocked.

## Next
1. s50 sample rebuild + headless bench (validates the browser path end to end).
2. Full build into `$SP/a2aj-index/full` (expect ~2.5-3 GB, 1-2 h at idle priority).
3. Full bench: cold (`--cold-copy`) + warm; quality vs baselines; memory.
4. Page check in headless Chromium (screenshot); work-laptop steps; final report tables.

## Commands
```
cd a2aj-index
# sample (every 50th document + all eval targets)
python $SP/heavy.py "a2aj s50 build" -- node --max-old-space-size=3500 build/build-index.mjs --out $SP/a2aj-index/s50 --sample 50 --eval-docs bench/queries.json --eval-out $SP/a2aj-index/s50-eval.json
python $SP/heavy.py "a2aj s50 bench" -- node bench/bench.mjs --index $SP/a2aj-index/s50 --eval $SP/a2aj-index/s50-eval.json --tag s50
# full
python $SP/heavy.py "a2aj full build" -- node --max-old-space-size=3500 build/build-index.mjs --out $SP/a2aj-index/full --eval-docs bench/queries.json --eval-out $SP/a2aj-index/full-eval.json
python $SP/heavy.py "a2aj full bench" -- node bench/bench.mjs --index $SP/a2aj-index/full --eval $SP/a2aj-index/full-eval.json --tag full --cold-copy $SP/a2aj-index/full-cold
node build/build-page.mjs   # rebuilds dist/a2aj-search.html
```
