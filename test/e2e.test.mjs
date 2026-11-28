// End to end in Chromium (Playwright): the built dist/ served like GitHub Pages; cold start, the sample code,
// oracle parity in the browser, then a reload that starts from Cache Storage (warm).
//   node scripts/pack.mjs && node --test test/e2e.test.mjs        (E2E_URL=https://… to test a deployed site)
// Writes e2e-timings.json and, with E2E_SCREENSHOT=path.png, a screenshot of the results.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { serve } from '../scripts/serve.mjs'
import { compareToOracle } from './compare.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const oracle = JSON.parse(readFileSync(ROOT + 'fixtures/oracle/ninja-default.oracle.json', 'utf8'))

test('demo page calculates the reference code in Chromium', { timeout: 600_000 }, async (t) => {
  let server = null
  let url = process.env.E2E_URL
  if (!url) {
    server = await serve(ROOT + 'dist')
    url = `http://127.0.0.1:${server.address().port}/`
  }
  const browser = await chromium.launch()
  const timings = { url }
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: process.env.E2E_SCREENSHOT ? 2 : 1 })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

    await page.goto(url)
    await page.waitForFunction(() => window.__pobInit, null, { timeout: 300_000 })
    const cold = await page.evaluate(() => window.__pobInit)
    timings.cold = { wallMs: cold.wallMs, ...cold.timings, networkBytes: cold.bytes.network, firstVisitBytes: cold.bytes.firstVisit, wasmHeapBytes: cold.wasmHeapBytes }
    assert.equal(cold.pobVersion, oracle.pobVersion)
    assert.equal(cold.pinCommit, oracle.pinCommit)

    await page.click('#sample')
    await page.waitForFunction(() => window.__pobLast, null, { timeout: 300_000 })
    const first = await page.evaluate(() => window.__pobLast)
    timings.firstCalc = { wallMs: first.wallMs, ...first.result.timings, wasmHeapBytes: first.result.wasmHeapBytes }

    await t.test('TotalDPS 186,706 on the page', async () => {
      assert.equal(Math.round(first.result.snapshot.stats.TotalDPS), 186706)
      assert.equal(await page.textContent('#total-dps'), '186,706')
    })
    await t.test('every stat matches the oracle in the browser', () => {
      assert.deepEqual(compareToOracle(first.result, oracle, null), [])
    })

    await t.test('Config table: the boss dropdown changes DPS without reloading the build, and back again', async () => {
      await page.evaluate(() => (window.__pobLast = null))
      await page.check('#autocfg')
      await page.click('#calc')
      await page.waitForFunction(() => window.__pobLast?.result.autoConfig?.catalog, null, { timeout: 300_000 })
      assert.ok((await page.locator('#catalog tbody tr').count()) > 0, 'Config table renders')
      const base = await page.textContent('#total-dps')
      const boss = page.locator('#catalog select', { has: page.locator('option', { hasText: 'Standard Boss' }) }).first()
      const original = await boss.inputValue()
      const other = original === 'Boss' ? 'None' : 'Boss'
      await page.evaluate(() => (window.__pobLast = null))
      await boss.selectOption(other)
      await page.waitForFunction(() => window.__pobLast, null, { timeout: 300_000 })
      assert.equal(await page.evaluate(() => window.__pobLast.kind), 'reconfig', 'no reload of the build')
      const changed = await page.textContent('#total-dps')
      assert.notEqual(changed, base)
      await page.waitForFunction(() => window.__pobPending === 0, null, { timeout: 300_000 })
      await page.evaluate(() => (window.__pobLast = null))
      await boss.selectOption(original)
      await page.waitForFunction(() => window.__pobLast, null, { timeout: 300_000 })
      assert.equal(await page.textContent('#total-dps'), base, 'back to the starting DPS')
      await page.waitForFunction(() => window.__pobPending === 0, null, { timeout: 300_000 })
      await page.uncheck('#autocfg')
    })

    // Repeat calc in the same engine.
    await page.evaluate(() => (window.__pobLast = null))
    await page.click('#calc')
    await page.waitForFunction(() => window.__pobLast, null, { timeout: 300_000 })
    const again = await page.evaluate(() => window.__pobLast)
    timings.repeatCalc = { wallMs: again.wallMs, ...again.result.timings }
    if (process.env.E2E_SCREENSHOT) await page.screenshot({ path: process.env.E2E_SCREENSHOT, fullPage: true })

    // Warm start: same context, so Cache Storage holds the packs.
    await page.reload()
    await page.waitForFunction(() => window.__pobInit, null, { timeout: 300_000 })
    const warm = await page.evaluate(() => window.__pobInit)
    timings.warm = { wallMs: warm.wallMs, ...warm.timings, networkBytes: warm.bytes.network, cachedBytes: warm.bytes.cached }
    await t.test('a reload starts from Cache Storage', () => {
      assert.equal(warm.bytes.network, 0)
    })
    await t.test('no page errors', () => assert.deepEqual(errors, []))
  } finally {
    await browser.close()
    server?.close()
    writeFileSync(ROOT + 'e2e-timings.json', JSON.stringify(timings, null, 2) + '\n')
    console.log(JSON.stringify(timings, null, 2))
  }
})
