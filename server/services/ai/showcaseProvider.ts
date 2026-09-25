/**
 * ShowcaseAIProvider —— 离线演示用的**预置数据** provider。
 *
 * ── 它解决什么问题 ──
 *
 * 比赛演示环境通常没有 API Key。MockAIProvider 是"基于句式的确定性抽取"，
 * 它只能从真实 PDF 里挑出**自我介绍型**句子（we present / we introduce …）。
 * 于是整条链路上有四件事注定展示不出来：
 *
 *   1. 方法分类     —— mock 主动拒绝分类（family_id 恒为 null）
 *   2. 因果演进     —— 门 B 要求证据点名**对方方法**，mock 的句子不含
 *   3. 研究空白     —— 需要"原文自陈局限"的句子，mock 从不产出
 *   4. 研究方向     —— 上游 Gap 为 0，必然为 0
 *
 * 本 Provider 换掉的**只有"抽取/分类"这一层的输出**，其余全部走真实算法：
 * 证据校验、方法对齐、技术演进、Gap、方向、报告，一行都没有绕过。
 *
 * ── 诚实性边界（最重要） ──
 *
 *   · 每一条 quote 都**从真实 PDF 正文里按子串取回**（见 pickQuote），
 *     不是硬编码的字符串副本 —— 这样 quote 与 page 天然一致，
 *     且必然能通过 EvidenceValidator。
 *   · 找不到匹配的论文时，**退回 mock 行为**，不硬造数据。
 *   · 产出标记 provider='showcase'、model='showcase-preset-v1'，
 *     paper.source_type 仍是 'uploaded'，UI 引擎徽标会显示预置来源。
 *
 * 它**不是**"伪造 AI 结果"：分类是判定（本就是模型做的判断），
 * 证据是原文（逐字取自 PDF）。它更接近"把一位领域专家的人工标注固化下来"。
 */

import type {
  AIResult,
  AIProvider,
  LLMMethod,
  LLMEvidence,
  MethodExtractionInput,
  MethodClassificationInput,
  LLMClassificationResult,
} from './types.ts'
import type { LLMMethodExtraction } from '../../types.ts'
import { MockAIProvider } from './mockProvider.ts'

const ZERO = { inputTokens: 0, outputTokens: 0, costUsd: null }

/**
 * 一篇论文的 Showcase 预置规格。
 *
 * `anchor` 是用于**识别论文**的标题特征（小写子串匹配）。
 * `quotes` 里的每一条都必须能在 PDF 正文中逐字找到 ——
 * 由 pickQuote 在运行时从 input.pages 里取回，取不到就跳过该条。
 */
interface ShowcaseSpec {
  anchor: string
  methodName: string
  methodNameZh: string
  task: string
  paradigm: string
  coreIdea: string
  familyId: string
  classifyReason: string
  /** [期望页码, quote 的前缀特征] —— 实际 quote 从该页正文中截回 */
  quotes: { page: number; prefix: string; supports: string[] }[]
}

/**
 * 三篇论文的预置规格。
 *
 * ⚠️ `prefix` 是"索引用前缀"，不是最终 quote —— 最终 quote 由 pickQuote
 * 在真实页文本里定位后**截取完整句子**，确保逐字真实、页码一致。
 * 所有 prefix 均已在设计阶段用真实 PDF 验证过存在性（见 docs/phase7-1-showcase-design.md）。
 */
