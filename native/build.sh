#!/usr/bin/env bash
# Build the Lua host (native/pobcalc.c + patched Lua 5.2.4 + LuaBitOp + luautf8 + zlib 1.3.1, all vendored in third_party/).
#   native/build.sh native   -> build/native/pobcalc   (gcc; for fast iteration and the compound-assignment spec)
#   native/build.sh wasm     -> dist/engine.mjs + dist/engine.wasm   (emcc; needs emsdk on PATH)
#   native/build.sh          -> both
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build"
TARGET="${1:-all}"

# Pristine Lua 5.2.4 sources (third_party, sha256 of the release tarball b9e2e4aa…69f4b) + our patches.
prepare_lua() {
  rm -rf "$BUILD/lua-src"
  mkdir -p "$BUILD"
  cp -r "$ROOT/third_party/lua-5.2.4/src" "$BUILD/lua-src"
  for p in "$ROOT"/native/patches/*.patch; do
    patch -s --forward -d "$BUILD/lua-src" -p2 < "$p"
  done
}

lua_core_sources() {
  ls "$BUILD"/lua-src/*.c | grep -v -e '/lua\.c$' -e '/luac\.c$'
}

CFLAGS_COMMON=(-DLUA_COMPAT_ALL -I"$BUILD/lua-src" -I"$ROOT/third_party/zlib")
ZLIB_SOURCES=(adler32 crc32 deflate inffast inflate inftrees trees zutil)
EXTRA_SOURCES=("$ROOT/native/pobcalc.c" "$ROOT/third_party/luabitop/bit.c" "$ROOT/third_party/luautf8/lutf8lib.c")
for z in "${ZLIB_SOURCES[@]}"; do EXTRA_SOURCES+=("$ROOT/third_party/zlib/$z.c"); done

build_native() {
  mkdir -p "$BUILD/native"
  # shellcheck disable=SC2046
  gcc -O2 -DLUA_USE_POSIX "${CFLAGS_COMMON[@]}" -o "$BUILD/native/pobcalc" \
    "${EXTRA_SOURCES[@]}" $(lua_core_sources) -lm
  echo "built $BUILD/native/pobcalc"
}

build_wasm() {
  command -v emcc >/dev/null || { echo "emcc not on PATH (source emsdk_env.sh)" >&2; exit 1; }
  mkdir -p "$ROOT/dist"
  # shellcheck disable=SC2046
  emcc -O3 "${CFLAGS_COMMON[@]}" -DLUA_USE_POSIX \
    "${EXTRA_SOURCES[@]}" $(lua_core_sources) \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createPobEngine \
    -sENVIRONMENT=web,worker,node \
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB -sMAXIMUM_MEMORY=4GB \
    -sSTACK_SIZE=8MB \
    -sFORCE_FILESYSTEM=1 -lnodefs.js \
    -sEXPORTED_FUNCTIONS=_pob_boot,_pob_eval,_pob_luaheap \
    -sEXPORTED_RUNTIME_METHODS=FS,ccall,UTF8ToString,HEAPU8 \
    -o "$ROOT/dist/engine.mjs"
  ls -la "$ROOT/dist/engine.mjs" "$ROOT/dist/engine.wasm"
}

prepare_lua
case "$TARGET" in
  native) build_native ;;
  wasm) build_wasm ;;
  all) build_native; build_wasm ;;
  *) echo "unknown target $TARGET" >&2; exit 2 ;;
esac
