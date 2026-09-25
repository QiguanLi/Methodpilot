/**
 * 自然语言检索条件的解析（Phase 3B-3）。
 *
 * ── 这个文件在做什么 ──
 *
 * 把「帮我找近三年 AI Coding Agent 的 Tool Use 论文」拆成结构化条件：
 *   关键词 / 年份区间 / 任务 / 方法
 *
 * ── 为什么用规则而不是调 LLM ──
 *
 * 这是个刻意的选择，而且我认为是这一轮最重要的决定。
 *
 * 用 LLM 抽条件看起来更"智能"，但它有三个问题：
 *
 *   1. **用户看不见它为什么这么理解。** 模型把"近三年"理解成 2023-2025 还是
 *      2022-2024，界面上无从判断。而这正好决定了返回什么论文。
 *   2. **失败时无法解释。** 搜不到结果时，用户无法区分是"条件抽错了"
 *      还是"真的没有这类论文"。
 *   3. **多一个失败点。** 模型调用可能超时、可能被限流、可能返回格式不对，
 *      于是"搜索"这件事多了一条会挂的路。
 *
 * 规则解析的可取之处：**它是可预测、可复述、可纠正的**。
 * 页面会把抽出来的条件原样显示给用户，用户一眼能看出哪里理解错了，
 * 改一下说法重搜即可。这比"更聪明但说不清"更有用。
 *
 * 代价是覆盖面窄——只认中文和英文里常见的几种说法。
 * 认不出来时**如实留空**，而不是猜一个填进去。留空表示"没限定"，
 * 猜错表示"限定错了"，后者严重得多。
 */

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface ParsedQuery {
  /** 送给 Semantic Scholar 的检索词 */
  keywords: string[]
  /** 年份区间。null 表示用户没提年份 —— 不设限，而不是猜一个 */
  yearRange: { from: number; to: number } | null
  /** 年份的原始说法，用于在界面上复述"我是从哪句话里读出来的" */
  yearLabel: string
  /** 研究任务（如 Software Engineering Agent）。多个命中时取第一个 */
  task: string
  /** 方法/技术（如 Tool Use）。多个命中时取第一个 */
  method: string
  /** 全部命中的任务。用户说"多智能体和工具调用"时两个都在这里 */
  tasks: string[]
  /** 全部命中的方法 */
  methods: string[]
  /** 最终拼给 S2 的查询串 */
  s2Query: string
  /**
   * 是否有任何条件被识别出来。
   * false 时界面要提示"没读懂，正在按原句搜索"——
   * 否则用户会以为条件抽取生效了，而其实只是原文透传。
   */
  understood: boolean
}

/* ------------------------------------------------------------------ */
/* 词表                                                                */
/* ------------------------------------------------------------------ */

/**
 * 任务词表。
 *
 * 每个条目是 [规范名, 触发词...]。规范名会同时作为检索词参与拼装，
 * 所以它本身也必须是检索有效的英文术语。
 *
 * 顺序有意义：**长的、具体的词排在前面**。
 * 「AI Coding Agent」必须比「Agent」先匹配，否则前者永远轮不到。
 * 这是这类朴素匹配最容易出的错，也是唯一需要小心的地方。
 */
const TASKS: [string, string[]][] = [
  ['Software Engineering Agent', ['ai coding agent', 'coding agent', 'software engineering agent', '代码智能体', '编码智能体', '编程智能体']],
  ['Web Agent', ['web agent', 'browser agent', '网页智能体', '浏览器智能体']],
  ['Embodied Agent', ['embodied agent', '具身智能']],
  ['Multi-Agent System', ['multi-agent', 'multi agent', '多智能体', '多代理']],
  ['Question Answering', ['question answering', 'qa system', '问答']],
  ['Information Retrieval', ['information retrieval', '信息检索']],
  ['Code Generation', ['code generation', 'program synthesis', '代码生成', '程序合成']],
  ['Software Testing', ['software testing', 'test generation', '软件测试', '测试生成']],
  ['Autonomous Driving', ['autonomous driving', '自动驾驶']],
  ['Robotics', ['robotics', '机器人']],
]

