/**
 * 星际猎手：16:9 全屏改造的**玩法回归**。
 *
 * 用页面暴露的 window.__probe 读真实内部状态（不是猜像素）：
 *   1. 逻辑画幅与屏幕一致、scale 两边相等 → 铺满无黑边；
 *   2. 玩家横向活动范围随屏幕变宽（不再是固定 480 逻辑像素）；
 *   3. 敌人仍从下方来（y > 0 的占绝大多数）；
 *   4. 敌人密度补偿生效（宽屏下每波敌人数比竖版多，不是空场）。
 */
import puppeteer from 'puppeteer-core'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const DIST = join(ROOT, 'game-library')
const PORT = 18774

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.png': 'image/png',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    let p = decodeURIComponent(url.pathname)
    if (p === '/') p = '/index.html'
    const file = join(DIST, p)
    const buf = await readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(buf)
  } catch {
    res.writeHead(404); res.end('not found')
  }
})
await new Promise((r) => server.listen(PORT, r))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await puppeteer.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox'],
})

try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setViewport({ width: 1920, height: 984, deviceScaleFactor: 1 })
  await page.goto(`http://127.0.0.1:${PORT}/arcade/sternenjaeger/index.html`, {
    waitUntil: 'networkidle2',
  })
  await new Promise((r) => setTimeout(r, 300))

  const dims = await page.evaluate(() => window.__probe())
  check('逻辑画幅与屏幕一致',
    Math.abs(dims.aspect - dims.cw / dims.ch) < 0.01,
    `screen=${dims.cw}×${dims.ch} logical=${dims.W}×${dims.H} aspect=${dims.aspect}`)
  check('逻辑宽度按 16:9 反推（>竖版 480）',
    dims.W > 480 * 1.5, `W=${dims.W} (竖版是 480)`)
  check('scale 横向纵向一致（保证铺满）',
    Math.abs(dims.scale - dims.ch / dims.H) < 0.001,
    `scale=${dims.scale} 期望=${(dims.ch / dims.H).toFixed(4)}`)
  check('页面无 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '))

  // 开始一关
  await page.evaluate(() => {
    const pri = document.querySelector('.pri')
    if (pri) pri.click()
  })
  await new Promise((r) => setTimeout(r, 3500))

  const play = await page.evaluate(() => window.__probe())
  check('已进入战斗状态', play.state === 'play', `state=${play.state}`)

  // 横向活动范围：按住左移到底，读玩家 x
  // 注意顺序：先测边界会把飞机推到边缘上，后面的输入测试就推不动了。
  // 所以先把飞机拨回中间，再测输入，最后测边界。
  const left = await page.evaluate(async () => {
    const dn = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })
    const up = new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true })
    document.dispatchEvent(dn)
    await new Promise((r) => setTimeout(r, 1500))
    document.dispatchEvent(up)
    return window.__probe()
  })

  // 手柄：横向推杆应让飞机横向移动（这次改了移动速度补偿，必须确认手柄没被漏掉）
  const pad = await page.evaluate(async () => {
    const before = window.__probe().playerX
    const orig = navigator.getGamepads
    navigator.getGamepads = function () {
      return [{ id: 'test', index: 0, connected: true, mapping: 'standard',
                axes: [1, 0, 0, 0], buttons: [], timestamp: performance.now() }]
    }
    await new Promise((r) => setTimeout(r, 1200))
    const after = window.__probe().playerX
    navigator.getGamepads = orig
    return { before, after }
  })
  check('手柄横向推杆能操控飞机',
    pad.after > pad.before + 30,
    `x ${pad.before} → ${pad.after}`)

  // 触摸：拖动应让飞机跟手（横向按宽度补偿后仍要跟手）
  const touch = await page.evaluate(async () => {
    const cv = document.getElementById('cv')
    const before = window.__probe().playerX
    const mk = (type, x, y) => new PointerEvent(type, {
      pointerId: 7, pointerType: 'touch', clientX: x, clientY: y,
      bubbles: true, cancelable: true,
    })
    cv.dispatchEvent(mk('pointerdown', 1500, 600))
    await new Promise((r) => setTimeout(r, 60))
    cv.dispatchEvent(mk('pointermove', 1700, 600))
    await new Promise((r) => setTimeout(r, 300))
    const after = window.__probe().playerX
    cv.dispatchEvent(mk('pointerup', 1700, 600))
    return { before, after }
  })
  check('触摸拖动能操控飞机',
    touch.after > touch.before + 20,
    `x ${touch.before} → ${touch.after}`)

  // 边界：往右推到头
  const right = await page.evaluate(async () => {
    const dn = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
    const up = new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })
    document.dispatchEvent(dn)
    await new Promise((r) => setTimeout(r, 3000))
    document.dispatchEvent(up)
    return window.__probe()
  })

  check('玩家能移动到左边缘',
    left.playerX <= left.playerMinX + 40,
    `x=${left.playerX} 左界=${left.playerMinX}`)
  check('玩家能移动到右边缘',
    right.playerX >= right.playerMaxX - 40,
    `x=${right.playerX} 右界=${right.playerMaxX}`)
  check('横向活动范围随屏变宽',
    right.playerMaxX > 480 * 1.5,
    `活动范围 0..${right.playerMaxX}（竖版是 0..480）`)

  // 敌人来向：敌机从**顶部屏幕外**（y<0）生成并向下飞。
  // 所以不能断言「上方没有敌人」——生成瞬间 y 就是负的。
  // 正确判据：屏幕内敌人的平均 y 随时间**增大**（在往下飞）。
  const flow = await page.evaluate(async () => {
    const a = window.__probe()
    await new Promise((r) => setTimeout(r, 1500))
    const b = window.__probe()
    return { a, b }
  })
  check('敌人持续存在（战斗没停）',
    flow.b.enemies > 0, `敌人 ${flow.a.enemies} → ${flow.b.enemies}`)
  check('敌机向下推进（平均 y 随时间增大）',
    flow.b.avgEnemyY >= flow.a.avgEnemyY,
    `avgY ${flow.a.avgEnemyY} → ${flow.b.avgEnemyY}（屏幕高 ${flow.b.H}）`)

  // 密度补偿：宽屏下每波敌人数应比竖版基准(8)多
  check('宽屏密度补偿生效（每波敌人数增加）',
    play.df > 1.5 && play.nextWaveSize >= 8,
    `df=${play.df} 下一波 ${play.nextWaveSize} 个（竖版基准 8）`)

  await page.close()
} finally {
  await browser.close()
  server.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed ? 1 : 0)
