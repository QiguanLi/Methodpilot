#!/usr/bin/env node
/**
 * 研究空白检测测试（Phase 4-6）。
 *
 * 运行：pnpm gap:test
 *
 * ── 这个测试最怕什么 ──
 *
 * Gap 模块最大的风险不是"漏掉"，而是**把话说过头**。
 * 两类过头方式，都必须被这里挡住：
 *
 *   1. **把推断写成事实。** 系统看到三篇论文都提了"长周期任务困难"，
 *      就说"长周期任务是一个研究空白" —— 这是一个归纳，不是一个事实。
 *      用户会拿它当既有结论引用。需求原文那句"推断型 Gap 必须标记 candidate，
 *      不能写成既定事实"针对的就是这个。
 *
 *   2. **凭"没看到"推出"没有"。** "我们的语料里没人解决 X" 被写成 "X 是空白"。
 *      这是**最危险**的一类编造，因为它看起来是归纳、实际是语料的局限性。
 *      本模块在架构上就不产出这类结论（见 researchGaps.ts 文件头注释），
 *      这里用断言把它钉死。
 *
 * 所以每一组"能产出 Gap"的断言后面，都紧跟一组**反向断言**：
 * 证明在证据不足、只有泛泛总结、只有单篇自述时，模块确实**拒绝**下结论。
 * 只测正向的话，一个"把所有 evidence 都变成 Gap"的坏实现也能全绿。
 *
 * 所有输入都是**构造的假数据**，不是真实项目数据 —— 这样断言才能精确到
 * "为什么这条应该/不应该成为 Gap"。真实数据由 verify-live 负责。
 */

import {
  detectGaps,
  summarizeGaps,
  assertGapInvariants,
  isGapSignalType,
  isGapAssertionLevel,
  GAP_SIGNAL_TYPES,
  GAP_RULE_VERSION,
  gapSignalLabel,
  gapThemeLabel,
} from '../server/services/researchGaps.ts'

/* ------------------------------------------------------------------ */

