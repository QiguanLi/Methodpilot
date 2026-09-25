/**
 * 极简 HTTP 工具。刻意不引 express/fastify。
 *
 * 理由：这个服务端要跑在评委的机器上，也可能是校园网里的某台机器。
 * 少一个依赖就少一类"装不上"的失败。Node 自带的 http 模块能力足够：
 * 路由是十几条、请求体是 JSON 或 multipart，两者手写都不复杂，
 * 而 multipart 解析的代码量（见下）比配置一个中间件还少。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiErr } from '../types.ts'

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // 前端在 5173 端口，服务端在 8787，跨源必须放开
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

export const sendErr = (res: ServerResponse, status: number, code: string, message: string, detail?: unknown) =>
  sendJson(res, status, { success: false, error: { code, message, ...(detail === undefined ? {} : { detail }) } } satisfies ApiErr)

/** 读取请求体，带硬上限，防止有人推一个 2GB 的请求把内存吃掉 */
export async function readBody(req: IncomingMessage, limitBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limitBytes) {
        reject(new Error(`Request body exceeds ${limitBytes} bytes`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const buf = await readBody(req)
  if (!buf.length) return {} as T
  return JSON.parse(buf.toString('utf8')) as T
}

/* ------------------------------------------------------------------ */
/* multipart/form-data 解析                                            */
/* ------------------------------------------------------------------ */

export interface UploadedFile {
  field: string
  filename: string
  contentType: string
  data: Buffer
}

export interface MultipartResult {
  fields: Record<string, string>
  files: UploadedFile[]
}

/**
 * 只做 PDF 上传场景需要的那部分 multipart 解析。
 *
 * 为什么不引 busboy/formidable：
 *   我们的表单结构极其固定（一个 file 字段或多个重复的 file 字段 + 若干文本字段），
 *   而 multipart 的边界切分本身只有二十行。引一个流式解析器反而要处理
 *   它的错误语义、临时文件清理、依赖体积。
 *
 * 已知限制（写在报告里，不假装支持）：
 *   - 不处理嵌套 multipart
 *   - 假定 boundary 不出现在文件内容中（PDF 二进制里出现随机 boundary 的概率可忽略）
 */
export function parseMultipart(body: Buffer, contentType: string): MultipartResult | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (!m) return null
  const boundary = (m[1] ?? m[2]).trim()
  const delim = Buffer.from(`--${boundary}`)

  const fields: Record<string, string> = {}
  const files: UploadedFile[] = []

  let pos = body.indexOf(delim)
  if (pos === -1) return { fields, files }
  pos += delim.length

  while (pos < body.length) {
    // 分隔符之后要么是 "--\r\n"（结束）要么是 "\r\n"（还有部件）
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2
    else if (body[pos] === 0x0a) pos += 1

    // 头部结束于 \r\n\r\n
    const headEnd = body.indexOf('\r\n\r\n', pos)
    if (headEnd === -1) break
    const rawHeaders = body.subarray(pos, headEnd).toString('utf8')
    const dataStart = headEnd + 4

    const nextDelim = body.indexOf(delim, dataStart)
    if (nextDelim === -1) break
    // 部件数据尾部有 \r\n，属于分隔符而不是内容
    let dataEnd = nextDelim
    if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2

    const nameMatch = /name="([^"]*)"/i.exec(rawHeaders)
    const fileMatch = /filename="([^"]*)"/i.exec(rawHeaders)
    const typeMatch = /Content-Type:\s*([^\r\n;]+)/i.exec(rawHeaders)
    const name = nameMatch ? nameMatch[1] : ''

    if (fileMatch) {
      files.push({
        field: name || 'file',
        filename: decodeFilename(fileMatch[1]),
        contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
        data: body.subarray(dataStart, dataEnd),
      })
    } else if (name) {
      fields[name] = body.subarray(dataStart, dataEnd).toString('utf8')
    }

    pos = nextDelim + delim.length
  }

  return { fields, files }
}

/**
 * 文件名可能带路径（老 IE 会传 C:\x\y.pdf），也可能被 MIME 编码。
 * 这里只取 basename 并剥掉控制字符——文件名会拼进本地路径，必须清干净。
 */
function decodeFilename(raw: string): string {
  let s = raw
  if (/=\?.*\?=/.test(s)) s = s.replace(/=\?[^?]*\?[Bb]\?([^?]*)\?=/g, (_x, b64: string) => {
    try {
      return Buffer.from(b64, 'base64').toString('utf8')
    } catch {
      return b64
    }
  })
  s = s.split(/[/\\]/).pop() ?? s
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'unnamed.pdf'
}

/* ------------------------------------------------------------------ */
/* 路径匹配                                                            */
/* ------------------------------------------------------------------ */

export interface RouteMatch {
  params: Record<string, string>
}

/**
 * 极简模式路由：/api/papers/:paperId/analyze
 * 只支持整段通配（:name），不支持正则——够用，且不会写出意外的匹配。
 */
export function matchPath(pattern: string, actual: string): RouteMatch | null {
  const p = pattern.split('/').filter(Boolean)
  const a = actual.split('/').filter(Boolean)
  if (p.length !== a.length) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]
    if (seg.startsWith(':')) {
      params[seg.slice(1)] = decodeURIComponent(a[i])
    } else if (seg !== a[i]) {
      return null
    }
  }
  return { params }
}

/** 从 URL 里取 path 与 query（不引 node:url 的完整解析，也不需要） */
export function splitUrl(raw: string): { path: string; query: URLSearchParams } {
  const q = raw.indexOf('?')
  if (q === -1) return { path: raw, query: new URLSearchParams() }
  return { path: raw.slice(0, q), query: new URLSearchParams(raw.slice(q + 1)) }
}
