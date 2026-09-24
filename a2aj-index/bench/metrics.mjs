// Quality metrics shared by bench.mjs (browser) and quality.mjs (Node).
// run: {id, docIds: ['c:123', ...] (ranked documents), pids (raw passage ranking), shownPids (passages as displayed)}
// evalMap (from the build's --eval-out): case id -> [[pid, start, end], ...]; a case target absent from it is out of scope.
export function quality(queries, runs, evalMap) {
  const byQ = new Map(queries.map(q => [q.id, q])), qual = {};
  for (const r of runs) {
    const q = byQ.get(r.id);
    if (!q.docs || !q.docs.some(k => k.startsWith('l:') || evalMap[k.slice(2)])) continue;
    const g = qual[q.set + ':' + q.type] ||= {n: 0, r20: 0, mrr: 0, pn: 0, r10: 0, s10: 0};
    const rank = r.docIds.slice(0, 20).findIndex(k => q.docs.includes(k));
    g.n++; if (rank >= 0) { g.r20++; g.mrr += 1 / (rank + 1); }
    r.docRank = rank >= 0 ? rank + 1 : null;
    if (q.passage && evalMap[q.passage.doc]) {
      const s = q.passage.start, e = s + q.passage.len, rel = new Set(evalMap[q.passage.doc].filter(([, a, b]) => a < e && b > s).map(x => x[0]));
      const pr = r.pids.slice(0, 10).findIndex(p => rel.has(p)), sr = (r.shownPids || []).slice(0, 10).findIndex(p => rel.has(p));
      g.pn++; if (pr >= 0) g.r10++; if (sr >= 0) g.s10++; r.passageRank = pr >= 0 ? pr + 1 : null;
    }
  }
  for (const g of Object.values(qual)) {
    g['docR@20'] = +(g.r20 / g.n).toFixed(3); g.MRR = +(g.mrr / g.n).toFixed(3);
    if (g.pn) { g['passageR@10'] = +(g.r10 / g.pn).toFixed(3); g['shownPassageR@10'] = +(g.s10 / g.pn).toFixed(3); }
    delete g.r20; delete g.mrr; delete g.r10; delete g.s10;
  }
  return qual;
}
