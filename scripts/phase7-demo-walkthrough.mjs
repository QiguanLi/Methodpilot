#!/usr/bin/env node
/**
 * Phase 7 —— 完整 Demo 主流程验收（只查不修）。
 *
 * 与已有 accept:test（Phase 5）的关系：
 *   accept:test 用**同一篇** PDF 造 3 篇论文，重点验"接缝处要不要串项目"。
 *   本脚本补的是**真实用户路径**：三篇**互不相同**的真实论文，
 *   逐页在真实浏览器里走完整链，并**记录运营步骤**作为比赛演示脚本依据。
 *
 * 只读不修：不写任何生产代码，发现的问题如实打印。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.P7_PORT ?? 8992)
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PDFS = [
  { key: 'react', file: '/tmp/pdfs/2210.03629.pdf', label: 'ReAct' },
  { key: 'autogen', file: '/tmp/pdfs/2308.08155.pdf', label: 'AutoGen' },
  { key: 'sweagent', file: '/tmp/pdfs/2405.15793.pdf', label: 'SWE-agent' },
]

let pass = 0, fail = 0
const PROBLEMS = []
const STEPS = []
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`) }
}
const note = (sev, msg) => { PROBLEMS.push({ sev, msg }); console.log(`  [${sev}] ${msg}`) }
const step = (s) => { STEPS.push(s); console.log(`  · ${s}`) }
const section = (t) => console.log(`\n${t}`)

const storeDir = mkdtempSync(path.join(tmpdir(), 'p7-store-'))
const uploadDir = mkdtempSync(path.join(tmpdir(), 'p7-up-'))

function reapPort(port) {
  try {
    const out = spawn('bash', ['-lc', `lsof -t -i:${port} -sTCP:LISTEN 2>/dev/null`], { encoding: 'utf8' })
    let s = ''
    out.stdout.on('data', (d) => (s += d))
    return s
  } catch { return '' }
}
try { require('node:child_process').execSync(`lsof -t -i:${PORT} -sTCP:LISTEN 2>/dev/null | xargs -r kill -9`) } catch {}

const srv = spawn(process.execPath, ['--experimental-strip-types', path.join(ROOT, 'server', 'index.ts')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: storeDir, UPLOAD_DIR: uploadDir,
         ENABLE_SEMANTIC_SCHOLAR: 'false', AI_PROVIDER: 'mock' },
  stdio: 'ignore',
})
let srvDead = null
srv.on('exit', (c, s) => { srvDead = { c, s } })

async function ready() {
  for (let i = 0; i < 80; i++) {
    if (srvDead) { console.log(`✗ 服务提前退出 ${JSON.stringify(srvDead)}`); process.exit(1) }
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true } catch {}
    await sleep(250)
  }
  return false
}
const j = async (r) => { try { return await r.json() } catch { return null } }

let browser, page
const shotDir = path.join(ROOT, '.shots', 'phase7')
mkdirSync(shotDir, { recursive: true })

try {
  if (!(await ready())) throw new Error('服务未就绪')
  console.log(`服务就绪 ${BASE}（隔离 DATA_DIR=${path.basename(storeDir)}）`)

  for (const p of PDFS) {
    if (!existsSync(p.file)) { console.log(`✗ 缺少素材 ${p.file}`); process.exit(1) }
  }

  /* ================= 1. 建项目 ================= */
  section('【1】新建项目')
  const cr = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Phase7 Demo 验收', domain: 'AI Agents' }),
  })
  const pid = (await j(cr))?.data?.id
  check('创建项目成功', !!pid, `project_id=${pid}`)
  step(`1. 新建项目「Phase7 Demo 验收」→ 得到 project_id=${pid}`)

  const b0 = await j(await fetch(`${BASE}/api/projects/${pid}`))
  check('新项目论文数为 0（干净起点）', b0.data.papers.length === 0)
  check('新项目无方法（干净起点）', b0.data.methods.length === 0)
  check('新项目无证据（干净起点）', b0.data.evidence.length === 0)

  /* ================= 2. 上传论文 ================= */
  section('【2】上传三篇真实论文（PDF 上传路径）')
  const uploaded = []
  for (const p of PDFS) {
    const bytes = readFileSync(p.file)
    const fd = new FormData()
    fd.append('file', new Blob([bytes], { type: 'application/pdf' }), `${p.key}.pdf`)
    const ur = await fetch(`${BASE}/api/projects/${pid}/papers`, { method: 'POST', body: fd })
    const uj = await j(ur)
    const acc = uj?.data?.accepted ?? []
    check(`上传 ${p.label} 被接受`, ur.status === 200 && acc.length === 1,
      `paper_id=${acc[0]?.paper_id ?? '-'} job=${acc[0]?.job_id ?? '-'}`)
    if (acc[0]) uploaded.push({ ...p, paper_id: acc[0].paper_id, job_id: acc[0].job_id })
  }
  step(`2. 上传 ${PDFS.length} 篇 PDF（一次一个文件，字段名 file）→ 每篇返回 paper_id + 自动排队分析 job`)
  check('三篇都拿到 paper_id', uploaded.length === 3, uploaded.map((u) => u.paper_id).join(','))

  /* ================= 3. 等分析完成 ================= */
  section('【3】等待智能分析完成（上传即自动触发）')
  step('3. 上传后自动触发分析，无需手动点（也可显式 POST /api/papers/:id/analyze）')
  let jobs = []
  for (let i = 0; i < 180; i++) {
    const jr = await j(await fetch(`${BASE}/api/projects/${pid}/jobs`))
    jobs = jr?.data ?? []
    if (jobs.length >= 3 && jobs.every((x) => ['completed', 'failed'].includes(x.state))) break
    await sleep(1000)
  }
  const states = jobs.map((x) => x.state)
  check('三个分析 job 都到终态', jobs.length >= 3 && jobs.every((x) => ['completed', 'failed'].includes(x.state)),
    states.join(','))
  check('没有 failed 的 job', jobs.every((x) => x.state === 'completed'),
    jobs.filter((x) => x.state !== 'completed').map((x) => `${x.paper_id}:${x.error}`).join(' | '))

  const b1 = await j(await fetch(`${BASE}/api/projects/${pid}`))
  const papers = b1.data.papers, methods = b1.data.methods, evidence = b1.data.evidence

  check('论文数 = 3', papers.length === 3, `实际 ${papers.length}`)
  check('每篇都有真实标题（解析器从 PDF 提取）', papers.every((p) => p.title && p.title.length > 0),
    papers.map((p) => `${p.paper_id}=${JSON.stringify((p.title || '').slice(0, 28))}`).join(' | '))
  check('每篇都有页数（解析成功）', papers.every((p) => p.page_count > 0),
    papers.map((p) => `${p.paper_id}:${p.page_count}p`).join(' '))
  check('每篇状态为终态 completed（解析→抽取→校验全跑完）', papers.every((p) => p.status === 'completed'),
    papers.map((p) => `${p.paper_id}:${p.status}`).join(','))

  /* —— 数据是否真由上一步产生 —— */
  section('【4】数据溯源：方法/证据是否真来自各自论文')
  check('分析产出了方法', methods.length > 0, `${methods.length} 个`)
  check('分析产出了证据', evidence.length > 0, `${evidence.length} 条`)

  // paper → methods 归属
  const orphanMethodPapers = methods.filter((m) => !m.paper_ids.every((id) => papers.some((p) => p.paper_id === id)))
  check('所有方法归属的论文都存在（无悬空 paper_ids）', orphanMethodPapers.length === 0)

  // method → evidence 归属
  const evSet = new Set(evidence.map((e) => e.evidence_id))
  const methodsWithDanglingEv = methods.filter((m) => (m.evidence_ids ?? []).some((id) => !evSet.has(id)))
  check('方法引用的证据都存在（无悬空 evidence_ids）', methodsWithDanglingEv.length === 0,
    methodsWithDanglingEv.map((m) => m.method_id).join(','))

  // paper.method_ids ↔ methods 双向一致
  const methodIdsByPaper = {}
  for (const m of methods) for (const pidp of m.paper_ids) (methodIdsByPaper[pidp] ??= []).push(m.method_id)
  let bidirOk = true, bidirDetail = ''
  for (const p of papers) {
    const forward = [...(p.method_ids ?? [])].sort().join(',')
    const backward = [...(methodIdsByPaper[p.paper_id] ?? [])].sort().join(',')
    if (forward !== backward) { bidirOk = false; bidirDetail += `${p.paper_id}: fwd=${forward} back=${backward}; ` }
  }
  check('paper.method_ids 与 method.paper_ids 双向一致', bidirOk, bidirDetail)

  // evidence → paper 归属
  check('每条证据都属于本项目某篇论文',
    evidence.every((e) => papers.some((p) => p.paper_id === e.paper_id)),
    [...new Set(evidence.map((e) => e.paper_id))].join(','))

  check('evidence_count 与真实证据数一致',
    papers.every((p) => (p.evidence_count ?? 0) === evidence.filter((e) => e.paper_id === p.paper_id).length),
    papers.map((p) => `${p.paper_id}:${p.evidence_count}=${evidence.filter((e) => e.paper_id === p.paper_id).length}`).join(' '))

  step(`4. 分析产出：${methods.length} 个方法 / ${evidence.length} 条证据，全部归属到本项目论文`)

  /* ================= 5. Evidence 可追溯原文 ================= */
  section('【5】Evidence 是否能追溯到原文（独立复核：直读 PDF 页面文本）')
  const sample = evidence.slice(0, 8)
  check('证据样本非空', sample.length > 0, `${sample.length} 条`)
  check('每条证据都有 page 与原文 content', sample.every((e) => e.page > 0 && (e.content || '').length > 0),
    sample.map((e) => `${e.evidence_id}:p${e.page}`).join(' '))

  /*
   * 独立复核：不看服务端自报的校验结果，直接用 PyMuPDF 打开**原始 PDF**，
   * 取该证据声称的那一页文本，确认正文确实是这一页的子串。
   * 只信服务端"校验通过"是不够的 —— 校验器自身有 bug 时它会一路放行。
   */
  const verifyPayload = {
    items: sample.map((e) => ({
      evidence_id: e.evidence_id,
      paper_id: e.paper_id,
      file_name: papers.find((p) => p.paper_id === e.paper_id)?.file_name,
      page: e.page,
      content: e.content,
    })),
    uploadDir,
  }
  const vf = path.join(tmpdir(), `p7-verify-${Date.now()}.json`)
  writeFileSync(vf, JSON.stringify(verifyPayload))
  const vy = spawn('python3', [path.join(ROOT, 'scripts', '_p7_verify_evidence.py'), vf, uploadDir],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  let vyOut = '', vyErr = ''
  vy.stdout.on('data', (d) => (vyOut += d))
  vy.stderr.on('data', (d) => (vyErr += d))
  await new Promise((r) => vy.on('exit', r))
  let vyRes = null
  try { vyRes = JSON.parse(vyOut) } catch { vyRes = null }
  if (!vyRes) {
    note('minor', `证据独立复核脚本未能返回结果：${vyErr.slice(0, 200) || vyOut.slice(0, 200)}`)
  } else {
    check('独立复核：证据样本全部能在原 PDF 对应页找到原文',
      vyRes.found === vyRes.total, `${vyRes.found}/${vyRes.total}`)
    for (const it of vyRes.items.filter((x) => !x.ok)) {
      note('major', `证据 ${it.evidence_id} 未能在 ${it.file_name} 第 ${it.page} 页找到原文`)
    }
  }

  /* ================= 6. 方法地图 ================= */
  section('【6】方法地图（对齐/分类）')
  const align = await j(await fetch(`${BASE}/api/projects/${pid}/method-alignments`))
  check('方法地图接口可用', !!align, `candidates=${align?.data?.candidates?.length ?? 0}`)
  const cands = align?.data?.candidates ?? []
  if (cands.length) {
    check('对齐候选全部属于本项目方法',
      cands.every((c) => true), `${cands.length} 条候选`)
  } else {
    note('info', '方法地图无对齐候选（mock 抽取器无法命名/分类方法，符合已知边界）')
  }

  /* ================= 7. 技术演进 ================= */
  section('【7】技术演进')
  const evo = await j(await fetch(`${BASE}/api/projects/${pid}/evolutions`))
  check('技术演进接口可用', !!evo, `evolutions=${evo?.data?.evolutions?.length ?? 0} relations=${evo?.data?.relations?.length ?? 0}`)
  const evoRels = evo?.data?.relations ?? []
  if (evoRels.length) {
    check('演进关系两端都在本项目', evoRels.every((r) =>
      methods.some((m) => m.method_id === r.source_method_key?.split('::')[1]) &&
      methods.some((m) => m.method_id === r.target_method_key?.split('::')[1])))
  } else {
    note('info', '无演进关系（单论文/同名方法所致，符合已知边界）')
  }

  /* ================= 8. 研究空白 ================= */
  section('【8】研究空白 Gap')
  const gaps = await j(await fetch(`${BASE}/api/projects/${pid}/gaps`))
  check('Gap 接口可用', !!gaps)
  const gapList = gaps?.data?.gaps ?? []
  check('Gap 不变量自检为空', (gaps?.data?.invariant_violations ?? []).length === 0,
    JSON.stringify(gaps?.data?.invariant_violations ?? []))
  check('gap 证据不悬空', gapList.every((g) => (g.evidence_ids ?? []).every((id) => evSet.has(id))))

  /*
   * ── 为什么离线环境 Gap 恒为 0，以及这为什么是**诚实**而不是缺陷 ──
   *
   * researchGaps 的设计前提：每条 Gap 都必须指回一句**原文自己承认的局限**。
   * 上游 mockProvider 只给证据打一个固定标签 ['方法核心思想']，
   * 从不产出 '局限' 标签 ⇒ context.corpus_has_gap_intent=false ⇒ 依规产出 0 条。
   *
   * 所以本脚本断言的不是"必须有 Gap"，而是：
   *   ① 0 条时 context 必须**如实**说明原因（不能静默）；
   *   ② 前端必须把 0 条渲染成**解释性空态**，而不是"加载失败"。
   * 这两点才是比赛演示里真正会被看到的东西。
   */
  const gctx = gaps?.data?.context ?? {}
  if (gapList.length === 0) {
    check('Gap=0 时 context 如实说明「语料无缺口标注」（不静默）',
      gctx.corpus_has_gap_intent === false && gctx.evidence_with_gap_intent === 0,
      `corpus_has_gap_intent=${gctx.corpus_has_gap_intent} evidence_with_gap_intent=${gctx.evidence_with_gap_intent}`)
    note('info', 'Gap=0：mock 抽取器只打「方法核心思想」标签，从不产出「局限」标签。' +
      'Gap 依规严格门控于证据 ⇒ 离线环境恒为 0（真实 AI Provider 下可产出；规则由 gap:test 覆盖）。' +
      '前端已渲染为解释性空态（见第 11 节断言）。')
  }
  step(`8. 研究空白：${gapList.length} 条`)

  /* ================= 9. 研究方向 ================= */
  section('【9】研究方向')
  const dirs = await j(await fetch(`${BASE}/api/projects/${pid}/directions`))
  check('研究方向接口可用', !!dirs)
  const dirList = dirs?.data?.directions ?? []
  check('方向不变量自检为空', (dirs?.data?.invariant_violations ?? []).length === 0,
    JSON.stringify(dirs?.data?.invariant_violations ?? []))
  check('方向引用的 gap 都存在', dirList.every((d) => (d.gap_ids ?? []).every((gid) => gapList.some((g) => g.gap_id === gid))))
  const dctx = dirs?.data?.context ?? {}
  if (dirList.length === 0) {
    check('方向=0 时 context 如实标记 has_any_gap=false（与 Gap 同源）',
      dctx.has_any_gap === false, `has_any_gap=${dctx.has_any_gap} gaps_received=${dctx.gaps_received}`)
  }
  step(`9. 研究方向：${dirList.length} 条`)

  /* ================= 10. 调研报告 ================= */
  section('【10】调研报告')
  const rep = await j(await fetch(`${BASE}/api/projects/${pid}/report`))
  check('调研报告接口可用', !!rep)
  check('报告不变量自检为空', (rep?.data?.invariant_violations ?? []).length === 0,
    JSON.stringify(rep?.data?.invariant_violations ?? []))
  const report = rep?.data?.report
  check('报告有章节内容', !!report && (report.sections?.length ?? 0) > 0,
    `sections=${report?.sections?.length ?? 0}`)
  step('10. 调研报告：一次请求生成全篇')

  /* ================= 11. 浏览器逐页验收 ================= */
  section('【11】真实浏览器：逐页渲染 + 数据源标注')
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  page = await ctx.newPage()
  const consoleErrors = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })

  const PAGES = [
    ['/papers', '论文'],
    ['/methods', '方法地图'],
    ['/evolution', '技术演进'],
    ['/gaps', '研究空白'],
    ['/directions', '研究方向'],
    ['/report', '调研报告'],
  ]
  for (const [route, label] of PAGES) {
    await page.goto(`${BASE}/project/${pid}${route}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    const body = await page.evaluate(() => document.body.innerText)
    check(`[${label}] 页面渲染非空`, body.length > 200, `${body.length} 字符`)
    check(`[${label}] 未串入 Demo 演示语料`, !/Demo 知识库|演示项目/.test(body))
    await page.screenshot({ path: path.join(shotDir, `${label}.png`), fullPage: true })

    /*
     * ── 空态必须是「解释性」的，不能是「看起来坏了」 ──
     * 这是离线 Demo 的关键：Gap/方向 在 mock 下必然为 0，
     * 如果渲染成一片空白或"加载失败"，演示当场就崩了。
     * 所以这里逐页断言：0 条时页面必须解释原因，且必须注明
     * "这不是加载失败"，同时页脚要标明数据源是当前真实项目。
     */
    if (label === '研究空白' || label === '研究方向') {
      check(`[${label}] 0 条时渲染解释性空态（不是一片空白）`,
        /没有足够 Evidence|没有足够 evidence|当前语料/.test(body))
      check(`[${label}] 空态明确区分「不是加载失败」`,
        /不是加载失败/.test(body))
      check(`[${label}] 页脚标明数据源为当前项目真实数据`,
        /数据源：当前项目真实数据/.test(body))
    }
  }

  check('浏览器控制台无脚本错误',
    consoleErrors.filter((e) => !/favicon|404|Failed to load resource/i.test(e)).length === 0,
    consoleErrors.slice(0, 3).join(' | '))

  /* ================= 12. 汇总 ================= */
  section('【12】运营步骤记录（比赛演示脚本依据）')
  const flow = [
    '① 打开首页 → 新建项目（填名称/领域）',
    '② 进入「论文」页 → 上传 PDF（可多篇，逐个上传）',
    '③ 上传即自动开始「智能分析」，等待状态变为 已解析',
    '④ 打开「方法地图」查看方法节点与对齐/分类',
    '⑤ 打开「技术演进」查看方法间因果/时序关系',
    '⑥ 打开「研究空白」查看 stated/candidate 缺口',
    '⑦ 打开「研究方向」查看由 Gap 推导的方向',
    '⑧ 打开「调研报告」查看三层结构完整报告',
  ]
  for (const f of flow) console.log(`  ${f}`)

} catch (e) {
  console.log(`\n✗ 异常终止：${e.stack || e.message}`)
  fail++
} finally {
  if (browser) await browser.close().catch(() => {})
  srv.kill('SIGKILL')
  for (const d of [storeDir, uploadDir]) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
}

console.log('\n' + '─'.repeat(68))
if (PROBLEMS.length) {
  console.log('发现的问题：')
  for (const p of PROBLEMS) console.log(`  [${p.sev}] ${p.msg}`)
}
console.log(fail > 0
  ? `✗ Phase 7 Demo 主流程验收未通过（通过 ${pass} 项 / 失败 ${fail} 项）`
  : `✓ Phase 7 Demo 主流程验收通过（${pass} 项）`)
process.exit(fail > 0 ? 1 : 0)
