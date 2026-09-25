import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox','--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
const shots = [
  ['/dashboard', 'dash'],
  ['/project/proj-aicoding-agent/methods', 'methods'],
  ['/project/proj-aicoding-agent/evolution', 'evo'],
  ['/project/proj-aicoding-agent/gaps', 'gaps'],
  ['/project/proj-aicoding-agent/directions', 'dirs'],
  ['/project/proj-aicoding-agent/report', 'report'],
  ['/project/proj-aicoding-agent/analysis', 'analysis'],
  ['/project/proj-aicoding-agent/papers', 'papers'],
]
for (const [r, n] of shots) {
  await p.goto('http://localhost:5173' + r, { waitUntil: 'networkidle' })
  await p.waitForTimeout(900)
  await p.screenshot({ path: `/tmp/f_${n}.png` })
}
console.log('✓ 桌面端截图完成')
await b.close()
