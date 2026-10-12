import { NavLink, useLocation, useNavigate, useParams } from 'react-router-dom'
import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  Chip,
  IconBell,
  IconBrain,
  IconChevronDown,
  IconClose,
  IconHome,
  IconLibrary,
  IconLightbulb,
  IconMap,
  IconMenu,
  IconMessage,
  IconPlus,
  IconReport,
  IconSearch,
  IconSparkles,
  IconTarget,
  IconTimeline,
} from './ui'
import { useProjectStats, type ProjectStats } from '@/context/projectStats'
import { getAgentMode } from '@/services/agent'

/* ------------------------------------------------------------------ */
/* 导航定义                                                            */
/* ------------------------------------------------------------------ */

interface NavItem {
  to: string
  label: string
  icon: ReactNode
  badge?: string | number
}

/**
 * 项目级路由（带 :id）。
 *
 * `s` 是本项目的统计数据（Demo 静态 / Live 真实），由 `ProjectStatsProvider` 提供。
 * **不要**再直接 import `selectors.stats` —— 那是演示知识库的常量，
 * 会让真实项目的侧栏显示演示数字（与页面正文自相矛盾）。
 *
 * 计数为 `null` 表示"尚未拿到"（加载中或接口失败）。此时**不显示徽标**，
 * 而不是显示 0 —— 0 是"确实没有"，两者不能混。
 */
