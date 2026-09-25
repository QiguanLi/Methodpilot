/**
 * Provider 注册表 —— 全服务只有这一处决定"用哪个模型"。
 *
 * 为什么要有这一层：业务代码（analysis.ts）不应该知道有几个 provider、
 * 它们各自怎么初始化。它只问一句"给我一个可用的"，拿不到就降级。
 *
 * 三个实现的分工：
 *   mock —— 没有任何外部依赖。用于演示与回归测试，永不失败。
 *           但它产出的数据全部标 source_type='demo'，绝不冒充 AI 结果。
 *   showcase —— 离线比赛演示专用：只把"抽取/分类"这一层换成预置数据，
 *           证据仍逐字取自真实 PDF，其余全部走真实算法。对未知论文退回 mock。
 *   http —— OpenAI 兼容的 /chat/completions。生产用，配 AI_API_KEY + AI_BASE_URL。
 *   cli  —— 调用本机 codebuddy CLI。适合无法出网、但有本地 Agent 环境的情况。
 */

import { createHash } from 'node:crypto'
import { config } from '../../config.ts'
import type { AIProvider } from './types.ts'
import { HttpAIProvider } from './httpProvider.ts'
import { CliAIProvider } from './cliProvider.ts'
import { MockAIProvider } from './mockProvider.ts'
import { ShowcaseAIProvider } from './showcaseProvider.ts'

export const hashFile = (buf: Buffer | Uint8Array): string =>
  createHash('sha256').update(buf).digest('hex')

let cached: AIProvider | null = null

export async function getAIProvider(): Promise<AIProvider> {
  if (cached) return cached

  switch (config.ai.provider) {
    case 'http':
      cached = new HttpAIProvider()
      break
    case 'cli':
      cached = new CliAIProvider()
      break
    case 'showcase':
      cached = new ShowcaseAIProvider()
      break
    default:
      cached = new MockAIProvider()
  }
  return cached
}

/** 健康检查用：不缓存失败结果，允许配置改完后立刻生效 */
export async function probeAIProvider(): Promise<{
  provider: string
  model: string
  ready: boolean
  reason: string
}> {
  const p = await getAIProvider()
  const r = await p.isReady()
  if (!r.ready && config.ai.provider === 'http') cached = null
  return { provider: p.name, model: p.model, ready: r.ready, reason: r.reason }
}

export function resetProviderCache() {
  cached = null
}

export type { AIProvider } from './types.ts'
