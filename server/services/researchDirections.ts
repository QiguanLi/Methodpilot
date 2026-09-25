/**
 * 研究方向生成（Phase 4-7）。
 *
 * ── 这个模块回答什么问题 ──
 *
 * 4-6 已经找出了一堆 Gap（"论文自己承认做不到的事"）。用户接下来的问题是：
 *   「那我该往哪个方向做？」
 * 本模块把 Gap 翻译成**可执行的研究方向**：一个研究问题 + 一个方法切入点 + 一个验证方案。
 *
 * ── 与 4-6 的分工（这条边界必须守住）──
 *   · 4-6 只做"证据的搬运与聚类"，产出的每条 Gap 都能指回一句真人写的原文。
 *   · 4-7 是**第一次引入"生成"** —— 它要说出论文里**没有**的话
 *     （"你可以试试用 X 解决 Y"）。
 *
 * 这是本模块最大的风险所在，所以下面这条底线贯彻全文：
 *
 * ── 本模块唯一的安全底线 ──
 *
 *   **凡是"事实性陈述"，都必须能回链到 Evidence；
 *     凡是"建议性陈述"，必须显式标注为建议。两者绝不混写。**
 *
 * 具体拆成三条硬规则（每条都有对应的不变量校验）：
 *
 *   1. **不產出没有来源的"研究事实"**。
 *      方向的任何一句描述里，只要叙述的是"论文/领域**是**怎样的"，
 *      就必须能在 evidence_ids 里找到出处。禁止出现
 *      "近年来越来越多工作关注 X"这类我无法核实、也无出处的领域综述句。
 *
 *   2. **每个方向至少关联 1 个 Gap 和 1 条 Evidence**。
 *      方向不是凭空想的，它是"某个已证实的缺口"的延伸。
 *      没有 Gap 就没有方向；Gap 没有证据就不成立（4-6 已保证），所以方向必然有证据。
 *
 *   3. **candidate 依据不得写成事实**。
 *      如果某个方向**只**由 candidate Gap 支撑，它必须整体标记为
 *      `basis_level = 'candidate_only'`，标题带「【推测方向】」前缀，
 *      且描述里明写这是从推断性线索出发的探索，不是对现状的陈述。
 *
 * ── 关于"方法切入点"与"验证实验"从哪来 ──
 *
 * 这两项是最容易被编造的地方（模型很容易写出"采用对比学习提升表征能力"这种
 * 听起来专业、但与本项目语料毫无关系的建议）。本模块的应对是：
 * **把它们约束成"对本项目已有方法/证据的重组"，而不是自由发挥。**
 *
 *   · 方法切入点：只能从**本项目真实存在的方法**里选（`methods` 输入），
 *     并且要说清"拿哪个已有方法、改什么"。方法池为空时，如实降级为
 *     "需要引入新方法"并标注依据不足，而不是编一个方法名。
 *   · 验证实验：只能引用**本项目证据里真实出现的**评测/场景词
 *     （基线、数据集、场景），并给出一个可由这些素材构成的最小实验。
 *     素材不足时如实降级（见 `buildValidation`）。
 *
 * ── 为什么必须是纯函数 ──
 * 与 relevance.ts / methodAlignment.ts / methodEvolution.ts / researchGaps.ts
 * 同一套理由：不读 config、不发请求、不碰文件、不取当前时间。测试可以直接跑它。
 * 需求也明确要求"Mock 使用 deterministic 规则，不调用 LLM"。
 */

import type { StoredEvidence, StoredMethod, StoredPaper } from '../types.ts'
import type { EvolutionRelation } from './methodEvolution.ts'
import type { GapSignalType, ResearchGapFinding } from './researchGaps.ts'

/* ------------------------------------------------------------------ */
/* 依据层级 —— **本模块的分层核心**                                     */
/* ------------------------------------------------------------------ */

/**
 * 一个方向的依据强度。取值比 4-6 的 `GapAssertionLevel` 多一档，因为
 * "由事实支撑"和"由推断支撑"之间还夹着一种真实情况：
 * **两者都用了**（有事实打底，推断补充）。
 *
 *   · `stated_backed`    —— 有 stated Gap 打底。**可以**说"论文指出…"。
 *                          这是唯一可以说事实口吻的层级。
 *   · `mixed`            —— stated 打底 + candidate 补充。事实部分照实说，
 *                          推断部分必须标明是推断。
 *   · `candidate_only`   —— **只**有 candidate 支撑。整条方向都是探索性的，
 *                          必须带「【推测方向】」前缀，不得出现任何事实口吻。
 *
 * ⚠️ 需求原文："stated Gap 作为主要依据，candidate 只能作为参考线索"。
 * 这个三分法就是它的落地形式 —— candidate **永远不能单独构成事实性方向**，
 * 它最多只能（a）补充 stated，或（b）自己撑起一条**明确标为推测**的方向。
 */
export type DirectionBasisLevel = 'stated_backed' | 'mixed' | 'candidate_only'

export const DIRECTION_BASIS_LEVELS: readonly DirectionBasisLevel[] = [
  'stated_backed',
  'mixed',
  'candidate_only',
] as const

export const isDirectionBasisLevel = (v: unknown): v is DirectionBasisLevel =>
  typeof v === 'string' && (DIRECTION_BASIS_LEVELS as readonly string[]).includes(v)

/* ------------------------------------------------------------------ */
/* 输入                                                                */
/* ------------------------------------------------------------------ */

/**
 * 方向生成输入。
 *
 * ── 为什么直接吃 4-6 的 `ResearchGapFinding[]` 而不是自己再判一遍 ──
 *
 * 与 4-4 复用 4-2 的对齐结果是同一个理由：**判定规则只能有一份**。
 * 如果本模块自己重判"什么是 Gap"，就会出现两套口径：
 * 研究空白页显示 5 条 Gap、研究方向页却基于另外 4 条生成方向。
 * 所以这里把 Gap 当作**既有事实**接收（`gaps` 必须是 4-6 的输出），
 * 本模块只负责"从 Gap 到方向"的翻译。
 *
 * `gaps` 里同时含 stated 与 candidate，本模块按 `assertion_level` 分流。
 */
export interface DirectionInput {
  /** 必须是 4-6 `detectGaps()` 的输出，不接受手写的、未经判定的 Gap */
  gaps: ResearchGapFinding[]
  methods: StoredMethod[]
  evidence: StoredEvidence[]
  papers: StoredPaper[]
  /** 4-4 的演进关系。用途见 `addressedMethodKeys()`：避开已被改进的方法 */
  evolutionRelations: EvolutionRelation[]
}

/* ------------------------------------------------------------------ */
/* 判定依据（供复核 / 测试断言）                                        */
/* ------------------------------------------------------------------ */

