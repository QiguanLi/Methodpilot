#!/usr/bin/env node
/**
 * 研究空白真实数据 sanity check（Phase 4-6）。
 *
 * 运行：pnpm gap:sanity
 *
 * ── 这个脚本存在的理由 ──
 *
 * gap:test 用的是**构造的假数据**，断言精确但覆盖面窄。
 * 真实项目的数据形态完全不同：方法少、证据散、supports 标注零散，
 * 很可能是"一条 Gap 也产不出来"**而且这是正确结果**。
 * 所以需要一个独立的脚本，把真实数据跑一遍，让人肉眼看一眼产出的 Gap 是否合理，
 * 而不是只看一个绿勾。
 *
 * ── 与 verify-live 的分工 ──
 *   · verify-live 查**引用完整性**（孤儿 id / 跨项目引用），是数据体检。
 *   · 本脚本查**判定行为**（真实数据下 detectGaps 到底说了什么），是行为体检。
 * 两者都不改数据、不写文件，只读。
 *
 * ── ⚠️ 一个踩过的坑，也是本脚本唯一值得写的注释 ──
 *
 * 第一版是在 shell 里用 heredoc 拼 JS，并在其中嵌入了
 * `${g.evidence_ids.join(',')}` 这样的表达式去做展示。
 * zsh 在 heredoc / 双引号里会先做参数展开，遇到 `${...}` 里的 `.join(` 这种
 * 非法的参数名，直接报 `Bad substitution` —— **脚本根本没跑起来**，
 * 而错误信息长得像"数据有问题"，很容易被误判成生产代码的 bug。
 *
 * 教训：**JS 表达式永远不要在 shell 字符串里求值。**
 * 判断某个信息该由谁计算，只有一条标准：它是不是 JS 的属性访问/方法调用？
 * 是 → 必须在 .mjs 文件里算，算成完整的字符串后再交给终端显示。
 * 所以本脚本是**一个真正的 .mjs 文件**，不接收任何 shell 传入的表达式，
 * 所有 join / map / 格式化都在 JS 内部完成。
 */

import { store } from '../server/store/fileStore.ts'
import { detectGaps, assertGapInvariants, gapSignalLabel, gapThemeLabel } from '../server/services/researchGaps.ts'
import { alignMethods } from '../server/services/methodAlignment.ts'
import { buildEvolution } from '../server/services/methodEvolution.ts'

/* ------------------------------------------------------------------ */
/* 输出工具 —— 全部在 JS 内部格式化，不经 shell                          */
/* ------------------------------------------------------------------ */

const line = (s = '') => process.stdout.write(`${s}\n`)
const rule = () => line('─'.repeat(72))

/**
 * 把 id 数组渲染成字符串。
 *
 * ⚠️ 这个函数的存在本身就是那条教训的落点：
 * 在 shell 里写 `${arr.join(',')}` 会炸，在这里写则完全正常。
 * 与之等价的 `arr.join(',')` 在 researchGaps.ts 的排序键里也用着，
 * 那里从来没出过问题 —— 因为那也在 JS 内部。
 */
const joinIds = (ids) => (ids.length ? ids.join(', ') : '（无）')
const truncate = (s, n = 110) => (s.length > n ? `${s.slice(0, n)}…` : s)

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

let totalGaps = 0
let totalStated = 0
let totalCandidate = 0
let totalEvidence = 0
let totalWithIntent = 0
let invariantFailures = 0
let projectsChecked = 0
let projectsWithGaps = 0

