# Native search workspace / CanLII launcher — 0.1.30

Baseline: PR #2 head `95c62ac6de0da74ff56b8e1dfd6eaa56ccd37135`.
The new command path uses sonar.html as a global Chrome side panel. Source-page
matching stays in the existing find-page.js agent; neither that file nor
find-core.js is changed. Citation/name/formatting, text-fragment optimizations,
the packaged WASM, court routes and legislation snapshot are also unchanged.
The old in-page UI entry remains for legacy regression compatibility but is no
longer called by the browser commands or popup.

## Design

- One native, extension-owned workspace keeps results visible during source-tab
  activation. It does not depend on a provider's page DOM or CSS.
- Fixed grid regions and virtual 132-pixel result rows prevent content-driven
  modal movement. Only visible/overscan rows exist in the DOM. No height animation,
  per-frame polling, external assets or UI framework is introduced.
- Exact range navigation keeps the existing document-ID/URL/ticket/group checks;
  result handles also record their window. Selecting a result neither scrolls
  nor activates its source; only Open (or Enter on a result) does.
- Cross-window panel opening occurs synchronously inside the click/key gesture,
  before IPC or storage awaits; a one-shot private RAM handoff transfers the list,
  selected passage and query without moving the source tab. Stale shared searches
  are explicitly disabled rather than navigating obsolete handles.
- Alt+Shift+S is dispatched by chrome.commands, including on chrome://newtab and
  about:blank. It opens the native CanLII query form with **zero source injections**.
  Only submitting the form creates a CanLII /#search/text= URL in a new tab.
- Sender identity is checked against the packaged panel/popup URL. Page senders
  cannot supply the panel's workspace identity. Remote search destinations are
  generated from a fixed HTTPS CanLII base, not accepted as arbitrary URLs.
- Only the sidePanel permission is added; no new-tab override or permanent
  all-site content script. Minimum Chrome is 116 for sidePanel.open. Existing
  worker suspension, cancellation, bounded scans and compact handle persistence
  are preserved. See FIND.md for transient handoff/cleanup limits.

## Validation actually run

This record predates the 2026-09-24 panel, which no longer has the passage preview,
Alt+wheel or Back to start; `npm run test:extension` is the current installed-extension gate.

Linux container, Node 22.16.0, Chromium 144.0.7559.96.

1. **19/19 Node tests passed:** eleven existing broker tests (two fixture updates:
   runtime.getURL and the windowId handle field), plus eight workspace tests.
   They cover scope, cancellation, stale writes, 40-tab budgets, restart, exact
   navigation, private-context checks, panel identity, virtual row bounds, and
   browser-command routing from ordinary, blank, new-tab and browser-owned URLs.
2. **1/1 Chromium workspace regression passed:** real matcher, page index,
   broker, launcher and native-panel HTML/CSS/JS across multiple independent
   documents. Chrome tab/window/storage/sidePanel APIs are simulated. Checked
   both proximity modes; all three scope keyboard cycles; real source Range
   highlights and scroll; direct row click; Alt-wheel/release; Back scroll restore;
   worker recreation; cross-window snapshot consumption; stale source rejection;
   separate CanLII query/submission; query-input node preservation; and Clear.
3. The same regression displayed **1,000 results with six mounted rows** at the
   end of the tested viewport. Query/list/preview/footer rectangles were identical
   before and after result changes, cross-window handoff, long excerpts and route
   changes. At a 320 x 560 viewport rows remain 132 pixels with no horizontal
   document overflow. This is a renderer geometry/allocation check, not a universal
   timing, memory-in-megabytes or native compositor benchmark.
4. **1/1 manifest permission/host contract test passed.** JavaScript syntax checks
   passed for every locally present runtime/test file. Packaged HTML uses external
   scripts/styles only and inserts previews as text. No historical speedup ratio
   is claimed as a new benchmark result in this revision.

Native extension loading was attempted, but the managed browser rejected the
extension-management route with ERR_BLOCKED_BY_ADMINISTRATOR and did not expose
an extension service worker. That restriction was not bypassed. Therefore the
OS keyboard accelerator, actual native panel opening/handoff, installed clipboard
and permission behavior, real worker-idle termination, and live CanLII results
are **not validated here**. New-tab command routing passes in API doubles; it is
not claimed as physical keyboard testing on a user's Chrome installation.

A full checkout/binary assets were unavailable, so the complete legacy parser,
clipboard, security, metadata and old browser suites were not executed. The
modified broker's existing Node suite was rerun. These limitations must remain
visible in release/PR notes.

## Installed-Chrome acceptance checklist

Load/update the branch as an unpacked extension in Chrome 116+, reload the
extension and previously injected source pages, then check:

- Ctrl+T followed by Alt+Shift+S opens/focuses CanLII document-text search while
  the new tab remains open. Enter submits a Unicode/operator query in a new
  CanLII results tab. Repeat from about:blank and a normal webpage.
- Ctrl+Shift+S opens the same native workspace. Tab switches /p and /s;
  Shift+Tab cycles Current/All/Group. Open real passages in two tabs, then a
  different window. Query and results remain visible, with exact source text
  highlighted and no tabs moved.
- Change source content or reload it before opening a saved result: require
  searching again rather than opening the wrong passage. Restrict a site's access and
  confirm it is listed as unavailable, not counted as a zero-hit search.
- Check keyboard shortcut assignments and conflicts at
  chrome://extensions/shortcuts. The popup must warn about unassigned commands
  and both buttons must remain usable. Native browser/OS reservations can still
  take precedence over suggested bindings.

## Official platform references

- [Chrome sidePanel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel): global default_path, window-level open, user-gesture requirement and close availability.
- [Chrome commands](https://developer.chrome.com/docs/extensions/reference/api/commands): browser-level accelerators, onCommand tab argument and getAll bindings.
- [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage): extension-private session storage and lifecycle.
- [Chrome worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle): tolerate suspension rather than keeping workers alive.