export type DirectionBasis =
  /** 依据里有论文明确写出的局限 */
  | 'stated_gap_primary'
  /** 依据里含系统推断的候选缺口（只作线索） */
  | 'candidate_gap_secondary'
  /** 仅由候选缺口支撑 —— 整条方向是探索性的 */
  | 'candidate_only_evidence'
  /** 每个方向都至少挂了一条真实证据 */
  | 'evidence_linked'
  /** 关联的 Gap 本身（回链用） */
  | 'linked_to_gap'
  /** 方法切入点来自本项目已有的方法 */
  | 'method_from_corpus'
  /** 本项目没有可用方法，切入点只能是"需要引入" */
  | 'no_corpus_method_available'
  /** 验证方案引用了本项目证据里出现的评测素材 */
  | 'validation_from_corpus'
  /** 评测素材不足，验证方案只是最小可执行建议 */
  | 'validation_minimal_suggestion'
  /** 该方向涉及的缺口已被后续工作改进过（价值降低，但仍保留） */
  | 'gap_addressed_by_later_work'
  /** 方向聚焦的场景主题由 4-6 的确定性词表给出 */
  | 'theme_from_gap'
  /** 方向已去重：与**另一条方向**的证据完全重叠（跨组路径） */
  | 'deduplicated_by_overlap'
  /**
   * 方向由**组内多个同坐标 Gap** 合成（组内路径）。
   *
   * 与 `deduplicated_by_overlap` 分开是有意的：两条路径的语义不同 ——
   *   · 组内：这些 Gap 本来就是同一个语义坐标下的一条证据/多条证据，
   *          合成是**自然聚合**，用户看 gap_ids 就能看到全部出口。
   *   · 跨组：它们本来是两个不同信号的方向，因为证据完全重叠才合并，
   *          属于**副作用**，更需要提醒用户"这里原本有两条"。
   * 用一个取值糊过去会让用户无法区分这两种情况。
   */
  | 'merged_same_coordinate_gaps'

/* ------------------------------------------------------------------ */
/* 输出类型                                                            */
/* ------------------------------------------------------------------ */

/** 建议研究问题。分三档，让用户能一眼看出"这是问题"而不是"这是结论" */
export interface DirectionQuestion {
  /** 一句话研究问题，必须以问号结尾 */
  question: string
  /** 为什么值得研究（必须挂在 Gap 上，不得空谈） */
  rationale: string
  /** 期望产出什么（同样只能是对已有素材的重组） */
  expected_outcome: string
}

/** 方法切入点：**只能**从本项目已有方法里选，或如实声明需引入 */
export interface DirectionApproach {
  /**
   * 切入点类型。
   *   · `extend_existing`  —— 扩展本项目已有的某个方法
   *   · `combine_existing` —— 组合本项目已有的两个方法
   *   · `evaluate_existing`—— 用已有方法做对比/评测（适合 missing_comparison）
   *   · `introduce_new`    —— 本项目没有可用方法，如实降级
   */
  kind: 'extend_existing' | 'combine_existing' | 'evaluate_existing' | 'introduce_new'
  /** 建议的切入点描述（不含任何"事实"口吻） */
  description: string
  /** 引用的**本项目**方法 id（introduce_new 时为空） */
  based_on_method_ids: string[]
  /** 引用的方法名，便于前端直接展示 */
  based_on_method_names: string[]
}

/** 建议验证实验。同样只能引用本项目证据里的素材 */
export interface DirectionValidation {
  /** 实验做什么 */
  experiment: string
  /** 用什么材料（来自本项目语料，或如实声明需补充） */
  materials: string
  /** 怎么算成功 —— 必须是可判定的，不能写"效果更好" */
  success_criteria: string
  /** 验证方案里引用的评测素材是否真的来自本项目证据 */
  from_corpus: boolean
}

export interface ResearchDirectionFinding {
  /** 稳定 id，形如 RD001。同一输入必须产出同一 id */
  direction_id: string
  /**
   * 依据层级 —— **本模块最重要的字段**。
   * 决定标题怎么写、描述能不能用事实口吻。由不变量强制与文案一致。
   */
  basis_level: DirectionBasisLevel
  /**
   * 便捷布尔。恒等于 `basis_level === 'candidate_only'`。
   *
   * 与 4-6 的 `candidate` 字段同一用意：让前端的
   * `d.candidate_only === true` 直接可用，不必解字符串。
   */
  candidate_only: boolean
  /** 方向标题。candidate_only 时必须以「【推测方向】」开头 —— 由不变量强制 */
  title: string
  /** 方向描述。candidate_only 时不得出现事实口吻（由不变量校验） */
  description: string
  /** 场景主题（由 4-6 的确定性词表给出，这里只透传） */
  theme: string
  /**
   * 该方向的**主缺口信号**。
   *
   * 分组键就是 `(signal, theme)`，所以组内所有 Gap 的信号必然相同 ——
   * 把它显式暴露出来，前端不必反查 Gap 就能分类展示，
   * 统计也能直接从方向上算，不必依赖调用方另算一份（避免两套口径）。
   */
  gap_signal: GapSignalType
  /** 支撑该方向的 Gap id，**恒非空**（本模块硬门槛） */
  gap_ids: string[]
  /**
   * 支撑该方向的证据 id，**恒非空**。
   * = 所关联 Gap 的证据之并集，**不引入任何新证据**。
   */
  evidence_ids: string[]
  /** 涉及的论文 id（去重、排序） */
  paper_ids: string[]
  /** 涉及的方法 id（去重、排序） */
  method_ids: string[]
  question: DirectionQuestion
  approach: DirectionApproach
  validation: DirectionValidation
  /** 命中的判定依据，按重要性排序 */
  basis: DirectionBasis[]
  /** 置信度 0-1。stated_backed 基线 0.7，mixed 0.5，candidate_only 0.35 */
  confidence: number
}

/**
 * 统计。**分依据层级分别计数**，不用一个"总数"糊过去。
 *
 * 理由与 4-6 的 GapStats 相同且在这里更极端：
 * `stated_backed`（有事实打底的方向）与 `candidate_only`（纯探索性方向）
 * 对用户的含义天差地别 —— 前者可以说是"文献指出的机会"，
 * 后者只是"我们的猜测"。合并计数会让用户以为有 12 个"机会"，
 * 而其中 9 个其实建立在推断的 Gap 上。
 */
export interface DirectionStats {
  /** 有 stated Gap 打底的方向数（含 mixed） */
  stated_backed: number
  /** stated 打底 + candidate 补充 */
  mixed: number
  /** 仅由 candidate 支撑的方向数 */
  candidate_only: number
  /** = 上面三者之和 */
  total: number
  /** 四类缺口信号各自撑起了多少方向（一个方向可能计入多类） */
  limitation: number
  open_problem: number
  missing_comparison: number
  uncovered_setting: number
  /** 涉及的论文数（去重） */
  papers_involved: number
  /** 涉及的方法数（去重） */
  methods_involved: number
  /** 场景主题数（去重，不含 general） */
  themes: number
  /**
   * 没有 Gap 的方向数 —— **必须恒为 0**。
   * 与 4-6 的 gaps_without_evidence 同一考虑：让硬门槛在**运行时**可见。
   */
  directions_without_gap: number
  /** 没有 Evidence 的方向数 —— **必须恒为 0** */
  directions_without_evidence: number
  /** 方法切入点确实来自本项目已有方法的方向数 */
  with_corpus_approach: number
  /** 验证方案确实引用了本项目评测素材的方向数 */
  with_corpus_validation: number
  /** 被去重合并掉的候选方向数 */
  deduplicated: number
  /** 因输入里没有 Gap 而无法生成（0 条方向是预期结果时的量化指标） */
  gaps_considered: number
}

