#!/usr/bin/env node
/**
 * 相关性打分与排序测试（Phase 3B-4）。
 *
 * 验的是两件需求里点名的事：
 *   1. **同一查询下结果排序稳定** —— 不能这次 A 在前、下次 B 在前
 *   2. **分数计算可复现** —— 同样的输入必须得到同样的分数
 *
 * 为什么这两条值得单独测：
 *   它们是"用户能不能信任这个排序"的全部依据。分数算得不准，
 *   用户看几次就能感觉到；但排序**不稳定**是更坏的情况——
 *   同一句话搜两次顺序不同，用户会认为整个功能是坏的，
 *   而且他会去怀疑自己记错了，而不是来反馈。
 *   这类 bug 不会抛异常、不会写日志，只会安静地让人困惑。
 *
 * 运行：pnpm relevance:test
 *
 * 实现说明：relevance.ts 是**纯函数**（不读 config、不发请求），
 * 所以这里直接用 Node 的类型擦除 import 就行，不需要像 verify-data.mjs
 * 那样先用 rolldown 打包。这也是当初把它单独成模块的原因之一。
 */

import { computeRelevance, rankPapers } from '../server/services/relevance.ts'

/* ------------------------------------------------------------------ */

const errors = []
const check = (cond, msg) => {
  if (!cond) errors.push(msg)
}
const pct = (r) => `${Math.round(r * 100)}%`

/* ------------------------------------------------------------------ */
console.log('— 1. 分数可复现 —')
/* ------------------------------------------------------------------ */

const sample = { title: 'Tool Use in Software Engineering Agents', abstract: 'We study tool use.' }
const terms = ['Tool Use', 'Software Engineering Agent']

const runs = [computeRelevance(sample, terms), computeRelevance(sample, terms), computeRelevance(sample, terms)]
check(runs.every((r) => r.ratio === runs[0].ratio), '同一输入连算三次得到不同 ratio（不可复现）')
check(runs.every((r) => r.percent === runs[0].percent), '同一输入连算三次得到不同 percent（不可复现）')
console.log(`  三次 ratio = ${runs.map((r) => r.ratio.toFixed(6)).join(' / ')}`)
console.log(`  三次 percent = ${runs.map((r) => r.percent).join(' / ')}`)

/* ------------------------------------------------------------------ */
console.log('\n— 2. 排序稳定（含并列 tie-break）—')
/* ------------------------------------------------------------------ */

/*
 * 刻意造三篇**完全同分**的论文。
 * 这是最容易出问题的情况：如果排序只按分数、不写 tie-break，
 * 顺序就取决于输入顺序，而输入顺序来自 S2 —— 我们控制不了。
 * 所以这里把输入反转，要求输出顺序不变。
 */
const tied = [
  { paper_id: 'p-bbb', title: 'tool use', abstract: '', citationCount: 5 },
  { paper_id: 'p-aaa', title: 'tool use', abstract: '', citationCount: 5 },
  { paper_id: 'p-ccc', title: 'tool use', abstract: '', citationCount: 99 },
]
const order1 = rankPapers(tied, ['Tool Use']).map((p) => p.paper_id).join(',')
const order2 = rankPapers([...tied].reverse(), ['Tool Use']).map((p) => p.paper_id).join(',')
const order3 = rankPapers([tied[1], tied[2], tied[0]], ['Tool Use']).map((p) => p.paper_id).join(',')
check(order1 === order2, `输入反转后排序变了：${order1} vs ${order2}`)
check(order1 === order3, `输入乱序后排序变了：${order1} vs ${order3}`)
console.log(`  输入正序 / 逆序 / 乱序 → ${order1} / ${order2} / ${order3}`)
console.log('  同分时按引用数降序，再按 paper_id 字典序（不依赖运行时）')

/* 分数不同时，引用数不得越权 */
const mixed = [
  { paper_id: 'x-low', title: 'unrelated text', abstract: '', citationCount: 99999 },
  { paper_id: 'x-high', title: 'tool use planning reflection', abstract: '', citationCount: 1 },
]
const mixedOrder = rankPapers(mixed, ['Tool Use', 'Planning', 'Reflection']).map((p) => p.paper_id)
check(
  mixedOrder[0] === 'x-high',
  `高引用但低相关的论文排到了前面（citationCount 越权影响了排序）：${mixedOrder.join(',')}`,
)
console.log(`  高相关/低引用 vs 低相关/99999引用 → ${mixedOrder.join(' , ')}`)

