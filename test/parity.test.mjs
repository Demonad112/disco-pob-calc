// Parity: the wasm engine (dist/engine.mjs, the same build the site ships) against the PoB2 oracle computed by
// LuaJIT in upgraded-disco-companion (fixtures/oracle, provenance in fixtures/README.md).
//   node --test test/parity.test.mjs            snapshot + all skill groups
//   PARITY_GROUPS=0 node --test test/...        snapshot only (fast)
// Writes parity-diff.json (every mismatch, empty array when green) and parity-timings.json next to the repo root.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { decodePobCode } from '../web/decode.mjs'
import { compareToOracle } from './compare.mjs'
import { bootNodeEngine, pinCommit, ROOT } from './node-engine.mjs'

const read = (p) => readFileSync(ROOT + p, 'utf8')
const oracle = JSON.parse(read('fixtures/oracle/ninja-default.oracle.json'))
const groupsOracle = JSON.parse(read('fixtures/oracle/ninja-default.groups.oracle.json'))
const withGroups = process.env.PARITY_GROUPS !== '0'
const EXPECTED_TOTAL_DPS = 186706

test('wasm engine reproduces PoB2 v0.23.1 for the reference code', { timeout: 600_000 }, async (t) => {
  const timings = {}
  let t0 = performance.now()
  const { engine, stderr } = await bootNodeEngine()
  timings.wasmInstantiateMs = performance.now() - t0
  t0 = performance.now()
  let info
  try {
    info = engine.init({ pinCommit: pinCommit() })
  } catch (e) {
    console.error(stderr.slice(-30).join('\n'))
    throw e
  }
  timings.initMs = performance.now() - t0
  assert.equal(info.pobVersion, oracle.pobVersion)
  assert.equal(info.pinCommit, oracle.pinCommit, 'vendor/pob2 must be pinned to the oracle commit')

  const xml = await decodePobCode(read('fixtures/oracle/ninja-default.code.txt'))
  t0 = performance.now()
  const first = engine.calc(xml, { groups: withGroups })
  timings.firstCalcMs = performance.now() - t0
  timings.firstCalc = first.timings
  assert.equal(first.error, undefined, first.error)

  const mismatches = compareToOracle(first, oracle, withGroups ? groupsOracle : null)
  writeFileSync(ROOT + 'parity-diff.json', JSON.stringify(mismatches, null, 2) + '\n')

  await t.test('TotalDPS is 186,706', () => {
    assert.equal(Math.round(first.snapshot.stats.TotalDPS), EXPECTED_TOTAL_DPS)
  })
  await t.test(`every stat matches the oracle (${Object.keys(oracle.stats).length} stats, ${Object.keys(oracle.export.PlayerStat).length} PlayerStats${withGroups ? `, ${groupsOracle.rows.length} group rows` : ''})`, () => {
    assert.deepEqual(mismatches, [])
  })

  // Warm path: the same build again in the same engine, as the site does for a second paste.
  t0 = performance.now()
  const again = engine.calc(xml)
  timings.warmCalcMs = performance.now() - t0
  timings.warmCalc = again.timings
  timings.wasmHeapBytes = engine.heapBytes()
  await t.test('a second calc in the same engine gives the same snapshot', () => {
    assert.deepEqual(compareToOracle(again, oracle, null), [])
  })

  // The owner's own fixture, when present: it must reproduce the same TotalDPS.
  const own = 'fixtures/Yykiuy.txt'
  if (existsSync(ROOT + own)) {
    const ownResult = engine.calc(await decodePobCode(read(own)))
    await t.test('fixtures/Yykiuy.txt calculates TotalDPS 186,706', () => {
      assert.equal(ownResult.error, undefined, ownResult.error)
      assert.equal(Math.round(ownResult.snapshot.stats.TotalDPS), EXPECTED_TOTAL_DPS)
    })
  }

  await t.test('a non-PoB2 XML is rejected', () => {
    assert.match(engine.calc('<nope/>').error, /not a PoB2 export XML/)
  })

  writeFileSync(ROOT + 'parity-timings.json', JSON.stringify(timings, null, 2) + '\n')
  console.log(JSON.stringify(timings))
})
