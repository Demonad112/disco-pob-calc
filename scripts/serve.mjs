#!/usr/bin/env node
// Static server for dist/ with the MIME types GitHub Pages uses (application/wasm, text/javascript).
// Packs are served as plain bytes (no Content-Encoding): the worker gunzips them itself, as on Pages.
//   node scripts/serve.mjs [dir=dist] [port=8080]
import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
  '.gz': 'application/gzip', '.png': 'image/png', '.svg': 'image/svg+xml',
}

export function serve(dir, port = 0) {
  const root = resolve(dir)
  const server = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (path.endsWith('/')) path += 'index.html'
    const file = normalize(join(root, path))
    if (!file.startsWith(root)) return res.writeHead(403).end()
    let st
    try {
      st = statSync(file)
    } catch {
      return res.writeHead(404).end('not found')
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache' })
    createReadStream(file).pipe(res)
  })
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? 'dist'
  const server = await serve(dir, Number(process.argv[3] ?? 8080))
  console.log(`serving ${dir} at http://127.0.0.1:${server.address().port}/`)
}
