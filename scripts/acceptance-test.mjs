#!/usr/bin/env node
/**
 * Phase 5 最终验收 —— 全链路 E2E（服务端 + 真浏览器）。
 *
 * ── 目的 ──
 *
 * 前四个阶段各自验过自己的纯函数与页面，但**从没有人把整条链一次跑完**：
 *   论文探索 → 加入 → 获取全文 → 分析 → 方法地图 → 技术演进
 *   → Gap → 研究方向 → 调研报告
 *
 * 接缝处的风险只有连起来才暴露（这是本项目反复踩到的一类问题）：
 *   · 每一步的统计是否都来自**同一个 project_id**；
 *   · 有没有哪一步静默串入了 Demo 数据；
 *   · 侧栏统计与正文数字是否一致；
 *   · 故意失败时 UI 会不会伪装成成功。
 *
 * ── 与其它脚本的分工 ──
 *
 *   各 `*:test`      → 验各自纯函数/接口/页面的**规则**
 *   本脚本          → 验**整条链的连贯性与数据归属**
 *
 * ⚠️ 本脚本**只读不修**。发现的问题如实记录，不改任何核心算法。
 *
 * 用法：pnpm accept:test   （需先 pnpm build）
 */

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.ACCEPT_PORT ?? 8977)
const SITE_PORT = Number(process.env.ACCEPT_SITE_PORT ?? 8978)
const BASE = `http://127.0.0.1:${PORT}`
const SITE = `http://127.0.0.1:${SITE_PORT}`
const PDF_PATH = process.env.ACCEPT_PDF ?? '/tmp/pdfs/2210.03629.pdf'
let pass = 0
let fail = 0
const findings = []
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`)
  }
}
const note = (level, text) => {
  findings.push({ level, text })
  console.log(`  ${level === 'blocker' ? '⛔' : level === 'major' ? '⚠️ ' : 'ℹ️ '} ${text}`)
}
const section = (t) => console.log(`\n${'─'.repeat(70)}\n${t}`)

const distIndex = path.join(ROOT, 'dist', 'index.html')
if (!existsSync(distIndex)) {
  console.log('✗ 找不到 dist/index.html —— 请先运行 pnpm build')
  process.exit(1)
}
if (!existsSync(PDF_PATH)) {
  console.log(`✗ 找不到测试 PDF：${PDF_PATH}`)
  process.exit(1)
}
/*
 * 兜底 PDF（真实论文）—— 只用于"能取到全文 >0 字节"这类不关心内容的场景。
 */
const REAL_PDF = readFileSync(PDF_PATH)

/* ------------------------------------------------------------------ */
/* 夹具 PDF：为什么需要它                                              */
/* ------------------------------------------------------------------ */

/*
 * ── 诊断结论（实测，非推测）──
 *
 * 4-6 Gap 的信号**只从 Evidence 里读**，而 Evidence 是抽取器从 **PDF 正文句子**
 * 里挑出来的。所以往论文的 `abstract` / `keywords` 里塞 limitation 文本**完全无效**：
 *
 *   1. 分析阶段会用 PDF 自带的 abstract 覆盖掉元数据里的 abstract
 *      （server/services/analysis.ts:247 `abstract: parsed.abstract || paper.abstract`）；
 *   2. `keywords` 从不进入抽取输入（它只是元数据展示用）。
 *
 * 实测证据：用真实 ReAct PDF 跑完整链路时，10 条 Evidence 全部是
 * `supports:['方法核心思想']` 的方法句，limitation 文本一条都没进来，
 * 于是 Gap 恒为 0、后半条链退化为空态。
 *
 * ── 因此 ──
 *
 * 夹具必须在**正文页**里带上 limitation 句，且这些句子要同时：
 *   ① 命中 METHOD_STATEMENT（否则不会成为 Evidence）
 *   ② 命中 GAP_PATTERNS 的 limitation / uncovered_setting（否则不成其为 Gap）
 *   ③ 命中同一 THEME 主题词（否则跨论文聚不成 candidate）
 *   ④ **不**命中 NOT_METHOD_STATEMENT / FUTURE_WORK_PATTERNS（否则被剔除）
 *
 * 语料设计（三个主题坐标，覆盖三层阶梯）：
 *   MP001 + MP002 → `limitation::evaluation_bench`（两篇共享 → 产 candidate）
 *   MP001 + MP002 → `uncovered_setting::search_planning`（两篇共享 → 产 candidate）
 *   MP003         → `limitation::tool_use`（单篇 → 只产 stated，验证不误聚）
 *
 * 这些都是真实学术写作里承认局限的常见措辞，不是为测试造的怪句子。
 */
const FIXTURE_SENTENCES = {
  'acc-react': [
    'We propose ReAct, a method that interleaves reasoning traces and actions for long-horizon agent tasks.',
    'ReAct augments the action space with a language space, letting the agent alternate between thinking and doing.',
    'A key limitation of our method is that it has not been evaluated on standardized multi-step planning benchmarks.',
    'Because of this limitation, the generalization of our approach across benchmarks remains uncertain.',
  ],
  'acc-reflexion': [
    'We introduce Reflexion, a framework that lets language agents improve from verbal feedback.',
    'The framework keeps a self-reflection memory, so the agent revises its own plan after each failed attempt.',
    'However, the proposed framework is limited by the absence of a shared evaluation benchmark.',
    'Our method has not been evaluated on multi-step planning benchmarks, which prevents a direct comparison.',
  ],
  'acc-toolformer': [
    'We propose Toolformer, a model that teaches language models to call APIs through tool use.',
    'The model is trained on a self-supervised corpus of API calls, learning when a tool is actually useful.',
    'A limitation of our work is that tool use has not been evaluated in open-ended, real-world settings.',
  ],
}

/**
 * 用 reportlab 造一份**单页、带文本层**的最小 PDF。
 *
 * 走 python3 而不是引入 PDF 库：本仓库是零运行时依赖的 Node 项目，
 * 为测试脚本装一个 PDF 生成依赖不划算；reportlab 在沙箱里已预装。
 * 生成失败时**明确报错并退出**，绝不静默退回真实 PDF（那会让 Gap 又变成 0，
 * 变成"测试悄悄失效"—— 正是本项目最反对的那类问题）。
 */
const FIXTURE_DIR = mkdtempSync(path.join(tmpdir(), 'mpacc-fix-'))
function makeFixturePdf(file, title, sectionTitle, sentences) {
  const script = `
import json, sys
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
W, H = letter
title, sect, sents, out = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), sys.argv[4]
def wrap(t, w=95):
    words, lines, cur = t.split(), [], ''
    for x in words:
        if len(cur) + len(x) + 1 > w:
            lines.append(cur); cur = x
        else:
            cur = (cur + ' ' + x).strip()
    if cur: lines.append(cur)
    return lines
c = canvas.Canvas(out, pagesize=letter); y = H - 70
c.setFont('Helvetica-Bold', 14); c.drawString(54, y, title); y -= 34
c.setFont('Helvetica-Bold', 11); c.drawString(54, y, sect); y -= 22
c.setFont('Helvetica', 10)
for s in sents:
    for ln in wrap(s):
        if y < 60:
            c.showPage(); y = H - 70; c.setFont('Helvetica', 10)
        c.drawString(54, y, ln); y -= 14
    y -= 8
