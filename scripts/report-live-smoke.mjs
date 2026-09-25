#!/usr/bin/env node
/**
 * 调研报告真实数据冒烟（Phase 4-8）。
 *
 * 运行：node --experimental-strip-types scripts/report-live-smoke.mjs
 *
 * 与 report-test.mjs 的分工：
 *   · report-test.mjs       —— 手写夹具，验**规则**（分层、回链、缺数据、乱序）
 *   · report-live-smoke.mjs —— 读 data/store 真实数据，验**契约**（不炸、不悬空）
 *
 * 真实数据是"AI 抽取 + 用户操作"共同产生的，形态比夹具脏得多：
 * 有 0 论文的项目、有方法没证据的项目、年份缺失的方法……
 * 报告必须对每一个都**产出结构合法的结果**，而不是抛异常或给出悬空引用。
 * 本脚本**只读**，绝不写入任何真实数据。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const store = path.join(root, 'data', 'store', 'projects')
if (!existsSync(store)) { console.error(`✗ 找不到 ${store}`); process.exit(1) }

const { alignMethods } = await import('../server/services/methodAlignment.ts')
const { buildEvolution } = await import('../server/services/methodEvolution.ts')
const { detectGaps } = await import('../server/services/researchGaps.ts')
const { generateDirections } = await import('../server/services/researchDirections.ts')
const { buildResearchReport, assertReportInvariants } = await import('../server/services/researchReport.ts')

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
const dirs = readdirSync(store).filter((d) => { try { return statSync(path.join(store, d)).isDirectory() } catch { return false } }).sort()

let bad = 0
const rows = []

for (const dir of dirs) {
  const base = path.join(store, dir)
  const project = readJson(path.join(base, 'project.json'))
  const papers = readJson(path.join(base, 'papers.json')) ?? []
  const methods = readJson(path.join(base, 'methods.json')) ?? []
  const evidence = readJson(path.join(base, 'evidence.json')) ?? []
  const pid = project?.id ?? dir

  const alignment = alignMethods({ methods, evidence, papers })
  const evolution = buildEvolution({ methods, evidence, papers, alignments: alignment.candidates })
  const gaps = detectGaps({ papers, methods, evidence, alignments: alignment.candidates, evolutionRelations: evolution.relations })
  const directions = generateDirections({ gaps: gaps.gaps, methods, evidence, papers, evolutionRelations: evolution.relations })
  const input = { papers, methods, evidence, alignment, evolution, gaps, directions }

  let report
  try {
    report = buildResearchReport(input)
  } catch (e) {
    console.log(`  ✗ ${pid}: buildResearchReport 抛异常 —— ${e.message}`)
    bad++
    continue
  }

  const v = assertReportInvariants(report, input)
  if (v.length) {
    bad += v.length
    console.log(`  ✗ ${pid}: 不变量违反 ${v.length} 处`)
    for (const x of v.slice(0, 3)) console.log(`      · ${x}`)
  }

  rows.push({
    pid,
    name: project?.name ?? '(未命名)',
    papers: papers.length, methods: methods.length, evidence: evidence.length,
    gaps: gaps.gaps.length, dirs: directions.directions.length,
    stmts: report.layering.total_statements, refs: report.layering.total_refs,
    idx: report.evidence_index.length,
    insuf: report.layering.insufficient_sections,
    partial: report.layering.partial_sections,
    title: report.title,
    ok: v.length === 0,
  })
}

console.log('— 调研报告真实数据冒烟（data/store，只读） —')
console.log('')
console.log(
  '  项目'.padEnd(24) + '论/方/证'.padEnd(12) + '空/向'.padEnd(10) +
  '陈述/回链'.padEnd(12) + '索引'.padEnd(7) + '空章/部分'.padEnd(11) + '结论',
)
for (const r of rows) {
  console.log(
    `  ${r.pid.padEnd(22)} ${String(`${r.papers}/${r.methods}/${r.evidence}`).padEnd(10)} ` +
    `${String(`${r.gaps}/${r.dirs}`).padEnd(8)} ${String(`${r.stmts}/${r.refs}`).padEnd(10)} ` +
    `${String(r.idx).padEnd(5)} ${String(`${r.insuf}/${r.partial}`).padEnd(9)} ${r.ok ? '✓' : '✗'}`,
  )
}

console.log('')
const totalStmts = rows.reduce((n, r) => n + r.stmts, 0)
const totalRefs = rows.reduce((n, r) => n + r.refs, 0)
console.log(`  合计：${rows.length} 个项目，${totalStmts} 条陈述，${totalRefs} 条回链，违规 ${bad} 处`)

if (bad) { console.log('\n✗ 真实数据下报告存在违规（本脚本只报不改）'); process.exit(1) }
console.log('\n✓ 所有真实项目均能产出结构合法、回链闭合的调研报告')
