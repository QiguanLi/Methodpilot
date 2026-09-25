# MethodPilot

**面向计算机科研的论文方法梳理与研究方向推导智能体**

AI Research Method Analysis Copilot · 深大计软 & 腾讯云 粤港澳大湾区 AI Coding 创新大赛 · 赛题方向六

---

## 这是什么

MethodPilot 不是一个"AI 论文总结工具"，也不是"ChatGPT + PDF 上传"。

它要解决的核心问题是：**帮助计算机科研人员快速理解一个细分领域"有哪些方法、方法之间有什么关系、技术是如何演进的、目前有哪些研究空白，以及可能有哪些后续研究方向"。**

完整的产品链路：

```
论文 → 批量解析 → 方法抽取 → 方法自动分类 → 技术演进重建
     → 研究空白发现 → 研究方向推导 → 研究调研报告
```

### 核心产品特色：Evidence-First 证据链

AI 输出的关键结论必须尽可能关联到原论文中的证据：

```
某方法是某方法的改进
  ↓ 对应论文
  ↓ 对应章节 / 页面 / 文本片段
  ↓ AI 解释
```

在任意结论卡片上点击 `N Evidence`，即可从右侧抽屉查看原文片段、章节、页码与抽取置信度。

**系统严格区分「有证据支持的演进关系」与「仅时间相邻」。** 当跨论文证据不足以支撑继承或改进判定时，关系会降级显示为「时间相邻」或「相关」，避免编造论文之间不存在的因果关系。

---

## 快速开始

本项目是**前端 SPA + 本地 Node API 服务**：前端负责界面，Node 服务负责 PDF 解析、
AI 抽取与数据落盘。两者**都要启动**（或用生产模式由 Node 一并托管）。

```bash
cd methodpilot
pnpm install
```

### 方式 A：一键开发模式（推荐日常开发）

```bash
pnpm dev:all
```

同时起前端 `http://localhost:5173` 与 API `http://localhost:8787`，Vite 已配好 `/api` 代理。

> ⚠️ 只跑 `pnpm dev` 会**只有前端、没有 API**，页面能打开但上传/分析会报网络错误。
> 演示时务必用 `dev:all` 或下面的生产模式。

### 方式 B：生产模式（推荐比赛现场演示）

```bash
pnpm build              # 先构建前端产物到 dist/
pnpm server             # Node 同时托管 dist/ 与 /api，单端口
```

打开 `http://127.0.0.1:8787` 即可，**只需一个进程、一个端口**，演示风险最低。

### 离线演示（Showcase 预置模式）

比赛现场通常没有 API Key。用 `showcase` provider 可以在**完全离线**的情况下
跑通整条链路，且**所有证据仍逐字取自真实 PDF**（不是伪造文本）：

```bash
pnpm demo:reset                 # 可选：清空历史项目，从干净状态开始
pnpm server:showcase            # AI_PROVIDER=showcase，单端口 8787
```

Showcase 模式只替换「方法抽取 / 分类」这一层为预置结果，
其后**证据校验、方法对齐、技术演进、研究空白、研究方向、调研报告全部走真实算法**。
对不在预置清单里的论文会自动退回内置规则抽取器，行为与普通 mock 一致。

一键验收 Showcase 全链路：

```bash
pnpm showcase:e2e               # 3 篇真实 PDF → 全链路 17 项断言
```

### 其他命令

```bash
pnpm build         # 生产构建（先做类型检查，再打包）
pnpm preview       # 预览生产构建产物
pnpm lint          # 代码检查
pnpm demo:reset    # 清空运行时数据（演示前重置，--dry-run 可先预览）
```

### AI Provider 选择

用环境变量 `AI_PROVIDER` 切换（默认 `mock`，无需任何配置即可跑通）：

| 值 | 用途 | 需要的配置 |
|---|---|---|
| `mock` | 默认。确定性规则抽取，永不失败，用于回归测试 | 无 |
| `showcase` | 离线比赛演示：预置抽取 + 真实算法 | 无 |
| `http` | 生产。OpenAI 兼容接口 | `AI_API_KEY` + `AI_BASE_URL` |
| `cli` | 调用本机 codebuddy CLI | 本机 CLI 环境 |

对应命令：`pnpm server` / `pnpm server:showcase` / `pnpm server:http` / `pnpm server:cli`。

> 首次打开会自动进入 `/dashboard`，无需登录；内置演示数据可直接跑完整流程。
> 若要体验真实上传链路，进入项目页上传 PDF（`AI_PROVIDER=showcase` 时预置的 3 篇论文效果最佳）。

