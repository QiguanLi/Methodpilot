/**
 * MethodPilot 核心数据模型
 *
 * 设计原则：所有结论（方法、关系、演进、空白、方向）都必须能回溯到 Evidence，
 * 而 Evidence 必须能回溯到 Paper 的具体章节/页面。这条链路是产品的核心资产，
 * 因此在类型层面就强制建立引用关系。
 */

/* ------------------------------------------------------------------ */
/* 基础枚举                                                            */
/* ------------------------------------------------------------------ */

/** 论文解析状态 */
export type PaperStatus = 'pending' | 'parsing' | 'analyzed' | 'failed'

/** 方法范式 */
export type MethodParadigm =
  | 'Prompting'
  | 'Fine-tuning'
  | 'Agent'
  | 'Multi-Agent'
  | 'Tool-Augmented'
  | 'Neuro-Symbolic'

/** 方法关系类型 */
export type RelationType =
  | 'extends' // 继承
  | 'improves' // 改进
  | 'combines' // 组合
  | 'replaces' // 替代
  | 'parallel' // 并行发展
  | 'related' // 相关（证据不足时的保守标注）
  | 'temporal' // 时间相邻（无因果证据）

/** 研究空白类型 */
export type GapType = 'method' | 'data' | 'evaluation' | 'application'

/** 流水线节点状态 */
export type StageStatus = 'waiting' | 'running' | 'done' | 'failed'

/* ------------------------------------------------------------------ */
/* Paper                                                              */
/* ------------------------------------------------------------------ */

export interface Paper {
  paper_id: string
  title: string
  authors: string[]
  year: number
  venue: string
  abstract: string
  keywords: string[]
  /** 研究任务，如 Software Engineering Agent */
  task: string
  /** 论文链接 / 来源 */
  source: string
  status: PaperStatus
  evidence_count: number
  /** 方法 ID 列表 */
  method_ids: string[]
  /** 该论文引用的其他论文 ID */
  related_paper_ids: string[]
  /** 结构化章节摘要（模拟解析结果） */
  sections: PaperSection[]
  /**
   * 以下三项**仅对「论文探索」收录的元数据论文有值**，上传解析的论文为 undefined。
   *
   * 它们来自 Semantic Scholar，不是从 PDF 里抽的。
   * 之所以是可选的：给所有论文硬塞这三个字段会让"这篇到底有没有读过正文"
   * 变得更加难以分辨，而可选字段的 undefined 本身就是答案。
   */
  citation_count?: number
  doi?: string
  external_url?: string
  /** 是否为仅元数据论文（file_hash 以 meta: 开头） */
  meta_only?: boolean
}

export interface PaperSection {
  name: string
  page: number
  summary: string
}

/* ------------------------------------------------------------------ */
/* Evidence —— 产品核心：结论的溯源锚点                                 */
/* ------------------------------------------------------------------ */

/** 该 Evidence 支撑的结论类型 */
export type EvidenceSupport =
  | '方法核心思想'
  | '关键模块'
  | '能力主张'
  | '局限'
  | '方法关系'
  | '技术演进'
  | '研究空白'
  | '研究方向'

export interface Evidence {
  evidence_id: string
  paper_id: string
  /** 章节，如 "Section 3.2 Method" */
  section: string
  page: number
  /** 原文片段（英文原文） */
  content: string
  /** 中文释义 */
  translation: string
  /** 该证据支撑哪些结论 */
  supports: EvidenceSupport[]
  /** 置信度 0-1 */
  confidence: number
  /** 关联的方法 ID */
  method_ids: string[]
  /** 关联的空白 ID */
  gap_ids: string[]
  /** 关联的方向 ID */
  direction_ids: string[]
}

/* ------------------------------------------------------------------ */
/* Method                                                             */
/* ------------------------------------------------------------------ */

export interface Method {
  method_id: string
  name: string
  /** 中文名 / 别名 */
  name_zh: string
  /**
   * 方法族 ID。
   *
   * Demo 数据里是 'F1'..'F5'；真实项目里由阶段③ 的 LLM 分类写入，
   * **空字符串表示未分类**（不是"字段忘了填"）。
   */
  family_id: string
  task: string
  paradigm: MethodParadigm
  /** 首次出现年份 */
  year: number
  core_idea: string
  /** 关键模块 */
  modules: string[]
  inputs: string[]
  outputs: string[]
  /** 主要能力 */
  capabilities: string[]
  advantages: string[]
  limitations: string[]
  paper_ids: string[]
  evidence_ids: string[]
  /** 方法地图中用于布局的层级：0 = 领域根节点 */
  layer: number
  /**
   * 阶段③ 的分类溯源。Demo 数据没有这个字段（undefined），
   * 真实项目里 null 表示还没跑过分类。
   */
  classification?: MethodClassification | null
}

