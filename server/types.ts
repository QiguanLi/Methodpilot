/**
 * 服务端领域类型。
 *
 * 这些类型与 src/types/index.ts 有意保持"结构兼容但不共享文件"：
 *   前端类型描述的是**渲染需要什么**；
 *   服务端类型描述的是**存储与分析产出什么**。
 * 两者字段名刻意对齐（paper_id / evidence_id / section / page / content…），
 * 这样前端可以直接消费，但服务端不必反向依赖浏览器侧的构建。
 */

/* ------------------------------------------------------------------ */
/* 数据来源标记 —— 防止把 Mock 包装成 AI 产出                            */
/* ------------------------------------------------------------------ */

/**
 * 这是评审时最容易产生误解的地方，所以做成强制字段。
 * 任何一条 Method / Evidence / Paper 都必须声明自己从哪来，
 * UI 上也会据此显示 Demo / Uploaded / Live AI 徽标。
 */
export type SourceType = 'demo' | 'uploaded' | 'ai_generated'

/* ------------------------------------------------------------------ */
/* PDF 解析产物                                                        */
/* ------------------------------------------------------------------ */

export interface ParsedPage {
  page: number
  text: string
}

export interface ParsedSection {
  name: string
  /** 章节起始页（真实 PDF 页码，1-based） */
  page: number
  /** 章节覆盖到的所有页码 */
  pages: number[]
  content: string
  summary: string
}

export interface ParsedPaper {
  status: 'ok'
  file_hash: string
  page_count: number
  parsed_pages: number
  char_count: number
  title: string
  authors: string[]
  year: number
  abstract: string
  keywords: string[]
  sections: ParsedSection[]
  /** 逐页原文，Evidence 校验时的比对基准 */
  pages: Record<string, string>
  removed_running_heads: string[]
  warnings: string[]
}

export interface ParserFailure {
  status: 'failed'
  error: string
  error_code: string
}

export type ParserResult = ParsedPaper | ParserFailure

/* ------------------------------------------------------------------ */
/* 论文                                                                */
/* ------------------------------------------------------------------ */

export type PaperStatus =
  | 'uploaded'
  | 'parsing'
  | 'parsed'
  | 'extracting'
  | 'validated'
  | 'completed'
  | 'failed'

