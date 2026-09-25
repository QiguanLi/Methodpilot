/**
 * 分析编排 —— 把「PDF → 章节 → 方法 → 证据 → 知识库」这条链串起来。
 *
 * 这里最关键的**不是**调 LLM，而是第 11 节规定的顺序：
 *
 *   错误顺序（先想方法，再去找证据在哪）：
 *     模型先编出 5 个漂亮的方法名 → 再让它"补上出处" → 它只能编页码和原文
 *   正确顺序（本文件采用的）：
 *     把论文正文连页码一起给模型 → 要求它**同时**给出方法与其原文出处
 *     → 服务端逐条验证 quote 真的在声称的那一页上 → 通过才写入知识库
 *
 * 差别在于：前者把"证据"当成事后补的装饰，后者把证据当成方法成立的前提。
 * 一个模型如果找不到原文，它就只能少报方法——这正是我们要的行为。
 *
 * 另外，本文件是所有"失败"的汇聚点。第 27 节列了 9 类失败，
 * 每一类都必须变成用户能看懂的一句话，而不是一个 500。
 */

import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.ts'
import { store, jobStore } from '../store/fileStore.ts'
import { parserErrorText, pdfParser } from './pdf/parserClient.ts'
import { getAIProvider, hashFile } from './ai/index.ts'
import { AIFormatError, AIUnavailableError } from './ai/types.ts'
import type { MethodExtractionInput, MethodClassificationInput } from './ai/types.ts'
import { validateExtraction, summarizeValidation, rejectionBreakdown } from './ai/evidenceValidator.ts'
import { METHOD_EXTRACTION_PROMPT_VERSION, METHOD_CLASSIFICATION_PROMPT_VERSION } from './ai/prompt.ts'
import { FAMILY_IDS, familySpec, isKnownFamilyId } from './ai/taxonomy.ts'
import type {
  Job,
  LLMMethod,
  SourceType,
  StoredEvidence,
  StoredMethod,
  StoredPaper,
} from '../types.ts'

/* ------------------------------------------------------------------ */
/* Job 辅助                                                            */
/* ------------------------------------------------------------------ */

export function createJob(projectId: string, paperId: string): Job {
  const now = new Date().toISOString()
  const job: Job = {
    job_id: `J${Date.now().toString(36)}${randomUUID().slice(0, 4)}`,
    project_id: projectId,
    paper_id: paperId,
    state: 'queued',
    stage: '已入队',
    steps: [],
    rejected: [],
    methods: 0,
    evidences: 0,
    classified: null,
    error: null,
    created_at: now,
    updated_at: now,
  }
  jobStore.save(job)
  return job
}

const log = (
  jobId: string,
  stage: string,
  message: string,
  level: 'info' | 'success' | 'warn' | 'error' = 'info',
) => {
  jobStore.addStep(jobId, stage, message, level)
}

/* ------------------------------------------------------------------ */
/* 并发闸门                                                            */
/* ------------------------------------------------------------------ */

/**
 * 批量上传时的并发控制（第 29 节）。
 *
 * 为什么一定要限流：每篇论文会 spawn 一个 Python 进程（100+ 页的吃掉上百 MB），
 * 之后还会发一次大上下文 LLM 请求。10 个文件一起上，机器直接换页到死。
 * 更实际的是：CLI provider 每次调用都是起一个进程，无限并发等于自己 DDoS 自己。
 */
class Gate {
  // 注意：不要用 TS 的"构造函数参数属性"（constructor(private x)），
  // Node 的 --experimental-strip-types 只擦除类型、不做代码生成，会直接报错。
  private active = 0
  private readonly waiting: (() => void)[] = []
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((r) => this.waiting.push(r))
    }
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      const next = this.waiting.shift()
      if (next) next()
    }
  }
}
const gate = new Gate(config.analysis.concurrency)

/* ------------------------------------------------------------------ */
/* 落库互斥锁：按 projectId 串行化「读最新 → 分配 id → 落盘」            */
/* ------------------------------------------------------------------ */

/**
 * 每个项目一条"落库队列尾"。
 *
 * ── 为什么光有"重新读最新 bundle"还不够（实测复现，非推测）──
 *
 * commitResults 已经很小心地"每次写回前重新读一次 latest"，并且用
 * mergeById 按 id 合并。这套设计能防住"整份覆盖抹掉别人的记录"，
 * 但**防不住 ID 分配撞号**：
 *
 *     T1: getBundle → M001 空 → 分配 M001
 *     T2: getBundle → M001 空 → 分配 M001     ← 同一个号！
 *     T1: commit(mergeById(final.methods, [M001(T1)]))
 *     T2: commit(mergeById(final.methods, [M001(T2)]))
 *
 * mergeById 是**按 id 去重**的：`existing.filter(x => !mineIds.has(id))` 会把
 * 已经落盘的 M001(T1) 过滤掉，再 append M001(T2)。于是 T1 的方法被
 * **同一个 id 静默顶掉** —— 只剩一条 method，而它的 paper_ids 是 T2 的。
 *
 * 实测症状（真实并发上传两篇论文）：
 *     papers=2  methods=1                      ← 少了一个方法
 *     P001.method_ids=["M001"]  但  M001.paper_ids=["P002"]   ← 归属错乱
 * 即"P001 说 M001 是我的，M001 却说我是 P002 的"。无孤儿（因为 id 存在），
 * 但方法丢失 + 归属错位，比孤儿更隐蔽。
 *
 * ── 为什么必须是**互斥**而不是"再多读几次" ──
 * ID 分配（nextId 的 max+1）+ 落盘必须是一个**不可分割**的动作：
 * 只要两次分配之间能插进对方，就一定会撞号。重读多少次都只是缩小窗口，
 * 不能消除窗口。要消除它，只能让整段临界区串行。
 *
 * ── 粒度：只锁 projectId ──
 * 不同项目各自读改各自的目录，没有共享 id 空间，没有理由互相等待。
 * 按 projectId 分键既保证同项目落库串行，又保留跨项目（以及同项目内
 * 不同论文的解析/抽取等**非落库**阶段）的并发度。
 */
