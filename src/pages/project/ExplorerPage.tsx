import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/AppLayout'
import {
  Card,
  Chip,
  EmptyState,
  IconAlert,
  IconCheck,
  IconExternalLink,
  IconLayers,
  IconLink,
  IconPlus,
  IconSearch,
  IconSparkles,
  ModeBadge,
  SectionTitle,
  SkeletonState,
} from '@/components/ui'
import { useToast } from '@/context/AppContext'
import { ApiCallError, api, type ParsedQuery, type S2Paper } from '@/services/api'
import { DEMO_PROJECT_ID, loadDataset } from '@/services/projectData'

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 作者列展示：超过 3 人折叠成 "A, B, C 等 N 人" */
function authorLine(authors: string[]): string {
  if (!authors.length) return '（作者未知）'
  if (authors.length <= 3) return authors.join('、')
  return `${authors.slice(0, 3).join('、')} 等 ${authors.length} 人`
}

/** 把英文摘要切成能读的段落预览，不做任何"美化"或改写 */
function abstractPreview(text: string, max = 420): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

/**
 * 相关性分数的显示口径（Phase 3B-4）。
 *
 * 分档着色只是让"高/中/低"一眼可辨，**不改数值**——
 * 数值一律原样显示取整后的百分比，不四舍五入到分档里去。
 * 用户看到的数字和算出来的数字一致，这是"可复述"的前提。
 */
function relevanceTone(percent: number): string {
  if (percent >= 60) return 'text-emerald-600'
  if (percent >= 30) return 'text-amber-600'
  return 'text-ink-400'
}

/**
 * 分数含义的说明文案，挂在 title 属性上。
 *
 * 必须写清楚它是**覆盖率**而不是"匹配概率"：
 * 用户看到"相关性 60%"很容易读成"60% 的概率是我要的论文"，
 * 那是个我们算不出来的量。宁可啰嗦，也不让用户高估这个数字。
 */
const RELEVANCE_HINT =
  '相关性 = 你输入里解析出的检索词，这篇论文覆盖了多少。' +
  '100% 表示检索词全部命中，不代表论文质量或是不是你要找的。' +
  '分数相同则按引用数排序。'

/* ------------------------------------------------------------------ */
/* 【检索条件】面板                                                     */
/* ------------------------------------------------------------------ */

/**
 * 展示从自然语言里拆出来的检索条件。
 *
 * 设计上只做一件事：**如实复述**。不改写、不美化、不隐藏空的项。
 *
 * 为什么空项也要显示（而不是"没抽到就不显示"）：
 * 用户说"帮我找近三年 AI Coding Agent 的 Tool Use 论文"，
 * 如果面板上只有关键词和时间两行，他会默认任务和方法也生效了。
 * 明确写出「任务：未识别」，他才知道这一条没起作用，
 * 然后换个说法（"AI 编程智能体"）再试。**空白的沉默比明确的缺失更有害。**
 *
 * 这个方法/任务识别不出来时会从关键词里兜底提取，
 * 所以下面"未识别"不总是意味着完全没进去检索——补一句说明。
 */
