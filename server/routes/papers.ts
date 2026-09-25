/**
 * 论文相关路由：上传 / 列表 / 详情 / 触发分析。
 *
 * 上传是本阶段唯一真正的"输入口"，所以这里的防护最密：
 * 扩展名、MIME、magic bytes 三重检查，文件大小上限，文件名净化，
 * 按 content hash 分目录存储（同名不同内容不会互相覆盖）。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.ts'
import { store } from '../store/fileStore.ts'
import { hashFile } from '../services/ai/index.ts'
import { createJob, gate, analyzePaper, classifyCommittedMethods, describeFailure } from '../services/analysis.ts'
import { fetchFulltext } from '../services/fulltext.ts'
import { sendErr, sendJson, readJson, type UploadedFile } from '../utils/http.ts'
import type { StoredPaper } from '../types.ts'

/* ------------------------------------------------------------------ */

const MAX_UPLOAD_BYTES = 40 * 1024 * 1024 // 40MB：足够放下任何单篇论文，含图表

export const canAcceptUpload = (files: UploadedFile[]) => {
  const total = files.reduce((n, f) => n + f.data.length, 0)
  if (total > MAX_UPLOAD_BYTES) {
    return { ok: false as const, message: `单次上传合计 ${(total / 1048576).toFixed(1)}MB，超出 ${MAX_UPLOAD_BYTES / 1048576}MB 上限` }
  }
  return { ok: true as const }
}

/**
 * 是否是 PDF。
 *
 * 只看扩展名不够——用户把 .docx 改名成 .pdf 太常见了，
 * 而 Python 侧随后会抛 CORRUPT_PDF，用户看到的是"PDF 损坏"这种误导性提示。
 * 这里提前用 magic bytes 判断，能给出"这不是 PDF"的准确说明。
 */
function looksLikePdf(buf: Buffer): boolean {
  return buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-'
}

/** 保存上传文件，按 content hash 分目录，返回路径与 hash */
export async function saveUpload(file: UploadedFile): Promise<{ filePath: string; hash: string; size: number }> {
  const hash = hashFile(file.data)
  const dir = path.join(config.storage.uploadDir, hash.slice(0, 16))
  await fsp.mkdir(dir, { recursive: true })
  // 文件名里可能带中文/空格，落盘前只保留安全字符，展示名另存于 paper.file_name
  const safe = file.filename.replace(/[^\w.\-()\u4e00-\u9fa5]/g, '_').slice(0, 120) || 'paper.pdf'
  const filePath = path.join(dir, safe)
  await fsp.writeFile(filePath, file.data)
  return { filePath, hash, size: file.data.length }
}