/* ------------------------------------------------------------------ */
console.log('\n— 3. 单调性：覆盖越多检索词，分越高 —')
/* ------------------------------------------------------------------ */

const t3 = ['Tool Use', 'Planning', 'Reflection']
const c1 = computeRelevance({ title: 'tool use', abstract: '' }, t3)
const c2 = computeRelevance({ title: 'tool use and planning', abstract: '' }, t3)
const c3 = computeRelevance({ title: 'tool use planning reflection', abstract: '' }, t3)
check(c1.ratio < c2.ratio, `覆盖 1/3 (${pct(c1.ratio)}) 未低于 2/3 (${pct(c2.ratio)})`)
check(c2.ratio < c3.ratio, `覆盖 2/3 (${pct(c2.ratio)}) 未低于 3/3 (${pct(c3.ratio)})`)
check(c3.percent === 100, `全覆盖应得 100%，实际 ${c3.percent}%`)
console.log(`  1/3 → ${pct(c1.ratio)}   2/3 → ${pct(c2.ratio)}   3/3 → ${pct(c3.ratio)}`)

/* ------------------------------------------------------------------ */
console.log('\n— 4. 标题权重高于摘要 —')
/* ------------------------------------------------------------------ */

const inTitle = computeRelevance({ title: 'tool use', abstract: '' }, ['Tool Use'])
const inAbs = computeRelevance({ title: 'nothing relevant', abstract: 'tool use', keywords: [] }, ['Tool Use'])
check(inTitle.ratio > inAbs.ratio, `标题命中未高于摘要命中：${pct(inTitle.ratio)} vs ${pct(inAbs.ratio)}`)
console.log(`  只命中标题 ${pct(inTitle.ratio)} > 只命中摘要 ${pct(inAbs.ratio)}`)

/* ------------------------------------------------------------------ */
console.log('\n— 5. 子串假阳性必须不命中 —')
/* ------------------------------------------------------------------ */

/*
 * 这一类错误**不报任何错**：`includes('plan')` 会让 explanation 命中，
 * 分数虚高、排序悄悄错掉，没有任何迹象。
 * 本项目已经踩过同类的坑（一个被转义写坏的正则静默永不匹配，
 * 以及 keywords 剥离正则漏了「链接:」导致 URL 漏到界面）。
 */
const trap = { title: 'An explanation of quality assurance', abstract: '' }
check(computeRelevance(trap, ['plan']).ratio === 0, 'plan 命中了 explanation（子串假阳性）')
check(computeRelevance(trap, ['qa']).ratio === 0, 'qa 命中了 quality（子串假阳性）')
check(computeRelevance({ title: 'task planning', abstract: '' }, ['plan']).ratio === 0, 'plan 命中了 planning（词形不同不应算命中）')
check(computeRelevance({ title: 'task planning', abstract: '' }, ['planning']).ratio > 0, 'planning 未命中 task planning（真命中被漏掉）')
console.log('  plan ↛ explanation / qa ↛ quality / planning ✓ task planning')
console.log('  注：plan 不命中 planning 是刻意的——本打分器不做词形还原')

/* 多 token 检索词：部分命中不算命中 */
const partial = computeRelevance({ title: 'we study agents', abstract: '' }, ['Software Engineering Agent'])
check(partial.ratio === 0, `"Software Engineering Agent" 因单个 agent 命中被算作命中（应为 0，实际 ${pct(partial.ratio)}）`)
console.log(`  只有 agent 命中 → ${pct(partial.ratio)}（多 token 词要求全部命中）`)

/*
 * 单复数归并：必须**双向**成立。
 *
 * 这一条是测试真的抓出来的 bug：论文标题写复数 "Agents" 是常态，
 * 而检索词是单数 "Agent"。不做归并时最切题的论文只拿 40%，
 * 并且和一篇完全无关的论文并列 0%，最后靠引用数把无关的排到了前面。
 * 两个方向都要测——只测一边的话，实现里只归并单边的错误不会被发现。
 */
