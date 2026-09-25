/**
 * 研究空白页（Phase 4-6 UI）。
 *
 * ── 这个页面最重要的一条设计约束 ──
 *
 * `stated`（论文原文明确写出的局限）与 `candidate`（系统跨论文聚簇推断）
 * **必须是两个独立区块**，绝不能合成一个列表、也不能只用一个标签区分。
 *
 * 理由：这两类东西对用户的含义完全不同 ——
 *   · stated 是**事实**，用户可以直接把那句话引用进自己的综述；
 *   · candidate 是**线索**，是"我们注意到好几篇论文都没做 X"，
 *     它可能是真的缺口，也可能是我们聚错了。
 * 把它们混在一个列表里，用户扫一眼只会看到"15 个研究空白"，
 * 而其中 12 个其实是系统猜的 —— 这是本功能最容易造成误导的地方。
 *
 * 所以：stated 在上、candidate 在下，各有自己的小节头与统计，
 * candidate 区块整体带琥珀色警示底色，每条卡片带「候选」徽标。
 *
 * ── 三个页面状态 ──
 *   error  : 接口出错 → ErrorState（真错误）
 *   empty  : 接口成功但 0 条 Gap → EmptyState（**不是**错误）
 *   normal : 有 Gap → 两个区块
 *
 * 「empty 不是 error」这一点很关键：真实语料当前大概率只产出个位数
 * stated、0 条 candidate，那是**正常且诚实的结果**，
 * 写成"加载失败"会让用户以为工具坏了。
 * 页面按 `context.corpus_has_gap_intent` 给出两种不同的措辞：
 *   false → "当前语料没有足够 Evidence"
 *   true  → "有线索但还没形成 Gap"
 */

import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { clsx } from 'clsx'
import { PageHeader } from '@/components/AppLayout'
import {
  Card,
  Chip,
  EmptyState,
  ErrorState,
  GapTypeBadge,
  IconAlert,
  IconArrowRight,
  IconLightbulb,
  IconQuote,
  IconSearch,
  IconSparkles,
  IconTarget,
  LoadingState,
  ProgressBar,
  SectionTitle,
} from '@/components/ui'
import { useEvidenceDrawer, useToast } from '@/context/AppContext'
import {
  api,
  type ResearchGapsResponse,
  type ServerGapAssertionLevel,
  type ServerGapFinding,
  type ServerGapSignal,
} from '@/services/api'
import {
  DEMO_PROJECT_ID,
  loadDataset,
  registerDataset,
  type ProjectDataset,
} from '@/services/projectData'
import {
  getDirectionsOfGap,
  getEvidenceOfGap,
  getGapDistribution,
  getGaps,
  getMethod,
  getPaper,
} from '@/services/selectors'
import type { GapType } from '@/types'

/* ------------------------------------------------------------------ */
/* 缺口信号类型 → 人话                                                  */
/* ------------------------------------------------------------------ */

/**
 * 服务端 `gap_signal` 四种机器码。
 *
 * 为什么要单独一套文案而不是复用 `GapTypeBadge`：
 * 那是 Demo 知识库的四类人工标注空白（topic/method/data/application），
 * 分类维度不同（那是"缺什么"，这是"缺口长什么样"）。
 * 混用会让用户以为是同一套分类，从而把 candidate 也当成人工标注结论。
 */
const SIGNAL_META: Record<ServerGapSignal, { label: string; desc: string; cls: string }> = {
  limitation: {
    label: '明确局限',
    desc: '论文原文承认自身方法存在未能解决的问题',
    cls: 'bg-rose-50 text-rose-700',
  },
  open_problem: {
    label: '开放问题',
    desc: '论文把某个问题列为尚未解决 / 留给未来工作',
    cls: 'bg-amber-50 text-amber-700',
  },
  missing_comparison: {
    label: '缺失对比',
    desc: '论文指出缺少某类基线或某场景下的对照实验',
    cls: 'bg-sky-50 text-sky-700',
  },
  uncovered_setting: {
    label: '未覆盖场景',
    desc: '论文说明其方法尚未在某个场景 / 条件下验证',
    cls: 'bg-violet-50 text-violet-700',
  },
}

const signalMeta = (s: string) =>
  SIGNAL_META[s as ServerGapSignal] ?? {
    label: s,
    desc: '',
    cls: 'bg-ink-100 text-ink-600',
  }

/** 场景主题机器名 → 中文。与服务端 THEME_PATTERNS 的 label 对齐，兜底显示原名 */
const THEME_LABEL: Record<string, string> = {
  long_horizon: '长程任务',
  repository_level: '仓库级场景',
  multi_agent: '多智能体协作',
  memory_context: '记忆与上下文',
  tool_use: '工具调用',
  search_planning: '搜索与规划',
  evaluation_bench: '评测基准',
  cost_efficiency: '成本与效率',
  safety_security: '安全与可靠',
  feedback_signal: '反馈信号',
  generalization: '泛化能力',
  general: '通用',
}

