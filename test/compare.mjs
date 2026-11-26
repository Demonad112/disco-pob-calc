// Oracle comparison shared by the Node parity test and the Playwright test.
// Numbers match when |a - b| <= 1e-9 * max(1, |b|) (PoB's own values, so only float noise is allowed);
// strings, booleans and shapes must be identical.
export const REL_TOL = 1e-9

export function sameValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= REL_TOL * Math.max(1, Math.abs(b))
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) if (!sameValue(a[k], b[k])) return false
    return true
  }
  return a === b
}

/** Flat list of { path, actual, expected } where the two differ. */
export function diff(actual, expected, path = '') {
  if (sameValue(actual, expected)) return []
  const bothObjects = actual && expected && typeof actual === 'object' && typeof expected === 'object'
  if (!bothObjects) return [{ path: path || '(root)', actual, expected }]
  const out = []
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)])
  for (const k of keys) out.push(...diff(actual[k], expected[k], path ? `${path}.${k}` : k))
  return out
}

/** Every difference between an engine result and the oracle files (empty = parity). */
export function compareToOracle(result, oracle, groupsOracle) {
  const s = result.snapshot
  const out = [
    ...diff(s.loadError, oracle.loadError, 'loadError'),
    ...diff(s.stats, oracle.stats, 'stats'),
    ...diff(s.export, oracle.export, 'export'),
    ...diff(s.fullDpsSkills, oracle.fullDpsSkills, 'fullDpsSkills'),
    ...diff(s.pobVersion, oracle.pobVersion, 'pobVersion'),
  ]
  if (groupsOracle && result.groups) out.push(...diff(result.groups, groupsOracle, 'groups'))
  return out
}
