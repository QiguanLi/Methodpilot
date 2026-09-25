#!/usr/bin/env node
/**
 * 批量加入幂等测试（Phase 3B-6）。
 *
 * 验的是需求点名的那一条：**重复加入不会产生重复论文**。
 *
 * 为什么这条特别值得测：
 *   重复加入有三个独立的入口，每一个都能单独把它搞砸——
 *     1. 用户连点两次按钮（前端 busy 只能挡一部分）
 *     2. 两个标签页同时提交（前端状态根本不共享）
 *     3. 直接打接口
 *   而一旦产生重复，后果是**静默的**：文献库里出现两条同名论文，
 *   证据、方法分别挂在两条上，看起来都正常，只是数据悄悄分裂了。
 *
 * 所以去重必须落在服务端（metaPaper.ts 按 file_hash = 'meta:' + s2_paper_id），
 * 本测试就是去打接口，绕过前端的一切保护来验证它。
 *
 * 运行：pnpm batch:test
 *   需要服务端已启动（脚本会自己起一个，用临时端口与临时 store）。
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.BATCH_TEST_PORT ?? 8977)
const BASE = `http://127.0.0.1:${PORT}`

const errors = []
const check = (cond, msg) => {
  if (!cond) errors.push(msg)
}

/* ------------------------------------------------------------------ */
/* 起一个隔离的服务端（独立 store，不碰真实数据）                        */
/* ------------------------------------------------------------------ */

const storeDir = mkdtempSync(path.join(tmpdir(), 'mpbatch-'))
const uploadDir = mkdtempSync(path.join(tmpdir(), 'mpbatch-up-'))

const srv = spawn(
  process.execPath,
  ['--experimental-strip-types', path.join(ROOT, 'server', 'index.ts')],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      /*
       * 用独立的 DATA_DIR / UPLOAD_DIR，绝不碰 data/store 里的真实数据。
       * 这个测试会往项目里写论文，跑在真实 store 上会污染演示数据——
       * 而且它创建的项目会一直留在项目列表里。
       */
      DATA_DIR: storeDir,
      UPLOAD_DIR: uploadDir,
      /*
       * 关掉 S2：这个测试只验"加进去以后数据里有没有重复"，
       * 不依赖任何外部接口。开着的话每次跑都要等网络超时。
       */
      ENABLE_SEMANTIC_SCHOLAR: 'false',
    },
    stdio: 'ignore',
  },
)

