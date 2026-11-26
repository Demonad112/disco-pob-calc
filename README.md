# disco-pob-calc

Path of Building 2's own calc engine, running fully in the browser: PoB2's Lua (unmodified, pinned) on PUC Lua 5.2.4 compiled to WebAssembly. No server and no paid service; it's hosted on GitHub Pages.

**Demo:** https://demonad112.github.io/disco-pob-calc/ (paste a PoB2 code, or press *Load sample code*)

Status: prototype. It reproduces PoB2 v0.23.1 exactly for the reference build: TotalDPS 186,706, and all 109 stats, 107 PlayerStats and 21 skill-group rows of the LuaJIT oracle, with 0 mismatches at 1e-9 relative tolerance.

## Numbers

Measured on this repo's build (source packs, emsdk 4.0.10). Chromium is headless Playwright on a cloud Linux VM serving from localhost, so the network time is ~0. CI prints the same table in each run's job summary.

| Download (gzip) | |
|---|---:|
| engine (`engine.mjs` + `engine.wasm`) | 0.19 MB |
| core pack (999 files: Modules, Classes, Data, runtime/lua) | 3.27 MB (27.2 MB unpacked) |
| one passive tree (lazy, per version used by the build; 0_5 shown) | 0.32 MB |
| **first visit total** | **3.78 MB** |
| later visits | 0 (Cache Storage, keyed by content hash) |

| Time | Chromium | Node 22 |
|---|---:|---:|
| start, cold (download + unpack + PoB init) | 3.18 s | 2.87 s |
| start, warm (from cache) | 3.01 s | n/a |
| first calc of a build | 1.72 s | 1.43 s |
| repeat calc | 1.23 s | 1.17 s |
| every skill group (`{ groups: true }`, 18 groups) | not measured | 21.8 s |
| wasm memory after start / after a calc | 256 MB / 369 MB | 387 MB peak (531 MB with groups) |

For comparison, the companion's LuaJIT container takes ~2.5 s to start, ~11 s for all groups, and ~700 MB resident. Native PUC Lua 5.2 (this repo's `build/native/pobcalc`) takes 2.3 s to start, 1.07 s per calc and 19.3 s for the groups.

Bytecode packs (`node scripts/pack.mjs --bytecode`) cut PoB init by ~0.5 s (2.89 → 2.37 s in Chromium) but grow the first download from 3.78 to 6.65 MB, because Lua bytecode compresses worse than source. Source is the default.

## Use it

```js
import { init, calc } from './pob-calc.js'   // from a copy of dist/ on the same origin (see below)

await init({ onProgress: ({ phase, loaded, total }) => {} })  // once; ~3 s
const r = await calc(code)                    // a PoB2 code or its decoded XML
r.snapshot.stats.TotalDPS                     // 186706.45241768
const all = await calc(code, { groups: true })  // + every skill group recalculated (slow)
```

The result has the same shape as `upgraded-disco-companion`'s `services/pob-engine`, so the site can drop it in:

```
{ pobVersion, pinCommit,
  snapshot: { pobVersion, pinCommit, loadError, stats, fullDpsSkills,
              export: { PlayerStat, MinionStat, FullDPSSkill } },
  groups: { groups, rows } | null,          // only with { groups: true }
  ms, cached: false,
  // additions:
  mainSkill: { skill, mainSocketGroup, mainHand: { PhysicalHitAverage, FireHitAverage, …, TotalMin, TotalMax } },
  timings: { decodeMs, treeMs, engineMs, totalMs, engine: { load, snapshot, groups, luaHeapBytes } },
  wasmHeapBytes }
```

`stats` holds every displayStat / extraSaveStat PoB has for the build: DPS, crit, life/ES/mana/spirit, resists and overcap, EHP, max hit per type, block, deflection, evade and more. Errors reject with `err.kind`: `decode` (not a PoB2 code), `engine` (PoB's own error message) or `fatal` (crash or out of memory; the next call starts a fresh engine). Calls are serialised in one module worker. Browsers only start workers from the page's own origin, so another site can't import `pob-calc.js` from the Pages URL. Copy `dist/` (any path) into that site and import it from there; `init({ baseUrl })` points at the folder if it isn't next to `pob-calc.js`.

## How it works

| Piece | What |
|---|---|
| `vendor/pob2` | Submodule: `Demonad112/PathOfBuilding-PoE2` at `7d6f530` (tag v0.23.1). Never edited. |
| `third_party/` | Pristine Lua 5.2.4, LuaBitOp 1.0.2, luautf8 0.1.6, zlib 1.3.1. |
| `native/patches/` | Three small Lua patches so PoB runs as on its LuaJIT (below). |
| `native/pobcalc.c` | The host: `bit` as a global, `lua-utf8`, `pobhost` (zlib inflate/deflate, chdir, clock). Builds natively (CLI) and with emcc (`pob_boot` / `pob_eval`). |
| `lua/` | `headless.lua` and `groups_lib.lua` from the companion's `tools/pob2` (ported: no ffi, a `jit` stub, real `Inflate`/`Deflate`), `calc.lua` (serve.lua's per-build logic). |
| `scripts/pack.mjs` | Builds `dist/`: compiles every Lua file inside the wasm engine (the compile check), then writes gzipped packs and `manifest.json`. |
| `web/` | `pob-calc.js` (API), `pob-worker.js` (module worker: cache, gunzip, tree prefetch), `decode.mjs`, demo page. |

