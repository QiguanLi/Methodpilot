import type {
  Evolution,
  KnowledgeBase,
  Method,
  MethodRelation,
  Paper,
  ResearchDirection,
  ResearchGap,
} from '@/types'
import { knowledgeBase } from '@/data'

/* ------------------------------------------------------------------ */
/* Agent 接口层 —— Mock / Real 的唯一切换点                            */
/* ------------------------------------------------------------------ */

/**
 * 这七个函数对应 MethodPilot 的七项核心 AI 能力。
 * 当前全部返回 Mock 数据（带模拟延迟），后续逐个替换为真实实现：
 *
 *   - analyzePapers()       → 调用 PDF 解析服务（如 PyMuPDF + 版面分析）产出章节结构
 *   - extractMethods()      → 用 LLM 从正文抽取方法实体，返回结构化 JSON
 *   - classifyMethods()     → 对方法做任务/范式聚类，归纳方法族
 *   - buildEvolution()      → 跨论文对比，重建技术演进链
 *   - detectResearchGaps()  → 对跨论文证据做对比归因，识别空白
 *   - generateDirections()  → 基于空白与证据生成研究方向
 *   - generateReport()      → 汇总所有结构化为调研报告
 *
 * 契约保持不变，页面层无需改动。
 */

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Agent 运行模式：'mock' 立即返回演示数据；'live' 走真实后端 */
export type AgentMode = 'mock' | 'live'

const AGENT_MODE: AgentMode =
  (import.meta.env.VITE_AGENT_MODE as AgentMode | undefined) ?? 'mock'

export const getAgentMode = () => AGENT_MODE

/* ------------------------------------------------------------------ */
/* 1. 文献解析                                                         */
/* ------------------------------------------------------------------ */

export interface AnalyzePapersResult {
  parsed: number
  total: number
  papers: Paper[]
}

export async function analyzePapers(
  paperIds?: string[],
): Promise<AnalyzePapersResult> {
  if (AGENT_MODE === 'live') {
    // TODO: POST /api/agent/analyze-papers
    throw new Error('Live mode is not implemented yet')
  }
  await delay(1200)
  const target = paperIds?.length
    ? knowledgeBase.papers.filter((p) => paperIds.includes(p.paper_id))
    : knowledgeBase.papers
  return { parsed: target.length, total: knowledgeBase.papers.length, papers: target }
}

/* ------------------------------------------------------------------ */
/* 2. 方法抽取                                                         */
/* ------------------------------------------------------------------ */

export interface ExtractMethodsResult {
  methods: Method[]
  evidenceCreated: number
}

export async function extractMethods(paperIds?: string[]): Promise<ExtractMethodsResult> {
  if (AGENT_MODE === 'live') throw new Error('Live mode is not implemented yet')
  await delay(1400)
  const methods = paperIds?.length
    ? knowledgeBase.methods.filter((m) =>
        m.paper_ids.some((pid) => paperIds.includes(pid)),
      )
    : knowledgeBase.methods
  return { methods, evidenceCreated: knowledgeBase.evidence.length }
}

/* ------------------------------------------------------------------ */
/* 3. 方法分类                                                         */
/* ------------------------------------------------------------------ */

export interface ClassifyMethodsResult {
  families: KnowledgeBase['families']
  assignments: { method_id: string; family_id: string }[]
  unclassified: number
}

export async function classifyMethods(): Promise<ClassifyMethodsResult> {
  if (AGENT_MODE === 'live') throw new Error('Live mode is not implemented yet')
  await delay(1600)
  return {
    families: knowledgeBase.families,
    assignments: knowledgeBase.methods.map((m) => ({
      method_id: m.method_id,
      family_id: m.family_id,
    })),
    unclassified: 0,
  }
}

/* ------------------------------------------------------------------ */
/* 4. 技术演进重建                                                     */
/* ------------------------------------------------------------------ */

export interface BuildEvolutionResult {
  evolutions: Evolution[]
  relations: MethodRelation[]
}