### 自检脚本

`scripts/` 下是一组校验脚本，用系统 Chromium 驱动，改完代码可以直接跑：

```bash
node scripts/verify.mjs        # 12 条路由全部渲染 + 控制台零报错
node scripts/verify-data.mjs   # 数据引用闭合性校验（Evidence-First 的结构性保证）
node scripts/responsive.mjs    # 1440 / 1024 / 390 三档响应式无横向溢出
```

完整回归（含 API 与 UI 端到端）：

```bash
pnpm analyze:test pnpm evolution:test pnpm gap:test   # 主链路
pnpm direction:test pnpm report:test                  # 下游
pnpm showcase:e2e                                     # 离线演示全链路
```

其中 `verify-data.mjs` 是这个项目最该保留的工程习惯：它会把"任何结论都必须有证据"这句产品承诺变成**机器可验证的约束** —— 例如"某条关系声明为 `extends` 却没有任何 `evidence_ids`"会直接判定为失败。承诺写在文案里只是营销，能跑成断言才是工程。

---

## 演示动线

### A. 真实上传链路（推荐主演示，约 5 分钟）

用 Showcase 模式加 3 篇真实 PDF，完整展示"上传 → 解析 → 抽取 → 落库 → 全链路"：

```bash
pnpm build && pnpm demo:reset && pnpm server:showcase
```

打开 `http://127.0.0.1:8787`，按此顺序操作：

| 步骤 | 操作 | 看点 |
|---|---|---|
| 1 | 新建项目 | 输入项目名（如「Agent 方法调研」） |
| 2 | 上传 3 篇 PDF | **建议**：ReAct (arXiv 2210.03629)、AutoGen (2308.08155)、SWE-agent (2405.15793) |
| 3 | 等待分析完成 | 自动走：解析 → 方法抽取 → 证据校验 → 落库 |
| 4 | 进入「方法地图」 | 3 个方法带确定性分类：ReAct→工具调用、AutoGen→多智能体协作、SWE-agent→软件工程智能体 |
| 5 | 点证据数字 | Evidence 抽屉展示**真实原文片段 + 页码**，可回链 |
| 6 | 进入「技术演进」 | 时间线按年排列；非因果边如实显示「时间相关」并解释原因 |
| 7 | 进入「研究空白」 | 2 条 `stated` 缺口（原文自陈的局限） |
| 8 | 进入「研究方向」 | 由 Gap 自动传播的 `stated_backed` 方向 |
| 9 | 进入「调研报告」 | 六章结构化报告，含 Evidence 索引；支持导出 Markdown / PDF |

> 📌 说明：3 篇论文中 ReAct 与 AutoGen 的 PDF 年份同为 2023，算法按「年份不能推因果」
> 如实输出「时间相关」而非编造因果 —— 这正是 Evidence-First 的体现，讲解时是加分项。

### B. 内置 Demo 数据（离线，无需上传，约 2 分钟）

不启动后端也能展示界面与知识链（`pnpm dev` 或直接看 `dist/`）：

| 步骤 | 操作 | 看点 |
|---|---|---|
| 1 | 打开 `/dashboard` | 统计卡、方法分布、技术演进概览、研究空白 |
| 2 | 进入「方法地图」 | 关系图可视化，点击节点查看 Method Card |
| 3 | 点击节点上的证据数字 | Evidence 抽屉：原文 + 中文释义 + 置信度 |
| 4 | 进入「技术演进」 | 横向时间线 + 数据视图切换 |
| 5 | 进入「研究空白」/「研究方向」/「调研报告」 | 分层展示、可回链、可导出 |

---


## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 构建 | Vite 8 | 启动快、构建快，前端产出静态文件 |
| 框架 | React 19 + TypeScript 6 | 严格模式，全项目类型完备 |
| 路由 | React Router 7 | 嵌套路由 + URL 查询参数承载选中状态 |
| 样式 | Tailwind CSS v4 | 通过 `@theme` 定义设计令牌，无额外配置 |
| 图表 | Recharts | 环形图、柱状图、折线图 |
| 关系图 | 原生 SVG | 自绘，支持多种关系类型的贝塞尔连线与箭头 |
| 图标 | 内联 SVG | 零图标库依赖，全部自绘 |
| 后端 | Node 原生 http + TS 直跑 | 零运行时依赖，`node --experimental-strip-types` 直接跑 `.ts` |
| PDF 解析 | PyMuPDF | 本地提取文本层、章节、页码、元数据 |
| 存储 | JSON 文件（`fileStore`） | 原子写 + 项目级读写锁，无需数据库 |

