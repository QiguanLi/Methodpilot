/**
 * 调研报告生成（Phase 4-8）。
 *
 * ── 这个模块回答什么问题 ──
 *
 * 前面六个阶段各自产出了一堆**结构化的中间结论**：
 *   4-3 方法地图 / 4-2 跨论文对齐 / 4-4 技术演进 / 4-6 研究空白 / 4-7 研究方向。
 * 用户真正想要的是把它们**串成一份能读、能引用的调研报告**。
 *
 * ── 本模块与其他模块最本质的区别：它是"编排"，不是"判定" ──
 *
 * 这是本模块唯一的设计原则，也是它最容易出错的地方：
 *
 *   **本模块不产生任何新的事实判断。它只做三件事：
 *     ① 搬运（把上游结论按章节归位）
 *     ② 计数（统计，且统计口径必须与上游一致）
 *     ③ 措辞（把结论写成有出处、分层级的句子）**
 *
 * 为什么这条纪律必须写得这么死：报告是**最终交付物**。前面任何一个模块
 * 出的错，在它自己那一页上都还能被用户对照证据发现；一旦写进报告、
 * 变成一段通顺的话，用户就**没有能力再核查**了。报告是"张冠李戴"
 * 这类错误造成了**最大伤害**的地方 —— 因为它长得最像结论。
 *
 * 所以下面每一条重要结论都必须带 `refs`（回链），且 `kind` 字段显式声明
 * 这条结论的性质。三层分层（与 4-6 / 4-7 同一套语义，刻意不发明新词）：
 *
 *   · `stated_fact`    —— 论文原文这么说。**只有这一层可以用事实口吻。**
 *                          来源：论文元数据、原文证据引文、stated Gap。
 *   · `system_analysis`—— 系统基于证据做的确定性分析（演进关系、对齐判定）。
 *                          措辞必须用"系统判定 / 依据 N 条证据"，
 *                          不能用"研究表明"。
 *   · `system_suggestion` —— 系统的建议（研究方向）。必须带"建议"字样，
 *                          candidate_only 的方向还要保留【推测方向】前缀。
 *
 * ── 缺数据时的行为：写"暂无足够证据"，不补全 ──
 *
 * 这是需求里被反复强调、也是 LLM 最容易违背的一条：给它一个空章节，
 * 它会热心地"帮你补充一段背景介绍"。本模块**不允许**这种补全 ——
 * 每个章节在无数据时产出一条 `status: 'insufficient'` 的显式声明，
 * 文案统一为「暂无足够证据」，并说明**为什么**没有（是语料里就没有，
 * 还是上游没跑）。空章节长这样，用户一眼就知道系统没得出东西，
 * 而不是以为系统漏渲染了。
 *
 * ── 为什么必须是纯函数 ──
 * 与 relevance.ts / methodAlignment.ts / methodEvolution.ts / researchGaps.ts /
 * researchDirections.ts 同一套理由：不读 config、不发请求、不碰文件、
 * 不取当前时间。测试可以直接跑它。
 * 需求也明确要求"Mock 使用 deterministic 规则，不调用 LLM"。
 *
 * ⚠️ 一个具体的纪律：本模块**不接收 `project` 对象**。
 *
 * 看起来把项目名/研究目标传进来、写进报告的"研究主题"章节很自然，
 * 但那会引入一个**无法核验的引用**：`project.goal` 是用户自己填的自由文本，
 * 不是论文里的事实，也不在任何 Evidence 里。把它写进报告的"研究主题"，
 * 报告就出现了第一条**没有出处**的陈述 —— 而这正是本模块要防的事。
 * 所以研究主题只从**语料里真实存在的东西**推出（论文标题 / 关键词 /
 * 方法族 / 场景主题），并在 `basis` 里写明它是怎么推出来的。
 */

import type { StoredEvidence, StoredMethod, StoredPaper } from '../types.ts'
import type { EvolutionOutcome } from './methodEvolution.ts'
import type { GapOutcome, GapAssertionLevel } from './researchGaps.ts'
import { gapSignalLabel, gapThemeLabel } from './researchGaps.ts'
import type { DirectionOutcome, DirectionBasisLevel } from './researchDirections.ts'

/* ------------------------------------------------------------------ */
/* 报告规则版本                                                        */
/* ------------------------------------------------------------------ */

export const REPORT_RULE_VERSION = 'deterministic-research-report-v1'

/**
 * 「没有数据」时的统一文案。
 *
 * 做成常量而不是散落各处的字符串，是为了让测试能一条断言扫全报告：
 * 任何 `status === 'insufficient'` 的段落，正文必须**逐字**是这句话。
 * 这样"系统没得出东西"和"系统得出了但没渲染"在界面上的区别是确定的。
 */
export const INSUFFICIENT_TEXT = '暂无足够证据'

/* ------------------------------------------------------------------ */
/* 分层：事实 / 分析 / 建议                                             */
/* ------------------------------------------------------------------ */

/**
 * 一条陈述的**性质**。这是本模块最重要的字段 —— 比任何内容都重要。
 *
 * 需求原文："明确区分'论文原文事实'和'系统分析/建议'，禁止把推断写成论文事实"。
 * 这个三分法就是它的落地形式。刻意与 4-6 的 `stated|candidate` 和
 * 4-7 的 `stated_backed|mixed|candidate_only` 保持**同一套语义方向**
 * （越靠前越硬），不发明第四套词汇。
 */
export type ReportStatementKind =
  /** 论文原文这么说。**唯一可以用事实口吻的层级** */
  | 'stated_fact'
  /** 系统基于证据的确定性分析。措辞必须是"系统判定" */
  | 'system_analysis'
  /** 系统的建议。措辞必须带"建议"，且不得断言现状 */
  | 'system_suggestion'

export const REPORT_STATEMENT_KINDS: readonly ReportStatementKind[] = [
  'stated_fact',
  'system_analysis',
  'system_suggestion',
] as const

export const isReportStatementKind = (v: unknown): v is ReportStatementKind =>
  typeof v === 'string' && (REPORT_STATEMENT_KINDS as readonly string[]).includes(v)

/** 引用类型。用于回链，也用于"ID 有效性"校验 */
export type ReportRefKind = 'paper' | 'method' | 'evidence' | 'gap' | 'direction' | 'alignment' | 'evolution'

/**
 * 一条回链。
 *
 * `label` 是**给人看的**（"论文 P001《ReAct》"），
 * `id` 是**给机器核的**。两者都要有：
 * 只给 id，用户读报告时看到一串 P001 无从判断；
 * 只给 label，测试无法校验它是否真的存在于语料里。
 */
export interface ReportRef {
  kind: ReportRefKind
  id: string
  label: string
}

/**
 * 报告里的一条陈述。
 *
 * `kind` + `refs` 的组合就是"不把推断写成事实"的机械保证：
 *   · `kind === 'stated_fact'`  ⇒ refs 里必须至少有一条 stated 级来源
 *     （证据引文 / stated Gap / 论文元数据），由不变量校验；
 *   · 任何 `system_*` 的 statement，其正文不得出现事实断言口吻词。
 */
export interface ReportStatement {
  kind: ReportStatementKind
  text: string
  refs: ReportRef[]
}

/**
 * 一个章节。
 *
 * `status` 三态，刻意区分开（这是需求"没有对应数据时必须写暂无足够证据"的落点）：
 *   · `ok`           —— 有数据，statements 非空
 *   · `insufficient` —— 上游给了空输入。statements **恰好一条**，正文为
 *                       INSUFFICIENT_TEXT，且 kind 为 system_analysis
 *                       （"语料里没有"是系统的观察，不是论文的事实）
 *   · `partial`      —— 有数据但**明显不全**（如方法全部未分类、
 *                       演进有未知年份）。内容照常给，但附一条 limitation 说明。
 *
 * 为什么不把 partial 并进 ok：报告里"我们知道的部分"和"我们不知道的部分"
 * 必须能分开读到，否则用户会把"系统没覆盖"误解成"领域里没有"。
 */
export interface ReportSection {
  section_id: string
  title: string
  status: 'ok' | 'insufficient' | 'partial'
  /** 这一章依据了多少条上游实体。给用户一个"饱满度"的直观感受 */
  source_counts: Record<string, number>
  statements: ReportStatement[]
  /** 这一章**没能覆盖**什么。status=partial/insufficient 时必须有 */
  limitations: string[]
}

/* ------------------------------------------------------------------ */
/* 输入                                                                */
/* ------------------------------------------------------------------ */

/**
 * 报告输入 —— **全部是上游模块的产出，本模块自己不算任何东西**。
 *
 * ⚠️ 为什么是"整个 Outcome"而不是"只要数组"：
 *
 * 4-4 / 4-6 / 4-7 的 Outcome 里带着 `stats` 与 `context`。报告需要用到它们
 * （比如"0 条方向是因为语料里没有 Gap"这个判断，必须靠 4-7 的
 * `context.has_any_gap`，而不是靠"directions.length === 0"去猜）。
 *
 * ⚠️ 但**统计绝不复算**：报告里的每个数字都直接引用上游 stats。
 * 自己重数一遍是"两套口径"的开始 —— 4-6 的 summarizeGaps 注释里
 * 记录过一次真实事故（两份实现漂移，测试抓到），这里不重犯。
 */
export interface ReportInput {
  papers: StoredPaper[]
  methods: StoredMethod[]
  evidence: StoredEvidence[]
  /** 4-2 的对齐产出 */
  alignment: AlignmentOutcome
  /** 4-4 的演进产出 */
  evolution: EvolutionOutcome
  /** 4-6 的空白产出 */
  gaps: GapOutcome
  /** 4-7 的方向产出 */
  directions: DirectionOutcome
}

/* ------------------------------------------------------------------ */
/* 输出：报告总包                                                       */
/* ------------------------------------------------------------------ */

/**
 * 报告的一级章节 id。
 *
 * 顺序即报告阅读顺序，也是目录顺序 —— 与需求列的七块**逐项对应**：
 *   研究主题 / 文献概览 / 方法分类 / 技术演进 / 研究空白 / 研究方向 / Evidence 索引
 */
export const REPORT_SECTION_IDS = [
  'topic',
  'literature',
  'methods',
  'evolution',
  'gaps',
  'directions',
  'evidence_index',
] as const

export type ReportSectionId = (typeof REPORT_SECTION_IDS)[number]

/** 报告头部的分层摘要 —— 让用户 3 秒内知道这份报告"有多少是事实、多少是猜测" */
export interface ReportLayeringSummary {
  /** stated_fact 级陈述数 */
  stated_fact: number
  /** system_analysis 级陈述数 */
  system_analysis: number
  /** system_suggestion 级陈述数 */
  system_suggestion: number
  /** 全部陈述数 */
  total_statements: number
  /** 全部回链数 */
  total_refs: number
  /** 空章节数（正文为「暂无足够证据」的章节） */
  insufficient_sections: number
  /** 带局限性说明的章节数 */
  partial_sections: number
}

