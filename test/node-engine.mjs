// Boot dist/engine.mjs in Node with vendor/pob2 and lua/ mounted straight from the repo (NODEFS), no packing.
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { LUA_DIR, VENDOR_DIR, wrapEngine } from '../web/engine-core.mjs'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))

export function pinCommit() {
  try {
    return execFileSync('git', ['-C', ROOT + 'vendor/pob2', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

export async function bootNodeEngine({ quiet = true, dist = ROOT + 'dist/' } = {}) {
  const { default: createPobEngine } = await import(dist + 'engine.mjs')
  const stderr = []
  const Module = await createPobEngine({
    print: (s) => stderr.push(s),
    printErr: (s) => (quiet ? stderr.push(s) : console.error(s)),
  })
  const { FS } = Module
  FS.mkdirTree('/pob/vendor')
  FS.mkdirTree('/pob/lua')
  FS.mount(Module.NODEFS ?? FS.filesystems.NODEFS, { root: ROOT + 'vendor/pob2' }, VENDOR_DIR)
  FS.mount(Module.NODEFS ?? FS.filesystems.NODEFS, { root: ROOT + 'lua' }, LUA_DIR)
  return { engine: wrapEngine(Module), stderr }
}
