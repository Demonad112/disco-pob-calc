// Auto-configuration (lua/autoconfig.lua): runs the native engine (build/native/pobcalc) and skips when it isn't built.
//   Off: the build exactly as exported. On: unset Config inputs the build can use are enabled; inputs the export
//   already sets are never touched; applied toggles are Tier 1 only (situational ones are only reported).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { decodePobCode } from '../web/decode.mjs'

const ROOT = new URL('../', import.meta.url).pathname
const native = ROOT + 'build/native/pobcalc'
const engineReady = existsSync(native) && existsSync(ROOT + 'vendor/pob2/src')
const skip = !engineReady && 'native engine not built'
const dir = mkdtempSync(join(tmpdir(), 'pob-auto-'))
let n = 0

function calc(xml, flag) {
  const f = join(dir, `b${n++}.xml`)
  writeFileSync(f, xml)
  const args = ['lua/cli.lua', f, ...(flag ? [flag] : [])]
  const out = execFileSync(native, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
  const res = JSON.parse(out.trim().split('\n').pop())
  assert.equal(res.error, undefined, res.error)
  return res
}

const refXml = await decodePobCode(readFileSync(ROOT + 'fixtures/oracle/ninja-default.code.txt', 'utf8'))
// The same build exported with an empty Config tab (no <Input> elements): what an unconfigured import looks like.
const bareXml = refXml.replace(/<Input [^>]*\/>\s*/g, '')
assert.notEqual(bareXml, refXml)

// Tier 1 keys autoconfig may ever apply.
const TIER1 = new Set([
  'usePowerCharges', 'multiplierRage', 'multiplierCombo', 'conditionHaveEnergyShield', 'conditionCritRecently',
  'conditionNonCritRecently', 'conditionEnemyDazed', 'conditionEnemyShocked',
  'useFrenzyCharges', 'useEnduranceCharges', 'conditionLeeching', 'conditionLeechingLife',
  'conditionLeechingMana', 'conditionLeechingEnergyShield',
])
// Never applied: Onslaught is situational (PoB grants it itself when a granting modifier's conditions hold) and an
// assumed Shock effect is either inert or above what the build applies.
const NEVER = ['buffOnslaught', 'conditionShockEffect']

// The bare build without "Overflowing Power" (+2 to Maximum Power Charges, node 65204): the Power Charge consumers
// stay (Critical Damage when consuming a Power Charge) and the maximum drops to the base 3 every character has. The
// only generator left is the socketed Profane Ritual ("the Corpse is consumed and you gain a Power Charge").
const baseMaxXml = bareXml.replace(/(<Spec [^>]*nodes=")([^"]*)"/, (_, pre, nodes) => {
  const kept = nodes.split(',').filter((id) => id !== '65204')
  assert.equal(kept.length, nodes.split(',').length - 1, 'fixture allocates node 65204')
  return `${pre}${kept.join(',')}"`
})
// ...and with Profane Ritual disabled too: a consumer with nothing that generates the charges.
const noGenXml = baseMaxXml.replace(/(<Gem [^>]*)enabled="true"([^>]*nameSpec="Profane Ritual")/, '$1enabled="false"$2')
assert.notEqual(noGenXml, baseMaxXml)

test('off by default: no autoConfig in the result and numbers unchanged', { skip, timeout: 300_000 }, () => {
  const r = calc(bareXml)
  assert.equal(r.autoConfig, null)
  assert.equal(Math.round(r.snapshot.stats.TotalDPS), 113587)
})

