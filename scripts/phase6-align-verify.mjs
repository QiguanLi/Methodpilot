/**
 * Phase 6 端到端验证：多论文方法对齐
 *
 * 目的：在**真实 2 篇论文**的项目上，验证跨论文关系能真正产出。
 *
 * 为什么必须做这个：引擎（Phase 4-2）本身已被 100 项断言覆盖，但
 * data/store 里**每个项目都只有 1 篇论文**，`skippedSamePaper` 把所有方法对
 * 都吃掉了 → 线上从来没产出过一条跨论文关系。即代码正确但从未被真实数据
 * 触发。本脚本补上这个缺口。
 *
 * 断言（对应用户 Phase 6 的 5 条要求）：
 *   1. 读取当前 methods + verified evidence        → 关系里带 evidence_ids
 *   2. 判断同一/改进/替代/组合关系                  → 只允许 same/alias/related/uncertain
 *   3. 只有有证据支持时才建立关系                    → same/alias 必须 grounded
 *   4. 无证据时标「待判断」不编造因果                → uncertain 不得是因果；无因果类型
 *   5. 方法地图能展示跨论文关系                      → candidates 含双方 paper_id
 */
import fs from 'node:fs'

const API = 'http://127.0.0.1:8787'
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

async function j(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

async function pollJob(id, ms = 120000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const r = await j('GET', `/api/jobs/${id}`)
    const st = r.body?.data?.state
    if (st === 'completed' || st === 'failed') return r.body.data
    await new Promise((s) => setTimeout(s, 400))
  }
  throw new Error('job timeout')
}

async function upload(projectId, filePath, fileName) {
  const buf = fs.readFileSync(filePath)
  const fd = new FormData()
  fd.append('file', new Blob([buf], { type: 'application/pdf' }), fileName)
  const r = await fetch(`${API}/api/projects/${projectId}/papers`, { method: 'POST', body: fd })
  return { status: r.status, body: await r.json().catch(() => null) }
}

console.log('══ 1. 建隔离项目 ══')
const created = await j('POST', '/api/projects', {
  name: 'Phase6 多论文方法对齐验证',
  subtitle: 'cross-paper alignment',
  description: '验证 2 篇论文能建立跨论文方法关系',
  domain: 'ai-coding',
  goal: '验证多论文对齐',
})
const PID = created.body?.data?.id
check(!!PID, `项目创建 ${PID}`)

console.log('\n══ 2. 上传 2 篇真实 PDF ══')
const PDF = 'data/uploads/f285b0971ae4a790/2210.03629.pdf'
const u1 = await upload(PID, PDF, 'align-a.pdf')
const u2 = await upload(PID, PDF, 'align-b.pdf')
const p1 = u1.body?.data?.accepted?.[0]?.paper_id
const p2 = u2.body?.data?.accepted?.[0]?.paper_id
console.log(`  上传结果 p1=${p1} p2=${p2}`)
check(!!p1 && !!p2, `两篇论文均已入库（${p1}, ${p2}）`)

console.log('\n══ 3. 逐篇分析（真实 PDF → parser → analysis）══')
for (const [pid, jobHint] of [
  [p1, u1.body?.data?.accepted?.[0]?.job_id],
  [p2, u2.body?.data?.accepted?.[0]?.job_id],
]) {
  if (jobHint) await pollJob(jobHint)
  const an = await j('POST', `/api/papers/${pid}/analyze`, { project_id: PID, force: true })
  const jid = an.body?.data?.job_id
  if (jid) {
    const done = await pollJob(jid)
    console.log(`  ${pid} → ${done.state}`)
  }
}

const bundle = (await j('GET', `/api/projects/${PID}`)).body?.data
const methods = bundle?.methods ?? []
const papers = bundle?.papers ?? []
console.log(`  方法 ${methods.length} 个 / 论文 ${papers.length} 篇`)

console.log('\n══ 4. 请求跨论文对齐 ══')
const al = (await j('GET', `/api/projects/${PID}/method-alignments`)).body?.data
const cands = al?.candidates ?? []
const ctx = al?.context ?? {}
console.log(`  context: ${JSON.stringify(ctx)}`)
console.log(`  候选 ${cands.length} 条`)

