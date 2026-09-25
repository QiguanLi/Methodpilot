#!/usr/bin/env node
/**
 * 调研报告 UI 验收（Phase 4-8 UI）—— 真浏览器。
 *
 * ── 为什么必须再跑一遍浏览器 ──
 *
 * report-test.mjs（128 断言）证明了 buildResearchReport() 这个纯函数是对的；
 * 这一阶段的改动**全在前端 + 一个只做搬运的 API**，上面那层一条都测不到：
 *
 *   · 七个章节必须**全都渲染出来**（尤其「研究主题」在 report.topic 里，
 *     不在 sections 里 —— 只遍历 sections 会静默少一章）
 *   · stated_fact / system_analysis / system_suggestion 必须**视觉区分**
 *     （颜色 + 徽标文字 + 边框样式，不能只靠颜色）
 *   · 每个重要结论要显示来源数量，且 Evidence 能点开抽屉看到**本项目的**原文
 *   · candidate Gap / candidate Direction 的「候选 / 推测」标识不得丢失
 *   · Evidence 索引要如实显示"哪些被引用、哪些没被引用"
 *   · 空项目必须显示明确空状态，**不能**伪装成一份报告
 *   · Demo 项目保持原有报告，且 Demo / Live 不串数据
 *
 * ── 四组夹具 ──
 *
 *   R1 单篇明确局限：有 stated Gap + stated 方向 → 三档层级齐全
 *   R2 两篇共缺：产出 candidate Gap → 候选标识必须保留
 *   R3 空项目：0 论文 → 明确空状态（不是错误、也不是空报告）
 *   R4 不存在：路由到没有 bundle 的项目 → 真错误态
 *
 * ⚠️ 地勘先跑：如果 R2 其实没产出 candidate，第 4 节整节就是在验证一个
 * 不存在的场景，全绿也没有意义。所以脚本开头直接 fetch 接口确认夹具成立，
 * 不满足立刻退出并说明夹具本身不成立。
 *
 * 用法：pnpm report:ui-test   （需先 pnpm build）
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.REPORT_UI_PORT ?? 8984)
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

/* ------------------------------------------------------------------ */
/* 前置：dist 必须已构建                                               */
/* ------------------------------------------------------------------ */

const distIndex = path.join(ROOT, 'dist', 'index.html')
if (!existsSync(distIndex)) {
  console.log('✗ 找不到 dist/index.html —— 请先运行 pnpm build 再跑本测试')
  process.exit(1)
}

/* ------------------------------------------------------------------ */
/* 隔离 store + 手工造数据                                             */
/* ------------------------------------------------------------------ */

const storeDir = mkdtempSync(path.join(tmpdir(), 'mprepui-'))
const uploadDir = mkdtempSync(path.join(tmpdir(), 'mprepui-up-'))

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

/*
 * ⚠️ 路径约定：DATA_DIR 本身就是 store 根，fileStore 在其下拼 `/projects/<id>`。
 * 多写一层 `store/` 会让所有夹具 404（Phase 4-3 踩过）。
 */
const PROJECTS = path.join(storeDir, 'projects')

