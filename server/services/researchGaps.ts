/**
 * 研究空白检测（Phase 4-6）。
 *
 * ── 这个模块回答什么问题 ──
 * 一个项目里有若干论文与方法，用户在"研究空白"页想问的是：
 *   「这群论文自己承认了哪些做不到的事？有没有几篇论文**共同**暴露出的缺口？」
 * 本模块只做一件事：**从 Evidence 原文里读出缺口，并如实分层**。
 *
 * ── 与 4-4（技术演进）的分工 ──
 *   · 4-4 问"谁演进了谁" —— 是**方法之间**的关系，需要因果证据。
 *   · 4-6 问"还缺什么"     —— 是**领域层面**的缺口，证据来源是论文自述的局限。
 * 两者共用 4-2 的对齐结果（4-6 只把它当背景输入，不依赖它产出结论），
 * 但判定逻辑完全独立。4-6 也吃 4-4 的演进结果，用途见下方 `evolutionThemeBoost`。
 *
 * ── 本模块唯一的安全底线（等价于 4-4 的"年份不能推因果"）──
 *
 *   **所有 Gap 的 Evidence 都必须来自"某条原文自己写了缺口"。**
 *
 * 具体地说，本模块**绝不**产出"所有论文都没做 X，所以 X 是空白"这类
 * **否定性推断**。原因很简单也很致命：
 *
 *      "我们没有找到证据"  ≠  "确实不存在"
 *
 * 我手上只有 8 篇论文的摘要级证据。凭"这些材料里没人提过 X"去断言
 * "X 是研究空白"，是一个逻辑上不成立、而且极难被用户发现的编造 ——
 * 用户没法知道我是因为"整个领域都没有"还是"我们的语料恰好没覆盖"才这么说的。
 *
 * 所以本模块的能力被**刻意收缩**成：只做"证据的搬运与聚类"。
 * 每一条 Gap 都能指回一句**真人写下的、承认自己有局限的原文**。
 * 这也意味着：如果语料里没人承认局限，本模块就诚实地产出 0 条 Gap。
 * 这是一个**正确结果**，不是失败。
 *
 * ── 为什么必须是纯函数 ──
 * 与 relevance.ts / methodAlignment.ts / methodEvolution.ts 同一套理由：
 * 不读 config、不发请求、不碰文件、不取当前时间。测试可以直接跑它。
 */

import type { StoredEvidence, StoredMethod, StoredPaper } from '../types.ts'
import type { AlignmentCandidate } from './methodAlignment.ts'
import type { EvolutionRelation } from './methodEvolution.ts'
import { isCausalRelationType } from './methodEvolution.ts'

/* ------------------------------------------------------------------ */
/* 缺口信号类型：需求里那四个词，各成一类                                */
/* ------------------------------------------------------------------ */

/**
 * 缺口信号类型 —— 对应需求里的四类措辞。
 *
 * ── 为什么不复用前端的 `GapType`（method|data|evaluation|application）──
 *
 * 两套词汇回答的是**两个不同的问题**，硬合并会丢信息：
 *
 *   · `GapType`    回答"这个空白属于哪个**方面**"（方法/数据/评价/应用）
 *     —— 是给用户看的**分类标签**，G001「长周期任务的记忆能力不足」归 'method'。
 *   · `GapSignalType` 回答"这句话是**怎么**说缺口的"（自陈局限/未解决/缺比较/未覆盖）
 *     —— 是**判定的依据**，同一句 limitation 可以关于方法、也可以关于数据。
 *
 * 而且 `GapType` 四值里没有"缺失比较"这个语义（缺 baseline 属于 evaluation 还是 method？
 * 说不清），强行映射会引入一个我无法用证据支撑的猜测。
 * 所以另立一套，并在输出的 GapTypeGuess 里如实标注"这是**推测**，不写进正式字段"。
 *
 * 四个信号按"证据有多硬"排序，这个顺序也用于同分排序（越靠前越可信）。
 */
export type GapSignalType =
  /** 论文自己写出的局限 —— 最硬，作者亲口承认 */
  | 'limitation'
  /** 论文自己说"尚未解决 / 仍是开放问题" */
  | 'open_problem'
  /** 论文自己说"缺少与 X 的比较 / 没有 baseline" */
  | 'missing_comparison'
  /** 论文自己说"尚未在 X 场景验证 / 不能泛化到 Y" */
  | 'uncovered_setting'

export const GAP_SIGNAL_TYPES: readonly GapSignalType[] = [
  'limitation',
  'open_problem',
  'missing_comparison',
  'uncovered_setting',
] as const

export const isGapSignalType = (v: unknown): v is GapSignalType =>
  typeof v === 'string' && (GAP_SIGNAL_TYPES as readonly string[]).includes(v)

/**
 * 缺口被陈述的形态 —— **本模块的分层核心**。
 *
 * 需求原文：「明确区分"论文原文明确指出的局限"和"系统根据多篇论文推断出的候选 Gap"；
 *           推断型 Gap 必须标记 candidate，不能写成既定事实」
 *
 * 这两个取值的差别，就是"事实"与"线索"的差别：
 *   · `stated`    —— 一句原文，一个出处。**可以**说"论文指出"。
 *   · `candidate` —— 多条原文聚出的模式。**只能**说"系统观察到多篇论文都…"。
 */
export type GapAssertionLevel = 'stated' | 'candidate'

export const isGapAssertionLevel = (v: unknown): v is GapAssertionLevel =>
  v === 'stated' || v === 'candidate'

/* ------------------------------------------------------------------ */
/* 输入                                                                */
/* ------------------------------------------------------------------ */

/**
 * 缺口检测输入。
 *
 * ── 为什么把 4-2 / 4-4 的结果也收进来 ──
 *
 * 需求明确要求输入包含"方法关系、技术演进"。它们在本模块里的用途是**加权**，
 * 不是**判定** —— 这一点必须写清楚，否则很容易被误用成"有演进关系就产 Gap"：
 *
 *   · `alignments`：告诉我们"哪些方法其实是同一个东西"。
 *     用途：candidate 聚簇时**不要把同一方法的多次出现当成多篇论文的共同缺失**。
 *     （若 M001 在 P001 与 P002 里是同一个方法，那"两篇都提到同一局限"
 *      很可能只是同一篇工作的重复引用，不构成"多篇论文共同缺失"。）
 *
 *   · `evolutionRelations`：4-4 判出的**有证据的**因果链。
 *     用途见 `evolutionThemeBoost()`：一条被后续工作明确"改进"过的局限，
 *     说明它已经被注意到了 —— 它的**候选**程度应当降低，而不是升高。
 *     这是一个反直觉但重要的方向：**已被改进的局限不是好 Gap**。
 *
 * 两者都允许为空数组 —— 此时本模块退化为"纯证据扫描"，仍然正确工作。
 */
export interface GapInput {
  papers: StoredPaper[]
  methods: StoredMethod[]
  evidence: StoredEvidence[]
  alignments: AlignmentCandidate[]
  evolutionRelations: EvolutionRelation[]
}

/* ------------------------------------------------------------------ */
/* 判定依据                                                            */
/* ------------------------------------------------------------------ */

/**
 * 一条 Gap"凭什么"被判出来。供界面复核、供测试断言。
 *
 * 与 4-2 的 AlignmentBasis / 4-4 的 EvolutionBasis 同一思路：
 * 每个取值都要能让用户复述出判定过程，而不是面对一个没有出处的标签。
 */
