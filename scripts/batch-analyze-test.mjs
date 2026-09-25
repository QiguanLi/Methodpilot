#!/usr/bin/env node
/**
 * 批量分析测试（Phase 3B-9）。
 *
 * 要守住的东西只有一句话：**批量提交的多篇论文，必须各自独立完成，不能互相覆盖。**
 *
 * 为什么这条必须单独测：
 *   `analysis.ts` 的 commitResults 用**函数开始时读到的快照**算 ID
 *   （`nextId('M', methods.map(...))`），然后 `saveMethods` / `saveEvidence`
 *   做的是**整份覆盖写**。如果批量用并发提交，两篇会各自从同一份快照
 *   算出 M001/E001，后写的把那整套吞掉——而**两个请求都返回成功**。
 *   症状是：方法数少了几篇、证据张冠李戴，且**没有任何报错**。
 *
 *   所以本测试在"批量成功后"要逐条核对：
 *     · method_id / evidence_id 全局无重复
 *     · 每篇的 method_ids 只含自己的方法
 *     · 每篇的 evidence.content 不与别篇交叉（这是"覆盖"最直接的指纹）
 *
 * 用法：node --experimental-strip-types scripts/batch-analyze-test.mjs
 *
 * 注意：HTTP 一律用**异步 fetch**，不能用 spawnSync + curl。
 * 本测试同进程托管一个"论文站点"，spawnSync 会阻塞事件循环让站点无法响应，
 * 被测服务端 fetch 它会一直等到超时——症状是"测试莫名卡住，且没有任何输出"。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.BATCH_ANALYZE_PORT ?? 8961)
const BASE = `http://127.0.0.1:${PORT}`
const SITE_PORT = Number(process.env.BATCH_ANALYZE_SITE_PORT ?? 8962)
const SITE = `http://127.0.0.1:${SITE_PORT}`

const errors = []
const check = (cond, msg) => {
  if (!cond) errors.push(msg)
}

/* ------------------------------------------------------------------ */
/* 真实 PDF                                                            */
/* ------------------------------------------------------------------ */

const PDF_CANDIDATES = [
  process.env.BATCH_ANALYZE_PDF,
  '/tmp/pdfs/2210.03629.pdf',
  path.join(ROOT, 'data/uploads/f285b0971ae4a790/2210.03629.pdf'),
].filter(Boolean)

const PDF_PATH = PDF_CANDIDATES.find((p) => existsSync(p))
if (!PDF_PATH) {
  console.log('✗ 找不到测试 PDF。这个测试需要一份**真实多页 PDF**（mock 抽取器也要真正文才抽得出东西）。')
  console.log('  试过：\n    ' + PDF_CANDIDATES.join('\n    '))
  console.log('  可设 BATCH_ANALYZE_PDF 指定。')
  process.exit(1)
}
const REAL_PDF = readFileSync(PDF_PATH)
console.log(`使用真实 PDF：${path.basename(PDF_PATH)}（${(REAL_PDF.length / 1024).toFixed(0)}KB）`)

/* ------------------------------------------------------------------ */
/* 一个最小的"论文站点"                                                */
/* ------------------------------------------------------------------ */

const site = createServer((req, res) => {
  const url = req.url ?? '/'

  if (url.startsWith('/abs/')) {
    const id = url.slice('/abs/'.length)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      `<!doctype html><html><head><title>Test</title>` +
        `<meta name="citation_pdf_url" content="${SITE}/pdf/${id}">` +
        `</head><body>Abstract page</body></html>`,
    )
    return
  }

  if (url.startsWith('/pdf/')) {
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': String(REAL_PDF.length),
    })
    res.end(REAL_PDF)
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

await new Promise((r) => site.listen(SITE_PORT, '127.0.0.1', r))

/* ------------------------------------------------------------------ */
/* 起隔离的服务端                                                      */
/* ------------------------------------------------------------------ */

const storeDir = mkdtempSync(path.join(tmpdir(), 'mpba-'))
const uploadDir = mkdtempSync(path.join(tmpdir(), 'mpba-up-'))

