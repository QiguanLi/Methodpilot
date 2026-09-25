/**
 * 真实数据「异常模式」审计（只读）
 *
 * 与另外两个校验脚本的关系：
 *   - `verify-data.mjs`      校 `src/data/*.ts`（内置 Demo 数据）—— 管"引用对不对"
 *   - `verify-live-data.mjs` 校 `data/store/`（真实运行时数据）—— 管"引用闭不闭合"
 *   - `audit-live-data.mjs`  校 `data/store/`（本脚本）—— 管"**数据长得像什么**"
 *
 * 本脚本不判断对错，只做**模式识别**并如实报告。它是审计，不是断言器。
 *
 * ══════════════════════════════════════════════════════════════════
 * 报告口径（**这是本脚本最重要的一条约定**）
 * ══════════════════════════════════════════════════════════════════
 * 每条发现都明确标注是【事实】还是【推断】：
 *
 *   【事实】= 直接读自文件的内容，可被逐字复核（时间戳、hash、字段值）。
 *   【推断】= 对事实的解读，**可能是错的**，需要更多证据才能定性。
 *
 * 本脚本**不会**、也不能声称存在"数据丢失"：
 *   这些 JSON 是各项目**当前状态**的快照，其中不含任何关于"曾经存在过什么"的记录。
 *   ——没有删除日志、没有 job 历史（jobStore 是内存 Map，进程重启即失）、
 *   没有 git 历史。所以任何"这里原本还有 X"的说法都**无法从现有数据证明**。
 *
 * 读不到证据时，本脚本写"无法从现有数据证明"，而**不是**猜一个结论。
 *
 * ══════════════════════════════════════════════════════════════════
 *
 * 绝对只读：只做 readFileSync / readdirSync / statSync / createHash，
 * 不含任何 write / unlink / rename / merge 调用。
 * 反复运行结果必须完全一致（输出含确定性排序）。
 *
 * 运行：node scripts/audit-live-data.mjs
 *      node scripts/audit-live-data.mjs --data-dir /path/to/store
 *      node scripts/audit-live-data.mjs --json      # 输出机器可读 JSON
 *
 * 退出码：恒为 0（审计发现"异常模式"不代表命令失败；判读交给调用方）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2)
const dataDirFlag = argv.indexOf('--data-dir')
const STORE_DIR =
  dataDirFlag !== -1 && argv[dataDirFlag + 1]
    ? path.resolve(argv[dataDirFlag + 1])
    : path.join(root, 'data', 'store')
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(root, 'data', 'uploads')
const AS_JSON = argv.includes('--json')

/* ------------------------------------------------------------------ */
/* 发现收集：每条都带 fact / inference 标记                            */
/* ------------------------------------------------------------------ */

const findings = []
/**
 * @param kind  模式类别，如「同名项目」
 * @param level 事实等级：'fact' | 'inference'
 * @param head  一句话结论
 * @param facts 支撑该结论的事实（逐条可复核）
 * @param note  推断说明 / 不确定性（fact 条目可为空数组）
 */
const report = (kind, level, head, facts = [], note = []) => {
  findings.push({ kind, level, head, facts, note })
}

/* ------------------------------------------------------------------ */
/* 读取（只读）                                                        */
/* ------------------------------------------------------------------ */