const singularTermPluralText = computeRelevance(
  { title: 'Tool Use in Software Engineering Agents', abstract: '' },
  ['Software Engineering Agent'],
)
const pluralTermSingularText = computeRelevance(
  { title: 'Software Engineering Agent Systems', abstract: '' },
  ['Software Engineering Agents'],
)
check(singularTermPluralText.ratio > 0, '单数检索词未命中复数文本（agent ↛ agents）')
check(pluralTermSingularText.ratio > 0, '复数检索词未命中单数文本（agents ↛ agent）')

/*
 * 反向守卫：归并**不能**宽到把不同词也归并掉。
 * `agentic` 不是 `agent` 的复数（是形容词），不该算命中——
 * 归并一旦过宽，会让大量"看着像但不是一个东西"的论文得分虚高。
 * 同理 `planning` 与 `plan` 是两个概念，不做 -ing 还原。
 */
check(
  computeRelevance({ title: 'software engineering agentic workflows', abstract: '' }, ['Software Engineering Agent']).ratio === 0,
  'agentic 被错误地归并成了 agent',
)
check(
  computeRelevance({ title: 'task planning', abstract: '' }, ['plan']).ratio === 0,
  'planning 被错误地归并成了 plan（不该做 -ing 还原）',
)
console.log(`  agent ↔ agents 双向命中：${pct(singularTermPluralText.ratio)} / ${pct(pluralTermSingularText.ratio)}`)
console.log('  agentic ↛ agent、planning ↛ plan（归并未过宽）')

/* 中文检索词：不能套 \b（\b 对汉字不成立，会永远匹配不上） */
const cn = computeRelevance({ title: '工具调用与思维链', abstract: '' }, ['工具调用'])
check(cn.ratio > 0, '中文检索词「工具调用」未命中（\\b 对汉字无效）')
console.log(`  中文「工具调用」→ ${pct(cn.ratio)}`)

/* ------------------------------------------------------------------ */
console.log('\n— 6. 比率不为 NaN，且不超过 100% —')
/* ------------------------------------------------------------------ */

const empty = computeRelevance({ title: 'x', abstract: 'y' }, [])
check(Number.isFinite(empty.ratio), '空 terms 时 ratio 不是有限数（NaN 会渲染成 "NaN%"）')
check(empty.percent === 0, `空 terms 时 percent 应为 0，实际 ${empty.percent}`)

const allTerms = computeRelevance({ title: 'Tool Use Planning Reflection', abstract: '' }, t3)
check(allTerms.ratio <= 1, `ratio 超过 1（界面会显示 >100%）：${allTerms.ratio}`)
check(allTerms.percent <= 100, `percent 超过 100：${allTerms.percent}`)
console.log(`  空 terms → ${empty.percent}%（有限数）   全覆盖 → ${allTerms.percent}%（未溢出）`)

/* ------------------------------------------------------------------ */
console.log('\n— 7. citationCount 原样保留 —')
/* ------------------------------------------------------------------ */

const before = [
  { paper_id: 'k1', title: 'tool use', abstract: '', citationCount: 42 },
  { paper_id: 'k2', title: 'planning', abstract: '', citationCount: 7 },
]
const after = rankPapers(before, ['Tool Use', 'Planning'])
check(after.length === before.length, '排序后条数变了')
for (const orig of before) {
  const found = after.find((p) => p.paper_id === orig.paper_id)
  check(Boolean(found), `排序后丢失了论文 ${orig.paper_id}`)
  check(
    found && found.citationCount === orig.citationCount,
    `论文 ${orig.paper_id} 的 citationCount 被改动了：${orig.citationCount} → ${found?.citationCount}`,
  )
}
console.log(`  ${after.map((p) => `${p.paper_id}:${p.citationCount}`).join(' , ')}（引用数未被排序改写）`)

/* ------------------------------------------------------------------ */
console.log('\n— 8. Mock 分数 deterministic 且互不相同 —')
/* ------------------------------------------------------------------ */

/*
 * Mock 三篇的标题摘要完全一致，靠文本算必然同分——
 * 那样"排序稳定"是平凡真，测试会掩盖 bug。
 * 所以 mock 用预先定好的递减 mockRelevance。
 * 这里验证它确实递减、确实可复现。
 */
const mock = (i, n = 3, query = 'demo query') => ({
  paper_id: `mock:search-tag-${i + 1}`,
  title: `示例论文 ${i + 1}：与「${query}」相关的占位数据`,
  abstract: '【Mock 数据】Semantic Scholar 不可达，以下为占位内容，不代表任何真实论文',
  citationCount: 0,
  mockRelevance: (n - i) / n,
})
const mockPapers = [mock(0), mock(1), mock(2)]

