"""Build canlii-case-aliases.tsv.gz: reporter/alias citation identity key -> CanLII case target.

Sources (local, read-only):
  The engine's alias table (common-law-cite crates/legal-citations/registry/aliases.json): every citation key of a
                           decision -> the decision's head citation (`targets`)
  A2AJ document metadata (providers/a2aj/a2aj.sqlite): pre-neutral canonical citation -> name + decision date
  CanLII case metadata   (ALR-Quote-Verifier data/canlii_db/canlii.db): databaseId, caseId, title

Targets are either a neutral citation (resolved at runtime by the exact court-route table) or
`jurisdiction/database/caseId`: for a decision the table knows by its CanLII identifier, that document; for a
pre-neutral case, the one matched uniquely by court, decision year and normalized style of cause. A key whose
decision reaches two targets, and ambiguous or unmatched cases, are omitted (abstain).

Usage: python tools/build-canlii-case-aliases.py <aliases.json> <a2aj.sqlite> <canlii.db>
"""
import gzip
import hashlib
import json
import re
import sqlite3
import sys
import unicodedata

from legal_citations import extract, key_for_text, registry
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
aliases_path, a2aj_path, canlii_path = sys.argv[1:4]

# Reuse the engine's court routes; duplicate surfaces with conflicting routes
# cannot authorize a derived CanLII target.
routes = {}
route_conflicts = set()
for court in registry("courts"):
    for index, code in enumerate(court.get("neutral", [])):
        route = (court.get("canlii_fr") if index % 2 else None) or court.get("canlii")
        if not route or code in route_conflicts:
            continue
        value = f"{route['jurisdiction']}/{route['database']}"
        if code in routes and routes[code] != value:
            route_conflicts.add(code)
            routes.pop(code)
        else:
            routes[code] = value


def name_key(name):
    text = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower()
    text = re.sub(r"\b(?:the|la|le|les|l|of|de|du|des|et|and|inc|ltd|ltee|limited|co|corp|corporation|company)\b", " ", text)
    text = re.sub(r"\b(?:v|c|vs)\b", " v ", text)
    return re.sub(r"[^a-z0-9]", "", text)


def neutral(citation):
    readings = extract(citation, resolve=False, parallel=False)
    return (readings[0] if len(readings) == 1 and readings[0].get("format") == "neutral"
            and readings[0].get("key") else None)

# CanLII cases indexed by (database, year, normalized name), and the databases each case id is in.
canlii = {}
canlii_databases = set()
case_databases = {}
for database, case_id, title in sqlite3.connect(canlii_path).execute("select databaseId, caseId, title from cases"):
    canlii_databases.add(database)
    canlii.setdefault((database, case_id[:4], name_key(title)), []).append(case_id)
    case_databases.setdefault(case_id, set()).add(database)


def canlii_database(path_database):
    """CanLII's internal database id ('csc-scc') for a URL route database ('scc')."""
    if path_database in canlii_databases:
        return path_database
    pairs = [d for d in canlii_databases if len(d.split("-")) == 2 and path_database in d.split("-")]
    return pairs[0] if len(pairs) == 1 else ""


# A CanLII database id's URL route ('csc-scc' -> 'ca/scc'), where one route alone names it.
route_of = {}
for route in set(routes.values()):
    if internal := canlii_database(route.split("/")[1]):
        route_of[internal] = route if route_of.get(internal, route) == route else ""


def canlii_document(key):
    """The CanLII document a CanLII identifier key ('4:canlii:1992:66') names, where its case id is in one routed database."""
    parts = key.split(":")
    if len(parts) != 4 or parts[1] != "canlii":
        return ""
    case_id = f"{parts[2]}canlii{parts[3]}"
    databases = case_databases.get(case_id, set())
    route = route_of.get(next(iter(databases)), "") if len(databases) == 1 else ""
    return f"{route}/{case_id}" if route else ""

a2aj = sqlite3.connect(a2aj_path)
pre_neutral = {}
for dataset, citation, name, date in a2aj.execute(
        "select dataset, citation_en, name_en, document_date_en from document where doc_type='cases' and citation_en like '[%'"):
    pre_neutral[citation] = (dataset, name, (date or "")[:4])


def canlii_target(canonical):
    if reading := neutral_citations.get(canonical):
        return canonical if reading["fields"].get("series") in routes else ""
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
table = json.loads(Path(aliases_path).read_text(encoding="utf8"))
# Each decision's keys, by its head key, with the head's citation.
decisions = {}
for key, target in table["targets"].items():
    decisions.setdefault(target["key"], (target["citation"], set()))[1].update((key, target["key"]))
resolved_aliases = [(key, citation) for citation, keys in decisions.values() for key in keys]
canonicals = {citation for citation, _ in decisions.values()} | set(pre_neutral)
neutral_citations = {canonical: reading for canonical in canonicals if (reading := neutral(canonical))}
targets = {canonical: canlii_target(canonical) for canonical in canonicals}


def add(k, target):
    if not k or not target or k in conflicts:
        return
    if k in rows and rows[k] != target:
        conflicts.add(k)
        rows.pop(k)
        return
    rows[k] = target


for canonical, target in targets.items():
    if canonical not in neutral_citations:
        add(key_for_text(canonical, resolve=False, parallel=False), target)
for identity, canonical in resolved_aliases:
    add(identity, targets.get(canonical, ""))
# A decision the table knows by its CanLII identifier is that document, unless its neutral citation routes it; two
# documents, or the one matched by its style of cause, disagreeing, it abstains.
for citation, keys in decisions.values():
    if citation in neutral_citations and targets[citation]:
        continue
    for document in {document for key in keys if (document := canlii_document(key))}:
        for key in keys:
            add(key, document)

body = "".join(f"{k}\t{rows[k]}\n" for k in sorted(rows))
digest = hashlib.sha256(body.encode()).hexdigest()
version = key_for_text("2016 SCC 27", resolve=False, parallel=False).split(":")[0]
(ROOT / "canlii-case-aliases.tsv.gz").write_bytes(gzip.compress(
    f"# legal-pinpointer-canlii-case-aliases-v{version}\tsha256={digest}\n{body}".encode("utf8"), compresslevel=9))
resolved_pre = sum(1 for c, t in targets.items() if c not in neutral_citations and t)
print(f"decisions={len(decisions)} keys={len(rows)} conflicts={len(conflicts)} pre-neutral resolved={resolved_pre}/{len(pre_neutral)}")
