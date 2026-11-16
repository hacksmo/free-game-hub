/**
 * 大厅滑动吞吐基准（三档对照）
 *
 * 为什么要单独做：开发机的 GPU 比车机强一个数量级，任何「优化后看着更顺」都不算证据。
 * 这里用「软件光栅 + CPU 降速」把机器压到接近弱车机的算力区间，然后在同一条件下
 * 分别跑三档画质，数每档每秒真正交付了多少帧。
 *
 * 读法：三档之间必须有明显落差，说明「降档」确实是有效杠杆；
 * 若三档几乎一样，说明瓶颈不在这一层，得另找方向。
 *
 * 用法：node tools/bench-lobby-fps.mjs [throttle=4]
 */
import puppeteer from 'puppeteer-core'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname, normalize } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const DIST = join(here, '..', 'dist')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const THROTTLE = Number(process.argv[2] || 4)
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
  args: [
    '--no-sandbox', '--mute-audio',
    '--disable-gpu', '--disable-gpu-compositing', '--use-gl=swiftshader', '--disable-accelerated-2d-canvas',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  ],
  defaultViewport: { width: 1920, height: 984, deviceScaleFactor: 1.5 },
})

try {
  const page = await browser.newPage()
  const cdp = await page.createCDPSession()
  if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
  await page.goto(ORIGIN, { waitUntil: 'networkidle2', timeout: 60000 })
  await sleep(3500)

  const box = await page.evaluate(() => {
    const r = document.querySelector('.cf-stage').getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })

  const rows = []
  for (const tier of [0, 1, 2]) {
    await page.evaluate((t) => window.__carcadePerf.setTier(t), tier)
    await sleep(600)

    // 起一个独立计数器：不依赖应用的采样器，避免被降档逻辑干扰
    await page.evaluate(() => {
      window.__bench = { frames: 0, worst: 0, last: 0, on: true }
      const t = (ts) => {
        if (!window.__bench.on) return
        if (window.__bench.last) {
          const d = ts - window.__bench.last
          if (d > window.__bench.worst) window.__bench.worst = d
        }
        window.__bench.last = ts
        window.__bench.frames++
        requestAnimationFrame(t)
      }
      requestAnimationFrame(t)
    })

    // 持续横向拖拽 2.2s：覆盖跟手绘制 + 跨卡 + 惯性
    const t0 = Date.now()
    await page.mouse.move(box.x + 500, box.y)
    await page.mouse.down()
    let x = 500
    let dir = -1
    for (let i = 0; i < 140; i++) {
      x += dir * 14
      if (x < -520 || x > 500) dir *= -1
      await page.mouse.move(box.x + x, box.y)
      await sleep(15)
      if (Date.now() - t0 > 2200) break
    }
    await page.mouse.up()
    const ms = Date.now() - t0

    const r = await page.evaluate(() => {
      window.__bench.on = false
      return { frames: window.__bench.frames, worst: window.__bench.worst }
    })
    rows.push({ tier, ms, frames: r.frames, fps: +(r.frames / (ms / 1000)).toFixed(1), worstMs: +r.worst.toFixed(1) })
    await sleep(400)
  }

  console.log(`\n=== 大厅滑动吞吐（软件光栅 / CPU×${THROTTLE} / 1920×984 @1.5x）===`)
  console.log('档位  时长ms   帧数   等效FPS   最差单帧ms')
  for (const r of rows) {
    console.log(` ${r.tier}   ${String(r.ms).padStart(6)} ${String(r.frames).padStart(6)}   ${String(r.fps).padStart(7)}   ${String(r.worstMs).padStart(8)}`)
  }
  const base = rows[0].fps
  const best = rows[rows.length - 1].fps
  console.log(`\n档 2 相对档 0 吞吐 ×${(best / base).toFixed(2)}`)
  console.log(best > base * 1.3
    ? '✅ 降档是有效杠杆：最弱档确实换来更高吞吐'
    : '⚠ 三档差别不大 → 瓶颈不在这一层，需要换方向')
} catch (e) {
  console.error('基准失败：', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
  server.close()
}