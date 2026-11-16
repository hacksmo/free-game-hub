/**
 * 重绘失效原因追踪探针
 *
 * 上一个探针发现：一次拖拽里 168 个 rAF 帧产生了 142 次 Paint —— 几乎每帧都重绘。
 * 但「重绘了」不等于知道「为什么重绘」。这个探针打开 Chromium 的
 * invalidationTracking 分类，把每条失效记录的原因（reason）与节点聚合出来。
 *
 * 判定依据：
 *   - 原因里出现 "custom property" / "style change" 且节点是 .cf-card →
 *     逐帧写 --cf-shade 之类的自定义属性在逼着卡片重绘。
 *   - 节点是 .cf-card 且原因与 transform/scale 有关、次数≈帧数 →
 *     逐帧改 scale 让 Chromium 反复重光栅化（动画没走合成器）。
 *   - 节点是 .cf-bg__img / .cf-stage__glow → 背景/光晕在重绘。
 *
 * 用法：node tools/probe-invalidation.mjs
 */
import puppeteer from 'puppeteer-core'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname, normalize } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const DIST = join(here, '..', 'dist')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = join(here, 'lobby-invalidation.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.wasm': 'application/wasm',
}
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0])
    if (p.endsWith('/')) p += 'index.html'
    const file = join(DIST, normalize(p).replace(/^(\.\.[/\\])+/, ''))
    if (!existsSync(file)) { res.writeHead(404); res.end('nf'); return }
    const buf = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(buf)
  } catch (e) { res.writeHead(500); res.end(String(e)) }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${server.address().port}/`

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: CHROME,
  args: ['--no-sandbox', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  defaultViewport: { width: 1920, height: 984, deviceScaleFactor: 1.5 },
})

try {
  const page = await browser.newPage()
  await page.goto(ORIGIN, { waitUntil: 'networkidle2', timeout: 45000 })
  await sleep(3200)

  await page.tracing.start({
    path: OUT,
    categories: [
      'devtools.timeline',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.frame',
      'disabled-by-default-devtools.timeline.invalidationTracking',
      'blink',
      'toplevel',
    ],
  })
  await sleep(250)

  const box = await page.evaluate(() => {
    const r = document.querySelector('.cf-stage').getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await page.mouse.move(box.x + 400, box.y)
  await page.mouse.down()
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(box.x + 400 - i * 24, box.y)
    await sleep(12)
  }
  await page.mouse.up()
  await sleep(700)
  await page.tracing.stop()

  const raw = JSON.parse(await readFile(OUT, 'utf8'))
  const events = raw.traceEvents || raw

  /* 把 DOM 节点 id 映射成可读选择器：靠页面自己给的 data 属性最直观 */
  const nodeMap = await page.evaluate(() => {
    const out = {}
    const all = document.querySelectorAll('*')
    for (const el of all) {
      // Blink 的 nodeId 不对 JS 公开，只能反过来用外层结构描述
      void el
    }
    return out
  })
  void nodeMap

  const reasons = new Map()
  let paintInvalidations = 0
  let styleInvalidations = 0
  let layoutInvalidations = 0
  const reasonsByKind = { 'PaintInvalidation': new Map(), 'StyleRecalcInvalidation': new Map(), 'LayoutInvalidation': new Map() }

  for (const e of events) {
    const kind = e.name
    if (!/Invalidation/.test(kind)) continue
    const reason = (e.args && e.args.data && e.args.data.reason) || '(no reason)'
    if (kind === 'PaintInvalidationTracking') paintInvalidations++
    else if (/Style/.test(kind)) styleInvalidations++
    else if (/Layout/.test(kind)) layoutInvalidations++
    const bucket = reasonsByKind[kind.startsWith('Paint') ? 'PaintInvalidation'
      : kind.startsWith('Layout') ? 'LayoutInvalidation' : 'StyleRecalcInvalidation']
    if (bucket) bucket.set(reason, (bucket.get(reason) || 0) + 1)
    reasons.set(kind + ' :: ' + reason, (reasons.get(kind + ' :: ' + reason) || 0) + 1)
  }

  /* 也统计 Paint / UpdateLayoutTree 的次数，作为对照 */
  let paints = 0, styles = 0, raf = 0
  const paintNodes = new Map()
  for (const e of events) {
    if (e.name === 'Paint') {
      paints++
      const n = e.args && e.args.data && e.args.data.nodeId
      if (n) paintNodes.set(n, (paintNodes.get(n) || 0) + 1)
    }
    if (e.name === 'UpdateLayoutTree') styles++
    if (e.name === 'FireAnimationFrame') raf++
  }

  console.log(`\n=== 失效追踪（${events.length} 条 trace 事件）===`)
  console.log(`rAF 帧 ${raf} · Paint ${paints} · UpdateLayoutTree ${styles}`)
  console.log(`失效记录：重绘 ${paintInvalidations} · 样式 ${styleInvalidations} · 布局 ${layoutInvalidations}`)

  for (const [kind, map] of Object.entries(reasonsByKind)) {
    if (!map.size) continue
    console.log(`\n${kind} 原因 TOP：`)
    for (const [r, c] of [...map].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`  ${String(c).padStart(5)} × ${r}`)
    }
  }

  if (paintNodes.size) {
    console.log(`\n被重绘的节点（nodeId × 次数）TOP：`)
    for (const [n, c] of [...paintNodes].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`  nodeId ${n}: ${c} 次`)
    }
    // 用 nodeId 反查元素
    const cdp = await page.createCDPSession()
    await cdp.send('DOM.enable')
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: false })
    const flat = []
    const walk = (n) => {
      flat.push(n)
      for (const c of n.children || []) walk(c)
    }
    walk(root)
    const byId = new Map(flat.map((n) => [n.nodeId, n]))
    console.log('\n反查元素：')
    for (const [n, c] of [...paintNodes].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      const node = byId.get(n)
      if (!node) { console.log(`  ${n}: (未找到，可能是内部节点)`); continue }
      const cls = (node.attributes || []).join(' ').slice(0, 90)
      console.log(`  ${n} ×${c}: <${node.localName}> ${cls}`)
    }
  }

  await writeFile(OUT.replace(/\.json$/, '-summary.json'), JSON.stringify({
    raf, paints, styles, paintInvalidations, styleInvalidations, layoutInvalidations,
    reasons: Object.fromEntries([...reasons].sort((a, b) => b[1] - a[1]).slice(0, 40)),
  }, null, 2))
} catch (e) {
  console.error('探针失败：', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
  server.close()
}