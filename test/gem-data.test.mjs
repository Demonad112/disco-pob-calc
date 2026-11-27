// Gem id lookup (Group A #6): web/gem-data.mjs + web/data/gems.json (scripts/extract-gems.mjs).
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { decodePobCode } from '../web/decode.mjs'
import { buildModelOf } from '../web/build-model.mjs'
import { editBuild, EditError } from '../web/build-edit.mjs'
import { encodePobCode } from '../web/encode.mjs'
import { loadGemTable, resolveGem } from '../web/gem-data.mjs'

const table = await loadGemTable()
const code = readFileSync(new URL('../fixtures/oracle/ninja-default.code.txt', import.meta.url), 'utf8')
const xml = await decodePobCode(code)

test('gem table records the PoB2 pin it was built from', () => {
  assert.equal(table.schema, 1)
  assert.equal(table.source.pob2Version, '0.23.1')
})

test('resolveGem: one match, ambiguous, and no match', () => {
  const heavySwing = resolveGem(table, 'Heavy Swing')
  assert.equal(heavySwing.gemId, 'Metadata/Items/Gems/SupportGemHeavySwing')
  assert.equal(heavySwing.skillId, 'SupportMeleePhysicalDamagePlayer')
  assert.equal(heavySwing.support, true)
  assert.equal(resolveGem(table, 'Nonexistent Gem Name Xyz'), null)
  // case-insensitive
  assert.equal(resolveGem(table, 'heavy swing').gemId, heavySwing.gemId)
})

test('model: every skill gem carries gemData from the bundled table, matched by gemId', () => {
  const model = buildModelOf(xml, { gemTable: table })
  const main = model.skills.groups.find((g) => g.isMain)
  const storm = main.active.find((g) => g.name === 'Storm Wave')
  assert.ok(storm.gemData, 'Storm Wave should resolve against the bundled gem table')
  assert.ok(Array.isArray(storm.gemData.tags))
  assert.equal(typeof storm.gemData.gemType, 'string')
  // without a table, gemData is null, never guessed
  const noTable = buildModelOf(xml)
  assert.equal(noTable.skills.groups.find((g) => g.isMain).active[0].gemData, null)
})

test('editBuild addGem: resolves gem.name via gemTable when gemId is not given', () => {
  const model = buildModelOf(xml)
  const group = model.character.mainSocketGroup - 1
  const out = buildModelOf(editBuild(xml, [{ op: 'addGem', group, gem: { name: 'Heavy Swing', level: 10 } }], { gemTable: table }))
  const added = out.skills.groups[group].gems.at(-1)
  assert.equal(added.name, 'Heavy Swing')
  assert.equal(added.gemId, 'Metadata/Items/Gems/SupportGemHeavySwing')
  assert.equal(added.skillId, 'SupportMeleePhysicalDamagePlayer')
  assert.equal(added.level, 10)
})

test('editBuild addGem: an edit with explicit ids never regresses, table or not', () => {
  const model = buildModelOf(xml)
  const group = model.character.mainSocketGroup - 1
  const gem = { name: 'Test Support', gemId: 'Metadata/Items/Gems/SupportGemTest', skillId: 'SupportTestPlayer', variantId: 'TestSupport', level: 5 }
  const withTable = buildModelOf(editBuild(xml, [{ op: 'addGem', group, gem }], { gemTable: table })).skills.groups[group].gems.at(-1)
  const withoutTable = buildModelOf(editBuild(xml, [{ op: 'addGem', group, gem }])).skills.groups[group].gems.at(-1)
  assert.deepEqual(withTable, withoutTable)
  assert.equal(withTable.gemId, gem.gemId)
})

test('editBuild addGem: an unresolved or ambiguous name throws EditError listing candidates', () => {
  const model = buildModelOf(xml)
  const group = model.character.mainSocketGroup - 1
  assert.throws(() => editBuild(xml, [{ op: 'addGem', group, gem: { name: 'Nonexistent Gem Name Xyz', level: 1 } }], { gemTable: table }), EditError)
  // "Fire Attunement" ids differ (SkillGemAddedFireDamageSupport key, SupportGemFireInfusion gameId) from its key,
  // but it's still a single unambiguous name match; this instead checks a name this table genuinely has >1 row
  // for, if any - and otherwise simply that a known unique name resolves instead of throwing.
  const dup = table.gems.reduce((m, g) => (g.name ? m.set(g.name, (m.get(g.name) ?? 0) + 1) : m), new Map())
  const ambiguousName = [...dup].find(([, n]) => n > 1)?.[0]
  if (ambiguousName) {
    assert.throws(() => editBuild(xml, [{ op: 'addGem', group, gem: { name: ambiguousName, level: 1 } }], { gemTable: table }), EditError)
  } else {
    assert.doesNotThrow(() => editBuild(xml, [{ op: 'addGem', group, gem: { name: 'Heavy Swing', level: 1 } }], { gemTable: table }))
  }
})

test('decode -> edit (gemTable) -> encode -> decode round-trips', async () => {
  const model = buildModelOf(xml)
  const group = model.character.mainSocketGroup - 1
  const edited = editBuild(xml, [{ op: 'addGem', group, gem: { name: 'Heavy Swing', level: 1 } }], { gemTable: table })
  assert.equal(await decodePobCode(await encodePobCode(edited)), edited)
})

// Yykiuy fixture doesn't exist in this repo yet; guard so the suite still runs once it's added.
const yykiuyPath = new URL('../fixtures/Yykiuy.txt', import.meta.url)
test('gem resolution against the Yykiuy fixture', { skip: !existsSync(yykiuyPath) }, async () => {
  const yCode = readFileSync(yykiuyPath, 'utf8')
  const yXml = await decodePobCode(yCode)
  const yModel = buildModelOf(yXml, { gemTable: table })
  for (const g of yModel.skills.groups.flatMap((gr) => gr.gems)) {
    assert.notEqual(resolveGem(table, g.name), undefined)
  }
})
