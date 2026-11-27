// Affix tier lookup (P0.5): puts tier / prefix-or-suffix / roll range / roll position / best available tier on item mod
// lines that only carry the rolled value (poe.ninja-style exports, trade copies, PoB items without {tier:N}).
//
// Data: web/data/affixes.json, built from the PoB2 fork's src/Data/{ModItem,ModJewel,ModFlask,ModCharm}.lua and
// Bases/*.lua by scripts/extract-affixes.mjs. Pure functions, no I/O, usable in Node and the browser.
//
// How a line is matched:
//  1. Turn the text into a template ("+# to maximum Life"); every number, or "(a-b)" range, is a value slot.
//  2. Take the mods with that template that can spawn on the item's base (PoB's rule: the first weightKey the base
//     has a tag for decides the weight; 0 means it cannot spawn). That is what separates local from global mods.
//  3. Keep the ones whose slot ranges contain the rolled values and whose level is at most the item level.
//  4. Tier = rank of the mod's level inside its group among the mods that can spawn on this base (T1 = best).
//  5. One candidate is "exact"; several are "ambiguous" and reported as such (tier null, tierLabel "T2 or T3").
//     Other statuses: 'off-base' (text matches a mod this base cannot roll), 'unmatched', 'no-base', 'not-covered'.
// Multi-line (hybrid) mods are matched as a unit across consecutive lines, and preferred over separate single-line
// mods; when the lines could also be two separate mods the lookup carries the note 'hybrid-or-separate'.

const EPS = 1e-6
const NUM = /\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)|\d+(?:\.\d+)?/g

/** "+(5-8) to Strength" -> { template: "+# to Strength", slots: [[5, 8]] }; plain numbers are fixed slots. */
export function modTemplate(text) {
  const slots = []
  const template = text.replace(NUM, (m, a, b) => {
    slots.push(a !== undefined ? [Number(a), Number(b)] : [Number(m), Number(m)])
    return '#'
  })
  return { template, slots }
}

// Item-side tokens: a rolled value, or an unrolled "(a-b)" range as PoB prints it next to a {range:x} tag.
function itemValues(text) {
  const vals = []
  const template = text.replace(NUM, (m, a, b) => {
    vals.push(a !== undefined ? { lo: Number(a), hi: Number(b) } : { v: Number(m) })
    return '#'
  })
  return { template, vals }
}

const SRC_BY_TYPE = { Jewel: 'jewel', Flask: 'flask', Charm: 'charm' }
const srcOfBaseType = (type) => SRC_BY_TYPE[type] ?? 'item'
const near = (a, b) => Math.abs(a - b) < EPS

export function indexAffixes(table) {
  const byTemplate = new Map()
  for (const mod of table.mods) {
    mod.l.forEach((line, li) => {
      if (!byTemplate.has(line.p)) byTemplate.set(line.p, [])
      byTemplate.get(line.p).push({ mod, li })
    })
  }
  return { table, byTemplate, spawnCache: new Map() }
}

function spawnWeight(table, mod, tags) {
  const [keys, vals] = table.weights[mod.w]
  for (let i = 0; i < keys.length; i++) if (tags.has(keys[i])) return vals[i] ?? 0
  return 0
}

// Magic items are named "<prefix> <base> <suffix>": fall back to the longest base name contained in the item name.
function resolveBase(idx, name) {
  const { bases } = idx.table
  if (bases[name]) return name
  idx.baseNames ??= Object.keys(bases).sort((a, b) => b.length - a.length)
  return idx.baseNames.find((b) => name.includes(b)) ?? null
}

// group -> mods that can spawn on this base, best first. Cached per base.
function groupsFor(idx, itemName) {
  const baseName = resolveBase(idx, itemName)
  if (idx.spawnCache.has(baseName)) return idx.spawnCache.get(baseName)
  const { table } = idx
  const base = baseName ? table.bases[baseName] : null
  let out = null
  if (base) {
    const tags = new Set(table.tagSets[base[1]])
    const src = srcOfBaseType(base[0])
    const groups = new Map()
    for (const mod of table.mods) {
      if (mod.s !== src || spawnWeight(table, mod, tags) <= 0) continue
      if (!groups.has(mod.g)) groups.set(mod.g, [])
      groups.get(mod.g).push(mod)
    }
    const key = (m) => m.l.reduce((s, l) => s + l.r.reduce((a, r) => a + r[1], 0), 0)
    const tier = new Map()
    for (const [g, list] of groups) {
      list.sort((a, b) => b.lv - a.lv || key(b) - key(a) || (a.id < b.id ? -1 : 1))
      list.forEach((m, i) => tier.set(m, i + 1))
    }
    out = { src, groups, tier, tags, baseName }
  }
  idx.spawnCache.set(baseName, out)
  return out
}