const projects = await store.listProjects()
const sorted = [...projects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

line()
rule()
line('研究空白真实数据 sanity check（Phase 4-6）')
rule()

for (const p of sorted) {
  const b = await store.getBundle(p.id)
  if (!b) continue

  projectsChecked++
  totalEvidence += b.evidence.length
  totalWithIntent += b.evidence.filter(
    (e) => e.supports.includes('局限') || e.supports.includes('研究空白'),
  ).length

  /*
   * 链路依赖与接口一致：先 4-2 对齐，再 4-4 演进，最后 4-6 缺口。
   * 这是刻意复现 server/index.ts 里的真实调用顺序 ——
   * 若本脚本自己另搭一条链路，测出来的就不是用户看到的那条。
   */
  const alignment = alignMethods({ methods: b.methods, evidence: b.evidence, papers: b.papers })
  const evolution = buildEvolution({
    methods: b.methods,
    evidence: b.evidence,
    papers: b.papers,
    alignments: alignment.candidates,
  })
  const out = detectGaps({
    papers: b.papers,
    methods: b.methods,
    evidence: b.evidence,
    alignments: alignment.candidates,
    evolutionRelations: evolution.relations,
  })

  const bad = assertGapInvariants(out)
  invariantFailures += bad.length
  totalGaps += out.gaps.length
  totalStated += out.stats.stated
  totalCandidate += out.stats.candidate
  if (out.gaps.length) projectsWithGaps++

  line()
  line(`【${p.name}】`)
  line(`  project_id      ${p.id}`)
  line(`  语料规模        论文 ${b.papers.length} / 方法 ${b.methods.length} / 证据 ${b.evidence.length}`)
  line(
    `  上游输入        对齐候选 ${alignment.candidates.length} / 演进关系 ${evolution.relations.length}`,
  )
  line(
    `  语料缺口意图    带「局限|研究空白」标注的证据 ${out.context.evidence_with_gap_intent} 条` +
      `（has_gap_intent=${out.context.corpus_has_gap_intent}）`,
  )
  line(`  门剔除          证据 ${out.stats.evidence_skipped} 条（归属不明 / 无实质文本）`)

  if (!out.gaps.length) {
    /*
     * 0 条 Gap 是最常见的真实结果，而且通常是**正确**的：
     * 真实项目的证据大多来自摘要与正文开头，那里没人写局限。
     * 所以这里不打印"警告"，而是打印原因 —— 让人一眼分清
     * "系统没看到"和"语料里确实没有"。
     */
    line('  Gap 产出        0 条')
    line(
      `      原因：${out.context.corpus_has_gap_intent ? '语料有缺口意图，但句式未命中' : '语料中没有证据自陈缺口 → 按设计不产出（不是失败）'}`,
    )
    continue
  }

  line(
    `  Gap 产出        stated ${out.stats.stated} / candidate ${out.stats.candidate} / 合计 ${out.gaps.length}`,
  )
  line(
    `  信号分布        limitation ${out.stats.limitation} · open_problem ${out.stats.open_problem} ·` +
      ` missing_comparison ${out.stats.missing_comparison} · uncovered_setting ${out.stats.uncovered_setting}`,
  )
  line(
    `  涉及范围        论文 ${out.stats.papers_involved} / 方法 ${out.stats.methods_involved} / 主题 ${out.stats.themes}`,
  )
  line(`  单篇信号        ${out.stats.single_paper_signals} 条（看见了但未下结论）`)

  for (const g of out.gaps) {
    const tag = g.assertion_level === 'candidate' ? '候选' : '事实'
    line()
    line(`    · ${g.gap_id} [${tag}] ${gapSignalLabel(g.gap_signal)} · 场景=${gapThemeLabel(g.theme)}`)
    line(`      置信度 ${g.confidence}`)
    line(`      标题   ${g.title}`)
    line(`      证据   ${joinIds(g.evidence_ids)}`)
    line(`      论文   ${joinIds(g.paper_ids)}    方法 ${joinIds(g.method_ids)}`)
    line(`      描述   ${truncate(g.description)}`)
  }

  if (bad.length) {
    line()
    line(`  ✗ 不变量违规 ${bad.length} 项：`)
    for (const m of bad) line(`      ${m}`)
  }
}

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

line()
rule()
line('汇总')
line(`  检查项目数      ${projectsChecked}（其中 ${projectsWithGaps} 个产出了 Gap）`)
line(`  证据总数        ${totalEvidence}，其中带缺口意图 ${totalWithIntent} 条`)
line(`  Gap 总数        ${totalGaps} = stated ${totalStated} + candidate ${totalCandidate}`)
line(`  不变量违规      ${invariantFailures}`)
rule()
line()

/* ------------------------------------------------------------------ */
/* 退出码                                                              */
/* ------------------------------------------------------------------ */

/*
 * 退出码的判定标准要写清楚，否则这个脚本会变成"永远绿"的摆设：
 *
 *   · 不变量违规       → 失败。这是真的 bug（无证据 Gap / 推断伪装事实）。
 *   · 0 条 Gap         → **不是失败**。真实语料很可能没有自陈局限，
 *                        按设计就该产出 0 条。把它当失败会逼人去"制造"Gap。
 *   · candidate 存在但只涉及 1 篇论文 → 不变量已经会抓，这里不重复。
 *
 * 换句话说：本脚本只对"结论不自洽"报错，不对"结论为空"报错。
 * 这与 detectGaps 的设计立场一致 —— 宁可产出 0 条，也不编造 1 条。
 */
if (invariantFailures > 0) {
  line(`✗ 真实数据 sanity check 失败：${invariantFailures} 项不变量违规`)
  process.exit(1)
}

line('✓ 真实数据 sanity check 通过：产出结构自洽，全部 Gap 均可回链 Evidence')
line('  0 条 Gap 属于按设计不产出（语料未自陈缺口），不是失败')
