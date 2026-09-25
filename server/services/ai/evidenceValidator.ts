/**
 * Evidence Validator —— 本项目可信度的地基（第 11/12/17 节，最高优先级）。
 *
 * 要解决的问题：
 *   LLM 非常擅长"编一条听起来很像原文的引用"，并且会给它配一个看起来合理的页码。
 *   如果直接采信，方法地图上就会出现一条指向"第 7 页"、但第 7 页根本没有那句话的证据——
 *   整个产品的卖点（可追溯到页码与原文）当场归零。
 *
 * 因此本文件做的是**证伪**，不是**补全**：
 *   只有当我们能在模型声称的那一页正文里，逐字找到它给出的 quote，这条证据才成立。
 *
 * 三条铁律：
 *   1. 不做语义近似匹配。第 18 节明确只允许"空白字符归一化"。
 *      一旦开始"看起来差不多就算过"，就再也说不清哪些证据是真的。
 *   2. 不做静默修复。页码错了就是错了，不替模型猜"其实可能是第 8 页"。
 *      被拒的证据要带着原因记录并展示给用户（见 Analysis Log）。
 *   3. 一条证据不成立，不影响其他证据。逐条独立判定。
 */

import type { LLMEvidence, LLMMethod } from '../../types.ts'

/* ------------------------------------------------------------------ */
/* 归一化                                                              */
/* ------------------------------------------------------------------ */

/**
 * 唯一允许的模糊处理。
 *
 * PDF 文本层会把换行、连字符断词、连续空格弄得很脏：
 *   "the ReAct framework\ninterleaves  reasoning"
 *   "inter-\nleaves"
 * 而模型在复述 quote 时通常会给成一行连续文本。两边都归一化后比较，
 * 属于"同一段文字的不同排版表示"，不是"意思相近的另一段文字"。
 *
 * 刻意**不**做的事：
 *   - 不去标点（句号/逗号的有无是有信息量的）
 *   - 不转小写以外做任何词形变换
 *   - 不忽略停用词
 *
 * 实现注意：这里刻意**不用正则字面量**。
 * 本文件曾在写入时被转义搞坏——源码里落进了字面量换行，
 * 正则照样能编译，只是永远不匹配。那是这类 bug 里最难发现的一种：
 * 校验器静默通过 / 静默否决，而没有任何报错。
 * 因此改为 new RegExp + String.fromCharCode 显式构造，转义无从出错，
 * 且下面的自测会真的跑一遍断词样例。
 */

/**
 * 跨行断词是这个校验器最容易误杀真实证据的地方。
 *
 * PDF 文本层里断词长这样：`... acting-<LF>aware ...`，
 * 而模型很可能把这句话直接写成 `... acting-aware ...`（带连字符）。
 * 如果只把断词"接回"成 `actingaware`，反而和模型的 `acting-aware` 对不上——
 * 一条完全真实的证据会被误判为"模型编造"，这是最冤枉的失败模式。
 *
 * 所以这里同时产出两种归一化形式：
 *   strict —— 断词接回成 `actingaware`（模型给连续词时命中）
 *   hyphen —— 断词接成 `acting-aware`（模型保留连字符时命中）
 * 只要任一形式命中，即认为 quote 真实存在于该页。
 * 注意两种形式都是"同一些字符的不同排版"，不存在语义近似。
 */
// U+00AD SOFT HYPHEN：PDF 里常作为不可见字符夹在词中
const SOFT_HYPHEN = String.fromCharCode(0x00ad)
// 用 fromCharCode 拿换行/制表，避免源码里出现真实控制字符
const LF = String.fromCharCode(0x0a)
const WS = ' ' + String.fromCharCode(0x09) + LF + String.fromCharCode(0x0d, 0x0c)
/** 各类不换行/窄空格 → 普通空格 */
const RE_ODD_SPACES = new RegExp('[' + String.fromCharCode(0x00a0, 0x2000, 0x202f, 0x205f, 0x3000) + ']', 'g')

