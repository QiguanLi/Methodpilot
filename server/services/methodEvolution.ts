/**
 * 技术演进重建（Phase 4-4）。
 *
 * ── 这个模块回答什么问题 ──
 * 一个项目里有若干方法，用户在"技术演进"页最想问的是：
 *   「这些方法之间，谁继承了谁？谁改进了谁？哪些只是年份相邻、其实没关系？」
 * 本模块把方法按时间排成一条链，并对**相邻节点**判定它们之间是否存在
 * **原文可证的**因果关系。
 *
 * ── 三条不可动摇的安全底线（本模块存在的全部理由）──
 *
 *   1. **年份先后永远不能推出因果。**
 *      早/晚只是时间事实；"B 改进了 A"是历史断言。
 *      两者之间没有推理通道 —— 晚出现的两个方法完全可能互不相干，
 *      甚至晚的那个是更早范式的回归。所以年份只用来**排序**，
 *      绝不参与"是否演进"的判定。
 *
 *   2. **因果箭头必须同时过三道门：句式命中 + 点名方法 + 证据归属。**
 *      缺任何一道都不产生。详见 detectEvolutionSignal 的注释。
 *
 *   3. **宁可产出 100 条 temporal，也不产 1 条无证据的 extends。**
 *      一条多余的因果箭头会误导用户对技术脉络的整个理解，
 *      而他没有能力逐条核对原文。这条立场与前端 src/data/relations.ts 的
 *      R018 一脉相承 —— 那里也是"年份相邻但没有证据"就老实写 temporal
 *      并且 evidence_ids 留空。
 *
 * ── 为什么必须是纯函数 ──
 * 与 relevance.ts / methodAlignment.ts 同一套理由：不读 config、不发请求、
 * 不碰文件、不取当前时间。这样测试可以直接跑它，不必起服务、不必配 key，
 * 也不必因为它的失败去怀疑"是不是网络又挂了"。
 *
 * ── 与前序阶段的关系 ──
 *   · Phase 4-2（methodAlignment.ts）判"两个方法是不是同一个东西"。
 *     它**刻意禁止**产出 extends/improves 这类因果类型，把这件事留给了本模块。
 *   · 本模块反过来**消费** 4-2 的对齐结果：如果相邻两个方法被 4-2 判为
 *     同一方法或别名，那它们是同一个物，不构成"演进"，标 related 而不是画因果箭头。
 *   · 名称归一化口径直接复用 4-2 的 normalizeMethodName / nameTokens，
 *     不再写一份 —— 两份口径迟早会漂移，届时"什么算同一个词"会前后不一致。
 */

import type { StoredMethod, StoredEvidence, StoredPaper } from '../types.ts'
import type { AlignmentCandidate } from './methodAlignment.ts'
// 值导入：复用 4-2 的归一化口径。**不要重写一份**，否则口径会漂移。
import { normalizeMethodName, nameTokens } from './methodAlignment.ts'

/* ------------------------------------------------------------------ */
/* 关系类型：把「因果」与「非因果」在类型层面分开                        */
/* ------------------------------------------------------------------ */

/**
 * 因果子集 —— **必须挂证据**才能产出。这是本模块唯一允许画箭头的四种类型。
 *
 * 为什么要把它们从七类里单独拎出来做成一个联合类型：
 * 如果用完整的七类，`temporal` 也能被传进"因果判定"的代码路径里，
 * 而它恰恰是"没有因果证据"的意思 —— 这是一个语义上的自相矛盾，
 * 靠 code review 记住"别把 temporal 当因果"是不可靠的，靠类型才可靠。
 * 用窄类型隔开后，任何试图把 temporal 塞进因果路径的代码在 `tsc -b` 就会失败。
 *
 * 取值与前端 src/types/index.ts 的 RelationType 完全一致（复用，不造第二套词汇）。
 */
export type CausalRelationType = 'extends' | 'improves' | 'replaces' | 'combines'

/** 非因果子集 —— 允许无证据，表示「只是时间上相邻」或「同属一个方向」，不画因果箭头 */
export type NonCausalRelationType = 'temporal' | 'parallel' | 'related'

export const CAUSAL_RELATION_TYPES: readonly CausalRelationType[] = [
  'extends',
  'improves',
  'replaces',
  'combines',
] as const

export const NON_CAUSAL_RELATION_TYPES: readonly NonCausalRelationType[] = [
  'temporal',
  'parallel',
  'related',
] as const

/** 演进关系中允许出现的全部类型 = 前端 RelationType 的七类 */
export type EvolutionRelationType = CausalRelationType | NonCausalRelationType

/**
 * 运行时白名单。
 *
 * 类型层面已有联合类型兜底，但 API 返回的是 JSON —— 前端拿到的是 `unknown`，
 * 类型在运行时不存在。所以出口处要再核一次，并导出给测试复用，
 * 避免两边各写一份之后漂移。
 */
export const isCausalRelationType = (v: unknown): v is CausalRelationType =>
  typeof v === 'string' && (CAUSAL_RELATION_TYPES as readonly string[]).includes(v)

export const isEvolutionRelationType = (v: unknown): v is EvolutionRelationType =>
  isCausalRelationType(v) ||
  (typeof v === 'string' && (NON_CAUSAL_RELATION_TYPES as readonly string[]).includes(v))

/* ------------------------------------------------------------------ */
/* 输入                                                                */
/* ------------------------------------------------------------------ */

/**
 * 演进分析输入：一个项目的方法快照 + Phase 4-2 的对齐结果。
 *
 * ── 为什么 `alignments` 只要 `AlignmentCandidate[]`，不要 `AlignmentOutcome` ──
 *
 * AlignmentOutcome 的外壳里有 `compared` / `skippedSamePaper` / `rule_version`，
 * 那些是「对齐阶段自己是怎么跑的」的元信息，对"这两个方法有没有演进关系"
 * 毫无用处。本模块真正需要的只有一件事：
 *
 *     「M_a 与 M_b 被判成了什么」—— 这是一个**事实集合**，数组就够了。
 *
 * 更重要的是解耦：如果入参是整个 Outcome，那么对齐模块一改统计口径
 * （比如改 skippedSamePaper 的定义），演进模块的测试就会莫名其妙地红 ——
 * 两件本来无关的事被绑在一起了。数组是事实，外壳是叙事，我们只要事实。
 *
 * 允许为空数组：此时演进判定完全靠 Evidence 独立工作。
 */
export interface EvolutionInput {
  methods: StoredMethod[]
  evidence: StoredEvidence[]
  papers: StoredPaper[]
  alignments: AlignmentCandidate[]
}

/* ------------------------------------------------------------------ */
/* 命中信号（判定依据）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 一条关系"凭什么"被这样判定。供界面复核、供测试断言。
 *
 * 命名与 4-2 的 AlignmentBasis 同一思路：每个取值都要能让用户
 * 复述出判定过程，而不是面对一个没有出处的标签。
 */