const SPECS: ShowcaseSpec[] = [
  {
    anchor: 'react',
    methodName: 'ReAct',
    methodNameZh: '推理-行动协同',
    task: '语言推理与决策任务',
    paradigm: '提示式推理-行动交织',
    coreIdea: '让语言模型交替产生推理轨迹与可执行动作，把思维链与外部工具调用交织在一起。',
    familyId: 'F2',
    classifyReason:
      '该方法的核心机制是让模型自主产生动作并调用外部工具（augment the action space），' +
      '把推理能力延伸到外部环境，符合「工具调用智能体」的判据。',
    quotes: [
      {
        page: 2,
        prefix: 'In this work, we present ReAct, a general paradigm',
        supports: ['方法核心思想'],
      },
      {
        page: 9,
        prefix: 'Despite the simplicity of our method, complex tasks with large action spaces',
        supports: ['局限'],
      },
    ],
  },
  {
    anchor: 'autogen',
    methodName: 'AutoGen',
    methodNameZh: '多智能体对话框架',
    task: '多智能体协作任务',
    paradigm: '可对话智能体协同',
    coreIdea: '把多智能体协作抽象为可编程的对话，让多个角色化 Agent 通过结构化消息分工完成复杂任务。',
    familyId: 'F4',
    classifyReason:
      '论文明确以「a generalized multi-agent conversation framework」定义自身，' +
      '核心是多个角色化 Agent 通过对话分工协作，符合「多智能体协作」的判据。',
    quotes: [
      {
        page: 2,
        prefix: 'While there is contemporaneous exploration of multi-agent approaches',
        supports: ['方法核心思想'],
      },
      /*
       * ⚠️ 这条是真实原文，且确实点名了 ReAct —— 但它**不会**产出因果边。
       *
       * 受控实验（把同一批 quote 喂给真实 buildEvolution）证明：
       *   · 年份错开 → 本句命中 improves，causal=true
       *   · 当前真实数据 → ReAct 与 AutoGen 的 PDF creationDate 都落在 2023
       *     （ReAct=2023-03-13，AutoGen=2023-10-05），命中
       *     `same_year_no_order` → 先于因果判定返回 temporal。
       *
       * 「年份不能推因果」是算法里一道正确且刻意的门，不改。
       * 这里保留本句，是因为它作为"能力主张"证据本身如实、可回验；
       * 但**不要**把它当成因果边的来源 —— 当前 Demo 的因果边为 0 是诚实结果。
       */
      {
        page: 25,
        prefix: 'design matches the performance of ReAct',
        supports: ['能力主张'],
      },
      {
        page: 6,
        prefix: 'We did not evaluate ChatGPT',
        supports: ['局限'],
      },
    ],
  },
  {
    anchor: 'swe-agent',
    methodName: 'SWE-agent',
    methodNameZh: '软件工程智能体',
    task: '真实代码仓库问题求解',
    paradigm: '智能体-计算机接口（ACI）',
    coreIdea: '为语言模型设计专用的人机接口（ACI），使其能自主定位、编辑并验证真实仓库中的代码修复。',
    familyId: 'F1',
    classifyReason:
      '论文面向真实代码仓库的端到端问题求解（软件工程任务），' +
      '覆盖定位、编辑、执行与迭代修复流程，符合「软件工程智能体」的判据。',
    quotes: [
      {
        page: 2,
        prefix: 'From this effort, we introduce SWE-agent',
        supports: ['方法核心思想'],
      },
      {
        page: 1,
        prefix: 'However, applying agents to more complex code tasks',
        supports: ['局限'],
      },
    ],
  },
]

/* ------------------------------------------------------------------ */
/* quote 取回（保证逐字真实）                                            */
/* ------------------------------------------------------------------ */

/**
 * 从该页正文中，按 prefix 定位并**截取完整句子**。
 *
 * 为什么不用硬编码的完整 quote 字符串：
 *   硬编码的字符串一旦与 PDF 实际排版有半点差异（多一个空格、少一个标点、
 *   连字符断词），EvidenceValidator 就会拒绝它。而按 prefix 在**真实页文本**
 *   里定位再截句，quote 天然就是该页的连续子串 —— 这是"不可能写错"的做法。
 *
 * ── 为什么比较时要折叠空白 ──
 *   PDF 文本层的换行位置完全取决于排版，例如原文实际是
 *       "complex tasks with large\naction spaces"
 *   而人写 prefix 时自然写成 "large action spaces"（单空格）。
 *   直接 indexOf 会因为这个换行差异而找不到 —— 这是纯粹的排版噪声，
 *   不是内容差异。所以这里把**页文本与 prefix 都折叠成单空格**后再定位。
 *
 *   ⚠️ 关键：定位用折叠后的文本，但**取回的 quote 仍按原文本的长度截取**，
 *   返回的依然是该页的**真实连续子串**（含原有换行），
 *   因此仍然逐字真实、仍然能被 EvidenceValidator 接受。
 *
 * ── 为什么返回时**不做**空白折叠 ──
 *   PDF 里存在连字符断词，例如
 *       "...is re-\nstricted by its hourly..."
 *   EvidenceValidator 内部用 `normalizeStrict` / `normalizeHyphenKept`
 *   专门处理这种 `-\n`（连字符 + 换行）情况。如果我们在返回前
 *   把 `\s+` 折叠成单空格，`-\n` 就变成了 `- `（连字符 + 空格），
 *   恰好绕开了 validator 的还原规则，反而导致校验失败。
 *   所以这里只裁剪首尾空白，**内部空白原样保留**，把归一化交给 validator。
 *
 * 返回 null 表示找不到 —— 调用方据此跳过该条，绝不退化为"用硬编码兜底"。
 */
