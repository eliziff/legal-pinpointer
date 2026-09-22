# Pinpointer Lens and Event Strip

Two local tools, not a hosted legal assistant.

## Use the packaged downloads

**Extension:** unpack `legal-pinpointer-lens.zip`, open Chrome's extension management page, enable Developer mode, and choose **Load unpacked** on the folder containing `manifest.json`. Open **Lens** from Tab Sonar. Enter a research question, choose **Open tabs**, **Local A2AJ**, or both, and search. Laya is bundled and runs automatically. Existing Pinpointer and Tab Sonar shortcuts remain available.

**Local A2AJ:** unpack the complete case-law, legislation and Hansard snapshots into one parent folder. In Lens choose **Local A2AJ → A2AJ files → Choose folder**. All nested Parquet files are registered; no file, document, row or corpus-size product cutoff is imposed. **Build / resume index** prepares the reusable local vector index. Searching also indexes unbuilt tails. **Find more** advances the candidate page, not corpus coverage. Original files remain authoritative and are read locally through DuckDB-WASM.

**Event Strip:** open `event-strip.html` directly from disk in Chrome or Edge. Drop EML, PDF and DOCX files. Attachments are included; PDF pages without native text can use bundled OCR. Classification starts automatically. An optional focus narrows the displayed chronology; **All entries** preserves access to other rows. Select a row to inspect the original passage or page, resolve a date, correct its status, or add a separate note. Export CSV, copy the table, or save a session ZIP containing originals and corrections. No assembler, API key, server, CDN, model download or online first run is required.

## Search and copying

Tabs use Pinpointer's native detected paragraphs, provisions, pages and exact source handles. Ordinary sites fall back to visible text blocks, without inventing legal locators. Every eligible tab unit enters Laya independently; lexical overlap is not required. Long passages are covered by overlapping token windows.

A2AJ has a separate persistent semantic index using the actual trained multilingual Model2Vec checkpoint. Every registered vector block is examined for each query. Laya judges the retrieved source passages. Exact Boolean retrieval is an explicit alternative under **Options**, not an undisclosed fallback after model failure.

Open a result to expose copying controls: passage plus source, quotation, pinpoint, citation, or link only; whole passage or matching sentence; native pinpoint or text-fragment link; existing Pinpointer wording settings. Native results call the existing quotation/citation formatter rather than approximating it in the search UI. Original text and browser document identity are checked again before opening or copying. Formatting is preserved in rich clipboard output, with plain text alongside it.

## Chronology semantics

Event date and communication date are separate. Repeated date strings preserve occurrence identity. Missing years, ambiguous day/month order, undated material and quoted older messages do not silently acquire invented dates. Normalization and sorting are deterministic.

Laya supplies a bounded four-way action-status judgment. Explicit condition/request/negation grammar guards prevent a stated condition or denial becoming a completed event. The original model choice, probability distribution, selected clause offsets and guard basis remain in the saved session, not cluttering the UI. Attribution is separate: a reported completed action is still a source assertion, not a finding of fact. Weak or conflicting judgments remain reviewable. Human corrections are not overwritten on rebuild.

## Reproduce the release

From `lens/`: install npm dependencies, install Python `numpy`, `safetensors` and `tokenizers`, and run `npm run build`. Build-time downloads are pinned and checked. Runtime code and weights are packaged locally. `prepare-embeddings.py` converts the pinned original matrix, checks quantization fidelity, and supplies independent numerical fixtures. No model training is required.

The package workflow runs existing Pinpointer regressions, numerical embedding parity, actual Laya inference, and installed-Chromium acceptance before publishing ZIP/HTML downloads. It tests EML/PDF/DOCX, OCR, date separation, real semantic ordering, native rich copying, stale-document rejection, both connectors, cancellation, session restore and external-request absence.

See `SEARCH.md` for the concrete Jev search projects used as precedents and the distinction between tested integration and broad model accuracy. Fixture performance does not establish national-corpus throughput or legal-search completeness. Downloaded A2AJ originals have separate source manifests and byte-level integrity records.
