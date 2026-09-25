#!/usr/bin/env node
/**
 * 研究空白 UI 验收（Phase 4-6 UI）—— 真浏览器。
 *
 * ── 为什么必须再跑一遍浏览器 ──
 *
 * gap-test.mjs（128 断言）证明了 detectGaps() 这个纯函数是对的；
 * gap-api-test.mjs（8 节）证明了接口返回的数据是对的。
 * 但这一阶段的改动**全在前端**，上面两层一条都测不到：
 *
 *   · stated 与 candidate 必须**分区渲染**，不能合成一个列表
 *   · candidate 必须**醒目标记**"候选 / 系统推断"，且区块整体带警示底色
 *   · 顶部统计（stated / candidate / total）要真的显示出来
 *   · 点 Evidence 要能打开证据抽屉，且抽屉里是**这个项目**的原文
 *   · 0 条 Gap 要显示成"当前语料没有足够 Evidence"，**不能**是"加载失败"
 *   · 真接口报错时才是错误态
 *
 * 接口全绿而页面把 stated 和 candidate 混成一个列表、或者点开证据
 * 看到的是演示论文的原文 —— 这些都是本脚本才抓得到的。
 *
 * ── 四组夹具 ──
 *
 *   G1 明确局限：单篇论文写明 limitation → 必须出现 stated 区块内容
 *   G2 多篇共缺：两篇论文都写"未在长程任务上评估" → 必须出现 candidate
 *   G3 干净语料：只有中性描述 → 必须出现空状态（不是错误）
 *   G4 不存在：路由到一个没有 bundle 的项目 → 必须出现错误态
 *
 * ⚠️ G2 是最容易假绿的一组：如果夹具没真的产出 candidate，
 * "候选区块"那一整节就是在验证不存在的场景。所以脚本开头先直接
 * fetch 接口做**地勘**，确认 G1 有 stated、G2 有 candidate、G3 全空，
 * 不满足立刻退出并说明夹具本身不成立。
 *
 * 用法：pnpm gap:ui-test   （需先 pnpm build）
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.GAP_UI_PORT ?? 8982)
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

const storeDir = mkdtempSync(path.join(tmpdir(), 'mpgapui-'))
const uploadDir = mkdtempSync(path.join(tmpdir(), 'mpgapui-up-'))

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

/* ── G1：单篇论文明确写出 limitation → stated ── */
writeProject({
  id: 'proj_gap_ui_stated',
  name: '明确局限夹具',
  papers: [{ paper_id: 'P001', title: 'ReAct: Reasoning and Acting', year: 2022 }],
  methods: [
    {
      method_id: 'M001',
      name: 'ReAct',
      name_zh: '推理-行动',
      year: 2022,
      task: '交替推理与行动',
      core_idea: '在推理与行动之间交替',
      paradigm: 'Prompting',
      paper_ids: ['P001'],
      evidence_ids: ['E001', 'E002'],
    },
  ],
  evidence: [
    {
      evidence_id: 'E001',
      paper_id: 'P001',
      section: '方法',
      page: 2,
      content: 'We propose ReAct, interleaving reasoning and acting.',
      translation: '我们提出 ReAct，交替进行推理与行动。',
      method_ids: ['M001'],
    },
    {
      evidence_id: 'E002',
      paper_id: 'P001',
      section: '局限',
      page: 8,
      /*
       * 这句原文必须同时满足：
       *   · 命中 limitation 句式（"a limitation ... is that"）
       *   · 有实质文本（≥12 字符）
       * 且它**只出现在一篇论文里**，所以只出 stated、不出 candidate ——
       * 这样 G1 才是一个纯净的 stated 夹具。
       */
      content:
        'A limitation of our approach is that it does not scale to long-horizon tasks, which we leave to future work.',
      translation: '我们方法的一个局限是它无法扩展到长程任务，这一点我们留给未来工作。',
      method_ids: ['M001'],
    },
  ],
})

