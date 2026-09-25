/**
 * Phase 6-2 · 跨论文因果关系端到端验证（Alpha 2021 → Beta 2024）
 *
 * ── 本脚本只验证一件事 ──
 * 当 Beta（后出现）的原文里有**明确点名 Alpha（先出现）并声明继承**的句子时，
 * evolution API 是否真的产出：
 *     relation_type = extends
 *     source_method = Beta（后出现）   ← 本项目既有的方向语义
 *     target_method = Alpha（被继承）
 *     causal        = true
 *     evidence_ids  非空
 * 并且该证据能在 UI 上点回原文。
 *
 * ── 关于方向语义（用户已确认接受现网口径）──
 * methodEvolution.ts 的 toRelation() 明确写着 `source = later, target = earlier`。
 * 所以「Beta 继承了 Alpha」在数据里的表示是 source=Beta, target=Alpha。
 * 本脚本按这个口径断言，不试图改动算法。
 *
 * ── 纪律 ──
 * · 绝不直接读写 store（data/store/**）。全部经 HTTP API。
 * · 每个 job 必须轮询到终态才进入下一步。
 * · 输出里不做 shell 插值，避免引号被 shell 吃掉。
 */
import fs from 'node:fs'
import path from 'node:path'

const API = 'http://127.0.0.1:8787'
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
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

async function j(method, p, body) {
  const r = await fetch(API + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

async function pollJob(id, ms = 180000) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < ms) {
    const r = await j('GET', `/api/jobs/${id}`)
    const d = r.body?.data
    last = d
    if (d?.state === 'completed' || d?.state === 'failed') return d
    await new Promise((s) => setTimeout(s, 500))
  }
  throw new Error(`job ${id} 轮询超时（最后状态 ${last?.state}）`)
}

async function upload(projectId, filePath, fileName) {
  const fd = new FormData()
  fd.append('file', new Blob([fs.readFileSync(filePath)], { type: 'application/pdf' }), fileName)
  const r = await fetch(`${API}/api/projects/${projectId}/papers`, { method: 'POST', body: fd })
  return await r.json().catch(() => null)
}

/* ------------------------------------------------------------------ */

console.log('══ 1. 建隔离项目 ══')
const created = await j('POST', '/api/projects', {
  name: 'Phase6-2 因果关系 E2E',
  subtitle: 'Alpha(2021) → Beta(2024)',
  description: 'Beta 原文明确声明 extends Alpha',
  domain: 'ai-coding',
  goal: '验证跨论文因果关系的产出与回链',
})
const PID = created.body?.data?.id
check(!!PID, `项目创建 ${PID}`)

/*
 * ══ 为什么必须**串行**上传（本次实测踩到的真问题）══
 *
 * POST /api/projects/:id/papers 上传后立刻 `void gate.run(() => analyzePaper(...))`
 * （papers.ts:142），即"上传即分析"。两个上传并发时，两个 analyze job 会
 * **同时**往 papers.json / methods.json / evidence.json 写。
 *
 * fileStore.writeJson 的原子写是 `${file}.${process.pid}.tmp` + rename——
 * 临时文件名只带 pid，**不带每次写的唯一后缀**。同一进程内两个并发写落到
 * 同一个 tmp 路径，字节互相穿插，rename 出来的就是两份 JSON 拼接的坏文件。
 * 实测症状：papers.json 里出现 `]okens": 0,` 这种从半个字段开始的残片，
 * 随后该论文被判 PAPER_FILE_MISSING（"服务端找不到原始 PDF"）。
 *
 * 这是**产品侧的并发缺陷**，按用户要求本次不修，只如实报告。
 * 本脚本通过**串行上传**规避：上一篇的 job 到终态后再传下一篇，
 * 从而不存在对同一文件的并发写。
 */
const FIX = path.join(ROOT, 'data', 'fixtures')

async function uploadOneAndWait(label, filePath, fileName) {
  const u = await upload(PID, filePath, fileName)
  const acc = u?.data?.accepted?.[0]
  check(!!acc, `${label} 被接受入库（paper=${acc?.paper_id}）`)
  const jid = acc?.job_id
  check(!!jid, `${label} 上传返回 job_id`)
  if (jid) {
    const d = await pollJob(jid)
    console.log(`  ${label} 入库+分析 job → ${d.state}${d.state === 'failed' ? ` （${d.error}）` : ''}`)
    check(d.state === 'completed', `${label} 入库+分析 job 到达 completed`)
  }
  return acc?.paper_id
}

