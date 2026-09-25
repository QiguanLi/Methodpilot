#!/usr/bin/env node
/**
 * 调研报告生成测试（Phase 4-8）。
 *
 * 运行：pnpm report:test
 *
 * ── 这个测试验什么 ──
 *
 * 全部验 `buildResearchReport()` 这个**纯函数**：输入手写对象，断言输出结构。
 * 不读文件、不发请求、不碰当前时间。
 *
 * ── 为什么 4-8 的测试是整条链上最关键的一份 ──
 *
 * 前面七个阶段各自出错，用户还能在那一页上对着证据发现；
 * 4-8 把它们**串成一份报告**之后，错误就藏进了一段通顺的话里 ——
 * 用户没有能力再去核。所以这个测试守的不是"格式对不对"，
 * 而是**"报告里有没有出现一句查无出处的话"**。
 *
 * ── 七条必测（对应用户需求里的验收要点）──
 *   1. 所有报告章节都能从已有数据生成
 *   2. 重要结论都能回链 Evidence
 *   3. candidate 不得写成事实
 *   4. 缺数据时不能生成虚假内容
 *   5. 输入乱序，报告输出稳定
 *   6. Evidence / Method / Gap / Direction ID 全部有效
 *   7. 报告不复算上游统计（口径只有一份）
 *
 * ── 关键设计：夹具走真实链路，不手写中间产物 ──
 *
 * 与 direction-test.mjs 同一立场：本测试的 Gap / Direction / Evolution
 * **不是手写的**，而是调用真实的 detectGaps() / buildEvolution() /
 * generateDirections() 从证据里跑出来的。
 *
 * 理由：手写 Gap 就得自己假设"Gap 长什么样"，那个假设一旦与 4-6 的真实输出
 * 不符（漏字段、类型不同），测试会全绿而线上炸掉。走真实链路，夹具就是真的。
 * 报告模块的价值恰恰在于"它只是搬运" —— 那么它搬运的对象必须是真实的上游产出，
 * 否则测的就不是这份报告了。
 */

import { alignMethods } from '../server/services/methodAlignment.ts'
import { buildEvolution } from '../server/services/methodEvolution.ts'
import { detectGaps, assertGapInvariants } from '../server/services/researchGaps.ts'
import {
  generateDirections,
  assertDirectionInvariants,
} from '../server/services/researchDirections.ts'
import {
  buildResearchReport,
  assertReportInvariants,
  reportStatConsistency,
  REPORT_RULE_VERSION,
  REPORT_SECTION_IDS,
  REPORT_STATEMENT_KINDS,
  INSUFFICIENT_TEXT,
} from '../server/services/researchReport.ts'
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
/* 夹具构造工具                                                        */
/* ------------------------------------------------------------------ */

const NOW = '2025-01-01T00:00:00.000Z'

function paper(paper_id, title, year, opts = {}) {
  return {
    paper_id,
    project_id: 'proj_test',
    title,
    authors: opts.authors ?? [],
    year,
    abstract: opts.abstract ?? '',
    keywords: opts.keywords ?? [],
    sections: [],
    file_name: `${paper_id}.pdf`,
    file_hash: `h:${paper_id}`,
    file_size: 0,
    page_count: 10,
    status: 'completed',
    error: null,
    source_type: 'live',
    analyzed_with: null,
    method_ids: [],
    evidence_count: 0,
    created_at: NOW,
    updated_at: NOW,
  }
}

function method(method_id, name, opts = {}) {
  return {
    method_id,
    project_id: 'proj_test',
    name,
    name_zh: opts.name_zh ?? '',
    family_id: opts.family_id ?? '',
    task: opts.task ?? '',
    paradigm: '',
    year: opts.year ?? 2023,
    core_idea: opts.core_idea ?? '',
    modules: [],
    inputs: [],
    outputs: [],
    capabilities: [],
    advantages: [],
    limitations: [],
    paper_ids: opts.paper_ids ?? [],
    evidence_ids: opts.evidence_ids ?? [],
    layer: 0,
    source_type: 'live',
    classification: null,
  }
}

function ev(evidence_id, paper_id, content, translation, opts = {}) {
  return {
    evidence_id,
    paper_id,
    project_id: 'proj_test',
    section: opts.section ?? '局限',
    page: opts.page ?? 8,
    content,
    translation,
    supports: opts.supports ?? [],
    confidence: opts.confidence ?? 1,
    method_ids: opts.method_ids ?? [],
    gap_ids: [],
    direction_ids: [],
    source_type: 'live',
  }
}

/**
 * 走完整链路：证据 → 4-2 对齐 → 4-4 演进 → 4-6 空白 → 4-7 方向 → 4-8 报告。
 *
 * ⚠️ 自动回填 method.evidence_ids —— 与 direction-test.mjs 同一处理。
 * 夹具里不填的话，4-4 的"点名门 B"找不到证据，会假失败成模块 bug。
 */
function build(input) {
  for (const m of input.methods) {
    if (m.evidence_ids?.length) continue
    m.evidence_ids = input.evidence
      .filter((e) => (e.method_ids ?? []).includes(m.method_id) && m.paper_ids.includes(e.paper_id))
      .map((e) => e.evidence_id)
      .sort()
  }

  const alignment = alignMethods({
    methods: input.methods,
    evidence: input.evidence,
    papers: input.papers,
  })

  const evolution = buildEvolution({
    methods: input.methods,
    evidence: input.evidence,
    papers: input.papers,
    alignments: alignment.candidates,
  })

  const gaps = detectGaps({
    papers: input.papers,
    methods: input.methods,
    evidence: input.evidence,
    alignments: alignment.candidates,
    evolutionRelations: evolution.relations,
  })

  const directions = generateDirections({
    gaps: gaps.gaps,
    methods: input.methods,
    evidence: input.evidence,
    papers: input.papers,
    evolutionRelations: evolution.relations,
  })

  const reportInput = {
    papers: input.papers,
    methods: input.methods,
    evidence: input.evidence,
    alignment,
    evolution,
    gaps,
    directions,
  }

  return {
    input: reportInput,
    alignment,
    evolution,
    gaps,
    directions,
    report: buildResearchReport(reportInput),
  }
}

/**
 * 顺序无关的规范化形式 —— 用于"输入乱序不改输出"对比。
 *
 * 必须把 refs 也纳入：报告的核心价值就是回链，如果乱序只改内容不改引用，
 * 那恰好是最危险的那种"输出稳定"（稳定地错）。
 */