export type EvolutionBasis =
  | 'explicit_causal_statement' // 证据里有明确因果句式（门 A 命中）
  | 'object_anchor' // 证据里**点名**了前驱方法（门 B 命中）
  | 'evidence_ownership_verified' // 证据归属已校验（门 C 通过）
  | 'aligned_same_method' // 4-2 判定为同一方法 → 是同一物，不建立因果
  | 'same_paper_no_causal' // 同一篇论文内的两个方法 → 不判因果
  | 'duplicate_method_identity' // 同一身份（paper_id::method_id 完全相同）被登记了两次
  | 'same_year_no_order' // 同年，无法确立先后
  | 'unknown_year_no_order' // 年份不可知，无法确立先后
  | 'year_adjacent_no_causal_evidence' // 仅年份相邻，证据里没有因果表述
  | 'reverse_statement' // 前驱的论文反向提及后继（少见，但原文可能如此）

/* ------------------------------------------------------------------ */
/* 输出：节点 / 关系 / 统计 / 总包                                       */
/* ------------------------------------------------------------------ */

/**
 * 演进链上的一个节点。
 *
 * 字段与前端 src/types/index.ts 的 `Evolution` **逐字段对齐**，
 * 只多一个 `paper_id`（便于前端跳转到论文、也便于用户复核）。
 * 这样本模块的产出可以被前端直接消费，不需要中间再翻译一层。
 */
export interface EvolutionNode {
  evolution_id: string
  year: number
  /** 代表方法 */
  method_id: string
  /** 阶段标题 */
  stage_title: string
  /** 技术变化 */
  change: string
  /** 相比前一节点的改进 */
  improvement: string
  /** 该阶段暴露的局限 */
  limitation: string
  evidence_ids: string[]
  /**
   * 与上一节点的关系类型。null = 链首。
   *
   * 取值就是前端那七类：因果四类（有证据）与 temporal/related（无因果证据）。
   * 注意它是**单向**的（只看前一个节点），这正是本模块把链做成线性结构的原因 ——
   * 前端这个字段天然只能表达"与前一节点的关系"，自由 DAG 无法映射到它。
   */
  relation_from_prev: EvolutionRelationType | null
  /** 该节点所属论文（前端 Evolution 无此字段，多出来的不冲突） */
  paper_id: string
}

/**
 * 一条演进关系（候选）。
 *
 * ── 需求「每条演进关系必须保存 source/target 的 method_id、paper_id、evidence_id」
 *    的落实处 ──
 *
 * 方向约定：**source = later（后继），target = earlier（前驱）**。
 * 这与前端 src/data/relations.ts 的 R001 一致（M003/SWE-agent → M001/ReAct，
 * source 是更晚的 SWE-agent）。保持同向很重要 —— 否则前端画箭头会反向。
 *
 * evidence_ids 的语义：
 *   · 因果类型 → **非空**，且每条都经过归属校验、可逐条回链原文；
 *   · 非因果类型（temporal/parallel/related）→ **允许为空数组**。
 *     空数组不是"忘了填"，而是"确实没有因果证据"的显式编码。
 *     这一点由 `causal` 字段与 assertEvolutionInvariants 共同钉死。
 */
export interface EvolutionRelation {
  /** 稳定 id，形如 ER001。同一输入必须产出同一 id */
  relation_id: string
  /** = later（后继方法） */
  source_method: string
  /** = earlier（前驱方法） */
  target_method: string
  source_paper_id: string
  target_paper_id: string
  /**
   * 双方的**完整身份键** `paper_id::method_id`。
   *
   * 为什么光有 source_method + source_paper_id 还不够，非要再存一份拼好的键：
   * `method_id` 只在**项目内**唯一，跨论文撞号是真实形态。
   * 那种数据下会出现 `source_method === target_method`（都是 M001）
   * 但 `source_paper_id !== target_paper_id` 的关系 —— 这在语义上完全合法
   * （确实是两个不同论文里的不同方法），可任何"按 method_id 去重 / 判自指"的
   * 下游逻辑都会把它错判成自指。
   * 把身份键显式写出来，下游用它做判等，就不必再各自拼一遍、
   * 也就不会有人漏掉 paper 那一段。
   */
  source_method_key: string
  target_method_key: string
  relation_type: EvolutionRelationType
  /** 可复述的中文解释，禁止空话 */
  description: string
  /** 因果时非空；非因果时允许为空数组 */
  evidence_ids: string[]
  /**
   * 是否因果。
   *
   * 不变量（由 assertEvolutionInvariants 校验）：
   *   causal === true  ⟺  类型在因果子集 **且** evidence_ids.length > 0
   */
  causal: boolean
  confidence: number
  /** 命中的信号，按重要性排序 */
  basis: EvolutionBasis[]
}

/**
 * 统计。七类**分别**计数，不用一个"总数"糊过去。
 *
 * 理由与 4-2 的 summarizeAlignments 相同且更强：`temporal`（只是年份相邻）
 * 和 `extends`（有原文依据的继承）对用户的含义**完全相反**。
 * 合并成一个数字会让"我们找到 1 条继承"和"我们注意到 20 条但没证据"
 * 看起来一样重要，而前者才是真正的结论。
 */
export interface EvolutionStats {
  extends: number
  improves: number
  replaces: number
  combines: number
  related: number
  parallel: number
  temporal: number
  /** 七类之和 = relations.length */
  total_relations: number
  /** 因果关系数 = extends + improves + replaces + combines */
  causal_total: number
  non_causal_total: number
  /** 节点（阶段）数 = evolutions.length */
  stages: number
  /** 年份不可知（=0）的节点数。必须如实上报，否则用户不知道排序有多可信 */
  unknown_year: number
  /**
   * 无证据却标成因果的关系数 —— **必须恒为 0**。
   * 把它放进统计而不是只放在测试里，是为了让这个不变量在运行时也可见。
   */
  causal_without_evidence: number
}

export interface EvolutionOutcome {
  evolutions: EvolutionNode[]
  relations: EvolutionRelation[]
  stats: EvolutionStats
  context: {
    methods: number
    papers: number
    evidence: number
    alignments_considered: number
    /** 缺有效论文归属、未参与演进的方法数（如实上报，不静默丢弃） */
    skipped_no_paper: number
    /** 相邻对总数 = max(0, evolutions.length - 1) */
    adjacent_pairs: number
  }
  /** 规则集版本，便于溯源。标明是确定性规则，不让人误以为是模型产出 */
  rule_version: string
}

export const EVOLUTION_RULE_VERSION = 'deterministic-method-evolution-v1'

/* ------------------------------------------------------------------ */
/* 门 A：演进触发词表                                                   */
/* ------------------------------------------------------------------ */