console.log('\n══ 2. 串行上传两篇夹具 PDF（传一篇→等终态→再传下一篇）══')
const pAlpha = await uploadOneAndWait('Alpha', path.join(FIX, 'alpha.pdf'), 'alpha.pdf')
const pBeta = await uploadOneAndWait('Beta', path.join(FIX, 'beta.pdf'), 'beta.pdf')
check(!!pAlpha && !!pBeta && pAlpha !== pBeta, `两篇独立论文入库（Alpha=${pAlpha}, Beta=${pBeta}）`)

/*
 * ⚠️ 本脚本**不**额外调 /analyze。
 *
 * 踩过的坑（已修）：上传接口内部已经接了完整分析，我原先在上传后又显式调了一次
 * /analyze，同一篇论文被分析两遍；落库走 `mergeById`（只增不删），
 * 于是 P001 名下出现两套 Method + 两套 Evidence，paper.method_ids 只留最后一次，
 * 前一套成了孤儿。孤儿方法照样进演进链，会凭空多出 "Alpha 继承 Alpha" 这类边。
 *
 * /analyze 入口虽有"已有 running 就复用"守卫（papers.ts:195），但那是
 * check-then-act：上传 job 刚 completed、守卫查不到 running，于是又起一个。
 */

console.log('\n══ 4. 校验落库的方法与证据（经 API 读，不碰 store）══')
const bundle = (await j('GET', `/api/projects/${PID}`)).body?.data
const methods = bundle?.methods ?? []
const evidence = bundle?.evidence ?? []
const papers = bundle?.papers ?? []
for (const p of papers) console.log(`  论文 ${p.paper_id} 「${p.title}」 year=${p.year} status=${p.status}`)
for (const m of methods)
  console.log(`  方法 ${m.method_id} 「${m.name}」 papers=[${m.paper_ids}] year=${m.year} ev=[${m.evidence_ids.join(',')}]`)
for (const e of evidence)
  console.log(`  证据 ${e.evidence_id} paper=${e.paper_id} p${e.page}`)

const methodsOfAlpha = methods.filter((m) => m.paper_ids.includes(pAlpha))
const methodsOfBeta = methods.filter((m) => m.paper_ids.includes(pBeta))
const mAlpha = methodsOfAlpha[0]
const mBeta = methodsOfBeta[0]

/*
 * 每篇论文必须**恰好一个**方法。
 *
 * 这条断言是本次踩坑后加的：同一篇论文被分析两遍会产出两套 Method
 * （落库 mergeById 只增不删），而 paper.method_ids 只保留最后一次，
 * 另一套变成孤儿。孤儿方法照样会进演进链，让"Alpha 继承 Alpha"这种
 * 荒谬关系出现的概率大增。宁可让脚本在这里红，也不要放过。
 */
check(
  methodsOfAlpha.length === 1,
  `Alpha 恰好 1 个方法（实际 ${methodsOfAlpha.length}：${methodsOfAlpha.map((m) => m.method_id).join(',')}）`,
)
check(
  methodsOfBeta.length === 1,
  `Beta 恰好 1 个方法（实际 ${methodsOfBeta.length}：${methodsOfBeta.map((m) => m.method_id).join(',')}）`,
)
check(!!mAlpha, `Alpha 有方法（${mAlpha?.method_id}「${mAlpha?.name}」）`)
check(!!mBeta, `Beta 有方法（${mBeta?.method_id}「${mBeta?.name}」）`)
check(
  !!mAlpha && !!mBeta && mAlpha.method_id !== mBeta.method_id,
  '两篇方法各自独立（未被去重合并）',
)
check(
  (mBeta?.year ?? 0) > 0 && (mAlpha?.year ?? 0) > 0 && mBeta.year !== mAlpha.year,
  `两年份可确立先后（Alpha=${mAlpha?.year} → Beta=${mBeta?.year}）`,
)
check(
  (mAlpha?.name ?? '') !== (mBeta?.name ?? '') && Boolean(mAlpha?.name) && Boolean(mBeta?.name),
  `两方法名各不相同，门 B（点名）有可撞的锚点（Alpha=「${mAlpha?.name}」/ Beta=「${mBeta?.name}」）`,
)

/* 因果句必须真的进了 Beta 的证据，否则后面全是空谈 —— 先把前提查清 */
const betaText = (mBeta?.evidence_ids ?? [])
  .map((id) => evidence.find((e) => e.evidence_id === id))
  .filter(Boolean)
