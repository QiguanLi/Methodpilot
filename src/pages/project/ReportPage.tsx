import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { clsx } from 'clsx'
import { PageHeader } from '@/components/AppLayout'
import {
  Card,
  Chip,
  EmptyState,
  IconAlert,
  IconCheck,
  IconCopy,
  IconDownload,
  IconLayers,
  IconQuote,
  IconRefresh,
  IconReport,
  SkeletonState,
} from '@/components/ui'
import { useEvidenceDrawer, useToast } from '@/context/AppContext'
import {
  api,
  type ReportEvidenceIndexEntry,
  type ReportRef,
  type ReportSection,
  type ReportStatementKind,
  type ResearchReportResponse,
} from '@/services/api'
import { DEMO_PROJECT_ID, loadDataset, registerDataset, type ProjectDataset } from '@/services/projectData'
import { generateReport, type GenerateReportResult } from '@/services/agent'

/* ================================================================== */
/* 页面入口：数据集加载 + Live / Demo 分流                              */
/* ================================================================== */

/**
 * 三层分流，**顺序不可调换**：
 *
 *   loading   → 数据集尚未就绪
 *   loadError → 数据集加载失败（含项目不存在）
 *   readError → Live 报告接口报错
 *   Live      → 走 buildResearchReport() 的结构化报告
 *   Demo      → 兜底，保持原有 `generateReport()` 的 Markdown 报告
 *
 * `loadError` 必须排在 Demo 之前：加载失败时 `dataset` 是 null、`isLive` 为 false，
 * 若先判 Demo，**一个不存在的项目 id 会显示演示知识库的报告** ——
 * 把演示数据伪装成对用户项目的分析结论。这与 4-6 / 4-7 是同一类错误，
 * 在 EvidenceDrawer 上已经真实发生过一次。
 */
export function ReportPage() {
  const { id } = useParams()
  const pid = id ?? DEMO_PROJECT_ID

  const [dataset, setDataset] = useState<ProjectDataset | null>(null)
  const [loadedPid, setLoadedPid] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [resp, setResp] = useState<ResearchReportResponse | null>(null)
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
         * ⚠️ Live 证据回链的前提（但本页**不是**唯一在注册的地方）。
         *
         * EvidenceDrawer 挂在 <Routes> 之外，只能按 evidence_id 反查注册表；
         * 注册表为空时它会**回落到 Demo 的 getEvidence()**。于是点开真实报告里的
         * E005，抽屉里显示演示论文的原文 —— 看起来完全正常，实际张冠李戴。
         *
         * 实测：`Shell` 里的 `ProjectStatsProvider`（侧栏统计那次修复加的）
         * 已经对每个项目路由注册过一份，所以本次调用是**冗余兜底** ——
         * 删掉它 UI 测试依然全绿。保留它是防御性的：本页不依赖"别人已经注册过"
         * 这个外部事实，把正确性收在自己手里。属于"多写一次无害、少写一次危险"。
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

  /* ── 报告接口（仅 Live）── */

  useEffect(() => {
    /*
     * Demo 不发这个请求：它的报告来自知识库人工标注，
     * 服务端对该项目也没有 bundle，调了只会拿到 404。
     *
     * 守卫用 `return` 早退、**不在 effect 里同步清空 state** ——
     * 清空交给下面的 `readResp` / `readError` 派生完成。
     */
    if (dataset?.source !== 'live') return

    let alive = true
    api
      .getReport(pid)
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
  }, [pid, dataset])

  const isLive = dataset?.source === 'live'

  /** 只有 Live 才认接口结果 —— 从渲染路径上直接切断，不留中间态 */
  const readResp = isLive ? resp : null
  const readError = isLive ? error : null
  const loading = loadedPid !== pid || (isLive && !readResp && !readError)

  if (loading) {
    return (
      <div className="mp-anim-fade-up space-y-5">
        <PageHeader title="研究调研报告" subtitle="正在汇总结构化结果…" />
        <Card className="p-6">
          <div className="mb-4 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
              <IconReport className="h-4 w-4" />
            </span>
            <p className="text-[13px] font-medium text-ink-700">正在汇总分析结果…</p>
          </div>
          <SkeletonState rows={8} />
        </Card>
      </div>
    )
  }

  /* ── 数据集加载失败：必须走错误态，不能落入 Demo 分支 ── */
  if (loadError) {
    return (
      <div className="mp-anim-fade-up space-y-5" data-report-page="error">
        <PageHeader title="研究调研报告" subtitle="项目加载失败" />
        <Card className="border-rose-200 bg-rose-50/60 p-6">
          <div className="flex items-start gap-3">
            <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
            <div>
              <p className="text-[13px] font-semibold text-rose-800">项目加载失败</p>
              <p className="mt-1 text-[12px] leading-relaxed text-rose-700" data-report-error="load">
                无法加载项目 {pid}：{loadError}
              </p>
              <p className="mt-2 text-[11.5px] text-rose-600/80">
                这里显示的是错误，而不是演示报告 —— 演示知识库不属于你的项目。
              </p>
            </div>
          </div>
        </Card>
      </div>
    )
  }

  if (readError) {
    return (
      <div className="mp-anim-fade-up space-y-5" data-report-page="error">
        <PageHeader title="研究调研报告" subtitle="报告加载失败" />
        <Card className="border-rose-200 bg-rose-50/60 p-6">
          <div className="flex items-start gap-3">
            <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
            <div>
              <p className="text-[13px] font-semibold text-rose-800">报告加载失败</p>
              <p className="mt-1 text-[12px] leading-relaxed text-rose-700" data-report-error="read">
                {readError}
              </p>
            </div>
          </div>
        </Card>
      </div>
    )
  }

  if (isLive && readResp) {
    return <LiveReportView pid={pid} resp={readResp} />
  }

  return <DemoReportView />
}

