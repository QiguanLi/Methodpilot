/**
 * Mock Provider —— 保证服务永远能起来，且绝不撒谎。
 *
 * 存在意义有两层：
 *   1. 工程师本地开发时不用配 key 也能跑通链路；
 *   2. 评委会在没有 API key 的机器上点开页面——那时服务必须还能演示，
 *      但**必须明确告诉用户这是模拟数据**，而不是拿假数据冒充 AI 抽取。
 *
 * 所以这个 provider 的行为是：读取真实的 PDF 解析结果（章节、页码都是真的），
 * 但方法名和证据文本是**从真实原文里摘出来的**——它不编造句子。
 * 这样即便在 Mock 模式下，证据链上显示的原文也确实是论文里的话，
 * 只是"选哪几句、归纳成什么方法"这一步是规则而非模型完成的。
 *
 * 这条设计事后看很值得：Mock 模式下证据校验**同样会跑**，
 * 且因为它摘的是真实句子，校验一定能过。这反过来验证了校验器没有误杀。
 */

import type {
  AIProvider,
  AIResult,
  MethodExtractionInput,
  MethodClassificationInput,
  LLMClassificationResult,
  TokenUsage,
} from './types.ts'
import type { LLMMethodExtraction, LLMMethod, LLMEvidence } from '../../types.ts'

const ZERO: TokenUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }

/**
 * 不该从里面摘证据的章节。
 *
 * 这一条是真实测试逼出来的：References 里满是
 * "Least-to-most prompting enables complex reasoning in large language models, 2022."
 * 这种句子——它含 "reasoning" 和 "models"，会被朴素关键词规则打成高分，
 * 于是被摘成"方法核心思想"的证据。**页码和原文都是真的**，
 * 校验器会欣然放行（它确实在那页上），但作为证据毫无意义：
 * 那是别人的论文标题，不是这篇论文的方法。
 *
 * 这说明一件事：证据校验能保证"这句话真实存在"，
 * 但保证不了"这句话相关"。后者需要语料层面的前置过滤——就在这里做。
 *
 * 注意这里只用它做**整页排除**，不用它做"哪些页是方法章节"的正向判断。
 */
const EXCLUDED_SECTION =
  /(^(references|bibliography|acknowledg|appendix|supplement)|related work|limitations|ethics|reproducib|checklist)/i

/** 引用条目特征：作者年份结尾、et al.、arXiv、纯条目 */
const CITATION_LIKE =
  /(et al\.|arxiv:|doi:|https?:\/\/|,\s*(19|20)\d{2}\.\s*$|^\[\d+\]|^\d+\.\s*[A-Z][a-z]+,)/i

/** 附录里的原始日志特征：ReAct 论文附录整页是 prompt 与失败案例记录 */
const LOG_LIKE = /(^Failure:|^Success:|^Question:|^Thought \d|^Observation \d|^Action \d|^Act \d)/i

/**
 * 页码/页脚残留：PDF 文本层里，页码和脚注会和正文挤在同一"行"上，
 * 例如 `...or arithmetic reasoning ("1844 < 1989"), guide\n2We find more examples...`
 * 其中 `2` 是页码、后面是脚注。摘句子时必须在这里断开，
 * 否则 quote 会尾巴上挂着 `2We find more examples do not improve performance.`，
 * 虽然仍能通过子串校验（它确实是原文的一部分），但作为"证据"读起来是坏的。
 *
 * 这个 case 是真实测试中发现的，不是设想的。
 */
const PAGE_NUMBER_LEAK = /\u000a?\s*\d{1,3}\s*(?=[A-Z])/
/** 脚注/页眉常见开头，命中即从此处截断 */
const FOOTNOTE_START = /\u000a?\s*\d{1,3}(?:See|We |The |In |This |Our |It |Note)/

/**
 * 句子切分。
 *
 * 做三件事，缺一不可：
 *   1. 把 PDF 硬换行压成空格（否则句子被切成碎片）；
 *   2. 在页码/脚注泄漏处截断；
 *   3. 在句末标点处切分。
 * 顺序不能换：先截断再切分，否则截断点会被当成句子边界。
 */
function splitSentences(text: Record<string, string>): { text: string; page: number }[] {
  const out: { text: string; page: number }[] = []
  for (const [pageStr, pageText] of Object.entries(text)) {
    const page = Number(pageStr)
    let flat = pageText.replace(/\u000a/g, ' ').replace(/\s+/g, ' ')

    // 2. 先去脚注（更严格），再去页码
    const fn = FOOTNOTE_START.exec(flat)
    if (fn) flat = flat.slice(0, fn.index)
    const pn = PAGE_NUMBER_LEAK.exec(flat)
    if (pn) flat = flat.slice(0, pn.index)

    for (const raw of flat.split(/(?<=[.!?])\s+/)) {
      const s = raw.trim()
      if (s.length >= 60 && s.length <= 420) out.push({ text: s, page })
    }
  }
  return out
}