const commitChains = new Map<string, Promise<void>>()

/**
 * 在 projectId 的落库锁内执行 fn。
 *
 * 与 papers.ts 的 withUploadLock、fileStore 的 writeChains 同一套模式：
 * 把新任务接到链尾，跑完仅在"自己仍是链尾"时清理。
 */
async function withCommitLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = commitChains.get(projectId) ?? Promise.resolve()

  let release!: () => void
  const current = new Promise<void>((r) => {
    release = r
  })
  commitChains.set(projectId, current)

  // 等前一个落库彻底结束（它失败了也不影响本任务继续排队）
  await prev.catch(() => {})

  try {
    return await fn()
  } finally {
    release()
    if (commitChains.get(projectId) === current) commitChains.delete(projectId)
  }
}


/* ------------------------------------------------------------------ */
/* 章节裁剪                                                            */
/* ------------------------------------------------------------------ */

/**
 * 选哪些章节送进 LLM。
 *
 * 这是成本与召回率的平衡点：
 *   - References 一定不要，几十页引用对找方法毫无用处，却吃掉大半上下文；
 *   - 附录（Appendix）默认也不要，里面多是 prompt 原文和超参表；
 *   - 其余按原顺序拼接，累计到 maxChars 就停，并在日志里说明被截断了。
 *
 * 截断必须**说出来**。悄悄丢掉后半篇论文，会让人误以为"这篇论文只有两个方法"。
 */
