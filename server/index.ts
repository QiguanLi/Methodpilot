/**
 * MethodPilot API 服务端。
 *
 * 职责边界（第 3 节）：
 *   浏览器**永远不持有任何密钥**。它只与这个 Node 服务说话。
 *   真实的模型调用、PDF 解析、密钥读取全部发生在这里。
 *   所以前端 bundle 里搜不到 OPENAI_API_KEY / AI_API_KEY 之类的字符串，
 *   这是可验证的（scripts/verify-data.mjs 里有一条断言在查这个）。
 *
 * 零运行时依赖：只用 node: 内置模块。
 * 理由很实际——这个服务可能跑在评委的校园网机器上，
 * "pnpm install 卡在某个 native 依赖"是最不该出现的问题。
 */

import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { config, describeConfig, publicConfig, ROOT } from './config.ts'
import { store, jobStore } from './store/fileStore.ts'
import { handleAnalyze, handleUpload, handleClassify, handleFetchFulltext } from './routes/papers.ts'
import { handleAddMetaPaper, handleAddMetaPapersBatch } from './routes/explorer.ts'
import {
  handleS2Search,
  handleS2Paper,
  handleS2Graph,
  s2Status,
} from './routes/semanticScholar.ts'
import { pdfParser } from './services/pdf/parserClient.ts'
import { probeAIProvider } from './services/ai/index.ts'
import { selfTestNormalize } from './services/ai/evidenceValidator.ts'
import { alignMethods, summarizeAlignments } from './services/methodAlignment.ts'
import { buildEvolution, summarizeEvolutions } from './services/methodEvolution.ts'
import { detectGaps, assertGapInvariants } from './services/researchGaps.ts'
import { generateDirections, assertDirectionInvariants } from './services/researchDirections.ts'
import { buildResearchReport, assertReportInvariants } from './services/researchReport.ts'
import { selfTestLayout } from '../src/services/methodLayout.ts'
import { METHOD_EXTRACTION_PROMPT_VERSION } from './services/ai/prompt.ts'
import {
  matchPath,
  parseMultipart,
  readJson,
  sendErr,
  sendJson,
  splitUrl,
} from './utils/http.ts'
import type { ProjectRecord } from './store/fileStore.ts'

/* ------------------------------------------------------------------ */

const startedAt = Date.now()
const STATIC_DIR = path.join(ROOT, 'dist')

/* ------------------------------------------------------------------ */
/* 路由表                                                              */
/* ------------------------------------------------------------------ */

type Handler = (ctx: {
  params: Record<string, string>
  query: URLSearchParams
  req: http.IncomingMessage
  res: http.ServerResponse
}) => Promise<void> | void

interface Route {
  method: string
  pattern: string
  handler: Handler
}

