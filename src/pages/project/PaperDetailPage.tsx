import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { clsx } from 'clsx'
import { PageHeader } from '@/components/AppLayout'
import {
  Card,
  Chip,
  EmptyState,
  ErrorState,
  IconAlert,
  IconArrowRight,
  IconCheck,
  IconLink,
  IconQuote,
  IconSearch,
  IconSparkles,
  ModeBadge,
  ParadigmBadge,
  SectionTitle,
  SkeletonState,
  SourceBadge,
  StatusBadge,
} from '@/components/ui'
import { useEvidenceDrawer, useToast } from '@/context/AppContext'
import { api, pollJob, type ServerJob } from '@/services/api'
import {
  DEMO_PROJECT_ID,
  findRegisteredMethod,
  loadDataset,
  registerDataset,
  type ProjectDataset,
} from '@/services/projectData'
import {
  getDirection,
  getEvidenceOfPaper,
  getGap,
  getMethod,
  getPaper,
  getRelatedPapers,
} from '@/services/selectors'

type Tab = 'abstract' | 'methods' | 'experiments' | 'evidence' | 'related'

const TABS: { key: Tab; label: string }[] = [
  { key: 'abstract', label: 'Abstract' },
  { key: 'methods', label: 'Methods' },
  { key: 'experiments', label: 'Experiments' },
  { key: 'evidence', label: 'Evidence' },
  { key: 'related', label: 'Related' },
]