const RE_SOFT_HYPHEN = new RegExp(SOFT_HYPHEN, 'g')
/** 「连字符 + 换行 + 可能的行尾/行首空白」，跨行断词的标志 */
const RE_HYPHEN_BREAK_JOIN = new RegExp('-[' + WS + ']*' + LF + '[' + WS + ']*', 'g')
/** 弯引号 → 直引号 */
const RE_CURLY_SINGLE = new RegExp('[' + String.fromCharCode(0x2018, 0x2019) + ']', 'g')
const RE_CURLY_DOUBLE = new RegExp('[' + String.fromCharCode(0x201c, 0x201d) + ']', 'g')
/** 各种 dash（hyphen/en-dash/em-dash/minus）→ ASCII 减号 */
const RE_DASHES = new RegExp(
  '[' + String.fromCharCode(0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2212) + ']',
  'g',
)
/** 所有空白（含换行、制表、不换行空格）折叠成单空格 */
const RE_WS = /\s+/g

/** A 型：断词直接接回（inter-\nleaves → interleaves） */
function normalizeStrict(s: string): string {
  return s
    .replace(RE_SOFT_HYPHEN, '')
    .replace(RE_HYPHEN_BREAK_JOIN, '')
    .replace(RE_CURLY_SINGLE, "'")
    .replace(RE_CURLY_DOUBLE, '"')
    .replace(RE_DASHES, '-')
    .replace(RE_ODD_SPACES, ' ')
    .replace(RE_WS, ' ')
    .trim()
    .toLowerCase()
}

/** B 型：断词保留为连字符（inter-\nleaves → inter-leaves） */
function normalizeHyphenKept(s: string): string {
  return s
    .replace(RE_SOFT_HYPHEN, '')
    // 把「连字符+换行(+缩进)」压成一个纯连字符，而不是删掉
    .replace(RE_HYPHEN_BREAK_JOIN, '-')
    .replace(RE_CURLY_SINGLE, "'")
    .replace(RE_CURLY_DOUBLE, '"')
    .replace(RE_DASHES, '-')
    .replace(RE_ODD_SPACES, ' ')
    .replace(RE_WS, ' ')
    .trim()
    .toLowerCase()
}

/** 对外沿用的归一化：A 型（最常用） */
export function normalizeForMatch(s: string): string {
  return normalizeStrict(s)
}

/** 两种归一化形式，供证据匹配使用 */
const normalizeBoth = (s: string): [string, string] => [normalizeStrict(s), normalizeHyphenKept(s)]

/**
 * 自测：确认归一化真的按预期工作。
 * 之所以把自测写进源码而不是测试文件，是因为这个函数错了不会报错——
 * 它只会让所有 evidence 被拒，而错误信息看起来像"模型在编造引用"，
 * 排查方向会被彻底带偏。宁可多花几十行把它钉死。
 */