export type GapBasis =
  /** 门 A：证据文本命中「局限」句式 */
  | 'explicit_limitation_statement'
  /** 门 A：证据文本命中「未解决 / 开放问题」句式 */
  | 'explicit_open_problem'
  /** 门 A：证据文本命中「缺失比较 / 无 baseline」句式 */
  | 'missing_comparison_statement'
  /** 门 A：证据文本命中「尚未覆盖的场景」句式 */
  | 'uncovered_setting_statement'
  /** 门 B：证据归属已校验（确属该论文） */
  | 'evidence_ownership_verified'
  /** 门 C：证据文本有实质内容（非空串、非纯符号） */
  | 'evidence_substantive_text'
  /** 该证据的 supports 里自带「研究空白」标注（上游抽取时的显式意图） */
  | 'evidence_declared_gap_support'
  /** 该证据的 supports 里自带「局限」标注 */
  | 'evidence_declared_limitation_support'
  /** 跨论文聚合：≥2 篇**不同**论文命中同一信号 */
  | 'multi_paper_shared_gap'
  /** 单篇论文自陈，未形成跨论文模式 */
  | 'single_paper_stated_only'
  /** 该缺口所涉方法已被后续工作明确改进 → 削弱其候选价值 */
  | 'addressed_by_later_work'
  /** 落到的场景主题（由场景词表确定性提取） */
  | 'theme_matched'
  /** 场景主题无法确定，落到 general */
  | 'theme_general'

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

/**
 * 一条研究空白。
 *
 * ── 与前端 `ResearchGap`（src/types/index.ts）的关系 ──
 *
 * **刻意不逐字段对齐**，只对齐能对齐的部分（title / description / evidence_ids /
 * method_ids / supporting_papers）。原因：前端 `ResearchGap` 里有
 * `existing_work` / `current_problem` / `potential_value` 三个字段，
 * 它们全部需要**综述级写作**才能填好 —— 那是 LLM 的活，不是确定性规则的活。
 * 用规则去硬凑这三个字段，产出的一定是看起来像模像样、实际空洞的套话，
 * 比留空更糟（用户会以为系统真的做过文献综述）。
 *
 * 所以本模块如实**不产出**它们，由前端决定怎么呈现"结构化的线索"。
 */
export interface ResearchGapFinding {
  /** 稳定 id，形如 GR001。同一输入必须产出同一 id */
  gap_id: string
  /**
   * 分层标记 —— **本模块最重要的字段**。
   * `stated` = 原文明确指出；`candidate` = 系统跨论文推断。
   */
  assertion_level: GapAssertionLevel
  /**
   * 便捷布尔。恒等于 `assertion_level === 'candidate'`。
   *
   * 需求原文用了"推断型 Gap 必须标记 candidate"，所以这个字段单独存在，
   * 让前端的 `gap.candidate === true` 这种写法直接可用，不必去解字符串。
   * 由 assertGapInvariants 强制它与 assertion_level 一致。
   */
  candidate: boolean
  /** 缺口信号类型（四类之一） */
  gap_signal: GapSignalType
  /** 缺口落到的场景主题（由场景词表确定性提取，可能为 'general'） */
  theme: string
  /** 标题。candidate 时必须以「【候选】」开头 —— 由不变量强制 */
  title: string
  /** 描述。candidate 时必须明写"系统推断" */
  description: string
  /** 支撑该 Gap 的证据 id，**恒非空**（这是本模块的硬门槛） */
  evidence_ids: string[]
  /** 涉及的论文 id（去重、排序） */
  paper_ids: string[]
  /** 涉及的方法 id（去重、排序） */
  method_ids: string[]
  /** 命中的判定依据，按重要性排序 */
  basis: GapBasis[]
  /**
   * 缺口属于哪个**方面**的推测（method/data/evaluation/application）。
   *
   * ⚠️ 字段名带 `_guess` 后缀是刻意的：这是一个**由措辞推出的弱推测**，
   * 不是从证据里读出来的事实。前端若要显示，必须同时显示"推测"字样。
   * 之所以还是给出来：完全不给的话，前端只能自己按 title 猜，猜得更差。
   */
  gap_type_guess: 'method' | 'data' | 'evaluation' | 'application'
  /** 置信度 0-1。stated 基线 0.8，candidate 基线 0.5 */
  confidence: number
}

/**
 * 统计。**分层分别计数**，不用一个"总数"糊过去。
 *
 * 理由与 4-2 / 4-4 的统计相同且在这里更强：
 * `stated`（论文白纸黑字承认的局限）与 `candidate`（我们聚出来的线索）
 * 对用户的含义完全不同 —— 前者可以直接引用，后者只能当研究方向参考。
 * 合并成一个数字会让"论文承认了 3 个局限"和"我们猜了 12 个空白"
 * 看起来一样重要。
 */
export interface GapStats {
  /** 原文明确指出的 Gap 数 */
  stated: number
  /** 系统推断的候选 Gap 数 */
  candidate: number
  /** = stated + candidate */
  total: number
  limitation: number
  open_problem: number
  missing_comparison: number
  uncovered_setting: number
  /** 涉及的不同论文数（去重） */
  papers_involved: number
  /** 涉及的不同方法数（去重） */
  methods_involved: number
  /** 场景主题数（去重，不含 general） */
  themes: number
  /**
   * 无证据的 Gap 数 —— **必须恒为 0**。
   *
   * 把它放进统计而不是只放在测试里（与 4-4 的 causal_without_evidence 同一考虑），
   * 是为了让"每个 Gap 都必须有 Evidence"这个不变量在**运行时**也随时可见：
   * 它一旦不为 0，接口返回的数据就自证其不可信，不需要等测试来发现。
   */
  gaps_without_evidence: number
  /**
   * 命中缺口句式但**不足以**形成 candidate 的单篇证据数。
   *
   * 单独上报的理由：这是"我们看见了线索但选择不下结论"的量化指标。
   * 它是 0 时，用户无从判断系统是真没看到还是没敢说。
   */
  single_paper_signals: number
  /** 被剔除的证据数（归属不明 / 无实质文本） */
  evidence_skipped: number
}

export interface GapOutcome {
  gaps: ResearchGapFinding[]
  stats: GapStats
  context: {
    papers: number
    methods: number
    evidence: number
    alignments_considered: number
    evolution_relations: number
    /** supports 里带「局限」或「研究空白」标注的证据数 —— 上游给的显式线索量 */
    evidence_with_gap_intent: number
    /** 语料里是否有任何一条证据带缺口意图（false 时 0 Gap 是预期的） */
    corpus_has_gap_intent: boolean
  }
  /** 规则集版本，便于溯源。标明是确定性规则，不让人误以为是模型产出 */
  rule_version: string
}

export const GAP_RULE_VERSION = 'deterministic-research-gap-v1'

/* ------------------------------------------------------------------ */
/* 门 A：缺口句式词表（中英各一套）                                      */
/* ------------------------------------------------------------------ */

