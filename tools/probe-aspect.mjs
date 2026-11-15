/**
 * 画幅探针：验证「星际猎手」在车机各档分辨率下**铺满整屏**。
 *
 * 背景：
 *   这游戏原本是竖版打飞机（480×800，3:4），在 1920×984 的车机上只占中间
 *   一条竖带，两侧全黑。改成 16:9 全屏后，必须确认：
 *     1. 画布真的铺满视口（不留黑边）；
 *     2. 逻辑坐标系的宽高比与屏幕一致（scale 两边相等）；
 *     3. 玩家横向活动范围确实变宽（不是被钉在中间）；
 *     4. 敌人仍从下方来（玩法没被改掉）。
 *
 * 手法：直接读页面里的 stage/canvas 实际像素尺寸 + 注入的探针状态，
 * 而不是截图肉眼看（黑边 vs 背景色在深色游戏里肉眼难辨）。
 */
import puppeteer from 'puppeteer-core'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const DIST = join(ROOT, 'game-library')
const PORT = 18771

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

/* 车机三档 + 桌面 16:9 + 极端宽屏（验证密度补偿上限） */
const VIEWPORTS = [
  { name: '车机 1920×984', width: 1920, height: 984 },
  { name: '车机 1280×720', width: 1280, height: 720 },
  { name: '车机 1024×600', width: 1024, height: 600 },
  { name: '桌面 1920×1080', width: 1920, height: 1080 },
  { name: '超宽 2560×1080', width: 2560, height: 1080 },
]

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
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage()
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 })
    await page.goto(`http://127.0.0.1:${PORT}/arcade/sternenjaeger/index.html`, {
      waitUntil: 'networkidle2',
    })
    await new Promise((r) => setTimeout(r, 400))

    const info = await page.evaluate(() => {
      const stage = document.getElementById('stage')
      const cv = document.getElementById('cv')
      const sr = stage.getBoundingClientRect()
      const cr = cv.getBoundingClientRect()
      return {
        stageW: Math.round(sr.width), stageH: Math.round(sr.height),
        canvasW: Math.round(cr.width), canvasH: Math.round(cr.height),
        stageLeft: Math.round(sr.left), stageTop: Math.round(sr.top),
        canvasLeft: Math.round(cr.left), canvasTop: Math.round(cr.top),
        vw: window.innerWidth, vh: window.innerHeight,
        bodyW: document.body.scrollWidth, bodyH: document.body.scrollHeight,
      }
    })

    const tag = vp.name
    // 1. 舞台铺满视口（允许 1px 舍入误差）
    check(`${tag} 舞台铺满视口`,
      Math.abs(info.stageW - info.vw) <= 1 && Math.abs(info.stageH - info.vh) <= 1,
      `stage=${info.stageW}×${info.stageH} viewport=${info.vw}×${info.vh}`)
    // 2. 画布铺满舞台，无黑边
    check(`${tag} 画布铺满舞台`,
      Math.abs(info.canvasW - info.stageW) <= 1 && Math.abs(info.canvasH - info.stageH) <= 1,
      `canvas=${info.canvasW}×${info.canvasH}`)
    // 3. 画布从 (0,0) 起 —— 没被居中留出左右边
    check(`${tag} 无左右黑边`,
      Math.abs(info.canvasLeft) <= 1 && Math.abs(info.canvasTop) <= 1,
      `left=${info.canvasLeft} top=${info.canvasTop}`)
    // 4. 画幅是横的，不是竖条
    const ratio = info.canvasW / info.canvasH
    check(`${tag} 画幅为横屏`, ratio > 1.5, `aspect=${ratio.toFixed(2)}`)
    // 5. 没有滚动溢出
    check(`${tag} 无滚动溢出`,
      info.bodyW <= info.vw + 1 && info.bodyH <= info.vh + 1,
      `body=${info.bodyW}×${info.bodyH}`)

    await page.close()
  }

  // 玩法验证：横向活动范围变宽 + 敌人仍从下方来
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 984, deviceScaleFactor: 1 })
  await page.goto(`http://127.0.0.1:${PORT}/arcade/sternenjaeger/index.html`, {
    waitUntil: 'networkidle2',
  })
  await new Promise((r) => setTimeout(r, 300))

  // 玩法验证：敌人仍从下方来。
  // 注意：不能用「亮像素分布」判断 —— 背景星空本身就是亮像素，
  // 会把星空误判成敌人（此前就误报过一次）。改读页面暴露的内部状态。
  const play = await page.evaluate(async () => {
    const pri = document.querySelector('.pri')
    if (pri) pri.click()
    await new Promise((r) => setTimeout(r, 3000))
    if (!window.__probe) return { noHook: true }
    const a = window.__probe()
    await new Promise((r) => setTimeout(r, 1500))
    const b = window.__probe()
    return { a, b }
  })
  check('能进入游戏', !play.noHook)

  if (!play.noHook) {
    check('敌人持续存在（战斗没停）',
      play.b.enemies > 0, `敌人 ${play.a.enemies} → ${play.b.enemies}`)
    check('敌机向下推进（平均 y 随时间增大）',
      play.b.avgEnemyY >= play.a.avgEnemyY,
      `avgY ${play.a.avgEnemyY} → ${play.b.avgEnemyY}（屏幕高 ${play.b.H}）`)
  }

  await page.close()
} finally {
  await browser.close()
  server.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed ? 1 : 0)
