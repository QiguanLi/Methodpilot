#!/usr/bin/env node
/**
 * 研究方向生成测试（Phase 4-7）。
 *
 * 运行：pnpm direction:test
 *
 * ── 这个测试验什么 ──
 *
 * 全部验 `generateDirections()` 这个**纯函数**：输入手写对象，断言输出结构。
 * 不读文件、不发请求、不碰当前时间。
 *
 * ── 为什么这个测试特别重要 ──
 *
 * 4-7 是本项目**第一次引入"生成"** —— 它要说出论文里没有的话
 * （"你可以试试用 X 解决 Y"）。前面几个阶段（4-2/4-3/4-4/4-6）本质上都是
 * "从证据里搬运信息"，错也错在搬运得不全；而这里一旦出错，
 * 错的是**凭空造出一个听起来很合理、但没有任何出处的研究事实**。
 *
 * 这类错误的特征是：**看起来完全正常**。用户读到一个通顺的方向，
 * 不会怀疑"论文真的这么说了吗"。所以必须靠断言把边界钉死。
 *
 * ── 六条必测（对应用户需求里的验收要点）──
 *   1. stated Gap → 可以生成方向
 *   2. 只有 candidate → 可以生成，但必须标记为候选依据
 *   3. 没有 Gap / Evidence → 不生成方向
 *   4. 每个方向都能回链 Gap + Evidence
 *   5. 输入乱序 → 输出稳定
 *   6. 不产生没有来源的"研究事实"
 *
 * ── 一个贯穿全文的关键认识：4-7 吃 4-6 的输出 ──
 *
 * 本测试的夹具**不是**手写 Gap 字面量，而是调用真实的 `detectGaps()`
 * 从证据里判出 Gap，再喂给 `generateDirections()`。
 *
 * 这么做的理由：如果手写 Gap，我就得自己假设"Gap 长什么样"，
 * 而那个假设一旦与 4-6 的真实输出不符（比如漏了某个字段），
 * 测试会全绿而线上炸掉。走真实链路，夹具就是真的。
 * 代价是夹具搭建更啰嗦，但换来的是"测试通过 = 线上能用"。
 */

import {
  detectGaps,
  assertGapInvariants,
} from '../server/services/researchGaps.ts'
import { alignMethods } from '../server/services/methodAlignment.ts'
import { buildEvolution } from '../server/services/methodEvolution.ts'
import {
  generateDirections,
  assertDirectionInvariants,
  summarizeDirections,
  DIRECTION_RULE_VERSION,
  DIRECTION_BASIS_LEVELS,
} from '../server/services/researchDirections.ts'

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

