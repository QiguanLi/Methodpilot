/**
 * 最小持久化层（JSON 落盘）
 *
 * 为什么不上数据库：
 *   本阶段的目标是让"上传 → 解析 → 抽取 → 证据链"这条链真正跑通并可信。
 *   引入 Postgres/SQLite 只会增加部署与演示的失败面，而数据量（几十篇论文）
 *   用文件完全够。接口按 repository 形态设计，将来换数据库只需替换本文件。
 *
 * 关键设计：
 *   - 每个 Project 一个目录，项目之间物理隔离，
 *     这样"用户上传的论文"不可能污染 "Demo 项目"。
 *   - 写入用「临时文件 + rename」，保证不会读到写一半的 JSON。
 *   - 内存缓存带失效时间，避免每次请求都读盘。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.ts'
import type { StoredEvidence, StoredMethod, StoredPaper } from '../types.ts'

export interface ProjectRecord {
  id: string
  name: string
  subtitle: string
  description: string
  domain: string
  goal: string
  /** demo = 内置演示项目；uploaded = 用户自己建的 */
  kind: 'demo' | 'uploaded'
  created_at: string
  updated_at: string
  paper_ids: string[]
}

export interface ProjectBundle {
  project: ProjectRecord
  papers: StoredPaper[]
  methods: StoredMethod[]
  evidence: StoredEvidence[]
}

/* ------------------------------------------------------------------ */

const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_')

function projectDir(projectId: string) {
  return path.join(config.storage.dir, 'projects', safeId(projectId))
}