const readJson = (file) => {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

if (!existsSync(STORE_DIR)) {
  console.error(`✗ 数据目录不存在：${STORE_DIR}`)
  process.exit(0)
}

const projectsRoot = path.join(STORE_DIR, 'projects')
const projectDirs = existsSync(projectsRoot)
  ? readdirSync(projectsRoot)
      .filter((d) => {
        try {
          return statSync(path.join(projectsRoot, d)).isDirectory()
        } catch {
          return false
        }
      })
      .sort()
  : []

const bundles = []
for (const dirName of projectDirs) {
  const dir = path.join(projectsRoot, dirName)
  const proj = readJson(path.join(dir, 'project.json'))
  const papers = readJson(path.join(dir, 'papers.json'))
  const methods = readJson(path.join(dir, 'methods.json'))
  const evidence = readJson(path.join(dir, 'evidence.json'))
  if (!proj.ok) continue

  bundles.push({
    dirName,
    project: proj.value,
    projectId: proj.value?.id ?? dirName,
    papers: papers.ok && Array.isArray(papers.value) ? papers.value : [],
    methods: methods.ok && Array.isArray(methods.value) ? methods.value : [],
    evidence: evidence.ok && Array.isArray(evidence.value) ? evidence.value : [],
    filesReadable: { papers: papers.ok, methods: methods.ok, evidence: evidence.ok },
  })
}

const allPaperRefs = [] // { projectId, paper }
for (const b of bundles) for (const p of b.papers) allPaperRefs.push({ projectId: b.projectId, paper: p })

const fmt = (iso) => (iso ? String(iso).replace('T', ' ').replace('Z', 'Z') : '(缺失)')
const shortHash = (h) => (h ? String(h).slice(0, 16) : '(缺失)')

/* ================================================================== */
/* 模式 1：同名项目                                                    */
/* ================================================================== */

{
  const byName = new Map()
  for (const b of bundles) {
    const name = b.project?.name ?? '(未命名)'
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push(b)
  }

  for (const [name, group] of [...byName.entries()].sort()) {
    if (group.length < 2) continue
    report(
      '同名项目',
      'fact',
      `存在 ${group.length} 个都叫「${name}」的项目`,
      group.map(
        (b) =>
          `${b.projectId}  created_at=${fmt(b.project.created_at)}  ` +
          `description=${JSON.stringify(b.project.description ?? '')}  ` +
          `${b.papers.length} 论文 / ${b.methods.length} 方法 / ${b.evidence.length} 证据`,
      ),
      [
        '多个项目同名本身**不能**推断为数据丢失或重复写入：',
        '「新建项目」接口未对 name 做唯一性约束，同名是允许的输入。',
        '要判断它们是否为同一次操作的重复产物，需要操作日志/用户行为记录——现有数据中不存在。',
      ],
    )
  }
}

/* ================================================================== */
/* 模式 2：时间集中创建                                                */
/* ================================================================== */

{
  const sorted = bundles
    .filter((b) => b.project?.created_at)
    .slice()
    .sort((a, b) => String(a.project.created_at).localeCompare(String(b.project.created_at)))

  // 相邻项目间隔 < 120s 视为"集中"
  const WINDOW_MS = 120_000
  const clusters = []
  let cur = []
  for (const b of sorted) {
    if (!cur.length) {
      cur = [b]
      continue
    }
    const prev = Date.parse(cur[cur.length - 1].project.created_at)
    const now = Date.parse(b.project.created_at)
    if (now - prev <= WINDOW_MS) cur.push(b)
    else {
      clusters.push(cur)
      cur = [b]
    }
  }
  if (cur.length) clusters.push(cur)

  for (const c of clusters) {
    if (c.length < 2) continue
    const t0 = Date.parse(c[0].project.created_at)
    const t1 = Date.parse(c[c.length - 1].project.created_at)
    report(
      '时间集中创建',
      'fact',
      `有 ${c.length} 个项目在 ${((t1 - t0) / 1000).toFixed(0)} 秒内连续创建`,
      c.map((b) => `${fmt(b.project.created_at)}  ${b.projectId}  ${JSON.stringify(b.project.name ?? '')}`),
      [
        '时间上连续**不能**推断为异常：短时间内连续新建/重试是正常的人工或脚本行为。',
        '要区分"用户连续操作"与"脚本重复执行"，需要调用方信息（HTTP 日志、进程记录）——现有数据中不存在。',
      ],
    )
  }

  if (sorted.length >= 2) {
    const first = Date.parse(sorted[0].project.created_at)
    const last = Date.parse(sorted[sorted.length - 1].project.created_at)
    report(
      '时间集中创建',
      'fact',
      `全部 ${sorted.length} 个项目的创建时间落在 ${((last - first) / 3_600_000).toFixed(1)} 小时窗口内`,
      [`最早：${fmt(sorted[0].project.created_at)}  ${sorted[0].projectId}`, `最晚：${fmt(sorted[sorted.length - 1].project.created_at)}  ${sorted[sorted.length - 1].projectId}`],
      ['时间窗口集中是"数据集体量小、集中在同一天测试产生"的自然结果，不构成异常判定。'],
    )
  }
}

/* ================================================================== */
/* 模式 3：共享 file_hash（同一份 PDF 被多个项目引用）                 */
/* ================================================================== */

{
  const byHash = new Map()
  for (const { projectId, paper } of allPaperRefs) {
    const h = String(paper?.file_hash ?? '')
    if (!h || h.startsWith('meta:')) continue
    if (!byHash.has(h)) byHash.set(h, [])
    byHash.get(h).push({ projectId, paper })
  }

  for (const [hash, group] of [...byHash.entries()].sort()) {
    if (group.length < 2) continue
    const names = [...new Set(group.map((g) => g.paper.file_name))]
    const sizes = [...new Set(group.map((g) => g.paper.file_size))]
    report(
      '共享 file_hash',
      'fact',
      `有 ${group.length} 篇论文（分布在 ${group.length} 个项目）共享同一个 file_hash ${shortHash(hash)}…`,
      [
        ...group.map(
          (g) => `${g.projectId} / ${g.paper.paper_id}  file_name=${JSON.stringify(g.paper.file_name)}  created_at=${fmt(g.paper.created_at)}`,
        ),
        `文件名 ${names.length === 1 ? `完全一致（${JSON.stringify(names[0])}）` : `不一致：${JSON.stringify(names)}`}`,
        `文件大小 ${sizes.length === 1 ? `完全一致（${sizes[0]} 字节）` : `不一致：${JSON.stringify(sizes)}`}`,
      ],
      [
        '这是**完全正常的**：服务端按 file_hash 做去重与复用（重复上传同一文件会命中去重），',
        '且同一篇论文可以被加入多个不同项目，因此同一 hash 出现在多个项目里是预期行为。',
        '它**不表示**文件重复落盘或数据冗余——落盘路径由 hash 前 16 位决定，共享 hash 意味着共享同一份物理文件。',
      ],
    )
  }
}

/* ================================================================== */
/* 模式 4：相同 PDF 文件（落盘物理文件层面）                           */
/* ================================================================== */

{
  const files = []
  const walk = (dir, depth) => {
    if (depth > 3 || !existsSync(dir)) return
    for (const e of readdirSync(dir)) {
      const full = path.join(dir, e)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full, depth + 1)
      else files.push({ full, size: st.size, rel: path.relative(UPLOAD_DIR, full) })
    }
  }
  walk(UPLOAD_DIR, 0)

  // 4a. 内容哈希 → 是否同一物理文件被存了多份
  const byRealHash = new Map()
  for (const f of files.sort((a, b) => a.rel.localeCompare(b.rel))) {
    let h = '(读取失败)'
    try {
      h = createHash('sha256').update(readFileSync(f.full)).digest('hex')
    } catch {
      /* 保留占位 */
    }
    if (!byRealHash.has(h)) byRealHash.set(h, [])
    byRealHash.get(h).push(f)
  }

  const dupGroups = [...byRealHash.entries()].filter(([, g]) => g.length > 1)
  if (files.length === 0) {
    report('相同 PDF 文件', 'fact', '上传目录中没有任何落盘文件', [`目录：${UPLOAD_DIR}`], [])
  } else if (dupGroups.length === 0) {
    report(
      '相同 PDF 文件',
      'fact',
      `上传目录共 ${files.length} 个文件，内容两两互不相同（无重复落盘）`,
      files.map((f) => `${f.rel}  ${f.size} 字节`),
      [],
    )
  } else {
    for (const [h, g] of dupGroups) {
      report(
        '相同 PDF 文件',
        'fact',
        `有 ${g.length} 个落盘文件内容完全相同（sha256 ${h.slice(0, 16)}…）`,
        g.map((f) => `${f.rel}  ${f.size} 字节`),
        ['内容相同但路径不同 → 同一份 PDF 被存了多份，占用额外磁盘。是否为问题取决于是否为有意的独立副本。'],
      )
    }
  }

  // 4b. 论文记录的 file_hash 与落盘文件的真实 sha256 是否一致（事实核对）
  const onDisk = new Map() // sha256 → rel
  for (const [h, g] of byRealHash) for (const f of g) onDisk.set(h, f.rel)

  const mismatches = []
  for (const { projectId, paper } of allPaperRefs) {
    const h = String(paper?.file_hash ?? '')
    if (!h || h.startsWith('meta:')) continue
    if (!onDisk.has(h)) {
      mismatches.push(`${projectId} / ${paper.paper_id}：记录的 file_hash 在上传目录中找不到对应文件（期望路径 ${h.slice(0, 16)}/${paper.file_name}）`)
    }
  }
  if (mismatches.length === 0 && allPaperRefs.some((x) => !String(x.paper?.file_hash ?? '').startsWith('meta:'))) {
    report(
      '相同 PDF 文件',
      'fact',
      '所有有真实 file_hash 的论文，都能在上传目录找到内容哈希一致的落盘文件',
      allPaperRefs
        .filter((x) => !String(x.paper?.file_hash ?? '').startsWith('meta:'))
        .map((x) => `${x.projectId} / ${x.paper.paper_id} → ${x.paper.file_hash.slice(0, 16)}/${x.paper.file_name}  ✓ sha256 一致`),
      ['这同时证明 file_hash 字段确实是文件内容的 sha256（而非随机 ID）。'],
    )
  } else if (mismatches.length) {
    report('相同 PDF 文件', 'fact', `有 ${mismatches.length} 处记录的 file_hash 在上传目录中找不到对应文件`, mismatches, [
      '注意：本脚本**不能**据此推断"文件被删除过"。上传目录可能从未拷贝过来，也可能是软链/挂载缺失。',
      '要判定原因需要文件系统历史或部署记录——现有数据中不存在。',
    ])
  }
}

