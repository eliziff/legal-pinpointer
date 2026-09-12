# Tab Sonar: one proximity finder for websites and tabs

## Controls

- **Ctrl+Shift+S** opens the finder on an ordinary webpage. macOS uses Control,
  not Command. The popup's **Tab Sonar / Find** button is an alternative;
  conflicting shortcuts can be reassigned in `chrome://extensions/shortcuts`.
- **Tab** cycles `/p` (paragraph) and `/s` (sentence), retaining the query.
- **Shift+Tab** cycles **Current tab → All tabs → Current tab group → Current tab**.
- **Enter / Shift+Enter**, or the arrows, preview next/previous results and wrap.
  Current tab also highlights and scrolls the source. Multi-tab preview does
  not activate another tab until you commit.
- **Ctrl+Enter** or **Open passage** activates and highlights the selected result.
  Alternatively, hold **Alt**, turn the mouse wheel to preview, then release Alt
  to open. Merely pressing/releasing Alt does nothing; losing focus cancels the
  wheel jump. Ordinary scrolling has no Sonar wheel listener.
- **Return to Tab Sonar** restores the visited tab's previous window/nested scroll
  position and returns to the originating search. It never restores an old URL.
- **Escape** closes and releases this session's results and indexes. It does not
  rewrite the selection or navigate back. **F6 / Shift+F6** move among controls
  because Tab and Shift+Tab are reserved for search.
- **Refresh** forces a fresh text index and re-reads tab/group membership.
  Source changes invalidate cached text; Current tab refreshes automatically.
  Multi-tab previews are revalidated before opening.

## Query language

`privileg* waiv*` requires both prefixes in one unit, in either order.
`"duty of care" breach` combines a whitespace-normalized phrase and whole word.
Matching is Unicode-aware and case-insensitive; accents are significant. There
is no stemming, legal inference, or model call.

`privilege /p waiver` or `privilege /s waiver` explicitly sets the mode; Tab
updates operators, not quoted literals. Spaces and `AND` combine terms;
parentheses and `OR` allow alternatives; `NOT` excludes a unit, not a document.
Example: `(privileg* OR confidential*) waiv* NOT implied`. Every alternative must
require a positive match. Mixed `/p` and `/s`, arbitrary word-distance operators,
malformed groups, and internal/leading wildcards produce visible errors. This
is not a replica of any provider's server-side search semantics. Counts are
matching paragraphs/sentences, not word occurrences or combinations.

## Scope, access and confidentiality

Current tab/group refer to the originating tab, not a visited result. All tabs
includes other windows without mixing normal and incognito contexts. Group is
the exact group and window; an ungrouped tab gets an explanatory empty scope.
No tab is created, regrouped, closed, reloaded, or awakened to search.

The existing `activeTab`, `scripting`, and HTTP/HTTPS host permissions enable
invoked current/all/group searches. `activeTab` alone cannot authorize other
tabs. No universal content script runs at page load; automatic citation scripts
keep their original provider matches. Chrome's site controls can narrow access;
denied tabs are reported. No new permissions are added by the performance work,
and there is no tabs/tabGroups/history/debugger/native-host permission.

Text is searched in its source tab. Bounded snippets reach the originating UI;
only issued navigation handles, target IDs, and session metadata are stored in
`chrome.storage.session` (extension-private RAM), not preview text or queries.
The closed-shadow UI inserts plain text, never source HTML. A closed shadow tree
is UI encapsulation, not a general security boundary against a hostile website.
There are no new network requests, model calls, telemetry, or disk/sync history.

Valid indexes survive query/mode changes. Mutation records, URLs, document IDs,
and source ranges are checked before reuse or navigation. Closing releases the
session; indexes shared with another live session remain until that session ends.
Page caches have a 15-minute expiry timer and release on pagehide. Abandoned RAM
sessions older than 15 minutes are pruned on the next open; Chrome restart clears
session storage. Browser suspension may delay page timers. The worker is allowed
to sleep; no keepalive loop or background crawler is introduced.

## Boundaries and partial searches

Search covers loaded visible HTML in the top document and open shadow trees.
CanLII's document container is preferred where present, but other sites need no
legal metadata. Paragraphs follow rendered block boundaries, lists, table cells,
and double breaks, with native paragraph anchors where available. Inline emphasis
and a single `<br>` stay in one paragraph. `Intl.Segmenter` plus a small legal
abbreviation guard supplies heuristic sentence boundaries.

Browser pages, the Web Store, built-in PDF viewer, scans, canvas text, closed
shadows, iframe interiors, and unloaded/virtualized text remain unsupported.
Local files require Chrome grants and are not guaranteed by the HTTP/HTTPS
manifest. Frozen/discarded/loading/denied tabs are skipped, not reported as
searched zero-hit documents. No re-fetch or wake-up occurs.

Work is bounded, and reaching a cap produces a visible partial-search notice:

- Four tabs per search batch; five-second per-operation waits within an 18-second
  search deadline. Queued work stops on supersession, cancellation, or a budget.
  Cancellation also reaches page jobs; timeout alone is not treated as cancellation.
- Four million indexed characters / 150,000 traversal steps per page. Physical
  paragraphs over 65,536 UTF-16 characters are skipped whole, as are units cut off
  by the page budget. They are not split or truncated into misleading NOT/proximity
  matches. The cross-tab scheduler stops starting batches at 32 million indexed
  characters; the final batch can overshoot by up to four page budgets.
- 200 result units per page; 1,000 total previews. Intermediate results are bounded
  by the four-tab batch. At most three result tickets are cached per page.
- Up to 100 source-ordered term ranges per unit, 2,000 background highlighted
  ranges per displayed result set, and 460 characters per preview. The active
  passage still gets its own highlight. Highlight limits also signal partial work.

Traversal/matching cooperatively yield around eight-millisecond checkpoints,
using scheduler continuations when available and a timer fallback. Native DOM,
style, regex, and segmentation operations can exceed that target; it is not a
hard real-time guarantee. Search does not wrap source nodes in `<mark>` elements.

## Development and validation

The extension needs no build or npm installation at runtime. After updating,
reload it and already-open provider pages to remove old content-script listeners.

```
npm run test:sonar
npm test
npm run test:browser
```

Optional browser regression and benchmark use Playwright only as an external
test driver, not an extension dependency:

```
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:sonar:browser
npm run benchmark:sonar -- /path/to/baseline-checkout
```

`CHROME_PATH` selects an existing executable; `PLAYWRIGHT_MODULE` selects a
preinstalled Playwright package. Browser tests run real page/UI/matcher/broker
code but simulate Chrome tabs, groups, permissions, and activation. They cover
interaction, warm-cache/paint reuse, mutation safety, cancellation, and resource
limits. They are not installed-extension or live-provider validation. Existing
clipboard/parser tests remain separate and unchanged. See [PERFORMANCE.md](PERFORMANCE.md)
for measured results, methodology, and validation gaps.
