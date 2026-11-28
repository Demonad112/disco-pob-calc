// Corpus parity: every fixture in fixtures/corpus decoded and recomputed by the native engine must reproduce its oracle
// (snapshot.export.PlayerStat and MinionStat, compared with diff() from compare.mjs: 1e-9 relative).
//   npm run test:corpus-parity      (needs build/native/pobcalc: scripts/checkout-pob2.sh, npm run build:native)
// ninja-default is REAL: its oracle is the PlayerStat/MinionStat PoB desktop wrote into the export, and the engine is
// also checked against the XML directly. The other fixtures are SYNTHETIC edits of it whose oracle is the engine's
// own earlier recompute (scripts/make-corpus.mjs), so for those a pass means "unchanged", not "matches PoB desktop".
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diff } from './compare.mjs'
import { label, manifest, oracleOf, pool, runFixture, skip, xmlStats } from './corpus.mjs'

const runs = skip ? null : pool(manifest, (f) => runFixture(f.id))
const get = (path, obj) => path.split('.').reduce((o, k) => o?.[k], obj)

test('manifest lists the real fixture and labels every other one synthetic', () => {
  assert.equal(manifest.filter((f) => !f.synthetic).map((f) => f.id).join(), 'ninja-default')
  assert.ok(manifest.length >= 15)
  for (const f of manifest) assert.equal(oracleOf(f.id).synthetic, f.synthetic, f.id)
})

for (const [i, f] of manifest.entries()) {
  test(`parity: ${label(f)}`, { skip, timeout: 600_000 }, async () => {
    const { res, xml } = (await runs)[i]
    const oracle = oracleOf(f.id)
    const exp = res.snapshot.export
    assert.deepEqual(diff(exp.PlayerStat, oracle.PlayerStat, 'PlayerStat'), [])
    assert.deepEqual(diff(exp.MinionStat, oracle.MinionStat, 'MinionStat'), [])
    // The stats each fixture exists to exercise are non-zero (a zero would mean the archetype isn't really calculated).
    const stats = { PlayerStat: exp.PlayerStat, MinionStat: exp.MinionStat }
    for (const p of f.positive) assert.ok(get(p, stats) > 0, `${f.id}: ${p} = ${get(p, stats)}`)
    assert.equal(exp.PlayerStat.TotalDPS, f.TotalDPS, 'manifest TotalDPS')
    if (!f.synthetic) {
      // Independent of the oracle file: the engine against the XML's own PlayerStat (what PoB desktop computed).
      const xmlPlayer = xmlStats(xml, 'PlayerStat')
      assert.ok(Object.keys(xmlPlayer).length > 50, 'the real export carries PlayerStat')
      assert.deepEqual(diff(exp.PlayerStat, xmlPlayer, 'PlayerStat'), [])
      assert.deepEqual(diff(exp.MinionStat, xmlStats(xml, 'MinionStat'), 'MinionStat'), [])
      assert.equal(Math.round(exp.PlayerStat.TotalDPS), 186706)
    }
  })
}
