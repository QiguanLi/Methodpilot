/**
 * 侧边栏统计一致性测试（Live / Demo 不串数据）。
 *
 * ── 这个测试要抓的 bug ──
 *
 * 侧边栏挂在 `<Routes>` 之外，早期实现直接读了 `selectors.stats` ——
 * 那是 **Demo 知识库的静态常量**（18 论文 / 19 方法 / 5 空白 / 3 方向 / 38 证据）。
 * 于是打开任何真实项目，侧栏都显示演示库数字，
 * 而「研究方向」页面正文显示的是该项目真实的 1 个方向 —— 同屏自相矛盾。
 *
 * ── 断言策略 ──
 *
 *   Live 项目：侧栏数字必须**等于接口返回的真实数量**
 *   Demo 项目：侧栏数字必须**等于 Demo 静态值**（保持现状不变）
 *   交叉断言：Live 的数字**不得**等于 Demo 的值（反向排除串数据）
 *
 * 夹具刻意让 Live 的每个数字都与 Demo 不同且互不相同
 * （论文 2 / 方法 3 / 证据 4 / 空白 1 / 方向 1），
 * 这样任何一个位置串了数据都能立刻定位。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.SIDEBAR_UI_PORT ?? 8987)
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`)
  }
}
const section = (t) => console.log(`\n${t}`)

const distIndex = path.join(ROOT, 'dist', 'index.html')
if (!existsSync(distIndex)) {
  console.log('✗ 找不到 dist/index.html —— 请先运行 pnpm build')
  process.exit(1)
}

const storeDir = mkdtempSync(path.join(tmpdir(), 'mpsb-'))
const uploadDir = mkdtempSync(path.join(tmpdir(), 'mpsb-up-'))

const srv = spawn(
  process.execPath,
  ['--experimental-strip-types', path.join(ROOT, 'server', 'index.ts')],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: storeDir,
      UPLOAD_DIR: uploadDir,
      ENABLE_SEMANTIC_SCHOLAR: 'false',
    },
    stdio: 'ignore',
  },
)

const stop = () => {
  try {
    srv.kill('SIGKILL')
  } catch {}
  for (const d of [storeDir, uploadDir]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return true
    } catch {}
    await sleep(250)
  }
  return false
}

/* ------------------------------------------------------------------ */
/* 夹具：刻意让数量与 Demo 全不相同                                      */
/* ------------------------------------------------------------------ */

const PROJECTS = path.join(storeDir, 'projects')

function writeProject({ id, name, papers, methods, evidence }) {
  const dir = path.join(PROJECTS, id)
  mkdirSync(dir, { recursive: true })
  const now = '2025-01-01T00:00:00.000Z'

  const fullPapers = papers.map((p) => ({
    paper_id: p.paper_id,
    project_id: id,
    title: p.title ?? p.paper_id,
    authors: [],
    year: p.year ?? 2024,
    abstract: '',
    keywords: [],
    sections: [],
    file_name: `${p.paper_id}.pdf`,
    file_hash: `h:${p.paper_id}`,
    file_size: 0,
    page_count: 10,
    status: 'completed',
    error: null,
    source_type: 'live',
    analyzed_with: null,
    method_ids: methods.filter((m) => m.paper_ids.includes(p.paper_id)).map((m) => m.method_id),
    evidence_count: evidence.filter((e) => e.paper_id === p.paper_id).length,
    created_at: now,
    updated_at: now,
  }))

  const fullMethods = methods.map((m) => ({
    method_id: m.method_id,
    project_id: id,
    name: m.name,
    name_zh: m.name_zh ?? '',
    family_id: '',
    task: m.task ?? '',
    paradigm: '',
    year: m.year ?? 0,
    core_idea: m.core_idea ?? '',
    modules: [],
    inputs: [],
    outputs: [],
    capabilities: [],
    advantages: [],
    limitations: [],
    paper_ids: m.paper_ids,
    evidence_ids: m.evidence_ids ?? [],
    layer: 0,
    source_type: 'live',
    classification: null,
  }))

  const fullEvidence = evidence.map((e) => ({
    evidence_id: e.evidence_id,
    paper_id: e.paper_id,
    project_id: id,
    section: e.section ?? '方法',
    page: e.page ?? 1,
    content: e.content ?? '原文片段',
    translation: e.translation ?? '',
    supports: [],
    confidence: 1,
    method_ids: e.method_ids ?? [],
    gap_ids: [],
    direction_ids: [],
    source_type: 'live',
  }))

  writeFileSync(
    path.join(dir, 'project.json'),
    JSON.stringify(
      {
        id,
        name,
        subtitle: '',
        description: '',
        domain: 'AI Agents',
        goal: '',
        kind: 'uploaded',
        created_at: now,
        updated_at: now,
        paper_ids: papers.map((p) => p.paper_id),
      },
      null,
      2,
    ),
  )
  writeFileSync(path.join(dir, 'papers.json'), JSON.stringify(fullPapers, null, 2))
  writeFileSync(path.join(dir, 'methods.json'), JSON.stringify(fullMethods, null, 2))
  writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(fullEvidence, null, 2))
}