const routes: Route[] = [
  /* ---------------- 健康检查 ---------------- */
  {
    method: 'GET',
    pattern: '/api/health',
    handler: async ({ res, query }) => {
      const deep = query.get('deep') === 'true'
      const ai = deep ? await probeAIProvider() : { ...(await probeAIProvider()) }
      const parser = deep ? await pdfParser.selfTest() : null
      const norm = selfTestNormalize()
      const layoutCheck = selfTestLayout()
      const layoutFailures = layoutCheck.filter((c) => !c.ok)

      sendJson(res, 200, {
        success: true,
        data: {
          status: 'ok',
          uptime_ms: Date.now() - startedAt,
          node: process.version,
          config: publicConfig(),
          ai: { provider: ai.provider, model: ai.model, ready: ai.ready, reason: ai.reason },
          pdfParser: parser ? { mode: config.pdf.mode, ...parser } : { mode: config.pdf.mode },
          evidenceValidator: { ok: norm.ok, failures: norm.failures },
          /*
           * 方法地图布局自测。
           * 它出过一个不报错的 bug：Live 方法的 family_id 是空字符串，
           * 伪族 id 却是 '__unclassified__'，于是画布全空而徽标照常显示"N 个方法"。
           * 类型系统查不出来，只有自测能拦。
           */
          methodLayout: {
            ok: layoutFailures.length === 0,
            total: layoutCheck.length,
            failures: layoutFailures.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ''}`),
          },
          promptVersion: METHOD_EXTRACTION_PROMPT_VERSION,
          /*
           * Semantic Scholar 状态。
           * 这里**只报 enabled / authenticated 两个布尔量**，
           * 绝不回传任何密钥内容——e2e 有一条断言在查
           * /api/health 不含 `api_key` 字样。
           */
          semanticScholar: s2Status(),
        },
      })
    },
  },

  /* ---------------- 项目 ---------------- */
  {
    method: 'GET',
    pattern: '/api/projects',
    handler: async ({ res }) => {
      const list = await store.listProjects()
      // 顺带回传每个项目的论文数，前端 Dashboard 不必再逐个请求
      const withCounts = await Promise.all(
        list.map(async (p) => {
          const b = await store.getBundle(p.id)
          return {
            ...p,
            paper_count: b?.papers.length ?? 0,
            method_count: b?.methods.length ?? 0,
            evidence_count: b?.evidence.length ?? 0,
          }
        }),
      )
      sendJson(res, 200, { success: true, data: withCounts })
    },
  },

  {
    method: 'POST',
    pattern: '/api/projects',
    handler: async ({ req, res }) => {
      const body = await readJson<Partial<ProjectRecord>>(req)
      const name = String(body.name ?? '').trim()
      if (!name) return sendErr(res, 400, 'INVALID_NAME', '项目名称不能为空')

      const id = `proj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const now = new Date().toISOString()
      const rec: ProjectRecord = {
        id,
        name,
        subtitle: String(body.subtitle ?? '').trim(),
        description: String(body.description ?? '').trim(),
        domain: String(body.domain ?? '').trim(),
        goal: String(body.goal ?? '').trim(),
        kind: 'uploaded',
        created_at: now,
        updated_at: now,
        paper_ids: [],
      }
      await store.createProject(rec)
      sendJson(res, 201, { success: true, data: rec })
    },
  },

  {
    method: 'GET',
    pattern: '/api/projects/:projectId',
    handler: async ({ params, res }) => {
      const b = await store.getBundle(params.projectId)
      if (!b) return sendErr(res, 404, 'PROJECT_NOT_FOUND', `项目 ${params.projectId} 不存在`)
      sendJson(res, 200, { success: true, data: b })
    },
  },

  /* ---------------- 论文 ---------------- */
  {
    method: 'GET',
    pattern: '/api/projects/:projectId/papers',
    handler: async ({ params, res }) => {
      const b = await store.getBundle(params.projectId)
      if (!b) return sendErr(res, 404, 'PROJECT_NOT_FOUND', `项目 ${params.projectId} 不存在`)
      sendJson(res, 200, { success: true, data: b.papers })
    },
  },

  {
    method: 'GET',
    pattern: '/api/projects/:projectId/methods',
    handler: async ({ params, query, res }) => {
      const b = await store.getBundle(params.projectId)
      if (!b) return sendErr(res, 404, 'PROJECT_NOT_FOUND', `项目 ${params.projectId} 不存在`)
      const scope = query.get('source_type')
      const methods = scope ? b.methods.filter((m) => m.source_type === scope) : b.methods
      sendJson(res, 200, { success: true, data: methods })
    },
  },

  {
    method: 'GET',
    pattern: '/api/projects/:projectId/evidence',
    handler: async ({ params, query, res }) => {
      const b = await store.getBundle(params.projectId)
      if (!b) return sendErr(res, 404, 'PROJECT_NOT_FOUND', `项目 ${params.projectId} 不存在`)
      const methodId = query.get('method_id')
      const paperId = query.get('paper_id')
      let list = b.evidence
      if (methodId) list = list.filter((e) => e.method_ids.includes(methodId))
      if (paperId) list = list.filter((e) => e.paper_id === paperId)
      sendJson(res, 200, { success: true, data: list })
    },
  },

  /**
   * 跨论文方法关系（Phase 4-3）。
   *
   * 调用 Phase 4-2 的纯函数 `alignMethods()`，把它的产出原样暴露给前端。
   *
   * ── 为什么这只是一层"只读包装"，不含任何判定逻辑 ──
   * 判定规则全部在 methodAlignment.ts 里，且那里是纯函数、有独立测试。
   * 如果在这里再补一句"顺便过滤掉 confidence 太低的"之类的逻辑，
   * 就会出现两套判定口径：测试验的是 A，用户看到的是 B。
   * 所以这里只做三件事：取数据、调函数、附统计。
   *
   * ── 关于"0 条候选" ──
   * 真实项目当前很可能返回 0 条（跨论文对齐需要至少两篇论文各有方法）。
   * 这是**正常结果**，不是错误：接口返回 200 + 空数组 + 统计，
   * 由前端显示 empty state。绝不能因为"没有数据"就报错或伪造关系。
   */
  {
    method: 'GET',
    pattern: '/api/projects/:projectId/method-alignments',
    handler: async ({ params, res }) => {
      const b = await store.getBundle(params.projectId)
      if (!b) return sendErr(res, 404, 'PROJECT_NOT_FOUND', `项目 ${params.projectId} 不存在`)

      const outcome = alignMethods({
        methods: b.methods,
        evidence: b.evidence,
        papers: b.papers,
      })

      sendJson(res, 200, {
        success: true,
        data: {
          candidates: outcome.candidates,
          stats: summarizeAlignments(outcome.candidates),
          /** 统计口径的上下文：为什么只有这么多候选，数字要能自解释 */
          context: {
            methods: b.methods.length,
            papers: b.papers.length,
            compared: outcome.compared,
            skipped_same_paper: outcome.skippedSamePaper,
            skipped_no_paper: outcome.skippedNoPaper,
          },
          rule_version: outcome.rule_version,
        },
      })
    },
  },

  /**
   * 技术演进候选链（Phase 4-4）。
   *
   * 链式依赖：先跑 Phase 4-2 的 `alignMethods()`，把它的 `candidates`
   * 作为 `alignments` 传给 `buildEvolution()`。
   *
   * ── 为什么必须走这条路，而不是让 4-4 自己算对齐 ──
   * "两个方法是不是同一个" 与 "谁演进了谁" 是**两个独立判断**，
   * 4-2 已经为前者建立了三道门与完整测试。让 4-4 自己再判一遍对齐，
   * 就会出现两套规则、两个答案。这里显式复用，保证全项目只有一处对齐口径。
   *
   * ── 关于空结果 ──
   * 真实项目当前大概率全是 `temporal`（每篇论文方法数少、且多在同一篇内）。
   * 这是**正常且诚实的结果**：接口照样 200，返回完整节点链 + 全部 temporal 边，
   * 由前端决定怎么呈现"有时间顺序但没有因果证据"。
   * 绝不能因为"没找到演进"就补一条假箭头 —— 那正是本功能最该避免的事。
   */
  {
    method: 'GET',
    pattern: '/api/projects/:projectId/evolutions',
    handler: async ({ params, res }) => {
      const b = await store.getBundle(params.projectId)
      if (!b) return sendErr(res, 404, 'PROJECT_NOT_FOUND', `项目 ${params.projectId} 不存在`)

      /* 复用 4-2 的对齐结果（判定规则只有一份，在这里） */
      const alignment = alignMethods({
        methods: b.methods,
        evidence: b.evidence,
        papers: b.papers,
      })

      const outcome = buildEvolution({
        methods: b.methods,
        evidence: b.evidence,
        papers: b.papers,
        alignments: alignment.candidates,
      })

      sendJson(res, 200, {
        success: true,
        data: {
          evolutions: outcome.evolutions,
          relations: outcome.relations,
          stats: summarizeEvolutions(outcome.relations, outcome.evolutions),
          /** 数字要能自解释：为什么链上有几个节点、几条边 */
          context: {
            methods: b.methods.length,
            papers: b.papers.length,
            /** 4-2 参与比较的方法数，用来解释 related 边为什么可能为 0 */
            aligned_compared: alignment.compared,
            /** 本模块剔除的"没有有效论文归属"的方法数 */
            skipped_no_paper: outcome.context.skipped_no_paper,
            rule_version: outcome.rule_version,
          },
        },
      })
    },
  },

  /**
   * 研究空白 Gap 检测（Phase 4-6）。
   *
   * 链式依赖：`alignMethods()` → `buildEvolution()` → `detectGaps()`。
   *
   * ── 为什么是三级链而不是让 4-6 自己算 ──
   * `detectGaps()` 要用到两样**别处已经算过**的东西：
   *   · 跨论文方法对齐（4-2）—— 判断"多篇论文是不是在说同一个方法"
   *   · 技术演进关系（4-4）—— 判断某条局限"后来是否已被解决"
   * 让 4-6 自己再判一遍，就会出现两套口径、两个答案。
   * 这里显式复用，全项目只有一处对齐规则、一处演进规则。
   *
   * ── 关于 0 条 Gap ──
   * 真实语料当前大概率只产出个位数的 `stated`、0 条 `candidate`
   * （candidate 需要 ≥2 篇论文指向同一语义坐标，前提往往不成立）。
   * 这是**正常且诚实的结果**：接口照样 200，`context.corpus_has_gap_intent`
   * 会告诉前端"语料里到底有没有人写过局限"。
   * 绝不能因为"没找到空白"就补一条 —— 那正是本功能最该避免的事。
   *
   * ── 不变量在运行时自检 ──
   * `assertGapInvariants()` 的结果随响应一起返回（`invariant_violations`）。
   * 正常情况下恒为空数组；一旦不为空，说明返回的数据自证不可信，
   * 前端能直接看到而不是等测试来发现。这与 4-4 把
   * `causal_without_evidence` 放进 stats 是同一个考虑。
   */
  {
    method: 'GET',
    pattern: '/api/projects/:projectId/gaps',
    handler: async ({ params, res }) => {
      const b = await store.getBundle(params.projectId)
      if (!b) return sendErr(res, 404, 'PROJECT_NOT_FOUND', `项目 ${params.projectId} 不存在`)

      /* 复用 4-2 的对齐结果（判定规则只有一份，在这里） */
      const alignment = alignMethods({
        methods: b.methods,
        evidence: b.evidence,
        papers: b.papers,
      })

      /* 复用 4-4 的演进结果（同样只有一份） */
      const evolution = buildEvolution({
        methods: b.methods,
        evidence: b.evidence,
        papers: b.papers,
        alignments: alignment.candidates,
      })

      const outcome = detectGaps({
        papers: b.papers,
        methods: b.methods,
        evidence: b.evidence,
        alignments: alignment.candidates,
        evolutionRelations: evolution.relations,
      })

      sendJson(res, 200, {
        success: true,
        data: {
          gaps: outcome.gaps,
          stats: outcome.stats,
          /**
           * 自解释的上下文。0 条 Gap 时前端要靠它区分
           * "语料里没人写过局限" 与 "写了但没够成 Gap"。
           */
          context: {
            ...outcome.context,
            rule_version: outcome.rule_version,
          },
          /** 必须恒为空数组 —— 与 4-4 的 causal_without_evidence 同款运行时自检 */
          invariant_violations: assertGapInvariants(outcome),
        },
      })
    },
  },

  /**
   * 研究方向（第 4-7 节）。
   *
   * 与 `/gaps` 是**同一条链的下游**：4-2 对齐 → 4-4 演进 → 4-6 空白 → 4-7 方向。
   * 前三步在这里原样复算，而不是把 /gaps 的结果缓存起来 ——
   * 判定规则只能有一份，重复调用是幂等的纯函数，代价远小于引入一份可能过期的缓存。
   *
   * 只做「取数据 / 调函数 / 附统计」三件事，**不加任何过滤或排序**。
   * 一旦这里也排一次序，就会形成第二套口径，前端与服务端迟早不一致。
   */
  {
    method: 'GET',
    pattern: '/api/projects/:projectId/directions',
    handler: async ({ params, res }) => {
      const b = await store.getBundle(params.projectId)
      if (!b) return sendErr(res, 404, 'PROJECT_NOT_FOUND', `项目 ${params.projectId} 不存在`)

      /* 复用 4-2 的对齐结果（判定规则只有一份，在这里） */
      const alignment = alignMethods({
        methods: b.methods,
        evidence: b.evidence,
        papers: b.papers,
      })

      /* 复用 4-4 的演进结果（同样只有一份） */
      const evolution = buildEvolution({
        methods: b.methods,
        evidence: b.evidence,
        papers: b.papers,
        alignments: alignment.candidates,
      })

      /* 复用 4-6 的空白结果 */
      const gapsOutcome = detectGaps({
        papers: b.papers,
        methods: b.methods,
        evidence: b.evidence,
        alignments: alignment.candidates,
        evolutionRelations: evolution.relations,
      })

      const input = {
        gaps: gapsOutcome.gaps,
        methods: b.methods,
        evidence: b.evidence,
        papers: b.papers,
        evolutionRelations: evolution.relations,
      }

      const outcome = generateDirections(input)

      sendJson(res, 200, {
        success: true,
        data: {
          directions: outcome.directions,
          stats: outcome.stats,
          /**
           * 自解释的上下文。0 条方向时前端要靠它区分
           * "语料里没有 Gap" 与 "有 Gap 但不足以支撑方向"。
           */
          context: {
            ...outcome.context,
            rule_version: outcome.rule_version,
          },
          /**
           * 运行时自检 —— 恒为空数组。
           *
           * `input` 必须传：不变量要校验「方向的证据是其 Gap 证据的子集」
           * 与「切入点方法确实来自项目方法池」，没有 input 这两条无从判断。
           */
          invariant_violations: assertDirectionInvariants(outcome, input),
        },
      })
    },
  },

  /**
   * 调研报告（第 4-8 节）。
   *
   * 与 `/gaps`、`/directions` 是**同一条链的最下游**：
   *   4-2 对齐 → 4-4 演进 → 4-6 空白 → 4-7 方向 → 4-8 报告。
   * 前四步在这里原样复算，理由与上面两个接口完全一致 ——
   * 判定规则只能有一份，重复调用是幂等的纯函数，代价远小于引入一份可能过期的缓存。
   *
   * ⚠️ 报告是**编排**，不是判定：它不产生任何新的事实判断，
   * 只做搬运 / 计数 / 措辞三件事。所以这里除了"取数据 / 调函数 / 附自检"
   * 之外什么都不做，**不加任何过滤、排序或补全**。
   *
   * `assertReportInvariants(report, input)` 的第二个参数必须传：
   * 不变量要校验"每条回链都能在输入池里解析到"以及"章节口径与上游 stats 一致"，
   * 没有 input 这两类问题无从判断。
   */
  {
    method: 'GET',
    pattern: '/api/projects/:projectId/report',
    handler: async ({ params, res }) => {
      const b = await store.getBundle(params.projectId)
      if (!b) return sendErr(res, 404, 'PROJECT_NOT_FOUND', `项目 ${params.projectId} 不存在`)

      /* 复用 4-2 的对齐结果（判定规则只有一份，在这里） */
      const alignment = alignMethods({
        methods: b.methods,
        evidence: b.evidence,
        papers: b.papers,
      })

      /* 复用 4-4 的演进结果 */
      const evolution = buildEvolution({
        methods: b.methods,
        evidence: b.evidence,
        papers: b.papers,
        alignments: alignment.candidates,
      })

      /* 复用 4-6 的空白结果 */
      const gaps = detectGaps({
        papers: b.papers,
        methods: b.methods,
        evidence: b.evidence,
        alignments: alignment.candidates,
        evolutionRelations: evolution.relations,
      })

      /* 复用 4-7 的方向结果 */
      const directions = generateDirections({
        gaps: gaps.gaps,
        methods: b.methods,
        evidence: b.evidence,
        papers: b.papers,
        evolutionRelations: evolution.relations,
      })

      /*
       * 报告输入 = 前四步的**完整 Outcome**（不是只要数组）。
       * 报告要靠上游的 stats / context 才知道"0 条是因为语料里没有"
       * 而不是"检测失败"—— 见 researchReport.ts 的 ReportInput 注释。
       */
      const input = {
        papers: b.papers,
        methods: b.methods,
        evidence: b.evidence,
        alignment,
        evolution,
        gaps,
        directions,
      }

      const report = buildResearchReport(input)

      sendJson(res, 200, {
        success: true,
        data: {
          report,
          /**
           * 运行时自检 —— 恒为空数组。
           *
           * 与 4-4 的 causal_without_evidence、4-6 的 gaps_without_evidence 同款：
           * 把不变量放到**响应里**而不是只放在测试里，这样线上每一次调用
           * 都在自证"没有悬空回链 / 没有把推断写成事实"。
           */
          invariant_violations: assertReportInvariants(report, input),
        },
      })
    },
  },

  {
    method: 'GET',
    pattern: '/api/papers/:paperId',
    handler: async ({ params, query, res }) => {
      const projectId = query.get('project_id')
      if (!projectId) return sendErr(res, 400, 'MISSING_PROJECT', '缺少 project_id 查询参数')

      const b = await store.getBundle(projectId)
      if (!b) return sendErr(res, 404, 'PROJECT_NOT_FOUND', `项目 ${projectId} 不存在`)
      const paper = b.papers.find((p) => p.paper_id === params.paperId)
      if (!paper) return sendErr(res, 404, 'PAPER_NOT_FOUND', `论文 ${params.paperId} 不存在`)

      const methods = b.methods.filter((m) => m.paper_ids.includes(paper.paper_id))
      const evidence = b.evidence.filter((e) => e.paper_id === paper.paper_id)
      sendJson(res, 200, { success: true, data: { paper, methods, evidence } })
    },
  },

  {
    method: 'GET',
    pattern: '/api/papers/:paperId/pdf',
    handler: async ({ params, query, res }) => {
      const projectId = query.get('project_id')
      if (!projectId) return sendErr(res, 400, 'MISSING_PROJECT', '缺少 project_id 查询参数')

      const b = await store.getBundle(projectId)
      const paper = b?.papers.find((p) => p.paper_id === params.paperId)
      if (!paper) return sendErr(res, 404, 'PAPER_NOT_FOUND', `论文 ${params.paperId} 不存在`)

      // 用 paper.file_hash 定位，而不是相信任何来自 URL 的路径片段——
      // 否则 /api/papers/x/pdf 就能变成任意文件读取
      const filePath = path.join(
        config.storage.uploadDir,
        paper.file_hash.slice(0, 16),
        paper.file_name.replace(/[^\w.\-()\u4e00-\u9fa5]/g, '_').slice(0, 120),
      )
      if (!existsSync(filePath)) return sendErr(res, 404, 'PAPER_FILE_MISSING', '原始 PDF 已不在服务端')

      const buf = await fsp.readFile(filePath)
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': buf.length,
        // inline 让浏览器内嵌预览，而不是下载
        'Content-Disposition': `inline; filename="${encodeURIComponent(paper.file_name)}"`,
        'Access-Control-Allow-Origin': '*',
      })
      res.end(buf)
    },
  },

  {
    method: 'POST',
    pattern: '/api/papers/:paperId/analyze',
    handler: async ({ params, req, res }) => {
      const body = await readJson<{ project_id?: string; force?: boolean }>(req)
      const projectId = body.project_id ?? config.defaultProjectId
      const r = await handleAnalyze(projectId, params.paperId, { force: body.force })
      sendJson(res, r.status, r.body)
    },
  },

  {
    method: 'POST',
    pattern: '/api/papers/:paperId/classify',
    handler: async ({ params, req, res }) => {
      /**
       * 阶段③ 方法分类，可独立重跑。
       *
       * 与 /analyze 的关键区别：不会有副作用地重跑解析和抽取。
       * 它只读已入库的方法与已校验证据，写回 family_id / reason / evidence_ids。
       * 所以这个接口可以随便点，不会产生重复的 Method。
       */
      const body = await readJson<{ project_id?: string }>(req)
      const projectId = body.project_id ?? config.defaultProjectId
      const r = await handleClassify(projectId, params.paperId)
      sendJson(res, r.status, r.body)
    },
  },

  {
    method: 'GET',
    pattern: '/api/jobs/:jobId',
    handler: async ({ params, res }) => {
      const job = jobStore.get(params.jobId)
      if (!job) return sendErr(res, 404, 'JOB_NOT_FOUND', `任务 ${params.jobId} 不存在`)
      sendJson(res, 200, { success: true, data: job })
    },
  },

  {
    method: 'GET',
    pattern: '/api/projects/:projectId/jobs',
    handler: async ({ params, res }) => {
      sendJson(res, 200, { success: true, data: jobStore.listByProject(params.projectId) })
    },
  },

  /* ---------------- Semantic Scholar（阶段③B-1） ---------------- */
  /**
   * 四个能力：search / paper detail / references / citations。
   *
   * 顺序有讲究：`/api/s2/paper/:paperId` 必须放在
   * `/api/s2/paper/:paperId/references` 之类的**后面**吗？不需要——
   * matchPath 是按段数精确匹配的（见 utils/http.ts），
   * 两段和三段不会互相吞。这里把更具体的放前面只是可读性考虑。
   */
  {
    method: 'GET',
    pattern: '/api/s2/search',
    handler: async ({ query, res }) => {
      const r = await handleS2Search(
        query.get('q') ?? '',
        query.get('limit'),
        // ?parse=false 可关掉自然语言拆解，用于对比"原句直搜"的效果
        query.get('parse'),
      )
      sendJson(res, r.status, r.body)
    },
  },

  {
    method: 'GET',
    pattern: '/api/s2/paper/:paperId/references',
    handler: async ({ params, query, res }) => {
      const r = await handleS2Graph(params.paperId, 'references', query.get('limit'))
      sendJson(res, r.status, r.body)
    },
  },

  {
    method: 'GET',
    pattern: '/api/s2/paper/:paperId/citations',
    handler: async ({ params, query, res }) => {
      const r = await handleS2Graph(params.paperId, 'citations', query.get('limit'))
      sendJson(res, r.status, r.body)
    },
  },

  {
    method: 'GET',
    pattern: '/api/s2/paper/:paperId',
    handler: async ({ params, res }) => {
      const r = await handleS2Paper(params.paperId)
      sendJson(res, r.status, r.body)
    },
  },

  {
    method: 'GET',
    pattern: '/api/config',
    handler: ({ res }) => {
      // 只回白名单字段。aiReady=false 时前端会把阶段①②显示成"降级"而不是 LIVE。
      sendJson(res, 200, { success: true, data: publicConfig() })
    },
  },
]

/* ------------------------------------------------------------------ */
/* 上传分流                                                            */
/* ------------------------------------------------------------------ */

async function handleUploadRoute(
  url: string,
  projectId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const contentType = String(req.headers['content-type'] ?? '')

  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return sendErr(res, 415, 'UNSUPPORTED_CONTENT_TYPE', '上传接口只接受 multipart/form-data')
  }

  const chunks: Buffer[] = []
  let size = 0
  const MAX = 120 * 1024 * 1024
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX) return sendErr(res, 413, 'PAYLOAD_TOO_LARGE', '上传体积超出服务端上限')
    chunks.push(c as Buffer)
  }

  const parsed = parseMultipart(Buffer.concat(chunks), contentType)
  if (!parsed) return sendErr(res, 400, 'BAD_MULTIPART', '无法解析上传表单，请重试')

  const fileParts = parsed.files.filter((f) => f.field === 'file' || f.field === 'files' || f.filename)
  if (!fileParts.length) return sendErr(res, 400, 'NO_FILE', '请求里没有文件字段（应为 file）')

  const r = await handleUpload(projectId, fileParts, parsed.fields)
  sendJson(res, r.status, r.body)
}

