/**
 * Semantic Scholar Provider —— 论文元数据的真实来源。
 *
 * ── 为什么需要它 ──
 *
 * 阶段①②③ 处理的是"用户上传的 PDF"。但一篇论文的价值远不止正文：
 * 它引用了谁、被谁引用、在领域里处于什么位置——这些只能从外部文献库拿。
 * 阶段④（技术演进）如果要真的重建演进链，就必须有 references / citations。
 *
 * ── 设计要点 ──
 *
 * 1. **无 Key 也能工作**。Semantic Scholar 的公开 API 允许匿名访问，
 *    只是速率限制更紧。所以这里不做"没 Key 就拒服务"的处理——
 *    评委机器上大概率没有 Key，而演示必须能跑。
 *    有 Key 时自动带上，仅此而已。
 *
 * 2. **统一的归一化输出**。S2 的 search / paper / references / citations
 *    四个接口返回的字段名和嵌套结构并不一致（比如作者在 search 里是
 *    `authors[].name`，在某些响应里还可能缺年份）。全部收敛成一个
 *    NormalizedPaper，让上层（未来的 Agent 页面、演进分析）只认识一种形状。
 *
 * 3. **取不到就走 Mock fallback，且明确标注**。这一点沿用整个项目的规矩：
 *    宁可显示"这是示例数据"，也不能把编造的引用关系当成真实文献网络。
 *    所以 NormalizedPaper 带 `source: 'live' | 'mock'`，调用方必须显式处理。
 *
 * 4. **绝不泄漏 Key**。Key 通过 header 传给 S2，但永远不进任何响应体。
 *    e2e 里有一条断言在查 /api/health 与 /api/config 不含 api_key 字样。
 */

import { config } from '../../config.ts'
import { rankPapers, type RelevanceScore } from '../relevance.ts'

/* ------------------------------------------------------------------ */
/* 归一化输出                                                          */
/* ------------------------------------------------------------------ */

/**
 * 统一论文结构。
 *
 * 字段严格按需求 5：title / authors / year / abstract / url / doi / citationCount。
 * 额外补了 paperId、venue、source —— 前两个是 S2 的定位信息（后续查
 * references 要用 paperId），source 是诚实性标记，都不可省。
 */
export interface NormalizedPaper {
  /** S2 的论文 id（sha 或 DOI:xxx 或 ARXIV:xxx）。Mock 下为合成 id */
  paper_id: string
  title: string
  authors: string[]
  /** 取不到时为 0。**不用当前年份兜底**——那会伪造出一个错的年份 */
  year: number
  abstract: string
  url: string
  doi: string
  citationCount: number
  /** 发表venue，S2 可能为空串 */
  venue: string
  /**
   * 数据来源。
   *   'live' —— 真的来自 Semantic Scholar
   *   'mock' —— fallback 示例数据，**不代表任何真实论文**
   * 调用方必须据此标注界面，不能混用。
   */
  source: 'live' | 'mock'
  /**
   * 相关性分数（Phase 3B-4）。由 rankPapers 附上，搜索路径下必有。
   *
   * 可选是因为 references/citations 路径不排序、不带分数——
   * 那两个接口返回的是引用关系，没有"相关性"这个概念可言。
   */
  relevance?: RelevanceScore
  /**
   * **仅 mock 数据使用**的占位相关度（0–1）。
   *
   * 为什么 mock 需要它：mock 的三篇论文标题与摘要完全一样，
   * 跑词面匹配必然得到三个相同的分数，于是"排序稳定"成了平凡真，
   * 测试会掩盖 bug。用这个预先定好的递减值，排序逻辑才真的被检验。
   *
   * 它**不是**从文本算出来的，也不代表任何真实相关度。
   */
  mockRelevance?: number
}

export interface S2SearchResult {
  papers: NormalizedPaper[]
  total: number
  source: 'live' | 'mock'
  /** 降级原因，live 时为空串 */
  note: string
}

export interface S2GraphResult {
  papers: NormalizedPaper[]
  source: 'live' | 'mock'
  note: string
}

/* ------------------------------------------------------------------ */
/* S2 原始响应形状（只声明我们真正读的字段）                            */
/* ------------------------------------------------------------------ */