function paths(projectId: string) {
  const dir = projectDir(projectId)
  return {
    dir,
    project: path.join(dir, 'project.json'),
    papers: path.join(dir, 'papers.json'),
    methods: path.join(dir, 'methods.json'),
    evidence: path.join(dir, 'evidence.json'),
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/**
 * 每个目标文件的"写入队列尾"。
 *
 * ── 为什么必须有这个 Map ──
 *
 * 原先的写法是「先写唯一临时文件、再 rename」，看似已经原子了，
 * 但它只保证**读方**看不到半截文件，不保证**写方之间**不互相踩：
 *
 *     writeJson(A, x)  ──┐  两者都在同一次 tick 里发起
 *     writeJson(A, y)  ──┘
 *
 * 两次写会各自 writeFile 到**同一个**临时路径、再各自 rename 到目标路径 A，
 * 于是 A 的内容取决于两个 rename 的完成顺序 —— 也就是"最后写的不一定赢"。
 *
 * 更糟的是临时文件名原先只带 `process.pid`（`${file}.${pid}.tmp`）。
 * 同一进程内两个并发写会用**同一个临时路径**：一个刚写完、
 * 另一个覆盖它，然后两个 rename 交替 —— 实测会出现两份 JSON
 * 字节互相穿插的坏文件（本次 Phase 6-2 就复现了
 * `papers.json` 里出现 `]okens": 0,` 这种半个字段开头的残片）。
 *
 * 所以本 Map 做两件事：
 *   1. 把**同一个文件**的写入串成一条链（后一次等前一次彻底结束）。
 *   2. 临时文件名再加一串唯一后缀，彻底消除 tmp 撞名。
 *
 * ⚠️ 它只按**文件路径**串行，**不**保证跨文件一致。
 * 这正是 Phase 6-2 残留 P002→M002 悬空引用的根因（见下方 commitChains）。
 */
const writeChains = new Map<string, Promise<void>>()

/** 单调递增序号，与 pid 一起保证同一进程内每次写入的 tmp 名唯一 */
let writeSeq = 0

/** 原子写：唯一临时文件 + 按文件串行化，避免并发写互相覆盖或写坏 */
function writeJson(file: string, data: unknown): Promise<void> {
  /*
   * 序列化：把本次写接在上一次（同文件）写之后。
   * prev 若是失败的 Promise，catch 掉以免污染后续写入的链
   * —— 一次写失败不该让这个文件之后**永远**写不进去。
   */
  const prev = writeChains.get(file) ?? Promise.resolve()
  const run = prev
    .catch(() => {})
    .then(async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      /*
       * 唯一临时文件名：pid + 自增序号 + 随机串。
       * 三者叠加后，即使同一进程内有并发写（理论上已被上面的链挡住，
       * 但别处直接调用时仍需自保），也不可能落到同一个 tmp 路径。
       */
      const tmp = `${file}.${process.pid}.${++writeSeq}.${Math.random().toString(36).slice(2, 10)}.tmp`
      try {
        await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
        await fsp.rename(tmp, file)
      } catch (e) {
        // 写失败时清掉遗留的 tmp，别在磁盘上堆垃圾
        await fsp.rm(tmp, { force: true }).catch(() => {})
        throw e
      }
    })

  writeChains.set(file, run)
  /*
   * 链尾用完即删（仅当自己仍是链尾时），防止 Map 随文件数无限增长。
   * 比较 identity 是必须的：若期间又有新写接了进来，新链尾不是本 run，
   * 这时删掉会把还没执行的链尾从 Map 里弄丢，后续写入就会与它并发。
   */
  run
    .catch(() => {})
    .finally(() => {
      if (writeChains.get(file) === run) writeChains.delete(file)
    })

  return run
}

/* ------------------------------------------------------------------ */
/* 项目级提交互斥 + 读屏障                                              */
/* ------------------------------------------------------------------ */

/**
 * 每个 project 的读/写屏障（小型的 reader-writer lock）。
 *
 * ── 为什么"等到没有 commit 再读"还不够 ──
 *
 * 最初的做法是 `await waitForCommit(projectId)` 之后就开始逐个 `readJson`。
 * 这只在**进入时**检查一次屏障，而 `getBundle` 要串行读四个文件、每个都是
 * 一次真实的 await。于是存在这样一条路径：
 *
 *     getBundle: 进入时无 commit → 读 papers.json ✓
 *     commit:    ──────────────────── 在这里抢到锁，开始写四个文件
 *     getBundle:                      → 读 methods.json ✗（已经是新版本）
 *
 * 实测（60 轮、119 次读）直接抓到三文件来自三个不同来源：
 * `papers=EMPTY / methods=A001 / evidence=B001`。
 *
 * ── 正确做法：把整次读放进临界区 ──
 *
 * 用一把 project 级的 reader-writer lock：
 *   · 多个读可以并发（不同请求读同一项目互不影响）
 *   · 写（commit）必须独占（读期间不能写，写期间不能读）
 *   · 写优先：等待中的写会阻止新的读插队，避免写饿死
 *
 * 锁粒度仍是 project，不同项目完全并行。
 */
interface RwLock {
  /** 当前活跃读者数 */
  readers: number
  /** 是否有写者持有锁 */
  writing: boolean
  /** 排队中的写者数（>0 时新读者需等待，保证写优先） */
  pendingWriters: number
  /** 读者全部退出后要唤醒的写者 */
  writeWaiters: Array<() => void>
  /** 写者释放后要唤醒的读者 */
  readWaiters: Array<() => void>
}

const rwLocks = new Map<string, RwLock>()

function lockFor(projectId: string): RwLock {
  let l = rwLocks.get(projectId)
  if (!l) {
    l = { readers: 0, writing: false, pendingWriters: 0, writeWaiters: [], readWaiters: [] }
    rwLocks.set(projectId, l)
  }
  return l
}

/** 释放空闲的锁对象，避免 Map 随项目数无限增长（仅在完全无人持有时） */
function gcLock(projectId: string, l: RwLock) {
  if (l.readers === 0 && !l.writing && l.pendingWriters === 0) {
    if (rwLocks.get(projectId) === l) rwLocks.delete(projectId)
  }
}

/** 进入读临界区：等写者退出，且不允许在写者排队时插队 */
async function acquireRead(projectId: string): Promise<void> {
  const l = lockFor(projectId)
  while (l.writing || l.pendingWriters > 0) {
    await new Promise<void>((resolve) => l.readWaiters.push(resolve))
  }
  l.readers++
}

/** 退出读临界区 */
function releaseRead(projectId: string): void {
  const l = lockFor(projectId)
  l.readers--
  if (l.readers === 0 && l.writeWaiters.length) {
    const w = l.writeWaiters.shift()
    if (w) w()
  }
  gcLock(projectId, l)
}

/** 进入写临界区（独占） */
async function acquireWrite(projectId: string): Promise<void> {
  const l = lockFor(projectId)
  l.pendingWriters++
  while (l.writing || l.readers > 0) {
    await new Promise<void>((resolve) => l.writeWaiters.push(resolve))
  }
  l.pendingWriters--
  l.writing = true
}

/** 退出写临界区，唤醒所有等待的读者与一个写者 */
function releaseWrite(projectId: string): void {
  const l = lockFor(projectId)
  l.writing = false
  // 唤醒全部读者（它们可并发读）
  const readers = l.readWaiters.splice(0)
  for (const r of readers) r()
  // 若有写者在排队，它会在 acquireWrite 的循环里重新判断 readers 是否退完
  if (l.writeWaiters.length) {
    const w = l.writeWaiters.shift()
    if (w) w()
  }
  gcLock(projectId, l)
}

/** 在项目级读临界区内执行 fn（fn 内部的多次读盘不会被 commit 打断） */
async function withReadBarrier<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  await acquireRead(projectId)
  try {
    return await fn()
  } finally {
    releaseRead(projectId)
  }
}

