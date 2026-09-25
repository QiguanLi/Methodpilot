import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  /**
   * 资源引用用**相对路径**（`./assets/xxx`），而不是默认的绝对路径（`/assets/xxx`）。
   *
   * 为什么必须这样：比赛/演示环境经常通过**子路径反代**暴露服务，
   * 例如 CloudStudio 预览面板给的是
   *     http://127.0.0.1:38699/sandbox-preview/45:/
   * 默认绝对路径下，页面里的 `/assets/index-xxx.js` 会被浏览器解析到
   * **代理根** `http://127.0.0.1:38699/assets/...` —— 那里没有我们的资源，
   * 于是 JS/CSS 全部 404，页面**白屏**（HTML 本身 200，很难排查）。
   *
   * 改成相对路径后，浏览器会基于当前 HTML 的路径解析资源，
   * 无论挂在根路径还是任意子路径下都能正确加载。
   * 直连 `http://127.0.0.1:8787/` 的情形同样正常（相对路径等价于根路径）。
   */
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    /**
     * 开发时把 /api 代理到 Node 服务。
     *
     * 这样前端代码里永远只用相对路径 /api/xxx，
     * 生产环境（Node 直接服务 dist/）下同源，一行都不用改。
     * 如果改成写死 http://localhost:8787，生产部署就要再改一遍，
     * 而且会引入 CORS 配置错误这一整类问题。
     */
    proxy: {
      '/api': {
        target: process.env.API_TARGET ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
        // PDF 预览可能是几十 MB，代理默认超时不够
        timeout: 300000,
        proxyTimeout: 300000,
      },
    },
  },
})