/**
 * 缺口句式词表（门槛 A）。
 *
 * ── 三条设计纪律，都是被误判逼出来的 ──
 *
 * 1. **必须内建"缺口标记词"，不能只匹配裸动词。**
 *    裸写 `\bstruggle\b` 会吞掉
 *        "we compare with methods that struggle on long tasks"  ← 在说别人不行
 *    我们要的是论文**自陈**的局限，所以每条规则都要么自带
 *    limitation/challenge/remains/尚未 这类缺口名词，
 *    要么自带否定/缺失标记（no / lacks / without / not yet）。
 *
 * 2. **刻意排除"未来工作"句。**
 *    "In future work, we plan to extend X" 不是局限，是路线图。
 *    虽然它常和局限写在同一段，但把它当 Gap 会让每条论文的
 *    "future work" 段都变成一堆 Gap。这里用负面先行断言把它挡掉。
 *
 * 3. **不做词干还原。**
 *    理由与 4-4 完全相同：`\bchalleng\w*` 这种宽通配会放过
 *    "challenges the assumption"（是挑战别人的假设，不是暴露局限）。
 *    显式枚举更**可审计** —— 出了问题能一眼看出是哪条规则放过的。
 *
 * 中英各一套：本项目的证据既有英文原文（content），也有中文释义（translation），
 * 两边都要能命中，否则中文语料永远产出不了 Gap。
 */
const GAP_PATTERNS: Record<GapSignalType, RegExp[]> = {
  /* ── 局限：作者亲口承认的能力边界 ── */
  limitation: [
    /\blimitation(?:s)?\b/i,
    /\blimited\s+(?:to|by|in)\b/i,
    /\bsuffer(?:s|ed)?\s+from\b/i,
    /\bstruggl(?:e|es|ed|ing)\s+(?:with|to)\b/i,
    /\bfail(?:s|ed)?\s+to\b/i,
    /\bcannot\s+(?:handle|deal|generalize|scale)\b/i,
    /\bis\s+not\s+robust\b/i,
    /\bremains?\s+(?:a\s+)?(?:challeng|difficult|hard|unsolved)/i,
    /\bis\s+still\s+(?:an?\s+)?(?:open|unsolved)/i,
    /\bdrop\s+in\s+performance\b/i,
    /\bdegrade(?:s|d)?\s+(?:sharply|significantly|rapidly)\b/i,
    /局限/,
    /不足之处/,
    /仍有待/,
    /表现挣扎/,
    /无法/,
    /难以/,
  ],

  /* ── 未解决：作者明说"这件事还没人做" ── */
  open_problem: [
    /\bopen\s+(?:problem|question|challenge)\b/i,
    /\bremains?\s+(?:an?\s+)?open\b/i,
    /\bhas\s+not\s+(?:yet\s+)?been\s+(?:addressed|explored|studied|solved)\b/i,
    /\bhave\s+not\s+(?:yet\s+)?been\s+(?:addressed|explored|studied|solved)\b/i,
    /\bis\s+not\s+(?:yet\s+)?(?:well\s+)?understood\b/i,
    /\byet\s+to\s+be\b/i,
    /\bno\s+principled\s+(?:method|way|approach|framework)\b/i,
    /\bunexplored\b/i,
    /\bunderexplored\b/i,
    /尚未/,
    /尚无/,
    /仍有待解决/,
    /还未/,
    /仍是开放问题/,
  ],

  /* ── 缺失比较：没有对照 / 没有 baseline ── */
  missing_comparison: [
    /\b(?:no|without|lacks?|lacking)\s+(?:a\s+)?(?:direct\s+)?comparison\b/i,
    /\bno\s+(?:fair|direct|systematic)\s+(?:comparison|baseline|benchmark)\b/i,
    /\blacks?\s+(?:a\s+)?(?:baseline|comparison|benchmark|ablation)\b/i,
    /\bcannot\s+be\s+(?:directly\s+)?compared\b/i,
    /\bnot\s+(?:directly\s+)?comparable\b/i,
    /\bno\s+standard(?:ized)?\s+(?:benchmark|evaluation|dataset)\b/i,
    /\bwithout\s+(?:a\s+)?baseline\b/i,
    /\bcomparison\s+(?:is|remains)\s+(?:missing|absent|difficult)\b/i,
    /缺乏.{0,10}对比/,
    /没有.{0,10}基准/,
    /缺少.{0,10}比较/,
    /无法直接比较/,
  ],

  /* ── 尚未覆盖的场景：没在这个设定下验证过 ── */
  uncovered_setting: [
    /\bhas\s+not\s+been\s+(?:evaluated|tested|validated|applied)\s+(?:on|in|to)\b/i,
    /\bhave\s+not\s+been\s+(?:evaluated|tested|validated|applied)\s+(?:on|in|to)\b/i,
    /\bdoes\s+not\s+(?:generalize|transfer|extend)\s+to\b/i,
    /\bdo\s+not\s+(?:generalize|transfer|extend)\s+to\b/i,
    /\bnot\s+(?:yet\s+)?(?:been\s+)?(?:applied|tested|explored)\s+(?:in|to|on)\b/i,
    /\brestricted\s+to\b/i,
    /\bonly\s+(?:been\s+)?(?:evaluated|tested|studied|applied)\s+(?:on|in)\b/i,
    /\bout\s+of\s+(?:the\s+)?scope\b/i,
    /\bbeyond\s+the\s+scope\b/i,
    /尚未在/,
    /未在.{0,12}(?:场景|环境|设定)/,
    /不能泛化/,
    /仅.{0,10}验证/,
  ],
}

/**
 * 未来工作句 —— **负面过滤器**。
 *
 * 命中这些模式，说明这句话是在描述**计划**而不是**缺口**。
 * 之所以做成独立的负面过滤器而不是写进上面每一条规则里：
 * 未来工作句可能同时命中多条缺口规则，逐条加负向断言会很啰嗦且容易漏；
 * 集中在一处过滤，行为可预测、可单独测试。
 *
 * 注意：只过滤"计划做"的口吻，不过滤"我们没做"的口吻。
 * "we leave X to future work" 在学术写作里是**承认局限**的常见委婉说法，
 * 它是真实的 Gap，不能被过滤掉 —— 所以这个词组刻意**不**在负面表里。
 */
const FUTURE_WORK_PATTERNS: RegExp[] = [
  /\bin\s+future\s+work\s*,?\s*we\s+(?:plan|will|intend|aim)\b/i,
  /\bwe\s+(?:plan|intend|aim)\s+to\b/i,
  /\bwe\s+will\s+(?:extend|explore|investigate|address)\b/i,
  /\bfuture\s+work\s+(?:should|will)\s+(?:explore|address|investigate)\b/i,
  /\bleft\s+(?:as\s+)?(?:a\s+)?future\s+(?:work|direction)\b/i,
  /未来工作.{0,20}(?:计划|将|拟)/,
  /我们计划/,
  /后续将/,
]

/* ------------------------------------------------------------------ */
/* 场景主题词表                                                        */
/* ------------------------------------------------------------------ */

/**
 * 场景主题词表 —— candidate 聚簇的判等键来源。
 *
 * ── 为什么需要它 ──
 * "多篇论文共同缺失"要能判出"共同"在哪里。最自然的想法是"同一种缺口措辞"，
 * 但那样几乎所有 limitation 都会聚成一坨（"局限"这个词太泛），
 * 产出的 candidate 毫无信息量。
 *
 * 所以聚簇键 = (缺口信号类别, 场景主题)。场景主题从证据文本里按这张**受控词表**
 * 确定性提取 —— 不用 LLM、不用统计模型，就是字符串包含。
 * 代价是覆盖不全（表外的场景归 general），收益是 100% 可复现、可审计。
 *
 * ── 为什么词表是"领域概念"而不是"通用词" ──
 * 只有真正区分研究场景的概念才进这张表。像 "task" / "method" / "model"
 * 这类词遍地都是，放进来会让所有证据聚成同一个 theme，等于没有 theme。
 */
