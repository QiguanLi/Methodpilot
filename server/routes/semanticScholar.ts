/**
 * Semantic Scholar 路由。
 *
 * 四个能力对应四个接口（需求 4）：
 *   GET /api/s2/search?q=&limit=
 *   GET /api/s2/paper/:paperId
 *   GET /api/s2/paper/:paperId/references?limit=
 *   GET /api/s2/paper/:paperId/citations?limit=
 *
 * ── 关于降级与错误码 ──
 *
 * 这里有一个刻意的选择：**S2 不可达时不返回 5xx，而是返回 200 + mock 数据**。
 *
 * 理由：调用方（未来的 Agent 页面、演进分析）需要的是"一份可以展示的论文列表"，
 * 而不是一个错误。如果返回 500，调用方要么自己编数据、要么整块功能白屏。
 * 返回 200 + `source: 'mock'` 则把判断权交给调用方：
 * 它可以选择标注"示例数据"、也可以选择隐藏，但至少它**有东西可判断**。
 *
 * 代价是调用方**必须**检查 `source` 字段。为了不让人忘，
 * mock 数据的 paper_id 带 `mock:` 前缀、title 里写着"占位数据"，
 * 而且 note 字段给出降级原因——三层冗余，忘了一层还有两层。
 *
 * 唯一例外：`allowMockFallback` 显式传 false 时（调试/测试用）如实抛错。
 */

import { getSemanticScholar, S2UnavailableError } from '../services/semanticScholar/index.ts'
import { parseQuery } from '../services/queryParser.ts'
import { config } from '../config.ts'
import { sendJson } from '../utils/http.ts'

/**
 * 解析 limit 参数。
 *
 * 给默认值也给上限：不传时用 10/20，传了 10000 也只当 20/100 处理。
 * 不设上限的结果是有人拿 ?limit=99999 把服务端的出网配额一次打光。
 */
const parseLimit = (raw: string | null, def: number, max: number): number => {
  if (!raw) return def
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.floor(n), max)
}

/** 出网总开关。ENABLE_SEMANTIC_SCHOLAR=false 时完全不发起外部请求 */
const disabled = () => ({
  enabled: false,
  note: 'Semantic Scholar 已通过 ENABLE_SEMANTIC_SCHOLAR=false 关闭，未发起任何外部请求',
})

export async function handleS2Search(
  query: string,
  limitRaw: string | null,
  /** 是否把自然语言拆成结构化条件（Phase 3B-3）。默认 true */
  parseRaw: string | null = null,
): Promise<{ status: number; body: unknown }> {
  const q = (query ?? '').trim()
  if (!q) {
    return {
      status: 400,
      body: { success: false, error: { code: 'MISSING_QUERY', message: '缺少查询参数 q' } },
    }
  }

  /*
   * 自然语言解析。
   *
   * 用当前年份而不是写死：年份区间的解析必须相对"现在"才有意义，
   * 而服务端在跨年时会重启，所以这里取系统时间是安全的。
   */
  const parsed = parseRaw === 'false'
    ? null
    : parseQuery(q, new Date().getFullYear())

  if (!config.semanticScholar.enabled) {
    return {
      status: 200,
      body: {
        success: true,
        data: {
          papers: [], total: 0, source: 'mock', query: q,
          parsed,
          ...disabled(),
        },
      },
    }
  }

  const s2 = getSemanticScholar()
  const r = await s2.search(parsed?.s2Query || q, {
    limit: parseLimit(limitRaw, 10, 20),
    yearRange: parsed?.yearRange ?? null,
    /*
     * 打分用的检索词 = 解析出的结构化条件（任务 + 方法 + 关键词）。
     *
     * 不复用 s2Query 的原因：s2Query 是**拼给 S2 的一整句话**，
     * 拿它当单个 term 去打分会要求"整句话都命中"，几乎必然 0 分。
     * 这里要把条件拆开逐个匹配，覆盖率才有意义。
     *
     * parsed 为 null（?parse=false）时不传，provider 会退回用原查询串。
     */
    terms: parsed ? [...parsed.tasks, ...parsed.methods, ...parsed.keywords] : undefined,
  })

  return {
    status: 200,
    body: {
      success: true,
      data: {
        query: q,
        /** 送给 S2 的实际检索串。和 query 不同时用户能看出 Agent 改写了什么 */
        s2_query: parsed?.s2Query || q,
        parsed,
        papers: r.papers,
        total: r.total,
        source: r.source,
        // live 时 note 为空串，调用方据此判断"有没有降级"
        note: r.note,
        authenticated: s2.hasApiKey(),
      },
    },
  }
}

export async function handleS2Paper(paperId: string): Promise<{ status: number; body: unknown }> {
  const id = (paperId ?? '').trim()
  if (!id) {
    return { status: 400, body: { success: false, error: { code: 'MISSING_ID', message: '缺少论文 id' } } }
  }

  if (!config.semanticScholar.enabled) {
    return { status: 200, body: { success: true, data: { paper: null, source: 'mock', ...disabled() } } }
  }

  const s2 = getSemanticScholar()
  const paper = await s2.paper(id)

  /**
   * paper 为 null 有两种可能，必须分开：
   *   - S2 明确 404（这篇论文不在它的库里）→ 也是 404，这是真实答案
   *   - 降级到 mock → 不是 404，200 + source:'mock'
   * 把后者也报成 404，用户会以为"这篇论文不存在"，
   * 而真相是"我们没连上"——这是两个完全不同的结论。
   */
  if (paper === null) {
    return {
      status: 404,
      body: {
        success: false,
        error: { code: 'PAPER_NOT_FOUND', message: `Semantic Scholar 中找不到论文 ${id}` },
      },
    }
  }

  return {
    status: 200,
    body: { success: true, data: { paper, source: paper.source, authenticated: s2.hasApiKey() } },
  }
}

export async function handleS2Graph(
  paperId: string,
  kind: 'references' | 'citations',
  limitRaw: string | null,
): Promise<{ status: number; body: unknown }> {
  const id = (paperId ?? '').trim()
  if (!id) {
    return { status: 400, body: { success: false, error: { code: 'MISSING_ID', message: '缺少论文 id' } } }
  }

  if (!config.semanticScholar.enabled) {
    return {
      status: 200,
      body: { success: true, data: { papers: [], source: 'mock', kind, ...disabled() } },
    }
  }

  const s2 = getSemanticScholar()
  const r = kind === 'references'
    ? await s2.references(id, parseLimit(limitRaw, 20, 100))
    : await s2.citations(id, parseLimit(limitRaw, 20, 100))

  return {
    status: 200,
    body: {
      success: true,
      data: {
        paperId: id,
        kind,
        papers: r.papers,
        count: r.papers.length,
        source: r.source,
        note: r.note,
        authenticated: s2.hasApiKey(),
      },
    },
  }
}

/**
 * 直接透传 sendJson，供 index.ts 的路由表使用。
 * 这几个 handler 都是"算出 {status, body}"的形式，与 papers 路由保持一致。
 */
export { sendJson }

/** 供健康检查用：不发请求，只看配置与静态状态 */
export function s2Status(): { enabled: boolean; authenticated: boolean; note: string } {
  const s2 = getSemanticScholar()
  const st = s2.isReady()
  return {
    enabled: config.semanticScholar.enabled,
    authenticated: s2.hasApiKey(),
    note: config.semanticScholar.enabled ? st.reason : '已关闭，不发起外部请求',
  }
}

export { S2UnavailableError }
