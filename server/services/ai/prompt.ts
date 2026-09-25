/**
 * 方法抽取 Prompt 与输出 Schema。
 *
 * Prompt 版本必须持久化到分析结果里。理由很实际：
 * 过一段时间回头看某个 Method，如果不知道它由哪版 prompt 产生，
 * 就无法判断"结论变差了"是因为模型升级还是因为 prompt 改坏了。
 */

import type { MethodExtractionInput } from './types.ts'

export const METHOD_EXTRACTION_PROMPT_VERSION = 'v1.1'

/**
 * 传给模型的 JSON Schema。
 *
 * 刻意做成"结构性约束"而非"建议"：
 *   - 所有数组字段都给 items 类型，避免模型塞字符串进来；
 *   - evidence 是 required，且内部 section/page/quote 全部 required，
 *     让模型没有"省略证据"的余地。
 */
export const METHOD_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    methods: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          name_zh: { type: 'string' },
          task: { type: 'string' },
          paradigm: {
            type: 'string',
            enum: ['Prompting', 'Fine-tuning', 'Agent', 'Multi-Agent', 'Tool-Augmented', 'Neuro-Symbolic'],
          },
          core_idea: { type: 'string' },
          modules: { type: 'array', items: { type: 'string' } },
          inputs: { type: 'array', items: { type: 'string' } },
          outputs: { type: 'array', items: { type: 'string' } },
          capabilities: { type: 'array', items: { type: 'string' } },
          advantages: { type: 'array', items: { type: 'string' } },
          limitations: { type: 'array', items: { type: 'string' } },
          evidence: {
            type: 'array',
            /**
             * 上限 3 是刻意的。上一版只给了 minItems:1，模型会为了"看起来充分"
             * 而凑证据——上一轮 15 条里 3 条是编造、1 条是跨句拼接。
             * 加上限等于告诉它：三条扎实的引用胜过八条猜的。
             */
            minItems: 1,
            maxItems: 3,
            items: {
              type: 'object',
              properties: {
                section: { type: 'string' },
                page: { type: 'integer' },
                /**
                 * minLength 只是给模型的强提示，**不是**放宽校验的替代品。
                 * Validator 侧 QUOTE_MIN_CHARS = 12 的判定原样保留、不降反升，
                 * 这里加下限是为了让模型别拿半句话当证据。
                 */
                quote: { type: 'string', minLength: 40 },
                supports: {
                  type: 'array',
                  items: {
                    type: 'string',
                    enum: ['方法核心思想', '关键模块', '能力主张', '局限'],
                  },
                },
                confidence: { type: 'number' },
              },
              required: ['section', 'page', 'quote', 'supports', 'confidence'],
            },
          },
        },
        required: ['name', 'evidence'],
      },
    },
  },
  required: ['methods'],
} as const

/** CLI provider 用 JSON 字符串形式传 schema */
export const METHOD_EXTRACTION_SCHEMA_JSON = JSON.stringify(METHOD_EXTRACTION_SCHEMA)

/* ------------------------------------------------------------------ */

