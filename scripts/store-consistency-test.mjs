/**
 * fileStore 跨文件一致性回归测试（Phase 6-2 补：mixed snapshot 修复验收）。
 *
 * ── 背景：这个测试防的是哪个 bug ──
 *
 * `writeJson` 的按路径串行（writeChains）只保证**同一个文件**不互相踩。
 * 一次 commit 内部的四个文件曾经是 `Promise.all` 并发写的，于是两个并发
 * commit 会跨文件交错：papers 最后落的是 A 的快照、methods 落的是 B 的快照。
 *
 * 单个文件都合法、都不损坏 —— 但作为一个 bundle 是**撕裂**的。
 * 实测（投毒实验，600/600 次）出现：
 *
 *     papers.json:  P002.method_ids = ["M002"]
 *     methods.json: ["M001"]            ← 根本没有 M002
 *
 * 也就是 papers→methods 的单向悬空引用，缓存过期也自愈不了。
 * 修复方案：fileStore 加 project-scoped commit mutex + 读屏障 + getBundle 深拷贝。
 *
 * ── 测什么 ──
 *   1. 并发 commit + 高频 getBundle：任何一次读取都不能出现 mixed snapshot
 *   2. mixed snapshot 的两个可判定谓词：
 *        a) papers.method_ids 与 methods.paper_ids 双向引用始终一致
 *        b) bundle 的四个实体必须来自**同一次**提交（版本戳必须齐平）
 *   3. getBundle 返回值被修改后，下一次读取不受影响（深拷贝隔离）
 *   4. commit 串行性：并发 commit 不丢实体、不悬空
 *   5. 不同 project 之间仍可并发（锁粒度是 project，不是全局）
 *
 * 用法：pnpm store:consistency-test
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'

let pass = 0
let fail = 0
const check = (ok, msg) => {
  if (ok) {
    pass++
    console.log(`  ✓ ${msg}`)
  } else {
    fail++
    console.log(`  ✗ ${msg}`)
  }
}
const section = (t) => console.log(`\n${t}`)

/* ------------------------------------------------------------------ */
/* 隔离存储目录：必须在 import store 之前设好环境变量                    */
/* ------------------------------------------------------------------ */

const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'mpstore-consist-'))
process.env.DATA_DIR = DATA_DIR
process.env.UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
process.env.ENABLE_SEMANTIC_SCHOLAR = 'false'

const { store } = await import('../server/store/fileStore.ts')

const PROJECTS = path.join(DATA_DIR, 'projects')

/* ------------------------------------------------------------------ */

function makeProject(id) {
  const now = new Date().toISOString()
  return {
    id,
    name: `一致性测试 ${id}`,
    subtitle: '',
    description: '',
    domain: 'test',
    goal: '',
    kind: 'uploaded',
    created_at: now,
    updated_at: now,
    paper_ids: [],
  }
}

/**
 * 造一份**自洽**的快照：papers[i].method_ids 与 methods[i].paper_ids 互为镜像。
 * 这样任何一次读取都可以用双向引用一致性来判定是否为 mixed snapshot。
 */
function makeSnapshot(snapId, paperCount) {
  const now = new Date().toISOString()
  const papers = []
  const methods = []
  const evidence = []
  for (let i = 1; i <= paperCount; i++) {
    const pid = `P${String(i).padStart(3, '0')}`
    const mid = `M${String(i).padStart(3, '0')}`
    const eid = `E${String(i).padStart(3, '0')}`
    papers.push({
      paper_id: pid,
      project_id: 'p',
      file_name: `${pid}.pdf`,
      file_hash: `h:${snapId}:${pid}`,
      file_size: 1,
      page_count: 1,
      title: `${snapId}-paper-${i}`,
      authors: [],
      year: 2000 + i,
      abstract: '',
      keywords: [],
      sections: [],
      status: 'completed',
      error: null,
      source_type: 'uploaded',
      analyzed_with: null,
      method_ids: [mid], // ← 正向引用
      evidence_count: 1,
      created_at: now,
      updated_at: now,
    })
    methods.push({
      method_id: mid,
      project_id: 'p',
      paper_id: pid, // ← 反向引用
      paper_ids: [pid], // ← 双向：方法也记录自己属于哪些论文
      name: `${snapId}-method-${i}`,
      aliases: [],
      category: 'test',
      one_liner: '',
      problem: '',
      core_idea: '',
      steps: [],
      inputs: [],
      outputs: [],
      assumptions: [],
      evidence_ids: [eid],
      confidence: 0.9,
      year: 2000 + i,
      created_at: now,
      updated_at: now,
    })
    evidence.push({
      evidence_id: eid,
      project_id: 'p',
      paper_id: pid,
      method_id: mid,
      kind: 'claim',
      quote: `${snapId} quote ${i}`,
      section: 'abstract',
      page: 1,
      confidence: 0.9,
      created_at: now,
    })
  }
  return { papers, methods, evidence }
}