/**
 * 一条分类结论的出处。
 *
 * 界面上要能回答"这个族是谁分的、凭什么"——
 * 只显示一个族名而没有理由和证据，用户没法判断该不该信。
 */
export interface MethodClassification {
  method_id: string
  /** 空字符串表示未分类 */
  family_id: string
  reason: string
  /** 支撑本次分类的 evidence_id，已由服务端核实过确属该方法 */
  evidence_ids: string[]
  confidence: number
  provider: string
  model: string
  prompt_version: string
  classified_at: string
}

export interface MethodFamily {
  family_id: string
  name: string
  name_zh: string
  description: string
  color: string
  method_ids: string[]
}

export interface MethodRelation {
  relation_id: string
  source_method: string
  target_method: string
  relation_type: RelationType
  /** 关系描述 */
  description: string
  evidence_ids: string[]
}

/* ------------------------------------------------------------------ */
/* Evolution                                                          */
/* ------------------------------------------------------------------ */

export interface Evolution {
  evolution_id: string
  year: number
  /** 代表方法 */
  method_id: string
  /** 阶段标题 */
  stage_title: string
  /** 技术变化 */
  change: string
  /** 相比前一节点的改进 */
  improvement: string
  /** 该阶段暴露的局限 */
  limitation: string
  evidence_ids: string[]
  /** 与上一节点的关系类型 */
  relation_from_prev: RelationType | null
}

/* ------------------------------------------------------------------ */
/* ResearchGap / ResearchDirection                                    */
/* ------------------------------------------------------------------ */

export interface ResearchGap {
  gap_id: string
  type: GapType
  title: string
  description: string
  /** 已有研究现状 */
  existing_work: string
  /** 当前问题 */
  current_problem: string
  supporting_papers: string[]
  evidence_ids: string[]
  /** 潜在研究价值 */
  potential_value: string
  /** 关联的方法 ID */
  method_ids: string[]
}

export interface ResearchDirection {
  direction_id: string
  title: string
  /** 研究问题 */
  research_question: string
  existing_work: string
  /** 关联空白 ID */
  gap_ids: string[]
  /** 可能方法 */
  possible_method: string[]
  /** 实验设计 */
  experiment_design: string
  /** Baseline */
  baselines: string[]
  /** 评价指标 */
  metrics: string[]
  risk: string
  /** 风险缓解 */
  risk_mitigation: string
  evidence_ids: string[]
  /** 关联论文 */
  paper_ids: string[]
  /** AI 给出的可行性评分 0-100 */
  feasibility: number
  /** AI 给出的新颖性评分 0-100 */
  novelty: number
}

/* ------------------------------------------------------------------ */
/* Project / Pipeline                                                 */
/* ------------------------------------------------------------------ */

export interface Project {
  id: string
  name: string
  subtitle: string
  description: string
  created_at: string
  updated_at: string
  domain: string
  /**
   * 研究目标。会作为 taskHint 传给方法抽取 prompt——
   * 同一篇论文在不同研究目标下，值得抽取的方法是不一样的。
   */
  goal?: string
  /** demo = 内置演示项目；uploaded = 用户自己上传的真实项目 */
  kind?: 'demo' | 'uploaded'
  paper_ids: string[]
}

export interface PipelineStage {
  id: string
  index: number
  name: string
  name_en: string
  description: string
  status: StageStatus
  /** 进度：已完成数 / 总数 */
  progress: { done: number; total: number }
}

export interface LogEntry {
  id: string
  time: string
  message: string
  /** 日志级别，用于着色 */
  level: 'info' | 'success' | 'warn' | 'evidence'
  /** 关联的实体，可点击跳转 */
  ref?: { type: 'paper' | 'method' | 'evidence'; id: string }
}

/* ------------------------------------------------------------------ */
/* 聚合视图                                                            */
/* ------------------------------------------------------------------ */

/** 项目全量知识数据包，所有页面从这里取数 */
export interface KnowledgeBase {
  project: Project
  papers: Paper[]
  methods: Method[]
  families: MethodFamily[]
  relations: MethodRelation[]
  evolutions: Evolution[]
  gaps: ResearchGap[]
  directions: ResearchDirection[]
  evidence: Evidence[]
}

/* ------------------------------------------------------------------ */
/* 数据来源 —— 防止把 Mock 数据当成 AI 产出                             */
/* ------------------------------------------------------------------ */

/**
 * 三条数据的出处，强制标注。
 *
 *   demo         —— 知识库里预置的示例数据（Phase 1 的 Mock）
 *   uploaded     —— 用户上传的原始 PDF 本身
 *   ai_generated —— 由 AI Provider 从 PDF 中抽取的结论（Method / Evidence）
 *
 * 之所以把 'uploaded' 和 'ai_generated' 分开：论文原文是客观材料，
 * 而 AI 抽取结果可能出错，两者的可信度不同，不能混为一谈。
 */
export type SourceType = 'demo' | 'uploaded' | 'ai_generated'
