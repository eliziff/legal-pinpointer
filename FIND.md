# Tab Sonar: persistent proximity search

Tab Sonar now opens in Chrome's **native side panel**, not a floating document
modal. The query, virtualized result list, and passage preview remain visible
when a source tab is activated. Chrome 116 or newer is required. Existing
citation-copying shortcuts and output formats are unchanged.

## Controls

| Control | Action |
| --- | --- |
| Ctrl+Shift+S | Open/focus Open tabs search. macOS uses Control, not Command. |
| Tab | Cycle /p (same paragraph) and /s (same sentence). |
| Shift+Tab | Cycle Current tab, All tabs, Current tab group. |
| Enter / Shift+Enter in the query | Preview next/previous passage. |
| Ctrl+Enter or click a result | Open the exact matching passage in its source tab. |
| Alt+wheel; release Alt | Preview passages, then open the displayed result. |
| Back to start | Restore the source scroll position and return to the originating tab. |
| Copy quote / Ctrl+Shift+X | Copy the selected passage as Pinpointer's quotation: the linked paragraph or provision marker and the text. Unnumbered text and other sites copy `[Link]: text` with a link to the passage. |
| Copy pinpoint / Ctrl+X | Copy the pinpoint (for example `at para 12`) linked to the paragraph, as the in-page shortcut does. Ctrl+X on a selection in the query still cuts. |
| Copy link | Copy a text-fragment link that opens the page scrolled to and highlighting the passage. |
| Alt+X | Copy the document's citation. |
| Use active tab | Explicitly change the origin of Current tab/group search. |
| Refresh | Re-read tabs/group membership and rebuild the source text index. |
| Clear | Clear the current route's query; in Open tabs, release its shared search session. |
| F6 / Shift+F6 | Move among controls because Tab and Shift+Tab control proximity/scope. |
| Alt+Shift+C | Open CanLII document-text search from any browser tab, including blank/new tabs. |

With focus on the result list, arrows, PageUp/PageDown, Home and End preview
results; Enter opens one. In Current tab scope, preview also highlights/scrolls
the source **without activating it or stealing query focus**. Multi-tab preview
does not activate any source until a click, Ctrl+Enter, or Alt release.

Escape clears the active route and closes the native side panel where Chrome's
close API is available; older supported Chrome versions can use its native X.
The popup provides both search buttons and reports unassigned shortcut bindings.
Chrome or another extension may claim a shortcut: assign it at
`chrome://extensions/shortcuts`. The extension does not override the new-tab page.

## CanLII document-text search, including from new tabs

Alt+Shift+C is a **chrome.commands** command handled by the service worker. The
handler opens the native panel synchronously in the keyboard gesture, before
awaiting storage, tab lookup, or page access. It never injects into the originating
page. Blank tabs, `chrome://newtab/`, and other browser-owned pages therefore need
no document script to launch this form. The same approach opens Open tabs search
from restricted pages; their contents remain unsearchable and are reported as such.

Type a query and press Enter or Search CanLII. A **new tab** opens at CanLII's
`/en/#search/text=...` URL with the complete query encoded as the text parameter.
The starting tab is not navigated/replaced. Typing alone sends nothing. This is
CanLII document-text search, not title/citation lookup and not a search of open
tabs. The two routes retain separate drafts while this workspace is open.

The submitted query is deliberately sent to CanLII and may become part of normal
browser history. Local Open tabs queries and excerpts are not sent to CanLII.
No selected document text is automatically placed into the remote query.

## Stable results and cross-window navigation

The header, status, list viewport, and preview occupy fixed grid regions. Long
text scrolls inside its region; loading, errors, empty results, proximity/scope
changes and skipped-tab details do not expand/collapse the panel. There are no
animated height transitions. Results have fixed 132-pixel rows and mount only
the viewport plus three overscan rows on either side. Scroll/resize redraws are
coalesced through animation frames. Result text is escaped into DOM text/mark
nodes, never injected as source HTML. Dark and forced-color modes are supported.

Copying runs in the source tab with Pinpointer's own formatting code and the
pinpoint wording option from the popup. The copied passage is the whole matching
paragraph (or sentence in /s mode), rechecked against the page before copying.