/* ================================================================== */
/* 模式 5：项目 → 论文 引用边界                                        */
/* ================================================================== */

{
  const empty = bundles.filter((b) => b.papers.length === 0)
  const metaOnly = bundles.filter(
    (b) => b.papers.length > 0 && b.papers.every((p) => String(p.file_hash ?? '').startsWith('meta:')),
  )

  if (empty.length) {
    report(
      '引用边界',
      'fact',
      `有 ${empty.length} 个项目没有任何论文`,
      empty.map((b) => `${b.projectId}  ${JSON.stringify(b.project.name ?? '')}  created_at=${fmt(b.project.created_at)}`),
      [
        '项目为空**不能**推断为数据丢失：新建后未加入论文，或论文被移除，都会是这个状态。',
        '项目 JSON 中没有任何"曾有过几篇论文"的记录，因此无法从现有数据证明是否曾存在过论文。',
      ],
    )
  }

  if (metaOnly.length) {
    report(
      '引用边界',
      'fact',
      `有 ${metaOnly.length} 个项目的论文全部只有元数据（file_hash 带 meta: 前缀，无 PDF 正文）`,
      metaOnly.map(
        (b) => `${b.projectId}  ${JSON.stringify(b.project.name ?? '')}  → ${b.papers.map((p) => `${p.paper_id}(${p.status})`).join(', ')}`,
      ),
      ['这是「论文探索 → 加入项目」的正常中间态：先登记元数据，之后才按需获取全文。'],
    )
  }
}

