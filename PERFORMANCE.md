# Tab Sonar performance and lifecycle review

## Measured comparison

Baseline: commit `60cb0a935942eb9e03e55e98d9182f6af4edabf0` (0.1.26).
Candidate: the 0.1.27 runtime in this commit. Run on Chromium 144.0.7559.96,
Node 22.16.0, in the task's Linux container on 2026-09-12 UTC.

`tools/benchmark-sonar.cjs` creates 6,000 fictional paragraphs, 1,699,050 text
characters, and 60 paragraphs containing both privilege and waiver. Five paired
runs alternate variant order. Each fresh page performs seven alternating
zero-hit/60-hit queries. Baseline releases its index between queries, matching
its broker; candidate retains it. Counts are asserted identical.

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Median cold search (5 observations) | 220.9 ms | 209.8 ms |
| Median repeat search (30 observations) | 144.0 ms | 15.2 ms |
| Median 300 highlight-only passage moves (5 observations) | 258.3 ms | 51.5 ms |
| Cold getComputedStyle calls (each trial) | 12,061 | 6,001 |
| Additional calls across six repeat queries (each trial) | 72,366 | 0 |
| Same all-hits Highlight and stylesheet reused while moving | No | Yes |

This is about 9.5x faster repeat search and 5.0x faster highlight-only navigation
in this workload, not a universal speedup claim. Cold timings are similar.
The benchmark measures foreground renderer work, excludes IPC, tab activation,
scroll layout and OS shortcuts, and does not establish all-tab end-to-end latency,
background-tab timing, memory in megabytes, or performance on real provider pages.
There are no flaky wall-clock thresholds in regression tests. The benchmark emits
all raw observations as JSON and checks result equivalence.

## Changes that matter

Previously every new query disposed the DOM index, each passage move recreated
all highlights/stylesheets, and Boolean failure still allocated term hit arrays.
Now valid indexes and sentence boundaries survive new queries; native style reads
are cached per pass; highlights are created lazily and reused; Boolean existence
checks precede bounded, source-ordered range enumeration.

DOM traversal uses depth-sized child iterators, matching and sentence iteration
yield cooperatively, and pathological units are skipped whole rather than split.
The broker stops launching batches when result/text budgets are met instead of
searching every tab and discarding excess results afterwards. Only compact
navigation handles enter RAM session storage; full preview text does not.

Per-session serialized state transitions prevent delayed storage writes or stale
Close messages overwriting newer searches. Cancellation reaches page jobs, including
superseded scans and close during injection. Targets are registered before work
starts for cleanup after a worker restart. Injected calls return explicit
success/error envelopes, including valid void-returning operations such as restore.
A warm probe preserves module instances while checking the current document ID.
Ordinary scrolling no longer carries a non-passive Sonar wheel listener: it is
installed only during Alt scrubbing and removed on release, blur, or close.

## Validation for this revision

- 18/18 Node matcher/broker tests passed. These include exact scopes, sender and
  result validation, closed/navigated/regrouped tabs, restart, return, cancellation,
  delayed storage, late injection, compact handles, and 40-tab budget/concurrency tests.
- 2/2 Chromium regressions passed using the actual page/UI/matcher/broker, with
  Chrome tab and permission APIs simulated. Includes original controls, all scopes,
  Alt-wheel, return/scroll restoration, open shadows, exact inline ranges, DOM
  preservation, zero extra warm style reads, stylesheet reuse, mutation revalidation,
  cancellation without cache resurrection, whole-unit limits, and clean close.
- Relevant JavaScript syntax checks passed. Permission/host/CSP configuration is
  unchanged apart from the version number; no runtime dependency is added.
- A native MV3 harness launch was attempted but its service worker did not start
  in this environment. This is not counted as a passing native extension test.

The complete legacy parser/WASM/metadata/clipboard suite and live providers were
not run: a complete checkout/binary assets were unavailable. OS shortcut dispatch,
actual extension permission prompts, native tab IPC/group APIs, background-tab
throttling, and idle worker termination still require installed-extension validation.
The code intentionally does not rely on keeping its service worker alive.

## Design references

- [Chrome service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle): allow termination; do not rely on globals for durable navigation state.
- [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage): extension-private session storage, not persistent query history.
- [Chrome messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging): validate inputs and keep explicit async response contracts.
- [Chrome extension security](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure): constrain privileges/messages and avoid inserting untrusted HTML.
- [Optimize long tasks](https://web.dev/articles/optimize-long-tasks): cooperative yielding rather than long main-thread monopolies.
