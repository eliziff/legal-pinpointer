# Legal Pinpointer

A small, local-only Manifest V3 extension for copying structure-aware Canadian legal pinpoints and citations from CanLII, Lexis+, and Westlaw Advantage Canada.

## Install

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Choose **Load unpacked** and select this folder.

No build or package installation is required to use the extension.

## Workflows

- **Ctrl+X** copies the hovered or selected pinpoint. It does not replace Cut in inputs, textareas, selects, or editable content.
- **Ctrl+Shift+X** copies the pinpoint plus selected text.
- **Alt+X** copies the cleaned McGill-style citation as a link.
- **Alt+C** opens the reliably detected CanLII version.
- The popup exposes the same actions. McGill pinpoints are the default (`para 12`, `paras 12-14`, `at p. 353`, `at pp. 553, 559`, `s 7(2)`, or `ss 7(2)-(4)`), with bare locators available as an option.

If a supported document exposes no usable structure, copy actions fall back to the cleaned page link labelled with the citation title. Secondary-source section headings such as `§ 12.02` act as page-wide pinpoints, while citation copy uses the provider's separate source and author metadata without the pinpoint.

Citation links cover only the authoritative citation core, such as `2024 SCC 1` or `SA 2008, c. A-4.2`; the case or legislation title remains outside the link. A provision suffix exposed by a legislation page, such as `s. 1`, is treated as a page pinpoint rather than part of the legislation citation.

A current-page text-fragment URL in the clipboard has precedence over both selection and hover. Its resolved range governs the pinpoint and quote, and the original fragment URL becomes every pinpoint endpoint link. The extension parses WICG text directives locally, including endpoint-only ranges and multiple `text=` directives.

Selections include every structural unit crossed. Rich clipboard output links the two ends of a collapsed range separately, such as `32-33` or `7(2)-(4)`. Quote output preserves a small safe set of inline formatting and emits real paragraph blocks, with one newline between units in plain text. Provisions use hanging paragraph indents so explicit and word-processor-wrapped continuation lines remain aligned beneath the provision text. An ellipsis is added only after the first marker when the selection omits substantive opening text; trailing ellipses are never emitted.

## Find within a CanLII document

**Ctrl+Shift+S** opens a compact find-in-page dialog. Type `privileg* waiv*`, or use explicit syntax such as `privilege /p waiver`. **Tab**, while typing in the search field, switches between **/p** (all terms in one paragraph) and **/s** (all terms in one sentence), retaining the query. The mode button does the same. **Enter** / **Shift+Enter** move to the next / previous matching unit and wrap; **Escape** closes the dialog and clears its highlights. Shift+Tab retains ordinary focus navigation, and input Cut/Copy shortcuts remain native.

Words are case-insensitive, whole-word matches in either order. Double quotes group an exact phrase; a trailing `*` matches word endings. Spaces combine all terms using the selected mode. Mixed proximity operators, Boolean operators, and arbitrary word-distance operators are not supported. The counter counts matching paragraphs or sentences, not combinations of word occurrences.

Search uses the existing CanLII document adapter and text-to-DOM mapper. Physical paragraphs and unnumbered block quotations remain separate; standalone native paragraph anchors provide additional boundaries on older pages. Inline emphasis and line breaks do not by themselves split a paragraph. Sentence detection uses English/French browser segmentation with common legal-abbreviation guards; it is not an exact reproduction of CanLII's server-side search engine. Poorly structured HTML or unusual abbreviations can affect boundaries. Native PDF viewers and scans are not searched.

The page stays intact: highlights use CSS text ranges rather than replacing document nodes or the user's selection. Queries stay in memory on the current page; there are no new permissions, dependencies, network calls, or saved query history. The index is built on demand and refreshed after document edits while the dialog is open. Existing citation/quote-copy behavior is unchanged. After updating an unpacked installation, reload the extension and the CanLII page.

## Structure and citation policy

Provider-native anchors are used first, with one deliberate hierarchy rule: a page-delimited case confirmed by the exact legal-structure engine outranks native paragraphs. Cases otherwise use paragraphs; legislation uses provisions; and pilcrow or silcrow markers are definitive in secondary sources.

`legal-structure.wasm` is the unmodified `legal-structure` Rust parser and grammar tables, linked behind the small C ABI in `engine-src/src/lib.rs`. The browser-only adaptations are:

- line-oriented DOM linearization and declared engine-offset-to-DOM mapping;
- validation that inferred reporter pages correspond to literal `[page n]` DOM text, including the parser-bounded final page;
- provider selectors, ordered native section evidence, and parallel-citation metadata extraction.

Neutral citations found in bounded provider metadata replace proprietary citations. Case URLs use the exact court-route table synchronized from Beaver. Legislation URLs resolve against the packaged CanLII metadata snapshot by exact citation identity or a unique title-and-jurisdiction match. Both paths abstain when identity is uncertain. A direct provider-owned CanLII link wins when present. CanLII is preferred for native paragraph and provision anchors, but never replaces a generated provider text-fragment target.

## Security and permissions

Runtime code and metadata are fully packaged. There are no dependencies, CDNs, remote scripts, analytics, backend, or runtime network requests. The service worker fetches only the extension's own packaged WASM and CanLII legislation index files.

Rich clipboard HTML is rebuilt from escaped text and a fixed inline-formatting allowlist. Provider markup, attributes, event handlers, styles, scripts, and hidden controls are never passed through.

The manifest requests only:

- `clipboardRead`, to recognize a copied current-page text-fragment URL;
- `clipboardWrite`, for plain and rich clipboard output;
- `storage`, for the pinpoint-style setting;
- exact content-script matches for CanLII documents, Lexis document pages, and Westlaw document pages.

Popup actions report once in the popup. Keyboard copy/navigation actions report once through the single in-page success/error toast. Find actions report in the find dialog.

## Maintenance

Refresh the exact parser after changing `legal-structure`:

```powershell
cargo check --manifest-path native/legal-structure-node/Cargo.toml --offline
.\tools\refresh-engine.ps1 -LegalStructurePath 'C:\path\to\legal-structure'
```

The refresh script builds a disposable offline WASM project from the checked-in ABI and the supplied parser source, then replaces only `legal-structure.wasm`.

Refresh the exact CanLII court-route table:

```powershell
.\tools\sync-canlii-courts.ps1 -SourcePath 'C:\path\to\backend\src\lib\canliiUrls.ts'
```

Refresh the packaged CanLII legislation metadata from the existing local snapshot:

```powershell
python .\tools\build-canlii-legislation-index.py 'C:\path\to\canlii.db'
```

Run focused tests:

```powershell
npm test
npm run test:browser
```

The browser tests cover full and partial quotes, edge ellipses, formatting and line breaks, separately linked range endpoints, text-fragment precedence, non-duplicated toast feedback, and the CanLII find dialog's matching, keyboard, mutation, and cleanup workflows. Set `CHROME_PATH` when Chrome is not at the launcher's default Windows path. The find fixture isolates its UI with a provider-model stub and the real text mapper; it does not validate live provider layouts or an installed extension. `tools/inspect-capture.cjs` runs the real provider adapter, DOM bridge, and packaged Rust engine over a saved HTML/MHTML page without copying it into this project. `tools/audit-canlii-cache.ps1` audits a supplied CanLII cache with incremental reports.
