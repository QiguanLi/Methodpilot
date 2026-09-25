#!/usr/bin/env node
/**
 * 全文获取测试（Phase 3B-7）。
 *
 * 覆盖 spec 点名的三种情况：
 *   1. 成功       —— 取到 PDF、落盘、状态改为可分析
 *   2. 无 PDF 链接 —— 明确失败，**状态一个字都不许改**
 *   3. 重复获取   —— 第二次不再下载，如实回报"已有全文"
 *
 * ── 为什么用本地 HTTP 服务器而不是真的打 arXiv ──
 *
 * 真打外网会把这个测试变成一个"网络可用性探测器"：
 * 断网、被墙、对方改版，任何一条都让它红，而代码可能是对的。
 * 那样测试会慢慢失去可信度，最后没人看它的结果。
 *
 * 所以这里起一个本地服务器，扮演"论文站点"：它提供摘要页 HTML 与 PDF 字节。
 * 走的是**完全相同的生产代码路径**（fulltext.ts 的解析 + 下载 + 落盘），
 * 只是目标地址换成了 127.0.0.1。这条路径的每个分支都能被确定性地验证。
 *
 * 另有一步"真实站点形状"的断言：把 arXiv 摘要页的真实 HTML 片段喂给
 * resolvePdfFromHtml()，确认它解析出的 URL 与实测可用的一致。
 * 这样既保住了确定性，又没丢掉对真实站点的信心。
 *
 * 运行：pnpm fulltext:test
 */

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.FULLTEXT_TEST_PORT ?? 8931)
const BASE = `http://127.0.0.1:${PORT}`
const SITE_PORT = Number(process.env.FULLTEXT_SITE_PORT ?? 8932)
const SITE = `http://127.0.0.1:${SITE_PORT}`

const errors = []
const check = (cond, msg) => {
  if (!cond) errors.push(msg)
}

/* ------------------------------------------------------------------ */
/* 一个最小的"论文站点"                                               */
/* ------------------------------------------------------------------ */

/**
 * 一份结构真实的最小 PDF。
 *
 * 必须是真 PDF 而不是随便几个字节：服务端的判据是 magic bytes，
 * 而且后面还要断言落盘文件能被读出来。用假字节会让这条测试
 * 在"是不是 PDF"这一点上变成自证——恰好是它该验的东西。
 */