const THEME_PATTERNS: { theme: string; label: string; re: RegExp }[] = [
  { theme: 'long_horizon', label: '长周期 / 多步任务', re: /long[- ]?horizon|long[- ]?term|many[- ]?step|consecutive\s+steps|数十步|长周期|连续多步/i },
  { theme: 'repository_level', label: '仓库级代码修改', re: /repository[- ]?level|repo[- ]?level|whole[- ]?repository|codebase[- ]?wide|仓库级/i },
  { theme: 'multi_agent', label: '多 Agent 协作', re: /multi[- ]?agent|multiple\s+agents|agent\s+collaboration|多\s*agent|多智能体/i },
  { theme: 'memory_context', label: '记忆与上下文管理', re: /\bmemory\b|context\s+(?:window|management|budget|length)|paging|分页|上下文管理|记忆/i },
  { theme: 'tool_use', label: '工具调用', re: /tool[- ]?use|tool[- ]?calling|function\s+calling|api\s+call|工具调用/i },
  { theme: 'search_planning', label: '搜索与规划', re: /\bsearch\b|\bplanning\b|backtrack|tree\s+of\s+thoughts|规划|搜索|回溯/i },
  { theme: 'evaluation_bench', label: '评测与基准', re: /benchmark|evaluation\s+suite|test\s+suite|metric|基准|评测|指标/i },
  { theme: 'cost_efficiency', label: '成本与效率', re: /\bcost\b|token\s+budget|latency|efficien|开销|成本|效率/i },
  { theme: 'safety_security', label: '安全与可靠性', re: /security|safety|vulnerab|malicious|安全|可靠性/i },
  { theme: 'feedback_signal', label: '反馈信号质量', re: /feedback\s+signal|external\s+feedback|sparse\s+reward|ground\s+truth|反馈信号|外部信号/i },
  { theme: 'generalization', label: '泛化能力', re: /generaliz|transfer\s+to|cross[- ]?(?:domain|language|project)|泛化|跨领域/i },
]

const THEME_LABEL = new Map(THEME_PATTERNS.map((t) => [t.theme, t.label]))

/** 从证据文本里确定性提取场景主题。命中多个时取**词表定义顺序**中第一个 —— 顺序即优先级 */
function detectTheme(text: string): { theme: string; label: string } {
  for (const t of THEME_PATTERNS) {
    if (t.re.test(text)) return { theme: t.theme, label: t.label }
  }
  return { theme: 'general', label: '通用场景' }
}

/* ------------------------------------------------------------------ */
/* 缺口方面的弱推测                                                     */
/* ------------------------------------------------------------------ */

/**
 * 由**缺口措辞**反推它属于哪个方面（method/data/evaluation/application）。
 *
 * ⚠️ 这是本模块里**唯一一个不来自证据的字段**，所以：
 *   1. 字段名带 `_guess` 后缀，调用方一眼能看出是推测；
 *   2. 只用于前端排序/分组等辅助用途，**不写进任何正式结论**；
 *   3. 判定规则刻意做得极简（关键词归属），因为越"聪明"越容易显得权威而实际不可靠。
 */
function guessGapType(signal: GapSignalType, text: string): ResearchGapFinding['gap_type_guess'] {
  /* 缺失比较 / 评测基准 / 指标 → 评价方面 */
  if (signal === 'missing_comparison') return 'evaluation'
  if (/benchmark|evaluation|metric|baseline|基准|评测|指标/i.test(text)) return 'evaluation'
  /* 数据相关 */
  if (/dataset|corpus|annotation|数据|语料|标注/i.test(text)) return 'data'
  /* 未覆盖场景 → 应用方面 */
  if (signal === 'uncovered_setting') return 'application'
  if (/real[- ]?world|deployment|production|场景|落地|部署/i.test(text)) return 'application'
  /* 其余（局限 / 未解决）默认归方法方面 */
  return 'method'
}

/* ------------------------------------------------------------------ */
/* 命中检测                                                            */
/* ------------------------------------------------------------------ */

interface SignalHit {
  signal: GapSignalType
  evidence_id: string
  paper_id: string
  quote: string
  trigger: string
  theme: string
  theme_label: string
}

/**
 * 门 C：证据文本有实质内容（防空串、纯符号、纯空白）。
 *
 * ⚠️ 判据必须同时看 `content` **和** `translation`，不能只看 content。
 *
 * 踩到的坑：最初只判 `ev.content`。但 content 是 PDF 抽取的英文原句，
 * 真实数据里它可能很短（图注、表格标题、被截断的片段），
 * 而 translation 是完整的释义 —— 那种情况下缺口信息全在 translation 里。
 * 只看 content 会把这类证据整体丢掉，**而且丢得很安静**
 * （stats.evidence_skipped 会涨，但没人会去查为什么涨）。
 *
 * 所以判据改为"两者合起来有实质内容"。这不会放宽标准：
 * 合起来仍不足 12 字符或没有字母/汉字，照样拒绝。
 */
function isSubstantive(text: string): boolean {
  const t = (text || '').trim()
  if (t.length < 12) return false // 短于 12 字符的片段不足以承载一个缺口陈述
  return /[a-zA-Z\u4e00-\u9fa5]/.test(t) // 必须含字母或汉字
}

/** 证据是否有可分析的实质文本（content 与 translation 合并判定，见 isSubstantive 注释） */
function evidenceHasSubstance(ev: StoredEvidence): boolean {
  return isSubstantive(ev.content) || isSubstantive(ev.translation)
}

/**
 * 判定一条证据暴露了哪些缺口。
 *
 * ── 为什么返回数组而不是单个信号（与 4-4 的关键差异）──
 *
 * 4-4 的 detectEvolutionSignal 在多类型命中时**取最强的一个** ——
 * 因为"两个方法的关系"是单一事实，只能有一种类型。
 *
 * 但缺口不是二选一：一条证据经常同时说"我们缺 baseline「而且」没在真实仓库上验证"。
 * 这两个是**两个真实的、独立的缺口**，强行取最强会凭空丢掉一半信息。
 * 所以这里返回**每个命中信号各一条**，multi-label。
 *
 * 同一信号命中多条规则时只产出一条（避免一条证据把同一个缺口报两遍），
 * 但把**所有**命中的规则都记进 trigger 便于复核。
 */
function detectGapSignals(ev: StoredEvidence): SignalHit[] {
  if (!evidenceHasSubstance(ev)) return []

  const bilingual = `${ev.content} ${ev.translation}`
  const theme = detectTheme(bilingual)

  for (const fw of FUTURE_WORK_PATTERNS) {
    if (fw.test(bilingual)) return [] // 未来工作句整体跳过（见 FUTURE_WORK_PATTERNS 注释）
  }

  const hits: SignalHit[] = []
  for (const signal of GAP_SIGNAL_TYPES) {
    const matched = GAP_PATTERNS[signal].filter((r) => r.test(bilingual))
    if (!matched.length) continue
    hits.push({
      signal,
      evidence_id: ev.evidence_id,
      paper_id: ev.paper_id,
      quote: ev.content,
      trigger: matched.map((r) => (bilingual.match(r) ?? [''])[0]).filter(Boolean).join(' / '),
      theme: theme.theme,
      theme_label: theme.label,
    })
  }
  return hits
}

