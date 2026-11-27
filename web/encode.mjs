// PoB2 XML -> export code (the inverse of decode.mjs): zlib deflate, then base64url, as PoB itself writes it.
// Works in the browser and in Node (both have CompressionStream).

async function deflateZlib(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** XML text -> PoB code (base64url of the zlib stream, `-`/`_` in place of `+`/`/`). */
export async function encodePobCode(xml) {
  if (typeof xml !== 'string' || !xml.includes('<PathOfBuilding2')) throw new Error('Not a PathOfBuilding2 document.')
  const b64 = bytesToBase64(await deflateZlib(new TextEncoder().encode(xml)))
  return b64.replace(/\+/g, '-').replace(/\//g, '_')
}
