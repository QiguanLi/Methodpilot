#!/usr/bin/env node
/**
 * 技术演进重建测试（Phase 4-4）。
 *
 * 运行：pnpm evolution:test
 *
 * ── 这个测试最怕什么 ──
 *
 * 演进模块最大的风险不是"漏掉"，而是**编造**。
 * 一条凭空的 "B 改进了 A" 会直接污染用户对整条技术脉络的理解，
 * 而用户没有能力逐条核对原文 —— 他会当成既有事实用下去。
 * 前端 src/data/relations.ts 的注释里那句"无证据时降级为 temporal/related"
 * 就是这个立场的来源。
 *
 * 所以这里每一组"能产生因果"的断言后面，都紧跟一组**反向断言**：
 * 证明在证据不足、宾语不具体、归属不对时，模块确实**拒绝**产生因果箭头。
 * 只测正向的话，一个"什么都判成 extends"的坏实现也能全绿。
 *
 * 所有输入都是**构造的假数据**，不是真实项目数据 —— 这样断言才能精确到
 * "为什么这一对应该/不应该产生因果"。真实数据由 verify-live 负责。
 */

import {
  buildEvolution,
  summarizeEvolutions,
  assertEvolutionInvariants,
  isCausalRelationType,
  isEvolutionRelationType,
  CAUSAL_RELATION_TYPES,
  NON_CAUSAL_RELATION_TYPES,
  EVOLUTION_RULE_VERSION,
} from '../server/services/methodEvolution.ts'

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
const section = (t) => console.log(`\n— ${t} —`)

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
  capabilities: [],
  advantages: extra.advantages ?? [],
  limitations: extra.limitations ?? [],
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
  /** 中文释义。默认空 —— 只有专门测中文命中时才填 */
  translation: extra.translation ?? '',
  supports: extra.supports ?? ['方法核心思想'],
  confidence: extra.confidence ?? 1,
  method_ids: extra.method_ids ?? [],
  gap_ids: [],
  direction_ids: [],
  source_type: 'demo',
})

/** 4-2 对齐候选。只填本模块真正会读的字段 */
const ALIGN = (id, a, b, relation_type, extra = {}) => ({
  alignment_id: id,
  relation_type,
  confidence: extra.confidence ?? 0.8,
  basis: extra.basis ?? [],
  reason: extra.reason ?? '',
  evidence_ids: extra.evidence_ids ?? [],
  shared_quotes: [],
  hasDirectEvidence: extra.hasDirectEvidence ?? true,
  source: {
    paper_id: extra.sourcePaper ?? '',
    method_id: a,
    name: extra.sourceName ?? a,
    name_zh: '',
    family_id: '',
    year: 0,
    evidence_ids: [],
  },
  target: {
    paper_id: extra.targetPaper ?? '',
    method_id: b,
    name: extra.targetName ?? b,
    name_zh: '',
    family_id: '',
    year: 0,
    evidence_ids: [],
  },
})

/* ================================================================== */
section('1. 仅年份先后 → 不产生因果演进')
/* ================================================================== */

