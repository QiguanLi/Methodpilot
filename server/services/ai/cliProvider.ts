/**
 * CliAIProvider —— 复用本机已授权的模型调用通道。
 *
 * 存在的意义：在没有 API Key 的环境（比如这个沙箱、或评委的离线演示机）里，
 * 仍然能跑通**真实**的 LLM 调用，而不是退回 Mock。
 * 它调用 `codebuddy -p --output-format json`，这是一个带授权的 headless 通道。
 *
 * 明确的边界：
 *   - 只用于本地开发 / 演示；云端没有 CLI 时 isReady() 返回 false，
 *     调用方自动降级，绝不会因此让服务启动失败。
 *   - 关掉全部工具（--tools ""）：模型只需要读文本、吐 JSON，
 *     给它 Bash/Write 权限既没必要也是风险。
 */

import { spawn } from 'node:child_process'
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
  METHOD_EXTRACTION_SCHEMA_JSON,
  METHOD_CLASSIFICATION_SCHEMA_JSON,
  buildMethodExtractionPrompt,
  buildClassificationPrompt,
  buildTranslatePrompt,
  getSystemPrompt,
  getClassifySystemPrompt,
  TRANSLATE_SYSTEM,
} from './prompt.ts'
import { extractJson } from './httpProvider.ts'

interface CliEnvelope {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
}

let cachedAvailability: { ready: boolean; reason: string } | null = null

export class CliAIProvider implements AIProvider {
  readonly name = 'cli'
  readonly model: string
  // 不用"构造函数参数属性"：Node 的 --experimental-strip-types 不做代码生成，会报错
  private readonly bin: string

  constructor(bin = config.ai.cliBin, model = config.ai.cliModel) {
    this.bin = bin
    this.model = model
  }

