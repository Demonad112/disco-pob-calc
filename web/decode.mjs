// PoB2 export code -> XML, in the browser and in Node (both have DecompressionStream).
// Same rules as upgraded-disco-companion services/pob-engine/src/decode.mjs: base64url, line breaks and `?` at the
// ends dropped, zlib inflate (capped at 8 MB), and the payload must be a <PathOfBuilding2> build.
import { buildModelOf } from './build-model.mjs'
export { buildModelOf }
export class DecodeError extends Error {}

const MAX_XML_BYTES = 8 << 20

function base64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'))
  const bin = atob(b64.replace(/=+$/, '').padEnd(Math.ceil(b64.replace(/=+$/, '').length / 4) * 4, '='))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function inflateZlib(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_XML_BYTES) {
      await reader.cancel()
      throw new DecodeError('Decoded build is larger than 8 MB.')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return new TextDecoder().decode(out)
}

/** Decode a PoB2 code, or pass decoded XML through. Resolves to the XML text. */
export async function decodePobCode(code) {
  if (typeof code !== 'string' || !code.trim()) throw new DecodeError('Empty Path of Building code.')
  const trimmed = code.trim()
  if (trimmed.startsWith('<')) {
    if (!trimmed.includes('<PathOfBuilding2')) throw new DecodeError('XML is not a Path of Building 2 build.')
    return trimmed
  }
  const compact = trimmed.replace(/^\?+|\?+$/g, '').replace(/[\r\n\t ]+/g, '')
  if (!/^[A-Za-z0-9_\-+/]+={0,2}$/.test(compact)) throw new DecodeError('Code is not valid base64.')
  let xml
  try {
    xml = await inflateZlib(base64ToBytes(compact.replace(/-/g, '+').replace(/_/g, '/')))
  } catch (e) {
    if (e instanceof DecodeError) throw e
    throw new DecodeError('Code did not inflate: it may be truncated or not a PoB code.')
  }
  if (!xml.includes('<PathOfBuilding2')) throw new DecodeError('Decoded payload is not a Path of Building 2 build.')
  return xml
}

/** Tree versions a build's <Spec> elements use (e.g. ["0_5"]), so their tree data can be fetched first. */
export function treeVersionsOf(xml) {
  const out = new Set()
  for (const m of xml.matchAll(/<Spec\b[^>]*\btreeVersion="([0-9_]+)"/g)) out.add(m[1])
  return [...out]
}

/** Decode a code (or XML) to { xml, model }: the raw XML plus the typed build model (see build-model.mjs). */
export async function decodePobBuild(code) {
  const xml = await decodePobCode(code)
  return { xml, model: buildModelOf(xml) }
}
