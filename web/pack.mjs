// Asset pack format, shared by scripts/pack.mjs (writer, Node) and the worker (reader, browser/Node).
//   "PCK1" | u32 LE index length | index JSON [{ path, offset, size }] | file bytes ...   (then gzip on top)
const MAGIC = [0x50, 0x43, 0x4b, 0x31] // PCK1

export function buildPack(files) {
  // files: [{ path, bytes: Uint8Array }]
  let offset = 0
  const index = files.map((f) => {
    const e = { path: f.path, offset, size: f.bytes.length }
    offset += f.bytes.length
    return e
  })
  const indexBytes = new TextEncoder().encode(JSON.stringify(index))
  const out = new Uint8Array(8 + indexBytes.length + offset)
  out.set(MAGIC, 0)
  new DataView(out.buffer).setUint32(4, indexBytes.length, true)
  out.set(indexBytes, 8)
  let o = 8 + indexBytes.length
  for (const f of files) {
    out.set(f.bytes, o)
    o += f.bytes.length
  }
  return out
}

export function readPack(bytes) {
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) throw new Error('not a PCK1 pack')
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true)
  const index = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n)))
  const base = 8 + n
  return index.map((e) => ({ path: e.path, bytes: bytes.subarray(base + e.offset, base + e.offset + e.size) }))
}

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Write every file of a pack into an Emscripten FS under `root`. Returns { files, bytes }. */
export function installPack(FS, root, entries) {
  let bytes = 0
  const made = new Set()
  for (const { path, bytes: data } of entries) {
    const full = `${root}/${path}`
    const dir = full.slice(0, full.lastIndexOf('/'))
    if (!made.has(dir)) {
      FS.mkdirTree(dir)
      made.add(dir)
    }
    FS.writeFile(full, data)
    bytes += data.length
  }
  return { files: entries.length, bytes }
}