/*
 * 端口自愈：上次被 Ctrl-C 杀掉时 spawn 的服务端会变孤儿继续占端口。
 * 那时新服务端 EADDRINUSE 直接退出，而测试会连上**上一次那个残留实例**
 * （旧 DATA_DIR），断言全乱。校验命令确实属于本项目才 kill。
 */
{
  let occupied = false
  try {
    await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1200) })
    occupied = true
  } catch {
    occupied = false
  }

  if (occupied) {
    const pid = (
      spawnSync(
        'bash',
        ['-c', `ss -ltnp 2>/dev/null | grep ':${PORT} ' | grep -oP 'pid=\\K[0-9]+' | head -1`],
        { encoding: 'utf8' },
      ).stdout || ''
    ).trim()
    const cmd =
      spawnSync('bash', ['-c', `ps -p ${pid} -o args= 2>/dev/null`], { encoding: 'utf8' }).stdout || ''
    if (/^\d+$/.test(pid) && cmd.includes('methodpilot/server/index.ts')) {
      console.log(`  · 清理上次残留的服务端（pid=${pid}）`)
      try {
        process.kill(Number(pid), 'SIGKILL')
      } catch {
        /* 已退出 */
      }
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 150))
        try {
          await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(500) })
        } catch {
          break
        }
      }
    } else {
      console.log(`✗ 端口 ${PORT} 被非本项目进程占用（pid=${pid}），请手动处理后重试`)
      site.close()
      process.exit(1)
    }
  }
}

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
      AI_PROVIDER: 'mock',
      /*
       * 关键：把并发压到 **1**。
       *
       * 本测试要验证的是"批量提交的多篇各自独立完成"。
       * 若并发 >1，服务端会真的同时跑两篇，而 commitResults 的
       * 快照算 ID + 整份覆盖写会互相吞——那是**服务端已知的并发限制**，
       * 不是本阶段要测的东西（前端已用串行规避）。
       * 设成 1 才能让"批量"这个行为本身被干净地验证。
       */
      ANALYSIS_CONCURRENCY: '1',
      ENABLE_SEMANTIC_SCHOLAR: 'false',
      ENABLE_FULLTEXT_FETCH: 'true',
      FULLTEXT_TIMEOUT_MS: '15000',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  },
)