function lineFits(slots, vals) {
  if (slots.length !== vals.length) return false
  return slots.every((s, i) => {
    const v = vals[i]
    if (v.v !== undefined) return v.v >= s[0] - EPS && v.v <= s[1] + EPS
    return near(v.lo, s[0]) && near(v.hi, s[1]) // unrolled range text: must be this tier's own range
  })
}

// Mean position of the rolled values inside their ranges (0 = min, 1 = max); null when nothing can vary.
function rollPosition(slots, vals, range) {
  const pos = []
  slots.forEach((s, i) => {
    if (s[1] - s[0] < EPS) return
    const v = vals[i].v !== undefined ? vals[i].v : range !== null && range !== undefined ? s[0] + range * (s[1] - s[0]) : null
    if (v !== null) pos.push(Math.min(1, Math.max(0, (v - s[0]) / (s[1] - s[0]))))
  })
  return pos.length ? pos.reduce((a, b) => a + b, 0) / pos.length : null
}

const slotsOut = (line) => line.r.map(([min, max]) => ({ min, max }))

function describe(ctx, mod, li, vals, range) {
  const { spawn, itemLevel } = ctx
  const list = spawn.groups.get(mod.g)
  const tier = spawn.tier.get(mod)
  const atLevel = itemLevel === null ? list : list.filter((m) => m.lv <= itemLevel)
  const best = atLevel[0] ?? null
  return {
    modId: mod.id,
    group: mod.g,
    name: mod.n ?? null,
    affix: mod.t === 'P' ? 'prefix' : 'suffix',
    tier,
    tierOf: list.length,
    tierLevel: mod.lv,
    ranges: slotsOut(mod.l[li]),
    topTier: { modId: list[0].id, ranges: slotsOut(list[0].l[li] ?? list[0].l[0]) },
    bestAvailable: best && { modId: best.id, tier: spawn.tier.get(best), ranges: slotsOut(best.l[li] ?? best.l[0]) },
    rollPosition: rollPosition(mod.l[li].r, vals, range),
  }
}

// A mod the base cannot roll naturally: known prefix/suffix and range, no tier.
function describeOffBase(mod, li, vals, range) {
  return {
    modId: mod.id,
    group: mod.g,
    name: mod.n ?? null,
    affix: mod.t === 'P' ? 'prefix' : 'suffix',
    tier: null,
    tierOf: null,
    tierLevel: mod.lv,
    ranges: slotsOut(mod.l[li]),
    topTier: null,
    bestAvailable: null,
    rollPosition: rollPosition(mod.l[li].r, vals, range),
  }
}

function finish(ctx, status, candidates, notes) {
  const out = { status, tier: null, tierLabel: null, affix: null, candidates, notes }
  if (!candidates.length) return out
  const tiers = [...new Set(candidates.map((c) => c.tier).filter((t) => t !== null))].sort((a, b) => a - b)
  out.tierLabel = tiers.length ? tiers.map((t) => `T${t}`).join(' or ') : null
  const affixes = new Set(candidates.map((c) => c.affix))
  if (affixes.size === 1) out.affix = [...affixes][0]
  if (candidates.length === 1) Object.assign(out, candidates[0])
  else if (new Set(candidates.map((c) => c.group)).size === 1) out.group = candidates[0].group
  out.itemLevel = ctx.itemLevel
  return out
}

// All mods (grouped by identity) whose lines k..k+n-1 match the item mods at positions i..i+n-1.
function matchAt(ctx, i, lines, n) {
  const first = lines[i]
  const found = []
  for (const { mod, li } of ctx.idx.byTemplate.get(first.t) ?? []) {
    if (li !== 0 || mod.l.length !== n || mod.s !== ctx.spawn.src) continue
    if (!ctx.spawn.groups.get(mod.g)?.includes(mod)) continue
    let ok = true
    for (let k = 0; k < n && ok; k++) {
      const l = lines[i + k]
      ok = !!l && l.t === mod.l[k].p && lineFits(mod.l[k].r, l.vals)
    }
    if (ok) found.push(mod)
  }
  return found
}