export function validateUpload(file: UploadedFile): { ok: true } | { ok: false; code: string; message: string } {
  if (!file.data.length) return { ok: false, code: 'EMPTY_FILE', message: `「${file.filename}」是空文件（0 字节）` }
  if (!looksLikePdf(file.data)) {
    return {
      ok: false,
      code: 'NOT_A_PDF',
      message: `「${file.filename}」的内容不是 PDF。本阶段只支持 PDF，请确认导出的格式`,
    }
  }
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/* 上传的并发保护：按 projectId 的互斥锁                                 */
/* ------------------------------------------------------------------ */

/**
 * 每个项目一条"上传队列尾"。
 *
 * ── 为什么上传必须串行（实测复现过，不是假设）──
 *
 * handleUpload 的写路径是一段**读 → 追加 → 写**：
 *
 *     const bundle = await store.getBundle(projectId)   // 读快照
 *     const papers = [...bundle.papers]                 // 在快照上追加
 *     await store.savePapers(projectId, papers)         // 整份覆盖写
 *
 * 单请求下没问题。但两个上传并发时（用户在页面上同时拖两篇、或同时开两个标签页），
 * 两者的 `getBundle` 会拿到**同一份旧快照**（例如都是空数组）：
 *
 *     T1: read []  → append P001 → write [P001]
 *     T2: read []  → append P002 → write [P002]   ← 覆盖掉 P001
 *
 * 结果是 **lost update**：P001 从 papers.json 里消失。更隐蔽的是，
 * P001 的 analyze job 早已启动，它会照常落库一个 `paper_ids:["P001"]` 的
 * Method —— 而 P001 已不存在，于是产生**孤儿方法**。
 * 技术演进页随后会把这个孤儿方法也排进链里，凭空多出一条边。
 *
 * ── 为什么锁放在**路由层**而不是 fileStore ──
 *
 * fileStore 的 writeJson 已经保证"单个文件不会被写坏"（原子写 + 同文件串行，
 * Phase 6-2 已修）。但那次修复解决的是**文件完整性**，解决不了这里的
 * **业务语义竞争** —— 两次写都合法，只是第二次基于过期快照，
 * 于是把第一次的结果抹掉了。要消除它，必须让"读 + 改 + 写"整体互斥，
 * 而"什么算一次改"只有路由层知道。所以锁属于这里。
 *
 * ── 只锁 projectId 的粒度 ──
 *
 * 不同项目的上传互不影响（各自读改各自己的目录），没有理由互相等待。
 * 按 projectId 分键既保证同项目串行，又保留跨项目并发。
 */
const uploadChains = new Map<string, Promise<void>>()

/**
 * 在 projectId 的上传锁内执行 fn。
 *
 * 返回 fn 的结果；fn 抛错时锁照常释放（不会毒化后续上传）。
 * 与 fileStore.writeChains 同一套模式：把新任务接到链尾，执行完
 * 仅在"自己仍是链尾"时清理，避免把后来者从 Map 里弄丢。
 */
async function withUploadLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = uploadChains.get(projectId) ?? Promise.resolve()

  let release!: () => void
  const current = new Promise<void>((r) => {
    release = r
  })
  /*
   * 链尾登记的是 current（一个只有本任务结束时才 resolve 的信号），
   * 而不是 fn 本身的 Promise —— 这样链的语义是"上一个任务**完成**"，
   * 不携带其结果值，也不会把上一个任务的异常传给下一个。
   */
  uploadChains.set(projectId, current)

  // 等前一个任务彻底结束（它失败了也不影响我继续排队）
  await prev.catch(() => {})

  try {
    return await fn()
  } finally {
    release()
    // 仅当没有新任务接在我后面时，才把自己从 Map 移走
    if (uploadChains.get(projectId) === current) uploadChains.delete(projectId)
  }
}

/* ------------------------------------------------------------------ */
/* POST /api/projects/:projectId/papers  （multipart，支持多文件）       */
/* ------------------------------------------------------------------ */

