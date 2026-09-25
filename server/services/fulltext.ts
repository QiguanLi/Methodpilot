/**
 * 全文获取（Phase 3B-7）。
 *
 * ── 这一步在兑现一个承诺 ──
 *
 * metaPaper.ts 的头部注释把 `pending` 定义成「**待你提供 PDF**」，
 * 而不是「排队等自动跑」。本模块就是给它一条把 PDF 补上的路径：
 * 拿现有的元数据链接去把全文取回来，取到了这篇论文才真的可分析。
 *
 * ── 与上传路径的关系：共用落盘，不共用入口 ──
 *
 * 上传路径收到的是**用户递来的字节**（multipart，浏览器已经把它读进内存），
 * 本模块收到的是**一个 URL**，字节要自己出去拿。两者最终都要产生
 * "项目里有一篇带 PDF 的论文"，所以落盘约定必须一致
 * （`uploadDir/<file_hash 前16位>/<安全文件名>`，见 routes/papers.ts 的 saveUpload
 * 与 analysis.ts 的 paperFilePath）——不一致的话，后续解析会找不到文件，
 * 而那种失败发生在几步之后，排查成本高得多。
 *
 * ── 链接从哪来（用户已确认的取舍）──
 *
 * 元数据 keywords 里存着 `链接:<url>`，那是 S2 的 `url` 字段，
 * **指向摘要页而不是 PDF**（实测是 semanticscholar.org/paper/xxx 这种）。
 * 所以本模块分两种情况：
 *   1. 链接本身就是 PDF 直链 → 直接下载
 *   2. 链接是摘要页 → 抓 HTML，从里面解析出 PDF 直链，再下载
 *
 * 为什么不改用 S2 的 `openAccessPdf` 字段：沙箱内 `/paper/{id}` 与
 * `/paper/search` 实测**持续 429**（按端点分池，非窗口限流），
 * 扩字段后那条路的正确性无法验证——写一段没法验证的代码比不写更糟。
 * 摘要页解析是实测可用的：`arxiv.org/abs/2210.03629` 能解析出
 * `arxiv.org/pdf/2210.03629`，后者返回 200 / application/pdf / 133KB 真实字节。
 *
 * ── 失败必须如实 ──
 *
 * 本模块**只**在两件事都成立时返回成功：拿到了 PDF 直链，且下载回来的
 * 字节真的是 PDF（magic bytes）。任何一步不成立都返回带 code 的失败，
 * 由上层如实显示「无法获取全文」。
 * 绝不用 HTML 错误页、登录页、Cloudflare 拦截页冒充 PDF——
 * 那正是本项目最反对的谎报，而且它们能被解析器打开、报出更绕的错。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.ts'
import { hashFile } from './ai/index.ts'
import type { StoredPaper } from '../types.ts'

/* ------------------------------------------------------------------ */
/* 结果类型                                                            */
/* ------------------------------------------------------------------ */

export interface FetchOutcome {
  /** 是否取到了真实 PDF 文件 */
  ok: boolean
  /** 失败时的机器可读原因 */
  code: FulltextErrorCode | ''
  /** 失败原因，**给用户看**的一句话 */
  message: string
  /** 实际下载来源（成功时才有），用于溯源展示 */
  from: string
  /** 落到磁盘的绝对路径（成功时才有） */
  filePath: string
  /** 新的内容哈希，写回 paper.file_hash 用 */
  fileHash: string
  fileSize: number
  fileName: string
  /** 走了哪条路径：direct = 链接即 PDF，resolved = 从摘要页解析出 PDF */
  route: 'direct' | 'resolved' | ''
}

export type FulltextErrorCode =
  | 'NO_LINK'
  | 'DISABLED'
  | 'BAD_URL'
  | 'UNRESOLVED'
  | 'NOT_PDF'
  | 'TOO_LARGE'
  | 'HTTP_ERROR'
  | 'NETWORK'

const fail = (code: FulltextErrorCode, message: string): FetchOutcome => ({
  ok: false,
  code,
  message,
  from: '',
  filePath: '',
  fileHash: '',
  fileSize: 0,
  fileName: '',
  route: '',
})

/** 出网 UA。与 semanticScholar provider 保持同一身份，便于对方排查 */
const UA = 'MethodPilot/0.1 (research paper analysis; contact via project repo)'