const SYSTEM = `You are a rigorous computer-science research assistant. Your job is to read a paper and extract the METHOD(S) it proposes, together with verbatim evidence from the paper.

Every quote you return is machine-verified: a program searches the page you claim for
your exact quote. If the quote is not found character-for-character on that page, the
evidence is REJECTED and discarded. Paraphrasing, stitching, or guessing will always be
caught — there is no partial credit.

ABSOLUTE RULES — violating any of these makes your output useless:

1. Every method you report MUST be accompanied by at least one piece of evidence.

2. A quote MUST be ONE CONTINUOUS SPAN copied verbatim from the paper text.
   - NEVER join text from two different sentences with a comma or any other separator.
   - NEVER join text from two different pages or two different paragraphs.
   - NEVER insert a period or connector that is not in the original.
   - If a sentence continues on the next page, stop your quote at the page boundary.
   - Do NOT paraphrase, translate, shorten, tidy up, or fix typos. Copy exactly.

3. The quote MUST come from the page you claim in "page".
   The text is given to you under explicit [PAGE n] markers. Find your quote inside
   ONE marker block, then report that block's n. Do not estimate or count pages.

4. Prefer 1–3 of the MOST RELIABLE evidence items over a long list.
   - Return fewer quotes rather than padding with weak ones.
   - { "evidence": [ one perfectly copied quote ] } beats a list of five shaky ones.

5. If you cannot find a reliable verbatim quote for a claim, DO NOT return that claim.
   Returning fewer methods is acceptable. GUESSING IS NOT. Never fabricate a quote to
   make a method look supported.

6. Only extract methods this paper itself proposes. Do not extract baselines or
   prior work that the paper merely cites.

7. Output ONLY JSON matching the schema. No markdown fences, no commentary.

The evidence field "supports" must use exactly these Chinese labels:
  方法核心思想 / 关键模块 / 能力主张 / 局限
"confidence" is your own 0-1 estimate that the quote genuinely supports the claim.`

/**
 * 把正文按**真实页码**重新组织，而不是按章节拼接。
 *
 * 为什么必须改（这是本轮优化里唯一真正起作用的一处）：
 *   旧版把每个章节的 content 拼成一段连续文本，并在段首标注
 *   "SECTION: INTRODUCTION (pages 1,2,3,4)"。问题是——PDF 解析出的
 *   章节正文里**没有任何页边界**，模型看到的是一整坨 14507 字符的文字，
 *   根本无从知道第 2 页在哪里结束、第 3 页从哪里开始。
 *   于是它只能靠猜，猜错了就是我们观测到的页码漂移；
 *   更糟的是，当它把一句话跨页抄下来时，那句话在**任何单独一页**上都不存在，
 *   校验器只能判 TRUNCATED_SPLICE。
 *
 *   这两个失败模式其实是一个根因：模型看不见页边界。
 *
 * 现在的做法：改用 parsed.pages（逐页真实正文），逐页输出并冠以 [PAGE n] 标记。
 * 模型于是有了明确的可引用单位——"把某个 [PAGE n] 块里的一段连续原文抄下来"。
 *
 * ⚠️ 关键约束：**只取被选中章节覆盖到的页面**。
 *   input.pages 是整篇论文的逐页正文（33 页，含 REFERENCES）。
 *   如果直接把 input.pages 全部铺开，就等于绕过了 selectSections 的
 *   maxChars 预算与 REFERENCES 排除规则——上下文会从 4 万字涨到 11 万字，
 *   参考文献页还会被当成证据来源。
 *   所以这里用 sections 的 pages 求并集来划定范围，**保证送入模型的信息
 *   与旧版完全一致**，改变的只是组织方式，不是信息量。
 */
function buildPageBlocks(input: MethodExtractionInput): { text: string; pages: number[] } {
  // 被选中章节覆盖的页面集合——这就是本次允许引用的全部页码
  const allowed = new Set<number>()
  for (const s of input.sections) {
    for (const p of s.pages) allowed.add(p)
    if (s.pages.length === 0) allowed.add(s.page)
  }

  const sorted = [...allowed].filter((n) => Number.isFinite(n) && n >= 1).sort((a, b) => a - b)

  const blocks: string[] = []
  const used: number[] = []

  for (const n of sorted) {
    const raw = (input.pages[String(n)] ?? '').trim()
    if (!raw) continue
    used.push(n)
    blocks.push(`[PAGE ${n}]\n${raw}`)
  }

  return { text: blocks.join('\n\n'), pages: used }
}

