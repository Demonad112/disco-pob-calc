// Loads web/data/affixes.json (built by scripts/extract-affixes.mjs): fetch in the browser, fs in Node. Cached.
// Resolves to null when the file is unavailable, so the decoder still returns a model (without tier lookups).
let cached = null

export function loadAffixTable() {
  cached ??= (async () => {
    const url = new URL('./data/affixes.json', import.meta.url)
    try {
      if (typeof process !== 'undefined' && process.versions?.node) {
        const { readFile } = await import('node:fs/promises')
        return JSON.parse(await readFile(url, 'utf8'))
      }
      const res = await fetch(url)
      return res.ok ? await res.json() : null
    } catch {
      return null
    }
  })()
  return cached
}
