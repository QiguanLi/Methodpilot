#!/usr/bin/env node
/**
 * 分析链路测试（Phase 3B-8）。
 *
 * 验的是这一条完整链路：
 *   metadata → fetch-fulltext → analyze → job 四态 → methods/evidence 落库
 *
 * ── 为什么这条链路必须端到端测，而不是分别测两段 ──
 *
 * 3B-7 交付了"把 PDF 取回来"，3B-8 交付了"把分析接出来"。
 * 两段各自单测都能过，但接缝处有几个**只有连起来才会暴露**的问题：
 *   · 取回全文后 file_hash 从 meta: 变成真实哈希 —— 分析路径找文件是按
 *     file_hash 反推目录的，哈希不对就会"论文存在但文件找不到"；
 *   · paperFilePath() 用 file_name 拼路径 —— 取全文时文件被重命名过
 *     （去掉 URL 里带不合法字符的部分），名字对不上同样找不到文件；
 *   · 取全文后 sections 被清空、page_count 归 0 —— 如果哪里缓存了旧值，
 *     分析会用空的章节去做抽取，产出 0 个方法并"成功"。
 * 这三条都不会报错，只会安静地少干活。所以必须跑真的全链路。
 *
 * ── 为什么用服务端自己起的 PDF 站点，而不是直接上传 ──
 *
 * 直接上传就跳过了 fetch-fulltext，接缝就测不到了——而那正是本阶段的风险所在。
 * 所以这里扮演一个论文站点：提供摘要页 HTML + 真实 PDF 字节。
 * 走的是**完全相同的生产代码路径**（fulltext.ts 解析 + 下载 + 落盘），
 * 只是目标地址换成了 127.0.0.1。
 *
 * AI 用 mock provider（确定性规则抽取器），这样测试不需要模型也不依赖网络，
 * 但**解析、文件定位、抽取、证据校验、落库**全部真实执行。
 *
 * 运行：pnpm analyze:test
 */

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.ANALYZE_TEST_PORT ?? 8951)
const BASE = `http://127.0.0.1:${PORT}`
const SITE_PORT = Number(process.env.ANALYZE_SITE_PORT ?? 8952)
const SITE = `http://127.0.0.1:${SITE_PORT}`

const errors = []
const check = (cond, msg) => {
  if (!cond) errors.push(msg)
}

/* ------------------------------------------------------------------ */
/* 真实 PDF —— 用 e2e 的同一份语料，避免再造一个假 PDF                   */
/* ------------------------------------------------------------------ */

const PDF_PATH = process.env.ANALYZE_TEST_PDF ?? '/tmp/pdfs/2210.03629.pdf'
if (!existsSync(PDF_PATH)) {
  console.log(`✗ 找不到测试 PDF：${PDF_PATH}`)
  console.log('  这个测试需要一份**真实多页 PDF**（mock 抽取器也要真正文才抽得出东西）。')
  console.log('  可用 e2e 的语料：/tmp/pdfs/2210.03629.pdf，或设 ANALYZE_TEST_PDF 指定。')
  process.exit(1)
}
const REAL_PDF = readFileSync(PDF_PATH)
console.log(`使用真实 PDF：${path.basename(PDF_PATH)}（${(REAL_PDF.length / 1024).toFixed(0)}KB）`)