/**
 * 演进触发词表（门槛 A）。
 *
 * ── 两条设计纪律，都是被误判逼出来的 ──
 *
 * 1. **不做词干还原（no stemming）。**
 *    看起来用一个 `\bimprov\w*` 就能覆盖 improve/improves/improved/improvement，
 *    很方便。但它会把 "our improvement is 5 points"（纯自夸，与"改进了别的方法"
 *    毫无关系）也吞进来。显式枚举 `improves? (up)?on` / `improves? over` /
 *    `improvement over` 比一个宽泛的通配更**可审计** —— 出了问题能一眼看出
 *    是哪条规则放过的。
 *
 * 2. **每条规则必须自带「比较对象标记词」。**
 *    over / upon / on / than / instead of / rather than / of，
 *    或所属格（`X's`）。原因是裸动词 `improve` 在方法论文里满地都是：
 *      "we improve the accuracy of our method"   ← 自夸，不是演进
 *      "we improve over ReAct"                   ← 演进
 *    两者唯一的客观区别就是有没有那个比较标记词。所以把它写进正则里，
 *    而不是留给调用方判断。
 *
 * 中英文各一套：本项目的证据既有英文原文，也有中文释义（translation），
 * 两边都要能命中，否则中文证据永远产生不了因果。
 */
const EVOLUTION_PATTERNS: Record<CausalRelationType, RegExp[]> = {
  /* 继承 / 扩展 */
  extends: [
    /\bextends?\b/i,
    /\bextending\b/i,
    /\bextension\s+of\b/i,
    /\bbuild(?:s|ing)?\s+(?:up\s+)?on\b/i, // build on / builds upon / building on
    /\bbuilt\s+(?:up\s+)?on\b/i,
    /\bfollows?\s+the\b/i, // ⚠️ 见下方取舍注释
    /\binherits?\b/i,
    /\bbased\s+(?:up)?on\b/i,
    /继承/,
    /沿用/,
    /在.{0,12}基础上/,
  ],

  /* 改进 / 超越 */
  improves: [
    /\bimproves?\s+(?:up)?on\b/i, // improve on / improves upon
    /\bimproves?\s+over\b/i, // improves over
    /\bimproved\s+(?:up)?on\b/i,
    /\bimprovement\s+over\b/i,
    /\boutperforms?\b/i,
    /\bbetter\s+than\b/i,
    /\benhanc(?:es?|ing)\s+(?:upon|over)\b/i,
    /\bsurpass(?:es)?\b/i,
    /改进/,
    /优于/,
    /提升了/,
  ],

  /* 替代 */
  replaces: [
    /\breplaces?\b/i,
    /\breplacing\b/i,
    /\bsupersedes?\b/i,
    /\binstead\s+of\b/i,
    /\brather\s+than\b/i,
    /\bstands?\s+in\s+place\s+of\b/i,
    /替代/,
    /取代/,
  ],

  /* 组合 */
  combines: [
    /\bcombines?\s+(?:with|the)\b/i,
    /\bcombin(?:es?|ing)\s+(?:with|the)\b/i,
    /\bintegrat(?:es?|ing)\b/i,
    /\bunif(?:ies|ying|y)\b/i,
    /\bfuses?\b/i,
    /\bmerges?\b/i,
    /结合/,
    /融合/,
    /整合/,
  ],
}

/*
 * ── 关于 /\bfollows?\s+the\b/ 的取舍（保留）──
 *
 * 这条规则比 `extends` 弱，必须说明为什么还留着、以及它为什么是安全的。
 *
 * 危险在哪：
 *   "We follow the setup of [17]"     ← 这是复现别人的实验设置，不是方法演进
 *   "Following the pipeline, we ..."  ← 这里的 the pipeline 根本不是具名方法
 *
 * 之所以仍然保留：`X follows the Y paradigm`（Y 是本项目里另一个具名方法）
 * 在方法论文里确实是一种继承表述，漏掉它会造成真实的漏检。
 * 而上面那两类误命中**已被门槛 B 挡住** —— "the setup"、"the pipeline"
 * 都不是任何方法的 name / nameTokens / 缩写，所以过不了门 B。
 *
 * 换句话说：**这条规则自身不设宾语限制，宾语限制完全外包给了门槛 B。**
 * 因此有一条必须遵守的耦合：**若将来放宽门槛 B（例如允许通用词命中），
 * 这条规则必须同步删除**，否则会立刻变成一个危险的宽规则。
 */

/** 命中强度排序：一条关系可能同时命中多种时取最强。数字越小越强 */
const CAUSAL_RANK: Record<EvolutionRelationType, number> = {
  replaces: 0,
  improves: 1,
  extends: 2,
  combines: 3,
  related: 4,
  parallel: 5,
  temporal: 6,
}

/* ------------------------------------------------------------------ */
/* 内部上下文                                                          */
/* ------------------------------------------------------------------ */

interface Ctx {
  evById: Map<string, StoredEvidence>
  /** evidence_id → 它在哪篇论文里。门 C 用 */
  evPaper: Map<string, string>
  paperById: Map<string, StoredPaper>
}

/* ------------------------------------------------------------------ */
/* 名称工具                                                            */
/* ------------------------------------------------------------------ */

/**
 * 首字母缩写：`Agent-Computer Interface` → `aci`。
 *
 * ⚠️ **刻意不过滤停用词**，与 nameTokens 不同。
 *
 * 这个实现逐字复制自 Phase 4-2 的 methodAlignment.ts（那里的 `acronym` 是私有的，
 * 没有导出）。为什么不直接导出它：4-2 已交付且判定规则**冻结**，
 * 为了本模块的一个便利去改动已冻结的文件，风险大于收益。
 * 代价是两份实现可能漂移 —— 所以写明：**源头是 4-2，那边改了这里必须同步。**
 *
 * 为什么不能过滤停用词：`agent` 在停用词表里（它在方法名中太常见、判别力低），
 * 但缩写 `ACI` 里的那个 `A` 恰恰来自 `Agent`。用过滤后的词表算缩写会得到 `ci`，
 * 于是永远匹配不上真实的 `ACI` —— 而这正是别名/引用识别的主要场景。
 */
function acronymLocal(s: string): string {
  const words = normalizeMethodName(s)
    .split(' ')
    .filter((w) => /^[a-z]/.test(w))
  if (words.length < 2) return ''
  return words.map((w) => w[0]).join('')
}

/**
 * 与 4-2 同源的"通用词"集合。
 *
 * 这些词在本领域遍地都是，单独命中它们不构成"点到了某个方法"。
 * 例如 `context`、`reasoning`、`code` —— 如果允许它们作为锚点，
 * "we improve the reasoning" 会被判成"改进了名叫 Reasoning 的方法"。
 *
 * 与 4-2 的 GENERIC 保持同一份清单：那边用它防"词集包含"的假阳性，
 * 这边用它防"泛泛提到某个通用词"的假阳性。两处的动机其实是一个。
 */
