/**
 * 跨论文方法对齐（Phase 4-2）。
 *
 * ── 这个模块回答什么问题 ──
 * 同一个项目里，不同论文各自抽出了若干 Method。用户在读第二篇论文时，
 * 最自然的疑问是：「这篇里的 X，和我上一篇读到的 Y，是不是同一个东西？」
 * 本模块就是回答这个问题的**候选生成器**。
 *
 * ── 为什么它必须是纯函数 ──
 * 与 relevance.ts 同一套理由：不读 config、不发请求、不碰文件。
 * 这样测试可以直接跑它，不必起服务、不必配 key，
 * 也不必因为它的失败去怀疑"是不是网络又挂了"。
 *
 * ── 最重要的设计约束：这是"候选"，不是"结论" ──
 * 对齐的本质是**语义判断**，而语义判断需要模型。本模块在 Mock / 无模型模式下
 * 只有名字字面量和一组结构化字段可用。所以：
 *
 *   1. 它只产出 `same` / `alias` / `related` / `uncertain` 四种**保守**关系；
 *   2. 它**永不**产出 `improves` / `extends` / `evolves` 这类**因果**关系——
 *      因为"B 改进了 A"是一个需要原文直接证据的历史断言，
 *      名字像、年份晚、同一个族，都不能推出"改进"。
 *      这三条在返回类型里被物理地堵死了（见 AlignmentRelationType）。
 *   3. 每个字段都带 `basis`（判定依据）与 `confidence`，让用户能复核，
 *      而不是面对一个没有出处的标签。
 *
 * 宁可给出 100 条 `uncertain`，也不给 1 条自信满满的错关系。
 * 错关系会污染整个方法地图，而方法地图正是这个工具最值钱的产出。
 *
 * ── 比较依据（严格限定为这四类，不引入其他信息源）──
 *   1. 方法名称（name / name_zh）：归一化后比对，含缩写与显式别名
 *   2. 任务（task）：两者针对的问题设定是否相同
 *   3. 核心做法（core_idea）：文本重合度
 *   4. 已有 Evidence：双方各自的证据，以及是否有逐字相同的原文句
 *
 * 除这四类之外**不读任何东西**：不看年份先后下判断（只作微调）、
 * 不看论文标题、不看外部知识。这是刻意的自我限制——
 * 加进来的每个信息源都会提高"看起来像"的能力，也会提高编造关系的能力。
 */

import type { StoredMethod, StoredEvidence, StoredPaper } from '../types.ts'

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/**
 * 允许产出的关系类型。
 *
 * **刻意不含 `improves` / `extends` / `evolves`。**
 *
 * 这不是"暂时没实现"，而是本阶段的能力边界：
 *   这几个类型都是**因果/历史**断言，必须由论文原文里"我们改进了 X"
 *   这种直接证据支撑。而本模块的输入只有方法名 + 结构化字段 + 已有证据的
 *   文本片段，没有"跨论文的因果声明"这一信息来源。
 *
 * 把它写成联合类型而不是 string，是为了让"不该有的类型"在类型层面
 * 就编译不过——任何试图 push 一个 'extends' 的代码都会在 build 阶段被拦下。
 * 靠 code review 记住"不要写 extends"是不可靠的，靠类型才可靠。
 */
export type AlignmentRelationType = 'same' | 'alias' | 'related' | 'uncertain'

/** 判定这条候选关系时实际用到的信号。界面可据此解释"凭什么" */
export type AlignmentBasis =
  | 'name_exact' // 归一化后方法名完全相同
  | 'name_surface_variant' // 名字互为表层变体（大小写/标点/复数/缩写）
  | 'name_token_subset' // 一个名字的词集是另一个的子集
  | 'name_zh_match' // 中文名相同
  | 'alias_declared' // 一方把自己的名字写进了另一方的别名/模块名（显式别名）
  | 'acronym_match' // 首字母缩写匹配
  | 'core_idea_overlap' // 核心思想文本高度重合
  | 'same_task' // 任务/问题设定相同
  | 'same_family' // 同属一个方法族
  | 'shared_evidence_text' // 双方证据里有逐字相同的原文句
  | 'year_gap' // 仅年份相邻
  | 'name_conflict' // 名字明显冲突（一方是另一方的否定/竞争）

/** 一条候选对齐关系 */
export interface AlignmentCandidate {
  /** 稳定 id，形如 A001。同一输入必须产出同一 id（确定性） */
  alignment_id: string
  /** 归一化后按字典序在前的一方（保证 A-B 与 B-A 只产出一次） */
  source: AlignmentSide
  target: AlignmentSide
  relation_type: AlignmentRelationType
  /** 0–1。**不是"我觉得有多像"，而是"有多少条独立信号支持这个判断"** */
  confidence: number
  /** 命中的信号，按重要性排序。空数组表示"什么都没想到" */
  basis: AlignmentBasis[]
  /** 给用户看的一句话解释。必须能复述判定过程，不能是空话 */
  reason: string
  /**
   * 支撑本次对齐的 evidence_id 列表（双方并集，去重）。
   *
   * 允许为空——`uncertain` / `related` 天然可能没有证据。
   * 但凡 `same` / `alias` 这两类要"合并展示"的关系，
   * `hasDirectEvidence` 会要求它非空（见下）。
   */
  evidence_ids: string[]
  /** 双方各自证据里**逐字相同**的原文句。非空是"同一方法"的强佐证 */
  shared_quotes: string[]
  /**
   * 是否达到「实质证据」门槛——即本条 `same` / `alias` 判定是否有证据支撑。
   *
   * 含义精确地说，为 true 当且仅当满足以下任一：
   *   - 一方在名称里显式声明了另一方为别名（`alias_declared`）；
   *   - 双方**各自**都挂有可核验的证据。
   *
   * **名字完全相同不算实质证据。** 所以这个字段为 false 时，
   * `relation_type` 一定落在 `related` / `uncertain`，不可能是 `same` / `alias`。
   * 界面可以据此提示"此判断无证据支撑"。
   */
  hasDirectEvidence: boolean
}