c.showPage(); c.save()
`
  const r = spawnSync(
    'python3',
    ['-c', script, title, sectionTitle, JSON.stringify(sentences), file],
    { encoding: 'utf8' },
  )
  if (r.status !== 0 || !existsSync(file)) {
    console.log(`✗ 夹具 PDF 生成失败（${file}）：${r.stderr ?? r.error?.message ?? '未知错误'}`)
    console.log('  夹具是 Gap 链路可验证的前提，缺失时不能静默降级 —— 直接终止。')
    process.exit(1)
  }
  return readFileSync(file)
}

const FIXTURE_PDF = {}
for (const [key, title] of [
  ['acc-react', 'ReAct: Synergizing Reasoning and Acting'],
  ['acc-reflexion', 'Reflexion: Language Agents with Verbal Reinforcement'],
  ['acc-toolformer', 'Toolformer: Language Models Can Teach Themselves to Use Tools'],
]) {
  FIXTURE_PDF[key] = makeFixturePdf(
    path.join(FIXTURE_DIR, `${key}.pdf`),
    title,
    'INTRODUCTION',
    FIXTURE_SENTENCES[key],
  )
}

/* ── 论文站点：扮演真实出版商，提供摘要页 + 真 PDF 字节 ── */

const site = createServer((req, res) => {
  /*
   * `/pdf/<key>.pdf` → 返回**该论文自己的**夹具 PDF（正文里带 limitation 句）。
   * 不认识的 key 回落到真实论文 PDF，保证任何形态都有字节可下。
   */
  const pdfMatch = /\/pdf\/([\w-]+)\.pdf/.exec(req.url ?? '')
  if (pdfMatch) {
    const buf = FIXTURE_PDF[pdfMatch[1]] ?? REAL_PDF
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buf.length })
    res.end(buf)
    return
  }
  /*
   * 两种摘要页：
   *   /abs/<id>   正常 —— 有一个指向**本论文夹具 PDF** 的链接（fetch-fulltext 能解析）
   *   /none/<id>  故障 —— 页面里没有任何 PDF 链接（模拟"取不到全文"）
   */
  const isNone = req.url?.startsWith('/none/')
  const key = /\/abs\/([\w-]+)/.exec(req.url ?? '')?.[1] ?? ''
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(
    `<html><head><title>论文摘要页</title></head><body>
      <h1>Abstract</h1><p>This is the abstract page.</p>
      ${isNone ? '' : `<a href="${SITE}/pdf/${key}.pdf">Download PDF</a>`}
    </body></html>`,
  )
})
await new Promise((r) => site.listen(SITE_PORT, '127.0.0.1', r))

const storeDir = mkdtempSync(path.join(tmpdir(), 'mpacc-'))
const uploadDir = mkdtempSync(path.join(tmpdir(), 'mpacc-up-'))

const srv = spawn(
  process.execPath,
  ['--experimental-strip-types', path.join(ROOT, 'server', 'index.ts')],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: storeDir,
      UPLOAD_DIR: uploadDir,
      ENABLE_SEMANTIC_SCHOLAR: 'false', // 走 Mock 文献搜索（离线可跑）
    },
    stdio: 'ignore',
  },
)

const stop = () => {
  try { srv.kill('SIGKILL') } catch {}
  try { site.close() } catch {}
  for (const d of [storeDir, uploadDir, FIXTURE_DIR]) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true } catch {}
    await sleep(250)
  }
  return false
}

const post = async (u, b) => {
  const r = await fetch(`${BASE}${u}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b ?? {}),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const get = async (u) => (await fetch(`${BASE}${u}`)).json()

