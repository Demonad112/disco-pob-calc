// Gem id lookup (Group A #6): turn a gem's display name into the ids a PoB2 <Gem> element needs
// (gemId/skillId/variantId). Data: web/data/gems.json, built from the PoB2 fork's src/Data/Gems.lua by
// scripts/extract-gems.mjs. Pure functions, no I/O.
import { loadData } from './affix-data.mjs'

export function loadGemTable() {
  return loadData('gems')
}

/** Every gem whose display name matches (case-insensitive). Several gems can share a display name (e.g. gem
 *  variants, or a reworked gem that kept its old display name): the caller decides what to do with more than one. */
export function findGems(table, name) {
  const n = name.trim().toLowerCase()
  return (table?.gems ?? []).filter((g) => g.name?.toLowerCase() === n)
}

/** Resolve a gem name to one match: the gem record, `{ ambiguous: [...] }` when several gems share that name, or
 *  null when none do. */
export function resolveGem(table, name) {
  const matches = findGems(table, name)
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) return { ambiguous: matches }
  return null
}
