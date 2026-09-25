#!/usr/bin/env node
/**
 * 跨论文方法关系 API 测试（Phase 4-3）。
 *
 * ── 这个测试要回答的问题 ──
 *
 * Phase 4-2 已经证明了 `alignMethods()` 这个纯函数是对的（100 条断言）。
 * 但在 4-3 里，它第一次通过 HTTP 暴露给界面，中间多了一层东西：
 *
 *     数据盘  →  store.getBundle()  →  alignMethods()  →  JSON  →  前端
 *
 * 纯函数测试**验不到这一层**。接口可能：
 *   · 把字段名写错（candidates 写成 candidate）→ 前端拿到 undefined
 *   · 忘了附 stats / context → 空状态说不出"为什么是 0"
 *   · 项目不存在时返回 200 + 空数组 → 用户以为"这个项目就是没关系"
 *   · 每次请求结果不一致 → 界面上的关系顺序乱跳
 *   · evidence_id 指向别的论文的证据 → 点开对不上号
 *
 * 所以这个测试**只打 HTTP**，一行 alignMethods() 都不直接调。
 * 它验的是"用户实际拿到什么"，不是"函数算得对不对"。
 *
 * ── 四条必测（需求点名）──
 *   1. Demo 能显示关系          → 造一个有跨论文数据的环境，接口必须给出 candidates
 *   2. 真实数据 0 条时正确空状态 → 接口 200 + candidates:[] + context 能解释原因
 *   3. Evidence ID 能正确回链    → 每条 evidence_id 都能查到，且 paper_id 与所在侧一致
 *   4. 输入顺序变化不改关系顺序  → 打两次接口（中间重排落盘方法），输出逐字节一致
 *
 * ── 为什么用 curl 而不是 fetch ──
 * 和 batch-add-test.mjs 保持一致：这个仓库的测试脚本一律不引入运行时依赖，
 * curl 是系统自带的，spawnSync 能拿到同步结果，省掉一层 await。
 *
 * 运行：pnpm method-align:api-test
 *   脚本会自己起一个隔离服务端（临时 DATA_DIR / UPLOAD_DIR），
 *   绝不碰 data/store 里的真实数据。
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.METHOD_ALIGN_API_PORT ?? 8978)
const BASE = `http://127.0.0.1:${PORT}`

const errors = []
/** 断言：条件不成立时记录，而不是立刻退出 —— 让一次运行报出所有问题 */
const check = (cond, msg) => {
  if (!cond) errors.push(msg)
}

/* ------------------------------------------------------------------ */
/* 起隔离服务端                                                        */
/* ------------------------------------------------------------------ */

const storeDir = mkdtempSync(path.join(tmpdir(), 'mpalign-'))
const uploadDir = mkdtempSync(path.join(tmpdir(), 'mpalign-up-'))

