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
//     Other statuses: 'off-base' (text matches a mod this base cannot roll), 'unmatched', 'no-base',
//     'combined'/'combined-ambiguous' (a line that sums several mods), 'exact-above-ilvl' (tier matches but its
//     level exceeds the item's recorded level: PoB data is trusted, so the export's ilvl may just be stale).
// Multi-line (hybrid) mods are matched as a unit across the item's lines, not only consecutive ones (real items
// order lines by statOrder, so a hybrid's partner line is often elsewhere); preferred over separate single-line
// mods, and when the lines could also be two separate mods the lookup carries the note 'hybrid-or-separate'.
// Lines this base cannot roll (off-base), plus {crafted}/{desecrated} lines, resolve through `lookup.source`:
// 'affix' (a normal spawnable mod) | 'essence' | 'desecrated' | 'corruption' | 'unique-only' | 'hand-wraps/abyss'
// | 'unknown'.

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
  // itemType -> Set of ModItem ids an essence can hit on that type (web/data/affixes.json's `essences` table: F3).
  const essenceModsByType = new Map()
  for (const ess of Object.values(table.essences ?? {})) {
    for (const [type, modId] of Object.entries(ess.mods ?? {})) {
      if (!essenceModsByType.has(type)) essenceModsByType.set(type, new Set())
      essenceModsByType.get(type).add(modId)
    }
  }
  return { table, byTemplate, spawnCache: new Map(), essenceModsByType }
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
export function groupsFor(idx, itemName) {
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
    out = { src, groups, tier, tags, baseName, type: base[0], buff: base[2] ?? 0 }
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

// Fallback classification for a line that does not match a normal spawnable affix of this base (F3/F4).
// Order: essence (for the base's item type) -> desecrated (ModVeiled) -> corruption implicits -> unique-only ->
// weight-0 ModItem entries (the "HandWraps…" abyss-jewel/glove family; anything else weight-0 is 'unknown').
function classifySource(ctx, mod) {
  if (mod.s === ctx.spawn.src && ctx.spawn.groups.get(mod.g)?.includes(mod)) return 'affix'
  if (ctx.essenceIds?.has(mod.id)) return 'essence'
  if (mod.s === 'desecrated') return 'desecrated'
  if (mod.s === 'corruption') return 'corruption'
  if (mod.s === 'unique') return 'unique-only'
  if (/^HandWraps/.test(mod.id)) return 'hand-wraps/abyss'
  return 'unknown'
}

function describeAny(ctx, mod, li, vals, range, source) {
  const d = source === 'affix' ? describe(ctx, mod, li, vals, range) : describeOffBase(mod, li, vals, range)
  d.source = source
  return d
}

// Every mod (any source table) with exactly one display line matching this template and whose range contains vals.
function singleCandidates(idx, line) {
  return (idx.byTemplate.get(line.t) ?? []).filter((e) => e.mod.l.length === 1 && lineFits(e.mod.l[0].r, line.vals)).map((e) => e.mod)
}

const ORDER_BY_KIND = {
  crafted: ['essence', 'affix'],
  desecrated: ['desecrated', 'affix'],
  explicit: ['affix', 'essence', 'desecrated', 'corruption', 'unique-only', 'hand-wraps/abyss'],
  fractured: ['affix', 'essence', 'desecrated', 'corruption', 'unique-only', 'hand-wraps/abyss'],
}

/** Resolve one line (any kind) against every source table, in the fallback order F2/F3/F4 call for. */
function resolveLine(ctx, idx, line, item) {
  const pool = singleCandidates(idx, line)
  const bySource = new Map()
  for (const mod of pool) {
    let s = classifySource(ctx, mod)
    // Unique-only and corruption mods can't appear as plain explicit lines on an item that isn't actually a
    // corrupted / UNIQUE-rarity item - without this, their huge pools make them look like a match for almost
    // any stray number.
    if (s === 'unique-only' && item.rarity !== 'UNIQUE') s = 'unknown'
    if (s === 'corruption' && !item.corrupted) s = 'unknown'
    if (!bySource.has(s)) bySource.set(s, [])
    bySource.get(s).push(mod)
  }
  const order = ORDER_BY_KIND[line.mod.kind] ?? ORDER_BY_KIND.explicit
  for (const s of order) {
    const list = bySource.get(s)
    if (list?.length) return { source: s, mods: list }
  }
  return { source: null, mods: [] }
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

// Every (mod, li) pair that could contribute to a sum (F5 "sum decomposition"): spawnable on this base, with a
// display line matching the template, whether that's the mod's only line or one line of a hybrid.
export function sumParts(ctx, template) {
  const out = []
  for (const { mod, li } of ctx.idx.byTemplate.get(template) ?? []) {
    if (mod.s !== ctx.spawn.src || !ctx.spawn.groups.get(mod.g)?.includes(mod)) continue
    out.push({ mod, li, range: mod.l[li].r[0] })
  }
  return out
}

// Combinations of 2 or 3 parts from DISTINCT affix groups whose summed ranges contain `value`.
export function sumCombinations(parts, value) {
  const out = []
  const n = parts.length
  const pick = (start, chosen) => {
    if (chosen.length >= 2) {
      const lo = chosen.reduce((s, p) => s + p.range[0], 0)
      const hi = chosen.reduce((s, p) => s + p.range[1], 0)
      if (value >= lo - EPS && value <= hi + EPS) out.push(chosen.slice())
    }
    if (chosen.length === 3) return
    for (let i = start; i < n; i++) {
      if (chosen.some((p) => p.mod.g === parts[i].mod.g)) continue
      chosen.push(parts[i])
      pick(i + 1, chosen)
      chosen.pop()
    }
  }
  pick(0, [])
  return out
}

function describePart(ctx, part) {
  const tier = ctx.spawn.tier.get(part.mod) ?? null
  return { modId: part.mod.id, tier, affix: part.mod.t === 'P' ? 'prefix' : 'suffix', ranges: slotsOut(part.mod.l[part.li]) }
}

// Non-adjacent hybrid search (F5): a multi-line mod's lines don't have to sit next to each other on the item, so
// search for each remaining line of a candidate mod anywhere among the still-unclaimed lines.
function findHybridAt(ctx, lines, claimed, i) {
  const first = lines[i]
  if (!first) return []
  const found = []
  for (const { mod, li } of ctx.idx.byTemplate.get(first.t) ?? []) {
    if (li !== 0 || mod.l.length < 2 || mod.s !== ctx.spawn.src) continue
    if (!ctx.spawn.groups.get(mod.g)?.includes(mod)) continue
    if (!lineFits(mod.l[0].r, first.vals)) continue
    const used = new Set([i])
    const indices = [i]
    let ok = true
    for (let k = 1; k < mod.l.length && ok; k++) {
      const want = mod.l[k]
      let hit = -1
      for (let j = 0; j < lines.length; j++) {
        if (used.has(j) || claimed.has(j) || !lines[j]) continue
        if (lines[j].t === want.p && lineFits(want.r, lines[j].vals)) {
          hit = j
          break
        }
      }
      if (hit < 0) {
        ok = false
        break
      }
      used.add(hit)
      indices.push(hit)
    }
    if (ok) found.push({ mod, indices })
  }
  return found
}

// PoB's affix budget: 3 prefixes + 3 suffixes on a rare (1 + 1 on magic), adjusted by any "+N Prefix/Suffix
// Modifier allowed" implicit present on the item (crafted bases, omens, etc).
const MODIFIER_ALLOWED = /^([+-]\d+)\s+(Prefix|Suffix)\s+Modifier allowed$/i
function affixBudget(item) {
  const budget = { prefix: item.rarity === 'MAGIC' ? 1 : 3, suffix: item.rarity === 'MAGIC' ? 1 : 3 }
  for (const m of item.mods) {
    if (!m.implicit) continue
    const mm = MODIFIER_ALLOWED.exec(m.text)
    if (mm) budget[mm[2].toLowerCase()] += Number(mm[1])
  }
  return budget
}

function setLookup(l, lookup) {
  l.mod.lookup = lookup
  if (lookup.status === 'exact' || lookup.status === 'exact-above-ilvl') {
    if (l.mod.tier === null) l.mod.tier = lookup.tier
    if (l.mod.rollMin === null && lookup.ranges?.length === 1) {
      l.mod.rollMin = lookup.ranges[0].min
      l.mod.rollMax = lookup.ranges[0].max
    }
  }
  if (l.mod.affix === null && lookup.affix) l.mod.affix = lookup.affix
}

function annotateItem(item, idx, warnings) {
  if (item.rarity !== 'RARE' && item.rarity !== 'MAGIC') return
  const spawn = item.base ? groupsFor(idx, item.base) : null
  const essenceIds = spawn ? idx.essenceModsByType.get(spawn.type) ?? new Set() : new Set()
  const ctx = { idx, spawn, itemLevel: item.itemLevel ?? null, essenceIds }
  const mods = item.mods
  // Affix lines only: implicit, enchant and rune lines are skipped.
  const lines = mods.map((m) => {
    if (m.implicit || !(m.kind === 'explicit' || m.kind === 'fractured' || m.kind === 'crafted' || m.kind === 'desecrated')) return null
    const { template, vals } = itemValues(m.text)
    return { t: template, vals, mod: m }
  })
  if (!spawn) {
    for (const l of lines) if (l) l.mod.lookup = { status: 'no-base', tier: null, tierLabel: null, affix: null, candidates: [], notes: [`base "${item.base}" not in the base table`] }
    return
  }
  const claimed = new Set()
  // Pass 1: hybrids, anywhere on the item (F5), longest line-count first so a 3-line mod wins over a 2-line one
  // that happens to share a line's template.
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i] || claimed.has(i)) continue
    const hits = findHybridAt(ctx, lines, claimed, i).sort((a, b) => b.mod.l.length - a.mod.l.length)
    if (!hits.length) continue
    const span = hits[0].mod.l.length
    let group = hits.filter((h) => h.mod.l.length === span)
    const notes = []
    if (group.length > 1 && item.rarity === 'MAGIC' && item.name) {
      const named = group.filter((h) => h.mod.n && item.name.includes(h.mod.n))
      if (named.length && named.length < group.length) {
        notes.push('narrowed by the affix name in the item name')
        group = named
      }
    }
    if (ctx.itemLevel !== null) {
      const ok = group.filter((h) => h.mod.lv <= ctx.itemLevel)
      if (ok.length && ok.length < group.length) notes.push(`excluded ${group.length - ok.length} tier(s) above item level ${ctx.itemLevel}`)
      if (ok.length) group = ok
    }
    const indices = group[0].indices
    const allSeparate = indices.every((ix) => singleCandidates(idx, lines[ix]).some((m) => m.s === spawn.src && spawn.groups.get(m.g)?.includes(m)))
    if (allSeparate) notes.push('hybrid-or-separate')
    for (let k = 0; k < indices.length; k++) {
      const l = lines[indices[k]]
      const cands = group.map((h) => describe(ctx, h.mod, k, l.vals, l.mod.range))
      let status = cands.length === 1 && !notes.includes('hybrid-or-separate') ? 'exact' : 'ambiguous'
      if (status === 'exact' && ctx.itemLevel !== null && cands[0].tierLevel > ctx.itemLevel) status = 'exact-above-ilvl'
      const lookup = finish(ctx, status, cands, notes.slice())
      lookup.source = 'affix'
      lookup.hybrid = { lines: indices.length, index: k }
      if (status === 'exact-above-ilvl') lookup.notes.push(`matched tier requires ilvl ${cands[0].tierLevel} > item level ${ctx.itemLevel}`)
      if (cands.length > 1) lookup.notes.push(`${cands.length} candidate mods`)
      setLookup(l, lookup)
      claimed.add(indices[k])
    }
  }
  // Pass 2: everything else, line by line.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l || claimed.has(i)) continue
    claimed.add(i)
    let { source, mods: cset } = resolveLine(ctx, idx, l, item)
    if (source) {
      const notes = []
      if (source === 'affix' && ctx.itemLevel !== null && cset.length > 1) {
        const ok = cset.filter((m) => m.lv <= ctx.itemLevel)
        if (ok.length && ok.length < cset.length) notes.push(`excluded ${cset.length - ok.length} tier(s) above item level ${ctx.itemLevel}`)
        if (ok.length) cset = ok
      }
      const cands = cset.map((mod) => describeAny(ctx, mod, 0, l.vals, l.mod.range, source))
      let status = source !== 'affix' ? 'off-base' : cands.length === 1 ? 'exact' : 'ambiguous'
      if (status === 'exact' && ctx.itemLevel !== null && cands[0].tierLevel > ctx.itemLevel) status = 'exact-above-ilvl'
      if (source !== 'affix') notes.push(`resolved via ${source} mods, not this base's normal affixes`)
      if (cands.length > 1) notes.push(`${cands.length} candidate mods`)
      const lookup = finish(ctx, status, cands, notes)
      lookup.source = source
      if (status === 'exact-above-ilvl') lookup.notes.push(`matched tier requires ilvl ${cands[0].tierLevel} > item level ${ctx.itemLevel}`)
      setLookup(l, lookup)
      continue
    }
    // Pass 3: sum decomposition (F5) - only for plain explicit/fractured lines with one rolled number.
    if ((l.mod.kind === 'explicit' || l.mod.kind === 'fractured') && l.vals.length === 1 && l.vals[0].v !== undefined) {
      const parts = sumParts(ctx, l.t)
      const combos = parts.length ? sumCombinations(parts, l.vals[0].v) : []
      if (combos.length) {
        const described = combos.map((c) => c.map((p) => describePart(ctx, p)))
        const unique = []
        const seen = new Set()
        for (const d of described) {
          const key = d.map((p) => p.modId).sort().join('+')
          if (!seen.has(key)) {
            seen.add(key)
            unique.push(d)
          }
        }
        const lookup = {
          status: unique.length === 1 ? 'combined' : 'combined-ambiguous',
          tier: null,
          tierLabel: null,
          affix: null,
          source: 'affix',
          candidates: [],
          combinations: unique,
          notes: [],
        }
        if (unique.length === 1) {
          lookup.parts = unique[0]
          const affixes = new Set(unique[0].map((p) => p.affix))
          if (affixes.size === 1) lookup.affix = [...affixes][0]
        } else lookup.notes.push(`${unique.length} combinations fit`)
        l.mod.lookup = lookup
        if (l.mod.affix === null && lookup.affix) l.mod.affix = lookup.affix
        continue
      }
    }
    const notes = [singleCandidates(idx, l).length ? 'value is outside every tier range' : 'no mod with this text in the item tables']
    notes.push('no combination fits')
    l.mod.lookup = { status: 'unmatched', tier: null, tierLabel: null, affix: null, source: 'unknown', candidates: [], notes }
  }
  // Item-level affix budget (F budget constraint): counts assigned prefixes/suffixes, including each part of a
  // 'combined' line, against the base's prefix/suffix allowance (adjusted for "Modifier allowed" implicits).
  const budget = affixBudget(item)
  const counts = { prefix: 0, suffix: 0 }
  for (const l of lines) {
    if (!l) continue
    const lk = l.mod.lookup
    if (!lk) continue
    if (lk.parts) for (const p of lk.parts) if (p.affix) counts[p.affix]++
    else if (lk.affix && (lk.status === 'exact' || lk.status === 'ambiguous' || lk.status === 'exact-above-ilvl')) counts[lk.affix]++
  }
  if (counts.prefix > budget.prefix || counts.suffix > budget.suffix) {
    warnings.push({
      code: 'affix-budget-exceeded',
      severity: 'warning',
      path: `items.byId.${item.id}`,
      message: `item ${item.id} (${item.name ?? item.base}) has ${counts.prefix} prefixes / ${counts.suffix} suffixes against a budget of ${budget.prefix}/${budget.suffix}`,
    })
  }
}

/** Annotate every affix line of every item in a build model, in place. Returns the model. */
export function annotateModel(model, table) {
  model.warnings ??= []
  if (!table) {
    model.affixData = null
    return model
  }
  const idx = indexAffixes(table)
  for (const item of Object.values(model.items.byId)) annotateItem(item, idx, model.warnings)
  model.affixData = { schema: table.schema, ...table.source }
  return model
}