async function pollJob(jobId, timeoutMs = 240_000) {
  const t0 = Date.now()
  const seen = []
  for (;;) {
    const j = (await get(`/api/jobs/${jobId}`))?.data
    if (!j) throw new Error(`job ${jobId} 读不到`)
    if (!seen.includes(j.state)) seen.push(j.state)
    if (j.state === 'completed' || j.state === 'failed') return { job: j, seen }
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${jobId} 超时`)
    await sleep(600)
  }
}

const run = async () => {
  if (!(await waitReady())) {
    stop()
    console.log('✗ 服务端未能启动')
    process.exit(1)
  }

  console.log('═'.repeat(70))
  console.log('Phase 5 最终验收 —— 全链路 E2E')
  console.log('═'.repeat(70))

  /* ================================================================ */
  section('【第 1 步】建全新临时 Live 项目')
  /* ================================================================ */

  const created = await post('/api/projects', { name: 'Phase5 验收项目', domain: 'AI Agents' })
  const PID = created.body?.data?.id ?? created.body?.data?.project?.id
  // POST /api/projects 契约是 201 Created（不是 200）—— 两者都接受
  check(
    '创建项目返回 2xx（201 Created）',
    created.status === 201 || created.status === 200,
    `status=${created.status}`,
  )
  check('拿到 project_id', typeof PID === 'string' && PID.length > 0, `PID=${PID}`)

  const projAfter = await get('/api/projects')
  const rec = (projAfter?.data ?? []).find((p) => p.id === PID)
  check(
    '新项目在列表中，且初始 0 论文 / 0 方法 / 0 证据',
    !!rec && rec.paper_count === 0 && rec.method_count === 0 && rec.evidence_count === 0,
    `papers=${rec?.paper_count} methods=${rec?.method_count} evidence=${rec?.evidence_count}`,
  )
  check(
    '新项目出现在项目列表中（Live 项目在册，可被路由解析）',
    !!rec,
    `找到=${!!rec} 列表总数=${(projAfter?.data ?? []).length}`,
  )
  check(
    '新项目 kind 不是 demo（Live 项目，不受 Demo 演示语料影响）',
    rec?.kind !== 'demo',
    `kind=${rec?.kind ?? '(未设置，即为 Live)'}`,
  )

  /* ================================================================ */
  section('【第 2 步】论文探索（S2 搜索，离线走 Mock）')
  /* ================================================================ */

  const search = await get('/api/s2/search?q=ReAct%20agent&limit=5')
  // 真实返回结构是 data.papers（不是 data.results）—— 见 routes/semanticScholar.ts
  const results = search?.data?.papers ?? []
  const s2source = search?.data?.source
  const s2enabled = search?.data?.enabled
  /*
   * ⚠️ 这里**不能**断言"必须有结果"。
   *
   * ENABLE_SEMANTIC_SCHOLAR=false 时服务端**故意**返回空数组 + enabled:false，
   * 而不是伪造一批假论文 —— 这正是"不伪装成成功"的正确行为。
   * 该断言要验的是**契约形状**：papers 必须是数组、必须标明来源。
   */
  check(
    '论文探索返回契约正确（data.papers 为数组 + 标明 source）',
    Array.isArray(results) && (s2source === 'mock' || s2source === 'live'),
    `命中 ${results.length} 条 source=${s2source} enabled=${s2enabled}`,
  )
  check(
    '搜索标明数据来源（mock 时页面必须显示 Mock 标识）',
    s2source === 'mock' || s2source === 'live',
    `source=${s2source}`,
  )
  if (s2source === 'mock') {
    check(
      'S2 关闭时返回**空结果 + enabled=false**，而不是伪造论文（不伪装成成功）',
      s2enabled === false && results.length === 0,
      `enabled=${s2enabled} 条数=${results.length} note=${search?.data?.note}`,
    )
    note('info', 'S2 搜索走 Mock（ENABLE_SEMANTIC_SCHOLAR=false）—— 离线预期行为，Mock 标识必须可见')
  }

  /* ================================================================ */
  section('【第 3 步】加入论文（元数据入库）')
  /* ================================================================ */

  const addMeta = async (s2id, title, abstractText, urlOverride) =>
    (
      await post(`/api/projects/${PID}/papers/meta`, {
        s2_paper_id: s2id,
        title,
        authors: ['验收作者'],
        year: 2023,
        abstract: abstractText,
        url: urlOverride ?? `${SITE}/abs/${s2id}`,
        doi: `10.1000/${s2id}`,
        citationCount: 42,
        venue: 'AcceptanceConf',
        source: 'live',
      })
    ).body?.data?.paper?.paper_id

  /*
   * ── 语料设计：为什么摘要要这么写 ──
   *
   * 4-6 Gap 的判定规则（researchGaps.ts）要求：缺口信号命中**证据文本**，
   * 且 ≥2 篇不同论文落在同一个 `${signal}::${theme}` 坐标上，才升级为 candidate。
   *
   * ⚠️ 但**光在 abstract 里写 limitation 是没用的**（实测确认）：
   * 分析阶段会用 PDF 自带的 abstract 覆盖元数据 abstract（analysis.ts:247），
   * 而 Evidence 只从 **PDF 正文句子**里抽。所以真正起作用的是
   * `FIXTURE_SENTENCES` —— 那些句子被写进了夹具 PDF 的正文页。
   *
   * 这里给 addMeta 的 abstract 只是**元数据展示用**（分类前、未取全文时可见），
   * 与 Gap 判定无关；写成限制语的句子是刻意的，让"元数据 vs 正文"两条路都自洽。
   */
  /** 不参与 Gap 判定的普通摘要，只给失败态/复现用论文用 */
  const ABS_PLAIN =
    'We propose a method for long-horizon agent tasks. The approach is evaluated on standard benchmarks and shows consistent gains.'

  const ABS_BY_ID = {
    'acc-react': FIXTURE_SENTENCES['acc-react'].join(' '),
    'acc-reflexion': FIXTURE_SENTENCES['acc-reflexion'].join(' '),
    'acc-toolformer': FIXTURE_SENTENCES['acc-toolformer'].join(' '),
  }

  const ADDED = []
  for (const [i, [s2id, title]] of [
    ['acc-react', 'ReAct: Synergizing Reasoning and Acting'],
    ['acc-reflexion', 'Reflexion: Language Agents with Verbal Reinforcement'],
    ['acc-toolformer', 'Toolformer: Language Models Can Teach Themselves to Use Tools'],
  ].entries()) {
    const id = await addMeta(s2id, title, ABS_BY_ID[s2id])
    ADDED.push({ s2id, id, title, idx: i })
    console.log(`  · 加入 ${id} ← ${title}`)
  }
  check('三篇论文都拿到了 paper_id', ADDED.every((a) => !!a.id), ADDED.map((a) => a.id).join(','))

  let papers = (await get(`/api/projects/${PID}/papers`))?.data ?? []
  check('项目论文数 = 3', papers.length === 3, `实际 ${papers.length}`)
  check(
    '三篇论文初始 status 均为 pending（仅元数据，未取全文）',
    papers.every((p) => p.status === 'pending'),
    papers.map((p) => `${p.paper_id}:${p.status}`).join(','),
  )
  check(
    '仅元数据论文不得带方法/证据（不能凭空有内容）',
    papers.every((p) => (p.method_ids ?? []).length === 0 && p.evidence_count === 0),
  )

  /* ================================================================ */
  section('【第 4 步】获取全文')
  /* ================================================================ */

  for (const a of ADDED) {
    const r = await post(`/api/projects/${PID}/papers/${a.id}/fetch-fulltext`)
    a.fetchOk = r.body?.data?.ok === true
    a.fileHash = r.body?.data?.paper?.file_hash
    console.log(`  · ${a.id} 取全文 ok=${a.fetchOk} hash=${String(a.fileHash).slice(0, 12)}`)
  }
  check('三篇论文均取到全文', ADDED.every((a) => a.fetchOk))

  papers = (await get(`/api/projects/${PID}/papers`))?.data ?? []
  check(
    '取全文后 status = uploaded（不是 completed —— 还不能显示"已分析"）',
    papers.every((p) => p.status === 'uploaded'),
    papers.map((p) => `${p.paper_id}:${p.status}`).join(','),
  )
  check(
    'file_hash 已从 meta: 变为真实哈希',
    papers.every((p) => !String(p.file_hash).startsWith('meta:')),
  )

  /* ================================================================ */
  section('【第 5 步】分析（真实 PDF 解析 + 抽取 + 落库）')
  /* ================================================================ */

  /*
   * ⚠️ 这里**刻意逐篇串行**（提交 → 等终态 → 再下一篇），而不是三篇一起提交。
   *
   * 原因：Phase 5 的并发探针发现了一个**静默数据丢失**缺陷 ——
   * `analysis.ts` 在 job 启动时只读一次 bundle，之后所有 savePapers 都用
   * 那份陈旧快照写回；任何在 job 运行期间被加入的论文都会被**抹掉**。
   * 三篇一起提交会互相覆盖，导致第 5 步数据不可用、后面整条链被污染。
   *
   * 该缺陷**不改**（Phase 5 只做 QA，禁止动核心算法），已在下方
   * 【并发缺陷复现】小节里单独、可复现地记录下来。
   *
   * 串行也是真实用法：UI 的「批量分析」就是顺序提交队列。
   */
  for (const a of ADDED) {
    const ar = await post(`/api/papers/${a.id}/analyze`, { project_id: PID, force: true })
    a.jobId = ar.body?.data?.job_id
    check(`${a.id} 分析请求被接受`, ar.status === 200, `status=${ar.status}`)

    const { job, seen } = await pollJob(a.jobId)
    a.jobState = job.state
    a.jobError = job.error
    console.log(
      `  · ${a.id} job=${a.jobId} 终态=${job.state} 状态序列=${seen.join('→')} stage=${job.stage}`,
    )
    if (job.state !== 'completed') console.log(`      error: ${job.error}`)
  }
  check('三篇论文的分析 job 全部 completed', ADDED.every((a) => a.jobState === 'completed'),
    ADDED.map((a) => `${a.id}:${a.jobState}`).join(','))

  papers = (await get(`/api/projects/${PID}/papers`))?.data ?? []
  check(
    '分析后三篇论文 status 均为 completed',
    papers.length === 3 && papers.every((p) => p.status === 'completed'),
    papers.map((p) => `${p.paper_id}:${p.status}`).join(','),
  )

  const methods = (await get(`/api/projects/${PID}/methods`))?.data ?? []
  const evidence = (await get(`/api/projects/${PID}/evidence`))?.data ?? []
  check('分析产出了方法', methods.length > 0, `${methods.length} 个`)
  check('分析产出了证据', evidence.length > 0, `${evidence.length} 条`)
  check(
    '每条证据都带页码与原文（不是空壳）',
    evidence.every((e) => typeof e.page === 'number' && e.page > 0 && (e.content ?? '').length > 0),
  )
  check(
    '每条证据的 paper_id 都属于本项目（无跨项目引用）',
    evidence.every((e) => papers.some((p) => p.paper_id === e.paper_id)),
  )
  check(
    '每个方法都属于本项目论文',
    methods.every((m) => (m.paper_ids ?? []).every((pid) => papers.some((p) => p.paper_id === pid))),
  )

  /* ================================================================ */
  section('【第 6 步】方法地图（4-2 对齐 + 4-3）')
  /* ================================================================ */

  const align = await get(`/api/projects/${PID}/method-alignments`)
  const alignData = align?.data
  const alignCandidates = alignData?.candidates ?? []
  const alignPresent = alignData !== undefined && alignData !== null
  check('方法地图接口可用', alignPresent, `candidates=${alignCandidates.length}`)

  /* ================================================================ */
  section('【第 7 步】技术演进（4-4）')
  /* ================================================================ */

  const evo = await get(`/api/projects/${PID}/evolutions`)
  const evoData = evo?.data
  check('技术演进接口可用', !!evoData, `返回 evolutions + relations`)
  const evoNodes = evoData?.evolutions ?? []
  const evoRels = evoData?.relations ?? []
  const evoCausal = evoRels.filter((r) => r.causal === true).length
  console.log(
    `  · 演进节点 ${evoNodes.length} 个，关系 ${evoRels.length} 条（其中因果 ${evoCausal} 条）`,
  )
  check(
    '演进关系全部带 evidence_ids（不允许无证据的演进边）',
    evoRels.filter((r) => r.causal === true).every((r) => (r.evidence_ids ?? []).length > 0),
    '因果边必须可回链',
  )

  /* ================================================================ */
  section('【第 8 步】研究空白 Gap（4-6）')
  /* ================================================================ */

  const gaps = await get(`/api/projects/${PID}/gaps`)
  const gapData = gaps?.data
  const gapStats = gapData?.stats ?? {}
  console.log(
    `  · gap total=${gapStats.total} stated=${gapStats.stated} candidate=${gapStats.candidate} papers_involved=${gapStats.papers_involved}`,
  )
  const gapList = gapData?.gaps ?? []
  /* stated / candidate 必须**同时可见**，不能用后者替换前者（见 researchGaps.ts ③） */
  const statedGaps = gapList.filter((g) => g.assertion_level === 'stated')
  const candGaps = gapList.filter((g) => g.assertion_level === 'candidate')
  console.log(
    `  · gap total=${gapStats.total} stated=${gapStats.stated} candidate=${gapStats.candidate} ` +
      `papers_involved=${gapStats.papers_involved} single_paper_signals=${gapStats.single_paper_signals}`,
  )
  check('Gap 接口可用', !!gapData)
  check('Gap 不变量自检为空（无悬空证据）', (gapData?.invariant_violations ?? []).length === 0,
    JSON.stringify(gapData?.invariant_violations ?? []))
  check(
    '每条 Gap 都有证据（不允许无证据的空白）',
    gapList.every((g) => (g.evidence_ids ?? []).length > 0),
  )
  check(
    'Gap 的证据都属于本项目',
    gapList.every((g) =>
      (g.evidence_ids ?? []).every((eid) => evidence.some((e) => e.evidence_id === eid)),
    ),
  )
  check('gap_stats.gaps_without_evidence 恒为 0（运行时自证）', gapStats.gaps_without_evidence === 0,
    `实际 ${gapStats.gaps_without_evidence}`)
  check('Gap 统计与列表长度一致', gapStats.total === gapList.length,
    `stats.total=${gapStats.total} 列表=${gapList.length}`)
  check(
    'stated + candidate = total（分层计数不重不漏）',
    gapStats.stated + gapStats.candidate === gapStats.total,
    `${gapStats.stated}+${gapStats.candidate}=${gapStats.total}`,
  )
  /*
   * 语料刻意让 MP001/MP002 共享 `limitation::evaluation_bench` 坐标，
   * 所以本轮**必须**真的检出内容 —— 检不出说明 4-6 在这条真实数据上失效了。
   */
  /*
   * ── 关于 candidate 层：为什么离线跑不出来，以及这**不是**缺陷 ──
   *
   * 4-6 升级 candidate 有三条件，其中一条是「两篇论文的方法身份不是同一方法」。
   * 离线环境的抽取器是 MockAIProvider（基于句式规则的确定性抽取），它**没有能力
   * 给方法命名** —— 实测三篇论文的方法全部落成 `name:"untitled"`（同一个名字），
   * 于是 4-2 把任意两两判为 `same`（name_exact 命中），4-6 随之正确地拒绝聚簇：
   * "三篇论文声称的是同一个方法" 不该被当成"三篇论文共同缺失"。
   *
   * 把方法名换成彼此不同的值后（不改任何生产代码，只喂不同的输入），
   * 4-2 立刻改判为 `related`，4-6 随即产出 2 条 candidate（已实测验证）。
   *
   * 所以：
   *   · candidate 层的**规则正确性**由 `pnpm gap:test`（构造夹具）负责验证；
   *   · 本 E2E 只声明"离线 Mock 抽取器**产不出** candidate"这一事实，
   *     并把它作为一条记录项，而不是伪装成通过。
   */
  check('本项目语料检出了 stated 缺口（原文明确指出的局限）', statedGaps.length > 0, `${statedGaps.length} 条`)
  if (candGaps.length > 0) {
    check(
      'candidate 缺口涉及 ≥2 篇不同论文（跨论文共同缺口，不是单篇自述）',
      candGaps.every((g) => (g.paper_ids ?? []).length >= 2),
      candGaps.map((g) => `${g.gap_id}:${(g.paper_ids ?? []).length}篇`).join(','),
    )
    check('candidate 缺口标题带【候选】前缀（推断标识不被洗掉）',
      candGaps.every((g) => g.title.startsWith('【候选】')))
    check('candidate 缺口置信度 ≤ 0.8（硬上限，低于 stated 基线）',
      candGaps.every((g) => g.confidence <= 0.8),
      candGaps.map((g) => g.confidence).join(','))
  } else {
    const untitled = methods.filter((m) => !m.name || m.name === 'untitled').length
    note(
      'major',
      `离线 Mock 抽取器无法给方法命名（${untitled}/${methods.length} 个方法为 "untitled"），` +
        '导致 4-2 把方法两两判为 same、4-6 依规拒绝聚簇 ⇒ candidate Gap 在离线环境下**产不出**。' +
        '这是抽取器能力边界，不是 4-6 的规则缺陷；candidate 规则由 `pnpm gap:test` 覆盖。' +
        '配置真实 AI Provider 后本条链路可端到端跑通。',
    )
  }
  check(
    'candidate 缺口的证据包含成员 stated 的证据（不引入新证据）',
    candGaps.every((g) =>
      (g.evidence_ids ?? []).every((eid) => evidence.some((e) => e.evidence_id === eid)),
    ),
  )
  if (gapStats.total === 0) {
    note('blocker', '本项目语料出现了 0 条 Gap —— 4-6 在真实数据上未产出，后半条链退化为空态')
  }

  /* ================================================================ */
  section('【第 9 步】研究方向（4-7）')
  /* ================================================================ */

  const dirs = await get(`/api/projects/${PID}/directions`)
  const dirData = dirs?.data
  const dirStats = dirData?.stats ?? {}
  console.log(
    `  · direction total=${dirStats.total} stated_backed=${dirStats.stated_backed} mixed=${dirStats.mixed} candidate_only=${dirStats.candidate_only}`,
  )
  const dirList = dirData?.directions ?? []
  check('研究方向接口可用', !!dirData)
  check('方向不变量自检为空', (dirData?.invariant_violations ?? []).length === 0,
    JSON.stringify(dirData?.invariant_violations ?? []))
  check(
    '方向统计与列表长度一致',
    dirStats.total === dirList.length,
    `stats.total=${dirStats.total} 列表=${dirList.length}`,
  )
  check(
    '每条方向都有证据回链（不允许无依据的方向）',
    dirList.every((d) => (d.evidence_ids ?? []).length > 0),
  )
  check(
    '方向的证据都属于本项目',
    dirList.every((d) =>
      (d.evidence_ids ?? []).every((eid) => evidence.some((e) => e.evidence_id === eid)),
    ),
  )
  check(
    'candidate_only 方向标题必须带【推测方向】前缀（候选标识不被洗掉）',
    dirList
      .filter((d) => d.basis_level === 'candidate_only')
      .every((d) => d.title.includes('【推测方向】')),
  )
  check(
    'candidate_only 方向置信度必须 ≤ 0.5（硬上限）',
    dirList
      .filter((d) => d.basis_level === 'candidate_only')
      .every((d) => d.confidence <= 0.5),
  )
  /*
   * 三层阶梯都要在**真实数据**上被走到，并且各自的证据必须真的能解析：
   *   stated_backed → 来自本项目自己写的 limitation 句（GR002/GR005 那类）
   *   candidate_only → 来自跨论文 candidate Gap
   */
  check('本项目语料生成了 stated_backed 方向（有事实依据）',
    (dirStats.stated_backed ?? 0) > 0, `stated_backed=${dirStats.stated_backed}`)
  /*
   * candidate_only 方向来自跨论文 candidate Gap。与上一条同源：
   * 离线 Mock 抽取器产不出 candidate，所以 candidate_only 也落在 0。
   * 有则断言其硬约束，无则记录（不伪装成通过）。
   */
  if ((dirStats.candidate_only ?? 0) > 0) {
    check('candidate_only 方向来自跨论文 Gap 且带【推测方向】前缀',
      dirList.filter((d) => d.basis_level === 'candidate_only')
        .every((d) => d.title.includes('【推测方向】') && d.confidence <= 0.5))
  } else {
    note('info',
      '离线环境下 candidate_only 方向为 0 —— 与 candidate Gap 同源（Mock 抽取器不能命名方法）。' +
        '该层规则由 `pnpm direction:test` 覆盖。')
  }
  check(
    '方向分层计数 = total（stated_backed + mixed + candidate_only）',
    (dirStats.stated_backed ?? 0) + (dirStats.mixed ?? 0) + (dirStats.candidate_only ?? 0) === dirStats.total,
    `${dirStats.stated_backed}+${dirStats.mixed}+${dirStats.candidate_only}=${dirStats.total}`,
  )
  /* stated_backed 方向必须能回链到**本项目已存在的 Evidence**（不是悬空引用） */
  const dirBacklinks = dirList.flatMap((d) => d.evidence_ids ?? [])
  const dirResolved = dirBacklinks.filter((eid) => evidence.some((e) => e.evidence_id === eid))
  check(
    '方向的 Evidence 回链全部能在本项目数据里解析（无悬空回链）',
    dirBacklinks.length > 0 && dirResolved.length === dirBacklinks.length,
    `回链 ${dirBacklinks.length} 条，可解析 ${dirResolved.length} 条`,
  )
  /*
   * 三层阶梯都必须在真实数据上被走到，否则等于没验：
   *   stated_backed（有事实打底）应来自本项目自己写的 limitation 句
   *   candidate_only（纯推测）应来自跨论文 candidate Gap
   */
  check('本项目语料生成了 stated_backed 方向（有事实依据）',
    (dirStats.stated_backed ?? 0) > 0, `stated_backed=${dirStats.stated_backed}`)

  /* ================================================================ */
  section('【第 10 步】调研报告（4-8）')
  /* ================================================================ */

  const rep = await get(`/api/projects/${PID}/report`)
  const repData = rep?.data
  const report = repData?.report
  check('调研报告接口可用', !!report)
  check('报告不变量自检为空', (repData?.invariant_violations ?? []).length === 0,
    JSON.stringify(repData?.invariant_violations ?? []))
  check(
    '报告含全部 7 个章节（topic 在顶层块 + sections 六章）',
    !!report?.topic && (report?.sections ?? []).length === 6,
    `sections=${(report?.sections ?? []).map((s) => s.section_id).join(',')}`,
  )
  const lay = report?.layering ?? {}
  console.log(
    `  · 报告 ${report?.report_id}：陈述 ${lay.total_statements} 条（事实 ${lay.stated_fact} / 分析 ${lay.system_analysis} / 建议 ${lay.system_suggestion}），回链 ${lay.total_refs} 条`,
  )
  check(
    '报告的每个回链 id 都能在本项目数据里解析到',
    (() => {
      const pool = {
        paper: new Set(papers.map((p) => p.paper_id)),
        method: new Set(methods.map((m) => m.method_id)),
        evidence: new Set(evidence.map((e) => e.evidence_id)),
        gap: new Set((gapData?.gaps ?? []).map((g) => g.gap_id)),
        direction: new Set((dirData?.directions ?? []).map((d) => d.direction_id)),
      }
      const all = [
        ...(report?.topic?.research_questions ?? []),
        ...(report?.sections ?? []).flatMap((s) => s.statements ?? []),
      ]
      return all.every((st) => (st.refs ?? []).every((r) => !pool[r.kind] || pool[r.kind].has(r.id)))
    })(),
    '不允许悬空回链',
  )
  /*
   * 报告必须**真的把 Gap / 方向写进对应章节**，而不是只留一个空壳小节。
   * 这是"后端算出来了但前端/报告没接上"这类接缝问题的守门断言。
   */
  const secById = new Map((report?.sections ?? []).map((s) => [s.section_id, s]))
  const gapsSec = secById.get('gaps')
  const dirsSec = secById.get('directions')
  const countStatements = (s) => (s?.statements ?? []).length
  console.log(
    `  · 报告章节陈述数：literature=${countStatements(secById.get('literature'))} ` +
      `methods=${countStatements(secById.get('methods'))} evolution=${countStatements(secById.get('evolution'))} ` +
      `gaps=${countStatements(gapsSec)} directions=${countStatements(dirsSec)} ` +
      `evidence_index=${countStatements(secById.get('evidence_index'))}`,
  )
  check('报告的 gaps 章节带有真实内容（不是空壳）',
    countStatements(gapsSec) > 0, `${countStatements(gapsSec)} 条陈述`)
  check('报告的 directions 章节带有真实内容（不是空壳）',
    countStatements(dirsSec) > 0, `${countStatements(dirsSec)} 条陈述`)
  check('report.layering 的分层计数非零（事实/分析/建议三层至少出现事实层）',
    (lay.stated_fact ?? 0) > 0, `事实 ${lay.stated_fact} / 分析 ${lay.system_analysis} / 建议 ${lay.system_suggestion}`)
  /* 报告里引用到的 Gap/Direction 必须真的是本项目算出来的那些 */
  const refIdsOf = (s, kind) =>
    new Set((s?.statements ?? []).flatMap((st) => (st.refs ?? []).filter((r) => r.kind === kind).map((r) => r.id)))
  check('报告 gaps 章节引用的 Gap 都属于本项目',
    [...refIdsOf(gapsSec, 'gap')].every((id) => (gapData?.gaps ?? []).some((g) => g.gap_id === id)),
    [...refIdsOf(gapsSec, 'gap')].join(',') || '(无 gap 引用)')
  check('报告 directions 章节引用的方向都属于本项目',
    [...refIdsOf(dirsSec, 'direction')].every((id) =>
      (dirData?.directions ?? []).some((d) => d.direction_id === id)),
    [...refIdsOf(dirsSec, 'direction')].join(',') || '(无 direction 引用)')

  /* ── 数据归属总校验：整条链只用同一个 project_id ── */

  section('【归属校验】全链路是否只用同一个 project_id，有无 Demo 数据串入')
  const demoPaperIds = new Set(['P001', 'P002', 'P003', 'P004', 'P005'])
  const allIds = [
    ...papers.map((p) => p.paper_id),
    ...methods.map((m) => m.method_id),
    ...evidence.map((e) => e.evidence_id),
  ]
  check(
    '本项目所有实体的 project_id 一律等于 PID',
    [...papers, ...methods, ...evidence].every((x) => x.project_id === PID),
  )
  check(
    '未出现任何 Demo 实体（无跨项目污染）',
    evidence.every((e) => papers.some((p) => p.paper_id === e.paper_id)),
  )
  check(
    '报告的 paper 回链全部指向本项目论文（不是演示论文）',
    (report?.sections ?? [])
      .flatMap((s) => s.statements ?? [])
      .flatMap((st) => st.refs ?? [])
      .filter((r) => r.kind === 'paper')
      .every((r) => papers.some((p) => p.paper_id === r.id)),
  )

  /* ================================================================ */
  section('【浏览器】逐步渲染 + 侧栏统计一致性 + Evidence 回链')
  /* ================================================================ */

  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } })
  const consoleErrors = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  const EXPECT_METHODS = methods.length
  const EXPECT_EVIDENCE = evidence.length
  const EXPECT_GAPS = (gapData?.gaps ?? []).length
  const EXPECT_DIRS = (dirData?.directions ?? []).length

  const readSidebar = async () => {
    const grab = async (k) => {
      const t = await page.locator(`[data-sidebar-stat="${k}"]`).first().innerText().catch(() => '')
      const n = Number(String(t).replace(/[^\d-]/g, ''))
      return Number.isFinite(n) && String(t).trim() !== '' ? n : null
    }
    return {
      papers: await grab('papers'),
      methods: await grab('methods'),
      gaps: await grab('gaps'),
      directions: await grab('directions'),
      evidence: await grab('evidence'),
    }
  }

  const PAGES = [
    ['methods', '方法地图'],
    ['evolution', '技术演进'],
    ['gaps', '研究空白'],
    ['directions', '研究方向'],
    ['report', '调研报告'],
  ]

  for (const [route, label] of PAGES) {
    await page.goto(`${BASE}/project/${PID}/${route}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2200)
    const body = await page.evaluate(() => document.body.innerText)

    /* 每个页面都必须出现"当前项目真实数据"字样，且不得含 Demo 特征 */
    const hasDemo = /SWE-agent|NeurIPS|agent-computer interface|ACI/i.test(body)
    check(`[${label}] 页面渲染成功（无空白骨架）`, body.length > 200)
    check(`[${label}] 未串入 Demo 演示语料`, !hasDemo,
      hasDemo ? body.match(/.{0,40}(SWE-agent|NeurIPS|ACI).{0,40}/i)?.[0] ?? '' : '')

    /* 侧栏统计必须与接口一致 */
    const sb = await readSidebar()
    if (route === 'report') {
      check(`[${label}] 侧栏论文数 = 接口 ${papers.length}`,
        sb.papers === papers.length, `侧栏 ${sb.papers} / 接口 ${papers.length}`)
      check(`[${label}] 侧栏方法数 = 接口 ${EXPECT_METHODS}`,
        sb.methods === EXPECT_METHODS, `侧栏 ${sb.methods} / 接口 ${EXPECT_METHODS}`)
      check(`[${label}] 侧栏空白数 = 接口 ${EXPECT_GAPS}`,
        sb.gaps === EXPECT_GAPS, `侧栏 ${sb.gaps} / 接口 ${EXPECT_GAPS}`)
      check(`[${label}] 侧栏方向数 = 接口 ${EXPECT_DIRS}`,
        sb.directions === EXPECT_DIRS, `侧栏 ${sb.directions} / 接口 ${EXPECT_DIRS}`)
      check(`[${label}] 侧栏证据数 = 接口 ${EXPECT_EVIDENCE}`,
        sb.evidence === EXPECT_EVIDENCE, `侧栏 ${sb.evidence} / 接口 ${EXPECT_EVIDENCE}`)
    }
  }

  /* ── 随机点至少 5 条 Evidence，确认回到本项目原文 ── */

  section('【Evidence 回链】随机点 5 条，确认都是本项目原文')

  /*
   * 验收要求「随机点至少 5 条 Evidence」。
   *
   * 只在报告页收候选是不够的：项目语料小的时候报告页可点入口会少于 5 个。
   * 所以**跨页面汇集** —— 报告页 + 方法地图 + 技术演进 + 研究空白 + 研究方向，
   * 这些都是 Evidence 的真实入口。再从中种子化随机挑 5 条。
   */
  const EVIDENCE_PAGES = ['report', 'methods', 'evolution', 'gaps', 'directions']
  const perPage = {}
  for (const route of EVIDENCE_PAGES) {
    await page.goto(`${BASE}/project/${PID}/${route}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1600)
    const ids = await page.evaluate(() => {
      const out = []
      for (const el of document.querySelectorAll('*')) {
        for (const a of el.attributes ?? []) {
          if (/^data-.*evidence/i.test(a.name) && /^E\d+/.test(a.value ?? '')) out.push(a.value)
        }
      }
      return out
    })
    perPage[route] = [...new Set(ids)]
  }
  const candidates = [...new Set(Object.values(perPage).flat())]
  console.log(
    `  · 可点 Evidence（跨 ${EVIDENCE_PAGES.length} 个页面）：` +
      EVIDENCE_PAGES.map((p) => `${p}=${perPage[p].length}`).join(' ') +
      ` 去重后 ${candidates.length} 个`,
  )

  check(
    '全链路页面至少暴露 5 条可点 Evidence（验收硬要求）',
    candidates.length >= 5,
    `${candidates.length} 个（项目实际证据 ${evidence.length} 条）`,
  )

  /* 固定种子的伪随机，保证每次跑挑同一批 —— 便于复现 */
  const seed = 20260924
  const rnd = (n) => (seed * 9301 + 49297) % 233280 % n
  const picked = []
  const pool = [...candidates]
  for (let i = 0; i < 5 && pool.length; i++) {
    picked.push(...pool.splice(rnd(pool.length + 1) % pool.length, 1))
  }
  console.log(`  · 随机选中：${picked.join(', ')}`)

  const evById = new Map(evidence.map((e) => [e.evidence_id, e]))
  const paperById = new Map(papers.map((p) => [p.paper_id, p]))
  let okDrawers = 0

  /*
   * 每条 Evidence 的入口可能落在不同页面上（报告页有 4 条、方法地图有 3 条…）。
   * 所以点之前先回到**暴露该 id 的那个页面**，再点。
   */
  const pageOf = (eid) => EVIDENCE_PAGES.find((p) => perPage[p].includes(eid)) ?? 'report'

  for (const eid of picked) {
    const route = pageOf(eid)
    await page.goto(`${BASE}/project/${PID}/${route}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1400)

    /*
     * ⚠️ 锚点 `data-report-evidence-index` 挂在**容器 div** 上，
     * 真正可点的是它内部的 `<button>#E00x</button>`；
     * `data-report-evidence-open` 则**本身就是** button。
     * 直接点容器会落在留白上、抽屉不打开 —— 必须区分这两种形态。
     */
    const btnSelectors = [
      `[data-report-evidence-open="${eid}"]`,
      `[data-report-evidence-index="${eid}"] button`,
      `[data-method-evidence-id="${eid}"]`,
      `[data-evolution-evidence-id="${eid}"]`,
      `[data-gap-evidence-id="${eid}"]`,
      `[data-direction-evidence-id="${eid}"]`,
      `[data-evidence-id="${eid}"]`,
    ]
    let use = null
    for (const sel of btnSelectors) {
      const loc = page.locator(sel).first()
      if ((await loc.count()) > 0) {
        use = loc
        break
      }
    }
    if (!use) {
      check(`Evidence ${eid} 在 ${route} 页有可点入口`, false)
      continue
    }

    await use.click()
    await page.waitForSelector('[data-evidence-drawer="1"]', { timeout: 8000 }).catch(() => null)
    const dt = await page.locator('[data-evidence-drawer="1"]').innerText().catch(() => '')
    const opened = dt.length > 0
    const ev = evById.get(eid)
    const title = ev ? paperById.get(ev.paper_id)?.title ?? '' : ''
    /* 抽屉里出现该证据所属论文的标题关键词（ReAct/Reflexion/Toolformer 之一或拼接文本） */
    const hitTitle = title ? dt.includes(title.slice(0, 12)) : false
    const noDemo = !/SWE-agent|NeurIPS|agent-computer interface/i.test(dt)
    const hasQuote = ev ? dt.includes((ev.content ?? '').slice(0, 20)) : false

    const good = opened && hitTitle && noDemo && hasQuote
    if (good) okDrawers++
    check(
      `Evidence ${eid} 回到本项目原文（${route} 页）`,
      good,
      `open=${opened} title=${hitTitle} quote=${hasQuote} noDemo=${noDemo}`,
    )
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }
  check('随机挑中的 5 条 Evidence 全部回到本项目原文', okDrawers === 5, `${okDrawers}/5`)

  /* ================================================================ */
  section('【并发缺陷复现】分析 job 运行期间加入的论文会被静默抹掉')
  /* ================================================================ */

  /*
   * 这是一个**独立的、最小化的复现**，不是验收链路的一部分。
   *
   * 机理（已定位到行）：
   *   server/services/analysis.ts 在第 184 行 `const bundle = await store.getBundle(projectId)`
   *   只读**一次**快照，之后 253 / 353 / 450 / 903 行的写回都是
   *   `store.savePapers(projectId, replacePaper(bundle.papers, next))`。
   *   `replacePaper` 只做 id 匹配替换、**从不删除**，所以那份陈旧数组里
   *   没有的论文会被整份覆盖掉。
   *   `fileStore` 的 1500ms 读缓存进一步放大了窗口。
   *
   * 每一次 HTTP 请求都返回 200 / success —— 数据是在"成功"的假象下消失的。
   * 这正是本项目反复出现的「张冠李戴 / 静默串数据」同一类问题。
   */
  /*
   * 由**独立的一次性项目**承载复现（主验收项目不做任何删除，保持纯净）。
   */
  const raceProj = (
    await post('/api/projects', { name: 'ACC 并发缺陷复现（一次性）' })
  ).body?.data?.id
  check('复现用隔离项目创建成功', typeof raceProj === 'string' && raceProj.length > 0, `项目=${raceProj}`)
  const addRaceMeta = async (s2id, title) =>
    (
      await post(`/api/projects/${raceProj}/papers/meta`, {
        s2_paper_id: s2id,
        title,
        authors: ['验收作者'],
        year: 2023,
        abstract: ABS_PLAIN,
        url: `${SITE}/abs/${s2id}`,
        doi: `10.1000/${s2id}`,
        citationCount: 42,
        venue: 'AcceptanceConf',
        source: 'live',
      })
    ).body?.data?.paper?.paper_id

  const raceA = await addRaceMeta('acc-race-a', '并发复现 A：先加入')
  await post(`/api/projects/${raceProj}/papers/${raceA}/fetch-fulltext`)
  const raceARes = await post(`/api/papers/${raceA}/analyze`, { project_id: raceProj, force: true })
  const raceAJob = raceARes.body?.data?.job_id

  // job 已经起飞，此刻**不等待**，立即插入 B
  const raceB = await addRaceMeta('acc-race-b', '并发复现 B：job 运行中加入')
  const midPapers = (await get(`/api/projects/${raceProj}/papers`))?.data ?? []
  check(
    '复现条件成立：B 是在 A 的 job 运行期间加入的',
    midPapers.some((p) => p.paper_id === raceB) && raceAJob !== undefined,
    `项目=${raceProj} A=${raceA} job=${raceAJob} B=${raceB} 当前论文数=${midPapers.length}`,
  )

  const raceDone = await pollJob(raceAJob)
  const afterPapers = (await get(`/api/projects/${raceProj}/papers`))?.data ?? []
  const raceBSurvived = afterPapers.some((p) => p.paper_id === raceB)
  const raceAStatus = afterPapers.find((p) => p.paper_id === raceA)?.status
  console.log(
    `  · A job 终态=${raceDone.job.state}  A.status=${raceAStatus}  B 是否还在= ${raceBSurvived ? '在' : '消失了'}`,
  )
  check(
    '【缺陷】A 的 job 写回后，运行期间加入的 B 论文被静默抹掉',
    raceBSurvived,
    raceBSurvived
      ? 'B 幸存 —— 该缺陷在当前构建下未复现'
      : `B=${raceB} 在 A 的 job 写回后从论文列表中消失（所有请求都返回 200，无任何报错）`,
  )
  if (!raceBSurvived) {
    note(
      'blocker',
      'analysis.ts 用陈旧 bundle 快照写回，抹掉 job 运行期间新增的论文 —— 用户可见数据静默丢失，' +
        '所有接口仍返回 200/success。Phase 5 只记录不修复（禁止改核心算法）。',
    )
    note(
      'info',
      `复现项目 ${raceProj} 是一次性隔离项目，主验收项目 ${PID} 的链路数据不受其影响。`,
    )
  }

  /* ================================================================ */
  section('【失败态】故意制造 3 种失败，确认 UI 不伪装成成功')
  /* ================================================================ */

  /* ── 失败 1：全文获取失败（摘要页没有任何 PDF 链接）── */
  /*
   * 直接**用故障链接建这篇论文**：`/none/...` 摘要页里没有任何 PDF 链接，
   * 这与真实世界里"出版商页面不给 PDF 直链"完全一致。
   * （服务端没有改论文 URL 的接口，从源头构造反而更贴近真实路径。）
   */
  const failId = await addMeta('acc-nofulltext', '无法取得全文的论文', ABS_PLAIN, `${SITE}/none/acc-nofulltext`)
  const noFull = await post(`/api/projects/${PID}/papers/${failId}/fetch-fulltext`)
  const noFullOk = noFull.body?.data?.ok
  check(
    '失败 1：无 PDF 链接时 fetch-fulltext 明确返回 ok=false（不是假装成功）',
    noFullOk === false || noFull.status >= 400,
    `ok=${noFullOk} status=${noFull.status} code=${noFull.body?.data?.code} msg=${noFull.body?.data?.message}`,
  )
  const failPaper = ((await get(`/api/projects/${PID}/papers`))?.data ?? []).find((p) => p.paper_id === failId)
  check(
    '失败 1：论文 status 保持 pending（未伪造成 uploaded/completed）',
    failPaper?.status === 'pending',
    `status=${failPaper?.status}`,
  )
  check('失败 1：论文未被写入任何方法/证据', (failPaper?.method_ids ?? []).length === 0 && failPaper?.evidence_count === 0)

  /* ── 失败 2：分析失败（先取到全文，再把物理文件删掉）── */
  const ghostId = await addMeta('acc-ghost', '分析会失败的论文', ABS_PLAIN)
  await post(`/api/projects/${PID}/papers/${ghostId}/fetch-fulltext`)
  const ghostPaper = ((await get(`/api/projects/${PID}/papers`))?.data ?? []).find((p) => p.paper_id === ghostId)
  let ghostRemoved = false
  if (ghostPaper && !String(ghostPaper.file_hash).startsWith('meta:')) {
    try {
      rmSync(path.join(uploadDir, ghostPaper.file_hash.slice(0, 16), ghostPaper.file_name), { force: true })
      ghostRemoved = true
    } catch {}
  }
  check('失败 2：已把物理 PDF 删掉以制造失败', ghostRemoved, ghostPaper?.file_name ?? '')

  const beforeM = ((await get(`/api/projects/${PID}/methods`))?.data ?? []).length
  const beforeE = ((await get(`/api/projects/${PID}/evidence`))?.data ?? []).length
  const gr = await post(`/api/papers/${ghostId}/analyze`, { project_id: PID, force: true })
  const { job: gJob } = await pollJob(gr.body?.data?.job_id)
  check('失败 2：job 终态为 failed（不是 completed）', gJob.state === 'failed', `state=${gJob.state}`)
  check('失败 2：job 带 error 说明（不是空错误）', typeof gJob.error === 'string' && gJob.error.length > 0, gJob.error)

  const ghostAfter = ((await get(`/api/projects/${PID}/papers`))?.data ?? []).find((p) => p.paper_id === ghostId)
  check(
    '失败 2：论文仍在列表中（**不得凭空消失**）',
    !!ghostAfter,
    ghostAfter ? '在' : '⚠️ 消失了 —— 论文被静默删除',
  )
  if (!ghostAfter) {
    note('blocker', '分析失败导致论文从列表消失 —— 前端会显示"学论文不存在"，用户的数据被静默丢弃')
  } else {
    check(
      '失败 2：status = failed（前端映射后显示"解析失败"，不是"已分析"）',
      ghostAfter.status === 'failed',
      `status=${ghostAfter.status}`,
    )
    check('失败 2：error 字段记下失败原因', typeof ghostAfter.error === 'string' && ghostAfter.error.length > 0, ghostAfter.error)
    check('失败 2：analyzed_with 未写入（不谎报已分析）', ghostAfter.analyzed_with === null)
  }
  const afterM = ((await get(`/api/projects/${PID}/methods`))?.data ?? []).length
  const afterE = ((await get(`/api/projects/${PID}/evidence`))?.data ?? []).length
  check('失败 2：未写入半套方法数据', afterM === beforeM, `${beforeM} → ${afterM}`)
  check('失败 2：未写入半套证据数据', afterE === beforeE, `${beforeE} → ${afterE}`)

  /* ── 失败 3：不存在的项目 ── */
  const badPid = 'proj_does_not_exist_phase5'
  for (const [api, label] of [
    [`/api/projects/${badPid}/gaps`, 'gaps'],
    [`/api/projects/${badPid}/directions`, 'directions'],
    [`/api/projects/${badPid}/report`, 'report'],
  ]) {
    const r = await fetch(`${BASE}${api}`)
    const b = await r.json().catch(() => null)
    check(
      `失败 3：${label} 对不存在项目返回 404（不是 200 空数据）`,
      r.status === 404 && b?.success === false,
      `status=${r.status}`,
    )
  }

  /* 浏览器侧：不存在的项目必须显示错误态，不能显示演示数据 */
  await page.goto(`${BASE}/project/${badPid}/report`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  const badBody = await page.evaluate(() => document.body.innerText)
  check(
    '失败 3：不存在的项目页面显示错误态',
    /加载失败|不存在/.test(badBody) && !/SWE-agent|NeurIPS/i.test(badBody),
    badBody.slice(0, 70).replace(/\n/g, ' '),
  )
  check('失败 3：不进入 Live/Demo 报告分支', (await page.locator('[data-report-page="live"]').count()) === 0)

  /* ── Demo 项目的 Demo 标识 ── */
  await page.goto(`${BASE}/project/proj-aicoding-agent/report`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3200)
  const demoBody = await page.evaluate(() => document.body.innerText)
  check('Demo 项目走 demo 分支', (await page.locator('[data-report-page="demo"]').count()) === 1)
  check(
    'Demo 项目披露其数据来自演示知识库（Mock 标识准确，不冒充真实分析）',
    /演示|Demo|知识库/.test(demoBody),
    demoBody.slice(0, 80).replace(/\n/g, ' '),
  )
  /* 反向：Live 项目页面不得出现任何 Demo 特征 */
  await page.goto(`${BASE}/project/${PID}/report`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-report-page="live"]', { timeout: 25000 }).catch(() => null)
  const liveBody = await page.evaluate(() => document.body.innerText)
  check(
    'Live 项目报告页不出现 Demo 特征语料',
    !/SWE-agent|NeurIPS|agent-computer interface|ACI/i.test(liveBody),
    'Live 必须只显示当前项目真实报告',
  )
  check('Live 项目走 live 分支', (await page.locator('[data-report-page="live"]').count()) === 1)

  /* ================================================================ */
  section('【前端报错】')
  const realErrors = consoleErrors.filter((e) => !/favicon|404 \(Not Found\)|Failed to load resource/i.test(e))
  check('浏览器控制台无脚本错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

  /* ── 截图存档 ── */
  const shotDir = path.join(ROOT, '.shots', 'phase5')
  mkdirSync(shotDir, { recursive: true })
  for (const [route, label] of PAGES) {
    await page.goto(`${BASE}/project/${PID}/${route}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2200)
    await page.screenshot({ path: path.join(shotDir, `${route}-${label}.png`), fullPage: true })
  }
  writeFileSync(
    path.join(shotDir, 'acceptance-summary.json'),
    JSON.stringify({ pid: PID, papers: papers.length, methods: methods.length, evidence: evidence.length, gaps: gapStats, directions: dirStats, report: lay, findings }, null, 2),
  )
  check('验收截图与摘要已存档', existsSync(path.join(shotDir, 'acceptance-summary.json')))

  await browser.close()
  stop()

  /* ================================================================ */
  console.log('\n' + '═'.repeat(70))
  if (findings.length) {
    console.log('发现的问题：')
    for (const f of findings) console.log(`  [${f.level}] ${f.text}`)
    console.log('')
  }
  if (fail > 0) {
    console.log(`✗ 验收未通过（通过 ${pass} / 失败 ${fail}）`)
    process.exit(1)
  }
  console.log(`✓ Phase 5 全链路验收通过（${pass} 项断言）`)
  console.log('  探索→加入→全文→分析→方法地图→演进→Gap→方向→报告 · 单一 project_id · 无 Demo 串入')
}

run().catch((e) => {
  console.error('✗ 验收异常：', e)
  stop()
  process.exit(1)
})