export interface ResearchReport {
  /** 稳定 id，形如 RP001。同一输入必须产出同一 id（确定性） */
  report_id: string
  /** 报告标题。由语料推出，**不是** project.goal 的直接复制（见模块头注释） */
  title: string
  /** 一句话交代这份报告的范围与依据 */
  scope_note: string
  /** 研究主题 / 研究问题 */
  topic: ResearchTopicBlock
  sections: ReportSection[]
  /** Evidence 索引 —— 报告里出现的所有证据，按 id 排序，逐条可查 */
  evidence_index: EvidenceIndexEntry[]
  /** 分层摘要 */
  layering: ReportLayeringSummary
  /**
   * 方法分类的全局计数，**与 `sections[methods].source_counts` 是同一份数据**。
   *
   * 为什么在顶层再放一份：方法分类的"已分类 / 未分类"是一个**全局属性**
   * （它描述的是分类阶段跑没跑、跑得怎么样），不只属于"方法分类"这一章 ——
   * 报告头部的饱满度摘要也要用它。放顶层便于 `reportStatConsistency` 独立对账，
   * 也让前端不必先去 sections 里找章节才能读到它。
   */
  methods_source_counts: Record<string, number>
  /** 报告没法覆盖什么。**恒非空** —— 再完整的一份报告也有边界 */
  global_limitations: string[]
  /** 规则集版本，便于溯源。标明是确定性规则，不让人误以为是模型产出 */
  rule_version: string
}

/**
 * 研究主题 / 研究问题。
 *
 * ⚠️ 这里**不是**"综述式引言"。综述需要读遍领域文献，而我们只有本项目的
 * 论文池。用规则硬凑一段引言，产出的一定是看起来很学术、实际没有出处的套话。
 * 所以这里只如实回答三个可核验的问题：
 *   ① 这批论文在谈什么（关键词频次 + 方法族 + 场景主题）
 *   ② 这批论文自己提出了什么问题（论文标题/摘要里的问题句，**原文**）
 *   ③ 系统据此把研究问题形式化成什么（明确的系统分析）
 */
export interface ResearchTopicBlock {
  /** 语料里出现的关键词，按频次降序，**每个都带回链** */
  keywords: { term: string; count: number; refs: ReportRef[] }[]
  /** 研究场景主题（来自 4-6 的确定性词表，只透传不重算） */
  themes: { theme: string; label: string; gap_count: number }[]
  /** 方法族分布（来自 4-3 的分类产出，只透传） */
  families: { family_id: string; count: number; method_names: string[] }[]
  /** 系统形式化的研究问题（system_analysis） */
  research_questions: ReportStatement[]
  /** 这一块没能覆盖什么 */
  limitations: string[]
}

/** Evidence 索引的一条。报告里**所有** evidence 引用都必须能在这里查到 */
export interface EvidenceIndexEntry {
  evidence_id: string
  paper_id: string
  /** 论文标题，便于在索引里直接读 */
  paper_title: string
  section: string
  page: number
  /** 英文原文（一句话，可能被截断以便阅读，全文见证据抽屉） */
  quote: string
  translation: string
  /** 被哪些章节引用。空数组 = 已登记但未被任何结论使用（如实标注，不隐藏） */
  cited_by: ReportSectionId[]
  /** 被哪些 Gap / Direction 引用 */
  gap_ids: string[]
  direction_ids: string[]
}

/* ------------------------------------------------------------------ */
/* 词表                                                                */
/* ------------------------------------------------------------------ */

/**
 * 事实断言口吻词表 —— 用于**反向校验**非 stated_fact 级陈述的文案。
 *
 * 与 4-7 的 `FACTUAL_ASSERTION_PATTERNS` 同一思路，但**刻意不复用那个常量**：
 * 4-7 那份是模块私有不导出，而且它的适用对象是"方向描述"，
 * 本模块的适用对象是"报告陈述"。两边的文案模板完全不同，
 * 共用一份会让将来任一边调整词表时意外改变另一边的行为。
 * 词表**打头的那几条保持一致**（"研究表明""普遍认为"），
 * 保证"事实口吻"在全项目只有一个定义。
 *
 * ⚠️ 逐条踩过的坑，记在这里免得后人重蹈：
 *
 *   1. **`〔论文(明确)?指出〕必须限定"主语是论文"`。**
 *      最初的写法是 `/论文\s*\S*\s*(?:明确)?指出/`，它在
 *      「研究空白」章节上误报 —— 因为 4-6 的 Gap 描述里有一句
 *      「…的原文明确声明与…的关系」，被 `\S*` 吃掉了"的原文明确"。
 *      更要命的是它同时**漏报**：`/论文\S*指出/` 匹配不到
 *      「论文明确指出」以外的合法事实句，也匹配不到"该论文指出"。
 *      改用"右边界锚定"（指出后面必须是非汉字字符）后，
 *      既能匹配"论文指出/论文明确指出/该论文指出"，
 *      又不会把"…的原文明确声明…"这种**引用来源描述**误判成断言。
 *
 *   2. **不能把"依据"类词一律当事实口吻。**
 *      `系统判定 X 继承并扩展 Y…判定依据：…` 里的"依据"是**引用**上游结论，
 *      不是在陈述世界状态。真正要拦的是"研究表明""已被证明"
 *      这类**无出处的领域断言**，而不是"依据本项目的 N 条证据"。
 *
 *   3. **时间性的领域断言**（"近年来…"）与**存在性的领域断言**
 *      （"该领域尚无…"）也要拦。报告只能陈述本项目语料里有什么，
 *      不能陈述领域里有什么 —— 后者需要外部检索，我们没做。
 */
const FACTUAL_ASSERTION_PATTERNS: RegExp[] = [
  /* ① "论文指出…" —— 主语必须是论文，右边接非汉字（见上面第 1 条） */
  /(?:论文|文献|作者)\s*(?:明确)?指出(?=[^\u4e00-\u9fa5]|$)/,
  /* ② 无出处的领域断言（被证明 / 研究表明 / 数据表明…） */
  /(?:研究表明|实验结果?表明|结果证明|已被证明|调查研究|数据显示)/,
  /已有\s*(?:研究|工作|文献)\s*(?:证明|表明|显示)/,
  /(?:普遍认为|广泛认为|众所周知|界内\s*(?:公认|共识))/,
  /* ③ 时间性领域断言 —— 需要外部检索才能成立，本报告没做 */
  /(?:近年|近些年来|最近几年|随着[^，。]{0,12}的(?:发展|兴起|普及)|当前(?:学界|领域)|学术界)/,
  /* ④ 存在性领域断言 —— "该领域没有 X"是外部结论，我们只能说"本语料里没有" */
  /(?:该|本|这一)?\s*(?:研究)?领域\s*(?:尚|仍|还)?\s*(?:无|没有|缺乏|未见|尚无)/,
]

/**
 * 系统分析/建议的**开场白词**。
 *
 * 反向校验用：任何 `system_analysis` / `system_suggestion` 的陈述，
 * 必须包含其中之一，否则说明它没有"这是系统说的"这一层标记 ——
 * 读起来和论文事实无从区分。
 */
const ANALYSIS_MARKERS = /系统|依据本项目的|本项目语料|判定|统计/
const SUGGESTION_MARKERS = /建议|可考虑|可以尝试|值得探索|探索|候选/

/** 场景主题中文名。与 4-6 的 THEME_LABEL 口径一致（4-6 已导出 gapThemeLabel） */

/** 方法族中文名。与 4-3 的族定义一致；表外的族如实回显 id */
const FAMILY_LABEL: Record<string, string> = {
  F1: '提示与推理链',
  F2: '工具与环境交互',
  F3: '规划与反思',
  F4: '记忆与检索增强',
  F5: '多智能体协作',
}

const familyLabelOf = (id: string): string => FAMILY_LABEL[id] ?? id

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)

/** 去重后排序，用于任何"id 列表"的规整 */
const sortedUnique = (xs: string[]): string[] => [...new Set(xs)].sort()

/** 截断到 n 个字符，超出加省略号。用于索引里展示引文 */
function clip(s: string, n: number): string {
  const t = (s ?? '').trim().replace(/\s+/g, ' ')
  return t.length <= n ? t : `${t.slice(0, n)}…`
}

/** 构造一条回链 */
const ref = (kind: ReportRefKind, id: string, label: string): ReportRef => ({ kind, id, label })

/* ------------------------------------------------------------------ */
/* 语料索引                                                            */
/* ------------------------------------------------------------------ */

interface Corpus {
  paperById: Map<string, StoredPaper>
  methodById: Map<string, StoredMethod>
  evidenceById: Map<string, StoredEvidence>
  gapById: Map<string, GapOutcome['gaps'][number]>
  directionById: Map<string, DirectionOutcome['directions'][number]>
}

function buildCorpus(input: ReportInput): Corpus {
  return {
    paperById: new Map(input.papers.map((p) => [p.paper_id, p])),
    methodById: new Map(input.methods.map((m) => [m.method_id, m])),
    evidenceById: new Map(input.evidence.map((e) => [e.evidence_id, e])),
    gapById: new Map(input.gaps.gaps.map((g) => [g.gap_id, g])),
    directionById: new Map(input.directions.directions.map((d) => [d.direction_id, d])),
  }
}

/** 论文的显示名：标题为空时如实回退到文件名/id，不编一个标题 */
const paperLabel = (p: StoredPaper | undefined, id: string): string => {
  if (!p) return `论文 ${id}（未在本项目论文库中找到）`
  const t = (p.title ?? '').trim()
  const year = p.year > 0 ? `，${p.year}` : ''
  return t ? `论文 ${id}《${t}》${year}` : `论文 ${id}（原文未提供标题）`
}

const methodLabel = (m: StoredMethod | undefined, id: string): string => {
  if (!m) return `方法 ${id}（未在本项目方法库中找到）`
  const n = (m.name_zh || m.name || '').trim()
  const year = m.year > 0 ? `，${m.year}` : ''
  return n ? `方法 ${id}「${n}」${year}` : `方法 ${id}（原文未提供方法名）`
}

/* ------------------------------------------------------------------ */
/* ① 研究主题 / 研究问题                                                */
/* ------------------------------------------------------------------ */

/**
 * 关键词频次。
 *
 * ⚠️ **只统计论文自己声明的关键词**（`paper.keywords`），不从标题里切词。
 *
 * 为什么不做标题分词：中文标题分词要词典，英文标题分词要停用词表，
 * 任何一套都会产出"基于""方法"这类无意义的高频词，然后被报告当成主题。
 * 那样的主题词**没有出处** —— 用户无法核实"这个词是从哪来的"。
 * 论文自带的关键词是作者自己写的，每个都能回链到具体论文，这是可核验的。
 * 代价是覆盖率低（很多论文不给 keywords），此时如实报告"关键词不足"。
 */
