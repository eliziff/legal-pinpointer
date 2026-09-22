# Local semantic search

## Specific Jev precedents

This is based on actual Jev applications, not a claim that generic LLM ranking results establish Laya's quality:

- `hev/reranker`, commit `1eb47266270b32b2a3667f9fb89646378ca9c9d6`: a Noul question tests whether each candidate answers or directly addresses the query, rather than merely sharing its topic. See `hev_rerank/prompt.yaml` and `hev_rerank/rerank.py` (Apache-2.0).
- `uehaj/jev-semgrep` and `larguesa/jev-search`: semantic matching on actual source lines/spans without a mandatory literal-word match.
- `kylemclaren/jevsearch` and `hotchpotch/jev-reranker`: ordinary retrieval plumbing combined with typed Jev relevance decisions and original-source results.

The browser implementation uses released Laya weights locally; none of these projects' hosted Jev APIs are called. Jev's ability to share a state across independent questions is **not** assumed for Laya: each Laya question is jointly encoded with its bounded text.

A proposed setwise Choice heap was tested with the actual Laya checkpoint and rejected: candidate-order changes could promote an unrelated rent clause. It is not the production ranker. `ranking.mjs` instead uses direct, independently evaluated relevance and exact source offsets.

## Connectors

Tabs: native Pinpointer paragraphs/provisions, otherwise visible text blocks. All eligible structural units enter Laya; keyword overlap is not required. Long units use the runtime's overlapping token windows. Original full units remain the display/copy authority.

A2AJ: every selected Parquet file is registered, including nested folders, English/French case law, legislation and Hansard. The original files remain authoritative. Model2Vec's multilingual token embeddings provide persistent passage vectors; each search scans all registered vector blocks, including indexing any unbuilt tail. The first candidate page is bounded, not corpus scope. Laya ranks these original-text candidates. Find more retrieves additional candidates, excluding already inspected IDs. Exact Boolean search remains an explicit alternative under Options.

The dense index's checkpoint and vector blocks commit in one IndexedDB transaction. An embedding/parser fingerprint invalidates incompatible indexes. File identity and exact source text are checked again before copying. Scope filters do not remove corpus files from registration.

## Packaging and checks

`npm run build` assembles the extension and single Event Strip HTML with pinned Laya, tokenizer, ONNX WASM, PDF.js and OCR assets. The extension additionally carries the signed Parquet extension, original legal-structure parser and quantized multilingual embeddings. `prepare-embeddings.py` reproduces the int8 lookup table from the pinned original matrix and checks its fidelity. `test/embeddings-runtime.mjs` compares actual JavaScript output to independent tokenizer/vector fixtures.

`verify-runtime.mjs` executes actual Laya, including multilingual and long-tail examples. `test/browser.mjs` runs installed Chromium integration, rich copying, original-source jumps, independent/combined connectors, cancellation, file:// chronology, automatic model classification, multi-format intake, OCR, session restore, and zero external requests.

These are integration and authored relevance checks, not a full legal-search benchmark or a measured national-corpus throughput claim.
