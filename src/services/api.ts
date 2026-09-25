/**
 * 服务端 API 客户端 —— 浏览器与 Node 服务之间的唯一边界。
 *
 * 安全约束（第 5 节，硬性）：
 *   这个文件里**不允许**出现任何密钥，也不允许出现 import.meta.env.*_API_KEY。
 *   浏览器能拿到的只有 /api/config 返回的白名单字段（provider 名字、模型名、
 *   是否可用）。真实调用永远发生在服务端。
 *
 * 这样做的可验证性：构建产物里搜不到 sk-* 形态的字符串，
 * scripts/e2e.mjs 的 [9] 一节会真的去 dist/ 里搜一遍。
 */

import { previewPrefix } from './locationBase'

/**
 * 显式配置的 API 地址（部署时用 VITE_API_BASE 指到独立的后端域名）。
 * 未配置时为空串，走"同源 + 反代前缀"逻辑（见 request 内的 base 计算）。
 */
const CONFIGURED_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

/* ------------------------------------------------------------------ */
/* 统一响应                                                            */
/* ------------------------------------------------------------------ */

export interface ApiError {
  code: string
  message: string
  detail?: unknown
}

export class ApiCallError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ApiCallError'
    this.code = code
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 反代前缀：页面挂在子路径下时（如 /sandbox-preview/45:/），
  // API 请求必须带上同一段前缀，否则会被浏览器解析到代理根，
  // 代理不认识裸的 /api/... → 全部 404 → 页面壳渲染正常但数据全空。
  // 直接访问（无前缀）时 previewPrefix() 为空串，行为与原来完全一致。
  const base = CONFIGURED_BASE || previewPrefix()
  let res: Response
  try {
    res = await fetch(`${base}${path}`, init)
  } catch (e) {
    // 网络层失败：服务端没起来是最常见的原因，直接说清楚
    throw new ApiCallError(
      'NETWORK',
      `无法连接分析服务（${base || '同源'}）。请确认服务端已启动：pnpm server`,
      0,
    )
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // 非 JSON 响应（比如反向代理返回了 HTML 错误页）
    throw new ApiCallError('BAD_RESPONSE', `服务端返回了非 JSON 响应（HTTP ${res.status}）`, res.status)
  }

  const obj = body as { success?: boolean; data?: T; error?: ApiError }
  if (!res.ok || obj?.success === false) {
    const code = obj?.error?.code ?? `HTTP_${res.status}`
    const message = obj?.error?.message ?? `请求失败（HTTP ${res.status}）`
    throw new ApiCallError(code, message, res.status)
  }
  return obj.data as T
}

/* ------------------------------------------------------------------ */
/* 类型（与服务端 server/types.ts 对齐）                                */
/* ------------------------------------------------------------------ */

export type SourceType = 'demo' | 'uploaded' | 'ai_generated'

export interface ServerParsedSection {
  name: string
  page: number
  pages: number[]
  content: string
  summary: string
}

export interface ServerPaper {
  paper_id: string
  project_id: string
  file_name: string
  file_hash: string
  file_size: number
  page_count: number
  title: string
  authors: string[]
  year: number
  abstract: string
  keywords: string[]
  sections: ServerParsedSection[]
  status: string
  error: string | null
  source_type: SourceType
  analyzed_with: {
    provider: string
    model: string
    prompt_version: string
    analyzed_at: string
    input_tokens: number
    output_tokens: number
    cost_usd: number | null
  } | null
  method_ids: string[]
  evidence_count: number
  created_at: string
  updated_at: string
}

export interface ServerEvidence {
  evidence_id: string
  paper_id: string
  project_id: string
  section: string
  page: number
  content: string
  translation: string
  supports: string[]
  confidence: number
  method_ids: string[]
  gap_ids: string[]
  direction_ids: string[]
  source_type: SourceType
}

export interface ServerMethod {
  method_id: string
  project_id: string
  name: string
  name_zh: string
  family_id: string
  task: string
  paradigm: string
  year: number
  core_idea: string
  modules: string[]
  inputs: string[]
  outputs: string[]
  capabilities: string[]
  advantages: string[]
  limitations: string[]
  paper_ids: string[]
  evidence_ids: string[]
  layer: number
  source_type: SourceType
  /** 阶段③ 分类溯源。null = 还没跑过分类（区别于 family_id='' 的"判定为未分类"） */
  classification: ServerClassification | null
}

export interface ServerClassification {
  method_id: string
  family_id: string
  reason: string
  evidence_ids: string[]
  confidence: number
  provider: string
  model: string
  prompt_version: string
  classified_at: string
}

/* ------------------------------------------------------------------ */
/* 跨论文方法关系（Phase 4-3，服务端 methodAlignment.ts 的产出）          */
/* ------------------------------------------------------------------ */

/**
 * 关系类型。
 *
 * **刻意与 `RelationType`（前端已有的 7 类）分开**，不合并成一个联合。
 *
 * 理由：那 7 类是 Demo 知识库里人工标注的**演进关系**（继承/改进/组合…），
 * 它们表达"B 是在 A 基础上发展出来的"这种历史因果，需要有原文声明支撑。
 * 而这 4 类是服务端规则算出的**对齐候选**（同一/别名/相关/说不清），
 * 表达的是"这两个方法名实是否指向同一个东西"。
 *
 * 两者语义不同、证据要求不同、可信度也不同。合并类型会让
 * 「related（有主题关联但证据不足）」和「extends（确实继承了）」在类型上无法区分，
 * 而那恰恰是必须让用户分清的一件事。
 */
export type AlignmentRelationType = 'same' | 'alias' | 'related' | 'uncertain'

/** 判定这条关系时命中的信号。界面据此解释"凭什么" */
export type AlignmentBasis =
  | 'name_exact'
  | 'name_surface_variant'
  | 'name_token_subset'
  | 'name_zh_match'
  | 'alias_declared'
  | 'acronym_match'
  | 'core_idea_overlap'
  | 'same_task'
  | 'same_family'
  | 'shared_evidence_text'
  | 'year_gap'
  | 'name_conflict'