/**
 * 该证据是否被上游标注过"缺口意图"。
 *
 * `supports` 里带「局限」或「研究空白」，说明阶段③ 的抽取模型当时就认为
 * 这条证据是在讲缺口。它是一个**独立于句式匹配**的信号：
 * 有些证据的措辞很委婉（"we leave X for future work" 之外还有更绕的说法），
 * 句式可能漏掉，但标注捕捉到了。之所以不直接拿它当判定依据（只用来加权）：
 * 它是模型判断，不是原文事实，不能单独支撑一条结论。
 */
function hasGapIntent(ev: StoredEvidence): boolean {
  return ev.supports.includes('局限') || ev.supports.includes('研究空白')
}

/* ------------------------------------------------------------------ */
/* 跨论文候选的判定                                                    */
/* ------------------------------------------------------------------ */

/**
 * 被后续工作明确改进过的方法（4-4 的因果边指向它）。
 *
 * ── 为什么"已被改进的局限"要**降权**，而不是升权 ──
 *
 * 直觉容易反过来：看到"论文 A 说 X 不行，论文 B 说我们改进了 X"，
 * 会想"这个缺口被点了两次，应该更可信"。但**研究空白**的语义不是"被提到的次数多"，
 * 而是"**到当前为止仍未解决**"。
 *
 * 一个已经被后续工作明确声称解决的方向，作为"待研究的空白"价值更低 ——
 * 把它和真正无人触及的缺口并列推荐，会浪费用户的时间，
 * 而且是在**用证据支持一个已经过时的结论**，这比没给证据更糟。
 *
 * 所以：命中了因果边的局限，其候选置信度下调，并在 basis 里写明原因，
 * 让用户能看到"为什么这条被降权了"。
 */
function addressedMethods(relations: EvolutionRelation[]): Set<string> {
  const s = new Set<string>()
  for (const r of relations) {
    // 只用**有证据的因果边**。temporal/related 不构成"已被改进"。
    if (!isCausalRelationType(r.relation_type) || !r.evidence_ids.length) continue
    // 被改进的是 target（前驱，即更早的那个方法）
    s.add(r.target_method_key)
  }
  return s
}

/**
 * 4-2 判为"同一方法 / 别名"的方法身份键集合。
 *
 * 用途：candidate 聚簇时，如果两条证据分别挂在**被判定为同一方法**的两个身份上，
 * 那"两篇论文都提到这个局限"很可能只是同一项工作的重复引用，
 * 不构成"多篇论文共同缺失"。这类聚簇要被拦下。
 *
 * 注意：这是一个**保守**的过滤（宁可少产出 candidate，也不多产）——
 * 与 4-4 的"宁可产出 100 条 temporal，也不产 1 条无证据的 extends"同一立场。
 */
function aliasLinkedKeys(alignments: AlignmentCandidate[]): { keys: Set<string>; groups: string[][] } {
  const keys = new Set<string>()
  const groups: string[][] = []
  for (const c of alignments) {
    if (c.relation_type !== 'same' && c.relation_type !== 'alias') continue
    const a = `${c.source.paper_id}::${c.source.method_id}`
    const b = `${c.target.paper_id}::${c.target.method_id}`
    keys.add(a)
    keys.add(b)
    groups.push([a, b])
  }
  return { keys, groups }
}

/** 两个方法身份是否被 4-2 直接判为同一方法 */
function isAliasPair(a: string, b: string, groups: string[][]): boolean {
  return groups.some((g) => g.includes(a) && g.includes(b))
}

/* ------------------------------------------------------------------ */
/* 主体逻辑                                                            */
/* ------------------------------------------------------------------ */

/** 中间态：一条 stated Gap 的材料 */
interface StatedDraft {
  signal: GapSignalType
  theme: string
  theme_label: string
  evidence: StoredEvidence
  hit: SignalHit
  basis: GapBasis[]
  confidence: number
  /* 聚簇键的组成：该证据关联的每个方法身份 */
  methodKeys: string[]
  methodIds: string[]
  paperId: string
}

/**
 * 检测研究空白。
 *
 * 五步：
 *   ① 建索引 + 过滤不可用证据（如实统计被剔除量）
 *   ② 逐条证据扫缺口信号 → 每条命中产出一条 stated 草稿
 *   ③ 按 (信号, 场景主题) 聚簇；跨 ≥2 篇论文且**非同一方法** → 升级为 candidate
 *   ④ 排序 → 统一编号（先排序后编号，与 4-2 / 4-4 同一条纪律）
 *   ⑤ 统计 + 组装
 */
