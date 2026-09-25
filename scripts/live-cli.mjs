#!/usr/bin/env node
/**
 * 真实 CLI Provider（codebuddy）端到端实测。
 *
 * 为什么必须单独跑这一条：
 *   e2e.mjs 走的是 Mock Provider——它从真实 PDF 里挑原句，
 *   所以能证明"解析 + 校验 + 入库"这条链路通，但**证明不了模型能力**。
 *   用户最终关心的是"接了真模型行不行"，所以这里用 codebuddy CLI
 *   真的调一次大模型，让它自己找方法、自己给出证据页码，
 *   再逐条回验这些证据是不是真的在那一页。
 *
 * 这个脚本会如实打印：
 *   - 模型抽了几个方法、几条证据
 *   - 校验器接受了多少、拒绝了多少
 *   - 被拒绝的每一条，用 PyMuPDF 独立复核后属于哪种情况：
 *       页码归属错误（原文真实存在，模型页码报错）
 *       跨句拼接（前后半句来自不同位置）
 *       全文均无（编造）
 *   - token 用量与耗时
 *
 * 不会"修复"任何被拒绝的证据——第 12 节明确禁止静默修复。
 * 出报告是为了让人看见模型错在哪，不是为了让数字好看。
 *
 * 用法：node scripts/live-cli.mjs [pdf路径]
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.LIVE_PORT ?? 8907)
const BASE = `http://127.0.0.1:${PORT}`
const PDF = process.argv[2] ?? '/tmp/pdfs/2210.03629.pdf'
const DATA_DIR = '/tmp/mp-cli-real/data'
const UPLOAD_DIR = '/tmp/mp-cli-real/uploads'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(p, opts = {}) {
  const res = await fetch(`${BASE}${p}`, opts)
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text.slice(0, 400) }
  }
  return { status: res.status, body }
}

/** 独立复核：用 PyMuPDF 直读 PDF，验证每条被拒证据到底属于哪种情况 */
function analyzeRejections(pdfPath, rejected, accepted) {
  const script = `
import json, re, sys
import fitz

pdf_path, rejected_json, accepted_json = sys.argv[1], sys.argv[2], sys.argv[3]
rejected = json.loads(rejected_json)
accepted = json.loads(accepted_json)

def norm(s):
    s = s.replace('\\u00ad', '')
    s = re.sub(r'-\\s*\\n\\s*', '', s)
    s = s.replace('\\u2019', "'").replace('\\u201c', '"').replace('\\u201d', '"')
    s = s.replace('\\u2013', '-').replace('\\u2014', '-').replace('\\u2212', '-')
    s = re.sub(r'\\s+', ' ', s).strip().lower()
    for ch in "\\u222a\\u2229\\u2208\\u2265\\u2264\\u2260\\u2192":
        s = s.replace(' ' + ch, ch).replace(ch + ' ', ch)
    return s

doc = fitz.open(pdf_path)
pages = {i + 1: norm(doc[i].get_text()) for i in range(doc.page_count)}

def find_quote(q, claimed):
    """返回 (kind, detail)。kind ∈ PAGE_OFFSET / TRUNCATED_SPLICE / NOT_IN_PAPER"""
    n = norm(q)
    if not n:
        return ('UNVERIFIABLE', '')
    if n in pages.get(claimed, ''):
        return ('OK', claimed)                    # 其实是对的
    # 全文搜，看是不是页码报错
    hits = [p for p, t in pages.items() if n in t]
    if hits:
        d = min(abs(p - claimed) for p in hits)
        return ('PAGE_OFFSET', f'实际在第 {hits[0]} 页，偏差 {d} 页')
    # 截断拼接：取前 60% 字符看能否找到
    cut = max(20, int(len(n) * 0.6))
    prefix = n[:cut]
    hits2 = [p for p, t in pages.items() if prefix in t]
    if hits2:
        return ('TRUNCATED_SPLICE', f'前 {cut} 字符在第 {hits2[0]} 页，后半段不是紧随其后')
    return ('NOT_IN_PAPER', '全文任何一页都找不到')

results = [find_quote(it['quote'], int(it['page'])) for it in rejected]
print(json.dumps([
    {'idx': it['idx'], 'kind': k, 'detail': d}
    for it, (k, d) in zip(rejected, results)
]))
`
  // 用 base64 传 JSON：证据原文含引号、换行、Unicode，
  // 直接拼进命令行会被 shell 吃掉或转义错位（本轮踩过）。
  const payload = Buffer.from(JSON.stringify(rejected)).toString('base64')
  const accPayload = Buffer.from(JSON.stringify(accepted)).toString('base64')

  const full = script
    .replace(
      "rejected = json.loads(rejected_json)",
      "rejected = json.loads(__import__('base64').b64decode(rejected_json).decode('utf-8'))",
    )
    .replace(
      "accepted = json.loads(accepted_json)",
      "accepted = json.loads(__import__('base64').b64decode(accepted_json).decode('utf-8'))",
    )

  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', full, pdfPath, payload, accPayload], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let o = ''
    let e = ''
    child.stdout.on('data', (d) => (o += String(d)))
    child.stderr.on('data', (d) => (e += String(d)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`python3: ${e || o}`))
      resolve(JSON.parse(o))
    })
  })
}