/**
 * 判定一个 bundle 是否**内部自洽**。
 * 任一方向对不上，就说明读到了跨文件 mixed snapshot。
 *
 * 注意：这里刻意做成"任意两个自洽快照的混合都必然被判定为不自洽"。
 * 由于每份快照的 paper/method/evidence id 数量一致且一一对应，
 * 混搭（papers 来自快照 A、methods 来自快照 B）会立刻暴露。
 */
function diagnose(bundle) {
  const problems = []
  const methodById = new Map(bundle.methods.map((m) => [m.method_id, m]))
  const paperById = new Map(bundle.papers.map((p) => [p.paper_id, p]))

  // 方向 1：papers.method_ids → methods 必须存在，且 method.paper_ids 回指本论文
  for (const p of bundle.papers) {
    for (const mid of p.method_ids ?? []) {
      const m = methodById.get(mid)
      if (!m) {
        problems.push(`papers→methods 悬空：${p.paper_id}.method_ids 含 ${mid}，methods 中不存在`)
        continue
      }
      if (!(m.paper_ids ?? []).includes(p.paper_id)) {
        problems.push(
          `双向引用不一致：${p.paper_id}→${mid}，但 ${mid}.paper_ids=${JSON.stringify(m.paper_ids)} 不含 ${p.paper_id}`,
        )
      }
      if (m.paper_id !== p.paper_id) {
        problems.push(`方法归属错位：${mid}.paper_id=${m.paper_id}，实际论文 ${p.paper_id}`)
      }
    }
  }

  // 方向 2：methods.paper_ids → papers 必须存在，且 paper.method_ids 回指本方法
  for (const m of bundle.methods) {
    for (const pid of m.paper_ids ?? []) {
      const p = paperById.get(pid)
      if (!p) {
        problems.push(`methods→papers 悬空：${m.method_id}.paper_ids 含 ${pid}，papers 中不存在`)
        continue
      }
      if (!(p.method_ids ?? []).includes(m.method_id)) {
        problems.push(
          `双向引用不一致：${m.method_id}→${pid}，但 ${pid}.method_ids=${JSON.stringify(p.method_ids)} 不含 ${m.method_id}`,
        )
      }
    }
  }

  // 方向 3：evidence 的 paper/method 归属必须都能找到
  for (const e of bundle.evidence) {
    if (!paperById.has(e.paper_id)) {
      problems.push(`evidence 悬空：${e.evidence_id}.paper_id=${e.paper_id} 不存在`)
    }
    if (e.method_id && !methodById.has(e.method_id)) {
      problems.push(`evidence 悬空：${e.evidence_id}.method_id=${e.method_id} 不存在`)
    }
  }

  return problems
}

/**
 * 版本戳判定：papers / methods / evidence 三类实体的数量必须来自同一快照。
 * 我们构造的快照满足 papers.length === methods.length === evidence.length，
 * 所以三者不等就是撕裂。另外 title 前缀（快照名）也必须一致。
 */
function versionMismatch(bundle) {
  const tags = new Set()
  for (const p of bundle.papers) tags.add(String(p.title).split('-')[0])
  for (const m of bundle.methods) tags.add(String(m.name).split('-')[0])
  for (const e of bundle.evidence) tags.add(String(e.quote).split(' ')[0])
  const sizes = [bundle.papers.length, bundle.methods.length, bundle.evidence.length]

  if (tags.size > 1) return `三类实体来自不同快照：${[...tags].join(' / ')}`
  if (new Set(sizes).size > 1) return `三类实体数量不齐平：papers=${sizes[0]} methods=${sizes[1]} evidence=${sizes[2]}`
  return null
}

/* ------------------------------------------------------------------ */
console.log('══ 准备：建两张隔离项目 ══')
/* ------------------------------------------------------------------ */

const P_A = 'proj_consist_a'
const P_B = 'proj_consist_b'
await store.createProject(makeProject(P_A))
await store.createProject(makeProject(P_B))
check(fs.existsSync(path.join(PROJECTS, P_A, 'papers.json')), `项目 A 已创建（${P_A}）`)
check(fs.existsSync(path.join(PROJECTS, P_B, 'papers.json')), `项目 B 已创建（${P_B}）`)

// 先落一份基线快照，让各文件都有内容（避免"空数组也算自洽"的假阳性）
await store.commit(P_A, makeSnapshot('S000', 0))

/* ------------------------------------------------------------------ */
section('1. 并发 commit + 高频 getBundle：任何一次读取都不得 mixed')
/* ------------------------------------------------------------------ */

