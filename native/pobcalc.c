/*
 * pobcalc: the Lua host for Path of Building 2's calc engine.
 *
 * Embeds PUC Lua 5.2.4 (patched for compound assignment, see native/patches) and the native
 * modules PoB needs headless:
 *   bit       LuaBitOp 1.0.2, installed as the global `bit` (LuaJIT's API and signed 32-bit results)
 *   lua-utf8  luautf8 0.1.6, via package.preload
 *   pobhost   chdir/getcwd, zlib inflate/deflate, a monotonic clock
 * The `jit` stub and everything else headless lives in Lua (lua/headless.lua).
 *
 * The same file builds two ways:
 *   native (gcc):  pobcalc <script.lua> [args...]   runs a script with `arg` set, like lua.c
 *   wasm (emcc):   exports pob_boot / pob_eval / pob_heap for JS (no main is run)
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <zlib.h>

#include "lauxlib.h"
#include "lua.h"
#include "lualib.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#include <emscripten/heap.h>
#define POB_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define POB_EXPORT
#endif

LUALIB_API int luaopen_bit(lua_State *L);
LUALIB_API int luaopen_utf8(lua_State *L);

/* ---- pobhost ---------------------------------------------------------------------------- */

static int h_chdir(lua_State *L) {
  const char *p = luaL_checkstring(L, 1);
  if (chdir(p) != 0) {
    lua_pushnil(L);
    lua_pushstring(L, strerror(errno));
    return 2;
  }
  lua_pushboolean(L, 1);
  return 1;
}

static int h_getcwd(lua_State *L) {
  char buf[4096];
  if (!getcwd(buf, sizeof buf)) return luaL_error(L, "getcwd: %s", strerror(errno));
  lua_pushstring(L, buf);
  return 1;
}

/* Milliseconds from a monotonic clock, as a double. */
static int h_now(lua_State *L) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  lua_pushnumber(L, (lua_Number)ts.tv_sec * 1000.0 + (lua_Number)ts.tv_nsec / 1e6);
  return 1;
}

/* inflate(data) -> string | nil, err. Accepts zlib or gzip streams (auto-detected), like SimpleGraphic. */
static int h_inflate(lua_State *L) {
  size_t inLen;
  const char *in = luaL_checklstring(L, 1, &inLen);
  z_stream zs;
  luaL_Buffer b;
  int ret;
  memset(&zs, 0, sizeof zs);
  if (inflateInit2(&zs, 15 + 32) != Z_OK) {
    lua_pushnil(L);
    lua_pushstring(L, "inflateInit2 failed");
    return 2;
  }
  zs.next_in = (Bytef *)in;
  zs.avail_in = (uInt)inLen;
  luaL_buffinit(L, &b);
  do {
    char *out = luaL_prepbuffsize(&b, 65536);
    zs.next_out = (Bytef *)out;
    zs.avail_out = 65536;
    ret = inflate(&zs, Z_NO_FLUSH);
    if (ret != Z_OK && ret != Z_STREAM_END) {
      const char *msg = zs.msg ? zs.msg : "inflate failed";
      inflateEnd(&zs);
      lua_pushnil(L);
      lua_pushstring(L, msg);
      return 2;
    }
    luaL_addsize(&b, 65536 - zs.avail_out);
    if (ret == Z_OK && zs.avail_in == 0 && zs.avail_out != 0) break; /* truncated input */
  } while (ret != Z_STREAM_END);
  inflateEnd(&zs);
  luaL_pushresult(&b);
  return 1;
}

/* deflate(data, isGzip) -> string | nil, err */
static int h_deflate(lua_State *L) {
  size_t inLen;
  const char *in = luaL_checklstring(L, 1, &inLen);
  int gzip = lua_toboolean(L, 2);
  z_stream zs;
  luaL_Buffer b;
  int ret;
  memset(&zs, 0, sizeof zs);
  if (deflateInit2(&zs, Z_BEST_COMPRESSION, Z_DEFLATED, gzip ? 15 + 16 : 15, 8, Z_DEFAULT_STRATEGY) != Z_OK) {
    lua_pushnil(L);
    lua_pushstring(L, "deflateInit2 failed");
    return 2;
  }
  zs.next_in = (Bytef *)in;
  zs.avail_in = (uInt)inLen;
  luaL_buffinit(L, &b);
  do {
    char *out = luaL_prepbuffsize(&b, 65536);
    zs.next_out = (Bytef *)out;
    zs.avail_out = 65536;
    ret = deflate(&zs, Z_FINISH);
    if (ret == Z_STREAM_ERROR) {
      deflateEnd(&zs);
      lua_pushnil(L);
      lua_pushstring(L, "deflate failed");
      return 2;
    }
    luaL_addsize(&b, 65536 - zs.avail_out);
  } while (ret != Z_STREAM_END);
  deflateEnd(&zs);
  luaL_pushresult(&b);
  return 1;
}

/* Bytes of linear memory the host has (wasm heap size; 0 natively). */
static int h_heap(lua_State *L) {
#ifdef __EMSCRIPTEN__
  lua_pushnumber(L, (lua_Number)emscripten_get_heap_size());
#else
  lua_pushnumber(L, 0);
#endif
  return 1;
}

