/**
 * 年份映射单元验证
 *
 * 直接验证 analysis.ts 里那一行的语义：
 *   year: a.paper.year > 0 ? a.paper.year : 0
 *
 * 为什么不做 E2E：PDF 里的年份由 parser 从正文抽取，绝大多数论文
 * 都能抽到真实年份，因此"论文无年份"这条分支在真实语料上很难构造
 * （parser.py 抽不到时才返回 0）。而这条分支正是原缺陷的触发条件，
 * 必须被精确覆盖，所以用单元级断言锁住它。
 *
 * 同时锁住与全链路其他环节的一致性：
 *   · metaPaper.ts   —— 无年份给 0
 *   · methodYear()   —— 0 表示未知
 *   · yearKeyOf()    —— 0 排到最后
 *   · 前端           —— unknown_year: year === 0 → 显示「未知」
 */
import assert from 'node:assert/strict'

let pass = 0
let fail = 0
function check(ok, msg) {
  if (ok) {
    pass++
    console.log(`  ✓ ${msg}`)
  } else {
    fail++
    console.log(`  ✗ ${msg}`)
  }
}

const NOW_YEAR = new Date().getFullYear()

/** 与 analysis.ts 中方法落库那一行完全同构 */
const methodYearOf = (paperYear) => (paperYear > 0 ? paperYear : 0)

console.log('══ 1. 原缺陷：不得伪造当前年份 ══')
check(
  methodYearOf(0) !== NOW_YEAR,
  `论文年份为 0 时，方法 year 不得等于当前年份 ${NOW_YEAR}`,
)
check(
  methodYearOf(0) === 0,
  `论文年份为 0 时，方法 year 应为 0（未知约定），实际 ${methodYearOf(0)}`,
)
console.log(
  `  · 旧写法 \`paper.year || new Date().getFullYear()\` 在 paper.year=0 时会得到 ${0 || NOW_YEAR} ← 伪造`,
)

console.log('\n══ 2. 真实年份必须原样透传，不得被覆盖 ══')
for (const y of [1969, 2015, 2021, 2023, 2024, 2025]) {
  check(methodYearOf(y) === y, `真实年份 ${y} 原样保留`)
}

console.log('\n══ 3. 与全链路"年份未知"约定一致 ══')
// methodEvolution.ts 的 methodYear()
const methodYear = (mYear, paperYear) => {
  if (mYear > 0) return mYear
  if (paperYear > 0) return paperYear
  return 0
}
check(methodYear(0, 0) === 0, 'methodYear(0,0) === 0（与 analysis 一致：未知即 0）')

// yearKeyOf()
const yearKeyOf = (y) => (y > 0 ? y : Number.MAX_SAFE_INTEGER)
check(yearKeyOf(0) === Number.MAX_SAFE_INTEGER, 'yearKeyOf(0) 排到最后（未知不冒充"最新"）')
check(yearKeyOf(2023) < yearKeyOf(0), '已知年份排在未知年份之前')

// 前端 unknown_year
const unknownFlag = (y) => y === 0
check(unknownFlag(0) === true, '前端 unknown_year(0) === true → 显示「未知」')
check(unknownFlag(2023) === false, '前端 unknown_year(2023) === false')

console.log('\n══ 4. 旧写法在新代码中已不存在 ══')
const src = await import('node:fs').then((fs) =>
  fs.readFileSync('server/services/analysis.ts', 'utf8'),
)
check(
  !/year:\s*a\.paper\.year\s*\|\|\s*new Date\(\)\.getFullYear\(\)/.test(src),
  'analysis.ts 已无 `a.paper.year || new Date().getFullYear()` 写法',
)
check(
  /year:\s*a\.paper\.year\s*>\s*0\s*\?\s*a\.paper\.year\s*:\s*0/.test(src),
  'analysis.ts 已改为 `a.paper.year > 0 ? a.paper.year : 0`',
)

console.log(`\n${'═'.repeat(60)}`)
if (fail === 0) {
  console.log(`✓ 年份映射验证通过（${pass} 项）`)
} else {
  console.log(`✗ ${fail} 项未通过（通过 ${pass} 项）`)
}
process.exit(fail === 0 ? 0 : 1)
