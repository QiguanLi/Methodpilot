import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { clsx } from 'clsx'
import { PageHeader } from '@/components/AppLayout'
import {
  Card,
  Chip,
  EmptyState,
  IconAlert,
  IconArrowRight,
  IconLightbulb,
  IconQuote,
  IconSparkles,
  ProgressBar,
  SectionTitle,
} from '@/components/ui'
import { useEvidenceDrawer, useToast } from '@/context/AppContext'
import {
  api,
  type ResearchDirectionsResponse,
  type ServerDirectionApproachKind,
  type ServerDirectionBasisLevel,
  type ServerDirectionFinding,
  type ServerGapSignal,
} from '@/services/api'
import { DEMO_PROJECT_ID, loadDataset, registerDataset, type ProjectDataset } from '@/services/projectData'
import {
  getDirection,
  getDirections,
  getEvidenceOfDirection,
  getGap,
  getPaper,
  stats,
} from '@/services/selectors'

/* ================================================================== */
/* 页面入口：数据集加载 + Live / Demo 分流                              */
/* ================================================================== */

/**
 * 三层分流，**顺序不可调换**：
 *
 *   loading   → 数据集尚未就绪
 *   loadError → 数据集加载失败（含项目不存在）
 *   readError → Live 接口报错
 *   Live      → 走新接口
 *   Demo      → 兜底，保持原有手工标注
 *
 * `loadError` 必须排在 Demo 之前：加载失败时 `dataset` 是 null、`isLive` 为 false，
 * 若先判 Demo，**一个不存在的项目 id 会显示演示知识库的 D001~D003** ——
 * 把演示数据伪装成对用户项目的分析结论。这与 EvidenceDrawer 回落 Demo 是同一类错误。
 */