const GENERIC = new Set([
  'context', 'reasoning', 'code', 'model', 'agent', 'data', 'task',
  'prompt', 'search', 'memory', 'tool', 'token', 'text', 'generation',
  'retrieval', 'training', 'planning', 'action', 'language',
])

/* ------------------------------------------------------------------ */
/* 门 B：句子必须点名某个具体方法                                        */
/* ------------------------------------------------------------------ */

/**
 * 门槛 B：证据文本里必须**具体点名**了 `target` 这个方法。
 *
 * ── 为什么这是整条流水线最关键的一道门 ──
 *
 * 只有门槛 A（句式）是不够的。反例：
 *     "Our method improves over the baseline"
 * 它命中了 `improves over`，但 `baseline` 不是一个具名方法。
 * 如果只看门槛 A，我们会生成一条 "我们的方法 improves 某方法" 的关系，
 * 而那个"某方法"只能靠猜 —— 这正是最危险的一类编造。
 *
 * 只有当文本里**真的出现了 target 的名字**（或其别名 / 实词 / 缩写），
 * 我们才有理由说"这条证据在讲 target"。
 *
 * ── 为什么不用「全局别名词表」或「4-2 的候选目标」 ──
 *   · 全局别名词表 = 引入外部知识、需要维护，且带来新的误配面。
 *     本模块的自我限制是"只用输入里的东西"。
 *   · 4-2 的候选目标**不带**"这句话点了谁"的信息 —— 它是方法**对**之间的集合，
 *     不是句子的宾语标注。用它做门 B 等于循环依赖。
 *
 * 所以做法是：拿 target **自己的**名字去撞文本，口径复用 4-2 的
 * normalizeMethodName / nameTokens，零外部依赖。
 *
 * ── self 参数的作用 ──
 * 必须排除"文本命中其实是方法自己的名字"。实测：
 *     "SWE-agent improves over ReAct"
 * 这句话里 `SWE-agent` 和 `ReAct` 都出现了。若判 (SWE-agent, ReAct) 时
 * 不排除 self，`mentionsMethod` 会命中 SWE-agent 自己的名字 —— 虽然调用方
 * 传的 target 是 ReAct 不会出错，但一旦有别的调用路径就会产生自指。
 * 显式传 self 把它堵死。
 */
function mentionsMethod(text: string, target: StoredMethod, self: StoredMethod): boolean {
  const raw = text || ''
  if (!raw.trim()) return false

  /*
   * 自指保护：target 与 self 是**同一个方法**时，直接判定为"不是点名他人"。
   *
   * 判等用身份键而不是裸 method_id —— 两个不同论文的方法可能同号，
   * 那种情况下 target 确实在点名"别人"，不该被这条守卫拦掉。
   * （与 detectEvolutionSignal 的硬约束 0 是同一处修正的两个落点。）
   */
  if (methodKey(target) === methodKey(self)) return false

  const hay = normalizeMethodName(raw)
  if (!hay) return false
  const haySet = new Set(hay.split(' '))

  /* (a) 主名整串命中（要求 ≥3 字符，避免 "AI" 这种短名乱撞） */
  const full = normalizeMethodName(target.name)
  if (full.length >= 3 && hay.includes(full)) return true

  /* (b) 中文名整串命中 */
  const zh = normalizeMethodName(target.name_zh)
  if (zh.length >= 2 && hay.includes(zh)) return true

  /*
   * (c) 实词命中：至少要有一个**非通用词**出现在文本里。
   *
   * ⚠️ 若 target 的名字与 self 的名字共享全部实词（例如 "ReAct" 与 "ReAct Loop"），
   * 那么这里的命中可能来自 self 自己。判据是：命中的词不能在 self 的实词集里
   * "独占" —— 也就是说，如果该词同时属于 self 的词表，它就不能作为区别性证据。
   */
  const selfToks = new Set(nameTokens(self.name))
  const toks = nameTokens(target.name)
  const hitSpecific = toks.some(
    (t) => (haySet.has(t) || hay.includes(t)) && !GENERIC.has(t) && !selfToks.has(t),
  )
  if (hitSpecific) return true

  /* (d) 缩写命中：`Agent-Computer Interface` → 文本里出现裸 ACI */
  const acr = acronymLocal(target.name)
  if (acr.length >= 2 && new RegExp(`\\b${acr}\\b`, 'i').test(raw)) return true

  return false
}

/* ------------------------------------------------------------------ */
/* 门 C：证据归属校验                                                    */
/* ------------------------------------------------------------------ */

/**
 * 门槛 C：这条证据必须确实属于 `ownerPaper` 这篇论文。
 *
 * 防的是一类具体的脏数据：`evidence.method_ids` 在历史上出现过跨论文错挂。
 * 若不过滤，一条被错误挂到论文 A 上的论文 B 的证据，会让 A 凭空"引用了 B" ——
 * 一个凭空的强信号，而且看起来完全合理，最难被发现。
 *
 * 判据与 4-2 的 sharedQuoteTexts.fingerprintsOf 完全一致：
 *   `evPaper` 里查不到的（归属不明）一律不收；查得到但和 owner 不符的也拒。
 * 宁可少收，不可错收 —— 少收只是漏检，错收会编造出一条因果链。
 */
function evidenceBelongsTo(eid: string, ownerPaper: string, ctx: Ctx): boolean {
  const owner = ctx.evPaper.get(eid)
  return Boolean(owner) && owner === ownerPaper
}

/* ------------------------------------------------------------------ */
/* 因果信号检测（三道门串起来）                                          */
/* ------------------------------------------------------------------ */

interface SignalHit {
  relation_type: CausalRelationType
  evidence_id: string
  /** 命中原文，用于生成可复述的 description */
  quote: string
  /** 命中的触发词片段，用于 description */
  trigger: string
}

/**
 * 判定 `earlier` 是否被 `later` 的证据明确声明为前驱。
 *
 * 三道门按顺序串在这里，且顺序是刻意的：
 *   先门 B（点名），再门 A（句式）。
 *   门 B 更严、更便宜（只是字符串包含），先判它能把绝大多数无关证据
 *   在跑正则之前就筛掉；也避免"句式命中但宾语是 baseline"这种句子
 *   进入后面的日志与统计。
 *
 * 返回 null 表示"没有找到任何一条合格的因果证据" ——
 * **这不是失败，而是大多数情况的正常结果**。
 */