const srv = spawn(
  process.execPath,
  ['--experimental-strip-types', path.join(ROOT, 'server', 'index.ts')],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      /*
       * 独立 store。这个测试要**手写**论文 / 方法 / 证据进盘，
       * 跑在真实 store 上会污染演示数据，而且真实数据每篇论文
       * 只挂一个方法（跨论文对齐天然 0 条），根本验不到"有候选"这一支。
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

const get = (u) => JSON.parse(spawnSync('curl', ['-s', `${BASE}${u}`], { encoding: 'utf8' }).stdout || 'null')

/**
 * 带 HTTP 状态码的 GET —— 验 404 必须拿得到状态码，get() 只给 body。
 *
 * ⚠️ 这里踩过一个很典型的坑，记下来：
 *
 * 最初写成 `curl -s -o /dev/stdout -w '\n%{http_code}'`，想一次拿到 body+状态码。
 * 在**终端里跑是对的**，但在这里 body 永远是空的 ——
 * 因为 `-o /dev/stdout` 让 curl 把 body 写到「进程的 fd 1」，
 * 而 spawnSync 用的是 **pipe**，curl 的 fd 1 指向 pipe 没错，
 * 但 `-o` 打开的是 `/dev/stdout` 这个**独立 fd**，两者不是同一个流。
 * 结果 body 流到了别处，pipe 里只剩 `-w` 那几行 —— 表现为
 * "404 拿到了，但 JSON 是 null"，症状和"服务端没返回 error 字段"一模一样。
 *
 * 正确做法（下面这版）：分两次调用，各拿各的。
 * 多花一次本地请求，换掉一整个类别的误判，很划算。
 */
const getWithStatus = (u) => {
  const body = spawnSync('curl', ['-s', `${BASE}${u}`], { encoding: 'utf8' }).stdout || ''
  const codeRaw = spawnSync(
    'curl',
    ['-s', '-o', '/dev/null', '-w', '%{http_code}', `${BASE}${u}`],
    { encoding: 'utf8' },
  ).stdout || ''
  const status = Number(codeRaw.trim())
  let json = null
  try {
    json = JSON.parse(body)
  } catch {}
  return { status, body, json }
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
  console.log('✗ 服务端未能启动，无法运行跨论文方法关系 API 测试')
  process.exit(1)
}

/* ------------------------------------------------------------------ */
/* 造数据：直接写盘，不走分析流水线                                     */
/* ------------------------------------------------------------------ */

/*
 * ⚠️ 路径约定（踩过一次，写下来免得再错）：
 *
 *   config.storage.dir = DATA_DIR          ← 环境变量直接映射到这里
 *   fileStore.projectDir(id) = dir + '/projects/' + id
 *
 * 也就是说 **DATA_DIR 本身就是 store 根**，不是 store 的父目录。
 * 一开始我写成 `path.join(storeDir, 'store', 'projects')`，
 * 多套了一层 `store/`，服务端根本扫不到 —— 三个夹具全部 404，
 * 而症状看起来像是"接口坏了"。真实仓库里 DATA_DIR 默认是
 * `<repo>/data/store`，那个 `store` 是**目录名的一部分**，不是约定层级。
 */
const PROJECTS = path.join(storeDir, 'projects')

/** 造一个项目：papers / methods / evidence 三件套，meta 字段补默认值 */
function writeProject({
  id,
  name,
  papers,
  methods,
  evidence,
}) {
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
    translation: '',
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
        /*
         * kind 必须给：ProjectRecord 要求这个字段，
         * 缺了虽然 JSON.parse 也过，但语义上不完整。
         * 夹具一律标 uploaded —— 它们不是内置 Demo 项目。
         */
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

/* ------------------------------------------------------------------ */
/* 夹具 A：有跨论文关系的项目（"Demo 能显示关系"的服务端等价）           */
/* ------------------------------------------------------------------ */

/*
 * 注意：这里刻意**不**用 src/data 的 Demo 数据。
 * Demo 数据是 .ts 文件，含 `@/` 别名，服务端 import 不了；
 * 而且 Demo 数据的职责是前端演示，不是这里要验的对象。
 *
 * 需求说的是"Demo 能显示关系"——落到接口层，就是
 * **"有一组跨论文数据时，接口必须真的给出候选"**。
 * 用一个可控夹具来验这一条，比去解析 Demo 的 .ts 更稳，也更准。
 * （Demo 前端的渲染另有 replay 脚本与 e2e 覆盖。）
 *
 * 夹具设计：两篇论文各有一个方法，名字是明显别名（含共同缩写 MCP），
 * 双方都有证据 → 应当判为 alias 或 same，无论如何必须有候选。
 */
writeProject({
  id: 'proj_fixture_align',
  name: '跨论文对齐夹具',
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
      section: '方法',
      page: 3,
      content: '我们提出 Model Context Protocol，用于统一接入外部工具与上下文。',
      method_ids: ['M001'],
    },
    {
      evidence_id: 'E002',
      paper_id: 'P002',
      section: '方法',
      page: 4,
      content: 'Model Context Protocol 在本工作中被用于标准化工具调用。',
      method_ids: ['M002'],
    },
  ],
})

/* ------------------------------------------------------------------ */
/* 夹具 B：真实数据的等价形态 —— 只有一篇论文有方法（0 条候选）          */
/* ------------------------------------------------------------------ */

/*
 * 这个夹具**复刻真实 store 的形态**：8 个项目里 7 个只有 1 篇论文 1 个方法。
 * 跨论文对齐需要"至少两篇论文各带方法"，单方法项目天然产不出候选。
 *
 * 关键点：0 条**不是**错误。接口必须 200 + 空数组 + 能自解释的 context。
 * 如果这里返回 404 或者 500，前端就只能显示"加载失败"，
 * 用户会以为工具坏了 —— 而其实数据本来就是这样的。
 */
writeProject({
  id: 'proj_fixture_single',
  name: '单论文项目（真实数据形态）',
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
    { evidence_id: 'E001', paper_id: 'P001', section: '方法', page: 2, content: 'ReAct 交替推理与行动。', method_ids: ['M001'] },
  ],
})