Every result carries the source's title, observed pinpoint where available,
excerpt and highlighted matches. A click uses an issued result handle, exact
Chrome document ID, URL and current group/window checks, then revalidates the
source ranges. Changed or unavailable passages require Refresh rather than an
approximate jump. Existing renderer indexes and highlight reuse remain intact.

Current tab and Current tab group stay pinned to the originating tab while
visiting results. All tabs includes other windows without mixing normal and
incognito contexts. A source in another window opens that window's native panel
**within the original click/key gesture** and hands off the query, result list,
selection and list scroll. No source tab is moved or regrouped. A window whose
shared search has been changed or cleared elsewhere shows a refresh notice.

## Query language

**Plain words rank by relevance.** In /p, a query of plain words (no quotes,
parentheses, `*`, `/p`, `/s` or upper-case AND/OR/NOT) finds paragraphs across
the searched tabs that share its words and lists them best first, not in page
order: `whether an employer must accommodate to the point of undue hardship`.
Lower-case and/or/not are ordinary words here. The status line reads
"N matching paragraphs, best first"; there are no scores or badges.

- The side panel reads each searchable tab's paragraphs once, in idle time after
  it opens (the starting tab first), into an index in a worker of its own:
  UTF-8 text and compact postings. A tab is read again only when it navigates,
  finishes loading or its text changes. Plain-word queries never touch the tabs.
- First pass, shown at once: Okapi BM25 (k1 1.2, b 0.75) over paragraphs, with
  unit counts, lengths and document frequencies summed over every searched tab,
  so a rare word weighs the same whichever tab it is in. Words are folded for
  scoring only (case, accents, light English/French inflection: `Waivers` ~
  `waiver`, `accommodating` ~ `accommodate`, `généraux` ~ `general`); offsets,
  highlights and copies always refer to the original text. The best 200 are listed.
- Second pass: the top 30 are rescored on the device by a cross-encoder in a
  worker of the side panel, each reading a 620-character window around its
  densest query words (192 tokens). A GPU with 16-bit shaders runs
  ms-marco-MiniLM-L4-v2 (fp16 ONNX, 38 MB) through WebGPU; any other machine runs
  ms-marco-TinyBERT-L2-v2 (int8 ONNX, 4.5 MB) on up to four WASM threads. The
  30 pairs run in three batches sorted by length, so little is padded. The model
  loads once the tabs have been read and is released after three idle minutes.
  It is English-only, so French queries keep the first-pass order. If the model
  is absent or fails (or Chrome is older than 137, which the runtime needs), the
  first-pass order stays.
- The list never jumps under the user: the reranked order replaces the first
  one once, and only while the pointer is off the list and the selection has
  not been moved. Otherwise it waits for the pointer to leave, or is dropped once
  a result has been chosen. Open, preview and the copy commands use the result's
  issued handle, so they work from either order.

Measured 2026-09-23 on an i3-1315U laptop with Intel UHD graphics, loaded to
80-90% CPU by other work: the 38 judged queries over 30 tabs holding the 30
longest A2AJ judgments (20.4M characters), each query's top 30 from the panel's
own index given to the shipped reranker worker in headless Chromium. "4x" slows
the whole renderer process (worker and WASM threads included) to a quarter
speed; DevTools CPU throttling would miss the workers. It slows the CPU only: the
GPU runs at full speed.

| Ranking | Target in top 10 | MRR | Rerank p50 / p95, 1x | Rerank p50 / p95, 4x | Memory over an idle renderer |
| --- | ---: | ---: | ---: | ---: | ---: |
| First pass (BM25) | 0.698 | 0.503 | - | - | - |
| GPU: MiniLM-L4 fp16, WebGPU | 0.809 | 0.711 | 361 / 493 ms | 406 / 477 ms | 250 MB + 175 MB GPU process |
| CPU: TinyBERT-L2 int8, WASM | 0.737 | 0.585 | 103 / 125 ms | 440 / 755 ms | 160 MB |
| Before: MiniLM-L6 int8, WASM | 0.836 | 0.724 | 1.48 s | 4.06 s | 445 MB (peak 742) |

The L6 model on WASM, which this replaces, ranked best but took 1.5 s on this
laptop and 4.1 s at 4x per 30 passages (timed separately on three queries' top
30); on this GPU it still takes 0.52 s, so L4 is the largest model that fits in
half a second. Both new paths rank below L6: on the GPU by one query in 38, on
CPU-only machines by a real margin, traded for speed. The index answers a query
in 5.7 ms (p50; p95 11.9 ms) at 1x.

