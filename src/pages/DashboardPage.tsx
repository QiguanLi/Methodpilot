import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'
import { PageHeader } from '@/components/AppLayout'
import {
  Card,
  Chip,
  EmptyState,
  EvidenceButton,
  GapTypeBadge,
  IconArrowRight,
  IconLightbulb,
  IconSparkles,
  IconTarget,
  IconTimeline,
  IconUpload,
  ProgressBar,
  SectionTitle,
} from '@/components/ui'
import { useEvidenceDrawer, useToast } from '@/context/AppContext'
import { analyzePapers } from '@/services/agent'
import {
  getDirections,
  getEvolutions,
  getFamilyDistribution,
  getGaps,
  getRecentPapers,
  getUncoveredGaps,
  stats,
} from '@/services/selectors'

export function DashboardPage() {
  const { id } = useParams()
  const pid = id ?? 'proj-aicoding-agent'
  const navigate = useNavigate()
  const { push } = useToast()
  const { open: openEvidence } = useEvidenceDrawer()
  const [running, setRunning] = useState(false)

  const statsCards = [
    { label: '已分析论文', value: stats.paperCount, unit: '篇', to: `/project/${pid}/papers`, accent: '#6d5cf0' },
    { label: '识别方法', value: stats.methodCount, unit: '个', to: `/project/${pid}/methods`, accent: '#0ea5e9' },
    { label: '方法族', value: stats.familyCount, unit: '个', to: `/project/${pid}/methods`, accent: '#10b981' },
    { label: '技术演进节点', value: stats.evolutionCount, unit: '个', to: `/project/${pid}/evolution`, accent: '#f59e0b' },
    { label: '研究空白', value: stats.gapCount, unit: '个', to: `/project/${pid}/gaps`, accent: '#ec4899' },
    { label: '候选研究方向', value: stats.directionCount, unit: '个', to: `/project/${pid}/directions`, accent: '#8b5cf6' },
  ]

  const familyDist = getFamilyDistribution()
  const evolutions = getEvolutions()
  const gaps = getGaps().slice(0, 4)
  const recent = getRecentPapers(5)
  const directions = getDirections()
  const uncovered = getUncoveredGaps()

  const runAnalysis = async () => {
    setRunning(true)
    push({
      title: 'Agent 开始工作',
      description: '正在解析论文并抽取方法实体…',
      tone: 'info',
    })
    await analyzePapers()
    setRunning(false)
    push({
      title: '分析完成',
      description: `已处理 ${stats.paperCount} 篇论文，抽取 ${stats.evidenceCount} 条证据`,
      tone: 'success',
    })
    navigate(`/project/${pid}/analysis`)
  }

  return (
    <div className="mp-anim-fade-up space-y-5">
      <PageHeader
        title="AI Coding Agent 方法演进研究"
        subtitle="基于论文的方法分析与研究方向发现 · 2019–2025 年 AI Coding Agent 领域全景梳理"
        meta={
          <>
            <Chip tone="brand">
              <IconSparkles className="h-3 w-3" />
              {stats.paperCount} 篇论文
            </Chip>
            <Chip tone="success">{stats.evidenceCount} 条证据已锚定</Chip>
            <Chip tone="neutral">最近更新 2026-09-21</Chip>
          </>
        }
        actions={
          <>
            <Link to={`/project/${pid}/papers`} className="mp-btn mp-btn-ghost">
              <IconUpload className="h-3.5 w-3.5" /> 上传论文
            </Link>
            <button className="mp-btn mp-btn-soft" onClick={runAnalysis} disabled={running}>
              <IconSparkles className="h-3.5 w-3.5" />
              {running ? '分析中…' : '开始分析'}
            </button>
            <Link to={`/project/${pid}/report`} className="mp-btn mp-btn-primary">
              生成报告
            </Link>
          </>
        }
      />

      {/* 统计卡 */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {statsCards.map((s) => (
          <Link key={s.label} to={s.to}>
            <Card hover className="group h-full p-3.5">
              <div className="flex items-start justify-between">
                <p className="text-[11.5px] text-ink-500">{s.label}</p>
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: s.accent }}
                />
              </div>
              <div className="mt-2 flex items-baseline gap-1">
                <span
                  className="text-[26px] font-semibold leading-none tabular-nums tracking-tight"
                  style={{ color: s.accent }}
                >
                  {s.value}
                </span>
                <span className="text-[11px] text-ink-400">{s.unit}</span>
              </div>
              <div className="mt-2.5">
                <ProgressBar
                  value={s.value}
                  max={Math.max(...statsCards.map((x) => x.value))}
                  color={s.accent}
                />
              </div>
            </Card>
          </Link>
        ))}
      </div>

      {/* 方法分布 + 技术演进概览 */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        {/* 方法分布 */}
        <Card className="p-4">
          <SectionTitle
            title="方法分布"
            subtitle={`${stats.methodCount} 个方法 · ${stats.familyCount} 个方法族`}
            action={
              <Link
                to={`/project/${pid}/methods`}
                className="flex items-center gap-1 text-[11.5px] font-medium text-brand-600 hover:text-brand-700"
              >
                方法地图 <IconArrowRight className="h-3 w-3" />
              </Link>
            }
          />
          <div className="flex items-center gap-4">
            <div className="relative h-[168px] w-[168px] shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={familyDist}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={52}
                    outerRadius={78}
                    paddingAngle={2}
                    startAngle={90}
                    endAngle={-270}
                    stroke="#fff"
                    strokeWidth={2}
                  >
                    {familyDist.map((f) => (
                      <Cell key={f.family_id} fill={f.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      borderRadius: 10,
                      border: '1px solid #e6ebf2',
                      fontSize: 12,
                      boxShadow: '0 4px 16px rgba(15,23,42,.08)',
                    }}
                    formatter={(v, n) => [`${v} 个方法`, String(n)] as [string, string]}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-[22px] font-semibold leading-none tabular-nums text-ink-800">
                  {stats.methodCount}
                </span>
                <span className="mt-0.5 text-[10px] text-ink-400">方法总数</span>
              </div>
            </div>

            <div className="min-w-0 flex-1 space-y-2">
              {familyDist.map((f) => (
                <Link
                  key={f.family_id}
                  to={`/project/${pid}/methods?family=${f.family_id}`}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition hover:bg-ink-50"
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-sm"
                    style={{ background: f.color }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-700">
                    {f.name}
                  </span>
                  <span className="text-[11.5px] font-medium tabular-nums text-ink-500">
                    {f.value}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </Card>

        {/* 技术演进概览 */}
        <Card className="p-4">
          <SectionTitle
            title="技术演进概览"
            subtitle="2019 → 2025 关键阶段"
            icon={<IconTimeline className="h-4 w-4" />}
            action={
              <Link
                to={`/project/${pid}/evolution`}
                className="flex items-center gap-1 text-[11.5px] font-medium text-brand-600 hover:text-brand-700"
              >
                完整时间线 <IconArrowRight className="h-3 w-3" />
              </Link>
            }
          />
          <div className="mp-scroll-thin -mx-1 overflow-x-auto px-1 pb-2">
            <div className="flex min-w-[560px] items-stretch gap-0 pt-1">
              {evolutions.slice(0, 6).map((e, i) => (
                <div key={e.evolution_id} className="flex min-w-0 flex-1 items-stretch">
                  <Link
                    to={`/project/${pid}/evolution?focus=${e.evolution_id}`}
                    className="group flex min-w-0 flex-1 flex-col"
                  >
                    <div className="flex items-center">
                      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-brand-400 bg-white text-[10px] font-semibold text-brand-600 transition group-hover:bg-brand-500 group-hover:text-white">
                        {i + 1}
                      </div>
                      {i < 5 && <div className="h-[2px] flex-1 bg-gradient-to-r from-brand-300 to-brand-100" />}
                    </div>
                    <div className="mt-2.5 min-w-0 pr-3">
                      <p className="font-mono text-[11px] font-semibold tabular-nums text-brand-600">
                        {e.year}
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-[12px] font-medium leading-snug text-ink-800">
                        {e.stage_title}
                      </p>
                      <p className="mt-1 line-clamp-3 text-[10.5px] leading-relaxed text-ink-400">
                        {e.change}
                      </p>
                    </div>
                  </Link>
                </div>
              ))}
            </div>
          </div>

          {/* 演进受限提示 */}
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2">
            <span className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
            <p className="text-[11px] leading-relaxed text-amber-800">
              仅当存在原文证据支持时，系统才标注「继承 / 改进」；证据不足的关系降级为「时间相邻」或「相关」。
            </p>
          </div>
        </Card>
      </div>

      {/* AI 发现的研究空白 */}
      <div>
        <SectionTitle
          title="AI 发现的研究空白"
          subtitle={`共 ${stats.gapCount} 项，以下为优先级最高的 ${gaps.length} 项`}
          icon={<IconTarget className="h-4 w-4" />}
          action={
            <Link
              to={`/project/${pid}/gaps`}
              className="flex items-center gap-1 text-[11.5px] font-medium text-brand-600 hover:text-brand-700"
            >
              全部空白 <IconArrowRight className="h-3 w-3" />
            </Link>
          }
        />
        <div className="grid gap-3 md:grid-cols-2">
          {gaps.map((g) => (
            <Card key={g.gap_id} hover className="flex flex-col p-4">
              <div className="flex items-start justify-between gap-2">
                <GapTypeBadge type={g.type} />
                <span className="text-[10.5px] tabular-nums text-ink-400">
                  {g.supporting_papers.length} 篇 · {g.evidence_ids.length} 证据
                </span>
              </div>
              <Link to={`/project/${pid}/gaps?focus=${g.gap_id}`} className="mt-2.5">
                <h3 className="text-[13.5px] font-semibold leading-snug text-ink-800 transition hover:text-brand-700">
                  {g.title}
                </h3>
              </Link>
              <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-ink-500">
                {g.current_problem}
              </p>

              <div className="mt-3 flex items-center gap-1.5 border-t border-ink-200 pt-2.5">
                <EvidenceButton
                  count={g.evidence_ids.length}
                  onClick={() => openEvidence(g.evidence_ids[0])}
                />
                <Link
                  to={`/project/${pid}/gaps?focus=${g.gap_id}`}
                  className="mp-chip bg-ink-100 text-ink-600 transition hover:bg-ink-200"
                >
                  查看详情
                </Link>
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* 候选研究方向 */}
      <div>
        <SectionTitle
          title="候选研究方向"
          subtitle={`基于 ${stats.paperCount} 篇论文的交叉证据推导`}
          icon={<IconLightbulb className="h-4 w-4" />}
          action={
            <Link
              to={`/project/${pid}/directions`}
              className="flex items-center gap-1 text-[11.5px] font-medium text-brand-600 hover:text-brand-700"
            >
              全部方向 <IconArrowRight className="h-3 w-3" />
            </Link>
          }
        />
        <div className="grid gap-3 md:grid-cols-3">
          {directions.map((d, i) => (
            <Link key={d.direction_id} to={`/project/${pid}/directions?focus=${d.direction_id}`}>
              <Card hover className="flex h-full flex-col p-4">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] font-semibold text-brand-500">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="flex items-center gap-1">
                    <Chip tone="success">可行性 {d.feasibility}</Chip>
                    <Chip tone="brand">新颖性 {d.novelty}</Chip>
                  </div>
                </div>
                <h3 className="mt-2 text-[13.5px] font-semibold leading-snug text-ink-800">
                  {d.title}
                </h3>
                <p className="mt-1.5 line-clamp-3 flex-1 text-[12px] leading-relaxed text-ink-500">
                  {d.research_question}
                </p>
                <div className="mt-3 flex items-center justify-between border-t border-ink-200 pt-2.5">
                  <span className="text-[10.5px] tabular-nums text-ink-400">
                    {d.evidence_ids.length} 条证据
                  </span>
                  <span className="flex items-center gap-1 text-[11.5px] font-medium text-brand-600">
                    展开分析 <IconArrowRight className="h-3 w-3" />
                  </span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      {/* 最近分析论文 */}
      <div>
        <SectionTitle
          title="最近分析论文"
          subtitle="按发表年份排序"
          action={
            <Link
              to={`/project/${pid}/papers`}
              className="flex items-center gap-1 text-[11.5px] font-medium text-brand-600 hover:text-brand-700"
            >
              进入文献库 <IconArrowRight className="h-3 w-3" />
            </Link>
          }
        />
        <Card className="divide-y divide-ink-200 overflow-hidden">
          {recent.length === 0 ? (
            <EmptyState title="暂无论文" description="上传论文后这里会显示分析结果" />
          ) : (
            recent.map((p) => (
              <Link
                key={p.paper_id}
                to={`/project/${pid}/papers/${p.paper_id}`}
                className="flex items-center gap-3 px-4 py-3 transition hover:bg-ink-50/70"
              >
                <span className="w-11 shrink-0 font-mono text-[12px] font-semibold tabular-nums text-ink-400">
                  {p.year}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-ink-800">{p.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Chip tone="neutral">{p.venue}</Chip>
                    <Chip tone="brand">{p.task}</Chip>
                    <span className="truncate text-[11px] text-ink-400">
                      {p.authors[0]}
                      {p.authors.length > 1 ? ' 等' : ''}
                    </span>
                  </div>
                </div>
                <span className="hidden shrink-0 items-center gap-1 text-[11px] text-ink-400 sm:flex">
                  {p.evidence_count} 条证据
                </span>
                <IconArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-300" />
              </Link>
            ))
          )}
        </Card>
      </div>

      {/* 未覆盖空白提示 */}
      {uncovered.length > 0 && (
        <Card className="flex flex-wrap items-center gap-3 border-brand-200 bg-gradient-to-r from-brand-50 to-white p-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-brand-600 shadow-sm">
            <IconLightbulb className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-ink-800">
              还有 {uncovered.length} 项研究空白尚未被任何研究方向覆盖
            </p>
            <p className="mt-0.5 text-[11.5px] text-ink-500">
              {uncovered.map((g) => g.title).join(' · ')}
            </p>
          </div>
          <Link to={`/project/${pid}/gaps`} className="mp-btn mp-btn-primary">
            查看并生成方向
          </Link>
        </Card>
      )}
    </div>
  )
}