/** 关系的一方。`paper_id` / `method_id` / `evidence_ids` 三者必须同时保留 */
export interface AlignmentSide {
  paper_id: string
  method_id: string
  name: string
  name_zh: string
  family_id: string
  year: number
  /** 该方自己的证据 id（不是交集，是这一侧的全部） */
  evidence_ids: string[]
}

/** 对齐输入：一个项目的方法快照 */
export interface AlignmentInput {
  methods: StoredMethod[]
  evidence: StoredEvidence[]
  papers: StoredPaper[]
}

/** 对齐产出 */
export interface AlignmentOutcome {
  candidates: AlignmentCandidate[]
  /** 参与比较的方法数（= 方法总数） */
  compared: number
  /** 被跳过的同论文方法对数——**这个数字要报出来，不能静默丢弃** */
  skippedSamePaper: number
  /** 因缺少 paper 归属而无法参与跨论文比较的方法数 */
  skippedNoPaper: number
  /** 使用的规则集版本，便于溯源 */
  rule_version: string
}

export const ALIGNMENT_RULE_VERSION = 'deterministic-method-alignment-v1'

/* ------------------------------------------------------------------ */
/* 关系类型白名单 + 统计                                                */
/* ------------------------------------------------------------------ */

/**
 * 四类关系的**运行时**白名单。
 *
 * 类型层面已经有 `AlignmentRelationType` 联合类型兜底，但 API 返回的是
 * JSON，前端拿到的是 `unknown`——类型在运行时不存在。所以服务端在出口处
 * 还要再核一次，并且把它导出给前端与测试复用，避免两边各写一份后漂移。
 */
export const ALIGNMENT_RELATION_TYPES: readonly AlignmentRelationType[] = [
  'same',
  'alias',
  'related',
  'uncertain',
] as const

export const isAlignmentRelationType = (v: unknown): v is AlignmentRelationType =>
  typeof v === 'string' && (ALIGNMENT_RELATION_TYPES as readonly string[]).includes(v)

/** 关系数量统计。四种类型**各自**计数，不用一个"总数"糊过去 */
export interface AlignmentStats {
  same: number
  alias: number
  related: number
  uncertain: number
  /** 四类之和，等于 candidates.length */
  total: number
  /** 达到实质证据门槛的条数（same/alias 必然包含在内，因为它们是门槛的必要条件） */
  grounded: number
}

/**
 * 统计关系数量。
 *
 * 为什么不给一个笼统的"共 N 条"就完事：
 * `same`（判定同一方法）和 `uncertain`（无法判断）对用户的含义完全相反。
 * 合并成一个数字会让"我们找到了 9 条同一方法"和
 * "我们注意到了 24 条但判断不了"看起来一样重要，而前者才是有结论的那部分。
 */
export function summarizeAlignments(candidates: AlignmentCandidate[]): AlignmentStats {
  const stats: AlignmentStats = {
    same: 0, alias: 0, related: 0, uncertain: 0, total: 0, grounded: 0,
  }
  for (const c of candidates) {
    if (isAlignmentRelationType(c.relation_type)) stats[c.relation_type]++
    stats.total++
    if (c.hasDirectEvidence) stats.grounded++
  }
  return stats
}


/* ------------------------------------------------------------------ */
/* 文本归一化                                                          */
/* ------------------------------------------------------------------ */

/**
 * 方法名归一化。
 *
 * 与 relevance.ts 的口径保持一致（非 `\w`/汉字 → 空格），
 * 这样「Tool-Use」「Tool Use」「tool use」会被视为同一个词。
 * 额外多做一步：去掉括号里的补充说明。
 *   `Combining ReAct and CoT-SC (ReAct ↔ CoT-SC)` → `combining react and cot sc`
 * 括号里往往是作者自注的别名或对照，不参与主名匹配——
 * 但它不会被丢弃，而是在 alias_declared 那条规则里单独利用。
 */
export function normalizeMethodName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/[^\w\u4e00-\u9fa5]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 取括号内的内容，用于别名识别 */
function parenthesized(s: string): string[] {
  const out: string[] = []
  const re = /[（(]([^）)]*)[）)]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) out.push(m[1])
  return out
}

