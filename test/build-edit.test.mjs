// Build editing (P1): decode -> edit -> encode round-trip. Pure JS except the last block, which runs the native
// engine (build/native/pobcalc, `npm run build:native`) when present and skips otherwise.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildModelOf } from '../web/build-model.mjs'
import { EditError, editBuild } from '../web/build-edit.mjs'
import { decodePobCode } from '../web/decode.mjs'
import { encodePobCode } from '../web/encode.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const code = readFileSync(ROOT + 'fixtures/oracle/ninja-default.code.txt', 'utf8')
const xml = await decodePobCode(code)
const model = buildModelOf(xml)
const helm = model.items.slots.Helmet.item
const mainGroup = model.character.mainSocketGroup - 1

test('unedited round-trip is lossless', async () => {
  assert.equal(editBuild(xml, []), xml)
  const again = await decodePobCode(await encodePobCode(xml))
  assert.equal(again, xml)
  assert.deepEqual(buildModelOf(again), model)
})

test('setMod keeps tags/indent, bumps only that line', () => {
  const i = helm.mods.findIndex((m) => m.text === '+81 to Evasion Rating')
  const out = buildModelOf(editBuild(xml, [{ op: 'setMod', itemId: helm.id, index: i, text: '+99 to Evasion Rating', range: 0.9 }])).items.byId[helm.id]
  assert.equal(out.mods[i].text, '+99 to Evasion Rating')
  assert.equal(out.mods[i].range, 0.9)
  assert.deepEqual(out.mods.map((m) => m.text).filter((_, k) => k !== i), helm.mods.map((m) => m.text).filter((_, k) => k !== i))
  assert.equal(out.corrupted, true)
})

test('addMod appends an explicit before the Corrupted flag; removeMod renumbers ranges and Implicits', () => {
  const added = buildModelOf(editBuild(xml, [{ op: 'addMod', itemId: helm.id, tags: '{prefix}', text: '+10% to Fire Resistance', range: 0.25 }])).items.byId[helm.id]
  assert.equal(added.mods.length, helm.mods.length + 1)
  const last = added.mods.at(-1)
  assert.deepEqual([last.text, last.affix, last.range], ['+10% to Fire Resistance', 'prefix', 0.25])
  assert.equal(added.corrupted, true)
  assert.equal(added.mods.filter((m) => m.implicit).length, 4)

  const removed = buildModelOf(editBuild(xml, [{ op: 'removeMod', itemId: helm.id, index: 0 }])).items.byId[helm.id]
  assert.equal(removed.mods.length, helm.mods.length - 1)
  assert.equal(removed.mods.filter((m) => m.implicit).length, 3)
  assert.deepEqual(removed.mods.map((m) => [m.text, m.range]), helm.mods.slice(1).map((m) => [m.text, m.range]))
})

test('item layout agrees with the model on every item', () => {
  for (const it of Object.values(model.items.byId)) {
    const n = it.mods.length
    const out = buildModelOf(editBuild(xml, [{ op: 'addMod', itemId: it.id, text: 'zz marker' }])).items.byId[it.id]
    assert.equal(out.mods.length, n + 1, `item ${it.id}`)
    assert.equal(out.mods.at(-1).text, 'zz marker')
    assert.deepEqual(out.mods.slice(0, n).map((m) => m.text), it.mods.map((m) => m.text), `item ${it.id}`)
  }
})

test('gems: add, set, remove', () => {
  const g0 = model.skills.groups[mainGroup]
  const gem = { name: 'Test Support', gemId: 'Metadata/Items/Gems/SupportGemTest', skillId: 'SupportTestPlayer', variantId: 'TestSupport', level: 5 }
  let m = buildModelOf(editBuild(xml, [{ op: 'addGem', group: mainGroup, gem }])).skills.groups[mainGroup]
  assert.equal(m.gems.length, g0.gems.length + 1)
  assert.equal(m.gems.at(-1).name, 'Test Support')
  assert.equal(m.gems.at(-1).level, 5)
  assert.equal(m.supports.length, g0.supports.length + 1)

  m = buildModelOf(editBuild(xml, [{ op: 'setGem', group: mainGroup, gemIndex: 1, enabled: false, level: 3 }])).skills.groups[mainGroup]
  assert.deepEqual([m.gems[1].enabled, m.gems[1].level, m.gems[1].gemId], [false, 3, g0.gems[1].gemId])

  m = buildModelOf(editBuild(xml, [{ op: 'removeGem', group: mainGroup, name: g0.gems[1].name }])).skills.groups[mainGroup]
  assert.deepEqual(m.gems.map((g) => g.name), g0.gems.filter((_, i) => i !== 1).map((g) => g.name))
  assert.throws(() => editBuild(xml, [{ op: 'removeGem', group: mainGroup, gemIndex: 99 }]), EditError)
})

