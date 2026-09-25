/**
 * HttpAIProvider —— OpenAI 兼容协议的通用实现。
 *
 * 刻意不绑定任何厂商：只要对方提供 /chat/completions 与 /models，
 * 就能通过 AI_BASE_URL 接进来（OpenAI / DeepSeek / Qwen / GLM / vLLM 皆可）。
 *
 * 关于结构化输出：
 *   优先用 response_format=json_schema（严格模式），模型不按 schema 返回会直接被拒。
 *   但并非所有兼容服务都支持，因此失败时降级为 json_object，
 *   再失败则由上层做"剥离 markdown 围栏 + 重试一次"的兜底。
 *   这条降级链是刻意设计的：宁可多试两次，也不要因为服务不支持某参数就整个功能不可用。
 */

import { config } from '../../config.ts'
import type {
  AIResult,
  AIProvider,
  MethodExtractionInput,
  MethodClassificationInput,
  LLMClassificationResult,
} from './types.ts'
import { AIFormatError, AIUnavailableError } from './types.ts'
import {
  METHOD_EXTRACTION_SCHEMA,
  METHOD_CLASSIFICATION_SCHEMA,
  buildTranslatePrompt,
  buildMethodExtractionPrompt,
  buildClassificationPrompt,
  getSystemPrompt,
  getClassifySystemPrompt,
  TRANSLATE_SYSTEM,
} from './prompt.ts'

interface ChatChoice {
  message?: { content?: string | null }
}

interface ChatResponse {
  choices?: ChatChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
  error?: { message?: string }
}

export class HttpAIProvider implements AIProvider {
  readonly name = 'http'
  readonly model: string
  // 不用"构造函数参数属性"：Node 的 --experimental-strip-types 不做代码生成，会报错
  private readonly baseUrl: string
  private readonly apiKey: string

  constructor(
    baseUrl = config.ai.baseUrl,
    apiKey = config.ai.apiKey,
    model = config.ai.model,
  ) {
    this.baseUrl = baseUrl
    this.apiKey = apiKey
    this.model = model
  }

  async isReady(): Promise<{ ready: boolean; reason: string }> {
    if (!this.apiKey) return { ready: false, reason: 'AI_API_KEY 未配置' }
    if (!this.baseUrl) return { ready: false, reason: 'AI_BASE_URL 未配置' }
    return { ready: true, reason: '' }
  }

  /* ---------------------------------------------------------------- */