  async isReady(): Promise<{ ready: boolean; reason: string }> {
    if (cachedAvailability) return cachedAvailability
    cachedAvailability = await new Promise((resolve) => {
      let child
      try {
        child = spawn(this.bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch {
        resolve({ ready: false, reason: `未找到可执行文件 ${this.bin}` })
        return
      }
      let out = ''
      child.stdout.on('data', (d) => {
        out += String(d)
      })
      child.on('error', () => resolve({ ready: false, reason: `未找到可执行文件 ${this.bin}` }))
      child.on('close', (code) =>
        resolve(
          code === 0
            ? { ready: true, reason: '' }
            : { ready: false, reason: `${this.bin} 不可用: ${out.slice(0, 120)}` },
        ),
      )
      setTimeout(() => child.kill('SIGKILL'), 15_000)
    })
    return cachedAvailability
  }

  /* ---------------------------------------------------------------- */

  private run(prompt: string, systemPrompt: string, jsonSchema?: string): Promise<CliEnvelope> {
    return new Promise((resolve, reject) => {
      const args = [
        '-p',
        '--tools',
        '', // 关闭所有工具：只要它读文本、回 JSON
        '--output-format',
        'json',
        '--model',
        this.model,
        '--system-prompt',
        systemPrompt,
      ]
      if (jsonSchema) args.push('--json-schema', jsonSchema)
      args.push(prompt)

      let child
      try {
        child = spawn(this.bin, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        })
      } catch (e) {
        reject(new AIUnavailableError(`无法启动 ${this.bin}: ${(e as Error).message}`))
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new AIUnavailableError(`CLI 调用超时（${config.ai.cliTimeoutMs}ms）`))
      }, config.ai.cliTimeoutMs)

      child.stdout.on('data', (d) => {
        stdout += String(d)
      })
      child.stderr.on('data', (d) => {
        stderr += String(d)
      })
      child.on('error', (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new AIUnavailableError(`CLI 进程错误: ${e.message}`))
      })
      child.on('close', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)

        const text = stdout.trim()
        if (!text) {
          reject(new AIUnavailableError(`CLI 无输出: ${stderr.slice(0, 300)}`))
          return
        }

        // --output-format json 返回一个数组，取其中 type=result 的元素
        const parsed = extractJson(text)
        const arr = Array.isArray(parsed) ? parsed : [parsed]
        const result = (arr as CliEnvelope[]).find((x) => x?.type === 'result') ?? (arr[0] as CliEnvelope)
        if (!result) {
          reject(new AIFormatError('CLI 输出缺少 result 字段', text.slice(0, 400)))
          return
        }
        if (result.is_error) {
          reject(new AIUnavailableError(`CLI 返回错误: ${String(result.result).slice(0, 300)}`))
          return
        }
        resolve(result)
      })
    })
  }

  /* ---------------------------------------------------------------- */

  async extractMethods(input: MethodExtractionInput): Promise<AIResult<import('../../types.ts').LLMMethodExtraction>> {
    const ready = await this.isReady()
    if (!ready.ready) throw new AIUnavailableError(ready.reason)

    const env = await this.run(
      buildMethodExtractionPrompt(input),
      getSystemPrompt(),
      METHOD_EXTRACTION_SCHEMA_JSON,
    )

    const text = env.result ?? ''
    const parsed = extractJson(text)
    if (!parsed) throw new AIFormatError('无法从 CLI 输出中解析 JSON', text.slice(0, 500))

    // CLI 通道的 JSON Schema 只作提示（模型可能把结果裹在解释里），
    // 所以这里再做一次形状检查，形状不对就当格式错误交给上层重试。
    const obj = parsed as Record<string, unknown>
    if (!Array.isArray(obj.methods)) {
      throw new AIFormatError('CLI 输出缺少顶层 methods 数组', text.slice(0, 500))
    }

    return {
      data: obj as unknown as import('../../types.ts').LLMMethodExtraction,
      usage: {
        inputTokens: env.usage?.input_tokens ?? 0,
        outputTokens: env.usage?.output_tokens ?? 0,
        costUsd: null,
      },
      provider: this.name,
      model: this.model,
      raw: text,
    }
  }

  /**
   * 阶段③ 方法分类。
   *
   * 与抽取分开成一次独立调用，而不是塞进抽取 prompt 里。
   * 理由是两件事的输入根本不同：抽取要读全文、要防跨页拼接；
   * 分类只该看"已校验的证据"，不该再看原文。合在一起会让模型
   * 有机会绕开证据、凭对论文的整体印象分类，reason 就失去可核性。
   */
  async classifyMethods(
    input: MethodClassificationInput,
  ): Promise<AIResult<LLMClassificationResult>> {
    const ready = await this.isReady()
    if (!ready.ready) throw new AIUnavailableError(ready.reason)

    const env = await this.run(
      buildClassificationPrompt(input),
      getClassifySystemPrompt(),
      METHOD_CLASSIFICATION_SCHEMA_JSON,
    )

    const text = env.result ?? ''
    const parsed = extractJson(text)
    if (!parsed) throw new AIFormatError('无法从 CLI 输出中解析 JSON', text.slice(0, 500))

    // CLI 通道的 --json-schema 只是提示而非强制，所以这里做形状检查。
    // 形状不对就当格式错误，让上层决定重试，而不是替模型"修好"。
    const obj = parsed as Record<string, unknown>
    if (!Array.isArray(obj.classifications)) {
      throw new AIFormatError('CLI 输出缺少顶层 classifications 数组', text.slice(0, 500))
    }

    return {
      data: obj as unknown as LLMClassificationResult,
      usage: {
        inputTokens: env.usage?.input_tokens ?? 0,
        outputTokens: env.usage?.output_tokens ?? 0,
        costUsd: null,
      },
      provider: this.name,
      model: this.model,
      raw: text,
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

    const env = await this.run(buildTranslatePrompt(quotes), TRANSLATE_SYSTEM)
    const text = env.result ?? ''
    const parsed = extractJson(text)
    const arr = Array.isArray(parsed) ? (parsed as unknown[]) : []

    return {
      data: quotes.map((_, i) => (typeof arr[i] === 'string' ? String(arr[i]) : '')),
      usage: {
        inputTokens: env.usage?.input_tokens ?? 0,
        outputTokens: env.usage?.output_tokens ?? 0,
        costUsd: null,
      },
      provider: this.name,
      model: this.model,
      raw: text,
    }
  }
}