function selectSections(
  sections: { name: string; page: number; pages: number[]; content: string }[],
): { picked: typeof sections; dropped: string[]; truncated: boolean } {
  const dropRe = /^(references|bibliography|acknowledg|appendix|supplement)/i
  const picked: typeof sections = []
  const dropped: string[] = []
  let budget = config.analysis.maxChars
  let truncated = false

  for (const s of sections) {
    const label = s.name.trim()
    if (dropRe.test(label)) {
      dropped.push(label)
      continue
    }
    if (s.content.trim().length < 80) continue // 空章节或纯图表标题

    if (s.content.length > budget) {
      if (budget < 4000) {
        dropped.push(`${label}（超出上下文预算）`)
        truncated = true
        continue
      }
      picked.push({ ...s, content: s.content.slice(0, budget) })
      truncated = true
      dropped.push(`${label}（截断）`)
      budget = 0
      continue
    }
    picked.push(s)
    budget -= s.content.length
  }

  return { picked, dropped, truncated }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

export interface AnalyzeOptions {
  /** 用户显式点了"重新分析"，跳过去重 */
  force?: boolean
}

/**
 * 分析一篇论文。**调用方不要 await 它**（除测试外）——它可能跑几分钟，
 * 路由层应该立即返回 job_id，让前端去轮询 GET /api/jobs/:jobId。
 */
export async function analyzePaper(
  projectId: string,
  paperId: string,
  jobId: string,
  opts: AnalyzeOptions = {},
): Promise<void> {
  jobStore.patch(jobId, { state: 'running' })

  try {
    const bundle = await store.getBundle(projectId)
    if (!bundle) throw new Error(`项目 ${projectId} 不存在`)

    const paper = bundle.papers.find((p) => p.paper_id === paperId)
    if (!paper) throw new Error(`论文 ${paperId} 不存在`)

    /* ---------------- 1. 找到 PDF 文件 ---------------- */
    const filePath = paperFilePath(paper)
    log(jobId, '定位文件', `已找到上传文件 ${path.basename(filePath)}`, 'success')

    /* ---------------- 2. 去重检查 ---------------- */
    const provider = await getAIProvider()
    const model = provider.model

    if (!opts.force) {
      const dup = await store.findByHash(projectId, paper.file_hash, model, METHOD_EXTRACTION_PROMPT_VERSION)
      if (dup && dup.paper_id !== paperId) {
        // 复用已有结果：不重复花 token，但必须保留来源说明，
        // 否则用户会以为这篇论文"被分析过"却找不到任何新证据
        log(
          jobId,
          '去重',
          `检测到相同文件已由 ${dup.paper_id} 用 ${model} / ${METHOD_EXTRACTION_PROMPT_VERSION} 分析过，直接复用其结果`,
          'warn',
        )
        await reuseFrom(projectId, paperId, dup, jobId)
        jobStore.patch(jobId, { state: 'completed', stage: '完成（复用已有分析）' })
        return
      }
    }

    /* ---------------- 3. Provider 可用性 ---------------- */
    const ready = await provider.isReady()
    if (!ready.ready) {
      // 第 13/14 节：没有真实 AI 时不能伪装成 LIVE。
      // 这里不写任何假数据，只把论文标成 failed 并说明原因。
      throw new AIUnavailableError(ready.reason)
    }
    log(jobId, 'AI Provider', `${provider.name} / ${model} 就绪`, 'success')

    /* ---------------- 4. 解析 PDF ---------------- */
    log(jobId, '解析 PDF', '调用 PyMuPDF 提取文本结构…')
    const parsed = await pdfParser.parse(filePath)
    if (parsed.status !== 'ok') {
      throw new ParserFailed(parsed.error_code, parsed.error)
    }
    log(
      jobId,
      '解析 PDF',
      `解析完成：${parsed.page_count} 页，识别出 ${parsed.sections.length} 个章节`,
      'success',
    )
    if (parsed.warnings.length) {
      for (const w of parsed.warnings) log(jobId, '解析 PDF', w, 'warn')
    }

    /* ---------------- 5. 写入解析结果 ---------------- */
    const withParsed: StoredPaper = {
      ...paper,
      page_count: parsed.page_count,
      title: parsed.title || paper.title,
      authors: parsed.authors.length ? parsed.authors : paper.authors,
      year: parsed.year || paper.year,
      abstract: parsed.abstract || paper.abstract,
      keywords: parsed.keywords.length ? parsed.keywords : paper.keywords,
      sections: parsed.sections,
      status: 'parsed',
      updated_at: new Date().toISOString(),
    }
    await updatePaperFresh(projectId, withParsed)
    log(jobId, '解析 PDF', `章节结构已入库（${parsed.sections.length} 节）`, 'success')

    /* ---------------- 6. 组装 LLM 输入 ---------------- */
    const { picked, dropped, truncated } = selectSections(
      parsed.sections.map((s) => ({ name: s.name, page: s.page, pages: s.pages, content: s.content })),
    )
    if (!picked.length) {
      throw new ParserFailed('NO_TEXT_LAYER', '解析出的章节全部为空，无法进行方法抽取')
    }
    if (dropped.length) {
      log(jobId, '准备上下文', `已排除：${dropped.join('、')}`, 'warn')
    }
    const totalChars = picked.reduce((n, s) => n + s.content.length, 0)
    log(jobId, '准备上下文', `送入模型：${picked.length} 个章节 / ${totalChars} 字符`, truncated ? 'warn' : 'info')

    const input: MethodExtractionInput = {
      title: withParsed.title,
      authors: withParsed.authors,
      year: withParsed.year,
      abstract: withParsed.abstract,
      sections: picked,
      pages: parsed.pages,
      taskHint: bundle.project.goal || undefined,
    }

    /* ---------------- 7. LLM 抽取（含一次重试） ---------------- */
    jobStore.patch(jobId, { stage: '方法抽取' })
    log(jobId, '方法抽取', '请求模型同时返回方法与原文出处…')
    const started = Date.now()
    const { extraction, usage, raw } = await extractWithRetry(provider, input, jobId)
    log(
      jobId,
      '方法抽取',
      `模型返回 ${extraction.methods.length} 个方法，用时 ${((Date.now() - started) / 1000).toFixed(1)}s` +
        `（in ${usage.inputTokens} / out ${usage.outputTokens} tokens）`,
      'success',
    )

    /* ---------------- 8. 证据校验 ---------------- */
    jobStore.patch(jobId, { stage: '证据校验' })
    const outcome = validateExtraction(extraction.methods, {
      sections: parsed.sections.map((s) => ({ name: s.name, pages: s.pages })),
      pages: parsed.pages,
    })
    log(
      jobId,
      '证据校验',
      summarizeValidation(outcome),
      outcome.stats.evidenceRejected > 0 ? 'warn' : 'success',
    )

    // 第 12 节：被拒的证据必须**记录并展示**，绝不静默修复或静默丢弃
    for (const r of outcome.rejectedEvidence) {
      log(jobId, '证据校验', `已拒绝：${r.message}`, 'warn')
    }
    for (const r of outcome.rejectedMethods) {
      log(jobId, '证据校验', r.message, 'error')
    }
    jobStore.patch(jobId, {
      rejected: outcome.rejectedEvidence.map((r) => ({
        section: r.section,
        page: r.page,
        /**
         * 这里**不再截断** quote。
         *
         * 之前是 slice(0, 300)，导致一个具体问题：真实模型跑完后，
         * 校验器与独立复核脚本对某一条的判定不一致，而我想复现时
         * 发现磁盘上只剩前 300 字符——无法确定两边比对的是不是同一个字符串。
         * 一个"说不清"的失败记录，比一条明确的拒绝更有害：
         * 它会让"证据可核验"这个核心承诺出现无法验证的缺口。
         *
         * 完整的 quote 是判断"到底是模型编造还是系统误拒"的唯一依据，
         * 所以原样存下，同时附上长度与校验器看到的匹配形式，便于逐字节比对。
         */
        quote: r.quote,
        quoteLength: r.quote.length,
        reason: r.reason,
        /** 面向人的中文说明，进 Analysis Log 与界面 */
        message: r.message,
        ...(r.diagnosis ? { diagnosis: r.diagnosis.kind } : {}),
      })),
      validation: {
        ...outcome.stats,
        ...(() => {
          const b = rejectionBreakdown(outcome)
          return {
            pageOffset: b.PAGE_OFFSET,
            truncatedSplice: b.TRUNCATED_SPLICE,
            notInPaper: b.NOT_IN_PAPER,
          }
        })(),
      },
    })

    /* ---------------- 9. 落库 ---------------- */
    if (!outcome.methods.length) {
      // 这是真实且重要的结果：模型什么都没找到，或找到的东西没有一条能站住。
      // 不编造方法，不写空壳方法，明确失败。
      const tail = raw ? `模型原始返回片段：${raw.slice(0, 200)}` : ''
      await updatePaperFresh(projectId, {
        ...withParsed,
        status: 'failed',
        error: `未能从这篇论文中抽取出任何带有效证据的方法（${outcome.stats.evidenceRejected} 条证据未通过校验）`,
        updated_at: new Date().toISOString(),
      })
      throw new AnalysisFailed(
        'NO_VALID_METHOD',
        `模型返回了 ${outcome.stats.methodsSeen} 个方法，但没有任何一个带有可在原文中核验的证据。` +
          `已拒绝 ${outcome.stats.evidenceRejected} 条证据，因此没有写入知识库。${tail}`,
      )
    }

    const committed = await commitResults({
      projectId,
      paper: withParsed,
      outcome,
      providerName: provider.name,
      model,
      usage,
    })

    log(
      jobId,
      '写入知识库',
      `已写入 ${committed.methodIds.length} 个方法、${committed.evidenceIds.length} 条证据`,
      'success',
    )
    jobStore.patch(jobId, {
      state: 'completed',
      stage: '完成',
      methods: committed.methodIds.length,
      evidences: committed.evidenceIds.length,
    })

    /* ---------------- 10. 方法分类（阶段③） ---------------- */
    /**
     * 放在这一步而不是 commitResults 里面，有两个理由：
     *
     * 1. **失败隔离**。抽取与证据校验是不可回退的：它们产出的东西
     *    一旦没落盘就没有第二次机会（PDF 得重解析、token 得重烧）。
     *    分类不一样——它的输入（方法 + 已校验证据）已经安全躺在磁盘上了，
     *    任何时候都能重跑，且几乎不花钱。
     *    所以分类失败**不能**把整篇论文标成 failed，那会把已经成功的
     *    抽取成果一起判死刑。这里捕获异常、记进日志、继续。
     *
     * 2. **可单独重跑**。用户在界面上改了分类 prompt 想重试，
     *    走 POST /api/papers/:id/classify 就行，不必重新上传 PDF。
     */
    jobStore.patch(jobId, { stage: '方法分类' })
    try {
      const cls = await classifyCommittedMethods(projectId, paperId, jobId)
      jobStore.patch(jobId, {
        classified: {
          seen: cls.seen,
          assigned: cls.assigned,
          unclassified: cls.unclassified,
          invalidFamilyId: cls.invalidFamilyId,
          strippedEvidenceIds: cls.strippedEvidenceIds,
        },
      })
      /**
       * 这里**不**更新 job.methods / job.evidences，也**不**把 state 改回 completed。
       * 它们已经被上面的落库步骤定稿了；分类只是锦上添花的附加信息，
       * 不该让"6 个方法已入库"这个事实因为分类器的表现而变动。
       */
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log(
        jobId,
        '方法分类',
        `分类失败，${committed.methodIds.length} 个方法与证据已正常入库，仅方法族标签缺失：${msg}`,
        'warn',
      )
      jobStore.patch(jobId, {
        classified: {
          seen: committed.methodIds.length,
          assigned: 0,
          unclassified: committed.methodIds.length,
          invalidFamilyId: 0,
          strippedEvidenceIds: 0,
        },
      })
    }
  } catch (e) {
    const { code, message } = describeFailure(e)
    log(jobId, '失败', message, 'error')
    jobStore.patch(jobId, { state: 'failed', stage: '失败', error: message, error_code: code } as Partial<Job>)

    // 论文状态也要更新，否则前端一直转圈。
    // 走 updatePaperFresh：重新读最新数据再合并，避免把并发新增的论文覆盖掉。
    try {
      const latest = await store.getBundle(projectId)
      const paper = latest?.papers.find((p) => p.paper_id === paperId)
      if (paper) {
        await updatePaperFresh(projectId, {
          ...paper,
          status: 'failed',
          error: message,
          updated_at: new Date().toISOString(),
        })
      }
    } catch {
      /* 记录失败都不能覆盖原始错误，静默 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 带重试的抽取                                                        */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 第 24 节：schema 不合法时自动重试一次；第二次仍失败即判为分析失败。
 *
 * 重试时把"上一次错在哪"告诉模型，比原样重发有效得多——
 * 原样重发大概率得到同样的错误输出。
 */
async function extractWithRetry(
  provider: Awaited<ReturnType<typeof getAIProvider>>,
  input: MethodExtractionInput,
  jobId: string,
) {
  const maxTries = 1 + config.analysis.maxRetries
  let lastErr: unknown

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const r = await provider.extractMethods(input)
      return { extraction: r.data, usage: r.usage, raw: r.raw }
    } catch (e) {
      lastErr = e

      // 网络/鉴权类错误重试没有意义：重试只会再等一次超时
      if (e instanceof AIUnavailableError) throw e

      if (e instanceof AIFormatError && attempt < maxTries) {
        log(jobId, '方法抽取', `第 ${attempt} 次返回的 JSON 不合法，正在重试一次…`, 'warn')
        await sleep(1200)
        continue
      }
      throw e
    }
  }
  throw lastErr
}

/* ------------------------------------------------------------------ */
/* 落库                                                                */
/* ------------------------------------------------------------------ */

interface CommitArgs {
  projectId: string
  paper: StoredPaper
  outcome: ReturnType<typeof validateExtraction>
  providerName: string
  model: string
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null }
}

/**
 * 写入 Method / Evidence，并回填双向关系。
 *
 * 第 19 节要求 evidence_id 由服务端生成且稳定（E001、E002…），
 * 而不是让模型自己编号——模型的编号在多篇论文之间一定会冲突。
 *
 * evidence_ids 一律从 evidence 表**派生**，不手工维护第二份，
 * 否则迟早出现"方法说有 3 条证据，实际只挂得上 2 条"。
 *
 * ⚠️ **写回必须基于最新数据**（本文件顶部「并发安全的写回」一节）：
 * 这里在函数内**重新读一次最新 bundle**，而不是用 job 启动时那份快照。
 * 原因有二，都会造成静默数据丢失：
 *   1. ID 分配：`nextId` 要基于**当前全部**已有 id 才能保证不重号。
 *      拿旧快照算，两个并发 job 会各自分配出 M003、E004 这种同一个号。
 *   2. 写回合并：旧快照里没有的记录（并发新增的论文/方法/证据）
 *      会在整份覆盖时被抹掉。
 */
async function commitResults(a: CommitArgs): Promise<{ methodIds: string[]; evidenceIds: string[] }> {
  /*
   * ⚠️ 整个函数体在 projectId 的锁内执行。
   *
   * 临界区必须**从"读最新 bundle"一直覆盖到"commit 落盘结束"**，
   * 因为 nextId 的取值依赖读到的集合，落盘又依赖刚分配出的 id：
   * 只要在"读"和"写"之间能插进另一个 job，两者就会分到同一个 id，
   * 后写的那个把先写的静默顶掉（详见 withCommitLock 的注释）。
   *
   * 注意锁**不**包含上层的解析与 LLM 抽取 —— 那些是本函数之外的步骤，
   * 耗时最长且完全不需要互斥。锁只罩住这段毫秒级的读改写。
   */
  return withCommitLock(a.projectId, () => commitResultsLocked(a))
}

async function commitResultsLocked(a: CommitArgs): Promise<{ methodIds: string[]; evidenceIds: string[] }> {
  const now = new Date().toISOString()

  const latest = await store.getBundle(a.projectId)
  if (!latest) throw new Error(`项目 ${a.projectId} 不存在`)

  const methods = [...latest.methods]
  const evidence = [...latest.evidence]
  const methodIds: string[] = []
  const evidenceIds: string[] = []

  /**
   * 关于 source_type 为什么**不**在这里按 provider 区分：
   *
   * source_type 的语义是"这条记录的来源性质"（演示数据 / 用户上传的原文 /
   * 系统推断出的结论），是一个**三选一的类别**，不该被复用去表达
   * "用的哪个 provider"。把 mock provider 的产出标成 'uploaded' 会让
   * 方法地图显示「用户上传」——那是比原来更严重的误标。
   *
   * 真正要解决的问题（不把规则引擎说成 AI）改由上层的
   * analyzed_with.provider 承担：所有界面都读那个字段，
   * 且 mock 的 model 名已改为自带说明的 deterministic-rule-based-extractor-v1。
   */
  const sourceType: SourceType = 'ai_generated'

  for (const { method: lm, evidence: evs } of a.outcome.methods) {
    const methodId = store.nextId('M', methods.map((m) => m.method_id))
    const evIds: string[] = []

    for (const ev of evs) {
      const evidenceId = store.nextId('E', evidence.map((e) => e.evidence_id))
      evIds.push(evidenceId)
      evidenceIds.push(evidenceId)
      evidence.push({
        evidence_id: evidenceId,
        paper_id: a.paper.paper_id,
        project_id: a.projectId,
        section: ev.section,
        page: ev.page,
        content: ev.quote,
        translation: '', // 翻译单独一次调用，失败也不影响证据有效性
        supports: normalizeSupports(ev.supports),
        confidence: ev.confidence,
        method_ids: [methodId],
        gap_ids: [],
        direction_ids: [],
        source_type: sourceType,
      })
    }

    methodIds.push(methodId)
    methods.push({
      method_id: methodId,
      project_id: a.projectId,
      name: String(lm.name ?? '').trim() || '未命名方法',
      name_zh: String(lm.name_zh ?? '').trim(),
      // family_id 与 classification 由阶段③「方法分类」写入。
      // 这里绝不用 LLM 随手给的编号——抽取阶段的模型根本没被问过分类，
      // 它如果碰巧吐了个 family_id 出来，那是幻觉，不能采信。
      family_id: '',
      classification: null,
      task: String(lm.task ?? ''),
      paradigm: String(lm.paradigm ?? ''),
      /*
       * 年份如实透传，**不用当前年份兜底**。
       *
       * 原写法是 `a.paper.year || new Date().getFullYear()`，这会凭空造出一个
       * "今年提出"的假年份：论文没有年份时（例如 S2 元数据论文），方法地图上
       * 就会显示 2026，技术演进的时间轴也会把它排到最右边，看上去像是
       * "最新研究"。用户完全无从分辨这是真实年份还是系统猜的。
       *
       * 全链路对"年份未知"的既有约定是 **0**：
       *   · metaPaper.ts —— "S2 拿不到年份时给 0，这里如实透传"
       *   · methodYear() —— `if (m.year > 0) return m.year; ... return 0`
       *   · yearKeyOf()  —— 0 映射为 +∞，排到最后
       *   · 前端          —— `unknown_year: n.year === 0`，显示「未知」
       * 这里必须与之一致，否则前端拿不到"未知"这个信号，只能显示假年份。
       */
      year: a.paper.year > 0 ? a.paper.year : 0,
      core_idea: String(lm.core_idea ?? ''),
      modules: arr(lm.modules),
      inputs: arr(lm.inputs),
      outputs: arr(lm.outputs),
      capabilities: arr(lm.capabilities),
      advantages: arr(lm.advantages),
      limitations: arr(lm.limitations),
      paper_ids: [a.paper.paper_id],
      evidence_ids: evIds,
      layer: 1,
      source_type: sourceType,
    })
  }

  const updatedMethodIds = [
    ...new Set([...a.paper.method_ids.filter((id) => methods.some((m) => m.method_id === id)), ...methodIds]),
  ]
  const evidenceCount = evidence.filter((e) => e.paper_id === a.paper.paper_id).length

  const updatedPaper: StoredPaper = {
    ...a.paper,
    status: 'completed',
    error: null,
    method_ids: updatedMethodIds,
    evidence_count: evidenceCount,
    analyzed_with: {
      provider: a.providerName,
      model: a.model,
      prompt_version: METHOD_EXTRACTION_PROMPT_VERSION,
      analyzed_at: now,
      input_tokens: a.usage.inputTokens,
      output_tokens: a.usage.outputTokens,
      cost_usd: a.usage.costUsd,
    },
    updated_at: now,
  }

  /*
   * 三个文件**一次性原子读-改-写**（store.updateBundle 在项目级写锁内完成
   * 「读最新四文件 → 合并 → 写回」），既避免前端读到"方法有了但证据还没落盘"
   * 的中间态，也避免本 job 用**陈旧快照**覆盖并发 job 已提交的改动。
   *
   * ── 为什么不能写成 getBundle() + commit() 两步 ──
   *
   * 那两步各自都是锁保护的，但**这一对**不是原子的。两个并发 analyze job 会：
   *
   *     A: getBundle ─→ 看到 P001 还是 parsed
   *     B: getBundle → commit（P001 已 completed）
   *     A:                commit（用陈旧 papers 覆盖 → P001 退回 parsed）← lost update
   *
   * 实测复现（24 轮 4 轮失败）：`P001 status=parsed method_ids=[]`，而
   * `M001.paper_ids=["P001"]` 明明存在 —— 方法落盘了，论文状态永久丢失。
   * updateBundle 把「读」挪进写锁，这两步合并成一次不可分割的操作。
   *
   * 三类实体都按**锁内最新数据**合并，语义与原先完全一致：
   *   · papers   —— 保留 latest.papers 里除本文之外的全部论文
   *   · methods  —— 本次新增的按 id 并入 latest.methods，别的 job 写的原样保留
   *   · evidence —— 同上
   *
   * ⚠️ 顺序上不能偷懒写成 `methods`（本地变量）直接落盘 ——
   * 那个变量虽然已经用 latest 初始化，但只包含"latest 快照 + 本次新增"，
   * 若本 job 运行期间又有第三方写入，仍会被覆盖。这里统一走 mergeById，
   * 以**落盘前一刻**的 latest 为基准确认最终集合。
   */
  await store.updateBundle(a.projectId, (final) => ({
    papers: replacePaper(final.papers, updatedPaper),
    methods: mergeById(final.methods, methods, (m) => m.method_id),
    evidence: mergeById(final.evidence, evidence, (e) => e.evidence_id),
  }))

  return { methodIds, evidenceIds }
}

/* ------------------------------------------------------------------ */
/* 阶段③：方法分类                                                      */
/* ------------------------------------------------------------------ */

export interface ClassifyOutcome {
  seen: number
  assigned: number
  unclassified: number
  invalidFamilyId: number
  strippedEvidenceIds: number
  provider: string
  model: string
}

/**
 * 把一批**已通过证据校验**的 Method 归入方法族，并把结果写回 methods.json。
 *
 * 为什么做成独立可调用的函数，而不是只塞在 analyzePaper 里：
 *   分类的输入（方法 + 已校验证据）全都已经落盘了。这意味着"分类"可以
 *   在**不重新解析 PDF、不重新调用抽取**的前提下重跑。
 *   这一点非常实际：抽取一次要 78k input tokens、109 秒；
 *   调分类 prompt 只需要几百 token。把两者绑死，等于每改一次分类 prompt
 *   就烧掉一次完整抽取的钱。所以路由层单独暴露了 POST /api/papers/:id/classify。
 *
 * 与 Evidence Validator 的关系（要求 6）：
 *   本函数**只读** evidence，从不修改、从不重新校验、从不放宽。
 *   它承接的是 Validator 已经判过的结论：凡是不在 method.evidence_ids 里的 id，
 *   一律剔除。Validator 的文件一个字节都没动。
 */
export async function classifyCommittedMethods(
  projectId: string,
  paperId: string,
  jobId: string | null,
): Promise<ClassifyOutcome> {
  const say = (stage: string, msg: string, level: 'info' | 'success' | 'warn' | 'error' = 'info') => {
    if (jobId) log(jobId, stage, msg, level)
  }

  const bundle = await store.getBundle(projectId)
  if (!bundle) throw new Error(`项目 ${projectId} 不存在`)

  const paper = bundle.papers.find((p) => p.paper_id === paperId)
  if (!paper) throw new Error(`论文 ${paperId} 不存在`)

  const targets = bundle.methods.filter((m) => m.paper_ids.includes(paperId))
  if (!targets.length) {
    say('方法分类', '这篇论文还没有已入库的方法，跳过分类', 'warn')
    return {
      seen: 0, assigned: 0, unclassified: 0, invalidFamilyId: 0,
      strippedEvidenceIds: 0, provider: '-', model: '-',
    }
  }

  const provider = await getAIProvider()
  const ready = await provider.isReady()
  if (!ready.ready) throw new AIUnavailableError(ready.reason)

  /* ---- 组装输入：方法画像 + 该方法的**已校验**证据 ---- */
  const evById = new Map(bundle.evidence.map((e) => [e.evidence_id, e]))
  const input: MethodClassificationInput = {
    title: paper.title,
    methods: targets.map((m) => ({
      method_id: m.method_id,
      name: m.name,
      name_zh: m.name_zh,
      task: m.task,
      paradigm: m.paradigm,
      core_idea: m.core_idea,
      modules: m.modules,
      capabilities: m.capabilities,
      limitations: m.limitations,
      /**
       * 只挂该方法自己的证据，且必须是真实存在的那几条。
       * evidence_ids 里出现悬空 id（证据被删过）时静默跳过——
       * 但下面会把这个数量报进日志，不藏。
       */
      evidence: m.evidence_ids
        .map((id) => evById.get(id))
        .filter((e): e is StoredEvidence => Boolean(e))
        .map((e) => ({
          evidence_id: e.evidence_id,
          section: e.section,
          page: e.page,
          content: e.content,
          supports: e.supports,
        })),
    })),
  }

  const dangling = targets.reduce(
    (n, m) => n + m.evidence_ids.filter((id) => !evById.has(id)).length,
    0,
  )
  if (dangling > 0) {
    say('方法分类', `发现 ${dangling} 个悬空 evidence_id（证据已不存在），已从分类依据中剔除`, 'warn')
  }

  say(
    '方法分类',
    `送入模型：${input.methods.length} 个方法 / ${input.methods.reduce((n, m) => n + m.evidence.length, 0)} 条已校验证据`,
  )
  say('方法分类', '分类依据仅限已通过逐字回验的证据，不重新读取论文原文')

  /* ---- 调用模型 ---- */
  const started = Date.now()
  const r = await provider.classifyMethods(input)
  say(
    '方法分类',
    `模型返回 ${r.data.classifications.length} 条分类，用时 ${((Date.now() - started) / 1000).toFixed(1)}s` +
      `（in ${r.usage.inputTokens} / out ${r.usage.outputTokens} tokens）`,
    'success',
  )

  /* ---- 归一化 + 核验（这一步决定"分类能不能被相信"） ---- */
  const now = new Date().toISOString()
  const byMethodId = new Map(r.data.classifications.map((c) => [String(c.method_id ?? ''), c]))
  const patched: StoredMethod[] = []
  let assigned = 0
  let unclassified = 0
  let invalidFamilyId = 0
  let strippedEvidenceIds = 0

  for (const m of targets) {
    const raw = byMethodId.get(m.method_id)

    if (!raw) {
      /**
       * 模型漏答了某个方法。
       *
       * 这里**不重试、不猜**，直接判为未分类并如实说明。
       * 用"让它重答一次"来消除漏答，得到的是一个为了通过检查而编的答案，
       * 反而比一个诚实的未分类更不可信。
       */
      unclassified++
      say('方法分类', `${m.method_id}（${m.name}）模型未返回分类结果，判为未分类`, 'warn')
      patched.push({
        ...m,
        family_id: '',
        classification: {
          method_id: m.method_id,
          family_id: '',
          reason: '模型没有为这个方法返回分类结果，服务端不做猜测，保持未分类。',
          evidence_ids: [],
          confidence: 0,
          provider: r.provider,
          model: r.model,
          prompt_version: METHOD_CLASSIFICATION_PROMPT_VERSION,
          classified_at: now,
        },
      })
      continue
    }

    /* 1. family_id 合法性 —— 只认 5 个已知 id，其余（含拼错的）一律作废 */
    let familyId = ''
    const rawFamily = raw.family_id === null || raw.family_id === undefined ? null : String(raw.family_id).trim()
    if (rawFamily) {
      if (isKnownFamilyId(rawFamily)) {
        familyId = rawFamily
      } else {
        invalidFamilyId++
        say(
          '方法分类',
          `${m.method_id}（${m.name}）模型返回了未知的方法族 id「${rawFamily}」，不在 ${FAMILY_IDS.join('/')} 之内，已作废并判为未分类`,
          'warn',
        )
      }
    }

    /* 2. evidence_ids 核验 —— 模型编的 id 一个都不留 */
    const allowed = new Set(m.evidence_ids)
    const cited = arr(raw.evidence_ids).filter((id) => allowed.has(id))
    const dropped = arr(raw.evidence_ids).length - cited.length
    if (dropped > 0) {
      strippedEvidenceIds += dropped
      say(
        '方法分类',
        `${m.method_id}（${m.name}）引用了 ${dropped} 个不属于该方法的 evidence_id，已剔除`,
        'warn',
      )
    }

    /**
     * 3. 要求 4：给了族就必须至少引用一条真实证据。
     *
     * 没引用 = "理由无从核对"。这种情况下宁可退回未分类，
     * 也不能让一个没有依据的族标签写进库里——那正是要求 5 要防的"强行分类"。
     */
    if (familyId && cited.length === 0) {
      say(
        '方法分类',
        `${m.method_id}（${m.name}）被判为 ${familyId} 但没有引用任何有效证据，无法核对，已退回未分类`,
        'warn',
      )
      familyId = ''
    }

    /* 4. reason 必须非空 —— 空理由在界面上无法与"没跑过"区分 */
    let reason = String(raw.reason ?? '').trim()
    if (!reason) {
      reason = familyId
        ? '模型给出了方法族但没有给出理由，服务端不采信无理由的分类。'
        : '模型判定为未分类但未说明原因。'
      if (familyId) {
        say('方法分类', `${m.method_id}（${m.name}）分类缺少 reason，已退回未分类`, 'warn')
        familyId = ''
      }
    }

    if (familyId) {
      assigned++
      const spec = familySpec(familyId)
      say(
        '方法分类',
        `${m.method_id}（${m.name}）→ ${familyId} ${spec?.name_zh ?? ''}（依据 ${cited.join('、')}）`,
        'success',
      )
    } else {
      unclassified++
      say('方法分类', `${m.method_id}（${m.name}）→ 未分类：${reason}`, 'info')
    }

    const conf = Number(raw.confidence)
    patched.push({
      ...m,
      family_id: familyId,
      classification: {
        method_id: m.method_id,
        family_id: familyId,
        reason,
        evidence_ids: cited,
        confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0,
        provider: r.provider,
        model: r.model,
        prompt_version: METHOD_CLASSIFICATION_PROMPT_VERSION,
        classified_at: now,
      },
    })
  }

  /* ---- 落盘：只写 methods.json 一个文件 ---- */
  /*
   * 再读一次最新数据：分类本身耗时（要调模型），期间可能有别的 job
   * 写完新方法。用早先的快照做 `map` 会把那些方法整份覆盖掉，
   * 所以这里以**落盘前一刻**的 methods 为准，只把本次的分类结果按 id 合并进去。
   */
  const freshest = await store.getBundle(projectId)
  const patchedById = new Map(patched.map((m) => [m.method_id, m]))
  const baseMethods = freshest ? freshest.methods : bundle.methods
  const nextMethods = baseMethods.map((m) => patchedById.get(m.method_id) ?? m)
  await store.saveMethods(projectId, nextMethods)

  say(
    '方法分类',
    `已写入 ${assigned} 个归类结果、${unclassified} 个未分类（provider=${r.provider} / ${r.model} / prompt=${METHOD_CLASSIFICATION_PROMPT_VERSION}）`,
    'success',
  )

  return {
    seen: targets.length, assigned, unclassified, invalidFamilyId, strippedEvidenceIds,
    provider: r.provider, model: r.model,
  }
}

/** 去重命中：把已有论文的方法与证据复制挂到新论文上，页码原样保留（同一份文件） */
async function reuseFrom(projectId: string, paperId: string, src: StoredPaper, jobId: string) {
  const latest = await store.getBundle(projectId)
  if (!latest) return
  const target = latest.papers.find((p) => p.paper_id === paperId)
  if (!target) return

  const srcMethods = latest.methods.filter((m) => m.paper_ids.includes(src.paper_id))
  const srcEvidence = latest.evidence.filter((e) => e.paper_id === src.paper_id)

  log(jobId, '去重', `复用 ${srcMethods.length} 个方法、${srcEvidence.length} 条证据（页码来自 ${src.paper_id} 的解析结果）`, 'info')

  // 走 updatePaperFresh：只改这一篇，并发新增的论文不会被覆盖（见「并发安全的写回」）
  await updatePaperFresh(projectId, {
    ...target,
    status: 'completed',
    page_count: src.page_count,
    title: target.title || src.title,
    sections: src.sections,
    method_ids: srcMethods.map((m) => m.method_id),
    evidence_count: srcEvidence.length,
    analyzed_with: src.analyzed_with,
    updated_at: new Date().toISOString(),
  })
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)).filter((x) => x.trim()) : []

