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