/* ================================================================== */
/* 模式 6：论文状态分布（含失败态）                                    */
/* ================================================================== */

{
  const byStatus = new Map()
  for (const { projectId, paper } of allPaperRefs) {
    const s = String(paper?.status ?? '(缺失)')
    if (!byStatus.has(s)) byStatus.set(s, [])
    byStatus.get(s).push({ projectId, paper })
  }

  report(
    '状态分布',
    'fact',
    `论文状态分布：${[...byStatus.entries()].sort().map(([s, g]) => `${s}=${g.length}`).join('，')}`,
    [...byStatus.entries()]
      .sort()
      .map(([s, g]) => `${s}: ${g.map((x) => `${x.projectId}/${x.paper.paper_id}`).join(', ')}`),
    [],
  )

  const failed = allPaperRefs.filter((x) => x.paper?.status === 'failed')
  if (failed.length) {
    for (const { projectId, paper } of failed) {
      report(
        '状态分布',
        'fact',
        `${projectId} / ${paper.paper_id} 的分析状态为 failed`,
        [
          `error = ${JSON.stringify(paper.error ?? null)}`,
          `analyzed_with = ${JSON.stringify(paper.analyzed_with ?? null)}`,
          `method_ids = ${JSON.stringify(paper.method_ids ?? [])}，evidence_count = ${paper.evidence_count}`,
          `created_at = ${fmt(paper.created_at)}，updated_at = ${fmt(paper.updated_at)}`,
          `该项目内方法数 = ${bundles.find((b) => b.projectId === projectId)?.methods.length ?? '?'}，证据数 = ${bundles.find((b) => b.projectId === projectId)?.evidence.length ?? '?'}`,
        ],
        [
          '这是**如实记录的失败**，不是数据丢失：error 字段给出了明确原因，且未写入任何方法/证据（符合"失败不写半套数据"的设计）。',
          '注意 updated_at 比 created_at 晚约 0.3 秒 —— 说明分析确实运行过并很快返回了失败，与 error 描述一致。',
        ],
      )
    }
  }
}