/**
 * 直读四个文件组装 bundle，**不加任何锁**。
 *
 * 调用方必须已经持有该项目的读锁或写锁，否则会读到跨文件撕裂的快照。
 * 抽出来是为了让 getBundle（读锁内）和 updateBundle（写锁内）共用同一段读取逻辑，
 * 避免两处实现漂移。
 */
async function readBundleUnlocked(projectId: string): Promise<ProjectBundle | null> {
  const p = paths(projectId)
  const project = await readJson<ProjectRecord | null>(p.project, null)
  if (!project) return null
  return {
    project,
    papers: await readJson<StoredPaper[]>(p.papers, []),
    methods: await readJson<StoredMethod[]>(p.methods, []),
    evidence: await readJson<StoredEvidence[]>(p.evidence, []),
  }
}


/* ------------------------------------------------------------------ */
/* 缓存                                                                */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  bundle: ProjectBundle
  at: number
}
const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 1500

function invalidate(projectId: string) {
  cache.delete(projectId)
}

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

export const store = {
  async ensureReady(): Promise<void> {
    await fsp.mkdir(path.join(config.storage.dir, 'projects'), { recursive: true })
    await fsp.mkdir(config.storage.uploadDir, { recursive: true })
  },

  async listProjects(): Promise<ProjectRecord[]> {
    const base = path.join(config.storage.dir, 'projects')
    let dirs: string[] = []
    try {
      dirs = await fsp.readdir(base)
    } catch {
      return []
    }
    const out: ProjectRecord[] = []
    for (const d of dirs) {
      const p = await readJson<ProjectRecord | null>(path.join(base, d, 'project.json'), null)
      if (p) out.push(p)
    }
    return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  },

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    return readJson<ProjectRecord | null>(paths(projectId).project, null)
  },

  async getBundle(projectId: string): Promise<ProjectBundle | null> {
    /*
     * 整次读取（含四个文件的逐个 readJson）都在项目级**读**临界区内完成。
     * 只在进入时 await 一次是不够的 —— 四个 readJson 之间会被 commit 插空，
     * 实测（60 轮 / 119 次读）抓到 papers/methods/evidence 来自三个不同来源。
     */
    return withReadBarrier(projectId, async () => {
      const hit = cache.get(projectId)
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        // 返回深拷贝：调用方改了返回对象也不能污染缓存
        return structuredClone(hit.bundle)
      }

      const bundle = await readBundleUnlocked(projectId)
      if (!bundle) return null
      cache.set(projectId, { bundle, at: Date.now() })
      return structuredClone(bundle)
    })
  },

  async createProject(rec: ProjectRecord): Promise<ProjectRecord> {
    const p = paths(rec.id)
    // 建项目同样是"四个文件一次落地"，必须持写锁，否则读方可能看到
    // project.json 已存在但 papers.json 还是空的半成品快照。
    await acquireWrite(rec.id)
    try {
      await fsp.mkdir(p.dir, { recursive: true })
      await writeJson(p.project, rec)
      await writeJson(p.papers, [])
      await writeJson(p.methods, [])
      await writeJson(p.evidence, [])
      invalidate(rec.id)
    } finally {
      releaseWrite(rec.id)
    }
    return rec
  },

  async saveProject(projectId: string, rec: ProjectRecord): Promise<void> {
    await writeJson(paths(projectId).project, rec)
    invalidate(projectId)
  },

  async savePapers(projectId: string, papers: StoredPaper[]): Promise<void> {
    await writeJson(paths(projectId).papers, papers)
    invalidate(projectId)
  },

  async saveMethods(projectId: string, methods: StoredMethod[]): Promise<void> {
    await writeJson(paths(projectId).methods, methods)
    invalidate(projectId)
  },

  async saveEvidence(projectId: string, evidence: StoredEvidence[]): Promise<void> {
    await writeJson(paths(projectId).evidence, evidence)
    invalidate(projectId)
  },

  /**
   * 一次性写三类实体，避免前端读到"论文有了但方法还没写进去"的中间态。
   *
   * 整个提交（写四个文件）持有项目级**写**锁（独占）：
   *   · 同一 project 的两次 commit 不会跨文件交错
   *   · 提交期间 getBundle 无法进入（读锁被写者挡在门外）
   * 读方要么看到完整的新快照，要么看到完整的旧快照，不存在中间态。
   * 锁粒度是 project，不同项目之间仍可并发提交。
   *
   * 注意字段守卫必须用 `!== undefined` 而不是真值判断：
   * `patch.papers = []` 是**合法**的"清空"语义，用 `if (patch.papers)`
   * 会把它当成"未提供"直接跳过，导致 papers.json 保留上一版内容
   * 而 methods/evidence 已更新 —— 正是我们要消灭的跨文件撕裂。
   */
  async commit(projectId: string, patch: Partial<ProjectBundle>): Promise<void> {
    await acquireWrite(projectId)
    try {
      const p = paths(projectId)
      const jobs: Promise<void>[] = []
      if (patch.project !== undefined) jobs.push(writeJson(p.project, patch.project))
      if (patch.papers !== undefined) jobs.push(writeJson(p.papers, patch.papers))
      if (patch.methods !== undefined) jobs.push(writeJson(p.methods, patch.methods))
      if (patch.evidence !== undefined) jobs.push(writeJson(p.evidence, patch.evidence))
      await Promise.all(jobs)
      // 落盘完成后才失效缓存：提交窗口内不会有新快照被缓存住
      invalidate(projectId)
    } finally {
      releaseWrite(projectId)
    }
  },

  /**
   * 项目级**原子读-改-写**：在同一个写锁临界区内完成
   * 「读最新四文件 → 执行 fn → 写回」，中间不可能被并发 job 插入。
   *
   * ── 为什么需要它（Phase 6-2 收尾）──
   *
   * 原先 analysis.commitResults 是两步：
   *
   *     const final = await store.getBundle(id)   // ① 读快照
   *     await store.commit(id, {
   *       papers: replacePaper(final.papers, updatedPaper),  // 用 ① 的陈旧数据
   *       ...
   *     })                                        // ② 稍后才拿写锁
   *
   * ① 和 ② 各自都是锁保护的，但**这一对**不是原子的。两个并发 analyze job 的
   * 交错是：
   *
   *     A: getBundle ─→ 看到 P001 还是 parsed
   *     B: getBundle → commit（P001 已 completed）
   *     A:                commit（用陈旧 papers 覆盖回去 → P001 退回 parsed）← lost update
   *
   * 实测复现（24 轮里 4 轮）：`P001 status=parsed method_ids=[]`，
   * 但 `M001.paper_ids=["P001"]` 明明在 —— 方法落盘了，论文状态却永久丢失。
   *
   * 本方法把「读」挪进写锁内，① 和 ② 合并成一次不可分割的操作。
   *
   * ── 约定 ──
   *   · fn 收到的是**锁内最新**快照（含本次调用之前所有已提交的改动）
   *   · fn 返回要落盘的 patch，语义与 commit() 完全一致（undefined 字段不写）
   *   · fn 返回 null 表示"无需落盘"，此时一个文件都不写
   *   · fn 在锁内执行，**必须快且不得再回调 store**（否则自死锁）
   */
  async updateBundle(
    projectId: string,
    fn: (bundle: ProjectBundle) => Partial<ProjectBundle> | null | Promise<Partial<ProjectBundle> | null>,
  ): Promise<void> {
    await acquireWrite(projectId)
    try {
      // 锁内直读四个文件（不能走 getBundle —— 它会再抢读锁，自死锁）
      const latest = await readBundleUnlocked(projectId)
      if (!latest) throw new Error(`项目 ${projectId} 不存在`)

      const patch = await fn(latest)
      if (patch === null) return

      const p = paths(projectId)
      const jobs: Promise<void>[] = []
      if (patch.project !== undefined) jobs.push(writeJson(p.project, patch.project))
      if (patch.papers !== undefined) jobs.push(writeJson(p.papers, patch.papers))
      if (patch.methods !== undefined) jobs.push(writeJson(p.methods, patch.methods))
      if (patch.evidence !== undefined) jobs.push(writeJson(p.evidence, patch.evidence))
      await Promise.all(jobs)
      invalidate(projectId)
    } finally {
      releaseWrite(projectId)
    }
  },

  /**
   * 按 file_hash + model + prompt_version 查已分析结果，用于跳过重复 LLM 调用。
   * 只比对这三项：换模型或改 prompt 都必须重算，否则会拿旧结论冒充新结果。
   */
  async findByHash(
    projectId: string,
    fileHash: string,
    model: string,
    promptVersion: string,
  ): Promise<StoredPaper | null> {
    const bundle = await this.getBundle(projectId)
    if (!bundle) return null
    return (
      bundle.papers.find(
        (x) =>
          x.file_hash === fileHash &&
          x.analyzed_with?.model === model &&
          x.analyzed_with?.prompt_version === promptVersion &&
          (x.status === 'completed' || x.status === 'validated'),
      ) ?? null
    )
  },

  /** 分配下一个形如 P007 / M020 / E039 的 ID */
  nextId(prefix: 'P' | 'M' | 'E' | 'J', existing: string[]): string {
    const re = new RegExp(`^${prefix}(\\d+)$`)
    let max = 0
    for (const id of existing) {
      const m = re.exec(id)
      if (m) max = Math.max(max, Number(m[1]))
    }
    return `${prefix}${String(max + 1).padStart(prefix === 'P' ? 3 : 3, '0')}`
  },
}