/** 英文单复数归并。与 relevance.ts 同口径，避免 Agents/Agent 匹配不上 */
function singularize(w: string): string {
  if (w.length <= 3) return w
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.endsWith('ses') || w.endsWith('xes') || w.endsWith('ches') || w.endsWith('shes')) {
    return w.slice(0, -2)
  }
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1)
  return w
}

/**
 * 把归一化后的名字切成**有意义的词**。
 *
 * 停用词必须去掉，否则 "Loop"、"Framework"、"Method" 这些通用词
 * 会让 "ReAct Loop" 和 "Reflexion Framework" 也共享一个词，
 * 从而产生假信号。这些词在方法名里几乎不携带判别信息。
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'with', 'via',
  'by', 'from', 'as', 'at', 'into', 'based', 'using', 'use', 'toward', 'towards',
  'method', 'methods', 'approach', 'approaches', 'framework', 'frameworks',
  'model', 'models', 'system', 'systems', 'agent', 'agents', 'algorithm',
  'loop', 'based', 'learning', 'framework', 'technique', 'strategy',
  'language', 'large', 'llm', 'llms', 'paper', 'new', 'novel',
])

export function nameTokens(s: string): string[] {
  return normalizeMethodName(s)
    .split(' ')
    /*
     * ⚠️ 顺序不能换：**先归并单复数，再过滤停用词**。
     *
     * 反了就会漏掉一个很常见的情形：`Agents` 不在停用词表里（表里是 `agent`），
     * 所以先过滤的话 `Agents` 会被当成实词放行，再归并成 `agent` —— 结果
     * 停用词表里明明有 `agent`，它却混进了词表。
     * 极端情况下 `nameTokens('Agents')` 会返回 `['agent']` 而不是 `[]`，
     * 于是 "Agents" 和 "Agent" 会被认为共享一个实词。
     */
    .map(singularize)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
}

/**
 * 首字母缩写：`Agent-Computer Interface` → `aci`。
 *
 * ⚠️ 这里**刻意不过滤停用词**，与 nameTokens 不同。
 *
 * 原因是踩过的坑：`agent` 在停用词表里（因为它在方法名中太常见、判别力低），
 * 但缩写 `ACI` 里的那个 `A` 恰恰就来自 `Agent`。
 * 用停用词过滤后的词表去算缩写，`Agent Computer Interface` 会算出 `ci`，
 * 于是永远匹配不上真实的缩写 `ACI` —— 而这个 case 正是别名识别的主要场景。
 *
 * 教训：停用词表是**为相似度打分**设计的，不能不加区分地复用到别处。
 * 两条规则对"哪些词有信息量"的答案本来就不同。
 */
function acronym(s: string): string {
  const words = normalizeMethodName(s)
    .split(' ')
    .filter((w) => /^[a-z]/.test(w))
  if (words.length < 2) return ''
  return words.map((w) => w[0]).join('')
}

/** 句子的归一化指纹，用于跨方法比对"是否逐字相同" */
function quoteFingerprint(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').trim()
}

/* ------------------------------------------------------------------ */
/* 词组相似度（Dice 系数，面向集合而非序列）                            */
/* ------------------------------------------------------------------ */

function dice(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0
  const sa = new Set(a)
  const sb = new Set(b)
  let inter = 0
  for (const x of sa) if (sb.has(x)) inter++
  return (2 * inter) / (sa.size + sb.size)
}

/* ------------------------------------------------------------------ */
/* 主体逻辑                                                            */
/* ------------------------------------------------------------------ */

/**
 * 生成跨论文方法对齐候选。
 *
 * 三条硬规则，按顺序在代码里体现：
 *   1. **同论文的方法互相对齐** —— 同一篇论文里抽出的两个方法，
 *      是这篇论文的两个不同贡献，不是"一个方法的两个名字"。
 *      把它们对齐起来是纯噪音，且极易误导（同一篇论文里的方法往往名字相似，
 *      会大量误命中）。所以第一件事就是把它们排除，并把跳过的对数报出来。
 *   2. **没有 paper 归属的方法不参与** —— 无法确认它是"跨论文"的。
 *   3. **强关系必须有直接证据** —— 见 `gradeRelation`。
 */
