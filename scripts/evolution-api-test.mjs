#!/usr/bin/env node
/**
 * 技术演进 API 测试（Phase 4-4）。
 *
 * 运行：pnpm evolution:api-test
 *
 * ── 这个测试与 evolution-test.mjs 的分工 ──
 *
 * `evolution-test.mjs` 验的是**纯函数**：132 条断言全在内存里跑，
 * 输入是手写的对象。它证明"给定这份数据，判定逻辑是对的"。
 *
 * 但纯函数是对的，不代表用户拿到的是对的。中间还隔着一条链：
 *
 *     数据盘 → store.getBundle() → alignMethods() → buildEvolution() → JSON
 *
 * 这一层能出的错，纯函数测试**一个都抓不到**：
 *   · 路由把 `summarizeEvolutions(relations, evolutions)` 的两个参数写反
 *     （签名是 (relations, evolutions)，非常容易反着传）
 *   · 忘了把 `alignMethods()` 的结果接进来 → `related` 边永远出不来，
 *     而且**不报错**，只是少一类关系，静默错误
 *   · 字段名拼错（source_method_key 写成 sourceMethodKey）→ 前端拿到 undefined
 *   · 项目不存在返回 200 + 空链 → 与"这个项目真的没有演进"无法区分
 *   · 响应依赖磁盘顺序 → 刷新一次链的顺序就变
 *
 * 所以这个测试**只打 HTTP**，一行 `buildEvolution()` 都不直接调。
 *
 * ── 六条必测（对应用户需求里的验收要点）──
 *   1. 仅年份先后 → 因果 0 条（接口层也要成立，不能"函数对、接口放开"）
 *   2. Evidence 明确 extends/improves/builds on → 真的产出因果边
 *   3. 没有对应 Evidence → 降级 temporal，且 evidence_ids 为空
 *   4. 同一方法不自指（含跨论文撞号这一真实形态）
 *   5. 输入乱序 → 响应逐字节一致
 *   6. 所有强因果边都能回链 Evidence，且证据归属正确
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
const PORT = Number(process.env.EVOLUTION_API_PORT ?? 8979)
const BASE = `http://127.0.0.1:${PORT}`

const errors = []
const check = (cond, msg) => {
  if (!cond) errors.push(msg)
}

/* ------------------------------------------------------------------ */
/* 起隔离服务端                                                        */
/* ------------------------------------------------------------------ */

const storeDir = mkdtempSync(path.join(tmpdir(), 'mpevo-'))
const uploadDir = mkdtempSync(path.join(tmpdir(), 'mpevo-up-'))

