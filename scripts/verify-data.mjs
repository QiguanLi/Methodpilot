/**
 * 数据一致性校验（Evidence-First 的结构性保证）
 *
 * 为什么要有这个脚本：
 * MethodPilot 的核心承诺是"任何 AI 结论都能回溯到原文证据"。
 * 这个承诺如果只写在文案里，就只是营销；它必须能被机器验证。
 * 本脚本把所有跨表引用（paper_id / method_id / evidence_id / gap_id /
 * direction_id / family_id）逐一解析，任何一处指向不存在的 ID 都会报错。
 *
 * 运行：node scripts/verify-data.mjs
 *
 * 实现说明：数据层是 TypeScript，用项目自带的 rolldown 先打包成一段
 * 临时 ESM 再 import，这样不需要引入额外依赖。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const { rolldown } = await import(
  path.join(root, 'node_modules/.pnpm/rolldown@1.2.9/node_modules/rolldown/dist/index.mjs')
)

const outDir = mkdtempSync(path.join(tmpdir(), 'mpdata-'))
const bundle = await rolldown({ input: path.join(root, 'src/data/index.ts') })
await bundle.write({
  dir: outDir,
  format: 'esm',
  entryFileNames: 'data.mjs',
  codeSplitting: false,
})
await bundle.close()

const kb = await import(path.join(outDir, 'data.mjs'))

/* ------------------------------------------------------------------ */

const errors = []
const check = (cond, msg) => {
  if (!cond) errors.push(msg)
}

const { papers, methods, families, relations, evolutions, gaps, directions, evidence } = kb

const paperIds = new Set(papers.map((p) => p.paper_id))
const methodIds = new Set(methods.map((m) => m.method_id))
const familyIds = new Set(families.map((f) => f.family_id))
const evIds = new Set(evidence.map((e) => e.evidence_id))
const gapIds = new Set(gaps.map((g) => g.gap_id))
const dirIds = new Set(directions.map((d) => d.direction_id))

const ref = (label, id, pool, kind) =>
  check(pool.has(id), `${label} 引用了不存在的${kind}: ${id}`)

/* 1. 论文自洽性 */
for (const p of papers) {
  check(Boolean(p.title) && Boolean(p.year), `论文 ${p.paper_id} 缺少标题或年份`)
}

/* 2. 方法 → paper_ids / family_id / evidence_ids */
for (const m of methods) {
  for (const pid of m.paper_ids ?? []) ref(`方法 ${m.method_id}`, pid, paperIds, '论文')
  if (m.family_id) ref(`方法 ${m.method_id}`, m.family_id, familyIds, '方法族')
  for (const eid of m.evidence_ids ?? []) ref(`方法 ${m.method_id}`, eid, evIds, '证据')
}

/* 3. 方法族 → method_ids */
for (const f of families) {
  for (const mid of f.method_ids ?? []) ref(`方法族 ${f.family_id}`, mid, methodIds, '方法')
}

/* 4. 关系 → from/to + evidence；有向声明必须有证据 */
const GROUNDED = ['extends', 'improves', 'combines', 'replaces']
for (const r of relations) {
  ref(`关系 ${r.relation_id}`, r.source_method, methodIds, '方法')
  ref(`关系 ${r.relation_id}`, r.target_method, methodIds, '方法')
  for (const eid of r.evidence_ids ?? []) ref(`关系 ${r.relation_id}`, eid, evIds, '证据')

  if (GROUNDED.includes(r.relation_type)) {
    check(
      (r.evidence_ids ?? []).length > 0,
      `关系 ${r.relation_id} 声明为「${r.relation_type}」却没有任何证据支撑 —— 这是产品最不能出的错`,
    )
  }
}

/* 5. 演进节点 → method_id + evidence */
for (const e of evolutions) {
  if (e.method_id) ref(`演进 ${e.evolution_id}`, e.method_id, methodIds, '方法')
  for (const eid of e.evidence_ids ?? []) ref(`演进 ${e.evolution_id}`, eid, evIds, '证据')
}