export function detectGaps(input: GapInput): GapOutcome {
  const { papers, methods, evidence, alignments, evolutionRelations } = input

  const paperById = new Map(papers.map((p) => [p.paper_id, p]))
  const methodById = new Map(methods.map((m) => [m.method_id, m]))
  const addressed = addressedMethods(evolutionRelations)
  const { groups: aliasGroups } = aliasLinkedKeys(alignments)

  /* ── ① 过滤 + 统计 ── */
  let evidenceSkipped = 0
  const usable: StoredEvidence[] = []
  for (const ev of evidence) {
    /*
     * 门 B：证据归属校验。
     *
     * 与 4-4 的 evidenceBelongsTo 同一动机：防"证据被错挂到别的论文上"。
     * 这里的判据是"证据声明的 paper_id 必须指向一篇真实存在的论文"。
     * 归属不明的证据一律不收 —— 宁可漏检，不可产出一条说不出出处的 Gap。
     */
    if (!ev.paper_id || !paperById.has(ev.paper_id)) {
      evidenceSkipped++
      continue
    }
    /* 门 C：文本必须有实质内容（content 与 translation 合并判定） */
    if (!evidenceHasSubstance(ev)) {
      evidenceSkipped++
      continue
    }
    usable.push(ev)
  }

  const evidenceWithGapIntent = usable.filter(hasGapIntent).length

  /* ── ② 扫描 → stated 草稿 ── */
  const statedDrafts: StatedDraft[] = []

  for (const ev of usable) {
    const hits = detectGapSignals(ev)
    for (const hit of hits) {
      /*
       * 方法身份。证据的 method_ids 可能为空的（比如一条纯讨论性质的证据）。
       * 空也不阻断 —— Gap 是**领域层面**的结论，不强制挂在具体方法上。
       * 这一点与 4-4 不同：那里没有方法就构不成关系，这里没有方法仍然构成缺口。
       */
      const methodIds = [...ev.method_ids].filter((id) => methodById.has(id)).sort()
      const methodKeys = methodIds.map((id) => `${ev.paper_id}::${id}`)

      const basis: GapBasis[] = ['explicit_limitation_statement']
      basis[0] =
        hit.signal === 'limitation'
          ? 'explicit_limitation_statement'
          : hit.signal === 'open_problem'
            ? 'explicit_open_problem'
            : hit.signal === 'missing_comparison'
              ? 'missing_comparison_statement'
              : 'uncovered_setting_statement'
      basis.push('evidence_ownership_verified', 'evidence_substantive_text')
      if (ev.supports.includes('研究空白')) basis.push('evidence_declared_gap_support')
      if (ev.supports.includes('局限')) basis.push('evidence_declared_limitation_support')
      basis.push(hit.theme === 'general' ? 'theme_general' : 'theme_matched')

      /* 已经被后续工作明确改进过的局限 → 降权（见 addressedMethods 注释） */
      const isAddressed = methodKeys.some((k) => addressed.has(k))
      if (isAddressed) basis.push('addressed_by_later_work')

      /*
       * stated 的置信度基线 0.8（原文写得清清楚楚）。
       * 三条微调，每条都有明确理由：
       *   · +0.1  上游标注了「研究空白」→ 句式与标注双重确认
       *   · -0.2  已被后续工作改进 → 事实成立但作为"待研究空白"的价值降低
       *   · ×ev.confidence 的弱影响：证据本身的抽取置信度应当传递下来
       *     （用 (0.5 + c/2) 而不是直接乘 c，避免一条 0.6 的证据把结论压得太低 ——
       *      句式命中是硬事实，不该被抽取置信度主导）
       */
      let confidence = 0.8
      if (ev.supports.includes('研究空白')) confidence += 0.1
      if (isAddressed) confidence -= 0.2
      confidence *= 0.5 + Math.max(0, Math.min(1, ev.confidence)) / 2
      confidence = Math.max(0.05, Math.min(0.99, Number(confidence.toFixed(4))))

      statedDrafts.push({
        signal: hit.signal,
        theme: hit.theme,
        theme_label: hit.theme_label,
        evidence: ev,
        hit,
        basis,
        confidence,
        methodKeys,
        methodIds,
        paperId: ev.paper_id,
      })
    }
  }

  /* ── ③ 先落 stated（每条证据一条），再聚簇产 candidate ── */

  /*
   * ── 这里的结构选择是本模块最需要解释的一处 ──
   *
   * 直觉写法是"聚簇后要么产 candidate、要么产 stated"（二选一）。
   * 我第一版就是这么写的，结果测试立刻抓到问题：
   * 三篇论文各有一条 limitation 时，**三条 stated 全部消失**，只剩一条 candidate。
   *
   * 这是错的，而且错得很隐蔽 —— 用户看到的 Gap 数变少了，看起来"更简洁"，
   * 但真实损失是：**每一篇论文自己的原始出处被吞掉了**。
   * 用户点开那条 candidate，看到三条证据混在一起，
   * 再也分不清"哪句话是哪篇论文说的"。
   * 而需求明确要求"明确区分论文原文明确指出的局限 和 系统推断出的候选 Gap" ——
   * 这个区分要能**同时看到**，不是用后者替换前者。
   *
   * 所以改成**两层都产**：
   *   · 第一层：每条声称缺口的证据各产出一条 stated —— 这是原始事实层，粒度 = 1 条证据
   *   · 第二层：把跨论文的 stated 聚成 candidate —— 这是模式层，粒度 = 一个语义坐标
   *
   * 两层的 evidence_ids 是**包含关系**（candidate 的证据 = 成员 stated 的证据之并集），
   * 且 candidate **绝不引入新证据**。这不是重复报数：
   * stated 回答"论文说了什么"，candidate 回答"几篇论文都在说什么"，
   * 是两个不同粒度的真问题。统计里分开计数，前端可以只显示 candidate 或两者都显示。
   */

  const gaps: ResearchGapFinding[] = []

  /* 第一层：逐条 stated。顺序先按内容定死（与输入顺序无关） */
  const statedSorted = [...statedDrafts].sort(
    (a, b) =>
      cmp(a.evidence.evidence_id, b.evidence.evidence_id) ||
      cmp(a.signal, b.signal) ||
      cmp(a.paperId, b.paperId),
  )

  for (const d of statedSorted) {
    const signalLabel = SIGNAL_LABEL[d.signal]
    gaps.push({
      gap_id: '',
      assertion_level: 'stated',
      candidate: false,
      gap_signal: d.signal,
      theme: d.theme,
      title: `${d.theme_label}：${signalLabel}`,
      description: `论文 ${d.paperId} 在正文中明确指出：${d.hit.quote}`,
      evidence_ids: [d.evidence.evidence_id],
      paper_ids: [d.paperId],
      method_ids: [...d.methodIds],
      basis: [...d.basis, 'single_paper_stated_only'],
      gap_type_guess: guessGapType(d.signal, `${d.hit.quote} ${d.evidence.translation}`),
      confidence: d.confidence,
    })
  }

  /* 第二层：聚簇 → candidate */

  /*
   * 聚簇键 = `信号::场景主题`。
   *
   * ⚠️ 这里**不能用**方法名或方法 id 做键。
   * 4-4 判演进关系时用的是 `paper_id::method_id` 这种**身份键**，
   * 那是因为它判的是"同两个方法之间"的关系。
   * 但本模块判的是"多篇论文共同缺失" —— 不同论文对同一问题的命名天然不同，
   * 用方法名做键会永远聚不起来，candidate 恒为 0。
   * 所以用"缺口的语义坐标"（哪类信号 + 哪个场景）做键，这才是可比的。
   */
  const clusters = new Map<string, StatedDraft[]>()
  for (const d of statedDrafts) {
    const key = `${d.signal}::${d.theme}`
    const arr = clusters.get(key)
    if (arr) arr.push(d)
    else clusters.set(key, [d])
  }

  let singlePaperSignals = 0

  for (const [, members] of clusters) {
    /* 稳定排序：证据 id → 论文 id → 方法身份键。全是内容派生，与输入顺序无关 */
    members.sort(
      (a, b) =>
        cmp(a.evidence.evidence_id, b.evidence.evidence_id) ||
        cmp(a.paperId, b.paperId) ||
        cmp(a.methodKeys.join(','), b.methodKeys.join(',')),
    )

    const distinctPapers = [...new Set(members.map((m) => m.paperId))].sort()

    const evidenceIds = [...new Set(members.map((m) => m.evidence.evidence_id))].sort()
    const methodIds = [...new Set(members.flatMap((m) => m.methodIds))].sort()
    const theme = members[0].theme
    const themeLabel = members[0].theme_label
    const signal = members[0].signal

    /*
     * 跨论文判定 —— 三个条件**全部**满足才升级为 candidate：
     *
     *   (a) 至少 2 篇**不同**论文；
     *   (b) 这些论文的方法身份**不是同一方法**（否则是同一工作的重复引用）；
     *   (c) 至少 2 条不同的证据（同一句被复制成两条证据不算两个模式）。
     *
     * 三条件缺一不可。少任何一条，产出的"共同缺失"都是假共同。
     */
    const hasMultiplePapers = distinctPapers.length >= 2
    const hasMultipleEvidence = evidenceIds.length >= 2
    const isSameWork = isSameMethodAcrossPapers(members, aliasGroups)
    const isCandidate = hasMultiplePapers && hasMultipleEvidence && !isSameWork

    /*
     * 数一遍"看见了但没敢下结论"的单篇信号。
     * 这不是错误指标，是**诚实性指标**：它让用户知道系统是在"保守地没说"
     * 而不是"根本没看到"。为 0 时用户才有理由怀疑召回。
     */
    if (!isCandidate) singlePaperSignals += members.length
    /* 即使聚成了 candidate，簇内也可能有未参与聚合的落单成员 —— 一并如实计数 */
    else if (distinctPapers.length < members.length) singlePaperSignals += members.length - distinctPapers.length

    /* 单篇自述不产 candidate —— 见下方断言（candidate 必须 ≥2 篇论文） */
    if (!isCandidate) continue

    const basis: GapBasis[] = [
      'explicit_limitation_statement',
      'evidence_ownership_verified',
      'evidence_substantive_text',
      'multi_paper_shared_gap',
      ...(theme === 'general' ? (['theme_general'] as GapBasis[]) : (['theme_matched'] as GapBasis[])),
    ]

    /*
     * candidate 置信度 = 成员置信度均值 × 0.7。
     *
     * 乘 0.7 是刻意的**双重折价**：均值已经把"多条证据"的信号吸收了一部分，
     * 再乘 0.7 是为了让 candidate 在数值上也**明显低于** stated 的 0.8 基线。
     * 需求要求"推断型不能写成既定事实"，数字上也必须体现这一点 ——
     * 否则前端按 confidence 排序时，candidate 会盖过 stated，与分层语义相反。
     *
     * 用均值而不是最大值/求和，是为了不让"多复制几条证据"抬高置信度。
     */
    const meanConfidence =
      members.reduce((s, m) => s + m.confidence, 0) / Math.max(1, members.length)
    const confidence = Math.max(0.05, Math.min(0.69, Number((meanConfidence * 0.7).toFixed(4))))

    const signalLabel = SIGNAL_LABEL[signal]
    const paperLabel = distinctPapers.join('、')

    /*
     * 文案分层 —— 这是"不写成既定事实"的落点。
     *
     * stated 的措辞是「论文指出」，因为那确实是原文写的（在第一层里）。
     * candidate 的措辞必须是「系统观察到多篇论文都…，**推断**存在…，**需进一步确认**」，
     * 且标题前缀「【候选】」—— 让用户在任何视图下（哪怕只看标题）
     * 都无法把推断误读成事实。
     */
    gaps.push({
      gap_id: '',
      assertion_level: 'candidate',
      candidate: true,
      gap_signal: signal,
      theme,
      title: `【候选】多篇论文共同提及的${themeLabel}缺口（${signalLabel}）`,
      description: `系统在 ${distinctPapers.length} 篇不同论文（${paperLabel}）的证据中，观察到同一类「${signalLabel}」表述，且场景均落在「${themeLabel}」。这构成一个**推断的候选缺口**，而非任何单篇论文的既有结论 —— 是否成立需要进一步确认。依据原文：「${members[0].hit.quote}」`,
      evidence_ids: evidenceIds,
      paper_ids: distinctPapers,
      method_ids: methodIds,
      basis,
      gap_type_guess: guessGapType(signal, `${members[0].hit.quote} ${members[0].evidence.translation}`),
      confidence,
    })
  }

  /* ── ④ 排序 → 编号 ── */

  /*
   * 排序键全部由**内容**算出，禁止依赖发现顺序。
   *
   * 顺序设计的意图（从最重要的排到最次要的）：
   *   1. stated 优先于 candidate —— 事实优先于推断
   *   2. 信号类型（limitation > open_problem > missing_comparison > uncovered_setting）
   *   3. 置信度降序
   *   4. 论文数降序（涉及论文越多，越值得关注）
   *   5. gap_signal + theme + evidence_ids 串 兜底，保证同分时稳定
   *
   * 第 5 条是必须的：前四键都可能相同（比如两个 stated limitation 置信度都是 0.8），
   * 那时若落到"发现顺序 id"就会随输入数组顺序变化 —— 这正是 4-2 咬过一口的坑。
   */
  gaps.sort(
    (a, b) =>
      LEVEL_RANK[a.assertion_level] - LEVEL_RANK[b.assertion_level] ||
      SIGNAL_RANK[a.gap_signal] - SIGNAL_RANK[b.gap_signal] ||
      b.confidence - a.confidence ||
      b.paper_ids.length - a.paper_ids.length ||
      cmp(a.gap_signal, b.gap_signal) ||
      cmp(a.theme, b.theme) ||
      cmp(a.evidence_ids.join(','), b.evidence_ids.join(',')),
  )

  gaps.forEach((g, i) => {
    g.gap_id = `GR${String(i + 1).padStart(3, '0')}`
  })

  /* ── ⑤ 统计 + 组装 ── */

  /*
   * 统计走 summarizeGaps 这一个实现（detectGaps 不再自己算一份）。
   * singlePaperSignals 由上面聚簇过程产出，作为入参传进去 ——
   * 因为只有这里知道"哪些簇没能升成 candidate"。
   */
  const stats = summarizeGaps(gaps, evidenceSkipped, singlePaperSignals)

  return {
    gaps,
    stats,
    context: {
      papers: papers.length,
      methods: methods.length,
      evidence: evidence.length,
      alignments_considered: alignments.length,
      evolution_relations: evolutionRelations.length,
      evidence_with_gap_intent: evidenceWithGapIntent,
      corpus_has_gap_intent: evidenceWithGapIntent > 0,
    },
    rule_version: GAP_RULE_VERSION,
  }
}

