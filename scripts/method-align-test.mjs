#!/usr/bin/env node
/**
 * 跨论文方法对齐测试（Phase 4-2）。
 *
 * 运行：pnpm method-align:test
 *
 * ── 为什么这个测试不能只测"正面案例" ──
 * 对齐模块最大的风险不是"漏掉",而是"多给"。
 * 一条自信的错误关系（把两个不相干的方法判成同一个）会直接污染方法地图，
 * 而用户没有能力逐条复核——他会当成既有知识用下去。
 *
 * 所以这里每一组"能对齐"的断言后面，都紧跟一组**反向断言**：
 * 证明这个模块在证据不足时确实**拒绝**升级关系。
 * 只测正向的话，一个"什么都判成 same"的坏实现也能全绿。
 *
 * 所有输入都是**构造的假数据**，不是真实项目数据 —— 这样断言才能精确到
 * "为什么这一对应该/不应该对齐"。真实数据由 verify-live 负责。
 */

import {
  alignMethods,
  normalizeMethodName,
  nameTokens,
  ALIGNMENT_RULE_VERSION,
} from '../server/services/methodAlignment.ts'

/* ------------------------------------------------------------------ */

const errors = []
let pass = 0
const check = (cond, msg) => {
  if (cond) pass++
  else errors.push(msg)
}
const eq = (actual, expected, msg) => {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`,
  )
}

/* ------------------------------------------------------------------ */
/* 构造器：让测试聚焦在"判定逻辑"而不是"拼对象"                          */
/* ------------------------------------------------------------------ */

const PAPER = (id, year = 2023, title = '') => ({
  paper_id: id,
  project_id: 'proj_test',
  file_name: `${id}.pdf`,
  file_hash: `hash_${id}`,
  file_size: 1000,
  page_count: 10,
  title: title || `Paper ${id}`,
  authors: [],
  year,
  abstract: '',
  keywords: [],
  sections: [],
  status: 'completed',
  error: null,
  source_type: 'demo',
  analyzed_with: null,
  method_ids: [],
  evidence_count: 0,
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
})

const METHOD = (id, paperId, name, extra = {}) => ({
  method_id: id,
  project_id: 'proj_test',
  name,
  name_zh: extra.name_zh ?? '',
  family_id: extra.family_id ?? '',
  task: extra.task ?? '',
  paradigm: extra.paradigm ?? '',
  year: extra.year ?? 2023,
  core_idea: extra.core_idea ?? '',
  modules: extra.modules ?? [],
  inputs: [],
  outputs: [],
  capabilities: extra.capabilities ?? [],
  advantages: [],
  limitations: [],
  paper_ids: [paperId],
  evidence_ids: extra.evidence_ids ?? [],
  layer: 0,
  source_type: 'demo',
  classification: null,
})

const EVID = (id, paperId, content, extra = {}) => ({
  evidence_id: id,
  paper_id: paperId,
  project_id: 'proj_test',
  section: extra.section ?? 'Introduction',
  page: extra.page ?? 1,
  content,
  translation: '',
  supports: extra.supports ?? ['方法核心思想'],
  confidence: extra.confidence ?? 1,
  method_ids: extra.method_ids ?? [],
  gap_ids: [],
  direction_ids: [],
  source_type: 'demo',
})

/* ================================================================== */
console.log('— 1. 同论文方法不互相对齐 —')
/* ================================================================== */

/*
 * 这是**最重要**的一条。同一篇论文里抽出的两个方法往往是同一贡献的两面
 * （比如 "ReAct" 和 "ReAct 与 CoT-SC 结合"），名字高度相似。
 * 如果不对它们做排除，会产生大量"自对齐"噪音。
 */
{
  const methods = [
    METHOD('M001', 'P001', 'ReAct: Synergizing Reasoning and Acting', {
      core_idea: 'Interleave reasoning traces and task specific actions in a loop',
    }),
    METHOD('M002', 'P001', 'Combining ReAct and CoT-SC', {
      core_idea: 'Interleave reasoning traces and task specific actions in a loop',
    }),
    METHOD('M003', 'P001', 'Finetuning ReAct', {
      core_idea: 'Interleave reasoning traces and task specific actions in a loop',
    }),
  ]
  const out = alignMethods({ methods, evidence: [], papers: [PAPER('P001')] })

  eq(out.candidates.map((c) => [c.source.method_id, c.target.method_id]), [],
    '同论文的 3 个方法之间不得产出任何候选关系')
  eq(out.skippedSamePaper, 3, '同论文方法对数应为 C(3,2)=3，且必须被显式统计')
  console.log(`  ✓ 3 个同论文方法 / 3 对全部跳过，候选 0 条`)
}

{
  /*
   * 反向对照：把同样的方法拆到不同论文，就必须能对齐了。
   *
   * ⚠️ 注意这里**必须给双方各自挂证据**。
   * 按本轮规则，"同名"本身不足以判定 same —— 没有证据时只能 related。
   * 这正是下面第 2.5 节专门验证的门槛。
   */
  const methods = [
    METHOD('M001', 'P001', 'ReAct: Synergizing Reasoning and Acting', { evidence_ids: ['E001'] }),
    METHOD('M002', 'P002', 'ReAct: Synergizing Reasoning and Acting', { evidence_ids: ['E002'] }),
  ]
  const evidence = [
    EVID('E001', 'P001', 'We propose ReAct, a paradigm that interleaves reasoning and acting'),
    EVID('E002', 'P002', 'ReAct interleaves reasoning traces with task specific actions'),
  ]
  const out = alignMethods({ methods, evidence, papers: [PAPER('P001'), PAPER('P002')] })
  eq(out.candidates.length, 1, '同名方法分属不同论文时，应产出 1 条候选')
  eq(out.candidates[0].relation_type, 'same', '同名 + 双方均有证据，应为 same')
  check(out.candidates[0].hasDirectEvidence, '双方均有证据时应标记 hasDirectEvidence')
  console.log('  ✓ 对照：同样名称跨论文 + 双方有证据 → same（证明上面的排除是按论文而非按名字）')
}

/* ================================================================== */
console.log('\n— 2. 明显别名可以对齐（alias） —')
/* ================================================================== */

{
  const methods = [
    METHOD('M001', 'P001', 'Tree of Thoughts', { evidence_ids: ['E001'] }),
    METHOD('M002', 'P002', 'Tree of Thoughts Search', { evidence_ids: ['E002'] }),
  ]
  const evidence = [
    EVID('E001', 'P001', 'Tree of Thoughts enables deliberate search over coherent units of text'),
    EVID('E002', 'P002', 'We extend Tree of Thoughts with an explicit search procedure'),
  ]
  const out = alignMethods({ methods, evidence, papers: [PAPER('P001'), PAPER('P002')] })
  eq(out.candidates.length, 1, '词集包含关系应产出 1 条候选')
  eq(out.candidates[0].relation_type, 'alias', '「Tree of Thoughts」vs「... Search」应为 alias')
  check(
    out.candidates[0].basis.includes('name_token_subset'),
    `alias 的 basis 应含 name_token_subset，实际 ${JSON.stringify(out.candidates[0].basis)}`,
  )
  console.log(`  ✓ Tree of Thoughts ↔ Tree of Thoughts Search → alias（basis: ${out.candidates[0].basis.join(',')}）`)
}

{
  // 首字母缩写：Agent-Computer Interface ↔ ACI。双方各带证据
  const methods = [
    METHOD('M001', 'P001', 'Agent Computer Interface', { evidence_ids: ['E001'] }),
    METHOD('M002', 'P002', 'ACI', { evidence_ids: ['E002'] }),
  ]
  const evidence = [
    EVID('E001', 'P001', 'We design an agent computer interface tailored for language model agents'),
    EVID('E002', 'P002', 'The ACI provides concise feedback to the agent after each action'),
  ]
  const out = alignMethods({ methods, evidence, papers: [PAPER('P001'), PAPER('P002')] })
  eq(out.candidates.length, 1, '缩写匹配应产出 1 条候选')
  eq(out.candidates[0].relation_type, 'same', 'ACI 是 Agent Computer Interface 的缩写，应为 same')
  check(
    out.candidates[0].basis.includes('acronym_match'),
    'basis 应含 acronym_match',
  )
  console.log('  ✓ Agent Computer Interface ↔ ACI → same（acronym_match）')
}

{
  /*
   * 括号里显式写的别名。
   *
   * 这一对**故意不给任何证据**——因为 `alias_declared` 是唯一能绕过
   * 证据门槛的信号：作者自己在名称里写了"ReAct"，那是原文里的事实陈述，
   * 不需要额外证据来"证明两个名字指同一个东西"。
   */
  const methods = [
    METHOD('M001', 'P001', 'ReAct: Synergizing Reasoning and Acting'),
    METHOD('M002', 'P002', 'Combining ReAct and CoT-SC (ReAct ↔ CoT-SC)'),
  ]
  const out = alignMethods({ methods, evidence: [], papers: [PAPER('P001'), PAPER('P002')] })
  const hit = out.candidates.find((c) =>
    [c.source.method_id, c.target.method_id].sort().join('-') === 'M001-M002',
  )
  check(Boolean(hit), '应产出 M001↔M002 的候选')
  eq(hit?.relation_type, 'same', '作者显式声明别名应可判定 same（不受证据门槛限制）')
  check(
    hit?.basis.includes('alias_declared'),
    `应命中 alias_declared，实际 ${JSON.stringify(hit?.basis)}`,
  )
  console.log(`  ✓ 括号内显式写出 ReAct → ${hit?.relation_type}（basis: ${hit?.basis.join(',')}，零证据仍可判）`)
}

/* ================================================================== */
console.log('\n— 2.5 无直接证据时禁止生成 same/alias（硬门槛） —')
/* ================================================================== */

{
  /*
   * 这是本轮最关键的一条规则。
   *
   * 两个方法**名字完全相同**，但双方都没有挂任何证据。
   * 一个天真的实现会直接判 same。本模块必须拒绝：
   * 同名不等于同物，"不同论文独立命名撞车"在这个领域很常见。
   */
  const methods = [
    METHOD('M001', 'P001', 'Tree of Thoughts'),
    METHOD('M002', 'P002', 'Tree of Thoughts'),
  ]
  const out = alignMethods({ methods, evidence: [], papers: [PAPER('P001'), PAPER('P002')] })
  eq(out.candidates.length, 1, '同名应产出候选（不能静默丢弃，要让用户看到）')
  const c = out.candidates[0]
  check(
    c.relation_type === 'related' || c.relation_type === 'uncertain',
    `零证据时不得判 same/alias，实际「${c.relation_type}」`,
  )
  check(!c.hasDirectEvidence, '零证据时 hasDirectEvidence 必须为 false')
  check(
    c.reason.includes('缺乏实质支撑') || c.reason.includes('未各自挂载证据'),
    `reason 必须说明为什么没升级，实际：${c.reason}`,
  )
  console.log(`  ✓ 同名但零证据 → ${c.relation_type}（未越界；reason 已说明原因）`)
}

{
  /* 名字相同、但**只有一方**有证据 —— 仍不满足"双方各自有证据" */
  const methods = [
    METHOD('M001', 'P001', 'Reflexion', { evidence_ids: ['E001'] }),
    METHOD('M002', 'P002', 'Reflexion'),
  ]
  const evidence = [EVID('E001', 'P001', 'Reflexion reinforces agents through linguistic feedback')]
  const out = alignMethods({ methods, evidence, papers: [PAPER('P001'), PAPER('P002')] })
  const c = out.candidates[0]
  check(
    c.relation_type !== 'same' && c.relation_type !== 'alias',
    `仅单方有证据不得判 same/alias，实际「${c.relation_type}」`,
  )
  check(!c.hasDirectEvidence, '仅单方有证据时 hasDirectEvidence 应为 false')
  console.log(`  ✓ 同名但仅单方有证据 → ${c.relation_type}（门槛要求"双方各自"）`)
}

{
  /* 缩写关系也一样受门槛约束 */
  const methods = [
    METHOD('M001', 'P001', 'Agent Computer Interface'),
    METHOD('M002', 'P002', 'ACI'),
  ]
  const out = alignMethods({ methods, evidence: [], papers: [PAPER('P001'), PAPER('P002')] })
  const c = out.candidates[0]
  check(
    c.relation_type !== 'same',
    `缩写匹配但无证据，不得判 same，实际「${c.relation_type}」`,
  )
  console.log(`  ✓ 缩写匹配但零证据 → ${c.relation_type}（缩写不豁免证据门槛）`)
}

{
  /* 真值表式断言：遍历全部候选，锁死"无证据 ⇒ 无强关系"这个不变式 */
  const methods = [
    METHOD('M001', 'P001', 'Alpha Method'),
    METHOD('M002', 'P002', 'Alpha Method'),
    METHOD('M003', 'P003', 'Alpha Method Search'),
    METHOD('M004', 'P004', 'Beta'),
  ]
  const out = alignMethods({ methods, evidence: [], papers: [PAPER('P001'), PAPER('P002'), PAPER('P003'), PAPER('P004')] })
  const bad = out.candidates.filter((c) => !c.hasDirectEvidence && (c.relation_type === 'same' || c.relation_type === 'alias'))
  eq(bad.map((c) => c.alignment_id), [], '不变式：!hasDirectEvidence ⇒ 关系类型不得是 same/alias')
  console.log(`  ✓ 不变式成立：${out.candidates.length} 条候选中 0 条"无证据却有强关系"`)
}

/* ================================================================== */
console.log('\n— 3. 无充分证据不能升级成强关系（核心约束） —')
/* ================================================================== */

{
  /*
   * 场景：两个方法**名字完全不同**，但同一个方法族、同一年、核心思想很像。
   * 这正是最容易误判的情形——一个过于激进的实现会说"它们都是 F2，一定是同一个"。
   * 本模块必须给出 related 或 uncertain，**绝不能是 same/alias**。
   */
  const IDEA = 'Let the model decide when to call external tools and APIs to extend reasoning beyond its parameters'
  const methods = [
    METHOD('M001', 'P001', 'Self-Supervised Tool Learning', {
      family_id: 'F2', year: 2023, core_idea: IDEA,
    }),
    METHOD('M002', 'P002', 'Depth-First Search Decision Tree', {
      family_id: 'F2', year: 2023, core_idea: IDEA,
    }),
  ]
  const out = alignMethods({ methods, evidence: [], papers: [PAPER('P001'), PAPER('P002')] })
  eq(out.candidates.length, 1, '有弱信号时应产出 1 条候选（不能静默丢弃）')
  const c = out.candidates[0]
  check(
    c.relation_type === 'related' || c.relation_type === 'uncertain',
    `名字不同 + 仅同族/思想相似，只能是 related/uncertain，实际得到「${c.relation_type}」`,
  )
  check(
    c.basis.includes('same_family') || c.basis.includes('core_idea_overlap'),
    '  basis 应记录命中的弱信号，便于用户复核',
  )
  console.log(`  ✓ 同族+同思想但名字不同 → ${c.relation_type}（未越界成 same/alias）`)
}

{
  /*
   * 更严格的一条：**只有**同族 + 年份相邻，连核心思想都不像。
   * 这必须落到 uncertain —— 它是"我们注意到了但判断不了"，不是"它们相关"。
   */
  const methods = [
    METHOD('M001', 'P001', 'Alpha Framework', {
      family_id: 'F3', year: 2023,
      core_idea: 'Uses a search over reasoning steps guided by a learned value function',
    }),
    METHOD('M002', 'P002', 'Beta Pipeline', {
      family_id: 'F3', year: 2024,
      core_idea: 'Filters generated samples by running unit tests and clustering the survivors',
    }),
  ]
  const out = alignMethods({ methods, evidence: [], papers: [PAPER('P001'), PAPER('P002')] })
  for (const c of out.candidates) {
    check(
      c.relation_type !== 'same' && c.relation_type !== 'alias',
      `仅同族不得升级为 ${c.relation_type}`,
    )
  }
  const types = out.candidates.map((c) => c.relation_type)
  check(
    types.length === 0 || types.every((t) => t === 'uncertain' || t === 'related'),
    `仅同族应至多 related，实际 ${JSON.stringify(types)}`,
  )
  console.log(`  ✓ 仅同族（思想不同）→ ${types.length ? types.join(',') : '不产出候选'}`)
}

{
  /*
   * 完全无关的两个方法：不应产出任何候选。
   * 这一条防的是"对每一对都吐一条 uncertain"的实现——
   * N 个方法会产生 N(N-1)/2 条，20 个方法就是 190 条噪音。
   */
  const methods = [
    METHOD('M001', 'P001', 'Sandboxed Code Execution', {
      family_id: 'F1', core_idea: 'Run generated code inside an isolated container with resource limits',
    }),
    METHOD('M002', 'P002', 'In-Context Learning', {
      family_id: 'F5', core_idea: 'Provide a handful of examples in the prompt so no gradient updates are needed',
    }),
  ]
  const out = alignMethods({ methods, evidence: [], papers: [PAPER('P001'), PAPER('P002')] })
  eq(out.candidates.length, 0, '毫无共同信号的两个方法不应产出候选（避免噪音）')
  console.log('  ✓ 完全无关 → 不产出候选，不制造 uncertain 噪音')
}

/* ================================================================== */
console.log('\n— 3.5 四种比较依据：名称 / 任务 / 核心做法 / Evidence —')
/* ================================================================== */

{
  /*
   * 依据②「任务」单独成立的场景：
   * 名字完全不同、核心做法不同，但 task 一模一样。
   * 应当产出 related（同任务值得看一眼），且**不得**是 same/alias。
   */
  const methods = [
    METHOD('M001', 'P001', 'Identifier-Aware Code Pretraining', {
      task: 'Code Generation',
      core_idea: 'Design an identifier-aware denoising objective on an encoder-decoder architecture',
      evidence_ids: ['E001'],
    }),
    METHOD('M002', 'P002', 'Sample-Filter-Cluster Pipeline', {
      task: 'Code Generation',
      core_idea: 'Sample many candidates then filter by unit tests and cluster the survivors',
      evidence_ids: ['E002'],
    }),
  ]
  const evidence = [
    EVID('E001', 'P001', 'We pretrain a code model that models identifier semantics explicitly'),
    EVID('E002', 'P002', 'We first sample a large number of candidate programs from the model'),
  ]
  const out = alignMethods({ methods, evidence, papers: [PAPER('P001'), PAPER('P002')] })
  eq(out.candidates.length, 1, '同任务应产出 1 条候选')
  const c = out.candidates[0]
  eq(c.relation_type, 'related', '仅同任务应为 related（不能升级）')
  check(c.basis.includes('same_task'), `basis 应含 same_task，实际 ${JSON.stringify(c.basis)}`)
  console.log(`  ✓ 仅任务相同（名称/做法均不同）→ related（basis: ${c.basis.join(',')}）`)
}

{
  /*
   * 依据③「核心做法」单独成立：
   * 名字无关、任务不同，但 core_idea 措辞高度重合。
   */
  const IDEA =
    'Interleave reasoning traces and task specific actions so the model can act and reason in a single loop'
  const methods = [
    METHOD('M001', 'P001', 'Alpha Loop', { task: 'Task A', core_idea: IDEA }),
    METHOD('M002', 'P002', 'Beta Cycle', { task: 'Task B', core_idea: IDEA }),
  ]
  const out = alignMethods({ methods, evidence: [], papers: [PAPER('P001'), PAPER('P002')] })
  eq(out.candidates.length, 1, '核心做法重合应产出 1 条候选')
  const c = out.candidates[0]
  check(c.relation_type === 'related' || c.relation_type === 'uncertain',
    `核心做法重合但无证据，应为 related/uncertain，实际 ${c.relation_type}`)
  check(c.basis.includes('core_idea_overlap'), 'basis 应含 core_idea_overlap')
  console.log(`  ✓ 仅核心做法重合（无证据）→ ${c.relation_type}（basis: ${c.basis.join(',')}）`)
}

{
  /*
   * 依据④「已有 Evidence」：双方证据含逐字相同原文。
   * 这是最硬的信号，但仍不足以单独判 same（除非名字也强）。
   */
  const SENT = 'We interleave reasoning traces with actions to solve multi hop knowledge tasks'
  const methods = [
    METHOD('M001', 'P001', 'Odd Name One', { evidence_ids: ['E001'] }),
    METHOD('M002', 'P002', 'Odd Name Two', { evidence_ids: ['E002'] }),
  ]
  const evidence = [
    EVID('E001', 'P001', SENT),
    EVID('E002', 'P002', SENT),
  ]
  const out = alignMethods({ methods, evidence, papers: [PAPER('P001'), PAPER('P002')] })
  eq(out.candidates.length, 1, '共享逐字原文应产出 1 条候选')
  const c = out.candidates[0]
  check(c.basis.includes('shared_evidence_text'), 'basis 应含 shared_evidence_text')
  eq(c.shared_quotes, [SENT], 'shared_quotes 应为那句原文')
  check(
    c.relation_type === 'related' || c.relation_type === 'uncertain',
    `名字不强时，即使共享原文也不得判 same/alias，实际 ${c.relation_type}`,
  )
  console.log(`  ✓ 仅证据共享（名称不强）→ ${c.relation_type}（shared_quotes=${c.shared_quotes.length}）`)
}

{
  /*
   * 约束：比较依据**只用**这四类。
   * 构造两个在"题面未列出的维度"上高度相似、但四类依据全不相同的输入，
   * 必须不产出任何候选。这里用完全不同的名称/任务/做法/证据。
   */
  const methods = [
    METHOD('M001', 'P001', 'Zeta', { task: 'Alpha', core_idea: 'One thing entirely', evidence_ids: ['E001'] }),
    METHOD('M002', 'P002', 'Omega', { task: 'Beta', core_idea: 'Another thing completely', evidence_ids: ['E002'] }),
  ]
  const evidence = [
    EVID('E001', 'P001', 'A sentence about the first method and its own distinct idea'),
    EVID('E002', 'P002', 'A different sentence describing an unrelated second method'),
  ]
  const out = alignMethods({ methods, evidence, papers: [PAPER('P001'), PAPER('P002')] })
  eq(out.candidates.length, 0, '四类依据全不同时不应产出候选（不引入额外信息源）')
  console.log('  ✓ 四类依据全不相同 → 0 条候选（未越权使用其他信息源）')
}

{
  /*
   * 回归：Demo 全量回放抓出的真实假阳性。
   *
   *   M015  Virtual Context Management / 虚拟上下文管理
   *   M018  In-Context Learning        / 上下文学习
   *
   * `In-Context Learning` 去停用词后只剩 `[context]`（in/learning 都是停用词），
   * 而对方是 `[virtual, context, management]`，于是 `[context]` 成了真子集，
   * 两者被判成 alias —— 但它们毫无关系。
   *
   * 这条断言防止"停用词+子集"组合再次制造假别名。
   */
  const methods = [
    METHOD('M015', 'P001', 'Virtual Context Management', {
      name_zh: '虚拟上下文管理', task: 'Memory Management', evidence_ids: ['E001'],
    }),
    METHOD('M018', 'P002', 'In-Context Learning', {
      name_zh: '上下文学习', task: 'Foundation', evidence_ids: ['E002'],
    }),
  ]
  const evidence = [
    EVID('E001', 'P001', 'We treat the context window as memory and external storage as disk'),
    EVID('E002', 'P002', 'Providing a few examples in the prompt needs no gradient updates'),
  ]
  const out = alignMethods({ methods, evidence, papers: [PAPER('P001'), PAPER('P002')] })
  for (const c of out.candidates) {
    check(
      c.relation_type !== 'same' && c.relation_type !== 'alias',
      `Virtual Context Management 与 In-Context Learning 不得对齐为 ${c.relation_type}（仅共享通用词 context）`,
    )
  }
  const types = out.candidates.map((c) => c.relation_type)
  console.log(`  ✓ 仅共享通用词 context → ${types.join(',') || '无候选'}（未误判为别名）`)
}

{
  /* 中文名仅共享一个常用词时同理 */
  const methods = [
    METHOD('M001', 'P001', '虚拟上下文管理', { evidence_ids: ['E001'] }),
    METHOD('M002', 'P002', '上下文学习', { evidence_ids: ['E002'] }),
  ]
  const evidence = [
    EVID('E001', 'P001', 'We treat the context window as memory mapped to external storage'),
    EVID('E002', 'P002', 'Providing a few examples in the prompt requires no gradient updates'),
  ]
  const out = alignMethods({ methods, evidence, papers: [PAPER('P001'), PAPER('P002')] })
  for (const c of out.candidates) {
    check(
      c.relation_type !== 'same' && c.relation_type !== 'alias',
      `中文名仅共享「上下文」不得判 ${c.relation_type}`,
    )
  }
  console.log(`  ✓ 中文名仅共享「上下文」→ ${out.candidates.map((c) => c.relation_type).join(',') || '无候选'}`)
}

/* ================================================================== */
console.log('\n— 4. 绝不产生「改进 / 继承 / 演进」关系 —')
/* ================================================================== */

{
  /*
   * 构造一个"看起来很像演进"的场景：A 早、B 晚、同族、名字还是包含关系。
   * 这是最容易诱使实现输出 'extends' 的情形。
   * 它最多只能是 alias —— 因为"B 改进了 A"需要原文里直接的历史声明。
   */
  const methods = [
    METHOD('M001', 'P001', 'ReAct', { family_id: 'F2', year: 2022 }),
    METHOD('M002', 'P002', 'ReAct with Self-Consistency', { family_id: 'F2', year: 2023 }),
  ]
  const out = alignMethods({ methods, evidence: [], papers: [PAPER('P001', 2022), PAPER('P002', 2023)] })

  for (const c of out.candidates) {
    check(
      ['same', 'alias', 'related', 'uncertain'].includes(c.relation_type),
      `产出了非法关系类型「${c.relation_type}」——改进/继承/演进类关系必须被物理禁止`,
    )
    check(
      !/改进|继承|演进|替代/.test(c.relation_type),
      `关系类型字符串不得含因果措辞：「${c.relation_type}」`,
    )
  }
  console.log(`  ✓ 早/晚 + 同族 + 名字包含 → ${out.candidates.map((c) => c.relation_type).join(',') || '无'}（无因果类型）`)
}

/* ================================================================== */
console.log('\n— 5. 每条候选必须保留双方 paper_id + method_id + evidence_id —')
/* ================================================================== */

{
  const methods = [
    METHOD('M001', 'P001', 'Reflexion', { evidence_ids: ['E001', 'E002'] }),
    METHOD('M002', 'P002', 'Reflexion', { evidence_ids: ['E003'] }),
  ]
  const evidence = [
    EVID('E001', 'P001', 'Reflexion is a framework that reinforces language agents through linguistic feedback'),
    EVID('E002', 'P001', 'The agent maintains a self-reflection memory across trials'),
    EVID('E003', 'P002', 'Reflexion is a framework that reinforces language agents through linguistic feedback'),
  ]
  const out = alignMethods({ methods, evidence, papers: [PAPER('P001'), PAPER('P002')] })
  eq(out.candidates.length, 1, '应产出 1 条候选')
  const c = out.candidates[0]

  /* 双方三要素齐全 */
  for (const side of ['source', 'target']) {
    check(Boolean(c[side].paper_id), `${side}.paper_id 不得为空`)
    check(Boolean(c[side].method_id), `${side}.method_id 不得为空`)
    check(Array.isArray(c[side].evidence_ids), `${side}.evidence_ids 必须是数组`)
  }

  /* 两侧必须指向不同的论文与方法 */
  check(c.source.paper_id !== c.target.paper_id, 'source 与 target 必须属于不同论文')
  check(c.source.method_id !== c.target.method_id, 'source 与 target 不能是同一个 method_id')

  /* 双方各自的证据要如实保留（不是只留交集） */
  eq(c.source.evidence_ids.sort(), ['E001', 'E002'], 'source 应保留自己全部 2 条证据')
  eq(c.target.evidence_ids.sort(), ['E003'], 'target 应保留自己全部 1 条证据')

  /* 并集 */
  eq(c.evidence_ids.slice().sort(), ['E001', 'E002', 'E003'], '候选应汇总双方证据并集')

  /* 逐字相同的原文必须被识别出来 */
  eq(c.shared_quotes.length, 1, '应有 1 条逐字相同的证据原文')
  check(c.hasDirectEvidence, '存在逐字相同原文时 hasDirectEvidence 应为 true')
  check(
    c.shared_quotes[0].startsWith('Reflexion is a framework'),
    'shared_quotes 内容应是被撞中的那句原文',
  )

  console.log('  ✓ 双方 paper_id/method_id/evidence_ids 齐全，并集 3 条，逐字相同 1 条')
}

{
  /*
   * 反向：证据归属被污染时，不能凭空"共享原文"。
   *
   * 构造一条脏数据：M001 的 evidence_ids 里混进了属于 P002 的 E009。
   * 归属过滤必须把它挡掉，否则任何跨论文的错挂证据都会立刻变成
   * 一个"共享原文"的强信号。
   */
  const evidence = [
    EVID('E001', 'P001', 'Ship it'),
    EVID('E002', 'P002', 'Ship it'),
    EVID('E009', 'P002', 'A completely unrelated sentence about gradient descent'),
  ]
  const methodsBad = [
    METHOD('M001', 'P001', 'Alpha', { evidence_ids: ['E001', 'E009'] }),
    METHOD('M002', 'P002', 'Beta', { evidence_ids: ['E002'] }),
  ]
  const out = alignMethods({ methods: methodsBad, evidence, papers: [PAPER('P001'), PAPER('P002')] })
  for (const c of out.candidates) {
    check(
      !c.shared_quotes.includes('A completely unrelated sentence about gradient descent'),
      '跨论文错误引用的证据不得被算作共享原文',
    )
  }
  console.log('  ✓ 跨论文错误引用的证据被正确排除，未产生虚假共享信号')
}

/* ================================================================== */
console.log('\n— 6. 不产生重复关系 —')
/* ================================================================== */

{
  /*
   * 三个方法两两之间都可能对齐。约束：
   *   - 每对方法**至多一条**候选（不能同时出现 A→B 和 B→A）；
   *   - 不能出现自己对自己的候选。
   */
  const methods = [
    METHOD('M001', 'P001', 'Chain of Thought', { evidence_ids: ['E001'] }),
    METHOD('M002', 'P002', 'Chain of Thought', { evidence_ids: ['E002'] }),
    METHOD('M003', 'P003', 'Chain of Thought', { evidence_ids: ['E003'] }),
  ]
  const evidence = [
    EVID('E001', 'P001', 'Chain of thought prompting elicits reasoning by intermediate steps'),
    EVID('E002', 'P002', 'Chain of thought prompting elicits reasoning by intermediate steps'),
    EVID('E003', 'P003', 'Chain of thought prompting elicits reasoning by intermediate steps'),
  ]
  const out = alignMethods({ methods, evidence, papers: [PAPER('P001'), PAPER('P002'), PAPER('P003')] })

  /* 每对无序方法组合恰好出现一次 */
  const pairKeys = out.candidates.map((c) =>
    [c.source.method_id, c.target.method_id].sort().join('|'),
  )
  eq(pairKeys.length, new Set(pairKeys).size, `存在重复的方法对：${JSON.stringify(pairKeys)}`)
  eq(out.candidates.length, 3, 'C(3,2)=3 对，应恰好产出 3 条候选')

  /* 不能自指 */
  for (const c of out.candidates) {
    check(c.source.method_id !== c.target.method_id, `候选 ${c.alignment_id} 自指（source === target）`)
    check(c.source.paper_id !== c.target.paper_id, `候选 ${c.alignment_id} 双方属于同一论文`)
  }

  /* alignment_id 必须唯一 */
  const ids = out.candidates.map((c) => c.alignment_id)
  eq(ids.length, new Set(ids).size, `alignment_id 存在重复：${JSON.stringify(ids)}`)

  console.log(`  ✓ 3 个方法 → 3 条候选，无重复对、无自指、id 唯一：${pairKeys.join(' ')}`)
}

{
  /*
   * 反例：**同名方法在同一论文里**不得产生关系，
   * 而分属不同论文的才产生 —— 两者混在一起时更不能串。
   */
  const methods = [
    METHOD('M001', 'P001', 'Duplicated Name', { evidence_ids: ['E001'] }),
    METHOD('M002', 'P001', 'Duplicated Name', { evidence_ids: ['E002'] }), // 同论文
    METHOD('M003', 'P002', 'Duplicated Name', { evidence_ids: ['E003'] }),
  ]
  const evidence = [
    EVID('E001', 'P001', 'A sentence that describes the duplicated method clearly'),
    EVID('E002', 'P001', 'Another sentence describing the very same duplicated method'),
    EVID('E003', 'P002', 'A sentence that describes the duplicated method clearly'),
  ]
  const out = alignMethods({ methods, evidence, papers: [PAPER('P001'), PAPER('P002')] })

  /* 唯一合法的跨论文对是 M001|M003 与 M002|M003 */
  const pairs = out.candidates.map((c) => [c.source.method_id, c.target.method_id].sort().join('|')).sort()
  eq(pairs, ['M001|M003', 'M002|M003'], `跨论文对应为 M001|M003 与 M002|M003，实际 ${JSON.stringify(pairs)}`)
  eq(out.skippedSamePaper, 1, 'P001 内部的 1 对同论文方法必须被跳过')

  for (const c of out.candidates) {
    check(
      c.source.paper_id !== c.target.paper_id,
      `候选 ${c.alignment_id} 双方同论文，不应存在`,
    )
  }
  console.log(`  ✓ 同论文同名方法被排除，仅保留 2 条跨论文对（skippedSamePaper=1）`)
}

/* ================================================================== */
console.log('\n— 7. 确定性：输入顺序变化时输出稳定 —')
/* ================================================================== */

{
  const build = () => ({
    methods: [
      METHOD('M003', 'P003', 'Chain of Thought', { family_id: 'F5', evidence_ids: ['E003'] }),
      METHOD('M001', 'P001', 'Chain-of-Thought Prompting', { family_id: 'F5', evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'Chain of Thought', { family_id: 'F5', evidence_ids: ['E002'] }),
    ],
    evidence: [
      EVID('E001', 'P001', 'Chain of thought prompting elicits reasoning by showing intermediate steps'),
      EVID('E002', 'P002', 'Chain of thought prompting elicits reasoning by showing intermediate steps'),
      EVID('E003', 'P003', 'Chain of thought prompting elicits reasoning by showing intermediate steps'),
    ],
    papers: [PAPER('P001'), PAPER('P002'), PAPER('P003')],
  })

  const base = alignMethods(build())
  const again = alignMethods(build())

  /*
   * 断言"完全相等"，不只是"集合相等"。
   * 顺序、alignment_id、confidence、basis 数组的顺序都必须一模一样 ——
   * 否则界面上同一份数据刷新两次会跳来跳去。
   */
  eq(again, base, '同一输入两次调用必须产出**逐字段**一致的结果（含顺序与 id）')

  /*
   * 穷举 3 个方法的**全部 6 种输入排列**，逐一比对。
   *
   * 只测 1 次打乱是不够的：某些顺序依赖的 bug 只在特定排列下暴露
   * （比如恰好让某个方法每次都在内层循环首位）。
   * 6 种排列全跑，成本几乎为零，覆盖却是确定的。
   */
  const perms = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ]
  let identical = 0
  for (const p of perms) {
    const input = build()
    input.methods = p.map((i) => input.methods[i])
    const out = alignMethods(input)
    eq(
      out.candidates.map((x) => [x.source.method_id, x.target.method_id, x.relation_type, x.confidence]),
      base.candidates.map((x) => [x.source.method_id, x.target.method_id, x.relation_type, x.confidence]),
      `输入排列 [${p.join(',')}] 改变了输出`,
    )
    identical++
  }
  console.log(`  ✓ 两次调用逐字段全等；穷举 ${identical} 种输入排列，输出全部一致`)

  /* source/target 顺序必须稳定，不能因输入顺序翻转 */
  for (const c1 of base.candidates) {
    check(
      `${c1.source.paper_id}::${c1.source.method_id}` < `${c1.target.paper_id}::${c1.target.method_id}`,
      `source 必须在 target 之前（字典序），实际 ${c1.source.method_id} → ${c1.target.method_id}`,
    )
  }
  console.log('  ✓ source/target 按 (paper_id, method_id) 字典序固定，方向稳定')
  console.log(`  ✓ ${base.candidates.length} 条候选，alignment_id 连续且唯一`)
}

/* ================================================================== */
console.log('\n— 8. 边界与健壮性 —')
/* ================================================================== */

{
  /* 空输入 */
  const out = alignMethods({ methods: [], evidence: [], papers: [] })
  eq(out.candidates, [], '空输入应产出空候选')
  eq(out.compared, 0, '空输入 compared 应为 0')
  console.log('  ✓ 空输入不崩、产出空候选')
}

{
  /* 没有 paper 归属的方法不参与比较，且必须被统计 */
  const methods = [
    METHOD('M001', 'P001', 'Orphan Method'),
    METHOD('M002', 'P999', 'Orphan Method'), // P999 不在 papers 里
  ]
  const out = alignMethods({ methods, evidence: [], papers: [PAPER('P001')] })
  eq(out.compared, 1, '只有 1 个方法有有效论文归属')
  eq(out.skippedNoPaper, 1, '缺论文归属的方法数必须被统计')
  eq(out.candidates.length, 0, '孤立方法不参与对齐')
  console.log('  ✓ 缺论文归属的方法被排除且如实统计（skippedNoPaper=1）')
}

{
  /* 悬空 evidence_id 不得让模块崩溃 */
  const methods = [
    METHOD('M001', 'P001', 'Ghost Evidence', { evidence_ids: ['E404'] }),
    METHOD('M002', 'P002', 'Ghost Evidence', { evidence_ids: ['E405', 'E001'] }),
  ]
  const evidence = [EVID('E001', 'P002', 'A real sentence that exists in the corpus')]
  const out = alignMethods({ methods, evidence, papers: [PAPER('P001'), PAPER('P002')] })
  eq(out.candidates.length, 1, '悬空证据不应阻止对齐')
  eq(out.candidates[0].source.evidence_ids, [], '悬空的 E404 应被静默剔除')
  eq(out.candidates[0].target.evidence_ids, ['E001'], '真实存在的 E001 应保留')
  console.log('  ✓ 悬空 evidence_id 被剔除，模块不崩，真实证据保留')
}

{
  /* 归一化函数本身 */
  eq(normalizeMethodName('Tool-Use Agent'), 'tool use agent', '连字符归一为空格')
  eq(normalizeMethodName('  ReAct  '), 'react', '去首尾空格并小写')
  eq(normalizeMethodName('X (aka Y)'), 'x', '括号内容被剥离出主名')

  /*
   * 单复数归并：用**非停用词**验证。
   *
   * 这里刻意不用 'Agents' —— 它归并后是 'agent'，而 'agent' 在停用词表里，
   * 所以正确结果是 `[]`（被过滤掉，不是因为归并失败）。
   * 拿它当断言会写出一个"看起来在测归并、实际测了停用词"的假测试。
   */
  check(nameTokens('Repositories').includes('repository'), '复数 ies→y 应归并：Repositories→repository')
  check(nameTokens('Branches').includes('branch'), '复数 ches→ch 应归并：Branches→branch')
  check(nameTokens('Trials').includes('trial'), '普通复数 s 应归并：Trials→trial')

  /* 停用词过滤：单独断言，与归并分开 */
  check(nameTokens('Agents').length === 0, 'Agents 归并为停用词 agent 后应被过滤为空')
  check(!nameTokens('ReAct Loop').includes('loop'), '停用词 loop 应被去除，避免假信号')
  check(!nameTokens('Tree of Thoughts').includes('of'), '停用词 of 应被去除')
  console.log('  ✓ 归一化：连字符/大小写/括号/复数/停用词 处理正确')
}

{
  /* 规则版本必须暴露，便于溯源 */
  check(
    ALIGNMENT_RULE_VERSION.startsWith('deterministic-'),
    '规则版本需标明是确定性规则，不得让人误以为是模型产出',
  )
  const out = alignMethods({ methods: [], evidence: [], papers: [] })
  eq(out.rule_version, ALIGNMENT_RULE_VERSION, '产出必须带规则版本')
  console.log(`  ✓ 规则版本可溯源：${ALIGNMENT_RULE_VERSION}`)
}

/* ================================================================== */

console.log('\n' + '─'.repeat(62))
if (errors.length) {
  console.log(`✗ 方法对齐测试失败（${errors.length} 项 / 通过 ${pass} 项）\n`)
  for (const e of errors) console.log(`  ✗ ${e}`)
  process.exit(1)
}
console.log(`✓ 跨论文方法对齐测试全部通过（${pass} 项断言）`)
console.log('  同论文不对齐 · 别名可对齐 · 无证据不升级 · 无因果类型 · 确定性可复现')
