// Rule matrix: auto-config (--auto-config) on every corpus fixture, asserting which Tier 1 keys must fire and which
// must not. A rule needs a fixture that fires it and one that must not (the plan's "positive and negative" rule).
//   npm run test:rule-matrix        (needs build/native/pobcalc)
// All fixtures except ninja-default are SYNTHETIC (scripts/make-corpus.mjs); the reason for each row is the fixture note.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { label, manifest, pool, runFixture, skip } from './corpus.mjs'

// Tier 1 keys autoconfig may ever apply (same set as test/autoconfig.test.mjs).
const TIER1 = new Set([
  'usePowerCharges', 'multiplierRage', 'multiplierCombo', 'conditionHaveEnergyShield', 'conditionCritRecently',
  'conditionNonCritRecently', 'conditionEnemyDazed', 'conditionEnemyShocked',
  'useFrenzyCharges', 'useEnduranceCharges', 'conditionLeeching', 'conditionLeechingLife',
  'conditionLeechingMana', 'conditionLeechingEnergyShield',
])
// Never applied on any fixture: Onslaught is situational (PoB grants it itself when a granting modifier's conditions
// hold), an assumed Shock effect is inert or above what the build applies, and no fixture has a Frenzy/Endurance
// generator (only Power Charges have one: Profane Ritual / node 65204).
const NEVER = ['buffOnslaught', 'conditionShockEffect', 'useFrenzyCharges', 'useEnduranceCharges']
const LEECH = ['conditionLeeching', 'conditionLeechingLife', 'conditionLeechingMana', 'conditionLeechingEnergyShield']

// Per fixture: applied / suggested keys that MUST be there, and ones that must NOT be (applied unless noted).
const RULES = {
  'charges-base-max-skill-generator': {
    why: 'max Power Charges is the base 3, but Profane Ritual generates them: applied with the skill as the reason',
    applied: ['usePowerCharges'],
  },
  'charges-no-generator': {
    why: 'Power Charge consumers but nothing generates charges and max is the base 3: only suggested (Tier 2)',
    notApplied: ['usePowerCharges'], suggested: ['usePowerCharges'],
  },
  'bare-spell': { why: 'max Power Charges 5 (base 3): applied', applied: ['usePowerCharges'] },
  'leech-consumer': { why: 'Leeches ... + "Damage while Leeching": the only fixture where leeching applies', applied: ['conditionLeeching'] },
  'leech-attack': { why: 'a leech source with no consumer: nothing to switch on', notApplied: LEECH },
  'attack': { why: 'no leech modifiers at all', notApplied: LEECH },
  'onslaught-consumer': { why: 'Onslaught consumer, nothing grants it: suggested only (Tier 2)', suggested: ['buffOnslaught'], notApplied: ['buffOnslaught'] },
  'onslaught-granted': { why: '"You have Onslaught": PoB applies it itself, so the toggle is neither applied nor suggested', absent: ['buffOnslaught'] },
  'ninja-default': { why: 'the export sets usePowerCharges, crit and daze itself: never overridden', notApplied: ['usePowerCharges', 'conditionCritRecently', 'conditionEnemyDazed'] },
}
const KNOWN = new Set(manifest.map((f) => f.id))
for (const id of Object.keys(RULES)) assert.ok(KNOWN.has(id), `rule matrix names an unknown fixture: ${id}`)

const runs = skip ? null : pool(manifest, (f) => runFixture(f.id, '--auto-config'))

for (const [i, f] of manifest.entries()) {
  test(`rules: ${label(f)}${RULES[f.id] ? ` - ${RULES[f.id].why}` : ''}`, { skip, timeout: 600_000 }, async () => {
    const a = (await runs)[i].res.autoConfig
    assert.equal(a.error, undefined, a.error)
    const applied = a.applied.map((x) => x.key)
    const suggested = a.suggested.map((x) => x.key)
    // Global: Tier 1 only, never the NEVER keys, nothing both applied and suggested, a reason on every applied key.
    for (const x of a.applied) {
      assert.ok(TIER1.has(x.key), `${x.key} is not a Tier 1 key`)
      assert.equal(x.tier, 1)
      assert.ok(x.source, `${x.key} has no source`)
    }
    for (const k of NEVER) assert.ok(!applied.includes(k), `${k} must never be applied`)
    for (const k of applied) assert.ok(!suggested.includes(k), `${k} is both applied and suggested`)
    // Leeching is applied on leech-consumer only.
    if (f.id !== 'leech-consumer') assert.ok(!applied.includes('conditionLeeching'), 'conditionLeeching only applies on leech-consumer')
    // usePowerCharges: applied where a generator exists or the export sets nothing; never without one.
    if (f.id === 'charges-no-generator') assert.ok(!applied.includes('usePowerCharges'))

    const r = RULES[f.id] ?? {}
    for (const k of r.applied ?? []) assert.ok(applied.includes(k), `${k} must be applied`)
    for (const k of r.notApplied ?? []) assert.ok(!applied.includes(k), `${k} must not be applied`)
    for (const k of r.suggested ?? []) assert.ok(suggested.includes(k), `${k} must be suggested`)
    for (const k of r.absent ?? []) assert.ok(!applied.includes(k) && !suggested.includes(k), `${k} must be neither applied nor suggested`)
    if (r.applied?.includes('usePowerCharges') && f.id === 'charges-base-max-skill-generator') {
      assert.match(a.applied.find((x) => x.key === 'usePowerCharges').source, /Profane Ritual/)
    }
    if (f.id === 'charges-no-generator') {
      assert.match(a.suggested.find((x) => x.key === 'usePowerCharges').source, /nothing found that generates them/)
    }
  })
}