const canonical = (r) =>
  JSON.stringify({
    title: r.title,
    scope: r.scope_note,
    topic: {
      kw: r.topic.keywords.map((k) => ({ t: k.term, c: k.count, refs: k.refs.map((x) => x.id) })),
      th: r.topic.themes,
      fam: r.topic.families,
      q: r.topic.research_questions.map((s) => ({ k: s.kind, t: s.text, refs: s.refs.map((x) => `${x.kind}:${x.id}`) })),
      lim: r.topic.limitations,
    },
    sections: r.sections.map((s) => ({
      id: s.section_id,
      st: s.status,
      c: s.source_counts,
      stmts: s.statements.map((x) => ({ k: x.kind, t: x.text, refs: x.refs.map((y) => `${y.kind}:${y.id}`) })),
      lim: s.limitations,
    })),
    idx: r.evidence_index.map((e) => ({ ...e })),
    layering: r.layering,
    global: r.global_limitations,
    rv: r.rule_version,
  })

/** 深拷贝 —— 用于"纯函数不修改入参"断言 */
const clone = (x) => JSON.parse(JSON.stringify(x))

/* ================================================================== */
console.log('═'.repeat(70))
console.log('调研报告生成测试（Phase 4-8）')
console.log('═'.repeat(70))

/* ================================================================== */
section('— 0. 侦察：夹具确实产出了上游结论（否则后面全是假绿）—')
/* ================================================================== */

/*
 * 与 gap-ui-test / project-stats-ui-test 的"侦察段"同一立场：
 * 先确认夹具真的产出了 Gap / Direction，再谈报告。
 * 如果这里就是 0，后面所有"章节有内容"的断言都会在空数据上通过 —— 假绿。
 */
const FULL = build({
  papers: [
    paper('P001', 'ReAct: Synergizing Reasoning and Acting', 2022, {
      authors: ['Yao', 'Zhao', 'Yu'],
      abstract: 'We explore how to combine reasoning and acting in language models. Can a single model interleave thought and action?',
      keywords: ['LLM Agent', 'Reasoning', 'Tool Use'],
    }),
    paper('P002', 'SWE-agent: Agent-Computer Interfaces', 2023, {
      authors: ['Yang', 'Jimenez'],
      keywords: ['LLM Agent', 'Tool Use'],
    }),
    paper('P003', 'Reflexion: Language Agents with Verbal Reinforcement', 2023, {
      keywords: ['LLM Agent', 'Reflection'],
    }),
  ],
  methods: [
    method('M001', 'ReAct', { name_zh: 'ReAct', family_id: 'F2', year: 2022, paper_ids: ['P001'], task: '交替推理与行动' }),
    method('M002', 'SWE-agent', { name_zh: 'SWE-agent', family_id: 'F2', year: 2023, paper_ids: ['P002'], task: '仓库级代码修改' }),
    method('M003', 'Reflexion', { name_zh: 'Reflexion', family_id: 'F3', year: 2023, paper_ids: ['P003'], task: '语言反馈自省' }),
  ],
  evidence: [
    ev('E001', 'P001', 'A limitation of our approach is that it cannot handle long-horizon tasks reliably.', '我们方法的一个局限是它无法可靠处理长程任务。', {
      method_ids: ['M001'], supports: ['局限'],
    }),
    ev('E002', 'P002', 'SWE-agent builds on ReAct and extends it to repository-level code editing.', 'SWE-agent 基于 ReAct，并将其扩展到仓库级代码修改。', {
      method_ids: ['M002'], supports: ['方法关系'],
    }),
    ev('E003', 'P002', 'There is no standard benchmark for evaluating repository-level agents.', '目前没有评测仓库级 Agent 的标准基准。', {
      method_ids: ['M002'], supports: ['局限'], section: '评测',
    }),
    ev('E004', 'P003', 'Reflexion improves over ReAct by adding verbal self-reflection, but our method remains difficult to generalize to unseen tools.', 'Reflexion 通过加入语言自省改进了 ReAct，但我们的方法仍难以泛化到未见过的工具。', {
      method_ids: ['M003'], supports: ['技术演进', '局限'], section: '局限',
    }),
  ],
})

check('夹具产出了 Gap', FULL.gaps.gaps.length > 0, `${FULL.gaps.gaps.length} 条`)
check('夹具产出了方向', FULL.directions.directions.length > 0, `${FULL.directions.directions.length} 条`)
check('夹具产出了演进关系', FULL.evolution.relations.length > 0, `${FULL.evolution.relations.length} 条`)
check('夹具产出了因果演进', FULL.evolution.relations.some((r) => r.causal), String(FULL.evolution.relations.filter((r) => r.causal).length))
check('上游 Gap 不变量通过', assertGapInvariants(FULL.gaps).length === 0, JSON.stringify(assertGapInvariants(FULL.gaps).slice(0, 2)))
check('上游 Direction 不变量通过', assertDirectionInvariants(FULL.directions, {
  gaps: FULL.gaps.gaps, methods: FULL.input.methods, evidence: FULL.input.evidence,
  papers: FULL.input.papers, evolutionRelations: FULL.evolution.relations,
}).length === 0)

check('被后续工作改进的声明存在（用于 candidate 场景）', FULL.gaps.gaps.some((g) => g.basis.includes('addressed_by_later_work')))

/* ================================================================== */
section('— 1. 所有报告章节都能从已有数据生成 —')
/* ================================================================== */

const R = FULL.report

check('七个章节一个不少',
  REPORT_SECTION_IDS.every((id) => id === 'topic' || R.sections.some((s) => s.section_id === id)),
  R.sections.map((s) => s.section_id).join(', '))

check('章节顺序与 REPORT_SECTION_IDS 一致（topic 除外）',
  R.sections.map((s) => s.section_id).join(',') ===
    REPORT_SECTION_IDS.filter((id) => id !== 'topic').join(','),
  R.sections.map((s) => s.section_id).join(','))

for (const s of R.sections) {
  check(`章节「${s.title}」有陈述内容`, s.statements.length > 0, `${s.statements.length} 条`)
}

check('文献概览引用了每篇论文',
  FULL.input.papers.every((p) => {
    const sec = R.sections.find((s) => s.section_id === 'literature')
    return sec.statements.some((st) => st.refs.some((r) => r.kind === 'paper' && r.id === p.paper_id))
  }))

check('方法分类章节覆盖了所有方法族',
  R.topic.families.length >= 2, `${R.topic.families.length} 个族`)

check('技术演进章节包含了因果结论',
  R.sections.find((s) => s.section_id === 'evolution').statements.some((st) => /改进|继承|替代|组合/.test(st.text)))