/* ------------------------------------------------------------------ */
/* 1. 从元数据里取链接                                                  */
/* ------------------------------------------------------------------ */

/**
 * 前缀必须与 metaPaper.ts 的 buildMetaKeywords() 和前端 projectData.ts
 * 的 metaOf() **逐字一致**。三处用的是同一个字符串：`链接:`（中文冒号）。
 * 写错一个字符的表现是"服务端存了、这里读不出来"，
 * 而这不会报任何错——只会让每一篇都报 NO_LINK。
 */
export const LINK_PREFIX = '链接:'

export function extractMetaLink(paper: StoredPaper): string {
  const hit = (paper.keywords ?? []).find((k) => k.startsWith(LINK_PREFIX))
  return hit ? hit.slice(LINK_PREFIX.length).trim() : ''
}

/* ------------------------------------------------------------------ */
/* 2. 摘要页 → PDF 直链                                                */
/* ------------------------------------------------------------------ */

/**
 * 判断一个 URL 是否**看起来**就是 PDF 直链。
 *
 * 只是启发式，用来决定"直接下"还是"先抓 HTML 解析"——
 * 猜错的代价很小（直接下失败了再走解析），
 * 真正的判据永远是下载回来的 magic bytes。
 */
function looksLikePdfUrl(url: string): boolean {
  const u = url.toLowerCase()
  return /\.pdf(\?|#|$)/.test(u) || u.includes('/pdf/') || u.includes('pdf=')
}

/**
 * 从摘要页 HTML 里解析 PDF 直链。
 *
 * 只认 `citation_pdf_url` 这个 meta 标签 + 一批明确的站点形态，
 * 不做"随便找个 .pdf 结尾的串"这种模糊匹配——
 * 模糊匹配会捞出引文里的 PDF 链接、模板里的示例链接，
 * 然后安静地去下一份完全无关的论文，这比直接失败危险得多。
 */
export function resolvePdfFromHtml(html: string, pageUrl: string): string {
  const head = html.slice(0, 200_000)

  // ① 学术站点普遍提供的标准 meta 标签，最可靠
  const meta =
    /<meta[^>]+name=["']citation_pdf_url["'][^>]*content=["']([^"']+)["']/i.exec(head) ??
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']citation_pdf_url["']/i.exec(head)
  if (meta?.[1]) {
    const abs = absolutize(meta[1], pageUrl)
    if (abs) return abs
  }

  // ② 站点规则：只有明确知道形态的才改写，命不中就返回空
  const rules: { test: RegExp; to: (m: RegExpMatchArray) => string }[] = [
    // arXiv: /abs/<id> → /pdf/<id>
    { test: /arxiv\.org\/abs\/([^/?#]+)/i, to: (m) => `https://arxiv.org/pdf/${m[1]}` },
    // OpenReview: /forum?id=<id> → /pdf?id=<id>
    { test: /openreview\.net\/forum\?id=([^&#]+)/i, to: (m) => `https://openreview.net/pdf?id=${m[1]}` },
    // ACL Anthology: /YYYY.xxx/ 页面本身没有稳定 PDF 规律，靠 ① 的 meta 标签
  ]
  for (const r of rules) {
    const m = r.test.exec(pageUrl)
    if (m) return r.to(m)
  }

  // ③ 页面里显式的 PDF 入口按钮（href 直接写明 .pdf）
  const href = /href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/i.exec(head)
  if (href?.[1]) {
    const abs = absolutize(href[1], pageUrl)
    if (abs) return abs
  }

  return ''
}

/** 相对路径补全。只接受 http/https，`javascript:` / `data:` 一律拒绝 */
function absolutize(raw: string, base: string): string {
  try {
    const u = new URL(raw, base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.toString()
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ */
/* 3. 下载                                                            */
/* ------------------------------------------------------------------ */

/**
 * 下载并**边下边数**。
 *
 * 为什么不信 Content-Length：它由服务端给出，可以撒谎（也可以缺失，
 * 比如 chunked 编码）。真按它预分配，一个声称 10KB / 实发 2GB 的响应
 * 就能把服务端内存吃掉。所以上限作用在**已接收字节数**上，超了立刻掐断。
 */
async function download(url: string, timeoutMs: number, maxBytes: number): Promise<
  | { ok: true; data: Buffer; contentType: string; finalUrl: string }
  | { ok: false; code: FulltextErrorCode; message: string }
> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/pdf,text/html;q=0.9,*/*;q=0.5', 'user-agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    const msg = (e as Error).message
    return {
      ok: false,
      code: 'NETWORK',
      message: /timeout|aborted/i.test(msg)
        ? `下载超时（${Math.round(timeoutMs / 1000)}s）：${url}`
        : `无法连接：${msg}`,
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      code: 'HTTP_ERROR',
      message: `下载失败，来源返回 HTTP ${res.status}：${url}`,
    }
  }

  const contentType = String(res.headers.get('content-type') ?? '')

  const chunks: Buffer[] = []
  let size = 0
  try {
    const body = res.body
    if (!body) throw new Error('响应没有内容')
    const reader = body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        return {
          ok: false,
          code: 'TOO_LARGE',
          message: `文件超过 ${Math.round(maxBytes / 1048576)}MB 上限，已中止下载`,
        }
      }
      chunks.push(Buffer.from(value))
    }
  } catch (e) {
    return { ok: false, code: 'NETWORK', message: `下载中断：${(e as Error).message}` }
  }

  if (size === 0) {
    return { ok: false, code: 'NOT_PDF', message: `来源返回了空内容：${url}` }
  }

  return { ok: true, data: Buffer.concat(chunks), contentType, finalUrl: res.url || url }
}

/** 判据与上传路径一致：头 5 字节必须是 %PDF- */
function looksLikePdf(buf: Buffer): boolean {
  return buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-'
}

/* ------------------------------------------------------------------ */
/* 4. 落盘                                                            */
/* ------------------------------------------------------------------ */

/**
 * 与上传路径完全一致的落盘约定。
 *
 * 目录取 `<hash 前16位>`，文件名做同样的字符净化——
 * 因为后续 analysis.ts 的 paperFilePath() 就是这么反推路径的，
 * 这里稍有不同，文件写了但解析时找不到，且失败点在几步之外。
 */
async function savePdf(data: Buffer, hash: string, wantName: string): Promise<{ filePath: string; fileName: string }> {
  const dir = path.join(config.storage.uploadDir, hash.slice(0, 16))
  await fsp.mkdir(dir, { recursive: true })
  const safe = wantName.replace(/[^\w.\-()\u4e00-\u9fa5]/g, '_').slice(0, 120) || 'paper.pdf'
  const filePath = path.join(dir, safe)
  await fsp.writeFile(filePath, data)
  return { filePath, fileName: safe }
}

/**
 * 从 URL 猜一个像样的文件名。
 *
 * 不直接用 URL 最后一段就落盘的原因：`arxiv.org/pdf/2210.03629` 最后一段
 * 是没有扩展名的 id，落成 `2210.03629` 之后，任何按扩展名判断的地方
 * （下载、预览）都会懵。统一补 `.pdf`。
 */
function fileNameFromUrl(url: string, title: string): string {
  let base = ''
  try {
    base = path.basename(new URL(url).pathname)
  } catch {
    base = ''
  }
  if (!base || !base.includes('.')) {
    // 标题里可能有中文与空格，剔除后用作可读的文件名；再退就退回 arXiv id 风格
    const fromTitle = title.replace(/[^\w.\-()\u4e00-\u9fa5]/g, '_').trim()
    base = fromTitle ? `${fromTitle.slice(0, 80)}.pdf` : 'fulltext.pdf'
  }
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`
}

/* ------------------------------------------------------------------ */
/* 5. 主流程                                                          */
/* ------------------------------------------------------------------ */

export interface FetchOptions {
  /** 注入点：测试用本地 HTTP 服务器替代真实站点，无需改生产代码路径 */
  fetchPage?: (url: string) => Promise<{ ok: boolean; status: number; html: string }>
}

/**
 * 把一篇元数据论文的全文取回来。
 *
 * **只下载与落盘，不写 papers.json。** 写回由路由层负责——
 * 因为 papers.json 的读-改-写必须与项目内其它写操作串行，
 * 而这个函数会花数秒到数十秒（出网），把持锁那么久是错的。
 */
export async function fetchFulltext(paper: StoredPaper, opts: FetchOptions = {}): Promise<FetchOutcome> {
  if (!config.fulltext.enabled) {
    return fail('DISABLED', '全文获取已在服务端关闭（ENABLE_FULLTEXT_FETCH=false），未发起任何外部请求')
  }

  const link = extractMetaLink(paper)
  if (!link) {
    return fail('NO_LINK', '这篇论文的元数据里没有可用的链接，无法自动获取全文')
  }

  let linkUrl: URL
  try {
    linkUrl = new URL(link)
    if (linkUrl.protocol !== 'http:' && linkUrl.protocol !== 'https:') throw new Error('protocol')
  } catch {
    return fail('BAD_URL', `元数据里的链接不是可用的 http 地址：${link.slice(0, 120)}`)
  }

  const { timeoutMs, maxBytes } = config.fulltext

  /* ---- 路径 A：链接本身就是 PDF ---- */
  if (looksLikePdfUrl(link)) {
    const d = await download(link, timeoutMs, maxBytes)
    if (!d.ok) return fail(d.code, d.message)
    if (!looksLikePdf(d.data)) {
      /*
       * 下载成功但内容不是 PDF。**这里就是最容易谎报的地方**：
       * 服务器可能返回一个 HTML 拦截页 / 登录页，HTTP 200，
       * 存下来大小也对，只有看 magic bytes 才知道被骗了。
       */
      return fail('NOT_PDF', '下载到的内容不是 PDF（可能是登录页或拦截页），未保存')
    }
    return await persist(d.data, d.finalUrl, paper)
  }

  /* ---- 路径 B：链接是摘要页，先解析出 PDF 直链 ---- */
  const page = await loadPage(link, timeoutMs, opts)
  if (!page.ok) {
    return fail('UNRESOLVED', `无法读取论文页面（HTTP ${page.status}）：${link.slice(0, 120)}`)
  }

  const pdfUrl = resolvePdfFromHtml(page.html, link)
  if (!pdfUrl) {
    return fail('UNRESOLVED', '在论文页面上找不到 PDF 下载链接，无法自动获取全文')
  }

  const d = await download(pdfUrl, timeoutMs, maxBytes)
  if (!d.ok) return fail(d.code, d.message)
  if (!looksLikePdf(d.data)) {
    return fail('NOT_PDF', '解析出的地址下载回来不是 PDF（可能是登录页或拦截页），未保存')
  }

  const out = await persist(d.data, d.finalUrl, paper)
  return { ...out, route: 'resolved' }
}

async function loadPage(
  url: string,
  timeoutMs: number,
  opts: FetchOptions,
): Promise<{ ok: boolean; status: number; html: string }> {
  if (opts.fetchPage) return opts.fetchPage(url)
  try {
    const res = await fetch(url, {
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, status: res.status, html: '' }
    // 摘要页是文本，截断保护：真 PDF 站点的正文页也就几百 KB
    const html = (await res.text()).slice(0, 400_000)
    return { ok: true, status: res.status, html }
  } catch (e) {
    /*
     * 网络异常与"页面不存在"对用户是同一件事：拿不到 PDF。
     * 但原因不能丢——服务端日志里要留下真实错因，否则线上出现
     * 一片 UNRESOLVED 时无从判断是站点挂了、被墙了，还是 DNS 没配。
     */
    console.warn(`[fulltext] 读取论文页面失败 ${url}: ${(e as Error).name}: ${(e as Error).message}`)
    return { ok: false, status: 0, html: '' }
  }
}

/** 落盘 + 算哈希 + 组装结果。哈希复用上传路径的 hashFile，保证同一份 PDF 得到同一个哈希 */
async function persist(data: Buffer, finalUrl: string, paper: StoredPaper): Promise<FetchOutcome> {
  const hash = hashFile(data)
  const wantName = fileNameFromUrl(finalUrl, paper.title)
  const saved = await savePdf(data, hash, wantName)
  return {
    ok: true,
    code: '',
    message: '',
    from: finalUrl,
    filePath: saved.filePath,
    fileHash: hash,
    fileSize: data.length,
    fileName: saved.fileName,
    route: 'direct',
  }
}