export function buildMethodExtractionPrompt(input: MethodExtractionInput): string {
  // 只把"本次真正可引用"的页码列为合法值——不是把整篇论文的页码都列上
  const { text: pageBlocks, pages: includedPages } = buildPageBlocks(input)
  const pageIndex = includedPages.length
    ? includedPages
    : Object.keys(input.pages)
        .map(Number)
        .sort((a, b) => a - b)

  /*
   * 章节清单仍然给出，但降级为"导航信息"而非承载正文的容器：
   * 模型需要知道 INTRODUCTION / METHODS 叫什么，才能填 evidence.section。
   * 正文本身一律走 [PAGE n] 块。
   */
  const sectionNav = input.sections
    .filter((s) => s.content.trim().length > 80)
    .map((s) => {
      const label = s.pages.length > 1 ? `pages ${s.pages.join(',')}` : `page ${s.page}`
      return `  - ${s.name}  (${label})`
    })
    .join('\n')

  return `PAPER METADATA
Title   : ${input.title}
Authors : ${input.authors.slice(0, 8).join(', ') || '(unknown)'}
Year    : ${input.year || '(unknown)'}
${input.abstract ? `Abstract: ${input.abstract.slice(0, 1600)}` : ''}
${input.taskHint ? `Research task hint: ${input.taskHint}` : ''}

SECTION INDEX (use these exact names for the evidence "section" field)
${sectionNav}

AVAILABLE PAGE NUMBERS: ${pageIndex.join(', ')}
(These are the ONLY valid values for evidence.page.)

═══════════════════════════════════════════════════════════════════════
PAPER CONTENT, ORGANISED BY PAGE
═══════════════════════════════════════════════════════════════════════
Each block below starts with a [PAGE n] marker. That marker is the ground truth
for the "page" field.

HOW TO BUILD A QUOTE:
  Step 1. Locate the sentence you want inside ONE [PAGE n] block.
  Step 2. Copy it out character-for-character, exactly as printed.
  Step 3. Report that block's n as "page".

  A quote must sit entirely inside a single block. If the sentence you want runs
  past the end of a block, cut your quote short at the block boundary —
  a shorter quote that is exactly right beats a longer one that spans two pages.

${pageBlocks}

═══════════════════════════════════════════════════════════════════════

PAGE COVERAGE NOTE
The blocks above cover exactly pages: ${includedPages.join(', ')}
No other page may be cited. Pages outside this list (references, appendix, or
content trimmed for length) were intentionally excluded and must not be used
as evidence sources.

TASK
Extract the method(s) proposed by THIS paper. For each method, return the structured
fields plus 1–3 evidence items, each a continuous verbatim quote from a single
[PAGE n] block with that block's page number.

Quality over quantity: it is entirely acceptable to return a method with just one
perfectly copied quote. Do NOT pad the list. Do NOT guess.

Respond with JSON only.`
}

export const getSystemPrompt = () => SYSTEM

/** 翻译 prompt：单独走一次调用，避免和抽取耦合导致一处失败全失败 */
export function buildTranslatePrompt(quotes: string[]): string {
  return `Translate each of the following English excerpts from a computer-science paper into concise, accurate Simplified Chinese.
Return ONLY a JSON array of strings, in the same order, with the same length (${quotes.length} items).
Do not merge, split, reorder, or add commentary.

${quotes.map((q, i) => `[${i + 1}] ${q}`).join('\n\n')}`
}

export const TRANSLATE_SYSTEM =
  'You are a precise academic translator. Output only a JSON array of strings.'

/* ------------------------------------------------------------------ */
/* 阶段③ 方法分类                                                       */
/* ------------------------------------------------------------------ */

/**
 * 分类 prompt 的版本号。
 *
 * 与抽取的版本号**分开**：分类和抽取是两个独立的能力，
 * 混用一个版本号会导致"只想改分类 prompt"时把抽取的去重缓存也一起失效。
 */
export const METHOD_CLASSIFICATION_PROMPT_VERSION = 'c1.0'

/**
 * 分类的输出 Schema。
 *
 * 关键设计：`family_id` 允许 **null**。
 *
 * 这是整个阶段最容易被写错、也最不该妥协的一处。
 * 如果把 family_id 写成 `{ type: 'string', enum: [F1..F5] }`，
 * 就等于逼模型在 5 个族里选一个——它**一定会选**，
 * 哪怕这篇论文的方法跟哪个族都不像。那是"为了填满字段而分类"。
 *
 * 所以：enum 里显式包含 null，并且 system prompt 里反复讲清
 * "返回 null 是预期内的正确答案，不是失败"。
 * 下游拿到 null 就写空串（未分类哨兵），界面照实显示「未分类」。
 */
