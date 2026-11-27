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
  'conditionNonCritRecently', 'conditionEnemyDazed', 'conditionEnemyShocked', 'conditionShockEffect',
])

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