/** 关系的一方。`paper_id` / `method_id` / `evidence_ids` 三者齐备，缺一不可 */
export interface AlignmentSide {
  paper_id: string
  method_id: string
  name: string
  name_zh: string
  family_id: string
  year: number
  evidence_ids: string[]
}

export interface ServerAlignmentCandidate {
  alignment_id: string
  source: AlignmentSide
  target: AlignmentSide
  relation_type: AlignmentRelationType
  confidence: number
  basis: AlignmentBasis[]
  reason: string
  evidence_ids: string[]
  shared_quotes: string[]
  /**
   * 是否达到"实质证据"门槛。
   *
   * 为 false 时 relation_type 一定不是 same/alias —— 服务端已保证。
   * 界面用它显示"此判断无证据支撑"，而不是让用户自己猜。
   */
  hasDirectEvidence: boolean
}

/** 四类关系各自计数。"共 N 条"是不够的，见服务端 summarizeAlignments 的注释 */
export interface AlignmentStats {
  same: number
  alias: number
  related: number
  uncertain: number
  total: number
  grounded: number
}

export interface MethodAlignmentsResponse {
  candidates: ServerAlignmentCandidate[]
  stats: AlignmentStats
  /**
   * 统计口径的上下文。
   *
   * 它回答的是 empty state 下用户最想问的那个问题：
   * "为什么 0 条？" —— 因为只有 1 篇论文有方法（跨论文无从比起），
   * 还是因为方法都在同一篇论文里（全被同论文规则跳过）。
   * 没有这几个数，空状态只能写一句"暂无数据"，用户会以为是功能坏了。
   */
  context: {
    methods: number
    papers: number
    compared: number
    skipped_same_paper: number
    skipped_no_paper: number
  }
  rule_version: string
}

/* ------------------------------------------------------------------ */
/* 技术演进（Phase 4-5）                                                */
/* ------------------------------------------------------------------ */

/**
 * 七类演进关系。与 `src/types` 的 `RelationType` **完全同词**。
 *
 * 这里刻意不造第二套词表：服务端 methodEvolution.ts 的
 * `EvolutionRelationType`、前端 types 的 `RelationType`、本类型
 * 三者必须逐字相同，否则某个页面漏了一类（4-3 就在图例里漏掉过 related），
 * 而 TypeScript 不会报错 —— 因为漏掉的那类只是永远不出现。
 */
export type EvolutionRelationType =
  | 'extends'
  | 'improves'
  | 'replaces'
  | 'combines'
  | 'related'
  | 'parallel'
  | 'temporal'

/**
 * 判定依据的机器码。
 *
 * 前端把它翻译成人话展示。rule-based 判定的全部价值就在**过程可复核** ——
 * 只给一个"继承"标签而不给依据，用户只能选择相信或不信。
 */
export type EvolutionBasis =
  | 'explicit_causal_statement'
  | 'object_anchor'
  | 'evidence_ownership_verified'
  | 'aligned_same_method'
  | 'same_paper_no_causal'
  | 'duplicate_method_identity'
  | 'same_year_no_order'
  | 'unknown_year_no_order'
  | 'year_adjacent_no_causal_evidence'
  | 'reverse_statement'

/**
 * 演进链上的一个节点。
 *
 * 比前端 `Evolution` 多一个 `paper_id`（便于展示溯源、跳转到论文）。
 * 其余字段逐字段对齐，所以可以直接当 `Evolution` 用。
 */
export interface ServerEvolutionNode {
  evolution_id: string
  /**
   * 代表年份。**可能为 0**，表示年份不可知。
   *
   * 0 是"诚实哨兵"而非错误值：年份不可知是真实状态，必须如实上报。
   * 这类节点排在链尾，并在 `stats.unknown_year` 单独计数 ——
   * 悄悄改成"最近的一年"会让整条链看起来比实际更可信。
   */
  year: number
  method_id: string
  paper_id: string
  stage_title: string
  change: string
  improvement: string
  limitation: string
  evidence_ids: string[]
  /** 与上一节点的关系。null = 链首（或该相邻对没有边） */
  relation_from_prev: EvolutionRelationType | null
}

/**
 * 一条演进关系。
 *
 * ── 方向（极易读反，务必注意）──
 * **`source` = later（后继），`target` = earlier（前驱）。**
 *
 * 这是**数据结构的引用方向**，不是画面的箭头方向。
 * 界面上箭头恒指"年代更晚"的一侧（见 EvolutionPage 的 EvolutionEdge）。
 *
 * ── 关于 method_key ──
 * `source_method_key` 形如 `paper_id::method_id`。
 * `method_id` **只在项目内唯一，跨论文会撞号**（两篇论文都可能被抽成 M001），
 * 所以判等一律用这个完整键，不能用裸 method_id。
 */
export interface ServerEvolutionRelation {
  relation_id: string
  source_method: string
  target_method: string
  source_paper_id: string
  target_paper_id: string
  source_method_key: string
  target_method_key: string
  relation_type: EvolutionRelationType
  /** 可复述的中文解释，禁止空话 */
  description: string
  /**
   * 因果时非空；非因果时**恒为空数组**。
   *
   * 空数组是"确实没有因果证据"的**显式编码**，不是"忘了填"。
   */
  evidence_ids: string[]
  /**
   * 是否因果。
   *
   * 不变量：`causal === true` ⟺ 类型属因果四类 **且** `evidence_ids.length > 0`。
   * 界面上"画不画箭头"就以此字段为准，不自己重新判类型 ——
   * 两套判据迟早会漂移，表现为"有箭头但没有证据"。
   */
  causal: boolean
  confidence: number
  basis: EvolutionBasis[]
}

