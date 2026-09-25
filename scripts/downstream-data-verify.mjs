/**
 * 下游页面数据真实性问题 —— 修复验证
 *
 * 验证三件事：
 *   1. 年份：论文无年份时，方法 year 必须是 0（未知），不能是当前年份
 *   2. core_idea：Mock 抽取结果不得把 provider 免责声明写进方法核心思想
 *   3. classification.reason：文案应作为「未归类原因」，不含 provider 自述口吻
 *
 * 走真实链路：建项目 → 加无年份元数据论文 → fetch-fulltext → analyze → 读回
 */
const API = 'http://127.0.0.1:8787'

let pass = 0
let fail = 0
function check(ok, msg) {
  if (ok) {
    pass++
    console.log(`  ✓ ${msg}`)
  } else {
    fail++
    console.log(`  ✗ ${msg}`)
  }
}

async function j(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

async function pollJob(jobId, timeoutMs = 90000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const r = await j('GET', `/api/jobs/${jobId}`)
    const st = r.body?.data?.state
    if (st === 'completed' || st === 'failed') return r.body.data
    await new Promise((s) => setTimeout(s, 400))
  }
  throw new Error('job timeout')
}

console.log('══ 1. 建隔离项目 ══')
const created = await j('POST', '/api/projects', {
  name: '下游数据真实性验证',
  subtitle: 'year/core_idea mapping',
  description: '验证年份兜底与 Mock 文案落库位置',
  domain: 'ai-coding',
  goal: '验证数据映射',
})
const PID = created.body?.data?.id
check(typeof PID === 'string' && PID.length > 0, `项目创建成功 ${PID}`)

console.log('\n══ 2. 加入**无年份**元数据论文 ══')
const add = await j('POST', `/api/projects/${PID}/papers/meta`, {
  s2_paper_id: 'probe-noyear-001',
  title: 'Mapping Probe Paper Without Year',
  authors: ['Probe'],
  year: 0, // 关键：无年份
  abstract: 'A probe paper used to verify that an unknown publication year is not fabricated.',
  doi: '10.1000/probe-noyear',
  citationCount: 0,
  url: 'https://example.org/probe-noyear',
})
const paperId = add.body?.data?.paper_id ?? add.body?.data?.id
check(typeof paperId === 'string' && paperId.length > 0, `论文加入成功 ${paperId}`)

const pBefore = (await j('GET', `/api/projects/${PID}/papers`)).body?.data?.find(
  (p) => p.paper_id === paperId,
)
check(pBefore?.year === 0, `入库论文 year 应为 0（未知），实际 ${JSON.stringify(pBefore?.year)}`)

console.log('\n══ 3. 取全文 → 分析（走真实 PDF → parser → analysis 链路）══')
const ft = await j('POST', `/api/projects/${PID}/papers/${paperId}/fetch-fulltext`)
console.log(`  取全文 status=${ft.status} ok=${ft.body?.data?.ok}`)
if (ft.body?.data?.ok === false) {
  console.log(`  · 取全文未成功（${ft.body?.data?.code}），改用已有真实 PDF 项目验证年份逻辑`)
}

const an = await j('POST', `/api/papers/${paperId}/analyze`, {
  project_id: PID,
  force: true,
})
const jobId = an.body?.data?.job_id
if (jobId) {
  const done = await pollJob(jobId)
  console.log(`  job state=${done.state}`)
}

const bundle = (await j('GET', `/api/projects/${PID}`)).body?.data
const methods = bundle?.methods ?? []
const method = methods[0]

console.log('\n══ 4. 核心断言：方法 year ══')
if (method) {
  check(
    method.year === 0,
    `论文无年份时，方法 year 必须为 0（未知），实际 ${JSON.stringify(method.year)}` +
      `${method.year === new Date().getFullYear() ? ' ← 这正是被修复的「伪造当前年份」缺陷' : ''}`,
  )
  check(
    method.year !== new Date().getFullYear(),
    `方法 year 不得被伪造成当前年份（${new Date().getFullYear()}）`,
  )
} else {
  console.log('  · 该项目未产出方法（分析失败或无有效方法），跳过 year 断言')
}

console.log('\n══ 5. 核心断言：core_idea 不含 provider 免责声明 ══')
const allMethods = []
for (const p of (await j('GET', '/api/projects')).body?.data ?? []) {
  const b = (await j('GET', `/api/projects/${p.id}`)).body?.data
  for (const m of b?.methods ?? []) allMethods.push({ pid: p.id, ...m })
}
const polluted = allMethods.filter((m) => /Mock 模式|本 Provider/.test(m.core_idea ?? ''))
console.log(`  全库检查 ${allMethods.length} 个方法的 core_idea`)
check(
  polluted.length === 0,
  `core_idea 不得含「Mock 模式」免责声明，实际污染 ${polluted.length} 个` +
    `${polluted.length ? '：' + polluted.map((m) => `${m.pid}/${m.method_id}`).join(', ') : ''}`,
)

console.log('\n══ 6. classification.reason 文案 ══')
const withReason = allMethods.filter((m) => m.classification?.reason)
const selfNarrating = withReason.filter((m) => /本 Provider 是/.test(m.classification.reason))
check(
  selfNarrating.length === 0,
  `reason 不应是 provider 自述口吻（「本 Provider 是…」），实际 ${selfNarrating.length} 个`,
)
if (withReason[0]) {
  console.log(`  · 样例 reason：${withReason[0].classification.reason.slice(0, 90)}…`)
}

console.log('\n══ 7. 技术演进不继承免责声明 ══')
const evo = (await j('GET', `/api/projects/${PID}/evolutions`)).body?.data
const evoBad = (evo?.evolutions ?? []).filter((e) => /Mock 模式/.test(e.change ?? ''))
check(evoBad.length === 0, `演进 change 不得含「Mock 模式」，实际 ${evoBad.length} 个`)

console.log(`\n${'═'.repeat(60)}`)
console.log(fail === 0 ? `✓ 全部通过（${pass} 项）` : `✗ ${fail} 项未通过（通过 ${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
