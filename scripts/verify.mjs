import { chromium } from 'playwright'

const ROUTES = [
  ['/dashboard', '工作台'],
  ['/project/new', '新建项目'],
  ['/project/proj-aicoding-agent/papers', '文献库'],
  ['/project/proj-aicoding-agent/papers/P001', '论文详情'],
  ['/project/proj-aicoding-agent/analysis', '智能分析'],
  ['/project/proj-aicoding-agent/methods', '方法地图'],
  ['/project/proj-aicoding-agent/methods?focus=M010', '方法地图-聚焦'],
  ['/project/proj-aicoding-agent/evolution', '技术演进'],
  ['/project/proj-aicoding-agent/gaps?focus=G001', '研究空白-展开'],
  ['/project/proj-aicoding-agent/directions', '研究方向'],
  ['/project/proj-aicoding-agent/report', '调研报告'],
  ['/definitely-not-a-page', '404'],
]

const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 1560, height: 1000 } })

const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`))

const results = []
for (const [route, label] of ROUTES) {
  errors.length = 0
  await page.goto(`http://localhost:5173${route}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)

  const text = await page.textContent('body')
  const hasRoot = await page.locator('#root > *').count()
  const navCount = await page.locator('aside a').count()
  const realErrors = errors.filter(
    (e) => !e.includes('favicon') && !e.includes('Download the React DevTools'),
  )

  results.push({
    route,
    label,
    rendered: text.length > 200,
    chars: text.length,
    navCount,
    hasRoot: hasRoot > 0,
    errors: realErrors.slice(0, 3),
  })
  await page.screenshot({ path: `/tmp/shots${route.replace(/[/?=]/g, '_')}.png`, fullPage: false })
}

console.log(JSON.stringify(results, null, 2))
await browser.close()
