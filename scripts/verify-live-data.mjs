/**
 * 真实数据一致性校验（data/store —— 用户真实跑出来的项目数据）
 *
 * 与 `scripts/verify-data.mjs` 的分工：
 *   - `verify-data.mjs`      校 `src/data/*.ts`，那是**内置 Demo 数据**，随代码走；
 *   - `verify-live-data.mjs` 校 `data/store/`，那是**运行时真实数据**，随用户走。
 *   两者互不干扰，各自独立跑。**本脚本只读，绝不写入/修改任何真实数据。**
 *
 * 为什么需要它：
 *   真实数据是"AI 抽取 + 用户操作"共同产生的，不像 Demo 数据那样被人手校对过。
 *   一旦出现孤儿 ID（指向已删论文的方法）或跨项目串号（A 项目的证据挂到 B 项目），
 *   前端不会报错，只会**静默地少显示一条 / 显示错一条**——正是这个项目最贵的那类 bug。
 *   所以这里把每个引用都解析一遍，宁可吵。
 *
 * 校验项：
 *   1. 目录/文件结构完整（project/papers/methods/evidence 四个 JSON 都要在且能解析）
 *   2. 项目内 ID 唯一（论文 / 方法 / 证据各自不许重复）
 *   3. 所有跨表引用闭合（paper_id / method_id / evidence_id / family_id）
 *   4. 反向一致性（method.evidence_ids ↔ evidence.method_ids 双向对得上）
 *   5. 跨项目引用检测（某实体引用了**别的项目**的 ID → 串号）
 *   6. 项目 → 论文列表闭合（project.paper_ids ↔ papers.json）
 *   7. 落盘 PDF 一致性（有真实 file_hash 的论文，其上是否存在对应文件）
 *
 * 运行：node scripts/verify-live-data.mjs
 *      node scripts/verify-live-data.mjs --data-dir /path/to/store
 *
 * 退出码：有异常 → 1；干净 → 0。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/* ------------------------------------------------------------------ */
/* 参数与路径                                                          */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2)
const dataDirFlag = argv.indexOf('--data-dir')
const STORE_DIR =
  dataDirFlag !== -1 && argv[dataDirFlag + 1]
    ? path.resolve(argv[dataDirFlag + 1])
    : path.join(root, 'data', 'store')

/** 上传目录：默认与 DATA_DIR 平级（server/config.ts 的默认布局） */
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(root, 'data', 'uploads')

/** 方法族 ID 白名单——与 server/services/ai/taxonomy.ts 的 FAMILY_SPECS 同源 */
const FAMILY_IDS = new Set(['F1', 'F2', 'F3', 'F4', 'F5'])

/* ------------------------------------------------------------------ */
/* 断言收集器                                                          */
/* ------------------------------------------------------------------ */

const problems = []
const addProblem = (kind, msg) => problems.push({ kind, msg })

/** 结构性错误（文件缺失/JSON 坏）——会让后续校验失去意义 */
const fatal = []

/* ------------------------------------------------------------------ */
/* 读取（全程只读）                                                    */
/* ------------------------------------------------------------------ */