/* ------------------------------------------------------------------ */
/* 静态资源（生产模式：直接服务 dist/）                                  */
/* ------------------------------------------------------------------ */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

async function serveStatic(urlPath: string, res: http.ServerResponse): Promise<boolean> {
  if (!existsSync(STATIC_DIR)) return false

  const clean = urlPath.split('?')[0]
  const rel = clean === '/' || clean === '' ? 'index.html' : clean.replace(/^\/+/, '')

  /**
   * 候选路径，按优先级依次尝试。
   *
   * ── 为什么要有"后缀回退" ──
   * 演示环境经常通过**子路径反代**暴露服务，例如 CloudStudio 预览面板给的是
   *     http://127.0.0.1:38699/sandbox-preview/45:/
   * 此时浏览器请求的资源路径是 `/sandbox-preview/45:/assets/index-xxx.js`。
   * 若只按整段路径去 dist/ 找，必然找不到 → 落到 SPA fallback → 返回 HTML，
   * 于是浏览器报 "Expected a JavaScript module script but ... text/html" → 白屏。
   *
   * 解决：先按完整路径找；找不到时，**从路径中截出真正的 dist 内相对路径**
   * （即以 assets/ 、favicon.svg 等开头的后缀）再试一次。
   * 这样无论被挂在根路径还是任意子路径下，静态资源都能命中。
   *
   * 注意目录穿越防护对**每一个候选**都生效（见下方 startsWith 检查），
   * 不会因为多了候选路径而放宽。
   */
  const candidates: string[] = [rel]
  // 后缀回退：找出以顶层资源目录/文件开头的部分（assets/… 、favicon.svg 等）
  const m = rel.match(/(?:^|\/)(assets\/.+|favicon\.svg|icons\.svg)$/)
  if (m && m[1] !== rel) candidates.push(m[1])

  for (const cand of candidates) {
    const target = path.join(STATIC_DIR, cand)
    // 防目录穿越：拼接后的真实路径必须仍在 dist 内
    if (!target.startsWith(STATIC_DIR)) {
      sendErr(res, 403, 'FORBIDDEN', '非法路径')
      return true
    }
    try {
      const buf = await fsp.readFile(target)
      /**
       * 缓存策略（踩坑记录）：
       * - index.html 必须 no-store。曾因无缓存头，浏览器按启发式缓存
       *   拿着旧 bundle 引用的 HTML，服务端修完 bug 用户端仍复现旧症状，
       *   只有强制刷新才恢复。HTML 只有几百字节，每次都取没有代价。
       * - /assets/* 文件名带内容哈希（index-BGvDopT4.js），内容一变名字
       *   就变，可以放心 immutable 缓存一年。
       * - 其他顶层文件（favicon 等）短缓存。
       */
      const cacheControl = target.endsWith('.html')
        ? 'no-store'
        : cand.startsWith('assets/')
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600'
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': cacheControl,
      })
      res.end(buf)
      return true
    } catch {
      /* 试下一个候选 */
    }
  }

  // SPA fallback：非 /api 的未命中路径交给前端路由（/projects/xxx 直接刷新也能打开）
  try {
    const index = await fsp.readFile(path.join(STATIC_DIR, 'index.html'))
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': index.length,
      // HTML 不允许缓存（理由见上方缓存策略注释）
      'Cache-Control': 'no-store',
    })
    res.end(index)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  void (async () => {
    const { path: rawPath, query } = splitUrl(req.url ?? '/')
    /**
     * 子路径反代兼容：剥掉代理加的前缀。
     *
     * 演示环境可能通过子路径反代暴露服务（CloudStudio 预览面板给的是
     * `http://127.0.0.1:38699/sandbox-preview/45:/`）。此时后端收到的是
     * `/sandbox-preview/45:/api/health` 而不是 `/api/health`，
     * 路由与静态资源都会全部失效（表现为白屏 + API 404）。
     *
     * 处理方式：在路径中定位真正的起点 —— `/api/` 或顶层资源段
     * （`assets/`、`favicon.svg`、`icons.svg`），把其之前的前缀砍掉。
     * 找不到标记就原样使用，因此直连根路径的行为完全不变。
     */
    const marker = rawPath.match(/\/(api\/|assets\/|favicon\.svg|icons\.svg)/)
    const urlPath = marker ? rawPath.slice(marker.index) : rawPath
    const method = req.method ?? 'GET'

    // CORS 预检
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Max-Age': '86400',
      })
      res.end()
      return
    }

    // 上传单独走，因为它需要未经解析的原始 body
    const up = matchPath('/api/projects/:projectId/papers', urlPath)
    if (up && method === 'POST') {
      try {
        return await handleUploadRoute(req.url ?? '', up.params.projectId, req, res)      } catch (e) {
        return sendErr(res, 500, 'UPLOAD_FAILED', humanize(e))
      }
    }

    /*
     * 「批量加入当前项目」（Phase 3B-6）。
     *
     * 必须先于下面那条单条 `/papers/meta` 注册。
     * 原因：matchPath 要求**段数相等**，`/papers/meta` 和
     * `/papers/meta/batch` 段数不同，本身不会互相误吞——
     * 但把更具体的路径放在前面是一条便宜的保险：
     * 将来若有人改了匹配策略（比如加通配），先匹配长的总是对的。
     */
    /*
     * 「获取全文」（Phase 3B-7）。
     *
     * 与上传路由 `/papers` 段数不同（这里是 5 段：projects/:pid/papers/:paperId/fetch-fulltext），
     * matchPath 要求段数相等，所以不会互相误吞。放在通用路由表之前，
     * 与上面几条同一条规矩：越具体的路径越先注册。
     */
    const fetchFull = matchPath('/api/projects/:projectId/papers/:paperId/fetch-fulltext', urlPath)
    if (fetchFull && method === 'POST') {
      const r = await handleFetchFulltext(fetchFull.params.projectId, fetchFull.params.paperId)
      return sendJson(res, r.status, r.body)
    }

    const metaBatch = matchPath('/api/projects/:projectId/papers/meta/batch', urlPath)
    if (metaBatch && method === 'POST') {
      const r = await handleAddMetaPapersBatch(metaBatch.params.projectId, req)
      return sendJson(res, r.status, r.body)
    }

    /*
     * 「加入当前项目」（Phase 3B-2）。
     *
     * 注意它必须排在通用路由表循环**之前**，而且路径比上传多一段
     * `/meta`——matchPath 是按段匹配的，`/papers` 不会误吞 `/papers/meta`，
     * 但显式分开处理能让"两种输入口"这件事在代码里也看得见：
     * 上面那条收字节流，下面这条收 JSON。
     */
    const meta = matchPath('/api/projects/:projectId/papers/meta', urlPath)
    if (meta && method === 'POST') {
      const r = await handleAddMetaPaper(meta.params.projectId, req)
      return sendJson(res, r.status, r.body)
    }

    for (const r of routes) {
      if (r.method !== method) continue
      const m = matchPath(r.pattern, urlPath)
      if (!m) continue
      try {
        return await r.handler({ params: m.params, query, req, res })
      } catch (e) {
        // 任何未捕获异常都收敛成统一错误结构，绝不让连接悬着
        return sendErr(res, 500, 'INTERNAL', humanize(e))
      }
    }

    if (urlPath.startsWith('/api/')) {
      return sendErr(res, 404, 'NOT_FOUND', `接口不存在：${method} ${urlPath}`)
    }

    if (await serveStatic(urlPath, res)) return
    sendErr(res, 404, 'NOT_FOUND', '未找到该路径')
  })().catch((e) => {
    try {
      sendErr(res, 500, 'INTERNAL', humanize(e))
    } catch {
      /* 响应已发出，忽略 */
    }
  })
})

const humanize = (e: unknown) => (e instanceof Error ? e.message : String(e))

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

export interface StartResult {
  port: number
  url: string
}

export function startServer(port = config.port): Promise<StartResult> {
  return new Promise((resolve) => {
    server.listen(port, config.host, () => {
      const actual = (server.address() as { port: number }).port
      resolve({ port: actual, url: `http://127.0.0.1:${actual}` })
    })
  })
}

export { server }

/* 仅在直接运行时才监听（被测试 import 时不启动） */
const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (isMain) {
  await store.ensureReady()
  console.log('─'.repeat(58))
  console.log(describeConfig())
  console.log('─'.repeat(58))
  const { url } = await startServer()
  console.log(`MethodPilot API 已启动：${url}`)
  console.log(`健康检查：${url}/api/health?deep=true`)
  if (existsSync(STATIC_DIR)) console.log(`已检测到 dist/，前端可直接访问 ${url}`)
  else console.log('未检测到 dist/，开发时请另开 `pnpm dev`（Vite 已配置 /api 代理）')
}