/* ================================================================== */
/* 陈述层级的中文元信息 —— 页面分区的**唯一依据**                        */
/* ================================================================== */

/**
 * 三类陈述的展示元信息。
 *
 * `short` 是徽标上的短标签，`desc` 是悬浮/说明用的一句话。
 * 之所以要给每一类都配**文字**而不是只给颜色：
 * 色盲用户、灰度打印、截图传播时，颜色会全部丢失 ——
 * 而"这是论文说的"和"这是系统算的"是这个页面上最重要的区分，
 * 不能依赖颜色承载。
 */
const STMT_META: Record<
  ReportStatementKind,
  { short: string; full: string; desc: string; tone: 'success' | 'brand' | 'warn' }
> = {
  stated_fact: {
    short: '论文原文',
    full: '论文原文事实',
    desc: '论文里确实写了的，可直接引用',
    tone: 'success',
  },
  system_analysis: {
    short: '系统分析',
    full: '系统分析',
    desc: '系统对本项目语料的统计与归纳，不是论文观点',
    tone: 'brand',
  },
  system_suggestion: {
    short: '系统建议',
    full: '系统建议',
    desc: '系统给出的建议，不构成对现状的陈述',
    tone: 'warn',
  },
}

/** 章节状态的中文说明 */
const SECTION_STATUS_META: Record<
  ReportSection['status'],
  { label: string; tone: 'success' | 'warn' | 'danger' }
> = {
  ok: { label: '完整', tone: 'success' },
  partial: { label: '部分覆盖', tone: 'warn' },
  insufficient: { label: '暂无足够证据', tone: 'danger' },
}

/** 章节 id → 目录锚点 / 序号。顺序与需求的七块逐项对应 */
const LIVE_NAV: { id: string; label: string; index: string }[] = [
  { id: 'topic', label: '研究主题', index: '一' },
  { id: 'literature', label: '文献概览', index: '二' },
  { id: 'methods', label: '方法分类', index: '三' },
  { id: 'evolution', label: '技术演进', index: '四' },
  { id: 'gaps', label: '研究空白', index: '五' },
  { id: 'directions', label: '研究方向', index: '六' },
  { id: 'evidence_index', label: 'Evidence 索引', index: '七' },
]

/** 回链类型的中文名 */
const REF_KIND_LABEL: Record<ReportRef['kind'], string> = {
  paper: '论文',
  method: '方法',
  evidence: '证据',
  gap: '空白',
  direction: '方向',
  alignment: '对齐',
  evolution: '演进',
}

/* ================================================================== */
/* Live：结构化报告的七个章节                                           */
/* ================================================================== */

