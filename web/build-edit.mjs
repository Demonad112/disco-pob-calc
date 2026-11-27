// Build editing (P1): apply edits to a PoB2 build's XML and hand back XML that calc() accepts.
//
// Edits are string splices on the original document, so everything an edit does not touch stays byte-for-byte
// identical (an empty edit list returns the input unchanged: the unedited round-trip is lossless by construction).
// Targets use the ids the typed model already carries (build-model.mjs): item id, group index, gem index, config
// set. Indices are the model's (0-based groups/gems, 0-based position in item.mods).
//
//   const xml2 = editBuild(xml, [
//     { op: 'setMod', itemId: 3, index: 5, text: '+40% to Fire Resistance' },
//     { op: 'addGem', group: 15, gem: { name: 'Heavy Swing', gemId: '…', skillId: '…', variantId: '…', level: 1 } },
//     { op: 'setConfig', name: 'conditionEnemyIgnited', value: true },
//   ])
//   const code = await encodePobCode(xml2)          // web/encode.mjs; or pass xml2 straight to engine.calc()
//
// Ops: setMod, addMod, removeMod, setItem | addGem, removeGem, setGem, setGroup | setConfig.
// Not handled here: item text parsing beyond mod lines, tree/spec edits.
//
// addGem resolves `gem.name` to ids via `options.gemTable` (web/gem-data.mjs's resolveGem, built by
// scripts/extract-gems.mjs) when the edit doesn't already pass `gem.gemId`; an edit that already carries explicit
// ids behaves exactly as before, table or not.

import { resolveGem } from './gem-data.mjs'

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c])
const escText = (s) => s.replace(/[&<>]/g, (c) => ESC[c])
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unesc = (s) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e] ?? m),
  )

export class EditError extends Error {}

/** Element tree with source offsets: { tag, attrs, children, start, openEnd, closeStart, end } (closeStart===end-? for empty). */
export function scan(xml) {
  const root = { tag: '#root', attrs: {}, children: [], start: 0, openEnd: 0, closeStart: xml.length, end: xml.length }
  const stack = [root]
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
  let m
  while ((m = re.exec(xml))) {
    if (!m[2]) continue
    if (m[1]) {
      if (stack.length > 1) {
        const n = stack.pop()
        n.closeStart = m.index
        n.end = m.index + m[0].length
      }
    } else {
      const attrs = {}
      for (const a of m[3].matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unesc(a[2] ?? a[3])
      const n = { tag: m[2], attrs, children: [], start: m.index, openEnd: m.index + m[0].length, closeStart: m.index + m[0].length, end: m.index + m[0].length, selfClosed: !!m[4] }
      stack[stack.length - 1].children.push(n)
      if (!m[4]) stack.push(n)
    }
  }
  return root.children[0]
}
const kidsOf = (n, tag) => (n ? n.children.filter((c) => c.tag === tag) : [])
const childOf = (n, tag) => n?.children.find((c) => c.tag === tag)
const splice = (xml, from, to, repl) => xml.slice(0, from) + repl + xml.slice(to)
/** Indentation (spaces/tabs) of the line a node starts on. */
const indentOf = (xml, n) => /[ \t]*$/.exec(xml.slice(0, n.start))[0]

function activeSet(node, setTag, activeAttr) {
  const sets = kidsOf(node, setTag)
  return sets.find((s) => s.attrs.id === node.attrs[activeAttr]) ?? sets[0] ?? node
}

function root(xml) {
  const r = scan(xml)
  if (!r || r.tag !== 'PathOfBuilding2') throw new EditError('Not a PathOfBuilding2 document.')
  return r
}

// ---------- items ----------

// Mirrors parseItem (build-model.mjs): which lines of an item's text are mod lines, in the model's order.
function itemLines(text) {
  const lines = text.split('\n')
  const idx = []
  lines.forEach((l, i) => {
    if (l.replace(/\r$/, '').trim() !== '') idx.push(i)
  })
  let p = 0
  let implicitsAt = -1
  let implicitCount = 0
  const r0 = /^Rarity:\s*/i.test(lines[idx[0]]?.trim() ?? '') ? 1 : 0
  if (r0) p = 1
  const rarity = (/^Rarity:\s*(.+)$/i.exec(lines[idx[0]]?.trim() ?? '')?.[1] ?? '').toUpperCase()
  const single = rarity === 'NORMAL' || rarity === 'MAGIC'
  const base = (single ? lines[idx[r0]] : lines[idx[r0 + 1]])?.trim() ?? null
  p += single ? 1 : 2
  for (; p < idx.length; p++) {
    const l = lines[idx[p]].trim()
    const im = /^Implicits:\s*(\d+)/.exec(l)
    if (im) {
      implicitsAt = idx[p]
      implicitCount = Number(im[1])
      p++
      break
    }
    if (!/^([A-Za-z][A-Za-z ]*?):\s*(.*)$/.test(l)) break
  }
  const mods = []
  let firstFlag = null
  for (; p < idx.length; p++) {
    const l = lines[idx[p]].trim()
    if (l === 'Corrupted' || l === 'Mirrored' || l === 'Unidentified') {
      firstFlag ??= idx[p]
      continue
    }
    mods.push(idx[p])
  }
  return { lines, mods, implicitsAt, implicitCount, firstFlag, base }
}

// F1 (see web/build-model.mjs's parseItem for the full explanation): a flask/charm base's ModRange ids are offset
// by its buff-line count, which never appears as item text. `bases` (an optional { baseName: buffCount } map, the
// same shape web/decode.mjs builds from affixes.json) resolves it the same way parseItem does: exact base name,
// or the longest known base name the (possibly magic-prefixed) base line contains. Without `bases`, or when the
// base isn't in it, fall back to re-deriving it from the ModRange ids already on the item: a buff-shifted item's
// ids run past the item's own mod-line count by exactly the buff count (confirmed against every base in the
// fixture: non-flask/charm bases always have ModRange ids <= the mod count).
function buffOf(ctx, bases) {
  if (bases && ctx.layout.base !== null) {
    if (Object.hasOwn(bases, ctx.layout.base)) return bases[ctx.layout.base] ?? 0
    const key = Object.keys(bases)
      .sort((a, b) => b.length - a.length)
      .find((b) => ctx.layout.base.includes(b))
    if (key !== undefined) return bases[key] ?? 0
  }
  const maxId = ctx.ranges.reduce((m, r) => Math.max(m, r.id), 0)
  return Math.max(0, maxId - ctx.layout.mods.length)
}

const TAGS = /^(\s*)((?:\{[A-Za-z_]+(?::[^}]*)?\})*)(.*)$/

