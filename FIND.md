# Tab Sonar: one proximity finder for websites and tabs

## Controls

- **Ctrl+Shift+S** opens the modal and focuses the input on an ordinary webpage.
  macOS uses Control, not Command. The popup's **Tab Sonar / Find** button is an
  alternative. A conflicting shortcut can be reassigned in `chrome://extensions/shortcuts`.
- **Tab** cycles `/p` (paragraph) and `/s` (sentence), without losing the query.
- **Shift+Tab** cycles **Current tab → All tabs → Current tab group → Current tab**.
- **Enter / Shift+Enter**, or the arrows, preview next/previous results and wrap.
  In Current tab scope they also highlight and scroll the source. In multi-tab
  scopes the preview changes without activating another tab.
- **Ctrl+Enter** or **Open passage** activates the selected tab and highlights the
  exact source passage. Alternatively, hold **Alt**, turn the mouse wheel to
  inspect previews, and release Alt to open the displayed passage. Merely
  pressing/releasing Alt does nothing; losing focus cancels a pending wheel jump.
- **Return to Tab Sonar** restores the visited tab's previous window/nested scroll
  position and returns to the originating search. It never restores an old URL.
- **Escape** closes and removes search highlights, observers, and cached results.
  It does not rewrite the source selection or navigate back. **F6 / Shift+F6**
  move through input/buttons because Tab and Shift+Tab are reserved for search.
- **Refresh** re-reads tabs, text, and group membership. A source change refreshes
  Current tab mode automatically; multi-tab previews are revalidated before opening.

## Query language

`privileg* waiv*` requires both word prefixes in the selected unit, in either order.
`"duty of care" breach` uses a whitespace-normalized phrase and a whole word.
Terms are Unicode-aware and case-insensitive; accents are significant. There is
no automatic stemming, legal inference, or model call.

`privilege /p waiver` and `privilege /s waiver` explicitly set the mode; Tab updates
those operators but not quoted literals. Spaces and `AND` combine terms;
parentheses and `OR` allow alternatives; `NOT` excludes the matching unit, not
an entire document. For example `(privileg* OR confidential*) waiv* NOT implied`.
Every alternative must require a positive match. Mixed `/p` and `/s`, arbitrary
word-distance operators, malformed groups, and internal/leading wildcards
produce visible errors, not an approximate replacement query. This is not a
replica of CanLII, Westlaw, or Lexis server-side search semantics.

The count is matching paragraphs/sentences, not word occurrences or combinations.

## Scope, access and confidentiality

The current tab and group are those of the tab containing the finder. They do
not change while previewing or visiting a result. All tabs includes other
windows, but never mixes normal and incognito tabs. Group is the exact group in
its window; an ungrouped tab yields an explicit empty Group scope. The finder
does not create, regroup, close, reload, or wake discarded tabs.

The manifest adds `activeTab`, `scripting`, and `http://*/*` / `https://*/*` host
access. Cross-tab search cannot work with activeTab alone: that grant covers
only the invoked tab. Site access is broad enough for user-requested all-tab
search, but no universal content script runs on page load. Existing automatic
citation scripts remain restricted to their original provider URL patterns.
Chrome's per-site access controls can narrow access; denied tabs are reported.
No `tabs`, `tabGroups`, browsing-history, debugger, native-host or cloud permission
is added. Group IDs are read through `chrome.tabs`.

Page text is searched inside each tab. Only bounded snippets and issued result
handles return to the broker/UI. The modal uses a closed shadow root in the
extension's isolated world. No page HTML is inserted into it. Queries are not
saved to disk or sync. Result previews and exact-document navigation handles
use `chrome.storage.session` (RAM, not persistent history, not exposed to content
scripts) so an idle worker restart does not destroy navigation. Closing removes
this state. Page caches expire after 15 minutes; abandoned session records
older than 15 minutes are pruned when the finder next opens. Session storage
is also cleared when Chrome restarts. No network requests or telemetry are
introduced.

## Boundaries and partial searches

The engine searches loaded, visible HTML text in each tab's top document and
open shadow trees. CanLII's document container is preferred when present; other
sites are not required to expose legal metadata or a citation. Paragraphs follow
HTML/rendered block boundaries, list items, table cells and double line breaks,
with native paragraph-anchor boundaries where available. Inline emphasis and a
single `<br>` stay in the same paragraph. Sentences use `Intl.Segmenter` and a
small legal-abbreviation guard; boundaries remain heuristic.

Chrome-internal pages, the Web Store, the built-in PDF viewer, scans, canvas text,
closed shadow trees, iframe interiors, and unloaded/virtualized text are not
searchable by this implementation. Local HTML depends on Chrome's file-access
switch and site grants. Frozen/discarded/loading tabs and denied injections are
listed as skipped, never counted as searched zero-hit documents. No wake-up or
re-fetch is performed.

To bound work: four concurrent tab tasks, a five-second per-tab wait, an
18-second queue-start deadline, four million characters / 150,000 traversal
steps per page, 200 result units per page and 1,000 total previews. Caps produce
a visible partial-search indicator. Individual result highlighting keeps up to
100 distinct term ranges; a preview shows at most 460 source characters. Older
cached page queries are bounded to three tickets. The DOM is never wrapped in
`<mark>` tags, and result navigation uses issued handles plus exact Chrome
`documentId`, URL, current group membership and source-range revalidation.

## Development and validation

The installed extension remains self-contained: no build or npm install is
needed to use it. Reload the extension and already-open provider pages after
updating to remove any older content-script listeners.

```
npm run test:sonar
npm test
npm run test:browser
```

The optional cross-document Chromium regression needs Playwright only as a test
driver (not an extension dependency):

```
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:sonar:browser
```

`CHROME_PATH` selects an existing Chromium/Chrome executable. `PLAYWRIGHT_MODULE`
can point to a preinstalled Playwright package. The test loads the real matcher,
page engine, UI and broker into three in-memory Chromium documents; tab IDs,
groups, permissions and activation APIs are simulated. It covers both proximity
modes, all three scopes, Alt-wheel preview/jump, return/scroll restoration,
worker restart, source mutation, shadow text, source DOM preservation and close
cleanup. This is deliberately not described as an installed-extension or live
provider validation. The pre-existing browser clipboard fixture remains intact.