export const METHOD_CLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    classifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          method_id: { type: 'string' },
          /** null = 未分类。这不是错误，是正确答案之一 */
          family_id: { type: ['string', 'null'], enum: ['F1', 'F2', 'F3', 'F4', 'F5', null] },
          family_name: { type: ['string', 'null'] },
          /** 归类理由，必须引用 evidence_ids 里那些原文说了什么 */
          reason: { type: 'string' },
          /** 支撑这次分类的 evidence_id 列表，取自给定的既有证据 */
          evidence_ids: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
        },
        required: ['method_id', 'family_id', 'reason', 'evidence_ids', 'confidence'],
      },
    },
  },
  required: ['classifications'],
} as const

/** CLI provider 用 JSON 字符串形式传 schema */
export const METHOD_CLASSIFICATION_SCHEMA_JSON = JSON.stringify(METHOD_CLASSIFICATION_SCHEMA)

const CLASSIFY_SYSTEM = `You are a rigorous computer-science research taxonomist. You are given a list of METHODs that have ALREADY been extracted from a paper and ALREADY had their evidence verbatim-verified. Your job is to assign each method to at most one method family.

You are NOT allowed to invent methods, invent evidence, or re-read the paper. Work ONLY from the material given to you.

ABSOLUTE RULES — violating any of these makes your output useless:

1. The ONLY valid values for "family_id" are: F1, F2, F3, F4, F5, or null.
   Never output any other string. Never output a family name in "family_id".

2. Returning family_id = null is a CORRECT and EXPECTED answer.
   This is the single most important rule. A method that does not clearly belong
   to any family MUST get null. Do NOT assign a family just to fill the field.
   An honest null is worth far more than a wrong label — a wrong label silently
   corrupts the method map, while a null is visibly "unclassified" and costs nothing.
   When you are not confident, return null. There is no penalty for null.

3. "reason" MUST be grounded in the evidence you were given.
   - Refer to what the cited quotes actually say, not to what you remember
     about this kind of work in general.
   - Do NOT write a reason that would apply equally to every method in the list
     (e.g. "this is an agent method"). Reasons must discriminate.
   - If you return null, the reason must explain specifically WHY the method
     does not fit any family, in the same evidence-grounded style.

4. "evidence_ids" MUST be drawn ONLY from the evidence ids listed for that
   method. Never invent an id, never borrow an id from another method.
   - If you assign a family, give at least one evidence id that supports it.
   - If the available evidence is too weak or too generic to decide, that is
     exactly the case where you should return family_id = null.

5. Judge each method INDEPENDENTLY. Two methods from the same paper may well
   belong to different families, or one may be classifiable and the other not.
   Do not try to spread the methods evenly across families.

6. A family may end up empty. Do NOT feel obliged to use all five.

7. Output ONLY JSON matching the schema. No markdown fences, no commentary.
   Return exactly one classification object per method given, in the same order,
   using the same method_id string you were given.

"confidence" is your own 0-1 estimate. It should be LOW when the evidence is thin,
and it does NOT license guessing — low confidence with a family_id is worse than
high confidence with null.`

export interface ClassifyPromptMethod {
  method_id: string
  name: string
  name_zh: string
  task: string
  paradigm: string
  core_idea: string
  modules: string[]
  capabilities: string[]
  limitations: string[]
  /** 该方法的证据，全部已通过 Evidence Validator 的逐字回验 */
  evidence: { evidence_id: string; section: string; page: number; content: string; supports: string[] }[]
}

export interface ClassifyPromptInput {
  title: string
  methods: ClassifyPromptMethod[]
}