/**
 * 方法/技术词表。
 *
 * 同样长的优先：「chain of thought」要先于「reasoning」——
 * 前者是具体技术，后者太泛，被泛词吃掉就丢了信息。
 */
const METHODS: [string, string[]][] = [
  ['Chain of Thought', ['chain of thought', 'chain-of-thought', 'cot', '思维链']],
  ['Tree of Thoughts', ['tree of thoughts', 'tree-of-thoughts', '思维树']],
  ['ReAct', ['react framework', 'reasoning and acting', 'react 框架']],
  ['Tool Use', ['tool use', 'tool-use', 'tool calling', 'tool-calling', 'function calling', '工具调用', '工具使用']],
  ['Retrieval Augmented Generation', ['retrieval augmented generation', 'retrieval-augmented', 'rag', '检索增强']],
  ['Reinforcement Learning', ['reinforcement learning', 'rlhf', '强化学习']],
  ['Fine-tuning', ['fine-tuning', 'finetuning', 'fine tuning', '微调']],
  ['In-context Learning', ['in-context learning', 'in context learning', 'few-shot', '上下文学习', '少样本']],
  ['Prompt Engineering', ['prompt engineering', '提示工程', '提示词']],
  ['Planning', ['planning', 'task decomposition', '规划', '任务分解']],
  ['Reflection', ['reflection', 'self-reflection', 'self-critique', '反思', '自我反思']],
]

/** 无实义、不应进入检索词的词 */
const STOPWORDS = new Set([
  '帮我', '帮', '我', '找', '查', '搜', '搜索', '检索', '看看', '想', '要', '请',
  '的', '了', '和', '与', '及', '或', '在', '中', '里', '方面', '相关', '关于',
  '论文', '文献', '文章', '研究', '工作', '一些', '几篇', '有哪些', '有什么',
  'paper', 'papers', 'find', 'search', 'look', 'for', 'me', 'please', 'about',
  'on', 'of', 'in', 'the', 'a', 'an', 'and', 'or', 'recent', 'latest', 'new',
  /*
   * 年份区间的连接词与泛称。
   *
   * 「between 2019 and 2024 reinforcement learning survey」里，
   * 年份解析只吃掉 `2019` 和 `2024`（以及它们的上下文），
   * `between` 留在原地成了"关键词"；`survey` 不是年份词，
   * 但它和"论文"一样是泛称，当检索词会把结果往综述上带偏。
   * 两者都会显示在【检索条件】里，被用户当成我们真的在搜的词。
   */
  'between', 'from', 'to', 'since', 'until', 'through', 'during',
  'survey', 'surveys', 'review', 'reviews', 'overview', 'study', 'studies',
  '综述', '回顾', '调研', '综述类',
])

/**
 * 中文的"客套前缀"。
 *
 * 中文不写空格，所以「帮我找近三年…」里「帮我找」是**一整个 token**，
 * 永远匹配不到上面那个按词列的停用词表——按空格分词对中文本来就失效。
 *
 * 处理办法是在分词**之前**，先把句首这类固定短语剥掉。
 * 只匹配句首（^）：句子中间的"找"可能是实义动词（"寻找规律"），
 * 无条件全局删除会把正常词也吃掉。
 */
const CN_PREFIXES = [
  '请帮我', '麻烦帮我', '帮我', '请帮', '麻烦', '请', '我想', '我要', '想要',
  '帮我找', '帮找', '找一下', '找一些', '找几篇', '找', '查一下', '查', '搜一下',
  '搜索', '搜', '检索', '看看', '有没有', '有哪些', '给我',
]