export interface DirectionOutcome {
  directions: ResearchDirectionFinding[]
  stats: DirectionStats
  context: {
    /** 上游给了几条 Gap */
    gaps_received: number
    /** 其中 stated / candidate 各几条 */
    stated_gaps: number
    candidate_gaps: number
    /** 有多少条 Gap 真正被用进了某个方向（未使用的 Gap 通常是去重时被合并） */
    gaps_used: number
    /** 本项目可用方法数（方法切入点的素材池大小） */
    methods_available: number
    /** 本项目证据里含评测素材的条数（验证方案的素材池大小） */
    evidence_with_eval_material: number
    /** 语料里有没有任何 Gap（false 时 0 条方向是预期结果，不是失败） */
    has_any_gap: boolean
    rule_version: string
  }
  /** 规则集版本，便于溯源。标明是确定性规则，不让人误以为是模型产出 */
  rule_version: string
}

export const DIRECTION_RULE_VERSION = 'deterministic-research-direction-v1'

/* ------------------------------------------------------------------ */
/* 词表                                                                */
/* ------------------------------------------------------------------ */

/**
 * 评测素材词表 —— 验证实验只能引用这里命中的东西。
 *
 * 设计取舍：这里**只做识别，不做生成**。
 * 命中时把原文里那个词抠出来用；不命中就如实降级成"最小可执行建议"。
 * 绝不出现"建议在 GLUE 上评测"这种凭常识补出来的数据集名 ——
 * 用户没法判断那是我从论文里读到的，还是我编的。
 */
const EVAL_MATERIAL_PATTERNS: { kind: string; label: string; re: RegExp }[] = [
  { kind: 'benchmark', label: '评测基准', re: /\b(?:benchmark|bench|suite)\b|基准/i },
  { kind: 'dataset', label: '数据集', re: /\b(?:dataset|corpus|data\s+set)\b|数据集|语料库/i },
  { kind: 'baseline', label: '基线对比', re: /\bbaseline\b|基线|对照组/i },
  { kind: 'human_eval', label: '人工评测', re: /human\s+(?:eval|study|rating)|人工评测|人工评估/i },
  { kind: 'ablation', label: '消融实验', re: /ablation|消融/i },
  { kind: 'real_world', label: '真实场景验证', re: /real[- ]?world|production|deployment|真实场景|生产环境|落地/i },
]

/**
 * 各缺口信号 → 默认的验证取向。
 *
 * 这解决"为什么是这几个方向而不是那几"的问题：验证方案不是随便写的，
 * 它由缺口的**类型**决定 —— 说"缺对比"的缺口，验证取向必然是"补对比"。
 * 这样每个方向的验证都是缺口本身的直接回应，而不是另起一个话题。
 */
const VALIDATION_STANCE: Record<GapSignalType, string> = {
  limitation: '针对该局限构造一个此前失败的条件，验证新方案能否在该条件下成立',
  open_problem: '把原论文承认未解决的问题形式化为可判定任务，给出定量结果',
  missing_comparison: '在同一设定下补齐缺失的对照，给出可比指标',
  uncovered_setting: '把方法迁移到此前未覆盖的场景，报告迁移后的表现与失效边界',
}

/** 该缺口信号是否天然适合"评测类"切入点 */
const EVAL_ORIENTED_SIGNALS = new Set<GapSignalType>(['missing_comparison', 'uncovered_setting'])

/**
 * 事实口吻词表 —— 用于**反向校验** candidate_only 方向的文案。
 *
 * 出现在 candidate_only 方向的描述里，就说明它把推断写成了事实。
 * 这些词都是"在陈述世界的状态"，而不是"在提建议"。
 * 正则刻意做得保守（只匹配明确的断言式措辞），避免误伤建议性表达。
 */
const FACTUAL_ASSERTION_PATTERNS: RegExp[] = [
  /论文\s*\S*\s*(?:明确)?指出/,
  /(?:研究表明|实验表明|结果证明|已被证明|事实表明)/,
  /已有\s*(?:研究|工作|文献)\s*(?:证明|表明|显示)/,
  /界内\s*(?:公认|共识)/,
  /(?:普遍认为|广泛认为|众所周知)/,
]

/**
 * 建议口吻的安全词 —— candidate_only 方向上必须出现其中之一，
 * 否则说明它没有任何"这是建议"的标记。
 */
const SUGGESTION_MARKERS = /建议|可以尝试|可考虑|值得探索|探索|候选/

/* ------------------------------------------------------------------ */
/* 输入索引                                                            */
/* ------------------------------------------------------------------ */

interface Corpus {
  evidenceById: Map<string, StoredEvidence>
  methodById: Map<string, StoredMethod>
  paperById: Map<string, StoredPaper>
  /** 已被后续工作改进过的方法身份键（4-4 的因果边 target 侧） */
  addressedMethodKeys: Set<string>
  /** 方法 key → 方法名，便于把身份键还原成人看的名字 */
  nameByMethodKey: Map<string, string>
}

/**
 * 被后续工作明确改进过的方法。
 *
 * 与 4-6 的 `addressedMethods()` 判据**刻意不同**，这里必须解释清楚：
 *
 *   4-6 用它**降低 Gap 的置信度**（"这个空白已经有人动了，作为空白价值低"）。
 *   4-7 用它**避免推荐重复劳动** —— 如果一条方向要做的正是"改进方法 M"，
 *   而 M 已经被后续论文声称改进过了，那这条方向对用户的价值很低。
 *   所以本模块会把这类方法**排除出方法切入点候选池**，
 *   并在 basis 里留下 `gap_addressed_by_later_work` 痕迹，不是静默丢弃。
 *
 * 只取**因果边**（`causal === true`）。temporal 边只说明"时间上更晚"，
 * 不能推断"改进了它"—— 那正是 4-4 最警惕的事，这里不重犯。
 */
function addressedMethodKeys(relations: EvolutionRelation[]): Set<string> {
  const s = new Set<string>()
  for (const r of relations) {
    if (r.causal) s.add(r.target_method_key)
  }
  return s
}

function buildCorpus(input: DirectionInput): Corpus {
  const evidenceById = new Map(input.evidence.map((e) => [e.evidence_id, e]))
  const methodById = new Map(input.methods.map((m) => [m.method_id, m]))
  const paperById = new Map(input.papers.map((p) => [p.paper_id, p]))
  const nameByMethodKey = new Map<string, string>()
  for (const m of input.methods) {
    for (const pid of m.paper_ids) {
      nameByMethodKey.set(`${pid}::${m.method_id}`, m.name_zh || m.name || m.method_id)
    }
  }
  return {
    evidenceById,
    methodById,
    paperById,
    addressedMethodKeys: addressedMethodKeys(input.evolutionRelations),
    nameByMethodKey,
  }
}

/* ------------------------------------------------------------------ */
/* 素材抽取：方法池 / 评测素材池                                        */
/* ------------------------------------------------------------------ */