export async function handleUpload(
  projectId: string,
  files: UploadedFile[],
  fields: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const bundle = await store.getBundle(projectId)
  if (!bundle) return { status: 404, body: errBody('PROJECT_NOT_FOUND', `项目 ${projectId} 不存在`) }

  const sizeCheck = canAcceptUpload(files)
  if (!sizeCheck.ok) return { status: 413, body: errBody('PAYLOAD_TOO_LARGE', sizeCheck.message) }

  const force = fields.force === 'true'

  /*
   * 校验 + 落盘（saveUpload）不需要互斥：它们只写各自的 hash 目录，
   * 相互之间没有共享状态。放在锁外可以把临界区缩到最小，
   * 避免大文件写盘时间串起来拖慢并发上传。
   *
   * 校验结果先算好，锁内只做"读最新 papers → 分配 id → 追加 → 落盘"。
   */
  const validated: { file: UploadedFile; hash: string; size: number }[] = []
  const rejected: { file_name: string; code: string; message: string }[] = []

  for (const f of files) {
    const check = validateUpload(f)
    if (!check.ok) {
      // 第 29 节：一个文件失败不能影响其他文件。所以只记录，不 return。
      rejected.push({ file_name: f.filename, code: check.code, message: check.message })
      continue
    }
    try {
      const { hash, size } = await saveUpload(f)
      validated.push({ file: f, hash, size })
    } catch (e) {
      rejected.push({ file_name: f.filename, code: 'SAVE_FAILED', message: (e as Error).message })
    }
  }

  /*
   * ⚠️ 临界区：必须在**锁内重新读一次** papers。
   *
   * 不能复用函数开头那份 bundle —— 那正是 lost update 的成因：
   * 上一个上传可能已经在我等待锁期间写入了新论文，用旧快照会把它们覆盖掉。
   * 所以这里（而不是函数开头）才是"读最新状态"的正确位置。
   */
  const { accepted, project } = await withUploadLock(projectId, async () => {
    const fresh = await store.getBundle(projectId)
    if (!fresh) throw new Error(`项目 ${projectId} 不存在`)

    const papers = [...fresh.papers]
    const accepted: { paper_id: string; file_name: string; job_id: string }[] = []

    for (const v of validated) {
      const paperId = store.nextId('P', papers.map((p) => p.paper_id))
      const now = new Date().toISOString()

      const paper: StoredPaper = {
        paper_id: paperId,
        project_id: projectId,
        file_name: v.file.filename,
        file_hash: v.hash,
        file_size: v.size,
        // 解析前这些字段都是空的——**不填占位内容**，
        // 否则界面上会先出现一个假的标题，看起来像识别成功
        page_count: 0,
        title: '',
        authors: [],
        year: 0,
        abstract: '',
        keywords: [],
        sections: [],
        status: 'uploaded',
        error: null,
        source_type: 'uploaded',
        analyzed_with: null,
        method_ids: [],
        evidence_count: 0,
        created_at: now,
        updated_at: now,
      }
      papers.push(paper)
      accepted.push({ paper_id: paperId, file_name: v.file.filename, job_id: '' })
    }

    const project = {
      ...fresh.project,
      paper_ids: papers.map((p) => p.paper_id),
      updated_at: new Date().toISOString(),
    }

    // 顺序很重要：**先落盘、再起任务**。
    // 反过来写会有一个真实的竞态——分析任务可能在 savePapers 完成前就读 papers.json，
    // 于是报"论文不存在"。这个 bug 在本轮真实复现过，不是假设。
    await store.savePapers(projectId, papers)
    await store.saveProject(projectId, project)
    return { accepted, project }
  })

  // 现在论文已经可读了，才可以安全地把任务丢进队列（仍不 await 分析本身）
  for (const a of accepted) {
    const job = createJob(projectId, a.paper_id)
    a.job_id = job.job_id
    void gate.run(() => analyzePaper(projectId, a.paper_id, job.job_id, { force }))
  }

  return {
    status: 200,
    body: {
      success: true,
      data: { project_id: projectId, accepted, rejected, total: files.length },
    },
  }
}

const errBody = (code: string, message: string) => ({ success: false, error: { code, message } })

/* ------------------------------------------------------------------ */
/* POST /api/papers/:paperId/analyze  （分析 / 重新分析）                */
/* ------------------------------------------------------------------ */

export async function handleAnalyze(
  projectId: string,
  paperId: string,
  body: { force?: boolean },
): Promise<{ status: number; body: unknown }> {
  const bundle = await store.getBundle(projectId)
  if (!bundle) return { status: 404, body: errBody('PROJECT_NOT_FOUND', `项目 ${projectId} 不存在`) }

  const paper = bundle.papers.find((p) => p.paper_id === paperId)
  if (!paper) return { status: 404, body: errBody('PAPER_NOT_FOUND', `论文 ${paperId} 不存在`) }

  /**
   * 「仅元数据」论文**不能**被分析（Phase 3B-7 补的守卫）。
   *
   * 它没有 PDF 文件——file_hash 是 `meta:<s2id>`，盘上不存在对应文件。
   * 放它进分析队列的后果不是"立刻报错"，而是**先报成功**：
   * 论文状态被改成 parsing、job 建出来返回 200，用户看到「正在分析」，
   * 然后任务在 readFile 处失败，状态落成 failed。
   * 这中间的每一秒界面都在谎报"分析已经在跑了"。
   *
   * 所以入口就挡住，并且明确指出下一步：先获取全文（或自己上传 PDF）。
   *
   * 注意判据是 **file_hash 前缀**，不是 status——
   * 与 fetchFulltext 的幂等判据保持同一个事实来源（有没有真实文件）。
   */
  if (paper.file_hash.startsWith('meta:')) {
    return {
      status: 409,
      body: errBody(
        'NO_FULLTEXT',
        '这篇论文只有元数据，没有 PDF 正文，无法分析。请先点「获取全文」把 PDF 取回来，或到上传页自行上传这篇论文的 PDF。',
      ),
    }
  }

  // 已经有一次在跑了就别再起一个：同一篇论文跑两遍会写出两套 Method
  const running = (await import('../store/fileStore.ts')).jobStore
    .listByProject(projectId)
    .find((j) => j.paper_id === paperId && (j.state === 'running' || j.state === 'queued'))
  if (running) {
    return {
      status: 200,
      body: { success: true, data: { job_id: running.job_id, state: running.state, reused: true } },
    }
  }

  // 状态先改再起任务，理由同上：任务一起来就会读 papers.json
  await store.savePapers(
    projectId,
    bundle.papers.map((p) =>
      p.paper_id === paperId ? { ...p, status: 'parsing', error: null, updated_at: new Date().toISOString() } : p,
    ),
  )

  const job = createJob(projectId, paperId)
  void gate.run(() => analyzePaper(projectId, paperId, job.job_id, { force: body.force !== false }))

  return { status: 200, body: { success: true, data: { job_id: job.job_id, state: 'queued', reused: false } } }
}