function buildKeywords(input: ReportInput, corpus: Corpus) {
  const byTerm = new Map<string, { count: number; paperIds: string[] }>()
  for (const p of input.papers) {
    for (const raw of p.keywords ?? []) {
      const term = (raw ?? '').trim()
      if (!term) continue
      const e = byTerm.get(term) ?? { count: 0, paperIds: [] }
      e.count++
      e.paperIds.push(p.paper_id)
      byTerm.set(term, e)
    }
  }
  return [...byTerm.entries()]
    .map(([term, e]) => ({
      term,
      count: e.count,
      /* 同一个词被同一篇论文写两次只算一次引用 */
      refs: sortedUnique(e.paperIds).map((pid) => ref('paper', pid, paperLabel(corpus.paperById.get(pid), pid))),
    }))
    /* 频次降序 → 词条字典序。第二键必须有，否则同频词的顺序依赖输入顺序 */
    .sort((a, b) => b.count - a.count || cmp(a.term, b.term))
    /* 只保留出现 ≥2 次的词：出现 1 次的词不构成"这批论文在谈什么" */
    .filter((k) => k.count >= 2)
}

/** 场景主题分布。**直接引用 4-6 的 gap.theme / gaps.stats**，不重新提取 */
function buildThemes(input: ReportInput) {
  const byTheme = new Map<string, number>()
  for (const g of input.gaps.gaps) {
    byTheme.set(g.theme, (byTheme.get(g.theme) ?? 0) + 1)
  }
  return [...byTheme.entries()]
    .map(([theme, gap_count]) => ({ theme, label: gapThemeLabel(theme), gap_count }))
    .sort((a, b) => b.gap_count - a.gap_count || cmp(a.theme, b.theme))
}

/** 方法族分布。**直接读 method.family_id**，不重跑分类 */
function buildFamilies(input: ReportInput) {
  const byFamily = new Map<string, string[]>()
  for (const m of input.methods) {
    const fid = m.family_id ?? ''
    if (!fid) continue /* '' 是"未分类"哨兵，单独统计，不混进族分布 */
    const arr = byFamily.get(fid) ?? []
    arr.push(m.name_zh || m.name || m.method_id)
    byFamily.set(fid, arr)
  }
  return [...byFamily.entries()]
    .map(([family_id, names]) => ({
      family_id,
      count: names.length,
      method_names: names.slice().sort(),
    }))
    .sort((a, b) => b.count - a.count || cmp(a.family_id, b.family_id))
}

/**
 * 从论文标题/摘要里提取**原文自带的问题句**。
 *
 * 这是研究问题章节里唯一允许说事实口吻的来源 —— 因为它是原文。
 * 判据是句尾问号，而不是"我们认为这是问题"。
 */
function explicitResearchQuestions(papers: StoredPaper[]): { text: string; paper: StoredPaper }[] {
  const out: { text: string; paper: StoredPaper }[] = []
  for (const p of [...papers].sort((a, b) => cmp(a.paper_id, b.paper_id))) {
    const hay = `${p.title ?? ''} ${p.abstract ?? ''}`
    /* 按句末标点切句，保留问句 */
    for (const s of hay.split(/(?<=[?？。.!！;；])\s*/)) {
      const t = s.trim()
      if (!/[?？]$/.test(t)) continue
      if (t.length < 8 || t.length > 300) continue
      out.push({ text: t, paper: p })
      break /* 每篇论文最多取一句，避免摘要里连串问句灌满报告 */
    }
  }
  return out
}

function buildTopic(input: ReportInput, corpus: Corpus): ResearchTopicBlock {
  const keywords = buildKeywords(input, corpus)
  const themes = buildThemes(input)
  const families = buildFamilies(input)
  const limitations: string[] = []

  const statements: ReportStatement[] = []

  /* ── 原文自带的问题句 → stated_fact（唯一可以说事实口吻的地方）── */
  const explicit = explicitResearchQuestions(input.papers)
  for (const e of explicit.slice(0, 5)) {
    statements.push({
      kind: 'stated_fact',
      text: `${paperLabel(e.paper, e.paper.paper_id)} 在原文中提出了这个问题：「${clip(e.text, 160)}」`,
      refs: [ref('paper', e.paper.paper_id, paperLabel(e.paper, e.paper.paper_id))],
    })
  }
  if (!explicit.length) {
    limitations.push('论文库中没有任何论文在标题或摘要里以问句形式陈述研究问题')
  }

  /* ── 系统形式化的研究问题 → system_analysis ── */
  /*
   * 措辞纪律：以"依据本项目的 N 篇论文"开头，用"系统把…形式化为"，
   * 绝不写"该领域的研究问题是…"。后者是在陈述领域现状，而我们只看过这几篇论文。
   */
  const paperCount = input.papers.length
  if (paperCount > 0) {
    const kwTop = keywords.slice(0, 3).map((k) => k.term)
    const themeTop = themes.filter((t) => t.theme !== 'general').slice(0, 3).map((t) => t.label)
    const famTop = families.slice(0, 3).map((f) => familyLabelOf(f.family_id))

    const bits: string[] = []
    if (kwTop.length) bits.push(`高频关键词为 ${kwTop.map((t) => `「${t}」`).join('、')}`)
    if (themeTop.length) bits.push(`场景集中在 ${themeTop.join('、')}`)
    if (famTop.length) bits.push(`方法主要落在 ${famTop.join('、')} 三类方法族`)

    if (bits.length) {
      statements.push({
        kind: 'system_analysis',
        text:
          `系统依据本项目的 ${paperCount} 篇论文统计，${bits.join('，')}。` +
          `据此把本项目的研究问题形式化为：在这些场景下推动上述方法族的进一步工作。` +
          `该形式化是系统对语料的归纳，不是任何单篇论文的结论。`,
        refs: [
          ...keywords.slice(0, 3).flatMap((k) => k.refs),
          /*
           * ⚠️ 必须用**排序后**的论文列表，不能用 `input.papers`。
           *
           * 这里踩过一次：直接 map 原数组时，refs 的顺序跟着**输入顺序**走，
           * 于是"乱序输入 ⇒ 报告一致"的断言失败，而失败点藏在一长串
           * `paper:P00x` 的中间 —— 极难发现，因为前面的内容全都一致。
           * 报告的任何输出都必须是内容的纯函数，包括 refs 的**排列**。
           */
          ...[...input.papers]
            .sort((a, b) => cmp(a.paper_id, b.paper_id))
            .map((p) => ref('paper', p.paper_id, paperLabel(p, p.paper_id))),
        ],
      })
    } else {
      limitations.push(
        '论文库既没有重复出现的关键词，也没有可归入场景主题的缺口，系统无法据此形式化研究问题',
      )
    }
  }

  return { keywords, themes, families, research_questions: statements, limitations }
}

/* ------------------------------------------------------------------ */
/* ② 文献概览                                                          */
/* ------------------------------------------------------------------ */

function buildLiterature(input: ReportInput): ReportSection {
  const section_id: ReportSectionId = 'literature'
  const title = '文献概览'
  const source_counts = {
    papers: input.papers.length,
    methods: input.methods.length,
    evidence: input.evidence.length,
  }

  if (!input.papers.length) {
    return {
      section_id,
      title,
      status: 'insufficient',
      source_counts,
      statements: [{ kind: 'system_analysis', text: INSUFFICIENT_TEXT, refs: [] }],
      limitations: ['项目论文库为空，无法生成文献概览'],
    }
  }

  const statements: ReportStatement[] = []
  const limitations: string[] = []

  /* ── 逐篇：元数据全部来自论文对象本身（stated_fact 的合法来源）── */
  const papers = [...input.papers].sort(
    (a, b) => (a.year || 0) - (b.year || 0) || cmp(a.paper_id, b.paper_id),
  )

  for (const p of papers) {
    const t = (p.title ?? '').trim()
    const evCount = input.evidence.filter((e) => e.paper_id === p.paper_id).length
    const mkCount = input.methods.filter((m) => (m.paper_ids ?? []).includes(p.paper_id)).length

    if (!t) {
      /*
       * 没有标题的论文 —— 这是真实存在的（只录了元数据、PDF 未解析）。
       * 如实说明，**不给它编一个标题**。用户会看到"未提供标题"，
       * 从而知道这篇论文在报告里是残缺的。
       */
      statements.push({
        kind: 'stated_fact',
        text: `${paperLabel(p, p.paper_id)} 未提供标题（仅登记了元数据），报告无法给出该论文的内容概览。`,
        refs: [ref('paper', p.paper_id, paperLabel(p, p.paper_id))],
      })
      limitations.push(`论文 ${p.paper_id} 缺少标题，其内容未进入报告`)
      continue
    }

    statements.push({
      kind: 'stated_fact',
      text:
        `${paperLabel(p, p.paper_id)}：` +
        `${p.authors?.length ? `作者 ${p.authors.slice(0, 3).join('、')}${p.authors.length > 3 ? ' 等' : ''}，` : ''}` +
        `系统从该论文抽取到 ${mkCount} 个方法、${evCount} 条证据。` +
        (p.abstract?.trim() ? `摘要原文摘录：「${clip(p.abstract, 180)}」` : '该论文未提供摘要。'),
      refs: [
        ref('paper', p.paper_id, paperLabel(p, p.paper_id)),
        ...input.methods
          .filter((m) => (m.paper_ids ?? []).includes(p.paper_id))
          .map((m) => ref('method', m.method_id, methodLabel(m, m.method_id))),
      ],
    })
  }

  /* ── 年份跨度：只有 ≥2 篇且有年份时才有意义 ── */
  const knownYears = papers.map((p) => p.year).filter((y) => y > 0)
  if (knownYears.length >= 2) {
    const min = Math.min(...knownYears)
    const max = Math.max(...knownYears)
    statements.push({
      kind: 'system_analysis',
      text:
        `依据本项目的 ${papers.length} 篇论文统计，有明确年份的共 ${knownYears.length} 篇，` +
        `跨度 ${min}–${max} 年（系统按年份升序排列，同年按论文 id 排序）。`,
      refs: papers.filter((p) => p.year > 0).map((p) => ref('paper', p.paper_id, paperLabel(p, p.paper_id))),
    })
  }
  const unknownYear = papers.filter((p) => !(p.year > 0)).length
  if (unknownYear > 0) {
    limitations.push(
      `有 ${unknownYear} 篇论文缺少年份，它们在文献概览中按"年份不可知"排在最后，` +
        `涉及时间的结论对其不适用`,
    )
  }

  return {
    section_id,
    title,
    status: limitations.length ? 'partial' : 'ok',
    source_counts,
    statements,
    limitations,
  }
}

/* ------------------------------------------------------------------ */
/* ③ 方法分类                                                          */
/* ------------------------------------------------------------------ */

