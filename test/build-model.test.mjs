// Build model (P0) against the reference fixture. Pure JS: no engine needed.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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
  assert.equal(model.affixData.schema, 2)
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

test('a sum of several same-template mods across distinct groups is reported combined, not guessed (F5)', () => {
  // This body armour's "139%" line is a genuine sum: several LocalEvasionAndEnergyShield-family mods (3 distinct
  // groups spawnable on a body armour) can add up to 139, and nothing in the export says which - so it's honestly
  // 'combined-ambiguous', not resolved to one tier and not dropped as 'unmatched'.
  const u = mod('Body Armour', '139% increased Evasion and Energy Shield').lookup
  assert.equal(u.status, 'combined-ambiguous')
  assert.equal(u.tier, null)
  assert.ok(u.combinations.length > 1)
  for (const combo of u.combinations) {
    assert.equal(new Set(combo.map((p) => p.affix)).size, 1) // every part of a combo is the same affix side
    const lo = combo.reduce((s, p) => s + p.ranges[0].min, 0)
    const hi = combo.reduce((s, p) => s + p.ranges[0].max, 0)
    assert.ok(139 >= lo && 139 <= hi)
  }
  // The gloves line "Attacks Gain 18% of Damage as Extra Cold Damage" matches ModItem.lua's HandWraps* family
  // exactly (weight 0 on every base: vendor/pob2 src/Data/ModItem.lua's HandWrapsAddedColdDamage1..8 all carry
  // weightVal {0}), so it's off-base with that family recorded as its source (F4).
  const o = mod('Gloves', 'Attacks Gain 18% of Damage as Extra Cold Damage')
  assert.equal(o.lookup.status, 'off-base')
  assert.equal(o.lookup.source, 'hand-wraps/abyss')
  assert.match(o.lookup.candidates[0].modId, /^HandWraps/)
  assert.equal(o.tier, null)
})

test('off-base fallback never proposes unique-only or corruption mods on a plain rare item', () => {
  // Every RARE item mod lookup's source is one that can legitimately appear on a non-unique, non-corrupted item.
  for (const it of Object.values(model.items.byId)) {
    if (it.rarity !== 'RARE') continue
    for (const m of it.mods) {
      if (!m.lookup) continue
      assert.notEqual(m.lookup.source, 'unique-only')
      if (!it.corrupted) assert.notEqual(m.lookup.source, 'corruption')
    }
  }
})

test('the amulet\'s +85 maximum Energy Shield is above the item\'s recorded level (F4 anomaly)', () => {
  // Amulet (item 16) is Item Level: 79, but the only tier whose range contains 85 (IncreasedEnergyShield10,
  // vendor/pob2 src/Data/ModItem.lua) requires level 80. No essence/desecrated source explains it either, so PoB's
  // data is trusted over the (possibly stale) exported ilvl: the tier is kept, flagged 'exact-above-ilvl'.
  const es = mod('Amulet', '+85 to maximum Energy Shield').lookup
  assert.equal(es.status, 'exact-above-ilvl')
  assert.equal(es.tier, 1)
  assert.equal(es.modId, 'IncreasedEnergyShield10')
  assert.match(es.notes.at(-1), /requires ilvl 80 > item level 79/)
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

// fixtures/Yykiuy.txt doesn't exist in this repo yet; guard so the suite still runs once it's added (every
// Group A item asks for a block like this one against it).
const yykiuyPath = new URL('../fixtures/Yykiuy.txt', import.meta.url)
test('decodes and annotates the Yykiuy fixture without throwing', { skip: !existsSync(yykiuyPath) }, async () => {
  const yCode = readFileSync(yykiuyPath, 'utf8')
  const { model: yModel } = await decodePobBuild(yCode)
  assert.ok(yModel.character.class)
  for (const it of Object.values(yModel.items.byId)) {
    for (const m of it.mods) if (m.lookup) assert.ok(m.lookup.status)
  }
  assert.ok(Array.isArray(yModel.warnings))
})
