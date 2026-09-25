import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { previewPrefix } from './services/locationBase'

/**
 * 入口 URL 规范化 + 路由 basename —— 兼容子路径反代。
 *
 * ── 为什么需要 ──
 * 演示环境可能通过子路径反代暴露服务，例如 CloudStudio 预览面板：
 *     http://127.0.0.1:38699/sandbox-preview/45:/index.html   ← 打开
 *     http://127.0.0.1:38699/sandbox-preview/45:/library     ← 进入文献库
 *
 * 三个坑：
 *   1. 代理前缀 `/sandbox-preview/45:` 会被当成路由路径的一部分，
 *      导致 `/library` 匹配不上 → 渲染 404。
 *   2. 入口 URL 常带 `/index.html`，它同样不是合法路由。
 *   3. API 请求若不带同一段前缀，会打到代理根而全军覆没
 *      （由 services/api.ts 与这里共用 previewPrefix() 解决）。
 *
 * 处理分两步：
 *   (a) 先把 location 里的 `/index.html` 抹掉（history.replaceState），
 *       使 pathname 变成 `/sandbox-preview/45:/`；
 *   (b) 再取 previewPrefix()（`:` 之前、含 `:`）补尾斜杠作为 basename。
 *
 * 关键点：(a) 必须在建 Router 前做。否则 Router 拿到的 pathname 尾部是
 * `index.html`（无前导斜杠），减去 basename 后剩余 `index.html`，
 * 被当成路由段 → 仍然 404。
 *
 * 无反代前缀时 pathname 形如 `/library`，basename 取 `/`，与原行为一致。
 * 只影响"从哪个路径开始解析路由"，不改任何路由表定义。
 */
function normalizeEntryUrl(): void {
  const { pathname, search, hash } = window.location
  if (!/\/index\.html$/.test(pathname)) return
  const next = pathname.replace(/\/index\.html$/, '/') + search + hash
  window.history.replaceState(null, '', next)
}

normalizeEntryUrl()
const prefix = previewPrefix()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={prefix ? `${prefix}/` : '/'}>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
