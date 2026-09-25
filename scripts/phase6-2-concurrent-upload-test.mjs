/**
 * Phase 6-2 并发上传回归：**不串行**，一次并发传两篇，验证不再写坏 store。
 *
 * ── 为什么单独写这个 ──
 *
 * phase6-2-causal-e2e.mjs 为了稳定，改成"串行上传"（传一篇等终态再传下一篇），
 * 从而规避了并发写。但**规避不等于修复**：真实用户完全可能同时拖两篇进来，
 * 或者并发触发两个分析 job。修复之后的正确性必须在这个场景下也成立。
 *
 * 本脚本就是那个场景：
 *   · 同一个 tick 里并发上传 alpha.pdf 与 beta.pdf
 *   · 两个 analyze job 会同时往 papers/methods/evidence 写
 *   · 断言：store 全部合法 JSON、两篇论文各自完整、跨论文 extends 关系可产出
 *
 * 用法：pnpm phase6-2:concurrent-test
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const API = 'http://127.0.0.1:8787'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
const check = (ok, msg) => {
  if (ok) {
    pass++
    console.log(`  ✓ ${msg}`)
  } else {
    fail++
    console.log(`  ✗ ${msg}`)
  }
}

const j = async (m, p, b) => {
  const r = await fetch(API + p, {
    method: m,
    headers: { 'content-type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const pollJob = async (id, ms = 180000) => {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < ms) {
    const r = await j('GET', `/api/jobs/${id}`)
    last = r.body?.data
    if (last?.state === 'completed' || last?.state === 'failed') return last
    await new Promise((s) => setTimeout(s, 300))
  }
  throw new Error(`job ${id} 超时（最后 ${last?.state}）`)
}
const upload = async (pid, fp, name) => {
  const fd = new FormData()
  fd.append('file', new Blob([fs.readFileSync(fp)], { type: 'application/pdf' }), name)
  const r = await fetch(`${API}/api/projects/${pid}/papers`, { method: 'POST', body: fd })
  return await r.json().catch(() => null)
}

/* ── 复跑多轮，因为并发缺陷是概率性的 ── */
const ROUNDS = Number(process.env.CONC_ROUNDS ?? 6)
const storeProjects = path.join(
  process.env.DATA_DIR ?? path.join(ROOT, 'data', 'store'),
  'projects',
)

console.log(`══ 并发上传回归：${ROUNDS} 轮，每轮同一个 tick 并发上传 2 篇 ══`)

let corruptRounds = 0
let missingRounds = 0
let causalRounds = 0