function projectNav(id: string, s: ProjectStats | null): NavItem[] {
  const p = (suffix: string) => `/project/${id}${suffix}`
  const badge = (v: number | null | undefined) => (v == null ? undefined : v)
  return [
    { to: '/dashboard', label: '工作台', icon: <IconHome /> },
    /*
     * 论文探索（Phase 3B-2）。放在「文献库」**上方**：
     * 它解决的是"项目里还没有这篇论文"的情况，逻辑上发生在进文献库之前。
     * 放在下方会让人以为它是文献库的一个附属功能。
     */
    { to: p('/explorer'), label: '论文探索', icon: <IconSearch /> },
    { to: p('/papers'), label: '文献库', icon: <IconLibrary />, badge: badge(s?.paperCount) },
    /*
     * 上传入口（Phase 2）。刻意放在「文献库」正下方而非藏在文献库页内按钮里——
     * 它是本轮唯一新增的真实闭环起点，歪三层菜单等于评委找不到。
     */
    { to: p('/upload'), label: '上传论文', icon: <IconPlus /> },
    { to: p('/analysis'), label: '智能分析', icon: <IconBrain /> },
    { to: p('/methods'), label: '方法地图', icon: <IconMap />, badge: badge(s?.methodCount) },
    { to: p('/evolution'), label: '技术演进', icon: <IconTimeline /> },
    { to: p('/gaps'), label: '研究空白', icon: <IconTarget />, badge: badge(s?.gapCount) },
    {
      to: p('/directions'),
      label: '研究方向',
      icon: <IconLightbulb />,
      badge: badge(s?.directionCount),
    },
    { to: p('/report'), label: '调研报告', icon: <IconReport /> },
  ]
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                            */
/* ------------------------------------------------------------------ */

/** Logo 区（Sidebar 与移动端抽屉共用） */
function Logo({ onClose }: { onClose?: () => void }) {
  return (
    <div className="flex h-[56px] shrink-0 items-center gap-2.5 border-b border-ink-200 px-4">
      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-sm">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3 4.5 7.5v9L12 21l7.5-4.5v-9z" />
          <path d="M12 12v9M12 12 4.5 7.5M12 12l7.5-4.5" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-semibold tracking-tight text-ink-900">
          MethodPilot
        </p>
        <p className="truncate text-[10px] leading-tight text-ink-400">
          AI Research Method Copilot
        </p>
      </div>
      {onClose && (
        <button
          onClick={onClose}
          aria-label="收起导航"
          className="rounded-lg p-1.5 text-ink-400 transition hover:bg-ink-50 hover:text-ink-700 lg:hidden"
        >
          <IconClose className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { id } = useParams()
  const location = useLocation()
  const { stats: projectStats } = useProjectStats()
  const nav = projectNav(id ?? 'proj-aicoding-agent', projectStats)

  return (
    <aside className="flex h-full w-[216px] shrink-0 flex-col border-r border-ink-200 bg-white">
      <Logo onClose={onNavigate} />

      {/* 导航 */}
      <nav className="mp-scroll-thin flex-1 overflow-y-auto px-2.5 py-3">
        <p className="mp-label mb-1.5 px-2">研究流程</p>
        <ul className="space-y-0.5">
          {nav.map((item) => {
            const active =
              location.pathname === item.to ||
              (item.to !== '/dashboard' && location.pathname.startsWith(item.to))
            return (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  onClick={onNavigate}
                  className={clsx(
                    'group flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] transition-colors',
                    active
                      ? 'bg-brand-50 font-medium text-brand-700'
                      : 'text-ink-600 hover:bg-ink-50 hover:text-ink-800',
                  )}
                >
                  <span className={clsx(active ? 'text-brand-500' : 'text-ink-400 group-hover:text-ink-500')}>
                    {item.icon}
                  </span>
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.badge !== undefined && (
                    <span
                      /*
                       * 测试锚点：用路由后缀（papers/methods/gaps/directions）
                       * 而不是中文标签，断言更稳。
                       */
                      data-sidebar-stat={item.to.split('/').pop()}
                      className={clsx(
                        'rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums',
                        active ? 'bg-brand-100 text-brand-700' : 'bg-ink-100 text-ink-500',
                      )}
                    >
                      {item.badge}
                    </span>
                  )}
                </NavLink>
              </li>
            )
          })}
        </ul>
      </nav>

      {/* 底部：Evidence 覆盖率 */}
      <div className="border-t border-ink-200 p-3">
        <div className="rounded-lg bg-gradient-to-br from-brand-50 to-white p-3">
          <div className="flex items-center gap-1.5">
            <IconSparkles className="h-3.5 w-3.5 text-brand-500" />
            <p className="text-[11px] font-semibold text-brand-800">Evidence 覆盖</p>
          </div>
          {/*
            数字来自当前项目的 dataset（Live）或静态常量（Demo）。
            为 null 时显示占位符而不是 0 —— 0 会被误读成"一条证据都没有"。
          */}
          <p
            data-sidebar-stat="evidence"
            className="mt-1.5 text-[22px] font-semibold leading-none tabular-nums text-brand-700"
          >
            {projectStats?.evidenceCount ?? '—'}
          </p>
          <p className="mt-0.5 text-[10px] text-ink-400">条原文证据已锚定到章节</p>
        </div>
        <p className="mt-2 px-1 text-[10px] text-ink-400">
          {projectStats == null
            ? '数据源：加载中…'
            : projectStats.source === 'live'
              ? '数据源：当前项目真实数据'
              : `Agent 模式：${getAgentMode() === 'mock' ? 'Mock 演示数据' : 'Live 真实解析'}`}
        </p>
      </div>
    </aside>
  )
}

/* ------------------------------------------------------------------ */
/* TopBar                                                             */
/* ------------------------------------------------------------------ */

function TopBar({ onOpenNav }: { onOpenNav: () => void }) {
  const navigate = useNavigate()
  const location = useLocation()

  const breadcrumb = useMemo(() => {
    const seg = location.pathname.split('/').filter(Boolean)
    const map: Record<string, string> = {
      dashboard: '工作台',
      papers: '文献库',
      analysis: '智能分析',
      methods: '方法地图',
      evolution: '技术演进',
      gaps: '研究空白',
      directions: '研究方向',
      report: '调研报告',
      project: '项目',
      new: '新建项目',
    }
    return seg.map((s) => map[s] ?? s)
  }, [location.pathname])

  return (
    <header className="flex h-[56px] shrink-0 items-center gap-2 border-b border-ink-200 bg-white/85 px-3 backdrop-blur sm:gap-4 sm:px-5">
      {/* 移动端抽屉开关 */}
      <button
        onClick={onOpenNav}
        aria-label="展开导航"
        className="-ml-0.5 rounded-lg p-1.5 text-ink-500 transition hover:bg-ink-50 hover:text-ink-800 lg:hidden"
      >
        <IconMenu className="h-[18px] w-[18px]" />
      </button>

      {/* 面包屑 + 项目名 */}
      <div className="flex min-w-0 items-center gap-2">
        <button
          onClick={() => navigate('/dashboard')}
          className="flex min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-[13px] font-semibold text-ink-800 transition hover:bg-ink-50"
        >
          <span className="truncate sm:max-w-[280px]">AI Coding Agent 方法演进研究</span>
          <IconChevronDown className="hidden h-3.5 w-3.5 shrink-0 text-ink-400 sm:block" />
        </button>
        <span className="hidden text-ink-300 md:inline">/</span>
        <span className="hidden truncate text-[12.5px] text-ink-500 md:inline">
          {breadcrumb[breadcrumb.length - 1]}
        </span>
      </div>

      <div className="flex-1" />

      {/* 搜索 */}
      <div className="relative hidden lg:block">
        <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
        <input
          className="mp-input h-8 w-[220px] pl-8 text-[13px]"
          placeholder="搜索论文、方法、证据…"
        />
        <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-ink-200 bg-ink-50 px-1 py-px text-[10px] text-ink-400">
          ⌘K
        </kbd>
      </div>

      {/* AI 状态：窄屏只保留脉冲点，避免与项目名挤压重叠 */}
      <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 sm:px-2.5">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
        <span className="hidden text-[11px] font-medium text-emerald-700 sm:inline">Agent 就绪</span>
      </div>

      <button className="relative hidden shrink-0 rounded-lg p-1.5 text-ink-500 transition hover:bg-ink-50 hover:text-ink-700 sm:block">
        <IconBell className="h-4 w-4" />
        <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-rose-500 ring-2 ring-white" />
      </button>

      <button className="hidden shrink-0 rounded-lg p-1.5 text-ink-500 transition hover:bg-ink-50 hover:text-ink-700 sm:block">
        <IconMessage className="h-4 w-4" />
      </button>

      {/* 用户 */}
      <div className="flex items-center gap-2 border-l border-ink-200 pl-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-[11px] font-semibold text-white">
          R
        </div>
        <div className="hidden xl:block">
          <p className="text-[12px] font-medium leading-tight text-ink-800">Researcher</p>
          <p className="text-[10px] leading-tight text-ink-400">深大计软 · 参赛项目</p>
        </div>
      </div>
    </header>
  )
}

/* ------------------------------------------------------------------ */
/* Layout                                                             */
/* ------------------------------------------------------------------ */

export function AppLayout({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false)
  const location = useLocation()

  // 路由变化时自动收起移动端抽屉
  useEffect(() => {
    setNavOpen(false)
  }, [location.pathname])

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      {/* 桌面端常驻 Sidebar（大屏以下让位给抽屉） */}
      <div className="hidden lg:flex">
        <Sidebar />
      </div>

      {/* 移动端抽屉 */}
      {navOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-ink-900/40 backdrop-blur-[2px]"
            onClick={() => setNavOpen(false)}
          />
          <div className="mp-anim-slide-left absolute inset-y-0 left-0 shadow-xl">
            <Sidebar onNavigate={() => setNavOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenNav={() => setNavOpen(true)} />
        <main className="mp-scroll-thin flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1400px] px-3 py-4 sm:px-5 sm:py-5 lg:px-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}

/** 页面级标题区 */
export function PageHeader({
  title,
  subtitle,
  actions,
  meta,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
  meta?: ReactNode
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[21px] font-semibold tracking-tight text-ink-900">{title}</h1>
        {subtitle && <p className="mt-1 text-[13px] text-ink-500">{subtitle}</p>}
        {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export { Chip }