const MINIMAL_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
%%EOF
`,
  'latin1',
)

const site = createServer((req, res) => {
  const url = req.url ?? '/'

  // 摘要页：带 citation_pdf_url（学术站点的常见做法）
  if (url.startsWith('/abs/')) {
    const id = url.slice('/abs/'.length)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      `<!doctype html><html><head><title>Test Paper</title>` +
        `<meta name="citation_title" content="Test Paper">` +
        `<meta name="citation_pdf_url" content="${SITE}/pdf/${id}">` +
        `</head><body>Abstract page</body></html>`,
    )
    return
  }

  // 摘要页但**没有**任何 PDF 链接
  if (url.startsWith('/nopdf/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>No PDF</title></head><body>no fulltext here</body></html>')
    return
  }

  // 假的 PDF：URL 像 PDF，内容其实是 HTML 拦截页（真实世界里很常见）
  if (url.startsWith('/fake/')) {
    res.writeHead(200, { 'content-type': 'application/pdf' })
    res.end('<!doctype html><html><body>Please sign in to continue</body></html>')
    return
  }

  // 真的 PDF 字节
  if (url.startsWith('/pdf/')) {
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(MINIMAL_PDF.length) })
    res.end(MINIMAL_PDF)
    return
  }

  // 404：链接不可达
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

await new Promise((r) => site.listen(SITE_PORT, '127.0.0.1', r))
/*
 * 自检：测试用的"论文站点"必须真的在服务，否则后面每一条都会失败，
 * 而报出来的错是"无法读取论文页面"，看起来像被测代码的问题。
 *
 * ⚠️ 这里必须用**异步**的 fetch，绝不能用 spawnSync + curl。
 * spawnSync 是同步阻塞的：它会把事件循环卡住，而这个站点跑在同一个进程里，
 * 于是请求发出去、站点永远没机会响应、curl 一直等——整个测试死锁。
 * 我在这个脚本上卡了很久就是因为这个：现象是"测试卡住没有任何输出"，
 * 而真凶是自检本身。
 */
{
  let ok = false
  try {
    const res = await fetch(`${SITE}/abs/_probe`, { signal: AbortSignal.timeout(5000) })
    ok = res.status === 200
  } catch {
    ok = false
  }
  if (!ok) {
    site.close()
    console.log(`✗ 测试站点未就绪（${SITE}/abs/_probe），无法运行全文获取测试`)
    process.exit(1)
  }
}

/* ------------------------------------------------------------------ */
/* 起一个隔离的服务端                                                  */
/* ------------------------------------------------------------------ */

const storeDir = mkdtempSync(path.join(tmpdir(), 'mpft-'))
const uploadDir = mkdtempSync(path.join(tmpdir(), 'mpft-up-'))

const srv = spawn(
  process.execPath,
  ['--experimental-strip-types', path.join(ROOT, 'server', 'index.ts')],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      // 独立 store/upload：这个测试会写论文与落盘 PDF，绝不能碰真实数据
      DATA_DIR: storeDir,
      UPLOAD_DIR: uploadDir,
      // 与全文获取无关的外部依赖一律关掉，避免白等超时
      ENABLE_SEMANTIC_SCHOLAR: 'false',
      ENABLE_FULLTEXT_FETCH: 'true',
      FULLTEXT_TIMEOUT_MS: '8000',
    },
    /*
     * 继承本进程的 stdout/stderr，而不是 'ignore'。
     *
     * 服务端的 `[fulltext] 读取论文页面失败 ...` 这类日志是这个测试
     * 唯一的排障线索——把它吞掉的话，失败时只剩一个 "HTTP 0"，
     * 只能靠猜是超时、DNS 还是被拦。这个测试第一版就是 'ignore'，
     * 结果排查花的时间比写代码还长。
     */
    stdio: ['ignore', 'inherit', 'inherit'],
  },
)

/*
 * 收尾必须**幂等且接得住意外退出**。
 *
 * 只用 srv.kill() 是不够的：如果测试在子进程还没起完时就被杀掉
 * （Ctrl-C / timeout），那个子进程会变成孤儿继续占着端口，
 * 下一次运行就会连到它——用着旧的 DATA_DIR，症状是一堆莫名其妙的失败。
 * 所以这里还挂到 exit / SIGINT / SIGTERM 上，让异常路径也能收干净。
 */
let stopped = false
const stop = () => {
  if (stopped) return
  stopped = true
  try { srv.kill('SIGKILL') } catch {}
  try { site.close() } catch {}
  for (const d of [storeDir, uploadDir]) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
}

process.on('exit', stop)
process.on('SIGINT', () => {
  stop()
  process.exit(130)
})
process.on('SIGTERM', () => {
  stop()
  process.exit(143)
})

/*
 * ⚠️ 本测试自己的 HTTP 调用**必须用异步 fetch**，不能用 spawnSync + curl。
 *
 * 这个脚本不只是一个测试驱动，它**同时**是这个测试的"论文站点"宿主
 * （site 服务器跑在同一个进程里）。spawnSync 会同步阻塞事件循环，
 * 于是出现一个很隐蔽的死锁：
 *   1. 测试用 spawnSync 打 /fetch-fulltext（同步等 curl 退出）
 *   2. 事件循环被卡住，同进程的 site 没法把响应写回去
 *   3. 被测服务端 fetch 一直在等 site → 超时
 *   4. curl 一直等被测服务端 → 测试卡死，没有任何输出
 * 症状是"测试挂住"，而真凶是测试工具选型。这一条我踩了两次
 * （第一次在站点自检里，第二次在 get/post 里），所以在这里写清楚。
 *
 * 3B-6 的 batch-add-test.mjs 可以用 spawnSync，因为它没有同进程的服务器。
 */
async function get(u) {
  try {
    const res = await fetch(`${BASE}${u}`, { signal: AbortSignal.timeout(30_000) })
    return res.json().catch(() => null)
  } catch {
    // 服务端还没起来时是 ECONNREFUSED，这是 ready() 轮询里**正常**的状态，
    // 不能让它抛出去打断启动等待。用 curl 时它只是返回空、不抛，所以没这个问题。
    return null
  }
}

/**
 * POST 则**不吞**连接错误：能走到 POST 说明 ready() 已经成功过，
 * 此时连不上就是真的出问题了，静默返回 null 会让后面每一条断言
 * 都报"字段是 undefined"，把真实的连接故障藏起来。
 */
async function post(u, body = {}) {
  const res = await fetch(`${BASE}${u}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  return res.json().catch(() => null)
}