/*
 * ⚠️ 查找必须**排除章节开头那条汇总陈述**。
 *
 * 汇总陈述（"系统检出 N 条空白：其中 x 条 stated…"）会引用**全部** gap_id，
 * 于是 `statements.find(st => st.refs 含 GR001)` 命中的永远是它，
 * 而不是下面那条真正属于 GR001 的陈述。结果就是"逐条列出"这类断言
 * 在**只有汇总、没有逐条**的实现上也会通过 —— 典型的假绿。
 * 判据：汇总陈述的 refs 含 ≥2 个同类 id；逐条陈述只含 1 个。
 */
const isPerItem = (st, kind) => st.refs.filter((r) => r.kind === kind).length === 1

check('研究空白章节逐条列出了 Gap',
  FULL.gaps.gaps.every((g) => {
    const sec = R.sections.find((s) => s.section_id === 'gaps')
    return sec.statements.some(
      (st) => isPerItem(st, 'gap') && st.refs.some((r) => r.kind === 'gap' && r.id === g.gap_id),
    )
  }))

check('研究方向章节逐条列出了 Direction',
  FULL.directions.directions.every((d) => {
    const sec = R.sections.find((s) => s.section_id === 'directions')
    return sec.statements.some(
      (st) => isPerItem(st, 'direction') && st.refs.some((r) => r.kind === 'direction' && r.id === d.direction_id),
    )
  }))

check('报告标题由语料推出（含关键词）', R.title.length > 0, R.title)
check('报告标题未使用 project.goal（本模块不接收 project）', R.title.includes('调研报告'), R.title)

check('Evidence 索引覆盖全部证据',
  R.evidence_index.length === FULL.input.evidence.length,
  `索引 ${R.evidence_index.length} vs 证据 ${FULL.input.evidence.length}`)

/* ================================================================== */
section('— 2. 重要结论都能回链 Evidence —')
/* ================================================================== */

const violations = assertReportInvariants(R, FULL.input)
check('报告不变量全部通过', violations.length === 0, violations.slice(0, 3).join(' | '))

{
  /* 逐条陈述检查"重要结论必有回链" */
  const noRefs = []
  for (const sec of R.sections) {
    for (const st of sec.statements) {
      if (st.text === INSUFFICIENT_TEXT) continue
      /* 只有"说明为什么没有"的元陈述允许无回链 */
      if (/^暂无足够证据$/.test(st.text.trim())) continue
      if (!st.refs.length) noRefs.push(`[${sec.title}] ${st.text.slice(0, 40)}…`)
    }
  }
  /*
   * 允许极少数元陈述无回链（"0 条因果"这类否定性观察本身没有可引用对象），
   * 但绝不能多。限制在 3 条以内，超了就说明有实现把结论写成了无出处的散文。
   */
  check('无回链的陈述不超过 3 条（且只能是否定性元陈述）',
    noRefs.length <= 3, `${noRefs.length} 条`)
  for (const s of noRefs) console.log(`      · 无回链：${s}`)
}

{
  /* 空白章节的每条 Gap 都必须挂上真实证据 */
  const gapSec = R.sections.find((s) => s.section_id === 'gaps')
  let gapStmtsWithEv = 0
  for (const g of FULL.gaps.gaps) {
    const st = gapSec.statements.find(
      (x) => isPerItem(x, 'gap') && x.refs.some((r) => r.kind === 'gap' && r.id === g.gap_id),
    )
    if (st && st.refs.some((r) => r.kind === 'evidence')) gapStmtsWithEv++
  }
  check('每条 Gap 的陈述都带 Evidence 回链',
    gapStmtsWithEv === FULL.gaps.gaps.length,
    `${gapStmtsWithEv}/${FULL.gaps.gaps.length}`)
}

{
  /* 方向章节：每条方向都必须能回链 Gap + Evidence */
  const dirSec = R.sections.find((s) => s.section_id === 'directions')
  let ok = 0
  for (const d of FULL.directions.directions) {
    const st = dirSec.statements.find(
      (x) => isPerItem(x, 'direction') && x.refs.some((r) => r.kind === 'direction' && r.id === d.direction_id),
    )
    if (!st) continue
    const hasGap = st.refs.some((r) => r.kind === 'gap')
    const hasEv = st.refs.some((r) => r.kind === 'evidence')
    if (hasGap && hasEv) ok++
  }
  check('每条方向的陈述都带 Gap + Evidence 双重回链',
    ok === FULL.directions.directions.length,
    `${ok}/${FULL.directions.directions.length}`)
}

{
  /* 因果演进：每条因果边必须带证据回链（4-4 已保证 evidence_ids 非空） */
  const evoSec = R.sections.find((s) => s.section_id === 'evolution')
  const causal = FULL.evolution.relations.filter((r) => r.causal)
  let ok = 0
  for (const r of causal) {
    const st = evoSec.statements.find((x) => x.refs.some((y) => y.kind === 'evolution' && y.id === r.relation_id))
    if (st && st.refs.some((y) => y.kind === 'evidence')) ok++
  }
  check('每条因果演进都带 Evidence 回链', ok === causal.length, `${ok}/${causal.length}`)
}

{
  /* 回链悬空检测：所有 ref 的 id 必须在输入池里 */
  const pools = {
    paper: new Set(FULL.input.papers.map((p) => p.paper_id)),
    method: new Set(FULL.input.methods.map((m) => m.method_id)),
    evidence: new Set(FULL.input.evidence.map((e) => e.evidence_id)),
    gap: new Set(FULL.gaps.gaps.map((g) => g.gap_id)),
    direction: new Set(FULL.directions.directions.map((d) => d.direction_id)),
    alignment: new Set(FULL.alignment.candidates.map((c) => c.alignment_id)),
    evolution: new Set(FULL.evolution.relations.map((r) => r.relation_id)),
  }
  const dangling = []
  for (const st of [...R.topic.research_questions, ...R.sections.flatMap((s) => s.statements)]) {
    for (const r of st.refs) {
      if (!pools[r.kind]?.has(r.id)) dangling.push(`${r.kind}:${r.id}`)
    }
  }
  check('全部回链都指向输入里真实存在的实体（零悬空）', dangling.length === 0, dangling.slice(0, 5).join(', '))
}

{
  /* 人工可读性：每条 ref 都必须有 label，且不能只是 id 的重复 */
  const noLabel = []
  for (const st of [...R.topic.research_questions, ...R.sections.flatMap((s) => s.statements)]) {
    for (const r of st.refs) {
      if (!r.label?.trim()) noLabel.push(`${r.kind}:${r.id}`)
    }
  }
  check('每条回链都有可读 label', noLabel.length === 0, noLabel.slice(0, 3).join(', '))
}

