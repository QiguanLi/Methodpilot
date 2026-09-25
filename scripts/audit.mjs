import { readFileSync } from 'node:fs'

const read = (f) => readFileSync(new URL(`../src/data/${f}`, import.meta.url), 'utf8')

// 从 evidence.ts 解析每条证据的 gap_ids / direction_ids
const evSrc = read('evidence.ts')
const evBlocks = evSrc.split(/\n  \{\n/).slice(1)
const evGaps = {}
const evDirs = {}
for (const b of evBlocks) {
  const id = b.match(/evidence_id: '(E\d+)'/)?.[1]
  if (!id) continue
  const gaps = b.match(/gap_ids: \[([^\]]*)\]/)?.[1] ?? ''
  const dirs = b.match(/direction_ids: \[([^\]]*)\]/)?.[1] ?? ''
  evGaps[id] = [...gaps.matchAll(/'(G\d+)'/g)].map((m) => m[1])
  evDirs[id] = [...dirs.matchAll(/'(D\d+)'/g)].map((m) => m[1])
}

function audit(idPattern, evMap) {
  const src = read('gaps.ts')
  const blocks = src.split(/\n  \{\n/).slice(1)
  const problems = []
  for (const b of blocks) {
    const id = b.match(new RegExp(`${idPattern}: '(G\\d+|D\\d+)'`))?.[1]
    if (!id) continue
    const declared = [
      ...(b.match(/evidence_ids: \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'(E\d+)'/g),
    ].map((m) => m[1])
    const actual = Object.entries(evMap)
      .filter(([, arr]) => arr.includes(id))
      .map(([e]) => e)
    const missing = actual.filter((e) => !declared.includes(e))
    const extra = declared.filter((e) => !actual.includes(e))
    if (missing.length || extra.length) {
      problems.push({ id, declared: declared.length, actual: actual.length, missing, extra })
    }
  }
  return problems
}

const gapProblems = audit('gap_id', evGaps)
const dirProblems = audit('direction_id', evDirs)

console.log('=== Gap evidence_ids 不一致 ===')
gapProblems.forEach((p) =>
  console.log(
    `${p.id}: 声明 ${p.declared} / 实际引用 ${p.actual} | 缺 ${p.missing.join(',') || '无'} | 多 ${p.extra.join(',') || '无'}`,
  ),
)
console.log('\n=== Direction evidence_ids 不一致 ===')
dirProblems.forEach((p) =>
  console.log(
    `${p.id}: 声明 ${p.declared} / 实际引用 ${p.actual} | 缺 ${p.missing.join(',') || '无'} | 多 ${p.extra.join(',') || '无'}`,
  ),
)
console.log(`\ngap 问题数: ${gapProblems.length} | direction 问题数: ${dirProblems.length}`)