const ready = async () => {
  for (let i = 0; i < 40; i++) {
    if ((await get('/api/health'))?.success) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/*
 * 先确认端口是空的，必要时**收掉上一次的残留**。
 *
 * 上一次测试被 Ctrl-C / 超时杀掉时，spawn 出去的服务端会变成孤儿进程
 * （父进程没了，被 init 收养）继续占着端口。这时本次新起的服务端
 * EADDRINUSE 直接退出，而测试会连上**上一次那个残留实例**——
 * 它用的是旧的 DATA_DIR，断言全都对不上，症状是一堆莫名其妙的失败。
 *
 * 我第一次撞上时花了很久才看出"连的不是自己起的那个服务"。
 * 所以这里不只是报错，而是主动清理：端口占用是完全可以自愈的情况，
 * 让开发者手工 kill 只是把麻烦推给人。
 */
async function reapStaleServer(port, label) {
  let occupied = false
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1200) })
    occupied = true
  } catch {
    return true // 连不上就是空的，正是我们要的
  }
  if (!occupied) return true

  // 是本项目的服务端吗？不是的话不能乱杀
  const r = spawnSync('bash', ['-c', `ss -ltnp 2>/dev/null | grep ':${port} ' | grep -oP 'pid=\\K[0-9]+' | head -1`], {
    encoding: 'utf8',
  })
  const pid = (r.stdout || '').trim()
  if (!/^\d+$/.test(pid)) {
    console.log(`✗ 端口 ${port}（${label}）被占用，且无法识别占用进程，请手动处理后重试`)
    return false
  }

  const cmd = spawnSync('bash', ['-c', `ps -p ${pid} -o args= 2>/dev/null`], { encoding: 'utf8' }).stdout || ''
  if (!cmd.includes('methodpilot/server/index.ts')) {
    console.log(`✗ 端口 ${port}（${label}）被一个非本项目的进程占用（pid=${pid}）：${cmd.trim().slice(0, 80)}`)
    console.log(`   不会自动清理，请手动停止它，或用 FULLTEXT_TEST_PORT 指定其它端口`)
    return false
  }

  console.log(`  · 发现上次测试残留的服务端（pid=${pid}）占着端口 ${port}，已清理`)
  try {
    process.kill(Number(pid), 'SIGKILL')
  } catch {}
  // 等端口真正释放，TCP 关闭不是瞬间的
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150))
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) })
    } catch {
      return true
    }
  }
  console.log(`✗ 端口 ${port} 清理后仍被占用`)
  return false
}

if (!(await reapStaleServer(PORT, 'API'))) process.exit(1)

if (!(await ready())) {
  stop()
  console.log('✗ 服务端未能启动，无法运行全文获取测试')
  process.exit(1)
}

/* ------------------------------------------------------------------ */

const created = await post('/api/projects', {
  name: '全文获取测试',
  subtitle: 'Phase 3B-7',
  domain: 'AI Agents',
  goal: '验证成功 / 无链接 / 重复获取三种情况',
})
const PID = created?.data?.id
if (!PID) {
  stop()
  console.log('✗ 无法创建测试项目：' + JSON.stringify(created))
  process.exit(1)
}

// data 就是数组本身，不是 data.papers —— 这个坑 3B-6 踩过，这里两种形态都兜
const papersOf = async () => {
  const d = (await get(`/api/projects/${PID}/papers`)).data
  return Array.isArray(d) ? d : (d?.papers ?? [])
}

