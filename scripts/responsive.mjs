import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox','--disable-dev-shm-usage'] })
const errs = []
for (const [w, h, tag] of [[1440, 900, 'lg'], [1024, 800, 'md'], [390, 844, 'sm']]) {
  const p = await b.newPage({ viewport: { width: w, height: h } })
  p.on('pageerror', e => errs.push(`${tag}: ${e.message}`))
  for (const [r, n] of [['/dashboard','dash'],['/project/proj-aicoding-agent/methods','methods'],['/project/proj-aicoding-agent/directions','dirs']]) {
    await p.goto('http://localhost:5173' + r, { waitUntil: 'networkidle' })
    await p.waitForTimeout(600)
    // 检测横向溢出
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if (overflow > 4) errs.push(`${tag} ${n}: 横向溢出 ${overflow}px`)
    if (tag === 'sm') await p.screenshot({ path: `/tmp/m_${n}.png`, fullPage: false })
  }
  await p.close()
}
console.log(errs.length ? errs.join('\n') : '✓ 各断点无横向溢出，无运行时错误')
await b.close()
