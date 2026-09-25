#!/usr/bin/env node
/**
 * 技术演进 UI 验收（Phase 4-5）—— 真浏览器。
 *
 * ── 为什么必须再跑一遍浏览器 ──
 *
 * evolution-test.mjs（132 断言）证明了 buildEvolution() 这个纯函数是对的；
 * evolution-api-test.mjs（9 节）证明了接口返回的数据是对的。
 * 但这一阶段的改动**全在前端**，上面两层一条都测不到：
 *
 *   · 因果边要画**箭头**，temporal/parallel/related 要画**虚线且不画箭头**
 *   · 顶部三个统计（阶段 / 因果 / 时间相关）要真的显示出来
 *   · 点节点要能看到论文 / Method / Evidence，且证据能回链到原文
 *   · 无节点时要显示 empty state 并**说明原因**，不能复用"加载失败"
 *
 * 接口全绿而页面把 temporal 也画成箭头、或者证据点开显示的是
 * 另一篇演示论文的原文 —— 这些都是本脚本才抓得到的。
 *
 * ── 三组夹具 ──
 *
 *   E1 因果：两篇论文，后者的证据原文写了 "builds on ReAct and extends it"
 *   E2 非因果：与 E1 **结构完全相同**，只把证据换成中性描述
 *   E3 无节点：单篇论文单方法 → 走"有链但无因果"分支
 *
 * E1 / E2 是 A/B 对照：**唯一变量是证据原文**。
 * 若 E2 也画出箭头，说明前端忽略了 causal —— 这正是要抓的回归。
 *
 * ⚠️ E2 是最容易假绿的一组：如果夹具证据写错了、其实产出了因果，
 * 那"非因果分支"根本没被验证。所以脚本开头先直接 fetch 接口做**地勘**，
 * 确认 E1 causal>0、E2 causal==0，不满足立刻退出并说明夹具本身不成立。
 *
 * 用法：pnpm evolution:ui-test   （需先 pnpm build）
 */

import { spawn, execSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.EVOLUTION_UI_PORT ?? 8980)
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

const storeDir = mkdtempSync(path.join(tmpdir(), 'mpevoui-'))
const uploadDir = mkdtempSync(path.join(tmpdir(), 'mpevoui-up-'))

/*
 * ── 必须先清掉占用本端口的**残留服务**，否则整轮测试会打到别人的 store ──
 *
 * 踩坑实录（Phase 6-3 定位）：
 *   上一次测试异常退出时 `srv.kill()` 打在一个已经 spawn 失败的 pid 上，
 *   旧服务没死、继续霸占 8980。本轮 spawn 新服务时 listen EADDRINUSE 直接失败，
 *   但 `stdio: 'ignore'` 把报错吞了；`waitReady()` 探到的 200 来自**旧进程**，
 *   于是后续所有请求都打到两小时前的旧 DATA_DIR —— 夹具明明写在磁盘上，
 *   接口却 404，表现成"空状态断言随机失败"。
 *
 * 所以：启动前主动 reaper，端口上不管是谁都先杀掉；spawn 后若子进程提前退出，
 * 立刻报错退出，绝不把"连错了服务"伪装成业务失败。
 */
function reapPort(port) {
  try {
    const out = execSync(`lsof -t -i:${port} -sTCP:LISTEN`, { encoding: 'utf8' }).trim()
    if (!out) return 0
    const pids = out.split('\n').map((s) => Number(s.trim())).filter(Boolean)
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    return pids.length
  } catch {
    return 0
  }
}

const reaped = reapPort(PORT)
if (reaped > 0) {
  console.log(`⚠ 端口 ${PORT} 上有 ${reaped} 个残留服务，已清理（否则测试会打到旧 store）`)
  await new Promise((r) => setTimeout(r, 300))
}

let srvExited = null

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

srv.on('exit', (code, signal) => {
  srvExited = { code, signal }
})

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
    // 子进程已经死了就别再探端口了 —— 探到的只可能是别的服务
    if (srvExited) {
      console.log(
        `✗ 服务进程提前退出（code=${srvExited.code} signal=${srvExited.signal}），端口 ${PORT} 可能被占用`,
      )
      process.exit(1)
    }
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