/** 反复剥句首客套词，直到没得剥（"请帮我找一下"要剥三次） */
function stripCnPrefix(s: string): string {
  let out = s.trim()
  for (let i = 0; i < 6; i++) {
    const hit = CN_PREFIXES.find((p) => out.startsWith(p))
    if (!hit) break
    out = out.slice(hit.length).trim()
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 年份                                                                */
/* ------------------------------------------------------------------ */

/**
 * 中文数字转阿拉伯数字。
 *
 * 必须支持的原因很实际：「近三年」里是**汉字三**，不是数字 3。
 * 这是中文口语里最常见的写法，而需求给的例句正是「近三年」——
 * 只认 \d 的话，最该work的例子反而work不了。
 *
 * 只处理 1–30 这个范围：年份跨度的合理上限，再大没有意义。
 * 不做通用的中文数字解析（「三千二百」这类）——那属于另一个问题，
 * 而在这里引入它只会增加出错面。
 */
const CN_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}
function cnToNumber(s: string): number | null {
  if (!s) return null
  if (/^\d{1,2}$/.test(s)) return Number(s)
  // 十 / 十一 / 二十 / 二十三
  const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s)
  if (m) {
    const tens = m[1] ? CN_DIGITS[m[1]] : 1
    const ones = m[2] ? CN_DIGITS[m[2]] : 0
    return tens * 10 + ones
  }
  return CN_DIGITS[s] ?? null
}

/** 匹配「近 3 年 / 近三年 / 最近五年 / past 3 years / last five years」 */
const RE_NEAR = new RegExp(
  `(?:近|最近|过去)\\s*(\\d{1,2}|[一二两三四五六七八九十]{1,3})\\s*年` +
    `|(?:past|last|recent)\\s+(\\d{1,2})\\s+years?`,
)

/**
 * 解析年份区间。
 *
 * 支持三种说法：
 *   - 「近 N 年 / 最近 N 年 / past N years / last N years」→ [今年-N+1, 今年]
 *   - 「20XX 年以来 / since 20XX / after 20XX」→ [20XX, 今年]
 *   - 「20XX 到 20XX / 20XX-20XX / between X and Y」→ 两端都含
 *
 * 「近三年」按 [今年-2, 今年] 算，因为"近三年"口语里就是含今年在内的三年。
 * 这个口径会原样显示在界面上（如「近三年 → 2024–2026」），
 * 所以即使理解得和用户想的不一样，他也能立刻看出来并换个说法。
 */
function parseYearRange(
  text: string,
  now: number,
): { range: { from: number; to: number } | null; label: string; consumed: string[] } {
  const t = text.toLowerCase()
  const consumed: string[] = []

  // 近 N 年 / 最近 N 年
  const near = RE_NEAR.exec(t)
  if (near) {
    const n = cnToNumber(near[1] ?? near[2] ?? '')
    if (n !== null && n >= 1) {
      const span = Math.min(n, 30)
      const zh = near[1] ? `近 ${span} 年` : `past ${span} years`
      return {
        range: { from: now - span + 1, to: now },
        label: `${zh} → ${now - span + 1}–${now}`,
        consumed: [near[0]],
      }
    }
  }

  // 具体年限区间：2020-2023 / 2020 到 2023 / between 2020 and 2023
  const span = /(20\d{2})\s*(?:-|–|~|到|至|to|and)\s*(20\d{2})/.exec(t)
  if (span) {
    const a = Number(span[1])
    const b = Number(span[2])
    const from = Math.min(a, b)
    const to = Math.max(a, b)
    return { range: { from, to }, label: `${from}–${to}`, consumed: [span[0]] }
  }

  // 某年之后 / 以来（连"年以来"一起吃掉，否则"以来"会漏成关键词）
  const since = /(20\d{2})\s*年?\s*(?:以来|之后|以后|起)|since\s+(20\d{2})|after\s+(20\d{2})/.exec(t)
  if (since) {
    const y = Number(since[1] ?? since[2] ?? since[3])
    return {
      range: { from: y, to: now },
      label: `${y} 年以来 → ${y}–${now}`,
      consumed: [since[0]],
    }
  }

  /*
   * 孤立的四位年份按"该年及以后"处理。
   * 这种写法（"找 2022 的 ReAct 论文"）在英文里罕见、中文里也少见，
   * 但比忽略它更接近用户意图——忽略会让年份条件静默失效。
   */
  const single = /\b(20\d{2})\b/.exec(t)
  if (single) {
    const y = Number(single[1])
    return { range: { from: y, to: now }, label: `${y} 年以来 → ${y}–${now}`, consumed: [single[0]] }
  }

  // 明确说了不限年份的情况
  const anyRe = /(?:不限|任意|所有)\s*年份|any\s+year|all\s+years/
  const anyM = anyRe.exec(t)
  if (anyM) {
    return { range: null, label: '不限年份', consumed: [anyM[0]] }
  }

  // 没提年份 —— 如实留空，不猜
  return { range: null, label: '', consumed: [] }
}

