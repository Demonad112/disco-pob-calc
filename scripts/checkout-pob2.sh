#!/usr/bin/env bash
# Check out vendor/pob2 at the commit this repo pins, with only the calc files (sparse + blobless).
# The full fork is ~400 MB, almost all tree art; this fetches ~40 MB. Used by CI; works locally too.
#   --specs  also check out PoB2's spec/ (for scripts/pob-specs.sh)
set -euo pipefail
SPECS=0
[ "${1:-}" = "--specs" ] && SPECS=1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
URL="$(git config -f .gitmodules submodule.vendor/pob2.url)"
SHA="$(git ls-tree HEAD vendor/pob2 | awk '{print $3}')"
[ -n "$SHA" ] || { echo "vendor/pob2 is not a submodule at HEAD" >&2; exit 1; }
if [ -e vendor/pob2/.git ] && [ "$(git -C vendor/pob2 rev-parse HEAD 2>/dev/null)" = "$SHA" ]; then
  [ "$SPECS" = 1 ] && git -C vendor/pob2 sparse-checkout add '/spec/'
  echo "vendor/pob2 already at $SHA"; exit 0
fi
rm -rf vendor/pob2
git init -q vendor/pob2
cd vendor/pob2
git remote add origin "$URL"
git sparse-checkout set --no-cone \
  '/src/*.lua' '/src/Modules/' '/src/Classes/' '/src/Data/**/*.lua' \
  '/src/TreeData/*/tree.lua' '/src/TreeData/legion/*.lua' '/runtime/lua/' '/manifest.xml' '/LICENSE.md'
for i in 1 2 3 4; do
  git fetch -q --depth 1 --filter=blob:none origin "$SHA" && break
  echo "fetch failed, retrying in $((i * 5)) s" >&2; sleep $((i * 5))
done
[ "$SPECS" = 1 ] && git sparse-checkout add '/spec/'
git checkout -q FETCH_HEAD
echo "vendor/pob2 at $(git rev-parse --short HEAD): $(grep -o 'Version number="[^"]*"' manifest.xml)"
