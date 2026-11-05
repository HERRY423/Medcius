"""Package committed plugin bytes; never include local models or runtime data."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import zipfile


def build(tag, output, ref="HEAD"):
    if not re.fullmatch(r"[vV]\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", tag):
        raise ValueError("RELEASE_TAG_INVALID")
    root = Path(__file__).resolve().parents[1]
    def git(*args):
        return subprocess.check_output(["git", "-C", str(root), *args])
    commit = git("rev-parse", "--verify", f"{ref}^{{commit}}").decode().strip()
    for p in ("plugin.json", ".codex-plugin/plugin.json", ".claude-plugin/plugin.json"):
        manifest = json.loads(git("show", f"{commit}:plugins/medcius/{p}"))
        if manifest["version"] != tag[1:]:
            raise ValueError(f"RELEASE_VERSION_MISMATCH:{p}")
    content = git("archive", "--format=zip", "--prefix=medcius/", f"{commit}:plugins/medcius")
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        names = archive.namelist()
        for name in names:
            p = PurePosixPath(name)
            if p.is_absolute() or ".." in p.parts or not name.startswith("medcius/"):
                raise ValueError("RELEASE_PATH_INVALID")
            if (set(p.parts) & {"node_modules", ".git", "out", "output"}
                    or p.name.startswith(".env")
                    or re.search(r"\.(?:sqlite|db)(?:-wal|-shm|-journal)?$", p.name, re.I)
                    or p.suffix.lower() in {".onnx", ".key", ".pem", ".pfx", ".p12"}):
                raise ValueError(f"RELEASE_FORBIDDEN_ASSET:{name}")
        for required in (".codex-plugin/plugin.json", ".claude-plugin/icon.png",
                         "assets/medcius-icon-128.png", "assets/medcius-icon-512.png",
                         "scripts/codex-mcp-server.mjs", "lib/plugin-version.mjs",
                         "runtimes/cn-phi-ner/package-lock.json"):
            if f"medcius/{required}" not in names:
                raise ValueError(f"RELEASE_ASSET_MISSING:{required}")
        if archive.testzip() is not None:
            raise ValueError("RELEASE_ZIP_CORRUPT")
    dest = Path(output).resolve()
    dest.mkdir(parents=True, exist_ok=True)
    filename = f"medcius-{tag}.zip"
    (dest / filename).write_bytes(content)
    digest = hashlib.sha256(content).hexdigest()
    (dest / "SHA256SUMS.txt").write_text(f"{digest}  {filename}\n", encoding="utf-8")
    receipt = {"tag": tag, "commit": commit, "archive": filename, "sha256": digest,
               "bytes": len(content), "entries": len(names), "models_bundled": False}
    (dest / "release-manifest.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", required=True)
    parser.add_argument("--output", default="output/release")
    parser.add_argument("--ref", default="HEAD")
    args = parser.parse_args()
    build(args.tag, args.output, args.ref)