function buildMethods(input: ReportInput, corpus: Corpus): ReportSection {
  const section_id: ReportSectionId = 'methods'
  const title = '方法分类'
  const families = buildFamilies(input)
  const source_counts = {
    methods: input.methods.length,
    classified: input.methods.filter((m) => (m.family_id ?? '').length > 0).length,
    unclassified: input.methods.filter((m) => !(m.family_id ?? '').length).length,
    alignments: input.alignment.candidates.length,
  }

  if (!input.methods.length) {
    return {
      section_id,
      title,
      status: 'insufficient',
      source_counts,
      statements: [{ kind: 'system_analysis', text: INSUFFICIENT_TEXT, refs: [] }],
      limitations: ['项目方法库为空，无法生成方法分类'],
    }
  }

  const statements: ReportStatement[] = []
  const limitations: string[] = []

  /* ── 族分布 —— 分类结果来自 4-3，本模块只搬运 ── */
  for (const f of families) {
    statements.push({
      kind: 'system_analysis',
      text:
        `系统依据本项目的分类结果统计，方法族 ${f.family_id}（${familyLabelOf(f.family_id)}）` +
        `下共有 ${f.count} 个方法：${f.method_names.map((n) => `「${n}」`).join('、')}。` +
        `该归类来自方法分类阶段，每个方法都带有当时的分类依据与证据。`,
      refs: input.methods
        .filter((m) => m.family_id === f.family_id)
        .map((m) => ref('method', m.method_id, methodLabel(m, m.method_id))),
    })
  }

  /* ── 未分类 —— 必须显式报告，不能因为"凑不成族"就静默丢掉 ── */
  const unclassified = input.methods.filter((m) => !(m.family_id ?? '').length)
  if (unclassified.length) {
    statements.push({
      kind: 'system_analysis',
      text:
        `系统统计到本项目的 ${unclassified.length} 个方法**未被归入任何方法族**：` +
        `${unclassified.map((m) => `「${m.name_zh || m.name || m.method_id}」`).join('、')}。` +
        `未分类有两种成因（分类未运行 / 分类运行但判定不可靠），报告无法替它们补一个族。`,
      refs: unclassified.map((m) => ref('method', m.method_id, methodLabel(m, m.method_id))),
    })
    limitations.push(`有 ${unclassified.length} 个方法未分类，方法分类章节未覆盖它们`)
  }

  /* ── 跨论文对齐 —— 这是"同一方法被多篇论文提到"的唯一依据 ── */
  const strong = input.alignment.candidates.filter(
    (c) => c.relation_type === 'same' || c.relation_type === 'alias',
  )
  if (strong.length) {
    for (const c of strong) {
      const a = methodLabel(corpus.methodById.get(c.source.method_id), c.source.method_id)
      const b = methodLabel(corpus.methodById.get(c.target.method_id), c.target.method_id)
      statements.push({
        kind: 'system_analysis',
        text:
          `系统判定 ${a} 与 ${b} 是**同一方法**（对齐类型 ${c.relation_type}，置信度 ${c.confidence}）。` +
          `判定依据：${c.reason}。` +
          (c.hasDirectEvidence
            ? `该判定达到实质证据门槛，双方各自挂有可核验的原文证据。`
            : `⚠️ 该判定**未**达到实质证据门槛，仅由名称等弱信号支撑，请谨慎采信。`),
        refs: [
          ref('alignment', c.alignment_id, `对齐关系 ${c.alignment_id}`),
          ref('method', c.source.method_id, a),
          ref('method', c.target.method_id, b),
          ...c.evidence_ids
            .map((eid) => corpus.evidenceById.get(eid))
            .filter((e): e is StoredEvidence => Boolean(e))
            .map((e) => ref('evidence', e.evidence_id, `证据 ${e.evidence_id}（论文 ${e.paper_id} 第 ${e.page} 页）`)),
        ],
      })
    }
  } else {
    const weak = input.alignment.candidates.length
    statements.push({
      kind: 'system_analysis',
      text:
        weak > 0
          ? `系统在本项目 ${input.methods.length} 个方法中比对了 ${input.alignment.compared} 个方法对，` +
            `共产出 ${weak} 条候选对齐关系，但**没有一条**达到"同一方法"的证据门槛，` +
            `因此报告不能断言任何两个方法其实是同一个。`
          : /* 0 条候选 —— 仍是系统分析，必须带"系统"标记（不变量第 5 条） */
            `系统在本项目 ${input.methods.length} 个方法中比对了 ${input.alignment.compared} 个方法对，` +
            `未产出任何对齐候选：${INSUFFICIENT_TEXT}。` +
            `这不表示这些方法之间没有关系，只表示现有语料不足以让系统下判断。`,
      refs: [],
    })
    if (weak > 0) {
      limitations.push(
        `存在 ${weak} 条未达门槛的对齐候选（related/uncertain），` +
          `报告未把它们写成"同一方法"，需要时请在方法地图中逐条复核`,
      )
    }
  }

  /* ── 对齐阶段被跳过的量：如实报告，否则用户会以为比对是全覆盖的 ── */
  if (input.alignment.skippedSamePaper > 0 || input.alignment.skippedNoPaper > 0) {
    limitations.push(
      `跨论文对齐跳过 ${input.alignment.skippedSamePaper} 个同论文方法对（同论文内不判对齐）、` +
        `${input.alignment.skippedNoPaper} 个缺论文归属的方法`,
    )
  }

  return {
    section_id,
    title,
    status: limitations.length ? 'partial' : 'ok',
    source_counts,
    statements,
    limitations,
  }
}

/* ------------------------------------------------------------------ */
/* ④ 技术演进                                                          */
/* ------------------------------------------------------------------ */

const EVOLUTION_CAUSAL_LABEL: Record<string, string> = {
  extends: '继承并扩展',
  improves: '改进',
  replaces: '替代',
  combines: '组合',
}

const EVOLUTION_NON_CAUSAL_LABEL: Record<string, string> = {
  temporal: '时间上更晚（无因果证据）',
  parallel: '同期并行（无因果证据）',
  related: '相关（无因果证据）',
}

function buildEvolutionSection(input: ReportInput, corpus: Corpus): ReportSection {
  const section_id: ReportSectionId = 'evolution'
  const title = '技术演进'
  const es = input.evolution.stats
  const source_counts = {
    evolutions: input.evolution.evolutions.length,
    relations: input.evolution.relations.length,
    causal: es.causal_total,
    non_causal: es.non_causal_total,
  }

  if (!input.evolution.evolutions.length) {
    return {
      section_id,
      title,
      status: 'insufficient',
      source_counts,
      statements: [{ kind: 'system_analysis', text: INSUFFICIENT_TEXT, refs: [] }],
      limitations: [
        '本项目没有可构成演进链的方法（方法数不足 2 个，或方法缺少年份/论文归属）',
      ],
    }
  }

  const statements: ReportStatement[] = []
  const limitations: string[] = []

  /* ── 演进链（节点按 chain 顺序，已是上游排好的确定性顺序）── */
  const chain = input.evolution.evolutions.map((n) => `${n.year > 0 ? n.year : '年份未知'}·${n.method_id}`)
  statements.push({
    kind: 'system_analysis',
    text:
      `系统依据本项目的 ${input.methods.length} 个方法排出 ${input.evolution.evolutions.length} 个演进阶段：` +
      `${chain.join(' → ')}。` +
      `阶段顺序由年份决定（年份不可知的排在最后），**不是**本报告对领域发展史的判断。`,
    refs: input.evolution.evolutions.map((n) =>
      ref('method', n.method_id, methodLabel(corpus.methodById.get(n.method_id), n.method_id)),
    ),
  })

  /* ── 因果边 —— 报告里最"像结论"的东西，必须逐条给证据 ── */
  const causal = input.evolution.relations.filter((r) => r.causal)
  if (causal.length) {
    for (const r of causal) {
      const later = methodLabel(corpus.methodById.get(r.source_method), r.source_method)
      const earlier = methodLabel(corpus.methodById.get(r.target_method), r.target_method)
      statements.push({
        kind: 'system_analysis',
        text:
          `系统判定 ${later} **${EVOLUTION_CAUSAL_LABEL[r.relation_type] ?? r.relation_type}** ${earlier}` +
          `（置信度 ${r.confidence}）。判定依据：${r.description}。该判定经过"原文因果句式 + ` +
          `点名前驱方法 + 证据归属校验"三重门槛，可逐条回链原文。`,
        refs: [
          ref('evolution', r.relation_id, `演进关系 ${r.relation_id}`),
          ref('method', r.source_method, later),
          ref('method', r.target_method, earlier),
          ...r.evidence_ids
            .map((eid) => corpus.evidenceById.get(eid))
            .filter((e): e is StoredEvidence => Boolean(e))
            .map((e) => ref('evidence', e.evidence_id, `证据 ${e.evidence_id}（论文 ${e.paper_id} 第 ${e.page} 页）`)),
        ],
      })
    }
  } else {
    /*
     * **0 条因果不等于"没有演进"。** 这是本模块最需要小心的一处措辞：
     * 很容易写成"这些方法之间没有继承关系"，那是在陈述领域事实。
     * 我们只能陈述"系统没找到证据"。
     */
    statements.push({
      kind: 'system_analysis',
      text:
        `系统未在本项目语料中找到**任何**有原文证据支撑的因果关系` +
        `（因果边 0 条）。这表示现有证据不足以支持"谁改进了谁"的判断，` +
        `**不表示**这些方法之间确实相互独立。`,
      refs: [],
    })
    limitations.push('技术演进章节只有时间顺序，没有因果结论 —— 证据不足以判定继承/改进/替代/组合')
  }

  /* ── 非因果边：单独成段，绝不与因果混写 ── */
  const nonCausal = input.evolution.relations.filter((r) => !r.causal)
  if (nonCausal.length) {
    const byType = new Map<string, number>()
    for (const r of nonCausal) byType.set(r.relation_type, (byType.get(r.relation_type) ?? 0) + 1)
    statements.push({
      kind: 'system_analysis',
      text:
        `另有 ${nonCausal.length} 条关系**没有因果证据**，系统只按时间/文本特征记录为：` +
        `${[...byType.entries()]
          .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
          .map(([t, n]) => `${EVOLUTION_NON_CAUSAL_LABEL[t] ?? t} ${n} 条`)
          .join('、')}。` +
        `这些关系**不构成**"谁改进谁"的结论。`,
      refs: nonCausal.map((r) => ref('evolution', r.relation_id, `演进关系 ${r.relation_id}`)),
    })
    limitations.push(
      `${nonCausal.length} 条关系仅有时间先后、无因果证据，报告中已与因果结论分开列出`,
    )
  }

  /*
   * causal_without_evidence 恒为 0 —— 这是 4-4 的硬不变量。
   * 报告里也检查一次：一旦不为 0，说明上游数据自证不可信，必须显式告诉用户，
   * 而不是照样把它写成结论。
   */
  if (es.causal_without_evidence !== 0) {
    limitations.push(
      `⚠️ 上游演进统计的 causal_without_evidence=${es.causal_without_evidence}（应为 0），` +
        `本报告的技术演进结论不可采信`,
    )
  }
  if (es.unknown_year > 0) {
    limitations.push(`${es.unknown_year} 个阶段的年份不可知，其时间先后无法确立`)
  }

  return {
    section_id,
    title,
    status: limitations.length ? 'partial' : 'ok',
    source_counts,
    statements,
    limitations,
  }
}