const themeLabel = (t: string) => THEME_LABEL[t] ?? t

/**
 * `gap_type_guess` → 人话。
 *
 * 这个字段名带 `_guess` 是服务端刻意的 —— 它是**由措辞推出的弱推测**，
 * 不是从证据里读出的事实。所以这里渲染时**必须**带"推测"字样，
 * 不能只写"方法层面"，否则用户会当成结论。
 */
const GUESS_LABEL: Record<ServerGapFinding['gap_type_guess'], string> = {
  method: '方法层面',
  data: '数据层面',
  evaluation: '评测层面',
  application: '应用层面',
}

/** `evidence_skipped` 之类的统计是否值得单独提示 */
const hasWarnings = (s: ResearchGapsResponse['stats']) =>
  s.gaps_without_evidence > 0

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

export function GapsPage() {
  const { id } = useParams()
  const pid = id ?? DEMO_PROJECT_ID

  const [dataset, setDataset] = useState<ProjectDataset | null>(null)
  const [loadedPid, setLoadedPid] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [resp, setResp] = useState<ResearchGapsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  /* ── 数据集（Demo 走本地、Live 走接口）── */

  useEffect(() => {
    let alive = true
    loadDataset(pid)
      .then((r) => {
        if (!alive) return
        setDataset(r.dataset)
        setLoadError(null)
        setLoadedPid(pid)
        /*
         * ⚠️ Live 证据回链的**前提**。
         *
         * EvidenceDrawer 挂在 <Routes> 之外，只能按 evidence_id 反查注册表；
         * 查不到时会**回落到 Demo 的 getEvidence()**（EvidenceDrawer.tsx）。
         * 于是点开真实项目的 #E001，抽屉里显示演示论文的原文 ——
         * 看起来完全正常，实际张冠李戴。
         */
        registerDataset(r.dataset)
      })
      .catch((e: unknown) => {
        if (!alive) return
        /*
         * 加载失败必须**显式记下来**。
         *
         * 早期写法只把 dataset 置 null，结果 `isLive` 变 false，
         * 渲染层就落入 Demo 分支 —— 一个不存在的项目 id 会显示
         * 演示知识库的人工标注空白（G001~G005），看起来完全正常。
         * 这与 EvidenceDrawer 回落 Demo 是同一类错误：
         * **把演示数据伪装成对用户项目的分析结论**。
         * 所以这里必须留下痕迹，由渲染层显示错误态。
         */
        setDataset(null)
        setLoadError(e instanceof Error ? e.message : String(e))
        setLoadedPid(pid)
      })
    return () => {
      alive = false
    }
  }, [pid, reloadKey])

  /* ── Gap 接口（仅 Live）── */

  useEffect(() => {
    /*
     * Demo 不发这个请求：它的空白来自知识库人工标注，
     * 服务端对该项目也没有 bundle，调了只会拿到 404。
     *
     * 守卫用 `return` 早退、**不在 effect 里同步清空 state** ——
     * 清空交给下面的 `readResp` / `readError` 派生完成，
     * 既是唯一事实来源，也不触发 set-state-in-effect 告警。
     */
    if (dataset?.source !== 'live') return

    let alive = true
    api
      .listGaps(pid)
      .then((r) => {
        if (!alive) return
        setResp(r)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setResp(null)
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [pid, dataset, reloadKey])

  const isLive = dataset?.source === 'live'

  /**
   * 只有 Live 才认接口结果。
   *
   * 从渲染路径上直接切断，而不是"进 Demo 分支时手动 set 成 null" ——
   * 后者依赖 effect 执行时机，存在中间态。
   */
  const readResp = isLive ? resp : null
  const readError = isLive ? error : null

  /** 数据集尚未就绪（首次进入或切换项目） */
  const loading = loadedPid !== pid || (isLive && !readResp && !readError)

  if (loading) {
    return (
      <div className="mp-anim-fade-up space-y-5">
        <PageHeader title="研究空白" subtitle="正在加载研究空白分析…" />
        <LoadingState label="正在加载研究空白…" />
      </div>
    )
  }

  /*
   * ── 数据集加载失败：**必须**走错误态，不能落入 Demo 分支 ──
   *
   * 顺序很关键：这一段必须在 Demo 分支**之前**。
   * 因为 loadError 时 `dataset` 是 null，`isLive` 为 false，
   * 若先判 `!isLive → Demo`，不存在的项目就会显示演示知识库的空白列表。
   */
  if (loadError) {
    return (
      <div className="mp-anim-fade-up space-y-5">
        <PageHeader title="研究空白" subtitle="识别尚未被解决的共性问题" />
        <ErrorState
          title="项目加载失败"
          description={`无法加载项目 ${pid}：${loadError}`}
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      </div>
    )
  }

  /* ── Live：接口真错误 ── */
  if (readError) {
    return (
      <div className="mp-anim-fade-up space-y-5">
        <PageHeader title="研究空白" subtitle="识别尚未被解决的共性问题" />
        <ErrorState
          title="研究空白加载失败"
          description={readError}
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      </div>
    )
  }

  if (isLive && readResp) {
    return <LiveGapsView pid={pid} resp={readResp} />
  }

  return <DemoGapsView pid={pid} />
}

/* ================================================================== */
/* Live：新 Gap API 的两个分区                                          */
/* ================================================================== */

function LiveGapsView({ pid, resp }: { pid: string; resp: ResearchGapsResponse }) {
  const stated = useMemo(
    () => resp.gaps.filter((g) => g.assertion_level === 'stated'),
    [resp],
  )
  const candidate = useMemo(
    () => resp.gaps.filter((g) => g.assertion_level === 'candidate'),
    [resp],
  )

  const { stats, context } = resp

  /*
   * 统计一致性自检：服务端给的 stats 必须与前端数出来的条数一致。
   * 不一致说明服务端统计口径漂移（表现为"标题写 3 条、下面只列 2 条"），
   * 与其静默显示一个错的数字，不如把矛盾摆出来。
   */
  const statMismatch =
    stats.stated !== stated.length ||
    stats.candidate !== candidate.length ||
    stats.total !== resp.gaps.length

  const isEmpty = resp.gaps.length === 0

  return (
    <div className="mp-anim-fade-up space-y-5" data-gaps-page="live">
      <PageHeader
        title="研究空白"
        subtitle="从论文原文的局限陈述出发，识别尚未被解决的共性问题"
        meta={
          <>
            <Chip tone="brand" >
              <span data-gap-stat="total">{stats.total}</span>&nbsp;项空白
            </Chip>
            <Chip tone="success">
              原文明确&nbsp;<span data-gap-stat="stated">{stats.stated}</span>
            </Chip>
            <Chip tone="neutral">
              系统推断&nbsp;<span data-gap-stat="candidate">{stats.candidate}</span>
            </Chip>
            <Chip tone="neutral">{stats.papers_involved} 篇涉及论文</Chip>
          </>
        }
      />

      {/* 规则版本 / 运行时自检 */}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
        <span className="mp-chip bg-ink-100 text-ink-500">
          确定性规则 · {context.rule_version}
        </span>
        <span>
          语料：{context.papers} 篇论文 / {context.methods} 个方法 / {context.evidence} 条证据
        </span>
        {context.evidence_with_gap_intent === 0 && (
          <span>· 其中 0 条带缺口标注</span>
        )}
      </div>

      {/* 服务端不变量自检 —— 正常恒为空，非空必须显眼 */}
      {hasWarnings(stats) && (
        <div
          data-gap-warning="no-evidence"
          className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50/70 px-3.5 py-3 text-[12px] text-rose-700"
        >
          <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            数据自检未通过：{stats.gaps_without_evidence} 条空白没有关联证据。
            本功能要求每个空白都必须能回链到原文，此处的数据不可信。
          </p>
        </div>
      )}

      {statMismatch && (
        <div
          data-gap-warning="stat-mismatch"
          className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-3 text-[12px] text-amber-800"
        >
          <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            统计口径不一致：服务端标注共 {stats.total} 项（明确 {stats.stated} / 推断{' '}
            {stats.candidate}），实际返回 {resp.gaps.length} 项（明确 {stated.length} / 推断{' '}
            {candidate.length}）。
          </p>
        </div>
      )}

      {isEmpty ? (
        <GapEmptyState context={context} />
      ) : (
        <>
          {/* 信号类型分布 */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {(
              [
                ['limitation', stats.limitation],
                ['open_problem', stats.open_problem],
                ['missing_comparison', stats.missing_comparison],
                ['uncovered_setting', stats.uncovered_setting],
              ] as [ServerGapSignal, number][]
            ).map(([sig, count]) => {
              const m = SIGNAL_META[sig]
              return (
                <div key={sig} data-gap-signal-card={sig}>
                  <Card className="p-3.5">
                    <p className="text-[11.5px] text-ink-500">{m.label}</p>
                    <div className="mt-2 flex items-baseline gap-1">
                      <span className="text-[26px] font-semibold leading-none tabular-nums text-ink-800">
                        {count}
                      </span>
                      <span className="text-[11px] text-ink-400">项</span>
                    </div>
                    <p className="mt-2 text-[10.5px] leading-snug text-ink-400">{m.desc}</p>
                  </Card>
                </div>
              )
            })}
          </div>

          {/* ── 分区一：原文明确指出 ── */}
          <section data-gap-section="stated">
            <SectionTitle
              title="论文明确指出"
              subtitle="论文原文自己承认的局限 / 开放问题 —— 可直接引用"
              action={
                <Chip tone="success">
                  <span data-gap-stat="stated-section">{stated.length}</span> 项
                </Chip>
              }
            />
            {stated.length === 0 ? (
              <div
                data-gap-empty="stated"
                className="rounded-xl border border-dashed border-ink-200 bg-ink-50/60 px-4 py-8 text-center"
              >
                <p className="text-[13px] font-medium text-ink-600">没有原文明确写出的空白</p>
                <p className="mt-1 text-[11.5px] text-ink-400">
                  当前语料里没有任何一条证据明确写出局限、开放问题或缺失对比。
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {stated.map((g, i) => (
                  <GapCard key={g.gap_id} pid={pid} gap={g} index={i + 1} />
                ))}
              </div>
            )}
          </section>

          {/* ── 分区二：系统推断候选 ── */}
          <section data-gap-section="candidate">
            <SectionTitle
              title="候选空白（系统推断）"
              subtitle="系统跨论文聚簇得到的线索 —— 不是论文的原话，只应作为研究方向参考"
              action={
                <Chip tone="neutral">
                  <span data-gap-stat="candidate-section">{candidate.length}</span> 项
                </Chip>
              }
            />
            <div
              data-gap-candidate-notice="1"
              className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-3 text-[12px] leading-relaxed text-amber-800"
            >
              <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>
                以下内容由系统根据多篇论文的共同缺失**推断**得出，**不是任何一篇论文的原话**。
                推断可能出错，请结合下方证据自行判断，不要直接当作既有结论引用。
              </p>
            </div>
            {candidate.length === 0 ? (
              <div
                data-gap-empty="candidate"
                className="rounded-xl border border-dashed border-ink-200 bg-ink-50/60 px-4 py-8 text-center"
              >
                <p className="text-[13px] font-medium text-ink-600">没有系统推断出的候选空白</p>
                <p className="mt-1 text-[11.5px] text-ink-400">
                  推断型空白需要至少两篇不同论文指向同一个语义缺口
                  {stats.single_paper_signals > 0
                    ? `；当前有 ${stats.single_paper_signals} 条单篇线索，但不足两篇，未升级为候选。`
                    : '；当前语料里没有这样的共现线索。'}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {candidate.map((g, i) => (
                  <GapCard key={g.gap_id} pid={pid} gap={g} index={i + 1} tone="candidate" />
                ))}
              </div>
            )}
          </section>

          {/* 判定口径说明 —— 统计数字要能自解释 */}
          <div>
            <SectionTitle
              title="判定口径"
              subtitle="为什么有些空白标成「候选」而不是结论"
            />
            <div className="grid gap-3 md:grid-cols-3">
              {[
                {
                  n: '01',
                  t: '每条空白必挂证据',
                  d: `当前 ${stats.total} 项空白全部关联了原文证据（自检结果：${
                    stats.gaps_without_evidence === 0 ? '通过' : '未通过'
                  }）。没有证据的空白不会被产出。`,
                },
                {
                  n: '02',
                  t: '原文明确 vs 系统推断',
                  d: '论文自己写出的局限直接归入「明确」；跨论文聚簇得到的线索一律标为「候选」，并明写推断二字。',
                },
                {
                  n: '03',
                  t: '候选需要跨论文共现',
                  d: `推断型空白要求至少两篇不同论文指向同一语义缺口。当前被判定为证据不足的单篇线索有 ${stats.single_paper_signals} 条。`,
                },
              ].map((x) => (
                <Card key={x.n} className="p-4">
                  <span className="font-mono text-[11px] font-semibold text-brand-500">{x.n}</span>
                  <p className="mt-1.5 text-[13px] font-semibold text-ink-800">{x.t}</p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-ink-500">{x.d}</p>
                </Card>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 空状态：必须区分"没人写过局限"与"写了但不够成 Gap"                    */
/* ------------------------------------------------------------------ */

function GapEmptyState({ context }: { context: ResearchGapsResponse['context'] }) {
  return (
    <div data-gap-empty="all">
      <EmptyState
        icon={<IconTarget className="h-5 w-5" />}
        title="当前语料没有足够 Evidence"
        description={
          context.corpus_has_gap_intent
            ? `已扫描 ${context.papers} 篇论文、${context.evidence} 条证据，` +
              `其中 ${context.evidence_with_gap_intent} 条带有缺口标注，` +
              '但都不足以构成一个可回链的研究空白。'
            : `已扫描 ${context.papers} 篇论文、${context.evidence} 条证据，` +
              '其中没有任何一条明确写出局限、开放问题或缺失对比。' +
              '研究空白只能从论文自己的陈述出发，所以这里暂时没有可报告的结果。'
        }
      />
      <p className="mt-3 text-center text-[11.5px] text-ink-400">
        这不是加载失败 —— 接口正常返回了 0 条结果。
        增加与本领域相关的论文，或补充带局限陈述的全文证据后，这里会出现内容。
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Gap 卡片                                                            */
/* ------------------------------------------------------------------ */

function GapCard({
  pid,
  gap,
  index,
  tone = 'stated',
}: {
  pid: string
  gap: ServerGapFinding
  index: number
  tone?: ServerGapAssertionLevel
}) {
  const { open: openEvidence } = useEvidenceDrawer()
  const [params, setParams] = useSearchParams()
  const isOpen = params.get('focus') === gap.gap_id

  const setFocus = () => {
    const next = new URLSearchParams(params)
    if (isOpen) next.delete('focus')
    else next.set('focus', gap.gap_id)
    setParams(next, { replace: true })
  }

  const sig = signalMeta(gap.gap_signal)
  const isCandidate = tone === 'candidate'

  /*
   * 证据去重后展开。只取 id 列表本身，原文交给全局抽屉 ——
   * 页面里再复制一份原文会让"以抽屉为准"变成"以页面为准"，
   * 两处一旦不一致，用户无法判断哪个是权威。
   */
  const evidenceIds = gap.evidence_ids

  return (
    <div
      data-gap-id={gap.gap_id}
      data-gap-level={gap.assertion_level}
      data-gap-signal={gap.gap_signal}
      className={clsx(
        'overflow-hidden rounded-xl border bg-white transition',
        isCandidate ? 'border-amber-200' : 'border-ink-200',
        isOpen && (isCandidate ? 'border-amber-300 shadow-[0_0_0_3px_var(--color-amber-50)]' : 'border-brand-300 shadow-[0_0_0_3px_var(--color-brand-50)]'),
      )}
    >
      <div className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] font-semibold text-ink-400">
              {String(index).padStart(2, '0')}
            </span>
            {isCandidate ? (
              <span
                data-gap-badge="candidate"
                className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-amber-800"
              >
                <IconSparkles className="h-2.5 w-2.5" />
                候选 · 系统推断
              </span>
            ) : (
              <span
                data-gap-badge="stated"
                className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-emerald-800"
              >
                <IconQuote className="h-2.5 w-2.5" />
                论文明确指出
              </span>
            )}
            <span className={clsx('rounded-md px-1.5 py-0.5 text-[10.5px] font-medium', sig.cls)}>
              {sig.label}
            </span>
            <Link
              to={`/project/${pid}/methods?focus=${gap.theme}`}
              className="rounded-md bg-ink-100 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-600 transition hover:bg-ink-200"
              title="场景主题"
            >
              主题：{themeLabel(gap.theme)}
            </Link>
            <span className="font-mono text-[10.5px] text-ink-400">{gap.gap_id}</span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-ink-400">
            <span>
              置信度{' '}
              <span
                data-gap-confidence={gap.confidence.toFixed(2)}
                className={clsx(
                  'font-medium tabular-nums',
                  isCandidate ? 'text-amber-700' : 'text-ink-700',
                )}
              >
                {gap.confidence.toFixed(2)}
              </span>
            </span>
          </div>
        </div>

        <button onClick={setFocus} className="mt-2.5 block w-full text-left">
          <h3 className="text-[15px] font-semibold leading-snug tracking-tight text-ink-900 transition hover:text-brand-700">
            {gap.title}
          </h3>
        </button>

        <p
          data-gap-description="1"
          className="mt-2 text-[12.5px] leading-relaxed text-ink-600"
        >
          {gap.description}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            data-gap-evidence-open={evidenceIds[0] ?? ''}
            onClick={() => evidenceIds[0] && openEvidence(evidenceIds[0])}
            className="mp-btn mp-btn-ghost !py-1.5 !text-[12px]"
          >
            <IconQuote className="h-3 w-3" /> 查看 Evidence（{evidenceIds.length}）
          </button>
          <Link
            to={`/project/${pid}/directions`}
            className="mp-btn mp-btn-soft !py-1.5 !text-[12px]"
          >
            <IconSparkles className="h-3 w-3" /> 生成研究方向
          </Link>
          <button
            onClick={setFocus}
            className="ml-auto flex items-center gap-1 text-[12px] font-medium text-brand-600 transition hover:text-brand-700"
          >
            {isOpen ? '收起' : '展开详情'}
            <IconArrowRight
              className={clsx('h-3 w-3 transition-transform', isOpen && 'rotate-90')}
            />
          </button>
        </div>
      </div>

      {isOpen && (
        <div className="border-t border-ink-200 bg-ink-50/50 p-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
            {/* 左：证据回链 */}
            <div>
              <p className="mp-label mb-2">支撑证据（{evidenceIds.length}）</p>
              <div className="space-y-1.5" data-gap-evidence-list="1">
                {evidenceIds.map((eid) => (
                  <button
                    key={eid}
                    data-gap-evidence-id={eid}
                    onClick={() => openEvidence(eid)}
                    className="flex w-full items-center gap-2 rounded-lg border border-ink-200 bg-white px-2.5 py-2 text-left transition hover:border-brand-200 hover:bg-brand-50/40"
                  >
                    <span className="font-mono text-[10.5px] font-semibold text-brand-600">
                      #{eid}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-500">
                      点击在原文中查看这句话
                    </span>
                    <IconArrowRight className="h-3 w-3 shrink-0 text-ink-300" />
                  </button>
                ))}
              </div>

              {/* 判定依据 */}
              <p className="mp-label mb-2 mt-3.5">判定依据</p>
              <div className="flex flex-wrap gap-1.5" data-gap-basis="1">
                {gap.basis.map((b) => (
                  <span key={b} className="mp-chip bg-ink-100 text-ink-600">
                    {BASIS_LABEL[b] ?? b}
                  </span>
                ))}
              </div>
            </div>

            {/* 右：涉及对象 */}
            <div className="space-y-3">
              <div>
                <p className="mp-label mb-2">缺口方面（推测）</p>
                <span
                  data-gap-guess={gap.gap_type_guess}
                  className="mp-chip bg-violet-50 text-violet-700"
                >
                  推测属于「{GUESS_LABEL[gap.gap_type_guess]}」· 由措辞推断，非证据原文
                </span>
              </div>

              <div>
                <p className="mp-label mb-2">涉及论文（{gap.paper_ids.length}）</p>
                <div className="flex flex-wrap gap-1.5">
                  {gap.paper_ids.map((pp) => (
                    <Link
                      key={pp}
                      to={`/project/${pid}/papers/${pp}`}
                      className="mp-chip bg-sky-50 text-sky-700 transition hover:bg-sky-100"
                    >
                      {pp}
                    </Link>
                  ))}
                </div>
              </div>

              <div>
                <p className="mp-label mb-2">涉及方法（{gap.method_ids.length}）</p>
                <div className="flex flex-wrap gap-1.5">
                  {gap.method_ids.length === 0 ? (
                    <span className="text-[11.5px] text-ink-400">未定位到具体方法</span>
                  ) : (
                    gap.method_ids.map((mid) => (
                      <Link
                        key={mid}
                        to={`/project/${pid}/methods?focus=${mid}`}
                        className="mp-chip bg-brand-50 text-brand-700 transition hover:bg-brand-100"
                      >
                        {mid}
                      </Link>
                    ))
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-brand-200 bg-gradient-to-br from-brand-50 to-white p-3">
                <p className="flex items-center gap-1.5 text-[12px] font-semibold text-brand-800">
                  <IconLightbulb className="h-3.5 w-3.5" />
                  下一步
                </p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-600">
                  {isCandidate
                    ? '这是系统推断的候选缺口，建议先核对证据再决定是否据此生成研究方向。'
                    : '这是论文自己写出的空白，可直接作为研究方向的依据。'}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 服务端 `basis` 机器码 → 人话。
 *
 * 与 MethodsPage 的 BASIS_LABEL 同款理由：rule-based 判定的全部价值
 * 在于过程可复核。只给一个"明确局限"标签而不说依据，
 * 用户只能选择相信或不信。
 */
const BASIS_LABEL: Record<string, string> = {
  explicit_limitation_statement: '原文写明局限',
  explicit_open_problem: '原文列为开放问题',
  missing_comparison_statement: '原文指出缺少对比',
  uncovered_setting_statement: '原文说明场景未覆盖',
  evidence_ownership_verified: '证据归属已核验',
  evidence_substantive_text: '证据含实质文本',
  evidence_declared_gap_support: '证据标注了「研究空白」',
  evidence_declared_limitation_support: '证据标注了「局限」',
  multi_paper_shared_gap: '多篇论文共同缺失',
  single_paper_stated_only: '仅单篇论文提及',
  addressed_by_later_work: '已有后续工作解决',
  theme_matched: '命中场景词表',
  theme_general: '未匹配到具体场景',
}

/* ================================================================== */
/* Demo：知识库人工标注（行为与原页面一致）                              */
/* ================================================================== */

function DemoGapsView({ pid }: { pid: string }) {
  const [params, setParams] = useSearchParams()
  const { open: openEvidence } = useEvidenceDrawer()
  const { push } = useToast()

  const [typeFilter, setTypeFilter] = useState<GapType | 'all'>('all')
  const gaps = getGaps()
  const dist = getGapDistribution()

  const filtered = gaps.filter((g) => typeFilter === 'all' || g.type === typeFilter)
  const focusId = params.get('focus')

  const setFocus = (gid: string) => {
    const next = new URLSearchParams(params)
    if (focusId === gid) next.delete('focus')
    else next.set('focus', gid)
    setParams(next, { replace: true })
  }

  const totalEvidence = [...new Set(gaps.flatMap((g) => g.evidence_ids))].length
  const totalPapers = [...new Set(gaps.flatMap((g) => g.supporting_papers))].length

  return (
    <div className="mp-anim-fade-up space-y-5" data-gaps-page="demo">
      <PageHeader
        title="研究空白"
        subtitle="AI 通过对跨论文证据做对比归因，识别尚未被解决的共性问题"
        meta={
          <>
            <Chip tone="brand">{gaps.length} 项空白</Chip>
            <Chip tone="neutral">{totalPapers} 篇支撑论文</Chip>
            <Chip tone="success">{totalEvidence} 条证据</Chip>
          </>
        }
        actions={
          <button
            className="mp-btn mp-btn-primary"
            onClick={() =>
              push({
                title: '已生成研究方向',
                description: '基于当前空白推导出 3 个候选研究方向',
                tone: 'success',
              })
            }
          >
            <IconSparkles className="h-3.5 w-3.5" /> 批量生成研究方向
          </button>
        }
      />

      {/* 类型统计 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {dist.map((d) => {
          const active = typeFilter === d.type
          return (
            <button
              key={d.type}
              onClick={() => setTypeFilter(active ? 'all' : (d.type as GapType))}
              className="text-left"
            >
              <Card hover className={clsx('p-3.5', active && 'border-brand-300 bg-brand-50/50')}>
                <p className="text-[11.5px] text-ink-500">{d.label}</p>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-[26px] font-semibold leading-none tabular-nums text-ink-800">
                    {d.count}
                  </span>
                  <span className="text-[11px] text-ink-400">项</span>
                </div>
                <div className="mt-2.5">
                  <ProgressBar value={d.count} max={Math.max(...dist.map((x) => x.count))} />
                </div>
              </Card>
            </button>
          )
        })}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="该类型下暂无研究空白"
          description="试着切换其他类型查看"
          icon={<IconSearch className="h-5 w-5" />}
          action={
            <button className="mp-btn mp-btn-soft" onClick={() => setTypeFilter('all')}>
              查看全部
            </button>
          }
        />
      ) : (
        <div className="space-y-4">
          {filtered.map((g, i) => {
            const isOpen = focusId === g.gap_id
            const evList = getEvidenceOfGap(g.gap_id)
            const relatedDirections = getDirectionsOfGap(g.gap_id)
            const papers = g.supporting_papers.map((p2) => getPaper(p2)).filter(Boolean)

            return (
              <Card
                key={g.gap_id}
                className={clsx(
                  'overflow-hidden transition',
                  isOpen && 'border-brand-300 shadow-[0_0_0_3px_var(--color-brand-50)]',
                )}
              >
                <div className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] font-semibold text-ink-400">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <GapTypeBadge type={g.type} />
                      <span className="font-mono text-[10.5px] text-ink-400">{g.gap_id}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-ink-400">
                      <span>
                        支撑论文 <span className="font-medium text-ink-600">{papers.length}</span>
                      </span>
                      <span>
                        Evidence{' '}
                        <span className="font-medium text-ink-600">{g.evidence_ids.length}</span>
                      </span>
                    </div>
                  </div>

                  <button onClick={() => setFocus(g.gap_id)} className="mt-2.5 block w-full text-left">
                    <h3 className="text-[15.5px] font-semibold leading-snug tracking-tight text-ink-900 transition hover:text-brand-700">
                      {g.title}
                    </h3>
                  </button>

                  <p className="mt-2 text-[12.5px] leading-relaxed text-ink-600">{g.description}</p>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => openEvidence(g.evidence_ids[0])}
                      className="mp-btn mp-btn-ghost !py-1.5 !text-[12px]"
                    >
                      查看 Evidence
                    </button>
                    <Link
                      to={`/project/${pid}/directions`}
                      className="mp-btn mp-btn-soft !py-1.5 !text-[12px]"
                    >
                      <IconSparkles className="h-3 w-3" /> 生成研究方向
                    </Link>
                    <button
                      onClick={() => setFocus(g.gap_id)}
                      className="ml-auto flex items-center gap-1 text-[12px] font-medium text-brand-600 transition hover:text-brand-700"
                    >
                      {isOpen ? '收起' : '展开分析'}
                      <IconArrowRight
                        className={clsx('h-3 w-3 transition-transform', isOpen && 'rotate-90')}
                      />
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-ink-200 bg-ink-50/50 p-4">
                    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
                      <div className="space-y-3">
                        <div className="rounded-xl border border-ink-200 bg-white p-3.5">
                          <p className="mp-label mb-1.5">已有研究</p>
                          <p className="text-[12.5px] leading-relaxed text-ink-700">
                            {g.existing_work}
                          </p>
                        </div>
                        <div className="rounded-xl border border-amber-100 bg-amber-50/50 p-3.5">
                          <p className="mp-label mb-1.5 text-amber-600">当前问题</p>
                          <p className="text-[12.5px] leading-relaxed text-ink-700">
                            {g.current_problem}
                          </p>
                        </div>
                        <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-3.5">
                          <p className="mp-label mb-1.5 text-emerald-600">潜在研究价值</p>
                          <p className="text-[12.5px] leading-relaxed text-ink-700">
                            {g.potential_value}
                          </p>
                        </div>
                      </div>

                      <div className="space-y-3">
                        <div>
                          <p className="mp-label mb-2">支撑论文（{papers.length}）</p>
                          <div className="space-y-1.5">
                            {papers.map(
                              (p) =>
                                p && (
                                  <Link
                                    key={p.paper_id}
                                    to={`/project/${pid}/papers/${p.paper_id}`}
                                    className="flex items-center gap-2 rounded-lg border border-ink-200 bg-white px-2.5 py-2 transition hover:border-brand-200 hover:bg-brand-50/40"
                                  >
                                    <span className="w-9 shrink-0 font-mono text-[11px] font-semibold tabular-nums text-ink-400">
                                      {p.year}
                                    </span>
                                    <span className="min-w-0 flex-1 line-clamp-2 text-[11.5px] leading-snug text-ink-700">
                                      {p.title}
                                    </span>
                                    <IconArrowRight className="h-3 w-3 shrink-0 text-ink-300" />
                                  </Link>
                                ),
                            )}
                          </div>
                        </div>

                        <div>
                          <p className="mp-label mb-2">支撑证据（{evList.length}）</p>
                          <div className="space-y-1.5">
                            {evList.map((ev) => (
                              <button
                                key={ev.evidence_id}
                                onClick={() => openEvidence(ev.evidence_id)}
                                className="block w-full rounded-lg border border-ink-200 bg-white p-2.5 text-left transition hover:border-brand-200 hover:bg-brand-50/40"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-[10.5px] font-semibold text-brand-600">
                                    #{ev.evidence_id}
                                  </span>
                                  <span className="text-[10.5px] text-ink-400">{ev.section}</span>
                                  <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-400">
                                    {ev.confidence.toFixed(2)}
                                  </span>
                                </div>
                                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-ink-500">
                                  {ev.translation}
                                </p>
                              </button>
                            ))}
                          </div>
                        </div>

                        <div>
                          <p className="mp-label mb-2">涉及方法</p>
                          <div className="flex flex-wrap gap-1.5">
                            {g.method_ids.map((mid) => {
                              const m = getMethod(mid)
                              if (!m) return null
                              return (
                                <Link
                                  key={mid}
                                  to={`/project/${pid}/methods?focus=${mid}`}
                                  className="mp-chip bg-sky-50 text-sky-700 transition hover:bg-sky-100"
                                >
                                  {m.name}
                                </Link>
                              )
                            })}
                          </div>
                        </div>

                        {relatedDirections.length > 0 && (
                          <div className="rounded-xl border border-brand-200 bg-gradient-to-br from-brand-50 to-white p-3">
                            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-brand-800">
                              <IconLightbulb className="h-3.5 w-3.5" />
                              已由此空白推导出 {relatedDirections.length} 个方向
                            </p>
                            <div className="mt-2 space-y-1.5">
                              {relatedDirections.map((d) => (
                                <Link
                                  key={d.direction_id}
                                  to={`/project/${pid}/directions?focus=${d.direction_id}`}
                                  className="block rounded-lg border border-brand-100 bg-white px-2.5 py-2 transition hover:border-brand-300"
                                >
                                  <p className="text-[12px] font-medium leading-snug text-ink-800">
                                    {d.title}
                                  </p>
                                  <div className="mt-1 flex items-center gap-2">
                                    <Chip tone="success">可行性 {d.feasibility}</Chip>
                                    <Chip tone="brand">新颖性 {d.novelty}</Chip>
                                  </div>
                                </Link>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}

      <div>
        <SectionTitle
          title="空白判定方法"
          subtitle="系统如何避免把个别论文的局限性误判为领域级研究空白"
        />
        <div className="grid gap-3 md:grid-cols-3">
          {[
            {
              n: '01',
              t: '多源交叉验证',
              d: '同一问题必须由至少两个独立来源（不同论文的 Limitations、评测分析或讨论章节）指向，才被判定为领域级空白。',
            },
            {
              n: '02',
              t: '证据强度加权',
              d: '每条证据带置信度，覆盖论文数量与证据置信度共同决定该空白的优先级排序。',
            },
            {
              n: '03',
              t: '可推导性检查',
              d: '空白必须能推导出可验证的研究方向，否则降级为「观察」而非正式空白。',
            },
          ].map((x) => (
            <Card key={x.n} className="p-4">
              <span className="font-mono text-[11px] font-semibold text-brand-500">{x.n}</span>
              <p className="mt-1.5 text-[13px] font-semibold text-ink-800">{x.t}</p>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink-500">{x.d}</p>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