for (let round = 1; round <= ROUNDS; round++) {
  const PID = (await j('POST', '/api/projects', {
    name: `Phase6-2 并发上传 R${round}`,
    subtitle: 'concurrent',
    description: 'x',
    domain: 'ai-coding',
    goal: 'x',
  })).body?.data?.id

  /* ★ 关键：不 await 第一个上传就发起第二个 —— 制造真实并发 */
  const [uA, uB] = await Promise.all([
    upload(PID, path.join(ROOT, 'data', 'fixtures', 'alpha.pdf'), 'alpha.pdf'),
    upload(PID, path.join(ROOT, 'data', 'fixtures', 'beta.pdf'), 'beta.pdf'),
  ])

  const jobs = [uA, uB].map((u) => u?.data?.accepted?.[0]?.job_id).filter(Boolean)
  const states = await Promise.all(jobs.map((id) => pollJob(id).then((d) => d.state).catch(() => 'timeout')))
  const allDone = states.every((s) => s === 'completed')

  /* 直接检查落盘 JSON 是否合法 —— 这是修复的核心断言 */
  const dir = path.join(storeProjects, PID)
  let roundCorrupt = false
  for (const f of ['papers.json', 'methods.json', 'evidence.json', 'project.json']) {
    try {
      JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    } catch {
      roundCorrupt = true
      console.log(`    ✗ R${round} ${f} 损坏`)
    }
  }
  if (roundCorrupt) corruptRounds++

  const bundle = (await j('GET', `/api/projects/${PID}`)).body?.data
  const papers = bundle?.papers ?? []
  const methods = bundle?.methods ?? []
  const okShape = papers.length === 2 && methods.length === 2
  if (!okShape) missingRounds++

  /*
   * 孤儿方法检测（核心验收点之一）。
   *
   * lost update 的一种后果：P001 从 papers.json 里被覆盖掉，
   * 但它早先启动的 analyze job 照常落库了一个 `paper_ids:["P001"]` 的方法 ——
   * 指向一篇已不存在的论文。这种"孤儿"在 UI 上看起来完全正常，
   * 却会让技术演进链凭空多出一个节点。
   */
  const paperIds = new Set(papers.map((p) => p.paper_id))
  const orphans = methods.filter((m) => !(m.paper_ids ?? []).some((id) => paperIds.has(id)))
  const orphanFree = orphans.length === 0

  /* 每篇论文都必须有方法（防止"论文在、方法丢"的反向丢数据） */
  const papersWithMethod = new Set(methods.flatMap((m) => m.paper_ids ?? []))
  const allPapersHaveMethod = papers.every((p) => papersWithMethod.has(p.paper_id))

  /*
   * ★ 归属一致性（本次 lost update 的真身，比"孤儿"更隐蔽）。
   *
   * ID 撞号被顶掉后的症状**不是**孤儿（id 存在），而是这个双向矛盾：
   *     P001.method_ids = ["M001"]      ← P001 说 M001 是我的
   *     M001.paper_ids  = ["P002"]      ← M001 却说我是 P002 的
   * 方法数没少、孤儿也没有，但方法和论文**对不上**。
   * 所以必须显式断言双向一致，否则这个 bug 会从"方法丢失"退化成
   * "归属错乱"继续潜伏。两处都要查：
   *   ① paper.method_ids 里每个 id，其 method.paper_ids 必须含该 paper
   *   ② method.paper_ids 里每个 id，其 paper.method_ids 必须含该 method
   */
  const methodById = new Map(methods.map((m) => [m.method_id, m]))
  const paperById = new Map(papers.map((p) => [p.paper_id, p]))
  const mismatches = []
  for (const p of papers) {
    for (const mid of p.method_ids ?? []) {
      const m = methodById.get(mid)
      if (!m) mismatches.push(`${p.paper_id}.method_ids 含不存在的 ${mid}`)
      else if (!(m.paper_ids ?? []).includes(p.paper_id))
        mismatches.push(`${p.paper_id}→${mid} 但 ${mid}.paper_ids=${JSON.stringify(m.paper_ids)}`)
    }
  }
  for (const m of methods) {
    for (const pid2 of m.paper_ids ?? []) {
      const p = paperById.get(pid2)
      if (!p) mismatches.push(`${m.method_id}.paper_ids 含不存在的 ${pid2}`)
      else if (!(p.method_ids ?? []).includes(m.method_id))
        mismatches.push(`${m.method_id}→${pid2} 但 ${pid2}.method_ids=${JSON.stringify(p.method_ids)}`)
    }
  }
  const assignmentOk = mismatches.length === 0

  const evo = (await j('GET', `/api/projects/${PID}/evolutions`)).body?.data
  const hasExtends = (evo?.relations ?? []).some((r) => r.relation_type === 'extends' && r.causal)
  if (hasExtends) causalRounds++

  console.log(
    `  R${round}: jobs=[${states.join(',')}] papers=${papers.length} methods=${methods.length} ` +
      `ev=${(bundle?.evidence ?? []).length} corrupt=${roundCorrupt} orphan=${orphans.length} ` +
      `assign=${assignmentOk ? 'ok' : 'MISMATCH'} extends=${hasExtends}`,
  )
  check(!roundCorrupt, `R${round} store 全部为合法 JSON`)
  check(okShape, `R${round} 两篇论文各 1 个方法（papers=${papers.length}/methods=${methods.length}）`)
  check(orphanFree, `R${round} 无孤儿方法（孤儿 ${orphans.length} 个${orphans.length ? '：' + orphans.map((m) => m.method_id + '→' + JSON.stringify(m.paper_ids)).join(',') : ''}）`)
  check(allPapersHaveMethod, `R${round} 每篇论文都有对应方法（无反向丢数据）`)
  check(assignmentOk, `R${round} 论文↔方法归属双向一致${assignmentOk ? '' : '：' + mismatches.slice(0, 3).join('；')}`)
  check(allDone, `R${round} 两个 analyze job 均 completed`)
  check(hasExtends, `R${round} 仍产出因果 extends（Beta→Alpha）`)

  /* 清理本轮项目 */
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n统计：损坏轮次 ${corruptRounds}/${ROUNDS} · 结构异常 ${missingRounds}/${ROUNDS} · 因果产出 ${causalRounds}/${ROUNDS}`)
check(corruptRounds === 0, `并发上传 ${ROUNDS} 轮，零损坏`)
check(missingRounds === 0, `${ROUNDS} 轮全部 papers=2 / methods=2（异常 ${missingRounds} 轮）`)
check(causalRounds === ROUNDS, `${ROUNDS} 轮全部产出因果 extends`)

console.log(`\n${'═'.repeat(62)}`)
if (fail === 0) console.log(`✓ 并发上传回归通过（${pass} 项断言）`)
else console.log(`✗ ${fail} 项未通过（通过 ${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