/**
 * "方法陈述句"的特征。
 *
 * 这一版是踩过两次坑之后重写的，记一下为什么：
 *
 * 第一版用 `we use` / `our method` 之类宽泛动词，结果从结果表和基线描述里
 * 摘出了 "With PaLM-8/62B, prompting ReAct performs worst among four methods..."——
 * 它在讲**实验结果**，不是方法本身。
 *
 * 第二版加了"必须在方法类章节里"的正向要求，结果 0 命中：
 * 这篇论文的方法定义其实写在 INTRODUCTION 里，而 INTRODUCTION 不含 method/model 字样。
 * 教训是——**章节名不可靠，句子本身才可靠**。
 *
 * 所以现在只认真正的"提出/定义"句式，不看章节名。
 */
const METHOD_STATEMENT = [
  /\bwe (propose|present|introduce|develop|design|devise|describe|formalize)\b/i,
  /\b(our|the proposed) (method|approach|framework|model|system|agent|algorithm)\b/i,
  /\bwe (interleave|combine|augment|equip|extend)\b/i,
  /\b(named|called|referred to as)\b/i,
  /\bprompts? (\w+ )?(llms?|language models?|models?) to\b/i,
  /\bin an interleaved manner\b/i,
]

/**
 * 明确**不是**方法陈述的句式。
 *
 * 这里每一条都来自真实误摘：
 *   - `four methods` / `performs worst` → 结果对比句
 *   - `baselines, we use BUTLER (Shridhar et al., 2020b)` → 基线描述，不是本文方法
 *   - `Figure 3 shows` / `Table 2` → 图表引用
 */
const NOT_METHOD_STATEMENT =
  /(performs? (worst|best|better)|four methods|three methods|baselines?,? we use|et al\.|arxiv|https?:\/\/|figure \d|table \d|appendix|we thank|this paper is organized|in this section we (review|describe the))/i

export class MockAIProvider implements AIProvider {
  readonly name = 'mock'
  /**
   * 这个字符串会原样落进 `paper.analyzed_with.model` 并显示在 UI 上。
   *
   * 命名为 "deterministic-rule-based-extractor-v1" 而不是含糊的
   * "mock-extractor-v1"，是刻意的冗余：即便有人把 provider 字段看漏了，
   * 光看 model 这一栏也不可能把它误读成"某个真实大模型"。
   * 这个 Provider 做的是**基于句式规则的确定性抽取**——
   * 它从真实 PDF 里挑出真实句子，但它没有调用任何模型。
   */
  readonly model = 'deterministic-rule-based-extractor-v1'

  async isReady() {
    return {
      ready: true,
      reason:
        '内置确定性抽取器（基于句式规则，从真实 PDF 中挑选原句）始终可用。' +
        '它不调用任何大模型，产出会标记为「非 AI 抽取」，绝不冒充 LIVE 结果。',
    }
  }

  async extractMethods(input: MethodExtractionInput): Promise<AIResult<LLMMethodExtraction>> {
    // 只按"这一页是否属于参考文献/附录"来排除整页，**不看章节名判断是否是方法章节**——
    // 理由见上方 METHOD_STATEMENT 的注释：章节名不可靠，句子本身才可靠。
    const bannedPages = new Set<number>()
    for (const s of input.sections) {
      if (EXCLUDED_SECTION.test(s.name.trim())) {
        for (const p of s.pages) bannedPages.add(p)
      }
    }

    const candidates = splitSentences(input.pages).filter((c) => !bannedPages.has(c.page))

    const scored = candidates
      .map((c) => {
        const t = c.text
        // 命中任一"方法陈述"句式才算候选，否则直接 0 分（不做部分给分）
        const statementHits = METHOD_STATEMENT.filter((re) => re.test(t)).length
        if (statementHits === 0) return { ...c, score: 0 }

        // 越靠前的章节越可能是方法定义，给一点位置偏好；
        // 但**只作为排序权重**，不参与是否入选的判定
        const early = c.page <= 6 ? 1 : 0
        return {
          ...c,
          score: statementHits * 3 + early - (NOT_METHOD_STATEMENT.test(t) ? 6 : 0)
            - (CITATION_LIKE.test(t) ? 8 : 0) - (LOG_LIKE.test(t) ? 8 : 0),
        }
      })
      // 只要求"命中至少一条方法陈述句式且没被扣成负分"。
      // 门槛刻意定得低：Mock 模式的价值在于把链路跑通并让证据可核验，
      // 不在于挑得多准——挑得准是真实 LLM 的职责。
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || a.page - b.page)

