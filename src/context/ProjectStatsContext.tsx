import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '@/services/api'
import {
  DEMO_PROJECT_ID,
  loadDataset,
  registerDataset,
} from '@/services/projectData'
import { stats as demoStats } from '@/services/selectors'
import { ProjectStatsContext, type ProjectStatsValue, type ProjectStats } from './projectStats'

/**
 * Demo 项目的统计 —— 直接复用既有静态常量，保证 Demo 数字一个都不变。
 */
function demoProjectStats(): ProjectStats {
  return {
    source: 'demo',
    paperCount: demoStats.paperCount,
    methodCount: demoStats.methodCount,
    evidenceCount: demoStats.evidenceCount,
    /*
     * Demo 的空白 / 方向同样取自知识库静态数组。
     * `stats` 里已有这两个字段，直接沿用即可 —— 不要另算一遍，
     * 否则"侧栏数字"与"Demo 页面数字"会再次分叉。
     */
    gapCount: demoStats.gapCount,
    directionCount: demoStats.directionCount,
  }
}

export function ProjectStatsProvider({
  projectId,
  children,
}: {
  /** 当前项目 id。为 `null` 时表示不在项目上下文里（如工作台无 id） */
  projectId: string | null
  children: ReactNode
}) {
  const [value, setValue] = useState<ProjectStatsValue>({
    stats: null,
    projectId: null,
    dataset: null,
  })

  useEffect(() => {
    /*
     * 无项目上下文时**不调 setValue**（同步 setState 会触发级联渲染）。
     * 正确性由下面的 `useMemo` 属主校验保证：value.projectId 不等于当前 projectId
     * 时一律对外表现为"未就绪"，所以这里什么都不做也是安全的。
     */
    if (!projectId) return

    let alive = true

    const load = async () => {
      /* ── Demo：本地静态，不联网 ── */
      if (projectId === DEMO_PROJECT_ID) {
        try {
          const r = await loadDataset(projectId)
          if (!alive) return
          registerDataset(r.dataset)
          setValue({ stats: demoProjectStats(), projectId, dataset: r.dataset })
        } catch {
          if (!alive) return
          setValue({ stats: null, projectId, dataset: null })
        }
        return
      }

      /* ── Live：先要 dataset（论文/方法/证据），再要两个项目级接口 ── */
      try {
        const r = await loadDataset(projectId)
        if (!alive) return
        registerDataset(r.dataset)

        /*
         * 三项并行。任一失败都降级为 `null` 而不是 0 ——
         * 0 是"确实没有"，null 是"没拿到"，两者在界面上必须能分开。
         */
        const [gaps, directions] = await Promise.all([
          api.listGaps(projectId).catch(() => null),
          api.listDirections(projectId).catch(() => null),
        ])
        if (!alive) return

        setValue({
          stats: {
            source: 'live',
            paperCount: r.dataset.papers.length,
            methodCount: r.dataset.methods.length,
            evidenceCount: r.dataset.evidence.length,
            gapCount: gaps ? gaps.gaps.length : null,
            directionCount: directions ? directions.directions.length : null,
          },
          projectId,
          dataset: r.dataset,
        })
      } catch {
        /* 项目不存在 / 网络失败：统计留空，不回落 Demo */
        if (!alive) return
        setValue({ stats: null, projectId, dataset: null })
      }
    }

    void load()
    return () => {
      alive = false
    }
  }, [projectId])

  /*
   * 统计必须与传入的 projectId **属主一致** 才对外可见。
   *
   * 切换项目时 effect 是异步的，`value.projectId` 会短暂停留在旧项目上。
   * 若不校验，切换瞬间侧栏会显示上一个项目的数字 —— 又是一次串数据。
   */
  const safe = useMemo<ProjectStatsValue>(
    () => (value.projectId === projectId ? value : { stats: null, projectId, dataset: null }),
    [value, projectId],
  )

  return <ProjectStatsContext.Provider value={safe}>{children}</ProjectStatsContext.Provider>
}
