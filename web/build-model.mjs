// Typed build model from PoB2 XML (P0): character, resists, items per slot, socket groups, config.
// Read-only today. Every node keeps the ids/indices of its XML source (itemId, skillIndex, gemIndex, configSet) so
// a later encode/edit round-trip (P1) can write changes back without re-deriving them.
import { child, kids, parseXml } from './xml-lite.mjs'

export const MODEL_VERSION = 2
const DEFAULT_RESIST_CAP = 75
const num = (v) => (v === undefined || v === 'nil' || v === '' || Number.isNaN(Number(v)) ? null : Number(v))
const bool = (v, dflt = false) => (v === undefined || v === 'nil' ? dflt : v === 'true')

function playerStats(build) {
  const s = {}
  for (const n of kids(build, 'PlayerStat')) {
    const v = Number(n.attrs.value)
    if (!Number.isNaN(v)) s[n.attrs.stat] = v
  }
  return s
}

// Resist caps: PoB's `<Elem>Resist` is the value after the cap; `<Elem>ResistOverCap` is what is above it.
// When over cap, cap === value (exact). Otherwise the real cap is not in the XML (needs `*ResistMax` from the engine
// snapshot); we report the default 75 with capSource 'assumed' so consumers can tell the difference.
function resists(stats) {
  const out = {}
  for (const el of ['Fire', 'Cold', 'Lightning', 'Chaos']) {
    const value = stats[`${el}Resist`]
    if (value === undefined) continue
    const overCap = stats[`${el}ResistOverCap`] ?? 0
    const max = stats[`${el}ResistMax`]
    const cap = max ?? (overCap > 0 ? value : Math.max(DEFAULT_RESIST_CAP, value))
    out[el.toLowerCase()] = { value, overCap, cap, capSource: max !== undefined ? 'engine' : overCap > 0 ? 'derived' : 'assumed' }
  }
  return out
}

function parseModLine(raw) {
  let text = raw.trim()
  const flags = {}
  const tags = {}
  for (;;) {
    const m = /^\{([A-Za-z_]+)(?::([^}]*))?\}/.exec(text)
    if (!m) break
    text = text.slice(m[0].length)
    if (m[2] === undefined) flags[m[1]] = true
    else tags[m[1]] = m[2]
  }
  const rangeMatch = /\((-?[\d.]+)-(-?[\d.]+)\)/.exec(text)
  const tier = num(tags.tier)
  return {
    text,
    kind: flags.enchant ? 'enchant' : flags.rune ? 'rune' : flags.fractured ? 'fractured' : flags.desecrated ? 'desecrated' : flags.crafted ? 'crafted' : 'explicit',
    affix: flags.prefix || tags.affix === 'prefix' ? 'prefix' : flags.suffix || tags.affix === 'suffix' ? 'suffix' : null,
    tier,
    range: num(tags.range), // 0..1 roll position when the source has one
    rollMin: rangeMatch ? Number(rangeMatch[1]) : null,
    rollMax: rangeMatch ? Number(rangeMatch[2]) : null,
    crafted: !!flags.crafted,
    fractured: !!flags.fractured,
    desecrated: !!flags.desecrated,
    corrupted: false,
    tags: { ...tags, ...flags },
    implicit: false,
    raw,
  }
}

const BASE_NAME_CACHE = new WeakMap()