function annotateItem(item, idx) {
  if (item.rarity !== 'RARE' && item.rarity !== 'MAGIC') return
  const spawn = item.base ? groupsFor(idx, item.base) : null
  const ctx = { idx, spawn, itemLevel: item.itemLevel ?? null }
  const mods = item.mods
  // Affix lines only: implicit, enchant and rune lines are skipped.
  const lines = mods.map((m) => {
    if (m.implicit || !(m.kind === 'explicit' || m.kind === 'fractured' || m.kind === 'crafted' || m.kind === 'desecrated')) return null
    const { template, vals } = itemValues(m.text)
    return { t: template, vals, mod: m }
  })
  for (let i = 0; i < mods.length; ) {
    const line = lines[i]
    if (!line) {
      i++
      continue
    }
    const m = line.mod
    if (m.kind === 'crafted' || m.kind === 'desecrated') {
      m.lookup = { status: 'not-covered', tier: null, tierLabel: null, affix: null, candidates: [], notes: [`${m.kind} mods are not in the item mod tables`] }
      i++
      continue
    }
    if (!spawn) {
      m.lookup = { status: 'no-base', tier: null, tierLabel: null, affix: null, candidates: [], notes: [`base "${item.base}" not in the base table`] }
      i++
      continue
    }
    // hybrid: longest run of consecutive affix lines that one multi-line mod explains
    let span = 1
    let hits = []
    for (let n = Math.min(4, lines.length - i); n >= 2; n--) {
      if (lines.slice(i, i + n).some((l) => !l || l.mod.kind === 'crafted' || l.mod.kind === 'desecrated')) continue
      hits = matchAt(ctx, i, lines, n)
      if (hits.length) {
        span = n
        break
      }
    }
    const notes = []
    const singles = (l) => (idx.byTemplate.get(l.t) ?? []).filter((e) => e.mod.l.length === 1 && e.mod.s === spawn.src)
    const spawnable = (mod) => spawn.groups.get(mod.g)?.includes(mod)
    if (!hits.length) hits = singles(line).filter((e) => spawnable(e.mod) && lineFits(e.mod.l[0].r, line.vals)).map((e) => e.mod)
    else if (lines.slice(i, i + span).every((l) => singles(l).some((e) => spawnable(e.mod) && lineFits(e.mod.l[0].r, l.vals)))) notes.push('hybrid-or-separate')
    if (hits.length > 1 && item.rarity === 'MAGIC' && item.name) {
      const named = hits.filter((h) => h.n && item.name.includes(h.n))
      if (named.length && named.length < hits.length) {
        notes.push('narrowed by the affix name in the item name')
        hits = named
      }
    }
    if (hits.length && ctx.itemLevel !== null) {
      const ok = hits.filter((h) => h.lv <= ctx.itemLevel)
      if (ok.length && ok.length < hits.length) notes.push(`excluded ${hits.length - ok.length} tier(s) above item level ${ctx.itemLevel}`)
      if (ok.length) hits = ok
      else notes.push('only tiers above item level match')
    }
    let offBase = []
    if (!hits.length && span === 1) {
      offBase = singles(line).filter((e) => !spawnable(e.mod) && lineFits(e.mod.l[0].r, line.vals)).map((e) => e.mod)
      if (offBase.length) notes.push('matches a mod this base cannot roll naturally (essence or special craft, or newer data than this table), so no tier')
      else notes.push(singles(line).length ? 'value is outside every tier range (the line may add up several mods)' : 'no mod with this text in the item tables (desecrated, special base or non-craftable)')
    }
    for (let k = 0; k < span; k++) {
      const l = lines[i + k]
      const cands = offBase.length ? offBase.map((h) => describeOffBase(h, 0, l.vals, l.mod.range)) : hits.map((h) => describe(ctx, h, k, l.vals, l.mod.range))
      const status = offBase.length ? 'off-base' : !cands.length ? 'unmatched' : cands.length === 1 && !notes.includes('hybrid-or-separate') ? 'exact' : 'ambiguous'
      const lookup = finish(ctx, status, cands, notes.slice())
      if (span > 1) lookup.hybrid = { lines: span, index: k }
      if (cands.length > 1) lookup.notes.push(`${cands.length} candidate mods`)
      if (offBase.length && cands.length === 1) lookup.status = 'off-base'
      l.mod.lookup = lookup
      // fill what the text did not carry; text-provided {tier}/{prefix}/{suffix}/(a-b) always wins
      if (lookup.status === 'exact') {
        if (l.mod.tier === null) l.mod.tier = lookup.tier
        if (l.mod.rollMin === null && lookup.ranges.length === 1) {
          l.mod.rollMin = lookup.ranges[0].min
          l.mod.rollMax = lookup.ranges[0].max
        }
      }
      if (l.mod.affix === null && lookup.affix) l.mod.affix = lookup.affix
    }
    i += span
  }
}

/** Annotate every affix line of every item in a build model, in place. Returns the model. */
export function annotateModel(model, table) {
  if (!table) {
    model.affixData = null
    return model
  }
  const idx = indexAffixes(table)
  for (const item of Object.values(model.items.byId)) annotateItem(item, idx)
  model.affixData = { schema: table.schema, ...table.source }
  return model
}