function itemNode(xml, itemId) {
  const items = childOf(root(xml), 'Items')
  const n = kidsOf(items, 'Item').find((i) => i.attrs.id === String(itemId))
  if (!n) throw new EditError(`No item with id ${itemId}.`)
  return n
}

/** Split an <Item> element into its text lines and its <ModRange> children. */
function openItem(xml, node) {
  const bodyStart = node.openEnd
  const tailAt = node.children.length ? node.children[0].start : node.closeStart
  const text = unesc(xml.slice(bodyStart, tailAt))
  const ranges = node.children.filter((c) => c.tag === 'ModRange').map((c) => ({ id: Number(c.attrs.id), range: c.attrs.range }))
  return { text, ranges, bodyStart, tailAt, layout: itemLines(text) }
}

function closeItem(xml, node, ctx, lines, ranges) {
  const ind = indentOf(xml, node)
  const rangeXml = [...ranges]
    .sort((x, y) => x.id - y.id)
    .map((r) => `${ind}\t<ModRange id="${r.id}" range="${escAttr(r.range)}"/>\n`)
    .join('')
  const body = lines.join('\n').replace(/\s+$/, '')
  return splice(xml, ctx.bodyStart, node.closeStart, `${escText(body)}\n${rangeXml}${ind}`)
}

function modLineOf(ctx, index) {
  const at = ctx.layout.mods[index]
  if (at === undefined) throw new EditError(`Item has no mod line ${index} (it has ${ctx.layout.mods.length}).`)
  return at
}

function setMod(xml, e, options) {
  const node = itemNode(xml, e.itemId)
  const ctx = openItem(xml, node)
  const buff = buffOf(ctx, options?.bases)
  const at = modLineOf(ctx, e.index)
  const lines = [...ctx.layout.lines]
  const m = TAGS.exec(lines[at].replace(/\r$/, ''))
  if (e.line !== undefined) lines[at] = m[1] + e.line
  else if (e.text !== undefined) lines[at] = m[1] + m[2] + e.text
  else if (e.range === undefined) throw new EditError('setMod needs text, line or range.')
  let ranges = ctx.ranges
  if (e.range !== undefined) {
    ranges = ranges.filter((r) => r.id !== e.index + 1 + buff)
    if (e.range !== null) ranges.push({ id: e.index + 1 + buff, range: String(e.range) })
  }
  return closeItem(xml, node, ctx, lines, ranges)
}

