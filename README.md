# Legal Pinpointer

A local-first Manifest V3 extension for structure-aware Canadian legal citations, CanLII links from Westlaw and Lexis, persistent proximity search across open tabs, Case Marker folders on CanLII, and PDF text-fragment links. Every in-page feature can be switched off in the popup's **Settings** tab.

## Install

1. Open `chrome://extensions` in Chrome 116 or newer.
2. Turn on Developer mode.
3. Choose **Load unpacked** and select this folder.

No build or package installation is required to use the extension. After updating, reload the extension and previously injected pages. Shortcut conflicts can be resolved at `chrome://extensions/shortcuts`; the popup reports unassigned search bindings.

## Workflows

- **Ctrl+X** copies the hovered or selected pinpoint. It does not replace Cut in inputs, textareas, selects, or editable content.
- **Ctrl+Shift+X** copies selected text with linked structural markers.
- **Alt+X** copies the cleaned citation as a link.
- **Alt+C** opens the reliably detected CanLII version.
- **Ctrl+Shift+F** (or right-click → *Link to the text copied in the clipboard*) turns copied text into a text-fragment link to the current tab, including Chrome's PDF viewer. The popup's Settings choose the link, the linked text, or the text followed by `[Link]`.
- The popup (Copy, Marker and Settings tabs) exposes the same actions. Full pinpoints are the default (`at para 12`, `at paras 12-14`, `at 353`, `at 553, 559`, `s 7(2)`, or `ss 7(2)-(4)`), with bare locators available as an option. Pages use `at n`, never `at p. n` or `at pp. n`.

If no structure is detected and text is selected, quote/pinpoint copy outputs literal **`[Link]: selected text`**. In rich text, only `[Link]` links to the source; selected text retains the safe inline-formatting allowlist. No paragraph number, provision or page is fabricated. With no selection, copy falls back to the cleaned page link labelled with the citation title. Citation-only copy still copies the citation.

With **Link passages when no structure is found** turned on in the popup, `[Link]` instead points at a text-fragment link for the selected passage (or, with nothing selected, the hovered paragraph), built against the page itself. The link is accepted only if the browser's own search, modelled on Chromium's and checked against current Chrome and newer Chromium alike, lands on exactly that passage; leading paragraph markers and stray edge punctuation are left out. When no link can single the passage out (its opening words recur verbatim elsewhere on the page), `[Link]` keeps the page link and the toast says why. Tab Search passage links use the same builder.

Secondary-source section headings such as `§ 12.02` act as page-wide pinpoints, while citation copy uses the provider's separate source and author metadata without the pinpoint.

Citation links cover only the citation core, such as `2024 SCC 1`, `1934 CanLII 376 (AB QB)`, or `SA 2008, c. A-4.2`; the case or legislation title remains outside the link. A provision suffix exposed by a legislation page, such as `s. 1`, is treated as a page pinpoint rather than part of the legislation citation. Names come from document metadata and title fields, not an unrelated authority cited in the body. Missing full names are not invented from a citation number.

A current-page text-fragment URL in the clipboard has precedence over both selection and hover, including the structureless fallback. Its resolved range governs the pinpoint and quote, and the original fragment URL becomes every pinpoint endpoint link. The extension parses WICG text directives locally, including endpoint-only ranges and multiple `text=` directives.

## On the page

- **Copy buttons on every paragraph and section.** Each numbered paragraph or provision on CanLII, Westlaw and Lexis carries two small buttons in its margin: the pinpoint (`at para 12`, linked; Ctrl+X) and the pinpoint with its text (Ctrl+Shift+X). With text selected, they copy the selection instead, exactly as the hotkeys do (a range such as `at paras 12-14`, or a quote across paragraphs). Where the page has no margin, they sit in the space above the paragraph's first line. They hold no text and sit outside the page's layout, so selecting and copying the page itself is unaffected, and they exist only for paragraphs near the screen.
- **CanLII's sticky header names the document.** The style of cause or statute name, as Pinpointer cites it, stays visible while scrolling, with a **Copy link** button (the same as Alt+X).
- **Clean titles on Westlaw and Lexis.** A roomy, selectable title block (name, citation, and a **Copy link** button, the same as Alt+X) sits above the document, clear of the provider's toolbars. Westlaw's own title stops being a draggable link, so a press selects text instead of starting a drag, and it wraps instead of truncating.
- **CanLII button.** A small square CanLII button (its maple leaf) at the left of the title block: in colour when a reliable CanLII version is known, greyed out when none is. It opens CanLII in a new tab; once the title scrolls away it rides in the bottom-left corner.
- **No selection menus.** Westlaw, Lexis and Practical Law stop opening their highlight/annotate/copy-with-reference menus when text is selected. Clicks on links, buttons and fields are untouched.