**Exact search** keeps document order and Boolean matching.
`privileg* waiv*` requires both prefixes in one unit, in either order.
`"duty of care" breach` combines a whitespace-normalized phrase and whole word.
Matching is Unicode-aware and case-insensitive; accents are significant.
Write AND or `/p` between plain words (`privilege AND waiver`,
`privilege /p waiver`) to get the exact same-paragraph match instead of
ranking; /s is always exact.

`privilege /p waiver` and `privilege /s waiver` explicitly set proximity; Tab
updates those operators but not quoted literals. AND and spaces between
operators combine terms; parentheses and OR allow alternatives; NOT excludes a
matching unit, not a whole document. For example
`(privileg* OR confidential*) waiv* NOT implied`. In exact queries and/or/not
are operators in any case. Each alternative must require a positive term.
Unsupported syntax is rejected. Exact mode is not a replica of a provider's
tokenizer.

## Access, resource budgets and cleanup

The native workspace adds only the **sidePanel** permission. Existing activeTab,
scripting and HTTP/HTTPS host access support user-invoked cross-tab searches.
Automatic citation scripts keep their original provider matches. Search code is
not injected into every website on page load. No backend, telemetry, polling or
worker-keepalive loop is added. The one packaged dependency is the reranker in
`vendor/rerank/` (onnxruntime-web 1.30.0's JSPI build for WebGPU and WASM, and
the two models; 60 MB, not committed): `npm run fetch:rerank` downloads it and
checks every file against a pinned SHA-256; nothing is fetched at run time. The
manifest makes extension pages cross-origin isolated (COOP/COEP), which lets the
panel's reranker use up to four WASM threads on machines without a suitable GPU;
its pool threads sleep rather than spin between operators.

The broker stores compact navigation handles in extension-private RAM session
storage; queries/previews normally remain in the panel instance. For a deliberate
cross-window handoff only, a one-shot RAM snapshot also contains the bounded
results and drafts. The receiving panel consumes/removes it. Unconsumed snapshots
older than 60 seconds are pruned on the next launch; no disk or sync storage is
used for these snapshots. Chrome restart clears session storage.

Clear in Open tabs or Escape from that route releases the shared session. Native
X closure does not globally destroy a workspace still in use in another window;
existing page cache timers expire after 15 minutes and release on pagehide.
Abandoned broker records are pruned on next launch. Browser suspension can delay
timers. Navigation also rejects expired handles. No claim of immediate deletion
on every browser-owned close event is made.

Existing search caps remain: four-tab batches; 200 units per page and 1,000 total
previews; four million text characters/150,000 traversal steps per page; a
32-million-character queue-start threshold across pages (last batch may overshoot);
five-second operation waits within an 18-second deadline. Ranked mode indexes up
to 32 million characters across tabs, keeps the best 200 (the 1,000-result stop
does not apply) and reranks the top 30, each cut to 620 characters and 192 tokens. Physical paragraphs over
65,536 UTF-16 characters and budget-truncated units are skipped whole, not split
into misleading proximity/NOT matches. Highlight caps are 100 ranges/unit and
2,000 background ranges; previews contain at most 460 characters. Partial work
and skipped tabs are visible through the fixed status area and Details popover.

Search covers loaded visible top-document HTML and open shadows. Browser-internal
pages, Web Store, built-in PDF viewers, scans, canvas text, closed shadows, iframe
interiors and unloaded/virtualized text remain unsupported. Frozen, discarded,
loading or access-denied tabs are skipped without waking or re-fetching them.
**Opening a search from a new tab does not imply permission to read that tab.**

## Validation and maintenance

See [WORKSPACE.md](WORKSPACE.md) for validation evidence and the remaining native
Chrome acceptance checks. Run the complete checkout's focused commands:

```
npm run test:sonar
npm run test:workspace
```

The browser driver is optional and development-only:
`npm install --no-save --package-lock=false playwright` and
`npx playwright install chromium`. CHROME_PATH and PLAYWRIGHT_MODULE select
existing installations. An unpacked extension requires no npm installation.
Reload the extension and previously injected pages after updating.
