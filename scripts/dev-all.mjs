#!/usr/bin/env node
/**
 * 一条命令同时起「前端 dev server」和「API 服务端」。
 *
 * 存在的理由很具体：演示当天最尴尬的场面是"前端起来了但 API 没起"，
 * 页面能打开、点上传却报网络错误，而错误信息不会告诉你是服务端没开。
 * 把两个进程绑在一起，少一个可失败的步骤。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const C = {
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  api: (s) => `\x1b[36m${s}\x1b[0m`,
  web: (s) => `\x1b[35m${s}\x1b[0m`,
}

const procs = []

function run(name, color, cmd, args, extraEnv = {}) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tag = color(name.padEnd(3))

  const pipe = (stream, target) => {
    let buf = ''
    stream.on('data', (d) => {
      buf += String(d)
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const l of lines) target.write(`${tag} ${l}\n`)
    })
  }
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)

  child.on('exit', (code, sig) => {
    console.log(`${tag} ${C.dim(`退出 code=${code} sig=${sig}`)}`)
    // 任一进程退出就带走另一个，避免留着半个环境让人困惑
    shutdown(code ?? 0)
  })

  procs.push(child)
  return child
}

let shuttingDown = false
function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const p of procs) {
    try {
      p.kill('SIGTERM')
    } catch {
      /* 已退出 */
    }
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

const provider = process.env.AI_PROVIDER ?? 'mock'

console.log('─'.repeat(64))
console.log(`MethodPilot 开发环境启动中（AI_PROVIDER=${provider}）`)
console.log('─'.repeat(64))

// 先起 API，再起前端：前端首屏会立刻请求 /api/health，
// 反过来的话第一次请求会打到还没监听的端口，页面上出现一次无谓的错误态
run('api', C.api, process.execPath, ['--experimental-strip-types', 'server/index.ts'], {
  AI_PROVIDER: provider,
})
setTimeout(() => {
  run('web', C.web, 'pnpm', ['dev'])
  setTimeout(() => {
    console.log('─'.repeat(64))
    console.log(`  前端  \x1b[4mhttp://localhost:5173\x1b[0m`)
    console.log(`  接口  \x1b[4mhttp://localhost:8787/api/health?deep=true\x1b[0m`)
    console.log(C.dim('  Ctrl+C 同时停止两个进程'))
    console.log('─'.repeat(64))
  }, 1200)
}, 600)