const srv = spawn(
  process.execPath,
  ['--experimental-strip-types', path.join(ROOT, 'server', 'index.ts')],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      /*
       * 独立 store。这个测试需要**手写**论文 / 方法 / 证据进盘，
       * 真实 store 里每个项目的方法都挤在同一篇论文内（产出全是 temporal），
       * 根本验不到"能产出因果边"这一支。
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
 * 带状态码的 GET。必须**分两次 curl** 调用：
 * 用 `-o /dev/stdout` 想在一次调用里同时拿 body 和状态码是行不通的 ——
 * `-o` 打开的是独立 fd，body 不会进 spawnSync 的 pipe，
 * 结果是"状态码拿到了、body 永远为空"，症状与"服务端没返回 error 字段"一模一样。
 * （这个坑在 Phase 4-3 踩过一次，这里不再踩。）
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
  console.log('✗ 服务端未能启动，无法运行技术演进 API 测试')
  process.exit(1)
}

/* ------------------------------------------------------------------ */
/* 造数据                                                              */
/* ------------------------------------------------------------------ */

/*
 * ⚠️ 路径约定：`config.storage.dir = DATA_DIR`，而 `fileStore.projectDir(id)`
 * 把它当成 store 根，再拼 `/projects/<id>`。
 * 也就是说 **DATA_DIR 本身就是 store 根**，不要再套一层 `store/`。
 * （Phase 4-3 在这里多套了一层，三个夹具全 404。）
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

/* ------------------------------------------------------------------ */
/* 夹具 A：年份相邻、但**没有**因果证据 → 必须全部 temporal              */
/* ------------------------------------------------------------------ */

/*
 * 这是整个功能的核心立场：**年份先后本身不构成演进**。
 * 两篇论文各一个方法，2022 → 2024，证据里只有中性描述。
 * 接口必须给出链（两个节点、一条边）但因果数**恒为 0**。
 *
 * 如果这里冒出任何一条因果边，说明"仅凭年份推因果"，
 * 那正是需求第一条明令禁止的。
 */
writeProject({
  id: 'proj_evo_temporal',
  name: '仅年份先后',
  papers: [
    { paper_id: 'P001', title: 'ReAct', year: 2022 },
    { paper_id: 'P002', title: 'SWE-agent', year: 2024 },
  ],
  methods: [
    {
      method_id: 'M001',
      name: 'ReAct',
      name_zh: '推理-行动',
      year: 2022,
      task: '交替推理与行动',
      core_idea: '在推理与行动之间交替，用工具反馈纠正推理',
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
      content: 'We propose ReAct, interleaving reasoning and acting.',
      translation: '我们提出 ReAct，交替进行推理与行动。',
      method_ids: ['M001'],
    },
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

/* ------------------------------------------------------------------ */
/* 夹具 B：证据里**明确**写了 builds on / extends → 应产出因果边        */
/* ------------------------------------------------------------------ */

/*
 * 与夹具 A 的唯一区别就是 E002 的原文：
 * 从 "We present SWE-agent..." 换成 "SWE-agent builds on ReAct and extends it"。
 * 这一对夹具构成 A/B 对照，证明**因果边确实由证据决定**，
 * 而不是由年份、名字相似度或任何别的东西决定。
 *
 * 同时 E002 里点名了 "ReAct"，满足门 B（宾语是具体方法）。
 */
writeProject({
  id: 'proj_evo_causal',
  name: '证据明确继承',
  papers: [
    { paper_id: 'P001', title: 'ReAct', year: 2022 },
    { paper_id: 'P002', title: 'SWE-agent', year: 2024 },
  ],
  methods: [
    {
      method_id: 'M001',
      name: 'ReAct',
      name_zh: '推理-行动',
      year: 2022,
      task: '交替推理与行动',
      core_idea: '在推理与行动之间交替，用工具反馈纠正推理',
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
      content: 'We propose ReAct, interleaving reasoning and acting.',
      translation: '我们提出 ReAct，交替进行推理与行动。',
      method_ids: ['M001'],
    },
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

/* ------------------------------------------------------------------ */
/* 夹具 C：句式命中但**没点名**具体方法 → 仍须降级                     */
/* ------------------------------------------------------------------ */

/*
 * 原文写了 "extends prior work"，句式齐全，但宾语是 "prior work" 而不是
 * 某个具体方法。门 B 必须拦住 —— 否则任何论文里一句
 * "our approach extends existing methods" 都会凭空拉出一条因果箭头。
 * 这类句子在真实论文里极其常见，不拦住的话整张演进图会被噪声淹没。
 */
writeProject({
  id: 'proj_evo_noanchor',
  name: '句式命中但无宾语',
  papers: [
    { paper_id: 'P001', title: 'ReAct', year: 2022 },
    { paper_id: 'P002', title: 'SomeAgent', year: 2024 },
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
      name: 'SomeAgent',
      name_zh: '某智能体',
      year: 2024,
      task: '通用任务',
      core_idea: '一个智能体框架',
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
      content: 'We propose ReAct.',
      translation: '我们提出 ReAct。',
      method_ids: ['M001'],
    },
    {
      evidence_id: 'E002',
      paper_id: 'P002',
      section: '方法',
      page: 3,
      content: 'Our approach extends prior work and improves existing methods.',
      translation: '我们的方法扩展了先前工作并改进了现有方法。',
      method_ids: ['M002'],
    },
  ],
})

/* ------------------------------------------------------------------ */
/* 夹具 D：真实数据的等价形态 —— 单论文单方法 → 空链                     */
/* ------------------------------------------------------------------ */

/*
 * 复刻真实 store 的形态：8 个项目里 7 个只有 1 篇论文 1 个方法。
 * 演进链至少需要两个方法才能连边，单方法项目天然产出**空链 + 空关系**。
 *
 * 关键：这不是错误。接口必须 200 + 空数组 + 能自解释的 context，
 * 否则前端只能显示"加载失败"，用户会以为工具坏了。
 */
writeProject({
  id: 'proj_evo_single',
  name: '单论文单方法（真实数据形态）',
  papers: [{ paper_id: 'P001', title: 'Single', year: 2024 }],
  methods: [
    {
      method_id: 'M001',
      name: 'ReAct',
      name_zh: '推理-行动',
      year: 2024,
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
      section: '方法',
      page: 2,
      content: 'We propose ReAct.',
      translation: '我们提出 ReAct。',
      method_ids: ['M001'],
    },
  ],
})

/* ------------------------------------------------------------------ */
/* 夹具 E：跨论文**撞号**（两篇论文的方法都叫 M001）                     */
/* ------------------------------------------------------------------ */

/*
 * method_id 只在**项目内**唯一，跨论文撞号是真实形态。
 * 早期实现用裸 method_id 判自指，这种数据下会误报；
 * 用裸 method_id 判"是不是同一个方法"，又会把合法关系吞掉。
 *
 * 夹具 E 同时验两件事：
 *   (a) 接口不因撞号报错（不变量为空）
 *   (b) 关系带 source_method_key / target_method_key，
 *       且两者不同 —— 前端/下游靠它判身份，不必自己再拼一遍
 */
writeProject({
  id: 'proj_evo_collide',
  name: '跨论文撞号',
  papers: [
    { paper_id: 'P001', title: 'ReAct', year: 2022 },
    { paper_id: 'P002', title: 'ReAct-Agent', year: 2024 },
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
      method_id: 'M001',
      name: 'ReAct-Agent',
      name_zh: '推理-行动智能体',
      year: 2024,
      task: '仓库级任务',
      core_idea: '把 ReAct 范式扩展到仓库级任务',
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
      content: 'We propose ReAct.',
      translation: '我们提出 ReAct。',
      method_ids: ['M001'],
    },
    {
      evidence_id: 'E002',
      paper_id: 'P002',
      section: '方法',
      page: 3,
      content: 'ReAct-Agent builds on ReAct and extends it to repositories.',
      translation: 'ReAct-Agent 建立在 ReAct 之上并扩展到仓库场景。',
      method_ids: ['M001'],
    },
  ],
})

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const EVO = (pid) => `/api/projects/${pid}/evolutions`
const dataOf = (pid) => get(EVO(pid))?.data

/** 把响应整理成与顺序无关的规范形式，用于"重排不改输出"的对比 */
const canonical = (d) =>
  d
    ? {
        nodes: d.evolutions.map((e) => ({
          y: e.year,
          m: e.method_id,
          p: e.paper_id,
          r: e.relation_from_prev,
          ev: [...e.evidence_ids].sort(),
        })),
        rels: d.relations.map((r) => ({
          id: r.relation_id,
          t: r.relation_type,
          c: r.causal,
          s: r.source_method_key,
          g: r.target_method_key,
          ev: [...r.evidence_ids].sort(),
        })),
        stats: d.stats,
      }
    : null

/* ------------------------------------------------------------------ */

console.log('═'.repeat(68))
console.log('技术演进 API 测试（Phase 4-4）')
console.log('═'.repeat(68))

/* ================================================================== */
console.log('\n— 1. 仅年份先后 → 必须产出链，但因果恒为 0 —')
/* ================================================================== */

const t = dataOf('proj_evo_temporal')
check(!!t, '夹具 A 的接口没返回 data')
if (t) {
  check(Array.isArray(t.evolutions), 'evolutions 不是数组')
  check(Array.isArray(t.relations), 'relations 不是数组')
  check(t.evolutions.length === 2, `两个方法应产出 2 个节点，实际 ${t.evolutions.length}`)
  check(t.relations.length === 1, `两个节点应产出 1 条边，实际 ${t.relations.length}`)
  check(
    t.evolutions[0].year === 2022 && t.evolutions[1].year === 2024,
    `节点必须按年份升序，实际 ${t.evolutions.map((e) => e.year).join(',')}`,
  )

  const rel = t.relations[0]
  check(rel.relation_type === 'temporal', `无因果证据应判 temporal，实际 ${rel.relation_type}`)
  check(rel.causal === false, 'temporal 必须 causal=false')
  check(
    Array.isArray(rel.evidence_ids) && rel.evidence_ids.length === 0,
    `temporal 的 evidence_ids 必须为空数组，实际 ${JSON.stringify(rel.evidence_ids)}`,
  )
  check(t.stats.causal_total === 0, `仅年份先后不得产生因果，实际 causal_total=${t.stats.causal_total}`)

  /* 全类型普查：任何一条因果类型都不许出现 */
  const CAUSAL = ['extends', 'improves', 'replaces', 'combines']
  const badTypes = t.relations.filter((r) => CAUSAL.includes(r.relation_type))
  check(badTypes.length === 0, `出现了因果类型：${badTypes.map((r) => r.relation_type).join(',')}`)

  check(
    t.evolutions[1].relation_from_prev === 'temporal',
    `节点上的 relation_from_prev 应同步为 temporal，实际 ${t.evolutions[1].relation_from_prev}`,
  )
  console.log(
    `  2 节点 (2022→2024) · 1 条 temporal · causal_total=${t.stats.causal_total} · evidence_ids=[]`,
  )
}

/* ================================================================== */
console.log('\n— 2. Evidence 明确 extends / builds on → 真的产出因果边 —')
/* ================================================================== */

const c = dataOf('proj_evo_causal')
check(!!c, '夹具 B 的接口没返回 data')
if (c) {
  check(c.relations.length === 1, `应产出 1 条边，实际 ${c.relations.length}`)
  const rel = c.relations[0]
  check(rel.relation_type === 'extends', `"builds on / extends" 应判 extends，实际 ${rel.relation_type}`)
  check(rel.causal === true, 'extends 必须 causal=true')
  check(rel.evidence_ids.length > 0, '因果边必须挂证据')
  check(rel.evidence_ids.includes('E002'), `因果边应挂上 E002，实际 ${JSON.stringify(rel.evidence_ids)}`)
  check(rel.source_method === 'M002', `source 必须是 later（M002），实际 ${rel.source_method}`)
  check(rel.target_method === 'M001', `target 必须是 earlier（M001），实际 ${rel.target_method}`)
  check(c.stats.causal_total === 1, `causal_total 应为 1，实际 ${c.stats.causal_total}`)
  check(c.stats.extends === 1, `stats.extends 应为 1，实际 ${c.stats.extends}`)

  /* 三道门都要留痕，否则无法向用户解释"为什么算因果" */
  check(
    rel.basis.includes('explicit_causal_statement') &&
      rel.basis.includes('object_anchor') &&
      rel.basis.includes('evidence_ownership_verified'),
    `basis 应记录三道门，实际 ${JSON.stringify(rel.basis)}`,
  )
  console.log(
    `  1 条 ${rel.relation_type} · ${rel.source_method}→${rel.target_method} · ` +
      `证据 ${JSON.stringify(rel.evidence_ids)} · 三道门齐全`,
  )
}

/*
 * A/B 对照：两个夹具**只差证据原文一句**，结果一个 temporal 一个 extends。
 * 这一条是"因果由证据决定"的直接证据 —— 如果是年份或名字在起作用，
 * 那这两个项目会得到同样的结果。
 */
if (t && c) {
  check(
    t.relations[0].relation_type === 'temporal' && c.relations[0].relation_type === 'extends',
    'A/B 对照失败：同结构数据仅因证据文本不同，理应一个 temporal 一个 extends',
  )
  console.log('  对照：同结构数据、只改证据原文 → temporal vs extends（因果确由证据决定）')
}

/* ================================================================== */
console.log('\n— 3. 句式命中但未点名具体方法 → 仍降级 temporal —')
/* ================================================================== */

const na = dataOf('proj_evo_noanchor')
check(!!na, '夹具 C 的接口没返回 data')
if (na) {
  check(na.stats.causal_total === 0, `未点名方法不得产生因果，实际 ${na.stats.causal_total}`)
  check(
    na.relations[0]?.relation_type === 'temporal',
    `应降级 temporal，实际 ${na.relations[0]?.relation_type}`,
  )
  console.log(
    `  "extends prior work" 但宾语是 prior work → temporal · causal_total=${na.stats.causal_total}`,
  )
}

/* ================================================================== */
console.log('\n— 4. 单方法项目：200 + 空链 + 可解释的 context —')
/* ================================================================== */

/*
 * 0 条关系是**合法结果**，不能是 4xx/5xx。
 * 而且 context 必须能解释"为什么是空的"（只有 1 篇论文 / 1 个方法）。
 */
const s1 = getWithStatus(EVO('proj_evo_single'))
check(s1.status === 200, `单方法项目状态码应为 200，实际 ${s1.status}`)
const single = s1.json?.data
if (single) {
  check(single.evolutions.length === 1, `单方法应有 1 个节点，实际 ${single.evolutions.length}`)
  check(single.relations.length === 0, `单方法不应有关系，实际 ${single.relations.length}`)
  check(single.stats.total_relations === 0, `total_relations 应为 0，实际 ${single.stats.total_relations}`)
  check(single.stats.stages === 1, `stages 应为 1，实际 ${single.stats.stages}`)
  check(single.context?.methods === 1, `context.methods 应为 1，实际 ${single.context?.methods}`)
  check(single.context?.papers === 1, `context.papers 应为 1，实际 ${single.context?.papers}`)
  check(!!single.context?.rule_version, 'context 应带 rule_version —— 统计条要展示它')
  console.log(
    `  200 · 节点=1 关系=0 · papers=${single.context?.papers} methods=${single.context?.methods} ` +
      `→ 空状态可解释`,
  )
}

/* ================================================================== */
console.log('\n— 5. 跨论文撞号：不报错、不自指、身份键可区分 —')
/* ================================================================== */

const col = dataOf('proj_evo_collide')
check(!!col, '夹具 E 的接口没返回 data')
if (col) {
  check(col.evolutions.length === 2, `撞号数据应有 2 个节点，实际 ${col.evolutions.length}`)
  check(col.relations.length === 1, `撞号数据应有 1 条边，实际 ${col.relations.length}`)
  const rel = col.relations[0]
  check(
    rel.source_method_key !== rel.target_method_key,
    `撞号关系的身份键必须不同，实际 ${rel.source_method_key} vs ${rel.target_method_key}`,
  )
  check(
    rel.source_method_key.includes('::') && rel.target_method_key.includes('::'),
    '身份键必须形如 paper_id::method_id',
  )
  check(
    rel.source_paper_id !== rel.target_paper_id,
    '撞号关系仍须跨论文（paper_id 不同）',
  )
  check(rel.relation_type === 'extends', `撞号不影响因果判定：应为 extends，实际 ${rel.relation_type}`)
  console.log(
    `  两方法同号 M001 但身份键不同（${rel.source_method_key} vs ${rel.target_method_key}）· ` +
      `仍正确判为 ${rel.relation_type}`,
  )
}

/* ================================================================== */
console.log('\n— 6. 所有强因果边都能回链 Evidence，且归属正确 —')
/* ================================================================== */

/*
 * 回链有两层，缺一不可：
 *   (a) evidence_id 在项目里**真实存在**（点开能查到）
 *   (b) 它属于 **source 那一侧的论文**（因果声明"后继继承了前驱"，
 *       出处必须在后继自己论文里；挂在 target 侧就是错位）
 *
 * 只验 (a) 会把"两边证据写反"判成通过，而那正是最误导用户的一种错。
 */
const evIndex = new Map()
for (const pid of ['proj_evo_temporal', 'proj_evo_causal', 'proj_evo_noanchor', 'proj_evo_collide']) {
  const list = get(`/api/projects/${pid}/evidence`)?.data ?? []
  for (const e of list) evIndex.set(`${pid}:${e.evidence_id}`, e)
}

let causalChecked = 0
for (const [pid, d] of [
  ['proj_evo_temporal', t],
  ['proj_evo_causal', c],
  ['proj_evo_noanchor', na],
  ['proj_evo_collide', col],
]) {
  if (!d) continue
  for (const r of d.relations) {
    if (!r.causal) continue
    causalChecked++
    check(r.evidence_ids.length > 0, `${pid}/${r.relation_id} 是因果边却没有证据`)
    for (const eid of r.evidence_ids) {
      const ev = evIndex.get(`${pid}:${eid}`)
      check(!!ev, `${pid}/${r.relation_id} 引用了不存在的证据 ${eid}`)
      if (ev) {
        check(
          ev.paper_id === r.source_paper_id,
          `${pid}/${r.relation_id} 的证据 ${eid} 属于 ${ev.paper_id}，` +
            `却挂在 source(${r.source_paper_id}) 侧 —— 回链错位`,
        )
      }
    }
  }
}
check(causalChecked >= 2, `应至少检查 2 条因果边，实际 ${causalChecked}`)
console.log(`  ${causalChecked} 条因果边的证据全部存在，且归属与 source 侧一致`)

/* ================================================================== */
console.log('\n— 7. 重排输入顺序 → 响应逐字节一致（确定性）—')
/* ================================================================== */

/*
 * 把夹具 B 的 methods / evidence / papers **倒序**重写进盘，再请求。
 * 服务端读到的数组顺序变了，输出必须完全一致。
 *
 * 为什么用倒序重写而不是直接打两次接口：
 * 直接打两次验的是"服务端无状态副作用"，验不到"输出依赖磁盘顺序"。
 * 必须真的改变存储顺序，才碰得到排序键这个层面。
 */
const before = canonical(c)
const ev1 = evIndex.get('proj_evo_causal:E001')
const ev2 = evIndex.get('proj_evo_causal:E002')

writeProject({
  id: 'proj_evo_causal',
  name: '证据明确继承',
  papers: [
    { paper_id: 'P002', title: 'SWE-agent', year: 2024 },
    { paper_id: 'P001', title: 'ReAct', year: 2022 },
  ],
  methods: [
    {
      method_id: 'M002',
      name: 'SWE-agent',
      name_zh: '软件工程智能体',
      year: 2024,
      task: '仓库级问题修复',
      core_idea: '为智能体设计面向代码仓库的接口',
      paper_ids: ['P002'],
      evidence_ids: ['E002'],
    },
    {
      method_id: 'M001',
      name: 'ReAct',
      name_zh: '推理-行动',
      year: 2022,
      task: '交替推理与行动',
      core_idea: '在推理与行动之间交替，用工具反馈纠正推理',
      paper_ids: ['P001'],
      evidence_ids: ['E001'],
    },
  ],
  evidence: [
    {
      evidence_id: 'E002',
      paper_id: 'P002',
      section: '方法',
      page: 3,
      content: ev2?.content ?? 'x',
      translation: ev2?.translation ?? '',
      method_ids: ['M002'],
    },
    {
      evidence_id: 'E001',
      paper_id: 'P001',
      section: '方法',
      page: 2,
      content: ev1?.content ?? 'x',
      translation: ev1?.translation ?? '',
      method_ids: ['M001'],
    },
  ],
})

const after = dataOf('proj_evo_causal')
check(
  JSON.stringify(before) === JSON.stringify(canonical(after)),
  '重排输入后输出变了 —— 结果依赖了磁盘顺序而非内容',
)

/* 更严：连原始数组顺序也要一致（不只是规范化后一致） */
const beforeIds = (c?.relations ?? []).map((r) => r.relation_id).join(',')
const afterIds = (after?.relations ?? []).map((r) => r.relation_id).join(',')
check(beforeIds === afterIds, `重排后 relation_id 顺序变了：${beforeIds} → ${afterIds}`)

const nodeBefore = (c?.evolutions ?? []).map((e) => e.evolution_id).join(',')
const nodeAfter = (after?.evolutions ?? []).map((e) => e.evolution_id).join(',')
check(nodeBefore === nodeAfter, `重排后节点顺序变了：${nodeBefore} → ${nodeAfter}`)

/* 整包逐字节比对：把"只改了 relations 但 stats 没跟上"也抓住 */
const respA = get(EVO('proj_evo_causal'))
const respB = get(EVO('proj_evo_causal'))
check(
  JSON.stringify(respA) === JSON.stringify(respB),
  '同一顺序连续请求两次响应逐字节不同（非确定性）',
)
console.log(`  倒序重写后 relation_id 仍为 ${afterIds}，节点仍为 ${nodeBefore}，整包逐字节一致`)

/* ================================================================== */
console.log('\n— 8. stats 与 evolutions / relations 自洽 —')
/* ================================================================== */

/*
 * stats 是给界面统计条用的，必须**从返回的数据算出来**。
 * 服务端另算一套迟早会不一致，表现为"标题写 3 条，下面只列 2 条"。
 */
const CAUSAL_SET = new Set(['extends', 'improves', 'replaces', 'combines'])
for (const [pid, d] of [
  ['proj_evo_temporal', t],
  ['proj_evo_causal', after],
  ['proj_evo_noanchor', na],
  ['proj_evo_collide', col],
  ['proj_evo_single', single],
]) {
  if (!d) continue
  const cnt = { extends: 0, improves: 0, replaces: 0, combines: 0, related: 0, parallel: 0, temporal: 0 }
  for (const r of d.relations) if (cnt[r.relation_type] !== undefined) cnt[r.relation_type]++

  for (const k of Object.keys(cnt)) {
    check(d.stats[k] === cnt[k], `${pid}: stats.${k}=${d.stats[k]}，实际 ${cnt[k]}`)
  }
  const sum = Object.values(cnt).reduce((a, b) => a + b, 0)
  check(sum === d.stats.total_relations, `${pid}: 七类之和 ${sum} ≠ total_relations ${d.stats.total_relations}`)
  check(
    d.stats.total_relations === d.relations.length,
    `${pid}: total_relations ${d.stats.total_relations} ≠ relations.length ${d.relations.length}`,
  )
  const causalCnt = d.relations.filter((r) => CAUSAL_SET.has(r.relation_type)).length
  check(d.stats.causal_total === causalCnt, `${pid}: causal_total=${d.stats.causal_total}，实际 ${causalCnt}`)
  check(
    d.stats.non_causal_total === d.relations.length - causalCnt,
    `${pid}: non_causal_total 与 causual 不互补`,
  )
  check(d.stats.stages === d.evolutions.length, `${pid}: stages=${d.stats.stages}，实际 ${d.evolutions.length}`)
  const unknown = d.evolutions.filter((e) => e.year === 0).length
  check(d.stats.unknown_year === unknown, `${pid}: unknown_year=${d.stats.unknown_year}，实际 ${unknown}`)
  /*
   * 最关键的一条不变量：因果 ⟺ 有证据。
   * 它必须恒为 0 —— 服务端把它放进 stats 就是为了让它运行时可见。
   */
  check(d.stats.causal_without_evidence === 0, `${pid}: causal_without_evidence=${d.stats.causal_without_evidence}（必须为 0）`)
}

/* 结构完整性：ID 唯一、无自指、方向不反、节点年份单调不降 */
for (const [pid, d] of [
  ['proj_evo_temporal', t],
  ['proj_evo_causal', after],
  ['proj_evo_collide', col],
]) {
  if (!d) continue
  const relIds = d.relations.map((r) => r.relation_id)
  check(relIds.length === new Set(relIds).size, `${pid}: relation_id 有重复`)
  const nodeIds = d.evolutions.map((e) => e.evolution_id)
  check(nodeIds.length === new Set(nodeIds).size, `${pid}: evolution_id 有重复`)

  for (const r of d.relations) {
    check(r.source_method_key !== r.target_method_key, `${pid}/${r.relation_id}: 自指`)
    check(!!r.source_paper_id && !!r.target_paper_id, `${pid}/${r.relation_id}: 双方 paper_id 缺失`)
    const sy = d.evolutions.find((e) => `${e.paper_id}::${e.method_id}` === r.source_method_key)?.year
    const ty = d.evolutions.find((e) => `${e.paper_id}::${e.method_id}` === r.target_method_key)?.year
    check(
      !(sy > 0 && ty > 0 && sy < ty),
      `${pid}/${r.relation_id}: 方向颠倒（source ${sy} 早于 target ${ty}）`,
    )
    if (r.causal) {
      check(CAUSAL_SET.has(r.relation_type), `${pid}/${r.relation_id}: causal=true 但类型 ${r.relation_type} 非因果`)
    }
  }
  const years = d.evolutions.map((e) => e.year)
  const sorted = [...years].sort((a, b) => (a > 0 ? a : Number.MAX_SAFE_INTEGER) - (b > 0 ? b : Number.MAX_SAFE_INTEGER))
  check(
    JSON.stringify(years) === JSON.stringify(sorted),
    `${pid}: 节点未按年份排序（${years.join(',')}）`,
  )
}
console.log('  5 个夹具的 stats 全部与节点/关系自洽，ID 唯一、无自指、方向正确、年份单调')

/* ================================================================== */
console.log('\n— 9. 不存在的项目必须 404，不能伪装成"没有演进" —')
/* ================================================================== */

/*
 * 把 404 写成 200 + 空链的话，用户输错项目 ID 会看到
 * "暂无技术演进" —— 看起来一切正常，而其实项目压根不存在。
 */
const missing = getWithStatus(EVO('proj_does_not_exist_xyz'))
check(missing.status === 404, `不存在的项目应 404，实际 ${missing.status}`)
check(missing.json?.success === false, '404 响应 success 应为 false')
check(!!missing.json?.error, '404 响应应带 error 说明')
console.log(`  不存在项目 → ${missing.status} ${missing.json?.error?.code ?? ''}（未伪装成空结果）`)

/* ------------------------------------------------------------------ */

stop()

console.log('\n' + '─'.repeat(68))
if (errors.length) {
  console.log(`✗ 技术演进 API 测试未通过（${errors.length} 项）`)
  for (const e of errors) console.log(`   ✗ ${e}`)
  process.exit(1)
}
console.log('✓ 技术演进 API 测试通过：年份不推因果 · 证据决定因果 · 无证据降级 · 不自指 · 乱序一致 · 可回链')
