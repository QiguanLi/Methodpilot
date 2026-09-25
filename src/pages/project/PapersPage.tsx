import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/AppLayout'
import {
  Card,
  Chip,
  EmptyState,
  EvidenceButton,
  ErrorState,
  IconAlert,
  IconCheck,
  IconCloudDownload,
  IconDownload,
  IconPlus,
  IconSearch,
  IconSparkles,
  ModeBadge,
  SectionTitle,
  SkeletonState,
  SourceBadge,
  StatusBadge,
} from '@/components/ui'
import { useEvidenceDrawer, useToast } from '@/context/AppContext'
import { api, pollJob } from '@/services/api'
import { DEMO_PROJECT_ID, loadDataset, registerDataset, type ProjectDataset } from '@/services/projectData'

type SortKey = 'year' | 'evidence'

/**
 * 批量分析中，单篇论文的处理阶段。
 *
 * 为什么要有 `submitting` 和 `running` 两档，而不是一个"进行中"：
 * 提交和分析是**两件不同的事**——提交可能被服务端 409 挡回来（没有全文），
 * 那时根本不会有 job，界面却显示"进行中"就是谎报。
 * 分开之后，"还没进队列"和"已经进队列在跑"在界面上是能区分的。
 */
type BatchPhase = 'submitting' | 'running' | 'done' | 'failed'

const BATCH_LABEL: Record<BatchPhase, string> = {
  submitting: '提交中…',
  running: '进行中…',
  done: '已完成',
  failed: '失败',
}