static const luaL_Reg host_funcs[] = {
  {"chdir", h_chdir},     {"getcwd", h_getcwd},   {"now", h_now},
  {"inflate", h_inflate}, {"deflate", h_deflate}, {"heap", h_heap},
  {NULL, NULL}
};

static int luaopen_pobhost(lua_State *L) {
  luaL_newlib(L, host_funcs);
#ifdef __EMSCRIPTEN__
  lua_pushstring(L, "wasm");
#else
  lua_pushstring(L, "native");
#endif
  lua_setfield(L, -2, "platform");
  return 1;
}

/* ---- state setup ------------------------------------------------------------------------ */

static void preload(lua_State *L, const char *name, lua_CFunction f) {
  luaL_getsubtable(L, LUA_REGISTRYINDEX, "_PRELOAD");
  lua_pushcfunction(L, f);
  lua_setfield(L, -2, name);
  lua_pop(L, 1);
}

static lua_State *newstate(void) {
  lua_State *L = luaL_newstate();
  if (!L) return NULL;
  luaL_openlibs(L);
  /* LuaJIT exposes `bit` as a global without require; PoB relies on that. */
  luaL_requiref(L, "bit", luaopen_bit, 1);
  lua_pop(L, 1);
  luaL_requiref(L, "pobhost", luaopen_pobhost, 1);
  lua_pop(L, 1);
  preload(L, "lua-utf8", luaopen_utf8);
  return L;
}

static int traceback(lua_State *L) {
  const char *msg = lua_tostring(L, 1);
  if (msg)
    luaL_traceback(L, L, msg, 1);
  else if (!lua_isnoneornil(L, 1)) {
    if (!luaL_callmeta(L, 1, "__tostring")) lua_pushliteral(L, "(no error message)");
  }
  return 1;
}

/* ---- wasm API --------------------------------------------------------------------------- */

static lua_State *gL = NULL;
static char *gResult = NULL;

/* Create the Lua state. Returns 0 on success. */
POB_EXPORT int pob_boot(void) {
  if (gL) return 0;
  gL = newstate();
  return gL ? 0 : 1;
}

/*
 * Run `chunk` (Lua source) with `arg` as its one string argument; return its first result as a
 * string. On error the returned string starts with "\x01" followed by the message and traceback.
 * The returned pointer stays valid until the next call.
 */
POB_EXPORT const char *pob_eval(const char *chunk, const char *arg) {
  size_t len;
  const char *s;
  int base;
  if (!gL && pob_boot() != 0) return "\x01" "cannot create Lua state";
  free(gResult);
  gResult = NULL;
  base = lua_gettop(gL);
  lua_pushcfunction(gL, traceback);
  if (luaL_loadbuffer(gL, chunk, strlen(chunk), "=pob_eval") != LUA_OK) {
    s = lua_tolstring(gL, -1, &len);
  } else {
    lua_pushstring(gL, arg ? arg : "");
    if (lua_pcall(gL, 1, 1, base + 1) != LUA_OK) {
      s = lua_tolstring(gL, -1, &len);
    } else {
      s = luaL_tolstring(gL, -1, &len);
      gResult = (char *)malloc(len + 1);
      if (gResult) memcpy(gResult, s, len + 1);
      lua_settop(gL, base);
      return gResult ? gResult : "\x01" "out of memory";
    }
  }
  /* error path */
  gResult = (char *)malloc(len + 2);
  if (gResult) {
    gResult[0] = '\x01';
    memcpy(gResult + 1, s ? s : "", len + 1);
  }
  lua_settop(gL, base);
  return gResult ? gResult : "\x01" "out of memory";
}

/* Lua heap in bytes (collectgarbage("count") * 1024). */
POB_EXPORT double pob_luaheap(void) {
  if (!gL) return 0;
  return (double)lua_gc(gL, LUA_GCCOUNT, 0) * 1024.0 + (double)lua_gc(gL, LUA_GCCOUNTB, 0);
}

/* ---- native CLI ------------------------------------------------------------------------- */

#ifndef __EMSCRIPTEN__
int main(int argc, char **argv) {
  lua_State *L;
  int i, status;
  if (argc < 2) {
    fprintf(stderr, "usage: %s script.lua [args...]\n", argv[0]);
    return 2;
  }
  L = newstate();
  if (!L) {
    fprintf(stderr, "cannot create Lua state\n");
    return 1;
  }
  lua_createtable(L, argc, 1);
  for (i = 0; i < argc; i++) {
    lua_pushstring(L, argv[i]);
    lua_rawseti(L, -2, i - 1);
  }
  lua_setglobal(L, "arg");
  lua_pushcfunction(L, traceback);
  status = luaL_loadfile(L, argv[1]);
  if (status == LUA_OK) {
    for (i = 2; i < argc; i++) lua_pushstring(L, argv[i]);
    status = lua_pcall(L, argc - 2, 0, 1);
  }
  if (status != LUA_OK) {
    fprintf(stderr, "%s\n", lua_tostring(L, -1));
    lua_close(L);
    return 1;
  }
  lua_close(L);
  return 0;
}
#endif