/* ------------------------------------------------------------------ */
/* ⑤ 研究空白                                                          */
/* ------------------------------------------------------------------ */

const GAP_LEVEL_LABEL: Record<GapAssertionLevel, string> = {
  stated: '论文原文明确指出',
  candidate: '系统跨论文推断（候选）',
}

function buildGapsSection(input: ReportInput, corpus: Corpus): ReportSection {
  const section_id: ReportSectionId = 'gaps'
  const title = '研究空白'
  const gs = input.gaps.stats
  const source_counts = {
    gaps: gs.total,
    stated: gs.stated,
    candidate: gs.candidate,
    papers_involved: gs.papers_involved,
  }

  if (!input.gaps.gaps.length) {
    /*
     * 0 Gap 有两种成因，必须分开说：
     *   · 语料里压根没有带缺口意图的证据 → 预期结果
     *   · 有线索但不足以升成 Gap       → 系统看见了但没下结论
     * 文案由 `context.corpus_has_gap_intent` / `stats.single_paper_signals` 决定，
     * 不能让用户自己去猜"是没找还是没找着"。
     */
    const hasIntent = input.gaps.context.corpus_has_gap_intent
    const singles = gs.single_paper_signals
    return {
      section_id,
      title,
      status: 'insufficient',
      source_counts,
      statements: [
        {
          kind: 'system_analysis',
          text:
            `${INSUFFICIENT_TEXT}。系统在本项目语料中未产出任何研究空白。` +
            (hasIntent
              ? `语料中存在带缺口意图的证据，但共 ${singles} 条线索**均是单篇论文自陈**、` +
                `未能形成跨论文模式，因此系统选择不下结论。`
              : `语料中没有任何证据被标注为「局限」或「研究空白」，也没有证据命中缺口句式，` +
                `因此 0 条空白是预期结果，不是检测失败。`),
          refs: [],
        },
      ],
      limitations: ['研究空白章节无内容 —— 报告未据此生成任何研究方向'],
    }
  }

  const statements: ReportStatement[] = []
  const limitations: string[] = []

  /* 分层计数 —— 先说清楚有几条事实、几条推断 */
  statements.push({
    kind: 'system_analysis',
    text:
      `系统在本项目 ${input.gaps.context.papers} 篇论文的语料中检出 ${gs.total} 条研究空白：` +
      `其中 ${gs.stated} 条是**论文原文明确指出**的，${gs.candidate} 条是**系统跨论文推断**的候选空白。` +
      `两类证据强度不同，正文已分别标注，请勿混用。`,
    refs: input.gaps.gaps.map((g) =>
      ref('gap', g.gap_id, `${g.assertion_level === 'stated' ? '原文空白' : '候选空白'} ${g.gap_id}`),
    ),
  })

  /* 逐条 Gap。stated 用事实口吻，candidate 必须保留候选标识 */
  for (const g of input.gaps.gaps) {
    const evRefs = g.evidence_ids
      .map((eid) => corpus.evidenceById.get(eid))
      .filter((e): e is StoredEvidence => Boolean(e))
      .map((e) => ref('evidence', e.evidence_id, `证据 ${e.evidence_id}（论文 ${e.paper_id} 第 ${e.page} 页）`))

    const paperRefs = g.paper_ids.map((pid) =>
      ref('paper', pid, paperLabel(corpus.paperById.get(pid), pid)),
    )

    /*
     * 回链的 label 里必须带上 4-6 的原始标题 —— 候选 Gap 的标题以【候选】开头，
     * 所以 label 天然带【候选】。这不是把前缀重复一遍，而是**把 4-6 的标识
     * 原样搬到报告里**：用户顺着 label 回到空白页时，看到的是同一条。
     * 候选标识在搬运链路上任何一环被洗掉，都等于把推断升格成事实。
     */
    const gapRefLabel = (level: 'stated' | 'candidate') =>
      `${level === 'candidate' ? '候选空白' : '原文空白'} ${g.gap_id}：${g.title}`

    if (g.assertion_level === 'stated') {
      /*
       * stated：可以说"论文指出"。但要注意 —— 说的是"论文指出了这个缺口"，
       * 不是"这个缺口客观存在"。前者可核验，后者不可。
       */
      statements.push({
        kind: 'stated_fact',
        text:
          `${GAP_LEVEL_LABEL.stated}的缺口（${g.gap_id}）—— ${g.title}。` +
          `该缺口由 ${g.paper_ids.length} 篇论文的 ${g.evidence_ids.length} 条原文证据支撑，` +
          `缺口类型为「${gapSignalLabel(g.gap_signal)}」，涉及场景「${gapThemeLabel(g.theme)}」。`,
        refs: [ref('gap', g.gap_id, gapRefLabel('stated')), ...paperRefs, ...evRefs],
      })
    } else {
      /*
       * candidate：**绝不能**写成"论文指出"。措辞固定为
       * "系统推断…不是任何单篇论文的原话"，并且**保留【候选】标识** ——
       * 直接把 4-6 的 title 原样带上（它必然以【候选】开头，由 4-6 不变量保证）。
       */
      statements.push({
        kind: 'system_analysis',
        text:
          `系统推断的候选缺口 —— ${g.title}。` +
          `该候选由 ${g.paper_ids.length} 篇**不同论文**的证据聚合而成（${g.evidence_ids.length} 条证据），` +
          `属于系统归纳出的模式，**不是任何单篇论文的原话**，仅作探索线索使用。` +
          `缺口类型推测为「${gapSignalLabel(g.gap_signal)}」，场景「${gapThemeLabel(g.theme)}」。`,
        refs: [ref('gap', g.gap_id, gapRefLabel('candidate')), ...paperRefs, ...evRefs],
      })
    }
  }

  if (gs.candidate > 0) {
    limitations.push(
      `其中 ${gs.candidate} 条为系统推断的候选空白（标题带【候选】标识），` +
        `不能作为论文事实引用，使用前需人工核实`,
    )
  }
  if (gs.evidence_skipped > 0) {
    limitations.push(
      `缺口检测阶段剔除了 ${gs.evidence_skipped} 条证据（归属不明或无实质文本），它们未进入本报告`,
    )
  }

  /*
   * gaps_without_evidence 恒为 0 —— 4-6 的硬门槛。报告也检查一次。
   */
  if (gs.gaps_without_evidence !== 0) {
    limitations.push(
      `⚠️ 上游空白统计的 gaps_without_evidence=${gs.gaps_without_evidence}（应为 0），` +
        `说明存在无证据的空白，本报告的空白结论不可采信`,
    )
  }

  return {
    section_id,
    title,
    /*
     * ⚠️ 状态只由 **limitations 是否非空** 决定 —— 这是刻意的，不是偷懒。
     *
     * 这里的 limitations 是**我们自己写进去的**（"候选空白要人工核实"、
     * "剔除了 N 条证据"）。所以"有 limitations"= "这一章有需要用户注意的边界"，
     * 正是 partial 的定义。
     *
     * 反过来说：如果一处 limitations 都没写，说明这一章没有边界要声明，
     * 那它就是 ok。**不能**把"上游有 candidate Gap"之类的业务事实
     * 单独拿来当 partial 的依据 —— 那样状态和它自己的 limitations 数组就会
     * 互相矛盾（status=partial 但 limitations 为空），而不变量会抓到这个矛盾。
     * 我第一版就是这么写的，测试立刻报了「研究空白: status=partial 但 limitations 为空」。
     */
    status: limitations.length ? 'partial' : 'ok',
    source_counts,
    statements,
    limitations,
  }
}

/* ------------------------------------------------------------------ */
/* ⑥ 研究方向                                                          */
/* ------------------------------------------------------------------ */

const DIRECTION_LEVEL_LABEL: Record<DirectionBasisLevel, string> = {
  stated_backed: '由论文明确指出的缺口支撑（事实打底）',
  mixed: '由论文明确指出的缺口打底，并参考系统推断的候选线索',
  candidate_only: '仅由系统推断的候选线索支撑（纯探索性）',
}

/**
 * 依据层级的**使用纪律** —— 报告里写给用户看的一句话。
 *
 * 为什么每个层级都要单独写一句：`basis_level` 是个枚举，
 * 前端渲染成彩色标签就完事了；但报告是**文字**，
 * 用户读到"方向 RD002"时必须能从字面上知道
 * "这条里哪些话能引用、哪些话只能当线索"。
 * 三级各有一句，措辞刻意互不相同，不允许合并成一句泛泛的"依据见上"。
 */
const DIRECTION_USAGE_NOTE: Record<DirectionBasisLevel, string> = {
  stated_backed:
    '本方向的依据全部是论文明确指出的缺口，其原文出处可直接引用作为立项依据；' +
    '方向本身（研究问题、切入点、验证方案）仍是系统建议，不是论文的观点。',
  mixed:
    '本方向由两部分依据构成：论文明确指出的缺口（原文可引用）与系统推断的候选线索' +
    '（**不是任何单篇论文的原话**，仅用于补充视角，不构成事实依据）。' +
    '引用时请只引用前者，切勿把候选线索一并写成论文结论。',
  candidate_only:
    '本方向**仅**由系统推断的候选线索支撑，整条方向都是探索性的：' +
    '在核实这些线索成立之前，它不能作为立项的事实依据，也不代表文献中已确认的问题。',
}

const APPROACH_KIND_LABEL: Record<string, string> = {
  extend_existing: '扩展本项目已有方法',
  combine_existing: '组合本项目已有方法',
  evaluate_existing: '用已有方法做对比评测',
  introduce_new: '需引入新方法',
}