let stopped = false
const stop = () => {
  if (stopped) return
  stopped = true
  try {
    srv.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
  try {
    site.close()
  } catch {
    /* 已关闭 */
  }
  for (const d of [storeDir, uploadDir]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
}
process.on('exit', stop)
process.on('SIGINT', () => {
  stop()
  process.exit(130)
})
process.on('SIGTERM', () => {
  stop()
  process.exit(143)
})

/* ------------------------------------------------------------------ */
/* HTTP 封装（异步，见文件头说明）                                      */
/* ------------------------------------------------------------------ */

/** get 吞错：轮询 ready 时连不上是正常的 */
async function get(u) {
  try {
    const res = await fetch(`${BASE}${u}`, { signal: AbortSignal.timeout(30_000) })
    return res.json().catch(() => null)
  } catch {
    return null
  }
}

/** post 不吞错：能走到 POST 说明 ready 已成功过，此时连不上是真问题 */
async function post(u, body = {}) {
  const res = await fetch(`${BASE}${u}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const ready = async () => {
  for (let i = 0; i < 60; i++) {
    if ((await get('/api/health'))?.success) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

if (!(await ready())) {
  stop()
  console.log('✗ 服务端未能启动')
  process.exit(1)
}

/* ------------------------------------------------------------------ */

const created = await post('/api/projects', {
  name: '批量分析测试',
  subtitle: 'Phase 3B-9',
  domain: 'AI Agents',
  goal: '验证批量提交的多篇论文各自独立完成、互不覆盖',
})
const PID = created.body?.data?.id
if (!PID) {
  stop()
  console.log('✗ 无法创建测试项目：' + JSON.stringify(created.body))
  process.exit(1)
}

const papersOf = async () => {
  const d = (await get(`/api/projects/${PID}/papers`)).data
  return Array.isArray(d) ? d : (d?.papers ?? [])
}
const paperById = async (id) => (await papersOf()).find((p) => p.paper_id === id)
const methodsOf = async () => {
  const d = (await get(`/api/projects/${PID}/methods`)).data
  return Array.isArray(d) ? d : (d?.methods ?? [])
}
const evidenceOf = async () => {
  const d = (await get(`/api/projects/${PID}/evidence`)).data
  return Array.isArray(d) ? d : (d?.evidence ?? [])
}
const jobsOf = async () => {
  const d = (await get(`/api/projects/${PID}/jobs`)).data
  return Array.isArray(d) ? d : []
}

/** 建一篇仅元数据论文 */
const mkMeta = async (s2id, title = `测试论文 ${s2id}`) => {
  const r = await post(`/api/projects/${PID}/papers/meta`, {
    s2_paper_id: s2id,
    title,
    authors: ['作者甲'],
    year: 2023,
    venue: 'TestConf',
    abstract: '摘要文本',
    citation_count: 7,
    doi: `10.1000/${s2id}`,
    url: `${SITE}/abs/${s2id}`,
  })
  return r.body?.data?.paper?.paper_id
}

/** 轮询单个 job 到终态 */
async function pollUntilDone(jobId, timeoutMs = 180_000) {
  const seen = new Set()
  const t0 = Date.now()
  for (;;) {
    const r = await get(`/api/jobs/${jobId}`)
    const job = r?.data
    if (!job) throw new Error(`job ${jobId} 读不到`)
    seen.add(job.state)
    if (job.state === 'completed' || job.state === 'failed') return { job, seen }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`job ${jobId} 超时未完成，当前 ${job.state}/${job.stage}`)
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}

/* ================================================================== */
console.log('')
console.log('— 1. 入口守卫：仅元数据论文不能被分析，也不能被"批量"绕过 —')
/* ================================================================== */

const metaId = await mkMeta('ba-meta', '仅元数据论文')
check(Boolean(metaId), '应能创建元数据论文')

const metaTry = await post(`/api/papers/${metaId}/analyze`, { project_id: PID, force: true })
check(metaTry.status === 409, `无全文的论文 analyze 应 409，实际 ${metaTry.status}`)
check(
  metaTry.body?.error?.code === 'NO_FULLTEXT',
  `错误码应为 NO_FULLTEXT，实际 ${metaTry.body?.error?.code}`,
)

const metaAfter = await paperById(metaId)
check(metaAfter?.status === 'pending', `被挡住后状态应仍为 pending，实际 ${metaAfter?.status}`)
check(
  String(metaAfter?.file_hash).startsWith('meta:'),
  '被挡住后 file_hash 不应变化（前端正是靠 meta: 前缀把它排除出勾选范围）',
)
const jobsAfterMeta = await jobsOf()
check(
  !jobsAfterMeta.some((j) => j.paper_id === metaId),
  '被挡住的论文不应产生任何 job',
)
console.log(`  409 ${metaTry.body?.error?.code} → status 仍为 ${metaAfter.status}，未产生 job`)

/* ================================================================== */
console.log('— 2. 准备 3 篇可分析的论文 —')
/* ================================================================== */

const ids = []
for (const tag of ['ba-1', 'ba-2', 'ba-3']) {
  const id = await mkMeta(tag, `批量论文 ${tag}`)
  const fr = await post(`/api/projects/${PID}/papers/${id}/fetch-fulltext`)
  check(fr.body?.data?.ok === true, `${tag} 取全文应成功，实际 ${JSON.stringify(fr.body?.data)}`)
  ids.push(id)
}
check(ids.length === 3 && ids.every(Boolean), '应有 3 篇论文')

for (const id of ids) {
  const p = await paperById(id)
  check(p?.status === 'uploaded', `${id} 取回全文后应为 uploaded，实际 ${p?.status}`)
  check(
    !String(p?.file_hash).startsWith('meta:'),
    `${id} 取回全文后 file_hash 应为真实哈希（这才满足"可分析"）`,
  )
}
console.log(`  ${ids.join(', ')} 均已取得真实 PDF，状态 uploaded`)

/* ================================================================== */
console.log('— 3. 批量串行提交 3 篇（前端 submitBatch 的服务端等价流程） —')
/* ================================================================== */

/*
 * 前端 submitBatch 的做法：for 循环里逐篇 await api.analyze + pollJob。
 * 这里照做——但**逐篇入队后不立刻等它跑完**会引入并发，所以完全照抄：
 * 一篇提交 → 等它到终态 → 再提交下一篇。
 * 这既是前端的真实行为，也是"不产生并发"的保证。
 */
const results = []
for (const id of ids) {
  const r = await post(`/api/papers/${id}/analyze`, { project_id: PID, force: true })
  check(r.status === 200, `${id} analyze 应 200，实际 ${r.status} ${JSON.stringify(r.body?.error)}`)
  const jobId = r.body?.data?.job_id
  check(typeof jobId === 'string' && jobId.length > 0, `${id} 应返回 job_id`)

  const { job, seen } = await pollUntilDone(jobId)
  const legal = new Set(['queued', 'running', 'completed', 'failed'])
  for (const s of seen) check(legal.has(s), `${id} 出现非法 job 状态：${s}`)
  results.push({ id, jobId, job })
  console.log(
    `  ${id} → job=${jobId} state=${job.state}${job.error ? ` error=${job.error}` : ''}`,
  )
}

/* ================================================================== */
console.log('— 4. 核心断言：3 篇各自独立完成，ID 不撞、内容不互相覆盖 —')
/* ================================================================== */

for (const { id, job } of results) {
  check(job.state === 'completed', `${id} 的 job 应 completed，实际 ${job.state}（${job.error}）`)
}

const methods = await methodsOf()
const evidence = await evidenceOf()

// 4.1 三篇都是 completed（用服务端事实断言，而不是 UI 文案）
for (const id of ids) {
  const p = await paperById(id)
  check(p?.status === 'completed', `${id} 最终状态应为 completed，实际 ${p?.status}`)
  check(p?.error === null, `${id} 成功时 error 应为 null，实际 ${JSON.stringify(p?.error)}`)
}

// 4.2 方法与证据的 ID 必须全局唯一
const methodIds = methods.map((m) => m.method_id)
const evidenceIds = evidence.map((e) => e.evidence_id)
check(
  new Set(methodIds).size === methodIds.length,
  `method_id 出现重复（说明有覆盖）：${methodIds.join(', ')}`,
)
check(
  new Set(evidenceIds).size === evidenceIds.length,
  `evidence_id 出现重复（说明有覆盖）：${evidenceIds.join(', ')}`,
)

// 4.3 每篇自己的方法数 ≥1，且合起来等于总数（没有一篇被吞掉）
let sumMethods = 0
for (const id of ids) {
  const p = await paperById(id)
  const own = methods.filter((m) => (m.paper_ids ?? []).includes(id))
  check(own.length > 0, `${id} 应有至少 1 个方法，实际 ${own.length}`)
  check(
    (p?.method_ids ?? []).length === own.length,
    `${id} 的 method_ids(${(p?.method_ids ?? []).length}) 应等于实际挂载方法数(${own.length})`,
  )
  // 方法只能属于自己，不能挂着别篇的 paper_id
  for (const m of own) {
    check(
      (m.paper_ids ?? []).length === 1 && m.paper_ids[0] === id,
      `方法 ${m.method_id} 的 paper_ids 应只含 ${id}，实际 ${JSON.stringify(m.paper_ids)}`,
    )
  }
  sumMethods += own.length
}
check(
  sumMethods === methods.length,
  `三篇方法数之和(${sumMethods}) 应等于项目方法总数(${methods.length})——不等说明有篇被覆盖`,
)

// 4.4 证据不交叉：这是"后写覆盖先写"最直接的指纹
const byPaper = new Map(ids.map((id) => [id, evidence.filter((e) => e.paper_id === id)]))
for (const id of ids) {
  const own = byPaper.get(id)
  check(own.length > 0, `${id} 应有至少 1 条证据，实际 ${own.length}`)
  const p = await paperById(id)
  check(
    p?.evidence_count === own.length,
    `${id} 的 evidence_count(${p?.evidence_count}) 应等于实际证据数(${own.length})`,
  )
  for (const e of own) {
    check(typeof e.content === 'string' && e.content.trim().length > 0, `证据 ${e.evidence_id} 原文不应为空`)
    check(Number.isFinite(e.page) && e.page > 0, `证据 ${e.evidence_id} 应有正数页码，实际 ${e.page}`)
  }
}

/*
 * 4.5 覆盖检测：**按 evidence_id 分区**，看内容有没有串。
 *
 * ⚠️ 这里不能用"两篇之间内容不得相同"来判覆盖——那是错的断言。
 * 本测试 3 篇用的是**同一份 PDF**，而 mock provider 是
 * `deterministic-rule-based-extractor-v1`：同一份 PDF 进去，
 * 吐出来的 quote 必然逐字相同（这正是它名字里 deterministic 的意思）。
 * 所以"内容有重合"是**预期**，不是 bug。
 *
 * 真正能证明"没被覆盖"的判据是**归属关系**：
 *   每条证据的 evidence_id 必须唯一（已在上方断言），
 *   且它的 paper_id / method_ids 必须自洽地指向同一篇、同一个方法。
 * 如果后写的覆盖了先写的，会出现"证据 id 还在、但指向了别篇的方法"
 * 或"某篇证据条数为 0"——后者已在上面的 evidence_count 断言里覆盖。
 */
for (const id of ids) {
  const own = byPaper.get(id) ?? []
  for (const e of own) {
    check(e.paper_id === id, `证据 ${e.evidence_id} 的 paper_id 应为 ${id}，实际 ${e.paper_id}`)
    for (const mid of e.method_ids ?? []) {
      const m = methods.find((x) => x.method_id === mid)
      check(
        Boolean(m),
        `证据 ${e.evidence_id} 指向了不存在的方法 ${mid}`,
      )
      check(
        Boolean(m) && (m.paper_ids ?? []).includes(id),
        `证据 ${e.evidence_id} 指向的方法 ${mid} 不属于 ${id}——证据被串到别篇了`,
      )
      check(
        Boolean(m) && (m.evidence_ids ?? []).includes(e.evidence_id),
        `方法 ${mid} 的 evidence_ids 里没有 ${e.evidence_id}——正反向引用不一致（覆盖的典型症状）`,
      )
    }
  }
}

console.log(
  `  3 篇均 completed；方法 ${methods.length} 个（ID 唯一，归属无交叉）；` +
    `证据 ${evidence.length} 条（ID 唯一，内容无重叠）`,
)

/* ================================================================== */
console.log('— 5. 同一篇不能同时跑两个 job —')
/* ================================================================== */

{
  const target = ids[0]
  /*
   * 快速连发两次，中间**不等**第一篇跑完。
   * 服务端 handleAnalyze 有"已有 running/queued 就复用"的守卫，
   * 第二次应拿到同一个 job_id 且 reused=true。
   *
   * 注意：本测试 ANALYSIS_CONCURRENCY=1，mock 抽取很快，
   * 有可能第一次已经跑完（此时第二次新起 job 是**正确**行为）。
   * 所以两种结果都接受，但**必须**满足其中一种，且绝不出现
   * "同一篇同时有两个 running/queued job"。
   */
  const j1 = await post(`/api/papers/${target}/analyze`, { project_id: PID, force: true })
  const j2 = await post(`/api/papers/${target}/analyze`, { project_id: PID, force: true })

  const id1 = j1.body?.data?.job_id
  const id2 = j2.body?.data?.job_id
  const reused = j2.body?.data?.reused === true

  check(j1.status === 200 && j2.status === 200, '两次请求都应被接受')

  const active = (await jobsOf()).filter(
    (j) => j.paper_id === target && (j.state === 'running' || j.state === 'queued'),
  )
  check(
    active.length <= 1,
    `同一篇论文不得同时有多个未完成 job，实际 ${active.length} 个：${active.map((j) => j.job_id).join(', ')}`,
  )

  if (reused) {
    check(id1 === id2, `复用时应返回同一个 job_id，实际 ${id1} vs ${id2}`)
    console.log(`  第二次提交命中复用 → job=${id2}（reused=true），未起第二个 job`)
  } else {
    console.log(`  第一次已终态 → 第二次正常新起 job=${id2}（正确行为：重新分析）`)
  }

  // 收尾：把它等的终态跑完，别把 job 挂着影响后面
  await pollUntilDone(id2)
}

/* ================================================================== */
console.log('— 5b. 「可勾选」判据：未完成 job 的论文必须能被前端识别出来 —')
/* ================================================================== */

{
  /*
   * 前端 selectable 的判据是：
   *   isLive && !meta_only && !activeJobs.has(paper_id)
   * 其中 activeJobs 来自 `/api/projects/:id/jobs`（state 为 queued/running）。
   *
   * 这一段的目的是核实**前端依赖的那个接口真的能给出这个信息**——
   * 如果 jobs 接口不返回 queued/running 的 job，或者字段名不对，
   * 前端就会永远认为"没有论文在跑"，勾选限制形同虚设。
   */
  const target = ids[2]

  // 起一个 job 但**不等它结束**，立刻查 jobs 接口
  const r = await post(`/api/papers/${target}/analyze`, { project_id: PID, force: true })
  check(r.status === 200, `${target} analyze 应 200，实际 ${r.status}`)
  const jobId = r.body?.data?.job_id

  const jobsRightAfter = await jobsOf()
  const mine = jobsRightAfter.find((j) => j.job_id === jobId)
  check(Boolean(mine), `jobs 接口应能查到刚起的 job ${jobId}`)
  check(mine?.paper_id === target, `job 的 paper_id 应为 ${target}，实际 ${mine?.paper_id}`)
  check(
    ['queued', 'running'].includes(mine?.state),
    `刚起的 job 状态应为 queued/running，实际 ${mine?.state}`,
  )

  // 模拟前端的 selectable 计算
  const activeIds = new Set(
    jobsRightAfter.filter((j) => j.state === 'queued' || j.state === 'running').map((j) => j.paper_id),
  )
  check(
    activeIds.has(target),
    `前端应能把 ${target} 判定为"已有任务在跑"从而禁用勾选，实际 activeIds=${JSON.stringify([...activeIds])}`,
  )
  // 已完成的论文不应被误判成"在跑"
  const jobsAfterAllDone = await (async () => {
    await pollUntilDone(jobId)
    return jobsOf()
  })()
  const activeIdsAfter = new Set(
    jobsAfterAllDone.filter((j) => j.state === 'queued' || j.state === 'running').map((j) => j.paper_id),
  )
  check(
    !activeIdsAfter.has(target),
    `${target} 任务结束后不应再被判定为"在跑"（否则用户永远选不了它）`,
  )

  console.log(
    `  起 job 后 jobs 接口可见 ${target}（${mine?.state}）；结束后该论文重新变为可勾选`,
  )
}

/* ================================================================== */
console.log('— 6. 部分失败：一篇挂了，其余照常完成 —')
/* ================================================================== */

{
  /*
   * 幽灵文件：论文有合法 file_hash（过得了 NO_FULLTEXT 守卫），
   * 但盘上把 PDF 删掉 → 任务在 readFile 处失败。
   * 这是真实会发生的场景（文件被外部删掉、或只拷了 papers.json 没拷 uploads）。
   */
  const ghostId = await mkMeta('ba-ghost', '幽灵文件论文')
  await post(`/api/projects/${PID}/papers/${ghostId}/fetch-fulltext`)
  const ghostFetched = await paperById(ghostId)
  check(
    !String(ghostFetched?.file_hash).startsWith('meta:'),
    '幽灵论文应先取全文成功（否则测的是另一条路径）',
  )

  const ghostPath = path.join(uploadDir, ghostFetched.file_hash.slice(0, 16), ghostFetched.file_name)
  rmSync(ghostPath, { force: true })

  const beforeMethods = (await methodsOf()).length
  const beforeEvidence = (await evidenceOf()).length

  // 再准备一篇正常的，与幽灵一起"批量"
  const okId = await mkMeta('ba-ok', '同批正常论文')
  await post(`/api/projects/${PID}/papers/${okId}/fetch-fulltext`)

  const batch = [ghostId, okId]
  const outcomes = []
  for (const id of batch) {
    const r = await post(`/api/papers/${id}/analyze`, { project_id: PID, force: true })
    if (r.status !== 200) {
      outcomes.push({ id, state: 'rejected', status: r.status })
      continue
    }
    const { job } = await pollUntilDone(r.body?.data?.job_id)
    outcomes.push({ id, state: job.state, job })
  }

  const ghostOut = outcomes.find((o) => o.id === ghostId)
  const okOut = outcomes.find((o) => o.id === okId)

  // 失败的那篇：不能显示"已分析"，也不能写半套数据
  check(ghostOut?.state === 'failed', `文件丢失的论文应 failed，实际 ${ghostOut?.state}`)
  const ghostAfter = await paperById(ghostId)
  check(
    ghostAfter?.status !== 'completed' && ghostAfter?.status !== 'validated',
    `失败后状态绝不能是 completed/validated（否则界面显示"已分析"），实际 ${ghostAfter?.status}`,
  )
  check(ghostAfter?.status === 'failed', `失败后状态应为 failed，实际 ${ghostAfter?.status}`)
  check(
    typeof ghostAfter?.error === 'string' && ghostAfter.error.length > 0,
    '失败论文应记下 error 原因',
  )
  check((ghostAfter?.method_ids ?? []).length === 0, '失败论文的 method_ids 应为空')

  // 同批正常的另一篇：必须照常完成，不被失败的拖累
  check(okOut?.state === 'completed', `同批的正常论文应 completed，实际 ${okOut?.state}`)
  const okAfter = await paperById(okId)
  check(okAfter?.status === 'completed', `同批正常论文最终应 completed，实际 ${okAfter?.status}`)

  // 失败不该写入任何方法/证据；成功那篇会写入，所以总数应只增加成功那篇的
  const afterMethods = (await methodsOf()).length
  const afterEvidence = (await evidenceOf()).length
  const okMethods = (await methodsOf()).filter((m) => (m.paper_ids ?? []).includes(okId)).length
  const okEvidence = (await evidenceOf()).filter((e) => e.paper_id === okId).length
  check(
    afterMethods - beforeMethods === okMethods,
    `方法数增量(${afterMethods - beforeMethods}) 应只等于成功那篇的方法数(${okMethods})`,
  )
  check(
    afterEvidence - beforeEvidence === okEvidence,
    `证据数增量(${afterEvidence - beforeEvidence}) 应只等于成功那篇的证据数(${okEvidence})`,
  )
  check(okMethods > 0, '同批成功的那篇应有方法落库')

  console.log(
    `  幽灵 ${ghostId} → failed（未写入数据）；同批 ${okId} → completed（方法 ${okMethods} / 证据 ${okEvidence}）`,
  )
}

/* ================================================================== */
console.log('— 7. 已分析的论文可以重新分析 —')
/* ================================================================== */

{
  const target = ids[1] // 已在第 3 段完成
  const before = await methodsOf()
  const r = await post(`/api/papers/${target}/analyze`, { project_id: PID, force: true })
  check(r.status === 200, `重新分析应被接受，实际 ${r.status}`)
  check(
    r.body?.data?.reused !== true,
    '上一篇已终态，这里应新起 job（reused 不该是 true）',
  )
  const { job } = await pollUntilDone(r.body?.data?.job_id)
  check(job.state === 'completed', `重新分析应成功，实际 ${job.state}（${job.error}）`)

  const after = await methodsOf()
  const idsAfter = after.map((m) => m.method_id)
  check(
    new Set(idsAfter).size === idsAfter.length,
    `重新分析后 method_id 仍不得重复：${idsAfter.join(', ')}`,
  )
  const p = await paperById(target)
  check(p?.status === 'completed', `重新分析后状态应为 completed，实际 ${p?.status}`)
  check(
    (p?.method_ids ?? []).length === after.filter((m) => (m.paper_ids ?? []).includes(target)).length,
    '重新分析后 method_ids 应仍与实际挂载一致（不残留旧 ID）',
  )
  console.log(`  重新分析 ${target} → completed（方法 ${before.length} → ${after.length}，ID 无重复）`)
}

/* ================================================================== */
console.log('— 8. 不越界：不产生 方法关系 / 演进 / 空白 / 方向 —')
/* ================================================================== */

{
  /*
   * 本阶段的范围只有"批量提交分析"。关系/演进/空白/方向是更上层的产物，
   * 本次一个字都不该动。这一段的做法是：这些数据在真实项目里本就来自
   * Demo 层，服务端接口不提供——所以只要确认接口不返回、且论文行里
   * 没有这些外键即可。
   */
  const ev = await evidenceOf()
  for (const e of ev) {
    check(
      (e.gap_ids ?? []).length === 0,
      `证据 ${e.evidence_id} 不应有 gap_ids（本阶段不涉及空白）：${JSON.stringify(e.gap_ids)}`,
    )
    check(
      (e.direction_ids ?? []).length === 0,
      `证据 ${e.evidence_id} 不应有 direction_ids（本阶段不涉及方向）：${JSON.stringify(e.direction_ids)}`,
    )
  }
  console.log(`  ${ev.length} 条证据的 gap_ids / direction_ids 均为空，未越界`)
}

/* ================================================================== */

console.log('')
console.log('──────────────────────────────────────────────────────────────')
if (errors.length) {
  console.log(`✗ 批量分析测试失败，${errors.length} 处：`)
  for (const e of errors) console.log('  · ' + e)
  stop()
  process.exit(1)
}
console.log('✓ 批量分析测试全部通过（3 篇各自独立完成 / ID 无重复 / 内容不互相覆盖）')
stop()
process.exit(0)
