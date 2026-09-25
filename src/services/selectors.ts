import { knowledgeBase } from '@/data'
import type { ServerAlignmentCandidate, AlignmentRelationType } from './api'
import type {
  Evidence,
  Evolution,
  Method,
  MethodFamily,
  MethodRelation,
  Paper,
  RelationType,
  ResearchDirection,
  ResearchGap,
} from '@/types'

/**
 * 关系类型的展示元信息
 *
 * 放在这里而非组件里，是因为「关系如何被描述」属于领域语义，
 * 报告生成、证据抽屉、方法地图都要共用同一套措辞，避免各页面口径不一致。
 */
const RELATION_META: Record<RelationType, { label: string; desc: string }> = {
  extends: { label: '继承', desc: '在原有方法基础上扩展适用场景或能力边界' },
  improves: { label: '改进', desc: '针对原方法的已知缺陷提出改进机制' },
  combines: { label: '组合', desc: '将多个方法的机制组合协同使用' },
  replaces: { label: '替代', desc: '以不同技术路线达成相似目标，替代原有方案' },
  parallel: { label: '并行发展', desc: '同期独立提出，思路相近但无直接继承关系' },
  related: { label: '相关', desc: '存在主题关联，但证据不足以判定演进关系' },
  temporal: { label: '时间相邻', desc: '仅年份相邻，无证据支持因果关系' },
}

export const relationLabel = (type: RelationType) => RELATION_META[type].label
export const relationDesc = (type: RelationType) => RELATION_META[type].desc

/* ------------------------------------------------------------------ */
/* 跨论文对齐关系（Phase 4-3）                                          */
/* ------------------------------------------------------------------ */

/**
 * 四类对齐关系的展示元信息。
 *
 * 与上面的 RELATION_META 分开，因为它们是**两套不同的语义**：
 *   RELATION_META        —— 人工标注的演进关系（继承/改进/组合…）
 *   ALIGNMENT_META       —— 服务端规则算出的对齐候选（同一/别名/相关/说不清）
 * 措辞必须能一眼区分，否则用户会把"判定为同一方法"读成"B 继承自 A"。
 *
 * `tone` 是给 Chip 用的语义色：same/alias 是**有结论**的（品牌色/成功色），
 * related/uncertain 是**待人工判断**的（中性色/警告色）。
 * 这个区分很重要——不能让"我们说不清"和"我们确认是同一个"看起来一样重。
 */
export const ALIGNMENT_META: Record<
  AlignmentRelationType,
  { label: string; desc: string; tone: 'brand' | 'success' | 'info' | 'neutral' | 'warn' }
> = {
  same: {
    label: '同一方法',
    desc: '名称与证据都指向同一个方法实体',
    tone: 'brand',
  },
  alias: {
    label: '别名',
    desc: '同一方法的不同写法（简称、缩写或作者声明的别名）',
    tone: 'success',
  },
  related: {
    label: '相关',
    desc: '存在主题关联，但证据不足以认定是同一方法，需人工判读',
    tone: 'info',
  },
  uncertain: {
    label: '待判断',
    desc: '发现了弱信号但无法给出结论，不生成任何强关系',
    tone: 'warn',
  },
}

export const alignmentLabel = (t: AlignmentRelationType) => ALIGNMENT_META[t].label
export const alignmentDesc = (t: AlignmentRelationType) => ALIGNMENT_META[t].desc
export const alignmentTone = (t: AlignmentRelationType) => ALIGNMENT_META[t].tone

/** 四类关系的稳定展示顺序。图表、图例、统计都按它走，避免各处顺序不一致 */
export const ALIGNMENT_ORDER: AlignmentRelationType[] = ['same', 'alias', 'related', 'uncertain']

/**
 * 把服务端的对齐候选转成方法地图既有的 `MethodRelation`。
 *
 * ── 为什么要转换，而不是让地图直接消费 AlignmentCandidate ──
 * 地图的连线渲染、图例、明细表都是围绕 `MethodRelation` 写的
 * （字段 source_method / target_method / relation_type / description / evidence_ids）。
 * 转换一次，这些渲染逻辑**一行都不用改**，也就不会引入新的渲染 bug。
 * 代价是类型上要写一层映射——比改动 500 行 SVG 渲染代码便宜得多。
 *
 * 注意 relation_type 用的是**对齐四类**，不是演进七类。
 * 所以 `isGrounded()`（判断是否 temporal/related）对它们不适用，
 * 地图侧要按 `alignment` 语义单独判定，见 MethodsPage。
 */