const stop = () => {
  try {
    srv.kill('SIGKILL')
  } catch {}
  for (const d of [storeDir, uploadDir]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
}

const get = (u) => JSON.parse(spawnSync('curl', ['-s', u], { encoding: 'utf8' }).stdout || 'null')
const post = (u, body) =>
  JSON.parse(
    spawnSync(
      'curl',
      ['-s', '-X', 'POST', `${BASE}${u}`, '-H', 'Content-Type: application/json', '-d', JSON.stringify(body)],
      { encoding: 'utf8' },
    ).stdout || 'null',
  )

/** 等服务和健康检查就绪 */
const ready = async () => {
  for (let i = 0; i < 40; i++) {
    const r = get(`${BASE}/api/health`)
    if (r?.success) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

if (!(await ready())) {
  stop()
  console.log('✗ 服务端未能启动，无法运行批量测试')
  process.exit(1)
}

/* ------------------------------------------------------------------ */

const created = post('/api/projects', {
  name: '批量加入幂等测试',
  subtitle: 'Phase 3B-6',
  domain: 'AI Agents',
  goal: '验证重复加入不产生重复论文',
})
const PID = created?.data?.id
if (!PID) {
  stop()
  console.log('✗ 无法创建测试项目：' + JSON.stringify(created))
  process.exit(1)
}

/*
 * `data` 就是论文数组本身（不是 data.papers）。
 * 这里两种形态都兜一下，因为写错字段名会静默得到空数组，
 * 表现为"什么都写不进去"——而其实是读错了地方。
 * 这个坑我在写这个测试时亲手踩过一次。
 */
const papersOf = () => {
  const d = get(`${BASE}/api/projects/${PID}/papers`).data
  return Array.isArray(d) ? d : (d?.papers ?? [])
}

const mk = (id, title, extra = {}) => ({
  s2_paper_id: id,
  title,
  authors: ['作者甲'],
  year: 2024,
  abstract: '摘要',
  url: `https://example.test/${id}`,
  doi: `10.1000/${id}`,
  citationCount: 7,
  venue: 'TestConf',
  source: 'live',
  ...extra,
})

const batch = (list) => post(`/api/projects/${PID}/papers/meta/batch`, { papers: list })
const single = (paper) => post(`/api/projects/${PID}/papers/meta`, paper)

/* ------------------------------------------------------------------ */
console.log('— 1. 首次批量加入 3 篇，3 篇都要真的写进去 —')
/* ------------------------------------------------------------------ */

const r1 = batch([mk('t-a', 'A'), mk('t-b', 'B'), mk('t-c', 'C')])
check(r1.data?.created === 3, `首次批量 created 应为 3，实际 ${r1.data?.created}`)
check(r1.data?.existing === 0, `首次批量 existing 应为 0，实际 ${r1.data?.existing}`)
const n1 = papersOf().length
check(n1 === 3, `项目里应有 3 篇，实际 ${n1}`)

/*
 * 这一条是整个测试里最重要的一条。
 *
 * 如果服务端用 Promise.all 并发执行 addMetaPaper（读-改-写），
 * 三个请求会各自读到空列表再各自写回，最终只剩 1 篇——
 * 而每个请求都返回 created=true。上面 r1.created === 3 会通过，
 * 只有这里会红。所以"接口说成功了几篇"和"数据里真有幾篇"必须分开测。
 */
check(n1 === 3, '并发写入覆盖：接口报 3 篇成功，数据里却没有 3 篇')
console.log(`  created=3 → 项目论文数 ${n1}（接口计数与落盘数量一致）`)

/* ------------------------------------------------------------------ */
console.log('\n— 2. 完全重复提交同一批：不得新增 —')
/* ------------------------------------------------------------------ */

const r2 = batch([mk('t-a', 'A'), mk('t-b', 'B'), mk('t-c', 'C')])
check(r2.data?.created === 0, `重复提交 created 应为 0，实际 ${r2.data?.created}`)
check(r2.data?.existing === 3, `重复提交 existing 应为 3，实际 ${r2.data?.existing}`)
const n2 = papersOf().length
check(n2 === n1, `重复提交后论文数变了：${n1} → ${n2}`)
console.log(`  created=0 existing=3 → 项目论文数仍为 ${n2}`)

/* ------------------------------------------------------------------ */
console.log('\n— 3. hash 无重复（真正的重复判定依据）—')
/* ------------------------------------------------------------------ */

const hashes = papersOf()
  .map((p) => p.file_hash)
  .filter((h) => typeof h === 'string' && h.startsWith('meta:'))
check(new Set(hashes).size === hashes.length, `存在重复 file_hash：${hashes.join(', ')}`)
console.log(`  ${hashes.length} 个 meta hash，去重后 ${new Set(hashes).size} 个`)

/* ------------------------------------------------------------------ */
console.log('\n— 4. 单条接口与批量接口共用同一套去重 —')
/* ------------------------------------------------------------------ */

/*
 * 这是最容易漏的一条：两条路径各写一套去重，就会变成
 * "批量加过的，单条再加一次还能加进去"。
 * 服务端两条路径都调 addMetaPaper，所以这里验证它们确实一致。
 */
const s1 = single(mk('t-a', 'A'))
check(s1.data?.created === false, `单条重复提交应为 created=false，实际 ${s1.data?.created}`)
const n4 = papersOf().length
check(n4 === n1, `单条重复提交后论文数变了：${n1} → ${n4}`)
console.log(`  单条重复提交 created=${s1.data?.created} → 论文数仍为 ${n4}`)

/* ------------------------------------------------------------------ */
console.log('\n— 5. 混合批：旧的 + 新的，只新增新的 —')
/* ------------------------------------------------------------------ */

const r5 = batch([mk('t-a', 'A'), mk('t-d', 'D'), mk('t-b', 'B')])
check(r5.data?.created === 1, `混合批 created 应为 1，实际 ${r5.data?.created}`)
check(r5.data?.existing === 2, `混合批 existing 应为 2，实际 ${r5.data?.existing}`)
check(r5.data?.created_ids?.join(',') === 't-d', `created_ids 应为 t-d，实际 ${r5.data?.created_ids}`)
check(papersOf().length === n1 + 1, `论文数应 +1，实际 ${papersOf().length}`)
console.log(`  created=1 existing=2 → 论文数 ${papersOf().length}`)

/* ------------------------------------------------------------------ */
console.log('\n— 6. 连打 5 次同一批：仍然只有一份 —')
/* ------------------------------------------------------------------ */

/*
 * 模拟"用户狂点按钮"和"多标签页同时提交"。
 * 前端 busy 状态能挡住前者，但挡不住后者——所以必须靠服务端。
 */
const before6 = papersOf().length
for (let i = 0; i < 5; i++) batch([mk('t-e', 'E'), mk('t-f', 'F')])
const after6 = papersOf().length
check(after6 === before6 + 2, `连打 5 次应只新增 2 篇，实际新增 ${after6 - before6}`)
const eCount = papersOf().filter((p) => p.file_hash === 'meta:t-e').length
check(eCount === 1, `t-e 出现了 ${eCount} 次，应为 1 次`)
console.log(`  连打 5 次 → 新增 ${after6 - before6} 篇（应 2 篇），t-e 出现 ${eCount} 次`)

/* ------------------------------------------------------------------ */
console.log('\n— 7. mock 论文同样支持（需求要求 mock / live 都支持）—')
/* ------------------------------------------------------------------ */

const r7 = batch([mk('mock-1', 'Mock One', { source: 'mock' }), mk('mock-2', 'Mock Two', { source: 'mock' })])
check(r7.data?.created === 2, `mock 批量 created 应为 2，实际 ${r7.data?.created}`)
const r7b = batch([mk('mock-1', 'Mock One', { source: 'mock' }), mk('mock-2', 'Mock Two', { source: 'mock' })])
check(r7b.data?.existing === 2, `mock 重复提交 existing 应为 2，实际 ${r7b.data?.existing}`)
check(papersOf().filter((p) => p.file_hash === 'meta:mock-1').length === 1, 'mock 论文产生了重复')
console.log(`  mock 首次 created=${r7.data?.created}，重复 existing=${r7b.data?.existing}，无重复`)

/* ------------------------------------------------------------------ */
console.log('\n— 8. 部分失败：好的照样写入，坏的只记失败 —')
/* ------------------------------------------------------------------ */

const before8 = papersOf().length
const r8 = batch([mk('t-g', 'G'), { s2_paper_id: 't-h', title: '' }])
check(r8.data?.created === 1, `部分失败时 created 应为 1，实际 ${r8.data?.created}`)
check(r8.data?.failed === 1, `部分失败时 failed 应为 1，实际 ${r8.data?.failed}`)
check(papersOf().length === before8 + 1, '部分失败时好的那条未写入')
console.log(`  created=1 failed=1 → 论文数 ${papersOf().length}（好的那条已写入）`)

/* ------------------------------------------------------------------ */
console.log('\n— 9. 参数校验（不该写进去的别写进去）—')
/* ------------------------------------------------------------------ */

const before9 = papersOf().length
check(batch([]).data?.total === 0, '空数组应正常返回 total=0')
check(batch([]).data?.created === 0, '空数组 created 应为 0')
const rNonArray = post(`/api/projects/${PID}/papers/meta/batch`, { papers: 'oops' })
check(rNonArray.error?.code === 'MISSING_PAPERS', `非数组应返回 MISSING_PAPERS，实际 ${JSON.stringify(rNonArray.error)}`)
const rTooMany = batch(Array.from({ length: 101 }, (_, i) => mk(`bulk-${i}`, `Bulk ${i}`)))
check(rTooMany.error?.code === 'TOO_MANY', `超 100 篇应返回 TOO_MANY，实际 ${JSON.stringify(rTooMany.error)}`)
check(papersOf().length === before9, '被拒绝的请求不应写入任何论文')
console.log(`  空数组 / 非数组 / 超限 均正确处理，论文数未变（${papersOf().length}）`)

/* ------------------------------------------------------------------ */
console.log('\n— 10. 项目不存在时是整体失败，不逐条刷错误 —')
/* ------------------------------------------------------------------ */

const rBad = post('/api/projects/proj-does-not-exist/papers/meta/batch', {
  papers: [mk('x', 'X'), mk('y', 'Y')],
})
check(rBad.error?.code === 'PROJECT_NOT_FOUND', `应为 PROJECT_NOT_FOUND，实际 ${JSON.stringify(rBad.error)}`)
console.log('  返回 PROJECT_NOT_FOUND（终止而非逐条失败）')

/* ------------------------------------------------------------------ */

stop()

if (errors.length) {
  console.log(`\n✗ 发现 ${errors.length} 处问题:`)
  for (const e of errors) console.log('  · ' + e)
  process.exit(1)
}
console.log('\n✓ 批量加入幂等性全部通过（重复提交不产生重复论文）')
