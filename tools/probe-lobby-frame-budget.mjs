/**
 * 大厅 CoverFlow 帧预算探针
 *
 * 目的：车机滑动大厅掉帧，但本机 4× CPU 降速仍能满帧 —— 说明瓶颈不在 JS 算力。
 * 这个探针改用「软件光栅 + 高 DPI」作为弱车机 GPU 的代理条件，并用 Chrome trace
 * 把每帧的时间拆到生命周期各阶段，回答一个具体问题：
 *
 *   每帧到底是在 UpdateLayoutTree（样式重算）、Layout、Paint，还是 Rasterize 上花掉的？
 *
 * 判定要点：
 *   - 每帧 UpdateLayoutTree / Paint 次数明显 > 1 → 逐帧写了非合成属性（自定义属性、
 *     zIndex、pointerEvents、box-shadow 之类），必须从逐帧循环里拿掉。
 *   - Rasterize 面积/耗时占比大 → 光栅化成了瓶颈，要减少被重绘的面积或降像素。
 *   - FireAnimationFrame 占比大 → JS 循环本身重。
 *
 * 用法：
 *   node tools/probe-lobby-frame-budget.mjs                 # 软件光栅（默认，模拟弱 GPU）
 *   node tools/probe-lobby-frame-budget.mjs --gpu           # 硬件加速（对照组）
 *   node tools/probe-lobby-frame-budget.mjs --throttle=4    # 叠加 CPU 降速
 */