test('apply: raises DPS, applies Tier 1 keys only, reports baseline', { skip, timeout: 300_000 }, () => {
  const r = calc(bareXml, '--auto-config')
  const a = r.autoConfig
  assert.equal(a.error, undefined)
  assert.equal(Math.round(a.baselineDPS), 113587)
  assert.ok(a.configuredDPS > a.baselineDPS * 2, `configured ${a.configuredDPS}`)
  assert.equal(r.snapshot.stats.TotalDPS, a.configuredDPS)
  assert.ok(a.applied.length > 0)
  for (const x of a.applied) {
    assert.ok(TIER1.has(x.key), `${x.key} is not a Tier 1 key`)
    assert.equal(x.tier, 1)
    assert.ok(x.source)
  }
  assert.ok(a.applied.some((x) => x.key === 'usePowerCharges'))
  assert.match(a.applied.find((x) => x.key === 'usePowerCharges').source, /Maximum Power Charges 5 \(base 3\)/)
  for (const k of NEVER) assert.ok(!a.applied.some((x) => x.key === k), `${k} is never applied`)
  // Situational toggles are reported but not applied, and carry no measured delta without 'suggest'.
  assert.ok(a.suggested.length > 0)
  for (const s of a.suggested) {
    assert.equal(s.tier, 2)
    assert.equal(s.dpsDelta, undefined)
    assert.ok(!a.applied.some((x) => x.key === s.key))
  }
})

test('suggest: each reported toggle carries a non-zero measured delta and the build stays at Tier 1', { skip, timeout: 600_000 }, () => {
  const applied = calc(bareXml, '--auto-config')
  const r = calc(bareXml, '--auto-config=suggest')
  assert.equal(r.snapshot.stats.TotalDPS, applied.snapshot.stats.TotalDPS)
  assert.ok(r.autoConfig.suggested.length > 0)
  for (const s of r.autoConfig.suggested) assert.ok(s.dpsDelta !== 0 || s.ehpDelta !== 0, s.key)
})

test('never overrides inputs the export already sets', { skip, timeout: 300_000 }, () => {
  // The reference export sets usePowerCharges/conditionCritRecently/conditionEnemyDazed explicitly.
  const r = calc(refXml, '--auto-config')
  const keys = r.autoConfig.applied.map((x) => x.key)
  for (const k of ['usePowerCharges', 'conditionCritRecently', 'conditionEnemyDazed']) assert.ok(!keys.includes(k), k)
  // Explicitly turning a toggle off in the export is respected too.
  const off = refXml.replace(/<Input boolean="true" name="usePowerCharges"\/>/, '<Input boolean="false" name="usePowerCharges"/>')
  const r2 = calc(off, '--auto-config')
  assert.ok(!r2.autoConfig.applied.some((x) => x.key === 'usePowerCharges'))
})

test('idempotent: a build already configured by autoconfig changes nothing', { skip, timeout: 300_000 }, () => {
  const first = calc(bareXml, '--auto-config')
  const inputs = first.autoConfig.applied
    .map((x) => `<Input ${typeof x.value === 'boolean' ? `boolean="${x.value}"` : `number="${x.value}"`} name="${x.key}"/>`)
    .join('')
  const configured = bareXml.replace(/(<ConfigSet [^>]*>)/, `$1${inputs}`)
  assert.notEqual(configured, bareXml)
  const second = calc(configured, '--auto-config')
  assert.equal(second.autoConfig.applied.length, 0)
  assert.equal(second.snapshot.stats.TotalDPS, first.snapshot.stats.TotalDPS)
})

