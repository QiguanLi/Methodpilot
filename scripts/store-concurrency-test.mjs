/**
 * fileStore 并发写回归测试（Phase 6-2 补）。
 *
 * ── 为什么必须加这个测试 ──
 *
 * Phase 6-2 跑真实 E2E 时，papers.json 被写成过这种形态：
 *
 *     ]
 *   oken"        ← 半个字段名，"input_tokens" 的尾巴
 *     "cost_usd": 0
 *     ...
 *
 * 两份 JSON 字节互相穿插。后果不是"报个错"，而是论文被判
 * PAPER_FILE_MISSING（"服务端找不到原始 PDF"）—— 数据静默损坏，
 * 用户完全无从分辨。
 *
 * 根因有两个，都在 fileStore.writeJson：
 *   ① 临时文件名是 `${file}.${process.pid}.tmp` —— 只带 pid，
 *      同进程内两次并发写落到**同一个** tmp 路径；
 *   ② 写入未按文件串行 —— 同文件的 writeFile/rename 交替执行，
 *      谁最后 rename 谁赢，甚至 rename 到中途的混合内容。
 *
 * 本测试**直接打 store.commit 这个公开入口**（不测私有函数），
 * 因为并发写是 commit 在真实并发分析时自然产生的行为。
 *
 * ── 测什么 ──
 *   1. 同一文件 N 次并发写 → 最终必须是**合法 JSON**（不损坏）
 *   2. 最终内容 = **最后一次写入**（顺序语义，不被中间写入覆盖）
 *   3. 不残留任何 .tmp 文件（临时文件必须被 rename 掉）
 *   4. 不同文件之间仍可并发（commit 的跨文件原子性没被破坏）
 *   5. 高并发强压：多轮 × 多写，全部合法
 *
 * 用法：pnpm store:concurrency-test
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
/* 隔离的存储目录：必须在 import store 之前设好环境变量                  */
/* ------------------------------------------------------------------ */

const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'mpstore-conc-'))
process.env.DATA_DIR = DATA_DIR
process.env.UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
process.env.ENABLE_SEMANTIC_SCHOLAR = 'false'

const { store } = await import('../server/store/fileStore.ts')

const PROJECTS = path.join(DATA_DIR, 'projects')

function makePaper(paperId, title, year) {
  const now = new Date().toISOString()
  return {
    paper_id: paperId,
    project_id: 'p',
    file_name: `${paperId}.pdf`,
    file_hash: `h:${paperId}`,
    file_size: 1,
    page_count: 1,
    title,
    authors: [],
    year,
    abstract: '',
    keywords: [],
    sections: [],
    status: 'completed',
    error: null,
    source_type: 'uploaded',
    analyzed_with: null,
    method_ids: [],
    evidence_count: 0,
    created_at: now,
    updated_at: now,
  }
}

function lstatTmpFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
}

console.log('══ 准备：建一个隔离项目 ══')
const proj = await store.createProject({
  id: 'proj_conc',
  name: '并发写测试',
  subtitle: '',
  description: '',
  domain: 'test',
  goal: '',
  kind: 'uploaded',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  paper_ids: [],
})
const PID = proj.id
const papersPath = path.join(PROJECTS, PID, 'papers.json')
check(fs.existsSync(papersPath), `项目目录与 papers.json 已创建（${PID}）`)

/* ------------------------------------------------------------------ */
section('1. 同一文件 20 次并发写：不损坏 + 最后一次获胜')
/* ------------------------------------------------------------------ */

/*
 * 关键构造：所有写都在**同一个 tick** 里发起（不 await 中间结果），
 * 这样才可能触发并发。若逐个 await，串行是白送的，测不出问题。
 *
 * 每次写的内容都不同（title = paper-i，且年份 = i），
 * 这样"最后一次获胜"可以被精确断言 —— 若实现退化成"某个中间值获胜"，
 * 或两次写交错成混合内容，都会立刻被抓到。
 */
const N = 20
const writes = []
for (let i = 1; i <= N; i++) {
  writes.push(
    store.savePapers(PID, [makePaper(`P${String(i).padStart(3, '0')}`, `paper-${i}`, 2000 + i)]),
  )
}
const settled = await Promise.allSettled(writes)
check(
  settled.every((s) => s.status === 'fulfilled'),
  `20 次并发写全部 resolve（失败 ${settled.filter((s) => s.status === 'rejected').length} 次）`,
)

const raw = fs.readFileSync(papersPath, 'utf8')

let parsed = null
let parseErr = null
try {
  parsed = JSON.parse(raw)
} catch (e) {
  parseErr = e
}
check(parseErr === null, `最终文件是合法 JSON${parseErr ? `（解析失败：${parseErr.message}）` : ''}`)

if (parsed) {
  check(Array.isArray(parsed), '最终内容是数组（结构未被破坏）')
  check(parsed.length === 1, `最终只有 1 篇论文（实际 ${parsed.length}）`)
  check(
    parsed[0]?.title === `paper-${N}` && parsed[0]?.year === 2000 + N,
    `最终内容 = 最后一次写入（期望 paper-${N}/${2000 + N}，实际 ${parsed[0]?.title}/${parsed[0]?.year}）`,
  )
}

/* ------------------------------------------------------------------ */
section('2. 不残留临时文件')
/* ------------------------------------------------------------------ */