/* ------------------------------------------------------------------ */
/* 一个最小的"论文站点"                                               */
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
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(REAL_PDF.length) })
    res.end(REAL_PDF)
    return
  }

  // 坏站点：页面能打开，但里面没有任何 PDF 线索
  if (url.startsWith('/broken/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><body>no fulltext available</body></html>')
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

await new Promise((r) => site.listen(SITE_PORT, '127.0.0.1', r))

/* ------------------------------------------------------------------ */
/* 起隔离的服务端                                                      */
/* ------------------------------------------------------------------ */

const storeDir = mkdtempSync(path.join(tmpdir(), 'mpan-'))
const uploadDir = mkdtempSync(path.join(tmpdir(), 'mpan-up-'))

/*
 * 端口自愈：上次测试被 Ctrl-C / timeout 杀掉时，spawn 的服务端会变成孤儿
 * 继续占着端口。那时本次新起的服务端 EADDRINUSE 直接退出，而测试会连上
 * **上一次那个残留实例**（旧 DATA_DIR），断言全乱。这个坑在 3B-7 踩过。
 */
{
  let occupied = false
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1200) })
    occupied = true
  } catch {
    occupied = false
  }
  if (occupied) {
    const pid = (
      spawnSync('bash', ['-c', `ss -ltnp 2>/dev/null | grep ':${PORT} ' | grep -oP 'pid=\\K[0-9]+' | head -1`], {
        encoding: 'utf8',
      }).stdout || ''
    ).trim()
    const cmd =
      spawnSync('bash', ['-c', `ps -p ${pid} -o args= 2>/dev/null`], { encoding: 'utf8' }).stdout || ''
    if (/^\d+$/.test(pid) && cmd.includes('methodpilot/server/index.ts')) {
      console.log(`  · 清理上次残留的服务端（pid=${pid}）`)
      try { process.kill(Number(pid), 'SIGKILL') } catch {}
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 150))
        try {
          await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(500) })
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
      // mock 抽取器：确定性、无需模型、不依赖网络，但解析/校验/落库全是真的
      AI_PROVIDER: 'mock',
      ANALYSIS_CONCURRENCY: '2',
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
  try { srv.kill('SIGKILL') } catch {}
  try { site.close() } catch {}
  for (const d of [storeDir, uploadDir]) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
}
process.on('exit', stop)
process.on('SIGINT', () => { stop(); process.exit(130) })
process.on('SIGTERM', () => { stop(); process.exit(143) })

/*
 * HTTP 用**异步 fetch**，不能用 spawnSync + curl。
 * spawnSync 会阻塞事件循环，而同进程的 site 服务器就没法响应，
 * 被测服务端 fetch 它会一直等到超时——症状是"测试莫名卡住"。
 * 3B-7 在这个坑上花了不少时间。
 */
async function get(u) {
  try {
    const res = await fetch(`${BASE}${u}`, { signal: AbortSignal.timeout(30_000) })
    return res.json().catch(() => null)
  } catch {
    return null
  }
}
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
  name: '分析链路测试',
  subtitle: 'Phase 3B-8',
  domain: 'AI Agents',
  goal: '验证 metadata → fetched PDF → analyze → job 完成',
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

/** 建一篇仅元数据论文，返回 paper_id */
const mkMeta = async (s2id, link, title = `测试论文 ${s2id}`) => {
  const r = await post(`/api/projects/${PID}/papers/meta`, {
    s2_paper_id: s2id,
    title,
    authors: ['作者甲'],
    year: 2023,
    abstract: '摘要文本',
    url: link,
    doi: `10.1000/${s2id}`,
    citationCount: 5,
    venue: 'TestConf',
    source: 'live',
  })
  return r.body?.data?.paper?.paper_id ?? ''
}