/* ── G2：两篇论文共同缺失 → candidate ── */
const G2_PAPERS = [
  { paper_id: 'P001', title: 'ReAct: Reasoning and Acting', year: 2022 },
  { paper_id: 'P002', title: 'Reflexion: Language Agents with Verbal RL', year: 2023 },
]
const G2_METHODS = [
  {
    method_id: 'M001',
    name: 'ReAct',
    name_zh: '推理-行动',
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
    year: 2023,
    task: '语言化自我反思',
    core_idea: '用语言反馈改进后续尝试',
    paradigm: 'Agent',
    paper_ids: ['P002'],
    evidence_ids: ['E002'],
  },
]
writeProject({
  id: 'proj_gap_ui_candidate',
  name: '多篇共缺夹具',
  papers: G2_PAPERS,
  methods: G2_METHODS,
  evidence: [
    {
      evidence_id: 'E001',
      paper_id: 'P001',
      section: '局限',
      page: 8,
      content: 'A limitation is that our method has not been evaluated on long-horizon tasks.',
      translation: '一个局限是我们的方法尚未在长程任务上进行评估。',
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

/* ── G3：干净语料（只有中性描述）→ 空状态 ── */
writeProject({
  id: 'proj_gap_ui_clean',
  name: '干净语料夹具',
  papers: G2_PAPERS,
  methods: G2_METHODS,
  evidence: [
    {
      evidence_id: 'E001',
      paper_id: 'P001',
      section: '方法',
      page: 2,
      content: 'We propose ReAct, interleaving reasoning and acting with tool feedback.',
      translation: '我们提出 ReAct，结合工具反馈交替进行推理与行动。',
      method_ids: ['M001'],
    },
    {
      evidence_id: 'E002',
      paper_id: 'P002',
      section: '方法',
      page: 3,
      content: 'Reflexion learns from verbal self-reflection signals.',
      translation: 'Reflexion 从语言化自我反思信号中学习。',
      method_ids: ['M002'],
    },
  ],
})

/* ------------------------------------------------------------------ */

const run = async () => {
  if (!(await waitReady())) {
    stop()
    console.log('✗ 服务端未能启动，无法运行研究空白 UI 测试')
    process.exit(1)
  }

  /*
   * ── 地勘：先确认夹具本身成立 ──
   *
   * 这一步是防"整节假绿"的关键。
   * 如果 G2 的夹具其实没产出 candidate（比如证据文本写错、或者
   * 两句话命中的语义坐标不同），后面"候选区块"那一整节就是在
   * 验证一个不存在的场景，全绿也没有任何意义。
   */
  console.log('═'.repeat(68))
  console.log('研究空白 UI 测试（Phase 4-6 UI）')
  console.log('═'.repeat(68))
  section('— 0. 夹具地勘（夹具不成立则后续断言无意义）—')

  const api = async (pid) => {
    const r = await fetch(`${BASE}/api/projects/${pid}/gaps`)
    return { status: r.status, body: await r.json().catch(() => null) }
  }

  const g1 = await api('proj_gap_ui_stated')
  const g2 = await api('proj_gap_ui_candidate')
  const g3 = await api('proj_gap_ui_clean')

  check(
    'G1 夹具必须真的产出 stated（否则第 1、2 节无从验证）',
    g1.body?.data?.stats?.stated > 0,
    `stated=${g1.body?.data?.stats?.stated}`,
  )
  check(
    'G1 夹具必须**不**产出 candidate（保证它是纯净的 stated 夹具）',
    g1.body?.data?.stats?.candidate === 0,
    `candidate=${g1.body?.data?.stats?.candidate}`,
  )
  check(
    'G2 夹具必须真的产出 candidate（否则第 3 节假绿）',
    g2.body?.data?.stats?.candidate > 0,
    `candidate=${g2.body?.data?.stats?.candidate}`,
  )
  check(
    'G2 的 candidate 必须挂到多篇论文的证据',
    !!g2.body?.data?.gaps?.some(
      (g) => g.assertion_level === 'candidate' && g.evidence_ids.length >= 2,
    ),
  )
  check(
    'G3 夹具必须是 0 条 Gap（否则空状态一节无从验证）',
    g3.body?.data?.gaps?.length === 0,
    `gaps=${g3.body?.data?.gaps?.length}`,
  )
  check(
    'G3 夹具的 corpus_has_gap_intent 必须为 false',
    g3.body?.data?.context?.corpus_has_gap_intent === false,
  )

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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  /*
   * 等"只有数据到了才会出现"的**选择器**，而不是等静态标题。
   * 等错信号（比如等页面标题「研究空白」，那是骨架就有的）
   * 是 UI 测试假红/假绿最大的来源。
   */
  const waitAttr = (sel, timeout = 20000) =>
    page.waitForSelector(sel, { timeout }).catch(() => null)

  /* ================================================================== */
  section('— 1. G1（明确局限）：stated 区块渲染 + 顶部统计 —')
  /* ================================================================== */

  await page.goto(`${BASE}/project/proj_gap_ui_stated/gaps`, { waitUntil: 'domcontentloaded' })
  await waitAttr('[data-gaps-page="live"]')

  const statedSection = await page.locator('[data-gap-section="stated"]').count()
  const candSection = await page.locator('[data-gap-section="candidate"]').count()
  check('存在 stated 区块', statedSection === 1, `实际 ${statedSection}`)
  check('存在 candidate 区块（即使为空也要有，供用户理解分层）', candSection === 1, `实际 ${candSection}`)

  const g1StatedCards = await page.locator('[data-gap-level="stated"]').count()
  const g1CandCards = await page.locator('[data-gap-level="candidate"]').count()
  check(
    'G1 渲染出 stated 卡片',
    g1StatedCards > 0,
    `实际 ${g1StatedCards}`,
  )
  check('G1 不渲染 candidate 卡片', g1CandCards === 0, `实际 ${g1CandCards}`)

  /* stated 必须带「论文明确指出」字样，而不是只有颜色 */
  const g1Body = await page.evaluate(() => document.body.innerText)
  check('stated 卡片显示「论文明确指出」', g1Body.includes('论文明确指出'))
  check('页面含 stated 小节头', g1Body.includes('论文明确指出') && g1Body.includes('可直接引用'))

  /* 顶部统计必须与接口一致 */
  const readStat = async (k) => {
    const t = await page.locator(`[data-gap-stat="${k}"]`).first().innerText().catch(() => '-1')
    return Number(String(t).trim())
  }
  const stTotal = await readStat('total')
  const stStated = await readStat('stated')
  const stCand = await readStat('candidate')
  const apiG1 = g1.body.data.stats
  check('顶部 total 与接口一致', stTotal === apiG1.total, `${stTotal} vs ${apiG1.total}`)
  check('顶部 stated 与接口一致', stStated === apiG1.stated, `${stStated} vs ${apiG1.stated}`)
  check('顶部 candidate 与接口一致', stCand === apiG1.candidate, `${stCand} vs ${apiG1.candidate}`)

  /* 分区小节头的计数也要对 */
  const secStated = Number(
    String(await page.locator('[data-gap-stat="stated-section"]').first().innerText().catch(() => '-1')).trim(),
  )
  const secCand = Number(
    String(await page.locator('[data-gap-stat="candidate-section"]').first().innerText().catch(() => '-1')).trim(),
  )
  check('stated 小节计数与接口一致', secStated === apiG1.stated, `${secStated} vs ${apiG1.stated}`)
  check('candidate 小节计数与接口一致', secCand === apiG1.candidate, `${secCand} vs ${apiG1.candidate}`)

  /* candidate 为 0 时必须有明确的"为什么没有"说明，不能只是空白 */
  check(
    g1Body.includes('没有系统推断出的候选空白'),
    'candidate 为 0 时给出明确说明（而不是空白）',
  )

  /* 信号类型 / 主题 / 置信度必须可见 */
  const g1Cards = await page.locator('[data-gap-id]').evaluateAll((els) =>
    els.map((e) => ({
      id: e.getAttribute('data-gap-id'),
      level: e.getAttribute('data-gap-level'),
      signal: e.getAttribute('data-gap-signal'),
    })),
  )
  check('每张 Gap 卡都带 gap_id / level / signal 三个标识', g1Cards.every((c) => c.id && c.level && c.signal))
  check(
    'signal 是四类之一',
    g1Cards.every((c) => ['limitation', 'open_problem', 'missing_comparison', 'uncovered_setting'].includes(c.signal)),
    g1Cards.map((c) => c.signal).join(','),
  )
  check('页面上出现信号类型中文名', /明确局限|开放问题|缺失对比|未覆盖场景/.test(g1Body))
  check('页面上出现主题标注', /主题：/.test(g1Body))
  check('页面上出现置信度', /置信度/.test(g1Body))

  /* 与接口逐条对齐 */
  const apiG1StatedIds = g1.body.data.gaps
    .filter((g) => g.assertion_level === 'stated')
    .map((g) => g.gap_id)
  const domG1StatedIds = g1Cards.filter((c) => c.level === 'stated').map((c) => c.id)
  check(
    'DOM 上的 stated gap_id 与接口完全一致',
    JSON.stringify(domG1StatedIds) === JSON.stringify(apiG1StatedIds),
    `${domG1StatedIds.join(',')} vs ${apiG1StatedIds.join(',')}`,
  )

  /* ================================================================== */
  section('— 2. G1：stated 卡片不带任何「候选」字样 —')
  /* ================================================================== */

  const g1CardTexts = await page
    .locator('[data-gap-level="stated"]')
    .evaluateAll((els) => els.map((e) => e.innerText))

  check(
    'stated 卡片正文不含「候选」「系统推断」字样',
    g1CardTexts.every((t) => !/候选|系统推断/.test(t)),
    g1CardTexts.map((t) => t.slice(0, 40)).join(' | '),
  )
  check(
    'stated 卡片带 stated 徽标',
    (await page.locator('[data-gap-badge="stated"]').count()) === g1StatedCards,
    `徽标 ${await page.locator('[data-gap-badge="stated"]').count()} / 卡片 ${g1StatedCards}`,
  )

  /* ================================================================== */
  section('— 3. G2（多篇共缺）：candidate 醒目区隔 + 措辞合规 —')
  /* ================================================================== */

  await page.goto(`${BASE}/project/proj_gap_ui_candidate/gaps`, { waitUntil: 'domcontentloaded' })
  await waitAttr('[data-gap-section="candidate"]')

  const g2StatedCards = await page.locator('[data-gap-level="stated"]').count()
  const g2CandCards = await page.locator('[data-gap-level="candidate"]').count()
  check('G2 渲染出 candidate 卡片', g2CandCards > 0, `实际 ${g2CandCards}`)
  check('G2 同时渲染出 stated 卡片（逐条原文必须保留）', g2StatedCards > 0, `实际 ${g2StatedCards}`)

  const apiG2 = g2.body.data.stats
  check(
    'G2 的 stated 卡片数 = 接口 stated',
    g2StatedCards === apiG2.stated,
    `${g2StatedCards} vs ${apiG2.stated}`,
  )
  check(
    'G2 的 candidate 卡片数 = 接口 candidate',
    g2CandCards === apiG2.candidate,
    `${g2CandCards} vs ${apiG2.candidate}`,
  )

  /* candidate 必须带醒目的「候选 · 系统推断」徽标 */
  const candBadges = await page.locator('[data-gap-badge="candidate"]').count()
  check('每条 candidate 都带候选徽标', candBadges === g2CandCards, `${candBadges} / ${g2CandCards}`)

  const candTexts = await page
    .locator('[data-gap-level="candidate"]')
    .evaluateAll((els) => els.map((e) => e.innerText))
  check(
    'candidate 卡片出现「候选」字样',
    candTexts.every((t) => t.includes('候选')),
  )
  check(
    'candidate 卡片出现「系统推断」字样',
    candTexts.some((t) => t.includes('系统推断')),
    candTexts.map((t) => t.split('\n')[1] ?? '').join(' | '),
  )

  /* 区块级警示：整体说明"不是论文原话，不要直接引用" */
  const notice = page.locator('[data-gap-candidate-notice="1"]')
  check('candidate 区块带整体警示条', (await notice.count()) === 1)
  const noticeText = await notice.first().innerText().catch(() => '')
  check(
    '警示条明写「推断」且说明不是原话',
    /推断/.test(noticeText) && /不是.*原话|不是任何一篇论文/.test(noticeText),
    noticeText.slice(0, 60),
  )

  /* 分层不混：candidate 卡片里不得出现 stated 徽标，反之亦然 */
  const candBadgeStated = await page
    .locator('[data-gap-level="candidate"] [data-gap-badge="stated"]')
    .count()
  const statedBadgeCand = await page
    .locator('[data-gap-level="stated"] [data-gap-badge="candidate"]')
    .count()
  check('分层不混：candidate 卡内无 stated 徽标', candBadgeStated === 0, `实际 ${candBadgeStated}`)
  check('分层不混：stated 卡内无候选徽标', statedBadgeCand === 0, `实际 ${statedBadgeCand}`)

  /* 顺序：stated 区块必须在 candidate 区块**之前**（DOM 顺序） */
  const order = await page.evaluate(() => {
    const s = document.querySelector('[data-gap-section="stated"]')
    const c = document.querySelector('[data-gap-section="candidate"]')
    if (!s || !c) return 'missing'
    return s.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING ? 'stated-first' : 'candidate-first'
  })
  check('stated 区块排在 candidate 之前', order === 'stated-first', order)

  /* candidate 置信度必须低于 stated（视觉上也要能看出来） */
  const confs = await page
    .locator('[data-gap-confidence]')
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-gap-confidence'))))
  check(
    '所有置信度都在 0-1 之间',
    confs.length > 0 && confs.every((c) => c >= 0 && c <= 1),
    confs.join(','),
  )

  /* ================================================================== */
  section('— 4. Evidence 回链：点开抽屉看到**本项目的**原文 —')
  /* ================================================================== */

  /*
   * 这一步防的是最恶劣的一类错：
   * EvidenceDrawer 挂在 <Routes> 之外，按 evidence_id 反查注册表；
   * 查不到时会**回落到 Demo 的 getEvidence()**。
   * 于是点开真实项目的 #E001，抽屉里显示演示论文的原文 ——
   * 看起来完全正常，实际张冠李戴。
   *
   * 所以断言不能只验"抽屉打开了"，必须验"抽屉里是 G2 的原文"。
   */
  const firstEvidenceBtn = page.locator('[data-gap-evidence-open]').first()
  const evBtnOk = (await firstEvidenceBtn.count()) > 0
  check('Gap 卡上有可点击的 Evidence 入口', evBtnOk)

  if (evBtnOk) {
    const evId = await firstEvidenceBtn.getAttribute('data-gap-evidence-open')
    await firstEvidenceBtn.click()
    await waitAttr('[data-evidence-drawer="1"]', 6000)

    const drawerOpen = (await page.locator('[data-evidence-drawer="1"]').count()) === 1
    check('点击 Evidence 打开了证据抽屉', drawerOpen)

    /*
     * ⚠️ 断言必须**只扫抽屉内部**，不能扫 document.body。
     *
     * 页面正文里也有"长程任务"这类字眼（Gap 描述里就写着），
     * 扫整页的话，抽屉其实显示了 Demo 演示语料（错）也照样通过 ——
     * 这是一个已经踩过的假绿：注入"不注册数据集"后测试仍全绿，
     * 而真实抽屉里显示的是 SWE-agent / NeurIPS 2024 的演示原文。
     *
     * 所以这里把 scanner 收窄到抽屉根节点。
     */
    const drawerText = await page
      .locator('[data-evidence-drawer="1"]')
      .innerText()
      .catch(() => '')

    check('抽屉非空', drawerText.length > 0, `${drawerText.length} 字符`)
    check('抽屉引用了当前 Gap 的证据 id', evId ? drawerText.includes(evId) : false, `期望 ${evId}`)
    check(
      '抽屉里是本项目原文（含 long-horizon / 长程任务）',
      /long-horizon|长程任务/.test(drawerText),
      '若显示的是演示论文原文，说明 registerDataset 缺失 → 回落到 Demo 数据',
    )
    /*
     * 反向排除：Demo 语料的特征串。这条才是真正抓"回落 Demo"的断言 ——
     * 上面那条正向断言在"正文恰好命中"时会漏，这条不会。
     */
    check(
      '抽屉里**不**含 Demo 演示语料特征（SWE-agent / NeurIPS / ACI）',
      !/SWE-agent|NeurIPS|agent-computer interface|ACI/i.test(drawerText),
      drawerText.slice(0, 120).replace(/\n/g, ' '),
    )
    check(
      '抽屉里**不**含演示论文标题',
      !/Agent-Computer Interfaces/i.test(drawerText),
    )

    /* 证据归属：抽屉里显示的论文必须是本项目的 P001 */
    check(
      '抽屉里显示的证据归属本项目论文（ReAct）',
      /ReAct/i.test(drawerText) || !/论文/i.test(drawerText),
      '若显示"来源论文"是别的标题即为张冠李戴',
    )
    const apiEv = g2.body.data.gaps.flatMap((g) => g.evidence_ids)
    check('接口确实给出过这些证据 id', apiEv.length > 0)

    /*
     * 抽屉是 fixed 全屏浮层，不关掉会拦截后续所有 pointer 事件
     * （表现为 click 超时并报 "subtree intercepts pointer events"）。
     * 按 Esc 关掉 —— 这也是用户真实的关闭方式，顺带验了它能关。
     */
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    const drawerClosed =
      (await page.locator('[data-evidence-drawer="1"]').count()) === 0
    check('按 Esc 能关闭证据抽屉（不残留浮层）', drawerClosed)
  }

  /* 展开详情后，证据列表里的每一条都应可点 */
  const expandBtn = page.locator('[data-gap-level="candidate"] button', { hasText: '展开详情' }).first()
  if ((await expandBtn.count()) > 0) {
    await expandBtn.click()
    await page.waitForTimeout(400)
    const inner = await page.locator('[data-gap-evidence-list="1"]').first().count()
    check('展开详情后出现证据回链列表', inner > 0)
    const basis = await page.locator('[data-gap-basis="1"]').first().count()
    check('展开详情后出现判定依据', basis > 0)
    const guess = await page.locator('[data-gap-guess]').first().count()
    check('展开详情后出现「缺口方面（推测）」', guess > 0)
    const guessText = await page.locator('[data-gap-guess]').first().innerText().catch(() => '')
    check(
      '缺口方面的措辞明确标为推测（不是事实）',
      /推测|推断/.test(guessText),
      guessText,
    )
  }

  /* ================================================================== */
  section('— 5. G3（干净语料）：空状态 ≠ 错误态 —')
  /* ================================================================== */

  await page.goto(`${BASE}/project/proj_gap_ui_clean/gaps`, { waitUntil: 'domcontentloaded' })
  await waitAttr('[data-gap-empty="all"]')

  const cleanBody = await page.evaluate(() => document.body.innerText)
  check('显示空状态', cleanBody.includes('当前语料没有足够 Evidence'))
  check(
    '空状态说明了原因（当前语料没有证据 / 没人写过局限）',
    /没有任何一条明确写出局限|不足以构成|没有足够 Evidence/.test(cleanBody),
  )
  check(
    '空状态明说「这不是加载失败」',
    cleanBody.includes('这不是加载失败'),
    '0 条 ≠ 失败，两者视觉与文案必须能区分',
  )
  check(
    '空状态**不**出现「加载失败」',
    !cleanBody.includes('研究空白加载失败'),
  )
  check(
    '空状态给出下一步建议',
    /增加|补充|全文证据/.test(cleanBody),
  )

  const cleanCards = await page.locator('[data-gap-id]').count()
  check('空状态不渲染任何 Gap 卡', cleanCards === 0, `实际 ${cleanCards}`)
  const cleanWarn = await page.locator('[data-gap-warning]').count()
  check('空状态不显示不变量告警（数据本身没问题）', cleanWarn === 0, `实际 ${cleanWarn}`)

  /* 反向：G1 不该出现空状态 */
  await page.goto(`${BASE}/project/proj_gap_ui_stated/gaps`, { waitUntil: 'domcontentloaded' })
  await waitAttr('[data-gaps-page="live"]')
  const g1Back = await page.evaluate(() => document.body.innerText)
  check(
    'G1（有 Gap）不出现空状态文案',
    !g1Back.includes('当前语料没有足够 Evidence'),
  )

  /* ================================================================== */
  section('— 6. G4（不存在的项目）：真错误才是错误态 —')
  /* ================================================================== */

  /*
   * 路由到一个没有 bundle 的 live 项目 id：
   * loadDataset 会 404，页面应显示错误态而非空状态。
   * 这确保"错误"与"没数据"在 UI 上确实分得开。
   */
  await page.goto(`${BASE}/project/proj_does_not_exist_xyz/gaps`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const errBody = await page.evaluate(() => document.body.innerText)
  check(
    '不存在的项目显示错误态而非空状态',
    /加载失败|不存在|失败/.test(errBody) && !errBody.includes('当前语料没有足够 Evidence'),
    errBody.slice(0, 80).replace(/\n/g, ' '),
  )

  /* ================================================================== */
  section('— 7. Demo 项目：原有人工标注页面未被破坏 —')
  /* ================================================================== */

  /*
   * 本轮改动把 GapsPage 重写了。Demo 项目（proj-aicoding-agent）走的是
   * 知识库人工标注分支，**必须仍然可用** —— 它不该被新接口牵连。
   */
  await page.goto(`${BASE}/project/proj-aicoding-agent/gaps`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const demoBody = await page.evaluate(() => document.body.innerText)
  check('Demo 项目仍渲染研究空白页', demoBody.includes('研究空白'))
  check(
    'Demo 走人工标注分支（出现判定方法学说明，非新接口文案）',
    demoBody.includes('空白判定方法'),
    'Demo 分支应完整保留',
  )
  const demoIsLive = await page.locator('[data-gaps-page="live"]').count()
  check('Demo 项目不进入 Live 分支', demoIsLive === 0, `实际 ${demoIsLive}`)

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
    ['proj_gap_ui_candidate', 'phase4-6-研究空白-分层.png'],
    ['proj_gap_ui_stated', 'phase4-6-研究空白-明确局限.png'],
    ['proj_gap_ui_clean', 'phase4-6-研究空白-空状态.png'],
  ]
  for (const [pid, file] of shots) {
    await page.goto(`${BASE}/project/${pid}/gaps`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(800)
    const p = path.join(shotDir, file)
    await page.screenshot({ path: p, fullPage: true })
    check(`已生成截图 ${file}`, existsSync(p))
  }

  await browser.close()
  stop()

  console.log('\n' + '─'.repeat(68))
  if (fail > 0) {
    console.log(`✗ 研究空白 UI 测试未通过（通过 ${pass} 项 / 失败 ${fail} 项）`)
    process.exit(1)
  }
  console.log(`✓ 研究空白 UI 测试通过（${pass} 项）`)
  console.log(
    '  stated / candidate 分区渲染 · 候选措辞醒目 · 统计与接口一致 · Evidence 回链本项语料 · 空状态与错误态可区分',
  )
}

run().catch((e) => {
  console.error('✗ 测试异常：', e)
  stop()
  process.exit(1)
})
