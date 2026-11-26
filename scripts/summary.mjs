#!/usr/bin/env node
// Markdown summary of the latest pack/parity/e2e run (CI job summary; also handy locally).
import { existsSync, readFileSync } from 'node:fs'

const json = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null)
const mb = (n) => (typeof n === 'number' ? `${(n / 1048576).toFixed(2)} MB` : '–')
const s = (n) => (typeof n === 'number' ? `${(n / 1000).toFixed(2)} s` : '–')
const out = []

const m = json('dist/manifest.json')
if (m) {
  const first = m.engine.jsGzipBytes + m.engine.wasmGzipBytes + m.core.bytes + m.trees[m.latestTree].bytes
  out.push(`## pob-calc: PoB2 ${m.pobVersion} @ \`${m.pinCommit?.slice(0, 7)}\` (${m.format} packs)`, '')
  out.push('| Download | gzip | unpacked |', '|---|---:|---:|')
  out.push(`| engine (js + wasm) | ${mb(m.engine.jsGzipBytes + m.engine.wasmGzipBytes)} | ${mb(m.engine.jsBytes + m.engine.wasmBytes)} |`)
  out.push(`| core (${m.core.files} files) | ${mb(m.core.bytes)} | ${mb(m.core.rawBytes)} |`)
  for (const [v, t] of Object.entries(m.trees)) out.push(`| tree ${v} (lazy) | ${mb(t.bytes)} | ${mb(t.rawBytes)} |`)
  out.push(`| **first visit** (engine + core + tree ${m.latestTree}) | **${mb(first)}** | |`, '')
}

const diff = json('parity-diff.json')
if (diff) out.push(diff.length ? `### Parity: ${diff.length} mismatch(es)\n\n\`\`\`json\n${JSON.stringify(diff.slice(0, 30), null, 2)}\n\`\`\`` : '### Parity: every stat matches the oracle', '')

const e = json('e2e-timings.json')
const p = json('parity-timings.json')
if (e || p) {
  out.push('| Timing | Chromium (e2e) | Node (parity) |', '|---|---:|---:|')
  out.push(`| start, cold | ${s(e?.cold?.wallMs)} | ${s(p?.initMs)} |`)
  out.push(`| start, warm (cached) | ${s(e?.warm?.wallMs)} | |`)
  out.push(`| first calc | ${s(e?.firstCalc?.wallMs)} | ${s(p?.firstCalc?.load + p?.firstCalc?.snapshot || undefined)} |`)
  out.push(`| repeat calc | ${s(e?.repeatCalc?.wallMs)} | ${s(p?.warmCalcMs)} |`)
  if (p?.firstCalc?.groups) out.push(`| all skill groups | | ${s(p.firstCalc.groups)} |`)
  out.push(`| wasm heap | ${mb(e?.firstCalc?.wasmHeapBytes)} | ${mb(p?.wasmHeapBytes)} |`, '')
}
console.log(out.join('\n'))