/**
 * 统计。七类**分别**计数，不用一个"总数"糊过去。
 *
 * 理由：`temporal`（只是年份相邻）和 `extends`（有原文依据的继承）
 * 对用户的含义**完全相反**。合并成一个数字会让"找到 1 条继承"
 * 和"注意到 20 条但没证据"看起来一样重要。
 */
export interface EvolutionStats {
  extends: number
  improves: number
  replaces: number
  combines: number
  related: number
  parallel: number
  temporal: number
  total_relations: number
  /** 因果关系数 = extends + improves + replaces + combines */
  causal_total: number
  non_causal_total: number
  /** 节点（阶段）数 */
  stages: number
  /** 年份不可知（=0）的节点数 */
  unknown_year: number
  /** 无证据却标成因果的关系数 —— **服务端不变量，恒为 0** */
  causal_without_evidence: number
}

export interface MethodEvolutionsResponse {
  /** 已按年份升序（年份不可知的排在最后） */
  evolutions: ServerEvolutionNode[]
  relations: ServerEvolutionRelation[]
  stats: EvolutionStats
  /**
   * 空状态 / 降级要能解释"为什么"，同 4-3 的处理。
   *
   * 没有这几个数，页面只能写"暂无数据"，用户会以为是功能坏了 ——
   * 而真实情况可能是"只有一篇论文，跨论文演进无从谈起"，
   * 那是完全不同的两件事。
   */
  context: {
    methods: number
    papers: number
    /** 4-2 参与比较的方法数，用来解释 related 边为什么可能为 0 */
    aligned_compared: number
    /** 本模块剔除的"没有有效论文归属"的方法数 */
    skipped_no_paper: number
    rule_version: string
  }
}

/* ------------------------------------------------------------------ */
/* 研究空白 Gap（Phase 4-6）                                           */
/* ------------------------------------------------------------------ */

/**
 * 缺口信号类型。与服务端 `GapSignalType` 必须逐字一致。
 *
 * 这四类不是"缺口严重程度"的分级，而是**缺口长什么样**的区分：
 * 前者会诱导前端排序，后者才是用户真正要判断的东西
 * （"是作者自己承认没做完，还是我们看出缺了个对比实验"）。
 */
export type ServerGapSignal =
  | 'limitation'
  | 'open_problem'
  | 'missing_comparison'
  | 'uncovered_setting'

/**
 * 断言层级 —— **本接口最重要的字段**。
 *
 * `stated`    = 论文原文明确写出（可以直接引用）
 * `candidate` = 系统跨论文聚簇推断（只能当研究方向参考）
 *
 * 两者的可信度、引用方式、给用户的心理暗示都完全不同，
 * 所以页面必须**分区展示**，绝不能合成一个列表。
 */
export type ServerGapAssertionLevel = 'stated' | 'candidate'

export interface ServerGapFinding {
  /** 稳定 id，形如 GR001 */
  gap_id: string
  assertion_level: ServerGapAssertionLevel
  /** 恒等于 `assertion_level === 'candidate'`，方便直接判断 */
  candidate: boolean
  gap_signal: ServerGapSignal
  /** 场景主题机器名（`long_horizon` 等，可能为 'general'） */
  theme: string
  /** candidate 时以「【候选】」开头 —— 服务端不变量强制 */
  title: string
  /** candidate 时明写"系统推断" */
  description: string
  /** 支撑证据，**恒非空**（服务端硬门槛） */
  evidence_ids: string[]
  paper_ids: string[]
  method_ids: string[]
  /** 命中的判定依据，按重要性排序 */
  basis: string[]
  /**
   * 由措辞推出的弱推测（method/data/evaluation/application）。
   *
   * ⚠️ 字段名带 `_guess` 是刻意的。显示时必须同时出现"推测"字样，
   * 否则用户会把它当作从证据里读出的事实。
   */
  gap_type_guess: 'method' | 'data' | 'evaluation' | 'application'
  confidence: number
}

export interface ServerGapStats {
  /** 原文明确指出 */
  stated: number
  /** 系统推断 */
  candidate: number
  /** = stated + candidate */
  total: number
  limitation: number
  open_problem: number
  missing_comparison: number
  uncovered_setting: number
  papers_involved: number
  methods_involved: number
  /** 场景主题数（不含 general） */
  themes: number
  /** 无证据的 Gap 数 —— 服务端不变量，恒为 0 */
  gaps_without_evidence: number
  /** 看见线索但不足以形成 candidate 的单篇证据数 */
  single_paper_signals: number
  /** 被剔除的证据数（归属不明 / 无实质文本） */
  evidence_skipped: number
}

export interface ResearchGapsResponse {
  gaps: ServerGapFinding[]
  stats: ServerGapStats
  /**
   * 空状态要能解释"为什么"。
   *
   * `corpus_has_gap_intent === false` 时 0 条 Gap 是**预期结果**
   * （语料里根本没人写过局限），页面要显示成"当前语料没有足够 Evidence"，
   * 而不是"加载失败"。
   */
  context: {
    papers: number
    methods: number
    evidence: number
    alignments_considered: number
    evolution_relations: number
    evidence_with_gap_intent: number
    corpus_has_gap_intent: boolean
    rule_version: string
  }
  /** 服务端不变量自检结果 —— 正常情况下恒为空数组 */
  invariant_violations: string[]
}

/* ------------------------------------------------------------------ */
/* 研究方向（第 4-7 节）                                                */
/* ------------------------------------------------------------------ */

/**
 * 依据层级 —— **本接口最重要的字段**。
 *
 * `stated_backed`  = 全部依据来自论文明确写出的 Gap（可引用）
 * `mixed`          = 事实依据 + 系统推断线索（两者都用了）
 * `candidate_only` = **仅**由系统推断支撑（只能当探索性建议）
 *
 * 为什么是三档而不是两档：`stated` 与 `candidate` 之间存在真实的中间态（两者都用）。
 * 硬拆两档会丢掉"这条方向有多少事实成分"的信息；
 * 而 `candidate_only` 单独成档，才能给它套上推测前缀与置信度硬上限。
 */
