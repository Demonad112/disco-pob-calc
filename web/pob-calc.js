// pob-calc.js: Path of Building 2's calc engine in the browser.
//
//   import { init, calc } from './pob-calc.js'
//   const info = await init({ onProgress })     // downloads ~3.8 MB once (then Cache Storage), starts PoB (~3 s)
//   const result = await calc(code)             // a PoB2 code or decoded XML; ~1-2 s per build
//   const full = await calc(code, { groups: true })   // also recalculates every skill group (much slower)
//
// result has upgraded-disco-companion services/pob-engine's shape:
//   { pobVersion, pinCommit, snapshot: { loadError, stats, fullDpsSkills, export: { PlayerStat, MinionStat,
//     FullDPSSkill } }, groups: { groups, rows } | null, ms, cached: false }
// plus mainSkill ({ skill, mainHand: per-type hit averages }), timings and wasmHeapBytes.
//
// Errors reject with an Error whose `kind` is 'decode' (not a PoB2 code), 'engine' (PoB could not calculate the
// build; the message is PoB's) or 'fatal' (the engine crashed or ran out of memory; the next call starts a new one).
// Calls are serialised: one build at a time.

const DEFAULT_BASE = new URL('.', import.meta.url).href

let worker = null
let initPromise = null
let initOpts = null
let chain = Promise.resolve()
let nextId = 1
const pending = new Map()

function startWorker(baseUrl) {
  const w = new Worker(new URL('pob-worker.js', baseUrl), { type: 'module', name: 'pob-calc' })
  w.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      initOpts?.onProgress?.(data)
      return
    }
    const p = pending.get(data.id)
    if (!p) return
    pending.delete(data.id)
    if (data.ok) p.resolve(data.info ?? data.result)
    else {
      const e = new Error(data.error)
      e.kind = data.kind
      if (data.stderr) e.stderr = data.stderr
      p.reject(e)
    }
  }
  w.onerror = (ev) => {
    const e = new Error(ev.message || 'pob-calc worker failed')
    e.kind = 'fatal'
    for (const p of pending.values()) p.reject(e)
    pending.clear()
    reset()
  }
  return w
}

function send(msg) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, ...msg })
  })
}

function reset() {
  worker?.terminate()
  worker = null
  initPromise = null
}

/**
 * Download the engine and PoB2's data, and start PoB. Safe to call more than once.
 * @param {{ baseUrl?: string, onProgress?: (p: { phase: string, loaded: number, total: number }) => void }} [opts]
 * @returns {Promise<{ pobVersion, pinCommit, format, timings, bytes, luaHeapBytes, wasmHeapBytes }>}
 */
export function init(opts = {}) {
  if (initPromise) return initPromise
  initOpts = opts
  const baseUrl = opts.baseUrl ? new URL(opts.baseUrl, location.href).href : DEFAULT_BASE
  worker = startWorker(baseUrl)
  initPromise = send({ type: 'init', baseUrl }).catch((e) => {
    reset()
    throw e
  })
  return initPromise
}

/**
 * Calculate one build.
 * @param {string} codeOrXml a PoB2 export code, or its decoded <PathOfBuilding2> XML
 * @param {{ groups?: boolean }} [opts] groups: also recalculate every skill group (slow)
 */
export function calc(codeOrXml, opts = {}) {
  const run = chain.then(async () => {
    await init(initOpts ?? {})
    try {
      return await send({ type: 'calc', code: codeOrXml, groups: !!opts.groups })
    } catch (e) {
      if (e.kind === 'fatal') reset() // the next call boots a fresh engine
      throw e
    }
  })
  chain = run.catch(() => {})
  return run
}

/** Stop the engine and free its memory. The next init()/calc() starts again (from the cache). */
export function terminate() {
  for (const p of pending.values()) p.reject(Object.assign(new Error('terminated'), { kind: 'usage' }))
  pending.clear()
  reset()
}