/*
 * 夹具 S1：2 论文 / 3 方法 / 4 证据 / 1 空白 / 1 方向
 *
 * 每个数字都与 Demo（18/19/38/5/3）不同，且彼此不同 —— 
 * 串了哪一格一眼可见。其中 1 条证据是明确的 limitation，
 * 用来把空白与方向真的算出来（而不是 0）。
 */
writeProject({
  id: 'proj_sb_live',
  name: '侧栏一致性夹具',
  papers: [
    { paper_id: 'P001', title: 'ReAct', year: 2022 },
    { paper_id: 'P002', title: 'Reflexion', year: 2023 },
  ],
  methods: [
    { method_id: 'M001', name: 'ReAct', year: 2022, paper_ids: ['P001'], evidence_ids: ['E001', 'E004'] },
    { method_id: 'M002', name: 'Reflexion', year: 2023, paper_ids: ['P002'], evidence_ids: ['E002'] },
    { method_id: 'M003', name: 'Extra', year: 2024, paper_ids: ['P002'], evidence_ids: ['E003'] },
  ],
  evidence: [
    {
      evidence_id: 'E001',
      paper_id: 'P001',
      section: '方法',
      content: 'We propose ReAct, interleaving reasoning and acting.',
      translation: '我们提出 ReAct。',
      method_ids: ['M001'],
    },
    {
      evidence_id: 'E002',
      paper_id: 'P002',
      section: '方法',
      content: 'Reflexion converts feedback into verbal reinforcement.',
      translation: 'Reflexion 把反馈转成语言强化信号。',
      method_ids: ['M002'],
    },
    {
      evidence_id: 'E003',
      paper_id: 'P002',
      section: '方法',
      content: 'The Extra module extends the base agent loop.',
      translation: 'Extra 模块扩展了基础 agent 循环。',
      method_ids: ['M003'],
    },
    {
      evidence_id: 'E004',
      paper_id: 'P001',
      section: '局限',
      content:
        'A limitation of our approach is that it does not scale to long-horizon tasks.',
      translation: '我们方法的局限在于无法扩展到长周期任务。',
      method_ids: ['M001'],
    },
  ],
})

/* ------------------------------------------------------------------ */
/* 启动浏览器并取数                                                     */
/* ------------------------------------------------------------------ */

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(String(e)))

/** 读侧栏全部统计锚点 */
const readSidebar = () =>
  page.locator('[data-sidebar-stat]').evaluateAll((els) =>
    Object.fromEntries(
      els.map((e) => [e.getAttribute('data-sidebar-stat'), e.innerText.trim()]),
    ),
  )

/** 等侧栏数字到齐（不是等静态标题） */
const waitSidebarReady = async () => {
  for (let i = 0; i < 40; i++) {
    const s = await readSidebar().catch(() => ({}))
    if (s.papers && s.papers !== '—') return s
    await sleep(250)
  }
  return readSidebar().catch(() => ({}))
}