export async function buildEvolution(): Promise<BuildEvolutionResult> {
  if (AGENT_MODE === 'live') throw new Error('Live mode is not implemented yet')
  await delay(1500)
  return { evolutions: knowledgeBase.evolutions, relations: knowledgeBase.relations }
}

/* ------------------------------------------------------------------ */
/* 5. 研究空白发现                                                     */
/* ------------------------------------------------------------------ */

export async function detectResearchGaps(): Promise<ResearchGap[]> {
  if (AGENT_MODE === 'live') throw new Error('Live mode is not implemented yet')
  await delay(1700)
  return knowledgeBase.gaps
}

/* ------------------------------------------------------------------ */
/* 6. 研究方向推导                                                     */
/* ------------------------------------------------------------------ */

export interface GenerateDirectionsResult {
  directions: ResearchDirection[]
  groundedEvidence: number
}

export async function generateDirections(): Promise<GenerateDirectionsResult> {
  if (AGENT_MODE === 'live') throw new Error('Live mode is not implemented yet')
  await delay(1800)
  return {
    directions: knowledgeBase.directions,
    groundedEvidence: knowledgeBase.evidence.filter(
      (e) => e.direction_ids.length > 0,
    ).length,
  }
}

/* ------------------------------------------------------------------ */
/* 7. 调研报告生成                                                     */
/* ------------------------------------------------------------------ */

export interface ReportSection {
  id: string
  title: string
  content: string
}

export interface GenerateReportResult {
  title: string
  generatedAt: string
  sections: ReportSection[]
  stats: {
    papers: number
    methods: number
    families: number
    evolutions: number
    gaps: number
    directions: number
    evidence: number
  }
}

export async function generateReport(): Promise<GenerateReportResult> {
  if (AGENT_MODE === 'live') throw new Error('Live mode is not implemented yet')
  await delay(2200)
  const kb = knowledgeBase
  const now = new Date()
  return {
    title: `${kb.project.name} · 研究调研报告`,
    generatedAt: now.toISOString(),
    sections: buildReportSections(kb),
    stats: {
      papers: kb.papers.length,
      methods: kb.methods.length,
      families: kb.families.length,
      evolutions: kb.evolutions.length,
      gaps: kb.gaps.length,
      directions: kb.directions.length,
      evidence: kb.evidence.length,
    },
  }
}

/* ------------------------------------------------------------------ */
/* 报告内容生成（纯函数，便于单测与后续替换）                           */
/* ------------------------------------------------------------------ */