function detectEvolutionSignal(
  later: StoredMethod,
  earlier: StoredMethod,
  ctx: Ctx,
): SignalHit | null {
  /*
   * 硬约束 0：绝不自己指向自己。
   *
   * ⚠️ 这里比的是 **methodKey（paper_id::method_id）**，不是裸 method_id。
   *
   * 踩过的坑：最初写成 `later.method_id === earlier.method_id`。
   * 在正常数据上它没问题，但 method_id 只在**项目内唯一**，
   * 跨论文撞号是真实存在的脏数据形态（比如两篇论文都被抽成 M001）。
   * 那种数据下，两个"不同的方法"因 id 相同被误判成自己，
   * 反过来更糟 —— 一旦上游换成按 (paper, method) 生成的 id，
   * 这个守卫就彻底失效，会放出一条 source_method === target_method
   * 的"自己演进自己"的关系，而自指是演进图里最荒谬的错误。
   *
   * 判"是不是同一个方法"必须用完整身份，不能只用 id 的一段。
   */
  const laterKey = methodKey(later)
  const earlierKey = methodKey(earlier)
  if (laterKey === earlierKey) return null

  const laterPaper = primaryPaperId(later)
  const hits: SignalHit[] = []

  for (const eid of later.evidence_ids) {
    const ev = ctx.evById.get(eid)
    if (!ev) continue // 悬空 evidence_id 静默跳过（与"有证据"不混淆）

    /* ── 门 C：归属校验 ── */
    if (!evidenceBelongsTo(eid, laterPaper, ctx)) continue

    /* ── 门 B：这条证据必须点名了 earlier ── */
    const bilingual = `${ev.content} ${ev.translation}`
    const anchored =
      mentionsMethod(ev.content, earlier, later) || mentionsMethod(ev.translation, earlier, later)
    if (!anchored) continue

    /*
     * ── 门 A：句式命中 ──
     *
     * ⚠️ 这里必须**遍历全部类型再取最强**，不能用 `break` 撞到第一个就停。
     *
     * 踩过的坑：最初写成 `for (const [type, res] of Object.entries(...))` 里
     * 命中就 break —— 而 `Object.entries` 的顺序是**定义顺序**
     * （extends > improves > replaces > combines），不是强度顺序。
     * 于是一句 "DFSDT replaces Toolformer and extends it" 会先撞上 `extends`
     * 就 break，把更强的 `replaces` 丢掉，最后误判成 extends。
     *
     * 症状极隐蔽：多类型共现的句子才会触发，单类型句完全正常，
     * 而"替代并扩展"恰恰是技术演进里最常见的陈述之一。
     * 修复：收集**所有**命中类型，再按 CAUSAL_RANK 取最强者。
     */
    for (const [type, res] of Object.entries(EVOLUTION_PATTERNS) as [
      CausalRelationType,
      RegExp[],
    ][]) {
      const re = res.find((r) => r.test(bilingual))
      if (re) {
        hits.push({
          relation_type: type,
          evidence_id: eid,
          quote: ev.content,
          trigger: (bilingual.match(re) ?? [''])[0] || type,
        })
      }
    }
  }

  if (!hits.length) return null

  /*
   * 多条命中（可能来自不同证据，也可能来自同一句里的多个类型）时取**最强**的那条
   * （replaces > improves > extends > combines）。
   *
   * 为什么不取"命中次数最多"的那类：次数反映的是作者啰嗦程度，
   * 而类型强度反映的是关系的实质。"replaces" 一条就足以定性，
   * 不需要靠三条 "extends" 来凑。
   *
   * 排序键除强度外还用 evidence_id 兜底 —— 保证同强度时结果稳定，
   * 不依赖证据在数组里的顺序（确定性要求）。
   */
  hits.sort(
    (x, y) =>
      CAUSAL_RANK[x.relation_type] - CAUSAL_RANK[y.relation_type] ||
      (x.evidence_id < y.evidence_id ? -1 : x.evidence_id > y.evidence_id ? 1 : 0),
  )
  return hits[0]
}

/* ------------------------------------------------------------------ */
/* 年份                                                                */
/* ------------------------------------------------------------------ */

/**
 * 方法的代表年份。
 *
 * 优先级：
 *   1. `method.year` 非 0  → 用它（阶段② 抽取出的年份）
 *   2. 否则回退到所属论文的 `paper.year`
 *   3. 两者都是 0 → 返回 0，**不猜、不用当前年、不用邻居年份**
 *
 * ── 为什么不用 Date.now() 兜底 ──
 * 那会让输出随运行时间变化，直接破坏本模块的确定性承诺 ——
 * 同一份数据今天跑和明天跑会得到不同的链顺序。
 *
 * ── 为什么 0 是"诚实哨兵"而不是错误值 ──
 * 年份不可知是一个**真实存在且必须如实上报**的状态。用 0 表示它，
 * 排序时排在所有已知年份**之后**（不假定未知年份在最前，那会伪造一个时间关系），
 * 并在 stats.unknown_year 里单独计数，让用户知道这条链里有多少节点
 * 的时间位置是推测出来的。把它悄悄改成"最近的一年"会让整条链看起来
 * 比实际更可信 —— 这正是最不该做的事。
 */
function methodYear(m: StoredMethod, paperById: Map<string, StoredPaper>): number {
  if (m.year > 0) return m.year
  const p = paperById.get(primaryPaperId(m))
  if (p && p.year > 0) return p.year
  return 0
}

/** 排序用的年份键：0（未知）映射为 +∞，排到最后 */
const yearKeyOf = (y: number) => (y > 0 ? y : Number.MAX_SAFE_INTEGER)

/** 方法的主论文 id。与 4-2 同口径：`paper_ids` 取第一个作为归属 */
function primaryPaperId(m: StoredMethod): string {
  return m.paper_ids.length ? m.paper_ids[0] : ''
}

/**
 * 方法的**完整身份键** `paper_id::method_id`。
 *
 * `method_id` 只在项目内唯一，跨论文撞号是真实存在的形态；
 * 因此凡是"判断两个方法是不是同一个""查找两方法之间的对齐关系"
 * 这类需要**身份**的地方，都必须用这个键，不能用裸 method_id。
 * （顺序键也用它，见 ② 的排序注释。）
 */
function methodKey(m: StoredMethod): string {
  return `${primaryPaperId(m)}::${m.method_id}`
}

/* ------------------------------------------------------------------ */
/* 节点文案                                                            */
/* ------------------------------------------------------------------ */

/**
 * 阶段标题。
 *
 * 优先用中文名（面向中文用户），退化为英文名，最后退化到 method_id。
 * 不编造任何概括性文字 —— 标题就是方法名，不假装我们知道它在
 * 技术脉络里扮演什么角色。那个判断属于链上的关系，不属于节点标题。
 */
function buildStageTitle(m: StoredMethod): string {
  return m.name_zh || m.name || m.method_id
}

/**
 * 把字符串数组拼成一句可读文本。
 *
 * 空数组时返回空串（由调用方决定兜底话术），而不是自作主张写"暂无" ——
 * "字段没填"和"作者明确说了没有改进"是两件事，兜底话术留给调用方
 * 在知道上下文的情况下写。
 */
