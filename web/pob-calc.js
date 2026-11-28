// pob-calc.js: Path of Building 2's calc engine in the browser.
//
//   import { init, calc } from './pob-calc.js'
//   const info = await init({ onProgress })     // downloads ~3.8 MB once (then Cache Storage), starts PoB (~3 s)
//   const result = await calc(code)             // a PoB2 code or decoded XML; ~1-2 s per build
//   const full = await calc(code, { groups: true })   // also recalculates every skill group (much slower)
//   const next = await setConfig({ overrides: { enemyIsBoss: 'Uber' } })   // same build, new Config, no reload
//   const { measured } = await measure([{ key: 'enemyLevel', values: [70, 84] }])   // effect of options, on demand
//
// result has upgraded-disco-companion services/pob-engine's shape:
//   { pobVersion, pinCommit, snapshot: { loadError, stats, fullDpsSkills, export: { PlayerStat, MinionStat,
//     FullDPSSkill } }, groups: { groups, rows } | null, ms, cached: false }
// plus autoConfig ({ baselineDPS, configuredDPS, applied[], suggested[] } when requested, else null), mainSkill ({ skill, mainHand: per-type hit averages }), timings and wasmHeapBytes.
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
 * @param {{ groups?: boolean, autoConfig?: boolean | 'apply' | 'suggest', overrides?: Record<string, boolean | number | string> }} [opts] groups: also recalculate every skill group (slow).
 * autoConfig: enable the Config inputs the build can actually use (charges, Rage, Combo, ES, Daze/Shock, crit-recently)
 * and report them in result.autoConfig; 'suggest' also computes each situational toggle's isolated delta. Off by default.
 * overrides: Config inputs to force (e.g. { enemyIsBoss: 'Boss', usePowerCharges: false }); applied before auto-config, which never overrides them.
 * With 'suggest', result.autoConfig.catalog lists every option the build shows, its state (export|auto|manual|available) and its measured effect.
 */
export function calc(codeOrXml, opts = {}) {
  return enqueue(() => send({ type: 'calc', code: codeOrXml, groups: !!opts.groups, autoConfig: opts.autoConfig || false, overrides: opts.overrides || null }))
}

// Run one worker call after the ones before it. skip() is asked when its turn comes; true resolves null.
function enqueue(job, skip) {
  const run = chain.then(async () => {
    if (skip?.()) return null
    await init(initOpts ?? {})
    try {
      return await job()
    } catch (e) {
      if (e.kind === 'fatal') reset() // the next call boots a fresh engine
      throw e
    }
  })
  chain = run.catch(() => {})
  return run
}

/**
 * Change the Config of the build the last calc() loaded (not with groups) and recalculate it. The worker keeps the build
 * loaded, so this skips decoding and loading it: ~0.5-1 s instead of calc()'s load plus the catalog's trials.
 * Starts again from the export's own Config, then applies `overrides` and auto-config like calc() does.
 * @param {{ autoConfig?: boolean | 'apply' | 'suggest', overrides?: Record<string, boolean | number | string>, trials?: number, catalog?: boolean, deltas?: boolean }} [opts]
 * trials: how many options the catalog measures in this call (default 0: listed, measured by measure()); catalog:
 * false skips the catalog; deltas: also measure each situational toggle (default false).
 * Rejects with kind 'engine' ("no build loaded") when calc() has not loaded one.
 */
export function setConfig(opts = {}) {
  return enqueue(() => send({ type: 'setConfig', autoConfig: opts.autoConfig || false, overrides: opts.overrides || null, trials: opts.trials ?? 0, catalog: opts.catalog ?? true, deltas: !!opts.deltas }), opts.skip)
}

/**
 * Measure Config options of the loaded build as configured now: one change at a time, nothing is kept.
 * @param {{ key: string, values?: number[] }[]} specs values (counts only): try these instead of +1 / vs 0.
 * @param {{ skip?: () => boolean }} [opts] skip: checked when the call's turn comes; true resolves null without running (stale request).
 * @returns {Promise<{ measured: object[], ms: number } | null>}
 */
export function measure(specs, opts = {}) {
  return enqueue(() => send({ type: 'measure', specs }), opts.skip)
}

/** Stop the engine and free its memory. The next init()/calc() starts again (from the cache). */
export function terminate() {
  for (const p of pending.values()) p.reject(Object.assign(new Error('terminated'), { kind: 'usage' }))
  pending.clear()
  reset()
}
