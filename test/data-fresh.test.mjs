// Every web/data/*.json with a `source.pob2Commit` must match the vendor/pob2 submodule's pinned commit, so a
// vendor/pob2 bump that forgets `npm run extract` fails CI instead of silently shipping stale data.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

const ROOT = new URL('..', import.meta.url).pathname
const pinned = execFileSync('git', ['ls-tree', 'HEAD', 'vendor/pob2'], { cwd: ROOT, encoding: 'utf8' }).trim().split(/\s+/)[2]

test('vendor/pob2 is pinned to a commit', () => {
  assert.match(pinned ?? '', /^[0-9a-f]{40}$/)
})

const dataDir = ROOT + 'web/data'
const files = readdirSync(dataDir).filter((f) => f.endsWith('.json'))
assert.ok(files.length > 0, 'web/data should have at least one extracted table')

for (const f of files) {
  test(`${f}: source.pob2Commit matches the pinned vendor/pob2 commit`, () => {
    const data = JSON.parse(readFileSync(`${dataDir}/${f}`, 'utf8'))
    if (!data.source?.pob2Commit) return // not every data file need carry one
    assert.equal(data.source.pob2Commit, pinned, `${f} was built from a different vendor/pob2 commit than HEAD pins - run npm run extract`)
  })
}
