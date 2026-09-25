#!/usr/bin/env node
/**
 * 研究空白 Gap API 测试（Phase 4-6 UI）。
 *
 * 运行：pnpm gap:api-test
 *
 * ── 这个测试与 gap-test.mjs 的分工 ──
 *
 * `gap-test.mjs` 验的是**纯函数** `detectGaps()`：128 条断言全在内存里跑，
 * 输入是手写对象。它证明"给定这份数据，判定逻辑是对的"。
 *
 * 但纯函数是对的，不代表用户拿到的是对的。中间隔着一条链：
 *
 *     store.getBundle() → alignMethods() → buildEvolution() → detectGaps() → JSON
 *
 * 这一层能出的错，纯函数测试**一个都抓不到**：
 *   · 忘了把 `alignMethods()` 的结果接进来 → candidate 的"跨论文"判据退化
 *   · 忘了把 `buildEvolution()` 的结果接进来 → `addressed_by_later_work` 永远不命中
 *   · `assertGapInvariants()` 没挂进响应 → 不变量在运行时不可见
 *   · `stated` / `candidate` 在序列化时被合并或字段名拼错
 *   · 项目不存在返回 200 + 空数组 → 与"真的没有空白"无法区分
 *   · 响应依赖磁盘顺序 → 刷新一次 Gap 顺序就变
 *   · **最重要的**：`candidate` 层的 `【候选】` 前缀和"推断"字样
 *     只存在于 title/description 文本里，纯函数测试断言的是对象字段；
 *     如果路由层重新拼了 title，纯函数测试照样全绿而用户看到的是既定事实口吻。
 *
 * 所以这个测试**只打 HTTP**，一行 `detectGaps()` 都不直接调。
 *
 * ── 八条必测（对应验收要点）──
 *   1. 论文明确写出的 limitation → 产出 stated
 *   2. 没有任何缺口证据 → 0 条 Gap（且不是错误）
 *   3. 多篇论文共同缺失 → 产出 candidate，且带【候选】/推断字样
 *   4. 单篇普通总结 → 不产出任何 Gap（关键：不能把总结当空白）
 *   5. 乱序输入 → 响应逐字节一致
 *   6. 每个 Gap 都能回链到**真实存在**的 Evidence
 *   7. 接口层分层：stated 与 candidate 不混，统计自洽
 *   8. 不存在项目 → 404，不能伪装成空结果
 *
 * ── 为什么用 curl ──
 * 与仓库里其它 API 测试一致：不引入运行时依赖，spawnSync 拿同步结果。
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.GAP_API_PORT ?? 8981)
const BASE = `http://127.0.0.1:${PORT}`

const errors = []
const check = (cond, msg) => {
  if (!cond) errors.push(msg)
}

/* ------------------------------------------------------------------ */
/* 起隔离服务端                                                        */
/* ------------------------------------------------------------------ */

const storeDir = mkdtempSync(path.join(tmpdir(), 'mpgap-'))
const uploadDir = mkdtempSync(path.join(tmpdir(), 'mpgap-up-'))

const srv = spawn(
  process.execPath,
  ['--experimental-strip-types', path.join(ROOT, 'server', 'index.ts')],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      /*
       * 独立 store。这个测试需要**手写**论文 / 方法 / 证据进盘 ——
       * 真实 store 里几乎没有带缺口陈述的证据（16 条里只有 1 条），
       * 根本验不到"能产出 candidate"这一支。
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
  console.log('✗ 服务端未能启动，无法运行研究空白 API 测试')
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

/* ================================================================== */
/* 夹具 S1：单篇论文**明确写出** limitation → 必须产出 stated           */
/* ================================================================== */

/*
 * 这是最基础的一条：原文写了 "a limitation of our approach is that it
 * does not scale to long-horizon tasks"，系统必须把它捞出来，
 * 标成 stated（**不是** candidate —— 这是论文自己说的，不是我们猜的）。
 */
writeProject({
  id: 'proj_gap_stated',
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
      content:
        'A limitation of our approach is that it does not scale to long-horizon tasks, which we leave to future work.',
      translation:
        '我们方法的一个局限是它无法扩展到长程任务，这一点我们留给未来工作。',
      method_ids: ['M001'],
    },
  ],
})