export function DirectionsPage() {
  const { id } = useParams()
  const pid = id ?? DEMO_PROJECT_ID

  const [dataset, setDataset] = useState<ProjectDataset | null>(null)
  const [loadedPid, setLoadedPid] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [resp, setResp] = useState<ResearchDirectionsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

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
         * 查不到时会**回落到 Demo 的 getEvidence()**。于是点开真实项目的证据，
         * 抽屉里显示演示论文的原文 —— 看起来完全正常，实际张冠李戴。
         */
        registerDataset(r.dataset)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setDataset(null)
        setLoadError(e instanceof Error ? e.message : String(e))
        setLoadedPid(pid)
      })
    return () => {
      alive = false
    }
  }, [pid])

  /* ── 方向接口（仅 Live）── */

  useEffect(() => {
    /*
     * Demo 不发这个请求：它的方向来自知识库人工标注，
     * 服务端对该项目也没有 bundle，调了只会拿到 404。
     *
     * 守卫用 `return` 早退、**不在 effect 里同步清空 state** ——
     * 清空交给下面的 `readResp` / `readError` 派生完成，
     * 既是唯一事实来源，也不触发 set-state-in-effect 告警。
     */
    if (dataset?.source !== 'live') return

    let alive = true
    api
      .listDirections(pid)
      .then((r: ResearchDirectionsResponse) => {
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
  }, [pid, dataset])

  const isLive = dataset?.source === 'live'

  /** 只有 Live 才认接口结果 —— 从渲染路径上直接切断，不留中间态 */
  const readResp = isLive ? resp : null
  const readError = isLive ? error : null
  const loading = loadedPid !== pid || (isLive && !readResp && !readError)

  if (loading) {
    return (
      <div className="mp-anim-fade-up space-y-5">
        <PageHeader title="研究方向" subtitle="正在加载研究方向建议…" />
        <div className="mp-card grid place-items-center p-10 text-[12px] text-ink-400">
          正在推导研究方向…
        </div>
      </div>
    )
  }

  /* ── 数据集加载失败：必须走错误态，不能落入 Demo 分支 ── */
  if (loadError) {
    return (
      <div className="mp-anim-fade-up space-y-5" data-directions-page="error">
        <PageHeader title="研究方向" subtitle="项目加载失败" />
        <Card className="border-rose-200 bg-rose-50/60 p-6">
          <div className="flex items-start gap-3">
            <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
            <div>
              <p className="text-[13px] font-semibold text-rose-800">项目加载失败</p>
              <p className="mt-1 text-[12px] leading-relaxed text-rose-700" data-directions-error="load">
                无法加载项目 {pid}：{loadError}
              </p>
              <p className="mt-2 text-[11.5px] text-rose-600/80">
                这里显示的是错误，而不是演示数据 —— 演示知识库不属于你的项目。
              </p>
            </div>
          </div>
        </Card>
      </div>
    )
  }

  if (readError) {
    return (
      <div className="mp-anim-fade-up space-y-5" data-directions-page="error">
        <PageHeader title="研究方向" subtitle="研究方向加载失败" />
        <Card className="border-rose-200 bg-rose-50/60 p-6">
          <div className="flex items-start gap-3">
            <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
            <div>
              <p className="text-[13px] font-semibold text-rose-800">研究方向加载失败</p>
              <p className="mt-1 text-[12px] leading-relaxed text-rose-700" data-directions-error="read">
                {readError}
              </p>
            </div>
          </div>
        </Card>
      </div>
    )
  }

  if (isLive && readResp) {
    return <LiveDirectionsView pid={pid} resp={readResp} />
  }

  return <DemoDirectionsView pid={pid} />
}

/* ================================================================== */
/* Live：新方向 API 的两个分区                                          */
/* ================================================================== */

const LEVEL_META: Record<
  ServerDirectionBasisLevel,
  { label: string; desc: string; tone: 'success' | 'brand' | 'warn' }
> = {
  stated_backed: {
    label: '事实依据',
    desc: '全部依据都是论文原文明确写出的空白 —— 可直接引用',
    tone: 'success',
  },
  mixed: {
    label: '含推断',
    desc: '以论文明确指出的空白为主，另参考了系统推断的候选线索',
    tone: 'brand',
  },
  candidate_only: {
    label: '推测方向',
    desc: '**仅**由系统推断支撑，不是任何论文的原话 —— 仅供参考，需先核实',
    tone: 'warn',
  },
}

const SIGNAL_META_LIVE: Record<ServerGapSignal, string> = {
  limitation: '原文自陈局限',
  open_problem: '原文提出的开放问题',
  missing_comparison: '原文指出缺少对比',
  uncovered_setting: '原文指出未覆盖场景',
}

const APPROACH_KIND_LABEL: Record<ServerDirectionApproachKind, string> = {
  extend_existing: '扩展既有方法',
  combine_existing: '组合既有方法',
  evaluate_existing: '评测既有方法',
  introduce_new: '引入新方法',
}

/** 依据标记的中文说明 —— 让"凭什么成立"可读 */
const BASIS_LABEL_LIVE: Record<string, string> = {
  stated_gap_primary: '以论文明确指出的空白为主要依据',
  candidate_gap_secondary: '参考了系统推断的候选线索',
  candidate_only_evidence: '仅由系统推断支撑（无原文事实）',
  evidence_linked: '关联了可回链的原文证据',
  linked_to_gap: '锚定到具体研究空白',
  method_from_corpus: '切入点取自本项目既有方法',
  no_corpus_method_available: '本项目无可用方法，需引入新方法',
  validation_from_corpus: '验证材料来自语料证据',
  validation_minimal_suggestion: '语料未提供验证材料，仅给出最小建议',
  gap_addressed_by_later_work: '该空白已被后续工作改进（切入点已排除相关方法）',
  theme_from_gap: '主题继承自空白',
  deduplicated_by_overlap: '与其他方向重叠，已合并去重',
  merged_same_coordinate_gaps: '多个同坐标空白合并为一条方向',
}

function LiveDirectionsView({ pid, resp }: { pid: string; resp: ResearchDirectionsResponse }) {
  const factual = useMemo(
    // 「事实依据」= 有原文事实打底的两种（stated_backed / mixed）
    () => resp.directions.filter((d) => d.basis_level !== 'candidate_only'),
    [resp],
  )
  const candidate = useMemo(
    () => resp.directions.filter((d) => d.basis_level === 'candidate_only'),
    [resp],
  )

  const { stats: st, context } = resp

  /*
   * 统计一致性自检：服务端给的 stats 必须与前端数出来的条数一致。
   * 不一致说明统计口径漂移（表现为"标题写 3 条、下面只列 2 条"），
   * 与其静默显示一个错的数字，不如把矛盾摆出来。
   */
  const statMismatch =
    st.stated_backed + st.mixed + st.candidate_only !== st.total ||
    st.total !== resp.directions.length ||
    st.stated_backed !== factual.filter((d) => d.basis_level === 'stated_backed').length ||
    st.candidate_only !== candidate.length

  const isEmpty = resp.directions.length === 0
  const invariantViolations = resp.invariant_violations

  return (
    <div className="mp-anim-fade-up space-y-5" data-directions-page="live">
      <PageHeader
        title="研究方向"
        subtitle="从论文明确指出的空白出发，推导可落地、可验证的研究方向"
        meta={
          <>
            <Chip tone="brand">
              <span data-direction-stat="total">{st.total}</span>&nbsp;个方向
            </Chip>
            <Chip tone="success">
              事实依据&nbsp;<span data-direction-stat="stated_backed">{st.stated_backed}</span>
            </Chip>
            <Chip tone="neutral">
              含推断&nbsp;<span data-direction-stat="mixed">{st.mixed}</span>
            </Chip>
            <Chip tone="warn">
              推测方向&nbsp;<span data-direction-stat="candidate_only">{st.candidate_only}</span>
            </Chip>
            <Chip tone="neutral">{st.papers_involved} 篇论文</Chip>
            <Chip tone="neutral">{st.methods_involved} 个方法</Chip>
          </>
        }
      />

      {/* 规则版本 / 语料规模 */}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
        <span className="mp-chip bg-ink-100 text-ink-500">
          确定性规则 · {context.rule_version}
        </span>
        <span>
          参与计算：{context.gaps_received} 条空白（明确 {context.stated_gaps} / 推断{' '}
          {context.candidate_gaps}）· 方法池 {context.methods_available} 个
        </span>
      </div>

      {/* 服务端不变量自检 —— 正常恒为空，非空必须显眼 */}
      {invariantViolations.length > 0 && (
        <div
          data-direction-warning="invariant"
          className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50/70 px-3.5 py-3 text-[12px] text-rose-700"
        >
          <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <p className="font-semibold">数据自检未通过（{invariantViolations.length} 项）</p>
            <ul className="mt-1 space-y-0.5">
              {invariantViolations.slice(0, 5).map((v) => (
                <li key={v} className="font-mono text-[11px]">
                  {v}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] text-rose-600/80">
              每个研究方向都必须能回链到 Gap 与原文证据。此处数据不可信。
            </p>
          </div>
        </div>
      )}

      {statMismatch && (
        <div
          data-direction-warning="stat-mismatch"
          className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-3 text-[12px] text-amber-800"
        >
          <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            统计口径不一致：服务端标注共 {st.total} 个方向（事实 {st.stated_backed} / 含推断{' '}
            {st.mixed} / 推测 {st.candidate_only}），实际返回 {resp.directions.length} 个。
          </p>
        </div>
      )}

      {isEmpty ? (
        <DirectionEmptyState context={context} />
      ) : (
        <>
          {/* ── 分区一：有事实依据（stated_backed + mixed）── */}
          <section data-direction-section="factual">
            <SectionTitle
              title="事实依据"
              subtitle="依据至少一条论文原文明确写出的空白 —— 出处可直接引用"
              action={
                <Chip tone="success">
                  <span data-direction-stat="factual-section">{factual.length}</span> 个
                </Chip>
              }
            />
            {factual.length === 0 ? (
              <div
                data-direction-empty="factual"
                className="rounded-xl border border-dashed border-ink-200 px-4 py-6 text-center text-[12px] text-ink-400"
              >
                没有以原文事实为依据的方向
              </div>
            ) : (
              <div className="space-y-3">
                {factual.map((d) => (
                  <DirectionLiveCard key={d.direction_id} pid={pid} d={d} />
                ))}
              </div>
            )}
          </section>

          {/* ── 分区二：推测方向（candidate_only）── */}
          <section data-direction-section="candidate">
            <SectionTitle
              title="推测方向"
              subtitle="仅由系统推断支撑，**不是任何论文的原话** —— 需先核实线索是否成立"
              action={
                <Chip tone="warn">
                  <span data-direction-stat="candidate-section">{candidate.length}</span> 个
                </Chip>
              }
            />

            {candidate.length > 0 && (
              <div
                data-direction-candidate-notice="1"
                className="mb-3 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50/80 px-3.5 py-3 text-[12px] text-amber-900"
              >
                <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <p>
                  以下方向<strong>不是论文的结论</strong>。它们来自系统对多条证据的归纳推断，
                  置信度已硬性封顶为 0.5。请先核实线索是否成立，再决定是否投入。
                </p>
              </div>
            )}

            {candidate.length === 0 ? (
              <div
                data-direction-empty="candidate"
                className="rounded-xl border border-dashed border-ink-200 px-4 py-6 text-center text-[12px] text-ink-400"
              >
                没有仅凭系统推断的方向
              </div>
            ) : (
              <div className="space-y-3">
                {candidate.map((d) => (
                  <DirectionLiveCard key={d.direction_id} pid={pid} d={d} tone="warn" />
                ))}
              </div>
            )}
          </section>

          {/* 口径说明 */}
          <div>
            <SectionTitle
              title="依据口径"
              subtitle="这个页面为什么要把两类方向分开"
            />
            <Card className="overflow-hidden">
              <div className="flex flex-col gap-0 divide-y divide-ink-200 lg:flex-row lg:divide-x lg:divide-y-0">
                {[
                  {
                    n: '①',
                    t: '锚定空白',
                    d: '方向必须源自至少一个已识别的研究空白，不能凭空提出',
                  },
                  {
                    n: '②',
                    t: '事实优先',
                    d: '以论文原文明确写出的空白为主要依据，系统推断只作补充线索',
                  },
                  {
                    n: '③',
                    t: '证据约束',
                    d: '每个方向都必须能回链到具体原文证据，无证据不产出',
                  },
                  {
                    n: '④',
                    t: '推断必标',
                    d: '仅由推断支撑的方向会显式标注「推测方向」，且置信度封顶 0.5',
                  },
                ].map((x) => (
                  <div key={x.n} className="flex-1 p-4">
                    <span className="font-mono text-[13px] font-semibold text-brand-500">{x.n}</span>
                    <p className="mt-1.5 text-[13px] font-semibold text-ink-800">{x.t}</p>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-ink-500">{x.d}</p>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

/** 空态：0 个方向是**按设计不产出**，不是加载失败 */
function DirectionEmptyState({
  context,
}: {
  context: ResearchDirectionsResponse['context']
}) {
  return (
    <div data-direction-empty="all">
      <EmptyState
        title="当前语料没有足够 Evidence 支撑研究方向"
        description={
          context.has_any_gap
            ? '已识别到研究空白，但其证据不足以支撑一个完整的研究方向（需要至少 1 条可回链的原文证据）。'
            : '本项目语料中尚未出现系统可识别的研究空白 —— 论文未自陈局限，或跨论文的共性尚未成立。'
        }
        icon={<IconLightbulb className="h-5 w-5" />}
        action={
          <div className="space-y-2 text-center">
            <p className="text-[11.5px] text-ink-400">
              这不是加载失败 —— 接口正常返回了 0 个结果。
            </p>
            <span className="mp-chip bg-ink-100 text-ink-500">
              确定性规则 · {context.rule_version}
            </span>
          </div>
        }
      />
    </div>
  )
}

/**
 * Live 单条方向卡。
 *
 * 展示需求点名的全部字段：研究问题 / 方法切入点 / 验证实验 / Gap / Evidence。
 * candidate_only 走 `tone="warn"`，整卡 amber 描边 + 顶部横幅，避免被当成普通建议。
 */
function DirectionLiveCard({
  pid,
  d,
  tone,
}: {
  pid: string
  d: ServerDirectionFinding
  tone?: 'warn'
}) {
  const { open: openEvidence } = useEvidenceDrawer()
  const [params, setParams] = useSearchParams()
  const isOpen = params.get('focus') === d.direction_id
  const meta = LEVEL_META[d.basis_level]

  const setOpen = (next: boolean) => {
    const p = new URLSearchParams(params)
    if (next) p.set('focus', d.direction_id)
    else p.delete('focus')
    setParams(p, { replace: true })
  }

  return (
    <div
      /* 测试锚点：id / 依据层级 / 信号类型 都挂在外层 div 上 */
      data-direction-id={d.direction_id}
      data-direction-basis={d.basis_level}
      data-direction-signal={d.gap_signal}
    >
      <Card
        className={clsx(
          'overflow-hidden',
          tone === 'warn' && 'border-amber-300 bg-amber-50/30',
        )}
      >
        {/* 头部 */}
        <div
          className={clsx(
            'flex flex-wrap items-start justify-between gap-3 p-4',
            tone === 'warn' ? 'bg-amber-50/70' : 'bg-gradient-to-r from-brand-50 to-white',
          )}
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                data-direction-badge={d.basis_level}
                className={clsx(
                  'mp-chip',
                  d.basis_level === 'candidate_only'
                    ? 'bg-amber-100 text-amber-800'
                    : d.basis_level === 'mixed'
                      ? 'bg-brand-50 text-brand-700'
                      : 'bg-emerald-50 text-emerald-700',
                )}
              >
                {d.basis_level === 'candidate_only' ? '⚠ 推测方向 · 系统推断' : meta.label}
              </span>
              <Chip tone="neutral">{SIGNAL_META_LIVE[d.gap_signal]}</Chip>
              <Chip tone="neutral">主题：{d.theme}</Chip>
            </div>

            <h3
              data-direction-title="1"
              className={clsx(
                'mt-2 text-[14.5px] font-semibold leading-snug',
                tone === 'warn' ? 'text-amber-900' : 'text-ink-900',
              )}
            >
              {d.title}
            </h3>

            <p className="mt-1.5 text-[11px] text-ink-400">
              <span className="font-mono">{d.direction_id}</span>
              {' · '}
              <span data-direction-confidence={d.confidence.toFixed(2)}>
                置信度 {d.confidence.toFixed(2)}
                {d.basis_level === 'candidate_only' && '（推断上限 0.5）'}
              </span>
            </p>
          </div>

          <button
            className="mp-btn mp-btn-soft shrink-0"
            onClick={() => setOpen(!isOpen)}
            data-direction-toggle={d.direction_id}
          >
            {isOpen ? '收起详情' : '展开详情'}
            <IconArrowRight className={clsx('h-3.5 w-3.5 transition', isOpen && 'rotate-90')} />
          </button>
        </div>

        {/* 摘要 + 回链操作 */}
        <div className="space-y-3 p-4">
          <p data-direction-description="1" className="text-[12px] leading-relaxed text-ink-600">
            {d.description}
          </p>

          {/* 研究问题（需求点名） */}
          <div data-direction-question="1" className="rounded-lg bg-ink-50/70 p-3">
            <p className="text-[11px] font-semibold text-ink-500">建议研究问题</p>
            <p className="mt-1 text-[12.5px] font-medium leading-relaxed text-ink-800">
              {d.question.question}
            </p>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-500">
              依据：{d.question.rationale}
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink-500">
              预期：{d.question.expected_outcome}
            </p>
          </div>

          {/* 操作行 */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              data-direction-evidence-open={d.evidence_ids[0] ?? ''}
              className="mp-btn mp-btn-soft"
              onClick={() => d.evidence_ids[0] && openEvidence(d.evidence_ids[0])}
            >
              <IconQuote className="h-3.5 w-3.5" /> 查看 Evidence（{d.evidence_ids.length}）
            </button>
            <Link
              to={`/project/${pid}/gaps?focus=${d.gap_ids[0] ?? ''}`}
              className="mp-btn mp-btn-soft"
              data-direction-gap-link={d.gap_ids[0] ?? ''}
            >
              查看来源空白（{d.gap_ids.length}）
            </Link>
          </div>

          {/* 展开区：方法切入点 / 验证实验 / Gap / Evidence / 依据 */}
          {isOpen && (
            <div className="space-y-3 border-t border-ink-200 pt-3">
              {/* 方法切入点 */}
              <div data-direction-approach="1">
                <p className="text-[11px] font-semibold text-ink-500">方法切入点</p>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-700">
                  <span className="mp-chip mr-1.5 bg-ink-100 text-ink-600">
                    {APPROACH_KIND_LABEL[d.approach.kind]}
                  </span>
                  {d.approach.description}
                </p>
                {d.approach.based_on_method_names.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {d.approach.based_on_method_names.map((n) => (
                      <Chip key={n} tone="neutral">
                        {n}
                      </Chip>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-[11px] text-amber-700">
                    本项目方法池中没有可用素材，此方向需要引入新方法。
                  </p>
                )}
              </div>

              {/* 验证实验 */}
              <div data-direction-validation="1">
                <p className="text-[11px] font-semibold text-ink-500">建议验证实验</p>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-700">
                  {d.validation.experiment}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {d.validation.materials.map((m) => (
                    <Chip key={m} tone="neutral">
                      {m}
                    </Chip>
                  ))}
                  <span
                    className={clsx(
                      'mp-chip text-[10.5px]',
                      d.validation.from_corpus
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-ink-100 text-ink-500',
                    )}
                  >
                    {d.validation.from_corpus ? '材料来自语料' : '最小建议（语料未提供材料）'}
                  </span>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-500">
                  成功标准：{d.validation.success_criteria}
                </p>
              </div>

              {/* Gap + Evidence 回链 */}
              <div className="grid gap-3 lg:grid-cols-2">
                <div>
                  <p className="text-[11px] font-semibold text-ink-500">来源空白</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5" data-direction-gap-list="1">
                    {d.gap_ids.map((gid) => (
                      <Link
                        key={gid}
                        to={`/project/${pid}/gaps?focus=${gid}`}
                        data-direction-gap-id={gid}
                        className="mp-chip bg-brand-50 font-mono text-brand-700 hover:bg-brand-100"
                      >
                        {gid}
                      </Link>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-[11px] font-semibold text-ink-500">
                    Evidence（点击查看原文）
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5" data-direction-evidence-list="1">
                    {d.evidence_ids.map((eid) => (
                      <button
                        key={eid}
                        data-direction-evidence-id={eid}
                        onClick={() => openEvidence(eid)}
                        className="mp-chip bg-ink-100 font-mono text-ink-600 hover:bg-ink-200"
                      >
                        {eid}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* 依据留痕 */}
              <div data-direction-basis-list="1">
                <p className="text-[11px] font-semibold text-ink-500">依据留痕</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {d.basis.map((b) => (
                    <span key={b} className="mp-chip bg-ink-100 text-ink-500">
                      {BASIS_LABEL_LIVE[b] ?? b}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}

/* ================================================================== */
/* Demo：保留原有手工标注（行为不变）                                    */
/* ================================================================== */

function DemoDirectionsView({ pid }: { pid: string }) {
  return <DemoDirectionsBody pid={pid} />
}

/** 方向详情页：点击卡片后进入 -> 这里用展开式的完整分析面板实现 */
function DemoDirectionsBody({ pid }: { pid: string }) {
  const { open: openEvidence } = useEvidenceDrawer()
  const { push } = useToast()
  const [params, setParams] = useSearchParams()

  const directions = getDirections()
  const focusId = params.get('focus') ?? directions[0]?.direction_id
  const focus = getDirection(focusId) ?? directions[0]

  const setFocus = (did: string) => {
    const next = new URLSearchParams(params)
    next.set('focus', did)
    setParams(next, { replace: true })
  }

  return (
    <div className="mp-anim-fade-up space-y-5" data-directions-page="demo">
      <PageHeader
        title="研究方向"
        subtitle={`基于 ${stats.paperCount} 篇论文 · AI 发现 ${directions.length} 个候选研究方向`}
        meta={
          <>
            <Chip tone="brand">全部方向均已关联原文证据</Chip>
            <Chip tone="neutral">
              平均可行性{' '}
              {Math.round(directions.reduce((s, d) => s + d.feasibility, 0) / directions.length)}
            </Chip>
            <Chip tone="neutral">
              平均新颖性{' '}
              {Math.round(directions.reduce((s, d) => s + d.novelty, 0) / directions.length)}
            </Chip>
          </>
        }
        actions={
          <button
            className="mp-btn mp-btn-primary"
            onClick={() =>
              push({
                title: '已生成研究计划',
                description: `${focus?.title ?? '方向'} 的详细研究计划已生成`,
                tone: 'success',
              })
            }
          >
            <IconSparkles className="h-3.5 w-3.5" /> 生成研究计划
          </button>
        }
      />

      {/* 方向卡片列表 */}
      <div className="grid gap-3 lg:grid-cols-3">
        {directions.map((d, i) => {
          const active = d.direction_id === focusId
          return (
            <button key={d.direction_id} onClick={() => setFocus(d.direction_id)} className="text-left">
              <Card
                hover
                className={clsx(
                  'flex h-full flex-col p-4',
                  active && 'border-brand-300 shadow-[0_0_0_3px_var(--color-brand-50)]',
                )}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={clsx(
                      'font-mono text-[13px] font-semibold',
                      active ? 'text-brand-600' : 'text-ink-400',
                    )}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="flex items-center gap-1">
                    <Chip tone="success">可行性 {d.feasibility}</Chip>
                    <Chip tone="brand">新颖性 {d.novelty}</Chip>
                  </div>
                </div>

                <h3
                  className={clsx(
                    'mt-2.5 text-[14px] font-semibold leading-snug transition',
                    active ? 'text-brand-700' : 'text-ink-800',
                  )}
                >
                  {d.title}
                </h3>

                <p className="mt-2 line-clamp-3 flex-1 text-[12px] leading-relaxed text-ink-500">
                  {d.research_question}
                </p>

                <div className="mt-3 space-y-2 border-t border-ink-200 pt-3">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10.5px] text-ink-400">可行性</span>
                      <span className="font-mono text-[10.5px] tabular-nums text-ink-500">
                        {d.feasibility}
                      </span>
                    </div>
                    <ProgressBar
                      value={d.feasibility}
                      className="mt-1"
                      color="var(--color-emerald-500)"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10.5px] text-ink-400">新颖性</span>
                      <span className="font-mono text-[10.5px] tabular-nums text-ink-500">
                        {d.novelty}
                      </span>
                    </div>
                    <ProgressBar value={d.novelty} className="mt-1" />
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between border-t border-ink-200 pt-2.5">
                  <span className="text-[10.5px] tabular-nums text-ink-400">
                    {d.evidence_ids.length} 条证据 · {d.paper_ids.length} 篇论文
                  </span>
                  <span className="flex items-center gap-1 text-[11.5px] font-medium text-brand-600">
                    展开分析 <IconArrowRight className="h-3 w-3" />
                  </span>
                </div>
              </Card>
            </button>
          )
        })}
      </div>

      {/* 详情 */}
      {focus ? (
        <DirectionDetail
          directionId={focus.direction_id}
          projectId={pid}
          onOpenEvidence={openEvidence}
          onGenerate={() =>
            push({
              title: '研究计划已生成',
              description: '包含实验设计、Baseline、指标与风险的完整计划',
              tone: 'success',
            })
          }
        />
      ) : (
        <EmptyState
          title="暂无可展示的研究方向"
          description="先运行分析流水线以推导研究方向"
          icon={<IconLightbulb className="h-5 w-5" />}
          action={
            <Link to={`/project/${pid}/analysis`} className="mp-btn mp-btn-soft">
              前往智能分析
            </Link>
          }
        />
      )}

      {/* 对比说明 */}
      <div>
        <SectionTitle
          title="推导逻辑说明"
          subtitle="每个方向都是从具体空白出发、由证据支撑、并落到可执行实验设计上的"
        />
        <Card className="overflow-hidden">
          <div className="flex flex-col gap-0 divide-y divide-ink-200 lg:flex-row lg:divide-x lg:divide-y-0">
            {[
              { n: '①', t: '锚定空白', d: '方向必须源自至少一个已识别的领域级研究空白' },
              { n: '②', t: '机制组合', d: '从现有方法中检索可复用的机制，形成新的组合方案' },
              { n: '③', t: '证据约束', d: '每个方向必须关联具体原文证据，无证据的推断会被标注为假设' },
              { n: '④', t: '可验证性', d: '必须给出可执行的实验设计、Baseline 与评价指标' },
            ].map((x) => (
              <div key={x.n} className="flex-1 p-4">
                <span className="font-mono text-[13px] font-semibold text-brand-500">{x.n}</span>
                <p className="mt-1.5 text-[13px] font-semibold text-ink-800">{x.t}</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-500">{x.d}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 方向详情：完整的十节分析                                            */
/* ------------------------------------------------------------------ */

function DirectionDetail({
  directionId,
  projectId,
  onOpenEvidence,
  onGenerate,
}: {
  directionId: string
  projectId: string
  onOpenEvidence: (id: string) => void
  onGenerate: () => void
}) {
  const d = getDirection(directionId)
  if (!d) return null

  const evList = getEvidenceOfDirection(d.direction_id)
  const papers = d.paper_ids.map((p) => getPaper(p)).filter(Boolean)
  const gaps = d.gap_ids.map((g) => getGap(g)).filter(Boolean)

  const sections = [
    { n: '一', title: '研究问题', body: d.research_question },
    { n: '二', title: '已有研究', body: d.existing_work },
    { n: '五', title: '可能研究方法', list: d.possible_method },
    { n: '六', title: '实验设计', body: d.experiment_design },
    { n: '七', title: 'Baseline', chips: d.baselines },
    { n: '八', title: 'Evaluation Metrics', chips: d.metrics },
    { n: '九', title: '主要风险', body: d.risk, tone: 'warn' as const },
    { n: '十', title: '风险缓解策略', body: d.risk_mitigation, tone: 'success' as const },
  ]

  return (
    <Card className="overflow-hidden">
      {/* 头部 */}
      <div className="border-b border-ink-200 bg-gradient-to-r from-brand-50 to-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Chip tone="brand">{d.direction_id}</Chip>
              <span className="text-[11px] text-ink-400">候选研究方向</span>
            </div>
            <h2 className="mt-2 text-[20px] font-semibold tracking-tight text-ink-900">
              {d.title}
            </h2>
          </div>
          <div className="flex gap-2">
            <div className="rounded-xl border border-emerald-200 bg-white px-3.5 py-2 text-center">
              <p className="font-mono text-[18px] font-semibold leading-none tabular-nums text-emerald-600">
                {d.feasibility}
              </p>
              <p className="mt-1 text-[10px] text-ink-400">可行性</p>
            </div>
            <div className="rounded-xl border border-brand-200 bg-white px-3.5 py-2 text-center">
              <p className="font-mono text-[18px] font-semibold leading-none tabular-nums text-brand-600">
                {d.novelty}
              </p>
              <p className="mt-1 text-[10px] text-ink-400">新颖性</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        {/* 左：分节内容 */}
        <div className="space-y-4">
          {sections.map((s) => (
            <div key={s.n} className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-ink-100 font-mono text-[11px] font-semibold text-ink-500">
                {s.n}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-[13.5px] font-semibold text-ink-800">{s.title}</h3>

                {s.body && (
                  <p
                    className={clsx(
                      'mt-1.5 rounded-lg border p-3 text-[12.5px] leading-relaxed',
                      s.tone === 'warn' && 'border-amber-100 bg-amber-50/50 text-ink-700',
                      s.tone === 'success' && 'border-emerald-100 bg-emerald-50/40 text-ink-700',
                      !s.tone && 'border-ink-200 bg-ink-50/50 text-ink-700',
                    )}
                  >
                    {s.body}
                  </p>
                )}

                {s.list && (
                  <ul className="mt-1.5 space-y-1.5">
                    {s.list.map((x) => (
                      <li
                        key={x}
                        className="flex items-start gap-2 rounded-lg border border-ink-200 bg-white px-3 py-2"
                      >
                        <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" />
                        <span className="text-[12.5px] leading-relaxed text-ink-700">{x}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {s.chips && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {s.chips.map((x) => (
                      <span
                        key={x}
                        className="rounded-md border border-ink-200 bg-white px-2 py-1 font-mono text-[11px] text-ink-600"
                      >
                        {x}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* 三、相关论文 */}
          <div className="flex gap-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-ink-100 font-mono text-[11px] font-semibold text-ink-500">
              三
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-[13.5px] font-semibold text-ink-800">
                相关论文（{papers.length}）
              </h3>
              <div className="mt-1.5 space-y-1.5">
                {papers.map(
                  (p) =>
                    p && (
                      <Link
                        key={p.paper_id}
                        to={`/project/${projectId}/papers/${p.paper_id}`}
                        className="flex items-center gap-2 rounded-lg border border-ink-200 bg-white px-3 py-2 transition hover:border-brand-200 hover:bg-brand-50/40"
                      >
                        <span className="w-9 shrink-0 font-mono text-[11px] font-semibold tabular-nums text-ink-400">
                          {p.year}
                        </span>
                        <span className="min-w-0 flex-1 line-clamp-1 text-[12px] text-ink-700">
                          {p.title}
                        </span>
                        <IconArrowRight className="h-3 w-3 shrink-0 text-ink-300" />
                      </Link>
                    ),
                )}
              </div>
            </div>
          </div>

          {/* 四、研究空白 */}
          <div className="flex gap-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-ink-100 font-mono text-[11px] font-semibold text-ink-500">
              四
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-[13.5px] font-semibold text-ink-800">
                研究空白（{gaps.length}）
              </h3>
              <div className="mt-1.5 space-y-1.5">
                {gaps.map(
                  (g) =>
                    g && (
                      <Link
                        key={g.gap_id}
                        to={`/project/${projectId}/gaps?focus=${g.gap_id}`}
                        className="block rounded-lg border border-ink-200 bg-white px-3 py-2.5 transition hover:border-brand-200 hover:bg-brand-50/40"
                      >
                        <p className="text-[12.5px] font-medium leading-snug text-ink-800">
                          {g.title}
                        </p>
                        <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-ink-500">
                          {g.current_problem}
                        </p>
                      </Link>
                    ),
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 右：证据 */}
        <div className="space-y-4">
          <div className="rounded-xl border border-brand-200 bg-gradient-to-br from-brand-50 to-white p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] font-semibold text-brand-800">证据支撑</p>
                <p className="mt-0.5 text-[11px] text-ink-500">
                  该方向由 {evList.length} 条原文证据支撑
                </p>
              </div>
              <span className="font-mono text-[24px] font-semibold tabular-nums text-brand-600">
                {evList.length}
              </span>
            </div>
          </div>

          <div>
            <p className="mp-label mb-2">Evidence 列表</p>
            <div className="space-y-2">
              {evList.map((ev) => (
                <button
                  key={ev.evidence_id}
                  onClick={() => onOpenEvidence(ev.evidence_id)}
                  className="block w-full rounded-lg border border-ink-200 bg-white p-3 text-left transition hover:border-brand-200 hover:bg-brand-50/40"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] font-semibold text-brand-600">
                      #{ev.evidence_id}
                    </span>
                    <span className="text-[10.5px] text-ink-400">{ev.section}</span>
                    <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-400">
                      p.{ev.page}
                    </span>
                  </div>
                  <p className="mt-1.5 line-clamp-3 text-[11.5px] leading-relaxed text-ink-600">
                    {ev.translation}
                  </p>
                  <div className="mt-1.5 flex items-center gap-1">
                    {ev.supports.slice(0, 2).map((s) => (
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
            </div>
          </div>

          <button className="mp-btn mp-btn-primary w-full" onClick={onGenerate}>
            <IconSparkles className="h-3.5 w-3.5" /> 生成研究计划
          </button>

          <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-ink-400">
            <IconQuote className="mt-px h-3 w-3 shrink-0" />
            研究计划将包含分阶段任务、所需资源、预期产出与里程碑，可直接作为开题参考。
          </p>
        </div>
      </div>
    </Card>
  )
}