**为什么不用 Next.js**：比赛要求"可部署、独立运行、现场演示"。前端是纯静态产物，
后端是零运行时依赖的 Node 进程 —— 生产模式下 `pnpm server` 一个进程同时托管前端与
`/api`，单端口即可演示，不受外部服务状态影响，演示风险最低。

---

## 现场排障

| 现象 | 原因 | 解决 |
|---|---|---|
| 页面能打开，但上传/分析报网络错误 | 只启动了前端，API 没起 | 用 `pnpm dev:all` 或 `pnpm build && pnpm server` |
| 启动报 `EADDRINUSE` | 8787 端口被上一次的进程占用 | `lsof -t -i:8787 -sTCP:LISTEN \| xargs -r kill -9` |
| 项目列表里有一堆陌生项目 | 之前联调/测试留下的运行时数据 | `pnpm demo:reset` |
| 上传后分析很慢或失败 | 送入了过多/过大的 PDF | 演示用 3 篇即可；单篇建议 < 20 MB |
| 想确认整条链路是否正常 | —— | `pnpm showcase:e2e`（17 项断言，全绿即可放心演示） |

> 演示环境建议：**提前 `pnpm build`**，现场只跑 `pnpm server:showcase`，
> 并预先上传好 3 篇论文。这样即使现场网络异常也不受影响（Showcase 完全离线）。

### 子路径反代环境（CloudStudio 预览面板等）

应用挂在代理子路径下（如 `http://host/sandbox-preview/45:/`）也能完整工作，已内置三处兼容：

| 环节 | 机制 |
|---|---|
| 静态资源 | Vite `base: './'` 相对引用 + 服务端后缀回退（`server/index.ts` serveStatic） |
| 前端路由 | `src/main.tsx` 入口规范化 + basename（前缀取自 `src/services/locationBase.ts`） |
| API 请求 | `src/services/api.ts` 把同一个前缀拼到 `/api/...` 前，与页面同通道 |

要点：路由与 API **共用同一个前缀来源**（`previewPrefix()`），
避免"页面在前缀下、请求打到代理根"的错位。直接根路径访问时前缀为空，行为不变。

### CloudStudio 沙箱内常驻运行

工作空间根目录的 `.cloudstudio`（TOML）声明应用后，由 IDE 的 terminal 服务托管：

```toml
[[app]]
name = "methodpilot"
port = 8787
cmd = "cd /workspace/methodpilot && AI_PROVIDER=showcase node --experimental-strip-types server/index.ts"
```

沙箱休眠恢复后会自动拉起，无需人工重启。
HTML 响应带 `Cache-Control: no-store`（assets 为 immutable 长缓存），
浏览器不会拿到旧 bundle。

---

## 目录结构

```
methodpilot/
├── src/
│   ├── types/
│   │   └── index.ts                  # 全部数据模型定义（Paper/Method/Evidence/...）
│   │
│   ├── data/                         # Demo 数据（集中管理，互相引用成链）
│   │   ├── papers.ts                 # 18 篇论文
│   │   ├── methods.ts                # 19 个方法 + 5 个方法族
│   │   ├── evidence.ts               # 38 条原文证据
│   │   ├── relations.ts              # 20 条方法关系 + 10 个演进节点
│   │   ├── gaps.ts                   # 5 项研究空白 + 3 个研究方向
│   │   ├── pipeline.ts               # 流水线阶段定义、AI 日志、统计项
│   │   └── index.ts                  # 知识库聚合 + 反向引用自动校正
│   │
│   ├── services/
│   │   ├── agent.ts                  # ★ Agent 接口层（Mock/Real 唯一切换点）
│   │   └── selectors.ts              # 查询层（页面只通过这里取数）
│   │
│   ├── context/
│   │   └── AppContext.tsx            # Toast / Evidence 抽屉 / 全局交互状态
│   │
│   ├── components/
│   │   ├── AppLayout.tsx             # Sidebar + TopBar + Main Content
│   │   ├── EvidenceDrawer.tsx        # ★ Evidence 证据抽屉 + Toast 容器
│   │   ├── AIAssistant.tsx           # 右下角 AI 助手（带证据引用）
│   │   └── ui.tsx                    # 设计系统：图标、卡片、徽标、状态视图
│   │
│   ├── pages/
│   │   ├── DashboardPage.tsx         # /dashboard
│   │   ├── NewProjectPage.tsx        # /project/new
│   │   ├── NotFound.tsx              # 404
│   │   └── project/
│   │       ├── PapersPage.tsx        # /project/:id/papers
│   │       ├── PaperDetailPage.tsx   # /project/:id/papers/:paperId
│   │       ├── AnalysisPage.tsx      # /project/:id/analysis
│   │       ├── MethodsPage.tsx       # /project/:id/methods
│   │       ├── MethodCard.tsx        # 方法卡片（方法地图右侧面板）
│   │       ├── EvolutionPage.tsx     # /project/:id/evolution
│   │       ├── GapsPage.tsx          # /project/:id/gaps
│   │       ├── DirectionsPage.tsx    # /project/:id/directions
│   │       └── ReportPage.tsx        # /project/:id/report
│   │
│   ├── App.tsx                       # 路由表 + 全局 Provider 装配
│   ├── main.tsx                      # 应用入口
│   └── index.css                     # 设计令牌（@theme）+ 组件类 + 动画 + 打印样式
│
├── scripts/                          # 自检脚本（Playwright 驱动系统 Chromium）
│   ├── verify.mjs                    # 路由渲染与运行时错误检查
│   ├── verify-data.mjs               # 数据引用闭合性校验
│   ├── responsive.mjs                # 多断点横向溢出检查
│   ├── audit.mjs                     # 证据数量一致性审计
│   └── shots.mjs                     # 批量截图
│
├── vite.config.ts
├── tsconfig.app.json
└── package.json
```

