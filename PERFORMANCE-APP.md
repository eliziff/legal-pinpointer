# Pinpointer 0.1.28: citation, clipboard and mapping follow-up

This builds on the Sonar work in 0.1.27; Sonar runtime files and controls are unchanged.
The baseline for this follow-up is PR head `889eda8058c1c64a1346a40ca2722df99b21cc10`.
The modified baseline core, content, provider and text-fragment files were retrieved
from GitHub and their local bytes checked against the Git blob IDs.

## Renderer benchmark

Five paired runs, alternating variant order, Chromium 144.0.7559.96 and Node
22.16.0 in the task container. Synthetic input: 4,000 paragraphs, 1,050,892
normalized characters. Engine-to-DOM mapping uses 4,000 supplied engine nodes;
ancestor filtering uses 900 supplied provision nodes and must retain the same
300 leaves. This does not time the native parser, clipboard IPC, tab dispatch,
real websites, or browser startup.

| Median operation | Before | After |
| --- | ---: | ---: |
| Build structure text/DOM map | 177.6 ms | 63.5 ms |
| Map supplied UTF-16 engine nodes to DOM | 111.6 ms | 68.3 ms |
| Remove redundant provision ancestors | 446.6 ms | 1.6 ms |
| Mapping records for the text fixture | 1,050,892 | 4,000 |

Mapping-record counts are not a measurement of total heap usage. Timings are
workload-specific, not universal speedup claims. `tools/benchmark-pinpointer.cjs`
emits raw observations and verifies output counts. Run against a baseline checkout:

```
npm run benchmark:pinpointer -- /path/to/889eda8-checkout
```

Playwright is an optional external test driver, never an extension dependency.
`CHROME_PATH` and `PLAYWRIGHT_MODULE` select existing installations.

## Implementation

Citation copying/navigation and an unselected popup now request only metadata,
without structure maps, section-body clones or WASM calls. Full structure work
remains on structured quote/pinpoint paths. Metadata and structure caches are
separate; cheap mutation invalidation checks headers as well as document text.
A document change during async copying rejects the stale operation. Pagehide
releases references. Unrelated keys no longer run editable-target selectors.

The internal mapper represents contiguous source runs rather than each character,
merging only when original offsets are contiguous. Normalized text and every
boundary are compared with the retained legacy mapping implementation. A text-only
mode avoids map allocation for Lexis section evidence. The engine bridge maps only
requested Unicode-scalar offsets and uses checked identity conversion for UTF-16,
rather than allocating an array as long as the document. Its native engine is unchanged.

Provision ancestor pruning enumerates ancestor paths once instead of comparing all
pairs. Per-model node positions and anchor lookup maps replace repeated scans and
sorts. Quote formatting tables are reused; the clipboard fallback always removes
its temporary listener. Popup inspection responses are latest-wins and unsupported
copy buttons remain disabled. No permissions, external requests, persistent history,
new runtime dependencies or service-worker keepalive are added.

## Requested citation behavior

Full pinpoints are `at para n`, `at paras n-m`, `s n`, `ss n-m`, and `at n` for
pages (never `at p.` or `at pp.`). Bare mode and secondary-source symbols remain.
Provider metadata/title candidates outrank generic or citation-only headings;
combined legislation titles are separated from their citations even when the
provider also supplies a citation field. Historic CanLII-only citations are
recognized without requiring a neutral citation. Missing names/court routes are
not invented. Literal `[page n]` marker detection now escapes its brackets correctly,
including engine ranges starting at the marker. Body citations are not used as an unbounded identity source.

With no structure but a selected quote, copy outputs `[Link]: selected text`, with
only `[Link]` hyperlinked in rich text and safe inline formatting retained. The
existing current-page clipboard text-fragment precedence remains. With neither
structure nor selected/resolved text, the existing citation-labelled page fallback
remains. Parser failures are not silently represented as successful structure detection.

## Validation actually run

- 3/3 focused Node regressions: formatting, historic/combined citations, and linear
  ancestor filtering compared against the previous pairwise definition.
- 4/4 Chromium regressions: exhaustive compact/legacy boundary comparison (including
  astral characters, collapsed whitespace and hidden nodes); equivalent sparse
  UTF-16/scalar offsets and literal reporter-page boundaries; six case/legislation metadata fixtures spanning CanLII,
  Lexis and Westlaw; parser-free citation copying; `[Link]:` selection fallback;
  unchanged DOM/selection; repeat-copy caching; metadata mutation and stale-copy rejection.
- The fourth Chromium regression executes the existing clipboard fixture with
  its expected paragraph wording updated. Provision indentation, full/partial
  quotes, linked endpoints, text-fragment precedence and secondary sources pass.
- Syntax checks passed for locally present changed JavaScript. The original core
  and browser fixture were hash-checked before applying expected-wording updates.

Provider HTML, engine messages, clipboard writes and the exercised court-route
identities are fixtures, not live integrations. Managed Chromium blocked navigation,
so tests use in-memory HTML. Full packaged WASM, metadata-corpus audit, installed
extension permissions/OS shortcuts, live CanLII (including the exact reported
historical page), Lexis and Westlaw were not verified in this run. The prior Sonar
suite was not re-run in this pass; its runtime files are unchanged.

Design references: Chrome's [security guidance](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure),
[content-script isolation](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts),
[service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle),
and [session storage](https://developer.chrome.com/docs/extensions/reference/api/storage).
A closed shadow root is UI encapsulation, not a blanket confidentiality guarantee.