import puppeteer from 'puppeteer-core'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname, normalize } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const DIST = join(ROOT, 'dist')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const argv = process.argv.slice(2)
const USE_GPU = argv.includes('--gpu')
const THROTTLE = Number((argv.find((a) => a.startsWith('--throttle=')) || '--throttle=1').split('=')[1]) || 1
const TRACE_OUT = join(here, 'lobby-frame-budget.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- 静态服务：直接用构建产物，保证测的是要发布的代码 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
}
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0])
    if (p.endsWith('/')) p += 'index.html'
    const file = join(DIST, normalize(p).replace(/^(\.\.[/\\])+/, ''))
    if (!existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    const buf = await readFile(file)
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(buf)
  } catch (e) {
    res.writeHead(500)
    res.end(String(e))
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${server.address().port}/`

/* ---------- 浏览器：软件光栅作为弱 GPU 代理 ---------- */
const args = [
  '--no-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  // 关掉后台节流，否则掉帧会被 Chrome 自己的省电逻辑污染
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
]
if (!USE_GPU) {
  // 强制走 SwiftShader 软件光栅：车机 WebView 若没有真 GPU 就是这个形态，
  // 同时它也是「GPU 很弱」的合理代理 —— 光栅全在 CPU 上做。
  args.push('--disable-gpu', '--disable-gpu-compositing', '--use-gl=swiftshader', '--disable-accelerated-2d-canvas')
}

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: CHROME,
  args,
  defaultViewport: { width: 1920, height: 984, deviceScaleFactor: 1.5 },
})

const report = { mode: USE_GPU ? 'gpu' : 'software-raster', throttle: THROTTLE }

try {
  const page = await browser.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  [page error]', m.text().slice(0, 160))
  })

  if (THROTTLE > 1) {
    const cdp = await page.createCDPSession()
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
  }

  await page.goto(ORIGIN, { waitUntil: 'networkidle2', timeout: 45000 })
  await sleep(3000) // 等入场级联动画（entered≈950ms）跑完

  const ready = await page.evaluate(() => ({
    stage: !!document.querySelector('.cf-stage'),
    cards: document.querySelectorAll('.cf-card').length,
    center: !!document.querySelector('.cf-card--center'),
  }))
  console.log('大厅就绪：', JSON.stringify(ready))
  if (!ready.stage) throw new Error('未找到 .cf-stage，无法测量')

  /* ---------- 记录一次真实拖拽期间的 trace ---------- */
  await page.tracing.start({
    path: TRACE_OUT,
    categories: [
      'devtools.timeline',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.frame',
      'blink.user_timing',
      'cc',
      'toplevel',
    ],
  })
  await sleep(300)

  const box = await page.evaluate(() => {
    const r = document.querySelector('.cf-stage').getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })

  // 一次「按住 - 横拖 12 步 - 松手」的真实手势：覆盖拖拽跟手 + 惯性吸附两段
  const t0 = Date.now()
  await page.mouse.move(box.x + 420, box.y)
  await page.mouse.down()
  for (let i = 1; i <= 24; i++) {
    await page.mouse.move(box.x + 420 - i * 30, box.y)
    await sleep(8)
  }
  await page.mouse.up()
  await sleep(900) // 惯性吸附
  const gestureMs = Date.now() - t0

  await page.tracing.stop()
  report.gestureMs = gestureMs
  console.log(`手势时长 ${gestureMs}ms`)

  /* ---------- 解析 trace：把时间拆到各生命周期阶段 ---------- */
  const raw = JSON.parse(await readFile(TRACE_OUT, 'utf8'))
  const events = raw.traceEvents || raw

  const PHASES = {
    'UpdateLayoutTree': '样式重算',
    'Layout': '布局',
    'Paint': '绘制',
    'PrePaint': '预绘制',
    'UpdateLayerTree': '图层树更新',
    'CompositeLayers': '合成层提交',
    'Rasterize': '光栅化',
    'RasterizeTask': '光栅化任务',
    'FireAnimationFrame': 'rAF 回调',
    'FunctionCall': 'JS 函数',
    'TimerFire': '定时器',
    'HitTest': '命中测试',
    'DrawFrame': '提交帧',
    'BeginMainFrame': '主线程帧开始',
    'BeginFrame': '合成器帧开始',
    'Commit': '提交',
    'ActivateLayerTree': '激活图层树',
  }

  const stat = {}
  let drawFrames = 0
  let mainFrames = 0
  for (const e of events) {
    const label = PHASES[e.name]
    if (!label) continue
    if (typeof e.dur !== 'number') continue
    const s = (stat[e.name] ||= { label, count: 0, dur: 0, max: 0 })
    s.count++
    s.dur += e.dur
    if (e.dur > s.max) s.max = e.dur
    if (e.name === 'DrawFrame') drawFrames++
    if (e.name === 'BeginMainFrame') mainFrames++
  }

  const rows = Object.entries(stat)
    .map(([name, s]) => ({
      name,
      label: s.label,
      count: s.count,
      totalMs: +(s.dur / 1000).toFixed(1),
      perFrameMs: s.count ? +(s.dur / 1000 / s.count).toFixed(2) : 0,
      maxMs: +(s.max / 1000).toFixed(1),
    }))
    .sort((a, b) => b.totalMs - a.totalMs)

  report.frames = { drawFrames, mainFrames }
  report.phases = rows
  report.fps = +(drawFrames / (gestureMs / 1000)).toFixed(1)

  console.log('\n=== 帧预算（%s / CPU×%d，%d×%d @%.1fx）===',
    report.mode, THROTTLE, 1920, 984, 1.5)
  console.log(`合成帧 ${drawFrames} · 主线程帧 ${mainFrames} · 等效 FPS ${report.fps}`)
  console.log('阶段                     次数    总计ms   每次ms   峰值ms')
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(18)} ${String(r.count).padStart(6)} ${String(r.totalMs).padStart(9)} ${String(r.perFrameMs).padStart(8)} ${String(r.maxMs).padStart(8)}`,
    )
  }

  /* 每帧平均做了几次样式重算 / 绘制：> 1 就说明逐帧写了非合成属性 */
  const per = (n) => {
    const r = rows.find((x) => x.name === n)
    return drawFrames ? +(r ? r.count / drawFrames : 0).toFixed(2) : 0
  }
  report.perFrame = {
    styleRecalc: per('UpdateLayoutTree'),
    layout: per('Layout'),
    paint: per('Paint'),
    rasterize: per('Rasterize'),
    raf: per('FireAnimationFrame'),
  }
  console.log('\n每帧：样式重算 %s 次 · 布局 %s 次 · 绘制 %s 次 · 光栅 %s 次 · rAF %s 次',
    report.perFrame.styleRecalc, report.perFrame.layout, report.perFrame.paint,
    report.perFrame.rasterize, report.perFrame.raf)

  /* ---------- 关键信号判定 ---------- */
  const verdict = []
  const mainBusy = rows
    .filter((r) => ['样式重算', '布局', '绘制', 'rAF 回调', '图层树更新', '提交帧'].includes(r.label))
    .reduce((a, r) => a + r.totalMs, 0)
  const raster = rows.find((r) => r.name === 'Rasterize')
  const rasterMs = raster ? raster.totalMs : 0
  verdict.push(`主线程渲染占比 ${((mainBusy / gestureMs) * 100).toFixed(1)}%`)
  verdict.push(`光栅化耗时 ${rasterMs}ms（占比 ${((rasterMs / gestureMs) * 100).toFixed(1)}%）`)
  if (report.perFrame.paint > 1.2) verdict.push('⚠ 每帧多次绘制 → 逐帧改了会触发重绘的属性')
  if (report.perFrame.styleRecalc > 1.2) verdict.push('⚠ 每帧多次样式重算 → 逐帧写了自定义属性/布局属性')
  if (gridCheck(rows)) verdict.push('⚠ 光栅化是主要瓶颈')
  report.verdict = verdict
  console.log('\n判定：')
  for (const v of verdict) console.log('  · ' + v)

  await writeFile(TRACE_OUT.replace(/\.json$/, '-summary.json'), JSON.stringify(report, null, 2))
  console.log(`\n摘要已写入 ${TRACE_OUT.replace(/\.json$/, '-summary.json')}`)
} catch (e) {
  console.error('探针失败：', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
  server.close()
}

function gridCheck(rows) {
  const raster = rows.find((r) => r.name === 'Rasterize')
  const paint = rows.find((r) => r.name === 'Paint')
  if (!raster || !paint) return false
  return raster.totalMs > paint.totalMs * 2 && raster.totalMs > 100
}