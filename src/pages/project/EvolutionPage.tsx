import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { clsx } from 'clsx'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { PageHeader } from '@/components/AppLayout'
import {
  Card,
  Chip,
  EmptyState,
  IconArrowRight,
  IconLayers,
  IconPlus,
  IconQuote,
  IconSparkles,
  IconTimeline,
  ModeBadge,
  SectionTitle,
} from '@/components/ui'
import { useEvidenceDrawer, useToast } from '@/context/AppContext'
import { api, type MethodEvolutionsResponse } from '@/services/api'
import {
  DEMO_PROJECT_ID,
  loadDataset,
  registerDataset,
  type ProjectDataset,
} from '@/services/projectData'
import {
  getEvolutions,
  getMethods,
  relationDesc,
  relationLabel,
} from '@/services/selectors'
import type { Evolution, Method, RelationType } from '@/types'

/* ------------------------------------------------------------------ */
/* 关系分类：因果 vs 非因果                                             */
/* ------------------------------------------------------------------ */

/**
 * 因果四类。**这是整个页面的视觉分水岭**：这四类画实心箭头，
 * 其余三类画虚线且不画箭头。
 *
 * 为什么要在前端也维护一份（服务端 relations 里已有 causal 布尔）：
 * 时间线上的边来自**节点的 `relation_from_prev`**（它只给类型不给 causal），
 * 所以这里必须能把类型映射到因果与否。两处判据由 evolution:test 的
 * 类型白名单断言保证一致。
 */
const CAUSAL_SET = new Set<RelationType>(['extends', 'improves', 'replaces', 'combines'])
const NON_CAUSAL: RelationType[] = ['parallel', 'related', 'temporal']
const CAUSAL_ORDER: RelationType[] = ['extends', 'improves', 'replaces', 'combines']

const isCausalRel = (t: RelationType | null | undefined): boolean =>
  t != null && CAUSAL_SET.has(t)

const REL_COLOR: Record<RelationType, string> = {
  extends: '#6d5cf0',
  improves: '#10b981',
  combines: '#0ea5e9',
  replaces: '#f59e0b',
  parallel: '#ec4899',
  related: '#94a3b8',
  temporal: '#cbd5e1',
}

/**
 * 服务端 `basis` 机器码 → 人话。
 *
 * 与 MethodsPage 的 BASIS_LABEL 同款理由：rule-based 判定的全部价值
 * 在于过程可复核。只给一个"继承"标签而不说依据，用户只能选择相信或不信。
 */
const BASIS_LABEL: Record<string, string> = {
  explicit_causal_statement: '证据原文出现继承 / 改进 / 替代 / 组合的明确表述',
  object_anchor: '该证据点名了具体的前驱方法',
  evidence_ownership_verified: '证据归属已校验（属于声明方论文）',
  aligned_same_method: '跨论文对齐判定为同一方法（是同一物，非演进）',
  same_paper_no_causal: '两者出自同一篇论文，不构成跨论文演进',
  duplicate_method_identity: '两条记录指向同一个方法（重复登记）',
  same_year_no_order: '两者同年出现，无法确立先后',
  unknown_year_no_order: '至少一方年份不可知，无法确立先后',
  year_adjacent_no_causal_evidence: '仅年份相邻，证据中没有因果表述',
  reverse_statement: '前驱的论文反向提及后继',
}

/* ------------------------------------------------------------------ */
/* ViewModel：抹平 Demo / Live 的形状差异                               */
/* ------------------------------------------------------------------ */

/**
 * 页内 ViewModel。
 *
 * 前端 `Evolution` 没有 `paper_id`（服务端 `EvolutionNode` 有），
 * 这里统一补成 `paper_id: string | null`（Demo 为 null）。
 *
 * 刻意**不改**全局 `src/types` 的 `Evolution`：那个类型还有其他消费方，
 * 为了一个页面的展示需求往里塞 Live 专属字段会污染它们。
 */
type EvoView = Evolution & {
  paper_id: string | null
  /** `year === 0` 的显式标记。0 是"年份不可知"，不是"公元 0 年" */
  unknown_year: boolean
}

/* ------------------------------------------------------------------ */
/* 边：因果实心箭头 / 非因果虚线无箭头                                   */
/* ------------------------------------------------------------------ */

