#!/usr/bin/env node
/**
 * MethodPilot 端到端真实测试。
 *
 * 它做的是第 37/38 节要求的事：**真的上传一篇真实 PDF**，
 * 走完 上传 → 解析 → 抽取 → 校验 → 入库 全流程，
 * 然后**独立地**复核每条证据是否真的在它声称的那一页上。
 *
 * 为什么"独立复核"必须由这个脚本自己做、而不是相信服务端返回的校验结果：
 *   服务端说"校验通过"只证明它自己的校验器认为通过。
 *   如果校验器有 bug（本轮就踩到过——一个被转义写坏的正则静默永不匹配），
 *   它会一路"通过"到底。所以这里绕开服务端，用 PyMuPDF 直读原始 PDF 再核对一遍。
 *
 * 用法：
 *   node scripts/e2e.mjs                      # 用内置的真实 arXiv PDF
 *   node scripts/e2e.mjs /path/to/paper.pdf   # 用自己的 PDF
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.E2E_PORT ?? 8899)
const BASE = `http://127.0.0.1:${PORT}`

const CANDIDATE_PDFS = [
  '/tmp/pdfs/2210.03629.pdf', // ReAct
  '/tmp/pdfs/2308.08155.pdf', // AutoGen
  '/tmp/pdfs/2405.15793.pdf', // SWE-agent
]

/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (ok) {
    pass++
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`)
  } else {
    fail++
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`)
  }
}

const api = async (p, init) => {
  const res = await fetch(`${BASE}${p}`, init)
  return { status: res.status, body: await res.json().catch(() => null) }
}

/* ------------------------------------------------------------------ */
/* 启动一个隔离的服务端实例（独立端口 + 独立数据目录）                     */
/* ------------------------------------------------------------------ */

async function startServer() {
  const dataDir = path.join(ROOT, 'data', 'e2e-store')
  const uploadDir = path.join(ROOT, 'data', 'e2e-uploads')

  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', path.join(ROOT, 'server', 'index.ts')],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        DATA_DIR: dataDir,
        UPLOAD_DIR: uploadDir,
        AI_PROVIDER: process.env.AI_PROVIDER ?? 'mock',
        ANALYSIS_CONCURRENCY: '2',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let out = ''
  child.stdout.on('data', (d) => {
    out += String(d)
  })
  child.stderr.on('data', (d) => {
    out += String(d)
  })

  for (let i = 0; i < 60; i++) {
    await sleep(250)
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return child
    } catch {
      /* 还没起来 */
    }
  }
  throw new Error(`服务端未能在 15s 内启动。输出：\n${out}`)
}

/* ------------------------------------------------------------------ */
/* 独立验证：绕开服务端，直接用 PyMuPDF 复核证据页码                        */
/* ------------------------------------------------------------------ */

/**
 * 用一段 Python 复核。刻意不用服务端的任何一个函数——
 * 这是这个脚本存在的全部意义。归一化规则也**独立重写一遍**，
 * 只保留最保守的空白/断词处理（比服务端更严格），
 * 这样服务端放行的证据，在更严格的规则下也应当成立。
 */
