// ModRange indexing (F1): PoB's loader walks buffModLines -> enchantModLines -> implicitModLines -> explicitModLines
// (no rune) to turn a 1-based <ModRange id> into a mod line; a flask/charm base's buff lines are never printed as
// item text, so every id after them is shifted. The ninja-default fixture's ModRanges are all 0.5 (see
// test/build-model.test.mjs), so index-correctness needs synthetic items with distinct values.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parseItem } from '../web/build-model.mjs'
import { editBuild } from '../web/build-edit.mjs'
import { decodePobCode } from '../web/decode.mjs'
import { parseXml } from '../web/xml-lite.mjs'

const wrap = (itemXml) => `<PathOfBuilding2><Items activeItemSet="1"><Item id="1">${itemXml}</Item><ItemSet id="1"><Slot name="Weapon 1" itemId="1"/></ItemSet></Items></PathOfBuilding2>`

function parse(xml, opts) {
  const root = parseXml(xml)
  const item = root.children[0].children.find((c) => c.tag === 'Item')
  return parseItem(item, opts)
}

test('charm: buff=1 shifts explicit ModRange ids (F1)', () => {
  const body =
    'Rarity: RARE\nNamed Test Charm\nTest Charm\nItem Level: 50\nLevelReq: 1\nImplicits: 1\nUsed when you test\n+5 to Test Charge\n+7 to Test Other\n' +
    '<ModRange id="3" range="0.3"/><ModRange id="4" range="0.7"/>\n'
  const xml = wrap(body)
  const bases = { 'Test Charm': 1 }
  const item = parse(xml, { bases })
  assert.equal(item.mods[0].implicit, true)
  assert.equal(item.mods[0].range, null) // the implicit has no ModRange in this fixture
  assert.equal(item.mods[1].text, '+5 to Test Charge')
  assert.equal(item.mods[1].range, 0.3)
  assert.equal(item.mods[2].text, '+7 to Test Other')
  assert.equal(item.mods[2].range, 0.7)

  // Without the bases table, re-derive the same offset from the ids already on the item.
  const noTable = parse(xml, {})
  assert.deepEqual([noTable.mods[1].range, noTable.mods[2].range], [0.3, 0.7])

  // Round-trip through editBuild with the same `bases` option: setMod on index 1 (explicit "+5...") must land on
  // the id-3 ModRange, not id-2 (which would be the implicit's slot under a naive id-1 mapping).
  const edited = editBuild(xml, [{ op: 'setMod', itemId: 1, index: 1, range: 0.9 }], { bases })
  const reparsed = parse(edited, { bases })
  assert.equal(reparsed.mods[1].range, 0.9)
  assert.equal(reparsed.mods[2].range, 0.7) // untouched

  // addMod appends past the existing explicit mods; its ModRange id must also carry the +1 buff offset.
  const added = editBuild(xml, [{ op: 'addMod', itemId: 1, text: '+1 to Added', range: 0.1 }], { bases })
  const reparsedAdded = parse(added, { bases })
  assert.equal(reparsedAdded.mods.at(-1).text, '+1 to Added')
  assert.equal(reparsedAdded.mods.at(-1).range, 0.1)
  assert.equal(reparsedAdded.mods[1].range, 0.3) // earlier mods keep their own ranges

  // removeMod renumbers the remaining ids, still offset by the buff count.
  const removed = editBuild(xml, [{ op: 'removeMod', itemId: 1, index: 1 }], { bases })
  const reparsedRemoved = parse(removed, { bases })
  assert.equal(reparsedRemoved.mods.length, 2)
  assert.equal(reparsedRemoved.mods[1].text, '+7 to Test Other')
  assert.equal(reparsedRemoved.mods[1].range, 0.7)
})