/**
 * 时间线上两节点之间的连线。
 *
 * ── 为什么不用 CSS border 做虚线 ──
 * `border-top: 2px dashed` 只能给盒子上边做虚线，箭头顶多是个 CSS 三角，
 * 且虚线与箭头是两个元素、位置不可控；横向 flex 拉伸时还会错位。
 * 这里用 `repeating-linear-gradient` 做虚线背景（能跟着 flex-1 伸缩），
 * 箭头用**独立固定尺寸**的 svg（shrink-0，不参与拉伸）。
 *
 * ── 箭头的方向（极易读反）──
 * 箭头 head 朝右，即指向**年代更晚**的后继节点。
 * 服务端 relation 里 `source = later`，那是**数据引用方向**，不是画面方向；
 * 若照 source→target 画会得到"新→旧"的反向箭头，把
 * 「SWE-agent 建立在 ReAct 上」读成「ReAct 建立在 SWE-agent 上」。
 * 时间线从左到右是年份升序，所以**箭头方向 = 线段方向 = 时间线方向**。
 *
 * ── data-* 的意义 ──
 * 「因果 / 非因果」的视觉差异**不能只靠颜色**（人眼才分得清，测试断不了）。
 * 这里把"有没有箭头元素"变成可断言的事实：
 *   `[data-edge-causal="true"]` 内部必有 svg；
 *   `[data-edge-causal="false"]` 内部必无 svg。
 * UI 测试正是数这两个来抓"因果与非因果视觉混淆"的回归。
 */
