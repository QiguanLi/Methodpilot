import { useEffect, useMemo, useState } from 'react'
import { useSearchParams, useParams, Link } from 'react-router-dom'
import { clsx } from 'clsx'
import { PageHeader } from '@/components/AppLayout'
import {
  Card,
  Chip,
  EmptyState,
  IconClose,
  IconLayers,
  IconPlus,
  IconSearch,
  ModeBadge,
  SectionTitle,
  SkeletonState,
} from '@/components/ui'
import { useAppState, useEvidenceDrawer } from '@/context/AppContext'
import { MethodCard } from './MethodCard'
import {
  DEMO_PROJECT_ID,
  FAMILY_TAXONOMY,
  getRegisteredEngine,
  loadDataset,
  registerDataset,
  type ProjectDataset,
} from '@/services/projectData'
import {
  COL_W,
  layout,
  liveFamilies,
  liveFamilyDistribution,
  NODE_H,
  NODE_W,
  PAD_X,
} from '@/services/methodLayout'
import {
  ALIGNMENT_ORDER,
  alignmentLabel,
  alignmentTone,
  getFamilies,
  getFamilyDistribution,
  getMethod,
  getMethods,
  getRelations,
  isAlignmentConclusive,
  relationLabel,
  toMethodRelation,
} from '@/services/selectors'
import type { AlignmentRelationType, MethodAlignmentsResponse } from '@/services/api'
import { api } from '@/services/api'
import type { RelationType } from '@/types'

/** 判断关系是否为"有证据支持" */
const isGrounded = (type: RelationType) =>
  type !== 'temporal' && type !== 'related'

/**
 * 对齐判定信号的展示文案（Phase 4-3）。
 *
 * 把服务端 `basis` 里的机器码翻译成人话，摊在卡片上让用户看到"凭什么这么判"。
 * 不展示的话，用户面对一个"相关"标签只能选择相信或不信，
 * 而 rule-based 判定的全部价值就在于**过程可复核**。
 */
const BASIS_LABEL: Record<string, string> = {
  name_exact: '名称完全相同',
  name_surface_variant: '名称表层变体',
  name_token_subset: '名称词集包含',
  name_zh_match: '中文名相同',
  alias_declared: '作者显式声明别名',
  acronym_match: '缩写匹配',
  core_idea_overlap: '核心做法重合',
  same_task: '任务相同',
  same_family: '同一方法族',
  shared_evidence_text: '证据原文逐字相同',
  year_gap: '仅年份相近',
  name_conflict: '名称互相冲突',
}