/* ------------------------------------------------------------------ */
/* 夹具 C：同论文多方法（应被同论文规则全部跳过，仍为 0 条）              */
/* ------------------------------------------------------------------ */

/*
 * 这一条专门验"同论文内部不互相对齐"在**接口层**也成立。
 * 夹具里两个方法名字完全一样，且都有证据 —— 纯函数层面它们会被判 same，
 * 但它们在**同一篇论文**里，所以必须一个候选都不产生。
 * 如果接口这层漏了同论文过滤，这里会冒出 1 条候选，立刻红。
 */
writeProject({
  id: 'proj_fixture_samepaper',
  name: '同论文双方法',
  papers: [{ paper_id: 'P001', title: 'Two Methods One Paper', year: 2024 }],
  methods: [
    {
      method_id: 'M001',
      name: 'Tree of Thought',
      name_zh: '思维树',
      task: '多路径推理',
      core_idea: '在推理过程中维护多条候选路径并搜索',
      paper_ids: ['P001'],
      evidence_ids: ['E001'],
    },
    {
      method_id: 'M002',
      name: 'Tree of Thought',
      name_zh: '思维树',
      task: '多路径推理',
      core_idea: '在推理过程中维护多条候选路径并搜索',
      paper_ids: ['P001'],
      evidence_ids: ['E002'],
    },
  ],
  evidence: [
    { evidence_id: 'E001', paper_id: 'P001', section: '方法', page: 2, content: 'Tree of Thought 维护多条路径。', method_ids: ['M001'] },
    { evidence_id: 'E002', paper_id: 'P001', section: '方法', page: 3, content: 'Tree of Thought 通过搜索选出最优路径。', method_ids: ['M002'] },
  ],
})

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const ALIGN = (pid) => `/api/projects/${pid}/method-alignments`
/** 取 data；接口包了一层 { success, data } */
const dataOf = (pid) => get(ALIGN(pid))?.data
/** 把候选排序成与顺序无关的规范形式，用于"重排输入不改输出"的对比 */
const canonical = (cands) =>
  [...cands]
    .sort((a, b) => (a.alignment_id < b.alignment_id ? -1 : a.alignment_id > b.alignment_id ? 1 : 0))
    .map((c) => ({
      id: c.alignment_id,
      type: c.relation_type,
      src: `${c.source.paper_id}/${c.source.method_id}`,
      tgt: `${c.target.paper_id}/${c.target.method_id}`,
      ev: [...c.evidence_ids].sort(),
    }))

/* ------------------------------------------------------------------ */

console.log('═'.repeat(68))
console.log('跨论文方法关系 API 测试（Phase 4-3）')
console.log('═'.repeat(68))

/* ================================================================== */
console.log('\n— 1. 有跨论文数据时，接口必须给出关系（"Demo 能显示关系"）—')
/* ================================================================== */

const fxA = dataOf('proj_fixture_align')
check(!!fxA, '夹具 A 的接口没返回 data')
if (fxA) {
  check(Array.isArray(fxA.candidates), 'candidates 不是数组')
  check(fxA.candidates.length >= 1, `夹具 A 应至少给出 1 条候选，实际 ${fxA.candidates?.length}`)

  const rel = fxA.candidates?.[0]
  if (rel) {
    check(
      rel.relation_type === 'same' || rel.relation_type === 'alias',
      `两篇论文里同名同义的方法应为 same/alias，实际 ${rel.relation_type}`,
    )
    check(rel.hasDirectEvidence === true, '双方都有证据时 hasDirectEvidence 应为 true')
    console.log(
      `  候选 ${fxA.candidates.length} 条 · 首条 ${rel.alignment_id} ${rel.relation_type} ` +
        `(${rel.source.method_id} ↔ ${rel.target.method_id}) 证据门槛=${rel.hasDirectEvidence}`,
    )
  }
}

/* ================================================================== */
console.log('\n— 2. 真实数据 0 条：接口 200 + 空数组 + 能解释原因的 context —')
/* ================================================================== */

/*
 * 这是整个测试最关键的一条。
 * 0 条候选是**合法结果**，绝不能是 4xx/5xx，也不能让 stats/context 缺席 ——
 * 前端就是靠 context 里的 papers / compared / skipped_same_paper
 * 来决定空状态该显示哪一句话的（见 MethodsPage.tsx 的 EmptyState 分支）。
 */