/* ================================================================== */
/* 夹具 S2：完全没有缺口证据 → 0 条 Gap（且是 200，不是错误）            */
/* ================================================================== */

/*
 * 两篇论文，证据全是中性的方法描述，没有任何局限/开放问题措辞。
 * 接口必须 200 + 空数组 + `corpus_has_gap_intent=false`。
 *
 * 这条测试防的是"为了不让页面空着，就硬凑一条 Gap" ——
 * 那是本功能最该避免的行为。空结果**也是**正确结果。
 */
writeProject({
  id: 'proj_gap_clean',
  name: '无缺口证据',
  papers: [
    { paper_id: 'P001', title: 'ReAct', year: 2022 },
    { paper_id: 'P002', title: 'Toolformer', year: 2023 },
  ],
  methods: [
    {
      method_id: 'M001',
      name: 'ReAct',
      name_zh: '推理-行动',
      year: 2022,
      task: '交替推理与行动',
      core_idea: '在推理与行动之间交替',
      paper_ids: ['P001'],
      evidence_ids: ['E001'],
    },
    {
      method_id: 'M002',
      name: 'Toolformer',
      name_zh: '工具调用',
      year: 2023,
      task: '学习调用工具',
      core_idea: '让模型自学调用 API',
      paper_ids: ['P002'],
      evidence_ids: ['E002'],
    },
  ],
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
      content: 'Toolformer learns to call APIs in a self-supervised manner.',
      translation: 'Toolformer 以自监督方式学习调用 API。',
      method_ids: ['M002'],
    },
  ],
})

/* ================================================================== */
/* 夹具 S3：**多篇论文共同缺失** → 必须产出 candidate                    */
/* ================================================================== */

/*
 * 两篇不同论文各写了一句"我们的方法尚未在长程任务上验证"。
 * 单看每一句都只是普通局限（stated）；但**两篇指向同一语义坐标**，
 * 系统就应该升级出一条 candidate。
 *
 * 这是 candidate 唯一合法的产生路径：**跨论文共现**。
 *
 * ⚠️ 关键验收：candidate 的 title 必须以「【候选】」开头、
 * description 必须出现"推断"字样。如果路由层重新拼了 title，
 * 这条就会失败 —— 而这正是纯函数测试抓不到的那一类错。
 */
