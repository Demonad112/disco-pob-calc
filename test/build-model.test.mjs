// Build model (P0) against the reference fixture. Pure JS: no engine needed.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { decodePobBuild, decodePobCode } from '../web/decode.mjs'
import { parseItem } from '../web/build-model.mjs'
import { parseXml } from '../web/xml-lite.mjs'

const code = readFileSync(new URL('../fixtures/oracle/ninja-default.code.txt', import.meta.url), 'utf8')
const { xml, model } = await decodePobBuild(code)

test('raw XML output is unchanged', async () => {
  assert.equal(xml, await decodePobCode(code))
})

test('character', () => {
  assert.deepEqual(
    { ...model.character },
    { class: 'Monk', ascendancy: 'Martial Artist', level: 90, targetVersion: '0_1', treeVersion: '0_5', mainSocketGroup: 15 },
  )
})

test('resist caps: derived when over cap, assumed otherwise', () => {
  assert.deepEqual(model.resists.cold, { value: 80, overCap: 59, cap: 80, capSource: 'derived' })
  assert.deepEqual(model.resists.chaos, { value: 53, overCap: 0, cap: 75, capSource: 'assumed' })
})

test('items per slot', () => {
  const helm = model.items.slots.Helmet.item
  assert.equal(helm.rarity, 'RARE')
  assert.equal(helm.base, 'Runeforged Brigand Mask')
  assert.equal(helm.corrupted, true)
  assert.equal(helm.mods.filter((m) => m.implicit).length, 4)
  assert.equal(helm.mods.find((m) => m.text === '+81 to Evasion Rating').range, 0.5)
  assert.equal(helm.mods[0].kind, 'enchant')
  assert.equal(model.items.slots['Weapon 2'].item, null)
  assert.equal(model.items.slots.Belt.item.rarity, 'UNIQUE')
  assert.equal(model.items.slots['Flask 1'].item.rarity, 'MAGIC')
})

test('mod flags and tiers parse from line prefixes', () => {
  const [it] = parseXml('<I><Item id="1">Rarity: RARE\nA\nB\nImplicits: 0\n{crafted}{tier:2}{prefix}+10 to Life\n{fractured}+5 to X (3-7)\nCorrupted\n</Item></I>').children.map(parseItem)
  assert.equal(it.mods[0].crafted, true)
  assert.equal(it.mods[0].tier, 2)
  assert.equal(it.mods[0].affix, 'prefix')
  assert.equal(it.mods[1].fractured, true)
  assert.deepEqual([it.mods[1].rollMin, it.mods[1].rollMax], [3, 7])
  assert.equal(it.corrupted, true)
})

test('socket groups: active, supports, main', () => {
  const main = model.skills.groups.filter((g) => g.isMain)
  assert.equal(main.length, 1)
  assert.equal(main[0].active[0].name, 'Storm Wave')
  assert.equal(main[0].active[0].level, 19)
  assert.equal(main[0].active[0].quality, 20)
  assert.equal(main[0].supports.length, 5)
  assert.ok(main[0].supports.every((g) => g.enabled && g.support))
  assert.equal(model.skills.groups.length, 18)
})

test('config', () => {
  assert.deepEqual(model.config.boss, { isBoss: false, tier: 'None' })
  assert.ok(model.config.conditions.includes('conditionEnemyIgnited'))
  assert.deepEqual(model.config.buffsAndCharges, ['useEnduranceCharges', 'useFrenzyCharges', 'usePowerCharges'])
  assert.equal(model.config.enemy.enemyLevel, 82)
})

// ---- affix tier lookup (web/affix-tiers.mjs + web/data/affixes.json) ----
const mod = (slot, text) => model.items.slots[slot].item.mods.find((m) => m.text === text)

test('affix data records the PoB2 pin it was built from', () => {
  assert.equal(model.affixData.pob2Version, '0.23.1')
  assert.equal(model.affixData.schema, 1)
})

test('exact match: tier, prefix/suffix, range, roll position, best tier at item level', () => {
  const life = mod('Helmet', '+123 to maximum Life')
  assert.equal(life.lookup.status, 'exact')
  assert.equal(life.tier, 2)
  assert.equal(life.affix, 'prefix')
  assert.equal(life.lookup.tierOf, 10)
  assert.equal(life.lookup.tierLabel, 'T2')
  const r = life.lookup.ranges[0]
  assert.ok(r.min <= 123 && 123 <= r.max)
  assert.deepEqual([life.rollMin, life.rollMax], [r.min, r.max])
  assert.ok(Math.abs(life.lookup.rollPosition - (123 - r.min) / (r.max - r.min)) < 1e-9)
  assert.ok(life.lookup.topTier.ranges[0].max > r.max)
  assert.equal(life.lookup.bestAvailable.tier, 1)
})

