#!/usr/bin/env node
// Package PoB2's calc files for the browser and assemble dist/.
//
//   node scripts/pack.mjs [--bytecode]
//
// 1. File set (relative to vendor/pob2), the same rule as upgraded-disco-companion's pob2:sync: src/*.lua,
//    src/Modules, src/Classes, src/Data (*.lua), src/TreeData/legion/*.lua, runtime/lua/**/*.lua, manifest.xml.
//    No art (PNG/DDS), no Export/, no binaries. Each src/TreeData/<ver>/tree.lua is its own lazily fetched pack.
// 2. Every Lua file is compiled inside the wasm engine itself (dist/engine.mjs), so the bytecode matches the target
//    (wasm32, Lua 5.2.4 + our patches) and a file the patched parser can't read fails the build: this is the
//    compile check. By default the Lua text is shipped: gzipped it is 3.3 MB against 5.9 MB of bytecode, and
//    bytecode only saves ~0.65 s of a ~3 s start (measured in Node, see README). --bytecode ships the compiled
//    chunks instead; their chunk names are the ones PoB's own loadfile/require would give.
// 3. Packs are PCK1 (web/pack.mjs) + gzip -9, named by content hash. dist/manifest.json lists them with sizes.
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'
import { buildPack } from '../web/pack.mjs'
import { bootNodeEngine, pinCommit, ROOT } from '../test/node-engine.mjs'

const VENDOR = join(ROOT, 'vendor/pob2')
const DIST = join(ROOT, 'dist')
const SOURCE_MODE = !process.argv.includes('--bytecode')