function joinText(list: string[]): string {
  return list.filter((s) => typeof s === 'string' && s.trim()).join('；')
}

/* ------------------------------------------------------------------ */
/* 关系构造                                                            */
/* ------------------------------------------------------------------ */

interface RelationDraft {
  later: StoredMethod
  earlier: StoredMethod
  relation_type: EvolutionRelationType
  causal: boolean
  confidence: number
  basis: EvolutionBasis[]
  description: string
  evidence_ids: string[]
}

/**
 * 把一条草稿变成正式关系。
 *
 * 注意这里**不分配 relation_id** —— 先给占位空串，等全部算完、
 * 排序之后再统一编号。原因见 buildEvolution 里"排序与编号"那段注释。
 */
function toRelation(d: RelationDraft): EvolutionRelation {
  return {
    relation_id: '',
    source_method: d.later.method_id, // source = later
    target_method: d.earlier.method_id, // target = earlier
    source_paper_id: primaryPaperId(d.later),
    target_paper_id: primaryPaperId(d.earlier),
    source_method_key: methodKey(d.later),
    target_method_key: methodKey(d.earlier),
    relation_type: d.relation_type,
    description: d.description,
    evidence_ids: d.evidence_ids,
    causal: d.causal,
    confidence: d.confidence,
    basis: d.basis,
  }
}

/** 非因果（temporal）关系的统一构造。evidence_ids 恒为空数组 */
function makeTemporal(
  earlier: StoredMethod,
  later: StoredMethod,
  reason: EvolutionBasis,
  yEarlier: number,
  yLater: number,
): RelationDraft {
  const why =
    reason === 'same_paper_no_causal'
      ? '两者出自同一篇论文，属于该论文的不同贡献，不构成跨论文的技术演进'
      : reason === 'duplicate_method_identity'
        ? '两条记录指向同一个方法（论文与方法 id 均相同），是重复登记而非演进'
        : reason === 'same_year_no_order'
          ? '两者同年出现，无法确立先后'
          : reason === 'unknown_year_no_order'
            ? '至少一方年份不可知，无法确立先后'
            : '现有 Evidence 中未出现「继承 / 改进 / 替代 / 组合」的明确表述'

  const span =
    yEarlier > 0 && yLater > 0 ? `（${yEarlier} → ${yLater}）` : ''

  return {
    later,
    earlier,
    relation_type: 'temporal',
    causal: false,
    confidence: 0.2,
    basis: [reason],
    description: `仅标注为时间相关${span}：${why}，故不建立因果关系。`,
    /*
     * 空数组 = "确实没有因果证据"的**显式编码**，不是"忘了填"。
     * 前端 src/data/relations.ts 的 R018 就是这个形态。
     */
    evidence_ids: [],
  }
}

/** 非因果（related）关系：被 4-2 判为同一方法，是同一物而非演进 */
function makeSameAsEarlier(
  earlier: StoredMethod,
  later: StoredMethod,
  alignment: AlignmentCandidate,
): RelationDraft {
  const label = alignment.relation_type === 'same' ? '同一方法' : '互为别名'
  return {
    later,
    earlier,
    relation_type: 'related',
    causal: false,
    confidence: 0.4,
    basis: ['aligned_same_method'],
    description: `${later.name} 与 ${earlier.name} 被跨论文对齐判定为${label}（${alignment.alignment_id}），属于同一方法的不同出现，而非技术演进，故不建立因果箭头。`,
    // 沿用对齐阶段的证据：它们支撑的是"这是同一个方法"，不是"谁演进了谁"
    evidence_ids: [...alignment.evidence_ids],
  }
}

/** 因果关系的构造 */
function makeCausal(
  earlier: StoredMethod,
  later: StoredMethod,
  hit: SignalHit,
  reverse: boolean,
): RelationDraft {
  /*
   * 反向声明的 confidence 略低：原文是**前驱**在提后继，
   * 这比"后继明确说自己继承了前驱"弱一档 —— 前者可能只是相关工作的一句提及，
   * 甚至是"我们预留了给未来工作"的表述。仍然产出（因为原文确实这么写了），
   * 但要让它的置信度低于正向声明。
   */
  const confidence = reverse ? 0.55 : 0.8
  const dir = reverse
    ? `${earlier.name} 的原文提及了 ${later.name}`
    : `${later.name} 的原文明确声明`

  const verbLabel: Record<CausalRelationType, string> = {
    extends: '继承 / 扩展',
    improves: '改进 / 超越',
    replaces: '替代',
    combines: '组合',
  }

  return {
    later,
    earlier,
    relation_type: hit.relation_type,
    causal: true,
    confidence,
    basis: reverse
      ? ['explicit_causal_statement', 'object_anchor', 'evidence_ownership_verified', 'reverse_statement']
      : ['explicit_causal_statement', 'object_anchor', 'evidence_ownership_verified'],
    description: `${dir}与 ${reverse ? later.name : earlier.name} 的「${verbLabel[hit.relation_type]}」关系，依据为「${hit.trigger}」。原文：「${hit.quote}」`,
    evidence_ids: [hit.evidence_id],
  }
}

/* ------------------------------------------------------------------ */
/* 相邻对判定                                                          */
/* ------------------------------------------------------------------ */

/**
 * 判定链上相邻的两个方法之间的关系。
 *
 * 判定顺序是刻意排的，从"最硬的事实"到"最弱的兜底"：
 *
 *   1. 同论文  → temporal（4-2 口径：同论文的方法是同一贡献的不同侧面）
 *   2. 年份无法确立先后（同年 / 未知）→ temporal
 *   3. 正向因果：later 的证据声明它继承了 earlier
 *   4. 反向因果：earlier 的证据提及了 later
 *   5. 4-2 判为同一方法 → related（是同一物，不是演进）
 *   6. 兜底 → temporal
 *
 * 注意第 1、2 条排在因果判定**之前**：这是"年份不能推因果"的落点 ——
 * 如果两个方法同年，即使证据里出现因果句式，我们也无法说清谁先谁后，
 * 所以不允许产生有向的因果箭头。
 * （同论文的情形同理且更强：那是同一篇论文的两个贡献，
 *  即使作者写了"我们的 X 改进了我们的 Y"，那也属于论文内部叙事，
 *  与"跨论文技术演进"是两回事。）
 */