export function MethodsPage() {
  const [params, setParams] = useSearchParams()
  const { id: routeId } = useParams()
  const pid = routeId ?? DEMO_PROJECT_ID
  const { selectedMethodId, setSelectedMethodId } = useAppState()
  const { open: openEvidence } = useEvidenceDrawer()

  /**
   * 方法地图的数据来源同样要分 Live / Demo。
   *
   * 之前这里直接读 getMethods()，于是真实上传项目打开方法地图看到的
   * 是演示的 12 个方法——上传闭环在方法地图这一环断掉。
   */
  const [dataset, setDataset] = useState<ProjectDataset | null>(null)
  const [loading, setLoading] = useState(true)

  /**
   * 跨论文对齐关系（Phase 4-3）。
   *
   * 与 methods/papers 分开取，因为它来自另一个接口
   * （/method-alignments，服务端现算），且**失败不应拖垮整个页面**：
   * 关系算不出来时，方法地图本身仍然有价值。所以它的错误被单独吞掉
   * 并标记为 `alignmentError`，页面上明说"关系加载失败"，
   * 而不是让整页白屏或假装"没有关系"。
   */
  const [alignment, setAlignment] = useState<MethodAlignmentsResponse | null>(null)
  const [alignmentError, setAlignmentError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    loadDataset(pid)
      .then((r) => {
        if (!alive) return
        setDataset(r.dataset)
        registerDataset(r.dataset)
      })
      .catch(() => {
        if (!alive) return
        setDataset(null)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [pid])

  /**
   * 拉取跨论文对齐关系。
   *
   * 只在 live 项目拉：
   *   Demo 项目的关系来自知识库的人工标注（relations.ts），
   *   那是另一套语义（演进七类），调这个接口没有意义。
   *   服务端对 Demo 项目也没有对应 bundle，会返回 404。
   */
  useEffect(() => {
    if (dataset?.source !== 'live') {
      setAlignment(null)
      setAlignmentError(null)
      return
    }
    let alive = true
    setAlignmentError(null)
    api
      .listMethodAlignments(pid)
      .then((r) => {
        if (alive) setAlignment(r)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setAlignment(null)
        setAlignmentError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [pid, dataset])

  const isLive = dataset?.source === 'live'

  const focusId = params.get('focus') ?? selectedMethodId ?? (isLive ? '' : 'M001')
  const familyParam = params.get('family') ?? 'all'

  const [paradigm, setParadigm] = useState('all')
  const [yearRange, setYearRange] = useState('all')
  const [showUngrounded, setShowUngrounded] = useState(true)
  const [keyword, setKeyword] = useState('')
  const [hoveredRelation, setHoveredRelation] = useState<string | null>(null)

  /**
   * Live：按每个方法自己的 family_id（阶段③ 真实 LLM 分类结果）分列。
   * 判不出来的落进「未分类」列——那是判定结果，不是能力缺失。
   * Demo：直接用知识库里的方法族。
   */
  const allMethods = useMemo(
    () => (isLive ? (dataset?.methods ?? []) : getMethods()),
    [isLive, dataset],
  )
  /**
   * Demo：知识库里人工标注的演进关系（继承/改进/组合…）。
   * Live：Phase 4-3 的跨论文对齐候选（同一/别名/相关/待判断），来自服务端。
   *
   * 两者共用 `MethodRelation` 形状，所以下面的连线渲染、图例、明细表
   * 不需要分叉。但**展示措辞必须分叉**——用 relationLabel 展示演进语义、
   * 用 alignmentLabel 展示对齐语义，否则会把"相关"读成"继承"。
   *
   * `alignedCandidates` 必须自己 useMemo：`alignment?.candidates ?? []`
   * 每次渲染都会造一个新数组，直接放进下游 useMemo 的依赖里会让它们每帧重算
   * （lint 的 exhaustive-deps 正是这么报的）。这里固定引用即可根治。
   */
  const alignedCandidates = useMemo(
    () => alignment?.candidates ?? [],
    [alignment],
  )
  const relations = useMemo(
    () => (isLive ? alignedCandidates.map(toMethodRelation) : getRelations()),
    [isLive, alignedCandidates],
  )

  /**
   * 方法 -> 对齐关系。用于明细表里展示"双方论文 / Method / Evidence"，
   * 以及点击节点时高亮相关连线。
   */
  const alignmentOfRelation = useMemo(() => {
    const map = new Map<string, (typeof alignedCandidates)[number]>()
    for (const c of alignedCandidates) map.set(c.alignment_id, c)
    return map
  }, [alignedCandidates])

  /**
   * paper_id -> paper。对齐卡片上要显示"这条关系跨的是哪两篇论文"，
   * 只有 paper_id（P001）对用户没有意义——每篇论文都叫 P001。
   */
  const papersById = useMemo(() => {
    const map = new Map<string, { title: string; file_name: string; year: number }>()
    for (const p of dataset?.raw?.papers ?? []) {
      map.set(p.paper_id, {
        title: p.title ?? '',
        file_name: p.file_name ?? '',
        year: p.year ?? 0,
      })
    }
    return map
  }, [dataset])

  /**
   * evidence_id -> 该证据的原文摘要，用作回链按钮的 tooltip。
   *
   * 有它用户才能"点之前先看一眼是不是自己想要的那条"，
   * 而不是盲点一串 E001/E002 再逐个关掉。
   */
  const evidenceTitle = useMemo(() => {
    const map = new Map<string, string>()
    for (const e of dataset?.raw?.evidence ?? []) {
      const t = (e.content ?? '').replace(/\s+/g, ' ').trim()
      map.set(e.evidence_id, t.length > 110 ? `${t.slice(0, 110)}…` : t)
    }
    return map
  }, [dataset])
  const families = useMemo(
    () => (isLive ? liveFamilies(allMethods, FAMILY_TAXONOMY) : getFamilies()),
    [isLive, allMethods],
  )

  /**
   * 分类状态总览。三个数各有各的含义，别合并：
   *   classified   —— 拿到了 'F1'..'F5'，是真的归了类
   *   unclassified —— 分类跑过了，但模型判定"证据不足以归类"
   *   notClassified —— 压根没跑过分类（classification 为 null）
   */
  const classifyStats = useMemo(() => {
    if (!isLive) return null
    let classified = 0
    let unclassified = 0
    let notClassified = 0
    for (const m of allMethods) {
      if (!m.classification) notClassified++
      else if (m.family_id) classified++
      else unclassified++
    }
    return { classified, unclassified, notClassified, total: allMethods.length }
  }, [isLive, allMethods])

  /**
   * 本页方法的抽取引擎。
   *
   * 一个项目里的所有论文通常由同一个 provider 处理，所以取第一篇有溯源的即可；
   * 若多篇不一致，这里会显示第一个能查到的——页面顶部另有按论文的明细入口。
   * 取不到就返回 null，界面照实写「未记录」。
   */
  const engine = (() => {
    if (!isLive) return null
    for (const p of dataset?.raw?.papers ?? []) {
      const e = getRegisteredEngine(p.paper_id)
      if (e) return e
    }
    return null
  })()

  const years = [...new Set(allMethods.map((m) => m.year).filter((y) => y > 0))].sort(
    (a, b) => a - b,
  )
  const paradigms = [...new Set(allMethods.map((m) => m.paradigm))]

  /* 筛选后的方法 */
  const visibleMethods = useMemo(() => {
    return allMethods.filter((m) => {
      if (familyParam !== 'all' && m.family_id !== familyParam) return false
      if (paradigm !== 'all' && m.paradigm !== paradigm) return false
      if (yearRange !== 'all') {
        if (yearRange.endsWith('+')) {
          if (m.year < Number(yearRange.slice(0, -1))) return false
        } else if (m.year !== Number(yearRange)) return false
      }
      if (keyword) {
        const kw = keyword.toLowerCase()
        return (
          m.name.toLowerCase().includes(kw) ||
          m.name_zh.includes(keyword) ||
          m.core_idea.toLowerCase().includes(kw)
        )
      }
      return true
    })
  }, [allMethods, familyParam, paradigm, yearRange, keyword])

  const visibleIds = new Set(visibleMethods.map((m) => m.method_id))
  const visibleRelations = relations.filter(
    (r) => visibleIds.has(r.source_method) && visibleIds.has(r.target_method),
  )

  const { nodes, width, height, orphanCount } = useMemo(
    () => layout(visibleMethods, families),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleMethods.map((m) => m.method_id).join(','), isLive],
  )

  /**
   * 运行期兜底：如果有方法没被任何族接住，说明族 id 与方法 family_id 对不上。
   * 不静默——直接显示警告。因为这种不一致会让方法在画布上凭空消失，
   * 而页面其他数字依然正常，用户根本发现不了。
   */
  const hasOrphans = orphanCount > 0

  const posMap = new Map(nodes.map((n) => [n.method.method_id, n]))
  const selected = isLive
    ? allMethods.find((m) => m.method_id === focusId)
    : getMethod(focusId)
  const familyDist = isLive
    ? liveFamilyDistribution(allMethods, families)
    : getFamilyDistribution()

  const selectMethod = (id: string) => {
    setSelectedMethodId(id)
    const next = new URLSearchParams(params)
    next.set('focus', id)
    setParams(next, { replace: true })
  }

  const clearFocus = () => {
    setSelectedMethodId(null)
    const next = new URLSearchParams(params)
    next.delete('focus')
    setParams(next, { replace: true })
  }

  const resetFilters = () => {
    setParadigm('all')
    setYearRange('all')
    setKeyword('')
    const next = new URLSearchParams(params)
    next.delete('family')
    setParams(next, { replace: true })
  }

  const hasFilter =
    familyParam !== 'all' || paradigm !== 'all' || yearRange !== 'all' || keyword

  if (loading) {
    return (
      <div className="mp-anim-fade-up space-y-5">
        <PageHeader title="方法地图" subtitle="正在加载项目数据…" />
        <Card className="p-4">
          <SkeletonState rows={8} />
        </Card>
      </div>
    )
  }

  return (
    <div className="mp-anim-fade-up space-y-5">
      <PageHeader
        title="方法地图"
        subtitle={
          isLive
            ? '从你上传的论文中真实抽取到的方法实体与支撑证据'
            : '方法实体、方法族与方法间关系的可视化视图'
        }
        meta={
          <>
            {isLive && (
              <span className="mp-chip bg-ink-100 text-ink-700">
                <ModeBadge mode="LIVE" />
              </span>
            )}
            {/*
             * 引擎徽标。这里刻意**不用** <SourceBadge source="ai_generated" />——
             * 它的文案是「AI 抽取」，而服务端可能跑在 mock provider 上，
             * 那种情况下这些方法一个模型都没调过。两个徽标并排出现时
             * （「AI 抽取」+「内置规则引擎抽取」）会直接自相矛盾，
             * 用户不知道该信哪个。所以只保留一个、且说真话的那个。
             */}
            {isLive && (
              <Chip tone={engine?.real ? 'success' : 'warn'}>
                {engine
                  ? engine.real
                    ? `真实模型抽取 · ${engine.model}`
                    : '内置规则引擎抽取（未调用大模型）'
                  : '抽取引擎未记录'}
              </Chip>
            )}
            <Chip tone="brand">{visibleMethods.length} 个方法</Chip>
            {isLive ? (
              /**
               * 分类状态徽标。三种状态必须分开显示，不能都写成一个词：
               *   分类未运行   → warn，这是能力缺口，得让人知道
               *   全部未分类   → warn，分类跑了但一条都没归进去，值得警惕
               *   部分/全部归类 → success，并给出真实族数
               * 把"没跑"说成"跑过"、或把"判不出"说成"没接入"，都是误导。
               */
              classifyStats && classifyStats.notClassified > 0 ? (
                <Chip tone="warn">分类未运行</Chip>
              ) : classifyStats && classifyStats.classified === 0 ? (
                <Chip tone="warn">全部未分类</Chip>
              ) : (
                <Chip tone="success">
                  {families.filter((f) => f.family_id !== '').length} 个方法族 ·{' '}
                  {classifyStats?.classified ?? 0}/{classifyStats?.total ?? 0} 已归类
                </Chip>
              )
            ) : (
              <Chip tone="success">{families.length} 个方法族</Chip>
            )}
            {/*
               * 关系数量统计。
               *
               * Live 与 Demo 的统计口径不同，所以分叉：
               *   Live —— 四类对齐关系**各自**计数（same/alias/related/uncertain）。
               *          不合并成一个"共 N 条"：same 是"确认同一方法"，
               *          uncertain 是"判断不了"，含义相反，合并会抹掉这个区别。
               *   Demo —— 沿用原来的"共 N 条 + N 条证据不足"。
               */}
            {isLive ? (
              alignment ? (
                <>
                  <Chip tone="neutral">{alignment.stats.total} 条跨论文关系</Chip>
                  {alignment.stats.same > 0 && (
                    <Chip tone="brand">同一方法 {alignment.stats.same}</Chip>
                  )}
                  {alignment.stats.alias > 0 && (
                    <Chip tone="success">别名 {alignment.stats.alias}</Chip>
                  )}
                  {alignment.stats.related > 0 && (
                    <Chip tone="info">相关 {alignment.stats.related}</Chip>
                  )}
                  {alignment.stats.uncertain > 0 && (
                    <Chip tone="warn">待判断 {alignment.stats.uncertain}</Chip>
                  )}
                </>
              ) : (
                <Chip tone={alignmentError ? 'warn' : 'neutral'}>
                  {alignmentError ? '关系加载失败' : '关系加载中…'}
                </Chip>
              )
            ) : (
              <>
                <Chip tone="neutral">{visibleRelations.length} 条关系</Chip>
                <Chip tone="warn">
                  {relations.filter((r) => !isGrounded(r.relation_type)).length} 条证据不足
                </Chip>
              </>
            )}
          </>
        }
        actions={
          isLive ? (
            <Link to={`/project/${pid}/upload`} className="mp-btn mp-btn-soft">
              <IconPlus className="h-3.5 w-3.5" /> 继续上传论文
            </Link>
          ) : (
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-ink-200 bg-white px-2.5 py-1.5">
              <input
                type="checkbox"
                checked={showUngrounded}
                onChange={(e) => setShowUngrounded(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--color-brand-600)]"
              />
              <span className="text-[12px] text-ink-600">显示证据不足的关系</span>
            </label>
          )
        }
      />

      {/* Live 项目声明：把"哪些是真、哪些还是假的"说在明面上 */}
      {isLive && (
        <Card className="p-3.5">
          <p className="text-[12px] leading-relaxed text-ink-600">
            <strong>本页方法由服务端从 PDF 正文真实抽取：</strong>
            每个方法都挂着若干条<strong>逐字回验通过</strong>的原文证据，
            点开即可看到它来自哪篇论文、哪一章节、哪一页。
            {classifyStats && classifyStats.notClassified > 0 ? (
              <span className="text-amber-700">
                方法分类（方法族划分）尚未运行，因此真实方法暂列在「未分类」下。
                运行分类后即可看到真实的族归属与归类理由。
              </span>
            ) : (
              <span className="text-ink-600">
                <strong>方法分类也已接入：</strong>
                每个方法由模型基于它<strong>已通过校验的证据</strong>归入方法族，
                卡片里会写明归类理由与所依据的证据编号。
                <span className="text-amber-700">
                  证据不足以可靠归类时会如实标为「未分类」，系统不强行归类。
                </span>
              </span>
            )}
            {/*
              跨论文关系的说明。Phase 6 起对齐已真实接入，原文案
              （「跨方法关系仍是演示能力，本页不展示」）已过时：
              本页此刻正在展示 N 条真实关系，却说"不展示"，是自相矛盾的。
              有数据时说明判定口径，无数据时说明为什么没有——两种都要说清。
            */}
            <span className="text-amber-700">
              {alignedCandidates.length > 0
                ? `跨论文关系已接入：已比较 ${alignment?.context?.methods ?? 0} 个方法，` +
                  `给出 ${alignedCandidates.length} 条候选。只有拿到可核验证据才会判为「同一方法/别名」，` +
                  `证据不足时如实标为「相关」或「待判断」，不编造因果（改进/替代/组合）。`
                : `跨论文关系已接入，但当前项目尚不足以建立关系：` +
                  `跨论文比较至少需要 2 篇各有方法的论文` +
                  (alignment?.context?.papers ? `（当前 ${alignment.context.papers} 篇）` : '') +
                  `。系统只在有证据支持时才建立关系，不画任何未经验证的连线。`}
            </span>
          </p>
        </Card>
      )}

      {/* 筛选 */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              className="mp-input pl-9"
              placeholder="搜索方法名称或核心思想…"
            />
          </div>
          <select
            value={familyParam}
            onChange={(e) => {
              const next = new URLSearchParams(params)
              if (e.target.value === 'all') next.delete('family')
              else next.set('family', e.target.value)
              setParams(next, { replace: true })
            }}
            className="mp-input w-auto min-w-[150px] cursor-pointer"
          >
            <option value="all">全部方法族</option>
            {families.map((f) => (
              <option key={f.family_id} value={f.family_id}>
                {f.name_zh}
              </option>
            ))}
          </select>
          <select
            value={paradigm}
            onChange={(e) => setParadigm(e.target.value)}
            className="mp-input w-auto min-w-[140px] cursor-pointer"
          >
            <option value="all">全部方法范式</option>
            {paradigms.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select
            value={yearRange}
            onChange={(e) => setYearRange(e.target.value)}
            className="mp-input w-auto min-w-[120px] cursor-pointer"
          >
            <option value="all">全部年份</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y} 年
              </option>
            ))}
            <option value="2023+">2023 年及以后</option>
          </select>
          {hasFilter && (
            <button className="mp-btn mp-btn-ghost" onClick={resetFilters}>
              重置
            </button>
          )}
        </div>
      </Card>

      {/* 布局异常告警：宁可难看，也不能让方法凭空消失 */}
      {hasOrphans && (
        <Card className="border-rose-200 bg-rose-50 p-3.5">
          <p className="text-[12px] leading-relaxed text-rose-700">
            <strong>布局异常：有 {orphanCount} 个方法未被任何分组接住，画布上不会显示。</strong>
            <br />
            这通常是方法族 id 与方法上的 family_id 不一致导致的数据问题，
            不是筛选条件造成的。请把这条信息连同项目 ID 一起反馈——系统不会自动隐藏它。
          </p>
        </Card>
      )}

      {/* 方法族图例：Live 下也是一个真实的筛选器——分类接入后族不再是占位 */}
      {(familyDist.length > 1 || !isLive) && (
        <div className="flex flex-wrap items-center gap-3">
          {familyDist.map((f) => {
            const active = familyParam === f.family_id
            const dim = familyParam !== 'all' && !active
            return (
              <button
                key={f.family_id}
                onClick={() => {
                  const next = new URLSearchParams(params)
                  if (active) next.delete('family')
                  else next.set('family', f.family_id)
                  setParams(next, { replace: true })
                }}
                className={clsx(
                  'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition',
                  active
                    ? 'border-brand-300 bg-brand-50'
                    : 'border-ink-200 bg-white hover:border-brand-200',
                  dim && 'opacity-45',
                )}
              >
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: f.color }} />
                <span className="text-[12px] font-medium text-ink-700">{f.name}</span>
                <span className="font-mono text-[11px] tabular-nums text-ink-400">
                  {f.value}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {/* 图谱 + 卡片 */}
      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* 关系图 */}
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-200 px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <IconLayers className="h-4 w-4 shrink-0 text-brand-500" />
              <p className="shrink-0 text-[13px] font-semibold text-ink-800">
                {isLive ? '方法实体图' : '方法关系图'}
              </p>
              <span className="hidden truncate text-[11px] text-ink-400 md:inline">
                {isLive
                  ? '每个节点 = 一条真实抽取到的方法 · 按方法族分列 · 族内按年份排列'
                  : '按方法族分列 · 族内按年份排列'}
              </span>
            </div>
            {/*
               * 图例同样分叉：
               *   Demo —— 演进五类（继承/改进/组合/替代/并行）
               *   Live —— 对齐四类（同一方法/别名/相关/待判断）
               * 用同一套图例会让用户以为"同一方法"就是"组合"，是错误信息。
               */}
            <div className="hidden items-center gap-3 sm:flex">
              {(isLive ? ALIGNMENT_ORDER : (['extends', 'improves', 'combines', 'replaces', 'parallel'] as RelationType[])).map(
                (t) => {
                  const isAlign = isLive
                  const color = isAlign
                    ? ALIGNMENT_COLOR[t as AlignmentRelationType]
                    : REL_COLOR[t as RelationType]
                  const dashed = isAlign
                    ? t === 'uncertain'
                    : t === 'parallel'
                  return (
                    <span key={t} className="flex items-center gap-1.5">
                      <svg width="18" height="6">
                        <line
                          x1="0"
                          y1="3"
                          x2="18"
                          y2="3"
                          stroke={color}
                          strokeWidth="1.8"
                          strokeDasharray={dashed ? '3 2' : undefined}
                        />
                      </svg>
                      <span className="text-[10.5px] text-ink-500">
                        {isAlign
                          ? alignmentLabel(t as AlignmentRelationType)
                          : relationLabel(t as RelationType)}
                      </span>
                    </span>
                  )
                },
              )}
            </div>
          </div>

          {visibleMethods.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="没有符合条件的方法"
                description={
                  isLive
                    ? '上传 PDF 后，服务端抽取到的方法会出现在这里'
                    : '试着放宽筛选条件'
                }
                icon={<IconSearch className="h-5 w-5" />}
                action={
                  isLive ? (
                    <Link to={`/project/${pid}/upload`} className="mp-btn mp-btn-soft">
                      <IconPlus className="h-3.5 w-3.5" /> 去上传论文
                    </Link>
                  ) : (
                    <button className="mp-btn mp-btn-soft" onClick={resetFilters}>
                      清空筛选
                    </button>
                  )
                }
              />
            </div>
          ) : (
            <div className="mp-scroll-thin overflow-auto overscroll-x-contain bg-[radial-gradient(circle_at_1px_1px,var(--color-ink-200)_1px,transparent_0)] [background-size:18px_18px]">
              <svg
                width={Math.max(width, 900)}
                height={Math.max(height, 380)}
                className="block"
              >
                <defs>
                  {Object.entries(REL_COLOR).map(([type, color]) => (
                    <marker
                      key={type}
                      id={`arrow-${type}`}
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="5"
                      markerHeight="5"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1 L 9 5 L 0 9 z" fill={color} opacity="0.9" />
                    </marker>
                  ))}
                  {/*
                   * 对齐关系的箭头。必须单独定义而不是复用上面的——
                   * 上面的 id 是按演进类型命名的（arrow-combines 等），
                   * 而对齐的 same/alias 在展示层虽然映射到 combines，
                   * 箭头颜色却不同（见 ALIGNMENT_COLOR）。共用会导致颜色错位。
                   */}
                  {Object.entries(ALIGNMENT_COLOR).map(([type, color]) => (
                    <marker
                      key={`align-${type}`}
                      id={`arrow-align-${type}`}
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="5"
                      markerHeight="5"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1 L 9 5 L 0 9 z" fill={color} opacity="0.9" />
                    </marker>
                  ))}
                </defs>

                {/* 列标题 */}
                {families.map((f, i) => {
                  const hasVisible = visibleMethods.some((m) => m.family_id === f.family_id)
                  if (!hasVisible) return null
                  return (
                    <g key={f.family_id}>
                      <rect
                        x={PAD_X + i * COL_W - 6}
                        y={4}
                        width={NODE_W + 12}
                        height={16}
                        rx={4}
                        fill={f.color}
                        opacity={0.1}
                      />
                      <text
                        x={PAD_X + i * COL_W + NODE_W / 2}
                        y={16}
                        textAnchor="middle"
                        className="fill-[var(--color-ink-500)] text-[9.5px] font-semibold"
                      >
                        {f.name_zh}
                      </text>
                    </g>
                  )
                })}

                {/* 关系线 */}
                {visibleRelations.map((r) => {
                  const from = posMap.get(r.source_method)
                  const to = posMap.get(r.target_method)
                  if (!from || !to) return null

                  /*
                   * Live 走对齐语义，Demo 走演进语义。
                   * `isGrounded()` 判的是演进七类里的 temporal/related，
                   * 拿它判对齐四类会出错（比如对齐的 related 会被误判为"证据不足"），
                   * 所以这里按模式取不同的判据。
                   */
                  const cand = isLive ? alignmentOfRelation.get(r.relation_id) : undefined
                  const conclusive = cand ? isAlignmentConclusive(cand.relation_type) : false
                  const grounded = isLive ? conclusive : isGrounded(r.relation_type)
                  if (!grounded && !showUngrounded && !isLive) return null

                  const hovered = hoveredRelation === r.relation_id
                  const dimmed = hoveredRelation !== null && !hovered

                  // 计算连线端点
                  const x1 = from.x + NODE_W / 2
                  const y1 = from.y + NODE_H / 2
                  const x2 = to.x + NODE_W / 2
                  const y2 = to.y + NODE_H / 2

                  // 同列：从节点右侧绕行；跨列：水平方向的平滑贝塞尔
                  const sameCol = from.col === to.col
                  const goingDown = to.row > from.row
                  const sameNodeRow = from.row === to.row

                  // 同列绕行半径随行距自适应，避免曲线互相压叠
                  const bow = 22 + Math.min(Math.abs(to.row - from.row), 4) * 9

                  const d = sameCol
                    ? `M ${from.x + NODE_W} ${y1} C ${from.x + NODE_W + bow} ${y1}, ${to.x + NODE_W + bow} ${y2}, ${to.x + NODE_W} ${y2}`
                    : sameNodeRow
                      ? `M ${x1 + NODE_W / 2} ${y1} L ${x2 - NODE_W / 2} ${y2}`
                      : `M ${x1 + NODE_W / 2} ${y1} C ${x1 + NODE_W / 2 + (to.col > from.col ? 52 : -52)} ${y1}, ${x2 - NODE_W / 2 + (to.col > from.col ? -52 : 52)} ${y2}, ${x2 - NODE_W / 2} ${y2}`

                  void goingDown

                  /*
                   * 颜色与虚线都按模式选。
                   * 对齐模式下的虚线只用于 uncertain（"说不清"），
                   * 有结论的 same/alias 用实线——线的形态本身就是可信度信号。
                   */
                  const strokeColor = cand
                    ? ALIGNMENT_COLOR[cand.relation_type]
                    : REL_COLOR[r.relation_type]
                  const dashed = cand
                    ? cand.relation_type === 'uncertain'
                    : r.relation_type === 'parallel' || !grounded
                  const markerId = cand
                    ? `arrow-align-${cand.relation_type}`
                    : `arrow-${r.relation_type}`

                  return (
                    <path
                      key={r.relation_id}
                      d={d}
                      fill="none"
                      stroke={strokeColor}
                      strokeWidth={hovered ? 2.4 : 1.5}
                      strokeDasharray={dashed ? '4 3' : undefined}
                      markerEnd={`url(#${markerId})`}
                      opacity={dimmed ? 0.08 : grounded ? 0.75 : 0.4}
                      className={hovered ? undefined : 'mp-flow-line'}
                      onMouseEnter={() => setHoveredRelation(r.relation_id)}
                      onMouseLeave={() => setHoveredRelation(null)}
                      style={{ cursor: 'pointer' }}
                    />
                  )
                })}

                {/* 节点 */}
                {nodes.map(({ method, x, y }) => {
                  const family = families.find((f) => f.family_id === method.family_id)
                  const isSelected = method.method_id === focusId
                  const relatedIds = new Set(
                    relations
                      .filter(
                        (r) =>
                          r.source_method === method.method_id ||
                          r.target_method === method.method_id,
                      )
                      .flatMap((r) => [r.source_method, r.target_method]),
                  )
                  const dim =
                    Boolean(focusId) &&
                    !isSelected &&
                    !relatedIds.has(method.method_id)

                  return (
                    <g
                      key={method.method_id}
                      transform={`translate(${x}, ${y})`}
                      onClick={() => selectMethod(method.method_id)}
                      style={{ cursor: 'pointer', opacity: dim ? 0.28 : 1 }}
                    >
                      {isSelected && (
                        <rect
                          x={-4}
                          y={-4}
                          width={NODE_W + 8}
                          height={NODE_H + 8}
                          rx={12}
                          fill="var(--color-brand-500)"
                          opacity={0.14}
                        />
                      )}
                      <rect
                        width={NODE_W}
                        height={NODE_H}
                        rx={9}
                        fill="#fff"
                        stroke={isSelected ? 'var(--color-brand-500)' : 'var(--color-ink-200)'}
                        strokeWidth={isSelected ? 1.8 : 1}
                      />
                      <rect
                        width={3.5}
                        height={NODE_H}
                        rx={2}
                        fill={family?.color ?? 'var(--color-ink-300)'}
                      />
                      <text
                        x={13}
                        y={20}
                        className="fill-[var(--color-ink-800)] text-[10.5px] font-semibold"
                      >
                        {method.name.length > 27 ? `${method.name.slice(0, 27)}…` : method.name}
                      </text>
                      <text x={13} y={34} className="fill-[var(--color-ink-400)] text-[9px]">
                        {method.name_zh}
                      </text>
                      <text
                        x={13}
                        y={46}
                        className="fill-[var(--color-ink-400)] text-[9px] font-mono"
                      >
                      {/*
                        年份未知（服务端约定 0）显示「未知」而不是「0」。
                        与本文件 1232 行的 `paper?.year ? ... : ''` 同口径，
                        也与技术演进页的 `unknown_year ? '未知' : e.year` 一致。
                      */}
                      {method.year > 0 ? method.year : '未知'} · {method.paradigm}
                    </text>
                      <g transform={`translate(${NODE_W - 26}, ${NODE_H - 22})`}>
                        <rect
                          width={20}
                          height={13}
                          rx={4}
                          fill="var(--color-brand-50)"
                        />
                        <text
                          x={10}
                          y={9.5}
                          textAnchor="middle"
                          className="fill-[var(--color-brand-600)] text-[8.5px] font-semibold"
                        >
                          {method.evidence_ids.length}
                        </text>
                      </g>
                    </g>
                  )
                })}
              </svg>
            </div>
          )}

          {/* 图注 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-ink-200 bg-ink-50/60 px-4 py-2.5">
            <span className="text-[10.5px] text-ink-500">
              节点右下角数字 = 该方法的 Evidence 数量
            </span>
            {isLive ? (
              <span className="text-[10.5px] text-amber-600">
                列 = 方法族（由模型基于已校验证据归类，未分类为独立一列）；
                {alignedCandidates.length > 0
                  ? `跨论文关系已接入，虚线 = 对齐候选（${alignedCandidates.length} 条）；` +
                    `实线只用于有证据的「同一方法/别名」，「待判断」一律虚线`
                  : '当前不足 2 篇论文，无可比较的跨论文关系'}
              </span>
            ) : (
              <>
                <span className="text-[10.5px] text-ink-500">实线 = 有原文证据支持</span>
                <span className="text-[10.5px] text-amber-600">
                  虚线 = 证据不足，已降级为「时间相邻 / 相关」
                </span>
              </>
            )}
          </div>
        </Card>

        {/* 方法卡片 */}
        <Card className="flex h-[640px] min-h-[520px] flex-col overflow-hidden 2xl:h-[calc(100vh-260px)]">
          <div className="flex shrink-0 items-center justify-between border-b border-ink-200 px-4 py-2.5">
            <p className="text-[13px] font-semibold text-ink-800">Method Card</p>
            {selected && (
              <button
                onClick={clearFocus}
                className="rounded-md p-1 text-ink-400 transition hover:bg-ink-50 hover:text-ink-700"
              >
                <IconClose className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1">
            {selected ? (
              <MethodCard
                method={selected}
                projectId={pid}
                live={isLive}
                onSelectMethod={selectMethod}
              />
            ) : (
              <div className="p-4">
                <EmptyState
                  title="点击任意方法节点"
                  description={
                    isLive
                      ? '右侧会展示该方法的完整画像，以及它来自哪篇论文、哪一章节、哪一页、哪段原文'
                      : '右侧会展示该方法的完整画像：核心思想、关键模块、能力、局限与支撑证据'
                  }
                  icon={<IconLayers className="h-5 w-5" />}
                />
              </div>
            )}
          </div>
        </Card>
      </div>

      {/*
       * 关系明细表只对 Demo 展示。
       * Live 项目没有经过验证的跨方法关系——把 Demo 的关系表放上去，
       * 等于告诉用户"这些方法之间存在这些关系"，而那是没有依据的。
       */}
      {!isLive && (
        <div>
          <SectionTitle
            title="方法关系明细"
            subtitle={`共 ${visibleRelations.length} 条关系，每条均标注证据来源与置信依据`}
          />
          <Card className="overflow-hidden">
            <div className="hidden grid-cols-[minmax(0,1fr)_72px_minmax(0,1fr)_90px_minmax(0,1.4fr)_110px] items-center gap-3 border-b border-ink-200 bg-ink-50/70 px-4 py-2.5 lg:grid">
              <span className="mp-label">源方法</span>
              <span className="mp-label">关系</span>
              <span className="mp-label">目标方法</span>
              <span className="mp-label">证据支持</span>
              <span className="mp-label">说明</span>
              <span className="mp-label">Evidence</span>
            </div>
            <div className="divide-y divide-ink-200">
              {visibleRelations
                .filter((r) => showUngrounded || isGrounded(r.relation_type))
                .map((r) => {
                  const from = getMethod(r.source_method)
                  const to = getMethod(r.target_method)
                  if (!from || !to) return null
                  const grounded = isGrounded(r.relation_type)
                  return (
                  <div
                    key={r.relation_id}
                    className="grid grid-cols-1 gap-2 px-4 py-2.5 transition hover:bg-ink-50/60 lg:grid-cols-[minmax(0,1fr)_72px_minmax(0,1fr)_90px_minmax(0,1.4fr)_110px] lg:items-center lg:gap-3"
                  >
                    <button
                      onClick={() => selectMethod(from.method_id)}
                      className="truncate text-left text-[12.5px] font-medium text-ink-700 transition hover:text-brand-700"
                    >
                      {from.name}
                    </button>
                    <span>
                      <Chip
                        tone={
                          r.relation_type === 'extends'
                            ? 'brand'
                            : r.relation_type === 'improves'
                              ? 'success'
                              : r.relation_type === 'combines'
                                ? 'info'
                                : r.relation_type === 'replaces'
                                  ? 'warn'
                                  : 'neutral'
                        }
                      >
                        {relationLabel(r.relation_type)}
                      </Chip>
                    </span>
                    <button
                      onClick={() => selectMethod(to.method_id)}
                      className="truncate text-left text-[12.5px] font-medium text-ink-700 transition hover:text-brand-700"
                    >
                      {to.name}
                    </button>
                    <span>
                      {grounded ? (
                        <span className="text-[11px] font-medium text-emerald-600">✓ 有证据</span>
                      ) : (
                        <span className="text-[11px] font-medium text-amber-600">! 降级</span>
                      )}
                    </span>
                    <span className="line-clamp-2 text-[11.5px] leading-relaxed text-ink-500">
                      {r.description}
                    </span>
                    <span className="flex flex-wrap gap-1">
                      {r.evidence_ids.length > 0 ? (
                        r.evidence_ids.map((eid) => (
                          <span
                            key={eid}
                            className="rounded border border-brand-200 bg-brand-50/70 px-1.5 py-0.5 font-mono text-[10px] text-brand-700"
                          >
                            #{eid}
                          </span>
                        ))
                      ) : (
                        <span className="text-[10.5px] italic text-ink-400">—</span>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          </Card>
        </div>
      )}

      {/*
       * ── 跨论文方法关系（Phase 4-3）────────────────────────────────
       *
       * 这一段只在 Live 项目出现，是 Phase 4-3 的主要可见产出。
       *
       * 三条设计底线：
       *   1. **空就是空。** 真实数据算出 0 条时，显示明确的 empty state
       *      并说明"为什么是 0"，绝不填充示例关系或模糊处理成"加载中"。
       *   2. **每条关系都能点到双方论文 / 方法 / 证据。** 判定是机器算的，
       *      但依据必须是用户可复核的，否则这条关系就没法用。
       *   3. **不做演进。** 这里只展示对齐候选，不生成"谁改进了谁"。
       */}
      {isLive && (
        <div>
          <SectionTitle
            title="跨论文方法关系"
            subtitle="两两比较不同论文中的方法，识别同一方法、别名、相关与待判断；不做技术演进推断"
          />

          {/*
           * 加载失败：明说失败 + 原因，而不是显示空。
           * "加载失败"和"确实没有关系"是两件事，混在一起用户会误以为数据没问题。
           */}
          {alignmentError && (
            <Card className="mb-3 border-amber-200 bg-amber-50/60 p-3.5">
              <p className="text-[12px] leading-relaxed text-amber-800">
                <strong>关系加载失败：</strong>
                {alignmentError}
                <br />
                这不代表"没有关系"，只是这次没取到。请刷新重试。
              </p>
            </Card>
          )}

          {alignment && alignment.candidates.length === 0 && (
            <EmptyState
              title="暂无跨论文方法关系"
              description={
                /*
                 * 空状态必须解释**为什么**是空的。
                 *
                 * 直接写"暂无数据"是最糟的做法：用户无法区分
                 * "功能坏了 / 我操作错了 / 数据本来就不支持"。
                 * 这里根据服务端回传的统计口径，给出具体原因。
                 */
                alignment.context.papers < 2
                  ? `当前项目只有 ${alignment.context.papers} 篇论文，跨论文对齐需要至少两篇论文各自抽出了方法。`
                  : alignment.context.compared < 2
                    ? `当前项目有 ${alignment.context.papers} 篇论文，但只有 ${alignment.context.compared} 个方法具备有效的论文归属，无法进行两两比较。`
                    : `已比较 ${alignment.context.compared} 个方法，其中 ${alignment.context.skipped_same_paper} 对被跳过（同一篇论文内部的方法不互相对齐），其余方法之间没有发现足够相似的名字或证据。`
              }
              icon={<IconLayers className="h-5 w-5" />}
              action={
                alignment.context.papers < 2 ? (
                  <Link to={`/project/${pid}/upload`} className="mp-btn mp-btn-soft">
                    <IconPlus className="h-3.5 w-3.5" /> 再上传一篇论文
                  </Link>
                ) : undefined
              }
            />
          )}

          {alignment && alignment.candidates.length > 0 && (
            <>
              {/* 统计条：四类各自计数 + 口径说明 */}
              <Card className="mb-3 p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone="brand">同一方法 {alignment.stats.same}</Chip>
                  <Chip tone="success">别名 {alignment.stats.alias}</Chip>
                  <Chip tone="info">相关 {alignment.stats.related}</Chip>
                  <Chip tone="warn">待判断 {alignment.stats.uncertain}</Chip>
                  <span className="text-[11.5px] text-ink-500">
                    共 {alignment.stats.total} 条 · 其中 {alignment.stats.grounded} 条有实质证据支撑
                  </span>
                </div>
                <p className="mt-2 text-[11.5px] leading-relaxed text-ink-500">
                  比较范围：{alignment.context.methods} 个方法 / {alignment.context.papers} 篇论文，
                  实际参与两两比较 {alignment.context.compared} 个；
                  同论文内部 {alignment.context.skipped_same_paper} 对被跳过（同一篇论文的方法视为不同贡献，不互相对齐）。
                  <span className="ml-1 font-mono text-[10.5px] text-ink-400">
                    规则 {alignment.rule_version}
                  </span>
                </p>
              </Card>

              <Card className="overflow-hidden">
                <div className="divide-y divide-ink-200">
                  {alignment.candidates.map((c) => {
                    const ok = isAlignmentConclusive(c.relation_type)
                    const pa = papersById.get(c.source.paper_id)
                    const pb = papersById.get(c.target.paper_id)
                    return (
                      <div key={c.alignment_id} className="px-4 py-3">
                        {/* 第一行：ID + 关系类型 + 置信度 */}
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <span className="font-mono text-[10.5px] text-ink-400">
                            {c.alignment_id}
                          </span>
                          <Chip tone={alignmentTone(c.relation_type)}>
                            {alignmentLabel(c.relation_type)}
                          </Chip>
                          <span className="text-[11px] text-ink-500">
                            置信度 {(c.confidence * 100).toFixed(0)}%
                          </span>
                          {c.hasDirectEvidence ? (
                            <span className="text-[11px] font-medium text-emerald-600">
                              ✓ 有实质证据
                            </span>
                          ) : (
                            <span className="text-[11px] font-medium text-amber-600">
                              ! 无实质证据，已降级
                            </span>
                          )}
                        </div>

                        {/* 第二行：双方论文 + 方法。两栏对照，这是"点击查看双方"的落点 */}
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {[c.source, c.target].map((side, idx) => {
                            const paper = idx === 0 ? pa : pb
                            return (
                              <button
                                key={side.method_id}
                                onClick={() => selectMethod(side.method_id)}
                                className="rounded-lg border border-ink-200 bg-ink-50/40 px-3 py-2 text-left transition hover:border-brand-300 hover:bg-brand-50/40"
                              >
                                <div className="mb-1 flex items-center gap-1.5">
                                  <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                                    {idx === 0 ? '来源' : '目标'}
                                  </span>
                                  <span className="font-mono text-[10px] text-ink-400">
                                    {side.method_id}
                                  </span>
                                </div>
                                <div className="truncate text-[12.5px] font-medium text-ink-700">
                                  {side.name}
                                  {side.name_zh && (
                                    <span className="ml-1 text-ink-400">{side.name_zh}</span>
                                  )}
                                </div>
                                <div className="mt-1 truncate text-[11px] text-ink-500">
                                  {/* 论文标题：让用户知道这条关系跨的是哪两篇 */}
                                  {paper ? paper.title || paper.file_name : side.paper_id}
                                  {paper?.year ? ` · ${paper.year}` : ''}
                                </div>
                              </button>
                            )
                          })}
                        </div>

                        {/* 第三行：判定依据 */}
                        <p className="mt-2 text-[11.5px] leading-relaxed text-ink-600">
                          {c.reason}
                        </p>

                        {/* 第四行：双方证据回链。逐条可点，点开即证据抽屉 */}
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <span className="text-[10.5px] text-ink-400">证据</span>
                          {c.evidence_ids.length === 0 ? (
                            <span className="text-[10.5px] italic text-ink-400">
                              双方均无证据 → 不判定为同一方法
                            </span>
                          ) : (
                            c.evidence_ids.map((eid) => (
                              <button
                                key={eid}
                                onClick={() => openEvidence(eid)}
                                title={evidenceTitle.get(eid) ?? eid}
                                className="rounded border border-brand-200 bg-brand-50/70 px-1.5 py-0.5 font-mono text-[10px] text-brand-700 transition hover:border-brand-400 hover:bg-brand-100"
                              >
                                #{eid}
                              </button>
                            ))
                          )}
                          {c.shared_quotes.length > 0 && (
                            <span className="ml-1 text-[10.5px] text-emerald-600">
                              · {c.shared_quotes.length} 条逐字相同原文
                            </span>
                          )}
                        </div>

                        {/* 命中信号：把 rule-based 的判定过程摊开，便于复核 */}
                        {c.basis.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {c.basis.map((b) => (
                              <span
                                key={b}
                                className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] text-ink-500"
                              >
                                {BASIS_LABEL[b] ?? b}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* 未达门槛时补一句明确说明，避免用户误以为工具漏看了 */}
                        {!ok && c.hasDirectEvidence && (
                          <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-400">
                            名称层面相似，但不足以认定是同一方法；工具不生成"改进/继承/演进"这类判断。
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </Card>
            </>
          )}
        </div>
      )}

      {/* Live 项目的真实抽查入口：不经图谱，直接按方法列出「哪篇论文 / 哪页 / 哪段原文」 */}
      {isLive && visibleMethods.length > 0 && (
        <div>
          <SectionTitle
            title="证据溯源明细"
            subtitle="每个方法对应的原文出处，可逐条核对页码与原文"
          />
          <Card className="overflow-hidden">
            <div className="divide-y divide-ink-200">
              {visibleMethods.map((m) => {
                const evs = (dataset?.evidence ?? []).filter((e) =>
                  m.evidence_ids.includes(e.evidence_id),
                )
                const src = dataset?.papers.find((p) => m.paper_ids.includes(p.paper_id))
                return (
                  <div key={m.method_id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px] font-semibold text-brand-600">
                        {m.method_id}
                      </span>
                      <span className="text-[13px] font-semibold text-ink-800">{m.name}</span>
                      <Chip tone="brand">{m.evidence_ids.length} 证据</Chip>
                    </div>
                    {src && (
                      <p className="mt-1 text-[11.5px] text-ink-500">
                        来源：
                        <Link
                          to={`/project/${pid}/papers/${src.paper_id}`}
                          className="text-brand-700 hover:underline"
                        >
                          {src.title || src.paper_id}
                        </Link>
                      </p>
                    )}
                    <div className="mt-2 space-y-1.5">
                      {evs.map((ev) => (
                        <button
                          key={ev.evidence_id}
                          onClick={() => openEvidence(ev.evidence_id)}
                          className="block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-left transition hover:border-brand-300 hover:bg-brand-50/30"
                        >
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-[10.5px] font-semibold text-brand-600">
                              #{ev.evidence_id}
                            </span>
                            <Chip tone="neutral">{ev.section || '未标注章节'}</Chip>
                            <Chip tone="neutral">p.{ev.page}</Chip>
                            <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-400">
                              conf {ev.confidence.toFixed(2)}
                            </span>
                          </div>
                          <p className="mt-1.5 line-clamp-2 font-serif text-[11.5px] italic leading-relaxed text-ink-600">
                            “{ev.content}”
                          </p>
                        </button>
                      ))}
                      {evs.length === 0 && (
                        <p className="text-[11px] text-ink-400">该方法的证据未通过校验</p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}

/** 关系类型配色 */
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
 * 对齐关系的连线颜色（Phase 4-3）。
 *
 * 刻意**不复用** REL_COLOR 里的值，即便两者在展示层会映射到同一个 key。
 * 理由：这两套颜色服务于不同的阅读目的——
 *   演进图里用户在看"谁影响谁"，颜色区分的是演进类型；
 *   对齐图里用户在看"哪些其实是同一个东西"，颜色区分的是**可信度层级**：
 *     同一方法/别名 = 有结论 → 高饱和（紫/绿）
 *     相关/待判断   = 待人工 → 低饱和（灰蓝/浅灰）
 * 让"说不清"的线在视觉上就弱下去，用户扫一眼就知道该重点看哪几条。
 */
const ALIGNMENT_COLOR: Record<AlignmentRelationType, string> = {
  same: '#6d5cf0',
  alias: '#10b981',
  related: '#0ea5e9',
  uncertain: '#94a3b8',
}