writeProject({
  id: 'proj_gap_candidate',
  name: '多篇共同缺失',
  papers: [
    { paper_id: 'P001', title: 'ReAct', year: 2022 },
    { paper_id: 'P002', title: 'Reflexion', year: 2023 },
  ],
  methods: [
    {
      method_id: 'M001',
      name: 'ReAct',
      name_zh: '推理-行动',
      year: 2022,
      task: '交替推理与行动',
      core_idea: '在推理与行动之间交替',
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
      content:
        'A limitation is that our method has not been evaluated on long-horizon tasks.',
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

/* ================================================================== */
/* 夹具 S4：单篇论文的**普通总结** → 不得产出任何 Gap                    */
/* ================================================================== */

/*
 * 这条最容易出错，也最该防。
 *
 * 原文："In this paper we presented X. Our method achieves strong results
 * on benchmark Y." —— 这是**总结**，不是局限。
 * 系统绝不能因为句子出现在"Conclusion"章节就把它当空白。
 *
 * 反向证据：如果这里冒出一条 Gap，说明判定只看章节名不看句式，
 * 结果是每篇论文的结论段都会变成一条"研究空白"。
 */
writeProject({
  id: 'proj_gap_summary_only',
  name: '只有普通总结',
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
      evidence_ids: ['E001'],
    },
  ],
  evidence: [
    {
      evidence_id: 'E001',
      paper_id: 'P001',
      section: '结论',
      page: 10,
      content:
        'In this paper we presented ReAct. Our method achieves strong results on the benchmark.',
      translation: '本文提出了 ReAct。我们的方法在基准上取得了很强的结果。',
      method_ids: ['M001'],
    },
  ],
})

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const GAPS = (pid) => `/api/projects/${pid}/gaps`
const dataOf = (pid) => get(GAPS(pid))?.data

/**
 * 顺序无关的规范化形式，用于"重排不改输出"对比。
 *
 * 连 `title` / `description` 文本一起纳入 —— 只比 id 的话，
 * "顺序对了但标题里的【候选】前缀丢了"这种错会漏过。
 */
const canonical = (d) =>
  d
    ? {
        gaps: d.gaps.map((g) => ({
          id: g.gap_id,
          lv: g.assertion_level,
          c: g.candidate,
          s: g.gap_signal,
          t: g.theme,
          ti: g.title,
          de: g.description,
          ev: [...g.evidence_ids].sort(),
          pp: [...g.paper_ids].sort(),
          mm: [...g.method_ids].sort(),
          cf: g.confidence,
        })),
        stats: d.stats,
        ctx: d.context,
      }
    : null

/** 判断文本里是否含"推断"类字样（candidate 必须明写） */
const hasInferenceWording = (s) =>
  typeof s === 'string' && /推断|推测|候选/.test(s)

/* ------------------------------------------------------------------ */

console.log('═'.repeat(68))
console.log('研究空白 Gap API 测试（Phase 4-6 UI）')
console.log('═'.repeat(68))

/* ================================================================== */
console.log('\n— 1. 原文明确的 limitation → 产出 stated（不是 candidate）—')
/* ================================================================== */

const s1 = dataOf('proj_gap_stated')
check(!!s1, '夹具 S1 的接口没返回 data')
if (s1) {
  check(Array.isArray(s1.gaps), 'gaps 不是数组')
  const statedGaps = s1.gaps.filter((g) => g.assertion_level === 'stated')
  check(statedGaps.length >= 1, `明确写出局限应至少产出 1 条 stated，实际 ${statedGaps.length}`)

  const g = statedGaps[0]
  if (g) {
    check(g.candidate === false, 'stated 的 candidate 必须为 false')
    check(
      g.evidence_ids.includes('E002'),
      `该 stated Gap 应挂上 E002（写局限的那条），实际 ${JSON.stringify(g.evidence_ids)}`,
    )
    check(
      !g.title.startsWith('【候选】'),
      `stated 的标题不得带【候选】前缀，实际「${g.title}」`,
    )
    check(
      g.confidence >= 0.7,
      `stated 置信度基线应为 0.8 附近，实际 ${g.confidence}`,
    )
    check(
      g.basis.includes('explicit_limitation_statement') ||
        g.basis.includes('explicit_open_problem'),
      `basis 应记录命中句式，实际 ${JSON.stringify(g.basis)}`,
    )
  }

  /* 这一支不能冒出 candidate（只有一篇论文，跨论文前提不成立） */
  const cand = s1.gaps.filter((g) => g.assertion_level === 'candidate')
  check(cand.length === 0, `单篇论文不得产出 candidate，实际 ${cand.length} 条`)

  console.log(
    `  ${s1.gaps.length} 条 Gap · stated=${s1.stats.stated} candidate=${s1.stats.candidate} · ` +
      `信号=${statedGaps.map((x) => x.gap_signal).join(',')}`,
  )
}

/* ================================================================== */
console.log('\n— 2. 无缺口证据 → 0 条 Gap，且是 200 不是错误 —')
/* ================================================================== */

const s2res = getWithStatus(GAPS('proj_gap_clean'))
check(s2res.status === 200, `无缺口项目应 200，实际 ${s2res.status}`)
const s2 = s2res.json?.data
check(!!s2, '夹具 S2 的接口没返回 data')
if (s2) {
  check(s2.gaps.length === 0, `无缺口证据应产出 0 条 Gap，实际 ${s2.gaps.length}`)
  check(s2.stats.total === 0, `stats.total 应为 0，实际 ${s2.stats.total}`)
  check(s2.stats.stated === 0, `stats.stated 应为 0，实际 ${s2.stats.stated}`)
  check(s2.stats.candidate === 0, `stats.candidate 应为 0，实际 ${s2.stats.candidate}`)
  /* 关键：要能解释"为什么是空的" */
  check(
    s2.context?.corpus_has_gap_intent === false,
    'context.corpus_has_gap_intent 应为 false —— 页面靠它区分"没人写过局限"与"写了但不够成 Gap"',
  )
  check(
    s2.context?.evidence_with_gap_intent === 0,
    `evidence_with_gap_intent 应为 0，实际 ${s2.context?.evidence_with_gap_intent}`,
  )
  check(!!s2.context?.rule_version, 'context 应带 rule_version —— 页面要展示它')
  check(
    Array.isArray(s2.invariant_violations) && s2.invariant_violations.length === 0,
    `invariant_violations 应为空数组，实际 ${JSON.stringify(s2.invariant_violations)}`,
  )
  console.log(
    `  200 · gaps=0 · corpus_has_gap_intent=false · 不变量 0 违例 → 空状态可解释`,
  )
}

/* ================================================================== */
console.log('\n— 3. 多篇论文共同缺失 → 产出 candidate，且措辞合规 —')
/* ================================================================== */

const s3 = dataOf('proj_gap_candidate')
check(!!s3, '夹具 S3 的接口没返回 data')
if (s3) {
  const cands = s3.gaps.filter((g) => g.assertion_level === 'candidate')
  check(cands.length >= 1, `多篇共同缺失应产出 candidate，实际 ${cands.length} 条`)

  const c = cands[0]
  if (c) {
    check(c.candidate === true, 'candidate 的候选布尔必须为 true')
    /*
     * ⚠️ 本测试最重要的一条断言。
     * 「推断」这件事只存在于文本里 —— 如果路由层重新拼了 title/description，
     * 纯函数测试全绿而用户会看到既定事实口吻。必须在这里拦。
     */
    check(
      c.title.startsWith('【候选】'),
      `candidate 标题必须以【候选】开头，实际「${c.title}」`,
    )
    check(
      hasInferenceWording(c.description),
      `candidate 描述必须明写"推断/推测"字样，实际「${c.description}」`,
    )
    check(
      c.paper_ids.length >= 2,
      `candidate 必须跨至少 2 篇论文，实际 ${JSON.stringify(c.paper_ids)}`,
    )
    check(
      c.confidence < 0.8,
      `candidate 置信度必须低于 stated 基线，实际 ${c.confidence}`,
    )
    check(
      c.basis.includes('multi_paper_shared_gap'),
      `candidate 的 basis 应记录"多篇共同缺失"，实际 ${JSON.stringify(c.basis)}`,
    )
    check(c.evidence_ids.length >= 2, `candidate 应挂上多篇的证据，实际 ${JSON.stringify(c.evidence_ids)}`)
  }

  /* 同一语义坐标上，**stated 层必须同时保留** —— 用户要能看出每句话出自谁 */
  const statedOnSameTheme = s3.gaps.filter((g) => g.assertion_level === 'stated')
  check(
    statedOnSameTheme.length >= 2,
    `candidate 成立的同时必须保留逐条 stated（让用户看到原话出自哪篇），实际 ${statedOnSameTheme.length} 条`,
  )

  console.log(
    `  stated=${s3.stats.stated} candidate=${s3.stats.candidate} · ` +
      `候选标题「${cands[0]?.title}」· 跨 ${cands[0]?.paper_ids.length} 篇`,
  )
}

/* ================================================================== */
console.log('\n— 4. 单篇普通总结 → 不得变成 Gap —')
/* ================================================================== */

const s4 = dataOf('proj_gap_summary_only')
check(!!s4, '夹具 S4 的接口没返回 data')
if (s4) {
  check(
    s4.gaps.length === 0,
    `"本文提出了 X，取得了强结果" 是总结不是局限，不得产出 Gap，实际 ${s4.gaps.length} 条：` +
      s4.gaps.map((g) => `[${g.gap_signal}]${g.title}`).join(' / '),
  )
  check(s4.stats.total === 0, `stats.total 应为 0，实际 ${s4.stats.total}`)
  console.log(`  "本文提出 X，在 Y 上取得强结果" → 0 条 Gap（未把总结当空白）`)
}

/* ================================================================== */
console.log('\n— 5. 每个 Gap 都能回链到真实存在的 Evidence —')
/* ================================================================== */

/*
 * 回链有两层，缺一不可：
 *   (a) evidence_id 在项目里**真实存在**（点开抽屉能查到原文）
 *   (b) 它属于 Gap 自己声明的 paper_ids 之一（不能挂别人的证据）
 *
 * 只验 (a) 会把"证据串了论文"判成通过，而那正是最误导用户的一种错。
 */
const evIndex = new Map()
for (const pid of [
  'proj_gap_stated',
  'proj_gap_clean',
  'proj_gap_candidate',
  'proj_gap_summary_only',
]) {
  const list = get(`/api/projects/${pid}/evidence`)?.data ?? []
  for (const e of list) evIndex.set(`${pid}:${e.evidence_id}`, e)
}

let gapChecked = 0
for (const [pid, d] of [
  ['proj_gap_stated', s1],
  ['proj_gap_clean', s2],
  ['proj_gap_candidate', s3],
  ['proj_gap_summary_only', s4],
]) {
  if (!d) continue
  for (const g of d.gaps) {
    gapChecked++
    /* (a) 硬门槛：每个 Gap 至少 1 条证据 */
    check(
      Array.isArray(g.evidence_ids) && g.evidence_ids.length > 0,
      `${pid}/${g.gap_id} 没有任何证据（本功能硬门槛）`,
    )
    for (const eid of g.evidence_ids) {
      const ev = evIndex.get(`${pid}:${eid}`)
      check(!!ev, `${pid}/${g.gap_id} 引用了不存在的证据 ${eid}`)
      /* (b) 归属一致 */
      if (ev) {
        check(
          g.paper_ids.includes(ev.paper_id),
          `${pid}/${g.gap_id} 的证据 ${eid} 属于 ${ev.paper_id}，` +
            `但 Gap 声明的 paper_ids 是 ${JSON.stringify(g.paper_ids)} —— 回链错位`,
        )
      }
    }
    /* 涉及论文/方法必须去重 */
    check(
      g.paper_ids.length === new Set(g.paper_ids).size,
      `${pid}/${g.gap_id} paper_ids 有重复`,
    )
    check(
      g.method_ids.length === new Set(g.method_ids).size,
      `${pid}/${g.gap_id} method_ids 有重复`,
    )
  }
}
check(gapChecked >= 3, `应至少检查 3 条 Gap，实际 ${gapChecked}`)
console.log(`  ${gapChecked} 条 Gap 的证据全部存在，且归属与声明的论文一致`)

/* ================================================================== */
console.log('\n— 6. 接口层分层：stated / candidate 不混，统计自洽 —')
/* ================================================================== */

for (const [pid, d] of [
  ['proj_gap_stated', s1],
  ['proj_gap_clean', s2],
  ['proj_gap_candidate', s3],
  ['proj_gap_summary_only', s4],
]) {
  if (!d) continue

  const stated = d.gaps.filter((g) => g.assertion_level === 'stated')
  const cand = d.gaps.filter((g) => g.assertion_level === 'candidate')

  /* 分层必须互斥且完备 —— 不允许第三种 assertion_level */
  check(
    stated.length + cand.length === d.gaps.length,
    `${pid}: assertion_level 不是二分（stated ${stated.length} + candidate ${cand.length} ≠ ${d.gaps.length}）`,
  )

  /* `candidate` 布尔必须与 assertion_level 严格一致 —— 否则前端两种写法会打架 */
  for (const g of d.gaps) {
    check(
      g.candidate === (g.assertion_level === 'candidate'),
      `${pid}/${g.gap_id}: candidate=${g.candidate} 与 assertion_level=${g.assertion_level} 不一致`,
    )
  }

  /* stats 必须从返回数据能算出来 */
  check(d.stats.stated === stated.length, `${pid}: stats.stated=${d.stats.stated}，实际 ${stated.length}`)
  check(d.stats.candidate === cand.length, `${pid}: stats.candidate=${d.stats.candidate}，实际 ${cand.length}`)
  check(
    d.stats.total === d.gaps.length,
    `${pid}: stats.total=${d.stats.total}，实际 ${d.gaps.length}`,
  )
  check(
    d.stats.stated + d.stats.candidate === d.stats.total,
    `${pid}: stated+candidate ≠ total`,
  )

  /* 四类信号计数自洽 */
  for (const sig of ['limitation', 'open_problem', 'missing_comparison', 'uncovered_setting']) {
    const n = d.gaps.filter((g) => g.gap_signal === sig).length
    check(d.stats[sig] === n, `${pid}: stats.${sig}=${d.stats[sig]}，实际 ${n}`)
  }
  const sigSum = ['limitation', 'open_problem', 'missing_comparison', 'uncovered_setting'].reduce(
    (a, k) => a + d.stats[k],
    0,
  )
  check(sigSum === d.stats.total, `${pid}: 四类信号之和 ${sigSum} ≠ total ${d.stats.total}`)

  /* 涉及论文/方法去重后计数 */
  const papers = new Set(d.gaps.flatMap((g) => g.paper_ids))
  const methods = new Set(d.gaps.flatMap((g) => g.method_ids))
  check(d.stats.papers_involved === papers.size, `${pid}: papers_involved=${d.stats.papers_involved}，实际 ${papers.size}`)
  check(d.stats.methods_involved === methods.size, `${pid}: methods_involved=${d.stats.methods_involved}，实际 ${methods.size}`)

  /*
   * 最关键的一条不变量：无证据的 Gap 恒为 0。
   * 服务端把它放进 stats 就是为了让它**运行时可见** ——
   * 一旦不为 0，返回的数据自证不可信。
   */
  check(d.stats.gaps_without_evidence === 0, `${pid}: gaps_without_evidence=${d.stats.gaps_without_evidence}（必须为 0）`)

  /* 运行时自检结果也必须为空 */
  check(
    Array.isArray(d.invariant_violations) && d.invariant_violations.length === 0,
    `${pid}: invariant_violations 非空：${JSON.stringify(d.invariant_violations)}`,
  )

  /* ID 唯一 */
  const ids = d.gaps.map((g) => g.gap_id)
  check(ids.length === new Set(ids).size, `${pid}: gap_id 有重复`)
}

/* 全类型普查：candidate 必须跨 ≥2 篇、必须带【候选】、必须措辞合规 */
for (const [pid, d] of [
  ['proj_gap_stated', s1],
  ['proj_gap_candidate', s3],
]) {
  if (!d) continue
  for (const g of d.gaps.filter((x) => x.assertion_level === 'candidate')) {
    check(g.paper_ids.length >= 2, `${pid}/${g.gap_id}: candidate 跨论文数 ${g.paper_ids.length} < 2`)
    check(g.title.startsWith('【候选】'), `${pid}/${g.gap_id}: candidate 标题缺【候选】前缀`)
    check(hasInferenceWording(g.description), `${pid}/${g.gap_id}: candidate 描述缺"推断"字样`)
  }
  /* stated 一律不得带候选字样 */
  for (const g of d.gaps.filter((x) => x.assertion_level === 'stated')) {
    check(
      !g.title.startsWith('【候选】'),
      `${pid}/${g.gap_id}: stated 标题误带【候选】前缀`,
    )
  }
}
console.log('  4 个夹具的分层互斥、candidate 布尔一致、stats 与 gaps 全部自洽')

/* ================================================================== */
console.log('\n— 7. 重排输入顺序 → 响应逐字节一致（确定性）—')
/* ================================================================== */

/*
 * 把夹具 S3 的 papers / methods / evidence **倒序**重写进盘，再请求。
 * 服务端读到的数组顺序变了，输出必须完全一致。
 *
 * 为什么用倒序重写而不是直接打两次接口：
 * 直接打两次验的是"服务端无状态副作用"，验不到"输出依赖磁盘顺序"。
 * 必须真的改变存储顺序，才碰得到排序键这个层面。
 */
const before = canonical(s3)

const ev1 = evIndex.get('proj_gap_candidate:E001')
const ev2 = evIndex.get('proj_gap_candidate:E002')

writeProject({
  id: 'proj_gap_candidate',
  name: '多篇共同缺失',
  papers: [
    { paper_id: 'P002', title: 'Reflexion', year: 2023 },
    { paper_id: 'P001', title: 'ReAct', year: 2022 },
  ],
  methods: [
    {
      method_id: 'M002',
      name: 'Reflexion',
      name_zh: '反思',
      year: 2023,
      task: '语言化自我反思',
      core_idea: '用语言反馈改进后续尝试',
      paper_ids: ['P002'],
      evidence_ids: ['E002'],
    },
    {
      method_id: 'M001',
      name: 'ReAct',
      name_zh: '推理-行动',
      year: 2022,
      task: '交替推理与行动',
      core_idea: '在推理与行动之间交替',
      paper_ids: ['P001'],
      evidence_ids: ['E001'],
    },
  ],
  evidence: [
    {
      evidence_id: 'E002',
      paper_id: 'P002',
      section: '讨论',
      page: 9,
      content: ev2?.content ?? 'x',
      translation: ev2?.translation ?? '',
      method_ids: ['M002'],
    },
    {
      evidence_id: 'E001',
      paper_id: 'P001',
      section: '局限',
      page: 8,
      content: ev1?.content ?? 'x',
      translation: ev1?.translation ?? '',
      method_ids: ['M001'],
    },
  ],
})

const after = dataOf('proj_gap_candidate')
check(
  JSON.stringify(before) === JSON.stringify(canonical(after)),
  '重排输入后输出变了 —— 结果依赖了磁盘顺序而非内容',
)

/* 更严：连原始数组顺序也要一致（不只是规范化后一致） */
const idBefore = (s3?.gaps ?? []).map((g) => g.gap_id).join(',')
const idAfter = (after?.gaps ?? []).map((g) => g.gap_id).join(',')
check(idBefore === idAfter, `重排后 gap_id 顺序变了：${idBefore} → ${idAfter}`)

/* 整包逐字节比对：把"只改了 gaps 但 stats 没跟上"也抓住 */
const respA = get(GAPS('proj_gap_candidate'))
const respB = get(GAPS('proj_gap_candidate'))
check(
  JSON.stringify(respA) === JSON.stringify(respB),
  '同一顺序连续请求两次响应逐字节不同（非确定性）',
)
console.log(`  倒序重写后 gap_id 仍为 ${idAfter}，整包逐字节一致`)

/* ================================================================== */
console.log('\n— 8. 不存在的项目必须 404，不能伪装成"没有空白" —')
/* ================================================================== */

/*
 * 把 404 写成 200 + 空数组的话，用户输错项目 ID 会看到
 * "当前语料没有足够 Evidence" —— 看起来一切正常，而项目压根不存在。
 */
const missing = getWithStatus(GAPS('proj_does_not_exist_xyz'))
check(missing.status === 404, `不存在的项目应 404，实际 ${missing.status}`)
check(missing.json?.success === false, '404 响应 success 应为 false')
check(!!missing.json?.error, '404 响应应带 error 说明')
console.log(`  不存在项目 → ${missing.status} ${missing.json?.error?.code ?? ''}（未伪装成空结果）`)

/* ------------------------------------------------------------------ */

stop()

console.log('\n' + '─'.repeat(68))
if (errors.length) {
  console.log(`✗ 研究空白 API 测试未通过（${errors.length} 项）`)
  for (const e of errors) console.log(`   ✗ ${e}`)
  process.exit(1)
}
console.log(
  '✓ 研究空白 API 测试通过：明确局限可生成 · 无证据不生成 · 多篇共缺出候选 · ' +
    '总结不变空白 · 乱序一致 · 可回链 · 分层自洽 · 404 不伪装',
)