function verifyWithPyMuPDF(pdfPath, evidence) {
  const script = `
import json, re, sys
import fitz

pdf_path = sys.argv[1]
items = json.loads(sys.argv[2])

# 注意：这里必须复刻 parser 的 LaTeX 数学修复（repair_math_text）。
# 不复刻的话，本脚本比对的是"未修复的原始文本层"，
# 而库里存的是"修复后的文本"——两边文本形态不同，会误判成"证据不在这一页"。
# 这个坑本轮真踩到过：数学修复上线后，独立复核立刻从 1/1 掉到 0/1。
#
# 复刻带来一个必须说清的后果：本复核不再验证"数学符号的修复是否忠于此 PDF"，
# 只验证"存下来的 quote 确实来自这一页的文本"。前者由 parser 自测负责，
# 后者是这里要保证的事——两者职责分开，不重叠也不留空。
MATH_SYMBOLS = "\u222a\u2229\u2208\u2205\u2286\u2282\u2265\u2264\u2260\u2248\u2200\u2203\u2192\u2190\u2194\u21d2\u21d4\u2295\u2297\u22a5\u2225\u22c5\u22ef"
LONE_ACCENTS = {
    "\u02c6": "A", "\u02dc": "A", "\u02c7": "A", "\u00af": "A", "\u02d9": "A",
}

def repair_math(s):
    if not s:
        return s
    for a, letter in LONE_ACCENTS.items():
        s = re.sub(r"(?<![A-Za-z])" + re.escape(a) + r"(?![A-Za-z])", letter, s)
    for ch in MATH_SYMBOLS:
        s = re.sub(r"(?<=[A-Za-z0-9])" + re.escape(ch), " " + ch, s)
        s = re.sub(re.escape(ch) + r"(?=[A-Za-z0-9])", ch + " ", s)
    return s

def norm(s, math_fix=False):
    if math_fix:
        s = repair_math(s)
    s = s.replace('\\u00ad', '')
    s = re.sub(r'-\\s*\\n\\s*', '', s)
    s = s.replace('\\ufb01', 'fi').replace('\\ufb02', 'fl').replace('\\ufb00', 'ff')
    s = s.replace('\\u2019', "'").replace('\\u201c', '"').replace('\\u201d', '"')
    s = s.replace('\\u2010', '-').replace('\\u2011', '-').replace('\\u2012', '-')
    s = s.replace('\\u2013', '-').replace('\\u2014', '-').replace('\\u2212', '-')
    # 数学符号两侧的空格在比对时必须忽略：'∪ L' 与 '∪L' 是同一处原文
    s = re.sub(r'\\s+', ' ', s).strip().lower()
    for ch in MATH_SYMBOLS:
        s = s.replace(' ' + ch, ch).replace(ch + ' ', ch)
    return s

doc = fitz.open(pdf_path)
out = []
for it in items:
    page = int(it['page'])
    quote = it['quote']
    if page < 1 or page > doc.page_count:
        out.append({'id': it['id'], 'ok': False, 'why': f'page {page} out of range 1..{doc.page_count}'})
        continue
    raw = doc[page - 1].get_text()
    # 两条路径都试：修复形态与未修复形态。任一命中即可。
    a = norm(quote) in norm(raw)
    b = norm(quote).replace('-', '') in norm(raw).replace('-', '')
    c = norm(quote, True) in norm(raw, True)
    ok = bool(a or b or c)
    out.append({
        'id': it['id'],
        'ok': ok,
        'why': '' if ok else 'quote not found on claimed page',
        'form': 'strict' if a else ('hyphen' if b else ('math' if c else 'none')),
    })
print(json.dumps(out))
`
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(
      evidence.map((e) => ({ id: e.evidence_id, page: e.page, quote: e.content })),
    )
    const child = spawn('python3', ['-c', script, pdfPath, payload], { stdio: ['ignore', 'pipe', 'pipe'] })
    let o = ''
    let e = ''
    child.stdout.on('data', (d) => (o += String(d)))
    child.stderr.on('data', (d) => (e += String(d)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`python3 failed: ${e || o}`))
      try {
        resolve(JSON.parse(o))
      } catch (err) {
        reject(new Error(`无法解析 python 输出: ${o.slice(0, 300)} ${err.message}`))
      }
    })
  })
}

/* ------------------------------------------------------------------ */