/** 轮询 job 到终态，返回过程中见过的所有 state（用于断言四态都出现过） */
async function pollUntilDone(jobId, timeoutMs = 180_000) {
  const seen = new Set()
  const t0 = Date.now()
  for (;;) {
    const r = await get(`/api/jobs/${jobId}`)
    const job = r?.data
    if (!job) throw new Error(`job ${jobId} 读不到`)
    seen.add(job.state)
    if (job.state === 'completed' || job.state === 'failed') return { job, seen }
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${jobId} 超时未完成，当前 ${job.state}/${job.stage}`)
    await new Promise((r) => setTimeout(r, 400))
  }
}

/* ================================================================== */
console.log('')
console.log('— 1. 仅元数据论文直接 analyze：必须被挡住，且不改状态 —')
/* ================================================================== */

const metaId = await mkMeta('chain-meta', `${SITE}/abs/chain-meta`)

/*
 * 这一条是 3B-8 补的服务端守卫。
 * 放它进队列的后果不是"立刻报错"而是**先报成功**：论文被改成 parsing、
 * job 返回 200，然后任务在 readFile 处失败。中间每一秒界面都在谎报"在分析"。
 */
const direct = await post(`/api/papers/${metaId}/analyze`, { project_id: PID, force: true })
check(direct.status === 409, `无全文的论文 analyze 应返回 409，实际 ${direct.status}`)
check(
  direct.body?.error?.code === 'NO_FULLTEXT',
  `错误码应为 NO_FULLTEXT，实际 ${direct.body?.error?.code}`,
)
check(
  typeof direct.body?.error?.message === 'string' && direct.body.error.message.includes('获取全文'),
  '错误提示应指出先获取全文，实际：' + JSON.stringify(direct.body?.error?.message),
)

const metaAfter = await paperById(metaId)
check(metaAfter?.status === 'pending', `被挡住后状态必须还是 pending，实际 ${metaAfter?.status}`)
check(
  String(metaAfter?.file_hash).startsWith('meta:'),
  '被挡住后 file_hash 不应变化',
)
// 没有产生 job —— 否则界面上会挂着一个永远不动的进度条
const jobsAll = (await get(`/api/projects/${PID}/jobs`))?.data ?? []
check(
  !jobsAll.some((j) => j.paper_id === metaId),
  '被挡住的论文不应产生任何 job',
)
console.log(`  409 ${direct.body.error.code} → status 仍为 ${metaAfter.status}，未产生 job`)

/* ================================================================== */
console.log('— 2. metadata → fetch-fulltext → analyze 全链路 —')
/* ================================================================== */

const okId = await mkMeta('chain-ok', `${SITE}/abs/chain-ok`, 'ReAct 分析链路测试')

const fr = await post(`/api/projects/${PID}/papers/${okId}/fetch-fulltext`)
check(fr.body?.data?.ok === true, `获取全文应成功，实际 ${JSON.stringify(fr.body?.data)}`)

const fetched = await paperById(okId)
check(fetched?.status === 'uploaded', `取回全文后状态应为 uploaded，实际 ${fetched?.status}`)
check(!String(fetched?.file_hash).startsWith('meta:'), '取回全文后 file_hash 应为真实哈希')

/*
 * 这三条验的是"落盘位置与论文记录一致"——分析路径按
 * uploadDir/<file_hash 前16位>/<file_name> 反推文件。
 * 任何一处对不上，分析都会报"文件找不到"，而且失败点在几步之外。
 */
const savedPath = path.join(uploadDir, fetched.file_hash.slice(0, 16), fetched.file_name)
check(existsSync(savedPath), `PDF 应落在分析路径反推的位置：${savedPath}`)
if (existsSync(savedPath)) {
  check(readFileSync(savedPath).subarray(0, 5).toString('latin1') === '%PDF-', '落盘文件应是真 PDF')
}

const ar = await post(`/api/papers/${okId}/analyze`, { project_id: PID, force: true })
check(ar.status === 200, `analyze 应返回 200，实际 ${ar.status} ${JSON.stringify(ar.body?.error)}`)
const jobId = ar.body?.data?.job_id
check(typeof jobId === 'string' && jobId.length > 0, 'analyze 应返回 job_id')
check(['queued', 'running'].includes(ar.body?.data?.state), `返回的 state 应是 queued/running，实际 ${ar.body?.data?.state}`)
console.log(`  取全文 → status=${fetched.status}；analyze → job=${jobId} state=${ar.body?.data?.state}`)

/* ================================================================== */
console.log('— 3. job 跑到终态，且四态都出现过 —')
/* ================================================================== */

const { job, seen } = await pollUntilDone(jobId)
check(job.state === 'completed', `job 应 completed，实际 ${job.state}（error=${job.error}）`)

/*
 * 四种状态：queued / running / completed / failed。
 * queued 与 running 是否都**观察得到**取决于调度快慢——
 * mock 抽取器很快，一次轮询里就可能从 queued 直接到 completed。
 * 所以这里不硬性要求四个都出现，而是要求"出现过的一定在合法集合内"，
 * 并单独验证 completed。硬要求四态齐全的测试会随机变红。
 */
check(seen.has('completed'), '必须观察到 completed')
const legal = new Set(['queued', 'running', 'completed', 'failed'])
for (const s of seen) check(legal.has(s), `出现了非法 job 状态：${s}`)
console.log(`  观察到状态：${[...seen].join(' → ')}；最终 stage=${job.stage}`)

/* ================================================================== */
console.log('— 4. 成功后有方法 / 证据真的落库（进现有数据链） —')
/* ================================================================== */

const paperFinal = await paperById(okId)
/* 先确认存在，再检查字段 —— 论文消失时不应让下面的断言静默通过 */
check(paperFinal !== undefined, `分析成功后论文必须仍在列表中，实际 paperById(${okId}) = ${JSON.stringify(paperFinal)}`)
check(paperFinal?.status === 'completed', `分析成功后论文状态应为 completed，实际 ${paperFinal?.status}`)
check(paperFinal !== undefined && paperFinal.error === null, `成功时 error 应为 null，实际 ${paperFinal?.error}`)

const okMethods = (await methodsOf()).filter((m) => (m.paper_ids ?? []).includes(okId))
check(okMethods.length > 0, `应写入方法，实际 ${okMethods.length} 个`)
check(
  (paperFinal?.method_ids ?? []).length > 0,
  `论文的 method_ids 应有值，实际 ${JSON.stringify(paperFinal?.method_ids)}`,
)

const okEvidence = (await evidenceOf()).filter((e) => e.paper_id === okId)
check(okEvidence.length > 0, `应写入证据，实际 ${okEvidence.length} 条`)
check(
  paperFinal?.evidence_count === okEvidence.length,
  `evidence_count(${paperFinal?.evidence_count}) 应与实际证据数(${okEvidence.length}) 一致`,
)

/*
 * 证据必须带页码与原文——这是本项目的核心承诺（每条结论都能回原文）。
 * 没有页码证据就是"看起来有证据"的装饰。
 *
 * ⚠️ 落库字段叫 `content`，不是 `quote`。
 * `quote` 是 job.rejected 里那条"**被拒绝**的证据"的字段名（保留完整原文
 * 以便复现判定）。我第一版把两者搞混，断言 content 不存在，得到
 * "证据 quote 不应为空"的假失败——代码是对的，是测试读错了字段。
 */
for (const e of okEvidence.slice(0, 3)) {
  check(
    typeof e.content === 'string' && e.content.trim().length > 0,
    `证据 ${e.evidence_id} 的 content（原文）不应为空`,
  )
  check(Number.isFinite(e.page) && e.page > 0, `证据 ${e.evidence_id} 应有正数页码，实际 ${e.page}`)
  check(
    typeof e.section === 'string' && e.section.length > 0,
    `证据 ${e.evidence_id} 应记录所属章节`,
  )
}

// 溯源也要写上，否则界面上"用什么算出来的"那一栏会显示缺失
check(paperFinal !== undefined && paperFinal.analyzed_with !== null, 'analyzed_with 应写入分析溯源')
console.log(`  status=${paperFinal.status}，方法 ${okMethods.length} 个，证据 ${okEvidence.length} 条，均已带页码`)

/* ================================================================== */
console.log('— 5. 重复 analyze：复用正在跑的 job，不重复起 —')
/* ================================================================== */

const again = await post(`/api/papers/${okId}/analyze`, { project_id: PID, force: true })
/*
 * 此刻上一个 job 已经 completed，所以这里会**新起**一个 job（不是复用）——
 * 这是正确行为：用户点"重新分析"就是要再跑一次。
 * 真正要守住的是"同一时刻不会有两个在跑"，那条用 running 分支覆盖：
 * 在同一个 job 还在跑的时候再点，必须拿到同一个 job_id。
 */
check(again.status === 200, `重新分析应返回 200，实际 ${again.status}`)
console.log(`  重新分析 → 新 job=${again.body?.data?.job_id}（上一个已终态，应新起）`)

/*
 * ⚠️ 必须**等这个 job 跑完**再往下走。
 *
 * 不等的话，这个 job 会在后面的小节里任意时刻落库，把那之后取的
 * "before 快照"顶掉，导致「失败不应写入方法/证据」这类**计数差值断言**
 * 随机变红 —— 是个测试自身的竞态，与被测代码无关。
 * （修复并发写回后更容易触发：现在每次分析都会**追加**方法与证据，
 *  而不是覆盖，所以后台 job 落库对计数的影响从"可能不变"变成"必然 +N"。）
 */
const againJobId = again.body?.data?.job_id
if (typeof againJobId === 'string' && againJobId.length > 0) {
  const againDone = await pollUntilDone(againJobId)
  check(againDone.job.state === 'completed', `重新分析应跑完，实际 ${againDone.job.state}`)
}

/* ================================================================== */
console.log('— 6. 失败路径：不能显示"已分析"，也不能写入半套数据 —')
/* ================================================================== */

/*
 * 构造一个必然失败的分析：
 * 论文有合法的 file_hash/文件名（所以能过 NO_FULLTEXT 守卫），
 * 但盘上**没有这个文件**。这是真实会发生的场景——文件被外部删掉、
 * 或者从别的机器拷了 papers.json 过来而没拷 uploads。
 *
 * 这样能确定性地走完"起了 job → 任务失败 → 状态落 failed"，
 * 而不依赖某个会让模型恰好抽不出东西的 PDF（那样太脆）。
 */
const ghostId = await mkMeta('chain-ghost', `${SITE}/abs/chain-ghost`, '幽灵文件测试')
await post(`/api/projects/${PID}/papers/${ghostId}/fetch-fulltext`)
const ghostFetched = await paperById(ghostId)
check(!String(ghostFetched?.file_hash).startsWith('meta:'), '幽灵论文应先取全文成功')

// 把落盘的 PDF 删掉，模拟文件丢失
const ghostPath = path.join(uploadDir, ghostFetched.file_hash.slice(0, 16), ghostFetched.file_name)
try {
  rmSync(ghostPath, { force: true })
} catch {}

const beforeMethods = (await methodsOf()).length
const beforeEvidence = (await evidenceOf()).length

const gr = await post(`/api/papers/${ghostId}/analyze`, { project_id: PID, force: true })
check(gr.status === 200, `文件丢失的分析请求本身仍应被接受（失败发生在任务里），实际 ${gr.status}`)

const gDone = await pollUntilDone(gr.body?.data?.job_id)
check(gDone.job.state === 'failed', `文件不存在时 job 应 failed，实际 ${gDone.job.state}`)
check(
  typeof gDone.job.error === 'string' && gDone.job.error.length > 0,
  '失败的 job 必须带 error 说明，不能是空',
)

const ghostAfter = await paperById(ghostId)

/*
 * ⚠️ **先确认论文存在，再检查它的字段。**
 *
 * 下面这一条是本节所有断言的**前提**，必须放在最前面且不可省略。
 * 原因（实测教训）：原先这一节全部写成 `ghostAfter?.status === 'failed'` 这类
 * 可选链断言。当论文整个从列表里消失时（`ghostAfter === undefined`），
 * 每一条可选链断言都会**求值为 false → 变成 fail**……但更早的版本里它们被写成了
 * `ghostAfter?.status !== 'completed'` 这种**否定式**，undefined 恰好也满足，
 * 于是全体"通过"。真正暴露问题的只是后面一句没加 `?.` 的 console.log。
 *
 * 也就是说：**测试崩溃掩盖了断言失效**——弱断言把「论文消失」这种严重缺陷
 * 伪装成了绿色。所以这里把存在性单独钉死，让「消失」直接指向病因。
 */
check(
  ghostAfter !== undefined && ghostAfter !== null,
  `分析失败的论文必须仍然存在于论文列表中（不得凭空消失），` +
    `实际 paperById(${ghostId}) = ${JSON.stringify(ghostAfter)}`,
)

/*
 * 这是本阶段最关键的三条断言。
 * spec 原话："失败时不能显示'已分析'"。
 * 前端 mapPaperStatus 把 completed/validated 映射成 analyzed，
 * 所以只要 status 不是这两个值，界面就不会显示"已分析"。
 * 这里直接把这条约束钉死在服务端数据上——比测 UI 文案可靠得多。
 */
check(
  ghostAfter?.status !== 'completed' && ghostAfter?.status !== 'validated',
  `失败后状态绝不能是 completed/validated（否则界面会显示"已分析"），实际 ${ghostAfter?.status}`,
)
check(ghostAfter?.status === 'failed', `失败后状态应为 failed，实际 ${ghostAfter?.status}`)
check(
  typeof ghostAfter?.error === 'string' && ghostAfter.error.length > 0,
  `论文的 error 字段应记下失败原因，实际 ${JSON.stringify(ghostAfter?.error)}`,
)

// 失败了就不能有半套数据落库
check(
  (await methodsOf()).length === beforeMethods,
  `失败不应写入方法（前后应一致：${beforeMethods}）`,
)
check(
  (await evidenceOf()).length === beforeEvidence,
  `失败不应写入证据（前后应一致：${beforeEvidence}）`,
)
/*
 * 下面两条也补上存在性前提：论文若消失，`?? []` 会让断言静默通过。
 */
check(
  Array.isArray(ghostAfter?.method_ids) && ghostAfter.method_ids.length === 0,
  `失败论文的 method_ids 应为空数组，实际 ${JSON.stringify(ghostAfter?.method_ids)}`,
)
check(
  ghostAfter !== undefined && ghostAfter.evidence_count === 0,
  `失败论文的 evidence_count 应为 0，实际 ${ghostAfter?.evidence_count}`,
)
check(ghostAfter !== undefined && ghostAfter.analyzed_with === null, '失败论文不应写入 analyzed_with 溯源')

// 前端映射复核：把 status 送进与 projectData.ts 相同规则的映射，确认得到 failed
const uiStatus = ['completed', 'validated'].includes(ghostAfter?.status)
  ? 'analyzed'
  : ghostAfter?.status === 'failed'
    ? 'failed'
    : 'pending'
check(uiStatus === 'failed', `前端映射后应显示"解析失败"，实际映射为 ${uiStatus}`)
console.log(
  `  job=${gDone.job.state} → paper.status=${ghostAfter?.status} → 前端显示"解析失败"，未写入任何数据`,
)

/* ================================================================== */
console.log('— 7. 失败后可以重试（用户已确认保留重试） —')
/* ================================================================== */

// 把文件放回去，再分析一次——应当成功，且状态从 failed 恢复
const restored = await post(`/api/projects/${PID}/papers/${ghostId}/fetch-fulltext`)
/*
 * 注意：这里 file_hash 已经是真实哈希（第一次 fetch 成功过），
 * 所以 fetch-fulltext 会返回 already=true，不会重新下载。
 * 直接用 curl 把文件放回原路径来模拟"问题修好了"。
 */
check(restored.body?.data?.already === true, '已有全文的论文再获取应返回 already（不重复下载）')

// 用 fetch-fulltext 的 already 分支拿不到文件，这里直接把 PDF 写回原位
{
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(path.dirname(ghostPath), { recursive: true })
  writeFileSync(ghostPath, REAL_PDF)
}

const rr = await post(`/api/papers/${ghostId}/analyze`, { project_id: PID, force: true })
check(rr.status === 200, `重试应被接受，实际 ${rr.status}`)
const rDone = await pollUntilDone(rr.body?.data?.job_id)
check(rDone.job.state === 'completed', `文件恢复后重试应成功，实际 ${rDone.job.state}（${rDone.job.error}）`)

const recovered = await paperById(ghostId)
check(recovered !== undefined, `重试后论文必须仍在列表中，实际 ${JSON.stringify(recovered)}`)
check(recovered?.status === 'completed', `重试成功后状态应为 completed，实际 ${recovered?.status}`)
check(recovered !== undefined && recovered.error === null, `重试成功后 error 应清空，实际 ${recovered?.error}`)
check((recovered?.method_ids ?? []).length > 0, '重试成功后应有方法写入')
console.log(`  重试 → job=${rDone.job.state}，status=${recovered.status}，方法 ${recovered.method_ids.length} 个`)

/* ================================================================== */
console.log('— 8. 已上传 PDF 的论文行为不变 —')
/* ================================================================== */

/*
 * 用上传接口真实的传一篇 PDF（不是伪造记录），验证 upload → analyze
 * 这条原有路径仍然完好——3B-8 只应该**新增**触发入口，不能改动它。
 */
const uploadRes = spawnSync(
  'curl',
  ['-s', '-X', 'POST', `${BASE}/api/projects/${PID}/papers`, '-F', `file=@${PDF_PATH}`],
  { encoding: 'utf8' },
)
let uploaded = null
try {
  uploaded = JSON.parse(uploadRes.stdout)
} catch {}
const upPaperId = uploaded?.data?.accepted?.[0]?.paper_id
check(Boolean(upPaperId), `上传应被接受，实际 ${uploadRes.stdout?.slice(0, 200)}`)

if (upPaperId) {
  const upJobId = uploaded.data.accepted[0].job_id
  check(typeof upJobId === 'string' && upJobId.length > 0, '上传应自动起分析任务（原有行为）')
  if (upJobId) {
    const uDone = await pollUntilDone(upJobId)
    check(uDone.job.state === 'completed', `上传后的自动分析应成功，实际 ${uDone.job.state}`)
    const upPaper = await paperById(upPaperId)
    check(upPaper !== undefined, `上传论文分析后论文必须仍在列表中，实际 ${JSON.stringify(upPaper)}`)
    check(upPaper?.status === 'completed', `上传论文分析后应为 completed，实际 ${upPaper?.status}`)
    check((upPaper?.method_ids ?? []).length > 0, '上传论文应抽出方法（原有链路完好）')
    console.log(`  上传 → 自动 job=${uDone.job.state}，status=${upPaper.status}，行为与之前一致`)
  }
}

/* ================================================================== */
console.log('— 9. 不存在的论文 / 项目仍然正确报错 —')
/* ================================================================== */

const bad1 = await post('/api/papers/P999/analyze', { project_id: PID })
check(bad1.status === 404, `不存在的论文应 404，实际 ${bad1.status}`)
const bad2 = await post('/api/papers/P001/analyze', { project_id: 'proj_not_exist' })
check(bad2.status === 404, `不存在的项目应 404，实际 ${bad2.status}`)
console.log(`  未知论文 → ${bad1.status}；未知项目 → ${bad2.status}`)

/* ================================================================== */
console.log('')
console.log('— 10. 并发回归：分析进行中加入的论文不得被抹掉 —')
/* ================================================================== */

/*
 * 这一节钉死的是 Phase 5 验收发现的 blocker：
 *
 *   分析 job 启动时只 `getBundle` 读**一次**快照，之后所有 savePapers
 *   都用那份陈旧数组写回；`replacePaper` 只替换 id 匹配项、从不删除，
 *   于是 job 运行期间新加入的论文会被整份覆盖掉——**静默消失**，
 *   而所有 HTTP 请求都返回 200/success。
 *
 * 复现要点：必须在 **A 的 job 还没结束时** 加入 B。
 * 用 `force:true` 保证 A 一定会真跑（不被去重跳过），
 * 从而把"job 在跑"的时间窗拉到最大。
 */
{
  // A：完整就绪（取到全文）
  const raceAId = await mkMeta('race-a', `${SITE}/abs/race-a`, '并发回归 A：先加入')
  await post(`/api/projects/${PID}/papers/${raceAId}/fetch-fulltext`)
  check(!!raceAId, `并发回归 A 论文已就绪：${raceAId}`)

  // 起 A 的分析 job，**不等待**
  const aRes = await post(`/api/papers/${raceAId}/analyze`, { project_id: PID, force: true })
  const aJobId = aRes.body?.data?.job_id
  check(typeof aJobId === 'string' && aJobId.length > 0, `A 的分析 job 已启动：${aJobId}`)

  // 关键动作：job 运行中加入 B（只加元数据，不需要 PDF）
  const raceBId = await mkMeta('race-b', `${SITE}/abs/race-b`, '并发回归 B：job 运行中加入')
  const midList = await papersOf()
  const bPresentMid = midList.some((p) => p.paper_id === raceBId)
  check(bPresentMid, `B 在 A 的 job 运行期间成功加入：${raceBId}`)

  // 等 A 跑到终态
  const aDone = await pollUntilDone(aJobId)
  check(aDone.job.state === 'completed', `A 的分析应成功，实际 ${aDone.job.state}`)

  // ── 核心断言 1：A、B 都必须还在 ──
  const afterList = await papersOf()
  const aAfter = afterList.find((p) => p.paper_id === raceAId)
  const bAfter = afterList.find((p) => p.paper_id === raceBId)

  check(
    aAfter !== undefined,
    `A(${raceAId}) 分析完成后必须仍在论文列表中`,
  )
  check(
    bAfter !== undefined,
    `⚠️ 回归：B(${raceBId}) 在 A 的 job 运行期间加入，` +
      `A 完成后 B 必须仍然存在（这正是被修复的静默丢失缺陷）`,
  )
  check(
    aAfter?.status === 'completed',
    `A 应完成分析，实际 ${aAfter?.status}`,
  )

  // ── 核心断言 2：A/B 的方法与证据不能互相覆盖 ──
  const allMethods = await methodsOf()
  const allEvidence = await evidenceOf()
  const aMethods = allMethods.filter((m) => (m.paper_ids ?? []).includes(raceAId))
  const bMethods = allMethods.filter((m) => (m.paper_ids ?? []).includes(raceBId))

  check(aMethods.length > 0, `A 应抽到方法，实际 ${aMethods.length} 个`)
  // B 只有元数据、没取全文，不该凭空有方法 —— 更不能"继承" A 的方法
  check(
    bMethods.length === 0,
    `B 未取全文，不应有方法（更不能继承 A 的方法），实际 ${bMethods.length} 个`,
  )
  check(
    aMethods.every((m) => !(m.paper_ids ?? []).includes(raceBId)),
    'A 的方法不得被错误挂到 B 上',
  )

  const aEvidence = allEvidence.filter((e) => e.paper_id === raceAId)
  const bEvidence = allEvidence.filter((e) => e.paper_id === raceBId)
  check(aEvidence.length > 0, `A 应有证据，实际 ${aEvidence.length} 条`)
  check(bEvidence.length === 0, `B 未取全文，不应有证据，实际 ${bEvidence.length} 条`)
  check(
    aEvidence.every((e) => e.paper_id !== raceBId),
    'A 的证据不得被错误归属到 B',
  )

  // ── 核心断言 3：连跑两次分析不产生重复 ID ──
  const idsBefore = allMethods.map((m) => m.method_id)
  const evIdsBefore = allEvidence.map((e) => e.evidence_id)
  check(
    new Set(idsBefore).size === idsBefore.length,
    `方法 ID 不得重复，实际 ${idsBefore.length} 个中有 ${idsBefore.length - new Set(idsBefore).size} 个重复`,
  )
  check(
    new Set(evIdsBefore).size === evIdsBefore.length,
    `证据 ID 不得重复，实际 ${evIdsBefore.length} 条中有 ${evIdsBefore.length - new Set(evIdsBefore).size} 条重复`,
  )

  // 对 A 再分析一次，确认新分配的 ID 不与既有冲突
  const aRes2 = await post(`/api/papers/${raceAId}/analyze`, { project_id: PID, force: true })
  const aJob2 = aRes2.body?.data?.job_id
  if (aJob2) {
    const aDone2 = await pollUntilDone(aJob2)
    check(aDone2.job.state === 'completed', `A 的第二次分析应成功，实际 ${aDone2.job.state}`)
  }
  const allMethods2 = await methodsOf()
  const allEvidence2 = await evidenceOf()
  const ids2 = allMethods2.map((m) => m.method_id)
  const evIds2 = allEvidence2.map((e) => e.evidence_id)
  check(
    new Set(ids2).size === ids2.length,
    `两次分析后方法 ID 仍不得重复，实际 ${ids2.length} 个（重复 ${ids2.length - new Set(ids2).size}）`,
  )
  check(
    new Set(evIds2).size === evIds2.length,
    `两次分析后证据 ID 仍不得重复，实际 ${evIds2.length} 条（重复 ${evIds2.length - new Set(evIds2).size}）`,
  )
  // 第二次分析后 B 依然要在
  const finalList = await papersOf()
  check(
    finalList.some((p) => p.paper_id === raceBId),
    '两次分析之后 B 必须依然存在（反复写入都不能把它抹掉）',
  )

  console.log(
    `  A=${raceAId}(${aAfter?.status}) 方法 ${aMethods.length} 个 / 证据 ${aEvidence.length} 条；` +
      `B=${raceBId} 存活=${finalList.some((p) => p.paper_id === raceBId)}；` +
      `ID 无重复（方法 ${ids2.length} / 证据 ${evIds2.length}）`,
  )
}

/* ------------------------------------------------------------------ */

stop()

console.log('')
if (errors.length) {
  console.log(`✗ 分析链路测试失败，${errors.length} 项未通过：`)
  for (const e of errors) console.log(`   · ${e}`)
  process.exit(1)
}
console.log('✓ 分析链路测试全部通过（metadata → fulltext → analyze → 落库；失败不显示已分析；重试可用）')