const readJson = (file) => {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

if (!existsSync(STORE_DIR)) {
  console.error(`✗ 真实数据目录不存在：${STORE_DIR}`)
  console.error('  （真实数据随用户走，若本机还没跑过项目，这个目录是空的属于正常）')
  process.exit(1)
}

const projectsRoot = path.join(STORE_DIR, 'projects')
if (!existsSync(projectsRoot)) {
  console.error(`✗ 找不到 ${projectsRoot} —— 这不像是 data/store 的目录布局`)
  process.exit(1)
}

const projectDirs = readdirSync(projectsRoot)
  .filter((d) => {
    try {
      return statSync(path.join(projectsRoot, d)).isDirectory()
    } catch {
      return false
    }
  })
  .sort()

/* ------------------------------------------------------------------ */
/* 装载：把每个项目读成一个 bundle                                     */
/* ------------------------------------------------------------------ */

const bundles = []

for (const dirName of projectDirs) {
  const dir = path.join(projectsRoot, dirName)

  const proj = readJson(path.join(dir, 'project.json'))
  const papers = readJson(path.join(dir, 'papers.json'))
  const methods = readJson(path.join(dir, 'methods.json'))
  const evidence = readJson(path.join(dir, 'evidence.json'))

  const missing = []
  if (!proj.ok) missing.push(`project.json（${proj.error}）`)
  if (!papers.ok) missing.push(`papers.json（${papers.error}）`)
  if (!methods.ok) missing.push(`methods.json（${methods.error}）`)
  if (!evidence.ok) missing.push(`evidence.json（${evidence.error}）`)

  if (missing.length) {
    fatal.push(`项目目录 ${dirName} 读取失败: ${missing.join('; ')}`)
    continue
  }

  // 目录名与 project.id 应一致，否则说明有人手工搬过目录
  if (proj.value?.id && proj.value.id !== dirName) {
    addProblem('结构', `目录名 ${dirName} 与 project.json 的 id「${proj.value.id}」不一致`)
  }

  bundles.push({
    dirName,
    project: proj.value,
    projectId: proj.value?.id ?? dirName,
    papers: Array.isArray(papers.value) ? papers.value : [],
    methods: Array.isArray(methods.value) ? methods.value : [],
    evidence: Array.isArray(evidence.value) ? evidence.value : [],
  })
}

/* ------------------------------------------------------------------ */
/* 全局池：ID → 所属项目（用于跨项目引用检测）                         */
/* ------------------------------------------------------------------ */

/*
 * ⚠️ ID 作用域：`P001` / `M001` / `E001` 是**项目内唯一**，不是全局唯一。
 * 证据：服务端 `store.nextId(prefix, existing)` 只扫**本项目**已有的同类 ID，
 * 所以 8 个真实项目里每一个都是 paper_id=P001、method_id=M001、evidence_id=E001。
 * 因此这里按「projectId::id」做键，否则会把正常数据全报成重复。
 * 真正要查的重复，是**同一个项目内部**同一个 ID 出现两次。
 */
const refKey = (projectId, id) => `${projectId}::${id}`

const paperOwner = new Map() // projectId::paper_id  → projectId
const methodOwner = new Map() // projectId::method_id → projectId
const evidenceOwner = new Map() // projectId::evidence_id → projectId

/** ID 是否在**同一项目内**重复（跨项目同名是正常的，不算问题） */
const dupReport = (kindLabel, id, owner, projectId) => {
  const key = refKey(projectId, id)
  if (owner.has(key)) {
    addProblem('重复 ID', `${projectId} 内${kindLabel}的 ID「${id}」重复出现（同一项目内 ID 必须唯一）`)
  } else {
    owner.set(key, projectId)
  }
}

for (const b of bundles) {
  for (const p of b.papers) {
    if (p?.paper_id) dupReport('论文', p.paper_id, paperOwner, b.projectId)
  }
  for (const m of b.methods) {
    if (m?.method_id) dupReport('方法', m.method_id, methodOwner, b.projectId)
  }
  for (const e of b.evidence) {
    if (e?.evidence_id) dupReport('证据', e.evidence_id, evidenceOwner, b.projectId)
  }
}

/* ------------------------------------------------------------------ */
/* 引用解析：本项目的 ID 池 + 跨项目检测                               */
/* ------------------------------------------------------------------ */

/**
 * 解析一个引用。**引用只在项目内解析**——ID 是项目内作用域的。
 * @param label  报错时用的主语，如「方法 M001」
 * @param id     被引用的 ID
 * @param kind   引用类型名，如「论文」
 * @param pool   本项目该类型的 ID 集合
 * @param owner  全局 projectId::id → projectId 映射（用于区分"孤儿"与"串号"）
 */
const resolveRef = (label, id, kind, pool, owner, projectId) => {
  if (id === undefined || id === null || id === '') return
  if (pool.has(id)) return

  // 本项目没有 → 看看是不是**别的项目**里有同名 ID。
  // 有同名不代表合法（ID 不跨项目生效），但说明调用方很可能混用了两个项目的数据，
  // 这个区分对排查很有价值，所以单独报一类。
  const ownerProject = owner.get(refKey(projectId, id))
  if (ownerProject === undefined) {
    const stolenFrom = [...owner.keys()].filter((k) => k.endsWith(`::${id}`)).map((k) => k.split('::')[0])
    if (stolenFrom.length) {
      addProblem(
        '跨项目引用',
        `${label} 引用了${kind}「${id}」，但本项目没有它；同名 ID 存在于项目 ${stolenFrom.join(', ')}`,
      )
      return
    }
  }
  addProblem('孤儿 ID', `${label} 引用了不存在的${kind}：${id}`)
}

/* ------------------------------------------------------------------ */
/* 逐项目校验                                                          */
/* ------------------------------------------------------------------ */

for (const b of bundles) {
  const { projectId, papers, methods, evidence } = b

  const paperIds = new Set(papers.map((p) => p.paper_id))
  const methodIds = new Set(methods.map((m) => m.method_id))
  const evidenceIds = new Set(evidence.map((e) => e.evidence_id))

  /* --- 论文：project_id 自洽 + 方法反向引用 --- */
  for (const p of papers) {
    if (p.project_id && p.project_id !== projectId) {
      addProblem('跨项目引用', `论文 ${p.paper_id} 的 project_id 是 ${p.project_id}，但它在 ${projectId} 目录下`)
    }
    for (const mid of p.method_ids ?? []) {
      resolveRef(`论文 ${p.paper_id}`, mid, '方法', methodIds, methodOwner, projectId)
    }
    // evidence_count 是冗余字段，必须与实际条数对得上，否则界面会谎报
    const realEvidence = evidence.filter((e) => e.paper_id === p.paper_id).length
    if (typeof p.evidence_count === 'number' && p.evidence_count !== realEvidence) {
      addProblem(
        '计数不一致',
        `论文 ${p.paper_id} 的 evidence_count=${p.evidence_count}，但实际有 ${realEvidence} 条证据`,
      )
    }
  }

  /* --- 方法：paper_ids / evidence_ids / family_id --- */
  for (const m of methods) {
    if (m.project_id && m.project_id !== projectId) {
      addProblem('跨项目引用', `方法 ${m.method_id} 的 project_id 是 ${m.project_id}，但它在 ${projectId} 目录下`)
    }
    for (const pid of m.paper_ids ?? []) {
      resolveRef(`方法 ${m.method_id}`, pid, '论文', paperIds, paperOwner, projectId)
    }
    for (const eid of m.evidence_ids ?? []) {
      resolveRef(`方法 ${m.method_id}`, eid, '证据', evidenceIds, evidenceOwner, projectId)
    }
    if (m.family_id && !FAMILY_IDS.has(m.family_id)) {
      addProblem('非法取值', `方法 ${m.method_id} 的 family_id「${m.family_id}」不在 F1–F5 之内`)
    }
  }

  /* --- 证据：paper_id / method_ids --- */
  for (const e of evidence) {
    if (e.project_id && e.project_id !== projectId) {
      addProblem('跨项目引用', `证据 ${e.evidence_id} 的 project_id 是 ${e.project_id}，但它在 ${projectId} 目录下`)
    }
    resolveRef(`证据 ${e.evidence_id}`, e.paper_id, '论文', paperIds, paperOwner, projectId)
    for (const mid of e.method_ids ?? []) {
      resolveRef(`证据 ${e.evidence_id}`, mid, '方法', methodIds, methodOwner, projectId)
    }
    // gap_ids / direction_ids 在真实数据里应恒为空（空白/方向是 Demo 层概念）
    for (const gid of e.gap_ids ?? []) {
      addProblem('孤儿 ID', `证据 ${e.evidence_id} 引用了研究空白 ${gid} —— 真实数据层不应出现 gap 引用`)
    }
    for (const did of e.direction_ids ?? []) {
      addProblem('孤儿 ID', `证据 ${e.evidence_id} 引用了研究方向 ${did} —— 真实数据层不应出现 direction 引用`)
    }
    if (typeof e.confidence === 'number' && (e.confidence <= 0 || e.confidence > 1)) {
      addProblem('非法取值', `证据 ${e.evidence_id} 的 confidence=${e.confidence} 越界（应 0<x≤1）`)
    }
  }

  /* --- 反向一致性：method.evidence_ids ↔ evidence.method_ids --- */
  for (const m of methods) {
    const fwd = new Set(m.evidence_ids ?? [])
    const back = new Set(evidence.filter((e) => (e.method_ids ?? []).includes(m.method_id)).map((e) => e.evidence_id))
    for (const eid of fwd) {
      if (!back.has(eid) && evidenceIds.has(eid)) {
        addProblem('方向不一致', `方法 ${m.method_id} 声称有证据 ${eid}，但该证据的 method_ids 里没有 ${m.method_id}`)
      }
    }
    for (const eid of back) {
      if (!fwd.has(eid)) {
        addProblem('方向不一致', `证据 ${eid} 指向方法 ${m.method_id}，但该方法的 evidence_ids 里没有它`)
      }
    }
  }

  /* --- 项目 → 论文列表闭合 --- */
  const listed = b.project?.paper_ids
  if (Array.isArray(listed)) {
    const listedSet = new Set(listed)
    for (const pid of listedSet) {
      if (!paperIds.has(pid)) {
        addProblem('孤儿 ID', `项目 ${projectId} 的 paper_ids 里有 ${pid}，但 papers.json 中不存在这篇论文`)
      }
    }
    for (const pid of paperIds) {
      if (!listedSet.has(pid)) {
        addProblem('方向不一致', `论文 ${pid} 存在于 papers.json，但未被项目 ${projectId} 的 paper_ids 收录`)
      }
    }
  }

  /* --- 落盘 PDF 一致性（只看有真实 file_hash 的论文） --- */
  for (const p of papers) {
    const hash = String(p.file_hash ?? '')
    if (!hash || hash.startsWith('meta:')) continue // 只有元数据，本就没有文件
    const expected = path.join(UPLOAD_DIR, hash.slice(0, 16), p.file_name)
    if (!existsSync(expected)) {
      addProblem(
        '文件缺失',
        `论文 ${p.paper_id}（${p.file_name}）有真实 file_hash，但落盘文件不存在：${expected}`,
      )
    }
  }
}

/* ------------------------------------------------------------------ */
/* 统计与输出                                                          */
/* ------------------------------------------------------------------ */

const totalPapers = bundles.reduce((n, b) => n + b.papers.length, 0)
const totalMethods = bundles.reduce((n, b) => n + b.methods.length, 0)
const totalEvidence = bundles.reduce((n, b) => n + b.evidence.length, 0)

const byKind = problems.reduce((acc, p) => {
  acc[p.kind] = (acc[p.kind] ?? 0) + 1
  return acc
}, {})

console.log('— 真实数据校验（data/store） —')
console.log(`数据目录: ${STORE_DIR}`)
console.log(`上传目录: ${UPLOAD_DIR}`)
console.log('')

console.log('— 数据规模 —')
console.log(
  [`${bundles.length} 项目`, `${totalPapers} 论文`, `${totalMethods} 方法`, `${totalEvidence} 证据`].join(' / '),
)
for (const b of bundles) {
  console.log(
    `  · ${b.projectId}  ${String(b.project?.name ?? '(未命名)').padEnd(18)} ` +
      `${b.papers.length} 论文 / ${b.methods.length} 方法 / ${b.evidence.length} 证据`,
  )
}

if (fatal.length) {
  console.log('')
  console.log(`✗ 结构性错误 ${fatal.length} 处（后续校验对这些项目不完整）:`)
  for (const f of fatal) console.log('  · ' + f)
}

console.log('')
console.log(`— 异常 ${problems.length} 处 —`)
if (problems.length) {
  for (const [kind, n] of Object.entries(byKind)) {
    console.log(`  ${kind}: ${n}`)
  }
  console.log('')
  for (const p of problems) {
    console.log(`  ✗ [${p.kind}] ${p.msg}`)
  }
} else {
  console.log('  无')
}

console.log('')
console.log(
  `统计：项目数 ${bundles.length}，论文数 ${totalPapers}，方法数 ${totalMethods}，` +
    `证据数 ${totalEvidence}，异常数 ${problems.length + fatal.length}`,
)

if (problems.length || fatal.length) {
  console.log('\n✗ 真实数据存在引用问题（本脚本只报不改，未修改任何数据）')
  process.exit(1)
}
console.log('\n✓ 真实数据引用全部闭合，未发现孤儿 ID / 重复 ID / 跨项目引用')