/* ------------------------------------------------------------------ */
/* 主解析                                                              */
/* ------------------------------------------------------------------ */

/**
 * 从词表里匹配**全部**命中的项，而不是只取第一个。
 *
 * 最初写成"命中即返回"，结果「找一下工具调用和思维链的论文」只能识别出
 * 两个方法里的一个——用户明确说了两件事，我们只听了半句。
 *
 * 返回全部命中的规范名 + 移除已消费片段后的文本。
 * 顺序仍按词表（长的在前），所以结果顺序是稳定的。
 */
function matchAll(text: string, table: [string, string[]][]): { values: string[]; rest: string } {
  let rest = text
  const values: string[] = []
  for (const [canonical, triggers] of table) {
    for (const trig of triggers) {
      if (rest.toLowerCase().includes(trig)) {
        // 全局移除该触发词（大小写不敏感）
        rest = rest.replace(new RegExp(escapeRe(trig), 'gi'), ' ')
        values.push(canonical)
        break
      }
    }
  }
  return { values, rest }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 从剩余文本里捞出可用的检索词。
 *
 * 两件事：
 *   1. 去掉停用词、年份数字、标点
 *   2. 相邻的英文词拼成一个短语（"language model" 作为一个词比拆成两个更准）
 *
 * 长度小于 2 的碎片直接丢弃：检索里单字母词只带来噪声。
 */
function extractKeywords(rest: string): string[] {
  // 剥掉句首客套词（中文无空格，必须在分词前做）
  let r = stripCnPrefix(rest)

  /*
   * 中文里的"的论文/的文章"这类尾部杂词，在分词后是独立 token，
   * 用停用词表就能清掉；但"的论文"粘在一起时清不掉，
   * 所以这里做一次子串替换，把常见的粘连尾巴去掉。
   */
  /*
   * 中文里的"的论文/的研究"这类尾部杂词。
   *
   * 「2022 年以来关于 RAG 的研究」分词后会得到 `的研究` 这**一个** token：
   * `的` 和 `研究` 各自都在停用词表里，但粘在一起就谁都匹配不到，
   * 于是"的研究"作为一个莫名其妙的检索词被送进 Semantic Scholar，
   * 还显示在【检索条件】里。子串替换能处理这种粘连，
   * 纯靠停用词表处理不了——这是分词粒度的问题，不是词表的问题。
   */
  r = r
    .replace(/(?:的)?(?:论文|文献|文章|研究|工作|paper|papers)$/i, ' ')
    .replace(/(?:相关|方面)(?:的)?/g, ' ')

  // 把所有非字母数字汉字换成空格，顺便干掉标点
  const cleaned = r.replace(/[^\w\u4e00-\u9fa5]+/g, ' ')

  const tokens = cleaned
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => !STOPWORDS.has(w.toLowerCase()))
    // 去掉纯年份（已经被年份解析消费过了）
    .filter((w) => !/^(19|20)\d{2}$/.test(w))
    .filter((w) => w.length >= 2)

  /**
   * 相邻英文词合并。
   *
   * 只合并连续 2–3 个英文词，且要求它们在全文中就是相邻的——
   * 这样 "large language model" 会合成一个短语，
   * 而 "Huang et al" 这种噪声不会跨停用词粘在一起。
   */
  const out: string[] = []
  let buf: string[] = []
  const flush = () => {
    if (buf.length >= 2) out.push(buf.join(' '))
    else if (buf.length === 1) out.push(buf[0])
    buf = []
  }
  for (const t of tokens) {
    const isAscii = /^[a-zA-Z][a-zA-Z0-9-]*$/.test(t)
    if (isAscii) {
      buf.push(t)
      if (buf.length === 3) flush()
    } else {
      flush()
      out.push(t)
    }
  }
  flush()

  // 去重但保持出现顺序
  return [...new Set(out.filter((w) => w.length >= 2))]
}