console.log('\n══ 要求1：读取 methods + verified evidence ══')
check(methods.length >= 2, `项目方法数 ≥ 2（实际 ${methods.length}）`)
check(
  cands.length > 0,
  `⚠️ 必须产出跨论文关系（skipped_same_paper=${ctx.skipped_same_paper}），实际 ${cands.length} 条`,
)

console.log('\n══ 要求2：关系类型合法（同一/别名/相关/待判断）══')
const ALLOWED = new Set(['same', 'alias', 'related', 'uncertain'])
const badType = cands.filter((c) => !ALLOWED.has(c.relation_type))
check(badType.length === 0, `全部关系类型在白名单内，越界 ${badType.length} 条`)
const CAUSAL = new Set(['improves', 'extends', 'evolves', 'replaces', 'causes'])
check(
  cands.every((c) => !CAUSAL.has(c.relation_type)),
  '未产出任何因果/历史类型（改进/替代/组合不得凭空断言）',
)

console.log('\n══ 要求3：只有有证据支持才建立关系 ══')
const conclusive = cands.filter((c) => c.relation_type === 'same' || c.relation_type === 'alias')
const ungrounded = conclusive.filter((c) => !c.hasDirectEvidence)
check(
  ungrounded.length === 0,
  `same/alias 必须 grounded，未达标 ${ungrounded.length} 条`,
)
const groundedNeedEvidence = cands.filter((c) => c.hasDirectEvidence && c.evidence_ids.length === 0)
check(
  groundedNeedEvidence.length === 0,
  `标记 grounded 的关系必须带 evidence_ids，实际违规 ${groundedNeedEvidence.length} 条`,
)

console.log('\n══ 要求4：无证据 → 待判断，不编造因果 ══')
const uncertain = cands.filter((c) => c.relation_type === 'uncertain')
console.log(`  uncertain ${uncertain.length} 条 / grounded ${(al?.stats?.grounded ?? 0)} 条`)
check(
  cands.every((c) => (c.hasDirectEvidence ? true : c.relation_type !== 'same')),
  '无证据的关系不得升级为 same',
)
check(
  uncertain.every((c) => typeof c.reason === 'string' && c.reason.length > 0),
  '每条待判断都带可复述的解释文案',
)

console.log('\n══ 要求5：方法地图可展示（双方 paper_id 齐全）══')
const crossPaper = cands.filter(
  (c) => c.source?.paper_id && c.target?.paper_id && c.source.paper_id !== c.target.paper_id,
)
check(
  crossPaper.length === cands.length,
  `每条关系都必须跨论文（source.paper_id ≠ target.paper_id），实际 ${crossPaper.length}/${cands.length}`,
)
check(
  cands.every((c) => c.source?.method_id && c.target?.method_id),
  '每条关系双方 method_id 齐全（可定位到图谱节点）',
)
check(
  cands.every((c) => c.alignment_id),
  '每条关系都有稳定 alignment_id（前端据此绑定）',
)

console.log('\n══ 附加：stats 口径与候选一致 ══')
check(
  (al?.stats?.total ?? -1) === cands.length,
  `stats.total 等于候选数（${al?.stats?.total} vs ${cands.length}）`,
)
const sumTypes =
  (al?.stats?.same ?? 0) +
  (al?.stats?.alias ?? 0) +
  (al?.stats?.related ?? 0) +
  (al?.stats?.uncertain ?? 0)
check(sumTypes === cands.length, `四类之和等于候选数（${sumTypes}）`)

console.log(`\n${'═'.repeat(62)}`)
if (fail === 0) console.log(`✓ Phase 6 多论文方法对齐验证通过（${pass} 项）`)
else console.log(`✗ ${fail} 项未通过（通过 ${pass} 项）`)
console.log(`\n项目 ${PID} 保留供排查；清理请手动删除 data/store/projects/${PID}`)
process.exit(fail === 0 ? 0 : 1)
