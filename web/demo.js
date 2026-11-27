// Demo page for pob-calc.js: paste a code, see PoB's numbers and how long each step took.
import { calc, init } from './pob-calc.js'

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
async function run() {
  const code = codeEl.value.trim()
  if (!code) {
    setStatus('Paste a PoB2 code first.', true)
    return
  }
  const groups = $('groups').checked
  calcBtn.disabled = true
  setStatus(groups ? 'Calculating every skill group… this takes a while.' : 'Calculating…')
  const t0 = performance.now()
  try {
    const r = await calc(code, { groups })
    const wall = performance.now() - t0
    calcCount++
    const label = calcCount === 1 ? 'First calc' : 'Last calc'
    const e = r.timings.engine
    setTiming(groups ? `${label} (+ all groups)` : label, ms(wall),
      `decode ${ms(r.timings.decodeMs)} · tree ${ms(r.timings.treeMs)} · load+calc ${ms(e.load)} · snapshot ${ms(e.snapshot)}${e.groups ? ` · groups ${ms(e.groups)}` : ''}`)
    setTiming('Memory now', mb(r.wasmHeapBytes), `Lua heap after GC ${mb(e.luaHeapBytes)}`)
    render(r)
    setStatus(r.snapshot.loadError ? `PoB reported: ${r.snapshot.loadError}` : `Done in ${ms(wall)}.`, !!r.snapshot.loadError)
    window.__pobLast = { result: r, wallMs: wall }
  } catch (e) {
    setStatus(e.kind === 'decode' ? e.message : `PoB could not calculate this build: ${e.message}`, true)
  } finally {
    calcBtn.disabled = false
  }
}

const SPLIT = [
  ['Physical', 'PhysicalHitAverage', 'var(--phys)'],
  ['Fire', 'FireHitAverage', 'var(--fire)'],
  ['Cold', 'ColdHitAverage', 'var(--cold)'],
  ['Lightning', 'LightningHitAverage', 'var(--light)'],
  ['Chaos', 'ChaosHitAverage', 'var(--chaos)'],
]

function render(r) {
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
codeEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !calcBtn.disabled) run()
})
$('copy').addEventListener('click', (e) => {
  e.preventDefault()
  navigator.clipboard?.writeText($('json').textContent)
})

boot()
