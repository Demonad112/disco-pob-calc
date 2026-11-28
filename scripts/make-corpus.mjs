// Builds fixtures/corpus/ from the one real PoB2 code in the repo (fixtures/oracle/ninja-default).
//   node scripts/make-corpus.mjs        (needs build/native/pobcalc and vendor/pob2: scripts/checkout-pob2.sh, npm run build:native)
//
// - `ninja-default` is REAL: its oracle is the PlayerStat block that PoB wrote into the export.
// - Every other fixture is SYNTHETIC: the ninja-default XML edited by the functions below (Config stripped, tree node
//   removed, skill group added, item line added). Their oracle is the native engine's own PlayerStat for the edited
//   XML, so those fixtures are regression fixtures, not independent truth. The test and manifest say so.
// Each fixture is written as <id>.code.txt (a normal PoB2 code, pasteable in the demo) and <id>.oracle.json.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { decodePobCode } from '../web/decode.mjs'

const ROOT = new URL('../', import.meta.url).pathname
const OUT = ROOT + 'fixtures/corpus/'
mkdirSync(OUT, { recursive: true })

const refXml = await decodePobCode(readFileSync(ROOT + 'fixtures/oracle/ninja-default.code.txt', 'utf8'))
const must = (xml, re, what) => {
  const out = xml.replace(re.re ?? re, re.to ?? '')
  if (out === xml) throw new Error(`edit did nothing: ${what}`)
  return out
}