function EvolutionEdge({ rel }: { rel: RelationType | null }) {
  const causal = isCausalRel(rel)
  const color = rel ? REL_COLOR[rel] : '#e6ebf2'

  return (
    <div
      className="flex flex-1 items-center gap-1 px-1"
      data-edge-rel={rel ?? 'none'}
      data-edge-causal={causal ? 'true' : 'false'}
    >
      <span
        className="h-[2px] flex-1 rounded-full"
        style={
          causal
            ? { background: `linear-gradient(to right, ${color}, ${color})` }
            : rel
              ? {
                  backgroundImage: `repeating-linear-gradient(to right, ${color} 0 5px, transparent 5px 10px)`,
                }
              : { background: color }
        }
      />
      {/* 箭头只给因果边。非因果边**没有这个元素**，这是硬区分点 */}
      {causal && (
        <svg
          width="7"
          height="7"
          viewBox="0 0 8 8"
          className="-ml-1.5 shrink-0"
          aria-hidden="true"
        >
          <path d="M0 0 L8 4 L0 8 Z" fill={color} />
        </svg>
      )}
      {rel && (
        <span
          className="shrink-0 rounded px-1 py-px text-[8.5px] font-semibold"
          style={{ background: `${color}18`, color }}
        >
          {relationLabel(rel)}
        </span>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

export function EvolutionPage() {
  const { id } = useParams()
  const pid = id ?? DEMO_PROJECT_ID
  const [params, setParams] = useSearchParams()
  const { open: openEvidence } = useEvidenceDrawer()
  const { push } = useToast()

  /* ── 数据源：Demo 走本地知识库，Live 走 API ── */

  const [dataset, setDataset] = useState<ProjectDataset | null>(null)
  /**
   * 已加载完成的项目 id。
   *
   * `loading` 是**派生值**（`loadedPid !== pid`），不是独立的 state：
   * 派生能保证"loading 与实际数据"永不脱节，
   * 也不必在 effect 里同步 setState（那会触发级联渲染告警）。
   */
  const [loadedPid, setLoadedPid] = useState<string | null>(null)
  const loading = loadedPid !== pid

  /**
   * 技术演进接口结果。
   *
   * 与 dataset 分开取，且**失败单独吞掉**并标记 `evoError`：
   * 演进算不出来不该拖垮整页（数据集仍然是好的），
   * 更不能显示成"没有演进" —— 同 MethodsPage 的 alignmentError 处理。
   */
  const [evoResp, setEvoResp] = useState<MethodEvolutionsResponse | null>(null)
  const [evoError, setEvoError] = useState<string | null>(null)

  /**
   * 数据加载 + 注册数据集。
   *
   * 注意这里**没有** `setLoading(true)`：切换项目时靠 `loadedPid` 派生
   * loading 状态（见下），而不是在 effect 里同步 setState ——
   * 后者会触发级联渲染告警（set-state-in-effect），
   * 且「加载完成」与「切换项目」本来就该是两件事。
   */
  useEffect(() => {
    let alive = true
    loadDataset(pid)
      .then((r) => {
        if (!alive) return
        setDataset(r.dataset)
        setLoadedPid(pid)
        /*
         * ⚠️ 这一行是 Live 证据回链的**前提**，缺了会出最恶劣的一种错误。
         *
         * EvidenceDrawer 挂在 <Routes> 之外，只能按 evidence_id 反查注册表；
         * 查不到时会**回落到 Demo 的 getEvidence()**（见 EvidenceDrawer.tsx）。
         * 于是点开真实项目的 #E001，抽屉里显示的是演示论文的原文 ——
         * 看起来完全正常，实际张冠李戴。
         */
        registerDataset(r.dataset)
      })
      .catch(() => {
        if (!alive) return
        setDataset(null)
        setLoadedPid(pid)
      })
    return () => {
      alive = false
    }
  }, [pid])

  useEffect(() => {
    /*
     * Demo 项目不发这个请求：它的演进来自知识库的人工标注，
     * 服务端对该项目也没有 bundle，调了只会拿到 404。
     *
     * 守卫用 `return` 早退、**不在 effect 里同步清空 state** ——
     * 清空交给下面的 `readResp` / `readError` 派生完成，
     * 这样既是唯一事实来源，也不触发级联渲染告警（set-state-in-effect）。
     */
    if (dataset?.source !== 'live') return

    let alive = true
    api
      .listEvolutions(pid)
      .then((r) => {
        if (alive) {
          setEvoResp(r)
          setEvoError(null)
        }
      })
      .catch((e: unknown) => {
        if (!alive) return
        setEvoResp(null)
        setEvoError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [pid, dataset])

  const isLive = dataset?.source === 'live'

  /**
   * 只有 Live 才认接口结果。
   *
   * Demo 项目即使残留上一次的响应也不会被读到 —— 这比"进 Demo 分支时
   * 手动 set 成 null"更稳：手动清空依赖 effect 的执行时机，
   * 而这里是从渲染路径上直接切断，不存在中间态。
   */
  const readResp = isLive ? evoResp : null
  const readError = isLive ? evoError : null

  const [view, setView] = useState<'timeline' | 'chart'>('timeline')

  /* ── 统一 ViewModel ── */

  const evolutions = useMemo<EvoView[]>(() => {
    if (isLive) {
      return (readResp?.evolutions ?? []).map((n) => ({
        ...n,
        paper_id: n.paper_id,
        unknown_year: n.year === 0,
      }))
    }
    return getEvolutions().map((e) => ({
      ...e,
      paper_id: null,
      unknown_year: e.year === 0,
    }))
  }, [isLive, readResp])

  /**
   * 统计口径。Live 一律用**服务端 stats**，Demo 才现算。
   *
   * 为什么不让前端统一自己数：`stats.causal_total` 由服务端
   * `summarizeEvolutions()` 从 relations 算出，是唯一权威。
   * 前端自己数 `relation_from_prev` 在"链是线性"的当下恰好等价，
   * 但一旦服务端改口径（例如某个相邻对允许没有边），前端就会**悄悄漂移** ——
   * 表现为"标题写 3 条因果，线上只有 2 条箭头"。
   */
  const stats = useMemo(() => {
    if (isLive && readResp) return readResp.stats
    const causal = evolutions.filter((e) => isCausalRel(e.relation_from_prev)).length
    const total = evolutions.filter((e) => e.relation_from_prev != null).length
    return {
      extends: 0,
      improves: 0,
      replaces: 0,
      combines: 0,
      related: 0,
      parallel: 0,
      temporal: 0,
      total_relations: total,
      causal_total: causal,
      non_causal_total: total - causal,
      stages: evolutions.length,
      unknown_year: evolutions.filter((e) => e.unknown_year).length,
      causal_without_evidence: 0,
    }
  }, [isLive, readResp, evolutions])

  /* ── Live 下所有查表都要走 dataset，不能读 Demo 知识库 ── */

  /**
   * 方法查找表。
   *
   * 刻意 memo 的是**数据**（Map），不是返回闭包的工厂函数 ——
   * 工厂函数每次返回新函数引用，React Compiler 无法证明它保持 memo
   * （lint 会报 preserve-manual-memoization）。
   */
  const methodById = useMemo(() => {
    const list = isLive ? (dataset?.methods ?? []) : getMethods()
    return new Map(list.map((m) => [m.method_id, m]))
  }, [isLive, dataset])

  const methodOf = (mid: string): Method | undefined => methodById.get(mid)

  const paperById = useMemo(
    () => new Map((dataset?.papers ?? []).map((p) => [p.paper_id, p])),
    [dataset],
  )

  /**
   * 节点所属论文。
   *
   * Live 用节点自带的 paper_id；Demo 没有该字段，退回用方法的 paper_ids[0] 反查。
   */
  const paperOf = (node: EvoView): { paper_id: string; title: string } | null => {
    const first = node.paper_id ?? methodOf(node.method_id)?.paper_ids?.[0]
    if (!first) return null
    return { paper_id: first, title: paperById.get(first)?.title || first }
  }

  /* ── 焦点节点 ── */

  const focusId = params.get('focus') ?? evolutions[evolutions.length - 1]?.evolution_id
  const focusIndex = evolutions.findIndex((e) => e.evolution_id === focusId)
  const focus = evolutions[focusIndex]

  const setFocus = (id: string) => {
    const next = new URLSearchParams(params)
    next.set('focus', id)
    setParams(next, { replace: true })
  }

  /**
   * 焦点节点对应的服务端关系（用于展示判定依据）。
   *
   * 用完整身份键 `paper_id::method_id` 反查 —— method_id 跨论文会撞号，
   * 用裸 id 查会命中错误的那条边。
   */
  const focusRelation = useMemo(() => {
    if (!isLive || !readResp || !focus) return null
    const key = focus.paper_id ? `${focus.paper_id}::${focus.method_id}` : ''
    if (!key) return null
    return readResp.relations.find((r) => r.source_method_key === key) ?? null
  }, [isLive, readResp, focus])

  /* ── 图表数据：Live 必须用真实 methods，否则会画演示数据 ── */

  const methodsForChart = useMemo(
    () => (isLive ? (dataset?.methods ?? []) : getMethods()),
    [isLive, dataset],
  )

  const methodsByYear = useMemo(() => {
    const map = new Map<number, number>()
    for (const m of methodsForChart) map.set(m.year, (map.get(m.year) ?? 0) + 1)
    return [...map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, count]) => ({ year: String(year), count }))
  }, [methodsForChart])

  /* ── 三种状态 ── */

  const hasNodes = evolutions.length > 0
  const allTemporal = hasNodes && stats.causal_total === 0
  const ctx = readResp?.context

  if (loading) {
    return (
      <div className="mp-anim-fade-up space-y-5">
        <PageHeader title="技术演进" subtitle="正在加载…" />
        <Card className="p-10">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
            <p className="text-sm text-ink-400">正在重建演进链…</p>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="mp-anim-fade-up space-y-5">
      <PageHeader
        title="技术演进"
        subtitle={
          isLive
            ? '从你上传的论文中真实重建的方法演进路径'
            : '演示知识库中人工标注的方法演进路径'
        }
        meta={
          <>
            {isLive && (
              <span className="mp-chip bg-ink-100 text-ink-700">
                <ModeBadge mode="LIVE" />
              </span>
            )}
            <Chip tone="brand" >
              <span data-evo-stat="stages">{stats.stages}</span> 个阶段
            </Chip>
            <Chip tone={stats.causal_total > 0 ? 'success' : 'neutral'}>
              因果 <span data-evo-stat="causal">{stats.causal_total}</span> 条
            </Chip>
            <Chip tone="neutral">
              时间相关 <span data-evo-stat="noncausal">{stats.non_causal_total}</span> 条
            </Chip>
            {stats.unknown_year > 0 && (
              <Chip tone="warn">{stats.unknown_year} 个节点年份不可知</Chip>
            )}
          </>
        }
        actions={
          <div className="flex rounded-lg border border-ink-200 bg-white p-0.5">
            {(['timeline', 'chart'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={clsx(
                  'rounded-md px-2.5 py-1 text-[12px] font-medium transition',
                  view === v ? 'bg-brand-50 text-brand-700' : 'text-ink-500 hover:text-ink-700',
                )}
              >
                {v === 'timeline' ? '时间线视图' : '数据视图'}
              </button>
            ))}
          </div>
        }
      />

      {/* ── 状态 1：加载失败。与"空"必须视觉区分开，绝不复用 EmptyState ── */}
      {readError && (
        <Card className="border-amber-200 bg-amber-50/60 p-3.5">
          <p className="text-[12px] leading-relaxed text-amber-800">
            <strong>技术演进加载失败：</strong>
            {readError}
            <br />
            这<strong>不代表</strong>该项目没有技术演进，只是这次没取到。请刷新重试。
          </p>
        </Card>
      )}

      {/* ── 状态 2：无节点。用 context 解释"为什么空"，而不是甩一句"暂无数据" ── */}
      {!readError && !hasNodes && (
        <EmptyState
          title="暂无技术演进数据"
          description={
            !isLive
              ? '演示知识库中未提供演进节点。'
              : (ctx?.methods ?? 0) < 2
                ? `当前项目只有 ${ctx?.methods ?? 0} 个方法，重建演进链至少需要两个方法。`
                : `已比较 ${ctx?.methods ?? 0} 个方法，但不足以在时间轴上形成阶段链。`
          }
          icon={<IconTimeline className="h-5 w-5" />}
          action={
            isLive && (ctx?.papers ?? 0) < 2 ? (
              <Link to={`/project/${pid}/upload`} className="mp-btn mp-btn-soft">
                <IconPlus className="h-3.5 w-3.5" /> 再上传一篇论文
              </Link>
            ) : undefined
          }
        />
      )}

      {/* ── 状态 3：有链但全无因果。正常渲染，只加一条解释性提示 ── */}
      {!readError && allTemporal && (
        <Card className="border-ink-200 bg-ink-50/60 p-3">
          <p className="text-[11.5px] leading-relaxed text-ink-600">
            本链包含 <strong>{evolutions.length}</strong> 个阶段，但<strong>没有一条因果关系</strong>
            —— 系统未在任何一条跨论文证据中找到「继承 / 改进 / 替代 / 组合」的明确表述。
            时间线上的虚线仅表示时间顺序，<strong>不代表因果关系</strong>。
          </p>
        </Card>
      )}

      {/* 关系图例：分段展示因果 / 非因果，避免把"时间相邻"读成"继承" */}
      {hasNodes && (
        <Card className="flex flex-col gap-2 p-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="mp-label">因果（实心箭头）</span>
            {CAUSAL_ORDER.map((t) => (
              <span key={t} className="flex items-center gap-1.5">
                <svg width="7" height="7" viewBox="0 0 8 8" aria-hidden="true">
                  <path d="M0 0 L8 4 L0 8 Z" fill={REL_COLOR[t]} />
                </svg>
                <span className="h-2 w-2 rounded-sm" style={{ background: REL_COLOR[t] }} />
                <span className="text-[11.5px] font-medium text-ink-600">{relationLabel(t)}</span>
                <span className="hidden text-[10.5px] text-ink-400 xl:inline">
                  {relationDesc(t)}
                </span>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-ink-200 pt-2">
            <span className="mp-label">非因果（虚线，不代表因果）</span>
            {NON_CAUSAL.map((t) => (
              <span key={t} className="flex items-center gap-1.5">
                <span
                  className="h-[2px] w-3.5 rounded-full"
                  style={{
                    backgroundImage: `repeating-linear-gradient(to right, ${REL_COLOR[t]} 0 4px, transparent 4px 8px)`,
                  }}
                />
                <span className="text-[11.5px] font-medium text-ink-600">{relationLabel(t)}</span>
                <span className="hidden text-[10.5px] text-ink-400 xl:inline">
                  {relationDesc(t)}
                </span>
              </span>
            ))}
          </div>
        </Card>
      )}

      {hasNodes &&
        (view === 'chart' ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-4">
              <SectionTitle title="每年新增方法数量" subtitle="方法首次出现的年份分布" />
              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={methodsByYear}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e6ebf2" vertical={false} />
                    <XAxis
                      dataKey="year"
                      tick={{ fontSize: 11, fill: '#94a3b8' }}
                      axisLine={{ stroke: '#e6ebf2' }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: '#94a3b8' }}
                      axisLine={false}
                      tickLine={false}
                      width={28}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        borderRadius: 10,
                        border: '1px solid #e6ebf2',
                        fontSize: 12,
                      }}
                      formatter={(v) => [`${v} 个方法`, '新增'] as [string, string]}
                    />
                    <Bar dataKey="count" fill="#6d5cf0" radius={[5, 5, 0, 0]} maxBarSize={38} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="p-4">
              <SectionTitle title="方法累积增长曲线" subtitle="领域方法总量的时间累积" />
              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={(() => {
                      let acc = 0
                      return methodsByYear.map((d) => {
                        acc += d.count
                        return { year: d.year, total: acc }
                      })
                    })()}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e6ebf2" vertical={false} />
                    <XAxis
                      dataKey="year"
                      tick={{ fontSize: 11, fill: '#94a3b8' }}
                      axisLine={{ stroke: '#e6ebf2' }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: '#94a3b8' }}
                      axisLine={false}
                      tickLine={false}
                      width={28}
                    />
                    <Tooltip
                      contentStyle={{
                        borderRadius: 10,
                        border: '1px solid #e6ebf2',
                        fontSize: 12,
                      }}
                      formatter={(v) => [`累计 ${v} 个`, '方法总量'] as [string, string]}
                    />
                    <Line
                      type="monotone"
                      dataKey="total"
                      stroke="#6d5cf0"
                      strokeWidth={2.4}
                      dot={{ r: 3.5, fill: '#6d5cf0' }}
                      activeDot={{ r: 5 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="p-4 lg:col-span-2">
              <SectionTitle
                title="演进阶段与方法对照"
                subtitle="每个阶段对应的代表方法与证据数量"
              />
              <div className="overflow-hidden rounded-lg border border-ink-200">
                <div className="grid grid-cols-[70px_minmax(0,1.3fr)_minmax(0,1.6fr)_90px] gap-3 border-b border-ink-200 bg-ink-50/70 px-3 py-2">
                  <span className="mp-label">年份</span>
                  <span className="mp-label">阶段 / 代表方法</span>
                  <span className="mp-label">技术变化</span>
                  <span className="mp-label">关系 / 证据</span>
                </div>
                {evolutions.map((e) => {
                  const m = methodOf(e.method_id)
                  return (
                    <button
                      key={e.evolution_id}
                      onClick={() => {
                        setFocus(e.evolution_id)
                        setView('timeline')
                      }}
                      className="grid w-full grid-cols-1 gap-2 border-b border-ink-200 px-3 py-2.5 text-left transition last:border-0 hover:bg-ink-50/60 lg:grid-cols-[70px_minmax(0,1.3fr)_minmax(0,1.6fr)_90px] lg:items-center lg:gap-3"
                    >
                      <span className="font-mono text-[12px] font-semibold tabular-nums text-brand-600">
                        {e.unknown_year ? '未知' : e.year}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[12.5px] font-medium text-ink-800">
                          {e.stage_title}
                        </p>
                        <p className="mt-0.5 truncate text-[11px] text-ink-400">{m?.name}</p>
                      </div>
                      <p className="line-clamp-2 text-[11.5px] leading-relaxed text-ink-500">
                        {e.change}
                      </p>
                      <div className="flex flex-col items-start gap-1">
                        {e.relation_from_prev ? (
                          <Chip
                            tone={isCausalRel(e.relation_from_prev) ? 'brand' : 'neutral'}
                          >
                            {relationLabel(e.relation_from_prev)}
                          </Chip>
                        ) : (
                          <span className="text-[10.5px] text-ink-400">起点</span>
                        )}
                        <span className="text-[10.5px] tabular-nums text-ink-400">
                          {e.evidence_ids.length} 证据
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </Card>
          </div>
        ) : (
          <>
            {/* 横向时间线 */}
            <Card className="overflow-hidden">
              <div className="mp-scroll-thin overflow-x-auto p-5 pb-3">
                <div className="flex min-w-[1100px] items-stretch">
                  {evolutions.map((e, i) => {
                    const m = methodOf(e.method_id)
                    const active = e.evolution_id === focusId
                    return (
                      <div key={e.evolution_id} className="flex min-w-0 flex-1 items-stretch">
                        <button
                          data-evo-node={e.evolution_id}
                          data-evo-year={e.unknown_year ? 'unknown' : String(e.year)}
                          onClick={() => setFocus(e.evolution_id)}
                          className="group flex min-w-0 flex-1 flex-col text-left"
                        >
                          {/* 年份 + 连线 */}
                          <div className="flex items-center">
                            <div
                              className={clsx(
                                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 font-mono text-[10px] font-semibold transition',
                                active
                                  ? 'mp-anim-pulse border-brand-500 bg-brand-500 text-white'
                                  : 'border-brand-300 bg-white text-brand-600 group-hover:border-brand-500',
                              )}
                            >
                              {i + 1}
                            </div>
                            {i < evolutions.length - 1 && (
                              /*
                               * 边挂在"当前节点之后"，表示它与**下一个**节点的关系。
                               * 所以取的是 `evolutions[i + 1].relation_from_prev`，
                               * 不是当前节点的 —— 后者描述的是"与上一个节点的关系"，
                               * 画在这里会整体错位一格。
                               */
                              <EvolutionEdge rel={evolutions[i + 1].relation_from_prev} />
                            )}
                          </div>

                          {/* 内容卡 */}
                          <div
                            className={clsx(
                              'mt-3 min-w-0 flex-1 rounded-xl border p-3 transition',
                              active
                                ? 'border-brand-300 bg-brand-50/60 shadow-sm'
                                : 'border-ink-200 bg-white hover:border-brand-200',
                            )}
                          >
                            <p className="font-mono text-[11px] font-semibold tabular-nums text-brand-600">
                              {e.unknown_year ? '年份未知' : e.year}
                            </p>
                            <p className="mt-1 line-clamp-2 text-[12px] font-semibold leading-snug text-ink-800">
                              {e.stage_title}
                            </p>

                            <div className="mt-2 border-t border-ink-200/80 pt-2">
                              <p className="mp-label mb-1 !text-[9.5px]">代表方法</p>
                              <p className="line-clamp-2 text-[11px] font-medium leading-snug text-brand-700">
                                {m?.name ?? '—'}
                              </p>
                            </div>

                            <div className="mt-2">
                              <p className="mp-label mb-1 !text-[9.5px]">技术变化</p>
                              <p className="line-clamp-4 text-[10.5px] leading-relaxed text-ink-500">
                                {e.change}
                              </p>
                            </div>

                            <div className="mt-2 flex items-center justify-between">
                              <span className="text-[10px] tabular-nums text-ink-400">
                                {e.evidence_ids.length} 条证据
                              </span>
                              <span className="flex items-center gap-0.5 text-[10px] font-medium text-brand-600 opacity-0 transition group-hover:opacity-100">
                                查看 <IconArrowRight className="h-2.5 w-2.5" />
                              </span>
                            </div>
                          </div>
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="flex items-start gap-2 border-t border-ink-200 bg-amber-50/60 px-5 py-2.5">
                <span className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                <p className="text-[11px] leading-relaxed text-amber-800">
                  系统严格区分「有证据支持的演进关系」与「仅时间相邻」。当跨论文证据不足以支撑继承或改进判定时，
                  关系会降级显示为「时间相邻」或「相关」，避免编造论文之间不存在的因果关系。
                </p>
              </div>
            </Card>

            {/*
              节点详情。

              `data-evo-detail` 标在整个详情区（含左「节点信息」与右「支撑证据」
              两张卡）的外层，而不是只标其中一张：断言"点节点后能看到
              论文 / 方法 / 证据"时，它们散在两列里，只标一张会让证据那半边
              落在断言范围之外。

              另外：Card 组件不透传任意属性（只收 className / hover），
              把 data-* 写在 Card 上会被静默丢弃。
            */}
            {focus && (
              <div
                className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
                data-evo-detail
              >
                <Card className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[13px] font-semibold tabular-nums text-brand-600">
                          {focus.unknown_year ? '年份未知' : focus.year}
                        </span>
                        {focus.relation_from_prev && (
                          <Chip
                            tone={isCausalRel(focus.relation_from_prev) ? 'brand' : 'neutral'}
                          >
                            与前一节点：{relationLabel(focus.relation_from_prev)}
                          </Chip>
                        )}
                        {!focus.relation_from_prev && focusIndex === 0 && (
                          <Chip tone="neutral">链首</Chip>
                        )}
                      </div>
                      <h3 className="mt-1 text-[17px] font-semibold tracking-tight text-ink-900">
                        {focus.stage_title}
                      </h3>
                    </div>
                    <IconTimeline className="h-4 w-4 shrink-0 text-brand-400" />
                  </div>

                  {/* 所属论文 */}
                  {(() => {
                    const p = paperOf(focus)
                    if (!p) return null
                    return (
                      <div className="mt-4">
                        <p className="mp-label mb-2">所属论文</p>
                        <Link
                          to={`/project/${pid}/papers/${p.paper_id}`}
                          className="flex items-center gap-3 rounded-xl border border-ink-200 bg-white p-3 transition hover:border-brand-200 hover:bg-brand-50/40"
                        >
                          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink-100 font-mono text-[10px] font-semibold text-ink-600">
                            {p.paper_id}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-medium text-ink-800">
                              {p.title}
                            </p>
                            <p className="truncate text-[11px] text-ink-400">查看论文原文与抽取结果</p>
                          </div>
                          <IconArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-300" />
                        </Link>
                      </div>
                    )
                  })()}

                  {/* 关系判定依据（Live 才有） */}
                  {focusRelation && (
                    <div className="mt-4 rounded-xl border border-ink-200 bg-ink-50/50 p-3.5">
                      <p className="mp-label mb-1.5">
                        判定依据 · {relationLabel(focusRelation.relation_type)}
                        {focusRelation.causal ? '（因果）' : '（非因果）'}
                      </p>
                      <p className="text-[12px] leading-relaxed text-ink-700">
                        {focusRelation.description}
                      </p>
                      {focusRelation.basis.length > 0 && (
                        <ul className="mt-2 space-y-0.5">
                          {focusRelation.basis.map((b) => (
                            <li
                              key={b}
                              className="flex items-start gap-1.5 text-[11px] text-ink-500"
                            >
                              <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-ink-300" />
                              {BASIS_LABEL[b] ?? b}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  <div className="mt-4 space-y-3">
                    {[
                      { label: '技术变化', value: focus.change, tone: 'brand' as const },
                      {
                        label: '相比前一节点的改进',
                        value: focus.improvement,
                        tone: 'success' as const,
                      },
                      {
                        label: '该阶段暴露的局限',
                        value: focus.limitation,
                        tone: 'warn' as const,
                      },
                    ].map((x) => (
                      <div
                        key={x.label}
                        className={clsx(
                          'rounded-xl border p-3.5',
                          x.tone === 'brand' && 'border-brand-100 bg-brand-50/50',
                          x.tone === 'success' && 'border-emerald-100 bg-emerald-50/40',
                          x.tone === 'warn' && 'border-amber-100 bg-amber-50/40',
                        )}
                      >
                        <p
                          className={clsx(
                            'mp-label mb-1.5',
                            x.tone === 'brand' && 'text-brand-500',
                            x.tone === 'success' && 'text-emerald-600',
                            x.tone === 'warn' && 'text-amber-600',
                          )}
                        >
                          {x.label}
                        </p>
                        <p className="text-[12.5px] leading-relaxed text-ink-700">{x.value}</p>
                      </div>
                    ))}
                  </div>

                  {/* 代表方法 */}
                  <div className="mt-4 border-t border-ink-200 pt-3.5">
                    <p className="mp-label mb-2">代表方法</p>
                    {(() => {
                      const m = methodOf(focus.method_id)
                      if (!m) return <p className="text-[12px] text-ink-400">未关联方法</p>
                      return (
                        <Link
                          to={`/project/${pid}/methods?focus=${m.method_id}`}
                          className="flex items-center gap-3 rounded-xl border border-ink-200 bg-white p-3 transition hover:border-brand-200 hover:bg-brand-50/40"
                        >
                          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50 font-mono text-[11px] font-semibold text-brand-600">
                            {m.year}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-medium text-ink-800">{m.name}</p>
                            <p className="truncate text-[11px] text-ink-400">{m.name_zh}</p>
                          </div>
                          <Chip tone="brand">{m.paradigm}</Chip>
                          <IconArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-300" />
                        </Link>
                      )
                    })()}
                  </div>
                </Card>

                <Card className="p-4">
                  <SectionTitle
                    title="支撑证据"
                    subtitle={`${focus.evidence_ids.length} 条原文证据支撑该演进节点`}
                    icon={<IconQuote className="h-4 w-4" />}
                  />
                  <div className="space-y-2">
                    {focus.evidence_ids.map((eid) => (
                      <button
                        key={eid}
                        onClick={() => openEvidence(eid)}
                        className="flex w-full items-center gap-2 rounded-lg border border-ink-200 bg-white px-3 py-2 text-left transition hover:border-brand-200 hover:bg-brand-50/40"
                      >
                        <span className="font-mono text-[11px] font-semibold text-brand-600">
                          #{eid}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-500">
                          点击查看原文出处
                        </span>
                        <IconArrowRight className="h-3 w-3 shrink-0 text-ink-300" />
                      </button>
                    ))}
                    {focus.evidence_ids.length === 0 && (
                      <p className="rounded-lg border border-dashed border-ink-200 bg-ink-50/60 px-3 py-6 text-center text-[12px] text-ink-400">
                        该节点暂无直接证据支持
                      </p>
                    )}
                  </div>

                  <div className="mt-4 border-t border-ink-200 pt-3.5">
                    <p className="mp-label mb-2">该阶段涉及的其他方法</p>
                    <div className="flex flex-wrap gap-1.5">
                      {methodsForChart
                        .filter((m) => m.year === focus.year && m.method_id !== focus.method_id)
                        .slice(0, 6)
                        .map((m) => (
                          <Link
                            key={m.method_id}
                            to={`/project/${pid}/methods?focus=${m.method_id}`}
                            className="mp-chip bg-ink-100 text-ink-600 transition hover:bg-ink-200"
                          >
                            {m.name}
                          </Link>
                        ))}
                      {methodsForChart.filter(
                        (m) => m.year === focus.year && m.method_id !== focus.method_id,
                      ).length === 0 && (
                        <span className="text-[11.5px] text-ink-400">该年份无其他方法</span>
                      )}
                    </div>
                  </div>

                  <button
                    className="mp-btn mp-btn-soft mt-4 w-full"
                    onClick={() =>
                      push({
                        title: '已生成阶段小结',
                        description: `${focus.unknown_year ? '年份未知' : focus.year} · ${focus.stage_title} 的阶段摘要已加入调研报告`,
                        tone: 'success',
                      })
                    }
                  >
                    <IconSparkles className="h-3.5 w-3.5" /> 生成阶段小结
                  </button>
                </Card>
              </div>
            )}
          </>
        ))}

      {/* 被引用的证据一览 */}
      {hasNodes && (
        <div>
          <SectionTitle
            title="演进证据链"
            subtitle="所有支撑演进判定的原文证据，点击查看出处"
          />
          <Card className="p-3.5">
            <div className="flex flex-wrap gap-1.5">
              {[...new Set(evolutions.flatMap((e) => e.evidence_ids))].map((eid) => (
                <button
                  key={eid}
                  onClick={() => openEvidence(eid)}
                  className="rounded-md border border-brand-200 bg-brand-50/70 px-2 py-1 font-mono text-[11px] text-brand-700 transition hover:bg-brand-100"
                >
                  #{eid}
                </button>
              ))}
              {evolutions.every((e) => e.evidence_ids.length === 0) && (
                <span className="flex items-center gap-1.5 text-[11.5px] text-ink-400">
                  <IconLayers className="h-3.5 w-3.5" />
                  本链目前没有任何被引用的证据（全部为时间相关关系）
                </span>
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
