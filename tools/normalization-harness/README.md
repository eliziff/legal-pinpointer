# Cloud normalization source preservation

This review branch preserves the retained normalization changes and the shared
evaluator/gate source. It is not a release or a claim of integration readiness.
Zero tests, model calls, or corpus evaluations were run for this branch handoff.

The implementation and unit-test changes in `lens/src/core.mjs` and
`lens/test/core.test.mjs` are the retained cloud changes, based on commit
`bf911d2e0bde3b692822d99c2d22b87e99411fa0`. The related OCR changes are preserved on
`integration/cloud-normalization` in `eliziff/legal-browser-ocr`, based on
`edcd860be5066ba4dbdf7f9e25f3008494ea9a83`. No merge into either main branch is part
of this handoff.

## Included source

- `evaluation/evaluate.py` and `evaluation/runner.mjs`: exact-output scoring and
  the Node bridge for the two repositories.
- `attempts/accept.py`: strict improvement and prior-success retention gate.
- `attempts/run-gates.py`: source for the syntax/unit gate runner; not executed.
- `attempts/record.py`: source for the local attempt ledger and snapshots.
- `inventory/existing-node-packages.mjs`: resolver for already-installed packages.

These are retained source copies. The only sanitation edits replace the dated
run identifier in `run-gates.py` and `record.py` with `NORMALIZATION_RUN_ID`,
defaulting to `machine_test-local`. A future run should supply its own identifier.
The retained implementation/test bytes are unchanged by this handoff.

## Unfinished portability

This directory is not a standalone runnable evaluation suite. The source still
assumes the former adjacent workspace/repository layout and omitted baseline
receipts. The evaluator requires an omitted `freeze.json` and fixture files; its
freeze verifier checks all manifest entries, including sealed entries, even for
a development run. The gate and ledger scripts write output files and snapshots.
The package resolver also requires compatible Node module hooks and installed
packages. No path adaptation, dependency setup, or fresh validation is claimed.

Before reuse, the integrator must separately define a public harness scope,
configure source/output locations, supply independently approved expectations,
and version/rebaseline that suite. Do not recover or publish excluded data just
to satisfy the old source assumptions. Keep any future generated data and logs
outside tracked source.

No original/private documents, corpus or extraction fixtures, gold/sealed data,
raw logs, credentials, signed URLs, binaries, caches, source snapshots, or
superseded candidates are included. Embedded unit/self-check strings are
independently invented synthetic probes. No Authorities/ALR work is included.

Known retained limits include ambiguity between decimal measurements and dotted
section labels, scalar-safe windows that can split combining sequences, and a
one-unit window budget emitting a two-unit supplementary scalar intact. This
branch preserves work for review; it does not resolve those semantic limits.