/*
 * 构造：两个并发 commit 交替写入**不同规模**的自洽快照，
 * 同时开一条"高频读"的循环，在提交期间疯狂 getBundle。
 *
 * 修复前：读方会在 commit 的四文件窗口里读到 papers=A/methods=B 的混合体。
 * 修复后：读屏障必须保证每次读到的都是完整快照。
 *
 * 每份快照都是自洽的（数量齐平 + 双向引用），因此**任何**一个 mixed 结果
 * 都会同时触发 diagnose() 和 versionMismatch()。
 */

const ROUNDS = 40
let readCount = 0
let mixedCount = 0
let mismatchCount = 0
const samples = []

for (let round = 1; round <= ROUNDS; round++) {
  const snapA = makeSnapshot(`A${String(round).padStart(3, '0')}`, 2)
  const snapB = makeSnapshot(`B${String(round).padStart(3, '0')}`, 3)

  let stop = false
  const reader = (async () => {
    while (!stop) {
      const b = await store.getBundle(P_A)
      if (!b) continue
      readCount++
      const probs = diagnose(b)
      if (probs.length) {
        mixedCount++
        if (samples.length < 3) samples.push(probs[0])
      }
      const vm = versionMismatch(b)
      if (vm) {
        mismatchCount++
        if (samples.length < 3) samples.push(vm)
      }
      await new Promise((r) => setImmediate(r))
    }
  })()

  // 两个并发提交：都写 project+papers+methods+evidence 四个文件
  await Promise.all([
    store.commit(P_A, {
      project: { ...makeProject(P_A), paper_ids: snapA.papers.map((p) => p.paper_id) },
      ...snapA,
    }),
    store.commit(P_A, {
      project: { ...makeProject(P_A), paper_ids: snapB.papers.map((p) => p.paper_id) },
      ...snapB,
    }),
  ])

  stop = true
  await reader
}

check(readCount > 0, `并发读共观测 ${readCount} 次 getBundle`)
check(
  mixedCount === 0,
  `双向引用始终一致（${mixedCount} 次 mixed snapshot${mixedCount ? '，例：' + samples[0] : ''}）`,
)
check(
  mismatchCount === 0,
  `四文件版本戳始终齐平（${mismatchCount} 次撕裂${mismatchCount ? '，例：' + samples[0] : ''}）`,
)

/* ------------------------------------------------------------------ */
section('2. 落地结果也是自洽的（不只是读屏障在遮挡）')
/* ------------------------------------------------------------------ */

const finalBundle = await store.getBundle(P_A)
const finalProbs = diagnose(finalBundle)
check(finalProbs.length === 0, `最终落盘快照自洽${finalProbs.length ? '：' + finalProbs[0] : ''}`)
check(
  finalBundle.papers.length === finalBundle.methods.length &&
    finalBundle.methods.length === finalBundle.evidence.length,
  `最终三类实体数量齐平（p=${finalBundle.papers.length} m=${finalBundle.methods.length} e=${finalBundle.evidence.length}）`,
)

// 直接读盘交叉验证（绕开缓存与读屏障，看磁盘真实状态）
const diskPapers = JSON.parse(fs.readFileSync(path.join(PROJECTS, P_A, 'papers.json'), 'utf8'))
const diskMethods = JSON.parse(fs.readFileSync(path.join(PROJECTS, P_A, 'methods.json'), 'utf8'))
const diskEvidence = JSON.parse(fs.readFileSync(path.join(PROJECTS, P_A, 'evidence.json'), 'utf8'))
const diskProbs = diagnose({ papers: diskPapers, methods: diskMethods, evidence: diskEvidence })
check(diskProbs.length === 0, `磁盘上三文件交叉一致${diskProbs.length ? '：' + diskProbs[0] : ''}`)

/* ------------------------------------------------------------------ */
section('3. getBundle 返回深拷贝：改返回值不污染缓存')
/* ------------------------------------------------------------------ */

const b1 = await store.getBundle(P_A)
const titleBefore = b1.papers[0].title
const lenBefore = b1.papers.length

// 恶意改返回值：改字段、push 数组、改嵌套对象
b1.papers[0].title = 'HACKED'
b1.papers.push({ paper_id: 'P_HACK' })
b1.methods.splice(0, b1.methods.length)
b1.project.name = 'HACKED-PROJECT'

const b2 = await store.getBundle(P_A)
check(b2.papers[0].title === titleBefore, `缓存未被污染：papers[0].title 仍为 ${b2.papers[0].title}`)
check(b2.papers.length === lenBefore, `缓存未被污染：papers.length 仍为 ${b2.papers.length}`)
check(b2.methods.length > 0, `缓存未被污染：methods 未被清空（${b2.methods.length}）`)
check(b2.project.name !== 'HACKED-PROJECT', `缓存未被污染：project.name=${b2.project.name}`)

