// Thin wrapper over the Emscripten module (dist/engine.mjs): runs lua/calc.lua inside it.
// Shared by the browser worker (web/pob-worker.js) and the Node tests, so both drive the engine the same way.
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
    /** Calculate one decoded build XML. Returns calc.lua's { snapshot, groups, timings } or { error, timings }. */
    calc(xml, { groups = false } = {}) {
      Module.FS.writeFile('/tmp/build.xml', xml)
      const json = evalLua(
        `local f = assert(io.open("/tmp/build.xml", "rb")); local xml = f:read("*a"); f:close()
         os.remove("/tmp/build.xml")
         return CALC.calc(xml, ${groups ? 'true' : 'false'})`,
      )
      return JSON.parse(json)
    },
    heapBytes() {
      return Module.HEAPU8.length
    },
  }
}