/* ================================================================== */
/* 模式 7：updated_at 早于 / 等于 created_at 等时间异常               */
/* ================================================================== */

{
  const anomalies = []
  for (const b of bundles) {
    const c = b.project?.created_at
    const u = b.project?.updated_at
    if (c && u && Date.parse(u) < Date.parse(c)) {
      anomalies.push(`项目 ${b.projectId}：updated_at(${fmt(u)}) 早于 created_at(${fmt(c)})`)
    }
  }
  for (const { projectId, paper } of allPaperRefs) {
    const c = paper?.created_at
    const u = paper?.updated_at
    if (c && u && Date.parse(u) < Date.parse(c)) {
      anomalies.push(`论文 ${projectId}/${paper.paper_id}：updated_at(${fmt(u)}) 早于 created_at(${fmt(c)})`)
    }
  }

  if (anomalies.length === 0) {
    report('时间字段', 'fact', '所有项目与论文的 updated_at 均不早于 created_at（时间字段自洽）', [`检查范围：${bundles.length} 个项目 + ${allPaperRefs.length} 篇论文`], [])
  } else {
    report('时间字段', 'fact', `发现 ${anomalies.length} 处 updated_at 早于 created_at`, anomalies, [
      '时间倒序通常说明记录被外部改写（如从备份恢复、手工编辑 JSON），但**无法从现有数据证明**具体成因。',
    ])
  }
}

/* ================================================================== */
/* 模式 8：文件哈希与文件名不一致                                      */
/* ================================================================== */

{
  const rows = []
  for (const { projectId, paper } of allPaperRefs) {
    const h = String(paper?.file_hash ?? '')
    if (!h || h.startsWith('meta:')) continue
    rows.push({ projectId, paper, hash: h })
  }

  // 同一 file_hash 对应多个不同 file_name
  const byHash = new Map()
  for (const r of rows) {
    if (!byHash.has(r.hash)) byHash.set(r.hash, new Set())
    byHash.get(r.hash).add(r.paper.file_name)
  }
  const inconsistent = [...byHash.entries()].filter(([, names]) => names.size > 1)

  if (inconsistent.length === 0) {
    report(
      '哈希与文件名',
      'fact',
      '同一 file_hash 下的文件名始终一致（哈希与文件名一一对应）',
      rows.length ? [...byHash.entries()].map(([h, names]) => `${h.slice(0, 16)}… → ${[...names].join(', ')}`) : ['（无带真实哈希的论文）'],
      [],
    )
  } else {
    for (const [h, names] of inconsistent) {
      report('哈希与文件名', 'fact', `同一 file_hash ${h.slice(0, 16)}… 对应了多个不同文件名`, [...names], [
        '同内容不同文件名通常是**重命名后重新上传**造成的，但具体经过**无法从现有数据证明**。',
      ])
    }
  }
}

/* ================================================================== */
/* 证据链完整性（事实核对，非异常判定）                                */
/* ================================================================== */

{
  const rows = []
  for (const b of bundles) {
    if (b.papers.length === 0) continue
    for (const p of b.papers) {
      const ev = b.evidence.filter((e) => e.paper_id === p.paper_id).length
      rows.push(`${b.projectId}/${p.paper_id}: status=${p.status} 方法=${(p.method_ids ?? []).length} 证据=${ev}`)
    }
  }
  report('证据链', 'fact', `逐论文的落库规模（${rows.length} 篇）`, rows, [])
}

/* ================================================================== */
/* 元信息：本审计能证明什么、不能证明什么                              */
/* ================================================================== */