interface S2Author {
  authorId?: string | null
  name?: string | null
}

interface S2Paper {
  paperId?: string | null
  title?: string | null
  abstract?: string | null
  year?: number | null
  authors?: S2Author[] | null
  url?: string | null
  venue?: string | null
  citationCount?: number | null
  externalIds?: { DOI?: string | null } | null
  /** references / citations 接口把结果包在 citedPaper / citingPaper 里 */
  citedPaper?: S2Paper | null
  citingPaper?: S2Paper | null
}

interface S2SearchResponse {
  total?: number
  data?: S2Paper[] | null
}

interface S2GraphResponse {
  data?: { citedPaper?: S2Paper | null; citingPaper?: S2Paper | null }[] | null
}

/* ------------------------------------------------------------------ */
/* 字段归一化                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把 S2 的一篇论文收敛成 NormalizedPaper。
 *
 * 这里的每一个 `?? ''` 都是刻意的：S2 经常返回 `"abstract": null`
 * 或干脆没有 year 字段。如果让 undefined 漏到上层，
 * 前端渲染时就会看到 "undefined" 或直接崩在 `.toFixed()` 上。
 * 在边界处一次性抹平，比在每个使用点判空可靠。
 */
export function normalizePaper(p: S2Paper | null | undefined, source: 'live' | 'mock'): NormalizedPaper {
  const s = p ?? {}
  return {
    paper_id: String(s.paperId ?? ''),
    title: String(s.title ?? '').trim(),
    // 作者只取名字；S2 里 name 也可能为 null，过滤掉而不是留下空串占位
    authors: Array.isArray(s.authors)
      ? s.authors.map((a) => String(a?.name ?? '').trim()).filter(Boolean)
      : [],
    // year 为 null / 非数字时给 0，**绝不 fallback 成当前年份**
    year: typeof s.year === 'number' && Number.isFinite(s.year) ? s.year : 0,
    abstract: String(s.abstract ?? '').trim(),
    url: String(s.url ?? '').trim(),
    doi: String(s.externalIds?.DOI ?? '').trim(),
    citationCount: typeof s.citationCount === 'number' && Number.isFinite(s.citationCount) ? s.citationCount : 0,
    venue: String(s.venue ?? '').trim(),
    source,
  }
}

/**
 * references / citations 接口的元素解包。
 *
 * 两个接口的结构是 `{ data: [{ citedPaper: {...} }, ...] }` 和
 * `{ data: [{ citingPaper: {...} }, ...] }`——数组元素**不是**论文本身，
 * 而是一个只含单个键的包装对象。直接当成论文读会得到一堆空对象，
 * 而且不报错。所以这里显式解包，取不到就返回 null 由上层过滤。
 */
function unwrapEdge(edge: { citedPaper?: S2Paper | null; citingPaper?: S2Paper | null } | null | undefined): S2Paper | null {
  if (!edge) return null
  return edge.citedPaper ?? edge.citingPaper ?? null
}

/* ------------------------------------------------------------------ */
/* 请求                                                                */
/* ------------------------------------------------------------------ */

/** 我们要 S2 返回哪些字段。只请求需要的，响应体小得多、也快得多 */
const PAPER_FIELDS = 'paperId,title,abstract,year,authors,url,venue,citationCount,externalIds'

export class S2UnavailableError extends Error {
  readonly status: number
  constructor(message: string, status = 0) {
    super(message)
    this.name = 'S2UnavailableError'
    this.status = status
  }
}

export interface S2RequestOptions {
  /** 网络失败时是否降级到 Mock。默认 true（要求 6） */
  allowMockFallback?: boolean
  signal?: AbortSignal
  /**
   * 年份区间（含两端）。
   *
   * 走 S2 的结构化参数 `year=a-b`，**不是**拼进查询串。
   * 拼进查询串会让"近三年"变成字面匹配 "2024 2025 2026"，
   * 检索结果会退化成"标题或摘要里出现过这四个数字"——
   * 几乎等于搜不到东西，而且错得很隐蔽。
   */
  yearRange?: { from: number; to: number } | null
  /**
   * 用于相关性打分的检索词（Phase 3B-4）。
   *
   * 与 `query` 分开传，因为两者常常不同：`query` 是送给 S2 的检索串
   * （可能已被 Agent 改写成 "Software Engineering Agent Tool Use"），
   * 而打分用的是**解析出的结构化条件**（tasks + methods + keywords）。
   * 不传时退回 `[query]`，这样 `?parse=false` 的直搜路径行为不变。
   */
  terms?: string[]
}