/*
 * ⚠️ 按 paper_id 查，**不要按 file_hash 查**。
 *
 * 我第一版写成 `find(p => p.file_hash === 'meta:' + id)`，它的副作用是：
 * 获取全文成功后 file_hash 就不再是 meta: 前缀了，于是查不到那篇论文，
 * 返回 undefined，后面读 after.file_name 直接 TypeError。
 * 表现为"测试崩了"，而其实是被测行为完全正确——恰恰是这个测试
 * 想要发生的那件事（meta: 前缀被真实哈希取代）把断言自己绊倒了。
 *
 * 按 paper_id 查在任何状态下都稳定。
 */
const pickById = async (paperId) => (await papersOf()).find((p) => p.paper_id === paperId)

/** 建一篇仅元数据论文，返回它的 paper_id */
const mkMeta = async (id, link) => {
  const r = await post(`/api/projects/${PID}/papers/meta`, {
    s2_paper_id: id,
    title: `测试论文 ${id}`,
    authors: ['作者甲'],
    year: 2024,
    abstract: '摘要文本',
    url: link,
    doi: `10.1000/${id}`,
    citationCount: 5,
    venue: 'TestConf',
    source: 'live',
  })
  return r?.data?.paper?.paper_id ?? ''
}

const fetchFull = (paperId) => post(`/api/projects/${PID}/papers/${paperId}/fetch-fulltext`)

const hashOf = async (paperId) => (await pickById(paperId))?.file_hash ?? ''

/* ================================================================== */
console.log('— 1. 成功获取（摘要页 → 解析出 PDF → 下载 → 落盘 → 状态可分析）—')
/* ================================================================== */

const okId = await mkMeta('ok-1', `${SITE}/abs/ok-1`)
const before = await pickById(okId)
check(before?.status === 'pending', `元数据论文初始状态应为 pending，实际 ${before?.status}`)
check(String(before?.file_hash).startsWith('meta:'), '元数据论文的 file_hash 应以 meta: 开头')

const r1 = await fetchFull(okId)
check(r1.data?.ok === true, `获取应成功，实际 ${JSON.stringify(r1.data)}`)
check(r1.data?.already === false, '首次获取不应被标记为 already')
check(r1.data?.route === 'resolved', `应走"从摘要页解析"路径，实际 ${r1.data?.route}`)

const after = await pickById(okId)
check(after?.status === 'uploaded', `获取成功后状态应为 uploaded（前端显示可分析），实际 ${after?.status}`)
check(
  String(after?.file_hash).startsWith('meta:') === false,
  `获取成功后 file_hash 不应再是 meta: 前缀，实际 ${after?.file_hash}`,
)
check(after?.file_size > 0, `file_size 应大于 0，实际 ${after?.file_size}`)
check(/\.pdf$/i.test(after?.file_name ?? ''), `文件名应以 .pdf 结尾，实际 ${after?.file_name}`)
check(after?.sections?.length === 0, 'sections 应被清空（元数据占位节不该留下来）')
check(after?.page_count === 0, 'page_count 应为 0（解析器还没跑，不许编一个数出来）')

// 真的落到磁盘上了吗？只看 file_size 是自证，必须直接读文件
const okHash = await hashOf(okId)
const savedPath = path.join(uploadDir, okHash.slice(0, 16), after.file_name)
check(existsSync(savedPath), `PDF 应真的落盘：${savedPath}`)
if (existsSync(savedPath)) {
  const buf = readFileSync(savedPath)
  check(buf.subarray(0, 5).toString('latin1') === '%PDF-', '落盘文件的 magic bytes 应是 %PDF-')
  check(buf.length === after.file_size, `落盘大小 ${buf.length} 应与 file_size ${after.file_size} 一致`)
}
console.log(`  route=resolved → status=${after.status} size=${after.file_size} name=${after.file_name}`)

/* ================================================================== */
console.log('— 2. 不含 PDF 链接的摘要页：必须明确失败，且不改状态 —')
/* ================================================================== */

const npId = await mkMeta('nopdf-1', `${SITE}/nopdf/nopdf-1`)
const r2 = await fetchFull(npId)

check(r2.data?.ok === false, '找不到 PDF 链接时应返回 ok:false')
check(r2.data?.code === 'UNRESOLVED', `应报 UNRESOLVED，实际 ${r2.data?.code}`)
check(
  typeof r2.data?.message === 'string' && r2.data.message.length > 0,
  '失败必须带一句能看懂的原因，不能是空字符串',
)