export function alignMethods(input: AlignmentInput): AlignmentOutcome {
  const { methods, evidence, papers } = input

  const evById = new Map(evidence.map((e) => [e.evidence_id, e]))
  /** evidence_id → 它在哪篇论文里 */
  const evPaper = new Map(evidence.map((e) => [e.evidence_id, e.paper_id]))
  const paperIds = new Set(papers.map((p) => p.paper_id))

  const skippedNoPaper: string[] = []
  const usable = methods.filter((m) => {
    const pid = primaryPaperId(m)
    if (!pid || !paperIds.has(pid)) {
      skippedNoPaper.push(m.method_id)
      return false
    }
    return true
  })

  const candidates: AlignmentCandidate[] = []
  let skippedSamePaper = 0

  /*
   * 两两比较。`j` 从 `i+1` 开始，保证每对只比较一次——
   * 这既省一半计算，也保证不会同时产出 A→B 和 B→A 两条重复关系。
   *
   * 注意：这里**先不分配 alignment_id**（先给占位空串），
   * 等排序完再统一编号。原因见下方注释。
   */
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i]
      const b = usable[j]
      const pa = primaryPaperId(a)
      const pb = primaryPaperId(b)

      /* 规则 1：同论文不互相对齐 */
      if (pa === pb) {
        skippedSamePaper++
        continue
      }

      const graded = gradeRelation(a, b, evById, evPaper)
      if (!graded) continue

      const [left, right] = orderPair(a, b)
      candidates.push({
        alignment_id: '',
        source: toSide(left, evById),
        target: toSide(right, evById),
        relation_type: graded.relation_type,
        confidence: graded.confidence,
        basis: graded.basis,
        reason: graded.reason,
        evidence_ids: graded.evidence_ids,
        shared_quotes: graded.shared_quotes,
        hasDirectEvidence: graded.hasDirectEvidence,
      })
    }
  }

  /*
   * ── 排序：必须完全由内容决定，不能依赖发现顺序 ──
   *
   * 这一版是**被测试逼出来的**。
   *
   * 最初的写法是"边发现边分配 id，再按 (强度, 置信度, id) 排序"。
   * 看起来确定，实际上有一个隐蔽的顺序依赖：
   * 当两条候选的**关系类型与置信度都相同**时（这很常见，
   * 比如两个 alias 都是 0.6），排序会落到 id 这一级；
   * 而 id 是发现顺序决定的，发现顺序又随输入数组顺序变化。
   * 结果就是：同一批方法，换个输入顺序，两条同分候选的先后会互换。
   *
   * 单次打乱碰不到，穷举 6 种排列就必现。
   * 修复方式是把排序键换成**由内容本身算出**的稳定键：
   * (关系强度, 置信度降序, source 键, target 键)。这四个都只跟内容有关，
   * 与输入顺序无关。排完之后再统一编号，id 也就稳定了。
   */
  const rank: Record<AlignmentRelationType, number> = {
    same: 0, alias: 1, related: 2, uncertain: 3,
  }
  const pairKey = (c: AlignmentCandidate) => [
    `${c.source.paper_id}::${c.source.method_id}`,
    `${c.target.paper_id}::${c.target.method_id}`,
  ]

  candidates.sort((x, y) => {
    const [xs, xt] = pairKey(x)
    const [ys, yt] = pairKey(y)
    return (
      rank[x.relation_type] - rank[y.relation_type] ||
      y.confidence - x.confidence ||
      (xs < ys ? -1 : xs > ys ? 1 : 0) ||
      (xt < yt ? -1 : xt > yt ? 1 : 0)
    )
  })

  /* 排序完成后统一编号：id 成为"排序后位置"的纯函数 */
  candidates.forEach((c, i) => {
    c.alignment_id = `A${String(i + 1).padStart(3, '0')}`
  })

  return {
    candidates,
    compared: usable.length,
    skippedSamePaper,
    skippedNoPaper: skippedNoPaper.length,
    rule_version: ALIGNMENT_RULE_VERSION,
  }
}

/** 方法的主论文 id。`paper_ids` 理论上可多值，取第一个作为跨论文比较的归属 */
function primaryPaperId(m: StoredMethod): string {
  return m.paper_ids.length ? m.paper_ids[0] : ''
}

/** 稳定排序：按 (paper_id, method_id) 字典序，保证 A-B 与 B-A 产出同一条 */
function orderPair(a: StoredMethod, b: StoredMethod): [StoredMethod, StoredMethod] {
  const ka = `${primaryPaperId(a)}::${a.method_id}`
  const kb = `${primaryPaperId(b)}::${b.method_id}`
  return ka <= kb ? [a, b] : [b, a]
}

function toSide(m: StoredMethod, evById: Map<string, StoredEvidence>): AlignmentSide {
  return {
    paper_id: primaryPaperId(m),
    method_id: m.method_id,
    name: m.name,
    name_zh: m.name_zh,
    family_id: m.family_id,
    year: m.year,
    // 只保留真实存在的证据 id，悬空的静默剔除（不与"有证据"混淆）
    evidence_ids: m.evidence_ids.filter((id) => evById.has(id)),
  }
}

/* ------------------------------------------------------------------ */
/* 判定                                                                */
/* ------------------------------------------------------------------ */

interface Graded {
  relation_type: AlignmentRelationType
  confidence: number
  basis: AlignmentBasis[]
  reason: string
  evidence_ids: string[]
  shared_quotes: string[]
  hasDirectEvidence: boolean
}

/**
 * 给一对跨论文方法定级。
 *
 * 返回 `null` 表示"这两者之间没有任何值得一提的信号"——
 * 直接不产出候选，而不是产出一条 `uncertain`。
 *
 * **为什么这点很重要**：N 个方法会产生 N(N-1)/2 对。
 * 如果对每一对都吐一条 `uncertain`，20 个方法就是 190 条噪音，
 * 用户再也不会打开这个面板。`uncertain` 应当保留给
 * "有表面相似、但不足以判断"的那一小撮，而不是"什么都没发现"。
 */
