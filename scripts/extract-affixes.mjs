#!/usr/bin/env node
// Build the affix lookup the decoder uses to put tier / prefix-or-suffix / roll range on item mod lines.
//
//   node scripts/extract-affixes.mjs [pob2Dir=vendor/pob2] [out=web/data/affixes.json]
//
// Reads PoB2's generated data: src/Data/{ModItem,ModJewel,ModFlask,ModCharm}.lua (every craftable affix with its
// roll ranges, level, group, prefix/suffix and spawn weights) and src/Data/Bases/*.lua (base name -> type + tags).
// Nothing is scraped; re-run it when the vendor/pob2 pin moves. Output is one mod per line so diffs stay readable.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { modTemplate } from '../web/affix-tiers.mjs'

export const SCHEMA = 2
const SOURCES = { item: 'ModItem', jewel: 'ModJewel', flask: 'ModFlask', charm: 'ModCharm' }
// Desecrated mods (PoE2's Ritual/boss-god mechanic) live in ModVeiled.lua, PoB2's data.itemMods.Desecrated table.
// Filter per F2: only the four tags that mark a mod as a desecrated roll, and only mods that can actually spawn
// (PoB keeps some with every weight 0, e.g. ones superseded by newer content).
const DESECRATED_TAGS = ['ulaman_mod', 'amanamu_mod', 'kurgal_mod', 'unveiled_mod']
// Extra off-base sources used to classify a line this base cannot roll (F3/F4), in fallback order.
const EXTRA_SOURCES = { corruption: 'ModCorrupted', unique: 'ModItemExclusive' }

// ---- minimal Lua table-literal parser (the generated data files only use strings, numbers, booleans, tables) ----
export function parseLuaValue(src) {
  let i = 0
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++
      if (src.startsWith('--', i)) while (i < src.length && src[i] !== '\n') i++
      else return
    }
  }
  const str = () => {
    const q = src[i++]
    let out = ''
    while (src[i] !== q) {
      if (src[i] === '\\') {
        const c = src[++i]
        out += c === 'n' ? '\n' : c === 't' ? '\t' : c
      } else out += src[i]
      i++
    }
    i++
    return out
  }
  const value = () => {
    ws()
    const c = src[i]
    if (c === '"' || c === "'") return str()
    if (c === '{') return table()
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|nil)/.exec(src.slice(i, i + 40))
    if (!m) throw new Error(`Lua parse error near: ${src.slice(i, i + 60)}`)
    i += m[0].length
    return m[0] === 'true' ? true : m[0] === 'false' ? false : m[0] === 'nil' ? null : Number(m[0])
  }
  const table = () => {
    i++ // {
    const arr = []
    const obj = {}
    for (;;) {
      ws()
      if (src[i] === '}') {
        i++
        break
      }
      let key = null
      if (src[i] === '[') {
        i++
        ws()
        key = value()
        ws()
        i++ // ]
        ws()
        i++ // =
      } else {
        const m = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(src.slice(i, i + 80))
        if (m) {
          key = m[1]
          i += m[0].length
        }
      }
      const v = value()
      if (key === null) arr.push(v)
      else obj[key] = v
      ws()
      if (src[i] === ',' || src[i] === ';') i++
    }
    return Object.keys(obj).length ? { ...obj, _arr: arr } : arr
  }
  const out = value()
  return out
}

// A mod's display lines are the unkeyed strings of its table (hybrids have several).
function modEntry(id, t) {
  const lines = (t._arr ?? []).filter((s) => typeof s === 'string')
  return { id, lines, t }
}

function loadMods(dataDir, file) {
  const text = readFileSync(join(dataDir, `${file}.lua`), 'utf8')
  const out = []
  for (const line of text.split('\n')) {
    const m = /^\t\["([^"]+)"\] = (\{.*\}),?\s*$/.exec(line)
    if (!m) continue
    out.push(modEntry(m[1], parseLuaValue(m[2])))
  }
  return out
}

// Count of a base's "buff" mod lines (F1): the PoB loader's ModRange walk is buffModLines -> enchantModLines ->
// implicitModLines -> explicitModLines (no rune), but a flask/charm's buff lines are never printed as item text, so
// they shift every ModRange id printed after them. Only flask/charm bases carry a `flask.buff`/`charm.buff` array;
// everything else is 0.
function buffCountOf(block) {
  for (const key of ['flask', 'charm']) {
    const m = new RegExp(`\\b${key}\\s*=\\s*\\{([\\s\\S]*?)\\n\\t\\}`).exec(block) ?? new RegExp(`\\b${key}\\s*=\\s*\\{([^\\n]*)\\}`).exec(block)
    if (!m) continue
    const buff = /\bbuff\s*=\s*\{([^}]*)\}/.exec(m[1])
    if (buff) return [...buff[1].matchAll(/"(?:[^"\\]|\\.)*"/g)].length
  }
  return 0
}

function loadBases(dataDir) {
  const bases = {}
  const dir = join(dataDir, 'Bases')
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.lua'))) {
    const text = readFileSync(join(dir, f), 'utf8')
    for (const m of text.matchAll(/^itemBases\["([^"]+)"\] = \{\n([\s\S]*?)^\}/gm)) {
      const type = /^\ttype = "([^"]+)"/m.exec(m[2])?.[1]
      const tags = /^\ttags = \{([^}]*)\}/m.exec(m[2])?.[1]
      if (!type || tags === undefined) continue
      bases[m[1]] = { type, tags: [...tags.matchAll(/(\w+) = true/g)].map((x) => x[1]).sort(), buff: buffCountOf(m[2]) }
    }
  }
  return bases
}

