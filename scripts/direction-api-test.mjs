/**
 * 研究方向 API 测试（Phase 4-7 UI 的服务端一半）。
 *
 * 只打 HTTP，**不直接调纯函数** —— 纯函数的行为已由 `direction:test` 覆盖。
 * 这一层的职责是验证「路由 + 链路复用 + 响应契约」：
 *
 *   1. 路由确实存在，且返回三件套（directions / stats / context）
 *   2. 依据分层自洽（candidate_only 布尔 ≡ basis_level === 'candidate_only'）
 *   3. candidate_only 的文案与置信度硬约束（推测前缀 + ≤0.5）
 *   4. 硬门槛：每个方向都必须关联 Gap 与 Evidence（stats 里的计数恒为 0）
 *   5. 全部可回链：evidence_ids ⊆ 其 gap_ids 的证据并集；方法来自项目方法池
 *   6. 统计一致
 *   7. 确定性：连续两次请求逐字节一致
 *   8. **0 条是空态不是错误**（200 + has_any_gap === false）
 *   9. **404 不伪装成空结果**（不存在的项目必须是错误）
 *
 * 第 8、9 条是这一组里最重要的：如果 404 也返回 `directions: []`，
 * 前端就无法区分「项目不存在」与「项目存在但没产出」，
 * 于是会把"打错了项目 id"显示成"该项目没有研究方向"。
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.DIRECTION_API_PORT ?? 8985)
const BASE = `http://127.0.0.1:${PORT}`

const errors = []
const check = (cond, msg) => {
  if (!cond) errors.push(msg)
}

/* ------------------------------------------------------------------ */
/* 起隔离服务端                                                        */
/* ------------------------------------------------------------------ */

const storeDir = mkdtempSync(path.join(tmpdir(), 'mpdir-'))
const uploadDir = mkdtempSync(path.join(tmpdir(), 'mpdir-up-'))

const srv = spawn(
  process.execPath,
  ['--experimental-strip-types', path.join(ROOT, 'server', 'index.ts')],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      /*
       * 独立 store。必须手写论文 / 方法 / 证据进盘：
       * 真实语料里几乎没有带缺口陈述的证据，验不到 candidate 那一支，
       * 也验不到 candidate_only 方向（它要求跨论文共性）。
       */
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

const get = (u) =>
  JSON.parse(spawnSync('curl', ['-s', `${BASE}${u}`], { encoding: 'utf8' }).stdout || 'null')

/*
 * 带状态码的 GET。必须**分两次 curl**：
 * 用 `-o /dev/stdout` 想在一次调用里同时拿 body 和状态码是行不通的 ——
 * `-o` 打开的是独立 fd，body 不会进 spawnSync 的 pipe，
 * 症状与"服务端没返回 error 字段"一模一样。
 */
const getWithStatus = (u) => {
  const body = spawnSync('curl', ['-s', `${BASE}${u}`], { encoding: 'utf8' }).stdout || ''
  const codeRaw =
    spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `${BASE}${u}`], {
      encoding: 'utf8',
    }).stdout || ''
  let json = null
  try {
    json = JSON.parse(body)
  } catch {}
  return { status: Number(codeRaw.trim()), body, json }
}