/* ------------------------------------------------------------------ */
/* 排序辅助                                                            */
/* ------------------------------------------------------------------ */

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)

/** stated 优先于 candidate（0 更小 = 更靠前） */
const LEVEL_RANK: Record<GapAssertionLevel, number> = {
  stated: 0,
  candidate: 1,
}

/** 信号强度排序：作者亲口承认的局限最强，泛泛的场景未覆盖最弱 */
const SIGNAL_RANK: Record<GapSignalType, number> = {
  limitation: 0,
  open_problem: 1,
  missing_comparison: 2,
  uncovered_setting: 3,
}

const SIGNAL_LABEL: Record<GapSignalType, string> = {
  limitation: '原文指出的局限',
  open_problem: '原文指出的未解决问题',
  missing_comparison: '原文指出的缺失比较',
  uncovered_setting: '原文指出的未覆盖场景',
}

export const gapSignalLabel = (s: GapSignalType): string => SIGNAL_LABEL[s]
export const gapThemeLabel = (t: string): string => THEME_LABEL.get(t) ?? t

/**
 * 判断这一簇成员是否"其实是同一个方法的不同出现"。
 *
 * 判据：任取两篇不同论文的成员，若它们各自的方法身份被 4-2 判为同一方法/别名，
 * 则认为这簇是同一工作的重复引用，不构成跨论文共同缺失。
 *
 * 为什么是"任一"而不是"全部"：只要有**一对**能对上，就说明这簇里存在
 * "同一工作被当成两个来源"的情况，此时候选结论不可靠 ——
 * 保守起见整簇降级为 stated。宁可少产 candidate，不可产假的。
 */
function isSameMethodAcrossPapers(members: StatedDraft[], aliasGroups: string[][]): boolean {
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      if (members[i].paperId === members[j].paperId) continue
      for (const ka of members[i].methodKeys) {
        for (const kb of members[j].methodKeys) {
          if (isAliasPair(ka, kb, aliasGroups)) return true
        }
      }
    }
  }
  return false
}

/* ------------------------------------------------------------------ */
/* 统计 + 不变量                                                        */
/* ------------------------------------------------------------------ */