function buildReportSections(kb: KnowledgeBase): ReportSection[] {
  // 年份范围同时考虑论文发表年与演进节点年，避免"演进已到 2025，摘要却只写到 2024"的口径不一致
  const allYears = [
    ...kb.papers.map((p) => p.year),
    ...kb.evolutions.map((e) => e.year),
  ]
  const yearRange = `${Math.min(...allYears)}–${Math.max(...allYears)}`
  const paperYearRange = `${Math.min(...kb.papers.map((p) => p.year))}–${Math.max(
    ...kb.papers.map((p) => p.year),
  )}`

  return [
    {
      id: 'abstract',
      title: '摘要',
      content: `本报告由 MethodPilot 基于 ${kb.papers.length} 篇论文自动生成，覆盖 ${paperYearRange} 年 AI Coding Agent 领域的关键工作，并将技术演进追踪至 ${Math.max(...allYears)} 年。系统共抽取 ${kb.methods.length} 个方法实体，归纳为 ${kb.families.length} 个方法族，重建 ${kb.evolutions.length} 个技术演进节点，识别 ${kb.gaps.length} 项研究空白并提出 ${kb.directions.length} 个候选研究方向。全部关键结论均关联至 ${kb.evidence.length} 条论文原文证据，平均置信度 ${(
        kb.evidence.reduce((s, e) => s + e.confidence, 0) / kb.evidence.length
      ).toFixed(2)}。`,
    },
    {
      id: 'background',
      title: '一、研究背景',
      content: `随着大语言模型在代码理解与生成上的能力提升，研究重心正从"生成一段代码"转向"自主完成真实仓库级的软件工程任务"。本报告聚焦的细分领域为 AI Coding Agent / Software Engineering Agent，核心问题是：Agent 如何在真实代码仓库中定位问题、做出修改并通过测试验证。\n\n该领域在 ${yearRange} 年间经历了从提示工程到 Agent 系统的范式迁移，其技术弧线可概括为：上下文学习 → 思维链 → 推理-行动交错 → 工具使用 → 规划与反思 → 仓库级 Agent。`,
    },
    {
      id: 'literature',
      title: '二、文献概览',
      content: kb.papers
        .slice()
        .sort((a, b) => a.year - b.year)
        .map(
          (p) =>
            `**${p.title}**（${p.venue}, ${p.year}）— ${p.authors[0]}${p.authors.length > 1 ? ' 等' : ''}。研究任务：${p.task}。本文抽取 ${getEvidenceCount(kb, p.paper_id)} 条证据。`,
        )
        .join('\n\n'),
    },
    {
      id: 'methods',
      title: '三、方法分类',
      content: kb.families
        .map((f) => {
          const ms = kb.methods.filter((m) => m.family_id === f.family_id)
          return `### ${f.name_zh}（${f.name}）\n\n${f.description}\n\n包含 ${ms.length} 个方法：${ms
            .map((m) => `${m.name}（${m.year}）`)
            .join('、')}。`
        })
        .join('\n\n'),
    },
    {
      id: 'evolution',
      title: '四、技术演进',
      content: kb.evolutions
        .slice()
        .sort((a, b) => a.year - b.year)
        .map(
          (e) =>
            `**${e.year} · ${e.stage_title}**\n\n- 技术变化：${e.change}\n- 相比前一节点的改进：${e.improvement}\n- 暴露的局限：${e.limitation}\n- 证据：${e.evidence_ids.join('、') || '无直接证据（标注为时间相邻）'}`,
        )
        .join('\n\n'),
    },
    {
      id: 'gaps',
      title: '五、研究空白',
      content: kb.gaps
        .map((g, i) => {
          const typeLabel = {
            method: '方法空白',
            data: '数据空白',
            evaluation: '评价空白',
            application: '应用场景空白',
          }[g.type]
          return `### ${i + 1}. 【${typeLabel}】${g.title}\n\n**已有研究**：${g.existing_work}\n\n**当前问题**：${g.current_problem}\n\n**潜在价值**：${g.potential_value}\n\n**支撑论文**：${g.supporting_papers.join('、')}（${g.evidence_ids.length} 条证据）`
        })
        .join('\n\n'),
    },
    {
      id: 'directions',
      title: '六、未来研究方向',
      content: kb.directions
        .map(
          (d, i) =>
            `### ${String(i + 1).padStart(2, '0')} ${d.title}\n\n**研究问题**：${d.research_question}\n\n**可能方法**：${d.possible_method.map((m) => `\n- ${m}`).join('')}\n\n**实验设计**：${d.experiment_design}\n\n**Baseline**：${d.baselines.join('、')}\n\n**评价指标**：${d.metrics.join('、')}\n\n**主要风险**：${d.risk}\n\n**可行性 / 新颖性**：${d.feasibility} / ${d.novelty}`,
        )
        .join('\n\n'),
    },
    {
      id: 'references',
      title: '七、参考文献',
      content: kb.papers
        .slice()
        .sort((a, b) => a.year - b.year)
        .map(
          (p) =>
            `[${p.paper_id}] ${p.authors.join(', ')}. *${p.title}*. ${p.venue}, ${p.year}. ${p.source}`,
        )
        .join('\n\n'),
    },
  ]
}

function getEvidenceCount(kb: KnowledgeBase, paperId: string) {
  return kb.evidence.filter((e) => e.paper_id === paperId).length
}