const ALLOWED_SUPPORTS = new Set([
  '方法核心思想',
  '关键模块',
  '能力主张',
  '局限',
  '方法关系',
  '技术演进',
  '研究空白',
  '研究方向',
])

/** 模型偶尔会自创标签，这里过滤到白名单内；空则给个合理默认 */
function normalizeSupports(v: unknown): StoredEvidence['supports'] {
  const list = arr(v).filter((x) => ALLOWED_SUPPORTS.has(x))
  return (list.length ? list : ['方法核心思想']) as StoredEvidence['supports']
}

const replacePaper = (papers: StoredPaper[], next: StoredPaper): StoredPaper[] =>
  papers.map((p) => (p.paper_id === next.paper_id ? next : p))

/* ------------------------------------------------------------------ */
/* 并发安全的写回                                                      */
/* ------------------------------------------------------------------ */

/*
 * ── 为什么需要这一节 ──
 *
 * 分析 job 是**异步长任务**（要下 PDF、解析、调模型），从启动到落库可能好几秒。
 * 期间用户完全可能继续往同一个项目里加论文、跑另一次分析。
 *
 * 原来的写法是：job 启动时 `const bundle = await store.getBundle(projectId)`
 * 读**一次**快照，之后所有写回都基于这份快照：
 *
 *     store.savePapers(projectId, replacePaper(bundle.papers, next))
 *
 * `replacePaper` 只做 id 匹配替换、**从不删除**，所以快照里没有的记录
 * 会被整份覆盖掉。实测后果：分析期间新加入的论文**静默消失**，
 * 而所有 HTTP 请求都返回 200/success。
 *
 * fileStore 的 1500ms 读缓存还会让"刚写的"数据在短时间内读不到，
 * 进一步放大这个时间窗。
 *
 * ── 修法 ──
 *
 * 不缓存快照用于写回：**每次写之前重新读一次最新 bundle**，只把本次
 * 要改的那条记录合并进去，其余原样保留。
 *
 * 三个写回点分别对应：
 *   · updatePaperFresh —— 只改一篇论文（解析完成 / 分析失败 / 失败兜底）
 *   · commitResults    —— 论文 + 方法 + 证据三类一起写（用 store.commit 原子落盘）
 *
 * ── 后续修正：只"重新读"是不够的，ID 分配必须互斥 ──
 *
 * 上面这条"刻意不加锁"的结论**后来被实测推翻**，保留在此以记录这段认识过程。
 *
 * 它成立的前提是"两个 job 各写各的记录"（记录彼此独立）。但 commitResults
 * 还要做**ID 分配**（nextId = max+1），这是一个**共享的可变状态**：
 * 两个 job 从同一份快照各自算出 M001，落盘后 mergeById 按 id 去重，
 * 后者会把前者顶掉 —— 方法数少一个，且幸存者的 paper_ids 属于另一个 job，
 * 造成"论文与方法归属错位"。
 *
 * 所以现在（见 withCommitLock）：**commitResults 的整段读改写串行执行**。
 * updatePaperFresh 无需加锁——它只按 id 替换单条记录、不分配新 id，
 * 那次"重新读 + 只改一条"的合并确实是充分的。
 * 锁的粒度是 projectId 而非全局，跨项目并发不受影响。
 */