/**
 * 从一条 Gap 涉及的证据里，找出真实出现的评测素材。
 *
 * 返回的是**原文里出现过的素材类别**（去重），不是任何具体数据集名。
 * 这一点很关键：我不会写"建议在 SWE-bench 上评测"，因为那需要我知道
 * SWE-bench 出现在哪条证据里 —— 而即使出现了，把"证据提到过某基准"
 * 写成"建议在该基准上评测"仍然需要我判断那个基准合不合适。
 * 只报类别，把这个判断留给用户，是更诚实的做法。
 */
function evalMaterialsOf(evidenceIds: string[], corpus: Corpus): string[] {
  const found = new Set<string>()
  for (const eid of evidenceIds) {
    const ev = corpus.evidenceById.get(eid)
    if (!ev) continue
    const text = `${ev.content} ${ev.translation}`
    for (const m of EVAL_MATERIAL_PATTERNS) {
      if (m.re.test(text)) found.add(m.label)
    }
  }
  /* 按词表定义顺序输出 —— 与输入顺序无关，保证确定性 */
  return EVAL_MATERIAL_PATTERNS.map((m) => m.label).filter((l) => found.has(l))
}

/**
 * 从一条 Gap 涉及的方法里，挑出可用的切入点素材。
 *
 * 排除规则（每条都有理由）：
 *   · 已被后续工作改进过的（见 addressedMethodKeys）—— 避免推荐重复劳动
 *   · 不属于本 Gap 涉及论文的 —— 切入点必须与缺口同源，否则是"另起一个话题"
 *
 * 排序按方法名（内容派生），保证与输入顺序无关。
 */