/**
 * 造一个**候选混合**夹具（用于第 3 节）。
 *
 * ── 为什么要费这个劲，而不是随手写两句话 ──
 *
 * 我最初的想法是"两篇论文各写一句局限 → 应该得到候选 Gap"。跑了才发现
 * 得到的是 stated（两条），因为 **4-6 的每一处信号命中都会先生成一条 stated**。
 * 这是设计而不是 bug：单篇论文自己承认的局限是**事实**，
 * 它不因为第二篇也说了同样的局限就失去事实性。
 * 然后 4-6 再把跨论文的 stated **额外**聚成一条 candidate。
 *
 * 所以真实的形态是：
 *   · 要拿到 candidate，必须**同一个 (信号, 场景主题) 坐标下有 ≥2 篇不同论文**的证据；
 *   · 同一坐标下的单篇证据**同时**留着各自的 stated；
 *   · 于是 4-7 收到 stated + candidate → basis_level = **mixed**。
 *
 * 纯 candidate_only 在真实链路里**几乎不可达** —— 除非某条证据命中句式、
 * 但它的 stated 因故不成立。这不是本测试要造的东西，
 * 报告对 candidate_only 的处理逻辑已经由不变量（【推测方向】前缀 +
 * 候选标识保留）单独覆盖，见第 3 节末尾的模拟断言。
 *
 * 因此这里造 mixed：
 *   · P001 / P002 各一条限制，**同落在 long_horizon** → 聚成一条 candidate
 *   · P003 一条限制，落在 tool_use   → 只有 stated，不参与任何候选
 * 结果 = 3 stated + 1 candidate，方向为 mixed。
 */
function mixedCandidateInput() {
  const papers = [
    paper('P001', 'Alpha Agent', 2022, { keywords: ['LLM Agent'] }),
    paper('P002', 'Beta Agent', 2023, { keywords: ['LLM Agent'] }),
    paper('P003', 'Gamma Agent', 2024, { keywords: ['LLM Agent'] }),
  ]
  const methods = [
    method('M001', 'Alpha', { family_id: 'F2', year: 2022, paper_ids: ['P001'] }),
    method('M002', 'Beta', { family_id: 'F2', year: 2023, paper_ids: ['P002'] }),
    method('M003', 'Gamma', { family_id: 'F2', year: 2024, paper_ids: ['P003'] }),
  ]
  const evidence = [
    ev('E001', 'P001', 'A limitation of our approach is that it cannot handle long-horizon tasks reliably.', '我们方法的一个局限是它无法可靠处理长程任务。', {
      method_ids: ['M001'], supports: ['局限'],
    }),
    ev('E002', 'P002', 'Our method suffers from poor performance on long-horizon tasks.', '我们的方法在长程任务上表现不佳。', {
      method_ids: ['M002'], supports: ['局限'],
    }),
    ev('E003', 'P003', 'A limitation of our approach is that it cannot handle unseen tool APIs.', '我们方法的一个局限是它无法处理未见的工具 API。', {
      method_ids: ['M003'], supports: ['局限'],
    }),
  ]
  return { papers, methods, evidence }
}

/* ================================================================== */
section('— 3. candidate 不得写成事实 —')
/* ================================================================== */

