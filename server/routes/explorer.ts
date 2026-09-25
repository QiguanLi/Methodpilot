/**
 * 「加入当前项目」路由。
 *
 * POST /api/projects/:projectId/papers/meta
 *
 * 只登记元数据，不碰 PDF、不碰 LLM（Phase 3B-2 要求 5）。
 * 具体做什么、为什么这么设计，见 services/metaPaper.ts 的头部说明。
 *
 * ── 为什么不用 multipart ──
 *
 * 上传那条路走 multipart + 落盘 + magic bytes 校验，是因为它真的传文件。
 * 这里是纯 JSON，没有字节流可验，套用 multipart 只会引入
 * 不必要的解析分支。两条路各有各的入口，比强行合并成一个更不容易出错。
 */

import type { IncomingMessage } from 'node:http'
import { readJson, sendErr, sendJson } from '../utils/http.ts'
import { addMetaPaper, type AddMetaInput } from '../services/metaPaper.ts'

/** 数组字段可能被前端写成字符串或缺失，统一收敛成 string[] */
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : []

const str = (v: unknown): string => String(v ?? '').trim()

export async function handleAddMetaPaper(
  projectId: string,
  req: IncomingMessage,
): Promise<{ status: number; body: unknown }> {
  let raw: unknown
  try {
    raw = await readJson(req)
  } catch (e) {
    return {
      status: 400,
      body: { success: false, error: { code: 'BAD_JSON', message: `请求体不是合法 JSON：${String(e)}` } },
    }
  }

  const b = (raw ?? {}) as Record<string, unknown>

  /**
   * 这两项是硬性必需：
   *   - s2_paper_id —— 去重的唯一依据，缺了就会重复加入
   *   - title        —— 文献库里没标题的行毫无意义
   * 其余字段（作者、DOI、摘要…）在 S2 侧本来就可能为 null，
   * 缺了就存空值，不阻塞加入——用户要的是"先收进来"。
   */
  const s2_paper_id = str(b.s2_paper_id ?? b.paper_id)
  const title = str(b.title)
  if (!s2_paper_id) {
    return { status: 400, body: { success: false, error: { code: 'MISSING_ID', message: '缺少 s2_paper_id' } } }
  }
  if (!title) {
    return { status: 400, body: { success: false, error: { code: 'MISSING_TITLE', message: '缺少标题，无法加入文献库' } } }
  }

  const yearNum = Number(b.year)
  const citedNum = Number(b.citationCount)

  const input: AddMetaInput = {
    s2_paper_id,
    title,
    authors: strArray(b.authors),
    year: Number.isFinite(yearNum) && yearNum > 0 ? Math.floor(yearNum) : 0,
    abstract: str(b.abstract),
    url: str(b.url),
    doi: str(b.doi),
    citationCount: Number.isFinite(citedNum) && citedNum >= 0 ? Math.floor(citedNum) : 0,
    venue: str(b.venue),
    // 只接受确定的两个值，其它一律当 live 之外的 mock 处理更危险，这里显式收窄
    source: b.source === 'live' ? 'live' : 'mock',
  }

  const r = await addMetaPaper(projectId, input)
  if (!r.ok) {
    const status = r.code === 'PROJECT_NOT_FOUND' ? 404 : 500
    return { status, body: { success: false, error: { code: r.code, message: r.message } } }
  }

  return {
    status: r.created ? 201 : 200,
    body: {
      success: true,
      data: {
        paper: r.paper,
        // 前端据此区分"加进去了"和"早就在里面"——两种提示文案不一样
        created: r.created,
        status: r.paper.status,
      },
    },
  }
}

/**
 * 批量加入（Phase 3B-6）。
 *
 * POST /api/projects/:projectId/papers/meta/batch
 * body: { papers: [ { s2_paper_id, title, ... }, ... ] }
 *
 * ── 为什么是服务端循环，而不是前端并发 N 个请求 ──
 *
 * 关键在于 addMetaPaper 是**读-改-写**：它先 getBundle 拿到现有 papers，
 * 追加一条，再整份 savePapers 写回。
 * 前端 Promise.all 并发打 N 次，这 N 次会各自读到**同一份旧数据**，
 * 然后各自写回——后写的覆盖先写的，最终只留下一条。
 * 这是最坏的一类 bug：接口全部返回 201「成功」，数据里只有一篇。
 *
 * 这里改成**顺序 await**，每一条都基于前一条的结果，
 * 于是天然串行、互不覆盖，而且第二条起就能靠已有的哈希去重命中。
 *
 * ── 部分成功也写入（用户已确认的口径）──
 *
 * 单条失败不中断整体。批量场景下"一篇格式不对就全部回滚"
 * 会让用户白白丢掉已经成功的部分，而那部分本来完全有效。
 * 所以逐条记录成败，最后汇总回报，失败的由前端保持勾选以便重试。
 */