// Files the patched Lua 5.2 parser cannot read and PoB never loads on this runtime.
const EXCLUDE = new Map([
  ['runtime/lua/sha1/lua53_ops.lua', 'Lua 5.3 bitwise operators; sha1 only loads it when _VERSION is Lua 5.3'],
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function fileSet() {
  const rel = (p) => relative(VENDOR, p).split('\\').join('/')
  const core = []
  const trees = {}
  for (const name of readdirSync(join(VENDOR, 'src'))) {
    if (name.endsWith('.lua')) core.push(`src/${name}`)
  }
  for (const d of ['src/Modules', 'src/Classes', 'src/Data']) {
    for (const p of walk(join(VENDOR, d))) if (p.endsWith('.lua')) core.push(rel(p))
  }
  for (const p of walk(join(VENDOR, 'src/TreeData'))) {
    const r = rel(p)
    const m = r.match(/^src\/TreeData\/([0-9_]+)\/tree\.lua$/)
    if (m) trees[m[1]] = r
    else if (r.startsWith('src/TreeData/legion/') && r.endsWith('.lua')) core.push(r)
  }
  for (const p of walk(join(VENDOR, 'runtime/lua'))) {
    const r = rel(p)
    if (r.endsWith('.lua') && !EXCLUDE.has(r)) core.push(r)
  }
  core.push('manifest.xml')
  return { core: core.sort(), trees }
}

// The chunk name PoB's own loading would give: loadfile("Modules/X.lua") from src/, or require's full path.
function chunkName(r) {
  if (r.startsWith('src/')) return '@' + r.slice(4)
  return '@/pob/vendor/' + r
}

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 10)

async function main() {
  const t0 = performance.now()
  const { core, trees } = fileSet()
  const { engine } = await bootNodeEngine()
  const { FS } = engine.Module
  const stage = join(ROOT, 'build/stage')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  FS.mkdirTree('/stage')
  FS.mount(engine.Module.NODEFS ?? FS.filesystems.NODEFS, { root: stage }, '/stage')

  const luaFiles = [...core.filter((r) => r.endsWith('.lua')), ...Object.values(trees)]
  const list = luaFiles.map((r) => `/pob/vendor/${r}\t${chunkName(r)}\t/stage/${r}`).join('\n') + '\n'
  for (const r of luaFiles) mkdirSync(join(stage, r, '..'), { recursive: true })
  FS.writeFile('/tmp/list.txt', list)
  const failures = JSON.parse(
    engine.evalLua(`
      local failures, n = {}, 0
      for line in io.lines("/tmp/list.txt") do
        local src, name, dst = line:match("^([^\\t]+)\\t([^\\t]+)\\t([^\\t]+)$")
        local f = assert(io.open(src, "rb")); local text = f:read("*a"); f:close()
        -- loadfile skips a first line starting with '#' (PoB's "#@" headers); load() doesn't, so blank it (same line numbers).
        local fn, err = load((text:gsub("^#[^\\n]*", "", 1)), name, "t")
        if not fn then
          failures[#failures + 1] = err
        else
          local out = assert(io.open(dst, "wb"))
          out:write(${SOURCE_MODE ? 'text' : 'string.dump(fn)'})
          out:close()
        end
        n = n + 1
      end
      local parts = {}
      for i, e in ipairs(failures) do parts[i] = string.format("%q", e) end
      return "[" .. table.concat(parts, ",") .. "]"`),
  )
  if (failures.length) {
    console.error(`compile check: ${failures.length} file(s) failed under patched Lua 5.2:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`compile check: ${luaFiles.length} Lua files compiled (${EXCLUDE.size} excluded: ${[...EXCLUDE.keys()].join(', ')})`)

  const readStaged = (r) => (r.endsWith('.lua') ? readFileSync(join(stage, r)) : readFileSync(join(VENDOR, r)))
  rmSync(join(DIST, 'packs'), { recursive: true, force: true })
  mkdirSync(join(DIST, 'packs'), { recursive: true })

  const writePack = (prefix, entries) => {
    const raw = buildPack(entries)
    const gz = gzipSync(raw, { level: 9 })
    const file = `packs/${prefix}.${hash(gz)}.pack.gz`
    writeFileSync(join(DIST, file), gz)
    const sourceBytes = entries.reduce((n, e) => n + e.sourceBytes, 0)
    return { file, bytes: gz.length, rawBytes: raw.length, sourceBytes, files: entries.length }
  }

  // Core: PoB's files under vendor/, plus our Lua shim under lua/ (kept as source; it's small and uses its own path).
  const coreEntries = core.map((r) => ({
    path: `vendor/${r}`,
    bytes: readStaged(r),
    sourceBytes: statSync(join(VENDOR, r)).size,
  }))
  for (const name of readdirSync(join(ROOT, 'lua'))) {
    if (name.endsWith('.lua') && name !== 'cli.lua') {
      const bytes = readFileSync(join(ROOT, 'lua', name))
      coreEntries.push({ path: `lua/${name}`, bytes, sourceBytes: bytes.length })
    }
  }
  const corePack = writePack('core', coreEntries)
  const treePacks = {}
  for (const [ver, r] of Object.entries(trees).sort()) {
    treePacks[ver] = writePack(`tree-${ver}`, [
      { path: `vendor/${r}`, bytes: readStaged(r), sourceBytes: statSync(join(VENDOR, r)).size },
    ])
  }

  // Engine + web files.
  const engineWasm = readFileSync(join(DIST, 'engine.wasm'))
  const engineJs = readFileSync(join(DIST, 'engine.mjs'))
  for (const f of ['index.html', 'pob-calc.js', 'pob-worker.js', 'decode.mjs', 'engine-core.mjs', 'pack.mjs', 'demo.js', 'demo.css']) {
    try {
      copyFileSync(join(ROOT, 'web', f), join(DIST, f))
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
  }
  copyFileSync(join(ROOT, 'fixtures/oracle/ninja-default.code.txt'), join(DIST, 'sample-code.txt'))
  writeFileSync(join(DIST, '.nojekyll'), '')

  const pobVersion = readFileSync(join(VENDOR, 'manifest.xml'), 'utf8').match(/Version number="([^"]+)"/)?.[1] ?? null
  const latestTree = Object.keys(trees).sort().at(-1)
  const manifest = {
    pobVersion,
    pinCommit: pinCommit(),
    format: SOURCE_MODE ? 'source' : 'bytecode',
    builtAt: new Date().toISOString(),
    engine: {
      js: 'engine.mjs',
      wasm: 'engine.wasm',
      jsBytes: engineJs.length,
      wasmBytes: engineWasm.length,
      jsGzipBytes: gzipSync(engineJs, { level: 9 }).length,
      wasmGzipBytes: gzipSync(engineWasm, { level: 9 }).length,
    },
    core: corePack,
    trees: treePacks,
    latestTree,
  }
  writeFileSync(join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  const mb = (n) => (n / 1048576).toFixed(2) + ' MB'
  const firstVisit = manifest.engine.jsGzipBytes + manifest.engine.wasmGzipBytes + corePack.bytes + treePacks[latestTree].bytes
  console.log(`format ${manifest.format}, PoB ${pobVersion} @ ${manifest.pinCommit?.slice(0, 7)}`)
  console.log(`engine      js ${mb(manifest.engine.jsGzipBytes)} gz, wasm ${mb(manifest.engine.wasmGzipBytes)} gz (${mb(engineWasm.length)} raw)`)
  console.log(`core        ${corePack.files} files: ${mb(corePack.bytes)} gz, ${mb(corePack.rawBytes)} unpacked (${mb(corePack.sourceBytes)} Lua source)`)
  for (const [v, p] of Object.entries(treePacks)) console.log(`tree ${v}    ${mb(p.bytes)} gz, ${mb(p.rawBytes)} unpacked`)
  console.log(`first visit (engine + core + tree ${latestTree}): ${mb(firstVisit)} transferred`)
  console.log(`packed in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