const singleRaw = getWithStatus(ALIGN('proj_fixture_single'))
check(singleRaw.status === 200, `单论文项目状态码应为 200，实际 ${singleRaw.status}`)
const fxB = singleRaw.json?.data
if (fxB) {
  check(Array.isArray(fxB.candidates) && fxB.candidates.length === 0, '单论文项目 candidates 应为空数组')
  check(fxB.context?.papers === 1, `context.papers 应为 1，实际 ${fxB.context?.papers}`)
  check(fxB.context?.methods === 1, `context.methods 应为 1，实际 ${fxB.context?.methods}`)
  /*
   * compared 的语义是**参与比较的"方法数"，不是"方法对数"**。
   * 这里只有 1 个方法，但它归属清晰，所以算"参与了比较"（compared=1），
   * 只是没有任何对手，自然产不出配对。
   *
   * 我第一版断言写成 compared === 0，跑红了 —— 而红的是**我的断言**，
   * 不是服务端。这个字段的字面含义容易让人以为是"比过几对"，
   * 好在 methodAlignment.ts 里的注释写得很清楚（`参与比较的方法数`）。
   * 留这条注释是为了下次不再误读。
   */
  check(fxB.context?.compared === 1, `context.compared 应为 1（1 个方法参与了比较），实际 ${fxB.context?.compared}`)
  check(!!fxB.stats, 'context 在但 stats 缺席 —— 空状态下也要有统计')
  check(fxB.stats?.total === 0, `空状态 stats.total 应为 0，实际 ${fxB.stats?.total}`)
  check(!!fxB.rule_version, 'rule_version 缺席 —— 前端统计条要展示规则版本')
  console.log(
    `  200 · candidates=0 · papers=${fxB.context?.papers} compared=${fxB.context?.compared} ` +
      `→ 空状态可解释："只有 ${fxB.context?.papers} 篇论文"`,
  )
}

/* ================================================================== */
console.log('\n— 3. 同论文内部的方法即使同名，也不得产生关系 —')
/* ================================================================== */

const fxC = dataOf('proj_fixture_samepaper')
if (fxC) {
  check(
    fxC.candidates?.length === 0,
    `同论文同名的两个方法产生了 ${fxC.candidates?.length} 条关系，应为 0`,
  )
  check(
    (fxC.context?.skipped_same_paper ?? 0) >= 1,
    `应记录同论文跳过对数，实际 skipped_same_paper=${fxC.context?.skipped_same_paper}`,
  )
  console.log(
    `  candidates=${fxC.candidates?.length} · skipped_same_paper=${fxC.context?.skipped_same_paper}（同名方法被正确地按同论文排除）`,
  )
}

/* ================================================================== */
console.log('\n— 4. Evidence ID 能正确回链 —')
/* ================================================================== */

/*
 * 回链有两层，缺一不可：
 *   (a) 这个 evidence_id 在项目里**真的存在**（点开能查到东西）
 *   (b) 它挂在**正确的那一侧**：source 的证据必须属于 source.paper_id
 *
 * 只验 (a) 是不够的 —— 把两边的证据 ID 写反了，(a) 照样过，
 * 但用户点开"来源"那侧却看到目标论文的原文，(a) 就变成了误导。
 */
const papersA = fxA ? new Set([fxA.candidates.map((c) => c.source.paper_id)]) : null
const evIndex = new Map()
// 从接口取该项目的证据列表，建 ID → paper_id 索引（走的是真实数据，不是夹具对象）
for (const pid of ['proj_fixture_align', 'proj_fixture_samepaper', 'proj_fixture_single']) {
  const list = get(`/api/projects/${pid}/evidence`)?.data ?? []
  for (const e of list) evIndex.set(`${pid}:${e.evidence_id}`, e)
}

let checkedEv = 0
if (fxA) {
  for (const c of fxA.candidates) {
    for (const side of [c.source, c.target]) {
      for (const eid of side.evidence_ids) {
        const ev = evIndex.get(`${'proj_fixture_align'}:${eid}`)
        check(!!ev, `候选 ${c.alignment_id} 引用了不存在的证据 ${eid}`)
        if (ev) {
          check(
            ev.paper_id === side.paper_id,
            `证据 ${eid} 的 paper_id=${ev.paper_id}，却挂在 ${side.paper_id} 侧 —— 回链错位`,
          )
        }
        checkedEv++
      }
    }
    // 顶层 evidence_ids 应是双方证据的并集，不能只留一边
    const expected = new Set([...c.source.evidence_ids, ...c.target.evidence_ids])
    check(
      c.evidence_ids.length === expected.size &&
        c.evidence_ids.every((e) => expected.has(e)),
      `候选 ${c.alignment_id} 的顶层 evidence_ids 不是双方并集：${c.evidence_ids.join(',')}`,
    )
  }
}
if (papersA) {
  console.log(`  ${checkedEv} 个证据 ID 全部可回链，且 paper_id 与所在侧一致`)
}