// --- edits -----------------------------------------------------------------------------------------------------
// An export with an empty Config tab, and no PlayerStat (a synthetic edit makes the exported ones stale).
const bare = (xml) => must(must(xml, /<Input [^>]*\/>\s*/g, 'strip Config inputs'), /<PlayerStat [^>]*\/>\s*/g, 'strip PlayerStat')
const mainGroup = (n) => (xml) => must(xml, { re: /mainSocketGroup="\d+"/, to: `mainSocketGroup="${n}"` }, 'mainSocketGroup')
const dropNode = (id) => (xml) =>
  must(xml, { re: /(<Spec [^>]*nodes=")([^"]*)"/, to: (_, pre, nodes) => `${pre}${nodes.split(',').filter((n) => n !== String(id)).join(',')}"` }, `drop node ${id}`)
const addNode = (id) => (xml) => must(xml, { re: /(<Spec [^>]*nodes=")([^"]*)"/, to: (_, pre, nodes) => `${pre}${nodes},${id}"` }, `add node ${id}`)
const disableGem = (name) => (xml) =>
  must(xml, { re: new RegExp(`(<Gem [^>]*)enabled="true"([^>]*nameSpec="${name}")`), to: '$1enabled="false"$2' }, `disable ${name}`)
// A new skill group appended to the set and made the main one (group 19: the export has 18).
const addSkill = (gem) => (xml) => {
  const groups = (xml.match(/<Skill /g) || []).length
  const line = `<Gem corruptLevel="0" corrupted="nil" count="1" enableGlobal1="true" enableGlobal2="true" enabled="true" gemId="Metadata/Items/Gems/${gem.gem}" level="20" nameSpec="${gem.name}" quality="0" skillId="${gem.skill}" variantId="${gem.variant}"/>`
  const group = `<Skill enabled="true" includeInFullDPS="nil" label="" mainActiveSkill="1" mainActiveSkillCalcs="1">${line}</Skill>\n\t\t`
  const out = xml.replace(/(\n\t\t<\/SkillSet>)/, `\n\t\t${group.trimEnd()}$1`)
  if (out === xml) throw new Error('addSkill: no </SkillSet>')
  return mainGroup(groups + 1)(out)
}
// An extra mod line on the Mageblood belt (item 7): text after the last explicit line, before its ModRange elements.
const beltLine = (text) => (xml) =>
  must(xml, { re: /(All Mage&apos;s Legacies have 32% increased effect per duplicate Mage&apos;s Legacy you have\n)/, to: `$1${text}\n` }, `belt line ${text}`)
const pipe = (...fns) => (xml) => fns.reduce((x, f) => f(x), xml)

const FIREBALL = { gem: 'SkillGemFireball', name: 'Fireball', skill: 'FireballPlayer', variant: 'Fireball' }
const ZOMBIE = { gem: 'SkillGemRaiseZombie', name: 'Raise Zombie', skill: 'RaiseZombiePlayer', variant: 'RaiseZombie' }
const TOTEM = { gem: 'SkillGemShockwaveTotem', name: 'Shockwave Totem', skill: 'ShockwaveTotemPlayer', variant: 'ShockwaveTotem' }
const CONTAGION = { gem: 'SkillGemContagion', name: 'Contagion', skill: 'ContagionPlayer', variant: 'Contagion' }

// Power Charge generator facts about ninja-default: node 65204 (+2 max Power Charges) takes the maximum from 5 to the
// base 3; Profane Ritual (group 11) is the only skill that generates charges.
export const FIXTURES = [
  { id: 'ninja-default', synthetic: false, archetypes: ['spell', 'charges-with-generator', 'es-evasion'], note: 'the real export; Config as the player set it', edit: (x) => x },
  { id: 'bare-spell', synthetic: true, archetypes: ['spell', 'charges-with-generator', 'es-evasion'], note: 'ninja-default with an empty Config tab (main skill Storm Wave)', edit: bare },
  { id: 'attack', synthetic: true, archetypes: ['attack', 'charges-with-generator'], note: 'empty Config, main skill switched to Quarterstaff Strike', edit: pipe(bare, mainGroup(1)) },
  { id: 'charges-base-max-skill-generator', synthetic: true, archetypes: ['charges-with-generator'], note: 'empty Config, node 65204 removed so max Power Charges is the base 3; Profane Ritual still generates them', edit: pipe(bare, dropNode(65204)) },
  { id: 'charges-no-generator', synthetic: true, archetypes: ['charges-without-generator'], note: 'as above and Profane Ritual disabled: consumers remain, nothing generates charges', edit: pipe(bare, dropNode(65204), disableGem('Profane Ritual')) },
  { id: 'spell-fireball', synthetic: true, archetypes: ['spell'], note: 'empty Config, extra group Fireball as main skill', edit: pipe(bare, addSkill(FIREBALL)) },
  { id: 'minion-zombie', synthetic: true, archetypes: ['minion', 'spell'], note: 'empty Config, extra group Raise Zombie as main skill', edit: pipe(bare, addSkill(ZOMBIE)) },
  { id: 'totem', synthetic: true, archetypes: ['totem', 'attack'], note: 'empty Config, extra group Shockwave Totem as main skill', edit: pipe(bare, addSkill(TOTEM)) },
  { id: 'dot-contagion', synthetic: true, archetypes: ['dot-ailment', 'spell'], note: 'empty Config, extra group Contagion as main skill', edit: pipe(bare, addSkill(CONTAGION)) },
  { id: 'leech-attack', synthetic: true, archetypes: ['leech', 'attack'], note: 'attack fixture + belt line "Leeches 5% of Physical Attack Damage as Life"', edit: pipe(bare, mainGroup(1), beltLine('Leeches 5% of Physical Attack Damage as Life')) },
  { id: 'leech-consumer', synthetic: true, archetypes: ['leech', 'attack'], note: 'leech-attack + belt line "30% increased Damage while Leeching": a modifier that needs leeching', edit: pipe(bare, mainGroup(1), beltLine('Leeches 5% of Physical Attack Damage as Life'), beltLine('30% increased Damage while Leeching')) },
  { id: 'onslaught-consumer', synthetic: true, archetypes: ['onslaught', 'attack'], note: 'attack fixture + belt line "20% increased Attack Speed during Onslaught": a consumer, nothing grants Onslaught', edit: pipe(bare, mainGroup(1), beltLine('20% increased Attack Speed during Onslaught')) },
  { id: 'onslaught-granted', synthetic: true, archetypes: ['onslaught', 'attack'], note: 'onslaught-consumer + belt line "You have Onslaught": PoB itself already has Onslaught active', edit: pipe(bare, mainGroup(1), beltLine('20% increased Attack Speed during Onslaught'), beltLine('You have Onslaught')) },
  { id: 'ci-es', synthetic: true, archetypes: ['ci-es'], note: 'empty Config + keystone Chaos Inoculation (node 56349) added to the allocated nodes', edit: pipe(bare, addNode(56349)) },
  { id: 'life-armour', synthetic: true, archetypes: ['life-armour', 'attack'], note: 'attack fixture + belt lines "+800 to maximum Life" and "+3000 to Armour"', edit: pipe(bare, mainGroup(1), beltLine('+800 to maximum Life'), beltLine('+3000 to Armour')) },
]

const toCode = (xml) => deflateSync(Buffer.from(xml, 'utf8')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')

function recompute(xml, id) {
  const f = `/tmp/corpus-${id}.xml`
  writeFileSync(f, xml)
  const out = execFileSync(ROOT + 'build/native/pobcalc', ['lua/cli.lua', f], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
  const res = JSON.parse(out.trim().split('\n').pop())
  if (res.error) throw new Error(`${id}: ${res.error}`)
  return res
}

const xmlStats = (xml, tag) => Object.fromEntries([...xml.matchAll(new RegExp(`<${tag} stat="([^"]+)" value="([^"]+)"/>`, 'g'))].map((m) => [m[1], Number(m[2])]))

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const manifest = []
  for (const fx of FIXTURES) {
    const xml = fx.edit(refXml)
    const res = recompute(xml, fx.id)
    const ps = fx.synthetic ? res.snapshot.export.PlayerStat : xmlStats(xml, 'PlayerStat')
    const ms = fx.synthetic ? res.snapshot.export.MinionStat : xmlStats(xml, 'MinionStat')
    writeFileSync(OUT + `${fx.id}.code.txt`, toCode(xml) + '\n')
    writeFileSync(
      OUT + `${fx.id}.oracle.json`,
      JSON.stringify({ id: fx.id, synthetic: fx.synthetic, oracleSource: fx.synthetic ? 'native engine recompute of the edited XML (regression only)' : "the XML's own PlayerStat block (PoB desktop)", PlayerStat: ps, MinionStat: ms }, null, 2) + '\n',
    )
    manifest.push({ id: fx.id, synthetic: fx.synthetic, archetypes: fx.archetypes, note: fx.note, mainSkill: (res.mainSkill ?? res.snapshot.mainSkill)?.skill ?? null, TotalDPS: ps.TotalDPS })
    console.log(fx.id.padEnd(36), fx.synthetic ? 'synthetic' : 'REAL     ', String((res.mainSkill ?? res.snapshot.mainSkill)?.skill).padEnd(24), Math.round(ps.TotalDPS))
  }
  writeFileSync(OUT + 'manifest.json', JSON.stringify(manifest, null, 2) + '\n')
}
