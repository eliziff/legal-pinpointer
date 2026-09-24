# Tab Sonar speed work (in progress; delete when done)

Goal: warm first results < 50 ms and reranked < 500 ms at 4x CPU throttle; R@10 >= 0.80.

## Done
- Read code; plan: in-panel index worker (sonar-index.js), SONAR_UNITS/SONAR_ISSUE in broker,
  page units()/handle validation by unit text hash, smaller cross-encoder, windowed batched rerank.

## Next
- Download L4/L2/TinyBERT int8; offline quality table (node); WASM speed bench 1x/4x.
- Implement, test, extension eval 30/60 tabs at 1x/4x, FIND.md.

## Commands
- heavy: python $SCRATCH/heavy.py "<label>" -- <cmd>
- eval: $SCRATCH/sonar-rank/eval-fast.cjs (new), tables-fast.cjs