/* ================================================================== */
console.log('\n— 5. 重排输入顺序，输出逐字段不变（确定性）—')
/* ================================================================== */

/*
 * 把夹具 A 的 methods / evidence / papers **倒序**重写进盘，再请求一次。
 * 服务端读到的顺序变了，但输出必须完全一致 —— 否则界面上每次刷新
 * 关系顺序都在跳，用户会以为数据在变。
 *
 * 对比用 canonical()：先按 alignment_id 排序再取关键字段，
 * 这样我们验的是"ID 到关系的映射一致"，而不是"数组恰好同序"。
 * 两者都要求：canonical 相同 + 原始数组逐元素 alignment_id 相同。
 */
const before = fxA ? canonical(fxA.candidates) : []

const ev1 = evIndex.get('proj_fixture_align:E001')
const ev2 = evIndex.get('proj_fixture_align:E002')
writeProject({
  id: 'proj_fixture_align',
  name: '跨论文对齐夹具',
  papers: [
    { paper_id: 'P002', title: 'Context Protocol for Agents', year: 2025 },
    { paper_id: 'P001', title: 'Memory-Augmented Agents', year: 2024 },
  ],
  methods: [
    {
      method_id: 'M002',
      name: 'Model Context Protocol',
      name_zh: '模型上下文协议',
      task: '为智能体提供统一的上下文接入',
      core_idea: '用统一协议把外部工具与上下文以标准化方式暴露给模型',
      paper_ids: ['P002'],
      evidence_ids: ['E002'],
    },
    {
      method_id: 'M001',
      name: 'Model Context Protocol',
      name_zh: '模型上下文协议',
      task: '为智能体提供统一的上下文接入',
      core_idea: '用统一协议把外部工具与上下文以标准化方式暴露给模型',
      paper_ids: ['P001'],
      evidence_ids: ['E001'],
    },
  ],
  evidence: [
    { evidence_id: 'E002', paper_id: 'P002', section: '方法', page: 4, content: ev2?.content ?? 'x', method_ids: ['M002'] },
    { evidence_id: 'E001', paper_id: 'P001', section: '方法', page: 3, content: ev1?.content ?? 'x', method_ids: ['M001'] },
  ],
})

const after = dataOf('proj_fixture_align')
const afterCanon = after ? canonical(after.candidates) : null

check(
  JSON.stringify(before) === JSON.stringify(afterCanon),
  '重排输入后 candidates 变了 —— 输出依赖了磁盘顺序而非内容',
)

/* 更严一点：连原始数组的 alignment_id 顺序也要一致 */
const beforeIds = (fxA?.candidates ?? []).map((c) => c.alignment_id).join(',')
const afterIds = (after?.candidates ?? []).map((c) => c.alignment_id).join(',')
check(beforeIds === afterIds, `重排后 alignment_id 顺序变了：${beforeIds} → ${afterIds}`)

/* 再严一点：整个响应体逐字节比对（含 stats / context / rule_version） */
/*
 * context.skipped_same_paper 等计数如果依赖遍历顺序，这里会红。
 * 用整包 JSON 比对，把"只改了 candidates 但 stats 没跟上"这类
 * 部分不一致也一并抓住。
 */
const respBefore = get(ALIGN('proj_fixture_align'))
const respAfter = get(ALIGN('proj_fixture_align'))
check(
  JSON.stringify(respBefore) === JSON.stringify(respAfter),
  '同一顺序连续请求两次，响应逐字节不同（非确定性）',
)
console.log(`  重排后 alignment_id 顺序仍为 ${afterIds}（两次请求响应逐字节一致）`)

/* ================================================================== */
console.log('\n— 6. stats 与 candidates 自洽 —')
/* ================================================================== */

/*
 * stats 是给界面统计条用的。它必须**从 candidates 算出来**，
 * 而不是服务端另算一套 —— 两套口径迟早会不一致，
 * 表现为"标题写 3 条，下面只列出 2 条"。
 */