const errors = []
let pass = 0
const check = (cond, msg) => {
  if (cond) pass++
  else errors.push(msg)
}
const eq = (actual, expected, msg) => {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`,
  )
}
const section = (t) => console.log(`\n— ${t} —`)

/* ------------------------------------------------------------------ */
/* 构造器：让测试聚焦在"判定逻辑"而不是"拼对象"                          */
/* ------------------------------------------------------------------ */

const PAPER = (id, year = 2023, title = '') => ({
  paper_id: id,
  project_id: 'proj_test',
  file_name: `${id}.pdf`,
  file_hash: `hash_${id}`,
  file_size: 1000,
  page_count: 10,
  title: title || `Paper ${id}`,
  authors: [],
  year,
  abstract: '',
  keywords: [],
  sections: [],
  status: 'completed',
  error: null,
  source_type: 'demo',
  analyzed_with: null,
  method_ids: [],
  evidence_count: 0,
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
})

const METHOD = (id, paperId, name, extra = {}) => ({
  method_id: id,
  project_id: 'proj_test',
  name,
  name_zh: extra.name_zh ?? '',
  family_id: extra.family_id ?? '',
  task: extra.task ?? '',
  paradigm: extra.paradigm ?? '',
  year: extra.year ?? 2023,
  core_idea: extra.core_idea ?? '',
  modules: extra.modules ?? [],
  inputs: [],
  outputs: [],
  capabilities: [],
  advantages: extra.advantages ?? [],
  limitations: extra.limitations ?? [],
  paper_ids: [paperId],
  evidence_ids: extra.evidence_ids ?? [],
  layer: 0,
  source_type: 'demo',
  classification: null,
})

const EVID = (id, paperId, content, extra = {}) => ({
  evidence_id: id,
  paper_id: paperId,
  project_id: 'proj_test',
  section: extra.section ?? 'Section 7 Limitations',
  page: extra.page ?? 9,
  content,
  /** 中文释义。默认空 —— 只有专门测中文命中时才填 */
  translation: extra.translation ?? '',
  supports: extra.supports ?? ['方法核心思想'],
  confidence: extra.confidence ?? 0.9,
  method_ids: extra.method_ids ?? [],
  gap_ids: [],
  direction_ids: [],
  source_type: 'demo',
})

/** 4-2 对齐候选。只填本模块真正会读的字段 */
const ALIGN = (id, a, b, relation_type, extra = {}) => ({
  alignment_id: id,
  relation_type,
  confidence: extra.confidence ?? 0.8,
  basis: extra.basis ?? [],
  reason: extra.reason ?? '',
  evidence_ids: extra.evidence_ids ?? [],
  shared_quotes: [],
  hasDirectEvidence: extra.hasDirectEvidence ?? true,
  source: {
    paper_id: extra.sourcePaper ?? '',
    method_id: a,
    name: extra.sourceName ?? a,
    name_zh: '',
    family_id: '',
    year: 0,
    evidence_ids: [],
  },
  target: {
    paper_id: extra.targetPaper ?? '',
    method_id: b,
    name: extra.targetName ?? b,
    name_zh: '',
    family_id: '',
    year: 0,
    evidence_ids: [],
  },
})

/** 4-4 演进关系。只填本模块真正会读的字段 */
const EVREL = (id, sourceKey, targetKey, relation_type, extra = {}) => ({
  relation_id: id,
  source_method: extra.sourceMethod ?? 'M002',
  target_method: extra.targetMethod ?? 'M001',
  source_paper_id: extra.sourcePaper ?? 'P002',
  target_paper_id: extra.targetPaper ?? 'P001',
  source_method_key: sourceKey,
  target_method_key: targetKey,
  relation_type,
  description: extra.description ?? '',
  evidence_ids: extra.evidence_ids ?? (relation_type === 'temporal' ? [] : ['E900']),
  causal: !['temporal', 'parallel', 'related'].includes(relation_type),
  confidence: extra.confidence ?? 0.8,
  basis: [],
})

/** 便捷调用：全空输入 */
const EMPTY = { papers: [], methods: [], evidence: [], alignments: [], evolutionRelations: [] }

/* ================================================================== */
section('1. 明确写出的 limitation → 可生成 Gap（stated）')
/* ================================================================== */

/*
 * 正向：原文真的在「Limitations」章节写了局限。
 * 门 A（句式 limitation）命中 → 产出一条 stated Gap。
 *
 * 这是本模块唯一的正向主路径。后面所有测试都在验证它的**边界**。
 */
{
  const input = {
    papers: [PAPER('P001', 2022)],
    methods: [METHOD('M001', 'P001', 'ReAct', { evidence_ids: ['E001'] })],
    evidence: [
      EVID(
        'E001',
        'P001',
        'A key limitation is that the agent struggles to recover once it commits to an incorrect plan.',
        { supports: ['局限', '研究空白'], method_ids: ['M001'] },
      ),
    ],
    alignments: [],
    evolutionRelations: [],
  }
  const out = detectGaps(input)

  eq(out.gaps.length, 1, '一条 limitation 证据应产出 1 条 Gap')
  eq(out.gaps[0].assertion_level, 'stated', '单篇自陈 → stated')
  eq(out.gaps[0].candidate, false, 'stated 的 candidate 必须为 false')
  eq(out.gaps[0].gap_signal, 'limitation', '应识别为 limitation 信号')
  eq(out.gaps[0].evidence_ids, ['E001'], 'Gap 必须挂上那条证据')
  eq(out.gaps[0].paper_ids, ['P001'], 'paper_ids 应为证据所属论文')
  eq(out.gaps[0].method_ids, ['M001'], 'method_ids 应为证据关联的方法')
  check(out.gaps[0].basis.includes('explicit_limitation_statement'), 'basis 应含句式命中')
  check(out.gaps[0].basis.includes('evidence_ownership_verified'), 'basis 应含归属校验')
  check(out.gaps[0].basis.includes('evidence_declared_gap_support'), 'basis 应含上游「研究空白」标注')
  check(out.gaps[0].confidence >= 0.8, `stated 置信度应不低于 0.8，实际 ${out.gaps[0].confidence}`)
  check(!out.gaps[0].title.startsWith('【候选】'), 'stated 标题不得带【候选】前缀')
  console.log('  ✓ limitation 证据 → 1 条 stated Gap，证据/论文/方法三重回链齐全')
  console.log(`  ✓ 标题：${out.gaps[0].title}`)
  console.log(`  ✓ 置信度 ${out.gaps[0].confidence}（stated 基线 0.8）`)
}

/* ================================================================== */
section('2. 没有 Evidence → 不生成（这是硬门槛）')
/* ================================================================== */

/*
 * 四种"没有证据"的形态，全部必须产出 0 条 Gap。
 * 其中第 3、4 种最关键 —— 它们看起来"像"有证据，实际没有缺口信息。
 */
{
  /* (a) 完全没有证据 */
  const noEvidenceAtAll = detectGaps({
    papers: [PAPER('P001')],
    methods: [METHOD('M001', 'P001', 'ReAct')],
    evidence: [],
    alignments: [],
    evolutionRelations: [],
  })
  eq(noEvidenceAtAll.gaps, [], '没有任何证据 → 0 条 Gap')
  eq(noEvidenceAtAll.stats.total, 0, '统计 total 应为 0')
  eq(noEvidenceAtAll.context.corpus_has_gap_intent, false, '语料无缺口意图时应如实上报')
  console.log('  ✓ 空证据语料 → 0 条 Gap（且 corpus_has_gap_intent=false）')

  /* (b) 证据 id 悬空 / 论文归属不存在 → 门 B 拦下 */
  const orphanEvidence = detectGaps({
    papers: [PAPER('P001')],
    methods: [METHOD('M001', 'P001', 'ReAct')],
    evidence: [
      EVID('E001', 'P_NO_SUCH_PAPER', 'A key limitation is that this approach fails to scale.'),
      EVID('E002', '', 'Another limitation is that the cost grows linearly.'),
    ],
    alignments: [],
    evolutionRelations: [],
  })
  eq(orphanEvidence.gaps, [], '证据归属不明的（论文不存在 / paper_id 空）→ 0 条 Gap')
  eq(orphanEvidence.stats.evidence_skipped, 2, '被剔除的证据数必须如实统计，不能静默丢弃')
  console.log('  ✓ 归属不明的证据被门 B 剔除 2 条并计入 evidence_skipped')

  /* (c) 证据有内容，但**没有**任何缺口措辞 → 句式为 0，不产出 */
  const noGapWording = detectGaps({
    papers: [PAPER('P001')],
    methods: [METHOD('M001', 'P001', 'ReAct')],
    evidence: [
      EVID(
        'E001',
        'P001',
        'We propose ReAct, a general paradigm that interleaves reasoning traces and task-specific actions.',
        { supports: ['方法核心思想'] },
      ),
    ],
    alignments: [],
    evolutionRelations: [],
  })
  eq(noGapWording.gaps, [], '证据里没有缺口措辞 → 不产出 Gap')
  console.log('  ✓ 无缺口措辞的证据 → 0 条 Gap')

  /* (d) 证据文本过短 / 纯符号 → 门 C 拦下 */
  const nonSubstantive = detectGaps({
    papers: [PAPER('P001')],
    methods: [METHOD('M001', 'P001', 'ReAct')],
    evidence: [
      EVID('E001', 'P001', 'limitation'),
      EVID('E002', 'P001', '--- --- --- !!'),
      EVID('E003', 'P001', '   '),
    ],
    alignments: [],
    evolutionRelations: [],
  })
  eq(nonSubstantive.gaps, [], '无实质文本的证据 → 0 条 Gap')
  eq(nonSubstantive.stats.evidence_skipped, 3, '三条无实质文本的证据都应被剔除')
  console.log('  ✓ 无实质文本的证据被门 C 剔除')

  /* 全部形态的合计：不变量必须仍然通过 */
  for (const out of [noEvidenceAtAll, orphanEvidence, noGapWording, nonSubstantive]) {
    eq(assertGapInvariants(out), [], '零产出时也必须满足全部不变量')
  }
  console.log('  ✓ 四种"零产出"形态全部满足不变量')
}

/* ================================================================== */
section('3. 多篇论文共同缺失 → 可以生成 candidate')
/* ================================================================== */

/*
 * 正向：三篇不同论文各自在自己的 Limitations 里提到**同一场景**（长周期任务）
 * 的同一类缺口（局限）。
 *
 * 结果应当是：
 *   · 三条 stated（每篇一条，各自可回链自己的证据）
 *   · 一条 candidate（跨论文聚合，涉及 P001/P002/P003）
 *
 * ⚠️ 关键设计：candidate **不新增任何证据**，它是把已有出处合并成一个模式。
 *    所以 gap 总数 4，而证据总数仍是 3 —— 这个关系本身就是"没有编造"的证明。
 */
{
  const input = {
    papers: [PAPER('P001', 2022), PAPER('P002', 2023), PAPER('P003', 2024)],
    methods: [
      METHOD('M001', 'P001', 'ReAct', { evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'SWE-agent', { evidence_ids: ['E002'] }),
      METHOD('M003', 'P003', 'OpenHands', { evidence_ids: ['E003'] }),
    ],
    evidence: [
      EVID(
        'E001',
        'P001',
        'Our method struggles with long-horizon tasks that require dozens of consecutive steps.',
        { supports: ['局限'], method_ids: ['M001'] },
      ),
      EVID(
        'E002',
        'P002',
        'A key limitation is that performance degrades on long-horizon repository-level tasks.',
        { supports: ['局限'], method_ids: ['M002'] },
      ),
      EVID(
        'E003',
        'P003',
        'The agent fails to maintain goals across long-horizon multi-step editing sessions.',
        { supports: ['局限'], method_ids: ['M003'] },
      ),
    ],
    alignments: [],
    evolutionRelations: [],
  }
  const out = detectGaps(input)

  eq(out.stats.stated, 3, '三篇论文 → 3 条 stated')
  eq(out.stats.candidate, 1, '三篇论文共同缺失 → 1 条 candidate')
  eq(out.stats.total, 4, '总计 4 条 Gap')

  const cand = out.gaps.find((g) => g.candidate)
  check(Boolean(cand), '应存在一条 candidate Gap')
  eq(cand.assertion_level, 'candidate', 'candidate 的 assertion_level 必须是 candidate')
  eq(cand.paper_ids, ['P001', 'P002', 'P003'], 'candidate 应涉及全部三篇论文')
  eq(
    cand.evidence_ids,
    ['E001', 'E002', 'E003'],
    'candidate 应挂上三条证据（全部来自原文，无一新增）',
  )
  eq(cand.theme, 'long_horizon', 'candidate 应落在 long_horizon 场景主题')
  check(cand.title.startsWith('【候选】'), 'candidate 标题必须以【候选】开头')
  check(/推断/.test(cand.description), 'candidate 描述必须声明其为推断')
  check(cand.confidence < 0.8, `candidate 置信度必须低于 stated 基线，实际 ${cand.confidence}`)
  check(cand.basis.includes('multi_paper_shared_gap'), 'basis 应含跨论文聚合依据')
  console.log(`  ✓ 3 篇论文共同缺失 → 3 stated + 1 candidate`)
  console.log(`  ✓ candidate 标题：${cand.title}`)
  console.log(`  ✓ candidate 置信度 ${cand.confidence} < stated 0.8（分层在数字上可见）`)

  /*
   * 最重要的一条结构性断言：**candidate 没有引入任何新证据**。
   * Gap 数 > 证据数是允许的（聚合），但 Gap 引用到的证据必须都是输入里真实存在的。
   */
  const inputEvIds = new Set(input.evidence.map((e) => e.evidence_id))
  const citedEvIds = new Set(out.gaps.flatMap((g) => g.evidence_ids))
  const fabricated = [...citedEvIds].filter((id) => !inputEvIds.has(id))
  eq(fabricated, [], 'candidate 不得引用任何输入里不存在的证据（防编造）')
  console.log('  ✓ 反向：所有被引用的证据 id 都在输入里真实存在，无编造')

  eq(assertGapInvariants(out), [], '不变量应全部通过')
  console.log('  ✓ 不变量全部通过')
}

/* ================================================================== */
section('4. 单篇论文的普通总结 → 不能直接变成 Gap')
/* ================================================================== */

/*
 * 这是本模块最容易出错的地方，所以要测得很细。
 *
 * 三种"看起来像缺口、实际不是"的文本：
 *   (a) 纯正向的方法介绍 —— 完全没有缺口信息
 *   (b) 未来工作句 —— 是计划，不是缺口
 *   (c) 自夸式的能力主张 —— 在说自己厉害，不是不足
 */
{
  /* (a) 纯正向介绍 */
  const positive = detectGaps({
    papers: [PAPER('P001')],
    methods: [METHOD('M001', 'P001', 'ReAct')],
    evidence: [
      EVID(
        'E001',
        'P001',
        'We present a novel framework that achieves state-of-the-art results on all evaluated benchmarks, improving accuracy by 12% over prior work.',
        { supports: ['能力主张'] },
      ),
    ],
    alignments: [],
    evolutionRelations: [],
  })
  eq(positive.gaps, [], '纯正向的方法介绍 → 0 条 Gap')
  console.log('  ✓ 纯正向介绍（SOTA + 提升 12%）→ 0 条 Gap')

  /* (b) 未来工作句：有 "we will extend" 字面，但那是计划 */
  const futureWork = detectGaps({
    papers: [PAPER('P001')],
    methods: [METHOD('M001', 'P001', 'ReAct')],
    evidence: [
      EVID(
        'E001',
        'P001',
        'In future work, we plan to extend this approach to long-horizon multi-step tasks and investigate memory mechanisms.',
        { supports: ['方法核心思想'] },
      ),
      EVID(
        'E002',
        'P001',
        'We will explore how the agent handles long-horizon tasks in future work.',
        { supports: ['方法核心思想'] },
      ),
    ],
    alignments: [],
    evolutionRelations: [],
  })
  eq(futureWork.gaps, [], '未来工作句是计划而非缺口 → 0 条 Gap')
  console.log('  ✓ 未来工作句（future work / we plan to）→ 0 条 Gap')

  /* (c) 自夸式能力主张 */
  const brag = detectGaps({
    papers: [PAPER('P001')],
    methods: [METHOD('M001', 'P001', 'ReAct')],
    evidence: [
      EVID(
        'E001',
        'P001',
        'Our method is robust and generalizes well to unseen repositories, outperforming all baselines.',
        { supports: ['能力主张'] },
      ),
    ],
    alignments: [],
    evolutionRelations: [],
  })
  eq(brag.gaps, [], '自夸式能力主张（robust / generalizes well / outperforming）→ 0 条 Gap')
  console.log('  ✓ 自夸式能力主张 → 0 条 Gap')

  /*
   * (d) 单篇自述的局限**可以**成为 stated —— 这是与上面三条的关键分界。
   *
   * 必须把这条测出来，否则无法证明上面的 0 是"因为文本没缺口"
   * 而不是"因为只有一篇论文所以一律拒绝"。后者会让整个模块毫无用处。
   */
  const singleStated = detectGaps({
    papers: [PAPER('P001')],
    methods: [METHOD('M001', 'P001', 'ReAct')],
    evidence: [
      EVID(
        'E001',
        'P001',
        'A key limitation is that the agent cannot handle tasks requiring extensive context.',
        { supports: ['局限'], method_ids: ['M001'] },
      ),
    ],
    alignments: [],
    evolutionRelations: [],
  })
  eq(singleStated.gaps.length, 1, '单篇自述的局限**应当**成为 stated Gap（不是一律拒绝）')
  eq(singleStated.stats.candidate, 0, '但不得升级为 candidate（未跨论文）')
  check(
    singleStated.gaps[0].basis.includes('single_paper_stated_only'),
    'basis 应标明"仅单篇自述"',
  )
  eq(singleStated.stats.single_paper_signals, 1, '单篇信号数应如实上报')
  console.log('  ✓ 单篇自述局限 → 1 条 stated（basis 标注 single_paper_stated_only）')
  console.log('  ✓ 反向：单篇不升级为 candidate，且 single_paper_signals 如实上报')

  /*
   * (e) 同一篇论文内部的"共同缺失"不得升级为 candidate。
   *
   * 只有同一篇论文的两条证据提到同一场景 —— 那是这一篇论文自己的观察，
   * 不是"多篇论文共同缺失"。这条是 candidate 的定义边界。
   */
  const samePaperTwice = detectGaps({
    papers: [PAPER('P001')],
    methods: [METHOD('M001', 'P001', 'ReAct')],
    evidence: [
      EVID('E001', 'P001', 'A key limitation is the difficulty of long-horizon planning.', {
        supports: ['局限'],
        method_ids: ['M001'],
      }),
      EVID('E002', 'P001', 'Another limitation concerns long-horizon memory retention.', {
        supports: ['局限'],
        method_ids: ['M001'],
      }),
    ],
    alignments: [],
    evolutionRelations: [],
  })
  eq(samePaperTwice.stats.candidate, 0, '同一篇论文的两条证据 → 不得升级为 candidate')
  eq(samePaperTwice.stats.stated, 2, '但两条 stated 各自成立')
  console.log('  ✓ 同一论文两条证据 → 0 candidate / 2 stated（不做假"共同")')
}

/* ================================================================== */
section('5. 输入乱序 → 输出稳定（确定性）')
/* ================================================================== */

/*
 * 与 4-2 / 4-4 同一条纪律，且这里有一个额外来源：
 * candidate 是**聚簇**产物，如果聚簇键或成员排序依赖输入顺序，
 * 那"哪条证据成为代表、哪个论文排在前面"都会漂移。
 * 所以必须穷举排列来验。
 */
{
  const mk = () => ({
    papers: [PAPER('P001', 2022), PAPER('P002', 2023), PAPER('P003', 2024)],
    methods: [
      METHOD('M001', 'P001', 'ReAct', { evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'SWE-agent', { evidence_ids: ['E002'] }),
      METHOD('M003', 'P003', 'OpenHands', { evidence_ids: ['E003'] }),
    ],
    evidence: [
      EVID('E001', 'P001', 'The agent struggles with long-horizon tasks.', {
        supports: ['局限'],
        method_ids: ['M001'],
      }),
      EVID('E002', 'P002', 'A key limitation is long-horizon degradation.', {
        supports: ['局限'],
        method_ids: ['M002'],
      }),
      EVID('E003', 'P003', 'It fails to scale to long-horizon sessions.', {
        supports: ['局限'],
        method_ids: ['M003'],
      }),
    ],
    alignments: [],
    evolutionRelations: [],
  })

  const base = detectGaps(mk())
  eq(detectGaps(mk()), base, '同一输入两次调用必须逐字段一致')
  check(base.gaps.length > 0, '本组夹具必须真的产出 Gap，否则乱序测试是空转')

  /* 穷举 6 种输入排列（papers / methods / evidence 同时打乱） */
  const perms = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ]
  let identical = 0
  for (const p of perms) {
    const input = mk()
    input.papers = p.map((i) => input.papers[i])
    input.methods = p.map((i) => input.methods[i])
    input.evidence = p.map((i) => input.evidence[i])
    const out = detectGaps(input)
    eq(
      out.gaps.map((g) => [g.gap_id, g.assertion_level, g.gap_signal, g.theme, g.evidence_ids]),
      base.gaps.map((g) => [g.gap_id, g.assertion_level, g.gap_signal, g.theme, g.evidence_ids]),
      `输入排列 [${p.join(',')}] 改变了 gaps 的顺序或内容`,
    )
    if (JSON.stringify(out) === JSON.stringify(base)) identical++
  }
  check(identical === 6, `穷举 6 种排列应全部逐字节一致，实际 ${identical}/6`)
  console.log(`  ✓ 穷举 ${identical}/6 种输入排列输出逐字节一致`)
  console.log(
    `  ✓ Gap 序列：${base.gaps.map((g) => `${g.gap_id}:${g.assertion_level}/${g.gap_signal}`).join(' | ')}`,
  )

  /* gap_id 是"排序后位置"的纯函数，必须连续 */
  eq(
    base.gaps.map((g) => g.gap_id),
    base.gaps.map((_, i) => `GR${String(i + 1).padStart(3, '0')}`),
    'gap_id 必须连续且与排序位置一致',
  )
  console.log('  ✓ gap_id 连续且由排序位置决定（不依赖发现顺序）')
}

/* ================================================================== */
section('6. 每个 Gap 都能回链 Evidence')
/* ================================================================== */

{
  const input = {
    papers: [PAPER('P001', 2022), PAPER('P002', 2023), PAPER('P003', 2024)],
    methods: [
      METHOD('M001', 'P001', 'ReAct', { evidence_ids: ['E001', 'E004'] }),
      METHOD('M002', 'P002', 'SWE-agent', { evidence_ids: ['E002', 'E005'] }),
      METHOD('M003', 'P003', 'OpenHands', { evidence_ids: ['E003', 'E006'] }),
    ],
    evidence: [
      EVID('E001', 'P001', 'A key limitation is long-horizon planning failure.', {
        supports: ['局限'],
        method_ids: ['M001'],
      }),
      EVID('E002', 'P002', 'It struggles with long-horizon repository tasks.', {
        supports: ['局限'],
        method_ids: ['M002'],
      }),
      EVID('E003', 'P003', 'No principled method exists for long-horizon termination.', {
        supports: ['研究空白'],
        method_ids: ['M003'],
      }),
      EVID('E004', 'P001', 'The evaluation lacks a baseline for long-horizon settings.', {
        supports: ['局限'],
        method_ids: ['M001'],
      }),
      EVID('E005', 'P002', 'We have not evaluated on multi-agent long-horizon setups.', {
        supports: ['局限'],
        method_ids: ['M002'],
      }),
      EVID('E006', 'P003', 'Cost grows linearly with the number of steps.', {
        supports: ['局限'],
        method_ids: ['M003'],
      }),
    ],
    alignments: [],
    evolutionRelations: [],
  }
  const out = detectGaps(input)
  const inputEvIds = new Set(input.evidence.map((e) => e.evidence_id))
  const inputPaperIds = new Set(input.papers.map((p) => p.paper_id))
  const inputMethodIds = new Set(input.methods.map((m) => m.method_id))

  check(out.gaps.length > 0, '本组夹具必须真的产出 Gap')

  /* 逐条 Gap 校验三种回链 */
  let badEvidence = 0
  let badPaper = 0
  let badMethod = 0
  let noEvidence = 0
  for (const g of out.gaps) {
    if (!g.evidence_ids.length) noEvidence++
    for (const id of g.evidence_ids) if (!inputEvIds.has(id)) badEvidence++
    for (const id of g.paper_ids) if (!inputPaperIds.has(id)) badPaper++
    for (const id of g.method_ids) if (!inputMethodIds.has(id)) badMethod++
  }
  eq(noEvidence, 0, '不得存在任何无证据的 Gap')
  eq(badEvidence, 0, '不得引用不存在的 evidence_id')
  eq(badPaper, 0, '不得引用不存在的 paper_id')
  eq(badMethod, 0, '不得引用不存在的 method_id')
  console.log(`  ✓ ${out.gaps.length} 条 Gap 全部能回链到真实存在的 Evidence / Paper / Method`)

  /*
   * 逐条 Gap 反查：证据所属论文必须在该 Gap 的 paper_ids 里。
   * 这条防的是"Gap 声称涉及 P003，但它的证据全来自 P001"这种表里不一。
   */
  const evPaper = new Map(input.evidence.map((e) => [e.evidence_id, e.paper_id]))
  let mismatch = 0
  for (const g of out.gaps) {
    const papersOfEvidence = new Set(g.evidence_ids.map((id) => evPaper.get(id)))
    for (const pid of papersOfEvidence) {
      if (pid && !g.paper_ids.includes(pid)) mismatch++
    }
  }
  eq(mismatch, 0, 'Gap 的 paper_ids 必须覆盖其全部证据的所属论文')
  console.log('  ✓ Gap.paper_ids 覆盖其全部证据的所属论文（无表里不一）')

  eq(assertGapInvariants(out), [], '不变量应全部通过')
  console.log('  ✓ 不变量全部通过')
}

/* ================================================================== */
section('7. 四类缺口信号分别可识别')
/* ================================================================== */

/*
 * 需求点名的四个词各测一条。四类必须真的可区分 ——
 * 如果实现把它们全归成一个 "limitation"，这里会红。
 */
{
  const cases = [
    {
      signal: 'limitation',
      text: 'A limitation of our approach is that the agent cannot handle long-horizon sessions.',
    },
    {
      signal: 'open_problem',
      text: 'How to terminate a multi-agent conversation remains an open problem for long-horizon work.',
    },
    {
      signal: 'missing_comparison',
      text: 'There is no direct comparison with prior multi-agent systems on long-horizon benchmarks.',
    },
    {
      signal: 'uncovered_setting',
      text: 'The method has not been evaluated on long-horizon repository-level settings.',
    },
  ]

  const found = new Set()
  for (const c of cases) {
    const out = detectGaps({
      papers: [PAPER('P001')],
      methods: [METHOD('M001', 'P001', 'M')],
      evidence: [EVID('E001', 'P001', c.text, { supports: ['局限'], method_ids: ['M001'] })],
      alignments: [],
      evolutionRelations: [],
    })
    eq(out.gaps.length, 1, `「${c.signal}」句式应产出恰好 1 条 Gap`)
    eq(out.gaps[0].gap_signal, c.signal, `应识别为 ${c.signal}`)
    found.add(out.gaps[0].gap_signal)
    console.log(`  ✓ ${c.signal} → ${gapSignalLabel(c.signal)}（主题 ${gapThemeLabel(out.gaps[0].theme)}）`)
  }
  eq(found.size, 4, '四类信号必须全部可识别（不得塌缩为一类）')

  /* 四个导出常量本身也自洽 */
  eq(GAP_SIGNAL_TYPES.length, 4, '信号类型应为 4 类')
  check(GAP_SIGNAL_TYPES.every(isGapSignalType), '每类都应通过 isGapSignalType')
  check(!isGapSignalType('bogus'), '未知值应被 isGapSignalType 拒绝')
  check(isGapAssertionLevel('stated') && isGapAssertionLevel('candidate'), '两个分层值都应合法')
  check(!isGapAssertionLevel('fact'), '未知分层值应被拒绝')
  console.log('  ✓ 四类信号互不塌缩；运行时白名单拒绝未知值')
}

/* ================================================================== */
section('8. 多重缺口性质：一条证据可暴露多个独立缺口')
/* ================================================================== */

/*
 * 与 4-4 的关键差异。4-4 判"两个方法的关系"时必须取最强类型（关系是单一事实）。
 * 但缺口不是二选一：一句 "缺乏 baseline，而且没在真实仓库上验证" 同时暴露两类缺口，
 * 强行取最强会凭空丢一半信息。这里验证 multi-label 行为。
 */
{
  const out = detectGaps({
    papers: [PAPER('P001')],
    methods: [METHOD('M001', 'P001', 'M')],
    evidence: [
      EVID(
        'E001',
        'P001',
        'There is no direct comparison with prior work, and the method has not been evaluated on long-horizon repository-level settings.',
        { supports: ['局限'], method_ids: ['M001'] },
      ),
    ],
    alignments: [],
    evolutionRelations: [],
  })
  eq(out.gaps.length, 2, '同时命中「缺失比较」与「未覆盖场景」→ 应产出 2 条独立 Gap')
  const signals = out.gaps.map((g) => g.gap_signal).sort()
  eq(signals, ['missing_comparison', 'uncovered_setting'], '两条 Gap 的信号类型应分别为两类')
  check(
    out.gaps.every((g) => g.evidence_ids.length === 1 && g.evidence_ids[0] === 'E001'),
    '两条 Gap 各自回链同一条证据（同一句原文的两个侧面）',
  )
  console.log(`  ✓ 一条证据命中两类信号 → 2 条 Gap：${signals.join(' + ')}`)
  console.log('  ✓ 反向：不塌缩为单条"最强"（与 4-4 的取最强策略刻意不同，理由是缺口非二选一）')

  /*
   * 同一信号命中多条规则时**只产出一条**（避免一条证据把同一个缺口报两遍）。
   * 上面这句同时命中 limitation 的多条规则（no comparison 里的 /lacks? baseline/ 等）。
   */
  const dupSignal = detectGaps({
    papers: [PAPER('P001')],
    methods: [METHOD('M001', 'P001', 'M')],
    evidence: [
      EVID(
        'E001',
        'P001',
        'A key limitation is that a limitation arises: our method cannot handle this and fails to scale.',
        { supports: ['局限'], method_ids: ['M001'] },
      ),
    ],
    alignments: [],
    evolutionRelations: [],
  })
  eq(dupSignal.gaps.length, 1, '同一信号命中多条规则 → 只产出 1 条 Gap（不去重会重复报）')
  console.log('  ✓ 同信号多规则命中 → 只产 1 条（不重复报同一缺口）')
}

/* ================================================================== */
section('9. 被后续工作改进过的局限 → 降权而非升权')
/* ================================================================== */

/*
 * 反直觉但重要：研究空白的语义是"**至今仍未解决**"，不是"被提到的次数多"。
 * 一个已被后续工作明确声称解决的方向，作为待研究空白价值更低。
 * 这里验证降权确实生效，且原因在 basis 里可见。
 */
{
  const mk = (relations) => ({
    papers: [PAPER('P001', 2022), PAPER('P002', 2024)],
    methods: [
      METHOD('M001', 'P001', 'ReAct', { evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'SWE-agent', { evidence_ids: ['E002'] }),
    ],
    evidence: [
      EVID('E001', 'P001', 'A key limitation is long-horizon planning failure.', {
        supports: ['局限'],
        method_ids: ['M001'],
      }),
      EVID('E002', 'P002', 'SWE-agent builds on ReAct and extends it to repository tasks.', {
        supports: ['技术演进'],
        method_ids: ['M002'],
      }),
    ],
    alignments: [],
    evolutionRelations: relations,
  })

  const withoutEvolution = detectGaps(mk([]))
  const withEvolution = detectGaps(
    mk([
      /* M002 改进了 M001 —— target 是更早的 M001，即被改进者 */
      EVREL('ER001', 'P002::M002', 'P001::M001', 'improves', {
        evidence_ids: ['E002'],
      }),
    ]),
  )

  const baseGap = withoutEvolution.gaps.find((g) => g.evidence_ids.includes('E001'))
  const loweredGap = withEvolution.gaps.find((g) => g.evidence_ids.includes('E001'))
  check(Boolean(baseGap) && Boolean(loweredGap), '两组都应产出针对 E001 的 Gap')
  check(
    loweredGap.confidence < baseGap.confidence,
    `被后续改进的局限应降权：${baseGap.confidence} → ${loweredGap.confidence}`,
  )
  check(
    loweredGap.basis.includes('addressed_by_later_work'),
    'basis 应含 addressed_by_later_work，让降权原因可见',
  )
  console.log(
    `  ✓ 被后续工作改进的局限置信度 ${baseGap.confidence} → ${loweredGap.confidence}（降权）`,
  )
  console.log('  ✓ 降权原因写入 basis（addressed_by_later_work），用户可复核')

  /*
   * 反向：非因果边（temporal / related）不构成"已被改进"。
   * 年份相邻不等于被解决 —— 这是 4-4 "年份不能推因果"在本模块的延续。
   */
  const temporalOnly = detectGaps(
    mk([EVREL('ER001', 'P002::M002', 'P001::M001', 'temporal', { evidence_ids: [] })]),
  )
  const temporalGap = temporalOnly.gaps.find((g) => g.evidence_ids.includes('E001'))
  eq(
    temporalGap.confidence,
    baseGap.confidence,
    'temporal 边不得触发降权（年份相邻 ≠ 已被解决）',
  )
  check(
    !temporalGap.basis.includes('addressed_by_later_work'),
    'temporal 边不得写入 addressed_by_later_work',
  )
  console.log('  ✓ 反向：temporal 边不触发降权（沿用 4-4「年份不推因果」的立场）')
}

/* ================================================================== */
section('10. 同一方法的不同出现 ≠ 多篇论文共同缺失')
/* ================================================================== */

/*
 * 4-2 判为 same/alias 的两个方法，其实是**同一个方法**。
 * 若它们的证据分别提到同一局限，"两篇论文都这么说"就是假共同 ——
 * 实际是同一项工作被引用两次。这类聚簇必须被拦下。
 */
{
  const mk = (alignments) => ({
    papers: [PAPER('P001', 2022), PAPER('P002', 2023)],
    methods: [
      METHOD('M001', 'P001', 'ReAct', { evidence_ids: ['E001'] }),
      METHOD('M001', 'P002', 'ReAct', { evidence_ids: ['E002'] }),
    ],
    evidence: [
      EVID('E001', 'P001', 'A key limitation is long-horizon planning failure.', {
        supports: ['局限'],
        method_ids: ['M001'],
      }),
      EVID('E002', 'P002', 'The approach struggles with long-horizon planning.', {
        supports: ['局限'],
        method_ids: ['M001'],
      }),
    ],
    alignments,
    evolutionRelations: [],
  })

  /* 第 ① 组：没有对齐信息 → 两篇不同论文，看起来是"共同缺失" */
  const unaligned = detectGaps(mk([]))
  eq(unaligned.stats.candidate, 1, '无对齐信息时，两条跨论文证据应聚成 candidate')

  /* 第 ② 组：4-2 判它们是同一方法 → 必须降级，不得产 candidate */
  const aligned = detectGaps(
    mk([
      ALIGN('AL001', 'M001', 'M001', 'same', {
        sourcePaper: 'P001',
        targetPaper: 'P002',
      }),
    ]),
  )
  eq(
    aligned.stats.candidate,
    0,
    '4-2 判为同一方法的两个身份 → 不得产 candidate（防"同一工作被数成两篇"）',
  )
  eq(aligned.stats.stated, 2, '但两条 stated 各自仍成立')
  console.log('  ✓ 无对齐信息 → 1 candidate；4-2 判 same 后 → 0 candidate（降级为 2 stated）')
  console.log('  ✓ 反向：不把同一篇工作的两次出现当成"多篇论文共同缺失"')
}

/* ================================================================== */
section('11. 统计自洽 + 不变量')
/* ================================================================== */

{
  const input = {
    papers: [PAPER('P001', 2022), PAPER('P002', 2023), PAPER('P003', 2024)],
    methods: [
      METHOD('M001', 'P001', 'ReAct', { evidence_ids: ['E001', 'E004'] }),
      METHOD('M002', 'P002', 'SWE-agent', { evidence_ids: ['E002'] }),
      METHOD('M003', 'P003', 'OpenHands', { evidence_ids: ['E003'] }),
    ],
    evidence: [
      EVID('E001', 'P001', 'A key limitation is long-horizon planning failure.', {
        supports: ['局限'],
        method_ids: ['M001'],
      }),
      EVID('E002', 'P002', 'It struggles with long-horizon repository tasks.', {
        supports: ['局限'],
        method_ids: ['M002'],
      }),
      EVID('E003', 'P003', 'There is no direct comparison in long-horizon multi-agent settings.', {
        supports: ['局限'],
        method_ids: ['M003'],
      }),
      EVID('E004', 'P001', 'How to do long-horizon planning remains an open problem.', {
        supports: ['研究空白'],
        method_ids: ['M001'],
      }),
    ],
    alignments: [],
    evolutionRelations: [],
  }
  const out = detectGaps(input)
  const s = out.stats

  eq(s.total, out.gaps.length, 'total 必须等于 gaps.length')
  eq(s.stated + s.candidate, s.total, 'stated + candidate 必须等于 total')
  eq(
    s.limitation + s.open_problem + s.missing_comparison + s.uncovered_setting,
    s.total,
    '四类信号计数之和必须等于 total',
  )
  eq(s.gaps_without_evidence, 0, '无证据的 Gap 数必须为 0')
  check(s.papers_involved > 0, 'papers_involved 应大于 0')
  check(s.methods_involved > 0, 'methods_involved 应大于 0')

  /* 独立复算，防止 summarizeGaps 自己算错。singlePaperSignals 是聚簇过程的产物，需原样传回 */
  const recomputed = summarizeGaps(out.gaps, s.evidence_skipped, s.single_paper_signals)
  eq(recomputed, s, 'summarizeGaps 的复算结果必须与 detectGaps 内建统计一致')

  eq(out.context.papers, 3, 'context.papers 应为输入论文数')
  eq(out.context.methods, 3, 'context.methods 应为输入方法数')
  eq(out.context.evidence, 4, 'context.evidence 应为输入证据数')
  eq(out.rule_version, GAP_RULE_VERSION, 'rule_version 应可溯源')

  eq(assertGapInvariants(out), [], '不变量应全部通过')
  console.log(
    `  ✓ 统计自洽：stated=${s.stated} candidate=${s.candidate} total=${s.total} ` +
      `limitation=${s.limitation} open=${s.open_problem} cmp=${s.missing_comparison} uncov=${s.uncovered_setting}`,
  )
  console.log(`  ✓ 涉及论文 ${s.papers_involved} 篇 / 方法 ${s.methods_involved} 个 / 主题 ${s.themes} 类`)
  console.log('  ✓ summarizeGaps 与内建统计逐字段一致；不变量全部通过')
}

/* ================================================================== */
section('12. 边界与健壮性')
/* ================================================================== */

{
  /* 空输入 */
  const empty = detectGaps(EMPTY)
  eq(empty.gaps, [], '空输入不得产出 Gap')
  eq(empty.stats.total, 0, '空输入统计应为 0')
  eq(empty.context.corpus_has_gap_intent, false, '空语料应上报无缺口意图')
  eq(assertGapInvariants(empty), [], '空输入不变量应通过')
  console.log('  ✓ 空输入不崩，产出 0 条')

  /* 证据缺 translation（翻译失败是常见情况）→ 仅靠英文原文也必须能命中 */
  const noTranslation = detectGaps({
    papers: [PAPER('P001')],
    methods: [METHOD('M001', 'P001', 'M')],
    evidence: [
      EVID('E001', 'P001', 'A key limitation is long-horizon planning failure.', {
        translation: '', // 翻译失败
        supports: ['局限'],
        method_ids: ['M001'],
      }),
    ],
    alignments: [],
    evolutionRelations: [],
  })
  eq(noTranslation.gaps.length, 1, 'translation 为空时仍应靠 content 命中')
  console.log('  ✓ translation 为空（翻译失败）仍能靠英文原文命中')

  /*
   * content 很短（真实数据里常见：图注、被截断的片段），
   * 缺口信息全在 translation 里 —— 门 C 必须同时看两者，否则会静默丢掉这类证据。
   */
  const chinese = detectGaps({
    papers: [PAPER('P001')],
    methods: [METHOD('M001', 'P001', 'M')],
    evidence: [
      EVID('E001', 'P001', 'Fig. 3.', {
        translation: '该方法在长周期任务上存在明显局限，且尚未在仓库级场景验证。',
        supports: ['局限'],
        method_ids: ['M001'],
      }),
    ],
    alignments: [],
    evolutionRelations: [],
  })
  check(chinese.gaps.length >= 1, 'content 短但 translation 完整时，缺口措辞仍应能命中')
  console.log(`  ✓ content 短 + 中文释义完整 → ${chinese.gaps.length} 条 Gap（门 C 同时看 content 与 translation）`)

  /* 证据关联的方法 id 不存在 → 不应引用幽灵方法 */
  const ghostMethod = detectGaps({
    papers: [PAPER('P001')],
    methods: [METHOD('M001', 'P001', 'M')],
    evidence: [
      EVID('E001', 'P001', 'A key limitation is long-horizon failure.', {
        supports: ['局限'],
        method_ids: ['M_NO_SUCH', 'M001'],
      }),
    ],
    alignments: [],
    evolutionRelations: [],
  })
  eq(ghostMethod.gaps[0].method_ids, ['M001'], '幽灵 method_id 应被剔除，只留真实存在的')
  console.log('  ✓ 幽灵 method_id 被剔除，不引用不存在的方法')

  /* 证据无关联方法 → Gap 仍然成立（缺口是领域层面的，不强制挂方法） */
  const noMethod = detectGaps({
    papers: [PAPER('P001')],
    methods: [],
    evidence: [
      EVID('E001', 'P001', 'A key limitation of the field is long-horizon planning.', {
        supports: ['局限'],
        method_ids: [],
      }),
    ],
    alignments: [],
    evolutionRelations: [],
  })
  eq(noMethod.gaps.length, 1, '无关联方法的证据仍应产出 Gap（缺口是领域层面的）')
  eq(noMethod.gaps[0].method_ids, [], 'method_ids 如实为空，不编造')
  console.log('  ✓ 无关联方法的证据仍产 Gap，method_ids 如实为空（不编造）')

  /* 未来工作句与真实局限混在同一句时：只要出现未来工作标记就跳过（保守） */
  const mixed = detectGaps({
    papers: [PAPER('P001')],
    methods: [METHOD('M001', 'P001', 'M')],
    evidence: [
      EVID(
        'E001',
        'P001',
        'In future work, we plan to address the limitation of long-horizon planning.',
        { supports: ['局限'], method_ids: ['M001'] },
      ),
    ],
    alignments: [],
    evolutionRelations: [],
  })
  eq(mixed.gaps, [], '含未来工作标记的句子整体跳过（保守：宁可漏检，不可把计划写成缺口）')
  console.log('  ✓ 未来工作 + 局限混写句 → 整体跳过（保守优先）')
}

/* ================================================================== */
section('13. 不变量本身有效（注入违反项必须被报出）')
/* ================================================================== */

/*
 * 不变量如果永远返回空数组，那它就是个摆设。
 * 这里构造几个**手工违反**的对象，验证 assertGapInvariants 确实报错。
 */
{
  const good = detectGaps({
    papers: [PAPER('P001'), PAPER('P002')],
    methods: [METHOD('M001', 'P001', 'M'), METHOD('M002', 'P002', 'N')],
    evidence: [
      EVID('E001', 'P001', 'A key limitation is long-horizon failure.', {
        supports: ['局限'],
        method_ids: ['M001'],
      }),
      EVID('E002', 'P002', 'It struggles with long-horizon tasks.', {
        supports: ['局限'],
        method_ids: ['M002'],
      }),
    ],
    alignments: [],
    evolutionRelations: [],
  })
  /*
   * 两层设计：2 条 stated（每条证据一条）+ 1 条 candidate（跨论文聚合）= 共 3 条。
   * 这里刻意用 3 而不是 2，是为了让"stated 不被 candidate 吞掉"这件事被固化下来。
   */
  check(good.gaps.length === 3, `本组夹具应产出 3 条（2 stated + 1 candidate），实际 ${good.gaps.length}`)
  eq(good.stats.stated, 2, '应产出 2 条 stated')
  eq(good.stats.candidate, 1, '应产出 1 条 candidate')
  eq(assertGapInvariants(good), [], '合法输出应无违反项')

  const clone = () => JSON.parse(JSON.stringify(good))
  /* 取第一条 stated 与那条 candidate 作为注入基准 */
  const statedIdx = good.gaps.findIndex((g) => g.assertion_level === 'stated')
  const candIdx = good.gaps.findIndex((g) => g.assertion_level === 'candidate')
  check(statedIdx >= 0 && candIdx >= 0, '夹具应同时含 stated 与 candidate')

  /* (1) 去掉证据 → 必须被报"没有 Evidence" */
  const noEv = clone()
  noEv.gaps[statedIdx].evidence_ids = []
  check(
    assertGapInvariants(noEv).some((m) => /没有任何 Evidence/.test(m)),
    '无证据的 Gap 必须被不变量报出',
  )

  /* (2) candidate 缺【候选】前缀 → 必须被报 */
  const badTitle = clone()
  badTitle.gaps[candIdx].title = '多篇论文共同提及的缺口'
  check(
    assertGapInvariants(badTitle).some((m) => /【候选】/.test(m)),
    'candidate 缺【候选】前缀必须被报出',
  )

  /* (3) candidate 描述不含"推断" → 必须被报 */
  const badDesc = clone()
  badDesc.gaps[candIdx].description = '这是一个确定的空白。'
  check(
    assertGapInvariants(badDesc).some((m) => /未声明其为推断/.test(m)),
    'candidate 描述未声明推断必须被报出',
  )

  /* (4) candidate 只涉及 1 篇论文 → 必须被报 */
  const onePaper = clone()
  onePaper.gaps[candIdx].paper_ids = ['P001']
  check(
    assertGapInvariants(onePaper).some((m) => /只涉及/.test(m)),
    'candidate 只涉及 1 篇论文必须被报出',
  )

  /* (5) candidate 置信度 ≥ 0.8 → 必须被报（分层必须在数字上可见） */
  const highConf = clone()
  highConf.gaps[candIdx].confidence = 0.9
  check(
    assertGapInvariants(highConf).some((m) => /不低于 stated 基线/.test(m)),
    'candidate 置信度过高必须被报出',
  )

  /* (6) candidate 布尔与 assertion_level 不一致 → 必须被报 */
  const mismatch = clone()
  mismatch.gaps[statedIdx].candidate = true
  check(
    assertGapInvariants(mismatch).some((m) => /不一致/.test(m)),
    'candidate 布尔与 assertion_level 不一致必须被报出',
  )

  /* (6b) stated 却带【候选】前缀 → 分层标记与文案矛盾，必须被报 */
  const statedCandTitle = clone()
  statedCandTitle.gaps[statedIdx].title = '【候选】不该出现的前缀：原文指出的局限'
  check(
    assertGapInvariants(statedCandTitle).some((m) => /分层标记与文案矛盾/.test(m)),
    'stated 带【候选】前缀必须被报出',
  )

  /* (7) gap_id 与位置不一致 → 必须被报 */
  const badId = clone()
  badId.gaps[0].gap_id = 'GR999'
  check(
    assertGapInvariants(badId).some((m) => /排序位置不一致/.test(m)),
    'gap_id 与位置不一致必须被报出',
  )

  /* (8) 统计被篡改 → 必须被报 */
  const badStats = clone()
  badStats.stats.total = 999
  check(
    assertGapInvariants(badStats).some((m) => /stats\.total/.test(m)),
    '统计不自洽必须被报出',
  )
  const badSum = clone()
  badSum.stats.stated = 99
  check(
    assertGapInvariants(badSum).some((m) => /≠ total/.test(m)),
    'stated+candidate≠total 必须被报出',
  )
  const badWoE = clone()
  badWoE.stats.gaps_without_evidence = 3
  check(
    assertGapInvariants(badWoE).some((m) => /gaps_without_evidence/.test(m)),
    'gaps_without_evidence 非 0 必须被报出',
  )

  console.log('  ✓ 9 类注入违反项全部被 assertGapInvariants 报出（不变量不是摆设）')
}

/* ================================================================== */

console.log('\n' + '─'.repeat(62))
if (errors.length) {
  console.log(`✗ 研究空白测试失败（${errors.length} 项 / 通过 ${pass} 项）\n`)
  for (const e of errors) console.log(`  ✗ ${e}`)
  process.exit(1)
}
console.log(`✓ 研究空白测试全部通过（${pass} 项断言）`)
console.log('  原文不写缺口就产不出 · 推断必须标 candidate · 无证据禁止产出 · 乱序一致 · 全部可回链')