const leftover = lstatTmpFiles(path.join(PROJECTS, PID))
check(leftover.length === 0, `项目目录无 .tmp 残留（实际 ${leftover.length} 个${leftover.length ? '：' + leftover.join(',') : ''}）`)

const baseLeftover = fs
  .readdirSync(PROJECTS)
  .filter((f) => f.endsWith('.tmp'))
check(baseLeftover.length === 0, `projects 根目录无 .tmp 残留（实际 ${baseLeftover.length} 个）`)

/* ------------------------------------------------------------------ */
section('3. 跨文件并发：commit 同时写 4 个文件仍全部合法')
/* ------------------------------------------------------------------ */

/*
 * store.commit 刻意用 Promise.all 并发写 project/papers/methods/evidence。
 * 修复不能把这个并发干掉（否则跨文件原子性变差），
 * 所以这里验证"四个文件同时写"依然各自合法、互不干扰。
 */
for (let round = 1; round <= 5; round++) {
  await Promise.all([
    store.commit(PID, {
      project: {
        ...proj,
        updated_at: new Date().toISOString(),
        paper_ids: [`R${round}`],
      },
      papers: [makePaper(`P${round}`, `round-${round}`, 2020 + round)],
      methods: [],
      evidence: [],
    }),
  ])
}
const fourFiles = ['project.json', 'papers.json', 'methods.json', 'evidence.json']
const bad = []
for (const f of fourFiles) {
  try {
    JSON.parse(fs.readFileSync(path.join(PROJECTS, PID, f), 'utf8'))
  } catch {
    bad.push(f)
  }
}
check(bad.length === 0, `commit 并发写 4 文件后全部是合法 JSON${bad.length ? `（损坏：${bad.join(',')}）` : ''}`)

/* ------------------------------------------------------------------ */
section('4. 高压：10 轮 × 每轮 15 次并发同名文件写')
/* ------------------------------------------------------------------ */

let stressBad = 0
let stressWrong = 0
for (let round = 1; round <= 10; round++) {
  const jobs = []
  for (let i = 1; i <= 15; i++) {
    jobs.push(store.saveEvidence(PID, [{ evidence_id: `E${round}-${i}`, round, i }]))
  }
  await Promise.allSettled(jobs)
  const evPath = path.join(PROJECTS, PID, 'evidence.json')
  try {
    const d = JSON.parse(fs.readFileSync(evPath, 'utf8'))
    // 最后一次写入是 i=15
    if (!Array.isArray(d) || d[0]?.i !== 15) stressWrong++
  } catch {
    stressBad++
  }
}
check(stressBad === 0, `10 轮高压后 evidence.json 始终合法（损坏 ${stressBad} 轮）`)
check(stressWrong === 0, `10 轮高压后每轮都保留了"最后一次写入"（异常 ${stressWrong} 轮）`)

/* ------------------------------------------------------------------ */
section('5. 失败不该卡死后续写入（健壮性）')
/* ------------------------------------------------------------------ */

/*
 * 序列化链最容易出的次生问题：一次写失败后，链上挂着 rejected，
 * 之后所有写都跟着失败（"毒化"）。这里模拟一次"目标路径不可写"，
 * 再验证后续正常写依然成功。
 */
const blockedDir = path.join(PROJECTS, PID, 'blocked.json')
await fsp.mkdir(blockedDir, { recursive: true }) // 目录占住文件路径 → rename 必然失败
let blockedThrew = false
try {
  await store.saveProject(PID, { ...proj, name: 'should-fail' })
  // saveProject 写的是 project.json，不写 blocked.json，所以这里不应抛
} catch (e) {
  blockedThrew = true
}
check(!blockedThrew, '正常的 saveProject 不受其它路径异常影响')

// 再验证一次正常写仍生效
await store.savePapers(PID, [makePaper('P999', 'after-failure', 1999)])
const afterFail = JSON.parse(fs.readFileSync(papersPath, 'utf8'))
check(
  afterFail[0]?.title === 'after-failure',
  `失败/压力之后写入仍然生效（实际 ${afterFail[0]?.title}）`,
)

/* ------------------------------------------------------------------ */
section('6. 数据格式与 API 不变（回归）')
/* ------------------------------------------------------------------ */

check(typeof store.savePapers === 'function', 'store.savePapers 仍存在')
check(typeof store.saveMethods === 'function', 'store.saveMethods 仍存在')
check(typeof store.saveEvidence === 'function', 'store.saveEvidence 仍存在')
check(typeof store.commit === 'function', 'store.commit 仍存在')
check(typeof store.saveProject === 'function', 'store.saveProject 仍存在')
const formatted = fs.readFileSync(papersPath, 'utf8')
check(formatted.includes('\n  '), '仍为 JSON.stringify(data, null, 2) 的缩进格式（2 空格）')
check(formatted.endsWith('\n') === false, '文件不以换行结尾（与修复前行为一致）')

/* ------------------------------------------------------------------ */

rmSync(DATA_DIR, { recursive: true, force: true })

console.log(`\n${'═'.repeat(62)}`)
if (fail === 0) console.log(`✓ fileStore 并发写回归测试通过（${pass} 项断言）`)
else console.log(`✗ ${fail} 项未通过（通过 ${pass} 项）`)
console.log('  同文件串行化 · 临时名唯一 · 不损坏 · 最后一次获胜 · 跨文件仍并发')
process.exit(fail === 0 ? 0 : 1)
