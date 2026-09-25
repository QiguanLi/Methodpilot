#!/usr/bin/env node
/**
 * Demo 知识库全量回放（Phase 4-2 验证脚本）。
 *
 * ── 为什么这是一个**文件**而不是 `node -e "..."` ──
 *
 * 这个脚本的前身是命令行里的一行 `node -e "..."`，其中有一句
 * `c.relation_type.padEnd(9)`。它反复报 `Bad substitution`。
 *
 * 根因不在 JS，而在 **shell**：
 *   脚本用双引号包裹传给 `node -e`，内部又用了模板字符串 `${...}`。
 *   当 `${c.relation_type.padEnd(9)}` 未被正确转义时，zsh 会抢在 node 之前
 *   把它当成**参数替换**去解析（`${var.op(args)}` 在 zsh 里是非法语法），
 *   于是直接抛 `zsh: bad substitution` —— node 根本没机会启动。
 *   实测：`zsh -c 'echo ${t.padEnd(9)}'` → `zsh:1: bad substitution`
 *
 * 教训：**任何含 `${}` / 反引号 / `!` 的 JS 代码都不该塞进 shell 字符串。**
 * 插值交给 JS 自己做，shell 只负责启动进程。
 * 把它固化成文件后，这类转义问题从根上消失，也不再依赖调用者的引号习惯。
 *
 * 本脚本**只读**，不写任何文件、不改任何数据。
 * 业务逻辑一行没动 —— 它只调用 alignMethods() 并打印结果。
 *
 * 运行：node --experimental-strip-types scripts/method-align-replay-demo.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { alignMethods } from '../server/services/methodAlignment.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DEMO = path.join(ROOT, 'src', 'data')
const LIVE = path.join(ROOT, 'data', 'store', 'projects')

/* ------------------------------------------------------------------ */
/* 极简 TS 字面量读取器                                                */
/* ------------------------------------------------------------------ */

/*
 * Demo 数据是 .ts 文件（前端构建用），含 `@/` 路径别名和 TS 类型标注，
 * 服务端 Node 无法直接 import。这里用一个**只认数据、不执行代码**的
 * 最小解析器把方法数组读出来。
 *
 * 为什么不用正则硬切：正则版本已经错过一次（字段偏移导致 method_id 与
 * name 串位）。这里改成按 `{ ... }` 配对扫描，结构稳得多。
 * 它只处理本仓库这种规整的字面量，不追求通用。
 */
function extractArrayLiteral(src, exportName) {
  const key = `export const ${exportName}`
  const at = src.indexOf(key)
  if (at < 0) return null

  /*
   * ⚠️ 不能直接 indexOf('[', at)。
   *
   * 声明是 `export const methods: Method[] = [ ... ]`，
   * 类型标注 `Method[]` 里就有一个 `[` —— 从它开始扫描会在
   * 紧接着的 `]` 上就把 depth 归零，返回一个空的 `"[]"`。
   * 这个 bug 的症状是"解析成功但 0 条数据"，测试还会因为空输入而"通过"，
   * 比直接报错危险得多。
   *
   * 正确做法：先定位赋值号 `=`，再从它后面找第一个 `[`。
   * 用 `=` 之后的位置还顺带避开了 `Method[]` 这类类型标注。
   */
  const eq = src.indexOf('=', at)
  if (eq < 0) return null
  const start = src.indexOf('[', eq)
  if (start < 0) return null

  let depth = 0
  let inStr = null
  let esc = false
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === inStr) inStr = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue }
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

/** 从对象字面量文本里取一个字符串/数字字段 */
function field(block, name) {
  const re = new RegExp(`(?:^|[\\s{,])${name}\\s*:\\s*('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*"|-?\\d+)`)
  const m = re.exec(block)
  if (!m) return ''
  const raw = m[1]
  if (raw.startsWith("'") || raw.startsWith('"')) {
    return raw
      .slice(1, -1)
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
  }
  return Number(raw)
}

/** 取一个字符串数组字段，如 paper_ids: ['P001','P012'] */
function strArray(block, name) {
  const re = new RegExp(`(?:^|[\\s{,])${name}\\s*:\\s*\\[([^\\]]*)\\]`)
  const m = re.exec(block)
  if (!m) return []
  const out = []
  const itemRe = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g
  let x
  while ((x = itemRe.exec(m[1])) !== null) out.push(x[1] ?? x[2])
  return out
}

/** 把 `[{...},{...}]` 切成若干对象文本 */
function splitObjects(arrayText) {
  const body = arrayText.slice(1, -1)
  const out = []
  let depth = 0
  let inStr = null
  let esc = false
  let cur = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (inStr) {
      cur += ch
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === inStr) inStr = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; cur += ch; continue }
    if (ch === '{') { depth++; cur += ch; continue }
    if (ch === '}') {
      depth--
      cur += ch
      if (depth === 0) { out.push(cur); cur = '' }
      continue
    }
    if (depth > 0) cur += ch
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 读数据                                                              */
/* ------------------------------------------------------------------ */

