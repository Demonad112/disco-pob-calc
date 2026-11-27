// Unit tests for web/affix-tiers.mjs's combinatorics (fixture-level behaviour is covered by
// test/build-model.test.mjs, which exercises these through decodePobBuild on the ninja-default fixture).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { indexAffixes, sumCombinations, sumParts } from '../web/affix-tiers.mjs'

const table = {
  schema: 2,
  source: {},
  tagSets: [['default', 'ring']],
  weights: [[['ring', 'default'], [1, 0]]],
  bases: { 'Test Ring': ['Ring', 0] },
  mods: [
    { id: 'A1', s: 'item', t: 'P', lv: 1, g: 'A', w: 0, l: [{ p: '+# to Foo', r: [[5, 10]] }] },
    { id: 'B1', s: 'item', t: 'P', lv: 1, g: 'B', w: 0, l: [{ p: '+# to Foo', r: [[1, 4]] }] },
    { id: 'C1', s: 'item', t: 'S', lv: 1, g: 'C', w: 0, l: [{ p: '+# to Foo', r: [[20, 30]] }] },
  ],
  essences: {},
}

function ctxFor(table, baseName) {
  const idx = indexAffixes(table)
  const base = table.bases[baseName]
  const tags = new Set(table.tagSets[base[1]])
  const groups = new Map()
  for (const mod of table.mods) {
    const [keys, vals] = table.weights[mod.w]
    let w = 0
    for (let i = 0; i < keys.length; i++) {
      if (tags.has(keys[i])) {
        w = vals[i] ?? 0
        break
      }
    }
    if (w <= 0) continue
    if (!groups.has(mod.g)) groups.set(mod.g, [])
    groups.get(mod.g).push(mod)
  }
  return { idx, spawn: { src: 'item', groups } }
}

test('sumParts: only mods spawnable on this base, across every group sharing the template', () => {
  const ctx = ctxFor(table, 'Test Ring')
  const parts = sumParts(ctx, '+# to Foo')
  assert.deepEqual(
    parts.map((p) => p.mod.id).sort(),
    ['A1', 'B1', 'C1'],
  )
})

test('sumCombinations: only distinct-group combinations of 2-3 whose summed range contains the value', () => {
  const ctx = ctxFor(table, 'Test Ring')
  const parts = sumParts(ctx, '+# to Foo')
  // A1 (5-10) + B1 (1-4) can reach 9..14; 11 fits.
  const hit = sumCombinations(parts, 11)
  assert.equal(hit.length, 1)
  assert.deepEqual(
    hit[0].map((p) => p.mod.id).sort(),
    ['A1', 'B1'],
  )
  // Nothing sums to 1000.
  assert.equal(sumCombinations(parts, 1000).length, 0)
  // A combo never repeats a group: with only one mod per group here, picking all three is the only 3-part combo.
  const three = sumCombinations(parts, 35) // A1max10 + B1max4 + C1max30 = up to 44, min 26
  assert.ok(three.every((c) => new Set(c.map((p) => p.mod.g)).size === c.length))
})