function addMod(xml, e, options) {
  const node = itemNode(xml, e.itemId)
  const ctx = openItem(xml, node)
  const buff = buffOf(ctx, options?.bases)
  const lines = [...ctx.layout.lines]
  const { mods, firstFlag } = ctx.layout
  const last = mods.length ? mods[mods.length - 1] : ctx.layout.implicitsAt
  if (last < 0) throw new EditError('Item has no Implicits line to anchor a new mod after.')
  const indent = TAGS.exec(lines[last])[1]
  const text = e.line ?? `${e.tags ?? ''}${e.text}`
  // new explicit goes after the last mod line, before Corrupted/Mirrored flags
  const insertAt = Math.min(last + 1, firstFlag ?? Infinity)
  lines.splice(insertAt, 0, indent + text)
  const ranges = [...ctx.ranges]
  if (e.range !== undefined && e.range !== null) ranges.push({ id: mods.length + 1 + buff, range: String(e.range) })
  return closeItem(xml, node, ctx, lines, ranges)
}

function removeMod(xml, e, options) {
  const node = itemNode(xml, e.itemId)
  const ctx = openItem(xml, node)
  const buff = buffOf(ctx, options?.bases)
  const at = modLineOf(ctx, e.index)
  const lines = [...ctx.layout.lines]
  if (e.index < ctx.layout.implicitCount) {
    lines[ctx.layout.implicitsAt] = lines[ctx.layout.implicitsAt].replace(/Implicits:\s*\d+/, `Implicits: ${ctx.layout.implicitCount - 1}`)
  }
  lines.splice(at, 1)
  const gone = e.index + 1 + buff
  const ranges = ctx.ranges.filter((r) => r.id !== gone).map((r) => (r.id > gone ? { ...r, id: r.id - 1 } : r))
  return closeItem(xml, node, ctx, lines, ranges)
}

/** Replace an item's whole raw text (keep its id and any slot references). `text` is PoB item text, newline-separated. */
function setItem(xml, e) {
  const node = itemNode(xml, e.itemId)
  const ind = indentOf(xml, node)
  const body = String(e.text).replace(/\r/g, '').replace(/^\n+|\s+$/g, '')
  return splice(xml, node.openEnd, node.closeStart, `\n${ind}\t${escText(body)}\n${ind}`)
}

// ---------- skills ----------

function groupNode(xml, group) {
  const skills = childOf(root(xml), 'Skills')
  if (!skills) throw new EditError('Build has no <Skills>.')
  const set = activeSet(skills, 'SkillSet', 'activeSkillSet')
  const g = kidsOf(set, 'Skill')[group]
  if (!g) throw new EditError(`No socket group ${group}.`)
  return g
}

function gemNode(xml, g, e) {
  const gems = kidsOf(g, 'Gem')
  const i = e.gemIndex ?? gems.findIndex((x) => x.attrs.nameSpec === e.name)
  if (i < 0 || !gems[i]) throw new EditError(`Group has no gem ${e.gemIndex ?? e.name}.`)
  return gems[i]
}

const GEM_ATTR_ORDER = ['corruptLevel', 'corrupted', 'count', 'enableGlobal1', 'enableGlobal2', 'enabled', 'gemId', 'level', 'nameSpec', 'quality', 'skillId', 'variantId']
const GEM_DEFAULTS = { corruptLevel: 'nil', corrupted: 'nil', count: '1', enableGlobal1: 'true', enableGlobal2: 'true', enabled: 'true', level: '1', quality: '0' }

function gemAttrs(gem) {
  const a = { ...GEM_DEFAULTS }
  const alias = { name: 'nameSpec' }
  for (const [k, v] of Object.entries(gem)) a[alias[k] ?? k] = String(v)
  for (const req of ['gemId', 'skillId', 'nameSpec']) if (!a[req]) throw new EditError(`Gem needs ${req === 'nameSpec' ? 'name' : req}.`)
  const keys = [...GEM_ATTR_ORDER.filter((k) => k in a), ...Object.keys(a).filter((k) => !GEM_ATTR_ORDER.includes(k))]
  return keys.map((k) => `${k}="${escAttr(a[k])}"`).join(' ')
}

function resolveGemEdit(gem, gemTable) {
  if (gem.gemId || !gem.name || !gemTable) return gem
  const match = resolveGem(gemTable, gem.name)
  if (!match) throw new EditError(`No gem named "${gem.name}" in the gem table.`)
  if (match.ambiguous) throw new EditError(`Gem name "${gem.name}" is ambiguous: ${match.ambiguous.map((g) => g.key).join(', ')}`)
  return { ...gem, gemId: match.gemId, skillId: gem.skillId ?? match.skillId, variantId: gem.variantId ?? match.variantId }
}