function buildDirectionsSection(input: ReportInput, corpus: Corpus): ReportSection {
  const section_id: ReportSectionId = 'directions'
  const title = '研究方向'
  const ds = input.directions.stats
  const source_counts = {
    directions: ds.total,
    stated_backed: ds.stated_backed,
    mixed: ds.mixed,
    candidate_only: ds.candidate_only,
  }

  if (!input.directions.directions.length) {
    const hasGap = input.directions.context.has_any_gap
    return {
      section_id,
      title,
      status: 'insufficient',
      source_counts,
      statements: [
        {
          kind: 'system_analysis',
          text:
            `${INSUFFICIENT_TEXT}。系统未产出任何研究方向。` +
            (hasGap
              ? `上游检出了 ${input.directions.context.gaps_received} 条研究空白，` +
                `但它们未能支撑起一条方向（通常是证据量或方法素材不足）。`
              : `本项目的研究空白章节没有任何内容（0 条空白），` +
                `而方向必须建立在空白之上 —— 没有空白就没有方向，这是预期结果。`),
          refs: [],
        },
      ],
      limitations: ['研究方向章节无内容 —— 报告未给出任何可执行的研究建议'],
    }
  }

  const statements: ReportStatement[] = []
  const limitations: string[] = []

  statements.push({
    kind: 'system_analysis',
    text:
      `系统依据上游 ${input.directions.context.gaps_received} 条研究空白生成 ${ds.total} 条研究方向：` +
      `其中 ${ds.stated_backed} 条有事实打底、${ds.mixed} 条事实与推断兼有、` +
      `${ds.candidate_only} 条为纯探索性推测。以下全部为**系统建议**，不构成对现状的陈述。`,
    /*
     * ⚠️ 这条摘要**刻意不带任何 ref**。
     *
     * 它是一条"目录式"总述（有几条方向），不是对某条方向的判定。
     * 给它挂上全部 direction 的 ref，会让测试里"找 RDxxx 那条陈述"的
     * 查找命中这条摘要而不是该方向自己的条目 —— 这类"多个陈述共享同一批 ref"
     * 会让回链断言变得毫无意义（随便点一条都能命中）。
     * 每条例行的 ref 由下面各自的陈述独立提供。
     */
    refs: [],
  })

  for (const d of input.directions.directions) {
    const evRefs = d.evidence_ids
      .map((eid) => corpus.evidenceById.get(eid))
      .filter((e): e is StoredEvidence => Boolean(e))
      .map((e) => ref('evidence', e.evidence_id, `证据 ${e.evidence_id}（论文 ${e.paper_id} 第 ${e.page} 页）`))
    const gapRefs = d.gap_ids.map((gid) => {
      const g = corpus.gapById.get(gid)
      return ref(
        'gap',
        gid,
        g
          ? `${g.assertion_level === 'stated' ? '原文空白' : '候选空白'} ${gid}：${g.title}`
          : `研究空白 ${gid}`,
      )
    })
    const methodRefs = d.approach.based_on_method_ids.map((mid) =>
      ref('method', mid, methodLabel(corpus.methodById.get(mid), mid)),
    )

    /*
     * candidate_only 必须**原样保留** 4-7 的「【推测方向】」前缀。
     * 这是需求"candidate Direction 必须保留候选标识"的落点：
     * 报告不能把前缀洗掉再换一个"听起来更专业"的说法。
     */
    const headline = d.candidate_only || d.title.startsWith('【推测方向】')
      ? d.title
      : `方向 ${d.direction_id}：${d.title}`

    statements.push({
      kind: 'system_suggestion',
      text:
        `${headline}。` +
        `依据层级：${DIRECTION_LEVEL_LABEL[d.basis_level]}（置信度 ${d.confidence}）。` +
        `依据说明：${d.description}` +
        `引用纪律：${DIRECTION_USAGE_NOTE[d.basis_level]}` +
        `研究问题：${d.question.question}` +
        `方法切入点（${APPROACH_KIND_LABEL[d.approach.kind] ?? d.approach.kind}）：建议${d.approach.description}` +
        `验证实验：${d.validation.experiment}；材料：${d.validation.materials}；` +
        `成功标准：${d.validation.success_criteria}` +
        (d.validation.from_corpus
          ? '该验证方案引用的评测素材来自本项目证据。'
          : '⚠️ 本项目证据中缺少可用评测素材，验证方案仅为最小可执行建议。'),
      refs: [
        ref('direction', d.direction_id, `研究方向 ${d.direction_id}`),
        ...gapRefs,
        ...evRefs,
        ...methodRefs,
      ],
    })
  }

  /*
   * ⚠️ 这几条局限从**实际渲染出来的 directions** 里数，而不是从 `ds`（上游 stats）里读。
   *
   * 听起来违反"统计只引用上游"的纪律，但这里必须分开看：
   *   · `source_counts`（章节头部的数字）—— **必须**引用 `ds`，那是"上游报了几条"；
   *   · `limitations`（我们自己写的话）—— **必须**基于实际渲染的内容。
   *
   * 理由：如果 stats 与实际数组不一致（上游统计漂移、或调用方注入了数据），
   * 那么"其中有 N 条是推测方向"这句话就会指向**报告里根本不存在的条目**。
   * 边界声明必须描述**这份报告**，不是描述上游的账本。
   * 两者的差异本身由不变量第 15 条负责报错，不靠这句话去修。
   */
  const renderedCandidateOnly = input.directions.directions.filter((d) => d.candidate_only).length
  const renderedWithCorpusApproach = input.directions.directions.filter((d) =>
    d.basis.includes('method_from_corpus'),
  ).length
  const renderedWithCorpusValidation = input.directions.directions.filter(
    (d) => d.validation.from_corpus,
  ).length
  const renderedTotal = input.directions.directions.length

  if (renderedCandidateOnly > 0) {
    limitations.push(
      `其中 ${renderedCandidateOnly} 条方向（标题带**【推测方向】**前缀）**仅**由系统推断的候选空白支撑，` +
        `属于探索性建议，不能作为立项的事实依据`,
    )
  }
  if (renderedWithCorpusApproach < renderedTotal) {
    limitations.push(
      `有 ${renderedTotal - renderedWithCorpusApproach} 条方向的方法切入点无法落在本项目已有方法上，` +
        `已如实标注为"需引入新方法"`,
    )
  }
  if (renderedWithCorpusValidation < renderedTotal) {
    limitations.push(
      `有 ${renderedTotal - renderedWithCorpusValidation} 条方向的验证方案缺少本项目评测素材，仅为最小可执行建议`,
    )
  }

  return {
    section_id,
    title,
    status: limitations.length ? 'partial' : 'ok',
    source_counts,
    statements,
    limitations,
  }
}

/* ------------------------------------------------------------------ */
/* ⑦ Evidence 索引                                                     */
/* ------------------------------------------------------------------ */

/**
 * Evidence 索引。
 *
 * ── 为什么它是报告里最不能省的一章 ──
 *
 * 前面六章都是"结论"。结论对不对，用户只能靠回链去核。
 * 如果回链指向的 evidence 在报告里查不到原文，那"可回链"就是一句空话 ——
 * 用户点进去只看到一个 ID，还得自己去别的页面翻。
 * 所以索引必须给出**引文原文 + 出处 + 被谁引用**。
 *
 * ⚠️ 收录范围：报告里**所有被引用过**的 evidence，**加上**项目里其他证据。
 * 未被引用的证据也收录，但 `cited_by` 为空数组 —— 如实标注
 * "这条证据存在但没被用来支撑任何结论"，而不是把它藏起来。
 *
 * ⚠️ `cited_by` **不含 `evidence_index` 自己**。
 *
 * 索引章节的摘要陈述里列了全部证据 id，但那只是"目录列出条目"，
 * 不是"用这条证据支撑了一个结论"。如果把它算进 cited_by，
 * 每条证据都会显示成"被引用过"，`cited_by` 就失去全部信息量 ——
 * 用户再也看不出"哪条证据其实没被用上"。
 * 所以这里显式跳过索引章节自己（我第一版漏了这层，被不变量第 12 条抓到）。
 */
function buildEvidenceIndex(input: ReportInput, corpus: Corpus, sections: ReportSection[]): EvidenceIndexEntry[] {
  /* 建立 evidence_id → 哪些章节引用了它（排除索引章节自身） */
  const citedBy = new Map<string, Set<ReportSectionId>>()
  for (const s of sections) {
    if (s.section_id === 'evidence_index') continue
    for (const st of s.statements) {
      for (const r of st.refs) {
        if (r.kind !== 'evidence') continue
        const set = citedBy.get(r.id) ?? new Set<ReportSectionId>()
        set.add(s.section_id)
        citedBy.set(r.id, set)
      }
    }
  }
  /* topic 块里的研究问题也引用论文，但主题块不是 section，其 evidence 引用为空 */

  const gapIdsByEv = new Map<string, string[]>()
  for (const g of input.gaps.gaps) {
    for (const eid of g.evidence_ids) {
      gapIdsByEv.set(eid, [...(gapIdsByEv.get(eid) ?? []), g.gap_id])
    }
  }
  const dirIdsByEv = new Map<string, string[]>()
  for (const d of input.directions.directions) {
    for (const eid of d.evidence_ids) {
      dirIdsByEv.set(eid, [...(dirIdsByEv.get(eid) ?? []), d.direction_id])
    }
  }

  return [...input.evidence]
    /* 按 evidence_id 排序 → 与输入顺序无关 */
    .sort((a, b) => cmp(a.evidence_id, b.evidence_id))
    .map((e) => {
      const p = corpus.paperById.get(e.paper_id)
      return {
        evidence_id: e.evidence_id,
        paper_id: e.paper_id,
        paper_title: (p?.title ?? '').trim(),
        section: e.section ?? '',
        page: e.page ?? 0,
        quote: clip(e.content ?? '', 220),
        translation: clip(e.translation ?? '', 220),
        cited_by: [...(citedBy.get(e.evidence_id) ?? new Set<ReportSectionId>())].sort() as ReportSectionId[],
        gap_ids: sortedUnique(gapIdsByEv.get(e.evidence_id) ?? []),
        direction_ids: sortedUnique(dirIdsByEv.get(e.evidence_id) ?? []),
      }
    })
}

/* ------------------------------------------------------------------ */
/* 标题与范围说明                                                      */
/* ------------------------------------------------------------------ */

/**
 * 报告标题。
 *
 * **刻意不使用 project.goal / project.name**（见模块头注释）：
 * 那是用户填的自由文本，不是语料事实。标题由语料里真实存在的东西推出。
 *
 * ⚠️ 空语料时标题**不得出现"0 篇论文"**。
 * "基于 0 篇论文的调研报告"这种标题本身就是在暗示"这是对论文的调研"，
 * 而实际上什么都没调研。此时标题必须直说"暂无内容"。
 */
function buildTitle(input: ReportInput): { title: string; scopeNote: string } {
  const noPapers = input.papers.length === 0

  if (noPapers) {
    return {
      title: '调研报告（暂无内容）',
      scopeNote:
        `本项目尚未收录任何论文，因此本报告没有任何可依据的语料。` +
        `所有章节均标注「${INSUFFICIENT_TEXT}」—— 这表示系统没有素材，` +
        `**不表示**该领域没有相关内容。` +
        `（确定性规则 ${REPORT_RULE_VERSION}，未调用任何语言模型。）`,
    }
  }

  const keywords = buildKeywords(input, buildCorpus(input))
  const kwLabel = keywords.slice(0, 3).map((k) => k.term)
  const themes = buildThemes(input)
  const themeLabel = themes.filter((t) => t.theme !== 'general').slice(0, 2).map((t) => t.label)

  const topicHint = kwLabel.length
    ? kwLabel.map((t) => `「${t}」`).join('、')
    : themeLabel.length
      ? themeLabel.join('、')
      : ''

  const title = topicHint
    ? `${topicHint} 调研报告`
    : `基于 ${input.papers.length} 篇论文的调研报告`

  const scopeNote =
    `本报告依据本项目的 ${input.papers.length} 篇论文、${input.methods.length} 个方法、` +
    `${input.evidence.length} 条证据自动生成（确定性规则 ${REPORT_RULE_VERSION}，未调用任何语言模型）。` +
    `报告中每条重要结论都标注了性质（论文原文事实 / 系统分析 / 系统建议）与回链，` +
    `「system_analysis」与「system_suggestion」不是论文的观点。` +
    `标注「${INSUFFICIENT_TEXT}」的章节表示系统没有足够素材，**不是**该领域没有相关内容。`

  return { title, scopeNote }
}