export type ServerDirectionBasisLevel = 'stated_backed' | 'mixed' | 'candidate_only'

/** 方法切入点的四种形态。`introduce_new` 是诚实降级：项目方法池里没有可用素材 */
export type ServerDirectionApproachKind =
  | 'extend_existing'
  | 'combine_existing'
  | 'evaluate_existing'
  | 'introduce_new'

export interface ServerDirectionQuestion {
  /** 建议研究问题。**契约：必然以 ？/ ? 结尾** —— 服务端不变量强制 */
  question: string
  /** 为什么值得问（依据是什么） */
  rationale: string
  /** 期望得到什么结论 */
  expected_outcome: string
}

export interface ServerDirectionApproach {
  kind: ServerDirectionApproachKind
  description: string
  /**
   * 切入点所依据的方法 id。
   *
   * **契约：必然全部存在于该项目的 methods 里**（服务端不变量强制）。
   * 显示时不要和"这篇论文提出的方法"混淆 —— 它是本项目语料里的既有方法。
   */
  based_on_method_ids: string[]
  based_on_method_names: string[]
}

export interface ServerDirectionValidation {
  /** 建议做的实验 */
  experiment: string
  /**
   * 验证材料 —— **只到类别级**（评测基准 / 数据集 / 基线对比 …），不含具体数据集名。
   *
   * 原因：写"建议在 SWE-bench 上评测"需要一个本模块无法支撑的判断，
   * 所以只输出类别，把具体选哪个留给研究者。
   */
  materials: string[]
  success_criteria: string
  /** true = 材料确实来自语料证据；false = 只是最小建议（页面上要区分口径） */
  from_corpus: boolean
}

export interface ServerDirectionFinding {
  /** 稳定 id，形如 RD001 —— 排序后按位置编号，是纯函数 */
  direction_id: string
  basis_level: ServerDirectionBasisLevel
  /**
   * 恒等于 `basis_level === 'candidate_only'`。
   *
   * 冗余字段，但刻意保留：前端 90% 的判断只需要这一个布尔，
   * 不必每次都写三段比较。服务端不变量保证两者不会不一致。
   */
  candidate_only: boolean
  /** candidate_only 时以「【推测方向】」开头 —— 服务端不变量强制 */
  title: string
  description: string
  theme: string
  gap_signal: ServerGapSignal
  /** 关联的 Gap，**恒非空**（硬门槛） */
  gap_ids: string[]
  /** 关联的 Evidence，**恒非空**，且恒为其 Gap 证据的子集 */
  evidence_ids: string[]
  paper_ids: string[]
  method_ids: string[]
  /** 研究问题三件套 */
  question: ServerDirectionQuestion
  /** 方法切入点 */
  approach: ServerDirectionApproach
  /** 建议验证实验 */
  validation: ServerDirectionValidation
  /** 依据留痕，逐项说明这个方向"凭什么成立" */
  basis: string[]
  /** candidate_only 时**硬性封顶 0.5** —— 数值上也要让推断排不过事实 */
  confidence: number
}

export interface ServerDirectionStats {
  /** 事实打底 */
  stated_backed: number
  /** 事实 + 推断 */
  mixed: number
  /** 纯推断 */
  candidate_only: number
  /** = stated_backed + mixed + candidate_only */
  total: number
  limitation: number
  open_problem: number
  missing_comparison: number
  uncovered_setting: number
  papers_involved: number
  methods_involved: number
  themes: number
  /** 无 Gap 的方向数 —— 服务端不变量，恒为 0 */
  directions_without_gap: number
  /** 无 Evidence 的方向数 —— 服务端不变量，恒为 0 */
  directions_without_evidence: number
  /** 切入点来自项目方法池的方向数 */
  with_corpus_approach: number
  /** 验证材料确实来自语料的方向数 */
  with_corpus_validation: number
  /** 被合并掉的方向数（组内 + 跨组两条路径合计） */
  deduplicated: number
  /** 参与计算过的 Gap 数 */
  gaps_considered: number
}

export interface ResearchDirectionsResponse {
  directions: ServerDirectionFinding[]
  stats: ServerDirectionStats
  /**
   * 空状态要能解释"为什么"。
   *
   * `has_any_gap === false` 时 0 条方向是**预期结果**
   * （语料里根本没有 Gap），页面要显示成"当前语料没有足够 Evidence 支撑研究方向"，
   * 而不是"加载失败"。
   */
  context: {
    gaps_received: number
    stated_gaps: number
    candidate_gaps: number
    gaps_used: number
    methods_available: number
    evidence_with_eval_material: number
    has_any_gap: boolean
    rule_version: string
  }
  /** 服务端不变量自检结果 —— 正常情况下恒为空数组 */
  invariant_violations: string[]
}

/* ------------------------------------------------------------------ */
/* 调研报告（第 4-8 节）                                                */
/* ------------------------------------------------------------------ */

/**
 * 报告陈述的**语义层级** —— 本接口最重要的字段，也是页面的分区依据。
 *
 *   `stated_fact`       论文原文事实（可引用）
 *   `system_analysis`   系统对语料的统计/归纳（不是论文观点）
 *   `system_suggestion` 系统给出的建议（不构成对现状的陈述）
 *
 * ⚠️ 三者必须**视觉区分**。把 `system_analysis` 和 `stated_fact` 画成同一个样子，
 * 用户会把"系统数了一下有几个方法"读成"论文说有 3 个方法"——
 * 这正是 4-8 整节要防的事。
 */
export type ReportStatementKind = 'stated_fact' | 'system_analysis' | 'system_suggestion'

