/**
 * PDF 解析客户端 —— Node 与 Python 之间的唯一通道。
 *
 * 为什么走「spawn 进程」而不是让 Python 常驻 HTTP 服务：
 *   本阶段最怕的是部署复杂度和进程管理。spawn 一个一次性进程，
 *   退出即释放内存；解析 100 页 PDF 会吃掉上百 MB，常驻服务反而要处理回收问题。
 *   将来若换成远程解析服务，只需替换本文件，业务代码一行不用改——
 *   这正是把它封装成 client 的意义。
 *
 * 契约：任何失败都返回 { status:'failed', error_code } 而**不抛异常**。
 * 上层据此把论文标记为 failed 并展示人类可读原因，而不是让整个页面 500。
 */

import { spawn } from 'node:child_process'
import { config } from '../../config.ts'
import type { ParserResult } from '../../types.ts'

export interface ParseOptions {
  maxPages?: number
  timeoutMs?: number
}

/** 面向用户的错误码 → 中文说明，UI 直接展示这段文字 */
export const PARSER_ERROR_TEXT: Record<string, string> = {
  FILE_NOT_FOUND: '文件不存在或已被清理，请重新上传',
  EMPTY_FILE: '这是一个空文件（0 字节），不是有效的 PDF',
  NOT_A_PDF: '文件不是 PDF 格式。本阶段只支持 PDF，请检查扩展名与实际内容',
  CORRUPT_PDF: 'PDF 已损坏或无法打开，建议用其他阅读器验证后重新导出',
  ENCRYPTED: 'PDF 有密码保护，请先解除加密再上传',
  NO_TEXT_LAYER: 'PDF 中没有可提取的文字层，可能是扫描件。需要 OCR 才能解析',
  PARSE_ERROR: '解析过程中出现异常，请重试或更换文件',
  PARSER_UNAVAILABLE: '服务端未安装 PyMuPDF，无法解析 PDF',
  PARSE_TIMEOUT: '解析超时，文件可能过大或结构异常',
  SPAWN_FAILED: '无法启动 PDF 解析进程，请检查服务端 Python 环境',
  BAD_JSON: 'PDF 解析服务返回了无法识别的结果',
  REMOTE_UNAVAILABLE: '远程 PDF 解析服务不可用',
}

export const parserErrorText = (code: string, fallback: string) =>
  PARSER_ERROR_TEXT[code] ?? fallback

/* ------------------------------------------------------------------ */
/* local: spawn Python                                                 */
/* ------------------------------------------------------------------ */

function runLocal(filePath: string, opts: ParseOptions): Promise<ParserResult> {
  return new Promise((resolve) => {
    const args = [config.pdf.script, filePath, '--max-pages', String(opts.maxPages ?? config.pdf.maxPages)]
    const timeout = opts.timeoutMs ?? config.pdf.timeoutMs

    let child
    try {
      child = spawn(config.pdf.python, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({
        status: 'failed',
        error: `Cannot spawn ${config.pdf.python}: ${(e as Error).message}`,
        error_code: 'SPAWN_FAILED',
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (r: ParserResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({
        status: 'failed',
        error: `Parsing exceeded ${timeout} ms`,
        error_code: 'PARSE_TIMEOUT',
      })
    }, timeout)

    child.stdout.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr.on('data', (d) => {
      stderr += String(d)
    })

    child.on('error', (e) => {
      finish({
        status: 'failed',
        error: `Cannot run ${config.pdf.python}: ${e.message}`,
        error_code: 'SPAWN_FAILED',
      })
    })

    child.on('close', () => {
      const text = stdout.trim()
      if (!text) {
        finish({
          status: 'failed',
          error: stderr.trim() || 'Parser produced no output',
          error_code: 'SPAWN_FAILED',
        })
        return
      }
      try {
        finish(JSON.parse(text) as ParserResult)
      } catch {
        finish({
          status: 'failed',
          error: `Parser output is not valid JSON: ${text.slice(0, 200)}`,
          error_code: 'BAD_JSON',
        })
      }
    })
  })
}

/* ------------------------------------------------------------------ */
/* http: 远程解析服务                                                   */
/* ------------------------------------------------------------------ */

async function runRemote(filePath: string, opts: ParseOptions): Promise<ParserResult> {
  const { readFile } = await import('node:fs/promises')
  const { basename } = await import('node:path')

  try {
    const buf = await readFile(filePath)
    const fd = new FormData()
    fd.append('file', new Blob([new Uint8Array(buf)], { type: 'application/pdf' }), basename(filePath))
    if (opts.maxPages) fd.append('max_pages', String(opts.maxPages))

    const res = await fetch(config.pdf.remoteUrl, {
      method: 'POST',
      body: fd,
      signal: AbortSignal.timeout(opts.timeoutMs ?? config.pdf.timeoutMs),
    })
    if (!res.ok) {
      return {
        status: 'failed',
        error: `Remote parser HTTP ${res.status}`,
        error_code: 'REMOTE_UNAVAILABLE',
      }
    }
    return (await res.json()) as ParserResult
  } catch (e) {
    return {
      status: 'failed',
      error: (e as Error).message,
      error_code: 'REMOTE_UNAVAILABLE',
    }
  }
}

/* ------------------------------------------------------------------ */

export const pdfParser = {
  async parse(filePath: string, opts: ParseOptions = {}): Promise<ParserResult> {
    return config.pdf.mode === 'http' ? runRemote(filePath, opts) : runLocal(filePath, opts)
  },

  /** 健康检查用：跑一次自测，确认 PyMuPDF 真的可用 */
  async selfTest(): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
      const child = spawn(config.pdf.python, [config.pdf.script, '--selftest'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      child.stdout.on('data', (d) => {
        out += String(d)
      })
      child.stderr.on('data', (d) => {
        out += String(d)
      })
      child.on('error', (e) => resolve({ ok: false, detail: e.message }))
      child.on('close', (code) =>
        resolve({ ok: code === 0, detail: code === 0 ? 'PyMuPDF ready' : out.slice(-300) }),
      )
      setTimeout(() => child.kill('SIGKILL'), 60_000)
    })
  },
}