const npAfter = await pickById(npId)
/*
 * 这三条是本阶段最重要的断言。
 * spec 原话："获取失败要明确显示「无法获取全文」，不能伪装成已获取"。
 * 伪装有两种写法：把状态改成 uploaded（看起来成功了），
 * 或者干脆改成 completed（看起来连分析都做完了）。这里两条都堵死。
 */
check(npAfter?.status === 'pending', `失败后状态必须还是 pending，实际 ${npAfter?.status}`)
check((await hashOf(npId)) === 'meta:nopdf-1', '失败后 file_hash 必须还是 meta: 前缀')
check(npAfter?.file_size === 0, `失败后 file_size 必须还是 0，实际 ${npAfter?.file_size}`)
console.log(`  ok=false code=${r2.data.code} → status 仍为 ${npAfter.status}，未伪装成已获取`)

/* ================================================================== */
console.log('— 3. 链接不可达 / 下回来不是 PDF：同样明确失败 —')
/* ================================================================== */

const deadId = await mkMeta('dead-1', `${SITE}/missing/dead-1`)
const r3 = await fetchFull(deadId)
check(r3.data?.ok === false, '链接不可达时应返回 ok:false')
check(r3.data?.code === 'UNRESOLVED', `不可达应报 UNRESOLVED，实际 ${r3.data?.code}`)
check((await pickById(deadId))?.status === 'pending', '不可达时状态不应改变')

/*
 * 最阴的一种：URL 长得像 PDF、Content-Type 也写着 application/pdf，
 * 内容其实是 HTML 登录页。只看 URL 或只看响应头的实现会把它当成功存下来，
 * 然后解析器在几步之后报一个莫名其妙的错。
 * 唯一可靠的判据是下载回来的字节本身。
 */
const fakeId = await mkMeta('fake-1', `${SITE}/fake/fake-1.pdf`)
const r4 = await fetchFull(fakeId)
check(r4.data?.ok === false, 'Content-Type 撒谎时应返回 ok:false')
check(r4.data?.code === 'NOT_PDF', `伪装成 PDF 的内容应报 NOT_PDF，实际 ${r4.data?.code}`)
check((await pickById(fakeId))?.status === 'pending', '内容不是 PDF 时状态不应改变')
console.log(`  不可达 → ${r3.data.code}；伪 PDF → ${r4.data.code}`)

/* ================================================================== */
console.log('— 4. 元数据里完全没有链接 —')
/* ================================================================== */

const noLinkId = await mkMeta('nolink-1', '')
const r5 = await fetchFull(noLinkId)
check(r5.data?.ok === false, '没有链接时应返回 ok:false')
check(r5.data?.code === 'NO_LINK', `应报 NO_LINK，实际 ${r5.data?.code}`)
check((await pickById(noLinkId))?.status === 'pending', '没有链接时状态不应改变')
console.log(`  无链接 → ${r5.data.code}`)

/* ================================================================== */
console.log('— 5. 重复获取：第二次不再下载 —')
/* ================================================================== */

const r6 = await fetchFull(okId)
check(r6.data?.already === true, '第二篇已有全文，应返回 already:true')
check(r6.data?.status === 'uploaded', `重复获取时状态应保持 uploaded，实际 ${r6.data?.status}`)

/*
 * 哈希必须一模一样。
 * 如果服务端按 status 判幂等而不是按文件判，第二次会重新下载同一个 PDF，
 * 算出同一个内容哈希——看起来没事，但如果重下的是**另一版** PDF
 * （站点更新了版本），就会悄悄产生第二个哈希目录，盘上留下两份全文，
 * 而 papers.json 只认其中一个。按 file_hash 判从根上避免这件事。
 */
check((await hashOf(okId)) === after.file_hash, '重复获取不应改变 file_hash')

// 再打两次，确认不会因为多次调用产生额外文件
await fetchFull(okId)
await fetchFull(okId)
check((await hashOf(okId)) === after.file_hash, '连续三次重复获取后 file_hash 仍应不变')
let dirCount = -1
try {
  dirCount = readdirSync(path.join(uploadDir, after.file_hash.slice(0, 16))).length
} catch {
  dirCount = -1
}
check(dirCount === 1, `哈希目录下应只有 1 个文件（不重复下载），实际 ${dirCount}`)