/** 回链类型。`paper`/`method`/`evidence` 是可打开抽屉的硬来源 */
export type ReportRefKind =
  | 'paper'
  | 'method'
  | 'evidence'
  | 'gap'
  | 'direction'
  | 'alignment'
  | 'evolution'

/**
 * 一条回链。`label` 给人看，`id` 给机器核。
 *
 * `kind === 'evidence'` 时 `id` 可直接交给证据抽屉打开原文 ——
 * 页面**不要**自己复制一份原文，否则"以抽屉为准"会变成"以页面为准"。
 */
export interface ReportRef {
  kind: ReportRefKind
  id: string
  label: string
}

export interface ReportStatement {
  kind: ReportStatementKind
  text: string
  refs: ReportRef[]
}

/** 章节状态。`insufficient` = 正文为「暂无足够证据」，页面必须显示空态而不是伪装成报告 */
export type ReportSectionStatus = 'ok' | 'insufficient' | 'partial'

export interface ReportSection {
  section_id: string
  title: string
  status: ReportSectionStatus
  source_counts: Record<string, number>
  statements: ReportStatement[]
  limitations: string[]
}

/** 研究主题 / 研究问题 —— **不在 `sections` 里**，是顶层独立块 */
export interface ReportTopicBlock {
  keywords: { term: string; count: number; refs: ReportRef[] }[]
  themes: { theme: string; label: string; gap_count: number }[]
  families: { family_id: string; count: number; method_names: string[] }[]
  research_questions: ReportStatement[]
  limitations: string[]
}

export interface ReportEvidenceIndexEntry {
  evidence_id: string
  paper_id: string
  paper_title: string
  section: string
  page: number
  quote: string
  translation: string
  /** 被哪些章节引用。**空数组 = 已登记但未被任何结论使用**（如实标注，不隐藏） */
  cited_by: string[]
  gap_ids: string[]
  direction_ids: string[]
}

export interface ReportLayeringSummary {
  stated_fact: number
  system_analysis: number
  system_suggestion: number
  total_statements: number
  total_refs: number
  insufficient_sections: number
  partial_sections: number
}

export interface ResearchReportData {
  report_id: string
  title: string
  scope_note: string
  topic: ReportTopicBlock
  sections: ReportSection[]
  evidence_index: ReportEvidenceIndexEntry[]
  layering: ReportLayeringSummary
  methods_source_counts: Record<string, number>
  /** 报告没法覆盖什么。**恒非空** —— 再完整的一份报告也有边界 */
  global_limitations: string[]
  /** 规则集版本。标明是确定性规则，不让人误以为是模型产出 */
  rule_version: string
}

export interface ResearchReportResponse {
  report: ResearchReportData
  /** 服务端不变量自检结果 —— 正常情况下恒为空数组 */
  invariant_violations: string[]
}

export interface ServerJob {
  job_id: string
  project_id: string
  paper_id: string
  state: 'queued' | 'running' | 'completed' | 'failed'
  stage: string
  steps: { at: string; stage: string; message: string; level: 'info' | 'success' | 'warn' | 'error' }[]
  rejected: {
    section: string
    page: number
    /** 完整未截断的原文，用于逐字节复现判定 */
    quote: string
    quoteLength: number
    /** 机器可读的拒绝代码 */
    reason: string
    /** 面向人的中文说明 */
    message?: string
    diagnosis?: 'PAGE_OFFSET' | 'TRUNCATED_SPLICE' | 'NOT_IN_PAPER' | 'UNVERIFIABLE'
  }[]
  validation: {
    evidenceSeen: number
    evidenceAccepted: number
    evidenceRejected: number
    methodsSeen: number
    methodsAccepted: number
    methodsRejected: number
    pageOffset: number
    truncatedSplice: number
    notInPaper: number
  } | null
  methods: number
  evidences: number
  error: string | null
  created_at: string
  updated_at: string
}

/* ------------------------------------------------------------------ */
/* Semantic Scholar（Phase 3B-1 服务端 Provider 的返回结构）            */
/* ------------------------------------------------------------------ */

/**
 * 归一化论文。
 *
 * 字段与服务端 server/services/semanticScholar/index.ts 的 NormalizedPaper 一一对应，
 * 少一个都会让界面渲染出 undefined。
 */
export interface S2Paper {
  paper_id: string
  title: string
  authors: string[]
  /** 取不到时为 0。服务端**不会**用当前年份兜底，前端也不要 */
  year: number
  abstract: string
  url: string
  doi: string
  citationCount: number
  venue: string
  /**
   * 'live' = 真的来自 Semantic Scholar
   * 'mock' = 降级占位数据，**不代表任何真实论文**
   *
   * 界面上必须据此标注。这是整个 S2 集成里唯一不能省的一层——
   * 用户看到一条标题、作者、年份俱全的记录，默认就会信它是真的。
   */
  source: 'live' | 'mock'
  /**
   * 相关性分数（Phase 3B-4）。
   *
   * `percent` 是**匹配覆盖率**（0–100），不是"这篇论文有多大概率是你想要的"。
   * 含义是：用户输入里解析出的检索词，这篇论文覆盖了多少。
   * 100% = 检索词全覆盖；0% = 一个都没命中。
   *
   * 可选：references/citations 路径不排序，不带这个字段。
   */
  relevance?: { percent: number; ratio: number; matched: string[] }
}

/**
 * 自然语言检索条件（Phase 3B-3）。
 *
 * 服务端用规则（不是 LLM）从输入里抽这些条件，并把抽取结果原样回传，
 * 好让页面把它显示给用户核对。抽错时用户一眼能看出来，改个说法重搜即可。
 */
export interface ParsedQuery {
  keywords: string[]
  yearRange: { from: number; to: number } | null
  /** 年份的原始说法，如「近三年 → 2024–2026」 */
  yearLabel: string
  task: string
  method: string
  /** 全部命中的任务/方法。用户一句话说了多个时不止一项 */
  tasks?: string[]
  methods?: string[]
  /** 实际送给 Semantic Scholar 的检索串 */
  s2Query: string
  /** 是否有任何条件被识别出来。false 表示"没读懂，按原句搜" */
  understood: boolean
}