/* ------------------------------------------------------------------ */
/* Job Store —— 本轮放内存，接口形态与文件存储一致                        */
/* ------------------------------------------------------------------ */

const jobs = new Map<string, import('../types.ts').Job>()

export const jobStore = {
  save(job: import('../types.ts').Job) {
    jobs.set(job.job_id, job)
  },
  get(jobId: string) {
    return jobs.get(jobId) ?? null
  },
  listByProject(projectId: string) {
    return [...jobs.values()]
      .filter((j) => j.project_id === projectId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  },
  patch(jobId: string, patch: Partial<import('../types.ts').Job>) {
    const cur = jobs.get(jobId)
    if (!cur) return null
    const next = { ...cur, ...patch, updated_at: new Date().toISOString() }
    jobs.set(jobId, next)
    return next
  },
  addStep(
    jobId: string,
    stage: string,
    message: string,
    level: import('../types.ts').JobStep['level'] = 'info',
  ) {
    const cur = jobs.get(jobId)
    if (!cur) return null
    cur.steps.push({ at: new Date().toISOString(), stage, message, level })
    cur.stage = stage
    cur.updated_at = new Date().toISOString()
    return cur
  },
}

export function resetCachesForTest() {
  cache.clear()
  jobs.clear()
}

export const ensureDirsSync = () => {
  fs.mkdirSync(path.join(config.storage.dir, 'projects'), { recursive: true })
  fs.mkdirSync(config.storage.uploadDir, { recursive: true })
}
