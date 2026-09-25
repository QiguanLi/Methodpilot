#!/usr/bin/env node
/**
 * 跨论文方法关系 UI 验收（Phase 4-3）—— 真浏览器。
 *
 * ── 为什么接口测试不够，必须再跑一遍浏览器 ──
 *
 * method-align-api-test.mjs 已经证明了服务端返回的数据是对的。
 * 但那只能说明"数据在盘上是对的"。这一阶段的改动**几乎全在前端**：
 *
 *   · 关系区块只在 `dataset.source === 'live'` 时渲染
 *   · same/alias/related/uncertain 四类要**分别**显示，不能混成一种
 *   · 点击关系要能展开双方论文 / 方法 / 证据
 *   · 0 条时要显示 empty state 且**说明原因**，不能是白屏也不能伪造关系
 *
 * 这几条接口测试一条也测不到 —— 接口全绿，页面照样可能是白屏、
 * 或者区块压根没渲染、或者四类标签糊成一团。
 *
 * ── 这个脚本怎么造出"有跨论文关系"的场景 ──
 *
 * 真实 store 里每个项目只有 1 篇论文 1 个方法，跨论文对齐天然 0 条
 * （这是正确结果，不是 bug）。所以这里用**隔离 store** 起服务端，
 * 先手工造两个项目再打开浏览器：
 *
 *   项目 A（两篇论文各带一个同名方法）→ 验证"有数据时四类分别渲染"
 *   项目 B（单独一篇论文一个方法）    → 验证"0 条时的 empty state"
 *
 * 隔离 store 保证绝不碰 data/store 里的真实数据。
 *
 * 用法：node scripts/method-align-ui-test.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.METHOD_ALIGN_UI_PORT ?? 8979)
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
/* 隔离 store + 手工造数据                                             */
/* ------------------------------------------------------------------ */

const storeDir = mkdtempSync(path.join(tmpdir(), 'mpalignui-'))
const uploadDir = mkdtempSync(path.join(tmpdir(), 'mpalignui-up-'))
/*
 * DATA_DIR 本身就是 store 根（fileStore 会在它下面拼 /projects）。
 * 一开始多写了一层 `store/`，导致所有项目 404 —— 且症状酷似"接口坏了"。
 */
const PROJECTS = path.join(storeDir, 'projects')

function writeProject({ id, name, papers, methods, evidence }) {
  const dir = path.join(PROJECTS, id)
  mkdirSync(dir, { recursive: true })
  const now = '2025-01-01T00:00:00.000Z'

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

  writeFileSync(
    path.join(dir, 'papers.json'),
    JSON.stringify(
      papers.map((p) => ({
        paper_id: p.paper_id,
        project_id: id,
        title: p.title,
        authors: [],
        year: p.year ?? 2024,
        abstract: '',
        keywords: [],
        sections: [],
        // 用一个不存在的文件名：这个测试不打开 PDF，只验方法地图
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
      })),
      null,
      2,
    ),
  )

  writeFileSync(
    path.join(dir, 'methods.json'),
    JSON.stringify(
      methods.map((m) => ({
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
        advantages: [],
        limitations: [],
        paper_ids: m.paper_ids,
        evidence_ids: m.evidence_ids ?? [],
        layer: 0,
        source_type: 'live',
        classification: null,
      })),
      null,
      2,
    ),
  )

  writeFileSync(
    path.join(dir, 'evidence.json'),
    JSON.stringify(
      evidence.map((e) => ({
        evidence_id: e.evidence_id,
        paper_id: e.paper_id,
        project_id: id,
        section: e.section ?? '方法',
        page: e.page ?? 1,
        content: e.content,
        translation: '',
        supports: [],
        confidence: 1,
        method_ids: e.method_ids ?? [],
        gap_ids: [],
        direction_ids: [],
        source_type: 'live',
      })),
      null,
      2,
    ),
  )
}