const ready = async () => {
  for (let i = 0; i < 40; i++) {
    const r = get('/api/health')
    if (r?.success) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

if (!(await ready())) {
  stop()
  console.log('✗ 服务端未能启动，无法运行研究方向 API 测试')
  process.exit(1)
}

/* ------------------------------------------------------------------ */
/* 造数据                                                              */
/* ------------------------------------------------------------------ */

/*
 * ⚠️ 路径约定：`config.storage.dir = DATA_DIR`，而 `fileStore.projectDir(id)`
 * 把它当成 store 根，再拼 `/projects/<id>`。
 * 也就是说 **DATA_DIR 本身就是 store 根**，不要再套一层 `store/`。
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
    /*
     * ⚠️ 必须回填 evidence_ids。
     * 4-4 的因果门槛 B 的入口就是 `later.evidence_ids`，
     * 空数组 ⇒ 永远不产生因果边 ⇒ 「已被后续工作改进」的降权测不到。
     */
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
    supports: e.supports ?? [],
    confidence: e.confidence ?? 1,
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

/* ================================================================== */
/* 夹具 D1：单篇论文明确写出 limitation → 必须产出 stated_backed        */
/* ================================================================== */

writeProject({
  id: 'proj_dir_stated',
  name: '明确的局限',
  papers: [{ paper_id: 'P001', title: 'ReAct', year: 2022 }],
  methods: [
    {
      method_id: 'M001',
      name: 'ReAct',
      name_zh: '推理-行动',
      year: 2022,
      task: '交替推理与行动',
      core_idea: '在推理与行动之间交替',
      paper_ids: ['P001'],
      evidence_ids: ['E002'],
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
      content:
        'A limitation of our approach is that it does not scale to long-horizon tasks, where the trajectory grows beyond the context budget.',
      translation:
        '我们方法的局限在于无法扩展到长周期任务，轨迹长度会超出上下文预算。',
      method_ids: ['M001'],
    },
  ],
})

/* ================================================================== */
/* 夹具 D2：跨两篇论文的共性缺口 → 应产出 candidate（并因此出现 mixed）  */
/* ================================================================== */

/*
 * 4-6 的 candidate 前提是「≥2 篇论文共享同一缺口模式」。
 * 这里让两篇论文各自写出"未在长程任务上评测"，
 * 于是除两条 stated 外还会聚出一个 candidate，
 * 同坐标下 stated + candidate 共存 ⇒ 4-7 合成 mixed 方向。
 */
writeProject({
  id: 'proj_dir_mixed',
  name: '跨论文共性缺口',
  papers: [
    { paper_id: 'P001', title: 'ReAct', year: 2022 },
    { paper_id: 'P002', title: 'Reflexion', year: 2023 },
  ],
  methods: [
    {
      method_id: 'M001',
      name: 'ReAct',
      year: 2022,
      task: '交替推理与行动',
      core_idea: '推理与行动交替',
      paper_ids: ['P001'],
      evidence_ids: ['E001'],
    },
    {
      method_id: 'M002',
      name: 'Reflexion',
      year: 2023,
      task: '语言化反思',
      core_idea: '用语言反馈自我改进',
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
      content: 'Our method has not been evaluated on long-horizon tasks.',
      translation: '我们的方法尚未在长程任务上评估。',
      method_ids: ['M001'],
    },
    {
      evidence_id: 'E002',
      paper_id: 'P002',
      section: '局限',
      page: 9,
      content: 'We have not tested our approach on long-horizon tasks.',
      translation: '我们尚未在长程任务上测试我们的方法。',
      method_ids: ['M002'],
    },
  ],
})

/* ================================================================== */
/* 夹具 D3：语料里没有任何缺口陈述 → 0 条方向（空态，不是错误）          */
/* ================================================================== */

writeProject({
  id: 'proj_dir_nogap',
  name: '没有缺口陈述',
  papers: [{ paper_id: 'P001', title: 'Plain', year: 2024 }],
  methods: [
    {
      method_id: 'M001',
      name: 'Plain',
      year: 2024,
      task: '普通方法',
      core_idea: '无',
      paper_ids: ['P001'],
      evidence_ids: ['E001'],
    },
  ],
  evidence: [
    {
      evidence_id: 'E001',
      paper_id: 'P001',
      section: '方法',
      page: 1,
      content: 'We present a plain method that works well.',
      translation: '我们提出一个运行良好的普通方法。',
      method_ids: ['M001'],
    },
  ],
})

/* ------------------------------------------------------------------ */
/* 断言                                                               */
/* ------------------------------------------------------------------ */

console.log('══════════════════════════════════════════════════════════════════════')
console.log('研究方向 API 测试（Phase 4-7 UI）')
console.log('══════════════════════════════════════════════════════════════════════')

const dirApi = (pid) => getWithStatus(`/api/projects/${pid}/directions`)

/* — 0. 地勘 — */
console.log('\n— 0. 夹具地勘（不成立则后续断言无意义）—')

const d1probe = dirApi('proj_dir_stated')
const d2probe = dirApi('proj_dir_mixed')
const d3probe = dirApi('proj_dir_nogap')

check(d1probe.status === 200, `D1 应返回 200，实际 ${d1probe.status}`)
check(d2probe.status === 200, `D2 应返回 200，实际 ${d2probe.status}`)
check(d3probe.status === 200, `D3 应返回 200，实际 ${d3probe.status}`)

const d1dirs = d1probe.json?.data?.directions ?? []
const d2dirs = d2probe.json?.data?.directions ?? []
const d3dirs = d3probe.json?.data?.directions ?? []

check(d1dirs.length > 0, `D1 必须产出方向，实际 ${d1dirs.length} 条`)
check(
  d1dirs.some((d) => d.basis_level === 'stated_backed'),
  'D1 必须存在 stated_backed 方向',
)
check(d3dirs.length === 0, `D3 必须产出 0 条方向，实际 ${d3dirs.length} 条`)

console.log(`   D1 方向 ${d1dirs.length} 条（levels: ${d1dirs.map((d) => d.basis_level).join(',')}）`)
console.log(`   D2 方向 ${d2dirs.length} 条（levels: ${d2dirs.map((d) => d.basis_level).join(',')}）`)
console.log(`   D3 方向 ${d3dirs.length} 条（预期 0）`)

if (d1dirs.length === 0) {
  stop()
  console.log('\n✗ 夹具不成立（D1 无方向），停止后续断言')
  process.exit(1)
}

/* — 1. 路由三件套 — */
console.log('\n— 1. 路由契约 —')

const payload = d1probe.json.data
check(Array.isArray(payload.directions), 'directions 必须是数组')
check(payload.stats && typeof payload.stats === 'object', 'stats 必须存在')
check(payload.context && typeof payload.context === 'object', 'context 必须存在')
check(
  Array.isArray(payload.invariant_violations),
  'invariant_violations 必须是数组',
)
check(
  payload.invariant_violations.length === 0,
  `不变量必须无违规，实际：${JSON.stringify(payload.invariant_violations)}`,
)
check(
  typeof payload.context.rule_version === 'string' && payload.context.rule_version.length > 0,
  'context.rule_version 必须是非空字符串',
)
check(
  /deterministic/.test(payload.context.rule_version),
  `rule_version 应标明确定性，实际 ${payload.context.rule_version}`,
)

/* — 2. 依据分层自洽 — */
console.log('\n— 2. 依据分层自洽 —')

const LEVELS = ['stated_backed', 'mixed', 'candidate_only']
for (const [label, dirs] of [
  ['D1', d1dirs],
  ['D2', d2dirs],
]) {
  for (const d of dirs) {
    check(
      LEVELS.includes(d.basis_level),
      `${label}/${d.direction_id} basis_level 非法：${d.basis_level}`,
    )
    /* 冗余字段必须一致 —— 前端大量依赖这个布尔 */
    check(
      d.candidate_only === (d.basis_level === 'candidate_only'),
      `${label}/${d.direction_id} candidate_only=${d.candidate_only} 与 basis_level=${d.basis_level} 不一致`,
    )
  }
}

/* — 3. candidate_only 的文案与置信度硬约束 — */
console.log('\n— 3. candidate_only 文案与置信度 —')

const allDirs = [...d1dirs, ...d2dirs]
const candidateOnly = allDirs.filter((d) => d.basis_level === 'candidate_only')

for (const d of candidateOnly) {
  check(
    d.title.startsWith('【推测方向】'),
    `${d.direction_id} candidate_only 标题缺少「推测方向」前缀：${d.title}`,
  )
  check(
    d.confidence <= 0.5,
    `${d.direction_id} candidate_only 置信度 ${d.confidence} 超过硬上限 0.5`,
  )
  /* 描述不得使用事实口吻 */
  check(
    !/论文(?:明确)?指出|原文(?:明确)?表明|已经证实|已被证实/.test(d.description),
    `${d.direction_id} candidate_only 描述出现事实口吻：${d.description}`,
  )
}

/* 反向：非 candidate_only 不得带推测前缀（否则标记与文案矛盾） */
for (const d of allDirs.filter((x) => x.basis_level !== 'candidate_only')) {
  check(
    !d.title.startsWith('【推测方向】'),
    `${d.direction_id} 为 ${d.basis_level} 却带「推测方向」前缀`,
  )
}

console.log(`   candidate_only 方向 ${candidateOnly.length} 条（若 0 条则本节为反向校验）`)

/* — 4. 硬门槛：必须关联 Gap + Evidence — */
console.log('\n— 4. 硬门槛：每个方向都能回链 —')

for (const d of allDirs) {
  check(d.gap_ids.length > 0, `${d.direction_id} 没有关联任何 Gap`)
  check(d.evidence_ids.length > 0, `${d.direction_id} 没有关联任何 Evidence`)
}

for (const [label, pl] of [
  ['D1', payload],
  ['D2', d2probe.json.data],
]) {
  check(
    pl.stats.directions_without_gap === 0,
    `${label} stats.directions_without_gap 应为 0，实际 ${pl.stats.directions_without_gap}`,
  )
  check(
    pl.stats.directions_without_evidence === 0,
    `${label} stats.directions_without_evidence 应为 0，实际 ${pl.stats.directions_without_evidence}`,
  )
}

/* — 5. 全部可回链：证据 ⊆ Gap 的证据；方法 ∈ 项目方法池 — */
console.log('\n— 5. 回链闭合性 —')

const d1undle = get('/api/projects/proj_dir_stated')
const d2undle = get('/api/projects/proj_dir_mixed')

for (const [label, dirs, bundle] of [
  ['D1', d1dirs, d1undle],
  ['D2', d2dirs, d2undle],
]) {
  const evIds = new Set((bundle?.data?.evidence ?? []).map((e) => e.evidence_id))
  const methodIds = new Set((bundle?.data?.methods ?? []).map((m) => m.method_id))
  const paperIds = new Set((bundle?.data?.papers ?? []).map((p) => p.paper_id))

  for (const d of dirs) {
    const missEv = d.evidence_ids.filter((x) => !evIds.has(x))
    check(missEv.length === 0, `${label}/${d.direction_id} 引用了不存在的证据：${missEv.join(',')}`)

    const missM = d.approach.based_on_method_ids.filter((x) => !methodIds.has(x))
    check(
      missM.length === 0,
      `${label}/${d.direction_id} 切入点引用了不存在的方法：${missM.join(',')}`,
    )

    const missP = d.paper_ids.filter((x) => !paperIds.has(x))
    check(
      missP.length === 0,
      `${label}/${d.direction_id} 引用了不存在的论文：${missP.join(',')}`,
    )
  }
}

/* D3 必须把 0 条解释清楚 */
check(
  d3probe.json.data.context.has_any_gap === false,
  `D3 context.has_any_gap 应为 false，实际 ${d3probe.json.data.context.has_any_gap}`,
)

/* — 6. 统计一致 — */
console.log('\n— 6. 统计一致 —')

for (const [label, pl] of [
  ['D1', payload],
  ['D2', d2probe.json.data],
]) {
  const s = pl.stats
  const dirs = pl.directions
  check(s.total === dirs.length, `${label} stats.total=${s.total} ≠ directions.length=${dirs.length}`)
  check(
    s.stated_backed + s.mixed + s.candidate_only === s.total,
    `${label} 三档之和 ${s.stated_backed + s.mixed + s.candidate_only} ≠ total ${s.total}`,
  )
  check(
    s.stated_backed === dirs.filter((d) => d.basis_level === 'stated_backed').length,
    `${label} stated_backed 计数不符`,
  )
  check(
    s.mixed === dirs.filter((d) => d.basis_level === 'mixed').length,
    `${label} mixed 计数不符`,
  )
  check(
    s.candidate_only === dirs.filter((d) => d.basis_level === 'candidate_only').length,
    `${label} candidate_only 计数不符`,
  )
  /* 信号分布四档之和也应等于 total（每个方向恰有一个信号） */
  check(
    s.limitation + s.open_problem + s.missing_comparison + s.uncovered_setting === s.total,
    `${label} 信号分布之和 ≠ total`,
  )
}

/* — 7. 确定性 — */
console.log('\n— 7. 确定性（同输入两次请求逐字节一致）—')

for (const pid of ['proj_dir_stated', 'proj_dir_mixed', 'proj_dir_nogap']) {
  const a = getWithStatus(`/api/projects/${pid}/directions`)
  const b = getWithStatus(`/api/projects/${pid}/directions`)
  check(
    a.body === b.body,
    `${pid} 两次请求响应不一致（输出不满足确定性要求）`,
  )
}

/* — 8. 0 条是空态不是错误 — */
console.log('\n— 8. 0 条方向 = 空态，不是错误 —')

check(d3probe.status === 200, `D3 应为 200，实际 ${d3probe.status}`)
check(d3probe.json?.success === true, 'D3 应返回 success: true')
check(d3dirs.length === 0, `D3 应为空数组，实际 ${d3dirs.length} 条`)
check(
  d3probe.json.data.invariant_violations.length === 0,
  'D3 空结果不应触发不变量违规',
)
check(
  d3probe.json.data.stats.gaps_considered === 0,
  `D3 gaps_considered 应为 0，实际 ${d3probe.json.data.stats.gaps_considered}`,
)

/* — 9. 404 不伪装成空结果 — */
console.log('\n— 9. 404 不伪装成空结果 —')

const nf = dirApi('proj_does_not_exist')
check(nf.status === 404, `不存在的项目应返回 404，实际 ${nf.status}`)
check(nf.json?.success === false, '不存在的项目应返回 success: false')
check(
  nf.json?.error?.code === 'PROJECT_NOT_FOUND',
  `错误码应为 PROJECT_NOT_FOUND，实际 ${nf.json?.error?.code}`,
)
check(
  !Array.isArray(nf.json?.data?.directions),
  '404 响应**不得**携带 directions 数组（否则与"项目存在但无产出"无法区分）',
)

/* ------------------------------------------------------------------ */

console.log('\n' + '─'.repeat(70))
if (errors.length === 0) {
  console.log('✓ 研究方向 API 测试全部通过')
  console.log('  路由三件套 · 分层自洽 · 推测必标且封顶 · 全部可回链 · 统计一致 · 空态≠错误 · 404 不伪装')
  stop()
  process.exit(0)
} else {
  console.log(`✗ 研究方向 API 测试失败 ${errors.length} 项：`)
  for (const e of errors) console.log(`   · ${e}`)
  stop()
  process.exit(1)
}