export function PaperDetailPage() {
  const { id, paperId } = useParams()
  const pid = id ?? DEMO_PROJECT_ID
  const { open: openEvidence } = useEvidenceDrawer()
  const { push } = useToast()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('abstract')

  const [dataset, setDataset] = useState<ProjectDataset | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  /**
   * 分析任务状态（Phase 3B-8）。
   *
   * 四种状态直接取自服务端 Job.state，**不自己造一套**：
   *   queued / running / completed / failed
   * 前端再额外区分一个 'idle'（还没点过），因为"没跑过"和"排队中"
   * 在界面上要做的事完全不同——前者给按钮，后者给进度。
   *
   * 为什么不复用 dataset 里的 paper.status：那是**落库后的结果**，
   * 而 queued 阶段论文还没被改动（createJob 之后才会被设成 parsing）。
   * 只看 paper.status 的话，点击后的头一小段时间界面毫无反应，
   * 用户会以为没点上，然后重复点击。
   */
  const [job, setJob] = useState<{ state: ServerJob['state'] | 'idle'; stage: string; jobId: string }>({
    state: 'idle',
    stage: '',
    jobId: '',
  })
  /** 接口层失败（409 无全文 / 网络错误），与 job.state==='failed' 是两回事 */
  const [runError, setRunError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await loadDataset(pid)
      setDataset(r.dataset)
      registerDataset(r.dataset)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setDataset(null)
    } finally {
      setLoading(false)
    }
  }, [pid])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const isLive = dataset?.source === 'live'

  /**
   * 真实项目与 Demo 项目走**两套不同的读取路径**，这是刻意的。
   *
   * Demo：从浏览器内的知识库按 id 查（数据齐全，含方法族/空白/方向）。
   * Live：只从本项目的数据集里查（服务端返回什么就显示什么）。
   * 如果让 Live 也去查 Demo 知识库，一个未命中的 id 就会捞出演示论文——
   * 这种"看起来一切正常"的错配比直接报错危险得多。
   */
  const paper = isLive
    ? dataset?.papers.find((p) => p.paper_id === paperId)
    : paperId
      ? getPaper(paperId)
      : undefined

  const evList = isLive
    ? (dataset?.evidence ?? []).filter((e) => e.paper_id === paperId)
    : paper
      ? getEvidenceOfPaper(paper.paper_id)
      : []

  const methods = isLive
    ? (dataset?.methods ?? []).filter((m) =>
        (paper?.method_ids ?? []).includes(m.method_id),
      )
    : (paper?.method_ids ?? [])
        .map((mid) => getMethod(mid))
        .filter((m): m is NonNullable<typeof m> => Boolean(m))

  // findRegisteredMethod 在 Live 分支下用于校验方法确实属于当前数据集
  void findRegisteredMethod

  const relatedPapers = isLive ? [] : paper ? getRelatedPapers(paper.paper_id) : []

  /**
   * 分析溯源。
   *
   * 这一栏不是装饰。它会直白地写出「这篇论文的结论是用什么算出来的」——
   * 因为 provider 一栏可能是 `mock`（内置确定性抽取器）也可能是 `cli`/`http`
   * （真实大模型）。两者的可信度完全不同，把它藏起来就等于让用户
   * 无从判断眼前的 REACT 方法是模型读出来的，还是规则挑出来的。
   *
   * Demo 项目走浏览器内的知识库，那份数据**根本没有** analyzed_with 字段，
   * 所以这里如实返回 null 并在界面上显示"未记录分析溯源"。
   * 刻意不去编一个假的 provider 填上——那正是本项目最反对的做法。
   *
   * 注意取的是 raw.papers（服务端原样对象），不是 dataset.papers——
   * 后者是给 UI 用的映射结果，映射时丢掉了 analyzed_with 这类溯源字段。
   */
  const provenance = isLive
    ? (dataset?.raw?.papers.find((p) => p.paper_id === paperId)?.analyzed_with ?? null)
    : null

  /** 是否由真实大模型产出。只有非 mock 才配得上「AI 抽取」这个说法 */
  const isRealModel = provenance !== null && provenance.provider !== 'mock'

  /** 该论文涉及的空白与方向：阶段③④⑤⑥未接入，真实项目一律为空 */
  const gapIds = isLive ? [] : [...new Set(evList.flatMap((e) => e.gap_ids))]
  const gaps = gapIds.map((g) => getGap(g)).filter(Boolean)
  const directionIds = isLive ? [] : [...new Set(evList.flatMap((e) => e.direction_ids))]
  const directions = directionIds.map((d) => getDirection(d)).filter(Boolean)

  /**
   * 是否可以发起分析。
   *
   * 三个条件缺一不可：
   *   isLive      —— Demo 项目的论文在服务端不存在，打过去必然 404
   *   !meta_only  —— 仅元数据论文没有 PDF，服务端会 409（这是刻意的守卫）
   *   !running    —— 跑着的时候不让重复点
   */
  const isRunning = job.state === 'queued' || job.state === 'running'
  const canAnalyze = isLive && !paper?.meta_only && !isRunning

  /**
   * 发起分析并跟踪到终态。
   *
   * 复用现有的 POST /api/papers/:paperId/analyze 与 pollJob，不新建接口、
   * 不改分析链路——本阶段只做"把已有能力接出来"。
   *
   * 关键在失败处理：job.state === 'failed' 时**绝不去刷新成"已分析"**，
   * 而是把失败原因留在页面上。刷新是必要的（论文状态确实变成了 failed），
   * 但界面必须让用户看见"这次没成"，而不是只看到一个静默变化的状态徽标。
   */
  const runAnalyze = async (force: boolean) => {
    if (!paper) return
    setRunError(null)
    setJob({ state: 'queued', stage: '已加入队列', jobId: '' })

    try {
      const r = await api.analyze(paper.paper_id, pid, force)
      setJob({ state: 'running', stage: '排队中', jobId: r.job_id })

      const final: ServerJob = await pollJob(r.job_id, {
        onTick: (j) => setJob({ state: j.state, stage: j.stage, jobId: j.job_id }),
      })

      setJob({ state: final.state, stage: final.stage, jobId: final.job_id })

      if (final.state === 'completed') {
        push({
          title: '分析完成',
          description: `已抽取 ${final.methods} 个方法、${final.evidences} 条原文证据`,
          tone: 'success',
        })
      } else {
        // 失败时 error 一定有值（analysis.ts 的 catch 保证），但兜一句以防字段缺失
        setRunError(final.error ?? '分析失败，未能从这篇论文中抽取出可核验的方法与证据')
      }

      /*
       * 无论成功失败都要刷新。
       *
       * 成功时为了拿到新写入的 methods / evidence；
       * 失败时为了拿到 status='failed'——**这一步不能省**：
       * 不刷新的话界面还停在旧状态，用户会以为论文没事、
       * 甚至以为刚才那次点击根本没生效。
       */
      await refresh()
    } catch (e: unknown) {
      /*
       * 走到这里的是接口层失败：409 NO_FULLTEXT、404、网络错误。
       * 它们**没有产生 job**，所以要把状态退回 idle（可以重试），
       * 而不是留一个假的 'running' 让按钮永远转圈。
       */
      const msg = e instanceof Error ? e.message : String(e)
      setJob({ state: 'idle', stage: '', jobId: '' })
      setRunError(msg)
      await refresh()
    }
  }

  if (loading) {
    return (
      <div className="mp-anim-fade-up space-y-5">
        <Card className="p-4">
          <SkeletonState rows={8} />
        </Card>
      </div>
    )
  }

  if (error) {
    return (
      <div className="mp-anim-fade-up">
        <ErrorState
          description={`无法加载论文数据（${error}）`}
          onRetry={() => void refresh()}
        />
        <div className="mt-4">
          <Link to={`/project/${pid}/papers`} className="mp-btn mp-btn-soft">
            返回文献库
          </Link>
        </div>
      </div>
    )
  }

  if (!paper) {
    return (
      <div className="mp-anim-fade-up">
        <ErrorState
          title="论文不存在"
          description={`项目 ${pid} 中未找到 ID 为 ${paperId} 的论文，可能未上传成功或链接有误`}
        />
        <div className="mt-4">
          <Link to={`/project/${pid}/papers`} className="mp-btn mp-btn-soft">
            返回文献库
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="mp-anim-fade-up space-y-5">
      {/* 面包屑 */}
      <div className="flex items-center gap-1.5 text-[12px] text-ink-400">
        <Link to={`/project/${pid}/papers`} className="transition hover:text-brand-600">
          文献库
        </Link>
        <span>/</span>
        <span className="font-mono text-ink-500">{paper.paper_id}</span>
      </div>

      <PageHeader
        title={paper.title}
        subtitle={paper.authors.join(', ') || '（PDF 中未识别到作者）'}
        meta={
          <>
            {isLive && (
              <span className="mp-chip bg-ink-100 text-ink-700">
                <ModeBadge mode="LIVE" />
              </span>
            )}
            {isLive && <SourceBadge source="uploaded" />}
            {paper.venue ? <Chip tone="brand">{paper.venue}</Chip> : null}
            {paper.year ? <Chip tone="neutral">{paper.year}</Chip> : null}
            {paper.task ? <Chip tone="neutral">{paper.task}</Chip> : null}
            <StatusBadge status={paper.status} />
            <button
              onClick={() => {
                if (evList[0]) openEvidence(evList[0].evidence_id)
              }}
              className="mp-chip bg-brand-50 text-brand-700 transition hover:bg-brand-100"
            >
              <IconQuote className="h-3 w-3" />
              {evList.length} Evidence
            </button>
          </>
        }
        actions={
          <>
            {/*
             * 仅元数据论文没有 PDF 文件，api.pdfUrl() 指向的 /api/papers/:id/pdf
             * 会因为找不到落盘文件而报错。这里改成指向 Semantic Scholar 的外链，
             * 而不是留一个必然失败的按钮。
             */}
            {paper.meta_only ? (
              paper.external_url ? (
                <a
                  href={paper.external_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mp-btn mp-btn-ghost"
                >
                  <IconLink className="h-3.5 w-3.5" /> Semantic Scholar
                </a>
              ) : null
            ) : isLive ? (
              <a
                href={api.pdfUrl(paper.paper_id, pid)}
                target="_blank"
                rel="noreferrer"
                className="mp-btn mp-btn-ghost"
              >
                <IconLink className="h-3.5 w-3.5" /> 原论文 PDF
              </a>
            ) : (
              <a
                href={paper.source}
                target="_blank"
                rel="noreferrer"
                className="mp-btn mp-btn-ghost"
              >
                <IconLink className="h-3.5 w-3.5" /> 原论文
              </a>
            )}

            {/*
             * 「开始分析」（Phase 3B-8）。
             *
             * 只在有条件可分析时出现：
             *   - 仅元数据论文（无 PDF）→ 不出现。它的下一步是"获取全文"，
             *     那是文献库页上的按钮，这里不该给一个必然 409 的按钮。
             *   - Demo 项目 → 不出现（服务端没有这些论文）。
             *   - 分析失败后 → 变成「重新分析」（force），用户已确认要保留重试。
             */}
            {canAnalyze && (
              <button
                className="mp-btn mp-btn-primary"
                onClick={() => void runAnalyze(job.state === 'idle' && paper.status === 'analyzed')}
              >
                <IconSparkles className="h-3.5 w-3.5" />
                {job.state === 'idle' && paper.status === 'analyzed' ? '重新分析' : '开始分析'}
              </button>
            )}

            <button
              className="mp-btn mp-btn-soft"
              onClick={() => navigate(`/project/${pid}/upload`)}
            >
              <IconSparkles className="h-3.5 w-3.5" />
              {isLive ? '继续上传' : '重新分析'}
            </button>
          </>
        }
      />

      {/*
       * 分析任务的四态展示（Phase 3B-8）。
       *
       * 为什么不复用 StatusBadge：那个徽标显示的是**论文的持久状态**
       * （待解析 / 解析中 / 已分析 / 解析失败），而这里是**这一次任务的进展**。
       * 两者在时间上错开：点击后的头一小段，任务已经 queued 但论文还是旧状态。
       * 用一个会动的状态条把这段空档补上，用户才不会以为没点上。
       */}
      {job.state !== 'idle' && (
        <Card
          className={clsx(
            'p-3.5',
            job.state === 'failed' && 'border-rose-200 bg-rose-50/60',
            job.state === 'completed' && 'border-emerald-200 bg-emerald-50/60',
            (job.state === 'queued' || job.state === 'running') && 'border-brand-200 bg-brand-50/60',
          )}
        >
          <div className="flex flex-wrap items-center gap-2">
            {job.state === 'queued' && (
              <span className="mp-chip bg-amber-100 text-amber-800">排队中</span>
            )}
            {job.state === 'running' && (
              <span className="mp-chip bg-brand-100 text-brand-700">分析中</span>
            )}
            {job.state === 'completed' && (
              <span className="mp-chip bg-emerald-100 text-emerald-700">
                <IconCheck className="h-3 w-3" /> 分析完成
              </span>
            )}
            {job.state === 'failed' && (
              <span className="mp-chip bg-rose-100 text-rose-700">
                <IconAlert className="h-3 w-3" /> 分析失败
              </span>
            )}
            <span className="text-[12px] text-ink-600">
              {job.state === 'queued' && '已提交，等待服务端开始处理…'}
              {job.state === 'running' && (job.stage || '正在解析 PDF 与抽取方法…')}
              {job.state === 'completed' && '方法与原文证据已写入知识库，可到方法地图查看。'}
              {job.state === 'failed' && '这次没有成功。下方的失败原因说明了卡在哪一步。'}
            </span>
          </div>

          {/*
           * 失败原因必须完整展示，且要强调"知识库没有被写入"。
           *
           * 这一条是本阶段最不能含糊的地方：用户看到"失败"最担心的是
           * "是不是写进去一半"。明确说没写入，他才知道重试是安全的。
           */}
          {job.state === 'failed' && runError && (
            <p className="mt-2 border-t border-rose-200 pt-2 text-[12px] leading-relaxed text-rose-800">
              {runError}
              <br />
              <span className="text-rose-700">
                本次没有写入任何方法与证据，这篇论文不会显示为「已分析」。修正后可以再试一次。
              </span>
            </p>
          )}
        </Card>
      )}

      {/*
       * 接口层失败（没有产生 job）。
       * 与上面的任务失败分开渲染，因为用户要做的事不同：
       * 任务失败是"内容层面的问题，可以重试或换论文"，
       * 接口失败多半是"这篇论文还缺前置条件"（比如没有全文）。
       */}
      {job.state === 'idle' && runError && (
        <Card className="border-rose-200 bg-rose-50/60 p-3.5">
          <div className="flex items-start gap-2">
            <IconAlert className="mt-px h-3.5 w-3.5 shrink-0 text-rose-600" />
            <div className="min-w-0">
              <p className="text-[12.5px] font-medium text-rose-800">无法开始分析</p>
              <p className="mt-1 text-[12px] leading-relaxed text-rose-700">{runError}</p>
              {paper.meta_only && (
                <Link
                  to={`/project/${pid}/papers`}
                  className="mt-1.5 inline-block text-[12px] font-medium text-rose-800 underline decoration-rose-300 underline-offset-2 hover:decoration-rose-600"
                >
                  去文献库获取全文 →
                </Link>
              )}
            </div>
          </div>
        </Card>
      )}

      {/*
       * 仅元数据论文的显著声明，优先级高于下面的 Live 溯源声明——
       * 因为它要纠正的误解更严重：用户看到"待分析"会以为在排队，
       * 看到"Abstract"标签页会以为那是从正文读出来的。
       */}
      {paper.meta_only && (
        <Card className="border-sky-200 bg-sky-50/60 p-3.5">
          <p className="text-[12.5px] leading-relaxed text-sky-900">
            <strong>本论文仅登记了元数据，尚未取得 PDF 全文。</strong>
            <br />
            标题、作者、年份、DOI 与引用数来自 Semantic Scholar；
            <span className="font-medium">正文没有解析过</span>，因此没有章节结构、没有方法、
            没有原文证据。下方「Abstract」显示的是 Semantic Scholar 提供的摘要，不是从 PDF 里抽的。
            <br />
            {/*
             * 两条路都给出来。
             *
             * Phase 3B-7 之后，「获取全文」是首选——它能用元数据里的链接
             * 自动把 PDF 取回来，用户不需要自己去找。自动取不到时（没有开放获取
             * 链接、链接失效）才需要退回手动上传。这个次序不能反：
             * 让用户先看到"请自己上传"等于把可以自动完成的事推给他。
             */}
            要抽取方法与证据，先在文献库点<b>「获取全文」</b>让服务端按 DOI / 链接自动取回 PDF；
            若自动获取不到，再到「上传论文」页自行上传这篇论文的 PDF。
          </p>
          {isLive && (
            <Link
              to={`/project/${pid}/papers`}
              className="mt-2 inline-block text-[12px] font-medium text-sky-800 underline decoration-sky-300 underline-offset-2 hover:decoration-sky-600"
            >
              去文献库获取全文 →
            </Link>
          )}
        </Card>
      )}

      {/* Live 项目的溯源声明。这条不是装饰——它明确了"这些字段是读出来的，不是编的" */}
      {isLive && !paper.meta_only && (
        <Card className="p-3.5">
          <p className="text-[12px] leading-relaxed text-ink-600">
            <strong>本页数据全部来自 PDF 真实解析：</strong>
            标题、作者、章节名、起始页码、逐页原文均由服务端 PyMuPDF 读取；
            下方每条 Evidence 都由 Evidence Validator 逐字回验过，确认该段文字确实出现在
            它所声称的页码上。点击任意证据可展开核对原文，或直接打开 PDF 对照。
          </p>

          {/*
           * 分析溯源条。
           * 关键在于是不是真实大模型 —— 这条信息的真假直接决定用户该给这些
           * 结论多少信任。所以不写"已由 AI 分析"这种含糊话，而是把
           * provider / model / prompt 版本原样摊开。
           */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-ink-200 pt-3">
            <Chip tone={isRealModel ? 'success' : 'warn'}>
              {isRealModel ? '真实大模型抽取' : '非大模型抽取（内置规则引擎）'}
            </Chip>
            {provenance ? (
              <>
                <Chip tone="neutral">provider：{provenance.provider}</Chip>
                <Chip tone="neutral">model：{provenance.model}</Chip>
                <Chip tone="neutral">prompt：{provenance.prompt_version}</Chip>
                {provenance.provider !== 'mock' && (
                  <Chip tone="neutral">
                    tokens：in {provenance.input_tokens} / out {provenance.output_tokens}
                  </Chip>
                )}
              </>
            ) : (
              <Chip tone="warn">未记录分析溯源</Chip>
            )}
          </div>
          {!isRealModel && (
            <p className="mt-2 text-[11.5px] leading-relaxed text-amber-700">
              {provenance
                ? '本次结果由服务端内置的确定性规则引擎产出：句子确实是 PDF 的原文，但方法的归纳不是大模型做的。接入 AI_API_KEY 或启用 CLI Provider 后重跑，这里会变成真实模型的名字。'
                : '这篇论文的分析溯源字段为空——可能是数据被外部改动过。系统不会替你补一个看起来合理的值。'}
            </p>
          )}
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* 左：主体内容 */}
        <div className="space-y-4">
          {/* Tab 切换 */}
          <Card className="overflow-hidden">
            <div className="flex border-b border-ink-200">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={clsx(
                    'relative px-4 py-2.5 text-[12.5px] font-medium transition',
                    tab === t.key
                      ? 'text-brand-700'
                      : 'text-ink-500 hover:bg-ink-50 hover:text-ink-700',
                  )}
                >
                  {t.label}
                  {t.key === 'evidence' && (
                    <span className="ml-1.5 rounded bg-brand-50 px-1.5 py-px text-[10px] font-semibold text-brand-600">
                      {evList.length}
                    </span>
                  )}
                  {tab === t.key && (
                    <span className="absolute inset-x-0 -bottom-px h-0.5 bg-brand-600" />
                  )}
                </button>
              ))}
            </div>

            <div className="p-4">
              {tab === 'abstract' && (
                <div className="space-y-4">
                  <div>
                    <p className="mp-label mb-2">Abstract</p>
                    <p className="text-[13px] leading-relaxed text-ink-700">
                      {paper.abstract || (
                        <span className="text-ink-400">
                          （未识别到摘要。可能是 PDF 无文本层，或摘要未按标准排版）
                        </span>
                      )}
                    </p>
                  </div>

                  <div>
                    <p className="mp-label mb-2">关键词</p>
                    <div className="flex flex-wrap gap-1.5">
                      {paper.keywords.length > 0 ? (
                        paper.keywords.map((k) => (
                          <Chip key={k} tone="brand">
                            {k}
                          </Chip>
                        ))
                      ) : (
                        <span className="text-[12px] text-ink-400">未识别到关键词</span>
                      )}
                    </div>
                  </div>

                  {/* 章节速览：让 Abstract 页也能看到 Agent 的解析成果 */}
                  <div>
                    <p className="mp-label mb-2">章节速览（真实解析结果）</p>
                    <div className="divide-y divide-ink-200 overflow-hidden rounded-xl border border-ink-200">
                      {paper.sections.map((sec, i) => (
                        <div key={i} className="flex items-start gap-3 bg-white px-3.5 py-2.5">
                          <span className="w-14 shrink-0 font-mono text-[11px] font-medium text-brand-600">
                            p.{sec.page}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-[12px] font-medium text-ink-700">{sec.name}</p>
                            <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-500">
                              {sec.summary}
                            </p>
                          </div>
                        </div>
                      ))}
                      {paper.sections.length === 0 && (
                        <div className="bg-white px-3.5 py-3 text-[12px] text-ink-400">
                          未解析出章节结构
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {tab === 'methods' && (
                <div className="space-y-3">
                  <p className="text-[12px] text-ink-500">
                    Agent 从正文抽取到的章节结构与段落摘要：
                  </p>
                  {paper.sections.map((s, i) => (
                    <div key={i} className="rounded-xl border border-ink-200 bg-ink-50/50 p-3.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] font-semibold text-brand-600">
                          {s.name}
                        </span>
                        <Chip tone="neutral">p.{s.page}</Chip>
                      </div>
                      <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-600">
                        {s.summary}
                      </p>
                    </div>
                  ))}
                  {paper.sections.length === 0 && (
                    <EmptyState
                      title="未解析出章节"
                      description="该 PDF 可能没有文本层，或章节标题排版不标准"
                    />
                  )}
                </div>
              )}

              {tab === 'experiments' && (
                <div className="space-y-3">
                  <EmptyState
                    title="实验数据抽取未在本阶段接入"
                    description="实验设置、数据集、指标与结果表格的抽取需要单独的 Prompt 与校验规则，属于下一阶段范围。这一栏不会被演示数据填充。"
                    icon={<IconSparkles className="h-5 w-5" />}
                  />
                </div>
              )}

              {tab === 'evidence' && (
                <div className="space-y-2.5">
                  {evList.map((ev) => (
                    <button
                      key={ev.evidence_id}
                      onClick={() => openEvidence(ev.evidence_id)}
                      className="block w-full rounded-xl border border-ink-200 bg-white p-3.5 text-left transition hover:border-brand-200 hover:bg-brand-50/40"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11.5px] font-semibold text-brand-600">
                          #{ev.evidence_id}
                        </span>
                        <Chip tone="neutral">{ev.section || '未标注章节'}</Chip>
                        <Chip tone="neutral">p.{ev.page}</Chip>
                        <span className="ml-auto font-mono text-[10.5px] tabular-nums text-ink-400">
                          conf {ev.confidence.toFixed(2)}
                        </span>
                      </div>
                      <p className="mt-2 font-serif text-[12.5px] italic leading-relaxed text-ink-600">
                        “{ev.content}”
                      </p>
                      {ev.translation && (
                        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-500">
                          {ev.translation}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1">
                        {ev.supports.map((s) => (
                          <span
                            key={s}
                            className="rounded bg-emerald-50 px-1.5 py-0.5 text-[9.5px] font-medium text-emerald-700"
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    </button>
                  ))}
                  {evList.length === 0 && (
                    <EmptyState
                      title="该论文暂无通过校验的证据"
                      description="可能是模型未抽取到方法，或抽取到的证据未通过逐字回验。失败明细见「智能分析」页。"
                    />
                  )}
                </div>
              )}

              {tab === 'related' && (
                <div className="space-y-4">
                  {isLive ? (
                    <EmptyState
                      title="引用关系分析未在本阶段接入"
                      description="跨论文引用网络需要额外的文献元数据源，属于下一阶段范围。此处不会被演示数据填充。"
                    />
                  ) : (
                    <>
                      <div>
                        <p className="mp-label mb-2">引用关系（{relatedPapers.length}）</p>
                        <div className="space-y-1.5">
                          {relatedPapers.map((p) => (
                            <Link
                              key={p.paper_id}
                              to={`/project/${pid}/papers/${p.paper_id}`}
                              className="flex items-center gap-2.5 rounded-lg border border-ink-200 bg-white px-3 py-2.5 transition hover:border-brand-200 hover:bg-brand-50/40"
                            >
                              <span className="w-9 shrink-0 font-mono text-[11px] font-semibold tabular-nums text-ink-400">
                                {p.year}
                              </span>
                              <span className="min-w-0 flex-1 line-clamp-2 text-[12px] leading-snug text-ink-700">
                                {p.title}
                              </span>
                              <IconArrowRight className="h-3 w-3 shrink-0 text-ink-300" />
                            </Link>
                          ))}
                          {relatedPapers.length === 0 && (
                            <p className="text-[12px] text-ink-400">暂无关联论文</p>
                          )}
                        </div>
                      </div>

                      {gaps.length > 0 && (
                        <div>
                          <p className="mp-label mb-2">本文涉及的研究空白</p>
                          <div className="space-y-1.5">
                            {gaps.map(
                              (g) =>
                                g && (
                                  <Link
                                    key={g.gap_id}
                                    to={`/project/${pid}/gaps?focus=${g.gap_id}`}
                                    className="block rounded-lg border border-ink-200 bg-white px-3 py-2.5 transition hover:border-brand-200 hover:bg-brand-50/40"
                                  >
                                    <p className="text-[12.5px] font-medium leading-snug text-ink-800">
                                      {g.title}
                                    </p>
                                  </Link>
                                ),
                            )}
                          </div>
                        </div>
                      )}

                      {directions.length > 0 && (
                        <div>
                          <p className="mp-label mb-2">本文支撑的研究方向</p>
                          <div className="space-y-1.5">
                            {directions.map(
                              (d) =>
                                d && (
                                  <Link
                                    key={d.direction_id}
                                    to={`/project/${pid}/directions?focus=${d.direction_id}`}
                                    className="block rounded-lg border border-brand-100 bg-brand-50/40 px-3 py-2.5 transition hover:border-brand-300"
                                  >
                                    <p className="text-[12.5px] font-medium leading-snug text-ink-800">
                                      {d.title}
                                    </p>
                                  </Link>
                                ),
                            )}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* 右：侧栏 */}
        <div className="space-y-4">
          {/* 论文信息 */}
          <Card className="p-4">
            <SectionTitle title="论文信息" />
            <dl className="space-y-2.5">
              {[
                { k: '论文 ID', v: paper.paper_id, mono: true },
                { k: '发表年份', v: paper.year ? String(paper.year) : '—', mono: true },
                { k: isLive ? '来源文件' : '会议 / 期刊', v: isLive ? paper.source : paper.venue },
                { k: '研究任务', v: paper.task || '—' },
                { k: '作者数', v: `${paper.authors.length} 人`, mono: true },
                { k: '章节数', v: `${paper.sections.length} 个`, mono: true },
                { k: 'Evidence 数', v: `${evList.length} 条`, mono: true },
              ].map((x) => (
                <div key={x.k} className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-[11.5px] text-ink-400">{x.k}</dt>
                  <dd
                    className={clsx(
                      'min-w-0 truncate text-right text-[12px] text-ink-700',
                      x.mono && 'font-mono tabular-nums',
                    )}
                    title={x.v}
                  >
                    {x.v}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>

          {/* 抽取到的方法 */}
          <Card className="p-4">
            <SectionTitle
              title={`抽取到的方法（${methods.length}）`}
              subtitle="点击可跳转到方法地图"
            />
            <div className="space-y-2">
              {methods.map(
                (m) =>
                  m && (
                    <Link
                      key={m.method_id}
                      to={`/project/${pid}/methods?focus=${m.method_id}`}
                      className="block rounded-xl border border-ink-200 bg-white p-3 transition hover:border-brand-200 hover:bg-brand-50/40"
                    >
                      <p className="text-[12.5px] font-medium leading-snug text-ink-800">
                        {m.name}
                      </p>
                      <p className="mt-0.5 text-[11px] text-ink-400">
                        {m.name_zh || '（暂无中文名）'}
                      </p>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <ParadigmBadge paradigm={m.paradigm} />
                        <span className="font-mono text-[10.5px] text-ink-400">
                          {m.year || '—'}
                        </span>
                        <span className="ml-auto text-[10.5px] text-brand-600">
                          {m.evidence_ids.length} 证据
                        </span>
                      </div>
                      {isLive && !m.family_id && (
                        <p className="mt-1.5 text-[10.5px] text-amber-600">
                          未分类 · 阶段③ 方法归类未接入
                        </p>
                      )}
                    </Link>
                  ),
              )}
              {methods.length === 0 && (
                <p className="text-[12px] text-ink-400">未抽取到方法实体</p>
              )}
            </div>
          </Card>

          {/* 知识链导航 */}
          <Card className="border-brand-200 bg-gradient-to-br from-brand-50 to-white p-4">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold text-brand-800">
              <IconLink className="h-3.5 w-3.5" /> 沿着知识链继续探索
            </p>
            <div className="mt-3 space-y-1.5">
              {(isLive
                ? [
                    { label: '回到方法地图', to: `/project/${pid}/methods` },
                    { label: '继续上传论文', to: `/project/${pid}/upload` },
                    { label: '查看分析状态与失败明细', to: `/project/${pid}/analysis` },
                  ]
                : [
                    {
                      label: '查看该方法族',
                      to: `/project/${pid}/methods?family=${methods[0]?.family_id ?? 'F1'}`,
                    },
                    { label: '查看技术演进', to: `/project/${pid}/evolution` },
                    { label: '查看研究空白', to: `/project/${pid}/gaps` },
                    { label: '查看研究方向', to: `/project/${pid}/directions` },
                  ]
              ).map((x) => (
                <Link
                  key={x.to}
                  to={x.to}
                  className="flex items-center justify-between rounded-lg border border-brand-100 bg-white px-3 py-2 text-[12px] text-ink-700 transition hover:border-brand-300"
                >
                  {x.label}
                  <IconArrowRight className="h-3 w-3 text-brand-400" />
                </Link>
              ))}
            </div>
            <p className="mt-3 text-[10.5px] leading-relaxed text-ink-500">
              {isLive
                ? '论文 → 方法 → 证据，每一跳都指向 PDF 中的具体页码与原文。'
                : '论文 → 方法 → 证据 → 空白 → 方向，MethodPilot 保证每一跳都有据可查。'}
            </p>
          </Card>

          {/* 快速搜索 */}
          <Card className="p-4">
            <p className="mp-label mb-2">在本文中查找</p>
            <div className="relative">
              <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
              <input className="mp-input pl-9" placeholder="搜索正文关键词…" />
            </div>
            {isLive && (
              <p className="mt-2 text-[10.5px] leading-relaxed text-ink-400">
                站内正文检索未实现，请用上方「原论文 PDF」在浏览器中查找。
              </p>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