const causalSentence = betaText.find((e) => /builds?\s+on/i.test(e.content) && /extends/i.test(e.content))
check(
  !!causalSentence,
  causalSentence
    ? `Beta 证据中含因果句（${causalSentence.evidence_id}）：${JSON.stringify(causalSentence.content.slice(0, 80))}`
    : 'Beta 证据中未含「builds on … extends …」句（前提不成立，后续因果必然为 0）',
)

console.log("\n══ 5. evolution API：核心断言 ══")
const evo = (await j('GET', `/api/projects/${PID}/evolutions`)).body?.data
const rels = evo?.relations ?? []
console.log(`  context: ${JSON.stringify(evo?.context)}`)
console.log(`  stats:   ${JSON.stringify(evo?.stats)}`)
console.log('  关系：')
for (const r of rels) {
  console.log(
    `    ${r.relation_type.padEnd(9)} src=${r.source_method}(${r.source_paper_id}) → tgt=${r.target_method}(${r.target_paper_id}) causal=${r.causal} conf=${r.confidence} ev=[${r.evidence_ids.join(',')}]`,
  )
}
console.log('  描述：')
for (const r of rels) console.log(`    [${r.relation_type}] ${r.description}`)

const causal = rels.filter((r) => r.causal)
const ext = causal.find((r) => r.relation_type === 'extends')
check(causal.length > 0, `有有效证据时产出因果关系（实际 ${causal.length} 条）`)
check(!!ext, `产出 relation_type = extends（实际因果类型 ${JSON.stringify(causal.map((r) => r.relation_type))}）`)

if (ext) {
  check(ext.source_method === mBeta.method_id, `source_method = Beta 方法（${ext.source_method}）`)
  check(ext.target_method === mAlpha.method_id, `target_method = Alpha 方法（${ext.target_method}）`)
  check(ext.source_paper_id === pBeta, `source_paper_id = Beta 论文（${ext.source_paper_id}）`)
  check(ext.target_paper_id === pAlpha, `target_paper_id = Alpha 论文（${ext.target_paper_id}）`)
  check(ext.causal === true, 'causal = true')
  check(Array.isArray(ext.evidence_ids) && ext.evidence_ids.length > 0, `evidence_ids 非空（[${ext.evidence_ids.join(',')}]）`)
  for (const eid of ext.evidence_ids) {
    const e = evidence.find((x) => x.evidence_id === eid)
    check(!!e, `证据 ${eid} 在 API 证据表中真实存在（可回链）`)
    if (e) check(e.paper_id === pBeta, `证据 ${eid} 归属 source 论文 Beta（归属校验通过）`)
  }
  check(ext.source_method !== ext.target_method, '不是自指关系')
}

/* 反向断言：不允许出现 Beta 被 Alpha 继承 这类方向颠倒 */
const reversed = rels.filter((r) => r.causal && r.source_paper_id === pAlpha && r.target_paper_id === pBeta)
check(reversed.length === 0, `未出现方向颠倒（Alpha → Beta）的因果边，实际 ${reversed.length} 条`)

console.log('\n══ 6. 无证据不得冒充因果（负向对照）══')
check(
  rels.filter((r) => !r.causal).every((r) => !['extends', 'improves', 'replaces', 'combines'].includes(r.relation_type)),
  '非因果边不得使用因果类型',
)
check(
  rels.filter((r) => r.causal).every((r) => r.evidence_ids.length > 0),
  '因果边必须带证据',
)
check((evo?.stats?.causal_without_evidence ?? -1) === 0, `无证据因果数 = 0（实际 ${evo?.stats?.causal_without_evidence}）`)

/* 报告用：把结果落盘供页面验证脚本复用 */
fs.writeFileSync(
  '/tmp/fxprobe/e2e-result.json',
  JSON.stringify({ PID, pAlpha, pBeta, mAlpha: mAlpha?.method_id, mBeta: mBeta?.method_id, relations: rels }, null, 2),
)

console.log(`\n${'═'.repeat(62)}`)
if (fail === 0) console.log(`✓ Phase 6-2 因果 E2E 通过（${pass} 项断言）`)
else console.log(`✗ ${fail} 项未通过（通过 ${pass} 项）`)
console.log(`项目 ${PID} 保留，供页面（UI）验证脚本复用`)
process.exit(fail === 0 ? 0 : 1)