/* 6. 研究空白 → paper_ids / method_ids / evidence_ids */
for (const g of gaps) {
  for (const pid of g.paper_ids ?? []) ref(`空白 ${g.gap_id}`, pid, paperIds, '论文')
  for (const mid of g.method_ids ?? []) ref(`空白 ${g.gap_id}`, mid, methodIds, '方法')
  for (const eid of g.evidence_ids ?? []) ref(`空白 ${g.gap_id}`, eid, evIds, '证据')
  check((g.evidence_ids ?? []).length > 0, `空白 ${g.gap_id} 没有任何证据支撑`)
}

/* 7. 研究方向 → gap_ids / evidence_ids */
for (const d of directions) {
  for (const gid of d.gap_ids ?? []) ref(`方向 ${d.direction_id}`, gid, gapIds, '空白')
  for (const eid of d.evidence_ids ?? []) ref(`方向 ${d.direction_id}`, eid, evIds, '证据')
  check(
    (d.gap_ids ?? []).length > 0,
    `方向 ${d.direction_id} 未关联任何研究空白 —— 方向必须由空白推导而来`,
  )
}

/* 8. 证据 —— 这条链的源头 */
for (const e of evidence) {
  ref(`证据 ${e.evidence_id}`, e.paper_id, paperIds, '论文')
  for (const mid of e.method_ids ?? []) ref(`证据 ${e.evidence_id}`, mid, methodIds, '方法')
  for (const gid of e.gap_ids ?? []) ref(`证据 ${e.evidence_id}`, gid, gapIds, '空白')
  for (const did of e.direction_ids ?? []) ref(`证据 ${e.evidence_id}`, did, dirIds, '方向')
  check(
    e.confidence > 0 && e.confidence <= 1,
    `证据 ${e.evidence_id} 置信度越界: ${e.confidence}`,
  )
  check(Boolean(e.content) && Boolean(e.translation), `证据 ${e.evidence_id} 缺少原文或译文`)
}

/* 9. 空白与方向必须被证据"反向指到" */
for (const g of gaps) {
  const hit = evidence.filter((e) => (e.gap_ids ?? []).includes(g.gap_id))
  check(hit.length > 0, `空白 ${g.gap_id} 没有任何证据在 gap_ids 中指向它`)
}
for (const d of directions) {
  const viaOwn = evidence.filter((e) => (e.direction_ids ?? []).includes(d.direction_id))
  const viaGap = evidence.filter((e) =>
    (e.gap_ids ?? []).some((g) => (d.gap_ids ?? []).includes(g)),
  )
  check(
    viaOwn.length + viaGap.length > 0,
    `方向 ${d.direction_id} 没有任何证据支撑（直接或经由空白）`,
  )
}

/* 10. 每篇论文都要被证据覆盖，否则它在知识链上是死节点 */
const covered = new Set(evidence.map((e) => e.paper_id))
for (const p of papers) {
  check(covered.has(p.paper_id), `论文 ${p.paper_id} 没有任何证据覆盖（证据链断裂）`)
}

/* ------------------------------------------------------------------ */

console.log('— 数据规模 —')
console.log(
  [
    `${papers.length} 论文`,
    `${methods.length} 方法`,
    `${families.length} 方法族`,
    `${relations.length} 关系`,
    `${evolutions.length} 演进节点`,
    `${gaps.length} 研究空白`,
    `${directions.length} 研究方向`,
    `${evidence.length} 证据`,
  ].join(' / '),
)
console.log(`证据表实际条数 ${evidence.length} / 被证据覆盖的论文 ${covered.size}`)

const uncoveredGaps = gaps.filter(
  (g) => !directions.some((d) => (d.gap_ids ?? []).includes(g.gap_id)),
)
console.log(
  `未被方向覆盖的空白: ${uncoveredGaps.length === 0 ? '无' : uncoveredGaps.map((g) => g.gap_id).join(', ')}`,
)

const grounded = relations.filter((r) => GROUNDED.includes(r.relation_type)).length
console.log(
  `关系分级: 有证据支撑 ${grounded} 条 / 保守标注（parallel·related·temporal） ${relations.length - grounded} 条`,
)

if (errors.length) {
  console.log(`\n✗ 发现 ${errors.length} 处引用问题:`)
  for (const e of errors) console.log('  · ' + e)
  process.exit(1)
}
console.log('\n✓ 全部引用闭合，数据一致')
