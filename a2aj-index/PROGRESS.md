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

- s50 browser bench + UI check pass (file:// page, folder input, court/date filters, 390 px layout).
- Extra baselines on the 49 legal queries (bench/baselines.json): FTS5 12.5 GB keyword R@20 0.308, NL 0.655;
  A2AJ API keyword 0.462, NL 0.655.
- Tax head rule audited (`$SP/a2aj-index/tax-audit.mjs`): drops FCA 1478 + SCC 42; a 25-doc sample of the 252 without a
  tax word in the head are all appeals from the Tax Court (costs, EI insurability, procedure).
- v1 full build (format /1): 14.3 min, peak RSS 1.4 GB, 2.44 GB in 6 files (text-000 1.75 GB), 208,235 docs,
  9.57 M passages. Bench (bench/results/full.json): open 197 ms; cold p50/p95 phrase 113/1157, keyword 82/378,
  NL 145/503 ms; warm NL 116/354; peak 253 MB. Quality: bench:nl R@20 0.697 / MRR 0.467 (FTS5 0.727 / 0.583),
  legal keyword 0.231 / 0.019, legal NL 0.655 / 0.333. Diagnosis (scratch/diag.mjs): lower-court passages restating a
  doctrine outrank the leading case; keyword queries name the case ("Jordan", "Oakes", "Ward").
- v2 (format /2): title field (style of cause + citations -> doc postings) and cited-by counts (citations in the text
  mapped through A2AJ citation_lookup keys) at build; engine ranks documents = best passage + QMAX * (title * sum title
  idf + authority * log10(1 + cited-by)); page shows one card per document with up to 2 passages.

## Next
1. s50 v2 (8 MB shards to exercise multi-file reads): arms via bench/quality.mjs, bench, UI check.
2. Full v2 build; arms {title 0/1} x {authority 0/0.5/1}; pick the default by both query sets; full cold+warm bench.
3. Work-laptop steps; final report tables (bench/tables.mjs).

## Work-laptop steps (no installs)
1. Get the files into one folder, e.g. `Documents\A2AJ`: `a2aj-search.html` plus every index file
   (`manifest.json`, `meta.bin`, `dict.bin`, `docs.bin`, `post-*.bin`, `text-*.bin`), about 2.5 GB. From a GitHub
   release: download every asset (each is under 2 GB). From a USB drive or OneDrive: copy the folder. Keep the file
   names exactly as they are (a browser that saves `text-000 (1).bin` breaks the set).
2. Double-click `a2aj-search.html`. If Windows opens something else: right-click > Open with > Microsoft Edge (or Chrome).
3. Click **Open index folder…**, choose the folder, and accept the browser's prompt ("View files" / "Upload"): the
   files are read in place on this computer and nothing is sent anywhere.
4. The status line shows about 208,000 documents and the open time. Search with plain words, a case name
   ("Jordan delay ceiling"), a question, or "exact phrases" in quotes; narrow with the court list and the dates.
   The citation links open the source A2AJ records (the court's own decision page, or the statute's official site) in a new tab.
5. Each time the page is reopened, pick the folder again (browsers do not keep file access for local pages).
6. To update, replace the whole folder with a newer build; if a file is missing or truncated the page names it.

Publishing a build (on the build machine): `node build/build-page.mjs`, then attach `dist/a2aj-search.html` and every
file of the index folder to a release, e.g. `gh release create a2aj-YYYY-MM-DD dist/a2aj-search.html <index>/*`.

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
