# Porting log: PoB2 on PUC Lua 5.2 in WebAssembly

Every error hit while bringing PoB2 v0.23.1 (`7d6f530`) up on this runtime, in order, and how it was fixed. The fork stays untouched: fixes live in our Lua build (`native/patches`), our host (`native/pobcalc.c`) or our shim (`lua/headless.lua`).

## Parse

| Finding | Fix |
|---|---|
| `goto` in CalcSetup, CalcPerform, PassiveSpec, Item, Data and others: PUC 5.1 can't parse them | Lua **5.2.4** instead of 5.1 |
| `+=` / `-=` in Main.lua:340, CalcSetup.lua:1743, ItemTools.lua:60, Item.lua:1422, Tooltip, PassiveTreeView | `01-compound-assign.patch` (lexer tokens + `compoundassign` in lparser.c) |
| `"?\z"` in Common.lua (LuaJIT/5.2 escape; 5.1 would read `z`) | native in 5.2 |
| `runtime/lua/sha1/lua53_ops.lua` uses 5.3 bitwise operators | excluded from the bundle; `sha1` loads it only on 5.3 (`choose_ops`) |
| `#@` first line in HeadlessWrapper.lua and Launch.lua | `loadfile` skips it; `pack.mjs` blanks it before its own `load()` compile check |

`scripts/pack.mjs` compiles all 1,000 bundled files with the patched parser on every build, so new syntax fails CI there first.

## Start (HeadlessWrapper → Launch → Main)

| Finding | Fix |
|---|---|
| `jit.opt.start(...)` in Launch.lua:19, `require("jit")` in Main | `jit` stub table (global + `package.loaded`) without `version_num`, so `sha2.lua` keeps treating the runtime as vanilla Lua |
| global `bit.*` in 13 files, LuaJIT's signed 32-bit results | LuaBitOp 1.0.2 registered as the global `bit` |
| `require('lua-utf8')` in Common.lua and EditControl.lua | luautf8 0.1.6 in `package.preload` |
| `Inflate` / `Deflate` are stubs returning `""` in `_SimpleGraphic.def.lua` | a one-shot `dofile` hook swaps in zlib right after that file runs |
| companion's `headless.lua` uses `ffi` for `chdir`/`getcwd` | `pobhost.chdir` / `pobhost.getcwd` (work on Emscripten's FS too) |
| `Classes/TradeHelpers.lua:13: invalid use of '%' in replacement string` | `02-gsub-replacement-5.1.patch` (5.1 rule) |
| HeadlessWrapper waits on `io.read` after a startup error, so the run hung | `io.read` returns nil during start; the error is raised with PoB's prompt text |
| `Modules/CalcDefence.lua:2922: bad argument #2 to 's_format' (not a number in proper range)` on NaN | `03-format-int-luajit.patch` (LuaJIT x86-64 truncation; NaN/inf → INT64_MIN) |
| "missing node …" lines and "Image '…' not found" | harmless console output; the art isn't shipped and PoB only logs it |

## Parity

After those fixes the native build matched the oracle exactly on the first full run (109 stats, 107 PlayerStats, 21 group rows), and so did wasm in Node and Chromium. The `pairs`-order and `#`-border differences between LuaJIT and PUC didn't show up in this build's numbers.

## PoB2's spec suite

`scripts/pob-specs.sh` runs the pinned tag's `spec/System/*_spec.lua` (33 files) one process per file with `CI` set, as PoB's own CI does under LuaJIT, through `lua/spec_runner.lua` (a busted-compatible subset). First run: 551 passed, 23 errors.

| Finding | Fix |
|---|---|
| `dkjson.lua:138: attempt to index upvalue '_ENV' (a nil value)` in CompareBuySimilar and TradeQueryRequests: dkjson's `local _ENV = nil` blocks globals on 5.2, and `sortedkeys` calls `table.sort` | `04-env-name-luajit.patch`: the environment upvalue is named `(ENV)`, so `_ENV` is an ordinary name as in LuaJIT |
| TradeQueryRequests mocks `launch = { DownloadPage = … }` with the wrong signature; the test only passes because busted gives each spec file its own environment, so PoB never sees the mock | the runner loads each spec with its own environment (reads fall through to `_G`) |
| TestSocketables calls `it(name, slotTypeTest(...))`: the checks run while the tests are being defined and `it` gets `nil` | `it` without a function is pending, as in busted (18 pending; their assertions still run at load) |
| TestCompareBuySimilar calls `getfenv` on a PoB closure | a LuaJIT-style `getfenv` in the spec environment only; PoB's own code never uses `getfenv`/`setfenv` |

After those: 566 passed, 0 failed, 18 pending. TestTriggers has no tests at this tag.

## Runtime settings

- GC pause 200 after start (PoB sets 400, which lets the heap grow to ~4× live).
- wasm: 256 MB initial, growth up to 4 GB, 8 MB stack, no threads (Pages can't send COOP/COEP headers).
- Build XML goes in through the FS (`/tmp/build.xml`), not as a C string argument, so large builds don't touch the wasm stack.