function approachCandidatesOf(
  methodIds: string[],
  paperIds: string[],
  corpus: Corpus,
): StoredMethod[] {
  const out: StoredMethod[] = []
  const seen = new Set<string>()
  for (const mid of methodIds) {
    const m = corpus.methodById.get(mid)
    if (!m) continue
    /* 排除已被后续工作改进的方法 */
    const isAddressed = m.paper_ids.some((p) => corpus.addressedMethodKeys.has(`${p}::${m.method_id}`))
    if (isAddressed) continue
    /* 切入点必须与缺口同源：方法所属论文要落在缺口涉及的论文里 */
    const overlaps = m.paper_ids.some((p) => paperIds.includes(p))
    if (!overlaps) continue
    /* 去重：同号方法可能跨论文出现 */
    const key = `${m.name}|${m.task}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m)
  }
  out.sort((a, b) => cmp(a.name, b.name) || cmp(a.method_id, b.method_id))
  return out
}

/* ------------------------------------------------------------------ */
/* 方向构造：三个组成部分各自独立生成                                    */
/* ------------------------------------------------------------------ */

/**
 * 生成研究问题。
 *
 * 文案策略：问题必须**直接由缺口导出**，而不是自创一个宏大命题。
 * 句式的骨架固定为「如何 {缺口所描述的事} 的同时 {补足缺口要求的性质}」，
 * 变化的只是缺口本身的措辞 —— 这样每个问题都能被读者一眼追回到它的 Gap。
 */
function buildQuestion(
  signal: GapSignalType,
  themeLabel: string,
  hasStated: boolean,
): DirectionQuestion {
  /*
   * ⚠️ 整个函数**不引用任何具体论文名或方法名**。
   *
   * 这是刻意的：一旦问题句里出现"ReAct 无法处理长程任务"，
   * 它就从"问题"变成了"对某篇论文的事实断言"，而 candidate_only 方向上
   * 那句断言是没有事实支撑的。把主语抽象成场景与缺口类型，
   * 问题就永远只是问题。
   */
  const scope = themeLabel

  const bySignal: Record<GapSignalType, DirectionQuestion> = {
    limitation: {
      question: `如何在${scope}中突破当前方法已知的能力上限？`,
      rationale: hasStated
        ? `该问题直接来自论文自己承认的局限：在${scope}这一设定下，现有做法存在明确的失效边界。`
        : `该问题来自系统对多条证据的归纳：在${scope}这一设定下，多条证据共同指向同一类能力边界（此为推断性线索，需先核实）。`,
      expected_outcome: `给出一个在${scope}下可运行的做法，并说明它在什么条件下仍然失效。`,
    },
    open_problem: {
      question: `如何把${scope}中被列为未解决的问题转化为可定量验证的任务？`,
      rationale: hasStated
        ? `该问题来自论文明确标注为尚未解决的方向，说明其可行性已被原作者认可，但尚无定论。`
        : `多条证据显示${scope}反复被当成悬置问题处理（此为推断性线索），值得判断它是否真的未被解决。`,
      expected_outcome: `给出该问题的形式化定义与一组可比指标。`,
    },
    missing_comparison: {
      question: `在${scope}下，如何建立一套可比的口径来衡量不同做法的差异？`,
      rationale: hasStated
        ? `论文自己指出缺少对照，意味着即便做出改进也无法判断是否真的更好；补齐口径是后续一切工作的前提。`
        : `多条证据共同反映${scope}缺少统一比较口径（此为推断性线索），需先确认缺失范围。`,
      expected_outcome: `给出在该设定下可复现的对照方案与判定标准。`,
    },
    uncovered_setting: {
      question: `把现有做法迁移到${scope}时，会在哪些环节失效，如何补足？`,
      rationale: hasStated
        ? `论文明确说明自身方法尚未在该场景验证，这正是"已知未知"——风险已被原作者点出，是最值得优先填补的一类。`
        : `多条证据共同显示${scope}缺乏验证（此为推断性线索），需先确认该场景是否真的未被覆盖。`,
      expected_outcome: `报告迁移后的表现，并划出该场景下的失效边界。`,
    },
  }

  return bySignal[signal]
}

/**
 * 生成方法切入点。
 *
 * ── 这是最容易被编造的一环，所以约束最硬 ──
 *
 * 候选池**只能**来自本项目 `methods` 输入（见 approachCandidatesOf）。
 * 池子空了就如实降级成 `introduce_new` 并说明"本语料没有可复用的方法"，
 * **绝不**编一个方法名出来。
 *
 * 四种 kind 的选择规则（全部只看输入，不看任何先验知识）：
 *   · 缺口是"缺对比/未覆盖场景" → `evaluate_existing`（这类缺口本质是评测问题）
 *   · 候选方法 ≥2 → `combine_existing`（有组合的余地）
 *   · 候选方法 =1 → `extend_existing`
 *   · 候选方法 =0 → `introduce_new`
 */
function buildApproach(
  signal: GapSignalType,
  candidates: StoredMethod[],
  themeLabel: string,
): { approach: DirectionApproach; basis: DirectionBasis[] } {
  if (!candidates.length) {
    return {
      approach: {
        kind: 'introduce_new',
        description:
          `本语料中没有与本缺口同源、且尚未被后续工作改进过的方法可供复用，` +
          `因此该方向需要引入新的做法，或在补充相关论文后重新评估已有方法。`,
        based_on_method_ids: [],
        based_on_method_names: [],
      },
      basis: ['no_corpus_method_available'],
    }
  }

  const names = candidates.map((m) => m.name_zh || m.name || m.method_id)
  const ids = candidates.map((m) => m.method_id)

  if (EVAL_ORIENTED_SIGNALS.has(signal)) {
    return {
      approach: {
        kind: 'evaluate_existing',
        description:
          `以本项目已有的 ${names.join('、')} 作为被测对象，在${themeLabel}设定下` +
          `补齐缺失的对照与场景覆盖；重点不是提出新方法，而是把比较口径做实。`,
        based_on_method_ids: ids,
        based_on_method_names: names,
      },
      basis: ['method_from_corpus'],
    }
  }

  if (candidates.length >= 2) {
    return {
      approach: {
        kind: 'combine_existing',
        description:
          `以本项目已有的 ${names.join('、')} 为起点，尝试组合两者的互补部分来突破该局限：` +
          `先分别定位各自在${themeLabel}下的失效环节，再判断哪些环节可以由另一方补足。`,
        based_on_method_ids: ids,
        based_on_method_names: names,
      },
      basis: ['method_from_corpus'],
    }
  }

  return {
    approach: {
      kind: 'extend_existing',
      description:
        `以本项目已有的 ${names[0]} 为起点做定向扩展：保留其主体结构，` +
        `只针对${themeLabel}这一失效环节做修改，以便把改进幅度归因到单点改动上。`,
      based_on_method_ids: ids,
      based_on_method_names: names,
    },
    basis: ['method_from_corpus'],
  }
}

/**
 * 生成验证实验。
 *
 * ── 依赖真实素材，而不是凭常识补数据集名 ──
 *
 * `materials` 只在**证据原文确实提到**评测素材时才具体（且只报类别，
 * 不报具体数据集名 —— 见 evalMaterialsOf 注释）。否则如实写
 * "需补充评测素材"，并在 basis 里标 `validation_minimal_suggestion`。
 *
 * `success_criteria` 一律要求可判定，禁止出现"效果更好"这种无法证伪的表述。
 */
function buildValidation(
  signal: GapSignalType,
  materials: string[],
  themeLabel: string,
): { validation: DirectionValidation; basis: DirectionBasis[] } {
  const stance = VALIDATION_STANCE[signal]
  const fromCorpus = materials.length > 0

  if (fromCorpus) {
    return {
      validation: {
        experiment: `${stance}。在${themeLabel}设定下先复现原有失败条件，再施加改动并重复同一条件。`,
        materials: `本项目证据中已出现的评测素材：${materials.join('、')}。可直接以这些素材为起点组织实验。`,
        success_criteria:
          `在复现的失败条件上取得可测得的改善，且在其他条件下不出现下降；` +
          `两个结果都需要给出具体数值，不接受定性描述。`,
        from_corpus: true,
      },
      basis: ['validation_from_corpus'],
    }
  }

  return {
    validation: {
      experiment: `${stance}。在${themeLabel}设定下构造一个最小可运行实验。`,
      materials:
        `本项目证据中未出现可复用的评测素材（基准 / 数据集 / 基线 / 人工评测 / 消融 / 真实场景），` +
        `因此实验材料需要另行补充，本方向暂不指定具体数据集。`,
      success_criteria:
        `需要先确定一个可量化的判定指标；在指标确定前，本方向不具备可验证性，` +
        `建议先补齐评测素材再投入。`,
      from_corpus: false,
    },
    basis: ['validation_minimal_suggestion'],
  }
}

/* ------------------------------------------------------------------ */
/* 主函数                                                              */
/* ------------------------------------------------------------------ */

/** 依据层级 → 置信度基线。stated 打底最可信，纯推断最弱 */
const LEVEL_CONFIDENCE: Record<DirectionBasisLevel, number> = {
  stated_backed: 0.7,
  mixed: 0.5,
  candidate_only: 0.35,
}

const LEVEL_RANK: Record<DirectionBasisLevel, number> = {
  stated_backed: 0,
  mixed: 1,
  candidate_only: 2,
}

/** 信号强度排序，用于同层级内排序（与 4-6 的 SIGNAL_RANK 保持一致口径） */
const SIGNAL_RANK: Record<GapSignalType, number> = {
  limitation: 0,
  open_problem: 1,
  missing_comparison: 2,
  uncovered_setting: 3,
}

/** 信号 → 中文（与 4-6 的 SIGNAL_LABEL 同口径，便于跨页对照） */
const SIGNAL_LABEL: Record<GapSignalType, string> = {
  limitation: '原文指出的局限',
  open_problem: '原文指出的未解决问题',
  missing_comparison: '原文指出的缺失比较',
  uncovered_setting: '原文指出的未覆盖场景',
}

/* 场景主题中文名。与 4-6 的 THEME_PATTERNS 标签对齐；未命中时退回原值 */
const THEME_LABEL_FALLBACK: Record<string, string> = {
  long_horizon: '长周期 / 多步任务',
  repository_level: '仓库级代码修改',
  multi_agent: '多 Agent 协作',
  memory_context: '记忆与上下文管理',
  tool_use: '工具调用',
  search_planning: '搜索与规划',
  evaluation_bench: '评测与基准',
  cost_efficiency: '成本与效率',
  safety_security: '安全与可靠性',
  feedback_signal: '反馈信号质量',
  generalization: '泛化能力',
  general: '通用场景',
}

const themeLabelOf = (t: string): string => THEME_LABEL_FALLBACK[t] ?? t

/**
 * 从 Gap 集合生成研究方向。
 *
 * ── 五步 ──
 *   ① 分流 + 过滤：把 Gap 按 stated / candidate 分开，并校验其证据可用
 *   ② 按"语义坐标"分组：同一 (signal, theme) 的 Gap 合成一个方向素材
 *   ③ 逐组构造方向：问题 / 切入点 / 验证 三部分各自独立生成
 *   ④ 排序 → 编号：全部排序键由内容派生，与输入顺序无关
 *   ⑤ 统计 + 组装
 *
 * ── 为什么按 (signal, theme) 分组而不是一个 Gap 一个方向 ──
 *
 * 4-6 的 stated 层是"一条证据一条 Gap"，粒度很细。
 * 如果 4-7 也一 Gap 一方向，三篇论文各说一句"没在长程任务上验证"
 * 就会产出三条几乎一样的方向 —— 用户看到的是重复噪声，不是三个机会。
 *
 * 所以这里把**同一语义坐标**的 Gap 合成一个方向（并在 gap_ids 里
 * 保留全部来源，让用户能点开看到每一条原始出口）。
 * 这与 4-6 内部"stated 逐条保留 + candidate 聚簇"是同一套思路的上一层：
 * 逐条保留是为了可溯源，聚合是为了可用。
 */
export function generateDirections(input: DirectionInput): DirectionOutcome {
  /* evolutionRelations 经由 buildCorpus(input) 消费，无需在此解构 */
  const { gaps, methods, evidence } = input
  const corpus = buildCorpus(input)

  const statedGaps = gaps.filter((g) => g.assertion_level === 'stated')
  const candidateGaps = gaps.filter((g) => g.assertion_level === 'candidate')

  /* ── ① 过滤：Gap 的证据必须真实存在 ── */

  let evidenceMissing = 0
  const usableGaps: ResearchGapFinding[] = []
  for (const g of gaps) {
    if (!g.evidence_ids || g.evidence_ids.length === 0) {
      evidenceMissing++
      continue
    }
    /* 只保留证据真实存在于本项目语料里的 Gap —— 防上游数据不一致 */
    const present = g.evidence_ids.filter((eid) => corpus.evidenceById.has(eid))
    if (present.length === 0) {
      evidenceMissing++
      continue
    }
    usableGaps.push({ ...g, evidence_ids: present })
  }

  /* ── ② 按语义坐标分组 ── */

  interface Group {
    signal: GapSignalType
    theme: string
    gaps: ResearchGapFinding[]
  }

  const groups = new Map<string, Group>()
  for (const g of usableGaps) {
    const key = `${g.gap_signal}::${g.theme}`
    const hit = groups.get(key)
    if (hit) hit.gaps.push(g)
    else groups.set(key, { signal: g.gap_signal, theme: g.theme, gaps: [g] })
  }

  /* ── ③ 逐组构造方向 ── */

  const drafts: ResearchDirectionFinding[] = []
  /*
   * 被合并掉的方向数。
   *
   * ⚠️ 这个计数必须覆盖**两条**合并路径，否则它会系统性低估：
   *
   *   路径 A（组内）：同 (signal, theme) 的多个 Gap 在步骤 ② 就落进同一个组，
   *                   一次构造成一条方向。N 个 Gap → 1 条方向，少掉 N-1 条。
   *   路径 B（跨组）：不同 signal 但主题与证据完全相同的两条草稿，
   *                   在步骤 ③b 被去重合并，少掉 1 条。
   *
   * 最初只数了路径 B，结果"两个同信号同主题的 Gap 合成一条"这件事
   * 完全没有体现 —— 统计里 deduplicated=0，而用户看到的 Gap 数是 2、方向数是 1。
   * 那个差值需要一个解释，否则用户会以为方向漏了一条。
   * 所以下面在路径 A 上也累加 `group.gaps.length - 1`。
   */
  let deduplicated = 0

  for (const [, group] of groups) {
    /* 路径 A：组内有 N 个 Gap 时，N-1 条在合成中被合并 */
    deduplicated += Math.max(0, group.gaps.length - 1)

    /* 组内排序：内容派生，与输入顺序无关 */
    group.gaps.sort(
      (a, b) =>
        LEVEL_RANK[a.assertion_level] - LEVEL_RANK[b.assertion_level] ||
        cmp(a.gap_id, b.gap_id),
    )

    const groupStated = group.gaps.filter((g) => g.assertion_level === 'stated')
    const groupCandidate = group.gaps.filter((g) => g.assertion_level === 'candidate')
    const hasStated = groupStated.length > 0
    const hasCandidate = groupCandidate.length > 0

    /*
     * 依据层级判定 —— 需求"stated 为主、candidate 仅作线索"的落点。
     * 三种情况，没有第四种。
     */
    const basisLevel: DirectionBasisLevel = hasStated
      ? hasCandidate
        ? 'mixed'
        : 'stated_backed'
      : 'candidate_only'

    /* 证据 = 所关联 Gap 的证据之并集。**不引入任何新证据** */
    const evidenceIds = [...new Set(group.gaps.flatMap((g) => g.evidence_ids))].sort()
    if (!evidenceIds.length) continue // 双保险：前面已过滤，这里再挡一次

    const paperIds = [...new Set(group.gaps.flatMap((g) => g.paper_ids))].sort()
    const methodIds = [...new Set(group.gaps.flatMap((g) => g.method_ids))].sort()
    const theme = group.theme
    const themeLabel = themeLabelOf(theme)

    /* 三部分各自生成 */
    const question = buildQuestion(group.signal, themeLabel, hasStated)
    const candidates = approachCandidatesOf(methodIds, paperIds, corpus)
    const { approach, basis: approachBasis } = buildApproach(group.signal, candidates, themeLabel)
    const materials = evalMaterialsOf(evidenceIds, corpus)
    const { validation, basis: validationBasis } = buildValidation(
      group.signal,
      materials,
      themeLabel,
    )

    /* 置信度：层级基线 + 组内证据量的小幅加成，且 candidate_only 封顶 0.5 */
    const base = LEVEL_CONFIDENCE[basisLevel]
    const boost = Math.min(0.1, 0.02 * (evidenceIds.length - 1) + 0.02 * (paperIds.length - 1))
    let confidence = base + boost
    /* 客观事实：证据本身抽取置信度应当传递下来 */
    const meanEvConf =
      evidenceIds.reduce((s, eid) => s + (corpus.evidenceById.get(eid)?.confidence ?? 1), 0) /
      Math.max(1, evidenceIds.length)
    confidence *= 0.6 + Math.max(0, Math.min(1, meanEvConf)) * 0.4
    /*
     * candidate_only 硬性封顶 0.5。
     * 与 4-6 给 candidate 置信度封顶 0.69 是同一个理由：
     * 数字上也要体现"推断弱于事实"，否则前端按置信度排序时推断会盖过事实。
     */
    const cap = basisLevel === 'candidate_only' ? 0.5 : 0.99
    confidence = Math.max(0.05, Math.min(cap, Number(confidence.toFixed(4))))

    /* 文案分层 —— "不把 candidate 写成事实"的最终落点 */
    const signalLabel = SIGNAL_LABEL[group.signal]
    const title =
      basisLevel === 'candidate_only'
        ? `【推测方向】${themeLabel}：${signalLabel}（探索性）`
        : `${themeLabel}：${signalLabel}的推进方向`

    const description =
      basisLevel === 'stated_backed'
        ? `依据 ${groupStated.length} 条论文明确指出的缺口（${groupStated.map((g) => g.gap_id).join('、')}）提出。` +
          `这些缺口能追溯到具体论文原文，可直接作为立项依据。`
        : basisLevel === 'mixed'
          ? `依据 ${groupStated.length} 条论文明确指出的缺口（${groupStated.map((g) => g.gap_id).join('、')}）` +
            `，并参考 ${groupCandidate.length} 条系统推断的候选线索（${groupCandidate.map((g) => g.gap_id).join('、')}）。` +
            `前者的原文出处可直接引用；后者是**推断**，仅用于补充视角，不构成事实依据。`
          : `本方向**仅**由系统推断的候选线索（${groupCandidate.map((g) => g.gap_id).join('、')}）支撑。` +
            `这些线索是系统从多条证据归纳出的模式，**不是任何论文的原话**。` +
            `因此本方向属于探索性建议：建议先核实上述线索是否成立，再决定是否投入。`;

    const basis: DirectionBasis[] = []
    /* 组内合并留痕：N 个同坐标 Gap 合成一条方向时必须说明 */
    if (group.gaps.length > 1) basis.push('merged_same_coordinate_gaps')
    if (hasStated) basis.push('stated_gap_primary')
    if (hasCandidate && hasStated) basis.push('candidate_gap_secondary')
    if (basisLevel === 'candidate_only') basis.push('candidate_only_evidence')
    basis.push('evidence_linked', 'linked_to_gap', 'theme_from_gap')
    basis.push(...approachBasis, ...validationBasis)
    /* 若组内任一 Gap 涉及"已被后续工作改进"，如实留痕（不静默） */
    if (group.gaps.some((g) => g.basis.includes('addressed_by_later_work'))) {
      basis.push('gap_addressed_by_later_work')
    }

    drafts.push({
      direction_id: '',
      basis_level: basisLevel,
      candidate_only: basisLevel === 'candidate_only',
      title,
      description,
      theme,
      gap_signal: group.signal,
      gap_ids: group.gaps.map((g) => g.gap_id).sort(),
      evidence_ids: evidenceIds,
      paper_ids: paperIds,
      method_ids: methodIds,
      question,
      approach,
      validation,
      basis,
      confidence,
    })
  }

  /* ── ③b 跨组去重 ── */

  /*
   * 为什么还要跨组去重：不同信号可能落在同一主题上
   * （"没在长程任务上验证"= uncovered_setting 与"长程任务上表现差"= limitation
   *   会落成两个组，但它们对用户其实是同一件事的两面）。
   *
   * 去重键 = 主题 + 证据集合。证据完全重叠时保留**依据更强**的那条，
   * 并把弱的那条的 gap_ids 合并进来（保证没有 Gap 被无声吞掉）。
   *
   * 只按证据集合判重而不是按主题判重，是因为同一主题下证据不同的方向
   * 确实是两个不同的问题（不同论文的不同缺口），不该合并。
   */
  const byKey = new Map<string, ResearchDirectionFinding>()
  const out: ResearchDirectionFinding[] = []

  for (const d of [...drafts].sort((a, b) => cmp(a.title, b.title))) {
    const key = `${d.theme}::${d.evidence_ids.join(',')}`
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, d)
      out.push(d)
      continue
    }
    /* 合并：保留依据更强的，gap_ids 取并集 */
    const stronger =
      LEVEL_RANK[d.basis_level] < LEVEL_RANK[prev.basis_level] ? d : prev
    const mergedGapIds = [...new Set([...prev.gap_ids, ...d.gap_ids])].sort()
    stronger.gap_ids = mergedGapIds
    if (!stronger.basis.includes('deduplicated_by_overlap')) {
      stronger.basis.push('deduplicated_by_overlap')
    }
    deduplicated++
    if (stronger === d) {
      /* 新来的更强：替换掉旧的那条（位置保持，由后面统一排序，不影响） */
      const idx = out.indexOf(prev)
      if (idx >= 0) out[idx] = d
      byKey.set(key, d)
    }
  }

  /* ── ④ 排序 → 编号 ── */

  /*
   * 排序键全部由**内容**算出，禁止依赖发现顺序。
   *
   * 顺序意图（重要性从高到低）：
   *   1. 依据层级：stated_backed > mixed > candidate_only —— 事实优先于推断
   *   2. 信号强度：limitation > open_problem > missing_comparison > uncovered_setting
   *   3. 置信度降序
   *   4. 证据数降序（证据越多越值得关注）
   */
  out.sort(
    (a, b) =>
      LEVEL_RANK[a.basis_level] - LEVEL_RANK[b.basis_level] ||
      SIGNAL_RANK[a.gap_signal] - SIGNAL_RANK[b.gap_signal] ||
      b.confidence - a.confidence ||
      b.evidence_ids.length - a.evidence_ids.length ||
      cmp(a.theme, b.theme) ||
      cmp(a.evidence_ids.join(','), b.evidence_ids.join(',')),
  )

  out.forEach((d, i) => {
    d.direction_id = `RD${String(i + 1).padStart(3, '0')}`
  })

  /* ── ⑤ 统计 + 组装 ── */

  const usedGapIds = new Set(out.flatMap((d) => d.gap_ids))
  const stats = summarizeDirections(out, {
    deduplicated,
    gapsConsidered: gaps.length,
  })

  return {
    directions: out,
    stats,
    context: {
      gaps_received: gaps.length,
      stated_gaps: statedGaps.length,
      candidate_gaps: candidateGaps.length,
      gaps_used: usedGapIds.size,
      methods_available: methods.length,
      evidence_with_eval_material: evidence.filter((e) =>
        EVAL_MATERIAL_PATTERNS.some((m) => m.re.test(`${e.content} ${e.translation}`)),
      ).length,
      has_any_gap: gaps.length > 0,
      rule_version: DIRECTION_RULE_VERSION,
    },
    rule_version: DIRECTION_RULE_VERSION,
  }
}

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)

/* ------------------------------------------------------------------ */
/* 统计 + 不变量                                                        */
/* ------------------------------------------------------------------ */

/**
 * 统计各字段。
 *
 * ⚠️ 与 4-6 的 summarizeGaps 同一教训：**必须只有一份实现**，
 * 且 `generateDirections` 与测试都调它。两份实现迟早漂移。
 */
export function summarizeDirections(
  directions: ResearchDirectionFinding[],
  extra: { deduplicated?: number; gapsConsidered?: number } = {},
): DirectionStats {
  const count = (fn: (d: ResearchDirectionFinding) => boolean) => directions.filter(fn).length
  return {
    stated_backed: count((d) => d.basis_level === 'stated_backed'),
    mixed: count((d) => d.basis_level === 'mixed'),
    candidate_only: count((d) => d.basis_level === 'candidate_only'),
    total: directions.length,
    limitation: count((d) => d.gap_signal === 'limitation'),
    open_problem: count((d) => d.gap_signal === 'open_problem'),
    missing_comparison: count((d) => d.gap_signal === 'missing_comparison'),
    uncovered_setting: count((d) => d.gap_signal === 'uncovered_setting'),
    papers_involved: new Set(directions.flatMap((d) => d.paper_ids)).size,
    methods_involved: new Set(directions.flatMap((d) => d.method_ids)).size,
    themes: new Set(directions.map((d) => d.theme).filter((t) => t !== 'general')).size,
    directions_without_gap: count((d) => d.gap_ids.length === 0),
    directions_without_evidence: count((d) => d.evidence_ids.length === 0),
    with_corpus_approach: count((d) => d.basis.includes('method_from_corpus')),
    with_corpus_validation: count((d) => d.basis.includes('validation_from_corpus')),
    deduplicated: extra.deduplicated ?? 0,
    gaps_considered: extra.gapsConsidered ?? 0,
  }
}

/**
 * 校验输出不变量，返回被违反项的说明列表（空数组 = 全部通过）。
 *
 * 导出给测试直接调用 —— 这样"不变量"不是散落在测试里的 if，
 * 而是一份可复用的契约，服务端与测试用同一份判断。
 */
export function assertDirectionInvariants(
  outcome: DirectionOutcome,
  input?: DirectionInput,
): string[] {
  const bad: string[] = []
  const gapById = new Map((input?.gaps ?? []).map((g) => [g.gap_id, g]))
  const evById = new Map((input?.evidence ?? []).map((e) => [e.evidence_id, e]))

  for (const d of outcome.directions) {
    /* 1. 每个方向必须至少关联 1 个 Gap —— 本模块的硬门槛 */
    if (!d.gap_ids.length) {
      bad.push(`${d.direction_id}: 没有关联任何 Gap（本模块禁止产出无来源的方向）`)
    }

    /* 2. 每个方向必须至少 1 条 Evidence —— 需求明确要求 */
    if (!d.evidence_ids.length) {
      bad.push(`${d.direction_id}: 没有关联任何 Evidence`)
    }

    /* 3. candidate_only 布尔必须与 basis_level 一致 */
    const expected = d.basis_level === 'candidate_only'
    if (d.candidate_only !== expected) {
      bad.push(
        `${d.direction_id}: candidate_only=${d.candidate_only} 与 basis_level=${d.basis_level} 不一致`,
      )
    }

    /* 4. 依据层级必须合法 */
    if (!isDirectionBasisLevel(d.basis_level)) {
      bad.push(`${d.direction_id}: 非法的 basis_level=${String(d.basis_level)}`)
    }

    /*
     * 5. **推断型不得写成事实** —— 需求核心要求，落成可校验的形式。
     *
     * candidate_only 必须：标题带【推测方向】前缀 + 描述里出现探索/推断类措辞。
     * 与前缀一起构成"视觉上无法误读"的保证。
     */
    if (d.candidate_only) {
      if (!d.title.startsWith('【推测方向】')) {
        bad.push(`${d.direction_id}: candidate_only 的标题缺少「【推测方向】」前缀`)
      }
      if (!SUGGESTION_MARKERS.test(d.description)) {
        bad.push(`${d.direction_id}: candidate_only 的描述没有声明其为探索性建议`)
      }
      /*
       * 6. **反向校验**：candidate_only 的描述里不得出现事实口吻。
       *    这是"不产生没有来源的研究事实"在文案层的直接检查。
       */
      for (const re of FACTUAL_ASSERTION_PATTERNS) {
        if (re.test(d.description)) {
          bad.push(
            `${d.direction_id}: candidate_only 的描述出现事实口吻（匹配 ${re}），会把推断写成既有结论`,
          )
        }
      }
    }

    /* 7. 非 candidate_only 不得自称推测 */
    if (!d.candidate_only && d.title.startsWith('【推测方向】')) {
      bad.push(`${d.direction_id}: 非 candidate_only 却带「【推测方向】」前缀，标记与文案矛盾`)
    }

    /* 8. 回链正确性：gap_ids 必须真的存在于输入里 */
    for (const gid of d.gap_ids) {
      if (gapById.size && !gapById.has(gid)) {
        bad.push(`${d.direction_id}: 引用了不存在的 Gap ${gid}`)
      }
    }

    /*
     * 9. **证据不得凭空引入** —— 方向的证据必须全部来自它所关联的 Gap。
     *    这条防的是"为了让方向看起来更有依据，另外挂几条不相关证据"。
     */
    if (gapById.size) {
      const allowed = new Set(d.gap_ids.flatMap((gid) => gapById.get(gid)?.evidence_ids ?? []))
      for (const eid of d.evidence_ids) {
        if (!allowed.has(eid)) {
          bad.push(`${d.direction_id}: 证据 ${eid} 不在所关联 Gap 的证据里（凭空引入）`)
        }
      }
    }

    /* 10. 证据必须真实存在于语料 */
    if (evById.size) {
      for (const eid of d.evidence_ids) {
        if (!evById.has(eid)) bad.push(`${d.direction_id}: 引用了不存在的证据 ${eid}`)
      }
    }

    /* 11. 方法切入点的 based_on_method_ids 必须来自本项目 */
    if (input) {
      const known = new Set(input.methods.map((m) => m.method_id))
      for (const mid of d.approach.based_on_method_ids) {
        if (!known.has(mid)) {
          bad.push(`${d.direction_id}: 方法切入点引用了不存在的方法 ${mid}（凭空引入）`)
        }
      }
      /* introduce_new 必须没有绑定方法，否则语义矛盾 */
      if (d.approach.kind === 'introduce_new' && d.approach.based_on_method_ids.length > 0) {
        bad.push(`${d.direction_id}: kind=introduce_new 却绑定了方法`)
      }
      if (d.approach.kind !== 'introduce_new' && d.approach.based_on_method_ids.length === 0) {
        bad.push(`${d.direction_id}: kind=${d.approach.kind} 却没有绑定任何本项目方法`)
      }
    }

    /* 12. 研究问题必须以问号结尾（它是问题，不是结论） */
    if (!/[？?]$/.test(d.question.question.trim())) {
      bad.push(`${d.direction_id}: question 未以问号结尾：${d.question.question}`)
    }

    /* 13. 去重 */
    if (new Set(d.paper_ids).size !== d.paper_ids.length) {
      bad.push(`${d.direction_id}: paper_ids 存在重复`)
    }
    if (new Set(d.evidence_ids).size !== d.evidence_ids.length) {
      bad.push(`${d.direction_id}: evidence_ids 存在重复`)
    }
    if (new Set(d.gap_ids).size !== d.gap_ids.length) {
      bad.push(`${d.direction_id}: gap_ids 存在重复`)
    }

    /* 14. 置信度区间 + candidate_only 封顶 */
    if (!(d.confidence > 0 && d.confidence <= 1)) {
      bad.push(`${d.direction_id}: confidence=${d.confidence} 超出 (0,1]`)
    }
    if (d.candidate_only && d.confidence > 0.5) {
      bad.push(`${d.direction_id}: candidate_only 的置信度 ${d.confidence} 超过上限 0.5`)
    }
  }

  /* 15. direction_id 唯一且与排序位置一致 */
  const ids = outcome.directions.map((d) => d.direction_id)
  if (ids.length !== new Set(ids).size) bad.push(`direction_id 存在重复：${ids.join(',')}`)
  outcome.directions.forEach((d, i) => {
    const expected = `RD${String(i + 1).padStart(3, '0')}`
    if (d.direction_id !== expected) {
      bad.push(`direction_id 与排序位置不一致：第 ${i + 1} 条是 ${d.direction_id}，应为 ${expected}`)
    }
  })

  /* 16. 统计自洽 */
  const s = outcome.stats
  if (s.total !== outcome.directions.length) {
    bad.push(`stats.total=${s.total} 与 directions.length=${outcome.directions.length} 不一致`)
  }
  if (s.stated_backed + s.mixed + s.candidate_only !== s.total) {
    bad.push(`三个依据层级计数之和 ${s.stated_backed}+${s.mixed}+${s.candidate_only} ≠ total ${s.total}`)
  }
  if (s.directions_without_gap !== 0) {
    bad.push(`stats.directions_without_gap=${s.directions_without_gap}，必须为 0`)
  }
  if (s.directions_without_evidence !== 0) {
    bad.push(`stats.directions_without_evidence=${s.directions_without_evidence}，必须为 0`)
  }
  if (s.limitation + s.open_problem + s.missing_comparison + s.uncovered_setting !== s.total) {
    bad.push(
      `四类信号计数之和 ${s.limitation}+${s.open_problem}+${s.missing_comparison}+${s.uncovered_setting} ≠ total ${s.total}`,
    )
  }

  /* 17. 方向数不得超过 Gap 数（一个 Gap 至多撑起一条方向） */
  if (input && outcome.directions.length > input.gaps.length + 1) {
    bad.push(
      `方向数 ${outcome.directions.length} 异常多于 Gap 数 ${input.gaps.length}（一个 Gap 至多撑一条方向）`,
    )
  }

  return bad
}

/** 信号中文名，供上层复用（与 4-6 口径一致） */
export const directionSignalLabel = (s: GapSignalType): string => SIGNAL_LABEL[s]
/** 主题中文名 */
export const directionThemeLabel = (t: string): string => themeLabelOf(t)