function paper(paper_id, title, year) {
  return {
    paper_id,
    project_id: 'proj_test',
    title,
    authors: [],
    year,
    abstract: '',
    keywords: [],
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

function method(method_id, name, { year = 2023, paper_ids = [], task = '', evidence_ids = [] } = {}) {
  return {
    method_id,
    project_id: 'proj_test',
    name,
    name_zh: '',
    family_id: '',
    task,
    paradigm: '',
    year,
    core_idea: '',
    modules: [],
    inputs: [],
    outputs: [],
    capabilities: [],
    advantages: [],
    limitations: [],
    paper_ids,
    evidence_ids,
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
 * 走真实链路：证据 → detectGaps() → generateDirections()
 *
 * ⚠️ 这里会自动把"证据挂在哪个方法上"回填进 `method.evidence_ids`。
 *
 * 为什么必须回填：4-4 判演进关系时，入口是 `later.evidence_ids` ——
 * 它会遍历这些证据、做归属校验与"点名"门 B。如果夹具里方法没有
 * evidence_ids，4-4 就找不到任何因果边，于是本测试里
 * "已被后续工作改进的方法"（第 10 节）那条断言会**假失败**：
 * 看起来像模块的 bug，其实是夹具没把链路接通。
 *
 * （这个坑我踩了一次：最初手写夹具时忘了填，排查半天才发现是夹具问题。）
 * 真实数据里方法一定带 evidence_ids（阶段③ 抽取时写入），
 * 所以回填过的夹具才更接近真实形态。
 */
function build(input) {
  for (const m of input.methods) {
    if (m.evidence_ids?.length) continue
    m.evidence_ids = input.evidence
      .filter((e) => (e.method_ids ?? []).includes(m.method_id) && m.paper_ids.includes(e.paper_id))
      .map((e) => e.evidence_id)
      .sort()
  }

  /*
   * 真正跑一遍 4-2 + 4-4 拿到演进关系，而不是让夹具手填。
   *
   * 为什么必须真跑：本测试有一条断言"已被后续工作改进的方法不再进入
   * 切入点候选"（第 10 节）。那条断言依赖 4-4 判出一条 **causal** 边。
   * 如果夹具手填（或干脆不填）evolutionRelations，4-4 的门 A/B/C 就被绕过了 ——
   * 于是"因果边"变成我自己假设的，而不是判定出来的。
   * 那样测试会验一个现实中不存在的输入，属于假绿。
   *
   * 真跑的代价是夹具多依赖两个上游模块，换来的是：
   * 一旦 4-4 改了判定口径（比如门 B 收紧），本测试会跟着失败并提示。
   */
  const alignments = input.alignments ?? alignMethods({
    methods: input.methods,
    evidence: input.evidence,
    papers: input.papers,
  }).candidates

  const evolutionRelations = input.evolutionRelations ?? buildEvolution({
    methods: input.methods,
    evidence: input.evidence,
    papers: input.papers,
    alignments,
  }).relations

  const gapOut = detectGaps({
    papers: input.papers,
    methods: input.methods,
    evidence: input.evidence,
    alignments,
    evolutionRelations,
  })
  const out = generateDirections({
    gaps: gapOut.gaps,
    methods: input.methods,
    evidence: input.evidence,
    papers: input.papers,
    evolutionRelations,
  })
  return { gapOut, out, input: { ...input, alignments, evolutionRelations } }
}

/** 顺序无关的规范化形式，用于"重排不改输出"对比 */
const canonical = (out) =>
  out
    ? {
        dirs: out.directions.map((d) => ({
          id: d.direction_id,
          lv: d.basis_level,
          co: d.candidate_only,
          sig: d.gap_signal,
          theme: d.theme,
          title: d.title,
          desc: d.description,
          q: d.question.question,
          qr: d.question.rationale,
          qo: d.question.expected_outcome,
          ak: d.approach.kind,
          ad: d.approach.description,
          am: [...d.approach.based_on_method_ids].sort(),
          ve: d.validation.experiment,
          vm: d.validation.materials,
          vs: d.validation.success_criteria,
          vc: d.validation.from_corpus,
          g: [...d.gap_ids].sort(),
          e: [...d.evidence_ids].sort(),
          p: [...d.paper_ids].sort(),
          m: [...d.method_ids].sort(),
          b: d.basis,
          cf: d.confidence,
        })),
        stats: out.stats,
        ctx: out.context,
      }
    : null

/* ================================================================== */

console.log('═'.repeat(70))
console.log('研究方向生成测试（Phase 4-7）')
console.log('═'.repeat(70))

/* ================================================================== */
section('— 1. stated Gap → 可以生成方向（且走事实口吻）—')
/* ================================================================== */

/*
 * 最基础的一条：论文自己写了局限 → 应当产出一个方向，
 * 依据层级为 stated_backed，标题**不带**【推测方向】前缀，
 * 描述可以说"论文指出"。
 */
const S1 = build({
  papers: [paper('P001', 'ReAct', 2022)],
  methods: [method('M001', 'ReAct', { paper_ids: ['P001'], task: '交替推理与行动' })],
  evidence: [
    ev(
      'E001',
      'P001',
      'A limitation of our approach is that it does not scale to long-horizon tasks.',
      '我们方法的一个局限是它无法扩展到长程任务。',
      { method_ids: ['M001'] },
    ),
  ],
})

check('stated 夹具产出了 Gap', S1.gapOut.gaps.length > 0, `${S1.gapOut.gaps.length} 条`)
check('stated 夹具产出了方向', S1.out.directions.length > 0, `${S1.out.directions.length} 条`)

const d1 = S1.out.directions[0]
if (d1) {
  check('依据层级为 stated_backed', d1.basis_level === 'stated_backed', d1.basis_level)
  check('candidate_only=false', d1.candidate_only === false)
  check('标题不带【推测方向】前缀', !d1.title.startsWith('【推测方向】'), d1.title)
  check('basis 含 stated_gap_primary', d1.basis.includes('stated_gap_primary'))
  check(
    'basis 不含 candidate_only_evidence',
    !d1.basis.includes('candidate_only_evidence'),
  )
  check('描述了论文明确指出的缺口', /论文明确指出的缺口/.test(d1.description), d1.description)
  check('置信度在 0.5 以上（事实打底）', d1.confidence > 0.5, String(d1.confidence))
  console.log(`    标题「${d1.title}」`)
}

/* ================================================================== */
section('— 2. 研究问题必须是问题，不能是结论 —')
/* ================================================================== */

/*
 * 「研究问题」这个字段最容易被写成陈述句（"现有方法在长程任务上失效"）。
 * 那已经不是问题了，而是对一个事实的断言 —— 而 candidate_only 方向上
 * 那个断言没有事实支撑。断言必须以问号结尾，且不得出现事实口吻词。
 */
for (const d of S1.out.directions) {
  check(
    `${d.direction_id} 研究问题以问号结尾`,
    /[？?]$/.test(d.question.question.trim()),
    d.question.question,
  )
  check(
    `${d.direction_id} 研究问题不含事实断言措辞`,
    !/论文\s*\S*\s*(?:明确)?指出|研究表明|已被证明|众所周知|普遍认为/.test(d.question.question),
    d.question.question,
  )
}
if (d1) {
  check('问题里不出现具体论文编号（避免变成对某篇论文的断言）', !/P\d{3}/.test(d1.question.question))
}

/* ================================================================== */
section('— 3. 只有 candidate → 可以生成，但必须标记为候选依据 —')
/* ================================================================== */

/*
 * 两篇不同论文各写一句"尚未在长程任务上评估" → 4-6 会同时产出
 * 逐条 stated 与一条 candidate。所以这个夹具是 **mixed**（stated 打底 + 推断补充）。
 *
 * 为了单独验 candidate_only，需要构造一个"只有 candidate、没有 stated"的场景。
 * 但 4-6 的 candidate 本身就是从 stated 聚出来的，纯 candidate 输入只能手工构造 ——
 * 这正是本测试唯一一处手工造 Gap 的地方，且必须说明理由。
 */
const S2 = build({
  papers: [paper('P001', 'ReAct', 2022), paper('P002', 'Reflexion', 2023)],
  methods: [
    method('M001', 'ReAct', { paper_ids: ['P001'] }),
    method('M002', 'Reflexion', { paper_ids: ['P002'] }),
  ],
  evidence: [
    ev(
      'E001',
      'P001',
      'A limitation is that our method has not been evaluated on long-horizon tasks.',
      '一个局限是我们的方法尚未在长程任务上进行评估。',
      { method_ids: ['M001'] },
    ),
    ev(
      'E002',
      'P002',
      'Our approach has not been evaluated on long-horizon tasks, which remains an open problem.',
      '我们的方法尚未在长程任务上评估，这仍是一个开放问题。',
      { method_ids: ['M002'] },
    ),
  ],
})

check(
  '两篇共缺夹具中 4-6 同时产出了 stated 与 candidate',
  S2.gapOut.stats.stated > 0 && S2.gapOut.stats.candidate > 0,
  `stated=${S2.gapOut.stats.stated} candidate=${S2.gapOut.stats.candidate}`,
)

const mixed = S2.out.directions.find((d) => d.basis_level === 'mixed')
check('存在依据层级为 mixed 的方向', !!mixed, mixed ? mixed.direction_id : '（无）')
if (mixed) {
  check('mixed 的 basis 同时含 primary 与 secondary', 
    mixed.basis.includes('stated_gap_primary') && mixed.basis.includes('candidate_gap_secondary'))
  check('mixed 的 candidate_only=false', mixed.candidate_only === false)
  check(
    'mixed 的描述区分了"可引用"与"仅推断"',
    /可直接引用|不构成事实依据/.test(mixed.description),
    mixed.description.slice(0, 80),
  )
  console.log(`    mixed 方向：${mixed.gap_ids.join(',')}（stated+candidate 双来源）`)
}

/* ── 纯 candidate_only：手工构造（唯一一处） ── */

/*
 * 为什么必须手工构造：
 * 4-6 的 candidate **一定**伴随同坐标的 stated（它的设计就是"两层都产"）。
 * 所以"只有 candidate、没有任何 stated"这个输入在真实链路里**不会出现**。
 *
 * 但本模块必须能正确处理它，理由有二：
 *   (a) 防御性：若 4-6 未来改了策略（比如只产 candidate），4-7 不能静默失真；
 *   (b) 它是本模块最关键的一条安全边界 —— "推断不能写成事实"这件事，
 *       只有在这个场景下才是**唯一**的防线。若不测，这个不变量等于没验。
 * 所以这里手工造 Gap，并把它标注清楚。
 */
const candidateOnlyGap = {
  gap_id: 'GR001',
  assertion_level: 'candidate',
  candidate: true,
  gap_signal: 'uncovered_setting',
  theme: 'long_horizon',
  title: '【候选】多篇论文共同提及的长周期 / 多步任务缺口（原文指出的未覆盖场景）',
  description:
    '系统在 2 篇不同论文（P001、P002）的证据中，观察到同一类「原文指出的未覆盖场景」表述，' +
    '且场景均落在「长周期 / 多步任务」。这构成一个**推断的候选缺口**，而非任何单篇论文的既有结论 —— 是否成立需要进一步确认。',
  evidence_ids: ['E001', 'E002'],
  paper_ids: ['P001', 'P002'],
  method_ids: ['M001', 'M002'],
  basis: ['uncovered_setting_statement', 'evidence_ownership_verified', 'multi_paper_shared_gap'],
  gap_type_guess: 'method',
  confidence: 0.56,
}

const S3out = generateDirections({
  gaps: [candidateOnlyGap],
  methods: [method('M001', 'ReAct', { paper_ids: ['P001'] }), method('M002', 'Reflexion', { paper_ids: ['P002'] })],
  evidence: [
    ev('E001', 'P001', 'Our method has not been evaluated on long-horizon tasks.', '我们的方法尚未在长程任务上评估。', { method_ids: ['M001'] }),
    ev('E002', 'P002', 'We have not tested our approach on long-horizon tasks.', '我们尚未在长程任务上测试我们的方法。', { method_ids: ['M002'] }),
  ],
  papers: [paper('P001', 'ReAct', 2022), paper('P002', 'Reflexion', 2023)],
  evolutionRelations: [],
})

const d3 = S3out.directions[0]
check('仅 candidate 输入也能产出方向', S3out.directions.length === 1, `${S3out.directions.length} 条`)
if (d3) {
  check('依据层级为 candidate_only', d3.basis_level === 'candidate_only', d3.basis_level)
  check('candidate_only 便捷布尔为 true', d3.candidate_only === true)
  check('标题带【推测方向】前缀', d3.title.startsWith('【推测方向】'), d3.title)
  check(
    '描述明写这是探索性建议',
    /探索性|建议先核实|不是任何论文的原话/.test(d3.description),
    d3.description.slice(0, 90),
  )
  check(
    '**描述里不出现事实口吻**（核心安全断言）',
    !/论文\s*\S*\s*(?:明确)?指出|研究表明|已被证明|普遍认为|众所周知|界内公认/.test(d3.description),
    d3.description.slice(0, 120),
  )
  check('basis 含 candidate_only_evidence', d3.basis.includes('candidate_only_evidence'))
  check(
    'basis **不**含 stated_gap_primary（不能声称有事实打底）',
    !d3.basis.includes('stated_gap_primary'),
  )
  check('置信度被压到 0.5 以内', d3.confidence <= 0.5, String(d3.confidence))
  console.log(`    标题「${d3.title}」· 置信度 ${d3.confidence}`)
}

/* ================================================================== */
section('— 4. 没有 Gap → 不生成方向 —')
/* ================================================================== */

const S4 = generateDirections({
  gaps: [],
  methods: [],
  evidence: [],
  papers: [],
  evolutionRelations: [],
})

check('无 Gap 时产出 0 条方向', S4.directions.length === 0, `${S4.directions.length} 条`)
check('stats.total 为 0', S4.stats.total === 0)
check('context.has_any_gap 为 false（0 条是预期结果，不是失败）', S4.context.has_any_gap === false)
check('不变量无违规', assertDirectionInvariants(S4, { gaps: [], methods: [], evidence: [], papers: [], evolutionRelations: [] }).length === 0)

/* 有 Gap 但没有对应证据 → 也不得生成 */
const S4b = generateDirections({
  gaps: [
    {
      ...candidateOnlyGap,
      gap_id: 'GR001',
      /* 证据 id 在语料里不存在 */
      evidence_ids: ['E999'],
    },
  ],
  methods: [],
  evidence: [],
  papers: [],
  evolutionRelations: [],
})
check(
  'Gap 的证据在语料里不存在时，不生成方向',
  S4b.directions.length === 0,
  `${S4b.directions.length} 条`,
)

/* Gap 的 evidence_ids 为空数组 → 不得生成 */
const S4c = generateDirections({
  gaps: [{ ...candidateOnlyGap, gap_id: 'GR001', evidence_ids: [] }],
  methods: [],
  evidence: [],
  papers: [],
  evolutionRelations: [],
})
check('Gap 无证据时，不生成方向', S4c.directions.length === 0, `${S4c.directions.length} 条`)

/*
 * ── 4d. 第二道证据防线是冗余网（用实测结论说话，不假设） ──
 *
 * 故障注入实验结论：
 *   · 只关"防线①"（过滤阶段丢弃无证据 Gap）→ §4 的 S4c 失败 ✓
 *   · 只关"防线②"（构造阶段 evidenceIds 空则跳过）→ 全绿
 *
 * 原因是防线① 内部有**三重检查**（空数组 / 全不存在 / 只保留存在的），
 * 它保证任何活到防线② 的 Gap 都至少带着 1 条**真实存在**的证据。
 * 因此防线② 在数学上不可达 —— 它是安全网，不是活防御。
 *
 * 这里不假装测它（假装测 = 假覆盖），而是断言真正可达的那个不变量：
 * **凡是产出的方向，其 evidence_ids 必定全部存在于语料中**。
 * 这条断言在防线① 被破坏时会立刻失败，是真防线。
 */
const S4d = generateDirections({
  gaps: [
    { ...candidateOnlyGap, gap_id: 'GR001', evidence_ids: ['E001', 'E999'], paper_ids: ['P001'] },
  ],
  methods: [],
  /* E001 真实存在，E999 不存在 → 防线① 应把 E999 剔掉、保留 E001 */
  evidence: [
    ev('E001', 'P001', 'We have not tested our approach on long-horizon tasks.', '我们尚未在长程任务上测试。'),
  ],
  papers: [paper('P001', 'Alpha', 2022)],
  evolutionRelations: [],
})
check(
  '4d 部分证据不存在时，只保留真实存在的证据',
  S4d.directions.length === 1 &&
    JSON.stringify(S4d.directions[0].evidence_ids) === JSON.stringify(['E001']),
  S4d.directions.map((d) => JSON.stringify(d.evidence_ids)).join(' | '),
)
check(
  '4d 产出方向的证据全部真实存在于语料（真防线：防线①破则此处必挂）',
  S4d.directions.every((d) => d.evidence_ids.every((eid) => eid === 'E001')),
  S4d.directions.map((d) => d.evidence_ids.join(',')).join(' | '),
)
/* 反向：凭空证据一个都不许漏进来 */
check(
  '4d 不存在的 E999 绝不出现在任何方向的 evidence_ids 里',
  S4d.directions.every((d) => !d.evidence_ids.includes('E999')),
  S4d.directions.map((d) => d.evidence_ids.join(',')).join(' | '),
)

console.log('  无 Gap / 无对应证据 / Gap 证据为空 / 部分证据不存在 —— 四种情况均不产出无据方向')

/* ================================================================== */
section('— 5. 每个方向都能回链 Gap + Evidence —')
/* ================================================================== */

/*
 * 回链有三层，缺一不可：
 *   (a) gap_ids 非空，且每个 id 都真的存在于输入的 Gap 集合
 *   (b) evidence_ids 非空，且每条都真的存在于语料
 *   (c) **证据必须来自该方向关联的 Gap** —— 不能凭空引入
 *       （这条最狠：它把"为了让方向看起来更有依据，另挂几条不相关证据"堵死）
 */
let dirChecked = 0
for (const [label, s] of [['S1', S1], ['S2', S2]]) {
  const gapById = new Map(s.gapOut.gaps.map((g) => [g.gap_id, g]))
  const evIds = new Set(s.input.evidence.map((e) => e.evidence_id))

  for (const d of s.out.directions) {
    dirChecked++
    check(`${label}/${d.direction_id} 至少关联 1 个 Gap`, d.gap_ids.length >= 1)
    check(`${label}/${d.direction_id} 至少关联 1 条 Evidence`, d.evidence_ids.length >= 1)

    for (const gid of d.gap_ids) {
      check(`${label}/${d.direction_id} 的 Gap ${gid} 真实存在`, gapById.has(gid))
    }
    /* (c) 证据必须来自关联 Gap 的并集 */
    const allowed = new Set(d.gap_ids.flatMap((gid) => gapById.get(gid)?.evidence_ids ?? []))
    for (const eid of d.evidence_ids) {
      check(
        `${label}/${d.direction_id} 的证据 ${eid} 来自关联 Gap（非凭空引入）`,
        allowed.has(eid),
      )
      check(`${label}/${d.direction_id} 的证据 ${eid} 真实存在`, evIds.has(eid))
    }
  }
}
check('至少检查了 1 个方向', dirChecked >= 1, `${dirChecked} 个`)

/* 不变量自检也要空 */
for (const [label, s] of [['S1', S1], ['S2', S2]]) {
  const bad = assertDirectionInvariants(s.out, {
    gaps: s.gapOut.gaps,
    methods: s.input.methods,
    evidence: s.input.evidence,
    papers: s.input.papers,
    evolutionRelations: s.input.evolutionRelations ?? [],
  })
  check(`${label} 不变量全部通过`, bad.length === 0, bad.slice(0, 2).join(' | '))
}

/* ================================================================== */
section('— 6. 不产生没有来源的「研究事实」—')
/* ================================================================== */

/*
 * 这一节是 4-7 的核心安全边界，分三个角度验：
 *
 *   (a) 文案层：candidate_only 方向不得出现事实口吻（已在上文验，这里再普查一次）
 *   (b) 结构层：方向的证据不得超出其所关联 Gap 的证据（= 第 5 节 (c)）
 *   (c) **素材层**：方法切入点引用的方法必须来自本项目；
 *       验证方案若声称"素材来自语料"，就必须真的能在那几条证据里找到评测素材词。
 *
 * (c) 是最容易被忽略的：一个方向写着"建议在公开基准上评测"，
 * 若本项目证据里根本没有 mention 任何基准，那这句话就是凭常识补的。
 */
const REAL_BENCH_HINT = /\b(?:benchmark|bench|suite|dataset|corpus|baseline|ablation|human\s+eval)\b|基准|数据集|基线|消融|人工评测/i

for (const [label, s] of [['S1', S1], ['S2', S2]]) {
  const evById = new Map(s.input.evidence.map((e) => [e.evidence_id, e]))
  for (const d of s.out.directions) {
    /* 切入点引用的方法必须真实存在于本项目 */
    const knownMethods = new Set(s.input.methods.map((m) => m.method_id))
    for (const mid of d.approach.based_on_method_ids) {
      check(`${label}/${d.direction_id} 切入点方法 ${mid} 来自本项目`, knownMethods.has(mid))
    }

    /*
     * 若 from_corpus=true，则 materials 里提到的评测素材类别
     * 必须真的能在该方向的证据里找到对应词。
     */
    if (d.validation.from_corpus) {
      const corpusText = d.evidence_ids
        .map((eid) => `${evById.get(eid)?.content ?? ''} ${evById.get(eid)?.translation ?? ''}`)
        .join(' ')
      check(
        `${label}/${d.direction_id} validation.from_corpus=true 时语料确有评测素材`,
        REAL_BENCH_HINT.test(corpusText),
        `语料片段：${corpusText.slice(0, 60)}`,
      )
    }
  }
}

/* candidate_only 方向不得声称"素材来自语料"却没素材（同上，用 S3） */
if (d3) {
  if (d3.validation.from_corpus) {
    check('candidate_only 若声称素材来自语料，需真的能核实', false, '不应走到这里')
  } else {
    check(
      'candidate_only 无评测素材时如实降级（from_corpus=false）',
      /需另行补充|暂不指定/.test(d3.validation.materials),
      d3.validation.materials.slice(0, 80),
    )
  }
}

/* 全局普查：任何方向都不得出现"论文明确指出"用在 candidate_only 上 */
for (const d of S3out.directions) {
  check(
    'candidate_only 方向全文无「论文指出」字样',
    !/论文[\s\S]{0,12}指出/.test(`${d.title} ${d.description} ${d.question.rationale}`),
  )
}

console.log('  切入点方法均可溯源 · 评测素材声称与语料一致 · 推断方向无事实口吻')

/* ================================================================== */
section('— 7. 输入乱序 → 输出逐字节一致 —')
/* ================================================================== */

/*
 * 把 S2 的 papers / methods / evidence 全部**倒序**，重跑整条链路。
 * 输出必须完全一致（包括 direction_id、标题、描述、统计）。
 *
 * 为什么用倒序而不是"跑两次"：跑两次验的是"函数无副作用"，
 * 验不到"排序键依赖了输入数组顺序"。必须真的改变输入顺序。
 */
const rev = (a) => [...a].reverse()

const S2b = build({
  papers: rev(S2.input.papers),
  methods: rev(S2.input.methods),
  evidence: rev(S2.input.evidence),
})

check(
  '倒序输入后 canonical 形式逐字节一致',
  JSON.stringify(canonical(S2.out)) === JSON.stringify(canonical(S2b.out)),
  '结果依赖了输入数组顺序',
)
check(
  'direction_id 序列一致',
  S2.out.directions.map((d) => d.direction_id).join(',') ===
    S2b.out.directions.map((d) => d.direction_id).join(','),
  `${S2.out.directions.map((d) => d.direction_id).join(',')} vs ${S2b.out.directions.map((d) => d.direction_id).join(',')}`,
)
check(
  'gap_ids 序列一致',
  JSON.stringify(S2.out.directions.map((d) => d.gap_ids)) ===
    JSON.stringify(S2b.out.directions.map((d) => d.gap_ids)),
)
check(
  '同一输入连续调用两次结果一致（无内部状态）',
  JSON.stringify(canonical(generateDirections({
    gaps: S2.gapOut.gaps,
    methods: S2.input.methods,
    evidence: S2.input.evidence,
    papers: S2.input.papers,
    evolutionRelations: [],
  }))) === JSON.stringify(canonical(S2.out)),
)

/*
 * ── 7b. tie-break 覆盖：排序键"内容派生"不能只看前几级 ──
 *
 * 背景：§7 用 S2 倒序验证稳定性，但 S2 的两条方向在
 *   basis_level / gap_signal / confidence / evidence_ids.length
 * 四级排序键上就已经分出胜负，**从未落到 theme → evidence_ids 这两级兜底键**。
 * 因此把兜底键删掉，§7 依然全绿 —— 这是一个真实的覆盖漏洞。
 *
 * 构造：两条方向在四级主键上完全打平（同为 stated_backed、
 * 同信号 missing_comparison、同证据数 1），只有 theme 不同。
 * 此时唯一的定序依据就是内容派生的 theme 兜底键。
 * 再倒序输入，若兜底键依赖输入顺序，输出就会翻转。
 *
 * ⚠️ 关键设计：必须让"title 顺序"与"theme 顺序"**相反**。
 *
 * 模块在跨组去重前会先按 title 排一次序（步骤 ③b），若两趟排序同向，
 * 最终顺序会被 title 那趟"顺带"定下来，把兜底键删掉也照样绿 —— 假覆盖。
 *
 * 而 direction.title 是由 themeLabel 拼的，themeLabel 又是 theme 的映射，
 * 所以不能靠"改 gap.title"来撕开（gap.title 根本没进 direction.title）。
 * 唯一可行的切法：选一对 theme key，让 **key 的排序**与 **label 的排序**相反。
 *
 *   memory_context → label「记忆与上下文管理」（中文，靠后）
 *   zzz_custom     → 未映射，label 回退为 key 本身（ASCII，靠前）
 *
 *   key 序：memory_context < zzz_custom
 *   label 序：zzz_custom   < 记忆与上下文管理   ← 与 key 序相反 ✓
 *
 * 于是一旦删掉 theme / evidence_ids 这两级兜底键，输出顺序就会翻转。
 */
const tieGap = (id, pid, theme, eid) => ({
  gap_id: id,
  assertion_level: 'stated',
  candidate: false,
  gap_signal: 'missing_comparison',
  theme,
  title: '论文明确指出：该方法缺少必要的基线对比。',
  description: '论文明确指出该方法缺少必要的基线对比。',
  evidence_ids: [eid],
  paper_ids: [pid],
  method_ids: [],
  basis: ['missing_comparison_statement', 'evidence_ownership_verified'],
  gap_type_guess: 'method',
  confidence: 0.7,
})

const TIE_INPUT = {
  gaps: [
    tieGap('GT001', 'P001', 'zzz_custom', 'E001'),
    tieGap('GT002', 'P002', 'memory_context', 'E002'),
  ],
  methods: [],
  evidence: [
    ev('E001', 'P001', 'Model A has not been compared against baseline B.', '模型 A 未与基线 B 对比。'),
    ev('E002', 'P002', 'Model C has not been compared against baseline D.', '模型 C 未与基线 D 对比。'),
  ],
  papers: [paper('P001', 'Alpha', 2022), paper('P002', 'Beta', 2023)],
  evolutionRelations: [],
}
const TIE = generateDirections(TIE_INPUT)
const TIE_REV = generateDirections({
  ...TIE_INPUT,
  gaps: rev(TIE_INPUT.gaps),
  evidence: rev(TIE_INPUT.evidence),
  papers: rev(TIE_INPUT.papers),
})

check('tie-break 场景确实产生了 2 条方向', TIE.directions.length === 2, `${TIE.directions.length} 条`)
check(
  'tie-break 场景四级主键确实全部打平（否则测不到兜底键）',
  TIE.directions.length === 2 &&
    TIE.directions[0].basis_level === TIE.directions[1].basis_level &&
    TIE.directions[0].gap_signal === TIE.directions[1].gap_signal &&
    TIE.directions[0].confidence === TIE.directions[1].confidence &&
    TIE.directions[0].evidence_ids.length === TIE.directions[1].evidence_ids.length,
  TIE.directions
    .map((d) => `${d.basis_level}/${d.gap_signal}/${d.confidence}/${d.evidence_ids.length}`)
    .join(' vs '),
)
check(
  '打平后由内容派生的 theme 兜底键定序（memory_context 在前）',
  TIE.directions[0]?.theme === 'memory_context',
  TIE.directions.map((d) => d.theme).join(' → '),
)
check(
  '该顺序确实与 title 顺序相反（保证测的是 theme 兜底键，不是 title 那趟排序）',
  TIE.directions.length === 2 &&
    TIE.directions[1].title.localeCompare(TIE.directions[0].title) < 0,
  TIE.directions.map((d) => `[${d.theme}] ${d.title}`).join(' | '),
)
check(
  'tie-break 场景倒序输入后仍逐字节一致',
  JSON.stringify(canonical(TIE)) === JSON.stringify(canonical(TIE_REV)),
  '兜底排序键依赖了输入数组顺序',
)

console.log(`  倒序后仍是 ${S2b.out.directions.map((d) => d.direction_id).join(',')}，整包一致`)

/* ================================================================== */
section('— 8. 依据层级与统计自洽 —')
/* ================================================================== */

for (const [label, s] of [['S1', S1], ['S2', S2]]) {
  const out = s.out
  const byLevel = (lv) => out.directions.filter((d) => d.basis_level === lv)

  check(
    `${label} 三个依据层级之和 = total`,
    byLevel('stated_backed').length + byLevel('mixed').length + byLevel('candidate_only').length ===
      out.directions.length,
  )
  check(`${label} stats.stated_backed 自洽`, out.stats.stated_backed === byLevel('stated_backed').length)
  check(`${label} stats.mixed 自洽`, out.stats.mixed === byLevel('mixed').length)
  check(`${label} stats.candidate_only 自洽`, out.stats.candidate_only === byLevel('candidate_only').length)
  check(`${label} stats.total 自洽`, out.stats.total === out.directions.length)

  for (const sig of ['limitation', 'open_problem', 'missing_comparison', 'uncovered_setting']) {
    const n = out.directions.filter((d) => d.gap_signal === sig).length
    check(`${label} stats.${sig} 自洽`, out.stats[sig] === n, `${out.stats[sig]} vs ${n}`)
  }
  check(
    `${label} 四类信号之和 = total`,
    out.stats.limitation + out.stats.open_problem + out.stats.missing_comparison + out.stats.uncovered_setting ===
      out.stats.total,
  )

  /* 硬门槛在统计里恒为 0 */
  check(`${label} directions_without_gap 恒为 0`, out.stats.directions_without_gap === 0)
  check(`${label} directions_without_evidence 恒为 0`, out.stats.directions_without_evidence === 0)

  /* summarizeDirections 与 generateDirections 内建口径必须一致（防两份实现漂移） */
  const recomputed = summarizeDirections(out.directions, {
    deduplicated: out.stats.deduplicated,
    gapsConsidered: out.stats.gaps_considered,
  })
  check(
    `${label} summarizeDirections 重算与内建一致`,
    JSON.stringify(recomputed) === JSON.stringify(out.stats),
    '统计口径出现两份实现',
  )

  /* context 自洽 */
  check(
    `${label} context.stated_gaps + candidate_gaps = gaps_received`,
    out.context.stated_gaps + out.context.candidate_gaps === out.context.gaps_received,
  )
  check(
    `${label} context.gaps_used ≤ gaps_received`,
    out.context.gaps_used <= out.context.gaps_received,
  )
  check(
    `${label} context 带 rule_version`,
    out.context.rule_version === DIRECTION_RULE_VERSION,
  )
  /* 论文/方法去重计数 */
  check(
    `${label} stats.papers_involved 自洽`,
    out.stats.papers_involved === new Set(out.directions.flatMap((d) => d.paper_ids)).size,
  )
  check(
    `${label} stats.methods_involved 自洽`,
    out.stats.methods_involved === new Set(out.directions.flatMap((d) => d.method_ids)).size,
  )
}

/* 排序优先级：stated_backed 永远排在 candidate_only 之前 */
{
  const order = S2.out.directions.map((d) => d.basis_level)
  const rank = { stated_backed: 0, mixed: 1, candidate_only: 2 }
  const sorted = [...order].sort((a, b) => rank[a] - rank[b])
  check('依据层级降序排列（事实优先于推断）', JSON.stringify(order) === JSON.stringify(sorted), order.join(' > '))
}

/* ================================================================== */
section('— 9. 方法切入点：只能来自本项目语料 —')
/* ================================================================== */

/*
 * 这条验的是"三个输出里最容易编造的一项"。
 * 切入点必须绑定本项目真实存在的方法，或如实降级为 introduce_new。
 */
/* S3 是直接构造的 outcome（不是 build() 返回的包装），单独列出它用的方法池 */
const S3_METHODS = [
  method('M001', 'ReAct', { paper_ids: ['P001'] }),
  method('M002', 'Reflexion', { paper_ids: ['P002'] }),
]

for (const [label, outcome, mPool] of [
  /* S1/S2 来自 build()，是 {gapOut,out,input} 包装；S3 是直接构造的 outcome */
  ['S1', S1.out, S1.input.methods],
  ['S2', S2.out, S2.input.methods],
  ['S3', S3out, S3_METHODS],
]) {
  const known = new Set(mPool.map((m) => m.method_id))
  for (const d of outcome.directions) {
    if (d.approach.kind === 'introduce_new') {
      check(`${label}/${d.direction_id} introduce_new 不绑定方法`, d.approach.based_on_method_ids.length === 0)
      check(
        `${label}/${d.direction_id} introduce_new 说明需引入`,
        /需要引入|没有.*可复用|另行补充/.test(d.approach.description),
      )
    } else {
      check(
        `${label}/${d.direction_id} 切入点绑定本项目方法`,
        d.approach.based_on_method_ids.length > 0 &&
          d.approach.based_on_method_ids.every((m) => known.has(m)),
        `kind=${d.approach.kind} ids=${JSON.stringify(d.approach.based_on_method_ids)}`,
      )
      check(
        `${label}/${d.direction_id} 切入点带方法名（便于前端直显）`,
        d.approach.based_on_method_names.length === d.approach.based_on_method_ids.length,
      )
    }
  }
}

/*
 * 反向夹具：本项目**没有**方法时，切入点必须降级为 introduce_new，
 * 且**不得**编出任何方法名。
 */
const S9 = generateDirections({
  gaps: [candidateOnlyGap],
  methods: [],
  evidence: [
    ev('E001', 'P001', 'Our method has not been evaluated on long-horizon tasks.', '我们的方法尚未在长程任务上评估。'),
    ev('E002', 'P002', 'We have not tested our approach on long-horizon tasks.', '我们尚未在长程任务上测试我们的方法。'),
  ],
  papers: [paper('P001', 'ReAct', 2022), paper('P002', 'Reflexion', 2023)],
  evolutionRelations: [],
})
const d9 = S9.directions[0]
if (d9) {
  check('本项目无方法时降级为 introduce_new', d9.approach.kind === 'introduce_new', d9.approach.kind)
  check('不绑定任何方法', d9.approach.based_on_method_ids.length === 0)
  check('basis 记录 no_corpus_method_available', d9.basis.includes('no_corpus_method_available'))
  check(
    '切入点描述不编造方法名',
    !/[A-Z][a-zA-Z]*-?[a-zA-Z]*\s*(模型|方法|框架)/.test(d9.approach.description) ||
      /需要引入新的做法/.test(d9.approach.description),
    d9.approach.description.slice(0, 90),
  )
  console.log(`    无方法池 → kind=${d9.approach.kind}，如实声明需引入`)
}

/* 方法池为空时不得因为"没有方法"而丢掉方向 */
check('无方法池时方向依然产出（不被静默丢弃）', S9.directions.length === 1, `${S9.directions.length} 条`)

/* ================================================================== */
section('— 10. 已被后续工作改进的方法不进入切入点候选 —')
/* ================================================================== */

/*
 * 与 4-6 的 addressedMethods 同源但用途不同：
 * 4-6 用它给 Gap 降权，4-7 用它**避免推荐重复劳动**。
 *
 * 构造：P001 的 M001 有一条局限；P002 的 M002 明确声明"builds on M001 and
 * extends it" → M001 被标记为 addressed。那么涉及 M001 的方向，
 * 切入点候选池里就不该再有 M001。
 */
const S10 = build({
  papers: [paper('P001', 'ReAct', 2022), paper('P002', 'ReActX', 2024)],
  methods: [
    method('M001', 'ReAct', { year: 2022, paper_ids: ['P001'] }),
    method('M002', 'ReActX', { year: 2024, paper_ids: ['P002'] }),
  ],
  evidence: [
    ev(
      'E001',
      'P001',
      'A limitation is that our method has not been evaluated on long-horizon tasks.',
      '一个局限是我们的方法尚未在长程任务上评估。',
      { method_ids: ['M001'] },
    ),
    ev(
      'E002',
      'P002',
      'ReActX builds on ReAct and extends it to long-horizon tasks.',
      'ReActX 建立在 ReAct 之上并扩展到长程任务。',
      { method_ids: ['M002'] },
    ),
  ],
})

const directionTouchingM001 = S10.out.directions.find((d) => d.method_ids.includes('M001'))
if (directionTouchingM001) {
  check(
    'M001 已被后续工作改进 → 不再作为切入点候选',
    !directionTouchingM001.approach.based_on_method_ids.includes('M001'),
    `切入点：${JSON.stringify(directionTouchingM001.approach.based_on_method_ids)}`,
  )
  check(
    '该降权在 basis 里如实留痕（不静默丢弃）',
    directionTouchingM001.basis.includes('gap_addressed_by_later_work') ||
      directionTouchingM001.approach.kind === 'introduce_new',
    directionTouchingM001.basis.join(','),
  )
  console.log(
    `    方向涉及 M001，但切入点候选已排除它（kind=${directionTouchingM001.approach.kind}）`,
  )
} else {
  check('夹具未产出涉及 M001 的方向（夹具不成立）', false)
}

/* ================================================================== */
section('— 11. 跨组去重 + 编号稳定 —')
/* ================================================================== */

/*
 * 同一主题、证据完全相同的两个组应当合并成一条方向，
 * 且两个组的 gap_ids 都要保留（不能有 Gap 被无声吞掉）。
 */
const S11 = generateDirections({
  gaps: [
    /* 同主题、同证据，但信号不同 → 两个组 → 应被去重合并 */
    { ...candidateOnlyGap, gap_id: 'GR001', gap_signal: 'uncovered_setting', evidence_ids: ['E001', 'E002'] },
    { ...candidateOnlyGap, gap_id: 'GR002', gap_signal: 'uncovered_setting', evidence_ids: ['E001', 'E002'] },
  ],
  methods: [method('M001', 'ReAct', { paper_ids: ['P001'] })],
  evidence: [
    ev('E001', 'P001', 'Our method has not been evaluated on long-horizon tasks.', '我们的方法尚未在长程任务上评估。', { method_ids: ['M001'] }),
    ev('E002', 'P002', 'We have not tested our approach on long-horizon tasks.', '我们尚未在长程任务上测试我们的方法。'),
  ],
  papers: [paper('P001', 'ReAct', 2022), paper('P002', 'Reflexion', 2023)],
  evolutionRelations: [],
})

check('同主题同证据的两个 Gap 合并为 1 条方向', S11.directions.length === 1, `${S11.directions.length} 条`)
if (S11.directions[0]) {
  check(
    '合并后保留全部 gap_ids（无 Gap 被吞）',
    S11.directions[0].gap_ids.length === 2,
    JSON.stringify(S11.directions[0].gap_ids),
  )
  /*
   * 两个同坐标 Gap 在**步骤 ② 分组**时就落进同一组，属于"组内合并"路径，
   * 所以标记是 merged_same_coordinate_gaps 而不是 deduplicated_by_overlap
   * （后者是跨组去重路径的标记）。两条路径分开留痕，见模块内注释。
   */
  check(
    'basis 记录 merged_same_coordinate_gaps（组内合并留痕）',
    S11.directions[0].basis.includes('merged_same_coordinate_gaps'),
    S11.directions[0].basis.join(','),
  )
  check('stats.deduplicated 计数正确（2 Gap → 1 方向 = 1 条被合并）', S11.stats.deduplicated === 1, String(S11.stats.deduplicated))

  /* 反向：只有一个 Gap 时不出现合并标记 */
  if (S1.out.directions[0]) {
    check(
      '单个 Gap 的方向不带合并标记',
      !S1.out.directions[0].basis.includes('merged_same_coordinate_gaps'),
    )
  }
}

/* 不同主题 → 不合并 */
const S11b = generateDirections({
  gaps: [
    { ...candidateOnlyGap, gap_id: 'GR001', theme: 'long_horizon', evidence_ids: ['E001'] },
    { ...candidateOnlyGap, gap_id: 'GR002', theme: 'repository_level', evidence_ids: ['E002'] },
  ],
  methods: [],
  evidence: [
    ev('E001', 'P001', 'Not evaluated on long-horizon tasks.', '尚未在长程任务上评估。'),
    ev('E002', 'P002', 'Not evaluated on repository-level tasks.', '尚未在仓库级任务上评估。'),
  ],
  papers: [paper('P001', 'A', 2022), paper('P002', 'B', 2023)],
  evolutionRelations: [],
})
check('不同主题不合并（证据也不同）', S11b.directions.length === 2, `${S11b.directions.length} 条`)

/* 编号必须是"排序后位置"的纯函数 */
for (const [label, out] of [['S1', S1.out], ['S2', S2.out], ['S11', S11]]) {
  out.directions.forEach((d, i) => {
    check(
      `${label} 第 ${i + 1} 条编号为 RD${String(i + 1).padStart(3, '0')}`,
      d.direction_id === `RD${String(i + 1).padStart(3, '0')}`,
      d.direction_id,
    )
  })
}

/* ================================================================== */
section('— 12. 不变量契约自身可信 —')
/* ================================================================== */

/*
 * 上一节验的是"合法输出能通过不变量"。这一节反过来验：
 * **不变量真的能拦住违规输出**。否则那 17 条检查只是摆设。
 *
 * 做法：拿一份合法输出，人为改坏，看 assertDirectionInvariants 是否报错。
 * 这也顺带证明"不变量不是恒真的"（恒真的断言等于没写）。
 */
const goodOut = S2.out
const clone = (o) => JSON.parse(JSON.stringify(o))
const inputForS2 = {
  gaps: S2.gapOut.gaps,
  methods: S2.input.methods,
  evidence: S2.input.evidence,
  papers: S2.input.papers,
  evolutionRelations: [],
}

check('合法输出：不变量为空', assertDirectionInvariants(goodOut, inputForS2).length === 0)

/* 坏样本 1：抹掉 gap_ids */
{
  const bad = clone(goodOut)
  bad.directions[0].gap_ids = []
  const errs = assertDirectionInvariants(bad, inputForS2)
  check('抹掉 gap_ids → 被拦截', errs.length > 0, errs[0] ?? '')
}

/* 坏样本 2：抹掉 evidence_ids */
{
  const bad = clone(goodOut)
  bad.directions[0].evidence_ids = []
  const errs = assertDirectionInvariants(bad, inputForS2)
  check('抹掉 evidence_ids → 被拦截', errs.length > 0, errs[0] ?? '')
}

/* 坏样本 3：把 candidate_only 的标题前缀去掉（推断伪装成事实） */
{
  const bad = clone(S3out)
  bad.directions[0].title = bad.directions[0].title.replace('【推测方向】', '')
  const errs = assertDirectionInvariants(bad, undefined)
  check('去掉【推测方向】前缀 → 被拦截', errs.length > 0, errs[0] ?? '')
}

/* 坏样本 4：把 candidate_only 的描述改成事实口吻 */
{
  const bad = clone(S3out)
  bad.directions[0].description = '论文明确指出该方法在长程任务上失效，因此应当加以改进。'
  const errs = assertDirectionInvariants(bad, undefined)
  check('candidate_only 出现事实口吻 → 被拦截', errs.length > 0, errs[0] ?? '')
}

/* 坏样本 5：凭空引入一条不相关证据 */
{
  const bad = clone(goodOut)
  bad.directions[0].evidence_ids = [...bad.directions[0].evidence_ids, 'E_NOT_EXIST']
  const errs = assertDirectionInvariants(bad, inputForS2)
  check('凭空引入不存在的证据 → 被拦截', errs.length > 0, errs[0] ?? '')
}

/* 坏样本 6：研究问题写成陈述句 */
{
  const bad = clone(goodOut)
  bad.directions[0].question.question = '该方法在长程任务上失效'
  const errs = assertDirectionInvariants(bad, inputForS2)
  check('研究问题不以问号结尾 → 被拦截', errs.length > 0, errs[0] ?? '')
}

/* 坏样本 7：candidate_only 的置信度超过上限 */
{
  const bad = clone(S3out)
  bad.directions[0].confidence = 0.9
  const errs = assertDirectionInvariants(bad, undefined)
  check('candidate_only 置信度超上限 → 被拦截', errs.length > 0, errs[0] ?? '')
}

/* 坏样本 8：切入点绑定不存在的方法 */
{
  const bad = clone(goodOut)
  bad.directions[0].approach.kind = 'extend_existing'
  bad.directions[0].approach.based_on_method_ids = ['M_NOT_EXIST']
  const errs = assertDirectionInvariants(bad, inputForS2)
  check('切入点引用不存在的方法 → 被拦截', errs.length > 0, errs[0] ?? '')
}

/* 坏样本 9：candidate_only 布尔与 basis_level 不一致 */
{
  const bad = clone(goodOut)
  bad.directions[0].candidate_only = true
  const errs = assertDirectionInvariants(bad, inputForS2)
  check('candidate_only 布尔与 basis_level 不一致 → 被拦截', errs.length > 0, errs[0] ?? '')
}

console.log('  9 个坏样本全部被不变量拦截（不变量非恒真）')

/* ================================================================== */
section('— 13. 与 4-6 的衔接：Gap 侧不变量未被破坏 —')
/* ================================================================== */

/*
 * 4-7 只读 4-6 的输出，绝不修改它。
 * 这里断言夹具跑完 4-6 后其自身不变量依然为空 —— 顺带证明
 * generateDirections 没有意外地原地改动传入的 Gap 对象（纯函数要求）。
 */
for (const [label, s] of [['S1', S1], ['S2', S2], ['S10', S10]]) {
  check(`${label} 4-6 输出不变量仍为空`, assertGapInvariants(s.gapOut).length === 0)
}

/* 纯函数性：传入的 gaps 数组不应被改动 */
{
  const gapsCopy = JSON.parse(JSON.stringify(S2.gapOut.gaps))
  generateDirections({
    gaps: S2.gapOut.gaps,
    methods: S2.input.methods,
    evidence: S2.input.evidence,
    papers: S2.input.papers,
    evolutionRelations: [],
  })
  check(
    'generateDirections 不修改传入的 gaps（纯函数）',
    JSON.stringify(S2.gapOut.gaps) === JSON.stringify(gapsCopy),
  )
}

/* 依据层级常量完整性 */
check(
  'DIRECTION_BASIS_LEVELS 三个取值齐备',
  DIRECTION_BASIS_LEVELS.length === 3 &&
    DIRECTION_BASIS_LEVELS.includes('stated_backed') &&
    DIRECTION_BASIS_LEVELS.includes('mixed') &&
    DIRECTION_BASIS_LEVELS.includes('candidate_only'),
)

/* rule_version 是确定性规则的标记 */
check(
  'rule_version 标明 deterministic',
  /deterministic/.test(DIRECTION_RULE_VERSION),
  DIRECTION_RULE_VERSION,
)

/* ------------------------------------------------------------------ */

console.log('\n' + '─'.repeat(70))
if (fail > 0) {
  console.log(`✗ 研究方向测试未通过（通过 ${pass} 项 / 失败 ${fail} 项）`)
  process.exit(1)
}
console.log(`✓ 研究方向测试全部通过（${pass} 项断言）`)
console.log(
  '  stated 可生成 · 仅候选必标推测 · 无 Gap 不生成 · 全部可回链 · 乱序一致 · 无凭空事实',
)