// ModVeiled.lua (desecrated), ModCorrupted.lua (corruption implicits) and ModItemExclusive.lua (unique-only) share
// ModItem's per-mod shape but live in their own file with no SOURCES prefix lookup.
function loadExtra(dataDir, file) {
  const text = readFileSync(join(dataDir, `${file}.lua`), 'utf8')
  const out = []
  for (const m of text.matchAll(/^\t\["([^"]+)"\] = (\{.*\}),?\s*$/gm)) out.push(modEntry(m[1], parseLuaValue(m[2])))
  return out
}

function loadEssences(dataDir) {
  const text = readFileSync(join(dataDir, 'Essence.lua'), 'utf8')
  const essences = {}
  for (const m of text.matchAll(/^\t\["([^"]+)"\] = (\{.*\}),?\s*$/gm)) {
    const t = parseLuaValue(m[2])
    const { _arr, ...mods } = t.mods ?? {}
    essences[m[1]] = { name: t.name, type: t.type, tierLevel: t.tierLevel, mods }
  }
  return essences
}

export function buildAffixTable(pob2Dir) {
  const dataDir = join(pob2Dir, 'src/Data')
  const tagSets = []
  const tagSetIdx = new Map()
  const intern = (arr, pool, idx) => {
    const k = JSON.stringify(arr)
    if (!idx.has(k)) idx.set(k, pool.push(arr) - 1)
    return idx.get(k)
  }
  const weights = []
  const weightIdx = new Map()

  const bases = {}
  for (const [name, b] of Object.entries(loadBases(dataDir)).sort(([a], [b2]) => (a < b2 ? -1 : 1))) {
    bases[name] = [b.type, intern(b.tags, tagSets, tagSetIdx), b.buff]
  }

  const lines = (text) => {
    const { template, slots } = modTemplate(text)
    return { p: template, r: slots }
  }
  const mods = []
  for (const [src, file] of Object.entries(SOURCES)) {
    for (const { id, lines: ls, t } of loadMods(dataDir, file)) {
      if (t.type !== 'Prefix' && t.type !== 'Suffix') continue
      mods.push({
        id,
        s: src,
        t: t.type === 'Prefix' ? 'P' : 'S',
        lv: t.level,
        g: t.group,
        n: t.affix || undefined,
        w: intern([t.weightKey, t.weightVal], weights, weightIdx),
        l: ls.map(lines),
      })
    }
  }
  // Desecrated (F2): same shape, filtered to the four tags that mark a genuinely desecrated-only roll.
  for (const { id, lines: ls, t } of loadExtra(dataDir, 'ModVeiled')) {
    if (t.type !== 'Prefix' && t.type !== 'Suffix') continue
    if (!(t.modTags ?? []).some((tag) => DESECRATED_TAGS.includes(tag))) continue
    if (!(t.weightVal ?? []).some((v) => v > 0)) continue
    mods.push({ id, s: 'desecrated', t: t.type === 'Prefix' ? 'P' : 'S', lv: t.level, g: t.group, n: t.affix || undefined, w: intern([t.weightKey, t.weightVal], weights, weightIdx), l: ls.map(lines) })
  }
  // Off-base fallback families (F4): corruption implicits and unique-only mods, kept so a line that doesn't match
  // any spawnable affix can still be classified instead of reported unknown.
  for (const [cat, file] of Object.entries(EXTRA_SOURCES)) {
    for (const { id, lines: ls, t } of loadExtra(dataDir, file)) {
      mods.push({ id, s: cat, t: t.type === 'Prefix' ? 'P' : t.type === 'Suffix' ? 'S' : null, lv: t.level ?? null, g: t.group ?? id, n: t.affix || undefined, w: intern([t.weightKey ?? [], t.weightVal ?? []], weights, weightIdx), l: ls.map(lines) })
    }
  }

  const essences = {}
  for (const [k, v] of Object.entries(loadEssences(dataDir)).sort(([a], [b2]) => (a < b2 ? -1 : 1))) essences[k] = v

  let commit = null
  let version = null
  try {
    commit = execFileSync('git', ['-C', pob2Dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {}
  try {
    version = /Version number="([^"]+)"/.exec(readFileSync(join(pob2Dir, 'manifest.xml'), 'utf8'))?.[1] ?? null
  } catch {}
  mods.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.s < b.s ? -1 : 1))
  return { schema: SCHEMA, source: { pob2Commit: commit, pob2Version: version }, tagSets, weights, bases, mods, essences }
}

export function serializeAffixTable(t) {
  const lines = [
    `{"schema":${t.schema},"source":${JSON.stringify(t.source)},`,
    `"tagSets":${JSON.stringify(t.tagSets)},`,
    `"weights":${JSON.stringify(t.weights)},`,
    `"bases":{\n${Object.entries(t.bases).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',\n')}\n},`,
    `"mods":[\n${t.mods.map((m) => JSON.stringify(m)).join(',\n')}\n],`,
    `"essences":{\n${Object.entries(t.essences).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',\n')}\n}}`,
  ]
  return lines.join('\n') + '\n'
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const pob2 = resolve(process.argv[2] ?? join(root, 'vendor/pob2'))
  const out = resolve(process.argv[3] ?? join(root, 'web/data/affixes.json'))
  const table = buildAffixTable(pob2)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, serializeAffixTable(table))
  console.log(`${table.mods.length} mods, ${Object.keys(table.bases).length} bases -> ${out} (pob2 ${table.source.pob2Version ?? '?'} @ ${table.source.pob2Commit?.slice(0, 7) ?? '?'})`)
}
