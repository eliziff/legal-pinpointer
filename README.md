# Legal Pinpointer

A local-first Manifest V3 extension for structure-aware Canadian legal citations, CanLII links from Westlaw and Lexis, persistent proximity search across open tabs, Case Marker folders on CanLII, and PDF text-fragment links. Every in-page feature can be switched off in the popup's **Settings** tab.

## Install

1. Download `legal-pinpointer.zip` from the [extension release](https://github.com/eliziff/legal-pinpointer/releases/tag/v0.5.3) and extract it to a permanent folder, or use this source checkout.
2. Open `chrome://extensions` in Chrome 116 or newer.
3. Turn on Developer mode.
4. Choose **Load unpacked** and select the folder containing `manifest.json`.

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

- **Copy buttons on every paragraph and section.** Each numbered paragraph or provision on CanLII, Westlaw and Lexis has two small buttons: the pinpoint (`at para 12`, linked; Ctrl+X) and the pinpoint with its text (Ctrl+Shift+X). With text selected, they copy the selection instead, exactly as the hotkeys do (a range such as `at paras 12-14`, or a quote across paragraphs). On CanLII they sit right under CanLII's own paragraph or section tools button in the right margin; elsewhere they line up in one column just right of the text (or left of it, when the right margin is taken or too narrow). Stacked where a unit has room, side by side where it has less, and shown only on hover where units sit too close together, so they never pile up, at any window width. They hold no text and live in one zero-size overlay whose layout is contained, so nothing on the page moves and selecting and copying the page is unaffected. Every anchor's position is measured once (again only when the document changes size), and only the units within a screen of the viewport have controls, recycled as you scroll: a 5,000-section statute scrolls exactly as it does without the extension.
- **CanLII's sticky header names the document.** The document's title (as CanLII prints it) takes the place of the breadcrumbs in CanLII's header, with a **Copy link** button (the same as Alt+X), so it stays visible while scrolling. It wraps onto a second line (a third, smaller, in a narrow window) within the header's existing height, so the full citation is readable and the header never changes size. The tab is titled with it too.
- **Clean titles on Westlaw and Lexis.** The provider's own title is made plain, wrapping, selectable text; no second copy of it is added. Westlaw's title stops being a link back to the document (so a click no longer reloads it and a press no longer starts a drag), and its status icons are hidden. A drag that starts in the title stays in it (the rest of the page cannot be selected until the next press), even when it overshoots, and a triple-click selects the title alone. At the end of the title, out of the page's flow, sit the CanLII button, the Case Marker circle and a **Copy link** button (the same as Alt+X). These styles are in place before the first paint.
- **CanLII button.** A small square CanLII button (its maple leaf): in colour when a reliable CanLII version is known, greyed out when none is. When CanLII has no version but the decision is on its court's own Lexum/Decisia site (from packaged A2AJ metadata, never a live query), it shows a courthouse and opens that page instead; Alt+C and copied citation links fall back the same way. It opens in a new tab; once the title scrolls away it rides in the bottom-left corner (or in the citation bar, when that is on).
- **Citation bar on Westlaw and Lexis.** Once the title scrolls out of view, a bar is frozen along the top of the document (below the provider's own fixed toolbar, or along the top of the app's document pane) with the CanLII button, the document's citation and **Copy link** (the same as Alt+X). It is fixed and in its own shadow root, so it never moves the page and the provider's styles never reach it; it covers nothing while the title is in view.
- **No selection menus.** Westlaw, Lexis and Practical Law never draw their highlight/annotate/copy-with-reference menus: the page is never told a selection is being made (the press, drag, release and selection changes on the document's text stop at the window before any page listener). The browser's own selection and copying are untouched, and clicks on links, buttons and fields pass through.

Nothing Pinpointer adds to a page moves it: every control is out of flow or fills space reserved before the first paint, and `tools/check-page-ui.cjs` records the page's layout shifts with and without it. Presses on its controls are taken by a window listener registered at `document_start`, before any provider script, so a provider's click, drag or copy handlers never swallow them; copies that a page blocks go through the engine document's clipboard. The full document model a copy needs is built only when a copy looks likely (the pointer on a Pinpointer control, a modifier key, or a selection), so a page that is only read never pays for it. The citation engine runs in an offscreen document (outside the page) that opens when a legal document starts loading, so the title's CanLII button and the first copy never wait for it, and closes after ten idle minutes.

## Case Marker

On CanLII search results, the open document's title, and the Westlaw and Lexis title block, a circle files the document into any number of the current project's folders, which nest without limit (nested rings show the deepest filing's path, up to three; "+N" counts the other folders). A document has one identity everywhere, its CanLII path, which Westlaw and Lexis pages resolve to: a case filed from Westlaw shows as filed on CanLII and Lexis. A document with no CanLII version is filed under its citation and links back to the page it was filed from. Click a circle for its folders, a note and a badge: the folders it is filed under sit in a row (the empty slot adds another), and the chosen slot's folder is picked level by level from rows of folder chips; every change saves itself. Hover a circle and press **C** or **V** to file it into the folders chosen in the Marker tab's settings, or **N** to clear it. Only search results and current versions get circles, never past versions of legislation or citations in the text.

The popup's **Marker** tab manages projects and a folder tree in the manner of Beaver's Sources workspace (the shared model and picker are `marker-core.js`): each document sits under every folder it is filed in; a row's ⋯ menu renames, nests, orders and deletes folders, or files and removes a document; folders and documents can be dragged (a folder before, into or after another; a document onto a folder), and Alt+arrows move the focused folder. Each new folder takes the next colour of a palette; click its folder icon to change it. **Copy links** copies the chosen folder's documents (or all of them) as links. Each document is stored under its own key (`cm:` and its identity), so filing one writes that document alone and a page reads only the documents it shows; a single `canliiMarkers` object from an earlier version is split once, when the extension is installed, updated or the browser starts. Export writes the original Case Marker's format (one `canliiMarkers` object; a document's first filing in its `folderPath`, `folderIds` listing them all), Import reads it, and the Marker tab's settings (its sliders button, beside the project) import and export it, choose the C and V folders, and turn the circles off. To bring over data from the standalone Case Marker extension, run this in its popup's DevTools console, then import the downloaded file:

```js
chrome.storage.local.get(null, (data) => Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(data)])), download: 'case-marker.json' }).click());
```

## Copying into Word

Copies never add a line or paragraph break that the source does not have. A single paragraph or provision is one run of text: line breaks and nested blocks inside it become spaces. Several units are separated by one line break in rich text and one newline in plain text, with no leading or trailing break. All rich output is inline HTML (links, bold, italic, underline, sub/superscript), so pasting into the middle of a Word paragraph keeps it one paragraph. Every copy is written with a copy event, never Chrome's async clipboard first: the async write wraps the HTML in a document of its own, and Word pastes that as a paragraph of its own (checked by pasting into real Word: two paragraphs through the async write, one through a copy event).

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
background when the panel opens so it can be read (at most 24 per panel); with
Settings → *Wake sleeping tabs* off, it is listed, not read.
Restricted/unavailable pages and partial results are reported, not silently counted
as zero-hit documents.

**Ctrl+Shift+E** opens **CanLII document-text search from any browser tab,
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
  Westlaw document pages, and a selection-menu guard on Westlaw, Lexis and Practical Law;
  Case Marker is registered with `scripting` only while it is on, and also runs on courts'
  Lexum/Decisia decision pages.

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

The popup and Tab Search are styled with Tailwind on Beaver's tokens: edit `ui/extension.css` (or their markup) and run `npm install` once, then `npm run build:ui`, which writes the static `ui.css` the extension loads (it is committed, so a checkout loads without a build). Pages Pinpointer works on never load it; their controls use `content.css` and `marker.css` on the same tokens.

`npm run package:extension` creates `dist/legal-pinpointer.zip` and `dist/SHA256SUMS` from the tracked extension files, including the compressed engine and metadata. The archive contains the browser extension alone. `PINPOINTER_EXTENSION_ROOT` can point the installed-extension check at an extracted package.

Refresh the exact parser after changing `legal-structure`:

```powershell
.\tools\refresh-engine.ps1
# or from local checkouts, overriding the pinned revisions:
.\tools\refresh-engine.ps1 -LegalStructurePath 'C:\path\to\legal-structure' -CommonLawCitePath 'C:\path\to\common-law-cite'
```

The refresh script builds an offline WASM wrapper with one Cargo job and reuses `engine-src/target` across runs. It uses the checked-in ABI and the supplied parser source (Canadian and journal providers only; US and UK adapters are left out), with personal paths remapped out of the binary, then replaces `legal-structure.wasm.gz` and its generated classic-worker (`legal-structure.js`) and module (`legal-structure.mjs`) loaders. Tools load the compressed engine through `tools/engine-node.cjs`. It requires `wasm-bindgen-cli` at the version resolved in the engine dependency lock; the script checks that version before generating bindings.

Citation parsing, formatting, reporter preferences and CanLII court routes come from
`common-law-cite` through the parser's shared citation dependency. Rebuild the
WASM above after updating that dependency.

Rebuild the packaged CanLII legislation index from a CanLII legislation metadata export (CSV with `databaseId`, `legislationId`, `title`, `citation` and `type`), after refreshing the engine, and audit it:

```powershell
node .\tools\build-canlii-legislation-index.cjs 'C:\path\to\canlii_legislation.csv'
npm run audit:legislation
```

Refresh the packaged reporter-alias to CanLII case index from the engine's alias table (`crates/legal-citations/registry/aliases.json` in common-law-cite) and local A2AJ and CanLII metadata, using the same `legal-citations` Python package revision as the packaged WASM:

```powershell
python .\tools\build-canlii-case-aliases.py 'C:\path\to\aliases.json' 'C:\path\to\a2aj.sqlite' 'C:\path\to\canlii.db'
```

Then extend it from A2AJ's citation table (every parallel citation of a decision whose neutral citation CanLII routes, such as the SCR citation of a neutral-era SCC decision) and rebuild `case-court-sites.tsv.gz`, the Lexum/Decisia fallback for decisions CanLII lacks:

```powershell
node .\tools\build-a2aj-case-index.cjs 'C:\path\to\a2aj.sqlite'
```

`node tools/check-canlii-resolution.cjs <corpus-dir>` reports how many saved Westlaw and Lexis case pages resolve to CanLII or a court site.

Run focused tests:

```powershell
npm test
npm run test:browser
npm run test:workspace
```

`node tools/check-page-ui.cjs <corpus-dir>` loads the unpacked extension in Chromium, serves saved CanLII, Westlaw and Lexis pages at their real URLs (with click- and copy-swallowing handlers standing in for the providers' scripts), uses every page control and checks its clipboard output (no added breaks), records when each control appeared and every layout shift, times scrolling, and checks Case Marker on an invented search page, the PDF link and the popup, saving screenshots. `node tools/benchmark-page-ui.cjs <corpus-dir> [throttle]` compares the same pages with the extension on and off under CPU throttling.

The browser fixture covers full and partial quotes, edge ellipses, formatting and line breaks, separately linked range endpoints, text-fragment precedence, and non-duplicated toast feedback. The optional Playwright-backed `npm run test:pinpointer:browser` additionally checks compact-map equivalence, sparse offsets, metadata paths across provider-shaped fixtures, structureless selected quotes, and mutation safety. `npm run test:workspace` checks native-panel markup and routing with simulated Chrome APIs, not installed keyboard dispatch. `tools/inspect-capture.cjs` runs the real provider adapter, DOM bridge, and packaged Rust engine over a saved HTML/MHTML page without copying it into this project. `tools/audit-canlii-cache.ps1` audits a supplied CanLII cache with incremental reports. `tools/fragment-quirks.cjs` checks the text-fragment search model against the installed Chrome case by case. `tools/fragment-paint-gate.cjs` proves built links on saved pages: each link is opened by a fresh navigation with `::target-text` painted green, and passes only if Chrome lands on the passage and paints exactly it.

### Lens source loop

From `lens/`, `npm run build` or `node build.mjs` bundles local source into the existing `lens-dist/` assets without downloading corpora/models, converting embeddings or assembling an archive. Run `npm run build:package` or `node build.mjs --package` explicitly to prepare those assets and deliver the standalone HTML and extension archive. Source builds reuse previously prepared assets; initial offline setup requires that explicit package build.