export function parseItem(node, opts = {}) {
  const lines = node.text.split('\n').map((l) => l.replace(/\r$/, '').trim()).filter((l) => l !== '')
  const item = { id: num(node.attrs.id), rarity: null, name: null, base: null, headers: {}, mods: [], corrupted: false, mirrored: false, unidentified: false, sockets: null, runes: [], raw: node.text }
  let i = 0
  const rar = /^Rarity:\s*(.+)$/i.exec(lines[0] ?? '')
  if (rar) {
    item.rarity = rar[1].toUpperCase()
    i = 1
  }
  const single = item.rarity === 'NORMAL' || item.rarity === 'MAGIC'
  item.name = lines[i++] ?? null
  if (single) item.base = item.name
  else item.base = lines[i++] ?? null
  // header "Key: value" lines up to the Implicits count
  let implicitCount = 0
  for (; i < lines.length; i++) {
    const l = lines[i]
    const im = /^Implicits:\s*(\d+)/.exec(l)
    if (im) {
      implicitCount = Number(im[1])
      i++
      break
    }
    const kv = /^([A-Za-z][A-Za-z ]*?):\s*(.*)$/.exec(l)
    if (!kv) break
    if (kv[1] === 'Rune') item.runes.push(kv[2])
    else item.headers[kv[1]] = kv[2]
  }
  for (let k = 0; i < lines.length; i++, k++) {
    const l = lines[i]
    if (l === 'Corrupted') item.corrupted = true
    else if (l === 'Mirrored') item.mirrored = true
    else if (l === 'Unidentified') item.unidentified = true
    else {
      const mod = parseModLine(l)
      mod.implicit = k < implicitCount
      item.mods.push(mod)
    }
  }
  item.itemLevel = num(item.headers['Item Level'])
  item.quality = num(item.headers.Quality)
  item.levelReq = num(item.headers.LevelReq)
  item.sockets = item.headers.Sockets ?? null
  for (const m of item.mods) m.corrupted = item.corrupted
  // <ModRange id range>: PoB's loader walks buffModLines -> enchantModLines -> implicitModLines -> explicitModLines
  // (runeModLines are skipped - the save side writes enchant, rune, implicit, explicit instead; that asymmetry is
  // in PoB itself, not something to "fix" here) to turn a 1-based `id` into a mod line. A flask/charm base's own
  // buffModLines (its granted-buff text, e.g. a charm's "Immune to X") are never printed as item text, so every id
  // printed after them is shifted by that many slots; nothing else in this fixture's bases has a nonzero count
  // (F1). `opts.bases` is a { baseName: buffLineCount } lookup (see scripts/extract-affixes.mjs's `bases[name][2]`
  // via web/gem-data.mjs-style loaders); an unknown base falls back to 0 and records a model warning.
  const basesBuff = opts.bases
  const modRanges = kids(node, 'ModRange')
  const maxId = modRanges.reduce((m, r) => Math.max(m, Number(r.attrs.id)), 0)
  // No bases table at all: re-derive the offset from the ids already on the item (same heuristic
  // web/build-edit.mjs's buffOf uses) rather than silently assuming 0.
  let buff = basesBuff ? 0 : Math.max(0, maxId - item.mods.length)
  if (basesBuff && item.base !== null) {
    // Magic items print "<prefix> <BaseName> of <suffix>" as their base line (see item.base above): fall back to
    // the longest known base name the text contains, same rule web/affix-tiers.mjs's resolveBase uses.
    const key = Object.hasOwn(basesBuff, item.base)
      ? item.base
      : (BASE_NAME_CACHE.get(basesBuff) ?? BASE_NAME_CACHE.set(basesBuff, Object.keys(basesBuff).sort((a, b) => b.length - a.length)).get(basesBuff)).find(
          (b) => item.base.includes(b),
        )
    if (key !== undefined) buff = basesBuff[key] ?? 0
    else {
      opts.warnings?.push({
        code: 'unknown-base-for-modrange',
        severity: 'warning',
        path: `items.byId.${item.id}`,
        message: `item ${item.id}: base "${item.base}" is not in the bases table; assuming 0 buff lines for ModRange offsets`,
      })
    }
  }
  for (const r of modRanges) {
    const m = item.mods[Number(r.attrs.id) - 1 - buff]
    if (m && m.range === null) m.range = num(r.attrs.range)
  }
  return item
}

function items(root, opts) {
  const itemsNode = child(root, 'Items')
  if (!itemsNode) return { activeItemSet: null, byId: {}, slots: {}, sockets: [] }
  const byId = {}
  for (const n of kids(itemsNode, 'Item')) byId[n.attrs.id] = parseItem(n, opts)
  const sets = kids(itemsNode, 'ItemSet')
  const set = sets.find((s) => s.attrs.id === itemsNode.attrs.activeItemSet) ?? sets[0]
  const slots = {}
  const sockets = []
  for (const s of kids(set, 'Slot')) {
    const it = byId[s.attrs.itemId]
    slots[s.attrs.name] = { itemId: num(s.attrs.itemId) || null, active: bool(s.attrs.active, true), item: it ?? null }
  }
  for (const s of kids(set, 'SocketIdURL')) sockets.push({ nodeId: num(s.attrs.nodeId), name: s.attrs.name })
  return { activeItemSet: set?.attrs.id ?? null, byId, slots, sockets }
}

const isSupport = (g) => /SupportGem/.test(g.gemId ?? '') || /^Support/.test(g.skillId ?? '')

// Gem #6: look the item's gemId up in the bundled gem table (web/data/gems.json / web/gem-data.mjs) by exact id,
// falling back to its display name (an older/newer table might not have that exact gemId). null when there's no
// table or no match, never guessed.
function gemDataOf(gemTable, g) {
  if (!gemTable) return null
  const row = gemTable.gems.find((row) => row.gemId === g.attrs.gemId) ?? gemTable.gems.find((row) => row.name === g.attrs.nameSpec)
  return row ? { tags: row.tags, gemType: row.gemType, naturalMaxLevel: row.naturalMaxLevel } : null
}