const run = async () => {
  if (!(await waitReady())) {
    stop()
    console.log('✗ 服务端未能启动')
    process.exit(1)
  }

  /* ── 0. 地勘：先确认接口侧的真实数量 ── */
  section('— 0. 地勘：接口给出的真实数量 —')

  const bundle = await (await fetch(`${BASE}/api/projects/proj_sb_live`)).json().catch(() => null)
  const gaps = await (await fetch(`${BASE}/api/projects/proj_sb_live/gaps`)).json().catch(() => null)
  const dirs = await (await fetch(`${BASE}/api/projects/proj_sb_live/directions`)).json().catch(() => null)

  const api = {
    papers: bundle?.data?.papers?.length ?? -1,
    methods: bundle?.data?.methods?.length ?? -1,
    evidence: bundle?.data?.evidence?.length ?? -1,
    gaps: gaps?.data?.gaps?.length ?? -1,
    directions: dirs?.data?.directions?.length ?? -1,
  }

  check('夹具论文数为 2', api.papers === 2, `实际 ${api.papers}`)
  check('夹具方法数为 3', api.methods === 3, `实际 ${api.methods}`)
  check('夹具证据数为 4', api.evidence === 4, `实际 ${api.evidence}`)
  check('夹具产出了至少 1 条空白', api.gaps > 0, `实际 ${api.gaps}`)
  check('夹具产出了至少 1 个方向', api.directions > 0, `实际 ${api.directions}`)
  check(
    '夹具数量与 Demo 静态值全不相同（否则测不出串数据）',
    api.papers !== 18 && api.methods !== 19 && api.evidence !== 38,
  )

  console.log(`   接口实际：论文 ${api.papers} / 方法 ${api.methods} / 证据 ${api.evidence} / 空白 ${api.gaps} / 方向 ${api.directions}`)
  console.log(`   Demo 静态：论文 18 / 方法 19 / 证据 38 / 空白 5 / 方向 3`)

  if (api.papers !== 2 || api.directions < 1) {
    stop()
    console.log('\n✗ 夹具不成立，停止浏览器断言')
    process.exit(1)
  }

  /* ── 1. Live 项目：侧栏必须等于接口真实数量 ── */
  section('— 1. Live 项目：侧栏 === 接口真实数量 —')

  await page.goto(`${BASE}/project/proj_sb_live/directions`, { waitUntil: 'domcontentloaded' })
  const live = await waitSidebarReady()

  check('Live 论文数 = 接口', live.papers === String(api.papers), `侧栏 ${live.papers} vs 接口 ${api.papers}`)
  check('Live 方法数 = 接口', live.methods === String(api.methods), `侧栏 ${live.methods} vs 接口 ${api.methods}`)
  check('Live 证据数 = 接口', live.evidence === String(api.evidence), `侧栏 ${live.evidence} vs 接口 ${api.evidence}`)
  check('Live 空白数 = 接口', live.gaps === String(api.gaps), `侧栏 ${live.gaps} vs 接口 ${api.gaps}`)
  check(
    'Live 方向数 = 接口',
    live.directions === String(api.directions),
    `侧栏 ${live.directions} vs 接口 ${api.directions}`,
  )

  /* ── 2. Live 侧栏 与 页面正文 必须一致 ── */
  section('— 2. Live：侧栏与「研究方向」正文一致 —')

  const bodyDirCount = await page
    .locator('[data-direction-stat="total"]')
    .first()
    .innerText()
    .catch(() => '—')
  check(
    '侧栏方向数 === 正文方向总数（同一屏不能自相矛盾）',
    live.directions === bodyDirCount.trim(),
    `侧栏 ${live.directions} vs 正文 ${bodyDirCount.trim()}`,
  )

  /* ── 3. 反向排除：Live 不得出现 Demo 数字 ── */
  section('— 3. 反向排除：Live 侧栏不得出现 Demo 数字 —')

  check('Live 论文数 ≠ Demo 的 18', live.papers !== '18', `实际 ${live.papers}`)
  check('Live 方法数 ≠ Demo 的 19', live.methods !== '19', `实际 ${live.methods}`)
  check('Live 证据数 ≠ Demo 的 38', live.evidence !== '38', `实际 ${live.evidence}`)
  check('Live 空白数 ≠ Demo 的 5', live.gaps !== '5', `实际 ${live.gaps}`)
  check('Live 方向数 ≠ Demo 的 3', live.directions !== '3', `实际 ${live.directions}`)

  /* ── 4. Demo 项目：保持静态数字不变 ── */
  section('— 4. Demo 项目：保持既有静态数字 —')

  await page.goto(`${BASE}/project/proj-aicoding-agent/directions`, { waitUntil: 'domcontentloaded' })
  const demo = await waitSidebarReady()

  check('Demo 论文数 = 18', demo.papers === '18', `实际 ${demo.papers}`)
  check('Demo 方法数 = 19', demo.methods === '19', `实际 ${demo.methods}`)
  check('Demo 证据数 = 38', demo.evidence === '38', `实际 ${demo.evidence}`)
  check('Demo 空白数 = 5', demo.gaps === '5', `实际 ${demo.gaps}`)
  check('Demo 方向数 = 3', demo.directions === '3', `实际 ${demo.directions}`)

  /* ── 5. 交叉：两组数字必须互不相同（真的换过数据源） ── */
  section('— 5. 交叉验证：Live 与 Demo 统计确实不同 —')

  check(
    'Live 与 Demo 的论文数不同',
    live.papers !== demo.papers,
    `live ${live.papers} vs demo ${demo.papers}`,
  )
  check(
    'Live 与 Demo 的证据数不同',
    live.evidence !== demo.evidence,
    `live ${live.evidence} vs demo ${demo.evidence}`,
  )
  check(
    'Live 与 Demo 的方向数不同',
    live.directions !== demo.directions,
    `live ${live.directions} vs demo ${demo.directions}`,
  )

  /* ── 6. 切回 Live：不得残留上一个项目的数字 ── */
  section('— 6. 来回切换：不得残留上一个项目的统计 —')

  await page.goto(`${BASE}/project/proj_sb_live/directions`, { waitUntil: 'domcontentloaded' })
  const back = await waitSidebarReady()
  check(
    '从 Demo 切回 Live 后，侧栏恢复为 Live 数字',
    back.evidence === String(api.evidence) && back.papers === String(api.papers),
    `papers ${back.papers} / evidence ${back.evidence}`,
  )

  await page.goto(`${BASE}/project/proj-aicoding-agent/directions`, { waitUntil: 'domcontentloaded' })
  const backDemo = await waitSidebarReady()
  check(
    '从 Live 切回 Demo 后，侧栏恢复为 Demo 数字',
    backDemo.evidence === '38' && backDemo.directions === '3',
    `evidence ${backDemo.evidence} / directions ${backDemo.directions}`,
  )

  /* ── 7. 不存在的项目：不得显示任何统计 ── */
  section('— 7. 不存在的项目：统计留空，不回落 Demo —')

  await page.goto(`${BASE}/project/proj_not_exist_at_all/directions`, { waitUntil: 'domcontentloaded' })
  await sleep(1500)
  const nf = await readSidebar().catch(() => ({}))
  check(
    '不存在的项目：证据数不得显示 Demo 的 38',
    nf.evidence !== '38',
    `实际 ${nf.evidence}`,
  )
  check(
    '不存在的项目：方向数不得显示 Demo 的 3',
    nf.directions !== '3',
    `实际 ${nf.directions}`,
  )
  check(
    '不存在的项目：显示占位符而不是数字',
    (nf.evidence ?? '—') === '—' || nf.evidence === '0',
    `实际 ${nf.evidence}`,
  )

  /* ── 8. 控制台无脚本错误 ── */
  section('— 8. 控制台清洁 —')

  const realErrors = consoleErrors.filter((e) => !/favicon|404|Failed to load resource/i.test(e))
  check('无脚本运行时错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

  /* ── 9. 截图 ── */
  section('— 9. 截图 —')

  const shots = path.join(ROOT, '.shots')
  mkdirSync(shots, { recursive: true })

  await page.goto(`${BASE}/project/proj_sb_live/directions`, { waitUntil: 'domcontentloaded' })
  await waitSidebarReady()
  await sleep(600)
  await page.screenshot({ path: path.join(shots, 'phase4-7-侧栏统计-live.png'), fullPage: false })

  await page.goto(`${BASE}/project/proj-aicoding-agent/directions`, { waitUntil: 'domcontentloaded' })
  await waitSidebarReady()
  await sleep(600)
  await page.screenshot({ path: path.join(shots, 'phase4-7-侧栏统计-demo.png'), fullPage: false })

  check('已输出两张截图', true, '.shots/phase4-7-侧栏统计-{live,demo}.png')

  await browser.close()
  stop()

  console.log('\n' + '─'.repeat(70))
  if (fail === 0) {
    console.log(`✓ 侧边栏统计一致性测试全部通过（${pass} 项断言）`)
    console.log('  Live 取真实 dataset · Demo 保持静态 · 两者不串 · 切项目无残留')
    process.exit(0)
  } else {
    console.log(`✗ 侧边栏统计一致性测试失败（通过 ${pass} / 失败 ${fail}）`)
    process.exit(1)
  }
}

run().catch(async (e) => {
  console.error('测试异常：', e)
  try {
    await browser.close()
  } catch {}
  stop()
  process.exit(1)
})
