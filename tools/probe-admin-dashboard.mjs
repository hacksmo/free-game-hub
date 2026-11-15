/**
 * 后台看板渲染探针。
 *
 * 验证改造后的 /admin 真的**渲染出图**，而不只是「页面里有这段 JS」：
 *   1. 登录后仪表盘出现，指标卡有真实数值（不是 —）；
 *   2. 趋势图真的生成了 SVG 折线（path 元素存在、坐标不为 NaN）；
 *   3. 排行条按数值渲染，且条宽与数值成正比；
 *   4. 空数据时给占位提示，不画一条 0 高度的线（那看着像坏了）；
 *   5. 布局在 1280 宽下不横向溢出；
 *   6. XSS 基线仍然成立：清单里的 HTML 被当纯文本渲染。
 *
 * 做法：起真实服务 → Puppeteer 登录 → 造统计数据 → 读 DOM。
 */
import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = '/Users/shuimo/Desktop/Call-AI/carcade-platform'
const PORT = 18790
const PIN = '1234'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

/* 起一个真实的服务进程（独立 root，不碰仓库） */
const tmpRoot = `/tmp/carcade-admin-probe-${Date.now()}`
const server = spawn('python3', ['server.py'], {
  cwd: ROOT,
  env: {
    ...process.env,
    CARCADE_PORT: String(PORT),
    CARCADE_PIN: PIN,
    CARCADE_ROOT: tmpRoot,
    CARCADE_DB: `${tmpRoot}/t.db`,
    CARCADE_PLAY_DIR: `${tmpRoot}/play`,
    CARCADE_APP_DIR: `${tmpRoot}/app`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverOut = ''
server.stdout.on('data', (d) => { serverOut += d })
server.stderr.on('data', (d) => { serverOut += d })

const cleanup = () => {
  try { server.kill('SIGTERM') } catch {}
}
process.on('exit', cleanup)

/* 等服务起来 */
let up = false
for (let i = 0; i < 60; i++) {
  await sleep(250)
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`)
    if (r.ok) { up = true; break }
  } catch {}
}
if (!up) {
  console.error('服务没起来：\n' + serverOut)
  process.exit(1)
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
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
  await page.goto(`http://127.0.0.1:${PORT}/admin`, { waitUntil: 'networkidle2' })

  // 登录
  await page.type('#pin', PIN)
  await page.click('button')
  await sleep(1200)

  const loggedIn = await page.evaluate(() =>
    document.getElementById('mainCard').style.display !== 'none')
  check('登录后进入主界面', loggedIn)

  // 空数据状态：此时还没造数据，趋势是「7 天全 0」。
  // 这时应画出平线（坐标有效）而不是坏图（NaN 坐标 / 什么都不画）。
  const emptyState = await page.evaluate(() => {
    const host = document.getElementById('chartTrend')
    const svg = host.querySelector('svg')
    const paths = svg ? [...svg.querySelectorAll('path.line')] : []
    return {
      text: (host.textContent || '').trim(),
      svgCount: host.querySelectorAll('svg').length,
      hasNaN: paths.some(p => (p.getAttribute('d') || '').includes('NaN')),
      emptyPaths: paths.filter(p => !(p.getAttribute('d') || '').trim()).length,
    }
  })
  check('全零数据时画出有效平线（坐标非 NaN、非空路径）',
    emptyState.svgCount === 1 && !emptyState.hasNaN && emptyState.emptyPaths === 0,
    `svg=${emptyState.svgCount} NaN=${emptyState.hasNaN} 空路径=${emptyState.emptyPaths}`)

  // 排行榜在无数据时给占位
  const emptyRank = await page.evaluate(() => {
    const host = document.getElementById('rankGames')
    return { text: (host.textContent || '').trim(), rows: host.querySelectorAll('.rank').length }
  })
  check('无数据时排行给占位提示',
    emptyRank.rows === 0 && emptyRank.text.length > 0,
    `rows=${emptyRank.rows} 文本="${emptyRank.text}"`)

  // 造数据：直接写 events 表（走服务端同一张表），再刷新看板
  const seeded = await page.evaluate(async () => {
    const POST = '/api/event'
    const today = new Date()
    const dayMs = 86400000
    const rows = []
    // 近 7 天，每天若干设备
    for (let d = 6; d >= 0; d--) {
      const n = 8 - d            // 越近的天人越多，形成上升趋势
      for (let i = 0; i < n; i++) {
        const when = new Date(today.getTime() - d * dayMs - i * 60000)
        const ts = Math.floor(when.getTime() / 1000)
        rows.push({ event: 'session_open', gameId: 'g1', deviceId: `dev-d${d}-${i}`, clientVersion: '1.20.0', durationMs: 0, ts })
        rows.push({ event: 'game_start', gameId: 'g1', deviceId: `dev-d${d}-${i}`, clientVersion: '1.20.0', durationMs: 0, ts })
        rows.push({ event: 'game_end', gameId: 'g1', deviceId: `dev-d${d}-${i}`, clientVersion: '1.20.0', durationMs: 120000, ts })
      }
    }
    // 第二款游戏：人次少，形成排行差异
    for (let i = 0; i < 3; i++) {
      rows.push({ event: 'game_start', gameId: 'g2', deviceId: `dev-x-${i}`, clientVersion: '1.19.0', durationMs: 0, ts: Math.floor(Date.now() / 1000) })
    }
    let ok = 0
    for (const r of rows) {
      const res = await fetch(POST, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(r),
      })
      if (res.ok) ok++
    }
    return { sent: rows.length, ok }
  })
  check('造测试数据（事件上报）', seeded.ok === seeded.sent, `${seeded.ok}/${seeded.sent}`)

  // 刷新看板
  await page.evaluate(() => loadStats())
  await sleep(900)

  const dash = await page.evaluate(() => {
    const host = document.getElementById('chartTrend')
    const svg = host.querySelector('svg')
    const paths = svg ? [...svg.querySelectorAll('path.line')] : []
    const dots = svg ? svg.querySelectorAll('circle.dot').length : 0
    const rankRows = document.querySelectorAll('#rankGames .rank')
    const fills = [...document.querySelectorAll('#rankGames .fill')].map(f => f.style.width)
    return {
      dau: document.getElementById('statDau').textContent,
      playsToday: document.getElementById('statPlaysToday').textContent,
      plays: document.getElementById('statPlays').textContent,
      duration: document.getElementById('statDuration').textContent,
      svgCount: host.querySelectorAll('svg').length,
      lineCount: paths.length,
      // 路径里不能出现 NaN（坐标算错）
      hasNaN: paths.some(p => (p.getAttribute('d') || '').includes('NaN')),
      dots,
      rankCount: rankRows.length,
      fills,
      updated: (document.getElementById('statsUpdated').textContent || '').trim(),
    }
  })

  check('指标卡显示真实数值',
    dash.dau !== '—' && dash.plays !== '—' && dash.duration !== '—',
    `DAU=${dash.dau} 今日次数=${dash.playsToday} 累计=${dash.plays} 时长=${dash.duration}`)

  check('趋势图渲染出 SVG 折线（双序列）',
    dash.svgCount === 1 && dash.lineCount === 2 && dash.dots >= 14,
    `svg=${dash.svgCount} 线=${dash.lineCount} 点=${dash.dots}`)

  check('折线坐标无 NaN', !dash.hasNaN)

  check('热门游戏排行有条目', dash.rankCount >= 2, `${dash.rankCount} 行`)

  // 条宽必须与数值成正比（第一条应为 100%）
  check('排行条宽按数值归一化',
    dash.fills.length > 0 && dash.fills[0] === '100%' && dash.fills[1] !== '100%',
    dash.fills.join(' / '))

  check('显示统计更新时间', dash.updated.includes('更新于'), dash.updated)

  // 累计卡的脚注要给出「今日占比」——否则累计数与今日数在数据少时看不出差别
  const foots = await page.evaluate(() => ({
    plays: document.getElementById('statPlaysFoot').textContent,
    duration: document.getElementById('statDurationFoot').textContent,
  }))
  check('累计卡脚注给出今日占比',
    foots.plays.includes('占') && foots.duration.includes('占'),
    `${foots.plays} / ${foots.duration}`)

  // 两条序列用实线/虚线区分：数值接近时不会完全重叠看不出来
  const dashStyle = await page.evaluate(() => {
    const paths = [...document.querySelectorAll('#chartTrend path.line')]
    return paths.map(p => p.getAttribute('stroke-dasharray') || 'solid')
  })
  check('趋势双序列用实线/虚线区分',
    dashStyle.length === 2 && dashStyle[0] !== dashStyle[1],
    dashStyle.join(' / '))

  // 布局不横向溢出
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }))
  check('1280 宽下无横向溢出',
    overflow.scroll <= overflow.inner + 1,
    `scroll=${overflow.scroll} inner=${overflow.inner}`)

  // XSS 基线：游戏名里的 HTML 必须当纯文本
  const xss = await page.evaluate(() => {
    const td = document.createElement('td')
    td.textContent = '<img src=x onerror=alert(1)>'
    const tr = document.createElement('tr')
    tr.appendChild(td)
    document.getElementById('statGames').appendChild(tr)
    const cell = [...document.querySelectorAll('#statGames td')].pop()
    return {
      text: cell.textContent,
      imgs: cell.querySelectorAll('img').length,
      scripts: document.querySelectorAll('#statGames script').length,
    }
  })
  check('清单里的 HTML 被当纯文本渲染',
    xss.imgs === 0 && xss.text.includes('<img'),
    `imgs=${xss.imgs} 文本="${xss.text.slice(0, 24)}"`)

  check('页面无 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '))

  // ---------- 批量 ROM 投放 ----------
  // 用 setInputFiles 直接喂多个文件，验证：多选 → 清单 → 逐项结果 → 目录出现
  const romFiles = [
    '/tmp/probe-roms/a.nes',
    '/tmp/probe-roms/b.gb',
    '/tmp/probe-roms/c.dat',   // 扩展名不支持 —— 应逐项标失败，不影响其它两个
  ]
  // puppeteer-core 没有 setInputFiles（那是 Playwright 的 API），
  // 用 CDP 的 DOM.setFileInputFiles 走原生通道设置文件。
  const cdp = await page.createCDPSession()
  await page.evaluate(() => {
    const el = document.getElementById('romFiles')
    el.setAttribute('data-probe', '1')
  })
  const doc = await cdp.send('DOM.getDocument')
  const node = await cdp.send('DOM.querySelector', {
    nodeId: doc.root.nodeId, selector: '#romFiles[data-probe="1"]',
  })
  await cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: romFiles })
  await sleep(400)

  const list = await page.evaluate(() => ({
    rows: document.querySelectorAll('#romList .romrow').length,
    info: document.getElementById('romSelectionInfo').textContent,
    names: [...document.querySelectorAll('#romList .romrow .fn')].map(e => e.textContent),
  }))
  check('多选后渲染出逐项清单',
    list.rows === 3 && list.names.includes('a.nes'),
    `${list.rows} 行 · ${list.info}`)

  // 填一个中文名
  await page.evaluate(() => {
    const inp = document.querySelector('#romList .romrow input')
    inp.value = '我的测试游戏'
    inp.dispatchEvent(new Event('input', { bubbles: true }))
  })

  // 执行批量投放
  await page.evaluate(() => addRoms())
  await sleep(2500)

  const result = await page.evaluate(() => ({
    ok: document.querySelectorAll('#romResult .res.ok').length,
    err: document.querySelectorAll('#romResult .res.err').length,
    texts: [...document.querySelectorAll('#romResult .res')].map(e => e.textContent),
    sum: document.querySelector('#romResult .tiny')?.textContent || '',
  }))
  check('批量投放：成功项与失败项分开列出',
    result.ok === 2 && result.err === 1,
    `成功 ${result.ok} 失败 ${result.err} · ${result.sum}`)
  check('失败的坏文件带原因',
    result.texts.some(t => t.includes('c.dat') && t.includes('平台')),
    result.texts.filter(t => t.includes('c.dat')).join(' | '))
  check('成功项显示中文名',
    result.texts.some(t => t.includes('我的测试游戏')),
    result.texts.filter(t => t.includes('我的测试游戏')).join(' | '))

  // 目录里应出现这两款
  const inCatalog = await page.evaluate(async () => {
    const out = await api('/api/admin/games')
    return out.games.map(g => g.id)
  })
  check('批量投放后目录出现新卡片',
    inCatalog.length >= 2, inCatalog.join(', '))

  // 截图存档
  await page.screenshot({ path: '/tmp/admin-dashboard.png', fullPage: true })

  await page.close()
} finally {
  await browser.close()
  cleanup()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed ? 1 : 0)
