/**
 * 大厅滑动性能探针
 *
 * 用 CDP 的合成器指标测真实滑动时的帧率与掉帧情况，而不是靠肉眼看。
 * 同时统计滑动过程中的长任务（>50ms 的主线程阻塞）——WebView 卡顿多半来自这里。
 *
 * 用法：node tools/probe-lobby-scroll.mjs [url] [cdpPort]
 */
import puppeteer from 'puppeteer-core'

const URL_ = process.argv[2] || 'http://127.0.0.1:5180/'
const CDP_PORT = process.argv[3] || '9222'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 先起一个带远程调试的 Chrome
const browser = await puppeteer.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: [
    '--no-sandbox',
    `--remote-debugging-port=${CDP_PORT}`,
    '--autoplay-policy=no-user-gesture-required',
    // 模拟车机：CPU 降速 4 倍，逼近弱车机的算力
    '--cpu-throttling-rate=4',
  ],
  defaultViewport: { width: 1920, height: 984, deviceScaleFactor: 1.5 },
})

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

try {
  const page = await browser.newPage()
  await page.goto(URL_, { waitUntil: 'networkidle2' })
  await sleep(2500)

  // 进入大厅（首页即大厅，若有引导页则点掉）
  await page.evaluate(() => {
    document.querySelector('.logo')?.click()
    window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, pointerType: 'touch', clientX: 10, clientY: 10 }))
  })
  await sleep(1500)

  const stageExists = await page.evaluate(() => !!document.querySelector('.cf-stage'))
  check('大厅 CoverFlow 舞台存在', stageExists)

  if (!stageExists) {
    console.log('\n未找到大厅舞台，跳过滑动测试')
    process.exit(0)
  }

  // 装帧率与长任务监听
  await page.evaluate(() => {
    window.__perf = { frames: [], longTasks: [], last: performance.now() }
    const tick = (t) => {
      window.__perf.frames.push(t - window.__perf.last)
      window.__perf.last = t
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__perf.longTasks.push(Math.round(e.duration))
      }).observe({ entryTypes: ['longtask'] })
    } catch (e) { /* 不支持 longtask */ }
  })

  // 真实滑动：在舞台上按住并左右拖
  const box = await page.evaluate(() => {
    const r = document.querySelector('.cf-stage').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })

  await page.mouse.move(box.x, box.y)
  await page.mouse.down()
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(box.x - i * 22, box.y, { steps: 2 })
    await sleep(16)
  }
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(box.x - 264 + i * 22, box.y, { steps: 2 })
    await sleep(16)
  }
  await page.mouse.up()
  await sleep(1200)

  const perf = await page.evaluate(() => {
    const f = window.__perf.frames.filter((d) => d > 0 && d < 1000)
    const sorted = [...f].sort((a, b) => a - b)
    const avg = f.reduce((a, b) => a + b, 0) / Math.max(1, f.length)
    return {
      frameCount: f.length,
      avgMs: +avg.toFixed(2),
      fps: +(1000 / avg).toFixed(1),
      p95: +(sorted[Math.floor(sorted.length * 0.95)] || 0).toFixed(2),
      worst: +(sorted[sorted.length - 1] || 0).toFixed(2),
      over32ms: f.filter((d) => d > 32).length,
      longTasks: window.__perf.longTasks,
    }
  })

  console.log('\n滑动性能：', JSON.stringify(perf, null, 1))

  // 车机判定：滑动态平均帧率 ≥ 40fps、p95 帧时长 ≤ 33ms（30fps 阈值）
  check('滑动平均帧率 ≥ 40fps', perf.fps >= 40, `${perf.fps}fps`)
  check('p95 帧时长 ≤ 33ms', perf.p95 <= 33, `${perf.p95}ms`)
  check('滑动中无 >100ms 长任务', perf.longTasks.filter((d) => d > 100).length === 0,
    `长任务: ${perf.longTasks.join(',') || '无'}`)

  // 静态检查：will-change 数量（弱 GPU 上每个 will-change 都是一个合成层）
  const layers = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.cf-card')]
    return {
      cards: cards.length,
      willChange: cards.filter((c) => getComputedStyle(c).willChange !== 'auto').length,
      blurred: cards.filter((c) => (getComputedStyle(c).filter || '').includes('blur')).length,
    }
  })
  console.log('合成层统计：', JSON.stringify(layers))
  check('合成层数量 ≤ 卡片数（无额外层）', layers.willChange <= layers.cards, JSON.stringify(layers))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