/**
 * 统计各字段。
 *
 * ⚠️ **必须与 detectGaps 内建的那份逐字段一致** —— 测试会拿两次结果对撞。
 *
 * 最初我把 single_paper_signals 在这里写成"stated 的条数"，而 detectGaps 里
 * 写的是"没能聚成 candidate 的簇成员数"。两者在只有单篇证据时数值相同，
 * 一旦出现 cross-paper candidate 就会分叉（4 vs 2）。测试立刻抓到了。
 *
 * 修法：把计算**收进这一个函数**，detectGaps 也调它，
 * 并接受 `singlePaperSignals` 作为入参（因为只有 detectGaps 知道聚簇过程）。
 * 两份实现迟早漂移；一份实现 + 一个入参不会。
 */
export function summarizeGaps(
  gaps: ResearchGapFinding[],
  skipped = 0,
  singlePaperSignals = 0,
): GapStats {
  const count = (fn: (g: ResearchGapFinding) => boolean) => gaps.filter(fn).length
  return {
    stated: count((g) => g.assertion_level === 'stated'),
    candidate: count((g) => g.assertion_level === 'candidate'),
    total: gaps.length,
    limitation: count((g) => g.gap_signal === 'limitation'),
    open_problem: count((g) => g.gap_signal === 'open_problem'),
    missing_comparison: count((g) => g.gap_signal === 'missing_comparison'),
    uncovered_setting: count((g) => g.gap_signal === 'uncovered_setting'),
    papers_involved: new Set(gaps.flatMap((g) => g.paper_ids)).size,
    methods_involved: new Set(gaps.flatMap((g) => g.method_ids)).size,
    themes: new Set(gaps.map((g) => g.theme).filter((t) => t !== 'general')).size,
    gaps_without_evidence: count((g) => g.evidence_ids.length === 0),
    single_paper_signals: singlePaperSignals,
    evidence_skipped: skipped,
  }
}

/**
 * 校验输出不变量，返回被违反项的说明列表（空数组 = 全部通过）。
 *
 * 导出给测试直接调用 —— 这样"不变量"不是散落在测试里的 if，
 * 而是一份可复用的契约，服务端与测试用同一份判断。
 */
export function assertGapInvariants(out: GapOutcome): string[] {
  const bad: string[] = []

  for (const g of out.gaps) {
    /* 1. 每个 Gap 必须有证据 —— 本模块的硬门槛 */
    if (!g.evidence_ids.length) {
      bad.push(`${g.gap_id}: 没有任何 Evidence 支撑（本模块禁止产出无证据的 Gap）`)
    }

    /* 2. candidate 布尔必须与 assertion_level 一致 */
    const expected = g.assertion_level === 'candidate'
    if (g.candidate !== expected) {
      bad.push(`${g.gap_id}: candidate=${g.candidate} 与 assertion_level=${g.assertion_level} 不一致`)
    }

    /* 3. 分层标记必须合法 */
    if (!isGapAssertionLevel(g.assertion_level)) {
      bad.push(`${g.gap_id}: 非法的 assertion_level=${String(g.assertion_level)}`)
    }

    /* 4. 缺口信号必须合法 */
    if (!isGapSignalType(g.gap_signal)) {
      bad.push(`${g.gap_id}: 非法的 gap_signal=${String(g.gap_signal)}`)
    }

    /*
     * 5. **推断型不得写成既定事实** —— 需求的核心要求，落成可校验的形式。
     *
     * candidate 必须：标题带【候选】前缀 + 描述里出现"推断"或"推测"字样。
     * 这两条一起构成"视觉上无法误读"的保证：即使前端只渲染 title，
     * 用户也会看到【候选】；即使前端只渲染 description，也会看到"推断"。
     */
    if (g.candidate) {
      if (!g.title.startsWith('【候选】')) {
        bad.push(`${g.gap_id}: candidate 的标题缺少「【候选】」前缀，会被误读为既定事实`)
      }
      if (!/推断|推测/.test(g.description)) {
        bad.push(`${g.gap_id}: candidate 的描述未声明其为推断`)
      }
    }

    /*
     * 6. stated 不得自称 candidate 的口吻。
     *    反向检查：stated 的标题不该带【候选】前缀（否则分层标记与文案矛盾）。
     */
    if (!g.candidate && g.title.startsWith('【候选】')) {
      bad.push(`${g.gap_id}: stated 的标题却带「【候选】」前缀，分层标记与文案矛盾`)
    }

    /*
     * 7. candidate 必须真的跨论文（≥2 篇）。
     *    这是"多篇论文共同缺失"的量化定义，不能只靠聚簇逻辑保证。
     */
    if (g.candidate && g.paper_ids.length < 2) {
      bad.push(`${g.gap_id}: candidate 却只涉及 ${g.paper_ids.length} 篇论文`)
    }

    /* 8. 论文 id 不得重复（上游去重失误会在界面上显示成两篇一样的论文） */
    if (new Set(g.paper_ids).size !== g.paper_ids.length) {
      bad.push(`${g.gap_id}: paper_ids 存在重复`)
    }
    if (new Set(g.evidence_ids).size !== g.evidence_ids.length) {
      bad.push(`${g.gap_id}: evidence_ids 存在重复`)
    }

    /* 9. 置信度区间 */
    if (!(g.confidence > 0 && g.confidence <= 1)) {
      bad.push(`${g.gap_id}: confidence=${g.confidence} 超出 (0,1]`)
    }

    /*
     * 10. candidate 的置信度必须**低于** stated 的基线 0.8。
     *     数字上也要体现"推断弱于事实"，否则前端按置信度排序时
     *     推断会盖过事实，与分层语义相反。
     */
    if (g.candidate && g.confidence >= 0.8) {
      bad.push(`${g.gap_id}: candidate 的置信度 ${g.confidence} 不低于 stated 基线 0.8`)
    }
  }

  /* 11. gap_id 必须唯一 */
  const ids = out.gaps.map((g) => g.gap_id)
  if (ids.length !== new Set(ids).size) bad.push(`gap_id 存在重复：${ids.join(',')}`)

  /* 12. gap_id 必须连续且与排序位置一致（编号是"排序后位置"的纯函数） */
  out.gaps.forEach((g, i) => {
    const expected = `GR${String(i + 1).padStart(3, '0')}`
    if (g.gap_id !== expected) {
      bad.push(`gap_id 与排序位置不一致：第 ${i + 1} 条是 ${g.gap_id}，应为 ${expected}`)
    }
  })

  /* 13. 统计必须自洽 */
  const s = out.stats
  if (s.total !== out.gaps.length) {
    bad.push(`stats.total=${s.total} 与 gaps.length=${out.gaps.length} 不一致`)
  }
  if (s.stated + s.candidate !== s.total) {
    bad.push(`stats.stated(${s.stated}) + stats.candidate(${s.candidate}) ≠ total(${s.total})`)
  }
  if (
    s.limitation + s.open_problem + s.missing_comparison + s.uncovered_setting !==
    s.total
  ) {
    bad.push(`四类信号计数之和与 total 不一致`)
  }
  /* 14. 无证据 Gap 数恒为 0 */
  if (s.gaps_without_evidence !== 0) {
    bad.push(`stats.gaps_without_evidence=${s.gaps_without_evidence}，必须为 0`)
  }

  return bad
}