const m1 = rankPapers(mockPapers, ['Tool Use'])
const m2 = rankPapers([...mockPapers].reverse(), ['Tool Use'])
const mIds1 = m1.map((p) => p.paper_id).join(',')
const mIds2 = m2.map((p) => p.paper_id).join(',')
const pcts = m1.map((p) => p.relevance.percent)

check(mIds1 === mIds2, `Mock 输入反转后排序变了：${mIds1} vs ${mIds2}`)
check(new Set(pcts).size === pcts.length, `Mock 三篇分数相同（排序未被真正检验）：${pcts.join(',')}`)
check(pcts[0] > pcts[1] && pcts[1] > pcts[2], `Mock 分数未降序：${pcts.join(' > ')}`)
check(m1.every((p) => p.citationCount === 0), 'Mock 的 citationCount 被改动')
console.log(`  Mock 排序 → ${mIds1}`)
console.log(`  Mock 分数 → ${pcts.join('% > ')}%（互异、降序、可复现）`)

/* ------------------------------------------------------------------ */
console.log('\n— 9. 需求原句端到端 —')
/* ------------------------------------------------------------------ */

/*
 * 「帮我找近三年 AI Coding Agent 的 Tool Use 论文」
 * 解析结果（Phase 3B-3 已验证）：
 *   task = Software Engineering Agent, method = Tool Use, keywords = []
 * 所以打分 terms = ['Software Engineering Agent', 'Tool Use']
 */
const realTerms = ['Software Engineering Agent', 'Tool Use']
const candidates = [
  {
    paper_id: 'r-off',
    title: 'A Survey of Database Indexing',
    abstract: 'We review B-tree variants.',
    citationCount: 500,
  },
  {
    paper_id: 'r-partial',
    title: 'Software Engineering Agents: A Survey',
    abstract: 'We review agents for software engineering tasks.',
    citationCount: 10,
  },
  {
    paper_id: 'r-full',
    title: 'Tool Use in Software Engineering Agents',
    abstract: 'We study how software engineering agents use tool use.',
    citationCount: 3,
  },
]
const ranked = rankPapers(candidates, realTerms)
check(realTerms.length > 0, '需求原句未解析出任何检索词')
check(
  ranked[0].paper_id === 'r-full',
  `最切题的论文未排第一，实际第一是 ${ranked[0].paper_id}`,
)
check(
  ranked[ranked.length - 1].paper_id === 'r-off',
  `完全无关的论文未排最后，实际最后是 ${ranked[ranked.length - 1].paper_id}`,
)
/*
 * 断言**完整顺序**而不只是首尾。
 * 只查首尾的话，"中间两篇颠倒"这类错误测不出来——
 * 而那正是最可能出现的错误（分数接近时的排序）。
 */
check(
  ranked.map((p) => p.paper_id).join(',') === 'r-full,r-partial,r-off',
  `完整排序不符，实际：${ranked.map((p) => p.paper_id).join(',')}`,
)
/*
 * 相关性必须严格递减，不能出现"A 排在 B 前但分数更低"。
 * 这是排序正确性最直接的表述。
 */
check(
  ranked[0].relevance.ratio > ranked[1].relevance.ratio &&
    ranked[1].relevance.ratio > ranked[2].relevance.ratio,
  `分数未严格递减：${ranked.map((p) => p.relevance.percent).join(' / ')}`,
)
console.log(`  terms = ${realTerms.join(' + ')}`)
for (const p of ranked) {
  console.log(`    ${String(p.relevance.percent).padStart(3)}%  ${p.paper_id.padEnd(10)} 被引 ${String(p.citationCount).padStart(4)}  ${p.title}`)
}
console.log('  注：r-off 引用数最高(500)但排最后 —— 引用数不参与打分，只在同分时做次序决断')

/* ------------------------------------------------------------------ */

if (errors.length) {
  console.log(`\n✗ 发现 ${errors.length} 处问题:`)
  for (const e of errors) console.log('  · ' + e)
  process.exit(1)
}
console.log('\n✓ 相关性打分与排序全部通过（可复现 / 稳定 / 无假阳性）')