export class SemanticScholarProvider {
  readonly name = 'semantic-scholar'
  // 不用"构造函数参数属性"：Node 的 --experimental-strip-types 不做代码生成，会报错
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number

  constructor(
    baseUrl = config.semanticScholar.baseUrl,
    apiKey = config.semanticScholar.apiKey,
    timeoutMs = config.semanticScholar.timeoutMs,
  ) {
    this.baseUrl = baseUrl
    this.apiKey = apiKey
    this.timeoutMs = timeoutMs
  }

  /**
   * 是否配了 Key。
   *
   * 注意这**不影响可用性**——只影响速率上限与是否有 `x-api-key` 头。
   * 界面上据此显示"已启用 API Key / 匿名访问（速率较低）"，
   * 而不是显示成"不可用"。
   */
  hasApiKey(): boolean {
    return Boolean(this.apiKey)
  }

  /**
   * 可用性。
   *
   * ready 的判据是 **provider 是否启用**，而不是"有没有 Key"。
   * 这是刻意的：S2 公开接口不要求 Key，没配 Key 一样能查（只是配额紧）。
   * 如果按 hasApiKey 来判 ready，就会把一个完全可用的 provider 报成
   * "未就绪"，调用方据此直接短路，用户明明能查到的东西反而查不到。
   * 没配 Key 这件事写在 reason 里让界面如实展示，不拿去当开关。
   */
  isReady(): { ready: boolean; reason: string } {
    if (!config.semanticScholar.enabled) {
      return { ready: false, reason: 'Semantic Scholar 已在配置中关闭（SEMANTIC_SCHOLAR_ENABLED=false）' }
    }
    return {
      ready: true,
      reason: this.apiKey
        ? '已配置 SEMANTIC_SCHOLAR_API_KEY，使用更高的速率配额'
        : '未配置 API Key，使用匿名访问（速率限制较紧，但功能完整）',
    }
  }

  /* ---------------------------------------------------------------- */

  private async get<T>(path: string, query: Record<string, string>, opts: S2RequestOptions = {}): Promise<T> {
    /**
     * 匿名配额下 429 是**偶发**的，不是持续封锁——实测同一篇论文
     * 连续 4 次 429 后第 5 次就返回了 200。所以先重试几次再降级：
     * 多等一会儿就能把大部分偶发 429 变成真实结果，
     * 而过早 fallback 到 Mock 会让用户以为"查不到这篇论文"——
     * 那是比"稍微慢一点"严重得多的错误结论。
     *
     * 退避策略：1.2s → 2.4s，共 3 次尝试，最坏多等 3.6 秒。
     * 不再往上加的原因：这是同步接口，等太久会把 HTTP 请求拖到超时，
     * 而配置了 API Key 的场景压根不会触发这条路径。
     */
    const attempts = 3
    let lastErr: unknown = null

    for (let i = 0; i < attempts; i++) {
      try {
        return await this.getOnce<T>(path, query, opts)
      } catch (e) {
        lastErr = e
        // 只有 429 值得重试；404/网络错误重试没有意义
        if (!(e instanceof S2UnavailableError) || e.status !== 429 || i === attempts - 1) throw e
        await new Promise((r) => setTimeout(r, 1200 * (i + 1)))
      }
    }
    throw lastErr
  }