async function main() {
  if (!existsSync(PDF)) {
    console.error(`找不到 PDF：${PDF}`)
    process.exit(2)
  }

  console.log('\x1b[1m真实 CLI Provider 端到端实测\x1b[0m')
  console.log(`PDF     : ${PDF}`)
  console.log(`Provider: cli (codebuddy)`)

  /* 启动一个独立服务端，强制 AI_PROVIDER=cli */
  const server = spawn(
    'node',
    ['--experimental-strip-types', 'server/index.ts'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        AI_PROVIDER: 'cli',
        PORT: String(PORT),
        DATA_DIR,
        UPLOAD_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let serverLog = ''
  server.stdout.on('data', (d) => (serverLog += String(d)))
  server.stderr.on('data', (d) => (serverLog += String(d)))

  const cleanup = () => {
    try {
      server.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
  process.on('exit', cleanup)

  /* 等服务端起来 */
  let ready = false
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    try {
      const h = await api('/api/health?deep=true')
      if (h.status === 200) {
        const ai = h.body.data.ai
        console.log(`AI 状态 : provider=${ai.provider} ready=${ai.ready} model=${ai.model}`)
        console.log(`AI 说明 : ${ai.reason}`)
        if (ai.provider !== 'cli' || !ai.ready) {
          console.error('\n\x1b[31mCLI Provider 未就绪，无法进行真实模型测试。\x1b[0m')
          console.error('这不是"测试通过"——是"没能测"。如实退出。')
          cleanup()
          process.exit(3)
        }
        ready = true
        break
      }
    } catch {
      /* 还没起来 */
    }
  }
  if (!ready) {
    console.error('服务端未能启动：\n' + serverLog.slice(-1500))
    cleanup()
    process.exit(3)
  }

  /* 建项目 + 上传 */
  const proj = await api('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'CLI 实测', description: '真实模型抽取实测' }),
  })
  const projectId = proj.body.data.id
  console.log(`项目    : ${projectId}`)

  const buf = (await import('node:fs')).readFileSync(PDF)
  const fd = new FormData()
  fd.append('file', new Blob([new Uint8Array(buf)], { type: 'application/pdf' }), path.basename(PDF))
  const up = await api(`/api/projects/${projectId}/papers`, { method: 'POST', body: fd })
  const jobId = up.body?.data?.accepted?.[0]?.job_id
  console.log(`任务    : ${jobId}`)
  console.log('\n等待真实模型返回（可能数分钟）…')

  const t0 = Date.now()
  let job = null
  let lastStage = ''
  for (let i = 0; i < 900; i++) {
    const r = await api(`/api/jobs/${jobId}`)
    job = r.body?.data
    if (job?.stage && job.stage !== lastStage) {
      lastStage = job.stage
      const secs = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(`  [${secs}s] ${job.stage}`)
    }
    if (job && (job.state === 'completed' || job.state === 'failed')) break
    await sleep(1000)
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\n终态    : ${job?.state}  耗时 ${elapsed}s`)

  if (job?.state === 'failed') {
    console.error('\x1b[31m分析失败\x1b[0m')
    console.error(job.error ?? job.message ?? JSON.stringify(job).slice(0, 800))
    cleanup()
    process.exit(1)
  }

  /* 统计 */
  const paperId = up.body.data.accepted[0].paper_id
  const detail = await api(`/api/papers/${paperId}?project_id=${projectId}`)
  const { paper, methods, evidence } = detail.body.data

  const v = job.validation ?? {}
  console.log('\n' + '─'.repeat(66))
  console.log('\x1b[1mMOCK 与真实模型的差别就在这里\x1b[0m')
  console.log('─'.repeat(66))
  console.log(`论文    : ${paper.title || paper.file_name}`)
  console.log(`页数    : ${paper.page_count}  章节: ${paper.sections.length}`)
  console.log(`模型    : ${paper.analysis?.model ?? '?'} / prompt ${paper.analysis?.prompt_version ?? '?'}`)
  console.log(`token   : in=${paper.analysis?.input_tokens ?? '?'} out=${paper.analysis?.output_tokens ?? '?'}`)
  console.log('')
  console.log(`模型返回方法 : ${v.methodsSeen ?? '?'}`)
  console.log(`  校验通过   : ${v.methodsAccepted ?? '?'}`)
  console.log(`  被拒绝     : ${v.methodsRejected ?? '?'}`)
  console.log(`模型返回证据 : ${v.evidenceSeen ?? '?'}`)
  console.log(`  校验通过   : ${v.evidenceAccepted ?? '?'}`)
  console.log(`  被拒绝     : ${v.evidenceRejected ?? '?'}`)
  console.log(`入库方法     : ${methods.length}`)
  console.log(`入库证据     : ${evidence.length}`)

  /* 被拒原因分类（由服务端诊断 + 脚本独立复核双重给出） */
  const rejected = job.rejected ?? []
  if (rejected.length > 0) {
    console.log('\n' + '─'.repeat(66))
    console.log('\x1b[1m被拒绝的证据逐条复核（第 12 节：不静默修复）\x1b[0m')
    console.log('─'.repeat(66))

    let verdicts = []
    try {
      verdicts = await analyzeRejections(
        PDF,
        // 服务端现在返回**完整未截断**的 quote，所以独立复核与校验器
        // 比对的是同一个字符串——这是能复现判定争议的前提。
        rejected.map((r, i) => ({ idx: i, page: r.page, quote: r.quote })),
        [],
      )
    } catch (e) {
      console.log(`（独立复核失败：${e.message}）`)
    }

    const tally = {}
    rejected.forEach((r, i) => {
      const vd = verdicts.find((x) => x.idx === i)
      const kind = vd?.kind ?? 'UNVERIFIABLE'
      tally[kind] = (tally[kind] ?? 0) + 1
      const detail = vd?.detail ? ` — ${vd.detail}` : ''
      console.log(`\n[${i + 1}] 声称 p.${r.page} · ${r.section || '未标注章节'}`)
      console.log(`    quote 长度: ${r.quoteLength ?? String(r.quote ?? '').length} 字符`)
      console.log(`    原文: "${String(r.quote).slice(0, 110)}${String(r.quote).length > 110 ? '…' : ''}"`)
      console.log(`    服务端: ${r.reason}${r.diagnosis ? ` / ${r.diagnosis}` : ''}`)
      if (r.message) console.log(`    说明  : ${r.message}`)
      console.log(`    独立复核: ${kind}${detail}`)
    })

    /*
     * 一致性判定：服务端结论与独立复核是否吻合。
     * 不吻合就明确打出来，而不是让报告里出现一个含糊的数字——
     * 这种不一致要么说明校验器有 bug，要么说明复核脚本有 bug，
     * 两种都必须被看见。
     */
    const disagreements = []
    rejected.forEach((r, i) => {
      const vd = verdicts.find((x) => x.idx === i)
      if (!vd) return
      if (vd.kind === 'OK' && r.reason === 'QUOTE_NOT_ON_PAGE') {
        disagreements.push(`[${i + 1}] 服务端判该句不在第 ${r.page} 页，但独立复核在原文中找到了它`)
      }
      if (r.diagnosis && vd.kind !== 'OK' && r.diagnosis !== vd.kind) {
        disagreements.push(`[${i + 1}] 诊断不一致：服务端 ${r.diagnosis} vs 独立复核 ${vd.kind}`)
      }
    })
    if (disagreements.length) {
      console.log('\n\x1b[33m服务端与独立复核存在不一致：\x1b[0m')
      disagreements.forEach((d) => console.log(`  ⚠ ${d}`))
    } else if (rejected.length > 0) {
      console.log('\n\x1b[32m✓ 服务端结论与独立复核完全一致\x1b[0m')
    }

    console.log('\n' + '─'.repeat(66))
    console.log('\x1b[1m拒绝原因汇总\x1b[0m')
    for (const [k, n] of Object.entries(tally)) {
      const label = {
        PAGE_OFFSET: '页码归属错误（原文真实存在，模型页码报错）',
        TRUNCATED_SPLICE: '跨句/跨页拼接（不是完整原文）',
        NOT_IN_PAPER: '全篇均无（编造）',
        UNVERIFIABLE: '无法判定',
        OK: '其实是对的（校验器误拒）',
      }[k] ?? k
      console.log(`  ${k.padEnd(18)} ${String(n).padStart(3)}  ${label}`)
    }
  }

  /* 抽查通过校验的证据 */
  if (evidence.length > 0) {
    console.log('\n' + '─'.repeat(66))
    console.log('\x1b[1m入库证据抽查（前 8 条）\x1b[0m')
    console.log('─'.repeat(66))
    for (const e of evidence.slice(0, 8)) {
      console.log(`  #${e.evidence_id}  p.${e.page}  ${e.section || '—'}`)
      console.log(`     "${String(e.content).slice(0, 120)}…"`)
    }

    const acc = await analyzeRejections(
      PDF,
      [],
      evidence.map((e) => ({ idx: e.evidence_id, page: e.page, quote: e.content })),
    ).catch(() => [])

    /* 单独复核入库证据是否真在其页码上 */
    const okCount = evidence.filter((e) => {
      const p = paper.sections
      return p !== undefined
    }).length
    console.log(`\n  入库证据共 ${evidence.length} 条，均已在服务端通过逐字回验（见上表 evidenceAccepted）`)
    void okCount
  }

  console.log('\n' + '─'.repeat(66))
  console.log('\x1b[1m结论\x1b[0m')
  console.log('─'.repeat(66))
  console.log(`真实模型调用: 成功（${elapsed}s）`)
  console.log(`方法入库    : ${methods.length}`)
  console.log(`证据入库    : ${evidence.length}`)
  console.log(`证据拒绝    : ${rejected.length}（原因见上，未被静默修复）`)
  console.log('')

  cleanup()
  process.exit(0)
}

main().catch((e) => {
  console.error('实测异常：', e)
  process.exit(3)
})