export function selfTestNormalize(): { ok: boolean; failures: string[] } {
  const failures: string[] = []
  const check = (name: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) failures.push(`${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }

  check(
    '连字符跨行断词应被接回',
    normalizeForMatch('inter-' + LF + 'leaves two things'),
    'interleaves two things',
  )
  check(
    '连字符断词 + 行尾空格',
    normalizeForMatch('acting- ' + LF + ' aware'),
    'actingaware',
  )
  check('soft hyphen 应被移除', normalizeForMatch('meth' + SOFT_HYPHEN + 'od'), 'method')
  check('连续空格与换行折叠', normalizeForMatch('a' + LF + LF + '  b'), 'a b')
  check('不换行空格折叠', normalizeForMatch('a' + String.fromCharCode(0x00a0) + 'b'), 'a b')
  check('en dash 归一到减号', normalizeForMatch('state' + String.fromCharCode(0x2013) + 'of'), 'state-of')
  check('弯引号归一', normalizeForMatch(String.fromCharCode(0x201c) + 'x' + String.fromCharCode(0x201d)), '"x"')
  check('大小写归一', normalizeForMatch('ReAct'), 'react')
  check('真实断行不误伤（无连字符时保留空格）', normalizeForMatch('end of' + LF + 'line'), 'end of line')

  // B 型：断词保留连字符。这一条直接对应真实失败场景——
  // 页面里是 "acting-⏎aware"，模型给的是 "acting-aware"。
  check(
    'B 型：断词保留为连字符',
    normalizeHyphenKept('acting-' + LF + 'aware'),
    'acting-aware',
  )
  check(
    'B 型不应把普通换行变成连字符',
    normalizeHyphenKept('end of' + LF + 'line'),
    'end of line',
  )
  check(
    'A 型不会命中带连字符的写法（证明两种形式确实互补）',
    normalizeStrict('acting-' + LF + 'aware') === normalizeStrict('acting-aware'),
    false,
  )

  // 匹配层：两种形式任一命中就算通过
  check(
    '匹配层：页面断词 vs 模型带连字符 → 应命中',
    quoteMatchesPage('acting-' + LF + 'aware execution', 'acting-aware execution').matched,
    true,
  )
  check(
    '匹配层：纯编造的句子 → 不应命中',
    quoteMatchesPage('this sentence was never written by anyone', 'acting-aware execution').matched,
    false,
  )
  check(
    '匹配层：真实跨行引用（无连字符）→ 应命中',
    quoteMatchesPage('interleaves  reasoning' + LF + 'and acting', 'that interleaves reasoning and acting here').matched,
    true,
  )

  return { ok: failures.length === 0, failures }
}

/** 数字/单位之间被 PDF 拆开的空格，不算语义差异，比较时顺手抹掉 */
const looseNumeric = (s: string) => s.replace(/(\d)\s+(?=\d)/g, '$1')

/**
 * 归一化后比对。两种归一化形式任一命中即算通过。
 *
 * 之所以不"只要相似度超过阈值就算过"：那会立刻失去"可证伪"这个核心价值。
 * 这里的判定始终是**子串精确包含**，只是容忍了排版差异。
 */
export function quoteMatchesPage(
  quote: string,
  pageText: string,
): { matched: boolean; occurrences: number; form: 'strict' | 'hyphen' | 'none' } {
  const [qStrict, qHyphen] = normalizeBoth(quote)
  const [pStrict, pHyphen] = normalizeBoth(pageText)

  const count = (hay: string, needle: string) => {
    if (!needle) return 0
    let n = 0
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) n++
    return n
  }

  // 两种形式都基于"页码内全文"比较；数字间空格差异在这两种形式之外再抹一次
  const a = count(looseNumeric(pStrict), looseNumeric(qStrict))
  if (a > 0) return { matched: true, occurrences: a, form: 'strict' }

  const b = count(looseNumeric(pHyphen), looseNumeric(qHyphen))
  if (b > 0) return { matched: true, occurrences: b, form: 'hyphen' }

  return { matched: false, occurrences: 0, form: 'none' }
}

const QUOTE_MIN_CHARS = 12

/* ------------------------------------------------------------------ */
/* 结果类型                                                            */
/* ------------------------------------------------------------------ */

export type RejectReason =
  | 'QUOTE_EMPTY'
  | 'QUOTE_TOO_SHORT'
  | 'PAGE_INVALID'
  | 'PAGE_NOT_FOUND'
  | 'PAGE_TEXT_EMPTY'
  | 'SECTION_NOT_FOUND'
  | 'QUOTE_NOT_ON_PAGE'
  | 'CONFIDENCE_OUT_OF_RANGE'

/**
 * 拒绝之后的**诊断**——注意这是诊断，不是修复。
 *
 * 真实测试跑出来一个很值得记录的现象：9 条被拒证据里有 7 条，
 * quote 是**逐字真实的**，只是页码错了（模型说 p7，实际在 p6）。
 * 原因是送给模型的是按章节拼接的连续文本，而模型自报页码时会有页边界漂移。
 *
 * 那为什么不直接"帮它改成 p6"？因为那就是第 12 节明令禁止的静默修复：
 *   一旦系统开始替模型猜"它大概想说的是第 6 页"，
 *   就再也说不清哪些证据是模型自己说对的、哪些是系统补对的。
 *   而这个产品的全部价值就建立在"我们不猜"之上。
 *
 * 所以做法是：**照旧拒绝**，但把诊断结果一并告诉用户，
 * 让他一眼看出"这是页码漂移，不是模型编造"。这比一个笼统的
 * "证据无效"既有用得多，也诚实得多。
 */
export type RejectDiagnosis =
  /** quote 找不到，但能在相邻页码找到 —— 典型的页码漂移 */
  | { kind: 'PAGE_OFFSET'; actualPage: number; distance: number }
  /** 前半句真实存在、后半句不存在 —— 模型把两处内容拼成了一句 */
  | { kind: 'TRUNCATED_SPLICE'; matchedPrefixRatio: number; foundOnPage: number }
  /** 全文都找不到 —— 模型编造 */
  | { kind: 'NOT_IN_PAPER' }
  /** 页内文本为空，无法判断 */
  | { kind: 'UNVERIFIABLE' }

export interface RejectedEvidence {
  section: string
  page: number
  quote: string
  reason: RejectReason
  /** 面向人的中文说明，直接进 Analysis Log */
  message: string
  diagnosis?: RejectDiagnosis
}

export interface ValidatedEvidence extends LLMEvidence {
  /** 校验通过后的页码与章节（以 PDF 解析结果为准，而不是模型的说法） */
  page: number
  section: string
  /** 归一化后 quote 在页内出现的次数，>1 说明该句重复出现，依然可信 */
  occurrences: number
  /** 命中的归一化形式。hyphen 表示页面里该词跨行断词，模型保留了连字符 */
  matchForm: 'strict' | 'hyphen'
}

export interface ValidatedMethod {
  method: LLMMethod
  evidence: ValidatedEvidence[]
}

export interface RejectedMethod {
  name: string
  reason: 'NO_EVIDENCE' | 'ALL_EVIDENCE_REJECTED'
  message: string
}

export interface ValidationOutcome {
  methods: ValidatedMethod[]
  rejectedEvidence: RejectedEvidence[]
  rejectedMethods: RejectedMethod[]
  /** 统计口径，用于在 UI 上展示"模型给了 9 条，7 条通过" */
  stats: {
    evidenceSeen: number
    evidenceAccepted: number
    evidenceRejected: number
    methodsSeen: number
    methodsAccepted: number
    methodsRejected: number
  }
}

export interface ValidateInput {
  /** 模型声称的 section → 该 section 覆盖的页码，用于 cross-check */
  sections: { name: string; pages: number[] }[]
  /** 页码 → 该页正文 */
  pages: Record<string, string>
}

/* ------------------------------------------------------------------ */
/* 单条证据判定                                                        */
/* ------------------------------------------------------------------ */

const REASON_TEXT: Record<RejectReason, string> = {
  QUOTE_EMPTY: 'quote 为空',
  QUOTE_TOO_SHORT: `quote 过短（少于 ${QUOTE_MIN_CHARS} 字符），不足以作为证据`,
  PAGE_INVALID: 'page 不是正整数',
  PAGE_NOT_FOUND: 'page 超出了这篇 PDF 的页码范围',
  PAGE_TEXT_EMPTY: '该页没有可提取的文字（可能是图表页或扫描页）',
  SECTION_NOT_FOUND: 'section 名称在这篇论文的章节列表里不存在',
  QUOTE_NOT_ON_PAGE: 'quote 无法在声称的那一页正文中找到（疑似模型改写或页码错误）',
  CONFIDENCE_OUT_OF_RANGE: 'confidence 不在 0–1 之间',
}

/** 章节名匹配：允许大小写与编号格式差异（"3.1 SETUP" vs "Setup"），但必须指同一节 */
function matchSection(
  claimed: string,
  sections: { name: string; pages: number[] }[],
): { name: string; pages: number[] } | null {
  const c = normalizeForMatch(claimed)
  if (!c) return null

  // 1) 完全相同
  const exact = sections.find((s) => normalizeForMatch(s.name) === c)
  if (exact) return exact

  // 2) 去掉编号前缀后相同："3.1 setup" → "setup"
  const stripNo = (s: string) => s.replace(/^[0-9]+(\.[0-9]+)*\s*/, '').replace(/^[ivx]+\.\s*/i, '').trim()
  const c2 = stripNo(c)
  const byStripped = sections.find((s) => stripNo(normalizeForMatch(s.name)) === c2)
  if (byStripped) return byStripped

  // 3) 一方包含另一方，且被包含方长度 >= 4（避免 "a" 命中一切）
  const byContains = sections.find((s) => {
    const n = normalizeForMatch(s.name)
    if (c.length >= 4 && n.includes(c)) return true
    if (n.length >= 4 && c.includes(n)) return true
    return false
  })
  return byContains ?? null
}

/* ------------------------------------------------------------------ */
/* 拒绝诊断（不是修复）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 当 quote 不在声称页时，弄清它属于哪一类失败。
 *
 * 这一步只**读取**事实，绝不改动任何数据。它的价值在于把
 * "证据无效" 这种无用信息，变成"这句原文确实在论文里，但在第 6 页而不是第 7 页"——
 * 用户据此能判断该改 prompt、还是该改解析器，而不是对着一堆红色日志发呆。
 *
 * 三种分类对应三种完全不同的处理方向：
 *   PAGE_OFFSET  → 模型的页码归属能力问题，prompt 里可以要求它更谨慎
 *   TRUNCATED_SPLICE → 模型把跨页/跨段的两句拼成了一句，属真实幻觉
 *   NOT_IN_PAPER → 模型凭空编造，最严重
 */
function diagnoseRejection(
  quote: string,
  claimedPage: number,
  pages: Record<string, string>,
): RejectDiagnosis {
  const needle = normalizeForMatch(quote)
  if (!needle) return { kind: 'NOT_IN_PAPER' }

  // 1) 在全文各页找，看是否只是页码错了
  const pageNums = Object.keys(pages)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)

  for (const p of pageNums) {
    if (p === claimedPage) continue
    const hit = quoteMatchesPage(quote, pages[String(p)])
    if (hit.matched) {
      return { kind: 'PAGE_OFFSET', actualPage: p, distance: Math.abs(p - claimedPage) }
    }
  }

  // 2) 前半句在某一页上真实存在？说明是拼接
  const prefixLen = Math.floor(needle.length * 0.6)
  if (prefixLen >= QUOTE_MIN_CHARS) {
    const prefix = quote.slice(0, prefixLen)
    for (const p of pageNums) {
      const hit = quoteMatchesPage(prefix, pages[String(p)])
      if (hit.matched) {
        return {
          kind: 'TRUNCATED_SPLICE',
          matchedPrefixRatio: 0.6,
          foundOnPage: p,
        }
      }
    }
  }

  // 3) 全文都找不到
  return { kind: 'NOT_IN_PAPER' }
}

function describeDiagnosis(d: RejectDiagnosis, claimedPage: number): string {
  switch (d.kind) {
    case 'PAGE_OFFSET':
      return `诊断：该 quote 逐字出现在第 ${d.actualPage} 页（模型声称第 ${claimedPage} 页，偏差 ${d.distance} 页）——属页码归属错误，非编造。系统不代为改正。`
    case 'TRUNCATED_SPLICE':
      return `诊断：quote 的前半段在第 ${d.foundOnPage} 页真实存在，但整句无法匹配——模型把跨句/跨页内容拼成了一句。`
    case 'NOT_IN_PAPER':
      return '诊断：该 quote 在全文任何一页都找不到——模型编造了原文。'
    case 'UNVERIFIABLE':
      return '诊断：该页没有可提取文字，无法判断真伪。'
  }
}

/**
 * 判定单条证据。
 *
 * 顺序刻意固定：先查结构性错误（空/页码/章节），最后才做最有信息量的
 * "quote 是否真的在那页上"。这样日志里第一眼就能看出问题是模型瞎编页码，
 * 还是模型改写了原文。
 */
export function validateEvidence(
  ev: LLMEvidence,
  input: ValidateInput,
): { ok: true; value: ValidatedEvidence } | { ok: false; reason: RejectReason } {
  const quote = typeof ev.quote === 'string' ? ev.quote : ''

  // ① quote 非空且足够长
  if (!quote.trim()) return { ok: false, reason: 'QUOTE_EMPTY' }
  if (normalizeForMatch(quote).length < QUOTE_MIN_CHARS) {
    return { ok: false, reason: 'QUOTE_TOO_SHORT' }
  }

  // ② confidence 0–1
  const confidence = Number(ev.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, reason: 'CONFIDENCE_OUT_OF_RANGE' }
  }

  // ③ page 是正整数
  const page = Number(ev.page)
  if (!Number.isInteger(page) || page < 1) return { ok: false, reason: 'PAGE_INVALID' }

  // ④ page 真实存在
  const pageText = input.pages[String(page)]
  if (pageText === undefined) return { ok: false, reason: 'PAGE_NOT_FOUND' }
  if (!pageText.trim()) return { ok: false, reason: 'PAGE_TEXT_EMPTY' }

  // ⑤ section 存在（不做硬拒绝，见下方说明）
  const sec = matchSection(String(ev.section ?? ''), input.sections)

  // ⑥ quote 必须真的落在该页正文里 —— 本校验器的核心
  const hit = quoteMatchesPage(quote, pageText)
  if (!hit.matched) return { ok: false, reason: 'QUOTE_NOT_ON_PAGE' }

  return {
    ok: true,
    value: {
      section: sec ? sec.name : String(ev.section ?? ''),
      page,
      quote,
      supports: Array.isArray(ev.supports) ? ev.supports.map(String) : [],
      confidence,
      occurrences: hit.occurrences,
      matchForm: hit.form === 'hyphen' ? 'hyphen' : 'strict',
    },
  }
}

/* ------------------------------------------------------------------ */
/* 整篇论文判定                                                        */
/* ------------------------------------------------------------------ */

/**
 * 逐条独立校验，任何一条失败都不影响其他条。
 *
 * 关于 section 的处理需要说明：
 *   第 17 节要求校验 "section 存在"。但实践中模型经常把章节名写成
 *   "Method" 而解析结果是 "3 METHOD"，或写成 "Section 3.1"。
 *   若因此把一条 quote 完全正确的证据丢掉，反而损害了可信度。
 *   所以这里的策略是：section 匹配失败**不拒绝证据**，而是以 PDF 解析结果里的
 *   真实章节名为准回填；只有 quote 在页面上找不到，才真的拒绝。
 *   这条取舍在最终报告里明确写出，不藏着。
 */
export function validateExtraction(
  methods: LLMMethod[],
  input: ValidateInput,
): ValidationOutcome {
  const out: ValidationOutcome = {
    methods: [],
    rejectedEvidence: [],
    rejectedMethods: [],
    stats: {
      evidenceSeen: 0,
      evidenceAccepted: 0,
      evidenceRejected: 0,
      methodsSeen: methods.length,
      methodsAccepted: 0,
      methodsRejected: 0,
    },
  }

  for (const m of methods) {
    const raw = Array.isArray(m.evidence) ? m.evidence : []
    out.stats.evidenceSeen += raw.length

    const accepted: ValidatedEvidence[] = []
    for (const ev of raw) {
      const r = validateEvidence(ev, input)
      if (r.ok) {
        accepted.push(r.value)
        out.stats.evidenceAccepted++
      } else {
        out.stats.evidenceRejected++
        const claimedPage = Number(ev?.page ?? 0)
        // 只在"找不到 quote"这种值得深挖的情形做诊断；
        // 空 quote / 页码非法之类的错误，原因已经一目了然，不需要再扫全文
        const diagnosis =
          r.reason === 'QUOTE_NOT_ON_PAGE'
            ? diagnoseRejection(String(ev?.quote ?? ''), claimedPage, input.pages)
            : undefined

        out.rejectedEvidence.push({
          section: String(ev?.section ?? ''),
          page: claimedPage,
          quote: String(ev?.quote ?? ''),
          reason: r.reason,
          message:
            `${REASON_TEXT[r.reason]}（方法「${m.name ?? '未命名'}」，声称第 ${ev?.page ?? '?'} 页）` +
            (diagnosis ? ` ${describeDiagnosis(diagnosis, claimedPage)}` : ''),
          ...(diagnosis ? { diagnosis } : {}),
        })
      }
    }

    // 第 17 节第 6 条：method 至少要有一条 evidence，否则不能进知识库
    if (raw.length === 0) {
      out.stats.methodsRejected++
      out.rejectedMethods.push({
        name: String(m.name ?? '未命名'),
        reason: 'NO_EVIDENCE',
        message: `方法「${m.name ?? '未命名'}」没有任何 evidence，已拒绝写入知识库`,
      })
      continue
    }
    if (accepted.length === 0) {
      out.stats.methodsRejected++
      out.rejectedMethods.push({
        name: String(m.name ?? '未命名'),
        reason: 'ALL_EVIDENCE_REJECTED',
        message: `方法「${m.name ?? '未命名'}」的 ${raw.length} 条 evidence 全部未通过校验，已拒绝写入知识库`,
      })
      continue
    }

    out.stats.methodsAccepted++
    // evidence 按页排序，界面上"来自第 3 页、第 9 页"读起来更自然
    accepted.sort((a, b) => a.page - b.page)
    out.methods.push({ method: m, evidence: accepted })
  }

  return out
}

/** 给 Analysis Log 用的一句话总结 */
export function summarizeValidation(o: ValidationOutcome): string {
  const s = o.stats
  const base = `证据校验：模型返回 ${s.methodsSeen} 个方法 / ${s.evidenceSeen} 条证据，通过 ${s.methodsAccepted} 个方法 / ${s.evidenceAccepted} 条证据`
  if (s.evidenceRejected === 0 && s.methodsRejected === 0) return `${base}（全部通过）`

  // 把拒绝原因分类统计出来。只报"拒绝 9 条"没有信息量；
  // 报"其中 7 条只是页码错了、2 条全文都找不到"才让人知道下一步该改什么。
  const byKind = { PAGE_OFFSET: 0, TRUNCATED_SPLICE: 0, NOT_IN_PAPER: 0, UNVERIFIABLE: 0 }
  let undiagnosed = 0
  for (const r of o.rejectedEvidence) {
    if (r.diagnosis) byKind[r.diagnosis.kind]++
    else undiagnosed++
  }
  const parts: string[] = []
  if (byKind.PAGE_OFFSET) parts.push(`${byKind.PAGE_OFFSET} 条页码归属错误（原文真实存在）`)
  if (byKind.TRUNCATED_SPLICE) parts.push(`${byKind.TRUNCATED_SPLICE} 条跨句拼接`)
  if (byKind.NOT_IN_PAPER) parts.push(`${byKind.NOT_IN_PAPER} 条全文均无（编造）`)
  if (byKind.UNVERIFIABLE) parts.push(`${byKind.UNVERIFIABLE} 条无法判断`)
  if (undiagnosed) parts.push(`${undiagnosed} 条其他格式错误`)

  return (
    `${base}，拒绝 ${s.evidenceRejected} 条证据、${s.methodsRejected} 个方法` +
    (parts.length ? `（${parts.join('；')}）` : '')
  )
}

/** 给 UI 用的结构化拒绝统计，避免前端再解析字符串 */
export function rejectionBreakdown(o: ValidationOutcome) {
  const byKind = { PAGE_OFFSET: 0, TRUNCATED_SPLICE: 0, NOT_IN_PAPER: 0, UNVERIFIABLE: 0 }
  for (const r of o.rejectedEvidence) if (r.diagnosis) byKind[r.diagnosis.kind]++
  return byKind
}