---

## 路由表

| 路由 | 页面 | 状态 |
|---|---|---|
| `/dashboard` | 工作台 | P0 |
| `/project/new` | 新建项目 | P0 |
| `/project/:id/papers` | 文献库 | P0 |
| `/project/:id/papers/:paperId` | 论文详情 | P1 |
| `/project/:id/analysis` | 智能分析（Agent 流水线） | P1 |
| `/project/:id/methods` | 方法地图 | P0 |
| `/project/:id/evolution` | 技术演进 | P0 |
| `/project/:id/gaps` | 研究空白 | P0 |
| `/project/:id/directions` | 研究方向 | P0 |
| `/project/:id/report` | 调研报告 | P1 |
| `*` | 404 | 已完成 |

---

## 接入真实 AI

> 📌 **先看这里**：项目有**两条并行的数据路径**，别混淆。
>
> - **前端内置 Demo 路径**（本节所述）—— `src/services/agent.ts`，为"不启动后端也能演示界面"而保留。
> - **后端真实链路**（已实现）—— `server/`：上传 PDF → PyMuPDF 解析 → AI Provider 抽取 → 算法 → 落库。
>   切模型只需改变量：`AI_PROVIDER=mock|showcase|http|cli`（见上方「AI Provider 选择」）。

前端 Demo 路径的七个函数**契约已冻结**，页面层完全不关心数据从哪来：

| 函数 | 对应能力 | 前端 Demo 实现 | 后端真实链路（已实现） |
|---|---|---|---|
| `analyzePapers()` | 批量文献解析 | 返回内置论文的章节结构 | ✅ PyMuPDF 提取章节 / 页码 / 元数据 |
| `extractMethods()` | 方法抽取 | 返回预置方法实体 | ✅ AI Provider（mock/showcase/http/cli） |
| `classifyMethods()` | 方法自动分类 | 返回预置方法族 | ✅ 确定性分类 + 依据 + 置信度 |
| `buildEvolution()` | 技术关系分析 | 返回预置关系与演进节点 | ✅ 三道门判定，因果/时间相关严格区分 |
| `detectResearchGaps()` | 研究空白发现 | 返回预置空白 | ✅ stated / candidate 分层 |
| `generateDirections()` | 研究方向推导 | 返回预置方向 | ✅ 由 Gap 自动传播 |
| `generateReport()` | 调研报告生成 | 由结构化数据拼装 | ✅ 六章 + kind 标注 + 上游回链 |

**前端切 Live 模式**：在 `.env` 中设置

```bash
VITE_AGENT_MODE=live
```

侧边栏底部会显示当前 Agent 模式（Mock / Live），方便演示时确认状态。

> **关键约定**：`generateReport()` 与所有返回结论的函数都应保持"结论必须携带 `evidence_ids`"这一契约。证据链是这个产品的立身之本，两条路径都不放弃。

---

## Demo 数据规模