export async function handleAddMetaPapersBatch(
  projectId: string,
  req: IncomingMessage,
): Promise<{ status: number; body: unknown }> {
  let raw: unknown
  try {
    raw = await readJson(req)
  } catch (e) {
    return {
      status: 400,
      body: { success: false, error: { code: 'BAD_JSON', message: `请求体不是合法 JSON：${String(e)}` } },
    }
  }

  const b = (raw ?? {}) as Record<string, unknown>
  const list = Array.isArray(b.papers) ? b.papers : null
  if (!list) {
    return {
      status: 400,
      body: { success: false, error: { code: 'MISSING_PAPERS', message: '请求体需要 papers 数组' } },
    }
  }

  /*
   * 上限 100。
   * 不是性能考虑（串行写 100 条文件也就几十毫秒），而是防误操作：
   * 一个拼错的请求体不该让服务端写进去一万条。
   * 前端一次最多也就提交当前页的结果（≤20 条），够用。
   */
  if (list.length > 100) {
    return {
      status: 400,
      body: {
        success: false,
        error: { code: 'TOO_MANY', message: `一次最多加入 100 篇，收到 ${list.length} 篇` },
      },
    }
  }

  const created: string[] = []
  const existing: string[] = []
  const failed: { s2_paper_id: string; code: string; message: string }[] = []
  let projectMissing = false

  /*
   * 顺序执行，**不要改成 Promise.all**。
   * 上面注释解释了原因：并发会让读-改-写互相覆盖，
   * 结果是"全部返回成功、实际只写进去一条"。
   */
  for (const item of list) {
    const it = (item ?? {}) as Record<string, unknown>
    const s2_paper_id = str(it.s2_paper_id ?? it.paper_id)
    const title = str(it.title)

    // 逐条做与单条接口一致的校验，失败只记这一条
    if (!s2_paper_id) {
      failed.push({ s2_paper_id: '', code: 'MISSING_ID', message: '缺少 s2_paper_id' })
      continue
    }
    if (!title) {
      failed.push({ s2_paper_id, code: 'MISSING_TITLE', message: '缺少标题，无法加入文献库' })
      continue
    }

    const yearNum = Number(it.year)
    const citedNum = Number(it.citationCount)
    const r = await addMetaPaper(projectId, {
      s2_paper_id,
      title,
      authors: strArray(it.authors),
      year: Number.isFinite(yearNum) && yearNum > 0 ? Math.floor(yearNum) : 0,
      abstract: str(it.abstract),
      url: str(it.url),
      doi: str(it.doi),
      citationCount: Number.isFinite(citedNum) && citedNum >= 0 ? Math.floor(citedNum) : 0,
      venue: str(it.venue),
      source: it.source === 'live' ? 'live' : 'mock',
    })

    if (r.ok) {
      // created=false 表示早就在项目里了——这不是失败，如实分开计数
      ;(r.created ? created : existing).push(s2_paper_id)
    } else if (r.code === 'PROJECT_NOT_FOUND') {
      /*
       * 项目不存在是**整体性**失败，不是这一条的问题。
       * 继续循环只会把同一个错误重复 N 遍，所以直接停。
       */
      projectMissing = true
      failed.push({ s2_paper_id, code: r.code, message: r.message })
      break
    } else {
      failed.push({ s2_paper_id, code: r.code, message: r.message })
    }
  }

  if (projectMissing) {
    return {
      status: 404,
      body: {
        success: false,
        error: { code: 'PROJECT_NOT_FOUND', message: `项目 ${projectId} 不存在` },
      },
    }
  }

  return {
    status: 200,
    body: {
      success: true,
      data: {
        // 三类计数分开回传，前端据此给出"新增 N / 已存在 M / 失败 K"的准确文案
        created: created.length,
        existing: existing.length,
        failed: failed.length,
        created_ids: created,
        existing_ids: existing,
        failures: failed,
        total: list.length,
      },
    },
  }
}

export { sendErr, sendJson }