/* ------------------------------------------------------------------ */
/* 主体逻辑                                                            */
/* ------------------------------------------------------------------ */

/**
 * 生成结构化调研报告。
 *
 * ── 纯函数的含义在这里格外实在 ──
 * 同一份输入（哪怕数组顺序被打乱）必须产出**逐字节相同**的报告。
 * 所以下面所有的排序键都来自内容（id / 年份 / 计数），没有一处依赖
 * "输入的先后"或"发现的先后"。
 *
 * @returns 报告对象。**从不抛异常、从不返回 null** ——
 *          空项目会产出一份每章都是「暂无足够证据」的报告，
 *          而不是一个错误页。这是刻意的：报告为空本身就是一种结论。
 */
export function buildResearchReport(input: ReportInput): ResearchReport {
  const corpus = buildCorpus(input)

  const topic = buildTopic(input, corpus)
  const sections: ReportSection[] = [
    buildLiterature(input),
    buildMethods(input, corpus),
    buildEvolutionSection(input, corpus),
    buildGapsSection(input, corpus),
    buildDirectionsSection(input, corpus),
  ]

  const evidence_index = buildEvidenceIndex(input, corpus, sections)

  /* ── Evidence 索引章节以数组形式挂在 sections 之外的 evidence_index 上，
        这里额外产出一条"索引章节"的摘要陈述，让目录完整覆盖七个章节 ── */
  const citedCount = evidence_index.filter((e) => e.cited_by.length > 0).length
  const indexSection: ReportSection = {
    section_id: 'evidence_index',
    title: 'Evidence 索引',
    status: input.evidence.length ? 'ok' : 'insufficient',
    source_counts: {
      evidence_total: input.evidence.length,
      evidence_cited: citedCount,
      evidence_uncited: input.evidence.length - citedCount,
    },
    statements: input.evidence.length
      ? [
          {
            kind: 'system_analysis',
            text:
              `系统统计：本报告共登记 ${input.evidence.length} 条证据，其中 ${citedCount} 条被上述章节引用、` +
              `${input.evidence.length - citedCount} 条未被任何结论使用（已如实标注，未从索引中隐藏）。` +
              `每条都给出论文出处、原文引文与页码，可按 id 直接追溯。`,
            refs: evidence_index.map((e) =>
              ref('evidence', e.evidence_id, `证据 ${e.evidence_id}（论文 ${e.paper_id} 第 ${e.page} 页）`),
            ),
          },
        ]
      : [{ kind: 'system_analysis', text: INSUFFICIENT_TEXT, refs: [] }],
    limitations: input.evidence.length
      ? []
      : ['项目证据库为空，报告没有任何可追溯的原文依据'],
  }

  /* 目录顺序与 REPORT_SECTION_IDS 一致（topic 单独成块，不在这里重复） */
  const orderedSections = [...sections, indexSection].sort(
    (a, b) =>
      REPORT_SECTION_IDS.indexOf(a.section_id as ReportSectionId) -
      REPORT_SECTION_IDS.indexOf(b.section_id as ReportSectionId),
  )

  /* ── 分层摘要 ── */
  const allStatements = [...topic.research_questions, ...orderedSections.flatMap((s) => s.statements)]
  const layering: ReportLayeringSummary = {
    stated_fact: allStatements.filter((s) => s.kind === 'stated_fact').length,
    system_analysis: allStatements.filter((s) => s.kind === 'system_analysis').length,
    system_suggestion: allStatements.filter((s) => s.kind === 'system_suggestion').length,
    total_statements: allStatements.length,
    total_refs: allStatements.reduce((n, s) => n + s.refs.length, 0),
    insufficient_sections: orderedSections.filter((s) => s.status === 'insufficient').length,
    partial_sections: orderedSections.filter((s) => s.status === 'partial').length,
  }

  /* ── 全局局限：恒非空 ── */
  const global_limitations: string[] = [
    '本报告由确定性规则生成，未使用语言模型：它只能重组本项目已有素材，' +
      '不具备综述级写作能力，因此**不包含**研究背景铺垫、领域趋势判断与文献评价。',
    '报告只覆盖本项目收录的论文，未做任何外部检索，' +
      '因此不能据此断言某一方向"无人研究"。',
  ]
  if (input.papers.length < 2) {
    global_limitations.push(
      '本项目论文数少于 2 篇，跨论文结论（对齐 / 演进 / 候选空白）天然无法成立',
    )
  }
  for (const s of orderedSections) {
    for (const l of s.limitations) global_limitations.push(`【${s.title}】${l}`)
  }
  for (const l of topic.limitations) global_limitations.push(`【研究主题】${l}`)

  const { title, scopeNote } = buildTitle(input)
  const methodsSection = orderedSections.find((s) => s.section_id === 'methods')

  return {
    report_id: 'RP001',
    title,
    scope_note: scopeNote,
    topic,
    sections: orderedSections,
    evidence_index,
    layering,
    methods_source_counts: methodsSection ? { ...methodsSection.source_counts } : {},
    global_limitations,
    rule_version: REPORT_RULE_VERSION,
  }
}

/* ------------------------------------------------------------------ */
/* 不变量校验                                                          */
/* ------------------------------------------------------------------ */

/**
 * 校验报告的不变量，返回被违反项的说明列表（空数组 = 全部通过）。
 *
 * 导出给测试直接调用 —— 这样"不变量"不是散落在测试里的 if，
 * 而是一份可复用的契约，服务端与测试用同一份判断。
 *
 * ── 这里校验的都是**最难发现、后果最重**的问题 ──
 * 报告是最终交付物，它出的错用户没有能力核验。所以校验集中在两件事：
 *   ① **回链有效性**：所有引用的 id 必须真实存在于输入里。
 *      （4-7 的 EvidenceDrawer 出过一次"回链不到就回落 Demo 证据"的事故，
 *        报告里的回链同样必须只能指向本项目自己的数据。）
 *   ② **分层不越界**：推断不能写成事实。
 */