export { sendErr, sendJson, readJson }

/* ------------------------------------------------------------------ */
/* POST /api/projects/:pid/papers/:paperId/fetch-fulltext （3B-7）      */
/* ------------------------------------------------------------------ */

/**
 * 给一篇「仅元数据」论文补上全文。
 *
 * ── 幂等，且判别依据是**文件**而不是状态 ──
 *
 * 重复获取的判据是 `file_hash` 是否还是 `meta:` 前缀，而不是 status。
 * 理由：status 是给人看的过程标记，file_hash 是"有没有真实文件"的事实。
 * 按 status 判会出现这种情况——一篇论文因为别的原因状态是 pending、
 * 但文件其实已经在盘上，于是又下一次、把同一份 PDF 存成两个哈希目录。
 *
 * ── 已有 PDF 的论文一律不动 ──
 *
 * 非元数据论文（file_hash 不以 meta: 开头）直接返回 already，
 * 连状态字段都不重写。spec 要求"已有上传 PDF 的论文完全不改"，
 * 一个"顺手把 updated_at 刷新一下"的写法就已经违反了它。
 *
 * ── 为什么同步等待下载 ──
 *
 * 下载是秒级的（实测 arXiv 133KB 约 1s），用户点按钮后要立刻看到结果，
 * 异步化只会让界面先显示"获取中"再靠轮询补——多一套状态机，
 * 换来的是一个没人等的等待。所以这里 await 到底。
 * 但要设超时上限，否则一个不响应的站点会把请求挂到天荒地老。
 */
