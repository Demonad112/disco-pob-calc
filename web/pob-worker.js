// Module worker that owns the engine: one PoB2 instance, one build at a time (pob-calc.js serialises calls).
//
// Messages in:  { id, type: 'init', baseUrl }            -> { id, ok, info }
//               { id, type: 'calc', code, groups }       -> { id, ok, result } | { id, ok: false, error, kind }
// Messages out: { type: 'progress', phase, loaded, total } while downloading / unpacking.
// A wasm abort (OOM, trap) is reported with kind 'fatal'; pob-calc.js then replaces this worker.
import { decodePobCode, DecodeError, treeVersionsOf } from './decode.mjs'
import { wrapEngine } from './engine-core.mjs'
import { gunzip, installPack, readPack } from './pack.mjs'

const CACHE_NAME = 'pob-calc-v1'

let engine = null
let manifest = null
let baseUrl = null
let info = null
const installedTrees = new Set()
const stderrTail = []

const progress = (phase, loaded, total) => postMessage({ type: 'progress', phase, loaded, total })

async function openCache() {
  try {
    return 'caches' in self ? await caches.open(CACHE_NAME) : null
  } catch {
    return null // opaque origins, private modes
  }
}

// Fetch a content-hashed pack: Cache Storage first (immutable names), network otherwise. Reports progress.
async function fetchPack(file, phase, stats) {
  const url = new URL(file, baseUrl).href
  const cache = await openCache()
  const hit = cache && (await cache.match(url))
  if (hit) {
    stats.cachedBytes += Number(hit.headers.get('content-length')) || 0
    const bytes = new Uint8Array(await hit.arrayBuffer())
    progress(phase, bytes.length, bytes.length)
    return bytes
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  const reader = res.body.getReader()
  const chunks = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    progress(phase, loaded, total)
  }
  const bytes = new Uint8Array(loaded)
  let o = 0
  for (const c of chunks) {
    bytes.set(c, o)
    o += c.length
  }
  stats.networkBytes += loaded
  if (cache) {
    try {
      await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(loaded) } }))
    } catch {
      // quota: fine, next visit downloads again
    }
  }
  return bytes
}

// Drop cached packs this manifest no longer names (an older pin or build).
async function pruneCache() {
  const cache = await openCache()
  if (!cache) return
  const keep = new Set([manifest.core.file, ...Object.values(manifest.trees).map((t) => t.file)].map((f) => new URL(f, baseUrl).href))
  for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req)
}

async function installTree(version, stats) {
  if (installedTrees.has(version) || !manifest.trees[version]) return false
  const bytes = await fetchPack(manifest.trees[version].file, `tree ${version}`, stats)
  installPack(engine.Module.FS, '/pob', readPack(await gunzip(bytes)))
  installedTrees.add(version)
  return true
}

async function init(base) {
  if (info) return info
  baseUrl = base
  const t0 = performance.now()
  const timings = {}
  const stats = { networkBytes: 0, cachedBytes: 0 }
  let t = performance.now()
  manifest = await (await fetch(new URL('manifest.json', baseUrl), { cache: 'no-cache' })).json()
  timings.manifestMs = performance.now() - t

  t = performance.now()
  const { default: createPobEngine } = await import(new URL(manifest.engine.js, baseUrl).href)
  const [Module, coreBytes] = await Promise.all([
    createPobEngine({
      locateFile: (p) => new URL(p, baseUrl).href,
      print: (s) => console.log('[pob]', s),
      printErr: (s) => {
        stderrTail.push(s)
        if (stderrTail.length > 50) stderrTail.shift()
      },
    }),
    fetchPack(manifest.core.file, 'core', stats),
  ])
  timings.downloadMs = performance.now() - t

  t = performance.now()
  progress('unpack', 0, 1)
  installPack(Module.FS, '/pob', readPack(await gunzip(coreBytes)))
  engine = wrapEngine(Module)
  // PoB builds its default (latest) tree at start, so that one is needed before init.
  await installTree(manifest.latestTree, stats)
  timings.unpackMs = performance.now() - t

  t = performance.now()
  progress('start', 0, 1)
  const ready = engine.init({ pinCommit: manifest.pinCommit })
  timings.engineInitMs = performance.now() - t
  timings.totalMs = performance.now() - t0
  pruneCache().catch(() => {})
  info = {
    pobVersion: ready.pobVersion,
    pinCommit: ready.pinCommit,
    format: manifest.format,
    timings,
    bytes: {
      network: stats.networkBytes,
      cached: stats.cachedBytes,
      firstVisit: manifest.engine.jsGzipBytes + manifest.engine.wasmGzipBytes + manifest.core.bytes + manifest.trees[manifest.latestTree].bytes,
    },
    luaHeapBytes: ready.luaHeapBytes,
    wasmHeapBytes: engine.heapBytes(),
  }
  return info
}

async function calc(code, groups, autoConfig, overrides) {
  const t0 = performance.now()
  const timings = {}
  let t = performance.now()
  const xml = await decodePobCode(code)
  timings.decodeMs = performance.now() - t

  t = performance.now()
  const stats = { networkBytes: 0, cachedBytes: 0 }
  for (const v of treeVersionsOf(xml)) await installTree(v, stats)
  timings.treeMs = performance.now() - t

  t = performance.now()
  const r = engine.calc(xml, { groups, autoConfig, overrides })
  timings.engineMs = performance.now() - t
  timings.totalMs = performance.now() - t0
  if (r.error) {
    const e = new Error(r.error)
    e.kind = 'engine'
    throw e
  }
  return {
    pobVersion: info.pobVersion,
    pinCommit: info.pinCommit,
    snapshot: r.snapshot,
    mainSkill: r.mainSkill,
    groups: r.groups,
    autoConfig: r.autoConfig ?? null,
    ms: Math.round(timings.totalMs),
    cached: false,
    timings: { ...timings, engine: r.timings },
    wasmHeapBytes: engine.heapBytes(),
  }
}

self.onmessage = async ({ data }) => {
  const { id, type } = data
  try {
    if (type === 'init') {
      postMessage({ id, ok: true, info: await init(data.baseUrl) })
    } else if (type === 'calc') {
      if (!info) throw Object.assign(new Error('call init() first'), { kind: 'usage' })
      postMessage({ id, ok: true, result: await calc(data.code, !!data.groups, data.autoConfig || false, data.overrides || null) })
    } else {
      throw Object.assign(new Error(`unknown message ${type}`), { kind: 'usage' })
    }
  } catch (e) {
    const fatal = e instanceof WebAssembly.RuntimeError || /abort|out of memory|unreachable/i.test(String(e?.message))
    const kind = e instanceof DecodeError ? 'decode' : fatal ? 'fatal' : e?.kind || 'engine'
    postMessage({ id, ok: false, error: String(e?.message ?? e), kind, stderr: kind === 'fatal' ? stderrTail.slice(-10) : undefined })
  }
}