test('local vs global is settled by what the base can roll', () => {
  // flat evasion is a local mod on the helmet (hybrid with ES here) and global on rings
  const ev = mod('Helmet', '+81 to Evasion Rating')
  assert.equal(ev.lookup.hybrid.lines, 2)
  assert.match(ev.lookup.group, /^Local/)
  assert.equal(mod('Ring 1', 'Adds 19 to 25 Physical Damage to Attacks').lookup.group.startsWith('Local'), false)
})

test('hybrid lines share one mod and carry per-line ranges', () => {
  const a = mod('Boots', '+54 to Evasion Rating').lookup
  const b = mod('Boots', '+18 to maximum Energy Shield').lookup
  assert.equal(a.modId, b.modId)
  assert.deepEqual([a.hybrid.index, b.hybrid.index], [0, 1])
  assert.equal(a.tier, b.tier)
})

test('unmatched and off-base lines are reported, never guessed', () => {
  const u = mod('Body Armour', '139% increased Evasion and Energy Shield').lookup
  assert.equal(u.status, 'unmatched')
  assert.equal(u.tier, null)
  assert.match(u.notes[0], /outside every tier range/)
  const o = mod('Gloves', 'Attacks Gain 18% of Damage as Extra Cold Damage')
  assert.equal(o.lookup.status, 'off-base')
  assert.equal(o.tier, null)
})

test('magic item names resolve their base', () => {
  const flask = model.items.slots['Flask 1'].item
  assert.ok(flask.mods.every((m) => m.lookup.status !== 'no-base'))
})

test('uniques, implicits and runes get no lookup', () => {
  assert.equal(model.items.slots.Belt.item.mods.every((m) => !m.lookup), true)
  assert.equal(model.items.slots.Helmet.item.mods.filter((m) => m.implicit).every((m) => !m.lookup), true)
})

test('ambiguous candidates are labelled, not resolved', async () => {
  // a made-up table: two overlapping tiers of one group both fit the rolled value
  const table = {
    schema: 1,
    source: {},
    tagSets: [['default', 'ring']],
    weights: [[['ring', 'default'], [1, 0]]],
    bases: { 'Test Ring': ['Ring', 0] },
    mods: [
      { id: 'Foo1', s: 'item', t: 'P', lv: 1, g: 'Foo', w: 0, l: [{ p: '+# to Foo', r: [[5, 10]] }] },
      { id: 'Foo2', s: 'item', t: 'P', lv: 20, g: 'Foo', w: 0, l: [{ p: '+# to Foo', r: [[8, 14]] }] },
    ],
  }
  const x = '<PathOfBuilding2><Items activeItemSet="1"><Item id="1">Rarity: RARE\nN\nTest Ring\nItem Level: 50\nImplicits: 0\n+9 to Foo\n</Item><ItemSet id="1"><Slot name="Ring 1" itemId="1"/></ItemSet></Items></PathOfBuilding2>'
  const { model: m } = await decodePobBuild(x, { affixTable: table })
  const l = m.items.slots['Ring 1'].item.mods[0]
  assert.equal(l.lookup.status, 'ambiguous')
  assert.equal(l.lookup.tierLabel, 'T1 or T2')
  assert.equal(l.tier, null)
  assert.equal(l.affix, 'prefix')
  // below the level of tier 1, only the low tier can match
  const { model: m2 } = await decodePobBuild(x.replace('Item Level: 50', 'Item Level: 10'), { affixTable: table })
  const l2 = m2.items.slots['Ring 1'].item.mods[0]
  assert.equal(l2.lookup.status, 'exact')
  assert.equal(l2.tier, 2) // sorted best-first: Foo2 is T1, Foo1 is T2
})

test('without the table the model still decodes', async () => {
  const { model: m } = await decodePobBuild(code, { affixTable: null })
  assert.equal(m.affixData, null)
  assert.equal(m.items.slots.Helmet.item.mods.some((x) => x.lookup), false)
})

test('text-provided tier and affix are kept', async () => {
  const x = '<PathOfBuilding2><Items activeItemSet="1"><Item id="1">Rarity: RARE\nN\nAmethyst Ring\nItem Level: 80\nImplicits: 0\n{tier:9}{suffix}+9 to Strength\n</Item><ItemSet id="1"><Slot name="Ring 1" itemId="1"/></ItemSet></Items></PathOfBuilding2>'
  const { model: m } = await decodePobBuild(x)
  const l = m.items.slots['Ring 1'].item.mods[0]
  assert.equal(l.tier, 9)
  assert.equal(l.affix, 'suffix')
  assert.equal(l.lookup.status === 'exact' || l.lookup.status === 'ambiguous', true)
})