function loadDemo() {
  const methodsSrc = fs.readFileSync(path.join(DEMO, 'methods.ts'), 'utf8')
  const arr = extractArrayLiteral(methodsSrc, 'methods')
  if (!arr) throw new Error('无法从 src/data/methods.ts 提取 methods 数组')

  const methods = splitObjects(arr).map((b) => ({
    method_id: String(field(b, 'method_id')),
    project_id: 'demo',
    name: String(field(b, 'name')),
    name_zh: String(field(b, 'name_zh')),
    family_id: String(field(b, 'family_id')),
    task: String(field(b, 'task')),
    paradigm: String(field(b, 'paradigm')),
    year: Number(field(b, 'year')) || 0,
    core_idea: String(field(b, 'core_idea')),
    modules: strArray(b, 'modules'),
    inputs: [],
    outputs: [],
    capabilities: [],
    advantages: [],
    limitations: [],
    paper_ids: strArray(b, 'paper_ids'),
    evidence_ids: strArray(b, 'evidence_ids'),
    layer: 0,
    source_type: 'demo',
    classification: null,
  }))

  /* 论文：只需要 paper_id 存在性，用于"归属校验" */
  const paperIds = new Set()
  for (const m of methods) for (const p of m.paper_ids) paperIds.add(p)
  const papers = [...paperIds].map((id) => ({
    paper_id: id, project_id: 'demo', title: id, authors: [], year: 0,
    abstract: '', keywords: [], sections: [], file_name: '', file_hash: '',
    file_size: 0, page_count: 0, status: 'completed', error: null,
    source_type: 'demo', analyzed_with: null, method_ids: [], evidence_count: 0,
    created_at: '', updated_at: '',
  }))

  /* 证据：从 evidence.ts 读，用于 shared_evidence_text 与双方证据判定 */
  const evSrc = fs.readFileSync(path.join(DEMO, 'evidence.ts'), 'utf8')
  const evArr = extractArrayLiteral(evSrc, 'evidence')
  const evidence = evArr
    ? splitObjects(evArr).map((b) => ({
        evidence_id: String(field(b, 'evidence_id')),
        paper_id: String(field(b, 'paper_id')),
        project_id: 'demo',
        section: String(field(b, 'section')),
        page: Number(field(b, 'page')) || 0,
        content: String(field(b, 'content')),
        translation: '',
        supports: [],
        confidence: 1,
        method_ids: strArray(b, 'method_ids'),
        gap_ids: [],
        direction_ids: [],
        source_type: 'demo',
      }))
    : []

  return { methods, evidence, papers }
}

function loadLive() {
  let dirs = []
  try { dirs = fs.readdirSync(LIVE) } catch { return [] }
  const out = []
  for (const d of dirs) {
    const dir = path.join(LIVE, d)
    const rd = (f, fb) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return fb }
    }
    const methods = rd('methods.json', [])
    if (!methods.length) continue
    out.push({
      label: rd('project.json', {})?.name || d,
      input: { methods, evidence: rd('evidence.json', []), papers: rd('papers.json', []) },
    })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 打印（所有格式化都在 JS 内完成，不经 shell）                          */
/* ------------------------------------------------------------------ */

const pad = (s, n) => String(s).padEnd(n)
const num = (v) => Number(v).toFixed(2)

function dump(title, input) {
  const out = alignMethods(input)
  const head =
    `  ${pad('方法数', 8)} ${input.methods.length}` +
    `   参与跨论文比较 ${out.compared}` +
    `   同论文跳过 ${out.skippedSamePaper} 对` +
    `   缺归属跳过 ${out.skippedNoPaper}` +
    `   候选 ${out.candidates.length} 条`
  console.log(`\n── ${title} ──`)
  console.log(head)

  if (!out.candidates.length) {
    console.log('   （无候选）')
    return out
  }

  console.log(
    `   ${pad('ID', 6)}${pad('关系', 10)}${pad('置信', 7)}${pad('双方方法', 40)}` +
    `${pad('证据', 6)}${pad('逐字同文', 9)}证据门槛`,
  )
  for (const c of out.candidates) {
    const pair = `${c.source.method_id} ↔ ${c.target.method_id}`
    /*
     * 这一列展示的是 `hasDirectEvidence` —— 即"是否达到实质证据门槛"。
     * 它**不代表这条关系是对的**，只代表它没有因为缺证据而被降级。
     * 所以 related 行也可能是"是"，这不矛盾：related 说明"有关联但不够判同一"，
     * 与"双方有证据"是两回事。表头写"证据门槛"而不是"直接证据"，
     * 就是为了避免这个误读。
     */
    console.log(
      `   ${pad(c.alignment_id, 6)}${pad(c.relation_type, 10)}${pad(num(c.confidence), 7)}` +
      `${pad(pair, 40)}${pad(c.evidence_ids.length, 6)}${pad(c.shared_quotes.length, 9)}` +
      `${c.hasDirectEvidence ? '达标' : '不足'}`,
    )
  }
  return out
}

