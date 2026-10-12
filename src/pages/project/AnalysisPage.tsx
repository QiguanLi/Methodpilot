import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { clsx } from 'clsx'
import { PageHeader } from '@/components/AppLayout'
import {
  Card,
  Chip,
  IconArrowRight,
  IconCheck,
  IconChevronDown,
  IconLayers,
  IconQuote,
  IconRefresh,
  IconSparkles,
  ProgressBar,
  SectionTitle,
} from '@/components/ui'
import { useEvidenceDrawer, useToast } from '@/context/AppContext'
import { analysisLogs } from '@/data/pipeline'
import {
  analyzePapers,
  buildEvolution,
  classifyMethods,
  detectResearchGaps,
  extractMethods,
  generateDirections,
} from '@/services/agent'
import type { PipelineStage, StageStatus } from '@/types'

/** 页面内的日志条目：id 用自增数字，便于 React key 与追加渲染 */
interface RuntimeLog {
  id: number
  time: string
  message: string
  level: 'info' | 'success' | 'warn' | 'evidence'
  ref?: { type: 'paper' | 'method' | 'evidence'; id: string }
}

const STAGE_META: { id: string; name: string; nameEn: string; desc: string; total: number }[] = [
  { id: 'S1', name: '文献解析', nameEn: 'Paper Parsing', desc: '解析 PDF 结构，切分章节，抽取摘要、方法与实验段落', total: 18 },
  { id: 'S2', name: '方法抽取', nameEn: 'Method Extraction', desc: '识别方法实体，抽取核心思想、关键模块与输入输出', total: 18 },
  { id: 'S3', name: '方法分类', nameEn: 'Method Classification', desc: '按研究任务与方法范式聚类，归纳方法族', total: 19 },
  { id: 'S4', name: '技术关系分析', nameEn: 'Relation Analysis', desc: '判定方法之间的继承、改进、组合、替代与并行关系', total: 20 },
  { id: 'S5', name: '研究空白发现', nameEn: 'Gap Detection', desc: '对跨论文证据做对比归因，识别四类研究空白', total: 5 },
  { id: 'S6', name: '研究方向推导', nameEn: 'Direction Generation', desc: '基于空白与证据生成候选方向，并给出实验设计与风险分析', total: 3 },
]

const RUNNERS: Record<string, () => Promise<unknown>> = {
  S1: () => analyzePapers(),
  S2: () => extractMethods(),
  S3: () => classifyMethods(),
  S4: () => buildEvolution(),
  S5: () => detectResearchGaps(),
  S6: () => generateDirections(),
}

/** 每个阶段运行时注入的日志 */
const STAGE_LOGS: Record<string, { message: string; level: 'info' | 'success' | 'warn' | 'evidence' }[]> = {
  S1: [
    { message: '扫描入队论文，读取 PDF 二进制流…', level: 'info' },
    { message: '版面分析完成，识别出标题/作者/章节层级', level: 'success' },
    { message: '章节切分：Abstract / Method / Experiments / Limitations', level: 'success' },
  ],
  S2: [
    { message: '定位方法描述段落，执行实体抽取…', level: 'info' },
    { message: '合并同一方法的多种命名变体', level: 'info' },
    { message: '产出结构化方法实体，关联至来源论文', level: 'success' },
  ],
  S3: [
    { message: '按研究任务与方法范式执行聚类…', level: 'info' },
    { message: '聚类得到 5 个方法族：SE Agent / Tool-Using / Planning & Reflection / Multi-Agent / CodeGen', level: 'success' },
    { message: '检查方法族内部一致性，无冲突分配', level: 'success' },
  ],
  S4: [
    { message: '构造方法对，检索跨论文引用与对比语句…', level: 'info' },
    { message: '判定关系类型：extends / improves / combines / replaces / parallel', level: 'info' },
    { message: '证据不足的关系降级为 temporal，避免过度推断', level: 'warn' },
    { message: '生成 20 条方法关系，平均每条关联 1.4 条证据', level: 'success' },
  ],
  S5: [
    { message: '汇总各方法的 Limitations 段落…', level: 'info' },
    { message: '交叉比对：多个独立来源是否指向同一问题', level: 'info' },
    { message: '发现潜在空白 G001：长周期任务记忆与规划', level: 'warn' },
    { message: '发现潜在空白 G003：评测无法衡量能力退化', level: 'warn' },
    { message: '共识别 5 项研究空白（方法 2 / 评价 1 / 应用 1 / 数据 1）', level: 'success' },
  ],
  S6: [
    { message: '以空白为锚点，检索可组合的方法机制…', level: 'info' },
    { message: '为每个方向生成研究问题、可能方法、实验设计', level: 'info' },
    { message: '评估可行性与新颖性评分', level: 'success' },
    { message: '产出 3 个候选研究方向，全部关联至原文证据', level: 'success' },
  ],
}

