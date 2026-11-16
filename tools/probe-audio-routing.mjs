/**
 * 音频出口路由探针（v1.21）。
 *
 * 锁住三个曾经真实发生过的缺陷，它们都是「声音卡顿 / 开关点了没用」的根因：
 *   1. 关闭媒体通道后 ctx.destination 回不到原型访问器（声音彻底没了、切不回来）
 *   2. PCM 中转与媒体通道能同时生效（同一路声音两路输出 → 卡顿/拖音）
 *   3. 采样率用全局单值（多 context 速率不同 → 变调断续）
 *
 * 做法：加载 audio-shim.js，用 stub 的 CARCADE_NATIVE 截获 relayPush，
 * 检查每个 AudioContext 的 __ccRoute 与 destination 的真实类型。
 *
 * 用法：node tools/probe-audio-routing.mjs
 */
import puppeteer from 'puppeteer-core'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'

const here = dirname(fileURLToPath(import.meta.url))
const SHIM = readFileSync(join(here, '..', 'public', 'shim', 'audio-shim.js'), 'utf8')

/* 需要一个真实的 http 源：about:blank / setContent 下 localStorage 被禁，
   而 shim 的开关状态正是存在 localStorage 里的。 */
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}/`

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: [
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
  ],
})

try {
  const page = await browser.newPage()
  await page.goto(origin, { waitUntil: 'domcontentloaded' })

  // 桥的 stub：记录收到的 PCM，用来验证采样率与是否有数据
  await page.evaluate(() => {
    window.__relay = { calls: 0, bytes: 0, rates: new Set(), enables: [] }
    window.CARCADE_NATIVE = {
      relayPush(b64, count, rate) {
        window.__relay.calls++
        window.__relay.bytes += count
        window.__relay.rates.add(rate)
        return true
      },
      relayEnable(on) {
        window.__relay.enables.push(on)
        return true
      },
      relayState() {
        return 'stub'
      },
    }
  })

  await page.addScriptTag({ content: SHIM })
  await page.evaluate(() => localStorage.clear())

  // ---- 1. 默认：不改写 destination ----
  const def = await page.evaluate(async () => {
    const ctx = new AudioContext()
    const ok = ctx.destination instanceof AudioDestinationNode
    return { ok, route: ctx.__ccRoute || 'default', state: ctx.state }
  })
  check('默认不接管 destination', def.ok && def.route === 'default', `route=${def.route}`)

  // ---- 2. 开 PCM 中转：destination 换成增益节点，且真的往桥里送数据 ----
  const relay = await page.evaluate(async () => {
    const A = window.__carcadeAudio
    A.setRelay(true)
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    g.gain.value = 0.2
    osc.connect(g)
    g.connect(ctx.destination)
    osc.start()
    await new Promise((r) => setTimeout(r, 900))
    const out = {
      route: ctx.__ccRoute,
      isGain: ctx.destination instanceof GainNode,
      calls: window.__relay.calls,
      worklet: !!ctx.__ccWorklet,
      rate: ctx.sampleRate,
      rates: [...window.__relay.rates],
      enables: window.__relay.enables.slice(),
    }
    osc.stop()
    return out
  })
  check('开中转后 route=relay', relay.route === 'relay', `route=${relay.route}`)
  check('中转时 destination 是增益节点（透传不经主线程）', relay.isGain === true)
  check('中转真的送出了 PCM', relay.calls > 0, `${relay.calls} 块`)
  check(
    '采集跑在 AudioWorklet（音频线程，不受游戏主线程影响）',
    relay.worklet === true,
    relay.worklet ? 'AudioWorkletNode 已挂上' : '退化为 ScriptProcessor —— 卡顿未根治'
  )
  check(
    '采样率跟着 context 走（不是全局常量）',
    relay.rates.length === 1 && relay.rates[0] === relay.rate,
    `ctx=${relay.rate} 桥收到=${relay.rates.join(',')}`
  )
  check('开中转时通知原生启用播放端', relay.enables.includes(true), JSON.stringify(relay.enables))

  // ---- 3. 开媒体通道：必须自动关掉中转（互斥） ----
  const media = await page.evaluate(async () => {
    const A = window.__carcadeAudio
    A.setMode(true)
    const out = { relayOn: A.relayOn(), mode: A.mode(), enables: window.__relay.enables.slice() }
    return out
  })
  check('开媒体通道后中转被自动关闭', media.relayOn === false, `relayOn=${media.relayOn}`)
  check('模式互斥：不会同时为真', media.mode === 'media' && media.relayOn === false)
  check('关闭中转时通知原生停播放端', media.enables.includes(false), JSON.stringify(media.enables))

  // ---- 4. 关媒体通道：destination 必须回到原型访问器（关键回归） ----
  const off = await page.evaluate(async () => {
    const A = window.__carcadeAudio
    const before = A.routes()
    A.setMode(false)
    const after = A.routes()
    return { before, after }
  })
  const restored = off.after.every((r) => r.route === 'default')
  check(
    '关闭媒体通道后 destination 能恢复（不再永久指向已暂停的流）',
    restored,
    JSON.stringify(off.after)
  )
  check(
    '关闭后每个 context 都是 default 出口',
    off.after.every((r) => !r.media && !r.worklet && !r.script),
    JSON.stringify(off.after)
  )

  // ---- 5. 反复切换不留残留（旧版越点越坏） ----
  const cycle = await page.evaluate(async () => {
    const A = window.__carcadeAudio
    for (let i = 0; i < 3; i++) {
      A.setRelay(true)
      A.setMode(true)
      A.setRelay(true)
      A.setMode(false)
      A.setRelay(false)
    }
    return { routes: A.routes(), relay: A.relayOn(), mode: A.mode() }
  })
  check(
    '反复切换后无残留路由',
    cycle.routes.every((r) => r.route === 'default') && !cycle.relay && cycle.mode === 'off',
    `relay=${cycle.relay} mode=${cycle.mode}`
  )

  // ---- 6. 两个开关在任意顺序下都不同时为真 ----
  const excl = await page.evaluate(async () => {
    const A = window.__carcadeAudio
    const seq = []
    A.setRelay(true); seq.push([A.relayOn(), A.mode()])
    A.setMode(true); seq.push([A.relayOn(), A.mode()])
    A.setRelay(true); seq.push([A.relayOn(), A.mode()])
    A.setMode(true); seq.push([A.relayOn(), A.mode()])
    return seq
  })
  check(
    '任意切换顺序下两者不同时为真',
    excl.every(([r, m]) => !(r && m === 'media')),
    JSON.stringify(excl)
  )
} finally {
  await browser.close()
  server.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.name).join('; '))
  process.exit(1)
}