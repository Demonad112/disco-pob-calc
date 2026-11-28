// Thin wrapper over the Emscripten module (dist/engine.mjs): runs lua/calc.lua inside it.
// Shared by the browser worker (web/pob-worker.js) and the Node tests, so both drive the engine the same way.
// { key: boolean | number | string } -> Lua table literal. Keys are PoB Config var names; anything else is dropped.
function luaOverrides(o) {
  const parts = []
  for (const [k, v] of Object.entries(o ?? {})) {
    if (!/^[A-Za-z0-9_]+$/.test(k)) continue
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) parts.push(`${k}=${v}`)
    else if (typeof v === 'string') parts.push(`${k}=${JSON.stringify(v)}`)
  }
  return parts.length ? `{ ${parts.join(', ')} }` : 'nil'
}

export class EngineError extends Error {}

export const LUA_DIR = '/pob/lua'
export const VENDOR_DIR = '/pob/vendor'

export function wrapEngine(Module) {
  function evalLua(chunk, arg = '') {
    const ptr = Module.ccall('pob_eval', 'number', ['string', 'string'], [chunk, arg])
    const out = Module.UTF8ToString(ptr)
    if (out.charCodeAt(0) === 1) throw new EngineError(out.slice(1))
    return out
  }
  // Arguments as JSON in a file (no escaping of keys or values into Lua source); the chunk decodes it with dkjson.
  function requestLua(fn, arg) {
    Module.FS.writeFile('/tmp/request.json', JSON.stringify(arg))
    return evalLua(
      `local f = assert(io.open("/tmp/request.json", "rb")); local req = require("dkjson").decode(f:read("*a")); f:close()
       os.remove("/tmp/request.json")
       return CALC.${fn}(req)`,
    )
  }
  const luaString = (s) => JSON.stringify(s) // JSON string literals are valid Lua strings for our paths/values

  return {
    Module,
    evalLua,
    /** Start PoB inside the engine. Returns { ready, pobVersion, pinCommit, ms, luaHeapBytes }. */
    init({ pinCommit = null, gcPause = 200 } = {}) {
      Module.ccall('pob_boot', 'number', [], [])
      const json = evalLua(
        `CALC = CALC or dofile(${luaString(LUA_DIR + '/calc.lua')})
         return CALC.init({ vendor = ${luaString(VENDOR_DIR)}, pinCommit = ${pinCommit ? luaString(pinCommit) : 'nil'}, gcPause = ${Number(gcPause)} })`,
      )
      return JSON.parse(json)
    },
    /** Calculate one decoded build XML. Returns calc.lua's { snapshot, groups, autoConfig, timings } or { error, timings }.
     *  autoConfig: false (as exported), true/'apply' (enable usable Config inputs), 'suggest' (+ per-toggle deltas). */
    calc(xml, { groups = false, autoConfig = false, overrides = null } = {}) {
      const auto = autoConfig === 'suggest' ? '"suggest"' : autoConfig ? '"apply"' : 'nil'
      Module.FS.writeFile('/tmp/build.xml', xml)
      const json = evalLua(
        `local f = assert(io.open("/tmp/build.xml", "rb")); local xml = f:read("*a"); f:close()
         os.remove("/tmp/build.xml")
         return CALC.calc(xml, ${groups ? 'true' : 'false'}, { autoConfig = ${auto}, overrides = ${luaOverrides(overrides)} })`,
      )
      return JSON.parse(json)
    },
    /** Change the Config of the build the last calc() loaded and recalculate it, without decoding or loading it again.
     *  Returns calc.lua's setConfig result ({ snapshot, mainSkill, autoConfig, timings } or { error }).
     *  opts: { autoConfig, overrides, trials, catalog, deltas }. calc() with groups invalidates the loaded build. */
    setConfig({ autoConfig = false, overrides = null, trials = 0, catalog = true, deltas = false } = {}) {
      const req = { overrides: overrides ?? {}, trials, catalog, deltas }
      if (autoConfig) req.autoConfig = autoConfig === 'suggest' ? 'suggest' : 'apply' // JSON null would decode to dkjson.null (truthy in Lua)
      return JSON.parse(requestLua('setConfig', req))
    },
    /** Measure Config options on the loaded build as configured now. specs: [{ key, values?: number[] }].
     *  Returns { measured: [{ key, effect | options | perUnit/total | trials }], ms } or { error }. */
    measure(specs) {
      return JSON.parse(requestLua('measure', specs))
    },
    heapBytes() {
      return Module.HEAPU8.length
    },
  }
}