function initialStages(): PipelineStage[] {
  return STAGE_META.map((m, i) => ({
    id: m.id,
    index: i + 1,
    name: m.name,
    name_en: m.nameEn,
    description: m.desc,
    status: i === 0 ? ('done' as StageStatus) : i === 1 ? ('done' as StageStatus) : i === 2 ? ('running' as StageStatus) : ('waiting' as StageStatus),
    progress: {
      done: i === 0 ? m.total : i === 1 ? m.total : i === 2 ? 8 : 0,
      total: m.total,
    },
  }))
}

export function AnalysisPage() {
  const { id } = useParams()
  const pid = id ?? 'proj-aicoding-agent'
  const { push } = useToast()
  const { open: openEvidence } = useEvidenceDrawer()

  const [stages, setStages] = useState<PipelineStage[]>(initialStages)
  const [logs, setLogs] = useState<RuntimeLog[]>(() =>
    analysisLogs.slice(0, 12).map((l, i) => ({ ...l, id: i + 1 })),
  )
  const [expanded, setExpanded] = useState<string | null>('S3')
  const [running, setRunning] = useState(false)
  /** 仅展示态：长日志展开、原始记录折叠（不影响任何业务逻辑） */
  const [expandedLog, setExpandedLog] = useState<number | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const logSeq = useRef(100)
  const logBoxRef = useRef<HTMLDivElement>(null)
  /** 首次渲染不自动滚动到底部，避免初始日志被推到视口外 */
  const didMountRef = useRef(false)

  useEffect(() => {
    // 仅展示行为调整：首次进入停在顶部，之后有新日志再跟随到底部
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    logBoxRef.current?.scrollTo({ top: logBoxRef.current.scrollHeight, behavior: 'smooth' })
  }, [logs])

  const pushLog = (message: string, level: 'info' | 'success' | 'warn' | 'evidence') => {
    logSeq.current += 1
    const now = new Date()
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
    setLogs((prev) => [...prev, { id: logSeq.current, time, message, level }])
  }

  const patchStage = (sid: string, patch: Partial<PipelineStage>) => {
    setStages((prev) => prev.map((s) => (s.id === sid ? { ...s, ...patch } : s)))
  }

  /** 让剩余阶段按顺序跑完（演示用动画） */
  const runFrom = async (startIdx: number) => {
    if (running) return
    setRunning(true)

    const startStage = stages[startIdx]
    push({
      title: `第 ${startStage.index} 阶段启动`,
      description: startStage.name,
      tone: 'info',
    })

    for (let i = startIdx; i < stages.length; i += 1) {
      const meta = STAGE_META[i]
      patchStage(meta.id, { status: 'running', progress: { done: 0, total: meta.total } })
      pushLog(`▶ 开始执行：${meta.name}（${meta.nameEn}）`, 'info')

      // 逐条输出日志
      const stageLogs = STAGE_LOGS[meta.id]
      for (const l of stageLogs) {
        await new Promise((r) => setTimeout(r, 320))
        pushLog(l.message, l.level)
      }

      // 进度推进动画
      for (let d = Math.ceil(meta.total / 4); d <= meta.total; d += Math.ceil(meta.total / 4)) {
        patchStage(meta.id, { progress: { done: Math.min(d, meta.total), total: meta.total } })
        await new Promise((r) => setTimeout(r, 130))
      }
      patchStage(meta.id, { progress: { done: meta.total, total: meta.total } })

      try {
        await RUNNERS[meta.id]()
      } catch {
        patchStage(meta.id, { status: 'failed' })
        pushLog(`✕ ${meta.name} 执行失败`, 'warn')
        push({ title: `${meta.name} 失败`, description: '已中止后续阶段', tone: 'error' })
        setRunning(false)
        return
      }

      patchStage(meta.id, { status: 'done' })
      pushLog(`✓ ${meta.name} 完成（${meta.total}/${meta.total}）`, 'success')
      await new Promise((r) => setTimeout(r, 220))
    }

    setRunning(false)
    push({
      title: '全部阶段执行完成',
      description: '证据链已闭合，可前往研究方向页面查看推导结果',
      tone: 'success',
    })
  }

  const reset = () => {
    if (running) return
    setStages(initialStages())
    setLogs(analysisLogs.slice(0, 12).map((l, i) => ({ ...l, id: i + 1 })))
    logSeq.current = 100
    push({ title: '已重置', description: '流水线状态恢复至初始进度', tone: 'info' })
  }

  const doneCount = stages.filter((s) => s.status === 'done').length
  const overallPct = Math.round((doneCount / stages.length) * 100)
  const nextIdx = stages.findIndex((s) => s.status !== 'done')

  const levelDot: Record<string, string> = {
    info: 'bg-ink-300',
    success: 'bg-emerald-400',
    warn: 'bg-amber-400',
    evidence: 'bg-brand-400',
  }
  /** 日志级别的浅色徽标（背景 + 前景），用于右侧「分析动态」 */
  const levelBadge: Record<string, string> = {
    info: 'bg-ink-100 text-ink-500',
    success: 'bg-emerald-50 text-emerald-600',
    warn: 'bg-amber-50 text-amber-600',
    evidence: 'bg-brand-50 text-brand-600',
  }
  const levelLabel: Record<string, string> = {
    info: '信息',
    success: '完成',
    warn: '提示',
    evidence: '证据',
  }
  const levelIcon: Record<string, React.ReactNode> = {
    info: <span className="h-1.5 w-1.5 rounded-full bg-ink-400" />,
    success: <IconCheck className="h-3 w-3" />,
    warn: <span className="h-1.5 w-1.5 rotate-45 rounded-[1px] bg-amber-500" />,
    evidence: <IconQuote className="h-3 w-3" />,
  }

  return (
    <div className="mp-anim-fade-up space-y-5">
      <PageHeader
        title="智能分析"
        subtitle="Agent 流水线 · 六个阶段依次产出方法、关系、空白与研究方向"
        meta={
          <>
            <Chip tone={running ? 'brand' : doneCount === 6 ? 'success' : 'neutral'}>
              {running ? '● 运行中' : doneCount === 6 ? '✓ 全部完成' : `${doneCount}/6 阶段完成`}
            </Chip>
            <Chip tone="neutral">共 18 篇论文入队</Chip>
          </>
        }
        actions={
          <>
            <button className="mp-btn mp-btn-ghost" onClick={reset} disabled={running}>
              <IconRefresh className="h-3.5 w-3.5" /> 重置
            </button>
            <button
              className="mp-btn mp-btn-primary"
              disabled={running || doneCount === 6}
              onClick={() => nextIdx >= 0 && runFrom(nextIdx)}
            >
              <IconSparkles className="h-3.5 w-3.5" />
              {running
                ? '执行中…'
                : doneCount === 6
                  ? '已完成'
                  : nextIdx >= 0
                    ? `执行第 ${nextIdx + 1} 阶段`
                    : '开始'}
            </button>
          </>
        }
      />

      {/* 总进度 */}
      <Card className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <p className="text-[13.5px] font-semibold text-ink-800">分析总进度</p>
              <span className="text-[11.5px] text-ink-400">
                已完成 {doneCount}/6 阶段
              </span>
            </div>
            <div className="mt-2.5 flex items-center gap-3">
              <ProgressBar value={doneCount} max={6} className="flex-1" />
              <span className="shrink-0 font-mono text-[13px] font-semibold tabular-nums text-brand-600">
                {overallPct}%
              </span>
            </div>
          </div>
          <div className="hidden shrink-0 gap-1.5 sm:flex">
            {stages.map((s) => (
              <div
                key={s.id}
                title={`${s.index}. ${s.name}`}
                className={clsx(
                  'h-6 w-6 rounded-md text-center text-[10px] font-semibold leading-6',
                  s.status === 'done' && 'bg-emerald-50 text-emerald-600',
                  s.status === 'running' && 'mp-anim-pulse bg-brand-100 text-brand-700',
                  s.status === 'waiting' && 'bg-ink-100 text-ink-400',
                  s.status === 'failed' && 'bg-rose-50 text-rose-600',
                )}
              >
                {s.status === 'done' ? '✓' : s.index}
              </div>
            ))}
          </div>
        </div>
      </Card>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        {/* 左：阶段列表 */}
        <div className="space-y-2">
          {stages.map((s, i) => {
            const isOpen = expanded === s.id
            const statusMeta: Record<StageStatus, { chip: 'success' | 'brand' | 'neutral' | 'danger'; icon: React.ReactNode; label: string }> = {
              done: { chip: 'success', icon: <IconCheck className="h-3 w-3" />, label: '完成' },
              running: { chip: 'brand', icon: <span className="h-1.5 w-1.5 animate-ping rounded-full bg-brand-500" />, label: '分析中' },
              waiting: { chip: 'neutral', icon: <span className="h-1.5 w-1.5 rounded-full bg-ink-300" />, label: '等待' },
              failed: { chip: 'danger', icon: <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />, label: '失败' },
            }
            const sm = statusMeta[s.status]
            const pct = Math.round((s.progress.done / s.progress.total) * 100)

            return (
              <Card
                key={s.id}
                className={clsx(
                  'overflow-hidden transition',
                  s.status === 'running' && 'border-brand-300 shadow-[0_0_0_3px_var(--color-brand-50)]',
                )}
              >
                <button
                  onClick={() => setExpanded(isOpen ? null : s.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  {/* 序号 */}
                  <span
                    className={clsx(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-mono text-[12px] font-semibold',
                      s.status === 'done' && 'bg-emerald-50 text-emerald-600',
                      s.status === 'running' && 'mp-anim-pulse bg-brand-500 text-white',
                      s.status === 'waiting' && 'bg-ink-100 text-ink-400',
                      s.status === 'failed' && 'bg-rose-50 text-rose-600',
                    )}
                  >
                    {s.status === 'done' ? <IconCheck className="h-4 w-4" /> : String(s.index).padStart(2, '0')}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-[13.5px] font-semibold text-ink-800">{s.name}</p>
                      <Chip tone={sm.chip}>
                        {sm.icon}
                        {sm.label}
                      </Chip>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[10.5px] text-ink-400">
                      {s.name_en}
                    </p>
                  </div>

                  {/* 进度 */}
                  <div className="hidden w-[100px] shrink-0 sm:block">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[11px] tabular-nums text-ink-500">
                        {s.progress.done}/{s.progress.total}
                      </span>
                      <span className="font-mono text-[10px] tabular-nums text-ink-400">{pct}%</span>
                    </div>
                    <ProgressBar
                      value={s.progress.done}
                      max={s.progress.total}
                      className="mt-1"
                      color={
                        s.status === 'done'
                          ? 'var(--color-emerald-500)'
                          : s.status === 'failed'
                            ? 'var(--color-rose-500)'
                            : 'var(--color-brand-500)'
                      }
                    />
                  </div>

                  <IconChevronDown
                    className={clsx(
                      'h-4 w-4 shrink-0 text-ink-400 transition-transform',
                      isOpen && 'rotate-180',
                    )}
                  />
                </button>

                {isOpen && (
                  <div className="border-t border-ink-200 bg-ink-50 px-4 py-3">
                    <p className="text-[12px] leading-relaxed text-ink-600">{s.description}</p>

                    {/* 阶段专属日志 */}
                    <div className="mt-3 space-y-1">
                      <p className="mp-label">阶段日志</p>
                      {(STAGE_LOGS[s.id] ?? []).map((l, k) => (
                        <div key={k} className="flex items-start gap-2">
                          <span className={clsx('mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full', levelDot[l.level])} />
                          <span className="text-[11.5px] leading-relaxed text-ink-600">
                            {s.status === 'waiting' ? '（待执行）' : l.message}
                          </span>
                        </div>
                      ))}
                    </div>

                    {/* 阶段产物跳转 */}
                    {s.status === 'done' && (
                      <div className="mt-3 flex flex-wrap gap-1.5 border-t border-ink-200 pt-3">
                        {i <= 2 && (
                          <Link
                            to={`/project/${pid}/papers`}
                            className="mp-chip bg-brand-50 text-brand-700 transition hover:bg-brand-100"
                          >
                            查看文献库 <IconArrowRight className="h-3 w-3" />
                          </Link>
                        )}
                        {i === 2 && (
                          <Link
                            to={`/project/${pid}/methods`}
                            className="mp-chip bg-brand-50 text-brand-700 transition hover:bg-brand-100"
                          >
                            查看方法地图 <IconArrowRight className="h-3 w-3" />
                          </Link>
                        )}
                        {i === 3 && (
                          <>
                            <Link
                              to={`/project/${pid}/methods`}
                              className="mp-chip bg-brand-50 text-brand-700 transition hover:bg-brand-100"
                            >
                              查看方法关系 <IconArrowRight className="h-3 w-3" />
                            </Link>
                            <Link
                              to={`/project/${pid}/evolution`}
                              className="mp-chip bg-brand-50 text-brand-700 transition hover:bg-brand-100"
                            >
                              查看技术演进 <IconArrowRight className="h-3 w-3" />
                            </Link>
                          </>
                        )}
                        {i === 4 && (
                          <Link
                            to={`/project/${pid}/gaps`}
                            className="mp-chip bg-brand-50 text-brand-700 transition hover:bg-brand-100"
                          >
                            查看研究空白 <IconArrowRight className="h-3 w-3" />
                          </Link>
                        )}
                        {i === 5 && (
                          <>
                            <Link
                              to={`/project/${pid}/directions`}
                              className="mp-chip bg-brand-50 text-brand-700 transition hover:bg-brand-100"
                            >
                              查看研究方向 <IconArrowRight className="h-3 w-3" />
                            </Link>
                            <Link
                              to={`/project/${pid}/report`}
                              className="mp-chip bg-brand-50 text-brand-700 transition hover:bg-brand-100"
                            >
                              生成调研报告 <IconArrowRight className="h-3 w-3" />
                            </Link>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </Card>
            )
          })}
        </div>

        {/* 右：分析动态 */}
        <Card className="flex min-h-[420px] flex-col overflow-hidden xl:h-[640px]">
          <div className="flex items-center justify-between border-b border-ink-200 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                <IconLayers className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0">
                <p className="text-[13.5px] font-semibold text-ink-800">分析动态</p>
                <p className="truncate text-[11px] text-ink-400">按时间顺序记录的分析过程</p>
              </div>
            </div>
            {running && (
              <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-brand-600">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
                进行中
              </span>
            )}
          </div>

          <div ref={logBoxRef} className="mp-scroll-thin flex-1 space-y-1 overflow-y-auto px-3 py-3">
            {logs.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-ink-100 text-ink-400">
                  <IconLayers className="h-5 w-5" />
                </span>
                <p className="mt-3 text-[13px] font-medium text-ink-600">暂无分析动态</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-400">
                  点击上方「执行」按钮开始分析，过程中的记录会实时出现在这里。
                </p>
              </div>
            ) : (
              logs.map((l) => {
                const isLong = l.message.length > 46
                const isExpanded = expandedLog === l.id
                const msgClass = clsx(
                  'text-[12px] leading-relaxed',
                  isLong && !isExpanded && 'line-clamp-2',
                )
                return (
                  <div
                    key={l.id}
                    className="group flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-ink-50"
                  >
                    <span
                      className={clsx(
                        'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
                        levelBadge[l.level],
                      )}
                      title={levelLabel[l.level]}
                    >
                      {levelIcon[l.level]}
                    </span>
                    <span className="mt-0.5 shrink-0 font-mono text-[10.5px] tabular-nums text-ink-400">
                      {l.time}
                    </span>
                    <div className="min-w-0 flex-1">
                      {l.ref?.type === 'evidence' ? (
                        <button
                          onClick={() => openEvidence(l.ref!.id)}
                          className={clsx(
                            'text-left text-brand-700 underline decoration-brand-300 decoration-dotted underline-offset-2 transition hover:text-brand-800',
                            msgClass,
                          )}
                        >
                          {l.message}
                        </button>
                      ) : (
                        <span
                          className={clsx(
                            'text-ink-600',
                            msgClass,
                            isLong && 'cursor-pointer',
                          )}
                          onClick={isLong ? () => setExpandedLog(isExpanded ? null : l.id) : undefined}
                        >
                          {l.message}
                        </span>
                      )}
                      {isLong && (
                        <button
                          onClick={() => setExpandedLog(isExpanded ? null : l.id)}
                          className="mt-0.5 block text-[10.5px] text-ink-400 transition hover:text-brand-600"
                        >
                          {isExpanded ? '收起' : '展开'}
                        </button>
                      )}
                    </div>
                  </div>
                )
              })
            )}

            {running && logs.length > 0 && (
              <div className="flex items-center gap-2.5 px-2 py-1.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                  <span className="flex gap-0.5">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="h-1 w-1 animate-bounce rounded-full bg-brand-400"
                        style={{ animationDelay: `${i * 120}ms` }}
                      />
                    ))}
                  </span>
                </span>
                <span className="text-[11.5px] text-brand-600">正在处理…</span>
              </div>
            )}
          </div>

          {/* 底部统计 */}
          <div className="grid grid-cols-3 divide-x divide-ink-200 border-t border-ink-200">
            {[
              { label: '日志条数', value: logs.length },
              { label: '证据建立', value: logs.filter((l) => l.level === 'evidence').length },
              { label: '阶段完成', value: `${doneCount}/6` },
            ].map((x) => (
              <div key={x.label} className="px-3 py-2.5 text-center">
                <p className="font-mono text-[15px] font-semibold tabular-nums text-ink-800">
                  {x.value}
                </p>
                <p className="mt-0.5 text-[10.5px] text-ink-400">{x.label}</p>
              </div>
            ))}
          </div>

          {/* 原始记录（只读折叠，保留演示属性） */}
          <div className="border-t border-ink-200">
            <button
              onClick={() => setShowRaw((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-2 text-[11.5px] text-ink-500 transition hover:bg-ink-50"
            >
              <span>查看原始记录</span>
              <IconChevronDown
                className={clsx('h-3.5 w-3.5 text-ink-400 transition-transform', showRaw && 'rotate-180')}
              />
            </button>
            {showRaw && (
              <div className="border-t border-ink-100 bg-ink-50 px-4 py-3">
                <pre className="mp-scroll-thin max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10.5px] leading-relaxed text-ink-500">
                  {logs.map((l) => `${l.time}  [${l.level}]  ${l.message}`).join('\n')}
                </pre>
                <p className="mt-2 text-[10.5px] text-ink-400">
                  以上为当前页面加载的演示日志（Mock 数据），非实时模型调用记录。
                </p>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* 说明 */}
      <div>
        <SectionTitle
          title="Agent 接口约定"
          subtitle="当前阶段所有函数返回 Mock 数据，接口契约已冻结，可直接替换为真实 AI 调用"
        />
        <Card className="overflow-hidden">
          <div className="divide-y divide-ink-200">
            {[
              { fn: 'analyzePapers()', stage: '文献解析', desc: '产出章节切分与段落摘要' },
              { fn: 'extractMethods()', stage: '方法抽取', desc: '产出结构化方法实体与 Evidence' },
              { fn: 'classifyMethods()', stage: '方法分类', desc: '产出方法族与归属关系' },
              { fn: 'buildEvolution()', stage: '技术关系分析', desc: '产出方法关系与技术演进节点' },
              { fn: 'detectResearchGaps()', stage: '研究空白发现', desc: '产出四类研究空白' },
              { fn: 'generateDirections()', stage: '研究方向推导', desc: '产出候选方向与实验设计' },
              { fn: 'generateReport()', stage: '调研报告', desc: '汇总为结构化研究报告' },
            ].map((x) => (
              <div key={x.fn} className="flex items-center gap-3 px-4 py-2.5">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600">
                  <IconQuote className="h-3 w-3" />
                </span>
                <code className="shrink-0 rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11.5px] text-brand-700">
                  {x.fn}
                </code>
                <span className="hidden shrink-0 sm:inline">
                  <Chip tone="neutral">{x.stage}</Chip>
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink-500">{x.desc}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
