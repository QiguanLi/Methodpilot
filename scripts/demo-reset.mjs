#!/usr/bin/env node
/**
 * 演示前重置：把运行时数据清干净，让评审看到的是"空项目列表"而不是一堆测试残留。
 *
 * 为什么需要它：默认 `DATA_DIR` 是 `data/store`，跑过测试/联调后会留下若干
 * 临时项目（名字如"CLI 实测""探索页验证项目"）。演示当天如果不清理，
 * 评审第一眼看到的就是一堆来历不明的项目 —— 这属于"演示卫生"问题，
 * 不是功能缺陷，但足以影响第一印象。
 *
 * 只删运行时产物，**不碰源码、不碰 dist、不碰 data/fixtures**。
 * 用法：
 *   pnpm demo:reset            # 清理默认 data/store + data/uploads
 *   pnpm demo:reset --dry-run  # 只打印将删除什么
 */
import { existsSync, rmSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dry = process.argv.includes('--dry-run')

/** 运行时数据：跑出来的东西，可以安全清空 */
const TARGETS = [
  path.join(ROOT, 'data', 'store', 'projects'),
  path.join(ROOT, 'data', 'uploads'),
]

function dirSize(p) {
  let n = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) walk(f)
      else n += statSync(f).size
    }
  }
  try { walk(p) } catch {}
  return n
}

let removedAny = false
for (const t of TARGETS) {
  if (!existsSync(t)) {
    console.log(`· 跳过（不存在）：${path.relative(ROOT, t)}`)
    continue
  }
  const n = readdirSync(t).length
  const size = (dirSize(t) / 1024 / 1024).toFixed(1)
  if (dry) {
    console.log(`· 将删除：${path.relative(ROOT, t)}（${n} 项，${size} MB）`)
    removedAny = true
    continue
  }
  rmSync(t, { recursive: true, force: true })
  console.log(`✓ 已清空：${path.relative(ROOT, t)}（${n} 项，${size} MB）`)
  removedAny = true
}

console.log('')
console.log(dry ? '（dry-run，未实际删除）' : '演示数据已重置，项目列表将为空。')
console.log('下一步：AI_PROVIDER=showcase pnpm server   然后浏览器打开 http://127.0.0.1:8787')
