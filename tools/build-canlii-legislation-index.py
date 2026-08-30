from __future__ import annotations

import argparse
import hashlib
import os
import sqlite3
import tempfile
from pathlib import Path


TYPE_PATH = {
    "STATUTE": "stat",
    "REGULATION": "regu",
    "ANNUAL_STATUTE": "astat",
    "REVISED_STATUTE": "hstat",
    "CONSTITUTION": "const",
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the packaged CanLII legislation metadata index.")
    parser.add_argument("database", type=Path, help="Path to the local canlii.db snapshot.")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "canlii-legislation.tsv",
    )
    args = parser.parse_args()
    database = args.database.resolve(strict=True)
    output = args.output.resolve()

    print(f"Hashing {database} ...", flush=True)
    with database.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
    rows = connection.execute(
        """
        SELECT databaseId, legislationId, title, type
        FROM legislation
        ORDER BY legislationId,
          CASE type
            WHEN 'STATUTE' THEN 0
            WHEN 'REGULATION' THEN 1
            WHEN 'REVISED_STATUTE' THEN 2
            WHEN 'CONSTITUTION' THEN 3
            WHEN 'ANNUAL_STATUTE' THEN 4
            ELSE 5
          END
        """
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent, text=True)
    count = 0
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as target:
            target.write(f"# legal-pinpointer-canlii-legislation-v1\tsha256={digest}\n")
            for database_id, legislation_id, title, document_type in rows:
                if document_type not in TYPE_PATH:
                    continue
                legislation_id = str(legislation_id).translate(str.maketrans("‐‑‒–—", "-----"))
                safe_title = " ".join(str(title or "").split())
                target.write(f"{legislation_id}\t{database_id}\t{TYPE_PATH[document_type]}\t{safe_title}\n")
                count += 1
        os.replace(temporary_name, output)
    finally:
        connection.close()
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)
    print(f"Wrote {count:,} records to {output}", flush=True)


if __name__ == "__main__":
    main()
