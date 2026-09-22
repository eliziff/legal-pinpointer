# Pinpointer Lens and Event Strip

## Use the packaged applications

Unpack `legal-pinpointer-lens.zip`, load its root in Chrome's extension manager, open Tab Sonar, and choose **Lens**. The extension package includes Laya, its tokenizer and browser inference runtime. No separate model download, key, server or pre-existing browser cache is required.

Open `event-strip.html` directly from disk. Its model, tokenizer, document parsers, OCR worker and language data are embedded. Dependencies are downloaded when building, not when processing your documents.

## Lens

Enter one research question and choose **Open tabs**, **Local A2AJ**, or both. Options select the current tab, current group or all windows, and corpus language/date/dataset filters. Results contain source text and source addresses. Select a result to open its passage or use native Pinpointer quotation, pinpoint and citation actions where the page has detected structure.

There is no separate semantic distinction, evaluation button or per-result model status. Search starts the packaged model automatically. A failed inference stops the search rather than masquerading as successful keyword retrieval. Stop interrupts work and retains only already-ranked results.

**Tabs:** Laya evaluates every detected structural unit against the question; matching query words are not a prerequisite. Ordinary pages fall back to visible text blocks. Long units are evaluated in overlapping token windows without discarding their tails, while display and clipboard retain the original unit. The native Pinpointer bridge preserves paragraph/section targets, formatting settings, rich/plain clipboard and stale-source checks.

**Local A2AJ:** choose the complete directory or individual Parquet files. Nested files and English/French case-law, legislation and Hansard layouts are supported. The connector uses broad lexical candidate retrieval followed by Laya ranking; there is not yet a dense vector index. Semantic matches absent from the lexical candidate set can therefore be missed. Tabs do not have that restriction.

DuckDB reads selected files in place; an incremental IndexedDB inverted index persists in bounded transactions. Indexing resumes from completed batches, and unindexed tails remain searchable. There is no file-count, document-count or result-count product cap. UI pagination is not a retrieval cutoff. This is not a full-national-corpus throughput benchmark.

Directory handles persist when the browser permits it. Individual-file selections need reselection after restart. Removing a corpus file removes its postings. Browser navigation validates document identity and expected text; local corpus navigation validates file identity, Parquet row, language and exact offsets. Built-in browser PDF viewers are not scraped as HTML; Event Strip accepts original PDF files for extraction/OCR.

## Event Strip

Drop EML, PDF, DOCX or text files. Supported email attachments are recursively imported. Native PDF text is preferred; otherwise packaged Tesseract OCR is used. Word paragraph/table-cell and note references are retained, with explicit current/original tracked-revision views.

Chronology rows retain event-date occurrences, original wording, communication date, exact source sentence and assertion status. Missing years and ambiguous numeric dates are not guessed. Model choices distinguish completed reports, proposals, requests, denials and conditions. Human corrections survive rebuilding. Save/Open session retains original files and corrections; CSV and clipboard exports retain locators.

Unsupported inputs and processing failures are reported. These operations do not establish whether a statement is true or calculate legal deadlines.

## Model and runtime

The packaged model is `soyelmismo/laya-multilingual-onnx`. The release workflow pins revision `0966c4fa58da6878b39e7e14cb5e93313b82d828`; `build-info.json` records the revision and asset hashes. The worker follows Laya's published option-marker sequence and temperature scaling on ONNX Runtime Web WASM.

Initialization performs real two- and four-option inference before reporting success. Each run validates input/output tensor contracts and disposes tensors in a finally block. Search uses a binary relevant/not-relevant judgment for ranking, with no scores exposed in the main UI. Ranking values are not calibrated accuracy estimates. Overlong questions are rejected explicitly; passage ranking covers long text through token windows. Event Strip's typed decisions retain explicit context-budget errors.

## Build and verify

```sh
npm test
cd lens
npm install
npm test
LAYA_REVISION=0966c4fa58da6878b39e7e14cb5e93313b82d828 npm run build
node verify-runtime.mjs
python -m pip install pyarrow==21.0.0 pillow==11.3.0
python test/fixtures.py
npx playwright install --with-deps chromium
npm run acceptance
```

The workflow publishes downloadable packages only after actual WASM inference and installed-Chromium acceptance pass. `runtime-validation.json` records authored semantic smoke cases, not a comprehensive retrieval benchmark. `validation.json` records actual browser checks: the dataset families, bilingual row 230, semantic tab ordering, native pinpoint actions, stale-source protection, combined connectors, document intake, embedded OCR and Laya inference. External runtime requests and uncaught page errors fail the gate. The source-page fixture is synthetic CanLII-shaped HTML fulfilled locally by Playwright.

Application additions: MIT. Upstream libraries and model assets retain their own licenses and bundled notices.