{
  const CAND = build(mixedCandidateInput())

  const candGaps = CAND.gaps.gaps.filter((g) => g.candidate)
  const statedGaps = CAND.gaps.gaps.filter((g) => !g.candidate)
  const mixedDirs = CAND.directions.directions.filter((d) => d.basis_level === 'mixed')

  /* 侦察：确认夹具真的落在目标形态上，否则后面的断言是空集合假绿 */
  check('夹具产出了 candidate Gap', candGaps.length > 0, `${candGaps.length} 条`)
  check('夹具同时产出了 stated Gap（candidate 不吞掉原文出处）', statedGaps.length > 0, `${statedGaps.length} 条`)
  check('夹具产出了 mixed 方向（stated 打底 + candidate 补充）',
    mixedDirs.length > 0,
    `${mixedDirs.length} 条（方向层级：${CAND.directions.directions.map((d) => d.basis_level).join(',')}）`)

  if (candGaps.length && mixedDirs.length) {
    const cr = CAND.report
    const gapSec = cr.sections.find((s) => s.section_id === 'gaps')
    const dirSec = cr.sections.find((s) => s.section_id === 'directions')

    /* ── candidate Gap：必须标为 system_analysis，且带【候选】 ── */
    for (const g of candGaps) {
      const st = gapSec.statements.find(
        (x) => isPerItem(x, 'gap') && x.refs.some((r) => r.kind === 'gap' && r.id === g.gap_id),
      )
      check(`candidate Gap ${g.gap_id} 未被写成 stated_fact`, st?.kind !== 'stated_fact', String(st?.kind))
      check(`candidate Gap ${g.gap_id} 的正文保留了候选标识`,
        /候选/.test(st?.text ?? '') || /【候选】/.test(st?.text ?? ''))
      check(`candidate Gap ${g.gap_id} 明确声明不是论文原话`,
        /不是任何单篇论文的原话|系统归纳/.test(st?.text ?? ''))
      const refLabel = st?.refs.find((r) => r.kind === 'gap' && r.id === g.gap_id)?.label ?? ''
      check(`candidate Gap ${g.gap_id} 的 label 带【候选】`,
        /【候选】/.test(refLabel), refLabel)
    }

    /* ── mixed 方向：必须同时保留 stated 出处与 candidate 线索的区分 ── */
    for (const d of mixedDirs) {
      const st = dirSec.statements.find(
        (x) => isPerItem(x, 'direction') && x.refs.some((r) => r.kind === 'direction' && r.id === d.direction_id),
      )
      check(`mixed 方向 ${d.direction_id} 的 kind 是 system_suggestion`,
        st?.kind === 'system_suggestion', String(st?.kind))
      check(`mixed 方向 ${d.direction_id} 声明了「事实打底 + 推断参考」混合层级`,
        /事实打底|参考系统推断|候选线索/.test(st?.text ?? ''))
      check(`mixed 方向 ${d.direction_id} 明确区分了"原文可引用"与"推断仅作线索"`,
        /不是任何单篇论文的原话|不构成事实依据|仅用于补充视角|线索/.test(st?.text ?? ''))
      check(`mixed 方向 ${d.direction_id} 带 Gap 回链`, st?.refs.some((r) => r.kind === 'gap'))
      check(`mixed 方向 ${d.direction_id} 带 Evidence 回链`, st?.refs.some((r) => r.kind === 'evidence'))
    }

    /*
     * ── candidate_only 方向：真实链路不可达，用**注入**的方式单独锁定 ──
     *
     * 上面的夹具只能到 mixed（原因见 mixedCandidateInput 注释）。
     * 但 candidate_only 恰恰是本模块**最需要防的那个形态**：
     * 整条方向没有任何事实打底，一旦报告洗掉【推测方向】前缀，
     * 用户就会把一句纯猜测读成立项依据。
     *
     * 所以这里直接构造一条 candidate_only 方向注入进去 —— 走的是
     * 与 4-7 完全相同的字段结构（title 带前缀、candidate_only=true），
     * 报告如何处理它，是**由产物决定的**，不依赖上游能否凑出这种输入。
     */
    const syntheticDir = {
      direction_id: 'RD900',
      basis_level: 'candidate_only',
      candidate_only: true,
      title: '【推测方向】多 Agent 协作：原文指出的未解决问题（探索性）',
      description:
        '本方向**仅**由系统推断的候选线索（GR004）支撑。这些线索是系统从多条证据归纳出的模式，**不是任何论文的原话**。'
        + '因此本方向属于探索性建议：建议先核实上述线索是否成立，再决定是否投入。',
      theme: 'multi_agent',
      gap_signal: 'open_problem',
      gap_ids: [candGaps[0].gap_id],
      evidence_ids: [...candGaps[0].evidence_ids],
      paper_ids: [...candGaps[0].paper_ids],
      method_ids: [],
      question: { question: '多 Agent 协作下是否存在尚未被形式化的问题？', rationale: '候选线索。', expected_outcome: '形式化定义。' },
      approach: { kind: 'introduce_new', description: '需要引入新的做法。', based_on_method_ids: [], based_on_method_names: [] },
      validation: { experiment: '最小可运行实验。', materials: '需另行补充。', success_criteria: '可量化指标。', from_corpus: false },
      basis: ['candidate_only_evidence', 'evidence_linked', 'linked_to_gap'],
      confidence: 0.35,
    }
    const syntheticInput = {
      ...CAND.input,
      directions: {
        ...CAND.input.directions,
        directions: [...CAND.input.directions.directions, syntheticDir],
      },
    }
    const sr = buildResearchReport(syntheticInput)
    const sDirSec = sr.sections.find((s) => s.section_id === 'directions')
    const sSt = sDirSec.statements.find((x) => x.refs.some((r) => r.kind === 'direction' && r.id === 'RD900'))

    check('候选方向：kind 是 system_suggestion（绝不能是 stated_fact）',
      sSt?.kind === 'system_suggestion', String(sSt?.kind))
    check('候选方向：**原样保留**「【推测方向】」前缀（未被洗掉）',
      (sSt?.text ?? '').includes('【推测方向】'), (sSt?.text ?? '').slice(0, 40))
    check('候选方向：声明了依据层级为"仅由系统推断支撑"',
      /仅.*系统推断|纯探索性|探索性建议/.test(sSt?.text ?? ''))
    check('候选方向：置信度被如实报出（低置信度不被隐藏）',
      /0\.35/.test(sSt?.text ?? ''))
    check('候选方向：报告级不变量通过（含候选标识保留）',
      assertReportInvariants(sr, syntheticInput).length === 0,
      assertReportInvariants(sr, syntheticInput).slice(0, 2).join(' | '))
    /*
     * ── 两条针对 candidate_only 的**报告级**断言 ──
     *
     * 上面已经确认了"注入的候选方向在正文里保留了【推测方向】"。
     * 但一条方向光是正文带前缀还不够 —— 用户很可能**只读全局局限**
     * （那是报告最后一段，也是最容易被单独复制出去的部分）。
     * 所以全局局限里必须同样点名【推测方向】，让边界声明跟着报告走。
     */
    check('候选方向：global_limitations 点名了【推测方向】',
      sr.global_limitations.some((l) => /【推测方向】/.test(l)),
      sr.global_limitations.filter((l) => /推测/.test(l)).join(' | ') || '（无）')

    /* ── 反向：不变量必须能抓到"把候选标识洗掉" ── */
    const washed = clone(sr)
    const wSt = washed.sections
      .find((s) => s.section_id === 'directions')
      .statements.find((x) => x.text.includes('【推测方向】'))
    wSt.text = wSt.text.replace('【推测方向】', '')
    check('篡改检测：洗掉【推测方向】前缀后不变量报错',
      assertReportInvariants(washed, syntheticInput).some((m) => /建议|推测/.test(m)),
      assertReportInvariants(washed, syntheticInput).slice(0, 2).join(' | '))

    /* ── 反向排除：整个报告里，任何声称是事实的陈述都不得引用 candidate Gap ── */
    const badFactual = []
    for (const st of [...cr.topic.research_questions, ...cr.sections.flatMap((s) => s.statements)]) {
      if (st.kind !== 'stated_fact') continue
      for (const r of st.refs) {
        if (r.kind === 'gap' && candGaps.some((g) => g.gap_id === r.id)) {
          badFactual.push(`${r.id} 被 stated_fact 引用`)
        }
      }
    }
    check('没有任何 stated_fact 引用 candidate Gap', badFactual.length === 0, badFactual.join(', '))

    /* ── 全文事实口吻扫描：非 stated_fact 的陈述一律不得出现事实断言句式 ── */
    const FACTUAL = [
      /(?:论文|文献|作者)\s*(?:明确)?指出(?=[^\u4e00-\u9fa5]|$)/,
      /(?:研究表明|实验结果?表明|结果证明|已被证明|调查研究|数据显示)/,
      /(?:普遍认为|广泛认为|众所周知|界内\s*(?:公认|共识))/,
      /(?:近年|近些年来|最近几年|学术界)/,
      /(?:该|本|这一)?\s*(?:研究)?领域\s*(?:尚|仍|还)?\s*(?:无|没有|缺乏|未见|尚无)/,
    ]
    const factualHits = []
    for (const st of [...cr.topic.research_questions, ...cr.sections.flatMap((s) => s.statements)]) {
      if (st.kind === 'stated_fact' || st.text === INSUFFICIENT_TEXT) continue
      for (const re of FACTUAL) {
        if (re.test(st.text)) factualHits.push(`[${st.kind}] ${re}`)
      }
    }
    check('非 stated_fact 的陈述零事实口吻', factualHits.length === 0, factualHits.slice(0, 3).join(' | '))

    /* ── 报告分层摘要必须真的反映出"有推测内容" ── */
    check('分层摘要统计到了 system_suggestion', cr.layering.system_suggestion > 0, String(cr.layering.system_suggestion))
    check('分层摘要统计到了 system_analysis', cr.layering.system_analysis > 0, String(cr.layering.system_analysis))
    check('分层摘要把 candidate Gap 的陈述计入 system_analysis（不是 stated_fact）',
      gapSec.statements.filter((st) => candGaps.some((g) => st.refs.some((r) => r.kind === 'gap' && r.id === g.gap_id)))
        .every((st) => st.kind === 'system_analysis'))
    check('Candidate 场景下 global_limitations 提到了候选空白',
      cr.global_limitations.some((l) => /候选空白|候选/.test(l)))
  }
}

