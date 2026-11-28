// Shared by the corpus tests: reads fixtures/corpus/manifest.json and runs the native engine (build/native/pobcalc)
// on each fixture, a few at a time (each run is a ~15 s PoB boot).
//   Real fixture:      ninja-default (a PoB2 export; oracle = the PlayerStat/MinionStat block PoB wrote into the XML).
//   Synthetic fixtures: ninja-default's XML edited by scripts/make-corpus.mjs; their oracle is the native engine's own
//                       recompute, so those tests catch regressions only, not engine errors.
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { decodePobCode } from '../web/decode.mjs'

export const ROOT = new URL('../', import.meta.url).pathname
const native = ROOT + 'build/native/pobcalc'
export const skip = !(existsSync(native) && existsSync(ROOT + 'vendor/pob2/src')) && 'native engine not built (scripts/checkout-pob2.sh, npm run build:native)'
export const manifest = JSON.parse(readFileSync(ROOT + 'fixtures/corpus/manifest.json', 'utf8'))
export const oracleOf = (id) => JSON.parse(readFileSync(ROOT + `fixtures/corpus/${id}.oracle.json`, 'utf8'))
export const codeOf = (id) => readFileSync(ROOT + `fixtures/corpus/${id}.code.txt`, 'utf8')
export const label = (f) => `${f.id} (${f.synthetic ? 'SYNTHETIC, regression only' : 'REAL'})`

const run = promisify(execFile)
const dir = mkdtempSync(join(tmpdir(), 'pob-corpus-'))

/** Decode a fixture's code and run lua/cli.lua on the XML; resolves to the calc JSON (throws on an engine error). */
export async function runFixture(id, ...flags) {
  const xml = await decodePobCode(codeOf(id))
  const file = join(dir, `${id}${flags.join('')}.xml`.replace(/[^\w.=-]/g, '_'))
  writeFileSync(file, xml)
  const { stdout } = await run(native, ['lua/cli.lua', file, ...flags], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
  const res = JSON.parse(stdout.trim().split('\n').pop())
  if (res.error) throw new Error(`${id}: ${res.error}`)
  return { res, xml }
}

/** fn over items, `limit` at a time; results in input order. */
export async function pool(items, fn, limit = 4) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i) }
  }))
  return out
}

/** <PlayerStat stat=".." value=".."/> (or MinionStat) entries of a PoB export XML as an object. */
export const xmlStats = (xml, tag) =>
  Object.fromEntries([...xml.matchAll(new RegExp(`<${tag} stat="([^"]+)" value="([^"]+)"/>`, 'g'))].map((m) => [m[1], Number(m[2])]))
