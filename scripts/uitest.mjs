#!/usr/bin/env node
/**
 * MethodPilot 真实浏览器闭环测试（第 2 节的端到端用户流程）。
 *
 * 为什么必须用真浏览器而不是 curl 接口：
 *   curl 只能证明"接口能通"。用户要的是"点得下去、看得见"。
 *   本轮的改动几乎全在前端——PapersPage / PaperDetailPage / MethodsPage /
 *   EvidenceDrawer 四处的数据源都从浏览器内 Mock 换成了服务端数据集。
 *   这类改动**接口测试完全测不出来**：接口全绿，页面依然可能显示演示论文。
 *   所以这里用 Chromium 把整条链路点一遍，并断言页面上出现的是真实 PDF 的内容。
 *
 * 断言的核心原则：**用真实 PDF 里独有的字符串做锚点**。
 *   比如论文标题、页码、原文句子。如果页面显示的是演示数据，
 *   这些锚点必然找不到，测试就会红——不会出现"看着绿其实假"的情况。
 *
 * 用法：node scripts/uitest.mjs
 */

import { chromium } from 'playwright'
import { existsSync } from 'node:fs'

const BASE = process.env.UI_BASE ?? 'http://127.0.0.1:8901'
const PDF = process.env.UI_PDF ?? '/tmp/pdfs/2210.03629.pdf'

let pass = 0
let fail = 0
const shots = []

function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`)
  } else {
    fail++
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`)
  }
}