function gradeRelation(
  a: StoredMethod,
  b: StoredMethod,
  evById: Map<string, StoredEvidence>,
  evPaper: Map<string, string>,
): Graded | null {
  const basis: AlignmentBasis[] = []

  const na = normalizeMethodName(a.name)
  const nb = normalizeMethodName(b.name)
  const ta = nameTokens(a.name)
  const tb = nameTokens(b.name)

  const zhA = normalizeMethodName(a.name_zh)
  const zhB = normalizeMethodName(b.name_zh)

  /* ---- 信号 1：名字完全一致 ---- */
  const exactName = na.length > 0 && na === nb
  if (exactName) basis.push('name_exact')

  /* ---- 信号 2：中文名一致 ---- */
  const sameZh = zhA.length > 0 && zhA === zhB
  if (sameZh) basis.push('name_zh_match')

  /* ---- 信号 3：表层变体（去标点/复数后一致，但原始不完全相同） ---- */
  const surfaceVariant = !exactName && na.replace(/ /g, '') === nb.replace(/ /g, '')
  if (surfaceVariant) basis.push('name_surface_variant')

  /* ---- 信号 4：词集包含 ---- */
  const setA = new Set(ta)
  const setB = new Set(tb)
  const onlyA = ta.filter((w) => !setB.has(w))
  const onlyB = tb.filter((w) => !setA.has(w))
  const rawSubset =
    ta.length > 0 &&
    tb.length > 0 &&
    (onlyA.length === 0 || onlyB.length === 0) &&
    !(onlyA.length === 0 && onlyB.length === 0)

  /*
   * ⚠️ 单纯"词集包含"会产生严重的假阳性，必须再加两个约束。
   *
   * 这个 bug 是 Demo 全量回放抓出来的，记一下它的完整形态：
   *
   *   M015  Virtual Context Management / 虚拟上下文管理
   *   M018  In-Context Learning        / 上下文学习
   *
   *   `In-Context Learning` 去停用词后只剩 `[context]`
   *   （`in` 和 `learning` 都在停用词表里），
   *   而 `Virtual Context Management` 是 `[virtual, context, management]`。
   *   于是 `[context]` 成了后者的**真子集** → 判定为别名。
   *   两个毫无关系的方法被判成 alias，还因为双方都有证据而顺利过关。
   *
   * 问题出在：停用词过滤太狠时，一个方法名会被压缩到只剩**一个通用词**，
   * 而这个通用词恰好出现在别的名字里，就产生了包含关系。
   * `context`、`reasoning`、`code` 这类词在本领域遍地都是。
   *
   * 两个约束：
   *   a) 短的那一方至少要有 2 个实词 —— 单词名不足以支撑"缩写/简称"的判断；
   *      真别名场景（Tree of Thoughts ↔ Tree of Thoughts Search）短边有 2+ 个词。
   *   b) 被共享的词里至少要有一个**非高频通用词**，避免仅靠 context 这类词
   *      就建立包含关系。
   */
  const shortSide = Math.min(ta.length, tb.length)
  const sharedWords = ta.filter((w) => setB.has(w))
  const GENERIC = new Set([
    'context', 'reasoning', 'code', 'model', 'agent', 'data', 'task',
    'prompt', 'search', 'memory', 'tool', 'token', 'text', 'generation',
    'retrieval', 'training', 'planning', 'action', 'language',
  ])
  const hasSpecificShared = sharedWords.some((w) => !GENERIC.has(w))
  const subset = rawSubset && shortSide >= 2 && hasSpecificShared
  if (subset) basis.push('name_token_subset')

  /* ---- 信号 5：显式别名 —— 一方的名字出现在另一方的括号里 ---- */
  const declaredAlias = detectDeclaredAlias(a, b)
  if (declaredAlias) basis.push('alias_declared')

  /* ---- 信号 6：缩写匹配（Agent-Computer Interface ↔ ACI） ---- */
  const acrA = acronym(a.name)
  const acrB = acronym(b.name)
  const acronymHit =
    (acrA.length >= 2 && normalizeMethodName(b.name).split(' ').includes(acrA)) ||
    (acrB.length >= 2 && normalizeMethodName(a.name).split(' ').includes(acrB))
  if (acronymHit) basis.push('acronym_match')

  /* ---- 信号 7：核心思想文本重合 ---- */
  const ideaDice = dice(nameTokens(a.core_idea), nameTokens(b.core_idea))
  const ideaOverlap = ideaDice >= 0.55 && ta.length > 0 && tb.length > 0
  if (ideaOverlap) basis.push('core_idea_overlap')

  /* ---- 信号 8：同任务（题目要求的四种依据之一） ---- */
  /*
   * `task` 是"这篇论文针对什么问题"。同任务说明两个方法在解同一类问题，
   * 但**同一任务的解法可以完全不同**（比如 M009 与 M011 都是 Code Generation，
   * 一个是预训练、一个是采样筛选）。所以它只能推高到 related/uncertain，
   * 绝不能单独支撑 same/alias。
   *
   * 归一化后比较，避免 "Code Generation" 与 "code generation " 被判为不同。
   */
  const taskA = normalizeMethodName(a.task)
  const taskB = normalizeMethodName(b.task)
  const sameTask = taskA.length > 0 && taskA === taskB
  if (sameTask) basis.push('same_task')

  /* ---- 信号 9：同族 ---- */
  const sameFamily = a.family_id !== '' && a.family_id === b.family_id
  if (sameFamily) basis.push('same_family')

  /* ---- 信号 10：双方证据里有逐字相同的原文句 ---- */
  const sharedRaw = sharedQuoteTexts(a, b, evById, evPaper)
  const sharedEvidence = sharedRaw.length > 0
  if (sharedEvidence) basis.push('shared_evidence_text')

  /* ---- 信号 11：名字冲突（显式的否定/竞争表述） ---- */
  const nameConflict = /^(no|non|anti)[\s-]/.test(na) !== /^(no|non|anti)[\s-]/.test(nb)
  if (nameConflict) basis.push('name_conflict')

  /* ---- 年份差（只作为 related 的辅助，单独不足以定级） ---- */
  const yearGap = Math.abs(a.year - b.year) <= 2 && a.year > 0 && b.year > 0

  /* ---- 名字相似度（亚阈值也算信号） ---- */
  const nameDice = dice(ta, tb)

  /*
   * 一条信号都没有：不产出候选。
   * 这正是"不制造噪音"的落点。
   */
  if (basis.length === 0 && nameDice < 0.4) return null

  /* ---- 证据集合：双方并集（只取真实存在的） ---- */
  const ownA = a.evidence_ids.filter((id) => evById.has(id))
  const ownB = b.evidence_ids.filter((id) => evById.has(id))
  const union = [...new Set([...ownA, ...ownB])]

  /**
   * ── 强关系的准入门槛（本阶段最硬的一条规则）──
   *
   * `same` / `alias` 都是**断言两个方法指同一个东西**。
   * 这种断言一旦错了，会直接污染方法地图，而用户没有能力逐条复核。
   * 所以它需要**实质证据**，光凭名字像不行。
   *
   * 什么算实质证据，只有两种，都不是"名字像"：
   *
   *   1. **作者显式声明**（`alias_declared`）——
   *      论文自己在名称里写了"又名 X"。这是原文里的事实陈述，最强。
   *   2. **双方都真的挂着证据**（`ownA` 与 `ownB` 都非空）——
   *      两个方法各自都有可核验的原文证据，说明它们是两篇论文里
   *      真实成立的方法实体，此时名字一致才足以支撑"同一个"的判断。
   *      若还共享逐字相同的原文，证据强度更高。
   *
   * **明确不算**实质证据的：名字完全相同、名字互为子集、缩写匹配、
   * 同族、同任务、年份相邻、核心思想文本重合。
   * 这些全是"表面像"，它们只能把关系推到 `related` / `uncertain`。
   *
   * 换句话说：本模块的默认立场是**怀疑**。
   * 两个方法名字一模一样但没有证据，它输出的不是 `same`，而是
   * `related` + 一句"名字相同但双方都没有证据，无法确认是否同一方法"。
   * 这不是保守过度，而是因为"同名不同物"在这个领域非常常见
   * （不同论文独立命名、术语复用、甚至不同缩写撞车）。
   */
  const bothHaveEvidence = ownA.length > 0 && ownB.length > 0
  const hasSubstantiveEvidence = declaredAlias || bothHaveEvidence
  const hasDirectEvidence = hasSubstantiveEvidence

  /* ================= 定级 ================= */

  /*
   * ── same：名实皆同 ──
   * 两个条件必须同时满足：
   *   a) 名字层面有强信号（完全一致 / 中文一致 / 表层变体 / 显式别名 / 缩写）；
   *   b) **有实质证据**（见上方 hasSubstantiveEvidence）；
   *   c) 名字不存在冲突表述。
   *
   * 同族、年份相邻这类弱信号**绝不**能单独把关系推到这里。
   */
  const strongName = exactName || sameZh || surfaceVariant || declaredAlias || acronymHit
  if (strongName && hasSubstantiveEvidence && !nameConflict) {
    const extra = [
      subset && 'name_token_subset',
      ideaOverlap && 'core_idea_overlap',
      sharedEvidence && 'shared_evidence_text',
    ].filter(Boolean).length
    return {
      relation_type: 'same',
      confidence: clamp(0.6 + extra * 0.12),
      basis,
      reason: buildReason('same', basis, sharedRaw.length, bothHaveEvidence),
      evidence_ids: union,
      shared_quotes: sharedRaw,
      hasDirectEvidence,
    }
  }

  /*
   * ── alias：一个名字是另一个的严格子集，或缩写关系 ──
   * 「Tree of Thoughts」vs「Tree of Thoughts Search」这类，
   * 是同一方法的长短写法，不是两个方法。
   *
   * 同样受实质证据门槛约束——理由与 same 完全一致：
   * "名字是子集"也可以是两个不同方法（`ReAct` vs `ReAct for Web`
   * 可能是两个不同的工作）。没有证据就退回 related。
   */
  if ((subset || acronymHit) && hasSubstantiveEvidence && !nameConflict) {
    return {
      relation_type: 'alias',
      confidence: clamp(0.5 + (ideaOverlap ? 0.15 : 0) + (sharedEvidence ? 0.1 : 0)),
      basis,
      reason: buildReason('alias', basis, sharedRaw.length, bothHaveEvidence),
      evidence_ids: union,
      shared_quotes: sharedRaw,
      hasDirectEvidence,
    }
  }

  /*
   * ── 降级守卫 ──
   *
   * 到这里说明：要么名字层面没有强信号，要么名字强但**缺少实质证据**。
   * 两种情况都**不允许**升级成 same 或 alias。
   *
   * 这一条是本阶段的底线：命名不同但思想相近是完全可能的，
   * 而"到底是不是同一个"需要研究者读原文判断。工具不该替他下这个结论。
   * 唯一能绕过证据门槛的是 `alias_declared`（作者自己在名称里写了"又叫 X"），
   * 那是原文里的事实陈述，已在上面的 strongName 分支处理。
   */
  /*
   * 弱信号计数。这些信号"能说明两者有点像"，但都**不足以**支撑
   * "是同一个方法"的判断。计数只用来调 confidence，不参与是否升级。
   */
  const weakSignals = basis.filter(
    (x) =>
      x === 'same_family' ||
      x === 'same_task' ||
      x === 'core_idea_overlap' ||
      x === 'name_token_subset',
  ).length

  /*
   * ── related：有实质相似，值得让用户看一眼 ──
   *
   * 与 uncertain 的区别在于**信号的层次**：
   *   related   ← 至少有一个"内容层"信号：核心思想重合 / 名字词集包含 /
   *               逐字相同证据 / 名字强但卡证据门槛 / **同任务**
   *   uncertain ← 只有"分组层"信号：同族这种聚类信息
   *
   * 同任务算内容层：它说明两者在解同一类问题，用户值得看一眼。
   * 但它**不能**推到 same/alias —— 同一问题的解法可以完全不同。
   */
  if (
    ideaOverlap ||
    (subset && nameDice >= 0.5) ||
    sharedEvidence ||
    (strongName && !nameConflict) ||
    sameTask
  ) {
    return {
      relation_type: 'related',
      confidence: clamp(0.3 + weakSignals * 0.08 + (sharedEvidence ? 0.15 : 0) + (strongName ? 0.1 : 0)),
      basis,
      reason: buildReason('related', basis, sharedRaw.length, bothHaveEvidence),
      evidence_ids: union,
      shared_quotes: sharedRaw,
      hasDirectEvidence,
    }
  }

  /*
   * ── uncertain：有弱信号，但不足以判断 ──
   * 这是诚实兜底。它明确告诉用户"系统注意到了两者可能有关，
   * 但现有信息不足以给出判断"，而不是硬塞一个 related。
   */
  return {
    relation_type: 'uncertain',
    confidence: clamp(0.1 + weakSignals * 0.05 + nameDice * 0.1 + (yearGap ? 0.03 : 0)),
    basis: basis.length ? basis : (['year_gap'] as AlignmentBasis[]),
    reason: buildReason('uncertain', basis, sharedRaw.length, bothHaveEvidence),
    evidence_ids: union,
    shared_quotes: sharedRaw,
    hasDirectEvidence,
  }
}