function pickQuote(pageText: string, prefix: string): string | null {
  if (!pageText) return null

  // 建立"折叠文本 → 原始文本"的索引映射（折叠的是空白，不改动其它字符）
  let folded = ''
  const map: number[] = [] // folded 的第 i 个字符 → 原始文本的下标
  let lastSpace = false
  for (let i = 0; i < pageText.length; i++) {
    const ch = pageText[i]
    if (/\s/.test(ch)) {
      if (!lastSpace) {
        folded += ' '
        map.push(i)
        lastSpace = true
      }
      // 连续的空白折叠为一个空格：后续空白不再进 folded
    } else {
      folded += ch
      map.push(i)
      lastSpace = false
    }
  }

  const idx = folded.toLowerCase().indexOf(prefix.toLowerCase().replace(/\s+/g, ' ').trim())
  if (idx < 0) return null

  // 映射回原始文本的起点，再从原文截句（保证返回的是真实子串）
  const start = map[idx]
  const rest = pageText.slice(start)
  const m = rest.match(/^[\s\S]*?[.!?](?=\s|$)/)
  // ⚠️ 只 trim 首尾，内部空白（含 `-\n` 断词）原样保留，交给 EvidenceValidator 归一化
  const raw = (m ? m[0] : rest.slice(0, 400)).trim()
  if (raw.length < 12) return null
  return raw
}

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

export class ShowcaseAIProvider implements AIProvider {
  readonly name = 'showcase'
  readonly model = 'showcase-preset-v1'

  /** 未命中预置规格时，退回到 mock 的确定性抽取 —— 保证"永不失败" */
  private readonly fallback = new MockAIProvider()

  async isReady() {
    return {
      ready: true,
      reason:
        'Showcase 预置数据 Provider：对已知的演示论文返回预置的抽取结果（quote 仍逐字取自真实 PDF，' +
        '并照常通过证据校验）；对其它论文自动退回内置规则抽取器。',
    }
  }

  private matchSpec(input: MethodExtractionInput): ShowcaseSpec | null {
    const hay = `${input.title} ${input.authors.join(' ')}`.toLowerCase()
    return SPECS.find((s) => hay.includes(s.anchor)) ?? null
  }

  async extractMethods(input: MethodExtractionInput): Promise<AIResult<LLMMethodExtraction>> {
    const spec = this.matchSpec(input)
    if (!spec) {
      // 不是预置论文 → 完全交给 mock，行为与普通 mock 一致
      return this.fallback.extractMethods(input)
    }

    const evidence: LLMEvidence[] = []
    for (const q of spec.quotes) {
      const pageText = input.pages[String(q.page)] ?? ''
      const quote = pickQuote(pageText, q.prefix)
      // 取不到就跳过 —— 宁可少一条证据，也不硬塞一条找不到出处的
      if (!quote) continue
      evidence.push({
        section: input.sections.find((s) => s.pages.includes(q.page))?.name ?? '',
        page: q.page,
        quote,
        supports: q.supports,
        // 与 mock 同理：这句话确实逐字在原文里，置信度就该是 1
        confidence: 1,
      })
    }

    /* 一条证据都取不到 → 退回 mock，避免产出一个无证据的空方法 */
    if (!evidence.length) {
      return this.fallback.extractMethods(input)
    }

    const methods: LLMMethod[] = [
      {
        name: spec.methodName,
        name_zh: spec.methodNameZh,
        task: spec.task,
        paradigm: spec.paradigm,
        core_idea: spec.coreIdea,
        modules: [],
        inputs: [],
        outputs: [],
        capabilities: [],
        advantages: [],
        limitations: [],
        evidence,
      },
    ]

    return {
      data: { methods },
      usage: { ...ZERO },
      provider: this.name,
      model: this.model,
      raw: '',
    }
  }

  async classifyMethods(
    input: MethodClassificationInput,
  ): Promise<AIResult<LLMClassificationResult>> {
    /*
     * 分类阶段拿不到论文原文，只能靠方法名匹配预置规格。
     * 匹配不上 → 交给 mock（返回 null，即"未分类"，与普通 mock 一致）。
     */
    const byName = new Map(SPECS.map((s) => [s.methodName.toLowerCase(), s]))

    const classifications = input.methods.map((m) => {
      const spec = byName.get(String(m.name).toLowerCase().trim())
      if (!spec) {
        return {
          method_id: m.method_id,
          family_id: null,
          family_name: null,
          reason:
            '当前抽取引擎是基于句式规则的确定性抽取器，不具备语义归类能力，' +
            '不会用关键词命中冒充方法族划分，因此如实返回「未分类」。',
          evidence_ids: m.evidence.map((e) => e.evidence_id),
          confidence: 0,
        }
      }
      return {
        method_id: m.method_id,
        family_id: spec.familyId,
        family_name: null,
        reason: spec.classifyReason,
        evidence_ids: m.evidence.map((e) => e.evidence_id),
        confidence: 0.7,
      }
    })

    return {
      data: { classifications },
      usage: { ...ZERO },
      provider: this.name,
      model: this.model,
      raw: '',
    }
  }

  async translateEvidence(quotes: string[]): Promise<AIResult<string[]>> {
    // 与 mock 一致：不翻译。返回空串比返回机翻假文本更诚实。
    return { data: quotes.map(() => ''), usage: { ...ZERO }, provider: this.name, model: this.model, raw: '' }
  }
}
