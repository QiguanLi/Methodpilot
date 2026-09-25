import { createContext, useContext } from 'react'
import type { ProjectDataset } from '@/services/projectData'

/**
 * 侧边栏统计的**唯一数据源**。
 *
 * ── 为什么必须有这一层 ──
 *
 * 侧边栏（`AppLayout.tsx`）挂在 `<Routes>` 之外，拿不到页面里加载的数据集，
 * 所以早期实现直接读了 `selectors.ts` 里的 `stats` —— 而那个对象是
 * **Demo 知识库的静态常量**。
 *
 * 后果：打开任何一个真实项目，侧边栏都显示演示库的数字
 * （18 篇论文 / 19 个方法 / 5 条空白 / 3 个方向 / 38 条证据），
 * 而「研究方向」页面正文却显示该项目真实的 1 个方向。
 * 同一个页面上两个数字互相打脸，用户会以为分析坏了 —— 其实只是侧栏在读演示数据。
 *
 * 这与 `EvidenceDrawer` 回落 Demo、`GapsPage` 误落 Demo 分支是**同一类错误**：
 * 把演示数据伪装成对用户项目的分析结论。
 *
 * ── 规则 ──
 *
 *   Demo 项目：沿用 `selectors.stats` 的静态值（保持现有 Demo 数字不变）
 *   Live 项目：论文 / 方法 / 证据数取自当前项目的 dataset；
 *              空白 / 方向数取自项目级接口（dataset 里没有这两项）
 *
 * 刻意**不**做任何推断或补齐：拿不到就是 `null`，由消费方决定显示
 * 数字还是占位符。宁可暂时不显示，也不能显示一个错的数字。
 */
export interface ProjectStats {
  source: 'demo' | 'live'
  /** `null` = 尚未拿到（加载中或失败）。**不是 0** —— 0 是"确实没有" */
  paperCount: number | null
  methodCount: number | null
  evidenceCount: number | null
  gapCount: number | null
  directionCount: number | null
}

export interface ProjectStatsValue {
  /** 当前项目的统计。`null` = 尚未加载完（或加载失败），消费方应显示占位符 */
  stats: ProjectStats | null
  /** 统计所属的项目 id，便于消费方校验是否串数据 */
  projectId: string | null
  /** 当前项目的数据集（Live 时供页面复用，避免重复请求） */
  dataset: ProjectDataset | null
}

/** 默认值刻意是"空"：没有 Provider 时消费方显示占位符，而不是演示数字 */
export const ProjectStatsContext = createContext<ProjectStatsValue>({
  stats: null,
  projectId: null,
  dataset: null,
})

export function useProjectStats(): ProjectStatsValue {
  return useContext(ProjectStatsContext)
}