/* ------------------------------------------------------------------ */

console.log('═'.repeat(66))
console.log('Demo 知识库全量回放 + 真实项目数据回放（Phase 4-2）')
console.log('═'.repeat(66))

const demo = loadDemo()
console.log(`\nDemo 数据：${demo.methods.length} 个方法 / ${demo.evidence.length} 条证据 / ${demo.papers.length} 篇论文`)
const demoOut = dump('Demo 全量', demo)

/* 真实项目：只读 */
let liveTotal = 0
let liveCand = 0
for (const p of loadLive()) {
  const o = dump(`真实项目 · ${p.label}`, p.input)
  liveTotal += o.compared
  liveCand += o.candidates.length
}

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */

const problems = []

/*
 * 0 号断言：**Demo 数据必须真的被解析出来**。
 *
 * 这一条是后加的，因为它差点让整个回放变成假绿：
 * 解析器的 `indexOf('[', at)` 撞上了类型标注 `Method[]` 里的 `[`，
 * 结果是"解析成功、0 个方法"。而空输入会让后面所有断言** vacuously true**，
 * 脚本欢快地打印"✓ 通过"。
 *
 * 一个在空数据上通过的测试，比失败的测试更危险 —— 它给的是虚假信心。
 * 所以断言顺序上，这条必须放在最前面：先证明有数据，再证明数据是对的。
 */
if (demo.methods.length < 10) {
  problems.push(
    `Demo 数据只解析出 ${demo.methods.length} 个方法（应 ≥10）—— ` +
      '解析器可能又撞上了类型标注，导致"0 条数据却假通过"',
  )
}
if (demo.evidence.length < 10) {
  problems.push(`Demo 证据只解析出 ${demo.evidence.length} 条（应 ≥10）`)
}

/* 1. 确定性：Demo 跑两遍必须逐字段一致 */
const again = alignMethods(demo)
if (JSON.stringify(again) !== JSON.stringify(demoOut)) {
  problems.push('Demo 回放两次结果不一致（非确定性）')
}

/* 2. 不变式：无直接证据 ⇒ 不得是 same/alias */
for (const c of [...demoOut.candidates]) {
  if (!c.hasDirectEvidence && (c.relation_type === 'same' || c.relation_type === 'alias')) {
    problems.push(`不变式被破坏：${c.alignment_id} 无直接证据却是 ${c.relation_type}`)
  }
}

/* 3. 关系类型白名单 */
const ALLOWED = new Set(['same', 'alias', 'related', 'uncertain'])
for (const c of demoOut.candidates) {
  if (!ALLOWED.has(c.relation_type)) {
    problems.push(`非法关系类型：${c.alignment_id} → ${c.relation_type}`)
  }
}

/* 4. 不越界：不得产生演进/空白/方向 */
const banned = /进化|演进|空白|方向|improve|extend|evolve|gap|direction/i
for (const c of demoOut.candidates) {
  if (banned.test(c.relation_type)) problems.push(`关系类型越界：${c.relation_type}`)
}

/* 5. 双方三要素齐全、且跨论文 */
for (const c of demoOut.candidates) {
  for (const side of ['source', 'target']) {
    if (!c[side].paper_id || !c[side].method_id) {
      problems.push(`${c.alignment_id}.${side} 缺 paper_id/method_id`)
    }
    if (!Array.isArray(c[side].evidence_ids)) {
      problems.push(`${c.alignment_id}.${side}.evidence_ids 不是数组`)
    }
  }
  if (c.source.paper_id === c.target.paper_id) {
    problems.push(`${c.alignment_id} 双方属于同一论文`)
  }
}

/* 6. 无重复关系 */
const keys = demoOut.candidates.map((c) =>
  [c.source.method_id, c.target.method_id].sort().join('|'),
)
if (keys.length !== new Set(keys).size) problems.push(`存在重复方法对：${keys.join(' ')}`)

/* ------------------------------------------------------------------ */

console.log('\n' + '─'.repeat(66))
console.log(`汇总：Demo ${demoOut.compared} 个方法参与比较，产出 ${demoOut.candidates.length} 条候选`)
console.log(`      真实项目 ${liveTotal} 个方法参与比较，产出 ${liveCand} 条候选`)
console.log(`      同论文跳过合计 ${demoOut.skippedSamePaper} 对（Demo）`)
console.log(`规则版本：${demoOut.rule_version}`)

if (problems.length) {
  console.log(`\n✗ Demo 全量回放未通过（${problems.length} 项）`)
  for (const p of problems) console.log(`   ✗ ${p}`)
  process.exit(1)
}
console.log('\n✓ Demo 全量回放通过：输出确定、关系类型合法、无重复、不越界')
