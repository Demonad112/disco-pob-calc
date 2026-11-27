// Loads a web/data/<name>.json file: fetch in the browser, fs in Node. Cached per name. Resolves to null when the
// file is unavailable, so a decoder still returns a model (without that lookup table).
const cache = new Map()

export function loadData(name) {
  if (!cache.has(name)) {
    cache.set(
      name,
      (async () => {
        const url = new URL(`./data/${name}.json`, import.meta.url)
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
      })(),
    )
  }
  return cache.get(name)
}

/** Back-compat: web/data/affixes.json specifically. */
export function loadAffixTable() {
  return loadData('affixes')
}
