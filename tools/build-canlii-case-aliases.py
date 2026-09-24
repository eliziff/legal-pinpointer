"""Build canlii-case-aliases.tsv: reporter/alias citation key -> CanLII case target.

Sources (local, read-only):
  A2AJ reporter aliases  (ALR-Quote-Verifier data/a2aj_reporter_aliases.json): alias -> canonical citation
  A2AJ document metadata (providers/a2aj/a2aj.sqlite): pre-neutral canonical citation -> name + decision date
  CanLII case metadata   (ALR-Quote-Verifier data/canlii_db/canlii.db): databaseId, caseId, title

Targets are either a neutral citation (resolved at runtime by the exact court-route table) or
`jurisdiction/database/caseId` for pre-neutral cases matched uniquely by court, decision year and
normalized style of cause. Ambiguous or unmatched cases are omitted (abstain).

Usage: python tools/build-canlii-case-aliases.py <aliases.json> <a2aj.sqlite> <canlii.db>
"""
import hashlib
import json
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
aliases_path, a2aj_path, canlii_path = sys.argv[1:4]

routes = dict(re.findall(r"'([A-Z0-9-]+)': '([a-z]{2}/[a-z0-9-]+)'", (ROOT / "canlii-courts.js").read_text(encoding="utf8")))


def key(citation):
    """Must match core.citationKey."""
    text = unicodedata.normalize("NFKD", citation).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]", "", text)


def name_key(name):
    text = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower()
    text = re.sub(r"\b(?:the|la|le|les|l|of|de|du|des|et|and|inc|ltd|ltee|limited|co|corp|corporation|company)\b", " ", text)
    text = re.sub(r"\b(?:v|c|vs)\b", " v ", text)
    return re.sub(r"[^a-z0-9]", "", text)


NEUTRAL = re.compile(r"^(\d{4}) ([A-Z][A-Z0-9-]+) (\d+)$")

# CanLII cases indexed by (database, year, normalized name).
canlii = {}
canlii_databases = set()
for database, case_id, title in sqlite3.connect(canlii_path).execute("select databaseId, caseId, title from cases"):
    canlii_databases.add(database)
    canlii.setdefault((database, case_id[:4], name_key(title)), []).append(case_id)


def canlii_database(path_database):
    """CanLII's internal database id ('csc-scc') for a URL route database ('scc')."""
    if path_database in canlii_databases:
        return path_database
    pairs = [d for d in canlii_databases if len(d.split("-")) == 2 and path_database in d.split("-")]
    return pairs[0] if len(pairs) == 1 else ""

a2aj = sqlite3.connect(a2aj_path)
pre_neutral = {}
for dataset, citation, name, date in a2aj.execute(
        "select dataset, citation_en, name_en, document_date_en from document where doc_type='cases' and citation_en like '[%'"):
    pre_neutral[citation] = (dataset, name, (date or "")[:4])


def canlii_target(canonical):
    if NEUTRAL.match(canonical):
        code = NEUTRAL.match(canonical).group(2)
        return canonical if code in routes else ""
    record = pre_neutral.get(canonical)
    if not record or record[0] not in routes:
        return ""
    dataset, name, year = record
    jurisdiction, database = routes[dataset].split("/")
    internal = canlii_database(database)
    hits = set()
    for delta in (0, -1, 1):
        if not year:
            break
        hits.update(canlii.get((internal, str(int(year) + delta), name_key(name)), []))
    return f"{jurisdiction}/{database}/{hits.pop()}" if len(hits) == 1 else ""


rows = {}
conflicts = set()
aliases = json.loads(Path(aliases_path).read_text(encoding="utf8"))["aliases"]
canonicals = {alias["canonical_citation"] for alias in aliases.values()} | set(pre_neutral)
targets = {canonical: canlii_target(canonical) for canonical in canonicals}


def add(citation, target):
    k = key(citation)
    if not k or not target or k in conflicts:
        return
    if k in rows and rows[k] != target:
        conflicts.add(k)
        rows.pop(k)
        return
    rows[k] = target


for canonical, target in targets.items():
    if not NEUTRAL.match(canonical):
        add(canonical, target)
for alias in aliases.values():
    add(alias["alias"], targets.get(alias["canonical_citation"], ""))

body = "".join(f"{k}\t{rows[k]}\n" for k in sorted(rows))
digest = hashlib.sha256(body.encode()).hexdigest()
(ROOT / "canlii-case-aliases.tsv").write_text(f"# legal-pinpointer-canlii-case-aliases-v1\tsha256={digest}\n{body}", encoding="utf8", newline="\n")
resolved_pre = sum(1 for c, t in targets.items() if not NEUTRAL.match(c) and t)
print(f"aliases={len(aliases)} keys={len(rows)} conflicts={len(conflicts)} pre-neutral resolved={resolved_pre}/{len(pre_neutral)}")
