// Demo page for pob-calc.js: paste a code, see PoB's numbers and how long each step took.
import { calc, init, measure, setConfig } from './pob-calc.js'

const $ = (id) => document.getElementById(id)
const codeEl = $('code')
const calcBtn = $('calc')
const statusEl = $('status')
const barFill = $('bar-fill')

const fmtInt = (v) => (typeof v === 'number' ? Math.round(v).toLocaleString('en-US') : v ?? '–')
const fmt1 = (v) => (typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : v ?? '–')
const fmt2 = (v) => (typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v ?? '–')
const pct = (v) => (typeof v === 'number' ? `${fmt1(v)}%` : '–')
const ms = (v) => (typeof v === 'number' ? (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`) : '–')
const mb = (v) => (typeof v === 'number' ? `${(v / 1048576).toFixed(2)} MB` : '–')

const timingRows = new Map()
function setTiming(label, value, sub) {
  timingRows.set(label, [value, sub])
  const body = $('timings').tBodies[0]
  body.replaceChildren(
    ...[...timingRows].map(([k, [v, s]]) => {
      const tr = document.createElement('tr')
      tr.innerHTML = `<td>${k}${s ? `<br><span class="sub">${s}</span>` : ''}</td><td>${v}</td>`
      return tr
    }),
  )
}

function setStatus(text, isError = false) {
  statusEl.textContent = text
  statusEl.classList.toggle('error', isError)
}

function kvTable(id, rows) {
  const body = $(id).tBodies[0]
  body.replaceChildren(
    ...rows
      .filter(([, v]) => v !== undefined && v !== null && v !== '–')
      .map(([k, v]) => {
        const tr = document.createElement('tr')
        const a = document.createElement('td')
        const b = document.createElement('td')
        a.textContent = k
        b.textContent = v
        tr.append(a, b)
        return tr
      }),
  )
}

const PHASES = { core: 'Downloading PoB2 data', unpack: 'Unpacking', start: 'Starting PoB' }
let initStart = performance.now()

async function boot() {
  initStart = performance.now()
  try {
    const info = await init({
      onProgress: ({ phase, loaded, total }) => {
        const name = PHASES[phase] ?? `Downloading ${phase}`
        if (total > 1) {
          setStatus(`${name}… ${mb(loaded)} / ${mb(total)}`)
          barFill.style.width = `${Math.min(100, (loaded / total) * 100)}%`
        } else setStatus(`${name}…`)
      },
    })
    const wall = performance.now() - initStart
    barFill.style.width = '100%'
    $('meta').innerHTML = `PoB2 <strong>${info.pobVersion}</strong> · pin <a href="https://github.com/Demonad112/PathOfBuilding-PoE2/commit/${info.pinCommit}"><code>${info.pinCommit?.slice(0, 7)}</code></a> · ${info.format} packs`
    const cached = info.bytes.network === 0
    setTiming('Download (data packs)', cached ? 'from cache' : mb(info.bytes.network), `first visit total ${mb(info.bytes.firstVisit)} (gzip); later visits use Cache Storage`)
    setTiming(cached ? 'Start (warm, cached data)' : 'Start (cold)', ms(wall), `fetch ${ms(info.timings.downloadMs)} · unpack ${ms(info.timings.unpackMs)} · PoB init ${ms(info.timings.engineInitMs)}`)
    setTiming('Memory after start', mb(info.wasmHeapBytes), `Lua heap ${mb(info.luaHeapBytes)}`)
    setStatus('Ready. Paste a code and press Calculate.')
    calcBtn.disabled = false
    window.__pobInit = { ...info, wallMs: wall }
  } catch (e) {
    setStatus(`Engine failed to start: ${e.message}`, true)
  }
}

let calcCount = 0
let overrides = {} // Config inputs the user set on the page; sent with every recalculation of the same code
let lastCode = ''
let loaded = null // { code, auto } while the worker still holds the build of the last full calc: Config changes then skip the reload
let busy = false // a calc or Config change is running
let dirty = false // a control changed meanwhile
let gen = 0 // bumps on every Config change; background measurements of an older Config are dropped
let pendingMeasure = 0
window.__pobPending = 0

function rerun() {
  if (calcBtn.disabled && !busy) return // engine not started yet
  if (busy) {
    dirty = true
    return
  }
  const code = codeEl.value.trim()
  if (loaded && loaded.code === code && loaded.auto === $('autocfg').checked && !$('groups').checked) reconfig()
  else run()
}

function afterRun() {
  busy = false
  calcBtn.disabled = false
  if (dirty) {
    dirty = false
    rerun()
  }
}

async function run() {
  const code = codeEl.value.trim()
  if (!code) {
    setStatus('Paste a PoB2 code first.', true)
    return
  }
  const groups = $('groups').checked
  const autoConfig = $('autocfg').checked ? 'suggest' : false
  busy = true
  dirty = false
  loaded = null
  gen++
  calcBtn.disabled = true
  setStatus(groups ? 'Calculating every skill group… this takes a while.' : 'Calculating…')
  const t0 = performance.now()
  try {
    const r = await calc(code, { groups, autoConfig, overrides: lastCode === code ? overrides : (overrides = {}) })
    lastCode = code
    if (!groups) loaded = { code, auto: !!autoConfig }
    const wall = performance.now() - t0
    calcCount++
    const label = calcCount === 1 ? 'First calc' : 'Last calc'
    const e = r.timings.engine
    setTiming(groups ? `${label} (+ all groups)` : label, ms(wall),
      `decode ${ms(r.timings.decodeMs)} · tree ${ms(r.timings.treeMs)} · load+calc ${ms(e.load)} · snapshot ${ms(e.snapshot)}${e.groups ? ` · groups ${ms(e.groups)}` : ''}`)
    setTiming('Memory now', mb(r.wasmHeapBytes), `Lua heap after GC ${mb(e.luaHeapBytes)}`)
    render(r)
    setStatus(r.snapshot.loadError ? `PoB reported: ${r.snapshot.loadError}` : `Done in ${ms(wall)}.`, !!r.snapshot.loadError)
    window.__pobLast = { result: r, wallMs: wall, kind: 'calc' }
  } catch (e) {
    setStatus(e.kind === 'decode' ? e.message : `PoB could not calculate this build: ${e.message}`, true)
  } finally {
    afterRun()
  }
}

// A Config change on the build the worker already holds: no decode, no load. Effects shown in the Config table are
// kept (greyed) and refreshed in the background.
async function reconfig() {
  busy = true
  dirty = false
  calcBtn.disabled = true
  const g = ++gen
  setStatus('Applying the Config change…')
  const t0 = performance.now()
  try {
    const r = await setConfig({ autoConfig: loaded.auto ? 'suggest' : false, overrides, trials: 0, catalog: true, deltas: false })
    const wall = performance.now() - t0
    const e = r.timings.engine
    setTiming('Last Config change (build stays loaded)', ms(wall), `reset + recalculation ${ms(e.load)} · snapshot ${ms(e.snapshot)}`)
    setTiming('Memory now', mb(r.wasmHeapBytes))
    render(r)
    setStatus(`Config change applied in ${ms(wall)}.`)
    window.__pobLast = { result: r, wallMs: wall, kind: 'reconfig' }
    refreshMeasured(g)
  } catch (e) {
    loaded = null // the engine dropped the build; the next change reloads it
    setStatus(`PoB could not apply this change: ${e.message}`, true)
  } finally {
    afterRun()
  }
}

const SPLIT = [
  ['Physical', 'PhysicalHitAverage', 'var(--phys)'],
  ['Fire', 'FireHitAverage', 'var(--fire)'],
  ['Cold', 'ColdHitAverage', 'var(--cold)'],
  ['Lightning', 'LightningHitAverage', 'var(--light)'],
  ['Chaos', 'ChaosHitAverage', 'var(--chaos)'],
]

// A situational toggle's isolated effect: the response's own delta, else (after a Config change) the catalog's measurement of it.
function suggestDelta(x) {
  if (x.dpsDeltaPct != null) return { dps: x.dpsDeltaPct, ehp: x.ehpDelta }
  const e = entries.get(x.key)
  if (!e?.measured || !e.effect) return null
  const d = e.effect
  return { dps: d.TotalDPS?.pct ?? (d.TotalDPS ? null : 0), ehp: d.TotalEHP ? d.TotalEHP.to - d.TotalEHP.from : 0 }
}

let lastAuto = null
function renderAutoConfig(a) {
  lastAuto = a
  $('autocfg-panel').hidden = !a
  if (!a) return
  $('autocfg-sum').textContent = a.error
    ? `failed: ${a.error}`
    : `${fmtInt(a.baselineDPS)} → ${fmtInt(a.configuredDPS)} DPS`
  kvTable('autocfg-applied', a.applied.length ? a.applied.map((x) => [`${x.key} = ${x.value}`, x.source]) : [['Nothing to apply', 'No unset toggle has both a source and a consumer in this build.']])
  const sug = a.suggested.map((x) => {
    const d = suggestDelta(x)
    return [`${x.key}`, `${x.source}${d?.dps != null ? ` · ${d.dps >= 0 ? '+' : ''}${d.dps}% DPS` : ''}${d?.ehp ? ` · ${d.ehp >= 0 ? '+' : ''}${fmtInt(d.ehp)} EHP` : ''}`]
  })
  $('autocfg-sug').hidden = !sug.length
  kvTable('autocfg-suggested', sug)
}

const STAT_LABEL = { TotalDPS: 'DPS', CombinedDPS: 'Combined DPS', TotalEHP: 'EHP', PhysicalMaximumHitTaken: 'Phys max hit', FireMaximumHitTaken: 'Fire max hit', EvadeChance: 'Evade', EffectiveBlockChance: 'Block', PhysicalDamageReduction: 'Phys DR' }
const signed = (n) => `${n >= 0 ? '+' : ''}${fmt2(n)}`
// { stat: { from, to, pct } } -> "DPS +27.6% · EHP -10.7% (Evade 40 → 42)"; DPS and EHP lead, the rest in brackets.
function effectText(d) {
  if (!d) return ''
  const part = (k) => {
    const x = d[k]
    return x ? `${STAT_LABEL[k]} ${x.pct != null ? `${signed(x.pct)}%` : `${fmt2(x.from)} → ${fmt2(x.to)}`}` : null
  }
  const main = ['TotalDPS', 'TotalEHP'].map(part).filter(Boolean)
  const rest = Object.keys(d).filter((k) => !['TotalDPS', 'TotalEHP', 'CombinedDPS'].includes(k)).map((k) => `${STAT_LABEL[k] ?? k} ${fmt2(d[k].from)} → ${fmt2(d[k].to)}`)
  if (!main.length && d.CombinedDPS) main.push(part('CombinedDPS'))
  return [main.join(' · '), rest.length ? `(${rest.join(', ')})` : ''].filter(Boolean).join(' ') || 'no change in tracked stats'
}
const effectClass = (d) => { const p = d?.TotalDPS?.pct ?? d?.CombinedDPS?.pct; return p > 0 ? 'pos' : p < 0 ? 'neg' : '' }
const STATE_LABEL = { export: 'in code', auto: 'auto', manual: 'manual', available: 'available' }

// ---- Config table. `entries` is the catalog as the page knows it (key -> entry, PoB's order); an entry's measured
// fields (effect | options[].vsSelected | perUnit/total | trials) can be stale after a Config change until the
// background refresh replaces them (`staleFields`).
const entries = new Map()
const rowOf = new Map() // key -> { name, effect } cells, for in-place updates
let trialMs = 400 // a measured trial's cost, refined from the engine's own timings
const FIELDS = ['effect', 'options', 'perUnit', 'total', 'trials']
const trialsOf = (e) => (e.type === 'check' ? 1 : e.type === 'list' ? Math.max(1, (e.options?.length ?? 1) - 1) : 2)
const mk = (tag, props, ...kids) => {
  const el = Object.assign(document.createElement(tag), props)
  el.append(...kids)
  return el
}

function control(e) {
  const set = (v) => { overrides[e.key] = v; rerun() }
  if (e.type === 'check') return mk('input', { type: 'checkbox', checked: e.value === true, onchange: (ev) => set(ev.target.checked) })
  if (e.type === 'list') {
    const sel = mk('select', { onchange: (ev) => set(ev.target.value) })
    for (const o of e.options ?? []) sel.append(mk('option', { value: o.val, textContent: o.label.replace(/\s+/g, ' '), selected: o.selected }))
    return sel
  }
  const box = mk('span', { className: 'ctl' }, mk('input', { type: 'number', min: 0, value: e.value, className: 'num', title: 'Set this value', onchange: (ev) => ev.target.value !== '' && set(Number(ev.target.value)) }))
  // Try a value without applying it: the effect of this count at that value against the current one.
  const tryIn = mk('input', { type: 'number', min: 0, className: 'num try', placeholder: 'try…', title: 'Measure the effect of this value without applying it' })
  const go = () => tryIn.value !== '' && Number.isFinite(Number(tryIn.value)) && measureSpecs([{ key: e.key, values: [Number(tryIn.value)] }])
  tryIn.addEventListener('keydown', (ev) => ev.key === 'Enter' && go())
  box.append(tryIn, mk('button', { type: 'button', className: 'secondary small', textContent: 'Try', onclick: go }))
  return box
}

// [{ cls, text, stale }] lines for one entry's measured effects.
function effectLines(e) {
  const stale = (f) => !!e.staleFields?.includes(f)
  const lines = []
  const add = (d, text, f) => lines.push({ cls: effectClass(d), text: `${text}${effectText(d)}`, stale: stale(f) })
  if (e.type === 'check' && e.effect) add(e.effect, e.value ? 'adds: ' : 'would add: ', 'effect')
  if (e.type === 'count') {
    if (e.perUnit) add(e.perUnit, 'per extra point: ', 'perUnit')
    if (e.total) add(e.total, `${fmt2(e.value)} vs 0: `, 'total')
    for (const t of e.trials ?? []) add(t.vs, `at ${fmt2(t.value)} (now ${fmt2(e.value)}): `, 'trials')
  }
  if (e.type === 'list') {
    for (const o of e.options ?? []) if (!o.selected && o.vsSelected && Object.keys(o.vsSelected).length) add(o.vsSelected, `${o.label.replace(/\s+/g, ' ')}: `, 'options')
  }
  return lines
}

function fillEffect(e, cell) {
  const lines = effectLines(e)
  const kids = lines.map((l) => mk('div', { className: `${l.cls}${l.stale ? ' stale' : ''}`, textContent: l.text }))
  if (e.measuring) kids.push(mk('div', { className: 'meta', textContent: 'measuring…' }))
  else if (!e.measured) kids.push(mk('button', { type: 'button', className: 'secondary small', textContent: `Measure (~${ms(trialsOf(e) * trialMs)})`, onclick: () => measureSpecs([{ key: e.key }]) }))
  else if (!lines.length) kids.push(mk('div', { className: 'meta', textContent: 'no change in tracked stats' }))
  cell.replaceChildren(...kids)
}

function buildRow(e) {
  const name = mk('td')
  const ctl = mk('td', {}, control(e))
  const eff = mk('td')
  const fillName = () => name.replaceChildren(mk('span', { className: `badge ${e.state}`, textContent: STATE_LABEL[e.state] }), ' ', mk('span', { textContent: e.label, title: e.tooltip ?? '' }))
  fillName()
  fillEffect(e, eff)
  rowOf.set(e.key, { eff })
  return mk('tr', {}, name, ctl, eff)
}

function updateRow(key) {
  const e = entries.get(key)
  const r = rowOf.get(key)
  if (e && r) fillEffect(e, r.eff)
}

// New catalog from the engine; measurements the response does not carry (after a Config change) are kept as stale.
function mergeCatalog(cat) {
  const prev = new Map(entries)
  entries.clear()
  for (const e of cat) {
    const old = prev.get(e.key)
    if (!e.measured && old?.measured) {
      e.staleFields = FIELDS.filter((f) => old[f] != null && (f !== 'options'))
      for (const f of e.staleFields) e[f] = old[f]
      if (e.options && old.options) {
        let any = false
        for (const o of e.options) {
          const oo = old.options.find((x) => x.val === o.val)
          if (oo?.vsSelected) { o.vsSelected = oo.vsSelected; any = true }
        }
        if (any) e.staleFields.push('options')
      }
      e.measured = true
    }
    entries.set(e.key, e)
  }
}

function renderCatalog(a) {
  const panel = $('catalog-panel')
  const cat = a?.catalog
  panel.hidden = !cat
  if (!cat) return
  mergeCatalog(cat)
  rowOf.clear()
  const list = [...entries.values()]
  const shown = list.filter((e) => e.measured || e.state !== 'available')
  $('catalog').tBodies[0].replaceChildren(...shown.map(buildRow))

  // Everything else, by PoB's section: measured on request, per option or for the whole section.
  const open = new Set([...document.querySelectorAll('#catalog-more details[open]')].map((d) => d.dataset.section))
  const bySection = new Map()
  for (const e of list) if (!(e.measured || e.state !== 'available')) (bySection.get(e.section ?? 'Other') ?? bySection.set(e.section ?? 'Other', []).get(e.section ?? 'Other')).push(e)
  const secs = [...bySection].map(([name, es]) => {
    const trials = es.reduce((n, e) => n + trialsOf(e), 0)
    const btn = mk('button', { type: 'button', className: 'secondary small', textContent: `Measure all ${es.length} (~${ms(trials * trialMs)})`, onclick: (ev) => { ev.preventDefault(); measureSpecs(es.map((e) => ({ key: e.key }))) } })
    const table = mk('table', { className: 'skills' }, mk('tbody', {}, ...es.map(buildRow)))
    const d = mk('details', { open: open.has(name) }, mk('summary', {}, `${name} · ${es.length} not measured `, btn), mk('div', { className: 'table-scroll' }, table))
    d.dataset.section = name
    return d
  })
  $('catalog-more').replaceChildren(...secs)
  const measuredN = list.filter((e) => e.measured).length
  $('catalog-note').textContent = `${measuredN} of ${list.length} options PoB shows for this build are measured, one change at a time (PoB recalculates each, ~${ms(trialMs)} per trial here). The rest are listed by section below: measure one, or a whole section. A count can be tried at any value without applying it. Changing a control recalculates the build without reloading it.`
}

// ---- Measuring on request and refreshing after a Config change.
function mergeMeasure(m) {
  const e = entries.get(m.key)
  if (!e) return
  const fresh = (f) => { e.staleFields = (e.staleFields ?? []).filter((x) => x !== f) }
  if (m.effect) { e.effect = m.effect; fresh('effect') }
  if (m.perUnit) { e.perUnit = m.perUnit; fresh('perUnit') }
  if (m.total) { e.total = m.total; fresh('total') }
  if (m.options && e.options) {
    for (const o of m.options) {
      const mine = e.options.find((x) => x.val === o.val)
      if (mine) mine.vsSelected = o.vsSelected
    }
    fresh('options')
  }
  if (m.trials?.length) {
    const byValue = new Map((e.trials ?? []).map((t) => [t.value, t]))
    for (const t of m.trials) byValue.set(t.value, t)
    e.trials = [...byValue.values()].slice(-4) // the last few values tried
    fresh('trials')
  }
  e.measured = true
}

// Measure in small chunks so the table fills in as results arrive; a newer Config change cancels what has not started.
async function measureSpecs(specs, g = gen) {
  const keys = [...new Set(specs.map((x) => x.key))].filter((k) => entries.has(k))
  specs = specs.filter((x) => entries.has(x.key))
  if (!specs.length) return
  pendingMeasure++
  window.__pobPending = pendingMeasure
  for (const k of keys) { entries.get(k).measuring = true; updateRow(k) }
  try {
    for (let i = 0; i < specs.length; i += 4) {
      const chunk = specs.slice(i, i + 4)
      const res = await measure(chunk, { skip: () => g !== gen })
      if (!res) break // the Config changed meanwhile: these numbers would be for the old one
      const trials = chunk.reduce((n, sp) => n + (sp.values ? sp.values.length : trialsOf(entries.get(sp.key))), 0)
      if (res.ms && trials) trialMs = Math.round(res.ms / trials)
      for (const m of res.measured) mergeMeasure(m)
      for (const sp of chunk) { entries.get(sp.key).measuring = false; updateRow(sp.key) }
    }
  } catch (e) {
    setStatus(`Could not measure: ${e.message}`, true)
  } finally {
    for (const k of keys) { const e = entries.get(k); if (e) { e.measuring = false; updateRow(k) } }
    pendingMeasure--
    window.__pobPending = pendingMeasure
    if (lastAuto && g === gen) renderAutoConfig(lastAuto)
  }
}

// After a Config change: re-measure what was measured (and the situational toggles), up to a few dozen trials.
function refreshMeasured(g) {
  const specs = []
  const wanted = new Set((lastAuto?.suggested ?? []).map((x) => x.key))
  for (const e of entries.values()) {
    if (!e.measured && !wanted.has(e.key)) continue
    specs.push({ key: e.key })
    if (e.type === 'count' && e.trials?.length) specs.push({ key: e.key, values: e.trials.map((t) => t.value) })
  }
  measureSpecs(specs.slice(0, 40), g)
}

function render(r) {
  renderCatalog(r.autoConfig)
  renderAutoConfig(r.autoConfig)
  const s = r.snapshot.stats ?? {}
  $('results').hidden = false
  $('total-dps').textContent = fmtInt(s.TotalDPS)
  $('main-skill').textContent = r.mainSkill?.skill ?? '–'
  $('ehp').textContent = fmtInt(s.TotalEHP)

  kvTable('offence', [
    ['Total DPS', fmtInt(s.TotalDPS)],
    ['Combined DPS (with DoTs)', fmtInt(s.CombinedDPS)],
    s.FullDPS ? ['Full DPS (all included skills)', fmtInt(s.FullDPS)] : [],
    ['Average hit', fmtInt(s.AverageDamage)],
    ['Speed (uses/s)', fmt2(s.Speed)],
    ['Hit chance', pct(s.HitChance)],
    ['Crit chance', pct(s.CritChance)],
    ['Crit multiplier', typeof s.CritMultiplier === 'number' ? `${fmt2(s.CritMultiplier * 100)}%` : undefined],
    s.TotalDotDPS ? ['DoT DPS', fmtInt(s.TotalDotDPS)] : [],
    s.IgniteDPS ? ['Ignite DPS', fmtInt(s.IgniteDPS)] : [],
  ].filter((x) => x.length))

  const hand = r.mainSkill?.mainHand ?? {}
  const total = SPLIT.reduce((n, [, k]) => n + (hand[k] || 0), 0)
  $('split').replaceChildren(
    ...(total > 0
      ? SPLIT.map(([name, k, color]) => {
          const v = hand[k] || 0
          const row = document.createElement('div')
          row.className = 'split-row'
          row.innerHTML = `<span>${name}</span><div class="split-track"><div class="split-fill" style="width:${((v / total) * 100).toFixed(1)}%;background:${color}"></div></div><span>${fmtInt(v)} · ${((v / total) * 100).toFixed(0)}%</span>`
          return row
        })
      : [Object.assign(document.createElement('p'), { textContent: 'No hit damage for the main skill.' })]),
  )

  kvTable('defence', [
    ['Life', `${fmtInt(s.Life)}${s.LifeUnreserved != null && s.LifeUnreserved !== s.Life ? ` (${fmtInt(s.LifeUnreserved)} unreserved)` : ''}`],
    ['Energy shield', fmtInt(s.EnergyShield)],
    ['Mana', `${fmtInt(s.Mana)}${s.ManaUnreserved != null && s.ManaUnreserved !== s.Mana ? ` (${fmtInt(s.ManaUnreserved)} unreserved)` : ''}`],
    ['Spirit', s.Spirit != null ? `${fmtInt(s.SpiritUnreserved)} / ${fmtInt(s.Spirit)}` : undefined],
    ['Armour', fmtInt(s.Armour)],
    ['Physical damage reduction', pct(s.PhysicalDamageReduction)],
    ['Evasion', fmtInt(s.Evasion)],
    ['Deflection rating', fmtInt(s.DeflectionRating)],
    ['Effective HP', fmtInt(s.TotalEHP)],
  ])
  const res = (k) => (typeof s[`${k}Resist`] === 'number' ? `${fmtInt(s[`${k}Resist`])}%${s[`${k}ResistOverCap`] ? ` (+${fmtInt(s[`${k}ResistOverCap`])} over cap)` : ''}` : undefined)
  kvTable('resists', [['Fire', res('Fire')], ['Cold', res('Cold')], ['Lightning', res('Lightning')], ['Chaos', res('Chaos')]])
  kvTable('maxhit', ['Physical', 'Fire', 'Cold', 'Lightning', 'Chaos'].map((t) => [t, fmtInt(s[`${t}MaximumHitTaken`])]))
  kvTable('avoid', [
    ['Block chance', pct(s.EffectiveBlockChance)],
    ['Spell block chance', pct(s.EffectiveSpellBlockChance)],
    ['Deflect chance', pct(s.DeflectChance)],
    ['Evade chance', pct(s.EvadeChance)],
    ['Movement speed modifier', typeof s.EffectiveMovementSpeedMod === 'number' ? `${fmt2(s.EffectiveMovementSpeedMod)}×` : undefined],
  ])

  renderSkills(r)
  $('json').textContent = JSON.stringify(r, null, 2)
}

function renderSkills(r) {
  const wrap = $('skills')
  const rows = r.groups?.rows
  const full = r.snapshot.fullDpsSkills ?? []
  const table = document.createElement('table')
  table.className = 'skills'
  if (rows?.length) {
    table.innerHTML = '<thead><tr><th>#</th><th>Skill</th><th class="n">Total DPS</th><th class="n">Combined</th><th class="n">Avg hit</th><th class="n">Speed</th><th class="n">Crit</th></tr></thead>'
    const body = document.createElement('tbody')
    for (const row of rows) {
      const tr = document.createElement('tr')
      if (!row.enabled) tr.className = 'off'
      tr.innerHTML = `<td>${row.group}${row.activeSkill > 1 ? `.${row.activeSkill}` : ''}</td><td></td><td class="n">${fmtInt(row.TotalDPS)}</td><td class="n">${fmtInt(row.CombinedDPS)}</td><td class="n">${fmtInt(row.AverageDamage)}</td><td class="n">${fmt2(row.Speed)}</td><td class="n">${pct(row.CritChance)}</td>`
      tr.cells[1].textContent = row.loadError ? `${row.skill ?? '?'} (${row.loadError})` : row.skill
      body.append(tr)
    }
    table.append(body)
    wrap.replaceChildren(Object.assign(document.createElement('div'), { className: 'table-scroll' }))
    wrap.firstChild.append(table)
    wrap.append(Object.assign(document.createElement('p'), { className: 'meta', textContent: 'One row per skill group (and active skill), recalculated with that group as the main skill. Greyed rows are disabled in the build.' }))
  } else if (full.length) {
    table.innerHTML = '<thead><tr><th>Skill</th><th class="n">Count</th><th class="n">DPS</th><th class="n">Total</th></tr></thead>'
    const body = document.createElement('tbody')
    for (const f of full) {
      const tr = document.createElement('tr')
      tr.innerHTML = `<td></td><td class="n">${f.count}</td><td class="n">${fmtInt(f.dps)}</td><td class="n">${fmtInt(f.value)}</td>`
      tr.cells[0].textContent = f.name + (f.skillPart ? ` (${f.skillPart})` : '')
      body.append(tr)
    }
    table.append(body)
    wrap.replaceChildren(table)
    wrap.append(Object.assign(document.createElement('p'), { className: 'meta', textContent: "PoB's Full DPS skills. Tick “Recalculate every skill group” for a row per group." }))
  } else {
    wrap.replaceChildren(Object.assign(document.createElement('p'), { className: 'meta', textContent: 'Only the main skill is calculated by default. Tick “Recalculate every skill group” and calculate again for DPS per skill group.' }))
  }
}

$('sample').addEventListener('click', async () => {
  codeEl.value = (await (await fetch('sample-code.txt')).text()).trim()
  if (!calcBtn.disabled) run()
})
async function loadFile(file) {
  if (!file) return
  try {
    codeEl.value = (await file.text()).trim()
    setStatus(`Loaded ${file.name} (${(file.size / 1024).toFixed(1)} KB).`)
    if (!calcBtn.disabled) run()
  } catch (e) {
    setStatus(`Could not read ${file.name}: ${e.message}`, true)
  }
}
$('upload').addEventListener('click', () => $('file').click())
$('file').addEventListener('change', (e) => {
  loadFile(e.target.files[0])
  e.target.value = ''
})
codeEl.addEventListener('dragover', (e) => e.preventDefault())
codeEl.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0]
  if (!f) return
  e.preventDefault()
  loadFile(f)
})
calcBtn.addEventListener('click', run)
$('reset-manual').addEventListener('click', () => { overrides = {}; rerun() })
codeEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !calcBtn.disabled) run()
})
$('copy').addEventListener('click', (e) => {
  e.preventDefault()
  navigator.clipboard?.writeText($('json').textContent)
})

boot()