export interface S2SearchResponse {
  query?: string
  /** 送给 S2 的实际检索串。与 query 不同时说明 Agent 改写了它 */
  s2_query?: string
  /** 自然语言解析结果。关闭解析（?parse=false）时为 null */
  parsed?: ParsedQuery | null
  papers: S2Paper[]
  total: number
  source: 'live' | 'mock'
  /** 降级原因，live 时为空串 */
  note: string
  authenticated: boolean
}

/**
 * 「加入当前项目」提交的单篇输入（Phase 3B-6）。
 *
 * 抽出来是因为单条与批量两个接口用的是**同一个结构**——
 * 重复写两遍的话，将来加字段只会改一处，另一处静默漏字段，
 * 表现为"批量加入的论文少了 DOI"，且不报任何错。
 * 服务端两条路径共用 addMetaPaper，所以这里也必须共用。
 */
export interface MetaPaperInput {
  s2_paper_id: string
  title: string
  authors: string[]
  year: number
  abstract: string
  url: string
  doi: string
  citationCount: number
  venue: string
  source: 'live' | 'mock'
}

/**
 * 引用关系响应（Phase 3B-5）。
 *
 * `kind` 区分方向，这个区分不能省：
 *   references = 这篇论文**引用了谁**（它的参考文献，指向过去）
 *   citations  = **谁引用了**这篇论文（施引文献，指向未来）
 * 两个方向混起来看会得出完全相反的结论（"它基于什么" vs "它影响了什么"），
 * 所以类型上就分开，而不是靠调用方自己记住。
 */
export interface S2GraphPage {
  paperId: string
  kind: 'references' | 'citations'
  papers: S2Paper[]
  count: number
  source: 'live' | 'mock'
  /** 降级原因，live 时为空串 */
  note: string
  authenticated: boolean
}

export interface ServerProject {  id: string
  name: string
  subtitle: string
  description: string
  domain: string
  goal: string
  kind: 'demo' | 'uploaded'
  created_at: string
  updated_at: string
  paper_ids: string[]
  paper_count?: number
  method_count?: number
  evidence_count?: number
}

export interface HealthInfo {
  status: string
  uptime_ms: number
  config: {
    aiProvider: 'mock' | 'http' | 'cli'
    aiReady: boolean
    aiNote: string
    aiModel: string
    pdfParser: string
    storage: string
    promptVersion: string
    /**
     * Semantic Scholar 状态。
     *
     * 服务端刻意只回布尔量 + 一句文案，**不回传任何密钥内容**——
     * e2e 有一条断言在查 /api/config 不含 `apikey|api_key|secret|token`。
     * 所以这里的字段叫 authenticated 而不是 apiKey：名字本身也是防线。
     */
    semanticScholar?: {
      enabled: boolean
      authenticated: boolean
      note: string
    }
  }
  ai: { provider: string; model: string; ready: boolean; reason: string }
  pdfParser: { mode: string; ok?: boolean; detail?: string }
  evidenceValidator: { ok: boolean; failures: string[] }
  promptVersion: string
}

/* ------------------------------------------------------------------ */
/* 接口                                                                */
/* ------------------------------------------------------------------ */

