# Local research tools

## Event Strip 0.4 — general-purpose chronology

Download `event-strip.html` from an **Event Strip 0.4.0 — general chronology** experimental release. Open the HTML directly in Chrome or Edge. It includes Laya, its tokenizer and WASM runtime, document parsers, PDF rendering and OCR; no server, API key, assembler, runtime download or online first run is needed.

**Add documents → Make chronology → Date / Event / Sources.** Leave Focus blank for a general chronology. EML, PDF and DOCX are supported, including supported nested email attachments, native PDF text, scanned-PDF OCR and current/original Word revision views. Adding documents parses them; pressing Make chronology discovers events. There is no action-status taxonomy or classification column.

The event—not a date occurrence—is the primitive. Laya distinguishes specific happenings from background text, separates distinct milestones in a sentence, associates ambiguous date candidates and matches repeated mentions. Deterministic code preserves exact source spans, handles unambiguous temporal adjuncts and date normalization, checks explicit conflicting dates/numbers, and sorts the result. A hospital stay can be one interval; an undated equipment failure can be an event; several dates in a sentence do not automatically create several rows.

Descriptions initially use selected source wording, not generated prose. Select an entry to read every original supporting passage or page and edit the description, date, interval or note. Combined mentions retain their individual source addresses. **Separate mentions** undoes a grouping without discarding evidence; subsequent builds retain that choice. Removed entries remain recoverable. Manually added entries are labelled as such.

Focus is optional and changes the view of the reusable event catalogue. **All events** restores the complete catalogue. Unchanged source discovery and pair judgments are reused; reviewed descriptions and dates are not rewritten on rebuild. **Date uncertain** and **To review** provide focused correction views. **Files → Review omitted passages** exposes rejected candidates for inclusion, rather than silently throwing them away.

**Save & export** contains CSV export, rich/plain table copying and session save/open. Sessions include original files, grouped mentions, edits and cached extraction. Original quotation offsets are rechecked on restore. The older date/status session format can be imported without preserving its discarded status taxonomy.

### Build and validation

The dedicated `.github/workflows/event-strip.yml` workflow builds and publishes this product independently of the extension. It retrieves the pinned Release 13 runtime archive, verifies its SHA-256 and model hash, bundles the current source with `node lens/event-build.mjs`, and gates publication on actual model and direct-file browser checks.

`lens/test/chronology-runtime.mjs` exercises the real Laya checkpoint on general event discovery, split milestones, intervals, ambiguous/missing dates, French, duplicate mentions and distinct/conflicting events. `chronology-browser.mjs` drives the built file:// HTML through EML/PDF/DOCX/OCR import, optional focus, editing/rebuild, grouping/separation, session round-trip, CSV export and cancellation. It records HTTP(S) requests and uncaught errors. `chronology.test.mjs` independently tests source/edit integrity and literal constraints against an intentionally erroneous model response.

These are authored development and integration checks, not a calibrated guarantee of complete event extraction or error-free matching. Source inspection and corrections remain part of the product.

## Pinpointer Lens

Pinpointer Lens remains the separate extension in this repository. Open tabs and Local A2AJ are independent connectors; local corpus files, native source handles and pinpoint/copy formatting remain its responsibilities. See `SEARCH.md` for its search architecture and concrete Jev search precedents.

**The general-chronology release updates Event Strip only. It does not establish a fix for the separately reported Tab Sonar/Lens search regression.** Extension release and validation records must be considered separately.
