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

If a supported document exposes no usable structure, pinpoint copy falls back to the cleaned page link labelled with the citation title. Selected-text copy appends the selected passage after that link, separated by a comma. With **Link passages when no structure is found** turned on in the popup, the selected passage (or, with nothing selected, the hovered paragraph) instead gets a text-fragment link built against the page itself. The link is accepted only if the browser's own search, modelled on Chromium's and checked against current Chrome and newer Chromium alike, lands on exactly that passage. Leading paragraph markers and stray punctuation at the edges are left out. When no link can identify the passage (its opening line recurs verbatim elsewhere), the copy says so. A copied text-fragment link still takes precedence. Secondary-source section headings such as `§ 12.02` act as page-wide pinpoints, while citation copy uses the provider's separate source and author metadata without the pinpoint.

Citation links cover only the authoritative citation core, such as `2024 SCC 1` or `SA 2008, c. A-4.2`; the case or legislation title remains outside the link. A provision suffix exposed by a legislation page, such as `s. 1`, is treated as a page pinpoint rather than part of the legislation citation.

A current-page text-fragment URL in the clipboard has precedence over both selection and hover. Its resolved range governs the pinpoint and quote, and the original fragment URL becomes every pinpoint endpoint link. The extension parses WICG text directives locally, including endpoint-only ranges and multiple `text=` directives.

Selections include every structural unit crossed. Rich clipboard output links the two ends of a collapsed range separately, such as `32-33` or `7(2)-(4)`. Quote output preserves a small safe set of inline formatting and uses inline HTML with explicit breaks between units and one newline between units in plain text, without adding a leading or trailing paragraph break. Provisions use hanging indents so explicit and word-processor-wrapped continuation lines remain aligned beneath the provision text. An ellipsis is added only after the first marker when the selection omits substantive opening text; trailing ellipses are never emitted.

## Structure and citation policy

Provider-native anchors are used first, with one deliberate hierarchy rule: a page-delimited case confirmed by the exact legal-structure engine outranks native paragraphs. Unnumbered continuations and block quotes inherit the preceding paragraph until the next marker. Cases otherwise use paragraphs; legislation uses provisions; and pilcrow or silcrow markers are definitive in secondary sources.

`legal-structure.wasm` is the unmodified `legal-structure` Rust parser and grammar tables, linked behind the small C ABI in `engine-src/src/lib.rs`. The browser-only adaptations are:

- line-oriented DOM linearization and declared engine-offset-to-DOM mapping;
- validation that inferred reporter pages correspond to literal `[page n]` DOM text, including the parser-bounded final page;
- provider selectors, ordered native section evidence, and parallel-citation metadata extraction.

Citations follow the McGill Guide (9th ed). Cases cite the neutral citation; without one, a printed reporter (official SCR/FCR first; digests such as ACWS, WCB or JE never qualify), then a CanLII citation, then the provider's own database citation marked `(WL Can)` or `(QL)`. Within the database tier, the current provider is preferred. Abbreviations carry no periods (`SCR`, `BCJ No 12`, `Ltd`, `R v NPD`), the Crown is `R`, Attorneys General are `(AG)`, `et al` is dropped, and matters read `Re X`. Only bounded document metadata supplies candidates. Case URLs use the exact court-route table synchronized from Beaver; a parallel neutral or CanLII citation in the document's own citation line also identifies the CanLII copy. Pre-neutral and reporter-only cases resolve through `canlii-case-aliases.tsv`, which joins A2AJ reporter aliases to CanLII case identifiers; a candidate is accepted only when its year matches the document's own citations and, for the Supreme Court, when the document is a Supreme Court decision. Legislation URLs resolve against the packaged CanLII metadata snapshot by exact citation identity or a unique title-and-jurisdiction match. Both paths abstain when identity is uncertain. The selected citation determines the CanLII case URL. A direct CanLII link is used only when its label matches the selected citation; otherwise citation copy retains the current provider document URL. CanLII is preferred for native paragraph and provision anchors, but never replaces a generated provider text-fragment target.

## Security and permissions

Runtime code and metadata are fully packaged. There are no dependencies, CDNs, remote scripts, analytics, backend, or runtime network requests. The service worker fetches only the extension's own packaged WASM and CanLII legislation index files.

Rich clipboard HTML is rebuilt from escaped text and a fixed inline-formatting allowlist. Provider markup, attributes, event handlers, styles, scripts, and hidden controls are never passed through.

The manifest requests only:

- `clipboardRead`, to recognize a copied current-page text-fragment URL;
- `clipboardWrite`, for plain and rich clipboard output;
- `storage`, for the pinpoint-style setting;
- exact content-script matches for CanLII documents, Lexis document pages, and Westlaw document pages.

Popup actions report once in the popup. Keyboard actions report once through the single in-page success/error toast.

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

Refresh the packaged reporter-alias to CanLII case index from local A2AJ and CanLII metadata:

```powershell
python .\tools\build-canlii-case-aliases.py 'C:\path\to\a2aj_reporter_aliases.json' 'C:\path\to\a2aj.sqlite' 'C:\path\to\canlii.db'
```

Run focused tests:

```powershell
npm test
npm run test:browser
```

The browser test covers full and partial quotes, edge ellipses, formatting and line breaks, separately linked range endpoints, text-fragment precedence, and non-duplicated toast feedback. `tools/inspect-capture.cjs` runs the real provider adapter, DOM bridge, and packaged Rust engine over a saved HTML/MHTML page without copying it into this project. `tools/audit-canlii-cache.ps1` audits a supplied CanLII cache with incremental reports. `tools/fragment-quirks.cjs` checks the text-fragment search model against the installed Chrome case by case. `tools/fragment-paint-gate.cjs` proves built links on saved pages: each link is opened by a fresh navigation with `::target-text` painted green, and passes only if Chrome lands on the passage and paints exactly it.