export async function handleFetchFulltext(
  projectId: string,
  paperId: string,
): Promise<{ status: number; body: unknown }> {
  const bundle = await store.getBundle(projectId)
  if (!bundle) return { status: 404, body: errBody('PROJECT_NOT_FOUND', `项目 ${projectId} 不存在`) }

  const paper = bundle.papers.find((p) => p.paper_id === paperId)
  if (!paper) return { status: 404, body: errBody('PAPER_NOT_FOUND', `论文 ${paperId} 不存在`) }

  /* ---- 已有真实 PDF：什么都不改 ---- */
  if (!paper.file_hash.startsWith('meta:')) {
    return {
      status: 200,
      body: {
        success: true,
        data: {
          already: true,
          paper,
          status: paper.status,
          message: '这篇论文已经有全文文件，无需重复获取',
        },
      },
    }
  }

  const r = await fetchFulltext(paper)

  if (!r.ok) {
    /*
     * 失败**不写任何东西**。
     *
     * 刻意不把 status 改成 'failed'：failed 在文献库里是"解析失败"，
     * 与"我们没能替你下载到 PDF"是两回事——前者说你给的 PDF 有问题，
     * 后者说我们没拿到 PDF。混用会让用户去检查一个根本不存在的文件。
     * 论文保持 pending，失败原因如实返回，界面显示「无法获取全文」。
     */
    return {
      status: 200,
      body: {
        success: true,
        data: {
          ok: false,
          already: false,
          code: r.code,
          message: r.message,
          status: paper.status,
        },
      },
    }
  }

  const now = new Date().toISOString()

  /*
   * 成功：把论文从"仅元数据"改造成"有全文、可分析"。
   *
   * status 用 'uploaded' —— 语义天然吻合：上传路径在同一时刻（文件已落盘、
   * 解析还没开始）用的就是这个值。**不用 'completed'**：
   * 那会让界面显示"已分析"，而这篇论文此刻没有方法、证据数为 0，
   * 那是最直白的谎报（metaPaper.ts 头部注释专门点名过这一条）。
   *
   * 清掉 file_name 的占位符与 sections 里的"元数据"节：
   * 现在有真 PDF 了，留着会让下游以为这篇还是纯元数据。
   * 标题/作者/年份/摘要/DOI 全部保留——它们是真实元数据，没有理由丢。
   */
  const next: StoredPaper = {
    ...paper,
    file_name: r.fileName,
    file_hash: r.fileHash,
    file_size: r.fileSize,
    // page_count 交给解析器填。这里写 0 是诚实的"还没解析"，
    // 编一个数字出来会让界面上出现一个假页数。
    page_count: 0,
    sections: [],
    status: 'uploaded',
    error: null,
    updated_at: now,
  }

  /**
   * 读-改-写必须基于**刚读到的这一份**，而且要一次写成。
   * 与 metaPaper.addMetaPaper 的约束相同：并发写 papers.json 会互相覆盖，
   * 每个请求都返回成功而数据只留一条。
   */
  await store.savePapers(
    projectId,
    bundle.papers.map((p) => (p.paper_id === paperId ? next : p)),
  )

  console.log(
    `[fulltext] ${paperId} 取得全文 ← ${r.route}:${r.from} (${r.fileSize} bytes, hash=${r.fileHash.slice(0, 12)})`,
  )

  return {
    status: 200,
    body: {
      success: true,
      data: {
        ok: true,
        already: false,
        paper: next,
        status: next.status,
        file_name: r.fileName,
        file_size: r.fileSize,
        from: r.from,
        route: r.route,
        message: '已获取全文，这篇论文现在可以分析了',
      },
    },
  }
}

/* ------------------------------------------------------------------ */
/* POST /api/papers/:paperId/classify  （阶段③：重跑方法分类）           */
/* ------------------------------------------------------------------ */

/**
 * 只跑分类，不碰解析、不碰抽取。
 *
 * 存在的价值：分类的输入已经全部落盘了，所以它可以被反复重跑。
 * 抽取一次要 78k input tokens，分类只要几百——把两者绑死的话，
 * 每微调一次分类 prompt 就要重烧一次完整抽取。
 *
 * 这个接口**不会**改动 evidence.json，也不会重新校验任何证据。
 * 它只读已通过校验的 evidence，把 family_id + reason + evidence_ids 写回 methods.json。
 */
export async function handleClassify(
  projectId: string,
  paperId: string,
): Promise<{ status: number; body: unknown }> {
  const bundle = await store.getBundle(projectId)
  if (!bundle) return { status: 404, body: errBody('PROJECT_NOT_FOUND', `项目 ${projectId} 不存在`) }

  const paper = bundle.papers.find((p) => p.paper_id === paperId)
  if (!paper) return { status: 404, body: errBody('PAPER_NOT_FOUND', `论文 ${paperId} 不存在`) }

  const methods = bundle.methods.filter((m) => m.paper_ids.includes(paperId))
  if (!methods.length) {
    return {
      status: 409,
      body: errBody(
        'NO_METHODS',
        '这篇论文还没有已入库的方法，无法分类。请先完成方法抽取。',
      ),
    }
  }

  /**
   * 同步跑完再返回，而不是丢进 gate 队列异步执行。
   *
   * 与抽取刻意不同：抽取要几分钟，必须异步 + 轮询；
   * 分类只要几秒，同步返回能让调用方（脚本/界面按钮）立刻拿到结果和计数，
   * 少一层 job 状态轮询就少一处可能出错的地方。
   *
   * 仍然过 gate：它是一次真实的模型调用，批量场景下不该把并发打满。
   */
  try {
    const result = await gate.run(() => classifyCommittedMethods(projectId, paperId, null))
    return { status: 200, body: { success: true, data: result } }
  } catch (e) {
    const { code, message } = describeFailure(e)
    return { status: code === 'AI_UNAVAILABLE' ? 503 : 500, body: errBody(code, message) }
  }
}