function addGem(xml, e, options) {
  const g = groupNode(xml, e.group)
  const gems = kidsOf(g, 'Gem')
  const xmlGem = `<Gem ${gemAttrs(resolveGemEdit(e.gem, options?.gemTable))}/>`
  if (g.selfClosed) {
    const ind = indentOf(xml, g)
    const open = xml.slice(g.start, g.openEnd).replace(/\s*\/>$/, '>')
    return splice(xml, g.start, g.end, `${open}\n${ind}\t${xmlGem}\n${ind}</Skill>`)
  }
  const at = e.at ?? gems.length
  if (gems.length && at < gems.length) return splice(xml, gems[at].start, gems[at].start, `${xmlGem}\n${indentOf(xml, gems[at])}`)
  if (gems.length) {
    const lastG = gems[gems.length - 1]
    return splice(xml, lastG.end, lastG.end, `\n${indentOf(xml, lastG)}${xmlGem}`)
  }
  const ind = indentOf(xml, g)
  return splice(xml, g.openEnd, g.openEnd, `\n${ind}\t${xmlGem}`)
}

function removeGem(xml, e) {
  const g = groupNode(xml, e.group)
  const n = gemNode(xml, g, e)
  const from = /\n[ \t]*$/.test(xml.slice(0, n.start)) ? n.start - /[ \t]*$/.exec(xml.slice(0, n.start))[0].length - 1 : n.start
  return splice(xml, from, n.end, '')
}

/** Replace/insert attributes on an element's open tag, keeping every other attribute as written. */
function setAttrs(xml, n, attrs) {
  let open = xml.slice(n.start, n.openEnd)
  for (const [k, v] of Object.entries(attrs)) {
    const re = new RegExp(`(\\s${k}\\s*=\\s*)(?:"[^"]*"|'[^']*')`)
    const val = `"${escAttr(v)}"`
    open = re.test(open) ? open.replace(re, (_, p) => p + val) : open.replace(/\s*(\/?)>$/, ` ${k}=${val}$1>`)
  }
  return splice(xml, n.start, n.openEnd, open)
}

function setGem(xml, e) {
  const g = groupNode(xml, e.group)
  const n = gemNode(xml, g, e)
  const attrs = {}
  for (const k of ['level', 'quality', 'enabled', 'count']) if (e[k] !== undefined) attrs[k] = e[k]
  if (!Object.keys(attrs).length) throw new EditError('setGem needs level, quality, enabled or count.')
  return setAttrs(xml, n, attrs)
}

function setGroup(xml, e) {
  const g = groupNode(xml, e.group)
  const attrs = {}
  for (const k of ['enabled', 'label', 'includeInFullDPS']) if (e[k] !== undefined) attrs[k] = e[k]
  if (!Object.keys(attrs).length) throw new EditError('setGroup needs enabled, label or includeInFullDPS.')
  return setAttrs(xml, g, attrs)
}

// ---------- config ----------

function setConfig(xml, e) {
  const cfg = childOf(root(xml), 'Config')
  if (!cfg) throw new EditError('Build has no <Config>.')
  const set = e.configSet !== undefined ? kidsOf(cfg, 'ConfigSet').find((s) => s.attrs.id === String(e.configSet)) : activeSet(cfg, 'ConfigSet', 'activeConfigSet')
  if (!set) throw new EditError(`No config set ${e.configSet}.`)
  const existing = kidsOf(set, 'Input').find((i) => i.attrs.name === e.name)
  const v = e.value
  if (v === null || v === undefined) {
    if (!existing) return xml
    const lead = /[ \t]*$/.exec(xml.slice(0, existing.start))[0]
    return splice(xml, existing.start - lead.length - (xml[existing.start - lead.length - 1] === '\n' ? 1 : 0), existing.end, '')
  }
  const kind = typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : 'string'
  if (kind === 'number' && !Number.isFinite(v)) throw new EditError('Config number must be finite.')
  const el = `<Input ${kind}="${escAttr(v)}" name="${escAttr(e.name)}"/>`
  if (existing) return splice(xml, existing.start, existing.end, el)
  const kids = kidsOf(set, 'Input')
  const ref = kids[kids.length - 1]
  if (ref) return splice(xml, ref.end, ref.end, `\n${indentOf(xml, ref)}${el}`)
  if (set.selfClosed) throw new EditError('Config set is empty and self-closed; not supported.')
  return splice(xml, set.openEnd, set.openEnd, `\n${indentOf(xml, set)}\t${el}`)
}

const OPS = { setMod, addMod, removeMod, setItem, addGem, removeGem, setGem, setGroup, setConfig }

/** Apply edits in order; returns the new XML. Throws EditError on a target that does not exist.
 *  `options.bases` (an optional { baseName: buffCount } map, the same shape web/decode.mjs builds from
 *  affixes.json) resolves a flask/charm's ModRange offset (F1) the way it does on decode; without it, setMod/
 *  addMod/removeMod re-derive the offset from the ModRange ids already on the item (see buffOf above). */
export function editBuild(xml, edits, options) {
  let out = xml
  for (const e of edits ?? []) {
    const f = OPS[e?.op]
    if (!f) throw new EditError(`Unknown edit op: ${e?.op}`)
    out = f(out, e, options)
  }
  return out
}