function LiveReportView({ pid, resp }: { pid: string; resp: ResearchReportResponse }) {
  const report = resp.report
  const { open: openEvidence } = useEvidenceDrawer()
  const [active, setActive] = useState('topic')
  const [copied, setCopied] = useState(false)
  const { push } = useToast()

  /**
   * 报告纯文本 —— 供"复制"用。
   *
   * 刻意**带上层级前缀**（【论文原文】/【系统分析】/【系统建议】），
   * 因为复制出去的文本会脱离页面的视觉区分：不加前缀，
   * 用户把系统建议贴进立项书就会变成一句没有出处的事实陈述。
   */
  const plainText = buildReportPlainText(report)

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(plainText)
      setCopied(true)
      push({
        title: '已复制到剪贴板',
        description: '每条陈述都带层级前缀，避免脱离页面后失去区分',
        tone: 'success',
      })
      setTimeout(() => setCopied(false), 2000)
    } catch {
      push({ title: '复制失败', description: '浏览器限制了剪贴板访问', tone: 'error' })
    }
  }

  /* ── 空项目：不伪装成报告 ── */

  const isEmptyProject =
    report.layering.stated_fact === 0 &&
    report.layering.total_refs === 0 &&
    report.layering.insufficient_sections === report.sections.length

  return (
    <div className="mp-anim-fade-up space-y-5" data-report-page="live" data-report-id={report.report_id}>
      <PageHeader
        title="研究调研报告"
        subtitle="确定性规则生成，全部结论可回链到原文证据"
        meta={
          <>
            <Chip tone="brand">{report.report_id}</Chip>
            <Chip tone="neutral">规则 {report.rule_version}</Chip>
          </>
        }
        actions={
          <>
            <button className="mp-btn mp-btn-ghost" onClick={copyAll}>
              {copied ? <IconCheck className="h-3.5 w-3.5" /> : <IconCopy className="h-3.5 w-3.5" />}
              {copied ? '已复制' : '复制全文'}
            </button>
          </>
        }
      />

      {/* 服务端不变量自检：只在真的有问题时出现，正常时完全不渲染 */}
      {resp.invariant_violations.length > 0 && (
        <Card className="border-rose-200 bg-rose-50/60 p-4" data-report-warning="invariants">
          <div className="flex items-start gap-3">
            <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
            <div>
              <p className="text-[13px] font-semibold text-rose-800">
                报告自检发现 {resp.invariant_violations.length} 处问题
              </p>
              <ul className="mt-1.5 space-y-1">
                {resp.invariant_violations.slice(0, 5).map((v) => (
                  <li key={v} className="text-[11.5px] leading-relaxed text-rose-700">
                    · {v}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      )}

      {/* ── 报告头部：标题 + 分层摘要 ── */}
      <Card className="p-6 sm:p-7">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-white">
            <IconReport className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-brand-600">
              MethodPilot 自动生成 · 确定性规则
            </p>
            <h1
              className="mt-1.5 text-[22px] font-semibold leading-tight tracking-tight text-ink-900"
              data-report-title="1"
            >
              {report.title}
            </h1>
            <p className="mt-2 max-w-3xl text-[12px] leading-relaxed text-ink-500" data-report-scope="1">
              {report.scope_note}
            </p>
          </div>
        </div>

        {/* 分层摘要 —— 让用户 3 秒内知道"多少是事实、多少是猜测" */}
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {(
            [
              ['stated_fact', '论文原文事实', '可直接引用的论文陈述'],
              ['system_analysis', '系统分析', '系统对语料的统计与归纳'],
              ['system_suggestion', '系统建议', '不构成对现状的陈述'],
            ] as const
          ).map(([k, t, d]) => (
            <div
              key={k}
              data-report-layering={k}
              className={clsx(
                'rounded-xl border p-3.5',
                k === 'stated_fact' && 'border-emerald-100 bg-emerald-50/40',
                k === 'system_analysis' && 'border-brand-100 bg-brand-50/40',
                k === 'system_suggestion' && 'border-amber-100 bg-amber-50/40',
              )}
            >
              <p className="font-mono text-[20px] font-semibold leading-none tabular-nums text-ink-800">
                {report.layering[k]}
              </p>
              <p className="mt-1.5 text-[12px] font-medium text-ink-700">{t}</p>
              <p className="mt-1 text-[10.5px] leading-relaxed text-ink-500">{d}</p>
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Chip tone="neutral">共 {report.layering.total_statements} 条陈述</Chip>
          <Chip tone="neutral">{report.layering.total_refs} 条回链</Chip>
          {report.layering.insufficient_sections > 0 && (
            <Chip tone="danger" data-report-stat="insufficient">
              {report.layering.insufficient_sections} 章暂无足够证据
            </Chip>
          )}
          {report.layering.partial_sections > 0 && (
            <Chip tone="warn" data-report-stat="partial">
              {report.layering.partial_sections} 章部分覆盖
            </Chip>
          )}
        </div>
      </Card>

      {isEmptyProject ? (
        /*
         * ⚠️ 空项目必须走**明确空态**，不能渲染成一份"看起来正常"的报告。
         *
         * 这份报告里每一章的正文都是「暂无足够证据」，`stated_fact` 与回链数
         * 都是 0 —— 把它当成普通报告渲染，读者会以为"系统分析完发现什么都没有"，
         * 而真相是"系统根本没有素材"。
         */
        <div data-report-empty="all">
          <EmptyState
            icon={<IconReport className="h-5 w-5" />}
            title="这份报告还没有可依据的语料"
            description={`${report.scope_note}\n上传论文并完成抽取后，系统会重新生成一份有内容、且每条结论都能回链原文的报告。`}
          />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[210px_minmax(0,1fr)]">
          {/* 目录 */}
          <div className="lg:sticky lg:top-5 lg:self-start">
            <Card className="p-3">
              <p className="mp-label mb-2 px-2">目录</p>
              <nav className="space-y-0.5">
                {LIVE_NAV.map((n) => (
                  <a
                    key={n.id}
                    href={`#${n.id}`}
                    data-report-nav={n.id}
                    onClick={() => setActive(n.id)}
                    className={clsx(
                      'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] transition',
                      active === n.id
                        ? 'bg-brand-50 font-medium text-brand-700'
                        : 'text-ink-600 hover:bg-ink-50',
                    )}
                  >
                    <span className="font-mono text-[10px] text-ink-400">{n.index}</span>
                    {n.label}
                  </a>
                ))}
              </nav>
            </Card>

            {/* 数据来源 */}
            <Card className="mt-3 p-3">
              <p className="mp-label mb-2 px-2">数据来源</p>
              <div className="space-y-1.5">
                {[
                  { k: '论文', v: maxOf(report.sections, 'papers', 'paper_total') },
                  { k: '方法', v: maxOf(report.sections, 'methods') },
                  { k: '证据', v: report.evidence_index.length },
                  { k: '研究空白', v: maxOf(report.sections, 'gaps') },
                  { k: '研究方向', v: maxOf(report.sections, 'directions') },
                ].map((x) => (
                  <div key={x.k} className="flex items-center justify-between px-2">
                    <span className="text-[11.5px] text-ink-500">{x.k}</span>
                    <span
                      data-report-stat={x.k}
                      className="font-mono text-[12px] font-medium tabular-nums text-ink-700"
                    >
                      {x.v}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* 正文 */}
          <Card className="p-5 sm:p-7">
            <div className="space-y-9">
              {/* 一、研究主题 —— 在 report.topic 里，**不在** sections 里 */}
              <TopicSection topic={report.topic} openEvidence={openEvidence} />

              {/* 二~七 */}
              {report.sections.map((s) => (
                <ReportSectionBlock
                  key={s.section_id}
                  section={s}
                  index={LIVE_NAV.find((n) => n.id === s.section_id)?.index ?? ''}
                  evidenceIndex={report.evidence_index}
                  openEvidence={openEvidence}
                />
              ))}
            </div>

            {/* 全局边界：再完整的一份报告也有边界 */}
            {report.global_limitations.length > 0 && (
              <div className="mt-9 border-t border-ink-200 pt-5" data-report-limitations="global">
                <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-700">
                  <IconAlert className="h-3.5 w-3.5 text-ink-400" />
                  这份报告没能覆盖什么
                </p>
                <ul className="mt-2 space-y-1.5">
                  {report.global_limitations.map((l) => (
                    <li key={l} className="flex gap-2 text-[11.8px] leading-relaxed text-ink-500">
                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ink-300" />
                      {l}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-8 flex flex-wrap items-center gap-2 border-t border-ink-200 pt-5">
              <Link to={`/project/${pid}/directions`} className="mp-btn mp-btn-soft">
                查看研究方向
              </Link>
              <Link to={`/project/${pid}/gaps`} className="mp-btn mp-btn-ghost">
                查看研究空白
              </Link>
              <Link to={`/project/${pid}/methods`} className="mp-btn mp-btn-ghost">
                返回方法地图
              </Link>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 一、研究主题 / 研究问题                                              */
/* ------------------------------------------------------------------ */

function TopicSection({
  topic,
  openEvidence,
}: {
  topic: ResearchReportResponse['report']['topic']
  openEvidence: (id: string) => void
}) {
  const nothing =
    topic.keywords.length === 0 &&
    topic.themes.length === 0 &&
    topic.families.length === 0 &&
    topic.research_questions.length === 0

  return (
    <section id="topic" data-report-section="topic" className="scroll-mt-5">
      <SectionHeading index="一" title="研究主题 / 研究问题" status="ok" />

      {nothing ? (
        <p className="mt-3 text-[12.5px] leading-relaxed text-ink-500" data-report-insufficient="topic">
          暂无足够证据。本项目还没有可用于归纳主题的论文、方法或空白数据。
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {/* 关键词频次 */}
          {topic.keywords.length > 0 && (
            <div>
              <p className="mp-label mb-2">语料高频关键词</p>
              <div className="flex flex-wrap gap-2">
                {topic.keywords.map((k) => (
                  <span
                    key={k.term}
                    data-report-keyword={k.term}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-ink-50/60 px-2.5 py-1 text-[12px] text-ink-700"
                  >
                    <span className="font-medium">{k.term}</span>
                    <span className="font-mono text-[10.5px] text-ink-400">×{k.count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 场景主题 + 方法族 */}
          <div className="grid gap-3 sm:grid-cols-2">
            {topic.themes.length > 0 && (
              <div className="rounded-xl border border-ink-200 p-3">
                <p className="mp-label mb-2">研究场景主题</p>
                <div className="space-y-1.5">
                  {topic.themes.map((t) => (
                    <div key={t.theme} className="flex items-center justify-between gap-2">
                      <span className="text-[12px] text-ink-700">{t.label}</span>
                      <span className="font-mono text-[11px] text-ink-400">{t.gap_count} 条空白</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {topic.families.length > 0 && (
              <div className="rounded-xl border border-ink-200 p-3">
                <p className="mp-label mb-2">方法族分布</p>
                <div className="space-y-1.5">
                  {topic.families.map((f) => (
                    <div key={f.family_id} className="flex items-start justify-between gap-2">
                      <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-ink-600">
                        <span className="font-mono font-semibold text-brand-600">{f.family_id}</span>{' '}
                        {f.method_names.slice(0, 3).join('、')}
                        {f.method_names.length > 3 ? ' 等' : ''}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-ink-400">×{f.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 系统形式化的研究问题 */}
          {topic.research_questions.length > 0 && (
            <div className="space-y-2.5">
              {topic.research_questions.map((st, i) => (
                <StatementRow key={i} st={st} openEvidence={openEvidence} />
              ))}
            </div>
          )}
        </div>
      )}

      <Limitations items={topic.limitations} />
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* 二~七：通用章节                                                      */
/* ------------------------------------------------------------------ */

function ReportSectionBlock({
  section,
  index,
  evidenceIndex,
  openEvidence,
}: {
  section: ReportSection
  index: string
  evidenceIndex: ReportEvidenceIndexEntry[]
  openEvidence: (id: string) => void
}) {
  /*
   * Evidence 索引章**不能**走 StatementRow 的普通路径：
   * 它的内容是"逐条证据 + 被谁引用"的表格，不是陈述列表。
   * 但它的 summary statement（"系统统计：共 7 条…"）仍要按层级渲染。
   */
  const isIndex = section.section_id === 'evidence_index'

  return (
    <section id={section.section_id} data-report-section={section.section_id} className="scroll-mt-5">
      <SectionHeading
        index={index}
        title={section.title}
        status={section.status}
        counts={section.source_counts}
      />

      {section.status === 'insufficient' ? (
        <p
          className="mt-3 text-[12.5px] leading-relaxed text-ink-500"
          data-report-insufficient={section.section_id}
        >
          {section.statements[0]?.text ?? '暂无足够证据。'}
        </p>
      ) : (
        <div className="mt-3 space-y-2.5">
          {section.statements.map((st, i) => (
            <StatementRow key={i} st={st} openEvidence={openEvidence} />
          ))}
        </div>
      )}

      {isIndex && section.status !== 'insufficient' && (
        <EvidenceIndexTable rows={evidenceIndex} openEvidence={openEvidence} />
      )}

      <Limitations items={section.limitations} />
    </section>
  )
}

function SectionHeading({
  index,
  title,
  status,
  counts,
}: {
  index: string
  title: string
  status: ReportSection['status']
  counts?: Record<string, number>
}) {
  const meta = SECTION_STATUS_META[status]
  return (
    <div className="border-b border-ink-200 pb-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="h-4 w-1 rounded-full bg-brand-500" />
        <h2 className="text-[16px] font-semibold tracking-tight text-ink-900">
          {index ? `${index}、` : ''}
          {title}
        </h2>
        <Chip tone={meta.tone} data-report-section-status={status}>
          {meta.label}
        </Chip>
        {/* 章节计数：给用户一个"这一章依据了多少条上游实体"的直观感受 */}
        {counts &&
          Object.entries(counts).map(([k, v]) => (
            <span
              key={k}
              data-report-section-count={`${k}`}
              className="font-mono text-[10.5px] text-ink-400"
            >
              {k} {v}
            </span>
          ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 一条陈述：层级徽标 + 正文 + 来源数量 + 可打开的 Evidence             */
/* ------------------------------------------------------------------ */

function StatementRow({
  st,
  openEvidence,
}: {
  st: { kind: ReportStatementKind; text: string; refs: ReportRef[] }
  openEvidence: (id: string) => void
}) {
  const meta = STMT_META[st.kind]
  const evidenceIds = st.refs.filter((r) => r.kind === 'evidence').map((r) => r.id)

  /*
   * 三条陈述的视觉区分**同时**用三样东西承载：
   *   ① 左侧色条 + 底色（快）
   *   ② 层级徽标文字（慢但可靠，灰度/截图后仍在）
   *   ③ 边框样式（虚线 = 系统建议，实线 = 有事实成分）
   * 只有颜色的话，色盲用户和黑白打印就完全看不出区别了。
   */
  return (
    <div
      data-report-statement={st.kind}
      className={clsx(
        'rounded-xl border-l-[3px] px-3.5 py-3',
        st.kind === 'stated_fact' && 'border-l-emerald-400 border-y border-r border-y-emerald-100 border-r-emerald-100 bg-emerald-50/30',
        st.kind === 'system_analysis' && 'border-l-brand-400 border-y border-r border-y-brand-100 border-r-brand-100 bg-brand-50/25',
        st.kind === 'system_suggestion' && 'border-l-amber-400 border-y border-r border-dashed border-y-amber-200 border-r-amber-200 bg-amber-50/30',
      )}
    >
      <div className="flex items-start gap-2">
        <span
          data-report-stmt-badge={st.kind}
          className={clsx(
            'mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold',
            st.kind === 'stated_fact' && 'bg-emerald-100 text-emerald-700',
            st.kind === 'system_analysis' && 'bg-brand-100 text-brand-700',
            st.kind === 'system_suggestion' && 'bg-amber-100 text-amber-700',
          )}
          title={meta.desc}
        >
          {meta.short}
        </span>
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-[12.8px] leading-[1.8] text-ink-700">
          {renderBold(st.text)}
        </p>
      </div>

      {st.refs.length > 0 && (
        <div className="mt-2.5 border-t border-ink-200/60 pt-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              data-report-refcount={st.refs.length}
              className="text-[10.5px] font-medium text-ink-400"
            >
              来源 {st.refs.length} 条
            </span>
            {/* 有 Evidence 的直接给"打开原文"按钮；其他类型回链显示为标签 */}
            {evidenceIds.length > 0 && (
              <button
                data-report-evidence-open={evidenceIds[0]}
                onClick={() => openEvidence(evidenceIds[0])}
                className="inline-flex items-center gap-1 rounded-md border border-brand-200 bg-white px-2 py-0.5 text-[10.5px] font-medium text-brand-600 transition hover:bg-brand-50"
              >
                <IconQuote className="h-2.5 w-2.5" /> 查看原文（{evidenceIds.length}）
              </button>
            )}
            {st.refs
              .filter((r) => r.kind !== 'evidence')
              .slice(0, 6)
              .map((r) => (
                <span
                  key={`${r.kind}:${r.id}`}
                  data-report-ref={`${r.kind}:${r.id}`}
                  title={r.label}
                  className={clsx(
                    'inline-flex max-w-[240px] items-center gap-1 rounded-md border px-2 py-0.5 text-[10.5px]',
                    /* 候选来源必须保留候选标识 —— 不能让它在回链标签上被洗掉 */
                    /候选|推测/.test(r.label)
                      ? 'border-amber-200 bg-amber-50 text-amber-700'
                      : 'border-ink-200 bg-ink-50/60 text-ink-500',
                  )}
                >
                  <span className="text-ink-400">{REF_KIND_LABEL[r.kind]}</span>
                  <span className="truncate">{r.label}</span>
                </span>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Evidence 索引表                                                     */
/* ------------------------------------------------------------------ */

function EvidenceIndexTable({
  rows,
  openEvidence,
}: {
  rows: ReportEvidenceIndexEntry[]
  openEvidence: (id: string) => void
}) {
  const cited = rows.filter((r) => r.cited_by.length > 0).length

  return (
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="mp-label">证据索引（{rows.length} 条）</p>
        <span data-report-cited-count={cited} className="text-[10.5px] text-ink-400">
          已被引用 {cited} 条 · 未被使用 {rows.length - cited} 条
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-ink-200">
        {rows.map((r) => {
          const used = r.cited_by.length > 0
          return (
            <div
              key={r.evidence_id}
              data-report-evidence-index={r.evidence_id}
              data-report-evidence-cited={used ? '1' : '0'}
              className={clsx(
                'border-b border-ink-100 px-3 py-2.5 last:border-b-0',
                used ? 'bg-white' : 'bg-ink-50/40',
              )}
            >
              <div className="flex items-start gap-2.5">
                <button
                  onClick={() => openEvidence(r.evidence_id)}
                  className="mt-0.5 shrink-0 rounded-md border border-brand-200 bg-white px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-brand-600 transition hover:bg-brand-50"
                >
                  #{r.evidence_id}
                </button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] text-ink-500">
                    {r.paper_id}《{r.paper_title}》 · {r.section} p{r.page}
                  </p>
                  <p className="mt-1 line-clamp-2 text-[11.8px] leading-relaxed text-ink-600">
                    {r.quote}
                  </p>
                  {/*
                   * 「被谁引用」必须如实显示，**包括"没人引用"**。
                   * 索引不是"用到的证据清单"，而是"报告里出现的全部证据"——
                   * 隐藏未引用的条目会让读者以为证据全被用上了。
                   */}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {used ? (
                      <>
                        <span className="text-[10px] text-ink-400">被引用：</span>
                        {r.cited_by.map((s) => (
                          <span
                            key={s}
                            data-report-cited-by={s}
                            className="rounded border border-brand-100 bg-brand-50/60 px-1.5 py-0.5 text-[10px] text-brand-700"
                          >
                            {LIVE_NAV.find((n) => n.id === s)?.label ?? s}
                          </span>
                        ))}
                        {r.gap_ids.map((g) => (
                          <span
                            key={g}
                            data-report-cited-gap={g}
                            className="rounded border border-ink-200 bg-ink-50 px-1.5 py-0.5 font-mono text-[10px] text-ink-500"
                          >
                            {g}
                          </span>
                        ))}
                        {r.direction_ids.map((d) => (
                          <span
                            key={d}
                            data-report-cited-direction={d}
                            className="rounded border border-ink-200 bg-ink-50 px-1.5 py-0.5 font-mono text-[10px] text-ink-500"
                          >
                            {d}
                          </span>
                        ))}
                      </>
                    ) : (
                      <span
                        data-report-evidence-unused="1"
                        className="rounded border border-ink-200 bg-ink-100/60 px-1.5 py-0.5 text-[10px] text-ink-400"
                      >
                        未被任何结论引用（已登记，如实标注）
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 章节局限性                                                          */
/* ------------------------------------------------------------------ */

function Limitations({ items }: { items: string[] }) {
  if (items.length === 0) return null
  return (
    <div
      data-report-limitations="1"
      className="mt-3 rounded-lg border border-amber-100 bg-amber-50/40 px-3.5 py-2.5"
    >
      <p className="text-[10.5px] font-semibold uppercase tracking-wider text-amber-700">
        这一章没能覆盖什么
      </p>
      <ul className="mt-1.5 space-y-1">
        {items.map((l) => (
          <li key={l} className="flex gap-2 text-[11.5px] leading-relaxed text-amber-800/90">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-amber-400" />
            {l}
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ================================================================== */
/* 纯文本导出（复制用）                                                 */
/* ================================================================== */

/**
 * 把结构化报告摊平成 Markdown。
 *
 * 三条纪律：
 *   ① 每条陈述带 `【层级】` 前缀 —— 脱离页面后视觉区分会消失
 *   ② 回链全部保留（`(来源 N 条: ...)`），否则复制出去的结论无从追溯
 *   ③ 未覆盖说明一并带上，不能让读者以为报告是完备的
 */
function buildReportPlainText(report: ResearchReportResponse['report']): string {
  const L: string[] = []
  L.push(`# ${report.title}`)
  L.push('')
  L.push(`> ${report.scope_note}`)
  L.push('')
  L.push(
    `分层：论文原文 ${report.layering.stated_fact} 条 · 系统分析 ${report.layering.system_analysis} 条 · 系统建议 ${report.layering.system_suggestion} 条（共 ${report.layering.total_statements} 条，回链 ${report.layering.total_refs} 条）`,
  )
  L.push('')

  const emit = (
    title: string,
    stmts: { kind: ReportStatementKind; text: string; refs: ReportRef[] }[],
    limitations: string[],
  ) => {
    L.push(`## ${title}`)
    L.push('')
    for (const st of stmts) {
      L.push(`【${STMT_META[st.kind].full}】${st.text}`)
      if (st.refs.length > 0) {
        L.push(
          `  来源 ${st.refs.length} 条：${st.refs.map((r) => `${REF_KIND_LABEL[r.kind]} ${r.id}（${r.label}）`).join('；')}`,
        )
      }
      L.push('')
    }
    if (limitations.length > 0) {
      L.push('这一章没能覆盖什么：')
      for (const l of limitations) L.push(`- ${l}`)
      L.push('')
    }
  }

  /* 一、研究主题 */
  const t = report.topic
  L.push('## 一、研究主题 / 研究问题')
  L.push('')
  if (t.keywords.length > 0) {
    L.push(`高频关键词：${t.keywords.map((k) => `${k.term}(${k.count})`).join('、')}`)
    L.push('')
  }
  if (t.themes.length > 0) {
    L.push(`研究场景主题：${t.themes.map((x) => `${x.label}(${x.gap_count} 条空白)`).join('、')}`)
    L.push('')
  }
  if (t.families.length > 0) {
    L.push(`方法族：${t.families.map((f) => `${f.family_id}×${f.count}`).join('、')}`)
    L.push('')
  }
  for (const st of t.research_questions) {
    L.push(`【${STMT_META[st.kind].full}】${st.text}`)
    L.push('')
  }
  if (t.limitations.length > 0) {
    L.push('这一章没能覆盖什么：')
    for (const l of t.limitations) L.push(`- ${l}`)
    L.push('')
  }

  /* 二~七 */
  for (const s of report.sections) emit(s.title, s.statements, s.limitations)

  /* Evidence 索引 */
  L.push('### Evidence 索引明细')
  L.push('')
  for (const r of report.evidence_index) {
    const used = r.cited_by.length > 0
    L.push(
      `- #${r.evidence_id} ${r.paper_id}《${r.paper_title}》${r.section} p${r.page} —— ${
        used ? `被引用：${r.cited_by.join('、')}` : '未被任何结论引用（已登记）'
      }`,
    )
  }
  L.push('')

  if (report.global_limitations.length > 0) {
    L.push('## 这份报告没能覆盖什么')
    L.push('')
    for (const l of report.global_limitations) L.push(`- ${l}`)
    L.push('')
  }

  L.push(`规则集：${report.rule_version}（确定性规则，未调用语言模型）`)
  return L.join('\n')
}

/* ------------------------------------------------------------------ */

/** 从各章节的 source_counts 里取一个计数，取不到返回 0（宁缺毋错） */
function maxOf(sections: ReportSection[], ...keys: string[]): number {
  for (const s of sections) {
    for (const k of keys) {
      const v = s.source_counts[k]
      if (typeof v === 'number') return v
    }
  }
  return 0
}

/** 渲染 **粗体** 片段 */
function renderBold(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? (
      <strong key={i} className="font-semibold text-ink-800">
        {p.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{p}</span>
    ),
  )
}

/* ================================================================== */
/* Demo：保留原有报告（行为不变）                                        */
/* ================================================================== */

const DEMO_NAV = [
  { id: 'abstract', label: '摘要' },
  { id: 'background', label: '一、研究背景' },
  { id: 'literature', label: '二、文献概览' },
  { id: 'methods', label: '三、方法分类' },
  { id: 'evolution', label: '四、技术演进' },
  { id: 'gaps', label: '五、研究空白' },
  { id: 'directions', label: '六、未来研究方向' },
  { id: 'references', label: '七、参考文献' },
]

function DemoReportView() {
  const pid = DEMO_PROJECT_ID
  const { push } = useToast()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [report, setReport] = useState<GenerateReportResult | null>(null)
  const [active, setActive] = useState('abstract')
  const [copied, setCopied] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(false)
    try {
      const r = await generateReport()
      setReport(r)
      setLoading(false)
    } catch {
      setError(true)
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const plainText = report
    ? `${report.title}\n\n${report.sections.map((s) => `## ${s.title}\n\n${s.content}`).join('\n\n')}`
    : ''

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(plainText)
      setCopied(true)
      push({ title: '已复制到剪贴板', description: '报告全文（Markdown 格式）', tone: 'success' })
      setTimeout(() => setCopied(false), 2000)
    } catch {
      push({ title: '复制失败', description: '浏览器限制了剪贴板访问', tone: 'error' })
    }
  }

  const downloadMarkdown = () => {
    const blob = new Blob([plainText], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `MethodPilot-调研报告-${new Date().toISOString().slice(0, 10)}.md`
    a.click()
    URL.revokeObjectURL(url)
    push({ title: '已导出 Markdown', description: '文件已开始下载', tone: 'success' })
  }

  return (
    <div className="mp-anim-fade-up space-y-5" data-report-page="demo">
      <PageHeader
        title="研究调研报告"
        subtitle="由 Agent 汇总全部结构化结果自动生成，可复制、可导出"
        meta={
          report && (
            <>
              <Chip tone="brand">{report.stats.papers} 篇论文</Chip>
              <Chip tone="neutral">{report.stats.methods} 个方法</Chip>
              <Chip tone="success">{report.stats.evidence} 条证据</Chip>
            </>
          )
        }
        actions={
          <>
            <button className="mp-btn mp-btn-ghost" onClick={load} disabled={loading}>
              <IconRefresh className="h-3.5 w-3.5" /> 重新生成
            </button>
            <button className="mp-btn mp-btn-ghost" onClick={copyAll} disabled={!report}>
              {copied ? <IconCheck className="h-3.5 w-3.5" /> : <IconCopy className="h-3.5 w-3.5" />}
              {copied ? '已复制' : '复制'}
            </button>
            <button className="mp-btn mp-btn-soft" onClick={downloadMarkdown} disabled={!report}>
              <IconDownload className="h-3.5 w-3.5" /> 导出 Markdown
            </button>
          </>
        }
      />

      {error ? (
        <EmptyState
          icon={<IconAlert className="h-5 w-5" />}
          title="报告生成失败"
          description="Agent 服务暂时不可用，请稍后重试"
        />
      ) : loading ? (
        <Card className="p-6">
          <div className="mb-4 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
              <IconReport className="h-4 w-4" />
            </span>
            <p className="text-[13px] font-medium text-ink-700">正在汇总分析结果…</p>
          </div>
          <SkeletonState rows={8} />
        </Card>
      ) : report ? (
        <div className="grid gap-4 lg:grid-cols-[210px_minmax(0,1fr)]">
          {/* 目录 */}
          <div className="lg:sticky lg:top-5 lg:self-start">
            <Card className="p-3">
              <p className="mp-label mb-2 px-2">目录</p>
              <nav className="space-y-0.5">
                {DEMO_NAV.map((n) => (
                  <a
                    key={n.id}
                    href={`#${n.id}`}
                    onClick={() => setActive(n.id)}
                    className={clsx(
                      'block rounded-lg px-2.5 py-1.5 text-[12.5px] transition',
                      active === n.id
                        ? 'bg-brand-50 font-medium text-brand-700'
                        : 'text-ink-600 hover:bg-ink-50',
                    )}
                  >
                    {n.label}
                  </a>
                ))}
              </nav>
            </Card>
          </div>

          {/* 正文 */}
          <Card className="p-6 sm:p-8">
            <div className="border-b border-ink-200 pb-5">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-white">
                  <IconReport className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-brand-600">
                    MethodPilot 自动生成
                  </p>
                  <p className="text-[10.5px] text-ink-400">演示知识库人工标注内容</p>
                </div>
              </div>
              <h1 className="mt-4 text-[24px] font-semibold leading-tight tracking-tight text-ink-900">
                {report.title}
              </h1>
            </div>

            <div className="mt-6 space-y-8">
              {report.sections.map((s) => (
                <section key={s.id} id={s.id} className="scroll-mt-5">
                  <h2 className="flex items-center gap-2 text-[16px] font-semibold tracking-tight text-ink-900">
                    <span className="h-4 w-1 rounded-full bg-brand-500" />
                    {s.title}
                  </h2>
                  <div className="mt-3 space-y-3">
                    {s.content.split('\n\n').map((para, i) => {
                      if (para.startsWith('### ')) {
                        const [head, ...rest] = para.split('\n')
                        return (
                          <div key={i} className="mt-4">
                            <h3 className="text-[13.5px] font-semibold text-ink-800">
                              {head.replace('### ', '')}
                            </h3>
                            {rest.length > 0 && (
                              <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-600">
                                {rest.join('\n')}
                              </p>
                            )}
                          </div>
                        )
                      }
                      return (
                        <p
                          key={i}
                          className="whitespace-pre-wrap text-[12.8px] leading-[1.85] text-ink-600"
                        >
                          {renderBold(para)}
                        </p>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>

            <div className="mt-10 flex flex-wrap items-center gap-2 border-t border-ink-200 pt-6">
              <Link to={`/project/${pid}/directions`} className="mp-btn mp-btn-soft">
                查看详细研究方向
              </Link>
              <Link to={`/project/${pid}/gaps`} className="mp-btn mp-btn-ghost">
                查看研究空白
              </Link>
              <Link to={`/project/${pid}/methods`} className="mp-btn mp-btn-ghost">
                返回方法地图
              </Link>
            </div>
          </Card>
        </div>
      ) : null}

      {/* 生成说明 */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <IconLayers className="h-4 w-4 text-ink-400" />
          <p className="text-[13px] font-semibold text-ink-800">报告生成流程（Demo 演示）</p>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          {[
            { n: '01', t: '汇总结构化数据', d: '汇集方法、关系、演进、空白与方向的结构化结果' },
            { n: '02', t: '证据关联', d: '为每个结论挂载对应的 Evidence 引用编号' },
            { n: '03', t: '生成叙述文本', d: '演示知识库已人工标注叙述文本' },
            { n: '04', t: '格式导出', d: '支持 Markdown 导出，保留证据引用' },
          ].map((x) => (
            <Card key={x.n} className="p-4">
              <span className="font-mono text-[11px] font-semibold text-brand-500">{x.n}</span>
              <p className="mt-1.5 text-[13px] font-semibold text-ink-800">{x.t}</p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-500">{x.d}</p>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