export interface StoredPaper {
  paper_id: string
  project_id: string
  file_name: string
  file_hash: string
  file_size: number
  /** 用于去重：同一文件 + 同一模型 + 同一 prompt 版本可直接复用结果 */
  page_count: number
  title: string
  authors: string[]
  year: number
  abstract: string
  keywords: string[]
  sections: ParsedSection[]
  status: PaperStatus
  error: string | null
  source_type: SourceType
  /** 分析溯源 */
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

/* ------------------------------------------------------------------ */
/* Evidence                                                            */
/* ------------------------------------------------------------------ */

export type EvidenceSupport =
  | '方法核心思想'
  | '关键模块'
  | '能力主张'
  | '局限'
  | '方法关系'
  | '技术演进'
  | '研究空白'
  | '研究方向'

export interface StoredEvidence {
  evidence_id: string
  paper_id: string
  project_id: string
  section: string
  page: number
  /** 英文原文，必须能在该页正文中找到 */
  content: string
  /** 中文释义（翻译失败时为空字符串，但 evidence 仍然有效） */
  translation: string
  supports: EvidenceSupport[]
  confidence: number
  method_ids: string[]
  gap_ids: string[]
  direction_ids: string[]
  source_type: SourceType
}

/* ------------------------------------------------------------------ */
/* Method                                                              */
/* ------------------------------------------------------------------ */

export interface StoredMethod {
  method_id: string
  project_id: string
  name: string
  name_zh: string
  /**
   * 方法族 id。
   *
   * **空字符串是"未分类"的哨兵值**，不是"字段还没填"。
   * 阶段③ 之前所有真实方法都是 ''；阶段③ 接入后，能可靠归类的会拿到
   * 'F1'..'F5'，判不出来的仍然是 ''。
   *
   * 为什么用空串而不是 null：
   *   前端 layout() 用 `m.family_id === family.family_id` 做列匹配，
   *   伪族的 id 就是空串。两边必须是同一个值，否则方法会被静默丢弃。
   *   这个坑有专门的回归自测（methodLayout.ts 的 selfTestLayout 第 2 条）。
   */
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
  /**
   * 阶段③ 的分类溯源。**没有跑过分类时为 null**（不是空对象）。
   *
   * null 与 family_id='' 的区别很重要：
   *   classification === null       → 还没分类（阶段③ 未运行 / 运行失败）
   *   classification.family_id === '' → 分类运行过，模型判定"不可靠归类"
   * 界面上前者该显示「未接入」，后者该显示「未分类，理由如下」。
   * 混为一谈会让"我们试过了但判不出来"被误读成"我们没做这件事"。
   */
  classification: StoredClassification | null
}

/* ------------------------------------------------------------------ */
/* Method 抽取的 LLM 契约（第 16 节要求的最小 Schema）                   */
/* ------------------------------------------------------------------ */

export interface LLMEvidence {
  section: string
  page: number
  quote: string
  supports: string[]
  confidence: number
}

export interface LLMMethod {
  name: string
  name_zh?: string
  task?: string
  paradigm?: string
  core_idea?: string
  modules?: string[]
  inputs?: string[]
  outputs?: string[]
  capabilities?: string[]
  advantages?: string[]
  limitations?: string[]
  evidence: LLMEvidence[]
}

export interface LLMMethodExtraction {
  methods: LLMMethod[]
}

/* ------------------------------------------------------------------ */
/* 阶段③ 方法分类                                                       */
/* ------------------------------------------------------------------ */

/**
 * 一条分类的**溯源记录**。
 *
 * 为什么要单独存这个，而不是只把 family_id 写回 Method 就完事：
 *   界面重构后会显示「F3 规划与反思 · 由 cli/auto 分类，依据 E004/E005」。
 *   如果只存 family_id，用户就**无法判断这个标签是老几辈子的模型给的**，
 *   也无法核对它当时引用了哪几条证据。
 *   分类是结论性的东西，结论必须带出处——这在阶段①②是靠 Evidence 保证的，
 *   阶段③ 靠这个结构保证。
 *
 * 与 Method 分开存放（methods.json 里内嵌）而不是新建 classifications.json：
 *   一条分类永远属于且只属于一个方法，生命周期完全一致。
 *   分成两个文件就会出现"方法删了分类还在"的悬挂记录。
 */
export interface StoredClassification {
  method_id: string
  /** 分类结果。'' 表示未分类（与 StoredMethod.family_id 同一套哨兵） */
  family_id: string
  /**
   * 模型给出的归类理由。**未分类时同样必须有**——
   * 空理由在界面上和"根本没跑过分类"无法区分。
   */
  reason: string
  /**
   * 支撑这次分类的 evidence_id。
   *
   * 服务端已核实：每一个都真实存在于该方法的 evidence_ids 中。
   * 模型编造的 id 会被剔除，而不是照单全收——否则"分类依据可核"就是空话。
   */
  evidence_ids: string[]
  /** 模型自评 0-1。未分类时通常为 0 */
  confidence: number
  /** 谁做的这次分类。provider='mock' 表示规则引擎（它不做分类，一律返回未分类） */
  provider: string
  model: string
  prompt_version: string
  classified_at: string
}

/* ------------------------------------------------------------------ */
/* Job                                                                 */
/* ------------------------------------------------------------------ */

export type JobState = 'queued' | 'running' | 'completed' | 'failed'

export interface JobStep {
  at: string
  stage: string
  message: string
  level: 'info' | 'success' | 'warn' | 'error'
}

export interface Job {
  job_id: string
  project_id: string
  paper_id: string
  state: JobState
  /** 当前阶段名，便于前端显示进度 */
  stage: string
  steps: JobStep[]
  /** 校验被拒的证据，必须展示给用户，不能静默丢弃 */
  /**
   * 被拒绝的证据。
   *
   * quote 是**完整未截断**的原文——这是回放"模型到底给了什么"的唯一依据。
   * reason 是机器可读的拒绝代码（QUOTE_NOT_ON_PAGE 等），message 才是给用户看的中文说明；
   * 两者都要留，因为前者用于程序复现，后者用于界面展示。
   */
  rejected: {
    section: string
    page: number
    quote: string
    /** quote 的字符长度，用于和独立复核脚本逐字节对齐 */
    quoteLength: number
    reason: string
    message?: string
    diagnosis?: string
  }[]
  /**
   * 拒绝原因的结构化统计。
   * 只展示"拒绝 N 条"没有信息量；把"其中 M 条只是页码错了"分开统计，
   * 用户才知道该改 prompt 还是该改解析器。
   */
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
  /** 阶段③ 的分类计数。未跑分类时全为 0 */
  classified: {
    seen: number
    assigned: number
    unclassified: number
    /** 模型返回了非法/不存在的 family_id 而被判为未分类的条数 */
    invalidFamilyId: number
    /** 模型引用了不属于该方法、因而被剔除的 evidence_id 总数 */
    strippedEvidenceIds: number
  } | null
  error: string | null
  created_at: string
  updated_at: string
}

/* ------------------------------------------------------------------ */
/* API 统一响应                                                         */
/* ------------------------------------------------------------------ */

export interface ApiOk<T> {
  success: true
  data: T
}

export interface ApiErr {
  success: false
  error: { code: string; message: string; detail?: unknown }
}

export type ApiResult<T> = ApiOk<T> | ApiErr

export const ok = <T>(data: T): ApiOk<T> => ({ success: true, data })
export const err = (code: string, message: string, detail?: unknown): ApiErr => ({
  success: false,
  error: { code, message, ...(detail === undefined ? {} : { detail }) },
})
