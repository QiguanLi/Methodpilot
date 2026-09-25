/**
 * 论文相关性打分（Phase 3B-4）。
 *
 * 设计基调：**可解释 > 聪明**。
 *
 * 这里是一个朴素的词面匹配器，不是语义模型。它回答的问题是
 * 「用户这句话里的检索词，这篇论文覆盖了多少」——而不是
 * 「这篇论文在多大程度上是用户想要的」。前者可以算准、可以复述、
 * 可以在界面上如实标注；后者需要模型，而且算错了用户看不出来。
 *
 * 为什么单独成一个模块：
 *   它必须是**纯函数**——不读 config、不发请求、不碰文件。
 *   这样测试能直接跑它，不必启动服务、不必联网，
 *   也不必因为这个模块的失败去怀疑"是不是网络又挂了"。
 *   本项目的 S2 provider 会 import config.ts，测试起来要连带环境，
 *   所以打分逻辑不能塞在 provider 里面。
 */

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/** 参与打分的论文侧文本。字段与 NormalizedPaper 的前几项同形，便于直接传入 */
export interface RelevanceInput {
  title: string
  abstract: string
  /** 附加文本（论文自带关键词 / venue 等）。可选 */
  keywords?: string[]
}

export interface RelevanceScore {
  /** 0–100 的整数百分比。**界面直接显示它** */
  percent: number
  /** 0–1 的原始比率。测试断言用它，避免被取整误导 */
  ratio: number
  /**
   * 命中的检索词。
   *
   * 本阶段只算、不在界面展示，但它不是多余的：
   * 有了它，用户问"为什么这篇只有 67%"时能答出"因为 Tool Use 没命中"，
   * 而不是只能说"算法算的"。下一阶段要做分数解释时直接用得上。
   */
  matched: string[]
}

/* ------------------------------------------------------------------ */
/* 文本归一化                                                          */
/* ------------------------------------------------------------------ */

/**
 * 归一化一段文本用于匹配。
 *
 * 与 queryParser 的清洗口径保持一致（同样把非 `\w`/汉字换成空格），
 * 这样「Tool-Use」「tool use」「Tool Use」三者能被视为同一个词
 * —— 否则连字符和空格的区别会造成漏命中，而且不会报错。
 */
function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 英文名词的单复数归并。
 *
 * 为什么必须做：论文标题里 "Software Engineering **Agents**" 是复数
 * 几乎是常态，而用户输入/检索词是单数 "Software Engineering Agent"。
 * 不做归并的话它们互相匹配不上——一篇标题就写着这个词的论文会得 0 分，
 * 而且**不报错**。测试里就抓到了这个：最切题的论文只拿到 40%，
 * 并且与一篇完全无关的论文并列 0%，最后靠引用数把无关的排到了前面。
 *
 * 只处理英文最常见的三种复数后缀，**不做完整词形还原**：
 *   - 不做 `-ing`/`-ed` 还原。`planning` 与 `plan` 是不同概念
 *     （"任务规划" vs "计划"），归并会制造假命中。
 *   - 不做不规则复数（papers/people 之类）。收益小，且容易误伤。
 *
 * 规则的保守程度是刻意的：**宁可漏归并，不可错归并**。
 * 漏了只是少加点分，错了会让不相关的论文排在前面——后者严重得多。
 *
 * 长度门槛 4：避免 `is`→`i`、`as`→`a` 这类把短词搅乱的情况。
 */
function singularize(word: string): string {
  if (word.length < 4) return word
  // -ies → -y（studies → study, properties → property）
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y'
  /*
   * -es 只在词干足够长时剥。
   * `-ses`/`-xes`/`-zes`/`-ches`/`-shes` 这些才是真的加 es 变复数；
   * 其余以 es 结尾的词（如 "series"）不该动，故限制前缀模式。
   * 注意判定用的是**去掉 es 之前**的形态。
   */
  if (/(?:s|x|z|ch|sh)es$/.test(word) && word.length >= 5) return word.slice(0, -2)
  // 普通 -s，但排除本身就是 s 结尾的单数词（再剥会误伤）
  if (/[^s]s$/.test(word)) return word.slice(0, -1)
  return word
}

/**
 * 判断一个 token 是否作为**独立词**出现在文本里。
 *
 * 为什么不能直接用 `text.includes(token)`：
 *   那会让 `plan` 命中 `explanation`、`qa` 命中 `quality`。
 *   这类假阳性**不会报任何错**，只会让分数虚高、排序悄悄错掉——
 *   本项目已经踩过同类的坑（一个被转义写坏的正则静默永不匹配）。
 *
 * 做法是在两侧要求词边界：ASCII 词用 lookaround 判断，汉字没有词边界概念，
 * 直接用相邻字符是否为 ASCII 词字符来判断。CJK 检索词（如「工具调用」）
 * 走分支处理，不能套 `\b`——`\b` 对汉字不成立，会永远匹配不上。
 */