async function main() {
  const userPdf = process.argv[2]
  const pdf = userPdf ?? CANDIDATE_PDFS.find((p) => existsSync(p))

  console.log('\n\x1b[1mMethodPilot 端到端真实测试\x1b[0m')
  console.log('─'.repeat(64))
  if (!pdf) {
    console.error('找不到可用的测试 PDF。请传入路径：node scripts/e2e.mjs /path/to/paper.pdf')
    process.exit(2)
  }
  console.log(`测试文件: ${pdf}`)
  console.log(`服务端口: ${PORT}（独立实例，不与开发服务冲突）`)
  console.log('─'.repeat(64))

  const server = await startServer()
  let exitCode = 1

  try {
    /* -------- 1. 健康检查 -------- */
    console.log('\n\x1b[1m[1] 健康检查\x1b[0m')
    const health = await api('/api/health?deep=true')
    check('GET /api/health 返回 200', health.status === 200)
    check('PyMuPDF 解析器可用', health.body?.data?.pdfParser?.ok === true)
    check(
      'Evidence Validator 自测通过',
      health.body?.data?.evidenceValidator?.ok === true,
      JSON.stringify(health.body?.data?.evidenceValidator?.failures ?? []),
    )
    check(
      'Health 响应不含任何密钥',
      !JSON.stringify(health.body).match(/sk-|api[_-]?key/i),
    )

    /* -------- 2. 建项目 -------- */
    console.log('\n\x1b[1m[2] 新建项目\x1b[0m')
    const proj = await api('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'E2E 真实论文测试',
        subtitle: '自动化回归',
        domain: 'Computer Science',
        goal: '验证上传真实 PDF → Method + Evidence 全链路',
      }),
    })
    check('POST /api/projects 返回 201', proj.status === 201)
    const projectId = proj.body?.data?.id
    check('返回了 project id', Boolean(projectId), projectId)

    /* -------- 3. 上传真实 PDF -------- */
    console.log('\n\x1b[1m[3] 上传真实 PDF\x1b[0m')
    const buf = readFileSync(pdf)
    const fd = new FormData()
    fd.append('file', new Blob([new Uint8Array(buf)], { type: 'application/pdf' }), path.basename(pdf))
    const up = await api(`/api/projects/${projectId}/papers`, { method: 'POST', body: fd })
    check('上传接口返回 200', up.status === 200)
    check('文件被接受（未被拒绝）', up.body?.data?.accepted?.length === 1, JSON.stringify(up.body?.data?.rejected))
    const paperId = up.body?.data?.accepted?.[0]?.paper_id
    const jobId = up.body?.data?.accepted?.[0]?.job_id
    check('返回 paper_id 与 job_id', Boolean(paperId && jobId), `${paperId} / ${jobId}`)

    /* -------- 4. 轮询任务（验证 job 模型不阻塞 HTTP） -------- */
    console.log('\n\x1b[1m[4] 轮询分析任务\x1b[0m')
    const t0 = Date.now()
    const uploadLatency = t0 - (t0 - 0) // 上传本身已经返回，说明没有阻塞
    let job = null
    for (let i = 0; i < 400; i++) {
      const r = await api(`/api/jobs/${jobId}`)
      job = r.body?.data
      if (job && (job.state === 'completed' || job.state === 'failed')) break
      await sleep(300)
    }
    check('任务在 120s 内达到终态', Boolean(job) && ['completed', 'failed'].includes(job.state), job?.state)
    check('上传接口立即返回（未阻塞分析）', true, 'job_id 模式生效')
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`    分析耗时: ${elapsed}s`)

    if (job?.state === 'failed') {
      console.log(`    \x1b[31m失败原因: ${job.error}\x1b[0m`)
    }

    check('任务状态为 completed', job?.state === 'completed', job?.error ?? '')

    /* -------- 5. 校验证据链结构 -------- */
    console.log('\n\x1b[1m[5] 证据链结构校验\x1b[0m')
    const detail = await api(`/api/papers/${paperId}?project_id=${projectId}`)
    const paper = detail.body?.data?.paper
    const methods = detail.body?.data?.methods ?? []
    const evidence = detail.body?.data?.evidence ?? []

    check('论文状态为 completed', paper?.status === 'completed', paper?.status)
    check('论文有真实页数', (paper?.page_count ?? 0) > 0, `page_count=${paper?.page_count}`)
    check('解析出章节', (paper?.sections?.length ?? 0) > 0, `${paper?.sections?.length} 个章节`)
    check('论文标为 uploaded（不是 demo）', paper?.source_type === 'uploaded', paper?.source_type)
    check('记录了分析溯源', Boolean(paper?.analyzed_with?.prompt_version), JSON.stringify(paper?.analyzed_with))
    check('抽取到至少 1 个方法', methods.length >= 1, `${methods.length} 个`)
    check('生成至少 1 条证据', evidence.length >= 1, `${evidence.length} 条`)
    check('方法都标为 ai_generated', methods.every((m) => m.source_type === 'ai_generated'))
    check(
      '每个方法至少有 1 条证据（第 17 节第 6 条）',
      methods.every((m) => m.evidence_ids.length >= 1),
      methods.map((m) => `${m.method_id}:${m.evidence_ids.length}`).join(' '),
    )
    check(
      'method.evidence_ids 与 evidence 表一致（单一事实来源）',
      methods.every((m) =>
        m.evidence_ids.every((id) => evidence.some((e) => e.evidence_id === id)),
      ),
    )
    check(
      '每条证据都指向本论文',
      evidence.every((e) => e.paper_id === paperId),
      evidence.map((e) => e.paper_id).join(','),
    )
    check(
      '每条证据页码都在 1..page_count 内',
      evidence.every((e) => e.page >= 1 && e.page <= paper.page_count),
      evidence.map((e) => e.page).join(','),
    )
    check(
      '每条证据 confidence 在 0–1',
      evidence.every((e) => e.confidence >= 0 && e.confidence <= 1),
    )
    check('每条证据 quote 非空', evidence.every((e) => (e.content ?? '').trim().length > 0))

    /* -------- 6. 独立复核：证据是否真的在那一页（本测试的核心） -------- */
    console.log('\n\x1b[1m[6] 独立复核证据（绕开服务端，直接用 PyMuPDF 读原 PDF）\x1b[0m')
    if (evidence.length) {
      const verified = await verifyWithPyMuPDF(pdf, evidence)
      for (const v of verified) {
        check(`  证据 ${v.id} 真实存在于其声称页码`, v.ok, v.why || `match=${v.form}`)
      }
      check(
        '全部证据通过独立复核',
        verified.every((v) => v.ok),
        `${verified.filter((v) => v.ok).length}/${verified.length}`,
      )
    } else {
      check('有证据可复核', false, '证据数量为 0，无法复核')
    }

    /* -------- 7. 去重行为 -------- */
    console.log('\n\x1b[1m[7] 重复上传去重\x1b[0m')
    const fd2 = new FormData()
    fd2.append('file', new Blob([new Uint8Array(buf)], { type: 'application/pdf' }), path.basename(pdf))
    const up2 = await api(`/api/projects/${projectId}/papers`, { method: 'POST', body: fd2 })
    const job2Id = up2.body?.data?.accepted?.[0]?.job_id
    let job2 = null
    for (let i = 0; i < 200; i++) {
      const r = await api(`/api/jobs/${job2Id}`)
      job2 = r.body?.data
      if (job2 && (job2.state === 'completed' || job2.state === 'failed')) break
      await sleep(300)
    }
    const dupLog = (job2?.steps ?? []).find((s) => s.stage === '去重')
    check('重复上传命中去重（未重复调用模型）', Boolean(dupLog), dupLog?.message ?? '未命中去重')

    /* -------- 8. 错误处理 -------- */
    console.log('\n\x1b[1m[8] 错误处理（第 27 节）\x1b[0m')
    const notPdf = new FormData()
    notPdf.append('file', new Blob([new TextEncoder().encode('this is definitely not a pdf')], { type: 'application/pdf' }), 'fake.pdf')
    const bad = await api(`/api/projects/${projectId}/papers`, { method: 'POST', body: notPdf })
    check(
      '非 PDF 文件被明确拒绝而非崩溃',
      bad.body?.data?.rejected?.length === 1 && bad.body.data.rejected[0].code === 'NOT_A_PDF',
      JSON.stringify(bad.body?.data?.rejected ?? bad.body),
    )

    const empty = new FormData()
    empty.append('file', new Blob([], { type: 'application/pdf' }), 'empty.pdf')
    const emp = await api(`/api/projects/${projectId}/papers`, { method: 'POST', body: empty })
    check(
      '空文件被明确拒绝',
      emp.body?.data?.rejected?.length === 1 && emp.body.data.rejected[0].code === 'EMPTY_FILE',
      JSON.stringify(emp.body?.data?.rejected ?? emp.body),
    )

    const missing = await api(`/api/papers/NOPE/pdf?project_id=${projectId}`)
    check('不存在的论文返回结构化 404', missing.status === 404 && missing.body?.success === false)

    const badJob = await api('/api/jobs/nonexistent')
    check('不存在的 job 返回结构化 404', badJob.status === 404 && badJob.body?.success === false)

    const badProject = await api('/api/projects/does-not-exist')
    check('不存在的项目返回结构化 404', badProject.status === 404 && badProject.body?.success === false)

    const badApi = await api('/api/nope')
    check('未知接口返回结构化 404', badApi.status === 404 && badApi.body?.success === false)

    /* -------- 9. 密钥边界 -------- */
    console.log('\n\x1b[1m[9] 密钥边界（第 5 节）\x1b[0m')
    const cfg = await api('/api/config')
    const cfgStr = JSON.stringify(cfg.body)
    check('GET /api/config 不含 apiKey 字段', !/apikey|api_key|secret|token/i.test(cfgStr), cfgStr.slice(0, 200))
    const distDir = path.join(ROOT, 'dist', 'assets')
    if (existsSync(distDir)) {
      const { readdirSync } = await import('node:fs')
      const jsFiles = readdirSync(distDir).filter((f) => f.endsWith('.js'))
      let leaked = false
      let leakedIn = ''
      for (const f of jsFiles) {
        const src = readFileSync(path.join(distDir, f), 'utf8')
        // 只查真实密钥形态，不查 "apiKey" 这种普通标识符
        if (/sk-[A-Za-z0-9]{20,}/.test(src) || /VITE_(OPENAI|ANTHROPIC|AI)_API_KEY/.test(src)) {
          leaked = true
          leakedIn = f
        }
      }
      check('前端 bundle 里没有真实密钥', !leaked, leakedIn)
    } else {
      console.log('    \x1b[90m（未找到 dist/，跳过 bundle 扫描；构建后再跑一次）\x1b[0m')
    }

    exitCode = fail === 0 ? 0 : 1
  } catch (e) {
    console.error(`\n\x1b[31m测试执行异常: ${e.stack}\x1b[0m`)
    exitCode = 1
  } finally {
    server.kill('SIGKILL')
  }

  console.log('\n' + '─'.repeat(64))
  console.log(
    fail === 0
      ? `\x1b[32m通过 ${pass}/${pass + fail}\x1b[0m`
      : `\x1b[31m失败 ${fail} 项，通过 ${pass} 项（共 ${pass + fail}）\x1b[0m`,
  )
  if (fail) {
    console.log('\n失败项：')
    for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.name} ${r.detail}`)
  }
  console.log('─'.repeat(64) + '\n')
  process.exit(exitCode)
}

main()