test('flask: a base with 2 buff lines shifts explicit ModRange ids the same way', () => {
  const body =
    'Rarity: RARE\nNamed Test Flask\nTest Flask\nItem Level: 50\nLevelReq: 1\nImplicits: 0\n+10 to Flask A\n+20 to Flask B\n' +
    '<ModRange id="3" range="0.1"/><ModRange id="4" range="0.9"/>\n'
  const xml = wrap(body)
  const bases = { 'Test Flask': 2 }
  const item = parse(xml, { bases })
  assert.deepEqual(item.mods.map((m) => m.range), [0.1, 0.9])

  const edited = editBuild(xml, [{ op: 'setMod', itemId: 1, index: 0, range: 0.5 }], { bases })
  assert.deepEqual(parse(edited, { bases }).mods.map((m) => m.range), [0.5, 0.9])
})

test('rune helmet (enchant+rune lines, buff=0): naive id-1 mapping, unaffected by F1', () => {
  const body =
    'Rarity: RARE\nTest Helm\nSome Helmet\nSockets: S\nRune: Some Rune\nLevelReq: 1\nImplicits: 2\n' +
    '{enchant}{rune}+1 to Rune Thing\n{enchant}{rune}Bonded: +2 to Rune Other\n+30 to Explicit One\n+40 to Explicit Two\n' +
    '<ModRange id="1" range="0.2"/><ModRange id="2" range="0.4"/><ModRange id="3" range="0.6"/><ModRange id="4" range="0.8"/>\n'
  const xml = wrap(body)
  const item = parse(xml, { bases: { 'Some Helmet': 0 } })
  assert.deepEqual(item.mods.map((m) => m.range), [0.2, 0.4, 0.6, 0.8])
  assert.deepEqual(item.mods.map((m) => m.implicit), [true, true, false, false])

  const edited = editBuild(xml, [{ op: 'setMod', itemId: 1, index: 2, range: 0.55 }], { bases: { 'Some Helmet': 0 } })
  assert.deepEqual(parse(edited, { bases: { 'Some Helmet': 0 } }).mods.map((m) => m.range), [0.2, 0.4, 0.55, 0.8])
})

test('plain rare item: distinct ModRange values land on the right lines without any bases table', () => {
  const body =
    'Rarity: RARE\nTest Ring Name\nAmethyst Ring\nItem Level: 50\nLevelReq: 1\nImplicits: 0\n+11 to Life\n+22 to Mana\n+33 to Strength\n' +
    '<ModRange id="1" range="0.11"/><ModRange id="2" range="0.22"/><ModRange id="3" range="0.33"/>\n'
  const xml = wrap(body)
  const item = parse(xml, {})
  assert.deepEqual(item.mods.map((m) => m.range), [0.11, 0.22, 0.33])

  const edited = editBuild(xml, [{ op: 'setMod', itemId: 1, index: 2, range: 0.99 }])
  assert.deepEqual(parse(edited, {}).mods.map((m) => m.range), [0.11, 0.22, 0.99])
})

test('unknown base with a bases table supplied: falls back to buff=0 and a model warning', () => {
  const body = 'Rarity: RARE\nTest Ring Name\nUnknown Base\nItem Level: 50\nLevelReq: 1\nImplicits: 0\n+11 to Life\n' + '<ModRange id="1" range="0.11"/>\n'
  const xml = wrap(body)
  const warnings = []
  const item = parse(xml, { bases: { 'Some Other Base': 1 }, warnings })
  assert.equal(item.mods[0].range, 0.11)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].code, 'unknown-base-for-modrange')
})

// fixtures/Yykiuy.txt doesn't exist in this repo yet; guard so the suite still runs once it's added.
const yykiuyPath = new URL('../fixtures/Yykiuy.txt', import.meta.url)
test('ModRange ids resolve to in-range mod lines on every item of the Yykiuy fixture', { skip: !existsSync(yykiuyPath) }, async () => {
  const yCode = readFileSync(yykiuyPath, 'utf8')
  const yXml = await decodePobCode(yCode)
  const root = parseXml(yXml)
  const itemsNode = root.children.find((c) => c.tag === 'Items')
  for (const n of itemsNode?.children.filter((c) => c.tag === 'Item') ?? []) {
    const item = parseItem(n, {})
    for (const m of item.mods) if (m.range !== null) assert.ok(m.range >= 0 && m.range <= 1)
  }
})