/*
 * 这是整个模块最重要的一条。
 * 两个方法，一先一后，各自都有证据，但证据里**没有任何**因果表述。
 * 结果只能是 temporal —— 年份相邻本身不是演进的证据。
 */
{
  const input = {
    methods: [
      METHOD('M001', 'P001', 'ReAct', { year: 2022, evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'SWE-agent', { year: 2024, evidence_ids: ['E002'] }),
    ],
    evidence: [
      EVID('E001', 'P001', 'We propose ReAct, interleaving reasoning and acting.'),
      EVID('E002', 'P002', 'We present SWE-agent, an agent for repository-level tasks.'),
    ],
    papers: [PAPER('P001', 2022), PAPER('P002', 2024)],
    alignments: [],
  }
  const out = buildEvolution(input)

  eq(out.relations.length, 1, '两个方法应产出 1 条相邻关系')
  eq(out.relations[0].relation_type, 'temporal', '年份相邻但无因果证据 → 只能是 temporal')
  eq(out.relations[0].causal, false, 'temporal 必须标记为非因果')
  eq(out.relations[0].evidence_ids, [], 'temporal 的 evidence_ids 必须为空数组（不挂任何证据）')
  check(out.stats.causal_total === 0, `不得有任何因果关系，实际 causal_total=${out.stats.causal_total}`)

  /* 反向断言：连"看起来像演进"的关系都不该被 push 进去 */
  check(
    out.relations.every((r) => !isCausalRelationType(r.relation_type)),
    '不得出现任何因果类型',
  )
  console.log('  ✓ 年份 2022→2024 + 中性证据 → temporal，因果 0 条')
  console.log('  ✓ 反向：无因果类型、evidence_ids 为空、causal=false')
}

/* ================================================================== */
section('2. Evidence 明确说明 extends / improves / builds on → 可产生演进关系')
/* ================================================================== */

/*
 * 正向：原文真的写了 "builds on ReAct and extends it"。
 * 三门全过（句式 + 点名 ReAct + 证据归属正确）→ 允许产生 extends。
 */
{
  const input = {
    methods: [
      METHOD('M001', 'P001', 'ReAct', { year: 2022, evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'SWE-agent', { year: 2024, evidence_ids: ['E002'] }),
    ],
    evidence: [
      EVID('E001', 'P001', 'We propose ReAct.'),
      EVID('E002', 'P002', 'SWE-agent builds on ReAct and extends it to repositories.'),
    ],
    papers: [PAPER('P001', 2022), PAPER('P002', 2024)],
    alignments: [],
  }
  const out = buildEvolution(input)
  const rel = out.relations[0]

  eq(rel.relation_type, 'extends', '明确写了 builds on / extends → 应判 extends')
  eq(rel.causal, true, 'extends 必须是因果')
  eq(rel.evidence_ids, ['E002'], '必须挂上那条证据')
  eq(rel.source_method, 'M002', 'source 必须是 later（SWE-agent）')
  eq(rel.target_method, 'M001', 'target 必须是 earlier（ReAct）')
  eq(out.evolutions[1].relation_from_prev, 'extends', '节点上的 relation_from_prev 应同步')
  check(
    rel.basis.includes('explicit_causal_statement') &&
      rel.basis.includes('object_anchor') &&
      rel.basis.includes('evidence_ownership_verified'),
    `basis 应记录三道门都过了，实际 ${JSON.stringify(rel.basis)}`,
  )
  console.log(`  ✓ builds on ReAct → extends，挂证据 ${JSON.stringify(rel.evidence_ids)}`)

  /*
   * ── 反向断言（本节的关键）──
   * 把证据里的 `ReAct` 删掉，只留 `extend prior work`。
   * 句式还在，但宾语不是一个具体方法 → 门 B 必须拦住它。
   * 这一条证明的不是"句式能命中"，而是"光有句式不够"。
   */
  const noAnchor = {
    ...input,
    evidence: [
      EVID('E001', 'P001', 'We propose ReAct.'),
      EVID('E002', 'P002', 'SWE-agent extends prior work to repositories.'),
    ],
  }
  const out2 = buildEvolution(noAnchor)
  eq(out2.relations[0].relation_type, 'temporal', '句式命中但未点名具体方法 → 必须降级为 temporal')
  eq(out2.relations[0].causal, false, '未点名方法时不得产生因果')
  check(out2.stats.causal_total === 0, '反向：因果数必须为 0')
  console.log('  ✓ 反向：删掉宾语 "ReAct" 后 extends 消失 → temporal（证明门 B 在起作用）')
}

/* ================================================================== */
section('2b. 另外三类因果（improves / replaces / combines）')
/* ================================================================== */

{
  const mk = (evidenceText) => ({
    methods: [
      METHOD('M001', 'P001', 'Toolformer', { year: 2022, evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'DFSDT', { year: 2024, evidence_ids: ['E002'] }),
    ],
    evidence: [
      EVID('E001', 'P001', 'We propose Toolformer.'),
      EVID('E002', 'P002', evidenceText),
    ],
    papers: [PAPER('P001', 2022), PAPER('P002', 2024)],
    alignments: [],
  })

  const cases = [
    ['DFSDT improves over Toolformer', 'improves'],
    ['DFSDT improves upon Toolformer', 'improves'],
    ['DFSDT outperforms Toolformer', 'improves'],
    ['DFSDT replaces Toolformer', 'replaces'],
    ['DFSDT is used instead of Toolformer', 'replaces'],
    ['DFSDT combines with Toolformer', 'combines'],
    ['DFSDT integrates Toolformer', 'combines'],
  ]
  let okCount = 0
  for (const [text, expected] of cases) {
    const out = buildEvolution(mk(text))
    if (out.relations[0]?.relation_type === expected) okCount++
    else errors.push(`"${text}" 期望 ${expected}，实际 ${out.relations[0]?.relation_type}`)
  }
  console.log(`  ✓ ${okCount}/${cases.length} 条句式正确归类为 improves/replaces/combines`)

  /*
   * 强弱优先：一句话里同时出现 replaces 与 extends 时，必须取**更强**的 replaces。
   *
   * 这一条是回归测试。原实现用 `Object.entries` 遍历并在首个命中处 break，
   * 而对象键顺序是 extends > improves > replaces > combines（定义顺序，
   * 不是强度顺序），于是 "replaces X and extends it" 被误判成 extends。
   * 症状极隐蔽：只有多类型共现的句子才触发。
   */
  const both = buildEvolution(mk('DFSDT replaces Toolformer and extends it'))
  eq(both.relations[0].relation_type, 'replaces', 'replaces 与 extends 共现时必须取更强的 replaces')
  console.log('  ✓ 强弱优先：replaces + extends 共现 → replaces（回归）')

  /* 反向：三类句式都出现但宾语不是任何方法 → 一条因果都不许有 */
  const noAnchor = buildEvolution(mk('Our work replaces the baseline, improves over existing methods and combines several ideas.'))
  eq(noAnchor.relations[0].relation_type, 'temporal', '句式齐全但无具体宾语 → 仍须降级 temporal')
  console.log('  ✓ 反向：句式齐全但宾语是 baseline/existing methods → temporal')
}

/* ================================================================== */
section('3. 没有对应 Evidence → 降级为时间相关')
/* ================================================================== */

{
  /* 情形 a：方法干脆没有挂任何证据 */
  const noEv = buildEvolution({
    methods: [
      METHOD('M001', 'P001', 'ReAct', { year: 2022, evidence_ids: [] }),
      METHOD('M002', 'P002', 'SWE-agent', { year: 2024, evidence_ids: [] }),
    ],
    evidence: [],
    papers: [PAPER('P001', 2022), PAPER('P002', 2024)],
    alignments: [],
  })
  eq(noEv.relations[0].relation_type, 'temporal', '双方都无证据 → temporal')
  eq(noEv.stats.causal_total, 0, '无证据时因果数必须为 0')

  /*
   * 情形 b：**证据归属错误** —— 这条最难发现，也最危险。
   *
   * 证据 E002 的文本确实说了 "builds on ReAct"，但它的 paper_id 是 P001，
   * 而挂在它上面的方法 M002 属于 P002。也就是说这条证据不属于 M002 的论文。
   *
   * 如果不校归属，我们会凭一条**不该属于这篇论文**的句子画出一条因果箭头——
   * 而且它看起来完全合理（文本确实提到了两个方法），用户永远发现不了。
   * 门 C 必须拦下它。
   */
  const wrongOwner = buildEvolution({
    methods: [
      METHOD('M001', 'P001', 'ReAct', { year: 2022, evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'SWE-agent', { year: 2024, evidence_ids: ['E002'] }),
    ],
    evidence: [
      EVID('E001', 'P001', 'We propose ReAct.'),
      // ⚠️ paper_id 是 P001，不是 M002 所属的 P002
      EVID('E002', 'P001', 'SWE-agent builds on ReAct and extends it.'),
    ],
    papers: [PAPER('P001', 2022), PAPER('P002', 2024)],
    alignments: [],
  })
  eq(wrongOwner.relations[0].relation_type, 'temporal', '证据归属错误 → 不得产生因果')
  check(wrongOwner.stats.causal_total === 0, '反向：归属错误时因果数必须为 0')
  console.log('  ✓ 无证据 → temporal；证据归属错误 → temporal（门 C 拦住）')
}

/* ================================================================== */
section('4. 同一方法不能自己指向自己')
/* ================================================================== */

{
  /*
   * 自指有两条可能的产生路径：
   *   a) 方法列表里出现同一身份（paper_id::method_id 完全相同）两次（脏数据）
   *   b) 证据文本里"点名"的其实是方法自己
   * 两条都要堵。下面的第一组用**不同论文的同号方法**（合法），
   * 第二组才用**同一身份的重复登记**（真正该被拦的）。
   */
  const selfRef = buildEvolution({
    methods: [
      METHOD('M001', 'P001', 'ReAct', { year: 2022, evidence_ids: ['E001'] }),
      METHOD('M001', 'P002', 'ReAct-Agent', { year: 2024, evidence_ids: ['E002'] }),
    ],
    evidence: [
      EVID('E001', 'P001', 'We propose ReAct.'),
      EVID('E002', 'P002', 'ReAct-Agent extends ReAct and builds on it.'),
    ],
    papers: [PAPER('P001', 2022), PAPER('P002', 2024)],
    alignments: [],
  })

  for (const r of selfRef.relations) {
    check(
      r.source_method_key !== r.target_method_key,
      `出现自指关系：${r.relation_id}（${r.source_method_key} → ${r.target_method_key}）`,
    )
  }
  console.log(`  ✓ 3 种关系数据下无自指（检查了 ${selfRef.relations.length} 条关系）`)

  /*
   * 补充一条**跨论文撞号**的断言。
   *
   * 这是 method_id 只在项目内唯一带来的真实形态：两篇论文都被抽成 M001。
   * 此时 source_method === target_method（都是 "M001"），但这是**两个不同方法**，
   * 关系合法、不该被判成自指。判等必须用 paper_id::method_id 拼出的身份键。
   * 早期实现用裸 method_id 判自指，这条会误报；用裸 method_id 判"是不是同一物"，
   * 又会把一条合法的跨论文关系吞掉。两个方向都错，故专门钉住。
   */
  const crossCollide = buildEvolution({
    methods: [
      METHOD('M001', 'P001', 'ReAct', { year: 2022, evidence_ids: ['E001'] }),
      METHOD('M001', 'P002', 'ReAct-Agent', { year: 2024, evidence_ids: ['E002'] }),
    ],
    evidence: [
      EVID('E001', 'P001', 'We propose ReAct.'),
      EVID('E002', 'P002', 'ReAct-Agent extends ReAct to repositories.'),
    ],
    papers: [PAPER('P001', 2022), PAPER('P002', 2024)],
    alignments: [],
  })
  eq(crossCollide.relations.length, 1, '跨论文撞号仍应产出 1 条关系')
  const collideRel = crossCollide.relations[0]
  eq(collideRel.source_method, 'M001', '撞号时 source_method 面值就是 M001（真实形态）')
  eq(collideRel.target_method, 'M001', '撞号时 target_method 面值也是 M001')
  check(
    collideRel.source_method_key !== collideRel.target_method_key,
    '撞号关系的身份键必须不同（否则会被误判为自指）',
  )
  eq(collideRel.relation_type, 'extends', '撞号不影响因果判定：仍能识别 extends')
  eq(assertEvolutionInvariants(crossCollide), [], '撞号数据的不变量校验必须为空（不得误报自指）')
  console.log('  ✓ 跨论文撞号（都叫 M001）：身份键不同 → 不误报自指，且 extends 判定不受影响')

  /*
   * 真正该被拦的那一组：**同一身份被登记两次**（同论文同 id）。
   * 排序会把这两条排在相邻位置，若不拦就会画出一条自指边。
   * 期望：边仍生成但降级为 temporal，且 basis 明确说是重复登记。
   */
  const dupIdentity = buildEvolution({
    methods: [
      METHOD('M001', 'P001', 'ReAct', { year: 2022, evidence_ids: ['E001'] }),
      METHOD('M001', 'P001', 'ReAct', { year: 2022, evidence_ids: ['E001'] }),
    ],
    evidence: [EVID('E001', 'P001', 'We propose ReAct.')],
    papers: [PAPER('P001', 2022)],
    alignments: [],
  })
  eq(dupIdentity.relations.length, 1, '重复登记应产出 1 条边（不是静默丢弃）')
  eq(
    dupIdentity.relations[0].relation_type,
    'temporal',
    '同一身份重复登记 → 必须降级 temporal，不得判因果',
  )
  check(
    dupIdentity.relations[0].basis.includes('duplicate_method_identity'),
    `重复登记应记入 basis，实际 ${JSON.stringify(dupIdentity.relations[0].basis)}`,
  )
  eq(dupIdentity.stats.causal_total, 0, '重复登记不得产生任何因果关系')
  console.log('  ✓ 同一身份重复登记 → temporal（basis=duplicate_method_identity），因果 0 条')

  /* 更直接的一条：断言不变量函数本身会抓自指（身份键相同） */
  const fake = {
    evolutions: [],
    relations: [
      {
        relation_id: 'ER999',
        source_method: 'M001',
        target_method: 'M001',
        source_paper_id: 'P001',
        target_paper_id: 'P001',
        source_method_key: 'P001::M001',
        target_method_key: 'P001::M001',
        relation_type: 'extends',
        description: 'x',
        evidence_ids: ['E001'],
        causal: true,
        confidence: 1,
        basis: [],
      },
    ],
  }
  const bad = assertEvolutionInvariants(fake)
  check(bad.some((m) => m.includes('自指')), '不变量函数必须能抓出自指关系')
  console.log('  ✓ 反向：不变量函数确实能识别自指')
}

/* ================================================================== */
section('5. 输入乱序 → 结果一致（确定性）')
/* ================================================================== */

{
  const mk = () => ({
    methods: [
      METHOD('M001', 'P001', 'ReAct', { year: 2022, evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'SWE-agent', { year: 2023, evidence_ids: ['E002'] }),
      METHOD('M003', 'P003', 'OpenHands', { year: 2024, evidence_ids: ['E003'] }),
    ],
    evidence: [
      EVID('E001', 'P001', 'We propose ReAct.'),
      EVID('E002', 'P002', 'SWE-agent builds on ReAct and extends it.'),
      EVID('E003', 'P003', 'OpenHands extends SWE-agent into a platform.'),
    ],
    papers: [PAPER('P001', 2022), PAPER('P002', 2023), PAPER('P003', 2024)],
    alignments: [],
  })

  const base = buildEvolution(mk())
  eq(buildEvolution(mk()), base, '同一输入两次调用必须逐字段一致')

  /* 穷举 3 个方法的全部 6 种输入排列 */
  const perms = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ]
  let identical = 0
  for (const p of perms) {
    const input = mk()
    input.methods = p.map((i) => input.methods[i])
    input.evidence = p.map((i) => input.evidence[i])
    input.papers = p.map((i) => input.papers[i])
    const out = buildEvolution(input)

    eq(
      out.evolutions.map((e) => [e.evolution_id, e.method_id, e.year, e.relation_from_prev]),
      base.evolutions.map((e) => [e.evolution_id, e.method_id, e.year, e.relation_from_prev]),
      `输入排列 [${p.join(',')}] 改变了 evolutions`,
    )
    eq(
      out.relations.map((r) => [r.relation_id, r.source_method, r.target_method, r.relation_type]),
      base.relations.map((r) => [r.relation_id, r.source_method, r.target_method, r.relation_type]),
      `输入排列 [${p.join(',')}] 改变了 relations`,
    )
    if (JSON.stringify(out) === JSON.stringify(base)) identical++
  }
  check(identical === 6, `穷举 6 种排列应全部逐字节一致，实际 ${identical}/6`)
  console.log(`  ✓ 穷举 ${identical}/6 种输入排列输出逐字节一致`)
  console.log(
    `  ✓ 链：${base.evolutions.map((e) => `${e.method_id}(${e.year})`).join(' → ')}`,
  )
  console.log(
    `  ✓ 关系：${base.relations.map((r) => `${r.relation_id}:${r.source_method}→${r.target_method}=${r.relation_type}`).join(' | ')}`,
  )

  /* 方向稳定性：source 的年份不得早于 target */
  for (const r of base.relations) {
    const sy = base.evolutions.find((e) => e.method_id === r.source_method)?.year ?? 0
    const ty = base.evolutions.find((e) => e.method_id === r.target_method)?.year ?? 0
    check(sy >= ty, `关系 ${r.relation_id} 方向错误：source 年(${sy}) 应不早于 target 年(${ty})`)
  }
  console.log('  ✓ 方向稳定：source 恒为 later')
}

/* ================================================================== */
section('6. 所有强演进关系都能回链 Evidence')
/* ================================================================== */

{
  const out = buildEvolution({
    methods: [
      METHOD('M001', 'P001', 'ReAct', { year: 2020, evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'SWE-agent', { year: 2022, evidence_ids: ['E002'] }),
      METHOD('M003', 'P003', 'OpenHands', { year: 2024, evidence_ids: ['E003'] }),
    ],
    evidence: [
      EVID('E001', 'P001', 'We propose ReAct.'),
      EVID('E002', 'P002', 'SWE-agent builds on ReAct and extends it.'),
      EVID('E003', 'P003', 'OpenHands improves over SWE-agent on long-horizon tasks.'),
    ],
    papers: [PAPER('P001', 2020), PAPER('P002', 2022), PAPER('P003', 2024)],
    alignments: [],
  })

  const evById = new Map(out.evolutions.map((e) => [e.method_id, e]))
  // 证据索引：本测试里 E00x 与 P00x 一一对应
  const evPaper = { E001: 'P001', E002: 'P002', E003: 'P003' }

  const causals = out.relations.filter((r) => r.causal)
  check(causals.length === 2, `应有 2 条因果关系，实际 ${causals.length}`)

  for (const r of causals) {
    /* (a) 证据非空 */
    check(r.evidence_ids.length > 0, `${r.relation_id} 是因果却没有证据`)
    /* (b) 每个 evidence_id 都真实存在（能查到） */
    for (const eid of r.evidence_ids) {
      check(!!evPaper[eid], `${r.relation_id} 引用了不存在的证据 ${eid}`)
      /* (c) 关键：证据必须属于 source（later）的论文 —— 防左右写反 */
      eq(
        evPaper[eid],
        r.source_paper_id,
        `${r.relation_id} 的证据 ${eid} 归属错误：应属 source 论文 ${r.source_paper_id}`,
      )
      /* (d) 该证据必须真的挂在 source 方法的 evidence_ids 里 */
      const src = out.evolutions.find((e) => e.method_id === r.source_method)
      check(
        !!src && src.evidence_ids.includes(eid),
        `${r.relation_id} 的证据 ${eid} 不在 source 方法 ${r.source_method} 的 evidence_ids 中`,
      )
    }
    /* (e) 双方 method_id / paper_id 齐备 */
    check(!!r.source_method && !!r.target_method, `${r.relation_id} 缺 method_id`)
    check(!!r.source_paper_id && !!r.target_paper_id, `${r.relation_id} 缺 paper_id`)
    check(!!evById.get(r.source_method) && !!evById.get(r.target_method), `${r.relation_id} 指向不存在的方法`)
  }

  /* 不变量函数必须全过 */
  eq(assertEvolutionInvariants(out), [], '不变量校验应全部通过')
  check(out.stats.causal_without_evidence === 0, '无证据的因果数必须为 0')
  console.log(`  ✓ ${causals.length} 条因果关系：证据存在、归属正确、挂在 source 上、双方 ID 齐备`)
  console.log('  ✓ 不变量校验通过，causal_without_evidence = 0')
}

/* ================================================================== */
section('7. 同年方法：顺序稳定，且不判因果')
/* ================================================================== */

{
  const mk = () => ({
    methods: [
      METHOD('M001', 'P001', 'Alpha', { year: 2024, evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'Beta', { year: 2024, evidence_ids: ['E002'] }),
    ],
    /* 即使证据里出现了明确的因果句式，同年也不允许判因果 */
    evidence: [
      EVID('E001', 'P001', 'We propose Alpha.'),
      EVID('E002', 'P002', 'Beta builds on Alpha and extends it.'),
    ],
    papers: [PAPER('P001', 2024), PAPER('P002', 2024)],
    alignments: [],
  })
  const out = buildEvolution(mk())

  eq(out.relations[0].relation_type, 'temporal', '同年 → 不得产生因果（无法确立先后）')
  check(
    out.relations[0].basis.includes('same_year_no_order'),
    `basis 应记录 same_year_no_order，实际 ${JSON.stringify(out.relations[0].basis)}`,
  )
  console.log('  ✓ 同年 + 明确因果句式 → 仍为 temporal（年份无法确立先后）')

  /* 排序稳定：按 (paper_id, method_id) 字典序，与输入顺序无关 */
  const flipped = mk()
  flipped.methods = [flipped.methods[1], flipped.methods[0]]
  flipped.evidence = [flipped.evidence[1], flipped.evidence[0]]
  const out2 = buildEvolution(flipped)
  eq(
    out2.evolutions.map((e) => e.method_id),
    out.evolutions.map((e) => e.method_id),
    '同年方法的链顺序必须与输入顺序无关',
  )
  console.log(`  ✓ 同年排序稳定：${out.evolutions.map((e) => e.method_id).join(' → ')}（与输入顺序无关）`)
}

/* ================================================================== */
section('8. 年份为 0 的兜底')
/* ================================================================== */

{
  /* 情形 a：method.year = 0 → 回退到所属论文的 year */
  const fallback = buildEvolution({
    methods: [
      METHOD('M001', 'P001', 'ReAct', { year: 0, evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'SWE-agent', { year: 2024, evidence_ids: ['E002'] }),
    ],
    evidence: [EVID('E001', 'P001', 'x'), EVID('E002', 'P002', 'y')],
    papers: [PAPER('P001', 2019), PAPER('P002', 2024)],
    alignments: [],
  })
  eq(fallback.evolutions[0].year, 2019, 'method.year=0 时应回退到所属论文的 year')
  eq(fallback.stats.unknown_year, 0, '回退成功后不应计入 unknown_year')
  console.log('  ✓ method.year=0 → 回退 paper.year(2019)')

  /* 情形 b：两者都是 0 → 年份记 0，且排到最后 */
  const bothZero = buildEvolution({
    methods: [
      METHOD('M000', 'P000', 'Ancient', { year: 0, evidence_ids: [] }),
      METHOD('M002', 'P002', 'Modern', { year: 2024, evidence_ids: ['E002'] }),
    ],
    evidence: [EVID('E002', 'P002', 'y')],
    papers: [PAPER('P000', 0), PAPER('P002', 2024)],
    alignments: [],
  })
  eq(bothZero.stats.unknown_year, 1, '年份不可知的节点应被计入 unknown_year')
  eq(
    bothZero.evolutions.map((e) => e.method_id),
    ['M002', 'M000'],
    '年份为 0 的方法必须排在已知年份之后，而不是被当作最早',
  )
  check(
    bothZero.relations[0].basis.includes('unknown_year_no_order'),
    '年份不可知时 basis 应记录 unknown_year_no_order',
  )

  /* 反向：不得用"当前年份"兜底 —— 那会破坏确定性 */
  const a = buildEvolution({
    methods: [METHOD('M001', 'P001', 'X', { year: 0, evidence_ids: [] })],
    evidence: [],
    papers: [PAPER('P001', 0)],
    alignments: [],
  })
  eq(a.evolutions[0].year, 0, '年份不可知时必须如实记 0，不得猜成当前年份')
  console.log('  ✓ 双 0 → year=0、排最后、unknown_year=1；不猜当前年份')
}

/* ================================================================== */
section('9. 消费 Phase 4-2 的对齐关系')
/* ================================================================== */

{
  /*
   * 若相邻两个方法被 4-2 判为 same/alias，说明它们**是同一个东西**，
   * 那就不是"演进"。必须标 related 并且**不画因果箭头**。
   */
  const withAlign = buildEvolution({
    methods: [
      METHOD('M001', 'P001', 'Model Context Protocol', { year: 2022, evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'Model Context Protocol', { year: 2024, evidence_ids: ['E002'] }),
    ],
    evidence: [EVID('E001', 'P001', 'x'), EVID('E002', 'P002', 'y')],
    papers: [PAPER('P001', 2022), PAPER('P002', 2024)],
    alignments: [
      ALIGN('A001', 'M001', 'M002', 'same', {
        evidence_ids: ['E001', 'E002'],
        sourcePaper: 'P001',
        targetPaper: 'P002',
      }),
    ],
  })
  eq(withAlign.relations[0].relation_type, 'related', '被判为同一方法 → 应标 related')
  eq(withAlign.relations[0].causal, false, '同一方法不是演进，不得标因果')
  check(
    withAlign.relations[0].basis.includes('aligned_same_method'),
    `basis 应记录 aligned_same_method，实际 ${JSON.stringify(withAlign.relations[0].basis)}`,
  )
  check(
    withAlign.relations[0].description.includes('同一方法'),
    'description 应说明是同一方法而非演进',
  )
  console.log('  ✓ 4-2 判 same → related（同一物，非演进），不画因果箭头')

  /*
   * ── 反向断言 ──
   * 把 alignment 删掉，同样两个方法必须退回 temporal。
   * 这证明 related 确实来自 4-2 的输入，而不是模块自己猜的。
   */
  const withoutAlign = buildEvolution({
    methods: [
      METHOD('M001', 'P001', 'Model Context Protocol', { year: 2022, evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'Model Context Protocol', { year: 2024, evidence_ids: ['E002'] }),
    ],
    evidence: [EVID('E001', 'P001', 'x'), EVID('E002', 'P002', 'y')],
    papers: [PAPER('P001', 2022), PAPER('P002', 2024)],
    alignments: [],
  })
  eq(withoutAlign.relations[0].relation_type, 'temporal', '删掉 alignment 后应退回 temporal')
  console.log('  ✓ 反向：删掉 alignment → 退回 temporal（证明 related 确实来自 4-2）')

  /*
   * 方向无关：4-2 的 source/target 按 (paper_id, method_id) 字典序，
   * 与本模块的 (earlier, later) 时间序不是同一个方向。
   * 把 alignment 的两个 side 反过来写，结果必须一样。
   */
  const reversed = buildEvolution({
    methods: [
      METHOD('M001', 'P001', 'Model Context Protocol', { year: 2022, evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'Model Context Protocol', { year: 2024, evidence_ids: ['E002'] }),
    ],
    evidence: [EVID('E001', 'P001', 'x'), EVID('E002', 'P002', 'y')],
    papers: [PAPER('P001', 2022), PAPER('P002', 2024)],
    /* ⚠️ 这里把 source/target 反过来（M002 在前） */
    alignments: [
      ALIGN('A001', 'M002', 'M001', 'alias', {
        evidence_ids: ['E001', 'E002'],
        sourcePaper: 'P002',
        targetPaper: 'P001',
      }),
    ],
  })
  eq(reversed.relations[0].relation_type, 'related', 'alignment 的 source/target 反转后仍应命中')
  console.log('  ✓ alignment 双向查找：source/target 反转仍能命中')
}

/* ================================================================== */
section('10. 边界与健壮性')
/* ================================================================== */

{
  /* 空输入 */
  const empty = buildEvolution({ methods: [], evidence: [], papers: [], alignments: [] })
  eq(empty.evolutions, [], '空输入不得产出节点')
  eq(empty.relations, [], '空输入不得产出关系')
  eq(empty.stats.total_relations, 0, '空输入统计应为 0')
  eq(empty.stats.stages, 0, '空输入阶段数应为 0')
  eq(assertEvolutionInvariants(empty), [], '空输入不变量应通过')
  console.log('  ✓ 空输入不崩，产出空链')

  /* 单个方法：链长为 1，无关系 */
  const single = buildEvolution({
    methods: [METHOD('M001', 'P001', 'OnlyOne', { year: 2024, evidence_ids: ['E001'] })],
    evidence: [EVID('E001', 'P001', 'x')],
    papers: [PAPER('P001', 2024)],
    alignments: [],
  })
  eq(single.evolutions.length, 1, '单方法应产出 1 个节点')
  eq(single.evolutions[0].relation_from_prev, null, '链首的 relation_from_prev 必须为 null')
  eq(single.relations, [], '单方法不得产出关系')
  eq(single.context.adjacent_pairs, 0, '单方法相邻对应为 0')
  console.log('  ✓ 单方法：链首 relation_from_prev=null，无关系')

  /* 孤儿方法：paper_ids 指向不存在的论文 → 排除并统计 */
  const orphan = buildEvolution({
    methods: [
      METHOD('M001', 'P001', 'Good', { year: 2024, evidence_ids: [] }),
      METHOD('M999', 'P_NO_SUCH', 'Orphan', { year: 2024, evidence_ids: [] }),
      METHOD('M998', '', 'NoPaper', { year: 2024, evidence_ids: [] }),
    ],
    evidence: [],
    papers: [PAPER('P001', 2024)],
    alignments: [],
  })
  eq(orphan.evolutions.length, 1, '缺有效论文归属的方法应被排除')
  eq(orphan.context.skipped_no_paper, 2, '被排除的方法数必须如实统计，不能静默丢弃')
  console.log('  ✓ 孤儿方法：排除 2 个并如实计入 skipped_no_paper')

  /* 悬空 evidence_id：静默剔除，不与"有证据"混淆 */
  const dangling = buildEvolution({
    methods: [
      METHOD('M001', 'P001', 'A', { year: 2020, evidence_ids: ['E_NO_SUCH', 'E001'] }),
      METHOD('M002', 'P002', 'B', { year: 2024, evidence_ids: ['E002'] }),
    ],
    evidence: [EVID('E001', 'P001', 'x'), EVID('E002', 'P002', 'y')],
    papers: [PAPER('P001', 2020), PAPER('P002', 2024)],
    alignments: [],
  })
  eq(
    dangling.evolutions[0].evidence_ids,
    ['E001'],
    '悬空 evidence_id 应被剔除，只保留真实存在的',
  )
  console.log('  ✓ 悬空 evidence_id 被剔除，节点仅保留真实证据')

  /* 中文证据命中 */
  const zh = buildEvolution({
    methods: [
      METHOD('M001', 'P001', 'ReAct', { year: 2022, name_zh: '推理-行动', evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'SWE-agent', { year: 2024, evidence_ids: ['E002'] }),
    ],
    evidence: [
      EVID('E001', 'P001', 'We propose ReAct.'),
      EVID('E002', 'P002', 'We build the system.', {
        translation: '本方法继承了 ReAct 的思路并加以扩展。',
      }),
    ],
    papers: [PAPER('P001', 2022), PAPER('P002', 2024)],
    alignments: [],
  })
  eq(zh.relations[0].relation_type, 'extends', '中文释义里的「继承」应能命中门 A')
  console.log('  ✓ 中文释义命中：translation 中的「继承」触发了 extends')
}

/* ================================================================== */
section('11. 规则版本与类型白名单')
/* ================================================================== */

{
  check(
    EVOLUTION_RULE_VERSION.startsWith('deterministic-'),
    '规则版本需标明是确定性规则，不得让人误以为是模型产出',
  )
  const out = buildEvolution({ methods: [], evidence: [], papers: [], alignments: [] })
  eq(out.rule_version, EVOLUTION_RULE_VERSION, '产出必须带规则版本')

  /* 因果白名单：temporal 绝不能被当成因果 */
  check(isCausalRelationType('extends') === true, 'extends 应在因果白名单里')
  check(isCausalRelationType('improves') === true, 'improves 应在因果白名单里')
  check(isCausalRelationType('replaces') === true, 'replaces 应在因果白名单里')
  check(isCausalRelationType('combines') === true, 'combines 应在因果白名单里')
  check(isCausalRelationType('temporal') === false, 'temporal 必须不在因果白名单里')
  check(isCausalRelationType('related') === false, 'related 必须不在因果白名单里')
  check(isCausalRelationType('parallel') === false, 'parallel 必须不在因果白名单里')
  check(isCausalRelationType('nonsense') === false, '未知类型不得被判为因果')

  /* 全集白名单 */
  for (const t of [...CAUSAL_RELATION_TYPES, ...NON_CAUSAL_RELATION_TYPES]) {
    check(isEvolutionRelationType(t) === true, `${t} 应在演进关系白名单里`)
  }
  check(isEvolutionRelationType('gap') === false, 'gap 这类非演进类型不得通过白名单')
  console.log(`  ✓ 规则版本：${EVOLUTION_RULE_VERSION}`)
  console.log(
    `  ✓ 白名单：因果 ${CAUSAL_RELATION_TYPES.length} 类 + 非因果 ${NON_CAUSAL_RELATION_TYPES.length} 类，temporal 不在因果里`,
  )
}

/* ================================================================== */
section('12. 泛泛自夸不得产生任何关系（本节最重要）')
/* ================================================================== */

/*
 * 方法论文里满地都是 "we improve the accuracy"、"outperforms existing methods"。
 * 这些话命中了触发词（improve / outperform），但它们的宾语**不是一个具名方法** ——
 * 它们是自夸，不是演进声明。
 *
 * 这是本模块最容易被"聪明的实现"搞砸的地方：一个只看句式的实现会把它们
 * 全部变成因果箭头，画出一张看似丰富、实则全是幻觉的演进图。
 * 本节就是钉死这个边界。
 */
{
  const SELF_PRAISE = [
    'We improve the accuracy of our method by 5%.',
    'Our method improves over the baseline.',
    'Our approach outperforms existing methods.',
    'We achieve better than state of the art results.',
    'The improvement is significant across all benchmarks.',
    'Our system integrates several components.',
    'This work combines retrieval and reasoning.',
  ]

  let clean = 0
  for (const text of SELF_PRAISE) {
    const out = buildEvolution({
      methods: [
        METHOD('M001', 'P001', 'ReAct', { year: 2022, evidence_ids: ['E001'] }),
        METHOD('M002', 'P002', 'SWE-agent', { year: 2024, evidence_ids: ['E002'] }),
      ],
      evidence: [EVID('E001', 'P001', 'We propose ReAct.'), EVID('E002', 'P002', text)],
      papers: [PAPER('P001', 2022), PAPER('P002', 2024)],
      alignments: [],
    })
    const hasCausal = out.relations.some((r) => r.causal)
    if (!hasCausal) clean++
    else errors.push(`泛泛自夸被误判为因果：「${text}」`)
  }
  check(clean === SELF_PRAISE.length, `全部 ${SELF_PRAISE.length} 条自夸句都应不产生因果，实际 ${clean} 条`)

  /*
   * 最关键的一对对照：同一句话，加不加具体宾语，结果必须不同。
   * 如果这两条都产生因果，或都不产生，说明门 B 是坏的。
   */
  const mk = (text) => ({
    methods: [
      METHOD('M001', 'P001', 'ReAct', { year: 2022, evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'SWE-agent', { year: 2024, evidence_ids: ['E002'] }),
    ],
    evidence: [EVID('E001', 'P001', 'We propose ReAct.'), EVID('E002', 'P002', text)],
    papers: [PAPER('P001', 2022), PAPER('P002', 2024)],
    alignments: [],
  })
  const vague = buildEvolution(mk('Our method improves over the baseline.'))
  const anchored = buildEvolution(mk('Our method improves over ReAct.'))

  eq(vague.relations[0].relation_type, 'temporal', '无具体宾语 → temporal')
  eq(anchored.relations[0].relation_type, 'improves', '点名 ReAct → improves')
  check(
    vague.relations[0].relation_type !== anchored.relations[0].relation_type,
    '同一句式下，有无具体宾语必须导致不同结论 —— 否则门 B 失效',
  )
  console.log(`  ✓ ${clean}/${SELF_PRAISE.length} 条自夸句均未产生因果`)
  console.log('  ✓ 对照：improves over the baseline → temporal；improves over ReAct → improves')
}

/* ================================================================== */
section('13. follows the 的取舍（保留，但受门 B 约束）')
/* ================================================================== */

/*
 * `follows the` 比 extends 弱，保留它的代价必须靠门 B 兜住。
 * 这一节就是把这个耦合关系写成可执行的断言 ——
 * 如果哪天有人放宽了门 B，这里会立刻红。
 */
{
  const mk = (text, targetName = 'ReAct') => ({
    methods: [
      METHOD('M001', 'P001', targetName, { year: 2022, evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'OurSystem', { year: 2024, evidence_ids: ['E002'] }),
    ],
    evidence: [EVID('E001', 'P001', `We propose ${targetName}.`), EVID('E002', 'P002', text)],
    papers: [PAPER('P001', 2022), PAPER('P002', 2024)],
    alignments: [],
  })

  /* 正向：点名了项目内的具名方法 → 允许 extends */
  const named = buildEvolution(mk('Our system follows the ReAct paradigm.'))
  eq(named.relations[0].relation_type, 'extends', 'follows the + 具名方法 → extends')

  /* 反向 a：the setup / the pipeline 不是具名方法 → 不得产生因果 */
  const setup = buildEvolution(mk('We follow the setup of prior work.'))
  eq(setup.relations[0].relation_type, 'temporal', 'follows the setup → 不是具名方法，须降级')

  const pipeline = buildEvolution(mk('Following the standard pipeline, we evaluate.'))
  eq(pipeline.relations[0].relation_type, 'temporal', 'following the pipeline → 须降级')
  console.log('  ✓ follows the ReAct paradigm → extends')
  console.log('  ✓ 反向：follows the setup / the pipeline → temporal（门 B 兜住了弱规则）')
}

/* ================================================================== */
section('14. 同论文内部不判因果（沿用 Phase 4-2 的硬规则）')
/* ================================================================== */

/*
 * 4-2 里"同一篇论文的方法不互相对齐"是硬规则，理由是两个方法往往是
 * 同一贡献的不同侧面。演进链必须沿用同一条约束 ——
 * 否则同一篇论文里的 "我们的 X 改进了我们的 Y" 会被当成跨论文技术演进。
 */
{
  const samePaper = buildEvolution({
    methods: [
      METHOD('M001', 'P001', 'Base', { year: 2020, evidence_ids: ['E001'] }),
      METHOD('M002', 'P001', 'Improved', { year: 2024, evidence_ids: ['E002'] }),
    ],
    evidence: [
      EVID('E001', 'P001', 'We propose Base.'),
      /* 即使证据明确说了因果，同论文也不允许判因果 */
      EVID('E002', 'P001', 'Our Improved method builds on Base and extends it.'),
    ],
    papers: [PAPER('P001', 2020)],
    alignments: [],
  })

  eq(samePaper.relations[0].relation_type, 'temporal', '同论文内不得判因果')
  check(
    samePaper.relations[0].basis.includes('same_paper_no_causal'),
    `basis 应记录 same_paper_no_causal，实际 ${JSON.stringify(samePaper.relations[0].basis)}`,
  )
  check(samePaper.stats.causal_total === 0, '反向：同论文时因果数必须为 0')

  /* 对照：把同样两个方法拆到不同论文，就应该能产生因果 */
  const crossPaper = buildEvolution({
    methods: [
      METHOD('M001', 'P001', 'Base', { year: 2020, evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'Improved', { year: 2024, evidence_ids: ['E002'] }),
    ],
    evidence: [
      EVID('E001', 'P001', 'We propose Base.'),
      EVID('E002', 'P002', 'Our Improved method builds on Base and extends it.'),
    ],
    papers: [PAPER('P001', 2020), PAPER('P002', 2024)],
    alignments: [],
  })
  eq(crossPaper.relations[0].relation_type, 'extends', '拆到不同论文后应能判 extends')
  console.log('  ✓ 同论文 + 明确因果证据 → 仍为 temporal')
  console.log('  ✓ 对照：拆到不同论文 → extends（证明是同论文规则在拦截，而非其他原因）')
}

/* ================================================================== */
section('15. 统计自洽')
/* ================================================================== */

{
  const out = buildEvolution({
    methods: [
      METHOD('M001', 'P001', 'ReAct', { year: 2020, evidence_ids: ['E001'] }),
      METHOD('M002', 'P002', 'SWE-agent', { year: 2022, evidence_ids: ['E002'] }),
      METHOD('M003', 'P003', 'OpenHands', { year: 2024, evidence_ids: ['E003'] }),
    ],
    evidence: [
      EVID('E001', 'P001', 'We propose ReAct.'),
      EVID('E002', 'P002', 'SWE-agent builds on ReAct and extends it.'),
      EVID('E003', 'P003', 'OpenHands is a platform for agents.'),
    ],
    papers: [PAPER('P001', 2020), PAPER('P002', 2022), PAPER('P003', 2024)],
    alignments: [],
  })
  const s = out.stats

  const seven =
    s.extends + s.improves + s.replaces + s.combines + s.related + s.parallel + s.temporal
  eq(seven, s.total_relations, '七类之和必须等于 total_relations')
  eq(s.total_relations, out.relations.length, 'total_relations 必须等于 relations.length')
  eq(
    s.causal_total + s.non_causal_total,
    s.total_relations,
    '因果数 + 非因果数 必须等于总数',
  )
  eq(s.stages, out.evolutions.length, 'stages 必须等于 evolutions.length')
  eq(s.causal_without_evidence, 0, '无证据的因果数必须为 0')

  /* 独立复算一遍，防止 summarizeEvolutions 自己算错 */
  const recomputed = summarizeEvolutions(out.relations, out.evolutions)
  eq(recomputed, s, 'summarizeEvolutions 两次调用必须一致')

  eq(out.context.adjacent_pairs, Math.max(0, out.evolutions.length - 1), '相邻对数必须正确')
  eq(out.context.methods, 3, 'context.methods 应为输入方法数')
  console.log(
    `  ✓ 统计自洽：extends=${s.extends} temporal=${s.temporal} causal=${s.causal_total} total=${s.total_relations} stages=${s.stages}`,
  )
}

/* ================================================================== */

console.log('\n' + '─'.repeat(62))
if (errors.length) {
  console.log(`✗ 技术演进测试失败（${errors.length} 项 / 通过 ${pass} 项）\n`)
  for (const e of errors) console.log(`  ✗ ${e}`)
  process.exit(1)
}
console.log(`✓ 技术演进测试全部通过（${pass} 项断言）`)
console.log('  年份不推因果 · 三道门缺一不可 · 无证据降级 temporal · 不自指 · 乱序一致 · 因果可回链')