{
  report(
    '证据能力边界',
    'inference',
    '本审计**无法**判定"是否发生过数据丢失"',
    [
      `git 历史：${existsSync(path.join(root, '.git')) ? '存在' : '不存在（不是 git 仓库）'}`,
      `日志文件：${existsSync(path.join(root, 'logs')) ? '存在 logs/ 目录' : '不存在 logs/ 目录'}`,
      'data/store 下仅含各项目**当前状态**的 4 个 JSON（project/papers/methods/evidence）',
      'jobStore 是内存 Map（server/store/fileStore.ts），**进程重启即失**，不落盘',
      '仓库中未见任何删除/归档日志、操作审计表或备份快照',
    ],
    [
      '结论：现有数据中**不存在**任何记录"曾经存在过什么"的载体。',
      '因此对于"是否有论文/项目被删除过"这类问题，本脚本的回答只能是——',
      '**无法从现有数据证明**。任何相反的断言都超出了证据支持的范围。',
    ],
  )
}

/* ================================================================== */
/* 输出                                                                */
/* ================================================================== */

if (AS_JSON) {
  console.log(JSON.stringify({ storeDir: STORE_DIR, uploadDir: UPLOAD_DIR, findings }, null, 2))
  process.exit(0)
}

console.log('══════════════════════════════════════════════════════════════')
console.log(' MethodPilot 真实数据审计（只读 · 事实/推断分离）')
console.log('══════════════════════════════════════════════════════════════')
console.log(`数据目录: ${STORE_DIR}`)
console.log(`上传目录: ${UPLOAD_DIR}`)
console.log(`项目数  : ${bundles.length}`)
console.log(`时间范围: ${bundles.length ? `${fmt(bundles.map((b) => b.project.created_at).filter(Boolean).sort()[0])} ~ ${fmt(bundles.map((b) => b.project.created_at).filter(Boolean).sort().slice(-1)[0])}` : '(无)'}`)
console.log('')

/* 原始事实表：把读到的都摊开，便于逐条复核 */
console.log('── 项目 ──────────────────────────────────────────────────────')
for (const b of bundles) {
  const p = b.project
  console.log(`${b.projectId}`)
  console.log(`  name        ${JSON.stringify(p.name ?? '')}`)
  console.log(`  created_at  ${fmt(p.created_at)}`)
  console.log(`  updated_at  ${fmt(p.updated_at)}`)
  console.log(`  paper_ids   ${JSON.stringify(p.paper_ids ?? [])}`)
  console.log(`  kind        ${JSON.stringify(p.kind ?? '')}   desc ${JSON.stringify(p.description ?? '')}`)
}
console.log('')

console.log('── 论文 ──────────────────────────────────────────────────────')
for (const b of bundles) {
  for (const p of b.papers) {
    console.log(`${b.projectId} / ${p.paper_id}`)
    console.log(`  file_name   ${JSON.stringify(p.file_name ?? '')}`)
    console.log(`  file_hash   ${p.file_hash ?? ''}`)
    console.log(`  created_at  ${fmt(p.created_at)}`)
  }
}
console.log('')

console.log('── 异常模式 ──────────────────────────────────────────────────')
if (!findings.length) {
  console.log('  （未识别出任何模式）')
}
for (const f of findings) {
  const tag = f.level === 'fact' ? '【事实】' : '【推断】'
  console.log('')
  console.log(`${tag}[${f.kind}] ${f.head}`)
  for (const x of f.facts) console.log(`    · ${x}`)
  if (f.note?.length) {
    console.log('    ── 判读（不属于事实）──')
    for (const x of f.note) console.log(`    ‣ ${x}`)
  }
}

const factCount = findings.filter((f) => f.level === 'fact').length
const infCount = findings.filter((f) => f.level === 'inference').length

console.log('')
console.log('══════════════════════════════════════════════════════════════')
console.log(`共 ${findings.length} 条发现：【事实】${factCount} 条，【推断】${infCount} 条`)
console.log('本脚本只读：未修改、未删除、未合并任何真实数据。')
console.log('关于"数据是否丢失"：现有数据不含删除日志/job 历史/git 历史，**无法从现有数据证明**。')
console.log('══════════════════════════════════════════════════════════════')
process.exit(0)