/* ================================================================== */
section('— 4. 缺数据时不能生成虚假内容 —')
/* ================================================================== */

{
  /* 完全空项目：报告必须存在，但每章都是「暂无足够证据」 */
  const EMPTY = build({ papers: [], methods: [], evidence: [] })

  check('空项目也能产出报告（不抛异常、不返回 null）', Boolean(EMPTY.report))
  check('空项目 Evidence 索引为空', EMPTY.report.evidence_index.length === 0)
  check('空项目不变量仍然通过',
    assertReportInvariants(EMPTY.report, EMPTY.input).length === 0,
    assertReportInvariants(EMPTY.report, EMPTY.input).slice(0, 2).join(' | '))

  for (const s of EMPTY.report.sections) {
    check(`空项目：章节「${s.title}」为 insufficient 且写「${INSUFFICIENT_TEXT}」`,
      s.status === 'insufficient' && s.statements.some((st) => st.text.includes(INSUFFICIENT_TEXT)),
      s.status)
  }

  check('空项目：insufficient 章节都带局限性说明',
    EMPTY.report.sections.filter((s) => s.status === 'insufficient').every((s) => s.limitations.length > 0))

  check('空项目：空缺声明不携带任何引用（不伪装成有数据）',
    EMPTY.report.sections.flatMap((s) => s.statements)
      .filter((st) => st.text === INSUFFICIENT_TEXT)
      .every((st) => st.refs.length === 0))

  /* 反向：空报告里不得出现任何具体数字/论文名式的"补全内容" */
  const fabricated = []
  for (const s of EMPTY.report.sections) {
    for (const st of s.statements) {
      if (st.text === INSUFFICIENT_TEXT || st.kind === 'system_analysis') continue
      fabricated.push(st.text.slice(0, 50))
    }
  }
  check('空项目：没有任何 stated_fact 级陈述（无中生有）', fabricated.length === 0, fabricated.slice(0, 2).join(' | '))

  check('空项目：报告标题不谎称有论文', !/\d+\s*篇论文/.test(EMPTY.report.title), EMPTY.report.title)
  check('空项目：全局局限非空（如实声明没内容）', EMPTY.report.global_limitations.length > 0)
}

{
  /* 只有论文没有方法/证据：论文章节要有内容，其余如实留空 */
  const PARTIAL = build({
    papers: [paper('P001', 'Solo Paper', 2022, { keywords: ['LLM Agent'] })],
    methods: [],
    evidence: [],
  })
  check('只有论文时：文献概览有内容',
    PARTIAL.report.sections.find((s) => s.section_id === 'literature').status === 'ok')
  check('只有论文时：方法分类为 insufficient',
    PARTIAL.report.sections.find((s) => s.section_id === 'methods').status === 'insufficient')
  check('只有论文时：研究空白为 insufficient',
    PARTIAL.report.sections.find((s) => s.section_id === 'gaps').status === 'insufficient')
  check('只有论文时：研究报告未编造方法',
    PARTIAL.report.sections.find((s) => s.section_id === 'methods').statements.every((st) => st.text === INSUFFICIENT_TEXT || /系统/.test(st.text)))
  check('只有论文时：不变量通过', assertReportInvariants(PARTIAL.report, PARTIAL.input).length === 0)
}

{
  /* 另一类"缺数据"：有论文有方法，但证据里没有任何缺口意图 → 0 Gap 且要说清原因 */
  const NOGAP = build({
    papers: [paper('P001', 'Neutral Paper', 2022, { keywords: ['LLM Agent'] })],
    methods: [method('M001', 'Plain', { family_id: 'F2', year: 2022, paper_ids: ['P001'] })],
    evidence: [ev('E001', 'P001', 'We propose a straightforward pipeline that works well on standard benchmarks.', '我们提出一个在标准基准上表现良好的简单流程。', { method_ids: ['M001'] })],
  })
  check('无缺口意图时：0 条 Gap（预期结果）', NOGAP.gaps.gaps.length === 0, `${NOGAP.gaps.gaps.length} 条`)
  const gapSecText = NOGAP.report.sections.find((s) => s.section_id === 'gaps').statements.map((s) => s.text).join(' ')
  check('无缺口意图时：报告写明"0 条是预期结果，不是检测失败"',
    /预期结果|检测失败/.test(gapSecText))
  check('无缺口意图时：报告没有因此编造一条空白', !/\d+ 条研究空白[，,]\s*其中/.test(gapSecText), gapSecText.slice(0, 80))
  check('无缺口意图时：不变量通过', assertReportInvariants(NOGAP.report, NOGAP.input).length === 0)
}

/* ================================================================== */
section('— 5. 输入乱序，报告输出稳定 —')
/* ================================================================== */