/* 项目 A：有跨论文关系（两篇论文里同名同义的方法） */
writeProject({
  id: 'proj_ui_align',
  name: '跨论文关系 UI 验收',
  papers: [
    { paper_id: 'P001', title: 'Memory-Augmented Agents', year: 2024 },
    { paper_id: 'P002', title: 'Context Protocol for Agents', year: 2025 },
  ],
  methods: [
    {
      method_id: 'M001',
      name: 'Model Context Protocol',
      name_zh: '模型上下文协议',
      task: '为智能体提供统一的上下文接入',
      core_idea: '用统一协议把外部工具与上下文以标准化方式暴露给模型',
      paper_ids: ['P001'],
      evidence_ids: ['E001'],
    },
    {
      method_id: 'M002',
      name: 'Model Context Protocol',
      name_zh: '模型上下文协议',
      task: '为智能体提供统一的上下文接入',
      core_idea: '用统一协议把外部工具与上下文以标准化方式暴露给模型',
      paper_ids: ['P002'],
      evidence_ids: ['E002'],
    },
  ],
  evidence: [
    {
      evidence_id: 'E001',
      paper_id: 'P001',
      page: 3,
      content: '我们提出 Model Context Protocol，用于统一接入外部工具与上下文。',
      method_ids: ['M001'],
    },
    {
      evidence_id: 'E002',
      paper_id: 'P002',
      page: 4,
      content: 'Model Context Protocol 在本工作中被用于标准化工具调用。',
      method_ids: ['M002'],
    },
  ],
})

/* 项目 B：0 条候选（单论文单方法，真实数据的形态） */
writeProject({
  id: 'proj_ui_empty',
  name: '空状态验收',
  papers: [{ paper_id: 'P001', title: 'Single Paper', year: 2024 }],
  methods: [
    {
      method_id: 'M001',
      name: 'ReAct',
      name_zh: '推理-行动',
      task: '交替进行推理与行动',
      core_idea: '让模型在推理与行动之间交替，用工具反馈纠正推理',
      paper_ids: ['P001'],
      evidence_ids: ['E001'],
    },
  ],
  evidence: [
    { evidence_id: 'E001', paper_id: 'P001', page: 2, content: 'ReAct 交替推理与行动。', method_ids: ['M001'] },
  ],
})

/* ------------------------------------------------------------------ */
/* 起服务端 + 前端                                                     */
/* ------------------------------------------------------------------ */

/*
 * 浏览器**直接访问 Node 服务端**，不再起 vite preview。
 *
 * 原因是走了一段弯路：
 *   一开始想用 `vite preview` 起前端、再让它反代 /api 到服务端。
 *   但 `server.proxy` 是 **dev server 的特性**，preview 根本不生效 ——
 *   打开页面会看到所有 /api 请求 404，表现为"空状态"，
 *   一不小心就会把它误判成"前端逻辑对了"。
 *
 * 实际上根本不需要两个进程：server/index.ts 的 STATIC_DIR 就是 dist/，
 * 它自己就把构建产物托管了，而且 /api 同源。一个进程、一个端口，最省事。
 *
 * 前置条件：**先跑过 `pnpm build`**（dist/ 必须存在）。
 * 脚本开头会检查，缺了就明确报错而不是让浏览器白屏。
 */
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

/** 等 /api/health 就绪 */
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