/**
 * 只更新**一篇**论文，其余论文按最新数据原样保留。
 *
 * 返回是否真的写成功：论文若在 job 运行期间被别人删掉了，就跳过写回
 * （而不是把它"复活"成一条幽灵记录）。
 */
async function updatePaperFresh(projectId: string, next: StoredPaper): Promise<boolean> {
  const latest = await store.getBundle(projectId)
  if (!latest) return false
  if (!latest.papers.some((p) => p.paper_id === next.paper_id)) return false
  await store.savePapers(projectId, replacePaper(latest.papers, next))
  return true
}

/** 按 id 合并：`mine` 里的记录覆盖同 id 的既有记录，`theirs` 里独有的原样保留 */
function mergeById<T>(existing: T[], mine: T[], idOf: (x: T) => string): T[] {
  const mineIds = new Set(mine.map(idOf))
  return [...existing.filter((x) => !mineIds.has(idOf(x))), ...mine]
}

export function paperFilePath(paper: StoredPaper): string {
  return path.join(config.storage.uploadDir, paper.file_hash.slice(0, 16), paper.file_name)
}

/* ------------------------------------------------------------------ */
/* 错误分类（第 27 节）                                                 */
/* ------------------------------------------------------------------ */

export class ParserFailed extends Error {
  readonly code: string
  constructor(code: string, detail: string) {
    super(parserErrorText(code, detail))
    this.name = 'ParserFailed'
    this.code = code
  }
}