function classifyAdjacent(
  earlier: StoredMethod,
  later: StoredMethod,
  ctx: Ctx,
  alignments: AlignmentCandidate[],
): RelationDraft {
  const yEarlier = methodYear(earlier, ctx.paperById)
  const yLater = methodYear(later, ctx.paperById)

  /*
   * 0. 同一身份（paper_id::method_id 相同）→ 根本不该有边。
   *
   * 正常路径下排序已保证相邻两个方法身份不同，这里是**兜底**：
   * 脏数据里同一方法被登记两次（同 id 同论文）时，
   * 排序仍会把它俩排在一起，进而画出一条自指边。
   * 与其在最后靠不变量把整批结果标记为可疑，
   * 不如在生成处就拒绝它 —— 一条自指边不该让整条链看起来"有进展"。
   */
  if (methodKey(earlier) === methodKey(later)) {
    return makeTemporal(earlier, later, 'duplicate_method_identity', yEarlier, yLater)
  }

  /* 1. 同论文 → 不判因果（沿用 4-2 的硬规则） */
  if (primaryPaperId(earlier) === primaryPaperId(later)) {
    return makeTemporal(earlier, later, 'same_paper_no_causal', yEarlier, yLater)
  }

  /* 2. 无法确立先后 → 不判因果 */
  if (yEarlier === yLater) {
    return makeTemporal(earlier, later, 'same_year_no_order', yEarlier, yLater)
  }
  if (yEarlier === 0 || yLater === 0) {
    return makeTemporal(earlier, later, 'unknown_year_no_order', yEarlier, yLater)
  }

  /* 3. 正向因果 */
  const forward = detectEvolutionSignal(later, earlier, ctx)
  if (forward) return makeCausal(earlier, later, forward, false)

  /* 4. 反向因果 */
  const backward = detectEvolutionSignal(earlier, later, ctx)
  if (backward) return makeCausal(earlier, later, backward, true)

  /* 5. 4-2 判为同一方法 → related */
  const alignment = findAlignment(earlier, later, alignments)
  if (alignment && (alignment.relation_type === 'same' || alignment.relation_type === 'alias')) {
    return makeSameAsEarlier(earlier, later, alignment)
  }

  /* 6. 兜底 */
  return makeTemporal(earlier, later, 'year_adjacent_no_causal_evidence', yEarlier, yLater)
}

/**
 * 在 4-2 的对齐结果里找这两个方法之间的那条关系。
 *
 * 必须**双向**查：4-2 输出的 source/target 是按 (paper_id, method_id) 字典序排的，
 * 与本模块的 (earlier, later) 时间序**不是同一个方向**。
 * 只查单向会漏掉一半情况，而且漏得很隐蔽（某些对能查到、某些查不到）。
 */
function findAlignment(
  a: StoredMethod,
  b: StoredMethod,
  alignments: AlignmentCandidate[],
): AlignmentCandidate | undefined {
  const ka = methodKey(a)
  const kb = methodKey(b)
  const keyOf = (s: AlignmentCandidate['source']) => `${s.paper_id}::${s.method_id}`
  return alignments.find(
    (c) =>
      (keyOf(c.source) === ka && keyOf(c.target) === kb) ||
      (keyOf(c.target) === ka && keyOf(c.source) === kb),
  )
}

/* ------------------------------------------------------------------ */
/* 主体逻辑                                                            */
/* ------------------------------------------------------------------ */

/**
 * 构建方法演进候选链。
 *
 * 六步：
 *   ① 筛出有有效论文归属的方法
 *   ② 按 (年份, paper_id::method_id) 全序排序
 *   ③ 生成节点，并在相邻节点之间判边
 *   ④ 边转成 relations
 *   ⑤ 排序 → 统一编号
 *   ⑥ 统计 + 组装
 */