/**
 * 构造分类 prompt。
 *
 * 这里的输入刻意**是结构化的已校验数据**，而不是论文原文。
 * 理由：分类依据必须是"已经站得住的证据"，而不是模型对论文的重新解读。
 * 把原文再塞一遍，模型就有机会绕开证据、靠印象分类，
 * 那样 reason 里引用的原文可能压根不在 evidence 列表里——要求 4 就成了空话。
 *
 * 所以这里只给：方法画像 + 已校验证据 + 族清单。模型没有别的可看。
 */
export function buildClassificationPrompt(input: ClassifyPromptInput): string {
  const blocks = input.methods
    .map((m) => {
      const evText = m.evidence.length
        ? m.evidence
            .map(
              (e) =>
                `    [${e.evidence_id}] (${e.section || '未标注章节'}, p.${e.page})` +
                `${e.supports.length ? ` supports=${e.supports.join('/')}` : ''}\n      「${e.content}」`,
            )
            .join('\n')
        : '    （无可用证据）'

      return `──────────────────────────────────────────────────────────────
METHOD ${m.method_id}
  name      : ${m.name || '(unnamed)'}
  name_zh   : ${m.name_zh || '(none)'}
  task      : ${m.task || '(none)'}
  paradigm  : ${m.paradigm || '(none)'}
  core_idea : ${m.core_idea || '(none)'}
  modules   : ${m.modules.join(' / ') || '(none)'}
  capabilities: ${m.capabilities.join(' / ') || '(none)'}
  limitations : ${m.limitations.join(' / ') || '(none)'}

  VERIFIED EVIDENCE (these ids are the ONLY valid values for evidence_ids):
${evText}`
    })
    .join('\n\n')

  return `PAPER: ${input.title || '(untitled)'}

You must classify each of the ${input.methods.length} method(s) below into at most one method family.

═══════════════════════════════════════════════════════════════════════
METHOD FAMILY MENU — these are the ONLY valid family_id values
═══════════════════════════════════════════════════════════════════════
  F1  Software Engineering Agent / 软件工程智能体
       判据：面向真实代码仓库的端到端问题求解，覆盖定位、编辑、测试、迭代修复全流程。
  F2  Tool-Using Agent / 工具调用智能体
       判据：让模型自主决定何时、如何调用外部工具与 API，把推理能力延伸到外部世界。
  F3  Planning & Reflection / 规划与反思
       判据：通过搜索式规划、自我批判与语言化反思，提升长程决策质量。
  F4  Multi-Agent Collaboration / 多智能体协作
       判据：多个角色化 Agent 通过结构化对话分工协作，完成单 Agent 难以覆盖的复杂工程任务。
  F5  Code Generation & Evaluation / 代码生成与评测
       判据：大规模代码生成、筛选排序方法，以及支撑整个领域评测的基准体系。

  null  未分类
       判据：证据不足以把该方法可靠地归入上面任何一个族。
       这是合法且常见的答案，不是失败。

═══════════════════════════════════════════════════════════════════════
METHODS TO CLASSIFY
═══════════════════════════════════════════════════════════════════════

${blocks}

═══════════════════════════════════════════════════════════════════════

TASK
For EACH method above, return one classification object with:
  - method_id   : exactly the id shown above (e.g. "M001")
  - family_id   : "F1".."F5", or null if the method does not clearly belong to any
  - family_name : the family's English name, or null when family_id is null
  - reason      : WHY, grounded in the evidence quotes shown above.
                  Quote or closely paraphrase the actual evidence text.
                  When returning null, explain what is missing or ambiguous.
  - evidence_ids: ids copied from THAT method's VERIFIED EVIDENCE list
  - confidence  : 0-1

BASIS FOR JUDGEMENT
Decide from the core_idea and the evidence quotes — that is what the paper
actually claims. Do not classify from the method's name alone, and do not
classify from what you happen to know about similar systems.

REMINDER
Returning null is the right answer whenever the evidence does not clearly
support one specific family. Do not force a label. A "reason" that could be
copy-pasted onto every other method in this list will be treated as a failure.

Respond with JSON only.`
}

export const getClassifySystemPrompt = () => CLASSIFY_SYSTEM
