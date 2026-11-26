#!/usr/bin/env bash
# Install emsdk at a pinned version: a git clone of the emsdk repo at the release tag (no `emsdk update`, which
# downloads an unpinned archive of emsdk HEAD), then `emsdk install`, with retries for transient network errors.
#   scripts/install-emsdk.sh [version=4.0.10] [dir=$HOME/emsdk]
# Reuses an existing install (e.g. restored by actions/cache). Prints the env file to source; in GitHub Actions it
# also adds emcc to PATH for later steps. (Not named DIR: emsdk_env.sh unsets DIR.)
set -euo pipefail
VERSION="${1:-${EMSDK_VERSION:-4.0.10}}"
EMSDK_TARGET="${2:-$HOME/emsdk}"
if [ ! -x "$EMSDK_TARGET/upstream/emscripten/emcc" ] || [ "$(git -C "$EMSDK_TARGET" describe --tags 2>/dev/null)" != "$VERSION" ]; then
  ok=
  for i in 1 2 3 4; do
    rm -rf "$EMSDK_TARGET"
    if git -c advice.detachedHead=false clone -q --depth 1 --branch "$VERSION" https://github.com/emscripten-core/emsdk "$EMSDK_TARGET" \
      && "$EMSDK_TARGET/emsdk" install "$VERSION"; then
      ok=1; break
    fi
    echo "emsdk install failed (attempt $i), retrying in $((i * 15)) s" >&2
    sleep $((i * 15))
  done
  [ -n "$ok" ] || { echo "emsdk $VERSION could not be installed" >&2; exit 1; }
fi
"$EMSDK_TARGET/emsdk" activate "$VERSION" >/dev/null
# shellcheck disable=SC1091
EMSDK_QUIET=1 source "$EMSDK_TARGET/emsdk_env.sh"
emcc --version | head -1 >&2
# In GitHub Actions, put emcc on PATH for the following steps.
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$EMSDK_TARGET" >> "$GITHUB_PATH"
  echo "$EMSDK_TARGET/upstream/emscripten" >> "$GITHUB_PATH"
  echo "EMSDK=$EMSDK_TARGET" >> "$GITHUB_ENV"
fi
echo "$EMSDK_TARGET/emsdk_env.sh"