**Why Lua 5.2 and not 5.1.** PoB2 uses `goto` (CalcSetup, CalcPerform, PassiveSpec, …) and compound assignment `+=`/`-=` (Main, CalcSetup, ItemTools, Item, …), which only PoB's own LuaJIT build parses. PUC 5.1 has neither. 5.2.4 has `goto`, LuaJIT's `\x`/`\z` escapes and `xpcall` arguments, and stays doubles-only (5.3+ adds an integer subtype that changes formatting). `LUA_COMPAT_ALL` keeps `unpack`, `loadstring` and `math.pow`. LuaJIT itself can't target wasm (its interpreter is hand-written assembly).

**Patches** (each one is small and covered by `test/lua/compound_spec.lua`):

1. `01-compound-assign`: `+= -= *= /= %= ^= ..=` on one target. A table and key are evaluated once (`t[f()] += 1` calls `f` once).
2. `02-gsub-replacement-5.1`: `%x` with a non-digit `x` in a `gsub` replacement adds `x`, as in 5.1/LuaJIT. 5.2 raises an error, which broke `Classes/TradeHelpers.lua` at start.
3. `03-format-int-luajit`: `%d`/`%x` truncate like LuaJIT on x86-64, with NaN and ±inf becoming INT64_MIN. 5.2 raises "not a number in proper range", which broke a breakdown line in `Modules/CalcDefence.lua`; a plain C cast would trap in wasm.

The porting log is in [`docs/PORTING.md`](docs/PORTING.md).

## Build

Needs: gcc, Node 22, emsdk 4.0.10 (`source "$(scripts/install-emsdk.sh 4.0.10)"` clones emsdk at that tag into `~/emsdk` and installs it).

```sh
git submodule update --init --depth 1      # full fork, ~400 MB (mostly tree art)
# or: scripts/checkout-pob2.sh             # pinned commit, calc files only (~40 MB, what CI uses)
npm ci
native/build.sh all                        # build/native/pobcalc + dist/engine.{mjs,wasm}
build/native/pobcalc test/lua/compound_spec.lua
node --test test/parity.test.mjs           # wasm vs oracle, snapshot + every group (~30 s)
node scripts/pack.mjs                      # dist/ (+ size table); --bytecode for bytecode packs
PARITY_SOURCE=dist PARITY_GROUPS=0 node --test test/parity.test.mjs   # the shipped packs alone
node --test test/e2e.test.mjs              # Chromium (Playwright): page, parity in browser, warm reload
node scripts/serve.mjs dist 8080           # http://127.0.0.1:8080/
```

Native CLI, for debugging PoB itself: `build/native/pobcalc lua/cli.lua fixtures/oracle/ninja-default.code.txt [--groups]`.

CI (`.github/workflows/pages.yml`) runs all of the above on every push and PR, uploads the reports, and deploys `dist/` to Pages on push.

## Bump PoB2

The pin is a PoB2 **release tag** commit, not the head of `dev`. Codes are written by the released app, and `dev` gives different numbers: `601768b` gives TotalDPS 203,790 on the reference code.

1. Sync the fork on GitHub (upstream → `dev`).
2. Find the tag's commit: `git ls-remote https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2 refs/tags/vX.Y.Z`.
3. `git -C vendor/pob2 fetch --depth 1 origin <sha> && git -C vendor/pob2 checkout <sha> && git add vendor/pob2`.
4. Regenerate the oracle in `upgraded-disco-companion` (`npm run pob2:sync -- --commit <sha>`, `npm run pob2:oracle`). Copy `ninja-default/{code.txt,oracle.json,groups.oracle.json}` into `fixtures/oracle/` (see `fixtures/README.md`).
5. `native/build.sh all && node --test test/parity.test.mjs && node scripts/pack.mjs`. A new Lua construct shows up as a compile-check failure in `pack.mjs`, and a new runtime gap as a parity diff (`parity-diff.json`).

## Known gaps

- **Exactness is proven for one build.** The reference code matches exactly. Other builds could still hit PUC-vs-LuaJIT differences: `pairs` order, `#` on tables with holes, `table.sort` raising "invalid order function" on an inconsistent comparator. Each one found becomes a documented patch.
- **Memory.** ~370 MB of wasm memory after a calc, ~530 MB with all groups. Desktop browsers are fine. Phones, iOS Safari especially, may run out of memory; untested.
- **Speed.** About 1.1–1.3× native PUC Lua and slower than LuaJIT (there's no JIT in wasm). Groups take ~20 s, so they're opt-in.
- **Not included:** tree art and the PoB UI; network features (`lcurl` stays stubbed, so no account/trade/poe.ninja import); timeless-jewel lookup tables that PoB downloads at runtime. The first-run update check and `Settings.xml` are absent by design.
- **The UI thread stays free, but the engine doesn't.** A calc can't be cancelled midway except with `terminate()`.

## Licenses

PoB2 (MIT, Path of Building Community), Lua 5.2.4 (MIT, Lua.org, PUC-Rio), LuaBitOp (MIT, Mike Pall), luautf8 (MIT, Xavier Wang), zlib (zlib license, Jean-loup Gailly and Mark Adler). Their notices are in `third_party/` and `vendor/pob2/LICENSE.md`. Not affiliated with Grinding Gear Games or the Path of Building team.