const clamp = (n: number) => Math.min(1, Math.max(0, Number(n.toFixed(3))))

/**
 * 显式别名检测：一方的名字（或括号内的别名）出现在另一方的名字里。
 *
 * 例：`Combining ReAct and CoT-SC (ReAct ↔ CoT-SC)` 括号里明写了 `ReAct`，
 * 而另一方就叫 `ReAct` —— 这是**作者自己声明的别名**，属于直接证据，
 * 与"我们觉得名字像"有本质区别。
 */
/**
 * 显式别名检测：一方的名字（或括号内的别名）出现在另一方的名字里。
 *
 * 例：`Combining ReAct and CoT-SC (ReAct ↔ CoT-SC)` 括号里明写了 `ReAct`，
 * 而另一方就叫 `ReAct` —— 这是**作者自己声明的别名**，属于直接证据，
 * 与"我们觉得名字像"有本质区别。
 *
 * 匹配用**词级**相等而非整串相等：
 *   括号内容 `ReAct ↔ CoT-SC` 归一化后是 `react cot sc`，对方主名是 `react`。
 *   整串不相等，但它们共享实词 `react`。要求整串相等会让这类真实别名全漏掉。
 *
 * 但也不能放宽成"共享任意一个词"，否则 `X (with attention)`
 * 会被判成与任何含 attention 的方法同义。
 * 收紧方式是：**只检查括号内容**，且要求命中的词必须是
 * 另一方"实词集合"里的成员（停用词不算）。
 */