export class AnalysisFailed extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'AnalysisFailed'
    this.code = code
  }
}

/**
 * 把任何异常收敛成 { code, message }。
 *
 * message 是**给用户看的**：会说清哪一步坏了、能怎么办。
 * 不做"An error occurred"这种偷懒处理——第 27 节明确要求不能白屏，
 * 而比白屏更糟的是有报错但看不懂。
 */
export function describeFailure(e: unknown): { code: string; message: string } {
  if (e instanceof ParserFailed) return { code: e.code, message: e.message }
  if (e instanceof AnalysisFailed) return { code: e.code, message: e.message }
  if (e instanceof AIUnavailableError) {
    return {
      code: 'AI_UNAVAILABLE',
      message: `AI 服务不可用：${e.message}。请配置 AI_API_KEY / AI_BASE_URL，或切换到 CLI Provider。此论文未被分析，知识库中没有写入任何数据。`,
    }
  }
  if (e instanceof AIFormatError) {
    return {
      code: 'AI_BAD_JSON',
      message: `模型返回的内容不是合法 JSON（已自动重试一次仍失败）。原始片段：${e.raw.slice(0, 300)}`,
    }
  }
  if (e instanceof Error) {
    if (/exceeds/.test(e.message)) return { code: 'PAYLOAD_TOO_LARGE', message: '文件过大，超出服务端允许的上传体积' }
    if (/ENOENT/.test(e.message)) return { code: 'PAPER_FILE_MISSING', message: '服务端找不到这篇论文的原始 PDF，请重新上传' }
    if (/timeout|aborted/i.test(e.message)) return { code: 'TIMEOUT', message: `处理超时：${e.message}` }
    return { code: 'INTERNAL', message: e.message }
  }
  return { code: 'INTERNAL', message: String(e) }
}

/* ------------------------------------------------------------------ */
/* 供路由层使用                                                        */
/* ------------------------------------------------------------------ */

export async function hashFileAt(filePath: string): Promise<string> {
  const buf = await fsp.readFile(filePath)
  return hashFile(buf)
}

export { gate }