function section(t) {
  console.log(`\n\x1b[1m${t}\x1b[0m`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (!existsSync(PDF)) {
    console.error(`找不到测试 PDF：${PDF}`)
    process.exit(2)
  }

  const browser = await chromium.launch({
    // 沙箱里 playwright 自带的浏览器版本与安装的 playwright 包不匹配（1208 vs 1243），
    // 直接用系统 Chromium。这不影响测试有效性——测的是页面行为，不是浏览器版本。
    executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })

  /** 收集控制台错误：前端白屏或 React 报错一定要暴露出来（第 27 节） */
  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

  try {
    /* ---------------------------------------------------------------- */
    section('[1] 进入 MethodPilot（Demo 项目仍可用）')

    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
    const dashTitle = await page.locator('h1, h2').first().textContent()
    check('工作台正常渲染', Boolean(dashTitle), `标题：${dashTitle?.trim().slice(0, 30)}`)
    check('页面未白屏', (await page.locator('body').innerText()).length > 200)

    /* ---------------------------------------------------------------- */
    section('[2] 新建项目')

    await page.goto(`${BASE}/project/new`, { waitUntil: 'networkidle' })
    await sleep(400)

    // 找到项目名称输入框并填写
    const nameInput = page.locator('input[type="text"], input:not([type])').first()
    await nameInput.fill('UI 闭环测试项目')

    // 主题/领域描述
    if ((await page.locator('textarea').count()) > 0) {
      await page.locator('textarea').first().fill('测试真实 PDF 上传与证据溯源')
    }

    /*
     * 关键：必须选「上传自己的论文」而不是默认的「使用内置演示数据」。
     * 这两条路是完全不同的代码分支：前者真的在服务端建项目并跳上传页，
     * 后者只是加载本地演示数据。测试必须覆盖前者，否则等于没测闭环。
     */
    const ownPapers = page.locator('button').filter({ hasText: /上传自己的论文/ }).first()
    check('新建项目页提供「上传自己的论文」选项', (await ownPapers.count()) > 0)
    await ownPapers.click()
    await sleep(300)

    await page.screenshot({ path: '/tmp/mp-uitest/02-newproject.png' })
    shots.push('/tmp/mp-uitest/02-newproject.png')

    // 提交。必须用精确文本匹配——「上传自己的论文」那张卡片的描述里
    // 也含"创建"二字，模糊匹配会点错按钮（本轮真踩过这个坑）。
    const submit = page.getByRole('button', { name: '创建并开始分析', exact: true })
    check('存在「创建并开始分析」按钮', (await submit.count()) > 0)
    await submit.click()
    await page.waitForURL(/\/project\/[^/]+\/(upload|papers|analysis)/, { timeout: 30000 })
    const url = page.url()
    const projectId = url.match(/\/project\/([^/]+)\//)?.[1] ?? ''
    check('新建项目后跳转进项目页', Boolean(projectId), `projectId=${projectId}`)
    check(
      '新建的是真实服务端项目（非 demo 项目）',
      projectId !== '' && projectId !== 'proj-aicoding-agent',
      `projectId=${projectId}`,
    )

    /* ---------------------------------------------------------------- */
    section('[3] 进入上传页')

    await page.goto(`${BASE}/project/${projectId}/upload`, { waitUntil: 'networkidle' })
    await sleep(600)

    const uploadBody = await page.locator('body').innerText()
    check('上传页可访问（导航已注册）', /上传|拖拽|PDF/.test(uploadBody))

    // 侧边栏应该有「上传论文」入口
    const navHasUpload = await page
      .locator('nav a')
      .filter({ hasText: '上传论文' })
      .count()
    check('侧边栏有「上传论文」入口', navHasUpload > 0, `${navHasUpload} 个`)

    /* ---------------------------------------------------------------- */
    section('[4] 上传真实 PDF')

    // 通过隐藏的 file input 上传
    const fileInput = page.locator('input[type="file"]')
    check('上传页存在 file input', (await fileInput.count()) > 0)
    await fileInput.first().setInputFiles(PDF)

    // 若有「开始分析」按钮则点击
    await sleep(500)
    const startBtn = page
      .locator('button')
      .filter({ hasText: /开始分析|上传并分析|开始|分析/ })
      .first()
    if ((await startBtn.count()) > 0) {
      await startBtn.click()
    }

    await page.screenshot({ path: '/tmp/mp-uitest/04-uploading.png' })
    shots.push('/tmp/mp-uitest/04-uploading.png')

    /*
     * 等待任务完成。
     * 判定条件刻意写成"同时看到完成信号 + 看不到进行中信号"，
     * 因为"已完成"和"分析中"在页面上可能同时存在（多个文件各自独立）。
     * 只匹配"完成"会把进行中的状态误判成完成。
     */
    let done = false
    for (let i = 0; i < 90; i++) {
      const txt = await page.locator('body').innerText()
      const finished = /已完成|\b完成\b/.test(txt)
      const running = /分析中|解析中|上传中|排队中/.test(txt)
      if (finished && !running) {
        done = true
        break
      }
      await sleep(2000)
    }
    check('上传后任务在 180s 内完成', done)

    const finalTxt = await page.locator('body').innerText()
    check('上传结果显示抽取到方法', /方法\s*\d+/.test(finalTxt))
    check('上传结果显示抽取到证据', /证据\s*\d+/.test(finalTxt))

    await page.screenshot({ path: '/tmp/mp-uitest/04b-done.png' })
    shots.push('/tmp/mp-uitest/04b-done.png')

    /* ---------------------------------------------------------------- */
    section('[5] 文献库显示真实论文（而不是演示数据）')

    await page.goto(`${BASE}/project/${projectId}/papers`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(3000)

    const papersTxt = await page.locator('body').innerText()

    // 关键锚点：真实 PDF 的标题片段。演示数据里绝不会有 "ReAct"
    check(
      '文献库出现真实论文标题（ReAct）',
      /ReAct/i.test(papersTxt),
      papersTxt.match(/ReAct[^\n]{0,40}/i)?.[0] ?? '',
    )
    // 演示数据独有的论文绝不应出现
    check(
      '文献库未混入演示论文（Reflexion / Tree of Thoughts 等）',
      !/Reflexion/.test(papersTxt) && !/Tree of Thoughts/.test(papersTxt),
    )
    check('文献库标注了 LIVE', /LIVE/.test(papersTxt))

    await page.screenshot({ path: '/tmp/mp-uitest/05-papers.png', fullPage: true })
    shots.push('/tmp/mp-uitest/05-papers.png')

    /* ---------------------------------------------------------------- */
    section('[6] 打开论文详情，检查章节与页码')

    // 点进第一篇论文
    const paperLink = page.locator('a[href*="/papers/P"]').first()
    check('存在论文详情链接', (await paperLink.count()) > 0)
    await paperLink.click()
    await page.waitForURL(/\/papers\/P\d+/, { timeout: 20000 })
    await page.waitForTimeout(2500)

    const detailTxt = await page.locator('body').innerText()
    check('论文详情页渲染', /ABSTRACT|Abstract|INTRODUCTION|Introduction/i.test(detailTxt))
    // 真实解析出的章节名
    check(
      '显示真实章节结构',
      /INTRODUCTION|REFERENCES|METHODS|SETUP/i.test(detailTxt),
    )
    // 页码锚点
    check('显示真实页码（p.N）', /p\.\d+/.test(detailTxt))

    await page.screenshot({ path: '/tmp/mp-uitest/06-paperdetail.png', fullPage: true })
    shots.push('/tmp/mp-uitest/06-paperdetail.png')

    /* ---------------------------------------------------------------- */
    section('[7] 打开证据抽屉，核对「哪篇论文 / 哪章节 / 哪页 / 哪段原文」')

    // 切到 Evidence tab 并点第一条证据
    const evTab = page.locator('button').filter({ hasText: /^Evidence/ }).first()
    if ((await evTab.count()) > 0) {
      await evTab.click()
      await sleep(800)
    }

    const evBtn = page
      .locator('button')
      .filter({ hasText: /#E\d+/ })
      .first()
    const hasEv = (await evBtn.count()) > 0
    check('论文详情有可点击的证据条目', hasEv)

    if (hasEv) {
      await evBtn.click()
      await sleep(1200)

      const drawerTxt = await page.locator('body').innerText()
      check('证据抽屉已打开（显示 Evidence 编号）', /Evidence #?E?\d+/.test(drawerTxt))
      check('抽屉显示章节', /INTRODUCTION|METHODS|SETUP|Preamble|REFERENCES/i.test(drawerTxt))
      check('抽屉显示页码', /p\.\d+/.test(drawerTxt))
      check('抽屉给出了 PDF 原文入口', /打开 PDF 第 \d+ 页|查看原论文 PDF/.test(drawerTxt))
      check('抽屉标注了 LIVE', /LIVE/.test(drawerTxt))

      await page.screenshot({ path: '/tmp/mp-uitest/07-evidence.png' })
      shots.push('/tmp/mp-uitest/07-evidence.png')

      // 关闭抽屉
      await page.keyboard.press('Escape')
      await sleep(500)
    }

    /* ---------------------------------------------------------------- */
    section('[8] 方法地图显示真实抽取的方法')

    await page.goto(`${BASE}/project/${projectId}/methods`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(3000)

    const methodsTxt = await page.locator('body').innerText()
    check('方法地图渲染', /方法地图/.test(methodsTxt))
    check('方法地图标注 LIVE', /LIVE/.test(methodsTxt))
    check(
      '方法地图未混入演示方法（Reflexion / Self-Refine / ToT）',
      !/Self-Refine/.test(methodsTxt) && !/Tree of Thoughts/.test(methodsTxt),
    )
    check('如实说明分类未接入', /未分类|分类未接入/.test(methodsTxt))
    // 真实方法出现
    check(
      '展示了真实抽取的方法',
      /ReAct|React|react/i.test(methodsTxt),
      methodsTxt.match(/[A-Z][A-Za-z-]{3,20}/g)?.slice(0, 6).join(', ') ?? '',
    )

    await page.screenshot({ path: '/tmp/mp-uitest/08-methods.png', fullPage: true })
    shots.push('/tmp/mp-uitest/08-methods.png')

    /* ---------------------------------------------------------------- */
    section('[9] 从方法点回论文，闭环成立')

    const methodNode = page.locator('svg g[transform]').first()
    if ((await methodNode.count()) > 0) {
      await methodNode.click()
      await sleep(1200)
      const cardTxt = await page.locator('body').innerText()
      check('点击方法节点后出现 Method Card', /Method Card/.test(cardTxt))
      check('卡片显示支撑证据页码', /p\.\d+/.test(cardTxt))

      await page.screenshot({ path: '/tmp/mp-uitest/09-methodcard.png', fullPage: true })
      shots.push('/tmp/mp-uitest/09-methodcard.png')
    } else {
      check('点击方法节点后出现 Method Card', false, '未找到 SVG 节点')
    }

    /* ---------------------------------------------------------------- */
    section('[10] 智能分析页的 LIVE / MOCK 声明')

    await page.goto(`${BASE}/project/${projectId}/analysis`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(2500)

    const analysisTxt = await page.locator('body').innerText()
    check('分析页显示能力实现状态表', /能力实现状态/.test(analysisTxt))
    check('明确标出 LIVE 阶段', /LIVE/.test(analysisTxt))
    check('明确标出 MOCK 阶段（未把假的说成真的）', /MOCK/.test(analysisTxt))
    check('给出阶段计数', /\d\/6 阶段 LIVE/.test(analysisTxt))

    await page.screenshot({ path: '/tmp/mp-uitest/10-analysis.png', fullPage: true })
    shots.push('/tmp/mp-uitest/10-analysis.png')

    /* ---------------------------------------------------------------- */
    section('[11] 前端控制台无错误（不白屏、不静默失败）')

    const realErrors = consoleErrors.filter(
      (e) => !/favicon|404 \(Not Found\)|Failed to load resource/i.test(e),
    )
    check(
      '无 JS 运行时错误',
      realErrors.length === 0,
      realErrors.slice(0, 3).join(' | ').slice(0, 200),
    )
  } finally {
    await browser.close()
  }

  console.log('\n' + '─'.repeat(64))
  console.log(`通过 ${pass}/${pass + fail}`)
  console.log('截图：')
  shots.forEach((s) => console.log(`  ${s}`))
  console.log('─'.repeat(64))

  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常：', e)
  process.exit(3)
})