The page controls reuse the content script's document model, built in idle time once the tab is shown (background tabs wait until they are opened). The citation engine runs in an offscreen document that opens on first use and closes after ten idle minutes.

## Case Marker

On CanLII search results, the open document's title, and the Westlaw and Lexis title block, a circle files the document into the current project's folders (up to three levels; nested rings show the path). A document has one identity everywhere, its CanLII path, which Westlaw and Lexis pages resolve to: a case filed from Westlaw shows as filed on CanLII and Lexis. A document with no CanLII version is filed under its citation and links back to the page it was filed from. Click a circle for its folders, a note and a badge. Hover a circle and press **C** or **V** to file it into the folders chosen in Settings, or **N** to clear it. Only search results and current versions get circles, never past versions of legislation or citations in the text.

The popup's **Marker** tab manages projects and folders (each new folder takes the next colour of a palette; click a swatch to change it), lists a folder's documents, and copies them as links. The data format is the original Case Marker's, and **Settings → Data** imports and exports it. To bring over data from the standalone Case Marker extension, run this in its popup's DevTools console, then import the downloaded file:

```js
chrome.storage.local.get(null, (data) => Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(data)])), download: 'case-marker.json' }).click());
```

## Copying into Word

Copies never add a line or paragraph break that the source does not have. A single paragraph or provision is one run of text: line breaks and nested blocks inside it become spaces. Several units are separated by one line break in rich text and one newline in plain text, with no leading or trailing break. All rich output is inline HTML (links, bold, italic, underline, sub/superscript), so pasting into the middle of a Word paragraph keeps it one paragraph.

Selections include every structural unit crossed. Rich clipboard output links the two ends of a collapsed range separately, such as `32-33` or `7(2)-(4)`. Quote output preserves a small safe set of inline formatting and uses inline HTML with explicit breaks between units and one newline between units in plain text, without adding a leading or trailing paragraph break. Provisions use hanging indents so explicit and word-processor-wrapped continuation lines remain aligned beneath the provision text. An ellipsis is added only after the first marker when the selection omits substantive opening text; trailing ellipses are never emitted.

## Tab Search — persistent results across your tabs

**Ctrl+Shift+S** opens Chrome's native side panel. It searches **This window**
(the default and widest scope), **This group** or **This tab**. Plain words rank by relevance; CanLII's operators
(AND, OR, NOT or `-`, `"phrase"`, EXACT( ), `*`, `/n`, `/s`, `/p`,
parentheses) work as written, and **?** lists them. Results list as you type,
each titled with the citation Pinpointer copies. **Enter** or **Tab** puts keyboard focus on
the results (Shift+Tab goes back) and arrows move among them; clicking a result only selects it.
**Open** (or Enter on a result) jumps to its exact source text while the
query/results remain visible. Each result's **Copy quote**, **Copy pinpoint** and
**Copy link** buttons copy it; **Ctrl+X**, **Ctrl+Shift+X** and **Alt+X** copy the
selected result's pinpoint, quotation or citation, as on its page. **Use
active tab** explicitly changes the pinned search origin. Escape closes the
panel, as does running a CanLII search.

Each window's panel searches that window; an ungrouped origin's Group scope is
empty, not all ungrouped tabs. Chrome freezes and discards background tabs to
save memory: a tab that has been read keeps its last reading and stays searchable
while it sleeps, and opening one of its results wakes the tab, reads it again and
then opens the same passage. A sleeping tab that was never read is reloaded in the
background so it can be read (Settings → *Wake sleeping tabs*; at most 24 per panel).
Restricted/unavailable pages and partial results are reported, not silently counted
as zero-hit documents.