function detectDeclaredAlias(a: StoredMethod, b: StoredMethod): boolean {
  const innerA = [...parenthesized(a.name), ...parenthesized(a.name_zh)]
  const innerB = [...parenthesized(b.name), ...parenthesized(b.name_zh)]
  if (!innerA.length && !innerB.length) return false

  /** 一方的实词集合 + 整串（`ReAct` 这种单词名整串就是 `react`） */
  const headsOf = (s: string): Set<string> => {
    const set = new Set<string>()
    const whole = normalizeMethodName(s)
    if (whole) set.add(whole)
    for (const t of nameTokens(s)) set.add(t)
    return set
  }

  /** 括号内容里出现的实词（含整串归一化结果） */
  const mentions = (inner: string[]): Set<string> => {
    const set = new Set<string>()
    for (const p of inner) {
      const whole = normalizeMethodName(p)
      if (whole) set.add(whole)
      for (const t of nameTokens(p)) set.add(t)
    }
    return set
  }

  const headsA = headsOf(a.name)
  const headsB = headsOf(b.name)
  const inA = mentions(innerA)
  const inB = mentions(innerB)

  /*
   * A 的括号里提到了 B 的主名词 → 声明别名；
   * 或者 B 的括号里提到了 A 的主名词 → 同样成立。
   *
   * `ReAct (ReAct)` 这种同义反复会命中"自己提到自己"？不会——
   * 这里比的是**跨方**：只有 A 的括号撞上 B 的名才成立。
   * 自己提到自己既不在 inA∩headsB 也不在 inB∩headsA 里。
   */
  for (const t of inA) if (headsB.has(t)) return true
  for (const t of inB) if (headsA.has(t)) return true
  return false
}