export function assertReportInvariants(report: ResearchReport, input: ReportInput): string[] {
  const bad: string[] = []

  const paperIds = new Set(input.papers.map((p) => p.paper_id))
  const methodIds = new Set(input.methods.map((m) => m.method_id))
  const evidenceIds = new Set(input.evidence.map((e) => e.evidence_id))
  const gapIds = new Set(input.gaps.gaps.map((g) => g.gap_id))
  const directionIds = new Set(input.directions.directions.map((d) => d.direction_id))
  const alignmentIds = new Set(input.alignment.candidates.map((c) => c.alignment_id))
  const evolutionIds = new Set(input.evolution.relations.map((r) => r.relation_id))

  const poolOf: Record<ReportRefKind, Set<string>> = {
    paper: paperIds,
    method: methodIds,
    evidence: evidenceIds,
    gap: gapIds,
    direction: directionIds,
    alignment: alignmentIds,
    evolution: evolutionIds,
  }

  const allStatements: { where: string; s: ReportStatement }[] = [
    ...report.topic.research_questions.map((s) => ({ where: '研究主题', s })),
    ...report.sections.flatMap((sec) => sec.statements.map((s) => ({ where: sec.title, s }))),
  ]

  for (const { where, s } of allStatements) {
    /* ── 1. kind 必须合法 ── */
    if (!isReportStatementKind(s.kind)) {
      bad.push(`${where}: 非法的 statement kind=${String(s.kind)}`)
    }

    /* ── 2. **回链有效性**：每个 ref 的 id 必须在对应池子里 ── */
    for (const r of s.refs) {
      const pool = poolOf[r.kind]
      if (!pool) {
        bad.push(`${where}: 非法的引用类型 ${String(r.kind)}`)
        continue
      }
      if (!pool.has(r.id)) {
        bad.push(`${where}: 引用了不存在的 ${r.kind}「${r.id}」（回链悬空）`)
      }
      if (!r.label || !r.label.trim()) {
        bad.push(`${where}: 引用 ${r.kind}「${r.id}」缺少人可读的 label`)
      }
    }

    /*
     * ── 3. **补充声明不得带引用** ──
     *
     * 「暂无足够证据」是一条"此处无内容"的声明，它没有任何可引用的东西。
     * 一旦它带上了 refs，就说明有实现把"缺数据"当成了"有一条数据"来渲染。
     */
    if (s.text === INSUFFICIENT_TEXT && s.refs.length > 0) {
      bad.push(`${where}: 「${INSUFFICIENT_TEXT}」声明不应携带任何引用（出现了 ${s.refs.length} 条）`)
    }

    /* ── 4. 非 stated_fact 不得使用事实断言口吻 ── */
    if (s.kind !== 'stated_fact' && s.text !== INSUFFICIENT_TEXT) {
      for (const re of FACTUAL_ASSERTION_PATTERNS) {
        if (re.test(s.text)) {
          bad.push(`${where}: kind=${s.kind} 的陈述出现事实口吻（匹配 ${re}），会把推断写成论文事实`)
        }
      }
    }

    /*
     * ── 5. **system_analysis / system_suggestion 必须自带"这是系统说的"标记** ──
     *
     * 这条是第 4 条的正面表达：光"不说事实口吻"还不够，
     * 还得让人**读出来**这是系统的判断。否则一段中性的句子
     * 与论文结论在观感上无从区分 —— 用户会默认前者才是事实。
     */
    if (s.kind === 'system_analysis' && s.text !== INSUFFICIENT_TEXT && !ANALYSIS_MARKERS.test(s.text)) {
      bad.push(`${where}: system_analysis 的陈述没有声明其为系统分析（缺少"系统/依据本项目/判定/统计"标记）`)
    }
    if (s.kind === 'system_suggestion' && !SUGGESTION_MARKERS.test(s.text)) {
      bad.push(`${where}: system_suggestion 的陈述没有声明其为建议（缺少"建议/可考虑/候选"标记）`)
    }

    /*
     * ── 6. **stated_fact 必须真的有出处** —— 需求"禁止把推断写成论文事实"的反面保障 ──
     *
     * 声称是事实却没有任何回链，说明这句话凭空而来。
     */
    if (s.kind === 'stated_fact') {
      const hasHardSource = s.refs.some((r) => r.kind === 'paper' || r.kind === 'evidence' || r.kind === 'gap')
      if (!hasHardSource) {
        bad.push(`${where}: stated_fact 的陈述没有任何论文/证据/空白级出处（凭空的事实陈述）`)
      }
    }
  }

  /*
   * ── 7. candidate 标识必须保留 ──
   *
   * 两个层面都要查，因为它们防的是两种不同的疏忽：
   *   (a) 引用层：引用了候选 Gap，陈述或 label 里必须留下"候选/推断"痕迹；
   *   (b) 标题层：引用了 **candidate_only 方向** 的陈述，
   *       必须**逐字保留** 4-7 的「【推测方向】」前缀。
   *
   * (b) 单独存在是必要的：正文里"探索""建议"这类词到处都是
   * （引用纪律、验证方案模板里都有），所以光查"有没有建议口吻"
   * 拦不住"把前缀洗掉"这种改动 —— 我加这条断言时正是这么发现的：
   * 把 title 的【推测方向】删掉后，(a) 与措辞检查**全都通过**，
   * 因为句子里还剩"探索性建议"四个字。
   * 而前缀是 4-7 给出的**唯一视觉标识**，丢了它用户第一眼就会误读。
   */
  for (const { where, s } of allStatements) {
    for (const r of s.refs) {
      if (r.kind === 'direction') {
        const d = input.directions.directions.find((x) => x.direction_id === r.id)
        if (d?.candidate_only && !s.text.includes('【推测方向】')) {
          bad.push(
            `${where}: 引用了 candidate_only 方向 ${r.id}，但陈述未保留「【推测方向】」前缀（候选标识被洗掉）`,
          )
        }
      }
      if (r.kind !== 'gap') continue
      const g = input.gaps.gaps.find((x) => x.gap_id === r.id)
      if (!g) continue
      /*
       * 候选 Gap 被引用时，要么引用它的那条陈述明确写了"候选/推断"，
       * 要么 label 里带【候选】。二者至少有一个 —— 否则候选 Gap
       * 就被当成普通事实引用了。
       * （4-6 保证候选 Gap 的 title 以【候选】开头，label 里的前缀就来自它。）
       */
      if (g.candidate) {
        const marked = /候选|推断|推测/.test(s.text) || /【候选】/.test(r.label)
        if (!marked) {
          bad.push(`引用了候选空白 ${r.id}，但陈述与 label 都没有保留候选标识`)
        }
      }
    }
  }

  /* ── 8. 章节完整性：七个章节一个都不能少 ── */
  const sectionIds = report.sections.map((s) => s.section_id)
  for (const id of REPORT_SECTION_IDS) {
    if (id === 'topic') continue /* topic 是独立块，不在 sections 里 */
    if (!sectionIds.includes(id)) bad.push(`报告缺少章节 ${id}`)
  }
  if (sectionIds.length !== new Set(sectionIds).size) bad.push('报告章节 id 存在重复')

  /* ── 9. insufficient 章节的正文必须逐字是 INSUFFICIENT_TEXT，且恰好一条 ── */
  for (const sec of report.sections) {
    if (sec.status !== 'insufficient') continue
    if (sec.statements.length !== 1) {
      bad.push(`${sec.title}: status=insufficient 的章节应恰好 1 条声明，实际 ${sec.statements.length} 条`)
    }
    for (const st of sec.statements) {
      if (!st.text.includes(INSUFFICIENT_TEXT)) {
        bad.push(`${sec.title}: status=insufficient 但正文未包含「${INSUFFICIENT_TEXT}」`)
      }
    }
    if (sec.limitations.length === 0) {
      bad.push(`${sec.title}: status=insufficient 但没有任何 limitations 说明`)
    }
  }

  /* ── 10. partial / insufficient 章节必须有局限性说明 ── */
  for (const sec of report.sections) {
    if ((sec.status === 'partial' || sec.status === 'insufficient') && !sec.limitations.length) {
      bad.push(`${sec.title}: status=${sec.status} 但 limitations 为空`)
    }
  }

  /* ── 11. Evidence 索引：覆盖全部证据，且每条引文非空 ── */
  const indexedIds = new Set(report.evidence_index.map((e) => e.evidence_id))
  for (const e of input.evidence) {
    if (!indexedIds.has(e.evidence_id)) bad.push(`Evidence 索引漏掉了证据 ${e.evidence_id}`)
  }
  if (report.evidence_index.length !== input.evidence.length) {
    bad.push(
      `Evidence 索引条数 ${report.evidence_index.length} ≠ 项目证据数 ${input.evidence.length}（索引必须全覆盖）`,
    )
  }
  for (const e of report.evidence_index) {
    if (!e.quote.trim()) {
      bad.push(`Evidence 索引 ${e.evidence_id} 的引文为空（索引必须能直接读到原文）`)
    }
  }

  /*
   * ── 12. 索引里的 cited_by 必须与章节实际引用一致 ──
   *
   * ⚠️ 比对时**跳过索引章节自己** —— 与 buildEvidenceIndex 里的跳过保持一致。
   * 索引章节的摘要陈述列出了全部证据 id（那是"目录列出条目"），
   * 把它算进"被引用"会让每条证据都显示成"用过"，cited_by 就失去意义。
   * 两处必须用同一个口径，否则不变量会一直报"不一致"（我第一版正是如此）。
   */
  const actualCited = new Map<string, Set<string>>()
  for (const sec of report.sections) {
    if (sec.section_id === 'evidence_index') continue
    for (const st of sec.statements) {
      for (const r of st.refs) {
        if (r.kind !== 'evidence') continue
        const set = actualCited.get(r.id) ?? new Set<string>()
        set.add(sec.section_id)
        actualCited.set(r.id, set)
      }
    }
  }
  for (const e of report.evidence_index) {
    const expect = [...(actualCited.get(e.evidence_id) ?? new Set<string>())].sort().join(',')
    const actual = [...e.cited_by].sort().join(',')
    if (expect !== actual) {
      bad.push(`Evidence 索引 ${e.evidence_id} 的 cited_by=[${actual}] 与章节实际引用 [${expect}] 不一致`)
    }
  }

  /* ── 13. 分层摘要自洽 ── */
  const total =
    report.layering.stated_fact + report.layering.system_analysis + report.layering.system_suggestion
  if (total !== report.layering.total_statements) {
    bad.push(
      `layering 三层之和 ${total} ≠ total_statements ${report.layering.total_statements}`,
    )
  }
  if (report.layering.total_statements !== allStatements.length) {
    bad.push(
      `layering.total_statements=${report.layering.total_statements} 与实际陈述数 ${allStatements.length} 不一致`,
    )
  }

  /* ── 14. 全局局限恒非空 ── */
  if (!report.global_limitations.length) {
    bad.push('global_limitations 为空 —— 任何报告都必须声明自己的边界')
  }

  /* ── 15. 顶层统计必须**引用**上游 stats，不得自行复算导致口径分叉 ── */
  const gapSection = report.sections.find((s) => s.section_id === 'gaps')
  if (gapSection) {
    if (gapSection.source_counts.gaps !== input.gaps.stats.total) {
      bad.push(
        `研究空白章节的 gaps 计数 ${gapSection.source_counts.gaps} ≠ 4-6 统计的 ${input.gaps.stats.total}（口径分叉）`,
      )
    }
  }
  const dirSection = report.sections.find((s) => s.section_id === 'directions')
  if (dirSection) {
    if (dirSection.source_counts.directions !== input.directions.stats.total) {
      bad.push(
        `研究方向章节的 directions 计数 ${dirSection.source_counts.directions} ≠ 4-7 统计的 ${input.directions.stats.total}（口径分叉）`,
      )
    }
  }

  /* ── 16. rule_version 必须标明确定性规则 ── */
  if (!/deterministic/.test(report.rule_version)) {
    bad.push(`rule_version「${report.rule_version}」未标明 deterministic`)
  }

  return bad
}

/**
 * 统计口径自检：报告的 source_counts 必须等于上游对应模块统计值。
 *
 * 为什么要单独抽出这份比对：**不变量校验通过不代表口径一致** ——
 * 两者查的是不同的东西。不变量管的是"引用是否存在、分层是否越界"，
 * 这里管的是"报告报出的数字是不是上游那个数字"。
 *
 * ⚠️ 每一行的 `upstream` 都必须来自**输入对象自己的字段**
 * （`input.gaps.gaps.length` / `input.x.stats.y`），
 * 绝不能写成 `report` 那一侧的表达式 —— 那就是自己跟自己比，永远为真。
 * 这条约束在这里格外重要：口径分叉正是"两个数字本该不同却看起来相同"造成的。
 */
export function reportStatConsistency(
  report: ResearchReport,
  input: ReportInput,
): { label: string; report: number | null; upstream: number }[] {
  const countIn = (sectionId: ReportSectionId, field: string): number | null => {
    const sec = report.sections.find((s) => s.section_id === sectionId)
    return sec ? (sec.source_counts[field] ?? null) : null
  }
  const classifiedIn = (field: string): number | null => {
    const n = report.methods_source_counts[field]
    return typeof n === 'number' ? n : null
  }

  const classified = input.methods.filter((m) => (m.family_id ?? '').length > 0).length
  const unclassified = input.methods.length - classified

  return [
    /* ── 与 4-6 对账 ── */
    { label: 'gaps.total', report: countIn('gaps', 'gaps'), upstream: input.gaps.gaps.length },
    { label: 'gaps.stated', report: countIn('gaps', 'stated'), upstream: input.gaps.stats.stated },
    { label: 'gaps.candidate', report: countIn('gaps', 'candidate'), upstream: input.gaps.stats.candidate },
    {
      label: 'gaps.papers_involved',
      report: countIn('gaps', 'papers_involved'),
      upstream: input.gaps.stats.papers_involved,
    },

    /* ── 与 4-7 对账 ── */
    {
      label: 'directions.total',
      report: countIn('directions', 'directions'),
      upstream: input.directions.directions.length,
    },
    {
      label: 'directions.stated_backed',
      report: countIn('directions', 'stated_backed'),
      upstream: input.directions.stats.stated_backed,
    },
    {
      label: 'directions.mixed',
      report: countIn('directions', 'mixed'),
      upstream: input.directions.stats.mixed,
    },
    {
      label: 'directions.candidate_only',
      report: countIn('directions', 'candidate_only'),
      upstream: input.directions.stats.candidate_only,
    },

    /* ── 与 4-2 / 4-4 对账 ── */
    {
      label: 'methods.alignments',
      report: countIn('methods', 'alignments'),
      upstream: input.alignment.candidates.length,
    },
    {
      label: 'evolution.relations',
      report: countIn('evolution', 'relations'),
      upstream: input.evolution.relations.length,
    },
    {
      label: 'evolution.causal',
      report: countIn('evolution', 'causal'),
      upstream: input.evolution.stats.causal_total,
    },

    /* ── 与自己语料对账（方法分类的"已分类 / 未分类"必须分割全部方法）── */
    { label: 'methods.classified', report: classifiedIn('classified'), upstream: classified },
    { label: 'methods.unclassified', report: classifiedIn('unclassified'), upstream: unclassified },

    /* ── 与 Evidence 索引对账 ── */
    {
      label: 'evidence_index.total',
      report: report.evidence_index.length,
      upstream: input.evidence.length,
    },
  ]
}
