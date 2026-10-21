"""Package the main browser extension and verify the actual archive."""
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile


root = Path(__file__).resolve().parents[1]
output = root / "dist"
output.mkdir(exist_ok=True)
target = output / "legal-pinpointer.zip"
temporary = target.with_suffix(".zip.tmp")
tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
names = sorted(name for name in tracked if name and "/" not in name and (
    Path(name).suffix in {".js", ".mjs", ".html", ".css", ".gz", ".txt"}
    or name in {"manifest.json", "THIRD_PARTY_NOTICES.md"}
))
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
assert manifest["version"] == json.loads((root / "package.json").read_text())["version"]
required = {
    "manifest.json", "THIRD_PARTY_NOTICES.md", "legal-citations-LICENSE.txt",
    "legal-citations-NOTICE.txt", "legal-structure.wasm.gz",
    "canlii-legislation.tsv.gz", "canlii-case-aliases.tsv.gz", "case-court-sites.tsv.gz",
    manifest["background"]["service_worker"], manifest["action"]["default_popup"],
    manifest["side_panel"]["default_path"],
}
for content in manifest["content_scripts"]:
    required.update(content.get("js", []))
    required.update(content.get("css", []))
assert required <= set(names), f"Missing extension assets: {required - set(names)}"
try:
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in names:
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, (root / name).read_bytes(), compresslevel=9)
    with zipfile.ZipFile(temporary) as archive:
        assert archive.testzip() is None
        assert archive.namelist() == names
        for name in names:
            data = archive.read(name)
            assert data == (root / name).read_bytes(), f"Archive differs from source: {name}"
            if name.endswith(".gz"):
                data = gzip.decompress(data)
            assert not re.search(rb"(?:[A-Za-z]:[\\/](?:Users|home)[\\/]|/(?:Users|home)/[A-Za-z])", data), f"Personal path in {name}"
    temporary.replace(target)
finally:
    temporary.unlink(missing_ok=True)
digest = hashlib.sha256(target.read_bytes()).hexdigest()
(output / "SHA256SUMS").write_text(f"{digest}  {target.name}\n", encoding="utf-8")
print(json.dumps({"version": manifest["version"], "files": len(names), "bytes": target.stat().st_size, "sha256": digest}))
