#!/usr/bin/env node
/**
 * 引用关系路径编码测试（Phase 3B-5）。
 *
 * 验的是本阶段**唯一会静默出错**的地方：S2 的论文 id 里带 `:` 和 `/`
 * （`DOI:10.1145/3290605.3300233`、`ARXIV:2210.03629`），
 * 直接拼进 URL 会被服务端路由当成多个路径段。
 *
 * 为什么这个错值得单独测：
 *   服务端路由（server/utils/http.ts matchPath）按 `/` 切分，
 *   并且要求**段数相等**才匹配。DOI 里那个 `/` 不编码就会多切出一段，
 *   于是路由匹配失败 → 404。整个过程**不抛异常、不打日志**，
 *   页面上只是空白。用户会以为"这篇论文没有引用关系"，
 *   而真相是路径拼错了 —— 一个假结论。
 *
 * 实测确认（规划阶段用 curl 做过）：
 *   /api/s2/paper/DOI:10.1145/3290605.3300233/references      → 404
 *   /api/s2/paper/DOI%3A10.1145%2F3290605.3300233/references  → 200
 *
 * 运行：pnpm citation:test
 *
 * 实现说明：这里**直接 import 服务端的 matchPath**，
 * 用真实的匹配函数来验证，而不是复刻一份逻辑。
 * 复刻的测试只能证明"我抄对了"，证明不了"服务端是对的"。
 */

import { matchPath } from '../server/utils/http.ts'
import { computeRelevance } from '../server/services/relevance.ts'

/* ------------------------------------------------------------------ */

const errors = []
const check = (cond, msg) => {
  if (!cond) errors.push(msg)
}

/* ------------------------------------------------------------------ */
console.log('— 1. 客户端拼路径：必须编码 —')
/* ------------------------------------------------------------------ */

/** 与 src/services/api.ts 里的拼法**逐字一致** */
const clientPath = (paperId) => `/api/s2/paper/${encodeURIComponent(paperId)}/references`

const CASES = [
  ['DOI 含斜杠', 'DOI:10.1145/3290605.3300233'],
  ['ARXIV 含冒号', 'ARXIV:2210.03629'],
  ['纯 sha', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'],
  ['CorpusId 形态', 'CorpusId:12345678'],
  ['含空格（脏数据）', 'some paper id'],
  ['含 + 号', 'DOI:10.1000/a+b'],
  ['含 % 号', 'DOI:10.1000/100%'],
  ['含 ? 号', 'weird?id'],
  ['含 # 号', 'weird#id'],
  ['中文 id（极端情况）', '论文:123'],
]

for (const [label, id] of CASES) {
  const path = clientPath(id)
  const m = matchPath('/api/s2/paper/:paperId/references', path)
  check(Boolean(m), `路由未匹配（path 被切错段）：${label} -> ${path}`)
  check(
    m?.params.paperId === id,
    `${label} 解码后不一致：期望 "${id}"，得到 "${m?.params.paperId}"`,
  )
  console.log(`  ✓ ${label.padEnd(16)} ${path.replace('/api/s2/paper/', '')}`)
}

/* ------------------------------------------------------------------ */
console.log('\n— 2. 反例：不编码必须失败（证明编码是必需的，而非多此一举）—')
/* ------------------------------------------------------------------ */

/*
 * 这一组是**反向验证**。如果哪天有人觉得 encodeURIComponent 多余而删掉它，
 * 只有靠这组断言才能发现。只测正向的话，删掉编码函数可能仍然"看起来正常"
 * （因为纯 sha 不需要编码）。
 */
const unencodedDoi = '/api/s2/paper/DOI:10.1145/3290605.3300233/references'
check(
  matchPath('/api/s2/paper/:paperId/references', unencodedDoi) === null,
  `未编码的 DOI 竟然匹配成功了 —— 说明服务端路由行为变了，需要重新评估`,
)
console.log('  ✓ 未编码 DOI 正确失败（段数不符），编码确有必要')

/* 纯 sha 不编码也能过 —— 所以这个 bug 只在 DOI/ARXIV 形态下暴露 */
const unencodedSha = '/api/s2/paper/a1b2c3d4e5f6/references'
check(
  matchPath('/api/s2/paper/:paperId/references', unencodedSha) !== null,
  '纯 sha 未编码竟然匹配失败，路由行为异常',
)
console.log('  ✓ 纯 sha 不编码也能过 —— 正是这类 bug 只在校验 DOI 时才暴露')

/* ------------------------------------------------------------------ */
console.log('\n— 3. 两个方向的路由都要能匹配 —')
/* ------------------------------------------------------------------ */

for (const kind of ['references', 'citations']) {
  const path = `/api/s2/paper/${encodeURIComponent('DOI:10.1145/3290605.3300233')}/${kind}`
  const m = matchPath(`/api/s2/paper/:paperId/${kind}`, path)
  check(Boolean(m), `${kind} 路由未匹配`)
  check(m?.params.paperId === 'DOI:10.1145/3290605.3300233', `${kind} 解码后 paperId 不符`)
  console.log(`  ✓ ${kind.padEnd(11)} 匹配成功`)
}

/* ------------------------------------------------------------------ */
console.log('\n— 4. 回归：相关性排序未被本阶段改动 —')
/* ------------------------------------------------------------------ */

/*
 * 需求明确要求"不改现有搜索、自然语言解析、相关性排序"。
 * 这里放一条最基础的探针：若有人误改了 relevance.ts 的核心口径，
 * 这条会红。完整的验证在 pnpm relevance:test 里。
 */
const probe = computeRelevance(
  { title: 'Tool Use in Software Engineering Agents', abstract: '' },
  ['Tool Use'],
)
check(probe.percent === 100, `相关性打分口径变了：期望 100，得到 ${probe.percent}`)
check(
  computeRelevance({ title: 'explanation of quality', abstract: '' }, ['plan']).percent === 0,
  '相关性打分的子串假阳性守卫失效',
)
console.log(`  ✓ 相关性打分仍为 100%（单 token 全命中），假阳性守卫仍在`)

/* ------------------------------------------------------------------ */

if (errors.length) {
  console.log(`\n✗ 发现 ${errors.length} 处问题:`)
  for (const e of errors) console.log('  · ' + e)
  process.exit(1)
}
console.log('\n✓ 引用关系路径编码全部正确（含 DOI/ARXIV 特殊字符）')