function containsToken(text: string, token: string): boolean {
  if (!token) return false

  if (/[\u4e00-\u9fa5]/.test(token)) {
    // 汉字：直接子串匹配。汉字没有形态变化，不存在 explanation/plan 那种问题
    return text.includes(token)
  }

  /*
   * ASCII 词：要求前后不是词字符。
   * `(?<![a-z0-9])` / `(?![a-z0-9])` —— 用 lookaround 而不是 `\b`，
   * 因为 token 可能以 `-` 结尾（例如 "fine-tuning" 归一化后是 "fine tuning"，
   * 但用户输入里可能带连字符），lookaround 对边界字符的控制更明确。
   */
  const bare = new RegExp(`(?<![a-z0-9])${escapeRe(token)}(?![a-z0-9])`)
  if (bare.test(text)) return true

  /*
   * 单复数归并：原形不中时，再用归并形态试一次。
   * 两侧都归并，保证对称 —— 否则「复数检索词 vs 单数文本」
   * 能命中而反过来的情况命中不了，这种不对称极难排查。
   */
  const sToken = singularize(token)
  const sText = text.split(' ').map(singularize).join(' ')
  if (sToken !== token || sText !== text) {
    const re = new RegExp(`(?<![a-z0-9])${escapeRe(sToken)}(?![a-z0-9])`)
    if (re.test(sText)) return true
  }
  return false
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/* ------------------------------------------------------------------ */
/* 打分                                                                */
/* ------------------------------------------------------------------ */

/**
 * 检索词权重。
 *
 * 按长度给权（上限 12）：长词更具体。
 * 「Software Engineering Agent」应该比「Planning」更能决定一篇论文是否切题——
 * 前者命中了几乎可以肯定找对了方向，后者命中说明不了什么。
 *
 * 上下限的取舍：截到 12 是为了不让一个超长短语（用户可能整句贴进来）
 * 独占全部分数——那会让"覆盖 1 个长词"和"覆盖 5 个短词"之间失去可比性。
 */
function termWeight(term: string): number {
  return Math.min(normalizeText(term).length, 12)
}

/**
 * 计算一篇论文对一组检索词的相关性。
 *
 * 分数语义 = **匹配覆盖率**：
 *   分母是全部检索词的权重和，分子是这篇论文命中的权重和。
 *   100% 的含义是"用户提到的每个检索词都能在这篇论文里找到"，
 *   而不是"这篇论文有 100% 的概率是用户想要的"。
 *
 * 这个口径是刻意选的：它是**可复述的**。用户看到 67% 能反推出
 * "有三个词，我只覆盖了两个"，于是知道该怎么改查询。
 * 若用批次归一化（最高分记 100%），同一篇论文在不同查询里百分比不同，
 * 用户无法建立任何稳定预期，且"可复现"这个要求就不成立了。
 */
export function computeRelevance(input: RelevanceInput, terms: string[]): RelevanceScore {
  /*
   * 去重：用户可能在不同位置重复同一个词（"找 tool use 的 tool use 论文"），
   * 重复计入分母会让分数被一个词绑架。
   */
  const uniq = [...new Set(terms.map((t) => t.trim()).filter(Boolean))]

  /*
   * 没有检索词时返回 0，**不返回 NaN**。
   *
   * `0/0` 是 NaN，而 NaN 在界面上会渲染成 "NaN%"——
   * 一个看起来像 bug 的输出。这次要显式挡住：
   * 分母为 0 就是"无从计算"，用 0 表示，并且是有限数。
   */
  const totalWeight = uniq.reduce((sum, t) => sum + termWeight(t), 0)
  if (totalWeight === 0) return { percent: 0, ratio: 0, matched: [] }

  const title = normalizeText(input.title)
  const abstract = normalizeText(input.abstract)
  const extra = normalizeText((input.keywords ?? []).join(' '))

  /*
   * 标题权重 3、摘要权重 1。
   *
   * 标题是作者对"这篇论文讲什么"最凝练的表述，摘要则长得多、
   * 且常包含大量背景铺垫（"近年来随着大模型的发展……"）。
   * 不加权的话，一篇摘要里凑巧提到关键词的无关论文
   * 会和标题就写着的论文得分接近。
   *
   * 同一检索词在标题和摘要都命中时**取标题权重，不叠加**：
   * 叠加会让长摘要可刷分，而"在标题里出现"已经是更强的信号了。
   */
  const MULT_TITLE = 3
  const MULT_ABSTRACT = 1

  let hitWeight = 0
  const matched: string[] = []

  for (const term of uniq) {
    /*
     * 一个检索词可能由多个 token 组成（"Software Engineering Agent"）。
     * 要求**全部 token 命中**才算这个词命中，而不是任一 token 命中。
     *
     * 反例说明必要性：若按任一 token 计数，检索词 "AI Coding Agent"
     * 会因为论文里出现了 "agent" 就算命中，于是任何 Agent 类论文
     * 都拿满分——这个词的具体性被完全浪费掉了。
     */
    const tokens = normalizeText(term).split(' ').filter(Boolean)
    if (tokens.length === 0) continue

    const inTitle = tokens.every((tk) => containsToken(title, tk))
    const inAbstract = tokens.every((tk) => containsToken(abstract, tk))
    const inExtra = tokens.every((tk) => containsToken(extra, tk))

    if (!inTitle && !inAbstract && !inExtra) continue

    matched.push(term)
    // 取命中位置里的最高权重，不累加
    const mult = inTitle ? MULT_TITLE : inAbstract || inExtra ? MULT_ABSTRACT : 0
    hitWeight += termWeight(term) * mult
  }

  /*
   * 分母同样要带上标题倍数，否则分子可能大于分母（比率 > 1）。
   *
   * 这是最容易写错的一处：分子按加权算、分母按未加权算，
   * 结果是一篇标题全命中的论文得到 300%，界面上显示"相关性 300%"。
   * 所以分母用「所有词都在标题命中」这一理论上限来归一。
   */
  const maxWeight = totalWeight * MULT_TITLE
  const ratio = maxWeight > 0 ? Math.min(hitWeight / maxWeight, 1) : 0

  return {
    /**
     * 取整用 Math.round。展示上 1% 的精度足够，
     * 且避免 "66.66666666666666%" 这种输出。
     * 注意 ratio 保留全精度，测试断言用 ratio 不受取整影响。
     */
    percent: Math.round(ratio * 100),
    ratio,
    matched,
  }
}

/* ------------------------------------------------------------------ */
/* 排序                                                                */
/* ------------------------------------------------------------------ */

/** 排序所需的最小形状。用泛型约束而不是固定类型，方便测试直接传朴素对象 */
export interface RankablePaper extends RelevanceInput {
  paper_id: string
  citationCount: number
  /** Mock 数据的占位相关度（0–1）。见 rankPapers 的说明 */
  mockRelevance?: number
}

/**
 * 按相关性降序排序，并给每篇附上分数。
 *
 * **稳定性由显式 tie-break 保证**：
 *   分数相同 → 引用数高的在前 → 仍然相同则按 paper_id 字典序。
 *
 * 为什么要显式写出来，而不是依赖 `Array.prototype.sort` 本身稳定：
 *   ES2019 起 sort 确实要求稳定，但"稳定"只保证**相等元素保持输入顺序**——
 *   而输入顺序取决于 S2 返回的顺序，那是个我们控制不了的量。
 *   同一查询两次调用，若 S2 返回顺序变了，并列的论文就会换位，
 *   "同一查询下结果排序稳定"这个要求就破了。
 *   把 tie-break 写进代码，不变量才成立在**我们的**逻辑里。
 */
export function rankPapers<T extends RankablePaper>(
  papers: T[],
  terms: string[],
): (T & { relevance: RelevanceScore })[] {
  const scored = papers.map((p) => {
    /*
     * Mock 数据走另一条路。
     *
     * 原因很实际：Mock 的三篇论文标题与摘要**完全一样**
     * （都写着"示例论文 N（Semantic Scholar 不可达时的占位数据）"），
     * 唯一区别是标题里嵌了查询串。若对它们跑词面匹配，
     * 三篇得分必然相同——于是"排序稳定"成了平凡真，
     * 测试会掩盖 bug 而不是暴露 bug。
     *
     * 所以 Mock 用 mockSearch 预先定好的 mockRelevance：
     * 三篇分数互异、完全 deterministic（无时间、无哈希、无随机），
     * 排序逻辑真的在被检验。
     *
     * 要明确的是：**Mock 的分数不是从文本算出来的**。
     * Mock 的文本与查询本就没有实质关系，硬算只会得到一个
     * 无意义却看起来合理的数字——那比不算是更糟的误导。
     */
    if (typeof p.mockRelevance === 'number' && Number.isFinite(p.mockRelevance)) {
      const r = Math.min(Math.max(p.mockRelevance, 0), 1)
      return { ...p, relevance: { percent: Math.round(r * 100), ratio: r, matched: [] } }
    }
    return { ...p, relevance: computeRelevance(p, terms) }
  })

  return scored.sort((a, b) => {
    if (b.relevance.ratio !== a.relevance.ratio) return b.relevance.ratio - a.relevance.ratio
    // 引用数降序：同为相关时，影响更大的先出
    if (b.citationCount !== a.citationCount) return b.citationCount - a.citationCount
    // 最后的确定性兜底：确保任意输入下顺序都不依赖运行时
    return a.paper_id < b.paper_id ? -1 : a.paper_id > b.paper_id ? 1 : 0
  })
}