export function toMethodRelation(c: ServerAlignmentCandidate): MethodRelation {
  return {
    /*
     * 用 alignment_id 作为 relation_id。
     * 它在服务端是"排序后位置"的纯函数，全局唯一且稳定，
     * 正好满足 React key 与 hover 态标识的要求，不需要再加前缀。
     */
    relation_id: c.alignment_id,
    source_method: c.source.method_id,
    target_method: c.target.method_id,
    // 这里做一次收窄：四个对齐类型在 RelationType 里都有对应成员
    // （related 恰好同名），所以转换是安全的。same/alias/uncertain 在
    // 演进七类里没有对应项——这是有意为之，见下方说明。
    relation_type: ALIGNMENT_TO_RELATION[c.relation_type],
    description: c.reason,
    evidence_ids: c.evidence_ids,
  }
}

/**
 * 对齐类型 → 地图渲染用的类型。
 *
 * ⚠️ 这是一个**展示层**的映射，不是语义合并。
 *
 * 演进七类里没有 same/alias/uncertain 这三个概念，但地图的连线和图例
 * 是按 `RelationType` 索引颜色的。直接新增三个类型到 `RelationType`
 * 会波及报告生成、证据抽屉等所有消费方——那是 Phase 4-3 不该动的范围。
 *
 * 所以：
 *   same / alias → 'combines'（同为"两者是同一/同源"的强关联表达）
 *   related      → 'related'
 *   uncertain    → 'temporal'（同为"无因果证据"的最弱标注）
 *
 * 但**地图上显示的文字仍用 alignmentLabel()**，所以用户看到的永远是
 * 「同一方法 / 别名 / 相关 / 待判断」，不会看到"组合""时间相邻"这种
 * 与事实不符的措辞。这个映射只影响线条颜色。
 */
const ALIGNMENT_TO_RELATION: Record<AlignmentRelationType, RelationType> = {
  same: 'combines',
  alias: 'combines',
  related: 'related',
  uncertain: 'temporal',
}

/** 判定一条对齐关系是否为"有结论"的（same/alias），区别于待人工判断的 */
export const isAlignmentConclusive = (t: AlignmentRelationType) =>
  t === 'same' || t === 'alias'

/** 该关系是否有原文证据支持（否则应降级展示） */
export const isGroundedRelation = (type: RelationType) =>
  type !== 'temporal' && type !== 'related'


/**
 * 查询层（selectors）
 *
 * 页面只通过这里访问数据，不直接 import data/*。
 * 好处：后续换成后端 API 或真实 Agent 输出时，改动被收敛在这一层。
 */

export const kb = knowledgeBase

export const getProject = () => kb.project

export const getPapers = (): Paper[] => kb.papers
export const getPaper = (id: string): Paper | undefined =>
  kb.papers.find((p) => p.paper_id === id)

export const getMethods = (): Method[] => kb.methods
export const getMethod = (id: string): Method | undefined =>
  kb.methods.find((m) => m.method_id === id)

export const getFamilies = (): MethodFamily[] => kb.families
export const getFamily = (id: string): MethodFamily | undefined =>
  kb.families.find((f) => f.family_id === id)

export const getRelations = (): MethodRelation[] => kb.relations

/** 与某方法直接相连的关系 */
export const getRelationsOfMethod = (methodId: string): MethodRelation[] =>
  kb.relations.filter(
    (r) => r.source_method === methodId || r.target_method === methodId,
  )

export const getEvolutions = (): Evolution[] =>
  [...kb.evolutions].sort((a, b) => a.year - b.year)

export const getGaps = (): ResearchGap[] => kb.gaps
export const getGap = (id: string): ResearchGap | undefined =>
  kb.gaps.find((g) => g.gap_id === id)

export const getDirections = (): ResearchDirection[] => kb.directions
export const getDirection = (id: string): ResearchDirection | undefined =>
  kb.directions.find((d) => d.direction_id === id)

export const getEvidenceList = (): Evidence[] => kb.evidence
export const getEvidence = (id: string): Evidence | undefined =>
  kb.evidence.find((e) => e.evidence_id === id)
export const getEvidenceByIds = (ids: string[]): Evidence[] =>
  ids.map((id) => getEvidence(id)).filter((e): e is Evidence => Boolean(e))