export function PapersPage() {
  const { id } = useParams()
  const pid = id ?? DEMO_PROJECT_ID
  const { push } = useToast()
  const { open: openEvidence } = useEvidenceDrawer()
  const navigate = useNavigate()

  /**
   * 数据集是本页唯一的数据来源。
   *
   * 之前这里直接读 getPapers()（浏览器内的静态 Mock），
   * 结果就是：用户上传了真实 PDF，文献库里依然是那 12 篇演示论文——
   * 上传闭环在最后一步断掉。现在统一走 loadDataset()，
   * Demo 项目返回内置数据，真实项目返回服务端结果，两者不混。
   */
  const [dataset, setDataset] = useState<ProjectDataset | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [keyword, setKeyword] = useState('')
  const [year, setYear] = useState('all')
  const [family, setFamily] = useState('all')
  const [task, setTask] = useState('all')
  const [sort, setSort] = useState<SortKey>('year')

  /**
   * 获取全文的每篇论文状态（Phase 3B-7）。
   *
   * 按 paper_id 存，而不是一个全局 busy 布尔：
   * 用户可能同时点几篇，或者点了一篇之后又去点另一篇。
   * 用一个全局标记的话，第二篇会把第一篇的"获取中"覆盖掉，
   * 界面就出现了"按钮转着圈但不知道是哪一篇"。
   *
   * failure 是**独立于状态**的一栏，因为它不是论文的状态——
   * 论文仍然是"仅元数据"，只是这一次尝试没成功。
   * 混进论文状态里会造成一个很难查的误导：看起来像这篇论文本身有问题。
   */
  const [fetching, setFetching] = useState<Record<string, boolean>>({})
  const [fetchError, setFetchError] = useState<Record<string, string>>({})
  /**
   * 本次会话内刚成功获取到全文的论文。
   *
   * 只在内存里、刷新即消失——它不是论文的属性，是一句一次性的确认。
   * 写成持久状态的话，用户下次打开文献库还会看到"已获取全文"，
   * 而那时这件事早就完成了，提示只会变成噪音。
   */
  const [fetchedOk, setFetchedOk] = useState<Record<string, boolean>>({})

  /* ------------------------------------------------------------------ */
  /* 批量分析（Phase 3B-9）                                              */
  /* ------------------------------------------------------------------ */

  /**
   * 已勾选的论文 ID。
   *
   * 与 ExplorerPage 的批量加入同款（Set<string>），键就是 paper_id——
   * 文献库里论文本来就是服务端对象，不需要像探索页那样剥 `mock:` 前缀。
   */
  const [selected, setSelected] = useState<Set<string>>(new Set())

  /**
   * 每篇论文在本次批量中的阶段，以及失败原因。按 paper_id 存。
   *
   * 与上面 fetching/fetchError 同样的理由：批量是逐篇跑的，
   * 用一个全局状态的话，「三篇里哪篇失败、哪篇还在跑」就全糊成一团。
   *
   * 失败原因独立成一栏，因为它不是论文的状态——
   * 论文可能仍然是"待解析"，只是这次提交没成。混进论文状态里，
   * 看起来就像论文本身有问题。
   */
  const [batchPhase, setBatchPhase] = useState<Record<string, BatchPhase>>({})
  const [batchError, setBatchError] = useState<Record<string, string>>({})
  const [batchBusy, setBatchBusy] = useState(false)

  /** 本次批量结束后的一句汇总，跑完就清掉 */
  const [batchSummary, setBatchSummary] = useState<string | null>(null)

  /**
   * 当前有 queued / running job 的论文 ID（Phase 3B-9）。
   *
   * 为什么需要它：
   * 服务端 handleAnalyze 对"已有未完成 job 的论文"是**复用**（返回 reused:true），
   * 而不是排队。如果界面允许勾选这样的论文，用户会以为"又提交了一次"，
   * 实际什么都没新发生——按钮点了像没点，这是最难查的一类误导。
   * 所以在可选阶段就把他排掉，并说明原因。
   *
   * 数据来自 `/api/projects/:id/jobs`。jobStore 是内存 Map，
   * 进程重启就没了——那时这里自然是空集合，行为退回"都能选"，也是对的。
   */
  const [activeJobs, setActiveJobs] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await loadDataset(pid)
      setDataset(r.dataset)
      // 注册给全局浮层（证据抽屉 / AI 助手）按 id 反查。
      // 不注册的话，抽屉会回落到浏览器里的 Demo 数据——见 projectData.ts 的说明。
      registerDataset(r.dataset)
      /*
       * 顺带取一次未完成的 job。
       * 拿不到（Demo 项目 / 服务端没起）就当没有——**不能**因此把整页判为加载失败，
       * 它只是一个附加的约束条件。
       */
      try {
        const jobs = await api.listJobs(pid)
        setActiveJobs(
          new Set(
            jobs.filter((j) => j.state === 'queued' || j.state === 'running').map((j) => j.paper_id),
          ),
        )
      } catch {
        setActiveJobs(new Set())
      }
    } catch (e: unknown) {
      // 服务端没起来不是"空数据"，是"拿不到数据"。两者必须区分，
      // 否则用户会以为论文丢了。
      setError(e instanceof Error ? e.message : String(e))
      setDataset(null)
      registerDataset(null)
    } finally {
      setLoading(false)
    }
  }, [pid])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const allPapers = dataset?.papers ?? []
  const methods = dataset?.methods ?? []
  const evidence = dataset?.evidence ?? []
  const families = dataset?.knowledgeBase?.families ?? []
  /**
   * 仅元数据论文数（来自论文探索）。
   *
   * 上面那段来源说明必须按它分叉：说"全部论文来自你上传的 PDF"在这个数不为 0 时
   * 就是错的，而这句话正好是用户判断"这些记录能不能信"的依据。
   */
  const metaCount = allPapers.filter((p) => p.meta_only).length

  const years = useMemo(
    () => [...new Set(allPapers.map((p) => p.year).filter((y) => y > 0))].sort((a, b) => b - a),
    [allPapers],
  )
  const tasks = useMemo(
    () => [...new Set(allPapers.map((p) => p.task).filter(Boolean))],
    [allPapers],
  )

  const filtered = allPapers
    .filter((p) => {
      if (year !== 'all' && p.year !== Number(year)) return false
      if (task !== 'all' && p.task !== task) return false
      if (family !== 'all') {
        const fam = families.find((f) => f.family_id === family)
        const methodIds = fam?.method_ids ?? []
        if (!p.method_ids.some((mid) => methodIds.includes(mid))) return false
      }
      if (keyword) {
        const kw = keyword.toLowerCase()
        return (
          p.title.toLowerCase().includes(kw) ||
          p.authors.join(' ').toLowerCase().includes(kw) ||
          p.task.toLowerCase().includes(kw) ||
          p.keywords.join(' ').toLowerCase().includes(kw)
        )
      }
      return true
    })
    .sort((a, b) =>
      sort === 'year' ? b.year - a.year : b.evidence_count - a.evidence_count,
    )


  const resetFilters = () => {
    setKeyword('')
    setYear('all')
    setFamily('all')
    setTask('all')
    setSort('year')
  }

  /**
   * 「获取全文」（Phase 3B-7）。
   *
   * 只做一件事：把这篇仅元数据论文的 PDF 取回来。
   * **不**顺手触发分析——spec 明确要求不启动 LLM。
   * 用户拿到全文之后，什么时候分析由他自己在论文详情页决定。
   *
   * 三种结果分别处理，因为用户据此要做的事完全不同：
   *   成功     → 刷新列表，状态变成"可分析"
   *   取不到   → 明确显示「无法获取全文」+ 具体原因，**不改状态**
   *   已获取过 → 提示一句就好，不重复下载
   */
  const handleFetch = async (paperId: string) => {
    setFetching((m) => ({ ...m, [paperId]: true }))
    setFetchError((m) => {
      const next = { ...m }
      delete next[paperId]
      return next
    })
    try {
      const r = await api.fetchFulltext(pid, paperId)

      if (r.already) {
        push({ title: '无需重复获取', description: r.message ?? '这篇论文已经有全文了', tone: 'info' })
        return
      }

      /*
       * 关键判断：服务端用 200 + ok:false 表达"取不到"，
       * 所以这里必须显式看 ok，不能只看有没有抛异常。
       * 判错的话，失败会被显示成成功——正是 spec 点名禁止的"伪装成已获取"。
       */
      if (r.ok === false) {
        setFetchError((m) => ({ ...m, [paperId]: r.message || '无法获取全文' }))
        return
      }

      push({
        title: '已获取全文',
        description: '这篇论文现在可以分析了。到论文详情页即可开始解析。',
        tone: 'success',
      })
      setFetchedOk((m) => ({ ...m, [paperId]: true }))
      // 重新拉一遍：状态、文件名、来源都变了，靠本地改 state 拼容易与后端不一致
      await refresh()
    } catch (e: unknown) {
      // 网络 / 5xx 才走到这里，与"取不到全文"是两类失败，但用户看到的是同一句提示
      setFetchError((m) => ({
        ...m,
        [paperId]: e instanceof Error ? e.message : '无法获取全文',
      }))
    } finally {
      setFetching((m) => {
        const next = { ...m }
        delete next[paperId]
        return next
      })
    }
  }

  const hasFilter = keyword || year !== 'all' || family !== 'all' || task !== 'all'
  const isLive = dataset?.source === 'live'

  /**
   * 可批量勾选的范围（Phase 3B-9）。
   *
   * 两个限制都必须有：
   *
   * 1. **仅元数据论文不能选**。它没有 PDF（file_hash 以 `meta:` 开头），
   *    服务端在 handleAnalyze 入口就用 409 NO_FULLTEXT 挡住。前端把它排除，
   *    是为了让用户**在点之前**就知道这件事，而不是点了才弹错误。
   *    注意判据用 `meta_only`（projectData.ts 里由 file_hash 前缀翻译而来），
   *    与那三个后端守卫是同一个事实来源。
   *
   * 2. **已有未完成 job 的论文不能选**。服务端对它只会"复用"已有 job
   *    （reused:true），不会新跑一次。允许勾选会让用户以为提交了新的分析，
   *    实际什么都没发生。
   *
   * 3. **Demo 项目整体不开放**。Demo 论文只存在于浏览器内置数据里，
   *    服务端根本没有这些记录，提交必然 404。
   */
  const selectable = useMemo(
    () => (isLive ? filtered.filter((p) => !p.meta_only && !activeJobs.has(p.paper_id)) : []),
    [filtered, isLive, activeJobs],
  )

  const allSelected =
    selectable.length > 0 && selectable.every((p) => selected.has(p.paper_id))

  const toggleOne = useCallback(
    (paperId: string) => {
      // 已有未完成 job 的论文不参与勾选（服务端只会复用，不会新跑）
      if (activeJobs.has(paperId)) return
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(paperId)) next.delete(paperId)
        else next.add(paperId)
        return next
      })
    },
    [activeJobs],
  )

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const ids = selectable.map((p) => p.paper_id)
      // 全选状态下再点 = 取消全选（与 ExplorerPage 一致）
      if (ids.length > 0 && ids.every((i) => prev.has(i))) {
        const next = new Set(prev)
        for (const i of ids) next.delete(i)
        return next
      }
      return new Set([...prev, ...ids])
    })
  }, [selectable])

  /** 操作栏上的四态计数（进行中 = 提交中 + 运行中） */
  const tallies = useMemo(() => {
    const t = { running: 0, done: 0, failed: 0 }
    for (const id of selected) {
      const ph = batchPhase[id]
      if (ph === 'submitting' || ph === 'running') t.running++
      else if (ph === 'done') t.done++
      else if (ph === 'failed') t.failed++
    }
    return t
  }, [selected, batchPhase])

  /**
   * 批量分析（Phase 3B-9）—— **逐篇串行提交**。
   *
   * 为什么必须串行，而不能 Promise.all 一起发：
   *
   * `analysis.ts` 的 commitResults 用**函数开始时读到的快照**算 ID
   * （`nextId('M', methods.map(...))`），然后 `saveMethods` / `saveEvidence`
   * 做的是**整份覆盖写**。两篇并发时，各自从同一份快照算出 M001/E001，
   * 后写的会把先写的整套吞掉——而**两个请求都返回成功**。
   * 结果是方法数对不上、证据张冠李戴，且没有任何报错。
   *
   * 服务端的 `gate` 限流默认是 2，挡不住这件事（2 > 1）。
   * 所以串行不是性能取舍，是**正确性要求**。
   *
   * 提交顺序取 `filtered` 的顺序，保证多次点击行为一致、可复现。
   */
  const submitBatch = useCallback(async () => {
    if (selected.size === 0 || batchBusy) return

    /*
     * 提交前再过滤一次，而不是只信勾选时的判断：
     * 从"勾选"到"点按钮"之间可能过了几秒，期间别处可能已经起了 job
     * （比如用户在另一个标签页点了分析）。这里以提交那一刻的 activeJobs 为准。
     */
    const ordered = filtered.filter(
      (p) => selected.has(p.paper_id) && !p.meta_only && !activeJobs.has(p.paper_id),
    )
    if (ordered.length === 0) return

    setBatchBusy(true)
    setBatchSummary(null)
    setBatchError({})
    setBatchPhase(Object.fromEntries(ordered.map((p) => [p.paper_id, 'submitting' as BatchPhase])))

    let ok = 0
    let bad = 0
    const doneIds = new Set<string>()

    for (const p of ordered) {
      const paperId = p.paper_id
      try {
        // 1) 提交（只等入队，不等跑完）
        const r = await api.analyze(paperId, pid, true)
        setBatchPhase((m) => ({ ...m, [paperId]: 'running' }))

        // 2) 跟着这一个 job 走到终态。
        //    onTick 用来把服务端的实时 stage 透出来（失败时 stage 会说清卡在哪）。
        const job = await pollJob(r.job_id, {
          onTick: (j) => {
            if (j.stage) setBatchPhase((m) => (m[paperId] ? { ...m, [paperId]: 'running' } : m))
          },
        })

        if (job.state === 'completed') {
          setBatchPhase((m) => ({ ...m, [paperId]: 'done' }))
          doneIds.add(paperId)
          ok++
        } else {
          // 任务失败：把服务端给的 error 如实挂到这一篇上
          setBatchPhase((m) => ({ ...m, [paperId]: 'failed' }))
          setBatchError((m) => ({ ...m, [paperId]: job.error || '分析任务失败' }))
          bad++
        }
      } catch (e: unknown) {
        /*
         * 接口层失败：409 NO_FULLTEXT、论文不存在、网络断了……
         * 这一支和"任务失败"是两回事——前者连 job 都没建出来。
         * 分开记，用户据此要做的事不同（去取全文 vs 重试）。
         */
        const msg = e instanceof Error ? e.message : String(e)
        setBatchPhase((m) => ({ ...m, [paperId]: 'failed' }))
        setBatchError((m) => ({ ...m, [paperId]: msg }))
        bad++
      }
    }

    setBatchBusy(false)
    setBatchSummary(`已完成 ${ok} 篇${bad ? `，失败 ${bad} 篇` : ''}`)

    /*
     * 成功的从勾选里摘掉（它已经不是"待处理"了）；失败的保留，方便直接重试。
     *
     * 这里用循环里同步累积的 `doneIds`，而不是去读 batchPhase 状态：
     * setBatchPhase 是异步的，此刻闭包里的 batchPhase 还是旧值，
     * 拿它来算会把「本次刚成功的」全漏掉。与 ExplorerPage 里
     * "只清成功的" 是同一个意图，只是实现上必须绕开状态闭包。
     */
    setSelected((prev) => new Set([...prev].filter((id) => !doneIds.has(id))))

    push({
      title: bad ? '批量分析部分完成' : '批量分析完成',
      description: `成功 ${ok} 篇${bad ? `，失败 ${bad} 篇（原因见对应论文行）` : ''}`,
      tone: bad ? 'warn' : 'success',
    })

    // 无论成败都要刷新：成功要看到方法与证据，失败要看到 status=failed
    await refresh()
  }, [selected, batchBusy, filtered, activeJobs, pid, push, refresh])

  /**
   * 按论文实际使用的抽取引擎汇总。
   *
   * 读的是 dataset.raw.papers（服务端原样对象），因为 dataset.papers 那层
   * 映射为了 UI 方便丢掉了 analyzed_with。这里宁可多绕一层，
   * 也不把"引擎是什么"这种关键信息丢掉。
   */
  const engineSummary = (() => {
    if (!isLive) return [] as { label: string; count: number; real: boolean }[]
    const buckets = new Map<string, { count: number; real: boolean }>()
    for (const p of dataset?.raw?.papers ?? []) {
      const aw = p.analyzed_with
      const real = Boolean(aw) && aw!.provider !== 'mock'
      const label = aw ? (real ? `真实模型 · ${aw.model}` : '内置规则引擎') : '溯源缺失'
      const cur = buckets.get(label) ?? { count: 0, real }
      cur.count++
      buckets.set(label, cur)
    }
    return [...buckets.entries()].map(([label, v]) => ({ label, ...v }))
  })()

  return (
    <div className="mp-anim-fade-up space-y-5">
      <PageHeader
        title="文献库"
        subtitle={
          loading
            ? '加载中…'
            : error
              ? '无法读取数据'
              : `本项目共 ${allPapers.length} 篇论文`
        }
        meta={
          <>
            {dataset && (
              <span className="mp-chip bg-ink-100 text-ink-700">
                <ModeBadge mode={isLive ? 'LIVE' : 'MOCK'} />
              </span>
            )}
            <Chip tone="success">
              {allPapers.filter((p) => p.status === 'analyzed').length} 篇已分析
            </Chip>
            <Chip tone="brand">{evidence.length} 条证据</Chip>
          </>
        }
        actions={
          <>
            <button
              className="mp-btn mp-btn-ghost"
              onClick={() => navigate(`/project/${pid}/upload`)}
            >
              <IconPlus className="h-3.5 w-3.5" /> 上传论文
            </button>
            <button className="mp-btn mp-btn-soft" onClick={() => void submitBatch()} disabled={loading || selected.size === 0 || batchBusy}>
              <IconSparkles className="h-3.5 w-3.5" />
              {batchBusy ? '分析中…' : `批量分析${selected.size > 0 ? `（${selected.size}）` : ''}`}
            </button>
            <button
              className="mp-btn mp-btn-ghost"
              onClick={() =>
                push({ title: '已导出', description: '文献清单已导出为 CSV（演示）', tone: 'success' })
              }
            >
              <IconDownload className="h-3.5 w-3.5" /> 导出
            </button>
          </>
        }
      />

      {/* Live 项目的数据来源说明：避免"这些是哪来的"困惑 */}
      {isLive && (
        <Card className="p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <SourceBadge source="uploaded" />
            <p className="text-[12px] leading-relaxed text-ink-500">
              {metaCount > 0 ? (
                <>
                  本页论文有<b>两个来源</b>：标着「仅元数据」的来自论文探索，
                  只登记了 Semantic Scholar 的标题 / 作者 / DOI，
                  <b>没有 PDF、没有正文、没有方法</b>；
                  其余来自你上传的 PDF，标题、作者、章节、页码均取自真实内容。
                  两类都是真实记录，但可核验的程度不同。
                </>
              ) : (
                <>
                  本页全部论文来自你上传的 PDF，经服务端解析与抽取后写入知识库；
                  标题、作者、章节、页码均取自 PDF 真实内容。
                </>
              )}
            </p>
          </div>

          {/*
           * 按实际使用的抽取引擎汇总，而不是笼统写一句"AI 分析"。
           * 用户扫一眼文献库就该知道：这些结论是规则挑的，还是模型读的。
           * 两种都真实存在（取决于服务端 AI_PROVIDER），不能混为一谈。
           */}
          {engineSummary.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-ink-200 pt-2.5">
              {engineSummary.map((e) => (
                <Chip key={e.label} tone={e.real ? 'success' : 'warn'}>
                  {e.count} 篇 · {e.label}
                </Chip>
              ))}
              {engineSummary.some((e) => !e.real) && (
                <span className="text-[11.5px] text-amber-700">
                  标为「规则引擎」的论文不是大模型抽的——句子是原文，但归纳不是模型做的。
                </span>
              )}
            </div>
          )}
        </Card>
      )}

      {/* 筛选条 */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              className="mp-input pl-9"
              placeholder="搜索论文标题、作者、关键词…"
            />
          </div>

          <select
            value={year}
            onChange={(e) => setYear(e.target.value)}
            className="mp-input w-auto min-w-[104px] cursor-pointer"
          >
            <option value="all">全部年份</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y} 年
              </option>
            ))}
          </select>

          <select
            value={task}
            onChange={(e) => setTask(e.target.value)}
            className="mp-input w-auto min-w-[128px] cursor-pointer"
          >
            <option value="all">全部任务</option>
            {tasks.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          {/* 方法族筛选只在 Demo 项目有意义：真实项目阶段③未接入，没有族可筛 */}
          {!isLive && (
            <select
              value={family}
              onChange={(e) => setFamily(e.target.value)}
              className="mp-input w-auto min-w-[128px] cursor-pointer"
            >
              <option value="all">全部方法族</option>
              {families.map((f) => (
                <option key={f.family_id} value={f.family_id}>
                  {f.name_zh}
                </option>
              ))}
            </select>
          )}

          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="mp-input w-auto min-w-[112px] cursor-pointer"
          >
            <option value="year">按年份</option>
            <option value="evidence">按证据数</option>
          </select>

          {hasFilter && (
            <button className="mp-btn mp-btn-ghost" onClick={resetFilters}>
              清除筛选
            </button>
          )}
        </div>
      </Card>

      {/* 状态分支：加载 / 报错 / 空 / 列表 —— 四态必须分开 */}
      {loading ? (
        <Card className="p-4">
          <SkeletonState rows={6} />
        </Card>
      ) : error ? (
        <ErrorState
          title="无法加载文献库"
          description={`${error}。请确认分析服务已启动（pnpm dev:all），或检查项目 ID 是否正确。`}
          onRetry={() => void refresh()}
        />
      ) : allPapers.length === 0 ? (
        <EmptyState
          title="还没有论文"
          description="上传一篇 PDF，服务端会解析章节结构，并抽取方法与其原文证据。每条证据都会被逐字回验到具体页码。手上还没有 PDF 时，也可以先去论文探索把想读的论文找进来。"
          action={
            /*
             * 两个入口并列，而不是只留「上传」。
             *
             * 原来的空态只指向上传，但"手上暂时没有 PDF"是很常见的情形——
             * 用户知道自己想找什么方向，只是还没把论文下载下来。
             * 那种情况下唯一的按钮会把他堵在门口。
             *
             * 「上传」仍是 primary：它通向完整闭环（解析 → 抽取 → 证据回验），
             * 而探索页只登记元数据。主次要分明。
             */
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                className="mp-btn mp-btn-primary"
                onClick={() => navigate(`/project/${pid}/upload`)}
              >
                <IconPlus className="h-3.5 w-3.5" /> 上传第一篇论文
              </button>
              <button
                className="mp-btn mp-btn-soft"
                onClick={() => navigate(`/project/${pid}/explorer`)}
              >
                <IconSearch className="h-3.5 w-3.5" /> 去论文探索找论文
              </button>
            </div>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="没有符合条件的论文"
          description="当前筛选条件下没有结果。清除筛选可以看全部论文。"
          action={
            <button className="mp-btn mp-btn-soft" onClick={resetFilters}>
              清除筛选
            </button>
          }
        />
      ) : (
        <Card className="overflow-hidden">
          {/* 表头 */}
          <div className="hidden grid-cols-[40px_minmax(0,3fr)_118px_108px_148px_128px_104px_104px] items-center gap-3 border-b border-ink-200 bg-ink-50/70 px-4 py-2.5 lg:grid">
            {/* 批量分析：全选框。只在真实项目出现（Demo 数据服务端没有，提交必然 404） */}
            <span className="flex items-center">
              {isLive && (
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
                  checked={allSelected}
                  disabled={selectable.length === 0 || batchBusy}
                  onChange={toggleAll}
                  aria-label="全选可分析的论文"
                  title={
                    selectable.length === 0
                      ? '没有可分析的论文（仅元数据的论文需先获取全文；已在跑的论文需等它结束）'
                      : allSelected
                        ? '取消全选'
                        : `全选本页 ${selectable.length} 篇可分析的论文`
                  }
                />
              )}
            </span>
            <span className="mp-label">论文标题</span>
            <span className="mp-label">作者 / 年份</span>
            {/* Live 项目这一列显示真实文件名；Demo 项目才是"会议" */}
            <span className="mp-label">{isLive ? '来源' : '会议'}</span>
            <span className="mp-label">研究任务</span>
            <span className="mp-label">方法标签</span>
            <span className="mp-label">状态</span>
            <span className="mp-label text-right">Evidence</span>
          </div>

          <div className="divide-y divide-ink-200">
            {filtered.map((p) => {
              const pMethods = p.method_ids
                .map((mid) => methods.find((m) => m.method_id === mid))
                .filter((m): m is NonNullable<typeof m> => Boolean(m))
              return (
                <div
                  key={p.paper_id}
                  className="group grid grid-cols-1 gap-3 px-4 py-3 transition hover:bg-brand-50/30 lg:grid-cols-[40px_minmax(0,3fr)_118px_108px_148px_128px_104px_104px] lg:items-center"
                >
                  {/*
                   * 批量分析勾选框。
                   *
                   * 仅在真实项目渲染；不可分析的论文（仅元数据）**渲染但禁用**，
                   * 而不是不渲染——否则这一列的行高与缩进会参差不齐。
                   * 与 ExplorerPage 里「已加入」的处理方式一致。
                   */}
                  <span className="flex items-center">
                    {isLive && (
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
                        checked={selected.has(p.paper_id)}
                        disabled={p.meta_only || activeJobs.has(p.paper_id) || batchBusy}
                        onChange={() => toggleOne(p.paper_id)}
                        aria-label={`选择「${p.title}」`}
                        title={
                          p.meta_only
                            ? '这篇论文只有元数据、没有 PDF 正文，需先「获取全文」才能分析'
                            : activeJobs.has(p.paper_id)
                              ? '这篇论文已有分析任务在跑，等它结束才能再次提交'
                              : '选择这篇以加入批量分析'
                        }
                      />
                    )}
                  </span>
                  {/* 标题 */}
                  <div className="min-w-0">
                    <Link
                      to={`/project/${pid}/papers/${p.paper_id}`}
                      className="line-clamp-2 text-[13px] font-medium leading-snug text-ink-800 transition group-hover:text-brand-700"
                    >
                      {p.title}
                    </Link>
                    {/*
                     * 仅元数据论文必须在这里标明。
                     * 它和旁边的论文长得一样（有标题、有作者、有年份），
                     * 但旁边那些是从 PDF 正文里读出来的，这一篇只有 S2 的登记信息。
                     * 不标出来，用户会以为「待分析」是「排队等着自动跑」。
                     */}
                    {p.meta_only && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Chip tone="info">仅元数据</Chip>
                        {/*
                         * 「获取全文」只在 live 项目出现。
                         *
                         * Demo 项目的数据是浏览器里的内置 Mock，服务端没有这些论文，
                         * 点下去必然 404。与其把按钮画出来再报错，不如不画。
                         */}
                        {isLive && (
                          <button
                            className="mp-chip bg-brand-50 text-brand-700 transition hover:bg-brand-100 disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={Boolean(fetching[p.paper_id])}
                            onClick={() => void handleFetch(p.paper_id)}
                            title="用元数据里的链接把这篇论文的 PDF 取回来"
                          >
                            {fetching[p.paper_id] ? (
                              <>获取中…</>
                            ) : (
                              <>
                                <IconCloudDownload className="h-3 w-3" />
                                获取全文
                              </>
                            )}
                          </button>
                        )}
                        <span className="text-[11px] text-ink-400">
                          来自论文探索 · 无 PDF，上传后才会抽取方法与证据
                        </span>
                      </div>
                    )}

                    {/*
                     * 刚获取到全文的提示（Phase 3B-7）。
                     *
                     * 为什么需要它：成功之后 meta_only 变 false，整块「仅元数据」
                     * 提示（连按钮）会一起消失，状态徽标则显示「待解析」——
                     * 与一篇刚上传的论文长得一模一样。用户点了按钮、行变了样，
                     * 却看不出到底发生了什么，甚至会怀疑是不是点错了。
                     *
                     * 所以这里给一个明确的收尾：告诉他已经拿到全文、下一步该去哪。
                     * 它只在本次会话内有效（fetchedOk 是内存状态），刷新后就消失——
                     * 那时用户已经知道自己做过什么，不需要再被提醒。
                     */}
                    {fetchedOk[p.paper_id] && !p.meta_only && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-1.5">
                        <IconCheck className="h-3 w-3 shrink-0 text-emerald-600" />
                        <span className="text-[11px] leading-relaxed text-emerald-700">
                          <b>已获取全文</b>，现在可以分析了
                        </span>
                        <Link
                          to={`/project/${pid}/papers/${p.paper_id}`}
                          className="text-[11px] font-medium text-emerald-800 underline decoration-emerald-300 underline-offset-2 hover:decoration-emerald-600"
                        >
                          去论文详情页开始解析
                        </Link>
                      </div>
                    )}

                    {/*
                     * 获取失败必须在这里如实显示，而且要说清"没拿到"。
                     *
                     * 它挂在论文行下方而不是弹一个 toast：toast 几秒后就消失了，
                     * 而用户可能是批量点了几篇之后才回来看，那时已经忘了哪篇失败。
                     * 这一栏会一直留到他再次尝试或刷新页面。
                     */}
                    {fetchError[p.paper_id] && (
                      <div className="mt-1.5 flex items-start gap-1.5 rounded-md bg-rose-50 px-2 py-1.5">
                        <IconAlert className="mt-px h-3 w-3 shrink-0 text-rose-600" />
                        <span className="text-[11px] leading-relaxed text-rose-700">
                          <b>无法获取全文</b>：{fetchError[p.paper_id]}
                        </span>
                      </div>
                    )}
                    <div className="mt-1 flex flex-wrap gap-1 lg:hidden">
                      <Chip tone="neutral">{p.year}</Chip>
                      <Chip tone="brand">{p.task || '未分类任务'}</Chip>
                    </div>
                  </div>

                  {/* 作者 */}
                  <div className="min-w-0">
                    <p className="truncate text-[12px] text-ink-600">
                      {p.authors[0] || '（未识别）'}
                    </p>
                    <p className="font-mono text-[11px] tabular-nums text-ink-400">
                      {p.year}
                      {p.authors.length > 1 ? ` · +${p.authors.length - 1}` : ''}
                    </p>
                  </div>

                  {/* 来源 / 会议 */}
                  <div className="hidden lg:block">
                    {isLive ? (
                      <span className="line-clamp-2 break-all text-[11px] leading-tight text-ink-500">
                        {p.source}
                      </span>
                    ) : (
                      <span className="text-[11.5px] text-ink-500">{p.venue}</span>
                    )}
                  </div>

                  {/* 任务 */}
                  <div className="hidden lg:block">
                    {p.task ? (
                      <Chip tone="brand">{p.task}</Chip>
                    ) : (
                      <span className="text-[11px] text-ink-300">—</span>
                    )}
                  </div>

                  {/* 方法标签 */}
                  <div className="flex flex-wrap gap-1">
                    {pMethods.slice(0, 2).map((m) => (
                      <Link
                        key={m.method_id}
                        to={`/project/${pid}/methods?focus=${m.method_id}`}
                        className="mp-chip bg-sky-50 text-sky-700 transition hover:bg-sky-100"
                      >
                        {m.name.length > 20 ? `${m.name.slice(0, 20)}…` : m.name}
                      </Link>
                    ))}
                    {pMethods.length === 0 && <span className="text-[11px] text-ink-300">—</span>}
                  </div>

                  {/* 状态 */}
                  <div>
                    <StatusBadge status={p.status} />

                    {/*
                     * 批量分析的进度 / 失败原因，挂在论文自己的行上。
                     *
                     * 不只用 toast：批量可能一次跑好几篇，toast 几秒就没了，
                     * 用户回头看时已经忘了是哪一篇出的问题。
                     * 这一栏会留到他刷新页面或重新提交为止。
                     */}
                    {batchPhase[p.paper_id] && (
                      <div className="mt-1">
                        {batchPhase[p.paper_id] === 'failed' ? (
                          <span className="flex items-start gap-1 text-[11px] leading-snug text-rose-600">
                            <IconAlert className="mt-px h-3 w-3 shrink-0" />
                            <span>{BATCH_LABEL.failed}：{batchError[p.paper_id] ?? '未知原因'}</span>
                          </span>
                        ) : (
                          <span
                            className={
                              batchPhase[p.paper_id] === 'done'
                                ? 'flex items-center gap-1 text-[11px] text-emerald-600'
                                : 'flex items-center gap-1 text-[11px] text-brand-600'
                            }
                          >
                            {batchPhase[p.paper_id] === 'done' ? (
                              <IconCheck className="h-3 w-3 shrink-0" />
                            ) : (
                              <span className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-brand-300 border-t-brand-600" />
                            )}
                            {BATCH_LABEL[batchPhase[p.paper_id]]}
                          </span>
                        )}
                      </div>
                    )}

                    {/*
                     * 已有 job 在跑 → 明确标出来，否则用户只会看到复选框是灰的，
                     * 不知道为什么点不动（可能以为界面坏了）。
                     */}
                    {activeJobs.has(p.paper_id) && !batchPhase[p.paper_id] && (
                      <div className="mt-1">
                        <span className="flex items-center gap-1 text-[11px] text-ink-400">
                          <span className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-ink-300 border-t-ink-500" />
                          已有任务在跑
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Evidence —— 从已加载的数据集里取，不再回落到浏览器 Demo 知识库 */}
                  <div className="flex justify-start lg:justify-end">
                    <EvidenceButton
                      count={p.evidence_count}
                      onClick={() => {
                        const first = evidence.find((e) => e.paper_id === p.paper_id)
                        if (first) openEvidence(first.evidence_id)
                      }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/*
       * 批量分析固定操作栏（Phase 3B-9）。
       *
       * 只在真实项目、且列表里确实有可分析论文时出现——
       * Demo 项目没有可提交的对象，画一条永远灰着的操作栏只会误导。
       *
       * sticky bottom-4：列表长的时候按钮始终停在视线内，
       * 不用勾完再滚回顶部找入口。与论文探索页的批量加入栏保持一致的观感。
       */}
      {isLive && selectable.length > 0 && (
        <div className="sticky bottom-4 z-20">
          <Card className="flex flex-wrap items-center justify-between gap-3 border-brand-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-[13px] font-medium text-ink-800">
                已选择 {selected.size} 篇
              </span>
              {selected.size > 0 && (
                <span className="font-mono text-[11px] tabular-nums text-ink-500">
                  进行中 {tallies.running} · 已完成 {tallies.done} · 失败 {tallies.failed}
                </span>
              )}
              {selected.size === 0 && (
                <span className="text-[11.5px] text-ink-400">
                  勾选论文左侧的复选框，可一次提交多篇分析
                </span>
              )}
              {batchSummary && (
                <span className="text-[11.5px] text-ink-500">{batchSummary}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {selected.size > 0 && (
                <button
                  className="mp-btn mp-btn-ghost"
                  onClick={() => {
                    setSelected(new Set())
                    setBatchSummary(null)
                  }}
                  disabled={batchBusy}
                >
                  清空选择
                </button>
              )}
              <button
                className="mp-btn mp-btn-primary"
                disabled={selected.size === 0 || batchBusy}
                onClick={() => void submitBatch()}
                title={
                  selected.size === 0
                    ? '先勾选要分析的论文'
                    : '逐篇串行提交，一篇失败不影响其余'
                }
              >
                {batchBusy ? '分析中…' : `批量分析${selected.size > 0 ? `（${selected.size}）` : ''}`}
              </button>
            </div>
          </Card>
        </div>
      )}

      {/* 说明 */}
      <SectionTitle
        title="关于文献库"
        subtitle={
          isLive
            ? '这一页的每个字段都来自你上传的 PDF，不是预置演示数据'
            : '演示项目的数据全部为内置 Mock，用于展示完整交互'
        }
      />
      <div className="grid gap-3 md:grid-cols-3">
        {[
          {
            t: '解析状态',
            d: isLive
              ? '上传后由服务端 PyMuPDF 解析章节结构，状态通过任务轮询实时回传。'
              : '演示数据，解析结果为预置内容。',
          },
          {
            t: '方法标签',
            d: isLive
              ? '由抽取引擎从正文识别并回填。点击标签可跳到方法地图查看该方法出自哪一页。'
              : '演示数据，方法与论文的对应关系为预置内容。',
          },
          {
            t: 'Evidence 计数',
            d: isLive
              ? '每篇论文锚定的原文证据条数，全部经服务端逐字回验。点击数字可直接打开证据抽屉。'
              : '演示数据中的证据条数。',
          },
        ].map((x) => (
          <Card key={x.t} className="p-4">
            <p className="text-[13px] font-semibold text-ink-800">{x.t}</p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-500">{x.d}</p>
          </Card>
        ))}
      </div>
    </div>
  )
}