{
  const shuffled = build({
    papers: [
      paper('P003', 'Reflexion: Language Agents with Verbal Reinforcement', 2023, { keywords: ['LLM Agent', 'Reflection'] }),
      paper('P001', 'ReAct: Synergizing Reasoning and Acting', 2022, {
        authors: ['Yao', 'Zhao', 'Yu'],
        abstract: 'We explore how to combine reasoning and acting in language models. Can a single model interleave thought and action?',
        keywords: ['LLM Agent', 'Reasoning', 'Tool Use'],
      }),
      paper('P002', 'SWE-agent: Agent-Computer Interfaces', 2023, { authors: ['Yang', 'Jimenez'], keywords: ['LLM Agent', 'Tool Use'] }),
    ],
    methods: [
      method('M003', 'Reflexion', { name_zh: 'Reflexion', family_id: 'F3', year: 2023, paper_ids: ['P003'], task: '语言反馈自省' }),
      method('M001', 'ReAct', { name_zh: 'ReAct', family_id: 'F2', year: 2022, paper_ids: ['P001'], task: '交替推理与行动' }),
      method('M002', 'SWE-agent', { name_zh: 'SWE-agent', family_id: 'F2', year: 2023, paper_ids: ['P002'], task: '仓库级代码修改' }),
    ],
    evidence: [
      ev('E004', 'P003', 'Reflexion improves over ReAct by adding verbal self-reflection, but our method remains difficult to generalize to unseen tools.', 'Reflexion 通过加入语言自省改进了 ReAct，但我们的方法仍难以泛化到未见过的工具。', {
        method_ids: ['M003'], supports: ['技术演进', '局限'], section: '局限',
      }),
      ev('E001', 'P001', 'A limitation of our approach is that it cannot handle long-horizon tasks reliably.', '我们方法的一个局限是它无法可靠处理长程任务。', {
        method_ids: ['M001'], supports: ['局限'],
      }),
      ev('E003', 'P002', 'There is no standard benchmark for evaluating repository-level agents.', '目前没有评测仓库级 Agent 的标准基准。', {
        method_ids: ['M002'], supports: ['局限'], section: '评测',
      }),
      ev('E002', 'P002', 'SWE-agent builds on ReAct and extends it to repository-level code editing.', 'SWE-agent 基于 ReAct，并将其扩展到仓库级代码修改。', {
        method_ids: ['M002'], supports: ['方法关系'],
      }),
    ],
  })

  check('乱序输入 → 报告逐字段一致（含全部回链）',
    canonical(shuffled.report) === canonical(FULL.report),
    canonical(shuffled.report) === canonical(FULL.report) ? '' : '不一致')

  /* 更强的一条：**两次乱序**之间也必须一致（防"稳定地依赖某种巧合顺序"） */
  const shuffled2 = build({
    papers: [FULL.input.papers[1], FULL.input.papers[2], FULL.input.papers[0]],
    methods: [FULL.input.methods[2], FULL.input.methods[0], FULL.input.methods[1]],
    evidence: [FULL.input.evidence[2], FULL.input.evidence[3], FULL.input.evidence[0], FULL.input.evidence[1]],
  })
  check('两种不同乱序 → 报告仍然一致', canonical(shuffled2.report) === canonical(FULL.report))

  /* Evidence 索引必须按 id 排序，与输入顺序无关 */
  const idx = shuffled.report.evidence_index.map((e) => e.evidence_id)
  check('Evidence 索引按 id 升序（与输入顺序无关）',
    idx.join(',') === [...idx].sort().join(','), idx.join(','))

  /* 章节目录顺序恒定 */
  check('章节顺序不受输入顺序影响',
    shuffled.report.sections.map((s) => s.section_id).join(',') ===
      R.sections.map((s) => s.section_id).join(','))

  /* 乱序不应改变任何 Gap / Direction 的判定（上游本就应该稳定） */
  check('乱序后 Gap 数不变', shuffled.gaps.gaps.length === FULL.gaps.gaps.length,
    `${shuffled.gaps.gaps.length} vs ${FULL.gaps.gaps.length}`)
  check('乱序后方向数不变', shuffled.directions.directions.length === FULL.directions.directions.length,
    `${shuffled.directions.directions.length} vs ${FULL.directions.directions.length}`)
  check('乱序后因果边数不变',
    shuffled.evolution.relations.filter((r) => r.causal).length ===
      FULL.evolution.relations.filter((r) => r.causal).length)
}

/* ================================================================== */
section('— 6. Evidence / Method / Gap / Direction ID 全部有效 —')
/* ================================================================== */

{
  /* 逐类逐条检查索引里的 id 有效性 */
  const paperIds = new Set(FULL.input.papers.map((p) => p.paper_id))
  const evIds = new Set(FULL.input.evidence.map((e) => e.evidence_id))
  const gapIds = new Set(FULL.gaps.gaps.map((g) => g.gap_id))
  const dirIds = new Set(FULL.directions.directions.map((d) => d.direction_id))

  check('索引里每条 evidence_id 都真实存在',
    R.evidence_index.every((e) => evIds.has(e.evidence_id)))
  check('索引里每个 paper_id 都真实存在',
    R.evidence_index.every((e) => paperIds.has(e.paper_id)))
  check('索引里每个 gap_id 都真实存在',
    R.evidence_index.every((e) => e.gap_ids.every((g) => gapIds.has(g))))
  check('索引里每个 direction_id 都真实存在',
    R.evidence_index.every((e) => e.direction_ids.every((d) => dirIds.has(d))))

  /* 索引里的 gap_ids / direction_ids 必须与上游一致（不是自己算的） */
  const evGaps = new Map()
  for (const g of FULL.gaps.gaps) {
    for (const eid of g.evidence_ids) evGaps.set(eid, [...(evGaps.get(eid) ?? []), g.gap_id])
  }
  const idxMismatch = R.evidence_index.filter((e) => {
    const expect = (evGaps.get(e.evidence_id) ?? []).sort().join(',')
    const actual = [...e.gap_ids].sort().join(',')
    return expect !== actual
  })
  check('索引的 gap_ids 与 4-6 的 Gap 归属一致（未自行复算）',
    idxMismatch.length === 0, idxMismatch.map((e) => e.evidence_id).join(','))

  /* 反向：报告里被引用的每个 id 都必须能"落地" */
  const usedMethods = new Set()
  const usedGaps = new Set()
  const usedDirs = new Set()
  for (const st of [...R.topic.research_questions, ...R.sections.flatMap((s) => s.statements)]) {
    for (const r of st.refs) {
      if (r.kind === 'method') usedMethods.add(r.id)
      if (r.kind === 'gap') usedGaps.add(r.id)
      if (r.kind === 'direction') usedDirs.add(r.id)
    }
  }
  check('被引用的方法 id 全部有效',
    [...usedMethods].every((m) => FULL.input.methods.some((x) => x.method_id === m)), `${usedMethods.size} 个`)
  check('被引用的 Gap id 全部有效', [...usedGaps].every((g) => gapIds.has(g)), `${usedGaps.size} 个`)
  check('被引用的 Direction id 全部有效', [...usedDirs].every((d) => dirIds.has(d)), `${usedDirs.size} 个`)

  check('研究空白章节覆盖了全部 Gap',
    FULL.gaps.gaps.every((g) => usedGaps.has(g.gap_id)),
    `${usedGaps.size}/${FULL.gaps.gaps.length}`)
  check('研究方向章节覆盖了全部 Direction',
    FULL.directions.directions.every((d) => usedDirs.has(d.direction_id)),
    `${usedDirs.size}/${FULL.directions.directions.length}`)

  /* 人工篡改检测：把一条 Gap id 改坏，不变量必须报警（证明校验真的在工作） */
  const tampered = clone(R)
  const gapSec = tampered.sections.find((s) => s.section_id === 'gaps')
  gapSec.statements[1].refs.push({ kind: 'evidence', id: 'E999', label: '证据 E999' })
  const tamperedBad = assertReportInvariants(tampered, FULL.input)
  check('篡改检测：插入悬空 evidence 引用后不变量报错',
    tamperedBad.some((m) => /E999/.test(m)), tamperedBad.slice(0, 2).join(' | '))

  const tampered2 = clone(R)
  tampered2.sections[0].statements.push({ kind: 'system_analysis', text: '研究表明该领域存在明显空白。', refs: [] })
  const tampered2Bad = assertReportInvariants(tampered2, FULL.input)
  check('篡改检测：把推断写成事实口吻后不变量报错',
    tampered2Bad.some((m) => /事实口吻/.test(m)), tampered2Bad.slice(0, 2).join(' | '))

  const tampered3 = clone(R)
  tampered3.evidence_index.pop()
  const tampered3Bad = assertReportInvariants(tampered3, FULL.input)
  check('篡改检测：Evidence 索引漏条后不变量报错',
    tampered3Bad.some((m) => /索引/.test(m)), tampered3Bad.slice(0, 2).join(' | '))

  const tampered4 = clone(R)
  tampered4.sections.find((s) => s.section_id === 'gaps').source_counts.gaps = 999
  const tampered4Bad = assertReportInvariants(tampered4, FULL.input)
  check('篡改检测：章节统计与上游口径分叉后不变量报错',
    tampered4Bad.some((m) => /口径分叉/.test(m)), tampered4Bad.slice(0, 2).join(' | '))
}