export const getEvidenceOfPaper = (paperId: string): Evidence[] =>
  kb.evidence.filter((e) => e.paper_id === paperId)

/* ------------------------------------------------------------------ */
/* 反向索引                                                            */
/* ------------------------------------------------------------------ */

/** 引用了某方法的所有论文 */
export const getPapersOfMethod = (methodId: string): Paper[] =>
  kb.papers.filter((p) => p.method_ids.includes(methodId))

/** 支撑某空白的证据 */
export const getEvidenceOfGap = (gapId: string): Evidence[] =>
  kb.evidence.filter((e) => e.gap_ids.includes(gapId))

/** 支撑某方向的证据 */
export const getEvidenceOfDirection = (directionId: string): Evidence[] =>
  kb.evidence.filter((e) => e.direction_ids.includes(directionId))

/** 某论文涉及的方法 */
export const getMethodsOfPaper = (paperId: string): Method[] =>
  kb.methods.filter((m) => m.paper_ids.includes(paperId))

/** 由某空白推导出的研究方向 */
export const getDirectionsOfGap = (gapId: string): ResearchDirection[] =>
  kb.directions.filter((d) => d.gap_ids.includes(gapId))

/** 与某方法同族的方法 */
export const getSiblingMethods = (methodId: string): Method[] => {
  const method = getMethod(methodId)
  if (!method) return []
  return kb.methods.filter(
    (m) => m.family_id === method.family_id && m.method_id !== methodId,
  )
}

/** 某论文的关联论文 */
export const getRelatedPapers = (paperId: string): Paper[] => {
  const paper = getPaper(paperId)
  if (!paper) return []
  return paper.related_paper_ids
    .map((rid) => getPaper(rid))
    .filter((p): p is Paper => Boolean(p))
}

/* ------------------------------------------------------------------ */
/* 聚合统计                                                            */
/* ------------------------------------------------------------------ */

export const stats = {
  paperCount: kb.papers.length,
  methodCount: kb.methods.length,
  familyCount: kb.families.length,
  evolutionCount: kb.evolutions.length,
  gapCount: kb.gaps.length,
  directionCount: kb.directions.length,
  evidenceCount: kb.evidence.length,
  relationCount: kb.relations.length,
}

/** 方法族分布，用于 Dashboard 环形图 */
export const getFamilyDistribution = () =>
  kb.families.map((f) => ({
    name: f.name_zh,
    nameEn: f.name,
    value: kb.methods.filter((m) => m.family_id === f.family_id).length,
    color: f.color,
    family_id: f.family_id,
  }))

/** 方法范式分布 */
export const getParadigmDistribution = () => {
  const map = new Map<string, number>()
  kb.methods.forEach((m) => map.set(m.paradigm, (map.get(m.paradigm) ?? 0) + 1))
  return [...map.entries()].map(([name, value]) => ({ name, value }))
}

/** 按年份的方法数量，用于演进图 */
export const getMethodsByYear = () => {
  const map = new Map<number, number>()
  kb.methods.forEach((m) => map.set(m.year, (map.get(m.year) ?? 0) + 1))
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, count]) => ({ year: String(year), count }))
}

/** 空白类型分布 */
export const getGapDistribution = () => {
  const labels: Record<string, string> = {
    method: '方法空白',
    data: '数据空白',
    evaluation: '评价空白',
    application: '应用场景空白',
  }
  const map = new Map<string, number>()
  kb.gaps.forEach((g) => map.set(g.type, (map.get(g.type) ?? 0) + 1))
  return Object.keys(labels).map((type) => ({
    type,
    label: labels[type],
    count: map.get(type) ?? 0,
  }))
}

/** 最新分析论文（按年份倒序） */
export const getRecentPapers = (n = 5) =>
  [...kb.papers].sort((a, b) => b.year - a.year).slice(0, n)

/** 全部研究任务选项（按出现论文数降序） */
export const getTaskOptions = () => {
  const map = new Map<string, number>()
  kb.papers.forEach((p) => map.set(p.task, (map.get(p.task) ?? 0) + 1))
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([task]) => task)
}

/** 未被任何方向覆盖的空白（用于提示研究机会） */
export const getUncoveredGaps = () => {
  const covered = new Set(kb.directions.flatMap((d) => d.gap_ids))
  return kb.gaps.filter((g) => !covered.has(g.gap_id))
}
