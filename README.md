# Legal Pinpointer

A local Manifest V3 extension for copying Canadian legal citations and exact
pinpoints from CanLII, Lexis+ and Westlaw Advantage Canada.

## Install and use

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**
and select this repository folder. The extension is already packaged: no npm
installation or build is needed to use it.

| Shortcut | Action |
| --- | --- |
| Ctrl+X | Copy the selected or hovered pinpoint; ordinary Cut remains available in editable controls |
| Ctrl+Shift+X | Copy the pinpoint and selected text |
| Alt+X | Copy the cleaned McGill-style citation as a link |
| Alt+C | Open a reliably identified CanLII version |

The popup offers the same actions. McGill pinpoints are the default, with bare
locators available as a setting. When usable structure is absent, copying falls
back to a cleaned page link labelled with the citation title.

A copied current-page text-fragment URL takes precedence over selection and
hover: its resolved range governs the quote and pinpoint, and its original URL
is preserved. Selections include each structural unit crossed; collapsed ranges
link their endpoints separately. Rich quotes retain safe inline formatting and
paragraph breaks, with hanging provision indents. Leading omissions can receive
an ellipsis; no trailing ellipsis is invented.

Only the authoritative citation core is linked; case/legislation titles remain
outside it. A provision suffix is a pinpoint, not part of the legislation's
identity. Secondary-source section markers can supply page-wide pinpoints while
citation copy uses separate source/author metadata.

## Source identity and structure

The extension consumes the unchanged
[Legal Structure Parser](https://github.com/eliziff/legal-structure-parser)
through the small ABI in [engine-src/](engine-src/). Browser code owns provider
selectors, DOM linearization and explicit engine-offset-to-DOM mapping—not a
parallel legal structure engine.

Native anchors are preferred except that engine-confirmed reporter pages outrank
native case paragraphs. Reporter-page matches must correspond to literal DOM
page markers. Legislation uses provisions; pilcrow/silcrow markers govern supported
secondary sources. Uncertain identities are not guessed.

The packaged court routes come from
[Beaver](https://github.com/eliziff/Beaver); legislation links use an exact citation
or unique title/jurisdiction match in the packaged metadata snapshot. A direct
provider-owned CanLII link wins when present, but never replaces an explicit
provider text-fragment target. Packaged data is a snapshot, not a live lookup.

## Maintenance

Run these commands from this repository's root with your local source/data paths.

```powershell
.\tools\refresh-engine.ps1 -LegalStructurePath 'C:\path\to\legal-structure'
.\tools\sync-canlii-courts.ps1 -SourcePath 'C:\path\to\Beaver\backend\src\lib\canliiUrls.ts'
python .\tools\build-canlii-legislation-index.py 'C:\path\to\canlii.db'
```

The engine refresh makes a disposable offline WASM build from the supplied parser
and checked-in ABI, replacing `legal-structure.wasm`. Record the source revision
used and validate the resulting packaged engine; updating source elsewhere does
not update this extension automatically. Keep provider captures and local corpus
files outside the repository.

With Node.js available:

```sh
npm test
npm run test:browser
npm run audit:legislation
```

The browser test launches Chrome directly. Set `CHROME_PATH` when Chrome is not at
the default Windows installation path. `npm run check` combines all three checks;
[package.json](package.json) is the command source of truth.
[tools/](tools/) also contains saved HTML/MHTML inspection and local-cache audits.
Browser fixtures do not replace checking changed selectors against real provider
pages.

## Privacy and notices

Runtime code, WASM and metadata are packaged locally: no analytics, remote scripts,
CDNs or backend. The worker fetches only extension-owned assets. Opening a provider
link is ordinary browser navigation, not a claim that the destination is offline.

The extension requests clipboard read/write and setting storage, with exact
provider content-script matches; see [manifest.json](manifest.json). Clipboard
HTML is reconstructed from escaped text and an inline-formatting allowlist, not
copied as arbitrary provider markup. Popup actions report in the popup; keyboard
actions use one in-page notification.

Retain [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with distributions.
