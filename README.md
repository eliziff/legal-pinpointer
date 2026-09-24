# Legal Pinpointer

A small, local-first Manifest V3 extension for structure-aware Canadian legal citations and persistent proximity search across open webpages.

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
- The popup exposes the same actions. Full pinpoints are the default (`at para 12`, `at paras 12-14`, `at 353`, `at 553, 559`, `s 7(2)`, or `ss 7(2)-(4)`), with bare locators available as an option. Pages use `at n`, never `at p. n` or `at pp. n`.

If no structure is detected and text is selected, quote/pinpoint copy outputs literal **`[Link]: selected text`**. In rich text, only `[Link]` links to the source; selected text retains the safe inline-formatting allowlist. No paragraph number, provision or page is fabricated. With no selection, copy falls back to the cleaned page link labelled with the citation title. Citation-only copy still copies the citation.

With **Link passages when no structure is found** turned on in the popup, `[Link]` instead points at a text-fragment link for the selected passage (or, with nothing selected, the hovered paragraph), built against the page itself. The link is accepted only if the browser's own search, modelled on Chromium's and checked against current Chrome and newer Chromium alike, lands on exactly that passage; leading paragraph markers and stray edge punctuation are left out. When no link can single the passage out (its opening words recur verbatim elsewhere on the page), `[Link]` keeps the page link and the toast says why. Tab Sonar passage links use the same builder.

Secondary-source section headings such as `§ 12.02` act as page-wide pinpoints, while citation copy uses the provider's separate source and author metadata without the pinpoint.

Citation links cover only the citation core, such as `2024 SCC 1`, `1934 CanLII 376 (AB QB)`, or `SA 2008, c. A-4.2`; the case or legislation title remains outside the link. A provision suffix exposed by a legislation page, such as `s. 1`, is treated as a page pinpoint rather than part of the legislation citation. Names come from document metadata and title fields, not an unrelated authority cited in the body. Missing full names are not invented from a citation number.

A current-page text-fragment URL in the clipboard has precedence over both selection and hover, including the structureless fallback. Its resolved range governs the pinpoint and quote, and the original fragment URL becomes every pinpoint endpoint link. The extension parses WICG text directives locally, including endpoint-only ranges and multiple `text=` directives.

Selections include every structural unit crossed. Rich clipboard output links the two ends of a collapsed range separately, such as `32-33` or `7(2)-(4)`. Quote output preserves a small safe set of inline formatting and uses inline HTML with explicit breaks between units and one newline between units in plain text, without adding a leading or trailing paragraph break. Provisions use hanging indents so explicit and word-processor-wrapped continuation lines remain aligned beneath the provision text. An ellipsis is added only after the first marker when the selection omits substantive opening text; trailing ellipses are never emitted.

## Tab Sonar — persistent results across websites and windows

**Ctrl+Shift+S** opens Chrome's native side panel. **Tab** cycles `/p` (same
paragraph) and `/s` (same sentence). **Shift+Tab** cycles **Current tab → All
tabs → Current tab group**. Start with `privileg* waiv*`; quoted phrases,
Boolean groups and explicit `/p` or `/s` also work. Results list as you type,
each titled with the citation Pinpointer copies. **Enter** puts keyboard focus on
the first result and arrows move among them; clicking a result only selects it.
**Open** (or Enter on a result) jumps to its exact source text while the
query/results remain visible. Each result's **Copy quote**, **Copy pinpoint** and
**Copy link** buttons copy it; **Ctrl+X**, **Ctrl+Shift+X** and **Alt+X** copy the
selected result's pinpoint, quotation or citation, as on its page. **Use
active tab** explicitly changes the pinned search origin. Escape clears the
search; the panel stays open, so it never replays Chrome's slide-in.

Other-window results open that window's panel
and hand off the search without moving tabs. All tabs includes other windows in
the same normal/incognito context; an ungrouped origin's Group scope is empty,
not all ungrouped tabs. Restricted/unavailable pages and partial results are
reported, not silently counted as zero-hit documents.

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

