/**
 * 当前页面所在的"反代前缀"。
 *
 * ── 为什么需要 ──
 * 演示环境可能把服务挂在子路径下，例如 CloudStudio 预览面板：
 *     http://127.0.0.1:38699/sandbox-preview/45:/dashboard
 *                              ^^^^^^^^^^^^^^^^^^^^
 * 这一段是代理加的前缀，不属于应用路由，也不属于 API 路径。
 *
 * ── 判定规则 ──
 * 前缀的可靠特征是它以 `:` 结尾（`45:` 是代理的会话/端口标识）。
 * 取 pathname 中最后一个 `:` 之前（含）的部分即为前缀；
 * 没有 `:` 说明没有被反代，返回空串。
 *
 * 本应用自身的路由（/dashboard、/project/xxx/methods 等）与
 * 项目 ID（proj-aicoding-agent 等）都不含 `:`，不会误判。
 *
 * ── 谁在用 ──
 * - main.tsx：作为 React Router 的 basename（路由从这个前缀之后开始解析）
 * - services/api.ts：拼在 /api/... 前面，让请求与页面走同一条代理通道
 *
 * 两个消费方必须用**同一个**前缀来源，否则会出现
 * "页面在前缀下、请求却打到代理根" 的错位。
 */

export function previewPrefix(): string {
  if (typeof window === 'undefined') return ''
  const { pathname } = window.location
  const idx = pathname.lastIndexOf(':')
  if (idx < 0) return ''
  return pathname.slice(0, idx + 1)
}