test('config: set existing, add, remove', () => {
  const on = (x) => buildModelOf(x).config.inputs
  assert.equal(on(editBuild(xml, [{ op: 'setConfig', name: 'conditionEnemyBleeding', value: false }])).conditionEnemyBleeding, false)
  assert.equal(on(editBuild(xml, [{ op: 'setConfig', name: 'enemyIsBoss', value: 'Pinnacle' }])).enemyIsBoss, 'Pinnacle')
  assert.equal(on(editBuild(xml, [{ op: 'setConfig', name: 'multiplierBrandedPct', value: 3 }])).multiplierBrandedPct, 3)
  assert.equal('conditionBeenHitRecently' in on(editBuild(xml, [{ op: 'setConfig', name: 'conditionBeenHitRecently', value: null }])), false)
  assert.throws(() => editBuild(xml, [{ op: 'nope' }]), EditError)
})

test('edited XML encodes to a code that decodes to the same XML', async () => {
  const edited = editBuild(xml, [{ op: 'setConfig', name: 'conditionEnemyBleeding', value: false }, { op: 'removeGem', group: mainGroup, gemIndex: 1 }])
  assert.equal(await decodePobCode(await encodePobCode(edited)), edited)
})

const native = ROOT + 'build/native/pobcalc'
const engineReady = existsSync(native) && existsSync(ROOT + 'vendor/pob2/src')
const dir = mkdtempSync(join(tmpdir(), 'pob-edit-'))
let n = 0
function calc(x) {
  const f = join(dir, `b${n++}.xml`)
  writeFileSync(f, x)
  const out = execFileSync(native, ['lua/cli.lua', f], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
  const res = JSON.parse(out.trim().split('\n').pop())
  assert.equal(res.error, undefined, res.error)
  return res.snapshot
}

test('engine: edits change calc output as expected', { skip: !engineReady && 'native engine not built', timeout: 300_000 }, async () => {
  const base = calc(xml)
  assert.equal(Math.round(base.stats.TotalDPS), 186706)

  // 1. unedited re-encode: identical numbers
  const reencoded = calc(await decodePobCode(await encodePobCode(xml)))
  assert.equal(reencoded.stats.TotalDPS, base.stats.TotalDPS)

  // 2. exact resist caps, usable by the model
  assert.deepEqual(base.resistMax, { ChaosResistMax: 75, ColdResistMax: 80, FireResistMax: 75, LightningResistMax: 76 })
  const exact = buildModelOf(xml, { stats: base.resistMax }).resists
  assert.deepEqual(exact.lightning, { value: 76, overCap: 54, cap: 76, capSource: 'engine' })
  assert.deepEqual(exact.chaos, { value: 53, overCap: 0, cap: 75, capSource: 'engine' })

  // 3. +10% fire res on the helmet: over-cap grows by exactly 10
  const withRes = calc(editBuild(xml, [{ op: 'addMod', itemId: helm.id, text: '+10% to Fire Resistance' }]))
  assert.equal(withRes.stats.FireResistOverCap, base.stats.FireResistOverCap + 10)

  // 4. disabling a support in the main group lowers damage
  const noSupport = calc(editBuild(xml, [{ op: 'setGem', group: mainGroup, gemIndex: 2, enabled: false }]))
  assert.notEqual(noSupport.stats.TotalDPS, base.stats.TotalDPS)

  // 5. removing the same support via removeGem gives the same result as disabling it
  const removed = calc(editBuild(xml, [{ op: 'removeGem', group: mainGroup, gemIndex: 2 }]))
  assert.equal(removed.stats.TotalDPS, noSupport.stats.TotalDPS)

  // 6. config toggle: dropping power charges lowers damage
  const noPower = calc(editBuild(xml, [{ op: 'setConfig', name: 'usePowerCharges', value: false }]))
  assert.ok(noPower.stats.TotalDPS < base.stats.TotalDPS)
})