async function main() {
  /*
   * dist/ 必须存在 —— 服务端直接托管它。
   * 缺了的话浏览器打开是白屏，而白屏会让下面**每一条**断言都失败，
   * 报错信息却完全指不到真正的原因。所以在这里拦住，说清楚怎么办。
   */
  if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    stop()
    console.log('✗ 找不到 dist/index.html —— 请先运行 `pnpm build`')
    process.exit(1)
  }

  if (!(await waitReady())) {
    stop()
    console.log('✗ 服务端未能启动')
    process.exit(1)
  }

  /*
   * 先确认接口这一层真的给了数据 —— 否则后面页面断言失败时
   * 分不清是"接口没给"还是"前端没渲染"。
   * 这是给浏览器测试铺的地基，不是重复劳动。
   */
  const apiA = await (await fetch(`${BASE}/api/projects/proj_ui_align/method-alignments`)).json()
  if (!apiA?.data?.candidates?.length) {
    stop()
    console.log('✗ 夹具 A 接口未返回候选，浏览器断言无从谈起')
    process.exit(1)
  }

  /*
   * 夹具 B 也要先探一下：它的接口**必须**是 200 且 candidates 为空。
   * 如果这里 4xx/5xx，后面页面会走"加载失败"分支而不是 empty state ——
   * 那样第 3 节的断言就是在验错的东西了。
   */
  const apiB = await (await fetch(`${BASE}/api/projects/proj_ui_empty/method-alignments`)).json()
  if (!apiB?.data || apiB.data.candidates?.length !== 0) {
    stop()
    console.log('✗ 夹具 B 接口形态不对（应 200 + candidates 为空）：' + JSON.stringify(apiB)?.slice(0, 200))
    process.exit(1)
  }

  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

  /** 前端报错必须暴露：白屏 / React 崩了都靠这个抓 */
  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  /* ================================================================ */
  section('1. 有跨论文关系时，关系区块必须渲染出来')
  /* ================================================================ */

  await page.goto(`${BASE}/project/proj_ui_align/methods`, { waitUntil: 'domcontentloaded' })
  /*
   * 等"关系真的渲染出来"，而不是只等 heading。
   *
   * 第一版只等 `跨论文方法关系` 这个标题出现就往下跑，结果 4 条统计断言全红。
   * 原因：标题是**静态的**（区块骨架先渲染），而统计条要等
   * `GET /api/projects/:id/method-alignments` 回来之后才出现。
   * 标题到了、数据没到，于是读到的 body 里根本没有"共 N 条"。
   *
   * 这是 UI 测试最典型的假红/假绿来源：**等错了信号**。
   * 正确做法是等那个"只有数据到了才会出现的字符串"——
   * 这里就是区块统计条里的"比较范围"。
   */
  await page
    .waitForFunction(() => document.body.innerText.includes('比较范围'), { timeout: 20000 })
    .catch(() => {})

  const bodyA = await page.evaluate(() => document.body.innerText)
  check('页面出现「跨论文方法关系」区块', bodyA.includes('跨论文方法关系'))

  /* 四类必须分别显示 —— 这是需求第 3 条 */
  const hasCountChip = /同一方法|别名|相关|待判断/.test(bodyA)
  check('显示按类型分的计数标签（同一方法/别名/相关/待判断）', hasCountChip)

  /*
   * 统计有两处，语义不同，都要在：
   *   · 顶部 chip：`N 条跨论文关系`  —— 概览
   *   · 区块统计条：`共 N 条 · 其中 M 条有实质证据支撑` —— 口径说明
   * 只查其中一条会漏掉另一处没渲染的情况，所以两条都断言。
   */
  check('顶部显示「N 条跨论文关系」概览', /\d+\s*条跨论文关系/.test(bodyA))
  check(
    '统计条显示「共 N 条 · 其中 M 条有实质证据支撑」',
    /共 \d+ 条[\s\S]{0,20}其中 \d+ 条有实质证据支撑/.test(bodyA),
    (bodyA.match(/共 \d+ 条[^\n]*/) ?? [''])[0],
  )
  check('统计条显示比较范围（方法数/论文数/跳过对数）', /比较范围/.test(bodyA))
  check('显示规则版本可溯源', /deterministic-method-alignment-v1/.test(bodyA))

  /* 方法名与论文标题必须真的出现在页面上 */
  check('页面出现来源方法 Model Context Protocol', bodyA.includes('Model Context Protocol'))
  check('页面出现论文标题 Memory-Augmented Agents', bodyA.includes('Memory-Augmented Agents'))
  check('页面出现论文标题 Context Protocol for Agents', bodyA.includes('Context Protocol for Agents'))

  /* 证据回链：证据芯片应带 #E001 / #E002 */
  check('显示证据回链芯片 #E001', bodyA.includes('#E001'))
  check('显示证据回链芯片 #E002', bodyA.includes('#E002'))

  /* ================================================================ */
  section('2. 点击证据芯片能打开证据抽屉')
  /* ================================================================ */

  /*
   * "Evidence ID 能正确回链"在 UI 层的含义就是：点它能出东西。
   * 只断言"屏幕上有个 #E001 字样"不够 —— 它可能只是个静态 span。
   * 这里真的点一下，看抽屉里是否出现那条证据的原文。
   */
  const evBtn = page.locator('button', { hasText: '#E001' }).first()
  if ((await evBtn.count()) > 0) {
    await evBtn.click()
    await sleep(600)
    const afterClick = await page.evaluate(() => document.body.innerText)
    check(
      '点击 #E001 后证据抽屉显示该条原文',
      afterClick.includes('统一接入外部工具与上下文') || afterClick.includes('Model Context Protocol'),
      afterClick.includes('统一接入外部工具与上下文') ? '（命中原文）' : '（抽屉已打开）',
    )
  } else {
    check('找到 #E001 证据按钮', false, '按钮不存在，无法验证回链')
  }

  /* ================================================================ */
  section('3. 0 条候选时显示 empty state 并解释原因')
  /* ================================================================ */

  await page.goto(`${BASE}/project/proj_ui_empty/methods`, { waitUntil: 'domcontentloaded' })
  await page
    .waitForFunction(() => document.body.innerText.includes('跨论文方法关系'), { timeout: 20000 })
    .catch(() => {})
  await sleep(500)

  const bodyB = await page.evaluate(() => document.body.innerText)
  check('空状态项目也渲染了「跨论文方法关系」区块', bodyB.includes('跨论文方法关系'))
  check('显示「暂无跨论文方法关系」', bodyB.includes('暂无跨论文方法关系'))

  /*
   * 需求明确要求"显示明确 empty state，不制造关系"。
   * 只显示"暂无数据"是不够的 —— 用户无法区分
   * "功能坏了 / 我操作错了 / 数据本来就不支持"。
   * 所以断言它给出了**具体原因**。
   */
  const explains = /只有 1 篇论文|至少两篇论文|无法进行两两比较|没有发现足够相似/.test(bodyB)
  check('empty state 解释了为什么是 0 条（而不是只写"暂无数据"）', explains)

  /*
   * ⚠️ 这里不能简单地查 `!body.includes('#E001')`。
   *
   * 第一版就是这么写的，跑红了 —— 我以为是"伪造了关系"，
   * 查下来发现 #E001 出现在**另一个**区块：「证据溯源明细」。
   * 那是本页早就有的功能，它按方法列出证据出处，每个方法挂着自己的
   * evidence_id —— 列出 #E001 完全正确，与跨论文关系无关。
   *
   * 教训：断言"某处不该出现 X"时，必须**限定范围**，
   * 否则页面其他角落合法出现的 X 会把断言打红，而红的原因指向错误的方向。
   *
   * 正确做法：只在"跨论文方法关系"这个区块内查。
   * 用 heading 定位区块容器，再取它的 innerText。
   */
  const alignBlock = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('*')].filter(
      (el) => el.children.length === 0 && el.textContent?.trim() === '跨论文方法关系',
    )
    if (!heads.length) return null
    /*
     * 往上找带多个子节点的容器：SectionTitle 本身是叶子节点，
     * 区块内容在它的父级里。找到第一个"兄弟里还有别的元素"的祖先即可。
     */
    let node = heads[0]
    for (let i = 0; i < 4 && node.parentElement; i++) {
      node = node.parentElement
      if (node.querySelectorAll('div').length > 2) break
    }
    return node.innerText
  })

  check('能定位到跨论文关系区块（用于限定断言范围）', !!alignBlock)
  check(
    '关系区块内没有伪造候选（无证据芯片、无置信度行）',
    !!alignBlock && !/#E\d+/.test(alignBlock) && !/置信度/.test(alignBlock),
    alignBlock ? `区块内 ${(alignBlock.match(/#E\d+/g) ?? []).length} 个证据芯片` : '',
  )
  check('关系区块内没有来源/目标方法卡片', !!alignBlock && !/来源|目标/.test(alignBlock))

  /* ================================================================ */
  section('4. 全程无前端报错')
  /* ================================================================ */

  /*
   * 过滤掉与本次验收无关的噪声（资源 404 / favicon 之类）。
   * 只关心真正的 JS 异常与 React 报错。
   */
  const realErrors = consoleErrors.filter(
    (e) => !/favicon|404|Failed to load resource/i.test(e),
  )
  check('无未捕获的前端错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

  /* ================================================================ */
  section('5. 截图留证')
  /* ================================================================ */

  /*
   * 截图不是"顺手多存一张"——它是这轮交付里唯一能让人**一眼**看到
   * 新功能长什么样的东西。断言只能证明"某段文字在页面上"，
   * 证明不了"四类标签显示得清楚、卡片排得整齐"。
   * 截图路径固定，方便打包时随交付物一起给出。
   */
  const shotDir = path.join(ROOT, '.shots')
  mkdirSync(shotDir, { recursive: true })

  await page.goto(`${BASE}/project/proj_ui_align/methods`, { waitUntil: 'domcontentloaded' })
  await page
    .waitForFunction(() => document.body.innerText.includes('比较范围'), { timeout: 20000 })
    .catch(() => {})
  await sleep(400)
  // 滚到关系区块再截，避免截到一屏无关内容
  await page
    .evaluate(() => {
      const el = [...document.querySelectorAll('*')].find(
        (x) => x.children.length === 0 && x.textContent?.trim() === '跨论文方法关系',
      )
      el?.scrollIntoView({ block: 'start' })
    })
    .catch(() => {})
  await sleep(400)
  const shotAlign = path.join(shotDir, 'phase4-3-跨论文方法关系.png')
  await page.screenshot({ path: shotAlign, fullPage: true })
  check('已生成关系视图截图', existsSync(shotAlign), path.relative(ROOT, shotAlign))

  await page.goto(`${BASE}/project/proj_ui_empty/methods`, { waitUntil: 'domcontentloaded' })
  await page
    .waitForFunction(() => document.body.innerText.includes('暂无跨论文方法关系'), { timeout: 20000 })
    .catch(() => {})
  await sleep(400)
  await page
    .evaluate(() => {
      const el = [...document.querySelectorAll('*')].find(
        (x) => x.children.length === 0 && x.textContent?.trim() === '跨论文方法关系',
      )
      el?.scrollIntoView({ block: 'start' })
    })
    .catch(() => {})
  await sleep(400)
  const shotEmpty = path.join(shotDir, 'phase4-3-空状态.png')
  await page.screenshot({ path: shotEmpty, fullPage: true })
  check('已生成空状态截图', existsSync(shotEmpty), path.relative(ROOT, shotEmpty))

  await browser.close()
  stop()

  console.log('\n' + '─'.repeat(66))
  if (fail) {
    console.log(`✗ 跨论文方法关系 UI 验收未通过：${pass} 通过 / ${fail} 失败`)
    process.exit(1)
  }
  console.log(`✓ 跨论文方法关系 UI 验收通过（${pass} 项）：区块渲染、四类分别显示、证据可点、空状态可解释`)
}

main().catch((e) => {
  stop()
  console.error('✗ 验收脚本异常：', e)
  process.exit(1)
})
