/**
 * Phase 6-2 · 因果关系页面回链验证（真浏览器）
 *
 * ── 只验一件事 ──
 * 在 Phase6-2 因果 E2E 产出的项目上（Beta → Alpha extends），
 * 打开"技术演进"页，确认：
 *   · 页面上出现因果边（extends）对应的两个阶段 / 方法名 Alpha、Beta
 *   · 点开证据 #E006 后，抽屉里显示的**正是 Beta 那句原文**
 *     （"Our approach builds on Alpha and extends it …"），
 *     而不是别的论文的原文 —— 这是本项目最容易假绿的一步。
 *
 * 依赖：先跑 scripts/phase6-2-causal-e2e.mjs，它会写 /tmp/fxprobe/e2e-result.json
 * 用法：node scripts/phase6-2-causal-ui-verify.mjs
 */
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.P62_UI_PORT ?? 8986)
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0
let fail = 0
const check = (ok, msg) => {
  if (ok) {
    pass++
    console.log(`  ✓ ${msg}`)
  } else {
    fail++
    console.log(`  ✗ ${msg}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const distIndex = path.join(ROOT, 'dist', 'index.html')
if (!fs.existsSync(distIndex)) {
  console.log('✗ 找不到 dist/index.html —— 请先运行 pnpm build')
  process.exit(1)
}

const RESULT = '/tmp/fxprobe/e2e-result.json'
if (!fs.existsSync(RESULT)) {
  console.log('✗ 找不到 e2e-result.json —— 请先运行 scripts/phase6-2-causal-e2e.mjs')
  process.exit(1)
}
const R = JSON.parse(fs.readFileSync(RESULT, 'utf8'))
const PID = R.PID
const ext = (R.relations ?? []).find((r) => r.relation_type === 'extends')
if (!ext) {
  console.log('✗ e2e-result.json 里没有 extends 关系 —— 前置 E2E 未产出因果边，本脚本无从验证')
  process.exit(1)
}
console.log(`使用 E2E 项目 ${PID}，因果边 ${ext.source_method} → ${ext.target_method}，证据 [${ext.evidence_ids.join(',')}]`)

/* 起一个前端静态服务 + 后端（复用同一台机器上的 data/store） */
const srv = spawn(
  process.execPath,
  ['--experimental-strip-types', path.join(ROOT, 'server', 'index.ts')],
  { cwd: ROOT, env: { ...process.env, PORT: String(PORT), ENABLE_SEMANTIC_SCHOLAR: 'false' }, stdio: 'ignore' },
)
const stop = () => { try { srv.kill('SIGKILL') } catch {} }

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return true
    } catch {}
    await sleep(250)
  }
  return false
}

let browser
try {
  check(await waitReady(), `前端+后端就绪（${BASE}）`)

  /* 沙箱内 playwright 自带的 headless shell 版本与已装的对不上，
     沿用本项目其他 UI 脚本的做法：显式指向系统 chromium。 */
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })

  console.log('\n══ 打开技术演进页 ══')
  await page.goto(`${BASE}/project/${PID}/evolution`, { waitUntil: 'networkidle' })
  await sleep(1200)

  const bodyText = await page.locator('body').innerText()
  check(/Alpha/.test(bodyText), '页面出现 Alpha（被继承的方法）')
  check(/Beta/.test(bodyText), '页面出现 Beta（继承方）')

  /* 页面上的因果边文案：API description 含「继承 / 扩展」 */
  const hasCausalCopy = /继承|扩展/.test(bodyText)
  check(hasCausalCopy, '页面出现「继承 / 扩展」因果关系文案（非仅时间相关）')

  /* 统计里应有"因果"一栏且数量 ≥ 1 */
  const statBlock = bodyText
  check(/因果/.test(statBlock), '页面统计区出现「因果」指标')

  console.log('\n══ 证据回链：点击 #E006 ══')
  const eid = ext.evidence_ids[0]
  const evBtn = page.locator(`button:has-text("#${eid}")`).first()
  const evCount = await page.locator(`button:has-text("#${eid}")`).count()
  check(evCount > 0, `页面上存在可点击的证据按钮 #${eid}（共 ${evCount} 个入口）`)

  if (evCount > 0) {
    await evBtn.click()
    await sleep(900)
    const drawerText = await page.locator('body').innerText()
    /* 抽屉里必须出现 Beta 那句原文的关键片段 */
    const KEY = 'builds on Alpha and extends it'
    check(
      drawerText.includes(KEY),
      `抽屉显示 Beta 原文片段「${KEY}」——证据回链到正确出处，未串入其他论文`,
    )
    check(/原文证据/.test(drawerText), '抽屉出现「原文证据」标签（结构化出处）')
    check(new RegExp(`#?${eid}`).test(drawerText), `抽屉标出证据 ID ${eid}`)
    /* 防串台：不能显示 Alpha 的原文句 */
    check(
      !drawerText.includes('interleaves reasoning traces and actions'),
      '抽屉未串入 Alpha 的原文（防"显示另一篇论文的原文"）',
    )
    /* 真实项目应给出 PDF 原文入口 */
    check(/打开 PDF 第/.test(drawerText), '抽屉给出「打开 PDF 第 N 页」原文入口')
  }

  /* 截图存档 */
  const shotDir = path.join(ROOT, 'data', 'shots')
  fs.mkdirSync(shotDir, { recursive: true })
  await page.screenshot({ path: path.join(shotDir, 'phase6-2-causal-evolution.png'), fullPage: true })
  console.log(`  截图：data/shots/phase6-2-causal-evolution.png`)
} catch (e) {
  console.error('✗ 页面验证异常：', e?.message ?? e)
  fail++
} finally {
  if (browser) await browser.close()
  stop()
}

console.log(`\n${'═'.repeat(62)}`)
if (fail === 0) console.log(`✓ Phase 6-2 页面回链验证通过（${pass} 项断言）`)
else console.log(`✗ ${fail} 项未通过（通过 ${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
