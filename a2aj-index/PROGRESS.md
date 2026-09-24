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

## Final v2 (2026-09-23): ranking default {title: 0, authority: 1}

Grid (12 arms, full index): any title weight hurt both query sets; cited-by authority helped both. Chosen: title 0, authority 1 (best bench:nl R@20 and best legal:nl R@20/MRR). Grid output: `$SP/a2aj-index/grid.json`.

## Package: 2.44 GB in 5 files (largest 1.75 GB), 208,235 documents, 9,567,821 passages, 779,229 terms; build 15 min

| file | bytes |
| --- | ---: |
| meta.bin | 1,722,470 |
| dict.bin | 12,266,995 |
| docs.bin | 5,757,176 |
| text-000.bin | 1,750,629,688 |
| post-000.bin | 673,571,805 |

### Per dataset (text store + postings attributed by passage, docs metadata by document)

| dataset | docs | passages | raw text MB | package MB |
| --- | ---: | ---: | ---: | ---: |
| BCCA | 14,638 | 605,373 | 373 | 165 |
| BCSC | 52,085 | 3,092,363 | 1806 | 824 |
| CHRT | 1,164 | 72,316 | 45 | 19 |
| CMAC | 154 | 7,511 | 4 | 2 |
| CT | 629 | 19,926 | 12 | 5 |
| FC | 35,426 | 1,350,325 | 819 | 364 |
| FCA | 6,272 | 195,323 | 117 | 52 |
| NSCA | 4,739 | 205,621 | 122 | 55 |
| NSFC | 323 | 20,642 | 12 | 5 |
| NSPC | 1,610 | 95,467 | 58 | 27 |
| NSSC | 9,219 | 539,224 | 315 | 145 |
| NSSM | 1,658 | 45,368 | 26 | 12 |
| ONCA | 23,883 | 592,269 | 364 | 161 |
| RAD | 14,156 | 519,526 | 313 | 127 |
| RLLR | 927 | 19,095 | 12 | 5 |
| RPD | 6,729 | 223,544 | 141 | 61 |
| SCC | 10,785 | 622,243 | 426 | 188 |
| SCT | 44 | 11,144 | 7 | 3 |
| YKCA | 271 | 13,329 | 8 | 4 |
| LEGISLATION (all jurisdictions) | 6,163 | 672,327 | 304 | 105 |
| REGULATIONS (all jurisdictions) | 17,360 | 644,885 | 281 | 98 |
| **total** | 208,235 | 9,567,821 | 5566 | 2444 |

Excluded by rule: appeals from the Tax Court of Canada (tax matters): 1520 documents

## Latency (headless Chromium, file:// page, ms per query incl. passage text + metadata for 20 results)

Folder open: 175 ms wall (file list + manifest + meta), worker open 73.4 ms. Pass 1 = cold disk (unbuffered copy) + fresh browser; pass 2 = warm.

| type | n | cold p50 | cold p95 | warm p50 | warm p95 | MB read p50 / p95 (cold) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| phrase | 17 | 138 | 1102 | 240 | 1488 | 1.3 / 7.9 |
| keyword | 15 | 162 | 472 | 155 | 1242 | 1.2 / 7.0 |
| nl | 68 | 272 | 1199 | 317 | 1346 | 3.5 / 7.3 |

Memory: peak working set 249 MB largest Chromium process, 391 MB all Chromium processes.

## Quality vs baselines

| query set | n | this: doc R@20 | MRR | passage R@10 | FTS5 12.5 GB: R@20 / MRR | FTS5 p50 ms | A2AJ API: R@20 / MRR | API p50 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bench:nl | 33 | 0.788 | 0.454 | 0.303 | 0.727 / 0.583 | 2275 | 0.606 / 0.338 | 1892 |
| legal:keyword | 13 | 0.538 | 0.338 | - | 0.308 / 0.076 | 389 | 0.462 / 0.133 | 3242 |
| legal:nl | 29 | 0.828 | 0.613 | - | 0.655 / 0.335 | 986 | 0.655 / 0.384 | 2172 |
| legal:phrase | 2 | 1.000 | 0.625 | - | 1.000 / 0.538 | 1575 | 1.000 / 1.000 | 3115 |

- bench:nl = the 39 paraphrase queries of search-bench minus 6 whose target is in an excluded dataset (OHSTC x3, TCC x2, SST); on all 39 the FTS5 baseline is R@20 0.641 / MRR 0.519 and the API 0.538 / 0.312 (search-bench/report.md). FTS5 and API rank whole documents over the full 225k-case corpus.
- search-bench K-queries (12 exact phrases): FTS5 phrase p50 179 ms / p95 240 ms (cases DB).
- legal:* = 49 legal-research queries (L01-L49 in bench/queries.json); targets are the leading case or statute. FTS5 and API rows: search-bench/src/ftslegal.mjs and api-legal.py (run 2026-09-23; FTS5 keyword/nl as OR of terms, phrases quoted; statute targets scored against the laws DB / doc_type=laws).

UI check on the full index passed (file:// page, court/date filters, no errors); screenshots in `$SP/a2aj-index/shots-v2`.