test('overrides win over auto-config; catalog reports state and measured effect', { skip, timeout: 600_000 }, () => {
  const f = join(dir, `b${n++}.xml`)
  writeFileSync(f, bareXml)
  const out = execFileSync(native, ['lua/cli.lua', f, '--auto-config=suggest', '--set=usePowerCharges=false', '--set=enemyIsBoss=Boss'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
  const a = JSON.parse(out.trim().split('\n').pop()).autoConfig
  assert.ok(!a.applied.some((x) => x.key === 'usePowerCharges'), 'a manual off must not be re-applied')
  const byKey = Object.fromEntries(a.catalog.map((e) => [e.key, e]))
  assert.equal(byKey.usePowerCharges.state, 'manual')
  assert.equal(byKey.usePowerCharges.value, false)
  assert.ok(byKey.usePowerCharges.effect.TotalDPS.pct > 0, 'turning power charges on adds damage')
  const boss = byKey.enemyIsBoss
  assert.equal(boss.value, 'Boss')
  const uber = boss.options.find((o) => o.val === 'Uber')
  assert.ok(uber.vsSelected.TotalDPS.pct < 0, 'uber pinnacle is worse than a standard boss')
})

// setConfig / measure keep the build loaded: lines are calc, then setConfig (--then), then measure.
function lines(xml, args) {
  const f = join(dir, `b${n++}.xml`)
  writeFileSync(f, xml)
  const out = execFileSync(native, ['lua/cli.lua', f, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
  return out.trim().split('\n').slice(1).map((l) => JSON.parse(l))
}

test('setConfig on the loaded build equals a fresh calc with the same overrides', { skip, timeout: 600_000 }, () => {
  const [, re] = lines(bareXml, ['--auto-config', '--then=enemyIsBoss=Boss'])
  const [fresh] = lines(bareXml, ['--auto-config', '--set=enemyIsBoss=Boss'])
  assert.equal(re.error, undefined)
  assert.equal(re.snapshot.stats.TotalDPS, fresh.snapshot.stats.TotalDPS)
  assert.equal(re.snapshot.stats.TotalEHP, fresh.snapshot.stats.TotalEHP)
  assert.deepEqual(re.autoConfig.applied.map((x) => x.key), fresh.autoConfig.applied.map((x) => x.key))
})

test('setConfig starts again from the export: an earlier override does not leak', { skip, timeout: 600_000 }, () => {
  const [first, re] = lines(bareXml, ['--auto-config', '--then=enemyIsBoss=Boss'])
  const [, back] = lines(bareXml, ['--auto-config', '--then=enemyIsBoss=Pinnacle'])
  assert.notEqual(re.snapshot.stats.TotalDPS, first.snapshot.stats.TotalDPS)
  assert.equal(back.snapshot.stats.TotalDPS, first.snapshot.stats.TotalDPS)
})

test('catalog lists every option, measures enemyIsBoss first, and measure() fills in the rest on request', { skip, timeout: 600_000 }, () => {
  const [a, , m] = lines(bareXml, ['--auto-config=suggest', '--then=enemyIsBoss=Boss', '--measure=enemyLevel:60,80', '--measure=conditionBeenHitRecently'])
  const cat = Object.fromEntries(a.autoConfig.catalog.map((e) => [e.key, e]))
  assert.ok(a.autoConfig.catalog.length > 100, 'unmeasured options are listed, not dropped')
  assert.equal(cat.enemyIsBoss.measured, true)
  assert.ok(a.autoConfig.unmeasured > 0)
  assert.ok(Object.values(cat).some((e) => e.section === 'Quest Rewards' && e.type === 'list' && e.options.length > 0), 'list options present even when not measured')
  const lvl = m.measured.find((e) => e.key === 'enemyLevel')
  assert.deepEqual(lvl.trials.map((t) => t.value), [60, 80])
  assert.ok(lvl.trials[0].vs.TotalEHP.pct > 0, 'a much lower enemy level helps')
  assert.ok(Object.keys(lvl.trials[1].vs).length > 0, 'every tried value is measured')
  assert.ok(m.measured.some((e) => e.key === 'conditionBeenHitRecently' && e.measured))
})

test('charges: base maximum plus a skill that generates them is applied, with the skill as the reason', { skip, timeout: 300_000 }, () => {
  const r = calc(baseMaxXml, '--auto-config')
  assert.equal(r.snapshot.stats.PowerChargesMax, 3)
  const x = r.autoConfig.applied.find((e) => e.key === 'usePowerCharges')
  assert.ok(x, 'applied')
  assert.match(x.source, /Profane Ritual/)
})

test('charges: a consumer without a generator is only suggested', { skip, timeout: 300_000 }, () => {
  const r = calc(noGenXml, '--auto-config')
  const a = r.autoConfig
  assert.equal(r.snapshot.stats.PowerChargesMax, 3)
  assert.ok(!a.applied.some((x) => x.key === 'usePowerCharges'), 'no generator: not applied')
  const s = a.suggested.find((x) => x.key === 'usePowerCharges')
  assert.ok(s, 'reported as situational')
  assert.match(s.source, /nothing found that generates them/)
})
