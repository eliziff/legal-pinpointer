# Pinpointer Lens and Event Strip

Two local tools, one small source-addressed decision layer. This is a preview, not a model-quality certification.

## Use the packaged artifacts

- Unpack `legal-pinpointer-lens.zip`, load its root in Chrome's extension manager, open Tab Sonar, and choose **Lens**.
- Open `event-strip.html` directly from disk. The model, tokenizer, inference engine, document parsers, OCR worker and language data are embedded. No server, key, CDN, model download, or prior browser cache is required at runtime.

The extension build contains the existing Pinpointer functionality unchanged, plus Lens. Build dependencies and model downloads are development-time only. Merely downloading the source repository is not a substitute for the packaged release.

## Lens

Search open tabs/current tab group or import PDF, DOCX and EML documents. Use exact words, quoted phrases, prefixes, AND/OR/NOT, then supply a semantic distinction. Results preserve source text; judgments add a score and can sort by fit. Blank Find sweeps all passages. The model never deletes the raw results.

Choose the complete A2AJ directory. Every nested Parquet file is registered. Case-law, legislation and Hansard column layouts are recognized, including English and French text. There is no document-count, file-count, corpus-size or result-count product cap. DuckDB reads selected files in place; an incremental IndexedDB inverted index persists in bounded transactions. Interrupted indexing resumes from completed batches. Searches include unindexed tails, so an incomplete index does not silently narrow scope. The UI pages results; it does not truncate them. File failures and schema mismatches are visible.

Directory handles are persisted when the browser permits it. Reauthorize/reselect the directory after a restart when requested. Individual-file selections need reselection after restart. Indexes and corpus result excerpts are extension-local data; Clear removes the active search results, while removing a corpus file removes its postings. Existing Tab Sonar's RAM-only query behavior is unchanged.

Exact browser navigation validates document ID, revision and original text. Local corpus navigation validates file identity, Parquet row, language and exact text offsets. The built-in Chrome PDF viewer cannot be scraped as HTML: import the original PDF for native extraction/OCR instead.

## Event Strip

Drop `.eml`, `.pdf`, `.docx` or text files. Supported email attachments are recursively imported. Native PDF text is used first; pages without usable text use packaged Tesseract OCR. This build does not claim to contain the separate Legal Browser OCR legal-domain model. Word paragraph/table-cell and note references are preserved; tracked revisions have explicit current/original views.

The chronology retains event-date occurrences, original date wording, communication date, exact sentence, source and assertion status. It does not infer missing years or choose between ambiguous numeric dates. Model choices distinguish completed reports, proposals, requests, denials and conditions. Human corrections are preserved across rebuilding. Source text is not generated or rewritten. Use the unresolved view and source preview before relying on an entry. Save/Open session retains original input files and corrections; CSV and clipboard exports keep source locators.

Encrypted email, unreadable pages, unsupported attachments and model context errors are reported, not silently treated as absent. These adapters do not establish whether a statement is true, calculate legal deadlines, or certify source authenticity.

## Model and runtime

The packaged graph is `soyelmismo/laya-multilingual-onnx`, a selective INT8 export of Apache-2.0 Laya. `build-info.json` records the resolved revision and downloaded SHA-256 values. `LAYA_REVISION` can pin a repeat build. The browser worker implements the published option-marker sequence and temperatures with ONNX Runtime Web. It performs actual model inference; there is no keyword-based stand-in, remote fallback or generated JSON parser. Context overflow remains an explicit unresolved result. The baseline is single-threaded WASM, including direct `file://` use; browser latency is measured by the acceptance runner, not inferred from a native GPU benchmark.

## Build and verify

```sh
cd lens
npm install
npm test
npm run build
python -m pip install pyarrow==21.0.0
python test/fixtures.py
npx playwright install --with-deps chromium
npm run acceptance
```

The preview workflow builds both deliverables and publishes them only after its browser acceptance gate passes. `validation.json` lists the checks actually executed. Core tests cover query semantics, exact offsets, date ambiguity and spreadsheet-safe escaping. The browser fixture includes all registered dataset families and a match beyond row 230; it is not a throughput measurement on the full national corpus.

Application additions: MIT. Upstream libraries and model assets retain their own licenses; bundled notices are available inside the HTML.