  private async getOnce<T>(path: string, query: Record<string, string>, opts: S2RequestOptions): Promise<T> {
    const url = new URL(`${this.baseUrl.replace(/\/+$/, '')}${path}`)
    for (const [k, v] of Object.entries(query)) {
      if (v !== '') url.searchParams.set(k, v)
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      /**
       * 显式 UA。S2 侧对无 UA 的请求更容易限流，
       * 而且带 UA 是对公共 API 提供方的基本礼貌——
       * 出问题时对方能从日志里看出是谁在调。
       */
      'user-agent': 'MethodPilot/0.1 (research paper analysis; contact via project repo)',
    }
    // 有 Key 就带上；没 Key 就不带这个头，S2 会按匿名配额处理
    if (this.apiKey) headers['x-api-key'] = this.apiKey

    let res: Response
    try {
      res = await fetch(url, {
        method: 'GET',
        headers,
        signal: opts.signal ?? AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      const msg = (e as Error).message
      throw new S2UnavailableError(
        /timeout|aborted/i.test(msg)
          ? `Semantic Scholar 请求超时（${this.timeoutMs}ms）`
          : `无法连接 Semantic Scholar：${msg}`,
      )
    }

    if (res.status === 429) {
      throw new S2UnavailableError(rateLimitMsg(this.apiKey), 429)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new S2UnavailableError(`Semantic Scholar 返回 HTTP ${res.status}：${text.slice(0, 200)}`, res.status)
    }

    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new S2UnavailableError('Semantic Scholar 返回的内容不是合法 JSON')
    }

    /**
     * S2 有一个很坑的行为：**限流时它可能返回 HTTP 200，而响应体是
     * `{"message":"Too Many Requests...","code":"429"}`**。
     * 实测碰到过（curl 显示 200，body 却是限流说明）。
     *
     * 如果只看 res.status，这种响应会被当成"成功"，然后 normalize 出一篇
     * 标题为空、年份为 0 的论文——界面上一片空白，而调用方以为拿到了真实数据。
     * 所以必须在 body 层面再判一次。
     */
    if (isRateLimitBody(body)) {
      throw new S2UnavailableError(rateLimitMsg(this.apiKey), 429)
    }

    return body as T
  }

  /* ---------------------------------------------------------------- */
  /* 四个能力                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 搜索论文。
   *
   * limit 上限压到 20：S2 默认返回 10 条，而 references/citations 一取
   * 就是几十上百条。搜索场景下用户看的是前几条，拉 100 条只是浪费配额。
   */
  async search(query: string, limit = 10, opts: S2RequestOptions = {}): Promise<S2SearchResult> {
    const q = query.trim()
    if (!q) return { papers: [], total: 0, source: 'live', note: '' }

    /*
     * limit 兜底。
     *
     * `Math.floor(undefined)` 和 `Math.floor({})` 都是 NaN，
     * 而 `Array.from({length: NaN})` 是空数组 —— 于是一个传错的参数
     * 会静默得到"0 条结果"，看起来像"真的没搜到"。
     * 这类错误我在调试时亲手触发过一次（把 options 对象当 limit 传了），
     * 排查花了些时间。所以这里显式挡掉 NaN。
     */
    const rawN = Math.floor(Number(limit))
    const n = Number.isFinite(rawN) ? Math.min(Math.max(1, rawN), 20) : 10

    try {
      const body = await this.get<S2SearchResponse>(
        '/paper/search',
        {
          query: q,
          limit: String(n),
          fields: PAPER_FIELDS,
          /*
           * S2 的年份区间语法是 `year=2024-2026`（含两端）；
           * 只给下界就是 `2024-`，只给上界是 `-2026`。
           * 这里两端都规范化成四位数字，避免把用户输入里的怪值直接透出去。
           */
          ...yearParam(opts.yearRange),
        },
        opts,
      )
      const papers = filterByYear(
        (body.data ?? [])
          .map((p) => normalizePaper(p, 'live'))
          // 标题为空的条目没有展示价值，直接丢掉而不是留个空壳
          .filter((p) => p.title !== ''),
        opts.yearRange,
      )

      /**
       * 「请求成功但一条都没解析出来」要单独说清楚。
       *
       * 两种可能：查询确实没有匹配，或者 S2 返回的结构和我们预期的不一样
       * （字段改名、限流返回了非预期的壳）。对调用方来说这两种都是"空"，
       * 但不说清楚就会被读成"这个主题没有论文"——而那可能是个假结论。
       * 这里如实返回空 + 说明，不塞 Mock（塞了就成了"没搜到=有结果"）。
       */
      if (papers.length === 0) {
        return {
          papers: [],
          total: 0,
          source: 'live',
          note: opts.yearRange
            ? `Semantic Scholar 在 ${opts.yearRange.from}–${opts.yearRange.to} 年内没有返回可解析的论文条目（可能是确实无匹配，也可能是返回结构异常）`
            : `Semantic Scholar 对「${q.slice(0, 60)}」没有返回可解析的论文条目（可能是确实无匹配，也可能是返回结构异常）`,
        }
      }

      /*
       * 相关性排序（Phase 3B-4）。
       *
       * 位置很关键：**在年份过滤之后**。年份过滤是"用户明确设的硬条件"，
       * 先按它筛掉不符合的，再对留下的按相关性排序。
       * 反过来的话，会把本该被年份排除的论文排到前面再逐个丢弃，
       * 结果是"取前 N 条"拿不到 N 条——这个 bug 只在边界上出现，很难查。
       */
      const ranked = rankPapers(papers, scoringTerms(q, opts.terms))

      return { papers: ranked, total: body.total ?? ranked.length, source: 'live', note: '' }
    } catch (e) {
      const note = (e as Error).message
      if (opts.allowMockFallback === false) throw e
      /*
       * Mock 也走同一条排序路径。
       *
       * 用 mockSearch 预先定好的 mockRelevance 作为分数：
       * 三篇分数互异且完全 deterministic，于是排序逻辑在 Mock 下
       * 同样被真实执行，而不是被"大家分数一样"糊过去。
       */
      const m = mockSearch(q, n)
      return { ...m, papers: rankPapers(m.papers, scoringTerms(q, opts.terms)), note }
    }
  }

  /**
   * 论文详情。
   *
   * 支持三种 id：S2 的 paperId、`DOI:10.xxx`、`ARXIV:2210.03629`。
   * S2 原样接受这些前缀形式，所以这里不做转换，只做 URL 编码。
   */
  async paper(paperId: string, opts: S2RequestOptions = {}): Promise<NormalizedPaper | null> {
    const id = paperId.trim()
    if (!id) return null

    try {
      const body = await this.get<S2Paper>(
        `/paper/${encodeURIComponent(id)}`,
        { fields: PAPER_FIELDS },
        opts,
      )
      return normalizePaper(body, 'live')
    } catch (e) {
      if (e instanceof S2UnavailableError && e.status === 404) return null
      if (opts.allowMockFallback === false) throw e
      return mockPaper(id)
    }
  }

  /** 这篇论文引用了谁（它 → 别人） */
  async references(paperId: string, limit = 20, opts: S2RequestOptions = {}): Promise<S2GraphResult> {
    return this.graph(paperId, 'references', limit, opts)
  }

  /** 谁引用了这篇论文（别人 → 它） */
  async citations(paperId: string, limit = 20, opts: S2RequestOptions = {}): Promise<S2GraphResult> {
    return this.graph(paperId, 'citations', limit, opts)
  }

  /**
   * references 与 citations 的公共实现。
   *
   * 两个接口只有路径不同，响应形状完全对称（citedPaper / citingPaper），
   * 所以合并成一处。分开写只会让"某一侧忘了解包"这种错误有机会发生。
   */
  private async graph(
    paperId: string,
    kind: 'references' | 'citations',
    limit: number,
    opts: S2RequestOptions,
  ): Promise<S2GraphResult> {
    const id = paperId.trim()
    if (!id) return { papers: [], source: 'live', note: '' }

    const n = Math.min(Math.max(1, Math.floor(limit)), 100)

    try {
      const body = await this.get<S2GraphResponse>(
        `/paper/${encodeURIComponent(id)}/${kind}`,
        { limit: String(n), fields: PAPER_FIELDS },
        opts,
      )
      const papers = (body.data ?? [])
        .map((edge) => normalizePaper(unwrapEdge(edge), 'live'))
        .filter((p) => p.paper_id !== '' || p.title !== '')
      return { papers, source: 'live', note: '' }
    } catch (e) {
      const note = (e as Error).message
      if (e instanceof S2UnavailableError && e.status === 404) {
        return { papers: [], source: 'live', note: '' }
      }
      if (opts.allowMockFallback === false) throw e
      const dir = kind === 'references' ? 'out' : 'in'
      return {
        papers: mockGraph(id, dir),
        source: 'mock',
        note: `${note}（已回退到示例数据，不代表真实引用关系）`,
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Mock fallback（要求 6）                                             */
/* ------------------------------------------------------------------ */

/**
 * Mock 数据的构造原则。
 *
 * 三条自我约束，都是为了让"这是假数据"不可能被误认：
 *
 *  1. **id 一律带 `mock:` 前缀**。这样任何一条从 Mock 流出去的数据，
 *     在后续环节都能被识别出来，不会混进真实结果的集合里。
 *  2. **title 明确写着示例**。不编造看起来像真的论文标题——
 *     比如不写 "Attention Is All You Need"，因为那会让人以为真的查到了它。
 *  3. **citationCount 给 0**，不给一个有零有整的假数字。
 *     假的引用数比没有引用数更有害：它看起来像一条可比较的指标。
 *
 * 唯一"真实"的是当前时间，用来在 title 里标出这是哪个时刻的占位数据。
 */
const MOCK_NOTE = '【Mock 数据】Semantic Scholar 不可达，以下为占位内容，不代表任何真实论文'

function mockPaper(id: string, index = 1): NormalizedPaper {
  return {
    paper_id: `mock:${id}`,
    title: `示例论文 ${index}（Semantic Scholar 不可达时的占位数据）`,
    authors: ['示例作者'],
    year: 0,
    abstract: MOCK_NOTE,
    url: '',
    doi: '',
    citationCount: 0,
    venue: '',
    source: 'mock',
  }
}

/**
 * 决定用哪些词给结果打分。
 *
 * 优先用解析出的结构化条件（tasks + methods + keywords）——
 * 那是用户真正表达的意图，而且已经是规范化的英文术语。
 * 没传（`?parse=false` 直搜、或内部调用没给）时退回原查询串本身：
 * 此时"用户意图"就是那句话，多词匹配会被并成一个整体去比对。
 *
 * 注意这里**不掺年份**：年份是硬过滤（走 S2 的 year 参数 + filterByYear），
 * 把它当检索词打分会变成字面匹配数字，且与过滤职责重复。
 */
function scoringTerms(query: string, terms?: string[]): string[] {
  const clean = (terms ?? []).map((t) => t.trim()).filter(Boolean)
  return clean.length > 0 ? clean : [query.trim()].filter(Boolean)
}

/**
 * Mock 搜索结果的 id 必须**与查询绑定**。
 *
 * 这一点最初写错了：id 用的是列表序号（`search-1`、`search-2`），
 * 于是"搜 A 的第 1 条"和"搜 B 的第 1 条"拿到同一个 id。
 * 后果不是显示错乱那么轻——论文探索页靠 id 判断"这篇加过没有"，
 * 在一个查询里加入 `search-2`，切到另一个完全无关的查询，
 * 那条也会显示「已加入」，而且服务端去重会把它们当成同一篇拒绝写入。
 *
 * 现在把查询的哈希掺进 id：同一个词重复搜得到的 id 稳定（刷新后
 * 「已加入」状态仍能对上），不同的词必然得到不同的 id。
 * 用 djb2 而不是 crypto：这是个占位标识，不是安全边界，
 * 没必要为此引入一个异步的摘要计算。
 */
function queryTag(query: string): string {
  let h = 5381
  const s = query.trim().toLowerCase()
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function mockSearch(query: string, limit: number): S2SearchResult {
  const n = Math.min(limit, 3)
  const tag = queryTag(query)
  return {
    papers: Array.from({ length: n }, (_, i) => ({
      ...mockPaper(`search-${tag}-${i + 1}`, i + 1),
      title: `示例论文 ${i + 1}：与「${query.slice(0, 40)}」相关的占位数据`,
      /*
       * 递减的占位相关度（1 → 0.67 → 0.33）。
       *
       * 存在的唯一理由是让排序在 Mock 下**真的被执行**：
       * 三篇的标题摘要完全相同，靠文本算必然同分，
       * 那样排序即使写错也看不出来，测试会掩盖 bug。
       * 这里给三个不同的值，排序逻辑就被真实检验了。
       *
       * 它是**确定性**的（纯下标推导，无时间、无哈希、无随机），
       * 所以"分数计算可复现"这一条在 Mock 下同样成立。
       * 它**不是**从文本算出来的，也不代表任何真实相关度。
       */
      mockRelevance: (n - i) / n,
    })),
    total: n,
    source: 'mock',
    note: `${MOCK_NOTE}（原查询：${query.slice(0, 80)}）`,
  }
}

function mockGraph(paperId: string, dir: 'in' | 'out'): NormalizedPaper[] {
  return [1, 2].map((i) => ({
    ...mockPaper(`${dir}-${i}`, i),
    title: `示例${dir === 'out' ? '被引' : '施引'}论文 ${i}（占位数据，非真实引用关系）`,
  }))
}

/**
 * 把年份区间转成 S2 的 `year` 参数。
 *
 * 返回空对象表示不加这个参数（用户没提年份）。
 * 只产出 `year` 一个键，调用方用展开合并进 query，
 * 让"加不加年份"这件事在调用处一行就能看清。
 */
function yearParam(range: { from: number; to: number } | null | undefined): Record<string, string> {
  if (!range) return {}
  const ok = (n: number) => Number.isFinite(n) && n >= 1900 && n <= 2200
  const from = ok(range.from) ? Math.floor(range.from) : null
  const to = ok(range.to) ? Math.floor(range.to) : null
  // 两端都非法就当没提年份，而不是传一个荒唐的值让 S2 返回 400
  if (from === null && to === null) return {}
  return { year: `${from ?? ''}-${to ?? ''}` }
}

/**
 * 按年份区间过滤。
 *
 * 客户端兜底：即使 S2 忽略了我们传的 year 参数（它偶尔会），
 * 这里也把区间外的结果剔掉。
 *
 * 为什么值得做两遍：用户明确说了"近三年"，返回 2019 年的论文
 * 会让他觉得这个功能是坏的。而"静默不生效的筛选条件"
 * 比"没有这个筛选"更糟糕——用户会据此相信一个错误的结论。
 *
 * `year <= 0` 表示 S2 没给年份，这种情况**保留**：
 * 我们不知道它是不是符合条件，因未知而丢弃是另一种失真。
 */
function filterByYear(papers: NormalizedPaper[], range: { from: number; to: number } | null | undefined): NormalizedPaper[] {
  if (!range) return papers
  return papers.filter((p) => p.year <= 0 || (p.year >= range.from && p.year <= range.to))
}

/* ------------------------------------------------------------------ */
/* 限流判定                                                            */
/* ------------------------------------------------------------------ */

/**
 * 限流说明文案。
 *
 * 刻意把"匿名访问配额较紧"和"可配置 API Key 提高配额"写进面向用户的消息里——
 * 用户看到"429"是不知道该怎么办的，看到"配个 Key 就好"才知道下一步。
 * 已经配了 Key 的情况则不同：那是真的被限了，只能等。
 */
const rateLimitMsg = (authed: boolean): string =>
  authed
    ? 'Semantic Scholar 速率限制（429）。已配置认证，请稍后重试'
    : 'Semantic Scholar 速率限制（429）。匿名访问配额较紧，可配置 SEMANTIC_SCHOLAR_API_KEY 提高配额'

/**
 * 识别"HTTP 200 但响应体是限流说明"这种响应。
 *
 * 实测遇到过：curl 显示 200，body 却是 `{"message":"Too Many Requests..."}`。
 * 不判这一层的话，它会一路走到 normalize，产出一篇
 * 标题空、年份 0 的"论文"——界面上什么都不显示，而调用方以为查到了。
 */
function isRateLimitBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  if (String(b.code ?? '') === '429') return true
  return typeof b.message === 'string' && /too many requests|rate limit/i.test(b.message)
}

/* ------------------------------------------------------------------ */
/* 单例                                                                */
/* ------------------------------------------------------------------ */

let cached: SemanticScholarProvider | null = null

export function getSemanticScholar(): SemanticScholarProvider {
  if (!cached) cached = new SemanticScholarProvider()
  return cached
}

export function resetSemanticScholarCache(): void {
  cached = null
}