function ConditionPanel({ parsed, s2Query }: { parsed: ParsedQuery; s2Query: string }) {
  const rows: { label: string; value: string; empty: boolean; hint?: string }[] = [
    {
      label: '关键词',
      value: parsed.keywords.join('、'),
      empty: parsed.keywords.length === 0,
    },
    {
      label: '时间',
      value: parsed.yearLabel || '未提及',
      empty: !parsed.yearLabel,
      hint: parsed.yearRange ? `${parsed.yearRange.from}–${parsed.yearRange.to}` : '不限年份',
    },
    { label: '任务', value: parsed.task || '未识别', empty: !parsed.task },
    { label: '方法', value: parsed.method || '未识别', empty: !parsed.method },
  ]

  return (
    <Card className="p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-[13px] font-semibold text-ink-800">
          <IconSparkles className="h-3.5 w-3.5 text-brand-500" />
          检索条件
        </p>
        <span className="text-[11px] text-ink-400">
          由规则从你的输入中拆出，非模型生成
        </span>
      </div>

      <dl className="mt-2.5 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.label} className="flex min-w-0 items-baseline gap-2">
            <dt className="shrink-0 text-[11.5px] text-ink-400">{r.label}</dt>
            <dd
              className={
                'min-w-0 flex-1 truncate text-[12.5px] ' +
                (r.empty ? 'text-ink-300' : 'text-ink-700')
              }
              title={r.value}
            >
              {r.value}
              {r.hint && !r.empty && (
                <span className="ml-1.5 font-mono text-[11px] text-ink-400">{r.hint}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>

      {/* 实际送到 Semantic Scholar 的串。这是"可复现"的关键：换个工具也能搜出一样的 */}
      <div className="mt-2.5 border-t border-ink-200 pt-2.5">
        <p className="text-[11.5px] text-ink-400">
          实际检索串
          <code className="ml-1.5 rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] text-ink-700">
            {s2Query || parsed.s2Query}
          </code>
        </p>
        {(!parsed.task || !parsed.method) && (
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-amber-700">
            有条件下未被识别为「任务 / 方法」，但相关词已并入关键词参与检索。
            识别结果不符合预期时，换个说法（例如用论文里的标准术语）重搜即可。
          </p>
        )}
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

/**
 * 论文探索页（Phase 3B-2）。
 *
 * 定位：**项目之外的论文**进到项目里的通道。
 * 文献库那一页管的是"项目里已有什么"，这一页管的是"外面还有什么值得收进来"。
 *
 * 三个刻意的设计决定：
 *
 *  1. **搜索是手动的，不是即时的。** 输入框每敲一个字就去打 S2，
 *     既浪费服务端出网配额（匿名限流很紧），又会让结果在半截关键词上乱跳。
 *     用户按回车或点按钮才发请求。
 *
 *  2. **Mock 必须显眼。** S2 限流时服务端会返回占位数据。
 *     这些占位数据同样有标题、作者、年份，看起来和真的没区别——
 *     所以每张卡片都带来源徽标，且 Mock 卡片整体降调处理，
 *     顶部还有一条总说明。宁可显得啰嗦，也不能让用户把示例论文当成真的收进项目。
 *
 *  3. **加入后按钮变「已加入」并且禁用。** 不只是视觉反馈——
 *     服务端也按 s2_paper_id 去重，刷新页面后重新搜到同一篇，
 *     按钮状态会从项目数据里重新算出来，不会退回到「加入当前项目」。
 */
export function ExplorerPage() {
  const { id } = useParams<{ id: string }>()
  const pid = id ?? DEMO_PROJECT_ID
  const navigate = useNavigate()
  const { push } = useToast()

  const [query, setQuery] = useState('')
  /** 真正发出去的那个词。和输入框分开，避免"输入框变了但结果还是上一次的" */
  const [submitted, setSubmitted] = useState('')
  const [papers, setPapers] = useState<S2Paper[]>([])
  const [source, setSource] = useState<'live' | 'mock'>('live')
  const [note, setNote] = useState('')
  const [authenticated, setAuthenticated] = useState(false)
  /** 自然语言解析出的检索条件。null = 服务端没做解析（或还没搜过） */
  const [parsed, setParsed] = useState<ParsedQuery | null>(null)
  /** 实际送给 S2 的检索串，用于在条件面板里显示"Agent 改写成了什么" */
  const [s2Query, setS2Query] = useState('')

  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  /** 已经搜过一次没有——用来区分"还没搜"和"搜了但没结果" */
  const [searched, setSearched] = useState(false)

  /** 项目里已有的 S2 论文 id（用于「已加入」状态） */
  const [inProject, setInProject] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState<Set<string>>(new Set())
  const [existingCount, setExistingCount] = useState(0)

  /**
   * 批量选择（Phase 3B-6）。
   *
   * 存的是**剥掉 mock: 前缀后的 id**，与 inProject 用同一套键：
   * 否则「已加入」判定和选择判定会各说各话，
   * 表现为一篇已加入的论文仍可勾选，然后提交时被服务端拒掉。
   * 这也正是服务端做去重键时用的那个值（见 addToProject 的注释）。
   */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchBusy, setBatchBusy] = useState(false)

  /**
   * S2 总开关。
   *
   * 关掉时（ENABLE_SEMANTIC_SCHOLAR=false，离线演示用）服务端会直接返回空列表，
   * 此时不该让用户一遍遍地点搜索然后每次都得到"没有找到"——
   * 那不是"查不到"，是"这个功能没开"。两种结论必须分开说。
   */
  const [s2Enabled, setS2Enabled] = useState(true)

  useEffect(() => {
    let alive = true
    api
      .config()
      .then((c) => {
        if (alive) setS2Enabled(c.semanticScholar?.enabled ?? true)
      })
      .catch(() => {
        /* 读不到配置就当它是开的：真正不可用时搜索会自己给出降级说明 */
      })
    return () => {
      alive = false
    }
  }, [])

  /* ---------------- 读取项目现状，算出哪些已加入 ---------------- */

  /**
   * 已加入的判定依据是 `file_hash === 'meta:' + s2_paper_id`。
   *
   * 这是服务端 metaPaper.ts 里写死的约定。前端复用它而不是另外发明一套标记，
   * 是因为两处一旦不一致，就会出现"服务端认为加过了、前端认为没加"，
   * 表现为按钮一直可点、点了几次都提示"已存在"——很难查。
   */
  const refreshProject = useCallback(async () => {
    try {
      const r = await loadDataset(pid)
      const ids = new Set<string>()
      let count = 0
      for (const p of r.dataset.raw?.papers ?? []) {
        const m = /^meta:(.+)$/.exec(p.file_hash ?? '')
        if (m) {
          ids.add(m[1])
          count++
        }
      }
      setInProject(ids)
      setExistingCount(count)
    } catch {
      /*
       * 读不到项目不算搜索失败——用户可能是先来搜、一会儿再决定加哪个。
       * 此时把已加入集合留空，按钮全部可点，真去加的时候服务端还会拦一次重复。
       */
      setInProject(new Set())
      setExistingCount(0)
    }
  }, [pid])

  useEffect(() => {
    // 异步起步，避免在 effect 内同步 setState（lint: set-state-in-effect）
    let alive = true
    void Promise.resolve().then(() => {
      if (alive) void refreshProject()
    })
    return () => {
      alive = false
    }
  }, [refreshProject])

  /* ---------------- 搜索 ---------------- */

  const runSearch = useCallback(
    async (q: string) => {
      const kw = q.trim()
      if (!kw || searching) return

      setSearching(true)
      setSearchError(null)
      setSubmitted(kw)
      /*
       * 换一次搜索就清空选择。
       *
       * 不清的话，"已选择 3 篇"里会混进上一次结果里的论文——
       * 它们已经不在页面上了，用户看不见自己到底要提交什么。
       * 一个看不见内容的提交按钮比没有这个功能更危险。
       */
      setSelected(new Set())
      try {
        const r = await api.s2Search(kw, 10)
        setPapers(r.papers)
        setSource(r.source)
        setNote(r.note ?? '')
        setAuthenticated(r.authenticated)
        setParsed(r.parsed ?? null)
        setS2Query(r.s2_query ?? r.query ?? kw)
      } catch (e) {
        const msg =
          e instanceof ApiCallError ? e.message : e instanceof Error ? e.message : String(e)
        setSearchError(msg)
        setPapers([])
        /*
         * 失败时把条件面板清掉。
         *
         * 留着上一次的条件会非常误导：面板上写着「近三年 · Tool Use」，
         * 下面却是一条红色的错误，用户会以为是"这些条件搜不到"，
         * 而其实是网络根本没通。
         */
        setParsed(null)
        setS2Query('')
      } finally {
        setSearched(true)
        setSearching(false)
      }
    },
    [searching],
  )

  /* ---------------- 加入当前项目 ---------------- */

  const addToProject = useCallback(
    async (p: S2Paper) => {
      // 用 paper_id 作 key。Mock 数据也带 id，所以这里天然能标出"哪一张在转"
      const key = p.paper_id
      setAdding((prev) => new Set(prev).add(key))
      try {
        const r = await api.addMetaPaper(pid, {
          /*
           * 剥掉 mock: 前缀再提交。
           * 服务端拿这个值做去重键，带上前缀会让同一篇论文
           * 在 live 搜到和 mock 搜到时算成两条。
           */
          s2_paper_id: p.paper_id.replace(/^mock:/, ''),
          title: p.title,
          authors: p.authors,
          year: p.year,
          abstract: p.abstract,
          url: p.url,
          doi: p.doi,
          citationCount: p.citationCount,
          venue: p.venue,
          source: p.source,
        })

        setInProject((prev) => new Set(prev).add(p.paper_id.replace(/^mock:/, '')))

        push({
          title: r.created ? '已加入当前项目' : '这篇已在本项目中',
          description: r.created
            ? `「${p.title.slice(0, 40)}${p.title.length > 40 ? '…' : ''}」已登记为待分析。它现在只有元数据——想抽取方法与证据，需要上传 PDF。`
            : '无需重复加入，文献库里已经有它了。',
          tone: r.created ? 'success' : 'info',
        })
        void refreshProject()
      } catch (e) {
        const msg =
          e instanceof ApiCallError ? e.message : e instanceof Error ? e.message : String(e)
        push({ title: '加入失败', description: msg, tone: 'error' })
      } finally {
        setAdding((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    },
    [pid, push, refreshProject],
  )

  /* ---------------- 批量加入（Phase 3B-6） ---------------- */

  /** 把 S2Paper 转成提交结构。剥掉 mock: 前缀——服务端拿它做去重键 */
  const toInput = useCallback(
    (p: S2Paper) => ({
      s2_paper_id: p.paper_id.replace(/^mock:/, ''),
      title: p.title,
      authors: p.authors,
      year: p.year,
      abstract: p.abstract,
      url: p.url,
      doi: p.doi,
      citationCount: p.citationCount,
      venue: p.venue,
      source: p.source,
    }),
    [],
  )

  /**
   * 可选择的论文。
   *
   * 已加入的**不进入候选**——需求要求"默认不可重复选择"。
   * 把它排除在候选之外（而不是允许勾选后再禁用提交）的好处是：
   * "全选当前结果"的语义变干净了，用户不会遇到
   * "全选之后按钮还是灰的、为什么"这种需要解释的状态。
   */
  const selectable = useMemo(
    () => papers.filter((p) => !inProject.has(p.paper_id.replace(/^mock:/, ''))),
    [papers, inProject],
  )

  const allSelected = selectable.length > 0 && selectable.every((p) => selected.has(p.paper_id.replace(/^mock:/, '')))

  const toggleOne = useCallback((rawId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(rawId)) next.delete(rawId)
      else next.add(rawId)
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      // 已经全选 → 取消全部；否则选中当前全部可选项（不清掉已有的）
      const ids = selectable.map((p) => p.paper_id.replace(/^mock:/, ''))
      const isAll = ids.length > 0 && ids.every((i) => prev.has(i))
      if (isAll) {
        const next = new Set(prev)
        for (const i of ids) next.delete(i)
        return next
      }
      return new Set([...prev, ...ids])
    })
  }, [selectable])

  const submitBatch = useCallback(async () => {
    if (selected.size === 0 || batchBusy) return

    /*
     * 从 selected 里的 id 反查论文对象。
     *
     * 必须是反查而不是直接用 papers.filter——两者的差别在**顺序**：
     * selected 是用户勾选的顺序，papers 是相关性排序后的顺序。
     * 用 papers 的顺序提交，服务端写入的顺序就与界面显示一致，
     * 文献库里看起来也是按相关性排列的。
     */
    const items = papers.filter((p) => selected.has(p.paper_id.replace(/^mock:/, ''))).map(toInput)
    if (items.length === 0) return

    setBatchBusy(true)
    try {
      const r = await api.addMetaPapersBatch(pid, items)

      /*
       * 文案按三类分别说。
       *
       * 不写"成功加入 N 篇"这种笼统话：用户勾了 5 篇，
       * 到底 5 篇都是新加的还是其中 2 篇早就在项目里，
       * 直接决定他要不要回文献库再看一遍。含糊的提示等于没提示。
       */
      const parts: string[] = []
      if (r.created) parts.push(`新增 ${r.created} 篇`)
      if (r.existing) parts.push(`已在项目中 ${r.existing} 篇`)
      if (r.failed) parts.push(`失败 ${r.failed} 篇`)

      push({
        title: r.failed ? '批量加入部分完成' : '批量加入完成',
        description: parts.join(' · ') || '没有需要加入的论文',
        tone: r.failed ? 'warn' : 'success',
      })

      /*
       * 只清掉成功的，**失败的保持勾选**。
       * 全清的话用户得重新找出来是哪几条失败了，而提示里的错误信息
       * 只说得出 id——那几乎等于让他重来一遍。
       */
      const okIds = new Set([...r.created_ids, ...r.existing_ids])
      setSelected((prev) => new Set([...prev].filter((id) => !okIds.has(id))))

      // 刷新列表状态：服务端已写入，重新读一遍拿到真实的「已加入」集合
      void refreshProject()
    } catch (e) {
      const msg =
        e instanceof ApiCallError ? e.message : e instanceof Error ? e.message : String(e)
      push({ title: '批量加入失败', description: msg, tone: 'error' })
    } finally {
      setBatchBusy(false)
    }
  }, [selected, batchBusy, papers, toInput, pid, push, refreshProject])

  const pendingCount = useMemo(
    () => inProject.size,
    [inProject],
  )

  const isMock = source === 'mock'

  return (
    <div className="mp-anim-fade-up space-y-5">
      <PageHeader
        title="论文探索"
        subtitle="从 Semantic Scholar 检索项目之外的论文，把值得读的收进当前项目"
        meta={
          <>
            <Chip tone={authenticated ? 'success' : 'neutral'}>
              {authenticated ? '已配置 API Key' : '匿名访问'}
            </Chip>
            {pendingCount > 0 && <Chip tone="brand">本项目已收 {pendingCount} 篇</Chip>}
          </>
        }
        actions={
          <button
            className="mp-btn mp-btn-ghost"
            onClick={() => navigate(`/project/${pid}/papers`)}
          >
            <IconLayers className="h-3.5 w-3.5" /> 去文献库
          </button>
        }
      />

      {/* 搜索框 */}
      <Card className="p-3">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void runSearch(query)
          }}
        >
          <div className="relative min-w-[240px] flex-1">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="mp-input pl-9"
              placeholder="说一句话，或直接输入关键词。例如：帮我找近三年 AI Coding Agent 的 Tool Use 论文"
              aria-label="检索 Semantic Scholar"
            />
          </div>
          <button
            type="submit"
            className="mp-btn mp-btn-primary"
            disabled={searching || !query.trim() || !s2Enabled}
          >
            <IconSearch className="h-3.5 w-3.5" />
            {searching ? '检索中…' : '搜索'}
          </button>
        </form>

        {/*
         * 功能被关掉时明说，而不是让用户搜了才发现是空的。
         * 这两种情况在界面上长得一样（都没有结果），但含义完全不同。
         */}
        {!s2Enabled && (
          <div className="mt-2.5 flex items-start gap-2 border-t border-ink-200 pt-2.5">
            <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            <p className="text-[11.5px] leading-relaxed text-ink-500">
              Semantic Scholar 查询已通过 <code className="font-mono">ENABLE_SEMANTIC_SCHOLAR=false</code> 关闭，
              不会发起任何外部请求。需要检索外部文献时，去掉该环境变量并重启服务端。
            </p>
          </div>
        )}

        {/*
         * 示例查询。第一条是自然语言整句，直接示范新能力——
         * 只给关键词示例的话，用户不会想到可以整句说。
         */}
        {!searched && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-ink-200 pt-2.5">
            <span className="text-[11.5px] text-ink-400">试试：</span>
            {[
              '帮我找近三年 AI Coding Agent 的 Tool Use 论文',
              '近五年 chain of thought 的推理方法',
              '2022 年以来 multi-agent 协作的论文',
              'retrieval augmented generation evaluation',
            ].map((s) => (
              <button
                key={s}
                className="mp-chip bg-ink-100 text-ink-600 transition hover:bg-brand-50 hover:text-brand-700"
                onClick={() => {
                  setQuery(s)
                  void runSearch(s)
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* Mock 总说明：只要结果是 mock 就常驻，不折叠 */}
      {isMock && papers.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/60 p-3.5">
          <div className="flex items-start gap-2">
            <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-amber-900">
                以下全部为示例数据
                <ModeBadge mode="MOCK" />
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-amber-800">
                {note || 'Semantic Scholar 当前不可达，已降级为占位数据。'}
                <br />
                <span className="font-medium">
                  这些记录不代表任何真实论文，请不要据此判断某个方向已有多少工作。
                </span>
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* 四态：加载 / 报错 / 未搜索 / 无结果 / 列表 */}
      {searching ? (
        <Card className="p-4">
          <SkeletonState rows={4} />
        </Card>
      ) : searched && !searchError && parsed && parsed.understood ? (
        /*
         * 【检索条件】面板。
         *
         * 放在结果**上方**，且"搜到 0 篇"时也照常显示——
         * 恰恰是没结果的时候，用户最需要看到"我到底拿什么去搜了"。
         * 只有错误分支不显示：那时候连搜索都没发生，显示条件是误导。
         */
        <ConditionPanel parsed={parsed} s2Query={s2Query} />
      ) : null}

      {searching ? null : searchError ? (
        <Card className="p-4">
          <p className="text-[13px] font-semibold text-rose-700">检索失败</p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-500">
            {searchError}
          </p>
          <button className="mp-btn mp-btn-soft mt-3" onClick={() => void runSearch(submitted || query)}>
            重试
          </button>
        </Card>
      ) : !searched ? (
        <EmptyState
          title="搜索项目之外的论文"
          description="可以直接说一句话，比如「帮我找近三年 AI Coding Agent 的 Tool Use 论文」。系统会先拆出关键词、时间、任务、方法，再拿去检索；拆出来的条件会列在结果上方，你可以核对后再决定要不要换个说法。检索结果只取元数据——标题、作者、年份、摘要、DOI。"
        />
      ) : papers.length === 0 ? (
        <EmptyState
          title={`没有找到与「${submitted}」相关的论文`}
          description={
            note ||
            '换个更具体的词试试，或者用论文标题里的关键术语。Semantic Scholar 对精确的技术名词匹配更好。'
          }
        />
      ) : (
        <div className="space-y-3">
          <SectionTitle
            title={`检索结果 · ${papers.length} 篇`}
            subtitle={
              /*
               * 显示实际送去检索的串，而不是用户原话。
               * 两者不同时这个差别本身就是信息——用户能看出 Agent 是怎么改写的。
               */
              parsed && parsed.s2Query !== submitted
                ? `实际检索串「${s2Query}」`
                : `关键词「${submitted}」`
            }
            action={
              <label className="flex cursor-pointer select-none items-center gap-2 text-[12px] text-ink-600">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-brand-600"
                  checked={allSelected}
                  /*
                   * 没有任何可选项时禁用。
                   * 不禁用的话会渲染成一个可点、但点了什么也不发生的复选框，
                   * 用户会以为是自己点错了。
                   */
                  disabled={selectable.length === 0}
                  onChange={toggleAll}
                />
                全选当前结果
                {selectable.length < papers.length && (
                  <span className="text-ink-400">
                    （{selectable.length} 篇可选）
                  </span>
                )}
              </label>
            }
          />

          {papers.map((p) => {
            const rawId = p.paper_id.replace(/^mock:/, '')
            const joined = inProject.has(rawId)
            const busy = adding.has(p.paper_id)
            const isCardMock = p.source === 'mock'
            const isChecked = selected.has(rawId)

            return (
              <Card
                key={p.paper_id}
                className={
                  isCardMock
                    ? 'border-amber-200 bg-amber-50/30 p-4'
                    : 'p-4 transition hover:border-brand-200'
                }
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
                  {/*
                    复选框（Phase 3B-6）。
                    已加入的渲染成 disabled + checked，而不是直接不渲染：
                    位置稳定、用户能看出"这一篇已经在了"，
                    比整块消失更好理解（消失会让人以为列表变了）。
                  */}
                  <div className="flex shrink-0 items-center pt-0.5">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-brand-600"
                      checked={joined || isChecked}
                      disabled={joined}
                      onChange={() => toggleOne(rawId)}
                      aria-label={`选择「${p.title}」`}
                      title={joined ? '这篇已经在当前项目里了' : '选择这篇以批量加入'}
                    />
                  </div>
                  {/* 主体 */}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start gap-2">
                      <h3 className="min-w-0 flex-1 text-[14px] font-semibold leading-snug text-ink-900">
                        {p.title}
                      </h3>
                      {/* 来源徽标：每张卡片都有，不依赖顶部那条总说明 */}
                      <Chip tone={isCardMock ? 'warn' : 'success'}>
                        {isCardMock ? '示例数据' : 'Semantic Scholar'}
                      </Chip>
                      {/*
                        「已加入」徽标（Phase 3B-6）。
                        复选框是 disabled+checked 的，但那个状态很轻、容易被忽略，
                        所以再加一个明确的文字徽标：用户扫一眼就知道为什么勾不动。
                      */}
                      {joined && <Chip tone="brand">已加入</Chip>}
                    </div>

                    {/* 元信息行：作者 / 年份 / 引用数 / DOI */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-500">
                      <span className="text-ink-700">{authorLine(p.authors)}</span>
                      <span className="font-mono tabular-nums text-ink-400">
                        {p.year > 0 ? p.year : '年份未知'}
                      </span>
                      {p.venue && <span className="truncate">{p.venue}</span>}
                      <span className="font-mono tabular-nums text-ink-400">
                        被引 {p.citationCount}
                      </span>
                      {/*
                        相关性百分比。
                        relevance 缺失时**不显示 0%**——那是"没算"而不是"算了是 0"，
                        两者显示成一样会误导。references/citations 路径就没有这个字段。
                        而真实的 0% 照常显示：用户看到 0% 会立刻明白
                        "检索词一个都没命中"，这比留空更有用——
                        留空会被读成"没有这个信息"，而它有。
                      */}
                      {p.relevance && (
                        <span
                          className={`font-mono tabular-nums ${relevanceTone(p.relevance.percent)}`}
                          title={RELEVANCE_HINT}
                        >
                          相关性 {p.relevance.percent}%
                        </span>
                      )}
                      {p.doi && (
                        <span className="font-mono text-ink-400">DOI {p.doi}</span>
                      )}
                    </div>

                    {/* 摘要 */}
                    {p.abstract ? (
                      <p className="mt-2 text-[12px] leading-relaxed text-ink-600">
                        {abstractPreview(p.abstract)}
                      </p>
                    ) : (
                      <p className="mt-2 text-[12px] italic text-ink-400">
                        这篇论文没有公开摘要
                      </p>
                    )}

                    {/* 外链 */}
                    {p.url && (
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-brand-600 transition hover:text-brand-700 hover:underline"
                      >
                        <IconExternalLink className="h-3 w-3" />
                        在 Semantic Scholar 打开
                      </a>
                    )}
                  </div>

                  {/* 操作 */}
                  <div className="flex shrink-0 flex-col items-stretch gap-2 lg:w-[132px]">
                    <button
                      className={joined ? 'mp-btn mp-btn-ghost' : 'mp-btn mp-btn-primary'}
                      disabled={joined || busy}
                      onClick={() => void addToProject(p)}
                      title={
                        joined
                          ? '这篇论文已经在当前项目的文献库里了'
                          : '只登记元数据，不下载 PDF、不调用模型'
                      }
                    >
                      {joined ? (
                        <>
                          <IconCheck className="h-3.5 w-3.5" /> 已加入
                        </>
                      ) : busy ? (
                        '加入中…'
                      ) : (
                        <>
                          <IconPlus className="h-3.5 w-3.5" /> 加入当前项目
                        </>
                      )}
                    </button>
                    {/*
                      引用关系入口（Phase 3B-5）。
                      用 paper_id 而不是标题做路径参数：标题会变、可能重复、
                      还可能含斜杠。paper_id 缺失时不渲染按钮——
                      渲染一个点不动的入口比没有入口更让人困惑。
                    */}
                    {p.paper_id && (
                      <button
                        className="mp-btn mp-btn-soft"
                        onClick={() =>
                          navigate(
                            `/project/${pid}/explorer/paper/${encodeURIComponent(p.paper_id)}`,
                          )
                        }
                        title="查看这篇论文的参考文献与被引用论文"
                      >
                        <IconLink className="h-3.5 w-3.5" /> 引用关系
                      </button>
                    )}
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {/*
        底部固定操作栏（Phase 3B-6）。
        只在有可选项且不在搜索中时出现——搜索结果为空时出现一条
        "已选择 0 篇"的栏只是噪声。
      */}
      {searched && !searchError && !searching && selectable.length > 0 && (
        <div className="sticky bottom-4 z-20">
          <Card className="flex flex-wrap items-center justify-between gap-3 border-brand-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
            <div className="flex items-center gap-3">
              <span className="text-[13px] font-medium text-ink-800">
                已选择 {selected.size} 篇
              </span>
              {selected.size === 0 && (
                <span className="text-[11.5px] text-ink-400">
                  勾选结果卡片左侧的复选框，可一次加入多篇
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {selected.size > 0 && (
                <button
                  className="mp-btn mp-btn-ghost"
                  onClick={() => setSelected(new Set())}
                  disabled={batchBusy}
                >
                  清空选择
                </button>
              )}
              <button
                className="mp-btn mp-btn-primary"
                disabled={selected.size === 0 || batchBusy}
                onClick={() => void submitBatch()}
                /*
                 * 空选时也渲染按钮（只是灰掉），而不是隐藏。
                 * 隐藏会让操作栏的位置随选择数跳动，
                 * 也让用户看不出"这里本来有个批量入口、只是还没选"。
                 */
                title={selected.size === 0 ? '先勾选要加入的论文' : '只登记元数据，不下载 PDF、不调用模型'}
              >
                {batchBusy ? '加入中…' : `加入当前项目${selected.size > 0 ? `（${selected.size}）` : ''}`}
              </button>
            </div>
          </Card>
        </div>
      )}

      {/* 说明 */}
      <SectionTitle
        title="关于论文探索"
        subtitle="这一页只做「发现 → 登记」，不做自动抓取和分析"
      />
      <div className="grid gap-3 md:grid-cols-3">
        {[
          {
            t: '检索来源',
            d: 'Semantic Scholar Graph API。未配置 API Key 时走匿名访问，配额较紧；配置 SEMANTIC_SCHOLAR_API_KEY 后服务端会自动带上请求头。',
          },
          {
            t: '加入后是什么状态',
            d: '论文以「待分析」进入文献库，只保存元数据——没有 PDF、没有章节、没有方法与证据。这是如实的状态，不是失败。',
          },
          {
            t: '怎么真正分析它',
            d: '拿到这篇论文的 PDF 后到「上传论文」页上传。服务端会解析正文、抽取方法，并对每条证据做逐字回验。',
          },
        ].map((x) => (
          <Card key={x.t} className="p-4">
            <p className="text-[13px] font-semibold text-ink-800">{x.t}</p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-500">{x.d}</p>
          </Card>
        ))}
      </div>

      {existingCount > 0 && (
        <p className="text-[11.5px] text-ink-400">
          当前项目已通过本页收录 {existingCount} 篇元数据论文。
          {pendingCount > 0 && ' 其中尚未上传 PDF 的会一直显示为「待分析」。'}
        </p>
      )}
    </div>
  )
}
