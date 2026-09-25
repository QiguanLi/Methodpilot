/**
 * AIProvider 抽象。
 *
 * 页面与路由只依赖这个接口，永远不知道背后是 Mock、HTTP 还是 CLI。
 * 这样"换模型"就退化成"改一个环境变量"，而不是改业务代码。
 */

import type { LLMMethodExtraction } from '../../types.ts'
import type { ClassifyPromptMethod } from './prompt.ts'

export interface MethodExtractionInput {
  title: string
  authors: string[]
  year: number
  abstract: string
  /** 章节名 → 正文。保留章节名是为了让模型能填 section 字段 */
  sections: { name: string; page: number; pages: number[]; content: string }[]
  /** 页码 → 该页全文。Evidence 校验的比对基准 */
  pages: Record<string, string>
  taskHint?: string
}

/**
 * 分类阶段的输入。
 *
 * 注意它**不含论文原文**：分类只允许基于"已经通过校验的证据"，
 * 所以输入就是方法画像 + 那些证据。见 prompt.ts 里 buildClassificationPrompt 的注释。
 */
export interface MethodClassificationInput {
  title: string
  methods: ClassifyPromptMethod[]
}

/** 模型返回的单条分类结果（未经服务端归一化） */
export interface LLMClassification {
  method_id: string
  /** null 表示模型判定"无法可靠分类"——这是合法答案，不是错误 */
  family_id: string | null
  family_name?: string | null
  reason: string
  /** 必须有；服务端会再校验这些 id 是否真的属于该方法的既有证据 */
  evidence_ids: string[]
  confidence: number
}

export interface LLMClassificationResult {
  classifications: LLMClassification[]
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** 未知时为 null，绝不用 0 冒充"免费" */
  costUsd: number | null
}

export interface AIResult<T> {
  data: T
  usage: TokenUsage
  provider: string
  model: string
  /** 原始返回文本，出问题时便于排查，不返回给浏览器 */
  raw: string
}

export interface AIProvider {
  readonly name: string
  readonly model: string

  /** 该方法是否真的可用（缺 key / 缺 CLI 时为 false，调用方据此降级） */
  isReady(): Promise<{ ready: boolean; reason: string }>

  extractMethods(input: MethodExtractionInput): Promise<AIResult<LLMMethodExtraction>>

  /**
   * 阶段③：把**已通过证据校验**的 Method 归入方法族。
   *
   * 契约要点：
   *   1. 只允许返回给定的 5 个 family_id 之一，或 `null`；
   *   2. reason 必须基于输入里给出的证据，而不是模型对这类工作的先验印象；
   *   3. evidence_ids 必须取自该方法的既有证据（服务端会再核一遍）。
   *
   * 返回 `family_id: null` 是**合法且被鼓励**的答案——证据不足以判断时必须返回它，
   * 不允许为了"每个方法都有归类"而强行选一个族。
   * provider 如果压根没有分类能力（例如 mock），必须全部返回 null 并在 reason 里说明。
   */
  classifyMethods(input: MethodClassificationInput): Promise<AIResult<LLMClassificationResult>>

  /** 把一段英文原文译成中文。失败不应导致 evidence 作废 */
  translateEvidence(quotes: string[]): Promise<AIResult<string[]>>
}

export class AIUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AIUnavailableError'
  }
}

export class AIFormatError extends Error {
  // 不用"构造函数参数属性"：Node 的 --experimental-strip-types 不做代码生成，会报错
  readonly raw: string
  constructor(message: string, raw: string) {
    super(message)
    this.name = 'AIFormatError'
    this.raw = raw
  }
}