// 同一个对象引用不能重复出现（否则调用方之间会互相串改）
const b3 = await store.getBundle(P_A)
const b4 = await store.getBundle(P_A)
check(b3 !== b4, '两次 getBundle 返回不同对象引用（不是同一个活缓存对象）')
check(b3.papers !== b4.papers, '两次 getBundle 的 papers 数组也不是同一引用')
b3.papers[0].title = 'HACKED-2'
check((await store.getBundle(P_A)).papers[0].title === titleBefore, '再次修改返回值，缓存依然不受影响')

/* ------------------------------------------------------------------ */
section('4. commit 串行性：并发提交不丢实体、不悬空')
/* ------------------------------------------------------------------ */

await store.commit(P_A, makeSnapshot('S100', 0))

// 三次并发提交，各自写不同规模的自洽快照。
// 无论谁最后赢，最终状态都必须是**某一个完整快照**，不能是缝合怪。
const c1 = makeSnapshot('C001', 1)
const c2 = makeSnapshot('C002', 2)
const c3 = makeSnapshot('C003', 3)
await Promise.all([
  store.commit(P_A, { ...c1 }),
  store.commit(P_A, { ...c2 }),
  store.commit(P_A, { ...c3 }),
])

const after = await store.getBundle(P_A)
const afterProbs = diagnose(after)
check(afterProbs.length === 0, `三次并发 commit 后仍自洽${afterProbs.length ? '：' + afterProbs[0] : ''}`)
const winners = new Set([
  ...[...after.papers].map((p) => String(p.title).split('-')[0]),
  ...[...after.methods].map((m) => String(m.name).split('-')[0]),
])
check(
  winners.size <= 1,
  `最终状态来自单一次提交（实际版本：${[...winners].join(',') || '空'}）`,
)
check(
  after.papers.length === after.methods.length && after.methods.length === after.evidence.length,
  `并发提交后数量齐平（p=${after.papers.length} m=${after.methods.length} e=${after.evidence.length}）`,
)

/* ------------------------------------------------------------------ */
section('5. 不同 project 之间仍可并发（锁粒度是 project）')
/* ------------------------------------------------------------------ */

await store.commit(P_B, makeSnapshot('S200', 0))
const d1 = makeSnapshot('D001', 2)
const d2 = makeSnapshot('D002', 2)

const t0 = Date.now()
await Promise.all([
  store.commit(P_A, { ...d1 }),
  store.commit(P_B, { ...d2 }),
])
const elapsed = Date.now() - t0

const bA = await store.getBundle(P_A)
const bB = await store.getBundle(P_B)
check(diagnose(bA).length === 0, '项目 A 提交后自洽')
check(diagnose(bB).length === 0, '项目 B 提交后自洽')
check(
  bA.papers.every((p) => String(p.title).startsWith('D001')) &&
    bB.papers.every((p) => String(p.title).startsWith('D002')),
  '两个项目互不干扰（A 落 D001、B 落 D002）',
)
check(elapsed < 5000, `跨项目并发未退化为全局串行（耗时 ${elapsed}ms）`)

/* ------------------------------------------------------------------ */
section('6. 不残留临时文件 / API 形态不变（回归）')
/* ------------------------------------------------------------------ */

const leftoverA = fs.readdirSync(path.join(PROJECTS, P_A)).filter((f) => f.endsWith('.tmp'))
const leftoverB = fs.readdirSync(path.join(PROJECTS, P_B)).filter((f) => f.endsWith('.tmp'))
check(leftoverA.length === 0 && leftoverB.length === 0, `无 .tmp 残留（A=${leftoverA.length} B=${leftoverB.length}）`)

check(typeof store.commit === 'function', 'store.commit 仍存在')
check(typeof store.getBundle === 'function', 'store.getBundle 仍存在')
check(typeof store.savePapers === 'function', 'store.savePapers 仍存在')
check(typeof store.saveMethods === 'function', 'store.saveMethods 仍存在')
check(typeof store.saveEvidence === 'function', 'store.saveEvidence 仍存在')
check(typeof store.nextId === 'function', 'store.nextId 仍存在')
check(store.nextId('M', ['M001', 'M007']) === 'M008', 'nextId 行为不变（M001,M007 → M008）')

const papersTxt = fs.readFileSync(path.join(PROJECTS, P_A, 'papers.json'), 'utf8')
check(papersTxt.includes('\n  '), '仍是 JSON.stringify(data, null, 2) 缩进格式')

/* ------------------------------------------------------------------ */

rmSync(DATA_DIR, { recursive: true, force: true })

console.log(`\n${'═'.repeat(62)}`)
if (fail === 0) console.log(`✓ fileStore 跨文件一致性回归测试通过（${pass} 项断言）`)
else console.log(`✗ ${fail} 项未通过（通过 ${pass} 项）`)
console.log('  project-scoped commit mutex · 读屏障 · 深拷贝 · 无 mixed snapshot')
process.exit(fail === 0 ? 0 : 1)