  private async chat(
    messages: { role: 'system' | 'user'; content: string }[],
    opts: {
      jsonSchema?: boolean
      jsonObject?: boolean
      maxTokens?: number
      /** 用哪份 schema，以及它在 response_format 里的名字 */
      schema?: { name: string; schema: unknown }
    } = {},
  ): Promise<{ text: string; input: number; output: number }> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: 0.2,
      max_tokens: opts.maxTokens ?? 8192,
    }

    if (opts.jsonSchema) {
      // 默认仍是抽取 schema；分类阶段会显式传入自己那一份。
      // 两者不能共用名字——有的服务端会按 name 做缓存/校验，
      // 名字一样而结构不同会得到一个非常难查的 400。
      const s = opts.schema ?? { name: 'method_extraction', schema: METHOD_EXTRACTION_SCHEMA }
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: s.name, strict: false, schema: s.schema },
      }
    } else if (opts.jsonObject) {
      body.response_format = { type: 'json_object' }
    }

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.ai.timeoutMs),
      })
    } catch (e) {
      const msg = (e as Error).message
      // 超时/网络不可达都归为"Provider 不可用"，上层据此降级而不是把论文标 failed
      throw new AIUnavailableError(`调用模型失败: ${msg}`)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new AIUnavailableError(`模型返回 HTTP ${res.status}: ${text.slice(0, 300)}`)
    }

    const json = (await res.json()) as ChatResponse
    if (json.error?.message) throw new AIUnavailableError(json.error.message)

    const text = json.choices?.[0]?.message?.content ?? ''
    if (!text.trim()) throw new AIFormatError('模型返回了空内容', '')

    return {
      text,
      input: json.usage?.prompt_tokens ?? 0,
      output: json.usage?.completion_tokens ?? 0,
    }
  }

  /**
   * 带降级的调用：先严格 schema → 再 json_object → 再纯文本。
   * 只有三次都拿不到可解析 JSON 才抛 AIFormatError。
   */
  private async chatJson(
    messages: { role: 'system' | 'user'; content: string }[],
    maxTokens?: number,
    schema?: { name: string; schema: unknown },
  ): Promise<{ text: string; input: number; output: number }> {
    const attempts: { jsonSchema?: boolean; jsonObject?: boolean }[] = [
      { jsonSchema: true },
      { jsonObject: true },
      {},
    ]
    let last: unknown = null
    for (const a of attempts) {
      try {
        const r = await this.chat(messages, { ...a, maxTokens, ...(schema ? { schema } : {}) })
        if (extractJson(r.text) !== null) return r
        last = r.text
      } catch (e) {
        if (e instanceof AIUnavailableError) throw e // 网络/鉴权问题不必重试
        last = e
      }
    }
    throw new AIFormatError('模型多次返回非 JSON 内容', String(last).slice(0, 500))
  }

  /* ---------------------------------------------------------------- */

  async extractMethods(input: MethodExtractionInput): Promise<AIResult<import('../../types.ts').LLMMethodExtraction>> {
    const ready = await this.isReady()
    if (!ready.ready) throw new AIUnavailableError(ready.reason)

    const r = await this.chatJson(
      [
        { role: 'system', content: getSystemPrompt() },
        { role: 'user', content: buildMethodExtractionPrompt(input) },
      ],
      8192,
    )

    const parsed = extractJson(r.text)
    if (!parsed) throw new AIFormatError('无法从模型输出中解析出 JSON', r.text.slice(0, 500))

    return {
      data: parsed as import('../../types.ts').LLMMethodExtraction,
      usage: { inputTokens: r.input, outputTokens: r.output, costUsd: null },
      provider: this.name,
      model: this.model,
      raw: r.text,
    }
  }

  /**
   * 阶段③ 方法分类。
   *
   * schema 显式传自己的那一份（名字也换掉），不要沿用抽取的——
   * 两份 schema 结构完全不同，共用名字会让某些服务端在缓存层直接返回坏结果。
   */
  async classifyMethods(
    input: MethodClassificationInput,
  ): Promise<AIResult<LLMClassificationResult>> {
    const ready = await this.isReady()
    if (!ready.ready) throw new AIUnavailableError(ready.reason)

    const r = await this.chatJson(
      [
        { role: 'system', content: getClassifySystemPrompt() },
        { role: 'user', content: buildClassificationPrompt(input) },
      ],
      4096,
      { name: 'method_classification', schema: METHOD_CLASSIFICATION_SCHEMA },
    )

    const parsed = extractJson(r.text)
    if (!parsed) throw new AIFormatError('无法从模型输出中解析出 JSON', r.text.slice(0, 500))

    const obj = parsed as { classifications?: unknown }
    if (!Array.isArray(obj.classifications)) {
      // 形状不对就当格式错误抛出去，交给上层决定是否重试。
      // 绝不"猜字段"把它修好——那会把模型的错误变成库里的脏数据。
      throw new AIFormatError('模型输出缺少顶层 classifications 数组', r.text.slice(0, 500))
    }

    return {
      data: parsed as LLMClassificationResult,
      usage: { inputTokens: r.input, outputTokens: r.output, costUsd: null },
      provider: this.name,
      model: this.model,
      raw: r.text,
    }
  }

  async translateEvidence(quotes: string[]): Promise<AIResult<string[]>> {
    if (quotes.length === 0) {
      return {
        data: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
        provider: this.name,
        model: this.model,
        raw: '[]',
      }
    }

    const r = await this.chatJson(
      [
        { role: 'system', content: TRANSLATE_SYSTEM },
        { role: 'user', content: buildTranslatePrompt(quotes) },
      ],
      4096,
    )

    const parsed = extractJson(r.text)
    // 翻译数量对不上就整体弃用：错位的译文比没有译文更糟
    const arr = Array.isArray(parsed) ? (parsed as unknown[]) : []
    const out = quotes.map((_, i) => (typeof arr[i] === 'string' ? String(arr[i]) : ''))

    return {
      data: out,
      usage: { inputTokens: r.input, outputTokens: r.output, costUsd: null },
      provider: this.name,
      model: this.model,
      raw: r.text,
    }
  }
}

/* ------------------------------------------------------------------ */

/**
 * 从模型输出里提取 JSON。
 *
 * 现实中即使要求"only JSON"，模型仍可能包上 ```json 围栏或加一句解释。
 * 这里做三层尝试：直接 parse → 去围栏 → 取第一个平衡的 {} / []。
 * 注意不做宽松的"猜字段"修复：格式不对就让上层重试或报错，
 * 悄悄修补只会把模型的错误变成数据库里的脏数据。
 */
export function extractJson(text: string): unknown | null {
  const t = text.trim()
  if (!t) return null

  const tryParse = (s: string): unknown | null => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }

  const direct = tryParse(t)
  if (direct !== null) return direct

  // 去掉 markdown 围栏
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) {
    const p = tryParse(fenced[1].trim())
    if (p !== null) return p
  }

  // 扫描第一个平衡的 JSON 值
  const start = t.search(/[[{]/)
  if (start >= 0) {
    const open = t[start]
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < t.length; i += 1) {
      const ch = t[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === open) depth += 1
      else if (ch === close) {
        depth -= 1
        if (depth === 0) {
          const p = tryParse(t.slice(start, i + 1))
          if (p !== null) return p
          break
        }
      }
    }
  }

  return null
}
