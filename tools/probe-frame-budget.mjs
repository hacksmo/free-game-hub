/**
 * 大厅滑动性能门禁
 *
 * 锁住三件事，它们都是「车机滑动掉帧」这条线上真实存在过的缺陷：
 *
 *   1. 逐帧写自定义属性（--cf-shade）会让卡片遮罩层每帧重绘，并每帧重启它的
 *      opacity 过渡。改造前实测一次拖拽 1061 次 inline style 改写 / 367 次动画失效。
 *   2. 逐帧写 zIndex / pointerEvents 同样会造成无谓的样式失效。
 *   3. 降档调速器必须真的能把画面降下来：档 2 要去掉 3D 透视与阴影，
 *      否则「自动降档」只是改了个属性名，弱 GPU 上毫无收益。
 *
 * 用法：node tools/probe-frame-budget.mjs
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

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  · ${detail}` : ''}`)
}

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: CHROME,
  args: [
    '--no-sandbox', '--mute-audio', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required',
  ],
  defaultViewport: { width: 1920, height: 984, deviceScaleFactor: 1.5 },
})

try {
  const page = await browser.newPage()
  await page.goto(ORIGIN, { waitUntil: 'networkidle2', timeout: 45000 })
  await sleep(3000)

  const ready = await page.evaluate(() => ({
    stage: !!document.querySelector('.cf-stage'),
    cards: document.querySelectorAll('.cf-card').length,
    bridge: !!window.__carcadePerf,
  }))
  check('大厅舞台渲染完成', ready.stage && ready.cards > 0, `${ready.cards} 张卡`)
  check('帧预算桥已安装', ready.bridge)

  if (!ready.stage || !ready.bridge) throw new Error('前置条件不满足，无法继续')

  /* ---- 1. 降档阶梯：固定输入必须得到确定结果 ---- */
  const ladder = await page.evaluate(() => {
    const d = window.__carcadePerf.decide
    return {
      // 60Hz 完美帧 16.7ms：不该降档
      perfect: d(16.7, 0),
      // 轻微跟不上（85% 帧准时、15% 掉到 33ms）：保持
      jitter: d(18, 0),
      // 持续跟不上：降到 1
      lag: d(21, 0),
      // 已经很差但还在档 0：直接降 1（不是一步到 2，避免一刀切掉画面）
      bad: d(30, 0),
      // 档 1 仍撑不住：降到 2
      worse: d(30, 1),
      // 已到最低档：不再变化
      floor: d(60, 2),
    }
  })
  check('16.7ms 完美帧不降档', ladder.perfect === null, JSON.stringify(ladder.perfect))
  check('18ms 轻微抖动不降档', ladder.jitter === null)
  check('21ms 持续跟不上降到档 1', ladder.lag === 1)
  check('30ms 档 0 先降到档 1 而非直接砍到平面', ladder.bad === 1)
  check('30ms 档 1 继续降到档 2', ladder.worse === 2)
  check('档 2 为最低档，不再降', ladder.floor === null)

  /* ---- 2. 降档必须真的改变渲染路径 ----
     注意：box-shadow 有 0.3s 过渡，切档后必须等过渡走完再读计算样式，
     否则读到的是过渡起始值 —— 会误判成「降档没生效」。 */
  const readTier = async (t) => {
    await page.evaluate((tt) => window.__carcadePerf.setTier(tt), t)
    await sleep(450)
    return page.evaluate(() => {
      const st = getComputedStyle(document.querySelector('.cf-stage'))
      const center = document.querySelector('.cf-card--center .cf-card__face')
      const side = document.querySelector('.cf-card:not(.cf-card--center) .cf-card__face')
      const bg = document.querySelector('.cf-bg__img')
      return {
        perspective: st.perspective,
        centerShadow: center ? getComputedStyle(center).boxShadow : '',
        sideShadow: side ? getComputedStyle(side).boxShadow : '',
        bgDisplay: bg ? getComputedStyle(bg).display : 'none',
        attr: document.documentElement.getAttribute('data-cfq'),
      }
    })
  }

  const tier0 = await readTier(0)
  check('档 0 有 3D 透视', tier0.perspective !== 'none', tier0.perspective)
  check('档 0 有卡片阴影', tier0.sideShadow !== 'none', tier0.sideShadow.slice(0, 40))

  const tier1 = await readTier(1)
  check('档 1 阴影收窄（层面积减半）', tier1.sideShadow.includes('4px 12px'), tier1.sideShadow.slice(0, 40))

  const tier2 = await readTier(2)
  check('档 2 关掉 3D 透视', tier2.perspective === 'none', tier2.perspective)
  check('档 2 去掉侧卡阴影', tier2.sideShadow === 'none', tier2.sideShadow.slice(0, 40))
  check('档 2 去掉中央卡阴影', tier2.centerShadow === 'none', tier2.centerShadow.slice(0, 40))
  check('档 2 横幅背景退化为纯色', tier2.bgDisplay === 'none')
  check('档位写在 html[data-cfq] 上', tier2.attr === '2', String(tier2.attr))

  /* ---- 3. 拖拽期间只写合成器属性 ---- */
  await page.evaluate(() => {
    window.__carcadePerf.setTier(0)
    // 监测逐帧写入：自定义属性与布局属性都不该出现在拖拽循环里
    window.__writes = { shade: 0, zIndex: 0, pointerEvents: 0, transform: 0, opacity: 0 }
    const proto = CSSStyleDeclaration.prototype
    const origSet = proto.setProperty
    proto.setProperty = function (name, value, prio) {
      if (name === '--cf-shade') window.__writes.shade++
      return origSet.call(this, name, value, prio)
    }
    const desc = Object.getOwnPropertyDescriptor(proto, 'zIndex')
    if (desc && desc.set) {
      Object.defineProperty(proto, 'zIndex', {
        configurable: true,
        get: desc.get,
        set(v) { window.__writes.zIndex++; desc.set.call(this, v) },
      })
    }
    const dpe = Object.getOwnPropertyDescriptor(proto, 'pointerEvents')
    if (dpe && dpe.set) {
      Object.defineProperty(proto, 'pointerEvents', {
        configurable: true,
        get: dpe.get,
        set(v) { window.__writes.pointerEvents++; dpe.set.call(this, v) },
      })
    }
  })

  const box = await page.evaluate(() => {
    const r = document.querySelector('.cf-stage').getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await page.mouse.move(box.x + 400, box.y)
  await page.mouse.down()
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(box.x + 400 - i * 22, box.y)
    await sleep(12)
  }
  await page.mouse.up()
  await sleep(700)

  const writes = await page.evaluate(() => window.__writes)
  // 一次跨约 5 张卡的拖拽：遮罩按 0.25 档量化后每卡最多写 4 次
  check('拖拽期遮罩写入已量化（≤ 60 次）', writes.shade <= 60, `--cf-shade ${writes.shade} 次`)
  check('拖拽期 zIndex 只在跨卡时写（≤ 60 次）', writes.zIndex <= 60, `zIndex ${writes.zIndex} 次`)
  check('拖拽期 pointerEvents 只在进出视野时写（≤ 80 次）', writes.pointerEvents <= 80, `pointerEvents ${writes.pointerEvents} 次`)

  /* ---- 4. 平面档下 transform 里不该出现 rotateY ---- */
  await page.evaluate(() => {
    window.__carcadePerf.setTier(2)
    // 触发一次切卡，让 paint() 用平面档重写位姿
    document.querySelector('.cf-card--center .cf-start')?.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  })
  await sleep(600)
  const flatT = await page.evaluate(() => {
    const center = document.querySelector('.cf-card--center')
    const side = document.querySelector('.cf-card:not(.cf-card--center)')
    return { center: center ? center.style.transform : '', side: side ? side.style.transform : '' }
  })
  check('平面档中心卡 transform 不含 rotateY', !/rotateY/.test(flatT.center), flatT.center.slice(0, 70))
  check('平面档侧卡 transform 不含 rotateY', !/rotateY/.test(flatT.side), flatT.side.slice(0, 70))

  /* ---- 5. 降到平面档后，构图与可操作性不能塌 ----
     降档只允许减特效，不允许把中央卡或开始按钮弄没。 */
  const layout = await page.evaluate(() => {
    const vw = innerWidth
    const vh = innerHeight
    const center = document.querySelector('.cf-card--center')
    const start = document.querySelector('.cf-card--center .cf-start')
    const r = center ? center.getBoundingClientRect() : null
    return {
      cards: document.querySelectorAll('.cf-card').length,
      hasCenter: !!center,
      w: r ? Math.round(r.width) : 0,
      h: r ? Math.round(r.height) : 0,
      cx: r ? Math.round(r.x + r.width / 2) : 0,
      vw,
      vh,
      startVisible: !!start && start.getBoundingClientRect().width > 0,
    }
  })
  check('平面档仍渲染全部卡片', layout.cards > 0, `${layout.cards} 张`)
  check('平面档中央卡仍有尺寸', layout.w > 100 && layout.h > 150, `${layout.w}×${layout.h}`)
  check('平面档中央卡仍水平居中', Math.abs(layout.cx - layout.vw / 2) <= 4, `卡中心 ${layout.cx} / 视口 ${layout.vw}`)
  check('平面档开始按钮仍可点', layout.startVisible)

  /* ---- 6. 回归锁：短促一下滑动也必须采到帧 ----
     v1.22 真车报告里出现过「采样窗口 0 / 尚未采样」——原因是采样门槛
     （不足 12 帧直接丢弃）把证据本身关掉了。用户在车上往往就滑一两下，
     门槛必须低到「滑一下就有数字」。 */
  await page.evaluate(() => window.__carcadePerf.setTier(0))
  const w0 = await page.evaluate(() => window.__carcadePerf.info().windows)
  await page.mouse.move(box.x - 260, box.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x - 260 + i * 26, box.y)
    await sleep(14)
  }
  await page.mouse.up()
  await sleep(900)
  const perf = await page.evaluate(() => {
    const i = window.__carcadePerf.info()
    return {
      windows: i.windows, frames: i.frames, p50: i.p50, total: i.total,
      worst: i.worst, gpuClass: i.gpuClass, gpuAttr: document.documentElement.getAttribute('data-gpu'),
    }
  })
  check('短促滑动也产出帧数据（窗口数递增）', perf.windows > w0, `${w0} → ${perf.windows} 个窗口`)
  check('帧间隔有实际数值（p50 > 0）', perf.p50 > 0, `p50 ${perf.p50}ms / ${perf.frames} 帧`)
  check('累计采样帧数在增长', perf.total > 0, `${perf.total} 帧`)
  check('最差窗口被记录（供主观掉帧对照）', !!perf.worst && perf.worst.p90 > 0, JSON.stringify(perf.worst))
  check('GPU 类别写进 html[data-gpu]（决定合成策略）',
    ['hw', 'sw', 'unknown'].includes(String(perf.gpuAttr)), String(perf.gpuAttr))

  /* ---- 7. 档 2 必须关掉倒影（每帧最贵的一层）---- */
  const reflectOff = await page.evaluate(() => {
    document.documentElement.setAttribute('data-cfq', '2')
    const card = document.querySelector('.cf-card')
    const el = document.createElement('span')
    el.className = 'cf-card__reflect'
    card.appendChild(el)
    const off = getComputedStyle(el).display
    card.removeChild(el)
    document.documentElement.removeAttribute('data-cfq')
    return off
  })
  check('档 2 关掉倒影层', reflectOff === 'none', reflectOff)

  /* ---- 8. 音频链路：采集必须累积后再过桥（静态锁） ----
     旧实现每 128 帧就过桥一次（375 次/秒），主线程被切碎；
     现在 worklet 内累积到 2048 帧再发。这两个特征一旦被人改回去，这里会红。 */
  const shim = await readFile(join(here, '..', 'public', 'shim', 'audio-shim.js'), 'utf8')
  check('worklet 在音频线程累积后再发（cap ≥ 1024）', /this\.cap\s*=\s*(1024|2048|4096)/.test(shim))
  check('worklet 只在攒满时 postMessage', /this\.n\s*>=\s*this\.cap\)\s*this\.flush\(\)/.test(shim))
  check('媒体通道开关已废弃（固定关闭）', /mediaMode=false;\s*$|mediaMode=false;\n/.test(shim) && !/mediaMode=on/.test(shim))

  const relayKt = await readFile(
    join(here, '..', 'android', 'app', 'src', 'main', 'java', 'net', 'hackmo', 'carcade', 'CarAudioRelay.kt'),
    'utf8',
  )
  check('音频写入线程为 URGENT_AUDIO（防被主线程抢占）', /THREAD_PRIORITY_URGENT_AUDIO/.test(relayKt))
  check('按网页源采样率建轨（不再固定降采样）', /wantedRate/.test(relayKt) && /FALLBACK_RATE/.test(relayKt))
  check('报告输出欠载与延迟（下次不用再猜）', /underrunCount/.test(relayKt) && /latencyMs/.test(relayKt))

  /* ---- 9. 音频中转运行时实测：每块必须 ≥1024 采样 ----
     静态断言只能证明代码里写了「累积」，这里真的建一个 AudioContext、
     跑一段振荡器，数原生侧实际收到几块、每块多大、报的采样率是多少。 */
  const audioPage = await browser.newPage()
  const shimSrc = await readFile(join(here, '..', 'public', 'shim', 'audio-shim.js'), 'utf8')
  await audioPage.evaluateOnNewDocument(`
    window.__pushes = [];
    window.CARCADE_NATIVE = {
      relayPush: function (b64, count, rate) { window.__pushes.push({ count: count, rate: rate }); return true; },
      relayEnable: function () { return true; },
      relayState: function () { return '{"enabled":true}'; }
    };
    ${shimSrc}
  `)
  await audioPage.goto(ORIGIN, { waitUntil: 'networkidle2', timeout: 45000 })
  await sleep(1200)
  await audioPage.evaluate(() => {
    window.__carcadeAudio.setRelay(true)
    const ctx = new window.AudioContext()
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    g.gain.value = 0.25
    osc.frequency.value = 440
    osc.connect(g)
    g.connect(ctx.destination)
    osc.start()
    window.__testCtx = ctx
  })
  await sleep(2500)
  const audio = await audioPage.evaluate(() => {
    const p = window.__pushes || []
    const counts = p.slice(0, 80).map((x) => x.count)
    const avg = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0
    return {
      chunks: p.length,
      avg: Math.round(avg),
      min: counts.length ? Math.min(...counts) : 0,
      rate: p.length ? p[0].rate : 0,
      ctxRate: window.__testCtx ? window.__testCtx.sampleRate : 0,
      state: window.__testCtx ? window.__testCtx.state : 'none',
    }
  })
  check('PCM 中转真的在送数据', audio.chunks > 0, `${audio.chunks} 块 / 上下文 ${audio.state}`)
  check('每块 ≥1024 采样（过桥次数降到 1/8 以下）', audio.avg >= 1024, `平均 ${audio.avg} 采样/块（最小 ${audio.min}）`)
  check('上报的采样率等于 context 实际采样率', audio.rate === audio.ctxRate && audio.ctxRate > 0, `${audio.rate} vs ${audio.ctxRate}`)
  await audioPage.close()

  const summary = { total: results.length, passed: results.filter((r) => r.ok).length }
  console.log(`\n${summary.passed}/${summary.total} 通过`)
  if (summary.passed !== summary.total) {
    for (const r of results.filter((x) => !x.ok)) console.log(`  未通过：${r.name}`)
    process.exitCode = 1
  }
} catch (e) {
  console.error('门禁执行失败：', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
  server.close()
}