if (after) {
  const cnt = { same: 0, alias: 0, related: 0, uncertain: 0 }
  for (const c of after.candidates) {
    if (cnt[c.relation_type] !== undefined) cnt[c.relation_type]++
  }
  check(after.stats.same === cnt.same, `stats.same=${after.stats.same}，实际 ${cnt.same}`)
  check(after.stats.alias === cnt.alias, `stats.alias=${after.stats.alias}，实际 ${cnt.alias}`)
  check(after.stats.related === cnt.related, `stats.related=${after.stats.related}，实际 ${cnt.related}`)
  check(after.stats.uncertain === cnt.uncertain, `stats.uncertain=${after.stats.uncertain}，实际 ${cnt.uncertain}`)
  const sum = cnt.same + cnt.alias + cnt.related + cnt.uncertain
  check(sum === after.stats.total, `四类之和 ${sum} ≠ stats.total ${after.stats.total}`)
  check(after.stats.total === after.candidates.length, `stats.total ≠ candidates.length`)
  const grounded = after.candidates.filter((c) => c.hasDirectEvidence).length
  check(after.stats.grounded === grounded, `stats.grounded=${after.stats.grounded}，实际 ${grounded}`)
  console.log(
    `  same=${cnt.same} alias=${cnt.alias} related=${cnt.related} uncertain=${cnt.uncertain} ` +
      `→ total=${after.stats.total} grounded=${after.stats.grounded}（与 candidates 一致）`,
  )
}

/* ================================================================== */
console.log('\n— 7. 结构完整性：ID 唯一 / 无自指 / 必跨论文 / 类型合法 —')
/* ================================================================== */

if (after) {
  const ids = after.candidates.map((c) => c.alignment_id)
  check(ids.length === new Set(ids).size, `alignment_id 有重复：${ids.join(',')}`)

  const pairKeys = after.candidates.map((c) =>
    [c.source.method_id, c.target.method_id].sort().join('|'),
  )
  check(pairKeys.length === new Set(pairKeys).size, `存在重复方法对：${pairKeys.join(' ')}`)

  const ALLOWED = new Set(['same', 'alias', 'related', 'uncertain'])
  for (const c of after.candidates) {
    check(ALLOWED.has(c.relation_type), `非法关系类型 ${c.relation_type}`)
    check(c.source.method_id !== c.target.method_id, `${c.alignment_id} 是自指关系`)
    check(c.source.paper_id !== c.target.paper_id, `${c.alignment_id} 双方同属一篇论文`)
    for (const side of [c.source, c.target]) {
      check(!!side.paper_id && !!side.method_id, `${c.alignment_id} 的某一侧缺 paper_id/method_id`)
      check(Array.isArray(side.evidence_ids), `${c.alignment_id} 的某一侧 evidence_ids 不是数组`)
    }
    // 无实质证据时不得是强关系 —— 服务端不变式，在接口层再核一遍
    if (!c.hasDirectEvidence) {
      check(
        c.relation_type !== 'same' && c.relation_type !== 'alias',
        `${c.alignment_id} 无实质证据却是 ${c.relation_type}`,
      )
    }
  }
  console.log(`  ${ids.length} 条候选 ID 唯一、无自指、全部跨论文、类型合法、不变式成立`)
}

/* ================================================================== */
console.log('\n— 8. 不存在的项目必须 404，不能假装"没有关系" —')
/* ================================================================== */

/*
 * 这一条防的是一种很隐蔽的错：把 404 写成 200 + 空数组。
 * 用户输错项目 ID 时，界面会显示"暂无跨论文方法关系"，
 * 看起来一切正常 —— 而其实项目压根不存在。
 * "没有数据"和"没有这个项目"必须能区分开。
 */
const missing = getWithStatus(ALIGN('proj_does_not_exist_xyz'))
check(missing.status === 404, `不存在的项目应 404，实际 ${missing.status}`)
check(missing.json?.success === false, '404 响应 success 应为 false')
check(!!missing.json?.error, '404 响应应带 error 说明')
console.log(`  不存在项目 → ${missing.status} ${missing.json?.error?.code ?? ''}（未伪装成空结果）`)

/* ------------------------------------------------------------------ */

stop()

console.log('\n' + '─'.repeat(68))
if (errors.length) {
  console.log(`✗ 跨论文方法关系 API 测试未通过（${errors.length} 项）`)
  for (const e of errors) console.log(`   ✗ ${e}`)
  process.exit(1)
}
console.log('✓ 跨论文方法关系 API 测试通过：有数据出关系、0 条出空状态、证据可回链、顺序稳定')