function skills(root, mainSocketGroup, gemTable) {
  const node = child(root, 'Skills')
  if (!node) return { activeSkillSet: null, groups: [] }
  const sets = kids(node, 'SkillSet')
  const set = sets.find((s) => s.attrs.id === node.attrs.activeSkillSet) ?? sets[0] ?? node
  const groups = kids(set, 'Skill').map((sk, idx) => {
    const gems = kids(sk, 'Gem').map((g, gi) => ({
      index: gi,
      name: g.attrs.nameSpec,
      gemId: g.attrs.gemId,
      skillId: g.attrs.skillId,
      variantId: g.attrs.variantId,
      level: num(g.attrs.level),
      quality: num(g.attrs.quality),
      enabled: bool(g.attrs.enabled, true),
      corrupted: bool(g.attrs.corrupted) || (num(g.attrs.corruptLevel) ?? 0) > 0,
      support: isSupport(g.attrs),
      count: num(g.attrs.count),
      gemData: gemDataOf(gemTable, g),
    }))
    return {
      index: idx,
      label: sk.attrs.label || null,
      enabled: bool(sk.attrs.enabled, true),
      slot: sk.attrs.slot ?? null,
      source: sk.attrs.source ?? null,
      includeInFullDPS: sk.attrs.includeInFullDPS === 'nil' ? null : bool(sk.attrs.includeInFullDPS),
      isMain: mainSocketGroup === idx + 1,
      mainActiveSkill: num(sk.attrs.mainActiveSkill),
      active: gems.filter((g) => !g.support),
      supports: gems.filter((g) => g.support),
      gems,
    }
  })
  return { activeSkillSet: set.attrs.id ?? null, groups }
}

const BOSS_NAMES = { None: false, Boss: true, Pinnacle: true, 'Uber Pinnacle': true }

function config(root) {
  const node = child(root, 'Config')
  if (!node) return { configSet: null, boss: { isBoss: false, tier: 'None' }, conditions: [], buffsAndCharges: [], multipliers: {}, enemy: {}, inputs: {} }
  const sets = kids(node, 'ConfigSet')
  const set = sets.find((s) => s.attrs.id === node.attrs.activeConfigSet) ?? sets[0]
  const inputs = {}
  const placeholders = {}
  for (const n of kids(set, 'Input')) inputs[n.attrs.name] = n.attrs.boolean !== undefined ? n.attrs.boolean === 'true' : n.attrs.number !== undefined ? Number(n.attrs.number) : (n.attrs.string ?? null)
  for (const n of kids(set, 'Placeholder')) placeholders[n.attrs.name] = n.attrs.number !== undefined ? Number(n.attrs.number) : (n.attrs.string ?? null)
  const names = Object.keys(inputs)
  const on = (k) => inputs[k] === true
  const tier = typeof inputs.enemyIsBoss === 'string' ? inputs.enemyIsBoss : 'None'
  return {
    configSet: set?.attrs.id ?? null,
    boss: { isBoss: BOSS_NAMES[tier] ?? tier !== 'None', tier },
    conditions: names.filter((k) => /^condition/.test(k) && on(k)),
    buffsAndCharges: names.filter((k) => /^(use.*Charges|buff|usePower|useFrenzy|useEndurance)/i.test(k) && on(k)),
    multipliers: Object.fromEntries(names.filter((k) => /^multiplier/.test(k)).map((k) => [k, inputs[k]])),
    enemy: Object.fromEntries(Object.entries({ ...placeholders, ...inputs }).filter(([k]) => /^enemy/.test(k))),
    inputs, // every user-set Input
    placeholders, // PoB's default-valued fields; only apply when the input above is unset
  }
}

/** Typed model for one decoded PoB2 build (XML string). `extra.stats` (e.g. calc()'s `snapshot.resistMax`) is merged
 *  over the XML's PlayerStats, so resist caps become exact (`capSource: 'engine'`) instead of derived/assumed. */
export function buildModelOf(xml, extra = {}) {
  const root = parseXml(xml)
  if (!root || root.tag !== 'PathOfBuilding2') throw new Error('Not a PathOfBuilding2 document.')
  const build = child(root, 'Build')
  const stats = { ...(build ? playerStats(build) : {}), ...(extra.stats ?? {}) }
  const tree = child(root, 'Tree')
  const specs = kids(tree, 'Spec')
  const spec = specs[Number(tree?.attrs.activeSpec) - 1] ?? specs[0]
  const mainSocketGroup = num(build?.attrs.mainSocketGroup)
  const warnings = []
  const it = items(root, { bases: extra.bases, warnings })
  return {
    modelVersion: MODEL_VERSION,
    warnings,
    character: {
      class: build?.attrs.className ?? null,
      ascendancy: build?.attrs.ascendClassName && build.attrs.ascendClassName !== 'None' ? build.attrs.ascendClassName : null,
      level: num(build?.attrs.level),
      targetVersion: build?.attrs.targetVersion ?? null,
      treeVersion: spec?.attrs.treeVersion ?? null,
      mainSocketGroup,
    },
    resists: resists(stats),
    items: it,
    skills: skills(root, mainSocketGroup, extra.gemTable),
    config: config(root),
  }
}
