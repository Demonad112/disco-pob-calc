#!/usr/bin/env node
// Build the gem id lookup resolveGem() (web/gem-data.mjs) uses to turn a gem's display name into the ids a PoB2
// <Gem> element needs (gemId/skillId/variantId).
//
//   node scripts/extract-gems.mjs [pob2Dir=vendor/pob2] [out=web/data/gems.json]
//
// Reads PoB2's generated src/Data/Gems.lua. Nothing is scraped; re-run it when the vendor/pob2 pin moves.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLuaValue } from './extract-affixes.mjs'

export const SCHEMA = 1

// Gems.lua entries are multi-line tables (unlike ModItem.lua's one-per-line mods): capture each block by its
// indentation (entry close is one tab, a nested table like `tags = {...}` closes at two), then parse the block
// text itself as a Lua table literal.
function loadGems(dataDir) {
  const text = readFileSync(join(dataDir, 'Gems.lua'), 'utf8')
  const out = []
  for (const m of text.matchAll(/^\t\["([^"]+)"\] = \{\n([\s\S]*?)\n\t\},$/gm)) {
    const t = parseLuaValue(`{\n${m[2]}\n}`)
    out.push({ key: m[1], t })
  }
  return out
}

export function buildGemTable(pob2Dir) {
  const dataDir = join(pob2Dir, 'src/Data')
  const gems = []
  for (const { key, t } of loadGems(dataDir)) {
    if (!t.gameId || !t.grantedEffectId) continue // a few rows (hidden/placeholder gems) are missing ids
    const { _arr, ...tagsObj } = t.tags ?? {}
    gems.push({
      key,
      name: t.name ?? null,
      gemId: t.gameId,
      skillId: t.grantedEffectId,
      variantId: t.variantId ?? null,
      support: t.gemType === 'Support',
      tags: Object.keys(tagsObj).sort(),
      gemType: t.gemType ?? null,
      naturalMaxLevel: t.naturalMaxLevel ?? null,
    })
  }
  gems.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  let commit = null
  let version = null
  try {
    commit = execFileSync('git', ['-C', pob2Dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {}
  try {
    version = /Version number="([^"]+)"/.exec(readFileSync(join(pob2Dir, 'manifest.xml'), 'utf8'))?.[1] ?? null
  } catch {}
  return { schema: SCHEMA, source: { pob2Commit: commit, pob2Version: version }, gems }
}

export function serializeGemTable(t) {
  return (
    [
      `{"schema":${t.schema},"source":${JSON.stringify(t.source)},`,
      `"gems":[\n${t.gems.map((g) => JSON.stringify(g)).join(',\n')}\n]}`,
    ].join('\n') + '\n'
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const pob2 = resolve(process.argv[2] ?? join(root, 'vendor/pob2'))
  const out = resolve(process.argv[3] ?? join(root, 'web/data/gems.json'))
  const table = buildGemTable(pob2)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, serializeGemTable(table))
  console.log(`${table.gems.length} gems -> ${out} (pob2 ${table.source.pob2Version ?? '?'} @ ${table.source.pob2Commit?.slice(0, 7) ?? '?'})`)
}
