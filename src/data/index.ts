import type { Evidence, KnowledgeBase, Project } from '@/types'
import { evidence } from './evidence'
import { directions, gaps } from './gaps'
import { families, methods } from './methods'
import { papers } from './papers'
import { evolutions, relations } from './relations'

/**
 * 项目索引 —— 所有页面通过它取数。
 *
 * 后续接入真实 Agent 时，只需把这里替换为从后端获取的 KnowledgeBase，
 * 页面层代码无需改动。
 */

export const project: Project = {
  id: 'proj-aicoding-agent',
  name: 'AI Coding Agent 方法演进研究',
  subtitle: '基于论文的方法分析与研究方向发现',
  description:
    '聚焦 AI Coding Agent / Software Engineering Agent 细分领域，梳理 2019–2025 年间的关键方法、技术演进路径与尚未解决的研究空白。',
  created_at: '2026-09-14',
  updated_at: '2026-09-21',
  domain: '计算机科学 / 软件工程 / 人工智能',
  paper_ids: papers.map((p) => p.paper_id),
}

/**
 * 反向引用校正
 *
 * 设计决策：`evidence` 表是证据链的唯一事实来源（single source of truth）。
 * Evidence 上声明了它关联哪些 paper / method / gap / direction，
 * 因此 Paper / Method / Gap / Direction 侧的 `evidence_ids` 一律由此**推导**而来，
 * 而不是两处各手写一份。
 *
 * 这样做的直接好处：不可能出现"卡片显示 7 条证据、抽屉里列出 11 条"这类
 * 自相矛盾的情况——而这恰恰是 Evidence-First 产品最不能出的错。
 */
const methodsOfEvidence = (e: Evidence, own: string[]) =>
  e.method_ids.filter((m) => own.includes(m))

const reconciledPapers = papers.map((paper) => ({
  ...paper,
  evidence_count: evidence.filter((e) => e.paper_id === paper.paper_id).length,
}))

const reconciledMethods = methods.map((method) => ({
  ...method,
  evidence_ids: evidence
    .filter((e) => methodsOfEvidence(e, [method.method_id]).length > 0)
    .map((e) => e.evidence_id),
}))

const reconciledGaps = gaps.map((gap) => ({
  ...gap,
  evidence_ids: evidence.filter((e) => e.gap_ids.includes(gap.gap_id)).map((e) => e.evidence_id),
}))

const reconciledDirections = directions.map((direction) => {
  const owned = evidence
    .filter((e) => e.direction_ids.includes(direction.direction_id))
    .map((e) => e.evidence_id)

  // 方向还应继承其关联空白下的证据，否则「空白已被证据支撑、方向却无证据」会造成口径断裂
  const viaGaps = evidence
    .filter((e) => e.gap_ids.some((g) => direction.gap_ids.includes(g)))
    .map((e) => e.evidence_id)

  return {
    ...direction,
    evidence_ids: [...new Set([...owned, ...viaGaps])],
  }
})

export const knowledgeBase: KnowledgeBase = {
  project,
  papers: reconciledPapers,
  methods: reconciledMethods,
  families,
  relations,
  evolutions,
  gaps: reconciledGaps,
  directions: reconciledDirections,
  evidence,
}

export { evidence, families, methods, papers, relations, evolutions, gaps, directions }