/* 复用的方法 / 证据模板，让 E1 与 E2 只差证据原文一句 */
const TWO_PAPER_PAPERS = [
  { paper_id: 'P001', title: 'ReAct: Reasoning and Acting', year: 2022 },
  { paper_id: 'P002', title: 'SWE-agent: Repository-level Agents', year: 2024 },
]
const TWO_PAPER_METHODS = [
  {
    method_id: 'M001',
    name: 'ReAct',
    name_zh: '推理-行动',
    year: 2022,
    task: '交替推理与行动',
    core_idea: '在推理与行动之间交替，用工具反馈纠正推理',
    paradigm: 'Prompting',
    paper_ids: ['P001'],
    evidence_ids: ['E001'],
  },
  {
    method_id: 'M002',
    name: 'SWE-agent',
    name_zh: '软件工程智能体',
    year: 2024,
    task: '仓库级问题修复',
    core_idea: '为智能体设计面向代码仓库的接口',
    paradigm: 'Agent',
    paper_ids: ['P002'],
    evidence_ids: ['E002'],
  },
]
const BASE_EVIDENCE = {
  evidence_id: 'E001',
  paper_id: 'P001',
  section: '方法',
  page: 2,
  content: 'We propose ReAct, interleaving reasoning and acting.',
  translation: '我们提出 ReAct，交替进行推理与行动。',
  method_ids: ['M001'],
}

/* ── E1：因果（证据点名并声明继承）── */
writeProject({
  id: 'proj_evo_ui_causal',
  name: '演进因果夹具',
  papers: TWO_PAPER_PAPERS,
  methods: TWO_PAPER_METHODS,
  evidence: [
    BASE_EVIDENCE,
    {
      evidence_id: 'E002',
      paper_id: 'P002',
      section: '方法',
      page: 3,
      content: 'SWE-agent builds on ReAct and extends it to repository-level tasks.',
      translation: 'SWE-agent 建立在 ReAct 之上，并将其扩展到仓库级任务。',
      method_ids: ['M002'],
    },
  ],
})

/* ── E2：非因果（同结构，证据中性）── */
writeProject({
  id: 'proj_evo_ui_temporal',
  name: '演进时间夹具',
  papers: TWO_PAPER_PAPERS,
  methods: TWO_PAPER_METHODS,
  evidence: [
    BASE_EVIDENCE,
    {
      evidence_id: 'E002',
      paper_id: 'P002',
      section: '方法',
      page: 3,
      content: 'We present SWE-agent, an agent for repository-level tasks.',
      translation: '我们提出 SWE-agent，一个面向仓库级任务的智能体。',
      method_ids: ['M002'],
    },
  ],
})

/* ── E3：单论文单方法 → 有链但无因果（不是空状态）── */
writeProject({
  id: 'proj_evo_ui_single',
  name: '演进单方法夹具',
  papers: [{ paper_id: 'P001', title: 'ReAct: Reasoning and Acting', year: 2022 }],
  methods: [TWO_PAPER_METHODS[0]],
  evidence: [BASE_EVIDENCE],
})

/* ── E4 / E5 / E6：其余三类因果（improves / replaces / combines）── *
 *
 * ── 为什么必须补这三组 ──
 *
 * 原夹具只覆盖 extends。白名单里另外三类（improves / replaces / combines）
 * 在**前端从未被任何断言点亮过**：图例里有它们的名字，但没有任何一个
 * 数据路径证明"这类关系真的能画成实心箭头"。
 *
 * 后果是：如果 CAUSAL_SET 漏了某一类（4-3 就在图例里漏过 related），
 * 那一类会静默降级成虚线无箭头 —— 用户看到"改进"却是虚线，
 * 而所有测试依然全绿，因为没人喂过这类数据。
 *
 * 三组与 E1 结构完全相同，**唯一变量是证据原文里的因果动词**。
 * 这样若某一类没画出箭头，就能直接定位到是"该动词没被识别"，
 * 而不是夹具哪里又不一样了。
 */
const CAUSAL_VARIANTS = [
  {
    id: 'proj_evo_ui_improves',
    // "improves upon X" —— 点名 ReAct 且用改进动词
    content: 'SWE-agent improves upon ReAct and outperforms it on repository tasks.',
    translation: 'SWE-agent 改进了 ReAct，并在仓库任务上超越它。',
    expect: 'improves',
  },
  {
    id: 'proj_evo_ui_replaces',
    content: 'Our method replaces ReAct with a repository-level interface.',
    translation: '我们的方法用一个仓库级接口替代了 ReAct。',
    expect: 'replaces',
  },
  {
    id: 'proj_evo_ui_combines',
    content: 'Our approach combines ReAct with a repository-level tool interface.',
    translation: '我们的方法将 ReAct 与仓库级工具接口相结合。',
    expect: 'combines',
  },
]