// 论文总数没变（重复获取不该新增论文）
const totalAfter = (await papersOf()).length
check(totalAfter === 5, `论文总数应恒为 5，实际 ${totalAfter}`)
console.log(`  三次重复调用 → file_hash 不变，目录内文件数 ${dirCount}，论文总数 ${totalAfter}`)

/* ================================================================== */
console.log('— 6. 已有上传 PDF 的论文完全不动 —')
/* ================================================================== */

/*
 * 构造一篇"看起来像上传"的论文：直接写进 store 不方便，
 * 所以换一条路——用一篇已经获取成功的论文冒充。
 * ok-1 此刻 file_hash 已经是真实哈希，正是"有上传 PDF"的形态。
 */
const snapshot = JSON.stringify(await pickById(okId))
const r7 = await fetchFull(okId)
check(r7.data?.already === true, '已有 PDF 的论文应返回 already')
check(JSON.stringify(await pickById(okId)) === snapshot, '已有 PDF 的论文记录应逐字节不变（含 updated_at）')

// 不存在的论文 / 项目
const r8 = await fetchFull('P999')
check(r8.success === false, '不存在的论文应报错，而不是静默成功')
const r9 = await post('/api/projects/proj_not_exist/papers/P001/fetch-fulltext')
check(r9.success === false, '不存在的项目应报错')
console.log(`  已有 PDF → already=true 且记录逐字节不变；未知论文/项目 → 正确报错`)

/* ================================================================== */
console.log('— 7. 真实站点形状：arXiv 摘要页能解析出可用 PDF 直链 —')
/* ================================================================== */

/*
 * 这一条补的是上面所有测试都缺的那部分：本地服务器是我按理解造的，
 * 万一我对真实站点的 HTML 结构理解错了，前面全绿也没用。
 * 所以这里直接喂 arXiv 摘要页的真实片段（实测抓取所得形态）。
 */
const { resolvePdfFromHtml } = await import(
  path.join(ROOT, 'server', 'services', 'fulltext.ts')
)

const arxivHtml = `<!doctype html><html><head>
<meta name="citation_title" content="ReAct: Synergizing Reasoning and Acting in Language Models">
<meta name="citation_author" content="Shunyu Yao">
<meta name="citation_pdf_url" content="https://arxiv.org/pdf/2210.03629">
</head><body><a href="/pdf/2210.03629">PDF</a></body></html>`

const got = resolvePdfFromHtml(arxivHtml, 'https://arxiv.org/abs/2210.03629')
check(
  got === 'https://arxiv.org/pdf/2210.03629',
  `arXiv 摘要页应解析出 https://arxiv.org/pdf/2210.03629，实际 ${got}`,
)

// 站内相对链接要补成绝对地址，不能原样返回
const rel = resolvePdfFromHtml('<html><head><meta name="citation_pdf_url" content="/pdf/abc"></head></html>', 'https://example.test/abs/abc')
check(rel === 'https://example.test/pdf/abc', `相对链接应补全为绝对地址，实际 ${rel}`)

// 没有 meta 标签时用站点规则兜底
const rule = resolvePdfFromHtml('<html><body>no meta</body></html>', 'https://arxiv.org/abs/2405.15793')
check(rule === 'https://arxiv.org/pdf/2405.15793', `arXiv 规则兜底应生效，实际 ${rule}`)

// 什么线索都没有时必须返回空，绝不能瞎猜一个
const none = resolvePdfFromHtml('<html><body>nothing useful</body></html>', 'https://example.test/paper/1')
check(none === '', `无任何线索时应返回空串，实际 ${none}`)
console.log(`  arXiv → ${got}；相对链接 → ${rel}；无线索 → 正确返回空`)

/* ------------------------------------------------------------------ */

stop()

console.log('')
if (errors.length) {
  console.log(`✗ 全文获取测试失败，${errors.length} 项未通过：`)
  for (const e of errors) console.log(`   · ${e}`)
  process.exit(1)
}
console.log('✓ 全文获取测试全部通过（成功 / 无链接 / 重复获取 / 已有 PDF 不动 / 真实站点形状）')
