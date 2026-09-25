import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import type { GapType, MethodParadigm, PaperStatus, RelationType, SourceType } from '@/types'

/* ------------------------------------------------------------------ */
/* 图标 —— 内联 SVG，避免引入图标库依赖                                */
/* ------------------------------------------------------------------ */

interface IconProps {
  className?: string
  strokeWidth?: number
}

const base = (className?: string) => clsx('shrink-0', className ?? 'w-4 h-4')

export const IconHome = ({ className, strokeWidth = 1.7 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M9.5 21v-6h5v6" />
  </svg>
)

export const IconLibrary = ({ className, strokeWidth = 1.7 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M4 4h6v16H4z" /><path d="M10 4h5v16h-5z" /><path d="m15.5 5.5 4.2 1.1-3.6 13.4-4.2-1.1z" />
  </svg>
)

export const IconBrain = ({ className, strokeWidth = 1.7 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M9.5 3.5A3 3 0 0 0 6.5 6.5 3 3 0 0 0 4 9.5a3 3 0 0 0 1.2 2.4A3 3 0 0 0 4.5 14a3 3 0 0 0 3 3 2.5 2.5 0 0 0 4.5 1.5" />
    <path d="M14.5 3.5a3 3 0 0 1 3 3 3 3 0 0 1 2.5 3 3 3 0 0 1-1.2 2.4A3 3 0 0 1 19.5 14a3 3 0 0 1-3 3 2.5 2.5 0 0 1-4.5 1.5" />
    <path d="M12 3v18" />
  </svg>
)

export const IconMap = ({ className, strokeWidth = 1.7 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <circle cx="12" cy="12" r="2.5" /><circle cx="4.5" cy="5" r="2" /><circle cx="19.5" cy="5" r="2" />
    <circle cx="4.5" cy="19" r="2" /><circle cx="19.5" cy="19" r="2" />
    <path d="m6.2 6.4 3.6 3.5M17.8 6.4l-3.6 3.5M6.2 17.6l3.6-3.5M17.8 17.6l-3.6-3.5" />
  </svg>
)

export const IconTimeline = ({ className, strokeWidth = 1.7 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M4 6h13M4 12h9M4 18h16" /><circle cx="20" cy="6" r="1.6" /><circle cx="16" cy="12" r="1.6" />
  </svg>
)

export const IconSearch = ({ className, strokeWidth = 1.7 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
  </svg>
)

export const IconTarget = ({ className, strokeWidth = 1.7 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" />
  </svg>
)

export const IconLightbulb = ({ className, strokeWidth = 1.7 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5.9 1.2 1 2.1h5c.1-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z" />
  </svg>
)

export const IconReport = ({ className, strokeWidth = 1.7 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" />
    <path d="M9 13h6M9 17h4" />
  </svg>
)

export const IconSettings = ({ className, strokeWidth = 1.7 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 18l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 12.5H3.4a2 2 0 1 1 0-4h.2A1.6 1.6 0 0 0 4.7 5.4l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 1.7V1.5a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.2 1Z" />
  </svg>
)

export const IconUpload = ({ className, strokeWidth = 1.8 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </svg>
)

export const IconSparkles = ({ className, strokeWidth = 1.7 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    <circle cx="12" cy="12" r="2.5" />
  </svg>
)

export const IconCheck = ({ className, strokeWidth = 2.2 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="m5 13 4.5 4.5L19 6.5" />
  </svg>
)

export const IconChevronRight = ({ className, strokeWidth = 2 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="m9 5 7 7-7 7" />
  </svg>
)

export const IconChevronDown = ({ className, strokeWidth = 2 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="m5 9 7 7 7-7" />
  </svg>
)

export const IconClose = ({ className, strokeWidth = 2 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
)

export const IconBell = ({ className, strokeWidth = 1.7 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" /><path d="M10.5 20a2 2 0 0 0 3 0" />
  </svg>
)

export const IconMenu = ({ className, strokeWidth = 1.9 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M4 7h16M4 12h16M4 17h10" />
  </svg>
)

export const IconArrowRight = ({ className, strokeWidth = 1.8 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M4 12h15M13 6l6 6-6 6" />
  </svg>
)

export const IconLink = ({ className, strokeWidth = 1.7 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
    <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
  </svg>
)

/** 外链图标（论文探索页跳转 Semantic Scholar 用） */
export const IconExternalLink = ({ className, strokeWidth = 1.8 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </svg>
)

export const IconQuote = ({ className, strokeWidth = 1.6 }: IconProps) => (  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M9 7c-2.5 1-4 3.2-4 6v4h5v-6H7c0-1.6.8-2.7 2-3.2z" />
    <path d="M19 7c-2.5 1-4 3.2-4 6v4h5v-6h-3c0-1.6.8-2.7 2-3.2z" />
  </svg>
)

export const IconPlus = ({ className, strokeWidth = 2 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const IconDownload = ({ className, strokeWidth = 1.8 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1" />
  </svg>
)

export const IconCopy = ({ className, strokeWidth = 1.8 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </svg>
)

/**
 * 云中带向下箭头 —— 「获取全文」用。
 *
 * 特意没用 IconDownload（硬盘带箭头）：那两个按钮在同一页并排出现
 * （右上角的「导出」用的就是它），图标一样会让用户以为点下去都是导出。
 * 这个形状表达的是"从外部取回来"，与动作语义一致。
 */
export const IconCloudDownload = ({ className, strokeWidth = 1.7 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M12 12v7" /><path d="m8.5 15.5 3.5 3.5 3.5-3.5" />
    <path d="M7 19a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.7-1.1A4 4 0 0 1 17.5 19" />
  </svg>
)

export const IconRefresh = ({ className, strokeWidth = 1.8 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M20 11a8 8 0 0 0-13.7-5.6L4 7.6" /><path d="M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 13.7 5.6L20 16.4" /><path d="M20 20v-4h-4" />
  </svg>
)

export const IconAlert = ({ className, strokeWidth = 1.8 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M12 3.5 21 19H3z" /><path d="M12 10v4M12 17.2v.1" />
  </svg>
)

export const IconSend = ({ className, strokeWidth = 1.8 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M4 12 20 4l-6 16-3.2-6.4z" />
  </svg>
)

export const IconMessage = ({ className, strokeWidth = 1.7 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
  </svg>
)

export const IconLayers = ({ className, strokeWidth = 1.7 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={base(className)}>
    <path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" />
  </svg>
)

/* ------------------------------------------------------------------ */
/* 基础组件                                                            */
/* ------------------------------------------------------------------ */

export function Card({
  children,
  className,
  hover = false,
}: {
  children: ReactNode
  className?: string
  hover?: boolean
}) {
  return (
    <div className={clsx('mp-card', hover && 'mp-card-hover', className)}>{children}</div>
  )
}

export function SectionTitle({
  title,
  subtitle,
  action,
  icon,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div className="flex items-center gap-2">
        {icon && <span className="text-brand-500">{icon}</span>}
        <div>
          <h2 className="text-[15px] font-semibold text-ink-800">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-ink-400">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  )
}

export function Chip({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode
  tone?: 'neutral' | 'brand' | 'success' | 'warn' | 'danger' | 'info' | 'pink'
  className?: string
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-ink-100 text-ink-600',
    brand: 'bg-brand-50 text-brand-700',
    success: 'bg-emerald-50 text-emerald-700',
    warn: 'bg-amber-50 text-amber-700',
    danger: 'bg-rose-50 text-rose-700',
    info: 'bg-sky-50 text-sky-700',
    pink: 'bg-pink-50 text-pink-700',
  }
  return <span className={clsx('mp-chip', tones[tone], className)}>{children}</span>
}

/** 论文状态徽标 */
export function StatusBadge({ status }: { status: PaperStatus }) {
  const map: Record<PaperStatus, { label: string; tone: 'success' | 'warn' | 'neutral' | 'danger' }> = {
    analyzed: { label: '已分析', tone: 'success' },
    parsing: { label: '解析中', tone: 'warn' },
    pending: { label: '待解析', tone: 'neutral' },
    failed: { label: '解析失败', tone: 'danger' },
  }
  const { label, tone } = map[status]
  const dot = {
    success: 'bg-emerald-500',
    warn: 'bg-amber-500',
    neutral: 'bg-ink-400',
    danger: 'bg-rose-500',
  }[tone]
  return (
    <Chip tone={tone}>
      <span className={clsx('h-1.5 w-1.5 rounded-full', dot)} />
      {label}
    </Chip>
  )
}

const PARADIGM_TONE: Record<MethodParadigm, 'brand' | 'info' | 'success' | 'warn' | 'pink' | 'neutral'> = {
  Prompting: 'info',
  'Fine-tuning': 'warn',
  Agent: 'brand',
  'Multi-Agent': 'success',
  'Tool-Augmented': 'pink',
  'Neuro-Symbolic': 'neutral',
}

/** 方法范式徽标 */
export function ParadigmBadge({ paradigm }: { paradigm: MethodParadigm }) {
  return <Chip tone={PARADIGM_TONE[paradigm]}>{paradigm}</Chip>
}

const GAP_META: Record<GapType, { label: string; tone: 'brand' | 'info' | 'warn' | 'pink' | 'success' }> = {
  method: { label: '方法空白', tone: 'brand' },
  data: { label: '数据空白', tone: 'info' },
  evaluation: { label: '评价空白', tone: 'warn' },
  application: { label: '应用场景空白', tone: 'pink' },
}

export function GapTypeBadge({ type }: { type: GapType }) {
  const { label, tone } = GAP_META[type]
  return <Chip tone={tone}>{label}</Chip>
}

export const gapTypeLabel = (type: GapType) => GAP_META[type].label

const RELATION_META: Record<RelationType, { label: string; tone: 'brand' | 'success' | 'warn' | 'info' | 'neutral' | 'pink'; desc: string }> = {
  extends: { label: '继承', tone: 'brand', desc: '在原有方法基础上扩展适用场景或能力边界' },
  improves: { label: '改进', tone: 'success', desc: '针对原方法的已知缺陷提出改进机制' },
  combines: { label: '组合', tone: 'info', desc: '将多个方法的机制组合协同使用' },
  replaces: { label: '替代', tone: 'warn', desc: '以不同技术路线达成相似目标，替代原有方案' },
  parallel: { label: '并行发展', tone: 'pink', desc: '同期独立提出，思路相近但无直接继承关系' },
  related: { label: '相关', tone: 'neutral', desc: '存在主题关联，但证据不足以判定演进关系' },
  temporal: { label: '时间相邻', tone: 'neutral', desc: '仅年份相邻，无证据支持因果关系' },
}

export function RelationBadge({ type }: { type: RelationType }) {
  const { label, tone } = RELATION_META[type]
  return <Chip tone={tone}>{label}</Chip>
}

export const relationLabel = (type: RelationType) => RELATION_META[type].label
export const relationDesc = (type: RelationType) => RELATION_META[type].desc

/* ------------------------------------------------------------------ */
/* 状态视图：加载 / 空 / 错误                                          */
/* ------------------------------------------------------------------ */

export function LoadingState({ label = '正在加载…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
      <p className="text-sm text-ink-400">{label}</p>
    </div>
  )
}

export function SkeletonState({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3 py-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="mp-skeleton h-14 w-full" />
      ))}
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string
  description?: string
  action?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-ink-200 bg-ink-50/60 px-6 py-14 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-ink-400 shadow-sm">
        {icon ?? <IconLayers className="h-5 w-5" />}
      </div>
      <div>
        <p className="text-sm font-medium text-ink-700">{title}</p>
        {description && <p className="mx-auto mt-1 max-w-md text-xs text-ink-400">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function ErrorState({
  title = '加载失败',
  description,
  onRetry,
}: {
  title?: string
  description?: string
  onRetry?: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-rose-100 bg-rose-50/50 px-6 py-14 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-rose-500 shadow-sm">
        <IconAlert className="h-5 w-5" />
      </div>
      <div>
        <p className="text-sm font-medium text-ink-700">{title}</p>
        {description && <p className="mx-auto mt-1 max-w-md text-xs text-ink-500">{description}</p>}
      </div>
      {onRetry && (
        <button className="mp-btn mp-btn-ghost" onClick={onRetry}>
          <IconRefresh className="h-3.5 w-3.5" /> 重试
        </button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Evidence 按钮/引用                                                  */
/* ------------------------------------------------------------------ */

export function EvidenceButton({
  count,
  onClick,
  className,
}: {
  count: number
  onClick: () => void
  className?: string
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-brand-200 bg-brand-50/70 px-2 py-1 text-[11px] font-medium text-brand-700 transition hover:bg-brand-100',
        className,
      )}
      title="查看关联的证据"
    >
      <IconQuote className="h-3 w-3" />
      {count} Evidence
    </button>
  )
}

/** 进度条 */
export function ProgressBar({
  value,
  max = 100,
  color = 'var(--color-brand-500)',
  className,
}: {
  value: number
  max?: number
  color?: string
  className?: string
}) {
  const pct = Math.min(100, Math.round((value / max) * 100))
  return (
    <div className={clsx('h-1.5 w-full overflow-hidden rounded-full bg-ink-100', className)}>
      <div
        className="h-full rounded-full transition-all duration-700 ease-out"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  )
}

/** 数据显示：小统计条 */
export function StatPill({
  label,
  value,
  color,
}: {
  label: string
  value: string | number
  color?: string
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-ink-200 bg-white px-3 py-2">
      <span className="text-xs text-ink-500">{label}</span>
      <span className="text-sm font-semibold" style={{ color: color ?? 'var(--color-ink-800)' }}>
        {value}
      </span>
    </div>
  )
}

/** 简单的 key-value 列表，用于方法卡片等 */
export function FieldList({
  label,
  items,
  tone = 'neutral',
}: {
  label: string
  items: string[]
  tone?: 'neutral' | 'success' | 'danger'
}) {
  if (!items.length) return null
  return (
    <div>
      <p className="mp-label mb-1.5">{label}</p>
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it} className="flex items-start gap-1.5 text-[13px] leading-relaxed text-ink-600">
            <span
              className={clsx(
                'mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full',
                tone === 'success' && 'bg-emerald-400',
                tone === 'danger' && 'bg-amber-400',
                tone === 'neutral' && 'bg-brand-300',
              )}
            />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 数据来源徽标 —— 诚实性声明                                          */
/* ------------------------------------------------------------------ */

/**
 * LIVE / MOCK 徽标。
 *
 * 这个组件存在的唯一目的是**不误导**：评委必须能一眼分清
 * "这是我们真跑通的能力" 和 "这是预置的演示数据"。
 * 所以样式刻意做得显眼（色块 + 边框），而不是一个灰色小标签。
 */
export function ModeBadge({
  mode,
  note,
  className,
}: {
  mode: 'LIVE' | 'MOCK'
  note?: string
  className?: string
}) {
  const live = mode === 'LIVE'
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold tracking-wide',
        live
          ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
          : 'border-ink-200 bg-ink-50 text-ink-500',
        className,
      )}
      title={note}
    >
      <span
        className={clsx(
          'inline-block h-1.5 w-1.5 rounded-full',
          live ? 'bg-emerald-500' : 'bg-ink-300',
        )}
      />
      {mode}
    </span>
  )
}

/**
 * 数据来源徽标：Demo / 用户上传 / AI 抽取。
 *
 * 与服务端的 SourceType 一一对应。之所以要三种而不是两种：
 * "用户上传的 PDF"和"从它抽取出的 AI 结论"是两回事，
 * 前者是原始材料，后者是可能出错的分析结果，混淆两者会让人误以为
 * 论文里的原文就是系统生成的。
 */
export function SourceBadge({ source, className }: { source: SourceType; className?: string }) {
  const map: Record<SourceType, { label: string; tone: 'neutral' | 'info' | 'pink' }> = {
    demo: { label: 'Demo 数据', tone: 'neutral' },
    uploaded: { label: '用户上传', tone: 'info' },
    ai_generated: { label: 'AI 抽取', tone: 'pink' },
  }
  const m = map[source]
  return (
    <Chip tone={m.tone} className={className}>
      {m.label}
    </Chip>
  )
}

/* ------------------------------------------------------------------ */
/* 主题切换                                                            */
/* ------------------------------------------------------------------ */

export type ThemeMode = 'light' | 'dark'

export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('methodpilot-theme')
    return (saved as ThemeMode) ?? 'light'
  })

  useEffect(() => {
    localStorage.setItem('methodpilot-theme', theme)
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  return {
    theme,
    toggle: () => setTheme((t) => (t === 'light' ? 'dark' : 'light')),
  }
}