Citations follow the McGill Guide (9th ed). Cases cite the neutral citation; without one, a printed reporter (official SCR/FCR first; digests such as ACWS, WCB or JE never qualify), then a CanLII citation, then the provider's own database citation marked `(WL Can)` or `(QL)`. Within the database tier, the current provider is preferred. Abbreviations carry no periods (`SCR`, `BCJ No 12`, `Ltd`, `R v NPD`), the Crown is `R`, Attorneys General are `(AG)`, `et al` is dropped, and matters read `Re X`. Only bounded document metadata supplies candidates. A direct provider-owned CanLII link wins when present. Otherwise case URLs use the exact court-route table synchronized from Beaver, first for the selected citation and then for a parallel neutral or CanLII citation in the document's own citation line. Pre-neutral and reporter-only cases then resolve through `canlii-case-aliases.tsv`, which joins A2AJ reporter aliases to CanLII case identifiers; a candidate is accepted only when its year matches the document's own citations and, for the Supreme Court, when the document is a Supreme Court decision. Legislation URLs resolve against the packaged CanLII metadata snapshot by exact citation identity or a unique title-and-jurisdiction match. Both paths abstain when identity is uncertain. CanLII is preferred for native paragraph and provision anchors, but never replaces a generated provider text-fragment target.

## Security and permissions

Runtime code and metadata are fully packaged. There are no runtime dependencies,
CDNs, remote scripts, analytics or backend. The service worker fetches only the
packaged WASM and CanLII legislation index. **Submitting a CanLII search opens a
remote CanLII URL containing the query**; it is an explicit navigation, not local
search, and may be recorded in normal browser history.

Rich clipboard HTML is rebuilt from escaped text and a fixed inline-formatting allowlist. Provider markup, attributes, event handlers, styles, scripts, and hidden controls are never passed through.

The manifest requests only:

- `clipboardRead`, to recognize a copied current-page text-fragment URL;
- `clipboardWrite`, for plain and rich clipboard output;
- `storage`, for settings and extension-private RAM navigation/handoff state;
- `activeTab` and `scripting`, for user-invoked search injection;
- `sidePanel`, for the persistent native search interface;
- HTTP/HTTPS host access, to search other open tabs without activating them;
- exact automatic content-script matches for CanLII documents, Lexis document
  pages, and Westlaw document pages. The citation-copy surface is unchanged.

Local search queries are not written to disk or sync. Navigation handles use
Chrome's private RAM session storage. A deliberate cross-window handoff also
stores a one-shot bounded query/result snapshot there; the receiving panel
consumes/removes it. Unconsumed snapshots older than 60 seconds are pruned on
next launch. Escape in the Open tabs query releases its shared search session. Native panel
X closure relies on the existing 15-minute page-cache/session expiry, rather
than destroying a workspace open in another window. Browser suspension can
delay timers. There is no background crawling, polling or worker keepalive.

Popup actions report once in the popup. Keyboard copy/navigation actions report once through the single in-page success/error toast; search feedback stays in the native workspace.

## Maintenance

Refresh the exact parser after changing `legal-structure`:

```powershell
.\tools\refresh-engine.ps1 -LegalStructurePath 'C:\path\to\legal-structure'
```

The refresh script builds a disposable offline WASM project from the checked-in ABI and the supplied parser source, then replaces only `legal-structure.wasm`.

Refresh the exact CanLII court-route table:

```powershell
.\tools\sync-canlii-courts.ps1 -SourcePath 'C:\path\to\Beaver\backend\src\lib\canliiUrls.ts'
```

Refresh the packaged CanLII legislation metadata from the existing local snapshot:

```powershell
python .\tools\build-canlii-legislation-index.py 'C:\path\to\canlii.db'
```

Refresh the packaged reporter-alias to CanLII case index from local A2AJ and CanLII metadata:

```powershell
python .\tools\build-canlii-case-aliases.py 'C:\path\to\a2aj_reporter_aliases.json' 'C:\path\to\a2aj.sqlite' 'C:\path\to\canlii.db'
```

Run focused tests:

```powershell
npm test
npm run test:browser
npm run test:workspace
```

The browser fixture covers full and partial quotes, edge ellipses, formatting and line breaks, separately linked range endpoints, text-fragment precedence, and non-duplicated toast feedback. The optional Playwright-backed `npm run test:pinpointer:browser` additionally checks compact-map equivalence, sparse offsets, metadata paths across provider-shaped fixtures, structureless selected quotes, and mutation safety. `npm run test:workspace` checks native-panel markup and routing with simulated Chrome APIs, not installed keyboard dispatch. `tools/inspect-capture.cjs` runs the real provider adapter, DOM bridge, and packaged Rust engine over a saved HTML/MHTML page without copying it into this project. `tools/audit-canlii-cache.ps1` audits a supplied CanLII cache with incremental reports. `tools/fragment-quirks.cjs` checks the text-fragment search model against the installed Chrome case by case. `tools/fragment-paint-gate.cjs` proves built links on saved pages: each link is opened by a fresh navigation with `::target-text` painted green, and passes only if Chrome lands on the passage and paints exactly it.