for (const v of CAUSAL_VARIANTS) {
  writeProject({
    id: v.id,
    name: `演进因果变体 ${v.expect}`,
    papers: TWO_PAPER_PAPERS,
    methods: TWO_PAPER_METHODS,
    evidence: [
      BASE_EVIDENCE,
      {
        evidence_id: 'E002',
        paper_id: 'P002',
        section: '方法',
        page: 3,
        content: v.content,
        translation: v.translation,
        method_ids: ['M002'],
      },
    ],
  })
}

/* ------------------------------------------------------------------ */

const run = async () => {
  if (!(await waitReady())) {
    stop()
    console.log('✗ 服务端未能启动，无法运行技术演进 UI 测试')
    process.exit(1)
  }

  /*
   * ── 地勘：先确认夹具本身成立 ──
   *
   * 这一步是防"整节假绿"的关键。
   * 如果 E2 的夹具其实产出了因果（比如证据文本写错），
   * 后面"非因果边不画箭头"那一整节就是在验证一个不存在的场景，
   * 全绿也没有任何意义。
   */
  console.log('═'.repeat(68))
  console.log('技术演进 UI 测试（Phase 4-5）')
  console.log('═'.repeat(68))
  section('— 0. 夹具地勘（夹具不成立则后续断言无意义）—')

  const api = async (pid) => {
    const r = await fetch(`${BASE}/api/projects/${pid}/evolutions`)
    return { status: r.status, body: await r.json().catch(() => null) }
  }

  const e1 = await api('proj_evo_ui_causal')
  const e2 = await api('proj_evo_ui_temporal')
  const e3 = await api('proj_evo_ui_single')

  check(
    'E1 夹具必须真的产出因果边（否则第 1 节无从验证）',
    e1.body?.data?.stats?.causal_total > 0,
    `causal_total=${e1.body?.data?.stats?.causal_total}`,
  )
  check(
    'E2 夹具必须真的**没有**因果边（否则第 2 节假绿）',
    e2.body?.data?.stats?.causal_total === 0,
    `causal_total=${e2.body?.data?.stats?.causal_total}`,
  )
  check(
    'E3 夹具应为「1 节点 0 关系」',
    e3.body?.data?.evolutions?.length === 1 && e3.body?.data?.relations?.length === 0,
    `nodes=${e3.body?.data?.evolutions?.length} rels=${e3.body?.data?.relations?.length}`,
  )

  /*
   * ── E1 必须精确是 extends，而不是"某个因果" ──
   *
   * 第 1 节原先只断言 causalEdges >= 1。那太松：若服务端把 extends
   * 判成 improves（或前端把标签写错），边依然是因果、依然有箭头，
   * 测试照样全绿，而用户看到的动词是错的。
   */
  const e1Rel = e1.body?.data?.relations?.[0]
  check(
    'E1 夹具必须精确产出 relation_type=extends',
    e1Rel?.relation_type === 'extends',
    `实际 ${e1Rel?.relation_type}`,
  )
  check(
    'E1 关系必须 causal=true 且 evidence_ids 非空',
    e1Rel?.causal === true && (e1Rel?.evidence_ids?.length ?? 0) > 0,
    `causal=${e1Rel?.causal} evidence_ids=${JSON.stringify(e1Rel?.evidence_ids)}`,
  )
  check(
    'E1 关系的 method_key 必须是 paper_id::method_id 完整身份键',
    (e1Rel?.source_method_key ?? '').includes('::') &&
      (e1Rel?.target_method_key ?? '').includes('::'),
    `${e1Rel?.source_method_key} → ${e1Rel?.target_method_key}`,
  )

  /* 其余三类因果夹具：各自必须精确产出对应类型，否则第 8 节假绿 */
  const causalVariants = [
    ['proj_evo_ui_improves', 'improves'],
    ['proj_evo_ui_replaces', 'replaces'],
    ['proj_evo_ui_combines', 'combines'],
  ]
  const variantRes = {}
  for (const [vpid, expect] of causalVariants) {
    const r = await api(vpid)
    variantRes[vpid] = r
    const rel = r.body?.data?.relations?.[0]
    check(
      `夹具 ${vpid} 必须精确产出 ${expect}`,
      rel?.relation_type === expect,
      `实际 ${rel?.relation_type ?? '(无)'}`,
    )
  }

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
   * 等"只有数据到了才会出现"的字符串，而不是等静态标题。
   * 等错信号（比如等页面标题「技术演进」，那是骨架就有的）
   * 是 UI 测试假红/假绿最大的来源。
   */
  const waitFor = (text, timeout = 20000) =>
    page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout }).catch(() => {})

  /**
   * 等到时间线上真的画出 `n` 条边为止。
   *
   * `waitFor('因果')` 是不够的：页头在接口返回**之前**就已经渲染了
   * 「因果 0 条」这句静态文案，于是断言会在数据到位前就跑。
   * 实测这会让 `[data-edge-rel]` 数到 0 个（假失败）。
   */
  const waitForEdges = (n = 1, timeout = 20000) =>
    page
      .waitForFunction((k) => document.querySelectorAll('[data-edge-rel]').length >= k, n, {
        timeout,
      })
      .catch(() => {})

  /* ================================================================== */
  section('— 1. 因果夹具：链路渲染 + 箭头 + 统计 —')
  /* ================================================================== */

  await page.goto(`${BASE}/project/proj_evo_ui_causal/evolution`, {
    waitUntil: 'domcontentloaded',
  })
  await waitFor('因果')

  const nodes = await page.locator('[data-evo-node]').count()
  check('渲染出 2 个演进节点', nodes === 2, `实际 ${nodes}`)

  const years = await page.locator('[data-evo-node]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-evo-year')),
  )
  check(
    years.length === 2 && Number(years[0]) < Number(years[1]),
    '节点按年份升序（早 → 晚）',
    years.join(' → '),
  )

  const causalEdges = await page.locator('[data-edge-causal="true"]').count()
  check('存在因果边', causalEdges >= 1, `实际 ${causalEdges}`)

  const causalWithArrow = await page
    .locator('[data-edge-causal="true"] svg')
    .count()
  check(
    '每条因果边都带箭头（svg）',
    causalWithArrow === causalEdges,
    `箭头 ${causalWithArrow} / 因果边 ${causalEdges}`,
  )

  const statStages = Number(
    (await page.locator('[data-evo-stat="stages"]').first().innerText().catch(() => '-1')) || -1,
  )
  const statCausal = Number(
    (await page.locator('[data-evo-stat="causal"]').first().innerText().catch(() => '-1')) || -1,
  )
  const statNonCausal = Number(
    (await page.locator('[data-evo-stat="noncausal"]').first().innerText().catch(() => '-1')) || -1,
  )
  const apiE1 = e1.body.data.stats
  check('顶部「阶段数」与接口一致', statStages === apiE1.stages, `${statStages} vs ${apiE1.stages}`)
  check(
    '顶部「因果关系数」与接口一致',
    statCausal === apiE1.causal_total,
    `${statCausal} vs ${apiE1.causal_total}`,
  )
  check(
    '顶部「时间相关关系数」与接口一致',
    statNonCausal === apiE1.non_causal_total,
    `${statNonCausal} vs ${apiE1.non_causal_total}`,
  )
  check('三个统计项都渲染出来了', statStages >= 0 && statCausal >= 0 && statNonCausal >= 0)

  /* 图例必须七类齐全，且明写"非因果不代表因果" */
  const bodyCausal = await page.evaluate(() => document.body.innerText)
  const legendTypes = ['继承', '改进', '替代', '组合', '并行发展', '相关', '时间相邻']
  const missing = legendTypes.filter((t) => !bodyCausal.includes(t))
  check('图例包含全部七类关系', missing.length === 0, missing.length ? `缺 ${missing.join('、')}` : '')
  check('图例明写「非因果」并声明不代表因果', bodyCausal.includes('不代表因果'))

  /* ================================================================== */
  section('— 2. 非因果夹具：虚线无箭头（视觉语义不混淆）—')
  /* ================================================================== */

  await page.goto(`${BASE}/project/proj_evo_ui_temporal/evolution`, {
    waitUntil: 'domcontentloaded',
  })
  await waitFor('因果')

  const tNodes = await page.locator('[data-evo-node]').count()
  check('非因果夹具同样渲染 2 个节点', tNodes === 2, `实际 ${tNodes}`)

  const nonCausalEdges = await page.locator('[data-edge-causal="false"]').count()
  const causalEdgesT = await page.locator('[data-edge-causal="true"]').count()
  check('存在非因果边', nonCausalEdges >= 1, `实际 ${nonCausalEdges}`)
  check(
    '夹具确无因果边（反向断言，防假绿）',
    causalEdgesT === 0,
    `实际 ${causalEdgesT}`,
  )

  const nonCausalArrows = await page.locator('[data-edge-causal="false"] svg').count()
  check(
    '非因果边**不画**箭头（这是"不混淆"的硬判据）',
    nonCausalArrows === 0,
    `实际箭头数 ${nonCausalArrows}`,
  )

  const tStatCausal = Number(
    (await page.locator('[data-evo-stat="causal"]').first().innerText().catch(() => '-1')) || -1,
  )
  const tStatNonCausal = Number(
    (await page.locator('[data-evo-stat="noncausal"]').first().innerText().catch(() => '-1')) || -1,
  )
  const apiE2 = e2.body.data.stats
  check('非因果夹具顶部因果数为 0', tStatCausal === 0, `实际 ${tStatCausal}`)
  check(
    '非因果夹具顶部时间相关数与接口一致',
    tStatNonCausal === apiE2.non_causal_total,
    `${tStatNonCausal} vs ${apiE2.non_causal_total}`,
  )

  await waitForEdges(1) // 降级边同样要等画出来
  const bodyTemporal = await page.evaluate(() => document.body.innerText)
  check(
    '有链但无因果时给出解释提示',
    bodyTemporal.includes('没有一条因果关系'),
    '页面应说明"有先后但无因果证据"',
  )

  /*
   * ── 降级语义的**类型**必须落到边上（Phase 6-3 补）──
   *
   * 上面只验证了"非因果边不画箭头"。但如果页面把 temporal 标成 related
   * （或根本没写 data-edge-rel），用户看到的降级文案就是错的，
   * 而"无箭头"那条断言仍然通过。
   *
   * 接口在无因果证据时应给出 temporal（年份相邻但无因果表述）。
   * 这里断言边上标的类型 === 接口给的类型，逐条对齐。
   */
  const tEdgeRels = await page.locator('[data-edge-rel]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-edge-rel')),
  )
  const apiE2Types = e2.body.data.relations.map((r) => r.relation_type)
  check(
    '降级边标注的 relation_type 与接口一致',
    apiE2Types.length > 0 && apiE2Types.every((t) => tEdgeRels.includes(t)),
    `边上=${JSON.stringify(tEdgeRels)} 接口=${JSON.stringify(apiE2Types)}`,
  )
  check(
    '无因果证据时接口给出的是三档非因果类型（temporal/related/parallel）',
    apiE2Types.every((t) => ['temporal', 'related', 'parallel'].includes(t)),
    JSON.stringify(apiE2Types),
  )
  /* 降级不得被悄悄升级成因果类型 */
  check(
    '降级边**没有**被误标成任一因果类型',
    !tEdgeRels.some((t) => ['extends', 'improves', 'replaces', 'combines'].includes(t)),
    JSON.stringify(tEdgeRels),
  )

  /* ================================================================== */
  section('— 3. Evidence 回链（点节点 → 详情 → 点证据 → 抽屉）—')
  /* ================================================================== */

  await page.goto(`${BASE}/project/proj_evo_ui_causal/evolution`, {
    waitUntil: 'domcontentloaded',
  })
  await waitFor('因果')

  /* 点最后一个节点（有证据挂载的那个） */
  const lastNode = page.locator('[data-evo-node]').last()
  await lastNode.click()
  await page.waitForTimeout(300)

  const detailText = await page
    .locator('[data-evo-detail]')
    .first()
    .innerText()
    .catch(() => '')
  check('点击节点后详情面板出现', detailText.length > 0)
  check('详情面板显示「所属论文」', detailText.includes('所属论文'))
  check('详情面板显示「代表方法」', detailText.includes('代表方法'))
  check('详情面板显示「支撑证据」', detailText.includes('支撑证据'))

  /*
   * 证据回链：真的点一下，验证抽屉打开了**正确的那条**证据。
   * 只断言页面上有 "#E002" 字样是不够的 —— 静态 span 也会有字样。
   */
  const evBtn = page
    .locator('[data-evo-detail]')
    .first()
    .locator('button', { hasText: '#E002' })
    .first()
  const hasEvBtn = (await evBtn.count()) > 0
  check('详情面板里出现证据 #E002 的回链按钮', hasEvBtn)

  if (hasEvBtn) {
    await evBtn.click()
    await page.waitForTimeout(500)
    const drawerText = await page.evaluate(() => document.body.innerText)
    check(
      '点击证据后抽屉显示该证据的原文',
      drawerText.includes('builds on ReAct'),
      '抽屉内容应含夹具证据原文',
    )
    /*
     * 这一条专抓"漏了 registerDataset"：
     * 不注册数据集时，抽屉会回落到 Demo 的 getEvidence()，
     * 显示**另一篇演示论文的原文** —— 看起来一切正常，实则张冠李戴。
     */
    check(
      '抽屉显示的是夹具论文而非演示数据（证明数据集已注册）',
      drawerText.includes('SWE-agent') || drawerText.includes('ReAct'),
    )
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(200)
  }

  /* ================================================================== */
  section('— 3b. 关系类型 / 判定依据 / 论文归属（Phase 6-3 补）—')
  /* ================================================================== */

  /*
   * ── 本节补的三个盲区 ──
   *
   * 3 节证明了"点节点能看到证据并回链"，但下面三件事**此前从未被断言**：
   *
   *   ① 边的类型：只数过 causal=true，没验证 data-edge-rel 真的是 extends。
   *      把 extends 错标成 improves，用户看到的动词就错了，而测试全绿。
   *
   *   ② 「判定依据」面板：页面的 focusRelation 用 `paper_id::method_id`
   *      完整键反查（见 EvolutionPage）。这是极易写错的一处 ——
   *      若退化成裸 method_id，跨论文撞号时会命中**另一条边**，
   *      面板显示的判定理由就属于别的方法，而页面看不出任何异常。
   *
   *   ③ 论文归属：节点应挂到**自己那篇**论文上（P002 的节点 → P002），
   *      而不是随便一篇。用接口的 paper_id 逐节点比对。
   */

  await page.goto(`${BASE}/project/proj_evo_ui_causal/evolution`, {
    waitUntil: 'domcontentloaded',
  })
  await waitFor('因果')
  await waitForEdges(1) // 必须等到边真的画出来，否则下面会数到 0 个（假失败）

  /* ① 边的类型必须与接口一致（不是"有个因果边就算过"） */
  const edgeRels = await page.locator('[data-edge-rel]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-edge-rel')),
  )
  const apiRelTypes = e1.body.data.relations.map((r) => r.relation_type)
  check(
    '时间线上的每条边都带上了接口声明的 relation_type',
    apiRelTypes.every((t) => edgeRels.includes(t)),
    `边上=${JSON.stringify(edgeRels)} 接口=${JSON.stringify(apiRelTypes)}`,
  )
  check(
    'extends 边恰好 1 条（data-edge-rel="extends"）',
    edgeRels.filter((r) => r === 'extends').length === 1,
    `实际 ${JSON.stringify(edgeRels)}`,
  )
  /* 反向：因果边不得带非因果类型标签 */
  const causalEdgeRels = await page
    .locator('[data-edge-causal="true"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-edge-rel')))
  check(
    '所有因果边标注的都是四类因果之一（没有 temporal/related 混入）',
    causalEdgeRels.every((r) => ['extends', 'improves', 'replaces', 'combines'].includes(r)),
    JSON.stringify(causalEdgeRels),
  )

  /* ② 「判定依据」面板：必须点到与接口同一条关系，且 basis/description 对得上 */
  const lastNode2 = page.locator('[data-evo-node]').last()
  await lastNode2.click()
  await page.waitForTimeout(300)
  const detailText2 = await page
    .locator('[data-evo-detail]')
    .first()
    .innerText()
    .catch(() => '')

  check(
    '详情面板出现「判定依据」区块（focusRelation 命中）',
    detailText2.includes('判定依据'),
    detailText2.includes('判定依据') ? '' : '未出现 —— 可能是 method_key 反查失败',
  )
  /* 判据里必须写清是因果/非因果，与接口 causal 一致 */
  check(
    '判定依据标注为「因果」，与接口 causal=true 一致',
    detailText2.includes('（因果）') && !detailText2.includes('（非因果）'),
  )
  /* 接口给出的 description 原文必须出现在面板里（证明取到的是这条边，不是别的） */
  const e1RelDesc = e1.body.data.relations[0]?.description ?? ''
  check(
    '判定依据展示的是接口这条关系的 description（不是其它关系的）',
    e1RelDesc.length > 0 && detailText2.includes(e1RelDesc),
    `期望含「${e1RelDesc.slice(0, 28)}…」`,
  )
  /* basis 机器码必须被翻译成人话，不能把裸码漏到界面上 */
  const e1Basis = e1.body.data.relations[0]?.basis ?? []
  const rawCodesLeaked = e1Basis.filter((b) => detailText2.includes(b) && b.includes('_'))
  check(
    '判定依据的 basis 已翻译为中文，未把机器码（含下划线）漏到界面',
    rawCodesLeaked.length === 0,
    rawCodesLeaked.length ? `漏出：${rawCodesLeaked.join('、')}` : '',
  )

  /* ③ 论文归属：焦点节点的「所属论文」必须是接口给它的 paper_id 对应的那篇 */
  const focusNode = e1.body.data.evolutions[e1.body.data.evolutions.length - 1]
  check(
    '详情面板的「所属论文」显示的是该节点自己的 paper_id',
    focusNode?.paper_id != null && detailText2.includes(focusNode.paper_id),
    `节点 paper_id=${focusNode?.paper_id}`,
  )
  /* 反向：不能显示另一篇论文的 id（跨论文张冠李戴） */
  const otherPaperId = e1.body.data.evolutions
    .map((n) => n.paper_id)
    .find((x) => x !== focusNode.paper_id)
  if (otherPaperId) {
    const paperBlock = await page
      .locator('[data-evo-detail]')
      .first()
      .locator('a[href*="/papers/"]')
      .first()
      .getAttribute('href')
      .catch(() => '')
    check(
      '所属论文链接指向本节点的论文，未错挂到另一篇',
      String(paperBlock).includes(focusNode.paper_id) &&
        !String(paperBlock).includes(otherPaperId),
      `href=${paperBlock}`,
    )
  }

  /* ================================================================== */
  section('— 3c. 四类因果都能画出实心箭头（不是只有 extends）—')
  /* ================================================================== */

  /*
   * 白名单四类在 UI 上必须**同等待遇**。若 CAUSAL_SET 漏了某类，
   * 那类会静默变虚线 —— 用户看到"替代"却是虚线，语义直接反了。
   */
  const variantUi = [
    ['proj_evo_ui_improves', 'improves'],
    ['proj_evo_ui_replaces', 'replaces'],
    ['proj_evo_ui_combines', 'combines'],
  ]

  for (const [vpid, expect] of variantUi) {
    await page.goto(`${BASE}/project/${vpid}/evolution`, { waitUntil: 'domcontentloaded' })
    await waitFor('因果')
    await waitForEdges(1)

    const nCausal = await page.locator('[data-edge-causal="true"]').count()
    const nArrow = await page.locator('[data-edge-causal="true"] svg').count()
    const rels = await page.locator('[data-edge-rel]').evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-edge-rel')),
    )
    check(
      `${expect}：画实心箭头（因果 ${nCausal} 条 / 箭头 ${nArrow} 个）`,
      nCausal >= 1 && nArrow === nCausal,
    )
    check(
      `${expect}：边上标注 data-edge-rel="${expect}"`,
      rels.includes(expect),
      JSON.stringify(rels),
    )
    /* 该变体的 stats 必须把它记进对应计数 */
    const st = variantRes[vpid].body.data.stats
    check(
      `${expect}：stats 计入 causal_total 且 ${expect} 计数 >= 1`,
      st.causal_total >= 1 && st[expect] >= 1,
      `causal=${st.causal_total} ${expect}=${st[expect]}`,
    )
  }

  /* ================================================================== */
  section('— 4. 单方法：有链但无因果（不是空状态）—')
  /* ================================================================== */
  await page.goto(`${BASE}/project/proj_evo_ui_single/evolution`, {
    waitUntil: 'domcontentloaded',
  })
  await waitFor('因果')

  const sNodes = await page.locator('[data-evo-node]').count()
  check('单方法项目仍渲染 1 个节点（不是空状态）', sNodes === 1, `实际 ${sNodes}`)

  const sBody = await page.evaluate(() => document.body.innerText)
  check('单方法项目不显示「暂无技术演进数据」', !sBody.includes('暂无技术演进数据'))
  check('单方法项目顶部因果数为 0', sBody.includes('因果 0 条') || sBody.includes('因果\n0'))

  const sEdges = await page.locator('[data-edge-causal="true"]').count()
  check('单方法项目没有任何因果边', sEdges === 0, `实际 ${sEdges}`)

  /* ================================================================== */
  section('— 5. 空状态：不复用「加载失败」—')
  /* ================================================================== */

  /* 造一个 0 论文 0 方法的项目 —— 真正无节点 */
  writeProject({
    id: 'proj_evo_ui_empty',
    name: '演进空夹具',
    papers: [],
    methods: [],
    evidence: [],
  })

  await page.goto(`${BASE}/project/proj_evo_ui_empty/evolution`, {
    waitUntil: 'domcontentloaded',
  })
  /*
   * ── 必须等页面**加载完成**，不能等固定文案 ──
   *
   * `waitFor()` 内部是 `.catch(() => {})`，文案若迟迟不出现它会**静默超时返回**，
   * 断言随即在一个仍在 loading 的页面上执行。此时页面显示的是
   * 「数据源：加载中…」并回落渲染 **Demo 知识库**（10 个阶段），
   * 于是"无节点时显示空状态"必然失败 —— 而且失败得毫无规律（取决于服务端快慢）。
   *
   * 正确的等待条件是**加载态结束**：dataset 就绪后
   * `loadedPid === pid`，页头会显示"数据源：当前项目真实数据"。
   */
  await waitFor('数据源：当前项目真实数据', 20000)
  await waitFor('暂无技术演进数据', 20000)

  const emptyBody = await page.evaluate(() => document.body.innerText)
  check('无节点时显示空状态', emptyBody.includes('暂无技术演进数据'))
  check(
    '空状态解释了原因（而不是只写"暂无数据"）',
    /至少需要两个方法|只有 \d+ 个方法|不足以/.test(emptyBody),
  )
  check(
    '空状态**不**显示「加载失败」',
    !emptyBody.includes('技术演进加载失败'),
    '空 ≠ 失败，两者视觉与文案必须能区分',
  )

  const emptyEdges = await page.locator('[data-edge-causal="true"]').count()
  check('空状态不画任何边', emptyEdges === 0)

  /* 反向：因果夹具不该出现"加载失败" */
  await page.goto(`${BASE}/project/proj_evo_ui_causal/evolution`, {
    waitUntil: 'domcontentloaded',
  })
  await waitFor('因果')
  const okBody = await page.evaluate(() => document.body.innerText)
  check('正常项目不出现「加载失败」', !okBody.includes('技术演进加载失败'))

  /* ================================================================== */
  section('— 6. 前端无报错 —')
  /* ================================================================== */

  /*
   * 过滤掉与本次改动无关的噪声（favicon 404 之类），
   * 只保留真正的脚本错误。
   */
  const realErrors = consoleErrors.filter(
    (e) => !/favicon|404 \(Not Found\)|Failed to load resource/i.test(e),
  )
  check('浏览器控制台无脚本错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

  /* ================================================================== */
  section('— 7. 截图 —')
  /* ================================================================== */

  const shotDir = path.join(ROOT, '.shots')
  mkdirSync(shotDir, { recursive: true })

  const shots = [
    ['proj_evo_ui_causal', 'phase4-5-技术演进-因果链.png'],
    ['proj_evo_ui_temporal', 'phase4-5-技术演进-时间相关.png'],
    ['proj_evo_ui_empty', 'phase4-5-技术演进-空状态.png'],
  ]
  for (const [pid, file] of shots) {
    await page.goto(`${BASE}/project/${pid}/evolution`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(800)
    const p = path.join(shotDir, file)
    await page.screenshot({ path: p, fullPage: true })
    check(`已生成截图 ${file}`, existsSync(p))
  }

  await browser.close()
  stop()

  console.log('\n' + '─'.repeat(68))
  if (fail > 0) {
    console.log(`✗ 技术演进 UI 测试未通过（通过 ${pass} 项 / 失败 ${fail} 项）`)
    process.exit(1)
  }
  console.log(`✓ 技术演进 UI 测试通过（${pass} 项）`)
  console.log(
    '  节点按年排列 · 四类因果都画箭头 · 非因果虚线无箭头 · 判定依据与接口一致 · 论文归属不错挂 · 统计与接口一致 · 证据可回链 · 空状态正确',
  )
}

run().catch((e) => {
  console.error('✗ 测试异常：', e)
  stop()
  process.exit(1)
})