/**
 * 找出双方证据里**逐字相同**的原文句。
 *
 * 为什么"逐字相同"才算：证据本身就是从论文原文摘出来的句子。
 * 两篇不同的论文里有完全相同的句子，只有两种可能——
 * 要么它们确实在描述同一个东西（作者复用了措辞/公式），
 * 要么其中一篇抄了另一篇。两种情况都值得用户看到。
 * 而"意思相近"的改写句不做匹配——那又回到需要语义模型的问题上了。
 */
function sharedQuoteTexts(
  a: StoredMethod,
  b: StoredMethod,
  evById: Map<string, StoredEvidence>,
  evPaper: Map<string, string>,
): string[] {
  const pb = primaryPaperId(b)

  /**
   * 取"确实属于该论文"的证据指纹。
   *
   * 这里要防的是一个具体的脏数据：`evidence.method_ids` 理论上只指向本论文的
   * 方法，但历史数据里出现过跨论文引用。如果不过滤，一条被错误挂到 A 上的
   * B 论文证据，会让 A、B 立刻"共享原文"——一个凭空的强信号。
   * 所以归属不明的（`evPaper` 里查不到的）一律不收。
   */
  const fingerprintsOf = (ids: string[], owner: string): Set<string> => {
    const s = new Set<string>()
    for (const id of ids) {
      const e = evById.get(id)
      if (!e) continue
      const belongs = evPaper.get(id)
      if (!belongs || belongs !== owner) continue
      const fp = quoteFingerprint(e.content)
      if (fp) s.add(fp)
    }
    return s
  }

  /*
   * 做法：把 A 的句子指纹放进集合，再用 B 去撞。
   * 方向固定（A→B）保证结果不依赖参数顺序，配合 orderPair 使输出确定。
   */
  const aFps = fingerprintsOf(a.evidence_ids, primaryPaperId(a))
  if (!aFps.size) return []

  const out: string[] = []
  for (const id of b.evidence_ids) {
    const e = evById.get(id)
    if (!e) continue
    const belongs = evPaper.get(id)
    if (!belongs || belongs !== pb) continue
    if (aFps.has(quoteFingerprint(e.content))) out.push(e.content)
  }
  return [...new Set(out)]
}

/** 生成可复述的中文解释。禁止返回空串或套话 */
function buildReason(
  type: AlignmentRelationType,
  basis: AlignmentBasis[],
  sharedCount: number,
  bothHaveEvidence = true,
): string {
  const label = (b: AlignmentBasis): string =>
    ({
      name_exact: '方法名完全相同',
      name_surface_variant: '方法名互为表层变体（大小写/标点/单复数差异）',
      name_token_subset: '一个方法名的词集是另一个的子集',
      name_zh_match: '中文名相同',
      alias_declared: '其中一方在名称里显式写出了另一方作为别名',
      acronym_match: '一方名称是另一方首字母缩写',
      core_idea_overlap: '核心思想描述高度重合',
      same_task: '任务/问题设定相同',
      same_family: '同属一个方法族',
      shared_evidence_text: `双方证据中存在逐字相同的原文（${sharedCount} 条）`,
      year_gap: '仅年份相近，无其他相似信号',
      name_conflict: '名称存在否定/竞争表述',
    })[b]

  const hits = basis.map(label).join('；')

  if (type === 'same') {
    return `判定为同一方法：${hits}。${sharedCount ? `另有 ${sharedCount} 条逐字相同的证据原文佐证。` : '双方均有独立证据，可支撑该判断。'}`
  }
  if (type === 'alias') {
    return `判定为别名关系：${hits}。属于同一方法的不同写法，未发现互相矛盾的表述。`
  }
  if (type === 'related') {
    /*
     * 关键的一条：当名字很像但**缺少实质证据**时，必须把"为什么没升级"
     * 说清楚，否则用户会以为工具没看到这个相似性。
     */
    const gate = !bothHaveEvidence
      ? '⚠️ 名称层面虽有强信号，但双方未各自挂载证据，缺乏实质支撑，故**不判定为同一方法**；'
      : ''
    return `判定为相关：${hits}。${gate}相似度足以提示用户关注，但不足以认定是同一方法，需人工判读原文。`
  }
  return `暂无法判断：${hits}。现有信号不足以支持任何更强的结论；不生成"改进/继承/演进"这类关系——那需要论文原文中直接的历史性声明。`
}