export const api = {
  health: (deep = false) => request<HealthInfo>(`/api/health${deep ? '?deep=true' : ''}`),

  config: () => request<HealthInfo['config']>('/api/config'),

  listProjects: () => request<ServerProject[]>('/api/projects'),

  createProject: (input: {
    name: string
    subtitle?: string
    description?: string
    domain?: string
    goal?: string
  }) =>
    request<ServerProject>('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  getProject: (projectId: string) =>
    request<{
      project: ServerProject
      papers: ServerPaper[]
      methods: ServerMethod[]
      evidence: ServerEvidence[]
    }>(`/api/projects/${projectId}`),

  listPapers: (projectId: string) => request<ServerPaper[]>(`/api/projects/${projectId}/papers`),

  listMethods: (projectId: string, sourceType?: SourceType) =>
    request<ServerMethod[]>(
      `/api/projects/${projectId}/methods${sourceType ? `?source_type=${sourceType}` : ''}`,
    ),

  listEvidence: (projectId: string, filter?: { methodId?: string; paperId?: string }) => {
    const q = new URLSearchParams()
    if (filter?.methodId) q.set('method_id', filter.methodId)
    if (filter?.paperId) q.set('paper_id', filter.paperId)
    const s = q.toString()
    return request<ServerEvidence[]>(`/api/projects/${projectId}/evidence${s ? `?${s}` : ''}`)
  },

  /**
   * 跨论文方法关系（Phase 4-3）。
   *
   * 服务端调用纯函数 alignMethods() 现算，没有落库缓存 ——
   * 因为这个计算是确定性的、成本极低（O(n²) 但 n 是方法数，通常个位数），
   * 而落库会引入"方法改了但关系没更新"的不一致。
   */
  listMethodAlignments: (projectId: string) =>
    request<MethodAlignmentsResponse>(`/api/projects/${projectId}/method-alignments`),

  /**
   * 技术演进候选链（Phase 4-5）。
   *
   * 服务端先跑 alignMethods() 再把结果喂给 buildEvolution()，现算不落库 ——
   * 与 listMethodAlignments 同款理由：确定性计算 + 落库会引入不一致。
   *
   * 注意：真实项目当前大概率返回**全是 temporal** 的链（每个项目方法数少、
   * 且多在同一篇论文内）。那是正常且诚实的结果，界面上要显示成
   * "有时间顺序但没有因果证据"，不是"加载失败"。
   */
  listEvolutions: (projectId: string) =>
    request<MethodEvolutionsResponse>(`/api/projects/${projectId}/evolutions`),

  /**
   * 研究空白 Gap 检测（Phase 4-6）。
   *
   * 服务端链式跑 alignMethods() → buildEvolution() → detectGaps()，
   * 现算不落库 —— 与上面两个接口同款理由。
   *
   * 注意：真实语料当前大概率只产出少量 `stated`、0 条 `candidate`。
   * 那是正常且诚实的结果，页面要按 `context.corpus_has_gap_intent`
   * 区分"没人写过局限"与"写了但不够成 Gap"，**不是加载失败**。
   */
  listGaps: (projectId: string) =>
    request<ResearchGapsResponse>(`/api/projects/${projectId}/gaps`),

  /**
   * 研究方向。
   *
   * 服务端链式跑 alignMethods() → buildEvolution() → detectGaps() → generateDirections()，
   * 现算不落库 —— 与上面三个接口同款理由。
   *
   * ⚠️ 页面必须按 `basis_level` **分区展示**：`candidate_only` 是系统推断，
   * 绝不能和"论文明确指出"的方向混在一个列表里 —— 那会让用户把推断当事实。
   */
  listDirections: (projectId: string) =>
    request<ResearchDirectionsResponse>(`/api/projects/${projectId}/directions`),

  /**
   * 调研报告（Phase 4-8）。
   *
   * 服务端链式跑 alignMethods() → buildEvolution() → detectGaps()
   * → generateDirections() → buildResearchReport()，现算不落库 —— 同款理由。
   *
   * ⚠️ 报告是**编排**不是判定：它只搬运上游结论并措辞，不产生新的事实判断。
   * 页面必须按 `statement.kind` **视觉区分** three 类陈述，
   * 否则用户会把系统统计读成论文事实。
   *
   * `sections` 里**没有**「研究主题」—— 它在 `report.topic` 顶层块，
   * 页面要单独渲染，不能只遍历 sections（否则会少一章）。
   */
  getReport: (projectId: string) =>
    request<ResearchReportResponse>(`/api/projects/${projectId}/report`),

  getPaper: (paperId: string, projectId: string) =>
    request<{ paper: ServerPaper; methods: ServerMethod[]; evidence: ServerEvidence[] }>(
      `/api/papers/${paperId}?project_id=${encodeURIComponent(projectId)}`,
    ),

  /** 原始 PDF 的 URL，交给 <iframe>/<embed> 直接内嵌预览 */
  pdfUrl: (paperId: string, projectId: string) =>
    `${CONFIGURED_BASE || previewPrefix()}/api/papers/${paperId}/pdf?project_id=${encodeURIComponent(projectId)}`,

  getJob: (jobId: string) => request<ServerJob>(`/api/jobs/${jobId}`),

  listJobs: (projectId: string) => request<ServerJob[]>(`/api/projects/${projectId}/jobs`),

  analyze: (paperId: string, projectId: string, force = true) =>
    request<{ job_id: string; state: string; reused: boolean }>(`/api/papers/${paperId}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, force }),
    }),

  /**
   * 阶段③：只重跑方法分类，不重跑解析与抽取。
   *
   * 之所以要单独一个入口：分类的输入（方法 + 已校验证据）都在盘上了，
   * 重跑几乎不花 token；而抽取一次要 78k input tokens。
   * 把两者绑死意味着每改一次分类 prompt 就要重烧一次完整抽取。
   */
  classify: (paperId: string, projectId: string) =>
    request<{
      seen: number
      assigned: number
      unclassified: number
      invalidFamilyId: number
      strippedEvidenceIds: number
      provider: string
      model: string
    }>(`/api/papers/${paperId}/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId }),
    }),

  /**
   * Semantic Scholar 搜索（Phase 3B-2 论文探索页）。
   *
   * 服务端在 S2 不可达时返回 200 + `source:'mock'` 而不是报错，
   * 所以这里**不会**抛异常——调用方必须自己看 `source` 字段。
   * limit 上限 20 由服务端兜底，前端不重复限制。
   */
  s2Search: (query: string, limit = 10) =>
    request<S2SearchResponse>(
      `/api/s2/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),

  /**
   * 引用关系（Phase 3B-5）：这篇论文引用了谁 / 谁引用了它。
   *
   * **paperId 必须 encodeURIComponent**，这不是可选的讲究：
   * S2 的 id 形态可能是 `DOI:10.1145/3290605.3300233` 或 `ARXIV:2210.03629`，
   * 而服务端路由（server/utils/http.ts matchPath）是按 `/` 切分并要求
   * **段数相等**来匹配的。DOI 里那个 `/` 若不编码会多切出一段，
   * 于是路由匹配失败返回 404 —— 不抛异常、不提示，页面只是空白。
   * 实测：未编码 404 / 编码后 200 且 paperId 正确还原。
   *
   * 服务端在 S2 不可达时返回 200 + source:'mock'，所以这里不抛异常，
   * 调用方必须自己看 source（与 s2Search 同一约定）。
   */
  s2References: (paperId: string, limit = 20) =>
    request<S2GraphPage>(
      `/api/s2/paper/${encodeURIComponent(paperId)}/references?limit=${limit}`,
    ),

  s2Citations: (paperId: string, limit = 20) =>
    request<S2GraphPage>(
      `/api/s2/paper/${encodeURIComponent(paperId)}/citations?limit=${limit}`,
    ),

  /**
   * 「加入当前项目」：只登记元数据，不下载 PDF、不调用 LLM。
   *
   * 201 = 新加入，200 = 早就在项目里（服务端按 s2_paper_id 去重）。
   * 两种都算成功，用 created 区分文案。
   */
  addMetaPaper: (
    projectId: string,
    input: MetaPaperInput,
  ) =>
    request<{ paper: ServerPaper; created: boolean; status: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/papers/meta`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    ),

  /**
   * 批量加入（Phase 3B-6）。
   *
   * **一次请求提交全部选中项**，而不是前端并发打 N 次 addMetaPaper。
   * 原因在服务端：addMetaPaper 是「读 papers.json → 追加 → 整份写回」，
   * 并发调用会各自读到同一份旧数据再各自覆盖，最终只留下一两条——
   * 而每个请求都返回 201 成功。服务端改成顺序循环后没有这个问题。
   *
   * 服务端对单条失败不回滚整体：`created` / `existing` / `failed` 三类分开计数，
   * 所以调用方要按这三项来组织文案，而不是简单地判"成功/失败"。
   */
  addMetaPapersBatch: (projectId: string, papers: MetaPaperInput[]) =>
    request<{
      created: number
      existing: number
      failed: number
      created_ids: string[]
      existing_ids: string[]
      failures: { s2_paper_id: string; code: string; message: string }[]
      total: number
    }>(`/api/projects/${encodeURIComponent(projectId)}/papers/meta/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ papers }),
    }),

  /**
   * 「获取全文」（Phase 3B-7）。
   *
   * 给一篇仅元数据的论文补上 PDF：服务端拿元数据里的链接去把全文取回来，
   * 落盘后把状态从 pending 改成 uploaded（前端显示为"可分析"）。
   *
   * ── 为什么失败不走异常 ──
   *
   * 服务端对"没找到 PDF 链接 / 链接不可达 / 下回来的不是 PDF"返回的是
   * **HTTP 200 + ok:false**，而不是 5xx。因为这不是接口出错，
   * 是接口正常回答了一个"取不到"的结论——就像搜索返回空结果一样。
   * 若用 5xx，界面只能显示一个红色的"请求失败"，而真相是
   * "这篇论文没有可用的开放获取链接"，用户据此该做的事完全不同。
   *
   * 所以调用方必须看 `ok`，不能只看有没有抛异常。这一点与 s2Search
   * 必须看 `source` 是同一类约定。
   */
  fetchFulltext: (projectId: string, paperId: string) =>
    request<{
      ok?: boolean
      already?: boolean
      status: string
      code?: string
      message?: string
      from?: string
      route?: string
      file_name?: string
      file_size?: number
    }>(
      `/api/projects/${encodeURIComponent(projectId)}/papers/${encodeURIComponent(paperId)}/fetch-fulltext`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    ),

  /**
   * 上传。用 XMLHttpRequest 而不是 fetch ——
   * 只有 XHR 能拿到 upload.onprogress，而批量上传时进度条不是装饰品：
   * 一篇 30MB 的论文在慢网络上要传十几秒，没有进度用户会以为卡死了。
   */
  upload(
    projectId: string,
    files: File[],
    opts: {
      force?: boolean
      onProgress?: (loaded: number, total: number) => void
      signal?: AbortSignal
    } = {},
  ): Promise<{
    project_id: string
    accepted: { paper_id: string; file_name: string; job_id: string }[]
    rejected: { file_name: string; code: string; message: string }[]
    total: number
  }> {
    return new Promise((resolve, reject) => {
      const fd = new FormData()
      for (const f of files) fd.append('file', f)
      if (opts.force) fd.append('force', 'true')

      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${CONFIGURED_BASE || previewPrefix()}/api/projects/${projectId}/papers`)

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total)
      }
      xhr.onerror = () =>
        reject(new ApiCallError('NETWORK', '上传失败：无法连接分析服务，请确认服务端已启动', 0))
      xhr.onabort = () => reject(new ApiCallError('ABORTED', '上传已取消', 0))
      xhr.onload = () => {
        let body: { success?: boolean; data?: unknown; error?: ApiError }
        try {
          body = JSON.parse(xhr.responseText)
        } catch {
          reject(
            new ApiCallError(
              'BAD_RESPONSE',
              `服务端返回了非 JSON 响应（HTTP ${xhr.status}）：${xhr.responseText.slice(0, 120)}`,
              xhr.status,
            ),
          )
          return
        }
        if (xhr.status >= 400 || body.success === false) {
          reject(
            new ApiCallError(
              body.error?.code ?? `HTTP_${xhr.status}`,
              body.error?.message ?? `上传失败（HTTP ${xhr.status}）`,
              xhr.status,
            ),
          )
          return
        }
        resolve(body.data as never)
      }
      opts.signal?.addEventListener('abort', () => xhr.abort())
      xhr.send(fd)
    })
  },
}