**Alt+Shift+S** opens **CanLII document-text search from any browser tab,
including blank/new tabs**. The browser command needs no source-page injection.
Type a query and press Enter: CanLII results open in a new tab, leaving the
starting tab untouched. Nothing is sent while typing. Open-tab and CanLII
queries have separate drafts. Both launchers are also available in the popup.

Read [FIND.md](FIND.md) for controls, access, resource limits and cleanup, and
[WORKSPACE.md](WORKSPACE.md) for tests and native Chrome validation gaps.

## Structure and citation policy

Provider-native anchors are used first, with one deliberate hierarchy rule: a page-delimited case confirmed by the exact legal-structure engine outranks native paragraphs. Unnumbered continuations and block quotes inherit the preceding paragraph until the next marker. Cases otherwise use paragraphs; legislation uses provisions; and pilcrow or silcrow markers are definitive in secondary sources.

`legal-structure.wasm` is the unmodified `legal-structure` Rust parser and grammar tables, linked behind the small C ABI in `engine-src/src/lib.rs`. The browser-only adaptations are:

- line-oriented DOM linearization and declared engine-offset-to-DOM mapping;
- validation that inferred reporter pages correspond to literal `[page n]` DOM text, including the parser-bounded final page;
- provider selectors, ordered native section evidence, and parallel-citation metadata extraction.

Citations follow the McGill Guide (9th ed). Cases cite the neutral citation; without one, a printed reporter (official SCR/FCR first; digests such as ACWS, WCB or JE never qualify), then a CanLII citation, then the provider's own database citation marked `(WL Can)` or `(QL)`. Within the database tier, the current provider is preferred. Abbreviations carry no periods (`SCR`, `BCJ No 12`, `Ltd`, `R v NPD`), the Crown is `R`, Attorneys General are `(AG)`, `et al` is dropped, and matters read `Re X`. Only bounded document metadata supplies candidates. A direct provider-owned CanLII link wins when present. Otherwise case URLs use the exact court-route table synchronized from Beaver, first for the selected citation and then for a parallel neutral or CanLII citation in the document's own citation line. Pre-neutral and reporter-only cases then resolve through `canlii-case-aliases.tsv`, which joins A2AJ reporter aliases to CanLII case identifiers; a candidate is accepted only when its year matches the document's own citations and, for the Supreme Court, when the document is a Supreme Court decision. Legislation URLs resolve against the packaged CanLII legislation index (every CanLII statute and regulation, 91,669 instruments) by CanLII's own printed citation: common-law-cite's `canlii_citation_key` folds the provider's citation and CanLII's to one key (`R.S.O. 1990, c. H.8` and `RSO 1990, c H.8` are `rso-1990-c-h.8`), with French and older series names (`RLRQ`/`CQLR`/`RSQ`, `DORS`/`SOR`) and two- or four-digit regulation years as equivalent spellings. The consolidated version wins over the annual volume. Titles only break ties, or stand in (unique, within the citation's jurisdiction) when there is no citation. `npm run audit:legislation` round-trips every instrument. Both paths abstain when identity is uncertain. CanLII is preferred for native paragraph and provision anchors, but never replaces a generated provider text-fragment target.

## Security and permissions

Runtime code and metadata are fully packaged. There are no runtime dependencies,
CDNs, remote scripts, analytics or backend. The citation engine (the legal-structure
parser with common-law-cite, `legal-structure.wasm.gz`) and the CanLII indexes are
loaded once into an offscreen engine document that stays loaded while the service
worker sleeps, so copies never wait for the engine to start. **Submitting a CanLII
search opens a remote CanLII URL containing the query**; it is an explicit navigation,
not local search, and may be recorded in normal browser history.

Rich clipboard HTML is rebuilt from escaped text and a fixed inline-formatting allowlist. Provider markup, attributes, event handlers, styles, scripts, and hidden controls are never passed through.

The manifest requests only:

- `clipboardRead`, to recognize a copied current-page text-fragment URL and read copied PDF text;
- `clipboardWrite`, for plain and rich clipboard output;
- `storage`, for settings, Case Marker data and extension-private RAM navigation/handoff state;
- `activeTab` and `scripting`, for user-invoked search injection;
- `sidePanel`, for the persistent native search interface;
- `offscreen`, for the engine document (and the PDF link's clipboard access);
- `contextMenus`, for the right-click PDF link item;
- HTTP/HTTPS host access, to search other open tabs without activating them;
- content scripts on CanLII (documents, plus Case Marker on search pages), Lexis and
  Westlaw document pages, and a selection-menu guard on Westlaw, Lexis and Practical Law.

Local search queries are not written to disk or sync. Navigation handles use
Chrome's private RAM session storage. A deliberate cross-window handoff also
stores a one-shot bounded query/result snapshot there; the receiving panel
consumes/removes it. Unconsumed snapshots older than 60 seconds are pruned on
next launch. Closing the panel with Escape releases its shared search session. Native panel
X closure relies on the existing 15-minute page-cache/session expiry, rather
than destroying a workspace open in another window. Browser suspension can
delay timers. There is no background crawling, polling or worker keepalive.

Popup actions report once in the popup. Keyboard copy/navigation actions report once through the single in-page success/error toast; search feedback stays in the native workspace.

## Maintenance

Refresh the exact parser after changing `legal-structure`:

```powershell
.\tools\refresh-engine.ps1 -LegalStructurePath 'C:\path\to\legal-structure'
```

The refresh script builds a disposable offline WASM project from the checked-in ABI and the supplied parser source (Canadian and journal providers only; US and UK adapters are left out), with personal paths remapped out of the binary, then replaces `legal-structure.wasm.gz` and its generated classic-worker (`legal-structure.js`) and module (`legal-structure.mjs`) loaders. Tools load the compressed engine through `tools/engine-node.cjs`. It requires `wasm-bindgen-cli` at the version resolved in the engine dependency lock; the script checks that version before generating bindings.

Citation parsing, formatting, reporter preferences and CanLII court routes come from
`common-law-cite` through the parser's shared citation dependency. Rebuild the
WASM above after updating that dependency.

Rebuild the packaged CanLII legislation index from a CanLII legislation metadata export (CSV with `databaseId`, `legislationId`, `title`, `citation` and `type`), after refreshing the engine, and audit it:

```powershell
node .\tools\build-canlii-legislation-index.cjs 'C:\path\to\canlii_legislation.csv'
npm run audit:legislation
```

Refresh the packaged reporter-alias to CanLII case index from local A2AJ and CanLII metadata, using the same `legal-citations` Python package revision as the packaged WASM:

```powershell
python .\tools\build-canlii-case-aliases.py 'C:\path\to\a2aj_reporter_aliases.json' 'C:\path\to\a2aj.sqlite' 'C:\path\to\canlii.db'
```

Run focused tests:

```powershell
npm test
npm run test:browser
npm run test:workspace
```

`node tools/check-page-ui.cjs <corpus-dir>` loads the unpacked extension in Chromium, serves saved CanLII, Westlaw and Lexis pages at their real URLs, and checks and times the page controls, their clipboard output (no added breaks), Case Marker on an invented search page, the PDF link and the popup, saving screenshots.

The browser fixture covers full and partial quotes, edge ellipses, formatting and line breaks, separately linked range endpoints, text-fragment precedence, and non-duplicated toast feedback. The optional Playwright-backed `npm run test:pinpointer:browser` additionally checks compact-map equivalence, sparse offsets, metadata paths across provider-shaped fixtures, structureless selected quotes, and mutation safety. `npm run test:workspace` checks native-panel markup and routing with simulated Chrome APIs, not installed keyboard dispatch. `tools/inspect-capture.cjs` runs the real provider adapter, DOM bridge, and packaged Rust engine over a saved HTML/MHTML page without copying it into this project. `tools/audit-canlii-cache.ps1` audits a supplied CanLII cache with incremental reports. `tools/fragment-quirks.cjs` checks the text-fragment search model against the installed Chrome case by case. `tools/fragment-paint-gate.cjs` proves built links on saved pages: each link is opened by a fresh navigation with `::target-text` painted green, and passes only if Chrome lands on the passage and paints exactly it.
