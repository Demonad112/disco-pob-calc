#!/usr/bin/env bash
# Package dist/ for sites that serve the engine from their own origin (upgraded-disco-companion pins one by sha256).
#   scripts/release-tarball.sh [dist=dist] [outDir=release]
# Writes <outDir>/pob-calc-<pinCommit>.tar.gz (runtime files only, no demo page) and its .sha256. The tarball is
# reproducible from the same dist/: sorted names, mtime 0, owner 0, gzip without a name or timestamp.
set -euo pipefail
DIST="${1:-dist}"
OUT="${2:-release}"
PIN="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).pinCommit || "")' "$DIST/manifest.json")"
[ -n "$PIN" ] || { echo "$DIST/manifest.json has no pinCommit" >&2; exit 1; }
mkdir -p "$OUT"
NAME="pob-calc-$PIN.tar.gz"
tar -C "$DIST" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  --exclude=index.html --exclude=demo.js --exclude=demo.css --exclude=sample-code.txt --exclude=.nojekyll \
  -cf - . | gzip -9 -n > "$OUT/$NAME"
( cd "$OUT" && sha256sum "$NAME" > "$NAME.sha256" )
cat "$OUT/$NAME.sha256"