/* ------------------------------------------------------------------ */
/* 轮询                                                               */
/* ------------------------------------------------------------------ */

/**
 * 轮询任务直到终态。
 *
 * 用轮询而不是 WebSocket/SSE：本阶段只关心"跑完了没有"，
 * 而轮询在任意代理、任意部署环境下都能工作，不会因为反向代理不支持
 * 长连接而静默失效。间隔逐步放宽，减少无谓请求。
 */
export async function pollJob(
  jobId: string,
  opts: {
    onTick?: (job: ServerJob) => void
    intervalMs?: number
    timeoutMs?: number
    signal?: AbortSignal
  } = {},
): Promise<ServerJob> {
  const start = Date.now()
  const timeout = opts.timeoutMs ?? 15 * 60 * 1000
  let wait = opts.intervalMs ?? 800

  for (;;) {
    if (opts.signal?.aborted) throw new ApiCallError('ABORTED', '已取消等待', 0)

    const job = await api.getJob(jobId)
    opts.onTick?.(job)

    if (job.state === 'completed' || job.state === 'failed') return job
    if (Date.now() - start > timeout) {
      throw new ApiCallError(
        'POLL_TIMEOUT',
        `任务 ${jobId} 超过 ${Math.round(timeout / 60000)} 分钟仍未完成。当前阶段：${job.stage}`,
        0,
      )
    }
    await new Promise((r) => setTimeout(r, wait))
    wait = Math.min(Math.round(wait * 1.3), 4000)
  }
}