/**
 * 主入口。
 *
 * @param input  用户原始输入
 * @param nowYear 当前年份，由调用方传入而不是在这里取 Date —— 
 *                这样函数是纯的，测试里能固定住"今年"再断言区间。
 */
export function parseQuery(input: string, nowYear: number): ParsedQuery {
  const raw = String(input ?? '').trim()
  if (!raw) {
    return {
      keywords: [], yearRange: null, yearLabel: '', task: '', method: '',
      tasks: [], methods: [],
      s2Query: '', understood: false,
    }
  }

  const { range, label, consumed } = parseYearRange(raw, nowYear)

  /*
   * 年份说法必须先从文本里摘掉，再做词表匹配。
   *
   * 否则「近三年」会留在文本里，最后被英文/中文兜底当成一个关键词塞进检索串，
   * S2 就会去匹配"近三年"这三个字——它当然匹配不到任何东西。
   * 这类"条件已生效但仍泄漏进关键词"的 bug 不会报错，只会稀释检索结果。
   */
  let working = raw
  for (const c of consumed) {
    working = working.replace(new RegExp(escapeRe(c), 'i'), ' ')
  }

  // 先摘方法再摘任务：方法词更具体，被泛化的任务词吃掉就丢信息了
  const m = matchAll(working, METHODS)
  const t = matchAll(m.rest, TASKS)

  const keywords = extractKeywords(t.rest)

  /*
   * 拼装送往 S2 的查询串。
   *
   * 顺序：任务 → 方法 → 其余关键词。
   * S2 的检索是相关性排序的，把最"骨架"的词放前面更稳。
   *
   * 一个反直觉但重要的点：**这里不加年份限定词**。
   * "近三年" 如果变成 "2024 2025 2026" 塞进查询串，
   * 会把检索变成字面匹配年份，结果是灾难性的。
   * 年份要走 S2 的结构化参数（year 字段），见 provider 的 search()。
   */
  const parts: string[] = [...t.values, ...m.values, ...keywords]

  /*
   * 一个词都没抽出来时，退回原句。
   *
   * 这是"搜索失败不能白屏"的第一道保障：宁可拿一句啰嗦的自然语言去搜，
   * 也不能拼出一个空查询让 S2 返回 400。
   */
  const s2Query = parts.length > 0 ? parts.join(' ') : raw

  const understood =
    t.values.length > 0 || m.values.length > 0 || keywords.length > 0 || Boolean(range)

  return {
    keywords,
    yearRange: range,
    yearLabel: label,
    /* 多个任务/方法取第一个作为主标识，其余已并入关键词不丢信息 */
    task: t.values[0] ?? '',
    method: m.values[0] ?? '',
    /* 全部命中的也带上，供界面显示"还识别到哪些" */
    tasks: t.values,
    methods: m.values,
    s2Query,
    understood,
  }
}