export function buildEvolution(input: EvolutionInput): EvolutionOutcome {
  const { methods, evidence, papers, alignments } = input

  const ctx: Ctx = {
    evById: new Map(evidence.map((e) => [e.evidence_id, e])),
    evPaper: new Map(evidence.map((e) => [e.evidence_id, e.paper_id])),
    paperById: new Map(papers.map((p) => [p.paper_id, p])),
  }

  /* ① 筛：缺有效论文归属的方法无法参与跨论文演进，如实统计而不是静默丢弃 */
  const usable = methods.filter((m) => {
    const pid = primaryPaperId(m)
    return Boolean(pid) && ctx.paperById.has(pid)
  })
  const skippedNoPaper = methods.length - usable.length

  /*
   * ② 全序排序。
   *
   * ── 为什么排序键要这么设计 ──
   * 年份是第一键（这是"按时间组织"的落点）。
   * 第二键用 (paper_id, method_id) 字典序而不是"输入顺序"或"发现顺序" ——
   * 那是确定性的全部来源。同年方法、以及年份不可知的方法，
   * 它们的相对位置必须由**内容**决定，不能由数组顺序决定，
   * 否则同一份数据换个加载顺序就会画出两条不同的链。
   *
   * yearKeyOf 把 0 映射成 +∞：年份不可知的方法排在最后，
   * 而不是被当成"最早"。后者会凭空制造出一个时间关系。
   */
  const ordered = [...usable].sort((a, b) => {
    const ya = yearKeyOf(methodYear(a, ctx.paperById))
    const yb = yearKeyOf(methodYear(b, ctx.paperById))
    if (ya !== yb) return ya - yb
    const ka = `${primaryPaperId(a)}::${a.method_id}`
    const kb = `${primaryPaperId(b)}::${b.method_id}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

  /* ③ 生成节点 + 相邻判边 */
  const evolutions: EvolutionNode[] = []
  const drafts: RelationDraft[] = []

  for (let i = 0; i < ordered.length; i++) {
    const m = ordered[i]
    const prev = i > 0 ? ordered[i - 1] : null

    let edge: RelationDraft | null = null
    if (prev) {
      edge = classifyAdjacent(prev, m, ctx, alignments)
      drafts.push(edge)
    }

    evolutions.push({
      evolution_id: '', // 占位，排完统一编号
      year: methodYear(m, ctx.paperById),
      method_id: m.method_id,
      stage_title: buildStageTitle(m),
      change: m.core_idea || '（该方法的原文抽取中未给出核心思想描述）',
      improvement: joinText(m.advantages) || '（原文未给出明确的改进声明）',
      limitation: joinText(m.limitations) || '（原文未给出明确的局限说明）',
      // 悬空 evidence_id 静默剔除，避免前端点开拿不到东西
      evidence_ids: m.evidence_ids.filter((id) => ctx.evById.has(id)),
      relation_from_prev: edge ? edge.relation_type : null,
      paper_id: primaryPaperId(m),
    })
  }

  /* ④ 草稿转正式关系 */
  const relations = drafts.map(toRelation)

  /*
   * ⑤ 排序 → 再统一编号。
   *
   * ── 这一条是被 Phase 4-2 的血泪教训定下来的 ──
   *
   * 4-2 最初的写法是"边发现边分配 id，再按 (强度, 置信度, id) 排序"。
   * 看起来确定，实际有一个隐蔽的顺序依赖：当两条关系的**类型与置信度都相同**时
   * （很常见，比如两条 temporal 都是 0.2），排序会落到 id 这一级；
   * 而 id 是发现顺序决定的，发现顺序又随输入数组顺序变化。
   * 结果就是：同一批方法，换个输入顺序，两条同分关系的先后会互换。
   *
   * 单次打乱碰不到，**穷举 6 种排列就必现**（4-2 就是这么抓到的）。
   *
   * 所以排序键必须全是**由内容算出**的：类型强度 → 置信度降序 → source 内容键
   * → target 内容键。这四个都与输入顺序无关。排完之后再统一编号，id 才稳定。
   */
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)

  relations.sort(
    (a, b) =>
      CAUSAL_RANK[a.relation_type] - CAUSAL_RANK[b.relation_type] ||
      b.confidence - a.confidence ||
      cmp(a.source_method_key, b.source_method_key) ||
      cmp(a.target_method_key, b.target_method_key),
  )

  /* 编号：id 成为"排序后位置"的纯函数 */
  relations.forEach((r, i) => {
    r.relation_id = `ER${String(i + 1).padStart(3, '0')}`
  })
  evolutions.forEach((e, i) => {
    e.evolution_id = `EV${String(i + 1).padStart(3, '0')}`
  })

  /*
   * ⑥ 组装。
   *
   * 注意 evolutions 的顺序**不**跟着 relations 的排序走 ——
   * 节点必须保持时间顺序（那是链的可读性所在），
   * 而 relations 按"因果强度"排（那是"先看有结论的"）。
   * 两者的排序目的不同，不能统一。
   */
  const stats = summarizeEvolutions(relations, evolutions)

  return {
    evolutions,
    relations,
    stats,
    context: {
      methods: methods.length,
      papers: papers.length,
      evidence: evidence.length,
      alignments_considered: alignments.length,
      skipped_no_paper: skippedNoPaper,
      adjacent_pairs: Math.max(0, evolutions.length - 1),
    },
    rule_version: EVOLUTION_RULE_VERSION,
  }
}

/* ------------------------------------------------------------------ */
/* 统计 + 不变量                                                        */
/* ------------------------------------------------------------------ */

/**
 * 统计各类型关系数量。
 *
 * `causal_without_evidence` 这一项放在统计里（而不只是放在测试里），
 * 是为了让"因果必有证据"这个不变量在**运行时**也随时可见 ——
 * 它一旦不为 0，接口返回的数据就自证其不可信，不需要等测试来发现。
 */
export function summarizeEvolutions(
  relations: EvolutionRelation[],
  evolutions: EvolutionNode[],
): EvolutionStats {
  const s: EvolutionStats = {
    extends: 0,
    improves: 0,
    replaces: 0,
    combines: 0,
    related: 0,
    parallel: 0,
    temporal: 0,
    total_relations: 0,
    causal_total: 0,
    non_causal_total: 0,
    stages: evolutions.length,
    unknown_year: evolutions.filter((e) => e.year === 0).length,
    causal_without_evidence: 0,
  }

  for (const r of relations) {
    if (isEvolutionRelationType(r.relation_type)) s[r.relation_type]++
    s.total_relations++
    if (isCausalRelationType(r.relation_type)) {
      s.causal_total++
      if (r.evidence_ids.length === 0) s.causal_without_evidence++
    } else {
      s.non_causal_total++
    }
  }

  return s
}

/**
 * 校验输出不变量，返回被违反项的说明列表（空数组 = 全部通过）。
 *
 * 导出给测试直接调用 —— 这样"不变量"不是散落在测试里的 if，
 * 而是一份可复用的契约，服务端与测试用同一份判断。
 */
export function assertEvolutionInvariants(out: EvolutionOutcome): string[] {
  const bad: string[] = []

  for (const r of out.relations) {
    /* 1. 因果 ⇒ 类型在因果子集 且 证据非空 */
    if (r.causal && !(isCausalRelationType(r.relation_type) && r.evidence_ids.length > 0)) {
      bad.push(`${r.relation_id}: causal=true 但类型或证据不满足（type=${r.relation_type}, ev=${r.evidence_ids.length}）`)
    }
    /* 2. 非因果类型不得标 causal=true */
    if (!r.causal && isCausalRelationType(r.relation_type)) {
      bad.push(`${r.relation_id}: 类型 ${r.relation_type} 是因果类型，却标了 causal=false`)
    }
    /*
     * 3. 绝不自己指向自己。
     *
     * 用**身份键**判等，不是裸 method_id：跨论文撞号的合法关系
     * （source_method === target_method 但 paper 不同）不该被误报成自指。
     */
    if (r.source_method_key === r.target_method_key) {
      bad.push(`${r.relation_id}: 自指关系（${r.source_method_key} 指向自身）`)
    }
    /* 4. 双方 paper_id 必须齐备 —— 需求要求能回链到双方论文 */
    if (!r.source_paper_id || !r.target_paper_id) {
      bad.push(`${r.relation_id}: source/target 的 paper_id 缺失`)
    }
    /* 5. 方向：source 的年份不得早于 target（source 必须是 later） */
    const sy = out.evolutions.find((e) => methodNodeKey(e) === r.source_method_key)?.year ?? -1
    const ty = out.evolutions.find((e) => methodNodeKey(e) === r.target_method_key)?.year ?? -1
    if (sy > 0 && ty > 0 && sy < ty) {
      bad.push(`${r.relation_id}: 方向颠倒，source 年(${sy}) 早于 target 年(${ty})`)
    }
  }

  /* 6. relation_id 必须唯一 */
  const ids = out.relations.map((r) => r.relation_id)
  if (ids.length !== new Set(ids).size) bad.push(`relation_id 存在重复：${ids.join(',')}`)

  /* 7. relation_from_prev 必须与 relations 里对应边一致 */
  for (let i = 1; i < out.evolutions.length; i++) {
    const node = out.evolutions[i]
    const prev = out.evolutions[i - 1]
    const nodeKey = methodNodeKey(node)
    const prevKey = methodNodeKey(prev)
    const edge = out.relations.find(
      (r) => r.source_method_key === nodeKey && r.target_method_key === prevKey,
    )
    if (!edge) {
      bad.push(`${node.evolution_id}: 非链首却找不到与前驱 ${prevKey} 的关系边`)
    } else if (node.relation_from_prev !== edge.relation_type) {
      bad.push(
        `${node.evolution_id}: relation_from_prev=${node.relation_from_prev} 与边类型 ${edge.relation_type} 不一致`,
      )
    }
  }

  return bad
}

/**
 * 节点的完整身份键。与关系的 `source_method_key` / `target_method_key` 同口径，
 * 让不变量校验能在"跨论文撞号"的数据上也判得准。
 */
function methodNodeKey(n: EvolutionNode): string {
  return `${n.paper_id}::${n.method_id}`
}