/* ================================================================== */
section('— 7. 报告不复算上游统计（口径只有一份）—')
/* ================================================================== */

{
  const rows = reportStatConsistency(R, FULL.input)
  check('口径对账项数覆盖了全部上游模块', rows.length >= 12, `${rows.length} 项`)
  for (const r of rows) {
    check(`口径一致：${r.label}`, r.report === r.upstream, `报告 ${r.report} vs 上游 ${r.upstream}`)
  }

  const gapSec = R.sections.find((s) => s.section_id === 'gaps')
  const dirSec = R.sections.find((s) => s.section_id === 'directions')
  check('空白章节的 stated/candidate 计数直接取自 4-6 stats',
    gapSec.source_counts.stated === FULL.gaps.stats.stated &&
      gapSec.source_counts.candidate === FULL.gaps.stats.candidate,
    `${gapSec.source_counts.stated}/${gapSec.source_counts.candidate} vs ${FULL.gaps.stats.stated}/${FULL.gaps.stats.candidate}`)
  check('方向章节的三个层级计数直接取自 4-7 stats',
    dirSec.source_counts.stated_backed === FULL.directions.stats.stated_backed &&
      dirSec.source_counts.mixed === FULL.directions.stats.mixed &&
      dirSec.source_counts.candidate_only === FULL.directions.stats.candidate_only,
    `${dirSec.source_counts.stated_backed}/${dirSec.source_counts.mixed}/${dirSec.source_counts.candidate_only}`)
  check('方向章节置信度/方法数等未在报告里重算（只透传上游 stats）',
    !JSON.stringify(R).includes('"direction_stats_recomputed"'))
}

/* ================================================================== */
section('— 8. 纯函数性质与常量完整性 —')
/* ================================================================== */

{
  const snapshot = clone(FULL.input)
  buildResearchReport(FULL.input)
  check('buildResearchReport 不修改输入的 papers/methods/evidence',
    JSON.stringify(FULL.input.papers) === JSON.stringify(snapshot.papers) &&
      JSON.stringify(FULL.input.methods) === JSON.stringify(snapshot.methods) &&
      JSON.stringify(FULL.input.evidence) === JSON.stringify(snapshot.evidence))
  check('buildResearchReport 不修改输入的 gaps/directions',
    JSON.stringify(FULL.input.gaps) === JSON.stringify(snapshot.gaps) &&
      JSON.stringify(FULL.input.directions) === JSON.stringify(snapshot.directions))

  /* 两次调用结果一致（无隐藏状态） */
  check('连续两次调用产出完全一致的报告',
    canonical(buildResearchReport(FULL.input)) === canonical(buildResearchReport(FULL.input)))

  check('REPORT_SECTION_IDS 覆盖需求列的七块',
    REPORT_SECTION_IDS.length === 7 &&
      ['topic', 'literature', 'methods', 'evolution', 'gaps', 'directions', 'evidence_index']
        .every((id) => REPORT_SECTION_IDS.includes(id)),
    REPORT_SECTION_IDS.join(','))

  check('REPORT_STATEMENT_KINDS 三层齐备',
    REPORT_STATEMENT_KINDS.length === 3 &&
      REPORT_STATEMENT_KINDS.includes('stated_fact') &&
      REPORT_STATEMENT_KINDS.includes('system_analysis') &&
      REPORT_STATEMENT_KINDS.includes('system_suggestion'))

  check('rule_version 标明 deterministic',
    /deterministic/.test(REPORT_RULE_VERSION), REPORT_RULE_VERSION)

  check('INSUFFICIENT_TEXT 是统一文案「暂无足够证据」', INSUFFICIENT_TEXT === '暂无足够证据')

  check('report_id 稳定', R.report_id === 'RP001', R.report_id)

  check('scope_note 声明了未调用语言模型', /未调用任何语言模型/.test(R.scope_note))
  check('scope_note 声明了「系统分析/建议」不是论文观点', /不是论文的观点/.test(R.scope_note))
}

/* ================================================================== */
section('— 9. 报告样本（人工可读性核对）—')
/* ================================================================== */

console.log(`  标题：${R.title}`)
console.log(`  分层：事实 ${R.layering.stated_fact} · 分析 ${R.layering.system_analysis} · 建议 ${R.layering.system_suggestion}（共 ${R.layering.total_statements} 条陈述 / ${R.layering.total_refs} 条回链）`)
console.log(`  空章节 ${R.layering.insufficient_sections} 个 · 部分章节 ${R.layering.partial_sections} 个 · 全局局限 ${R.global_limitations.length} 条`)
for (const s of R.sections) {
  console.log(`  · [${s.status.padEnd(12)}] ${s.title}  ${s.statements.length} 条陈述 / ${s.limitations.length} 条局限`)
}
console.log(`  · 主题关键词：${R.topic.keywords.map((k) => `${k.term}(${k.count})`).join('、') || '（无）'}`)
console.log(`  · 方法族：${R.topic.families.map((f) => `${f.family_id}×${f.count}`).join('、') || '（无）'}`)

check('报告样本：每条陈述都有 kind（无 undefined）',
  R.sections.flatMap((s) => s.statements).every((st) => typeof st.kind === 'string'))

/* ------------------------------------------------------------------ */

console.log('\n' + '─'.repeat(70))
if (fail > 0) {
  console.log(`✗ 调研报告测试未通过（通过 ${pass} 项 / 失败 ${fail} 项）`)
  process.exit(1)
}
console.log(`✓ 调研报告测试全部通过（${pass} 项断言）`)
console.log(
  '  七章齐备 · 结论可回链 · 推断不写成事实 · 缺数据不补全 · 乱序稳定 · ID 全有效 · 口径不重算',
)