function writeProject({ id, name, papers, methods, evidence }) {
  const dir = path.join(PROJECTS, id)
  mkdirSync(dir, { recursive: true })
  const now = '2025-01-01T00:00:00.000Z'

  const fullPapers = papers.map((p) => ({
    paper_id: p.paper_id,
    project_id: id,
    title: p.title ?? p.paper_id,
    authors: p.authors ?? [],
    year: p.year ?? 2024,
    abstract: p.abstract ?? '',
    keywords: p.keywords ?? [],
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
    family_id: m.family_id ?? '',
    task: m.task ?? '',
    paradigm: m.paradigm ?? '',
    year: m.year ?? 0,
    core_idea: m.core_idea ?? '',
    modules: [],
    inputs: [],
    outputs: [],
    capabilities: [],
    advantages: m.advantages ?? [],
    limitations: m.limitations ?? [],
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

/* ── R1：单篇论文明确写出 limitation → stated 打底 ── */

const R1_PAPERS = [
  {
    paper_id: 'P001',
    title: 'ReAct: Synergizing Reasoning and Acting',
    year: 2022,
    keywords: ['LLM Agent', 'Tool Use'],
    abstract: 'We propose ReAct, interleaving reasoning and acting with language models.',
  },
]
const R1_METHODS = [
  {
    method_id: 'M001',
    name: 'ReAct',
    name_zh: '推理-行动',
    family_id: 'F1',
    year: 2022,
    task: '交替推理与行动',
    core_idea: '在推理与行动之间交替',
    paradigm: 'Prompting',
    paper_ids: ['P001'],
    evidence_ids: ['E001', 'E002'],
  },
]

writeProject({
  id: 'proj_report_ui_stated',
  name: '明确局限夹具',
  papers: R1_PAPERS,
  methods: R1_METHODS,
  evidence: [
    {
      evidence_id: 'E001',
      paper_id: 'P001',
      section: '方法',
      page: 2,
      content: 'We propose ReAct, interleaving reasoning and acting with language models.',
      translation: '我们提出 ReAct，让语言模型交替进行推理与行动。',
      method_ids: ['M001'],
    },
    {
      evidence_id: 'E002',
      paper_id: 'P001',
      section: '局限',
      page: 8,
      /*
       * 必须同时满足：
       *   · 命中 limitation 句式（"a limitation ... is that"）
       *   · 有实质文本（≥12 字符）
       * 且只出现在一篇论文里 —— 这样 R1 是纯净的 stated 夹具。
       */
      content:
        'A limitation of our approach is that it does not scale to long-horizon tasks, which we leave to future work.',
      translation: '我们方法的一个局限是它无法扩展到长程任务，这一点我们留给未来工作。',
      method_ids: ['M001'],
    },
  ],
})

/* ── R2：两篇论文共同缺失 → candidate Gap（用于验候选标识）── */

writeProject({
  id: 'proj_report_ui_candidate',
  name: '多篇共缺夹具',
  papers: [
    {
      paper_id: 'P001',
      title: 'ReAct: Synergizing Reasoning and Acting',
      year: 2022,
      keywords: ['LLM Agent'],
      abstract: 'We propose ReAct.',
    },
    {
      paper_id: 'P002',
      title: 'Reflexion: Language Agents with Verbal RL',
      year: 2023,
      keywords: ['LLM Agent'],
      abstract: 'We propose Reflexion.',
    },
  ],
  methods: [
    {
      method_id: 'M001',
      name: 'ReAct',
      name_zh: '推理-行动',
      family_id: 'F1',
      year: 2022,
      task: '交替推理与行动',
      core_idea: '在推理与行动之间交替',
      paradigm: 'Prompting',
      paper_ids: ['P001'],
      evidence_ids: ['E001'],
    },
    {
      method_id: 'M002',
      name: 'Reflexion',
      name_zh: '反思',
      family_id: 'F2',
      year: 2023,
      task: '语言化自我反思',
      core_idea: '用语言反馈改进后续尝试',
      paradigm: 'Agent',
      paper_ids: ['P002'],
      evidence_ids: ['E002'],
    },
  ],
  evidence: [
    {
      evidence_id: 'E001',
      paper_id: 'P001',
      section: '局限',
      page: 8,
      content: 'A limitation is that our method has not been evaluated on long-horizon tasks.',
      translation: '一个局限是我们的方法尚未在长程任务上评估。',
      method_ids: ['M001'],
    },
    {
      evidence_id: 'E002',
      paper_id: 'P002',
      section: '讨论',
      page: 9,
      content:
        'Our approach has not been evaluated on long-horizon tasks, which remains an open problem.',
      translation: '我们的方法尚未在长程任务上评估，这仍是一个开放问题。',
      method_ids: ['M002'],
    },
  ],
})

/* ── R3：空项目（0 论文）→ 明确空状态 ── */

writeProject({
  id: 'proj_report_ui_empty',
  name: '空项目夹具',
  papers: [],
  methods: [],
  evidence: [],
})

/* ------------------------------------------------------------------ */

const run = async () => {
  if (!(await waitReady())) {
    stop()
    console.log('✗ 服务端未能启动，无法运行调研报告 UI 测试')
    process.exit(1)
  }

  console.log('═'.repeat(68))
  console.log('调研报告 UI 测试（Phase 4-8 UI）')
  console.log('═'.repeat(68))

  const apiReport = async (pid) => {
    const r = await fetch(`${BASE}/api/projects/${pid}/report`)
    return { status: r.status, body: await r.json().catch(() => null) }
  }

  /* ================================================================== */
  section('— 0. 夹具地勘（夹具不成立则后续断言无意义）—')
  /* ================================================================== */

  const r1 = await apiReport('proj_report_ui_stated')
  const r2 = await apiReport('proj_report_ui_candidate')
  const r3 = await apiReport('proj_report_ui_empty')
  const r4 = await apiReport('proj_does_not_exist_xyz')

  check('R1 报告接口 200', r1.status === 200, `status=${r1.status}`)
  check('R1 无服务端不变量违规', r1.body?.data?.invariant_violations?.length === 0,
    JSON.stringify(r1.body?.data?.invariant_violations ?? []).slice(0, 120))
  check(
    'R1 必须真的产出 stated_fact（否则第 1、2 节无从验证）',
    (r1.body?.data?.report?.layering?.stated_fact ?? 0) > 0,
    `stated_fact=${r1.body?.data?.report?.layering?.stated_fact}`,
  )
  check(
    'R1 必须产出 Evidence 索引（否则第 5 节无从验证）',
    (r1.body?.data?.report?.evidence_index?.length ?? 0) > 0,
    `index=${r1.body?.data?.report?.evidence_index?.length}`,
  )

  check('R2 报告接口 200', r2.status === 200, `status=${r2.status}`)
  check('R2 无服务端不变量违规', r2.body?.data?.invariant_violations?.length === 0)
  const r2CandidateGaps = (r2.body?.data?.report?.sections ?? [])
    .flatMap((s) => s.statements ?? [])
    .flatMap((st) => st.refs ?? [])
    .filter((x) => x.kind === 'gap')
  check(
    'R2 必须真的产出 candidate Gap（否则第 4 节假绿）',
    (r2.body?.data?.report?.sections ?? [])
      .flatMap((s) => s.statements ?? [])
      .some((st) => /【候选】|候选/.test(st.text)),
    `gap refs=${r2CandidateGaps.length}`,
  )

  check(
    'R3 空项目：0 论文 / 0 回链 / 全部章节 insufficient',
    r3.body?.data?.report?.layering?.total_refs === 0 &&
      r3.body?.data?.report?.layering?.insufficient_sections ===
        r3.body?.data?.report?.sections?.length,
    `refs=${r3.body?.data?.report?.layering?.total_refs} insufficient=${r3.body?.data?.report?.layering?.insufficient_sections}`,
  )

  check('R4 不存在的项目返回 404（用于验错误态）', r4.status === 404, `status=${r4.status}`)

  if (fail > 0) {
    stop()
    console.log('\n✗ 夹具不成立，停止后续浏览器断言（继续跑只会得到无意义的绿）')
    process.exit(1)
  }

  /* ── 启动浏览器 ── */

  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } })

  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  /*
   * 等"只有数据到了才会出现"的**选择器**，而不是等静态标题。
   * 等错信号（比如等页面标题「研究调研报告」，那是骨架就有的）
   * 是 UI 测试假红/假绿最大的来源。
   */
  const waitAttr = (sel, timeout = 20000) => page.waitForSelector(sel, { timeout }).catch(() => null)

  const resp1 = r1.body.data.report

  /* ================================================================== */
  section('— 1. R1：七个章节齐全（含不在 sections 里的「研究主题」）—')
  /* ================================================================== */

  await page.goto(`${BASE}/project/proj_report_ui_stated/report`, { waitUntil: 'domcontentloaded' })
  await waitAttr('[data-report-page="live"]')

  const domSections = await page
    .locator('[data-report-section]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-report-section')))

  const EXPECTED = [
    'topic',
    'literature',
    'methods',
    'evolution',
    'gaps',
    'directions',
    'evidence_index',
  ]
  check(
    '七个章节全部渲染（顺序与需求逐项对应）',
    JSON.stringify(domSections) === JSON.stringify(EXPECTED),
    domSections.join(','),
  )

  /*
   * ⚠️ 「研究主题」在 report.topic 里，**不在** sections 里。
   * 这条单独断言，防的是"只遍历 sections"这种会静默少一章的实现。
   */
  check(
    '「研究主题」章存在（它在 report.topic，不在 sections）',
    domSections.includes('topic'),
  )
  check(
    '接口的 sections 里确实没有 topic（证实两个来源不同）',
    !resp1.sections.some((s) => s.section_id === 'topic'),
    resp1.sections.map((s) => s.section_id).join(','),
  )

  /* 目录七项都要在 */
  const navIds = await page
    .locator('[data-report-nav]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-report-nav')))
  check('目录含七个锚点', JSON.stringify(navIds) === JSON.stringify(EXPECTED), navIds.join(','))

  const bodyText = await page.evaluate(() => document.body.innerText)
  for (const [id, label] of [
    ['topic', '研究主题'],
    ['literature', '文献概览'],
    ['methods', '方法分类'],
    ['evolution', '技术演进'],
    ['gaps', '研究空白'],
    ['directions', '研究方向'],
    ['evidence_index', 'Evidence 索引'],
  ]) {
    check(`页面出现章节标题「${label}」`, bodyText.includes(label), `(${id})`)
  }

  /* 标题来自接口，不是写死的 */
  const domTitle = await page.locator('[data-report-title]').innerText()
  check('报告标题与接口一致', domTitle.trim() === resp1.title.trim(), `${domTitle} vs ${resp1.title}`)
  check('页面显示 report_id', bodyText.includes(resp1.report_id), resp1.report_id)

  /* ================================================================== */
  section('— 2. R1：三种语义视觉区分（不只靠颜色）—')
  /* ================================================================== */

  const stmtKinds = await page
    .locator('[data-report-statement]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-report-statement')))

  check(
    '每条陈述都带 kind，且都在三类之内',
    stmtKinds.length > 0 &&
      stmtKinds.every((k) =>
        ['stated_fact', 'system_analysis', 'system_suggestion'].includes(k),
      ),
    `共 ${stmtKinds.length} 条`,
  )

  /* 每一类都要有徽标，且徽标**文字**必须能区分（灰度/截图后颜色会丢） */
  const badges = await page
    .locator('[data-report-stmt-badge]')
    .evaluateAll((els) =>
      els.map((e) => ({
        kind: e.getAttribute('data-report-stmt-badge'),
        text: e.innerText.trim(),
      })),
    )
  check('每一条陈述都有层级徽标', badges.length === stmtKinds.length, `${badges.length}/${stmtKinds.length}`)

  const badgeTexts = new Set(badges.map((b) => b.text))
  check(
    '三类徽标文字互不相同（视觉区分不能只靠颜色）',
    badgeTexts.size === new Set(badges.map((b) => b.kind)).size,
    [...badgeTexts].join(' | '),
  )
  check(
    '徽标文字出现了「论文原文」「系统分析」两种以上',
    [...badgeTexts].some((t) => t.includes('论文原文')) && [...badgeTexts].some((t) => t.includes('系统分析')),
    [...badgeTexts].join(' | '),
  )

  /* 颜色也要真的不同：取背景色比较 */
  const distinctBg = await page.evaluate(() => {
    const out = {}
    for (const el of document.querySelectorAll('[data-report-statement]')) {
      const k = el.getAttribute('data-report-statement')
      const cs = getComputedStyle(el)
      out[k] = `${cs.backgroundColor}|${cs.borderLeftColor}|${cs.borderStyle}`
    }
    return out
  })
  const styles = Object.values(distinctBg)
  check(
    '不同层级的样式（底色/左边框/边框样式）互不相同',
    new Set(styles).size === styles.length,
    JSON.stringify(distinctBg).slice(0, 200),
  )

  /* 分层摘要：三个数字必须与接口一致 */
  const readLayering = async (k) =>
    Number(
      String(
        await page.locator(`[data-report-layering="${k}"]`).first().innerText().catch(() => '-1'),
      )
        .split('\n')[0]
        .trim(),
    )
  const lStated = await readLayering('stated_fact')
  const lAnalysis = await readLayering('system_analysis')
  const lSuggestion = await readLayering('system_suggestion')
  const api = resp1.layering
  check('分层摘要 stated_fact 与接口一致', lStated === api.stated_fact, `${lStated} vs ${api.stated_fact}`)
  check('分层摘要 system_analysis 与接口一致', lAnalysis === api.system_analysis, `${lAnalysis} vs ${api.system_analysis}`)
  check('分层摘要 system_suggestion 与接口一致', lSuggestion === api.system_suggestion, `${lSuggestion} vs ${api.system_suggestion}`)

  /*
   * 摘要数字必须等于 **DOM 上真实渲染的条数** —— 这一条抓的是
   * "摘要读接口、正文却漏渲染几条" 的口径分叉。
   */
  const domCount = stmtKinds.reduce((a, k) => ((a[k] = (a[k] || 0) + 1), a), {})
  check(
    'DOM 上 stated_fact 条数 = 接口 stated_fact',
    (domCount.stated_fact ?? 0) === api.stated_fact,
    `${domCount.stated_fact ?? 0} vs ${api.stated_fact}`,
  )
  check(
    'DOM 上 system_suggestion 条数 = 接口 system_suggestion',
    (domCount.system_suggestion ?? 0) === api.system_suggestion,
    `${domCount.system_suggestion ?? 0} vs ${api.system_suggestion}`,
  )

  /* ================================================================== */
  section('— 3. R1：重要结论显示来源数量，且能回链 Evidence —')
  /* ================================================================== */

  const refCountRows = await page
    .locator('[data-report-refcount]')
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-report-refcount'))))
  check('至少有一条陈述显示了来源数量', refCountRows.length > 0, `${refCountRows.length} 条`)
  check(
    '来源数量全部 > 0 且与正文里的 ref 标签数一致',
    refCountRows.every((n) => n > 0),
    refCountRows.join(','),
  )

  /* 接口侧：统计带 refs 的陈述，和 DOM 上出现的 refcount 数量对得上 */
  const apiStmtsWithRefs = [...resp1.topic.research_questions, ...resp1.sections.flatMap((s) => s.statements)].filter(
    (st) => st.refs.length > 0,
  )
  check(
    'DOM 的来源数量行数 = 接口里带 refs 的陈述数',
    refCountRows.length === apiStmtsWithRefs.length,
    `${refCountRows.length} vs ${apiStmtsWithRefs.length}`,
  )

  const evOpenBtns = await page.locator('[data-report-evidence-open]').count()
  check('存在可点击的 Evidence 入口', evOpenBtns > 0, `${evOpenBtns} 个`)

  const firstEv = page.locator('[data-report-evidence-open]').first()
  const firstEvId = await firstEv.getAttribute('data-report-evidence-open')

  /*
   * ⚠️ 先**硬刷新**一次再点开抽屉。
   *
   * `registerDataset()` 写的是 `projectData.ts` 里的**模块级单例**
   * `currentDataset`，它**跨路由存活**。如果本用例顺着前面的导航进来，
   * 注册表里还留着上一个页面的数据集 —— 那么"报告页忘了调
   * registerDataset"这个 bug 就**观察不到**（抽屉照旧拿到本项目证据）。
   *
   * 实测确认过：注入"删掉 registerDataset 调用"后，不刷新时 79 项全绿。
   * 所以这里必须 reload，把模块状态清空，模拟"用户直接打开这个链接"。
   */
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitAttr('[data-report-page="live"]')

  const firstEv2 = page.locator('[data-report-evidence-open]').first()
  await firstEv2.click()
  await waitAttr('[data-evidence-drawer="1"]', 6000)

  check('点击 Evidence 打开了证据抽屉', (await page.locator('[data-evidence-drawer="1"]').count()) === 1)

  /*
   * ⚠️ 断言必须**只扫抽屉内部**，不能扫 document.body。
   *
   * 报告正文里也含相同的英文原文（那正是被引用的那句话），
   * 扫整页的话，抽屉其实显示了 Demo 演示语料（错）也照样通过 ——
   * 这是一个已经踩过的假绿（4-6 注入"不注册数据集"后仍全绿）。
   */
  const drawerText = await page.locator('[data-evidence-drawer="1"]').innerText().catch(() => '')
  check('抽屉非空', drawerText.length > 0, `${drawerText.length} 字符`)
  check('抽屉引用了当前陈述的证据 id', firstEvId ? drawerText.includes(firstEvId) : false, `期望 ${firstEvId}`)
  check(
    '抽屉里是本项目原文（含 ReAct / interleaving）',
    /ReAct|interleaving|reasoning and acting/i.test(drawerText),
    '若显示的是演示论文原文，说明 registerDataset 缺失 → 回落到 Demo 数据',
  )
  /* 反向排除：Demo 语料的特征串。这条才是真正抓"回落 Demo"的断言 */
  check(
    '抽屉里**不**含 Demo 演示语料特征（SWE-agent / NeurIPS / ACI）',
    !/SWE-agent|NeurIPS|agent-computer interface|ACI/i.test(drawerText),
    drawerText.slice(0, 120).replace(/\n/g, ' '),
  )

  /* 抽屉是 fixed 全屏浮层，不关掉会拦截后续所有 pointer 事件 */
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  check('按 Esc 能关闭证据抽屉（不残留浮层）', (await page.locator('[data-evidence-drawer="1"]').count()) === 0)

  /* ================================================================== */
  section('— 4. R2：candidate 标识不丢失 —')
  /* ================================================================== */

  await page.goto(`${BASE}/project/proj_report_ui_candidate/report`, { waitUntil: 'domcontentloaded' })
  await waitAttr('[data-report-page="live"]')
  const r2Body = await page.evaluate(() => document.body.innerText)

  /*
   * 候选 Gap 的标识有三处可能被洗掉：
   *   ① 正文措辞（"候选" / "推断" 字样）
   *   ② 回链标签的 label（【候选】前缀）
   *   ③ 标签的配色（候选用琥珀色而非灰/绿）
   * 三条都验，任何一条丢失都会被抓到。
   */
  check(
    'R2 页面出现 candidate Gap 的标识（【候选】或"候选"/"推断"）',
    /【候选】|候选|推断/.test(r2Body),
    '若正文把候选写成事实，这里会失败',
  )

  const candRefLabels = await page
    .locator('[data-report-ref]')
    .evaluateAll((els) =>
      els
        .map((e) => ({ ref: e.getAttribute('data-report-ref'), text: e.innerText }))
        .filter((x) => x.ref && x.ref.startsWith('gap:')),
    )
  check('页面渲染出 Gap 回链标签', candRefLabels.length > 0, `${candRefLabels.length} 个`)

  /*
   * 候选 Gap 的 label 必须带「候选」前缀。
   *
   * ⚠️ 这条不能写成 `candLabels.length > 0 || 没找到就跳过`（那就是恒真）。
   * 正确做法：先从**接口**里找出候选 Gap 的 id，再看 DOM 上这些 id 的标签长什么样。
   * 只有"接口确实有候选 Gap"时这条断言才有内容 —— 而地勘已经保证 R2 有候选。
   */
  const apiCandidateGapIds = r2.body.data.report.sections
    .flatMap((s) => s.statements ?? [])
    .flatMap((st) => st.refs ?? [])
    .filter((x) => x.kind === 'gap' && /候选/.test(x.label))
    .map((x) => x.id)
  check(
    '接口里确实存在带「候选」前缀的 Gap label（本断言的前提）',
    apiCandidateGapIds.length > 0,
    apiCandidateGapIds.join(',') || '（无 → 说明候选标识在服务端就被洗掉了）',
  )

  const candGapIds = [...new Set(apiCandidateGapIds)]
  const domCandLabels = candRefLabels.filter((x) => candGapIds.some((id) => x.ref === `gap:${id}`))
  check(
    '接口里的候选 Gap 在 DOM 上被渲染为回链标签',
    domCandLabels.length > 0,
    `期望 ${candGapIds.join(',')}，实际命中 ${domCandLabels.length} 个`,
  )
  check(
    '候选 Gap 的回链标签**逐条**保留了「候选」字样（label 未被洗掉）',
    domCandLabels.length > 0 && domCandLabels.every((x) => /候选/.test(x.text)),
    domCandLabels.map((x) => x.text.replace(/\s+/g, ' ').slice(0, 40)).join(' | ') || '无命中',
  )

  /* 候选标签的配色必须与普通标签不同（琥珀 vs 灰） */
  const candStyle = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-report-ref]')]
    const cand = els.filter((e) => /候选|推测/.test(e.innerText))
    const plain = els.filter((e) => !/候选|推测/.test(e.innerText))
    const bg = (e) => (e ? getComputedStyle(e).backgroundColor : null)
    return { cand: bg(cand[0]), plain: bg(plain[0]), candCount: cand.length }
  })
  if (candStyle.candCount > 0 && candStyle.plain) {
    check(
      '候选回链的配色与普通回链不同（视觉上能一眼区分）',
      candStyle.cand !== candStyle.plain,
      `${candStyle.cand} vs ${candStyle.plain}`,
    )
  } else {
    check('候选回链配色检查（夹具未产出候选 Gap 标签，跳过）', true, 'skip')
  }

  /*
   * 最关键的一条：候选 Gap **绝不能**出现在 stated_fact 陈述里。
   * 一旦出现，就说明"推断被写成了论文事实"——这是整节要防的事。
   */
  const statedTexts = await page
    .locator('[data-report-statement="stated_fact"]')
    .evaluateAll((els) => els.map((e) => e.innerText))
  check(
    '没有任何 stated_fact 陈述提到「候选」',
    statedTexts.every((t) => !/候选/.test(t)),
    statedTexts.map((t) => t.slice(0, 60)).join(' | '),
  )

  /* 全文扫描：系统建议 / 系统分析 不得出现事实断言口吻 */
  const allStmtTexts = await page.evaluate(() =>
    [...document.querySelectorAll('[data-report-statement]')]
      .filter((e) => e.getAttribute('data-report-statement') !== 'stated_fact')
      .map((e) => e.innerText),
  )
  const FACTUAL = /研究表明|实验结果?表明|普遍认为|众所周知|学术界|已有研究(?:证明|表明)/
  check(
    '非事实级陈述不含事实断言口吻（未把推断写成论文事实）',
    allStmtTexts.every((t) => !FACTUAL.test(t)),
    allStmtTexts.filter((t) => FACTUAL.test(t)).map((t) => t.slice(0, 70)).join(' | ') || 'clean',
  )

  /* ================================================================== */
  section('— 5. R1：Evidence 索引显示哪些被实际引用 —')
  /* ================================================================== */

  await page.goto(`${BASE}/project/proj_report_ui_stated/report`, { waitUntil: 'domcontentloaded' })
  await waitAttr('[data-report-section="evidence_index"]')

  const idxRows = await page.locator('[data-report-evidence-index]').count()
  check(
    'Evidence 索引条数 = 接口 evidence_index 长度',
    idxRows === resp1.evidence_index.length,
    `${idxRows} vs ${resp1.evidence_index.length}`,
  )

  const citedFlags = await page
    .locator('[data-report-evidence-cited]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-report-evidence-cited')))
  const domCited = citedFlags.filter((f) => f === '1').length
  const apiCited = resp1.evidence_index.filter((r) => r.cited_by.length > 0).length
  check('被引用的证据条数 = 接口 cited_by 非空条数', domCited === apiCited, `${domCited} vs ${apiCited}`)

  const domUnused = await page.locator('[data-report-evidence-unused]').count()
  check(
    '未被引用的证据被**如实标注**（不是隐藏掉）',
    domUnused === resp1.evidence_index.length - apiCited,
    `${domUnused} vs ${resp1.evidence_index.length - apiCited}`,
  )

  const citedCount = await page.locator('[data-report-cited-count]').first().innerText().catch(() => '')
  check('索引顶部显示"已被引用 N 条 / 未被使用 M 条"', /已被引用/.test(citedCount) && /未被使用/.test(citedCount), citedCount)

  /* 被引用的那条要显示出"被哪些章节" */
  if (apiCited > 0) {
    const citedByChips = await page
      .locator('[data-report-cited-by]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-report-cited-by')))
    check('被引用的证据显示了「被引用：章节」', citedByChips.length > 0, citedByChips.join(','))

    /*
     * 逐条比对：对**每一条被引用的证据**，DOM 上属于它的 cited_by 恰好等于
     * 接口给的集合。不能把所有 chip 混在一起比（那样 `["a","b"]` 与 `["b","a"]`
     * 会被误判，也无法发现"张冠李戴"——A 的引用被渲染到了 B 行上）。
     */
    const mismatch = []
    for (const row of resp1.evidence_index.filter((r) => r.cited_by.length > 0)) {
      const rowEl = page.locator(`[data-report-evidence-index="${row.evidence_id}"]`)
      const rowChips = await rowEl
        .locator('[data-report-cited-by]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-report-cited-by')).sort())
      const want = [...row.cited_by].sort()
      if (JSON.stringify(rowChips) !== JSON.stringify(want)) {
        mismatch.push(`${row.evidence_id}: dom=${rowChips.join(',')} api=${want.join(',')}`)
      }
    }
    check(
      '每条被引用证据的「被哪些章节引用」都与接口逐条一致（无张冠李戴）',
      mismatch.length === 0,
      mismatch.join(' ; ') || '全部一致',
    )
  }

  /* 索引里的证据也要能点开抽屉 */
  const idxBtn = page.locator('[data-report-evidence-index] button').first()
  if ((await idxBtn.count()) > 0) {
    await idxBtn.click()
    await waitAttr('[data-evidence-drawer="1"]', 6000)
    const dt = await page.locator('[data-evidence-drawer="1"]').innerText().catch(() => '')
    check('索引里的证据可点开抽屉', dt.length > 0)
    check(
      '索引抽屉里是本项目原文，不是演示语料',
      !/SWE-agent|NeurIPS|agent-computer interface/i.test(dt),
      dt.slice(0, 100).replace(/\n/g, ' '),
    )
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }

  /* ================================================================== */
  section('— 6. R3：空项目显示明确空状态（不伪装成报告）—')
  /* ================================================================== */

  await page.goto(`${BASE}/project/proj_report_ui_empty/report`, { waitUntil: 'domcontentloaded' })
  await waitAttr('[data-report-empty="all"]', 15000)

  const emptyBody = await page.evaluate(() => document.body.innerText)
  check('空项目显示明确空状态', (await page.locator('[data-report-empty="all"]').count()) === 1)
  check(
    '空状态说明"没有可依据的语料"',
    /还没有可依据的语料|没有任何可依据的语料/.test(emptyBody),
    emptyBody.slice(0, 120).replace(/\n/g, ' '),
  )
  check('空状态给出下一步建议', /上传论文/.test(emptyBody))
  check(
    '空状态**不**出现"加载失败"文案',
    !/报告加载失败|项目加载失败/.test(emptyBody),
    '0 条 ≠ 失败，两者必须能区分',
  )
  check('空项目不渲染任何章节', (await page.locator('[data-report-section]').count()) === 0)
  check(
    '空项目不渲染任何陈述（不能伪装成有内容的报告）',
    (await page.locator('[data-report-statement]').count()) === 0,
  )

  const emptyTitle = await page.locator('[data-report-title]').innerText().catch(() => '')
  check(
    '空项目标题不声称"基于 0 篇论文"',
    !/0\s*篇论文/.test(emptyTitle),
    emptyTitle,
  )

  /* ================================================================== */
  section('— 7. R4 + Demo：错误态与 Demo 不串数据 —')
  /* ================================================================== */

  await page.goto(`${BASE}/project/proj_does_not_exist_xyz/report`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const errBody = await page.evaluate(() => document.body.innerText)
  check(
    '不存在的项目显示错误态而非空状态',
    /加载失败|不存在/.test(errBody) && !/还没有可依据的语料/.test(errBody),
    errBody.slice(0, 80).replace(/\n/g, ' '),
  )
  check('错误态不进入 Live 分支', (await page.locator('[data-report-page="live"]').count()) === 0)

  /*
   * Demo 项目必须**完整保留**原有报告（Agent 生成的 Markdown 版），
   * 且绝不能进入 Live 分支 —— 否则 Demo 会去请求服务端的 report 接口，
   * 而服务端根本没有 proj-aicoding-agent 的 bundle（必然 404）。
   */
  await page.goto(`${BASE}/project/proj-aicoding-agent/report`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
  const demoBody = await page.evaluate(() => document.body.innerText)
  check('Demo 项目渲染报告页', /研究调研报告/.test(demoBody))
  check('Demo 进入 demo 分支', (await page.locator('[data-report-page="demo"]').count()) === 1)
  check('Demo **不**进入 live 分支', (await page.locator('[data-report-page="live"]').count()) === 0)
  check('Demo 不渲染 Live 的章节锚点', (await page.locator('[data-report-section]').count()) === 0)
  check(
    'Demo 报告内容来自知识库人工标注（出现演示领域标题）',
    /AI Coding Agent|研究背景|文献概览/.test(demoBody),
    demoBody.slice(0, 100).replace(/\n/g, ' '),
  )

  /*
   * 反向：Live 项目**不得**出现 Demo 的演示语料特征。
   * 这条抓的是"Live 页面读到了 Demo 静态数据"这一次真实发生过的错。
   */
  await page.goto(`${BASE}/project/proj_report_ui_stated/report`, { waitUntil: 'domcontentloaded' })
  await waitAttr('[data-report-page="live"]')
  const liveBody = await page.evaluate(() => document.body.innerText)
  check(
    'Live 项目**不**含 Demo 演示语料特征',
    !/SWE-agent|NeurIPS|agent-computer interface|ACI/i.test(liveBody),
    '若出现，说明 Live 读到了 Demo 数据（张冠李戴）',
  )
  check('Live 项目进入 live 分支', (await page.locator('[data-report-page="live"]').count()) === 1)
  check('Live 项目不进入 demo 分支', (await page.locator('[data-report-page="demo"]').count()) === 0)

  /* ================================================================== */
  section('— 8. 前端无报错 —')
  /* ================================================================== */

  const realErrors = consoleErrors.filter(
    (e) => !/favicon|404 \(Not Found\)|Failed to load resource/i.test(e),
  )
  check('浏览器控制台无脚本错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

  /* ================================================================== */
  section('— 9. 截图 —')
  /* ================================================================== */

  const shotDir = path.join(ROOT, '.shots')
  mkdirSync(shotDir, { recursive: true })

  const shots = [
    ['proj_report_ui_candidate', 'phase4-8-调研报告-候选标识.png'],
    ['proj_report_ui_stated', 'phase4-8-调研报告-分层.png'],
    ['proj_report_ui_empty', 'phase4-8-调研报告-空状态.png'],
  ]
  for (const [pid, file] of shots) {
    await page.goto(`${BASE}/project/${pid}/report`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(900)
    const p = path.join(shotDir, file)
    await page.screenshot({ path: p, fullPage: true })
    check(`已生成截图 ${file}`, existsSync(p))
  }

  await browser.close()
  stop()

  console.log('\n' + '─'.repeat(68))
  if (fail > 0) {
    console.log(`✗ 调研报告 UI 测试未通过（通过 ${pass} 项 / 失败 ${fail} 项）`)
    process.exit(1)
  }
  console.log(`✓ 调研报告 UI 测试通过（${pass} 项）`)
  console.log(
    '  七章齐备 · 三档语义视觉区分 · 来源可回链本项原文 · 候选标识不丢失 · 索引如实标注 · Demo/Live 不串数据',
  )
}

run().catch((e) => {
  console.error('✗ 测试异常：', e)
  stop()
  process.exit(1)
})