| 类型 | 数量 | 说明 |
|---|---|---|
| 论文 Paper | 18 篇 | SWE-agent、ReAct、Reflexion、AutoGen、ChatDev、MemGPT、OpenHands、SWE-bench、ToT、Toolformer、ToolLLM、CodeT5、AlphaCode 等真实经典工作 |
| 方法 Method | 19 个 | 覆盖 Agent / Prompting / Fine-tuning / Multi-Agent / Tool-Augmented / Neuro-Symbolic 六种范式 |
| 方法族 Family | 5 个 | SE Agent、Tool-Using Agent、Planning & Reflection、Multi-Agent、Code Generation & Evaluation |
| 方法关系 Relation | 20 条 | 继承、改进、组合、替代、并行、时间相邻、相关 |
| 演进节点 Evolution | 10 个 | 2019 → 2025 贯穿 |
| 研究空白 Gap | 5 项 | 方法 2、评价 1、应用 1、数据 1 |
| 研究方向 Direction | 3 个 | 每个含完整十节分析 |
| 证据 Evidence | 38 条 | 每条锚定到具体论文、章节、页码，含英文原文 + 中文释义 + 置信度 |

所有实体互相引用，形成闭合知识链：

```
Paper ─┬─→ Method ──→ Evidence ←── Evolution
       │      │                      │
       │      └──→ Relation ─────────┘
       │                             │
       └──→ Evidence ──→ Gap ──→ Direction
```

---

## 设计原则

**Evidence-First。** 数据模型在类型层面就强制建立引用关系：`Evidence` 必须锚定 `(paper_id, section, page, content)`，且声明它 `supports` 哪些结论类型。页面渲染任何结论时都能反向检索到证据。

**不编造关系。** `RelationType` 区分了"有证据的演进关系"（继承/改进/组合/替代）与"证据不足的保守标注"（相关/时间相邻）。UI 上用实线/虚线区分，并在图注中明确说明。

**识别本身就是有边界的。** 2025 年的演进节点明确标注为「AI 推断」，摘要中也会说明"2025 年趋势为推断"。产品不假装自己知道未来。

**先能跑起来。** 第一阶段优先保证页面完整、可跳转、有真实交互、能完整演示，而不是追求复杂架构。所有 AI 能力先用 Mock 数据模拟，但接口预留。

---

## 当前进展

**已完成**

- 全部 10 个页面 + 404，路由打通
- 内置 Demo 数据与闭合知识链（离线可用，无需任何后端配置）
- **真实链路**：上传 PDF → PyMuPDF 解析（章节/页码/元数据）→ AI 方法抽取 → 证据校验 → 落库
- **方法自动分类**（F1–F5 五类方法族，带依据与置信度）
- **技术演进重建**：三道门（句式 / 点名 / 归属）逐条判定，因果与时间相关严格区分
- **研究空白发现**：`stated`（原文自陈）与 `candidate`（系统推断）分层，推断必标注
- **研究方向推导**：由 Gap 自动传播，`stated_backed` / `candidate_only` 分层
- **调研报告**：六章结构化，每条陈述带 `kind` 与上游回链，支持 Markdown / PDF 导出
- 方法关系图（自绘 SVG）、Evidence 证据抽屉（全局可达）、Agent 分析流水线
- **四种 AI Provider**：`mock` / `showcase` / `http` / `cli`，一行环境变量切换
- **离线 Showcase 演示模式**：`AI_PROVIDER=showcase`，预置抽取 + 全部真实算法
- 加载 / 空 / 错误三态；响应式布局

**测试与验收**

- 21 个回归套件覆盖分析链路、方法对齐、技术演进、研究空白、研究方向、调研报告、UI 与 API
- `pnpm showcase:e2e` 一键验收离线演示全链路
- Evidence 全部可回到真实 paper / page / quote（独立回验，非自证）

**未完成（后续阶段）**

- 多人协作、权限、复杂知识图谱（P3，暂不开发）
- 更细的领域方法族划分（当前为 F1–F5 五类）

---

## 说明

**关于两类数据，必须区分清楚：**

1. **内置 Demo 数据**（`src/data/*.ts`）—— 论文为真实存在的计算机科学论文，
   标题、作者、会议为真实信息；摘要做了演示用压缩。用于 `/dashboard` 无需后端的开箱演示。

2. **真实上传链路** —— 上传 PDF 后，标题 / 作者 / 年份 / 章节 / 页码 / 原文证据
   **全部由 PyMuPDF 从 PDF 真实解析**，证据 quote 逐字取自原文并可回验。

`showcase` 模式只替换「方法抽取与分类」这一层的**判定结果**（相当于把领域专家的人工标注固化），
**证据本身仍逐字取自真实 PDF**，且后续所有算法一行不改。