    const evidence: LLMEvidence[] = scored.slice(0, 4).map((c) => ({
      section: sectionForPage(input.sections, c.page),
      page: c.page,
      quote: c.text,
      supports: ['方法核心思想'],
      // Mock 的 confidence 故意写 1.0：这句话确实是原文里的原句，
      // 不是"模型觉得像"。混淆这两者会让 confidence 失去意义。
      confidence: 1,
    }))

    const title = input.title || '未命名论文'
    const methods: LLMMethod[] = evidence.length
      ? [
          {
            name: `${title.split(/[:—-]/)[0].trim().slice(0, 60) || 'Proposed Method'}`,
            name_zh: '',
            task: '',
            paradigm: '',
            /*
             * ⚠️ 这里**不能**写免责声明。
             *
             * 原先是把「【Mock 模式】以上证据句由规则从论文原文中摘取…」这段
             * 塞进 core_idea。问题在于 core_idea 是**方法的语义字段**——
             * 前端会把它当"这篇论文讲的核心思想"直接渲染在方法地图的
             * 「核心思想」卡片里、技术演进的「技术变化」区块里。
             *
             * 于是真实项目页面上就出现了这样一幕：用户点开自己的论文，
             * 看到"核心思想：【Mock 模式】…"。他会以为系统拿假数据糊弄他，
             * 而实际上证据句确实是论文原文——真正的问题只是**这一段放错了字段**。
             *
             * 免责义务由别处承担，且已经有更好的载体：
             *   · paper.analyzed_with.provider / model —— 方法地图的引擎徽标读它，
             *     显示「内置规则引擎抽取（未调用大模型）」
             *   · 证据本身 —— 逐字逐句来自真实 PDF，且经过子串回验
             * 所以这里如实留空：没跑过归纳，就不编一段"核心思想"出来。
             */
            core_idea: '',
            modules: [],
            inputs: [],
            outputs: [],
            capabilities: [],
            advantages: [],
            limitations: [],
            evidence,
          },
        ]
      : []

    return {
      data: { methods },
      usage: { ...ZERO },
      provider: this.name,
      model: this.model,
      raw: '',
    }
  }

  /**
   * 阶段③ 方法分类 —— 这个 provider **不做分类**，全部返回 null。
   *
   * 为什么宁可"什么都不做"也不做关键词分类：
   *   规则引擎完全有能力写几条正则，比如正文里出现 "multi-agent" 就丢进 F4、
   *   出现 "tool" 就丢进 F2。那会让 Demo 看起来更"完整"。
   *   但那是**编造分类**：正则命中一个词，和"这篇论文的方法真的属于这个族"
   *   是两件事。而界面上二者看起来一模一样——都是「F2 工具调用智能体」。
   *
   *   这条底线在阶段③尤其重要，因为分类是**结论性**的：
   *   一旦方法被贴上族标签，用户就会拿它当已有知识去用。
   *   宁可整列显示「未分类」，也不能让规则命中冒充语义归类。
   *
   * 所以这里返回的每一条都是 family_id=null + 一句说明为什么没有分类。
   * reason 不是空串——空的 reason 在界面上和"没跑过"无法区分。
   */
  async classifyMethods(
    input: MethodClassificationInput,
  ): Promise<AIResult<LLMClassificationResult>> {
    return {
      data: {
        classifications: input.methods.map((m) => ({
          method_id: m.method_id,
          family_id: null,
          family_name: null,
          /*
           * 这一段会被前端渲染在「未归类原因」标题下。
           *
           * 所以文案要写成**原因**，而不是一段 provider 免责声明——
           * 读者是在问"这个方法为什么没有族"，直接回答这个问题即可。
           * 原先是「【Mock 模式】本 Provider 是…」，像在解释系统架构，
           * 而不是解释这一条判定。
           */
          reason:
            '当前抽取引擎是基于句式规则的确定性抽取器，不具备语义归类能力，' +
            '不会用关键词命中冒充方法族划分，因此如实返回「未分类」。' +
            '配置 AI_API_KEY / AI_BASE_URL（或切换到 CLI Provider）后可获得真实的 LLM 分类结果。',
          // 证据如实带上——它们确实是该方法的证据，只是不足以支撑任何分类
          evidence_ids: m.evidence.map((e) => e.evidence_id),
          confidence: 0,
        })),
      },
      usage: { ...ZERO },
      provider: this.name,
      model: this.model,
      raw: '',
    }
  }

  async translateEvidence(quotes: string[]): Promise<AIResult<string[]>> {
    // Mock 模式不做翻译：返回空串比返回机翻假文本更诚实
    return {
      data: quotes.map(() => ''),
      usage: { ...ZERO },
      provider: this.name,
      model: this.model,
      raw: '',
    }
  }
}

function sectionForPage(
  sections: { name: string; pages: number[] }[],
  page: number,
): string {
  const hit = sections.find((s) => s.pages.includes(page))
  return hit ? hit.name : ''
}
