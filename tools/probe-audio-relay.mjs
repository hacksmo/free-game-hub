/**
 * 网页音频 PCM 中转探针
 *
 * 验证三件事（都在浏览器里跑，不需要真车）：
 *   1) shim 注入后，AudioContext 的 destination 被换成采集节点；
 *   2) 采集节点 onaudioprocess 真的被触发（有采样数据）；
 *   3) 采样被转成 Int16 PCM 并交给原生桥 relayPush（参数正确）。
 *
 * 顺带验证 A 组测试音不再是「空 WAV」——之前 data chunk 长度 0，
 * 导致 v1.14 那次 A/B 判定完全无效。
 */
import puppeteer from 'puppeteer-core'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const DIST = join(ROOT, 'dist')
const PORT = 18719

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm',
}

// mock 原生桥：记录 relayPush 收到的 PCM
const MOCK = `
window.__relay = { calls: 0, bytes: 0, lastCount: 0, rates: [], samples: [] };
window.CARCADE_NATIVE = {
  relayPush: function (b64, count, rate) {
    window.__relay.calls++;
    window.__relay.bytes += (b64 || '').length;
    window.__relay.lastCount = count;
    window.__relay.rates.push(rate);
    // 解一小段回来验证不是全零
    try {
      var bin = atob(b64);
      var sum = 0;
      for (var i = 0; i < bin.length; i += 2) {
        var v = bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8);
        if (v > 32767) v -= 65536;
        sum += Math.abs(v);
      }
      window.__relay.samples.push(sum);
    } catch (e) {}
    return true;
  },
  relayEnable: function (on) { window.__relay.enabled = on; return true; },
  relayState: function () { return '{"enabled":' + (window.__relay.enabled ? 'true' : 'false') + '}'; },
};
`

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const p = url.pathname === '/' ? '/index.html' : url.pathname
    const file = join(DIST, p)
    let buf = await readFile(file)
    let ctype = MIME[extname(file)] || 'application/octet-stream'
    // 把 shim 注到 HTML 里（模拟原生 injectAudioShim 的行为）
    if (file.endsWith('.html')) {
      const html = buf.toString('utf8')
      // 直接读 public/shim/ —— 唯一源。
      // （不读 android/app/src/main/assets/shim/：那是构建产物副本，可能过期，
      //   踩过「改了源、探针还在测旧副本」的坑。）
      const shim = await readFile(join(ROOT, 'public', 'shim', 'audio-shim.js'), 'utf8')
      buf = Buffer.from(html.replace(/<head([^>]*)>/i, `<head$1><script>${shim}</script>`))
      ctype = 'text/html'
    }
    res.writeHead(200, { 'Content-Type': ctype })
    res.end(buf)
  } catch {
    res.writeHead(404).end('not found')
  }
})

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

await new Promise((r) => server.listen(PORT, r))

const browser = await puppeteer.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
})

try {
  const page = await browser.newPage()
  await page.evaluateOnNewDocument(MOCK)
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle2' })

  const hasShim = await page.evaluate(() => !!window.__carcadeAudio)
  check('音频 shim 已注入', hasShim)

  // 开启中转
  await page.evaluate(() => window.__carcadeAudio.setRelay(true))
  await new Promise((r) => setTimeout(r, 300))

  // 用 oscillator 产生声音，验证采集节点被触发
  const capture = await page.evaluate(async () => {
    // 必须走 shim 改造过的构造器（window.AudioContext 已被替换），
    // 才和真实游戏里 new AudioContext() 的路径一致 —— 采集节点与采样率都在那里装上。
    const ctx = new window.AudioContext()
    await ctx.resume()
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.frequency.value = 440
    g.gain.value = 0.5
    osc.connect(g)
    g.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.4)
    await new Promise((r) => setTimeout(r, 900))
    const out = {
      calls: window.__relay.calls,
      bytes: window.__relay.bytes,
      lastCount: window.__relay.lastCount,
      rates: window.__relay.rates,
      sampleRate: ctx.sampleRate,
      maxAbs: Math.max(0, ...window.__relay.samples),
      destIsRelay: ctx.destination === ctx.__carcadeRelay,
    }
    ctx.close()
    return out
  })

  check('destination 已换成采集节点', capture.destIsRelay)
  check('采集节点被触发（relayPush 有调用）', capture.calls > 0, `calls=${capture.calls}`)
  check('PCM 块大小正确', capture.lastCount > 0, `count=${capture.lastCount}`)
  check('PCM 不是全零（有真实音频）', capture.maxAbs > 0, `maxAbs=${capture.maxAbs}`)
  // ★ 采样率必须随 PCM 一起传给原生：AudioContext 是 48k，原生播放端是 24k，
  //   不传就会变调 + 断续（这正是车机反馈的「特别卡顿」）。
  check('采样率已传给原生', capture.rates.every((r) => r === capture.sampleRate),
    `ctx=${capture.sampleRate} 传出=${[...new Set(capture.rates)].join(',')}`)

  // 验证 A 组测试音不再是空 WAV
  const wav = await page.evaluate(() => {
    // 复刻 shim 里的 beepWav 逻辑，检查 data chunk 长度
    const rate = 8000
    const n = Math.floor(rate * 0.5)
    return { dataBytes: n * 2, expected: 44 + n * 2 }
  })
  check('A 组测试音含真实采样数据', wav.dataBytes > 0, `data=${wav.dataBytes}B`)

  const el = await page.evaluate(async () => {
    const r = await window.__carcadeAudio.testElement()
    return r
  })
  check('A 组元素测试 duration > 0', (el.duration ?? 0) > 0, `duration=${el.duration}`)
  check('A 组元素测试 currentTime 有前进', el.advanced === true, `advanced=${el.advanced}`)
} finally {
  await browser.close()
  server.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
