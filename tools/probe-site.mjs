/** 站点页面渲染检查：截图 + 断言关键元素存在、布局无横向溢出。 */
import puppeteer from 'puppeteer-core'

const BASE = process.env.SITE_URL || 'http://127.0.0.1:18733'
const OUT = process.env.SHOT_DIR || '/tmp/site-shots'

const browser = await puppeteer.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox'],
})

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

try {
  for (const [path, label] of [['/', 'zh'], ['/en/', 'en']]) {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
    await page.goto(BASE + path, { waitUntil: 'networkidle2' })

    // 关键元素
    // 图片加载失败的判定：naturalWidth 为 0 才是真失败。
    // （complete 在解码完成前可能是 false，不能拿它当失败依据 —— 会误报。）
    const info = await page.evaluate(() => ({
      title: document.title,
      h1: document.querySelector('h1')?.innerText || '',
      cards: document.querySelectorAll('.card').length,
      figures: document.querySelectorAll('figure img').length,
      imgsBroken: [...document.images].filter((i) => i.naturalWidth === 0).length,
      dlHref: document.getElementById('dl')?.getAttribute('href') || '',
      ver: document.getElementById('ver')?.textContent || '',
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    }))

    check(`${label} 有 h1`, info.h1.length > 0, JSON.stringify(info.h1.slice(0, 30)))
    check(`${label} 卡片齐全`, info.cards >= 3, `cards=${info.cards}`)
    check(`${label} 截图渲染成功`, info.imgsBroken === 0 && info.figures >= 2, `broken=${info.imgsBroken}`)
    check(`${label} 下载按钮指向 Release`, /releases/.test(info.dlHref), info.dlHref)
    check(`${label} 版本号已填`, info.ver.length > 0, info.ver)
    check(`${label} 无横向溢出`, !info.overflow)

    await page.screenshot({ path: `${OUT}/${label}-full.png`, fullPage: true })
    await page.screenshot({ path: `${OUT}/${label}-fold.png` })
    await page.close()
  }
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
