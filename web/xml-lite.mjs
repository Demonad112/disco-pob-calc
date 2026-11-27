// Minimal XML reader for PoB2 build files (works in browser and Node; no DOMParser dependency).
// Returns { tag, attrs, children, text } nodes. Handles attributes, entities, self-closing tags, comments, <?xml?>.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unescapeXml = (s) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    return ENT[e] ?? m
  })

export function parseXml(xml) {
  const root = { tag: '#root', attrs: {}, children: [], text: '' }
  const stack = [root]
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g
  let m
  while ((m = re.exec(xml))) {
    if (m[5] !== undefined) {
      stack[stack.length - 1].text += unescapeXml(m[5])
    } else if (m[2]) {
      if (m[1]) {
        if (stack.length > 1) stack.pop()
      } else {
        const attrs = {}
        for (const a of m[3].matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unescapeXml(a[2] ?? a[3])
        const node = { tag: m[2], attrs, children: [], text: '' }
        stack[stack.length - 1].children.push(node)
        if (!m[4]) stack.push(node)
      }
    }
  }
  return root.children[0] ?? null
}

export const child = (n, tag) => n?.children.find((c) => c.tag === tag)
export const kids = (n, tag) => (n ? n.children.filter((c) => c.tag === tag) : [])
