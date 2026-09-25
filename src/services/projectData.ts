/**
 * 项目数据源 —— Demo 与真实上传项目的统一读取层。
 *
 * 这一层要解决的核心问题是**隔离**（第 26 节）：
 *   Demo 项目的数据全部来自知识库里的静态 Mock 数据；
 *   用户新建的项目数据全部来自服务端真实分析结果。
 *   两者绝不能混在一起——否则评审看到的方法地图上，
 *   一半是演示数据一半是真实抽取结果，却无法分辨，整个可信度就没了。
 *
 * 做法：
 *   - 每个数据集都带 source 标记（'demo' | 'live'）。
 *   - 页面拿到的是「一个数据集」，而不是「两个来源的并集」。
 *   - 需要双源同现的场合（比如 Dashboard 的汇总）显式分别展示并标注。
 *
 * 判断依据是 project.kind（服务端返回 'demo' | 'uploaded'），
 * 而不是猜 projectId 的格式——猜格式迟早会猜错。
 */

import type {
  Evidence,
  KnowledgeBase,
  Method,
  MethodFamily,
  MethodParadigm,
  Paper,
  PaperStatus,
} from '@/types'
import { knowledgeBase, families as demoFamilies } from '@/data'
import { api } from './api'
import type { ServerEvidence, ServerMethod, ServerPaper, ServerProject } from './api'

export type DataSource = 'demo' | 'live'

export interface ProjectDataset {
  source: DataSource
  project: {
    id: string
    name: string
    subtitle: string
    description: string
    domain: string
    goal: string
  }
  papers: Paper[]
  methods: Method[]
  evidence: Evidence[]
  /** Demo 项目才有：方法族/演进/空白/方向仍是 Mock（第 24/40 节） */
  knowledgeBase: KnowledgeBase | null
  /** Live 项目才有：原始服务端对象，便于看溯源字段 */
  raw: {
    papers: ServerPaper[]
    methods: ServerMethod[]
    evidence: ServerEvidence[]
  } | null
}

/* ------------------------------------------------------------------ */
/* Demo 数据集                                                        */
/* ------------------------------------------------------------------ */

export const DEMO_PROJECT_ID = 'proj-aicoding-agent'

export function demoDataset(): ProjectDataset {
  return {
    source: 'demo',
    project: {
      id: DEMO_PROJECT_ID,
      name: knowledgeBase.project.name,
      subtitle: knowledgeBase.project.subtitle,
      description: knowledgeBase.project.description,
    domain: knowledgeBase.project.domain,
    goal: knowledgeBase.project.goal ?? '',
    },
    papers: knowledgeBase.papers,
    methods: knowledgeBase.methods,
    evidence: knowledgeBase.evidence,
    knowledgeBase,
    raw: null,
  }
}

/* ------------------------------------------------------------------ */
/* 服务端 → 前端类型映射                                              */
/* ------------------------------------------------------------------ */

/**
 * 服务端状态 → 前端状态。
 *
 * 两边的状态机刻意不同：
 *   服务端关心"我处理到哪一步了"（uploaded/parsing/parsed/extracting/validated/completed/failed）
 *   前端只需要知道"能不能展示"（pending/parsing/analyzed/failed）
 * 所以这里做一次显式映射，而不是让前端页面去认识 7 个服务端状态。
 */
function mapPaperStatus(s: string): PaperStatus {
  switch (s) {
    case 'completed':
    case 'validated':
      return 'analyzed'
    case 'failed':
      return 'failed'
    case 'parsing':
    case 'extracting':
    case 'parsed':
      return 'parsing'
    default:
      return 'pending'
  }
}

function mapPaper(p: ServerPaper): Paper {
  /*
   * 仅元数据论文（Phase 3B-2）：从 file_hash 的 meta: 前缀识别。
   *
   * DOI / 引用数 / 链接由服务端塞在 keywords 里（见 metaPaper.ts 的说明：
   * 加字段要迁移所有既有 papers.json，写进既有字段则零迁移）。
   * 这里把它们挖出来还原成结构化字段，让界面不必知道那个折衷的存在。
   *
   * `关键词:` 是关键词的原有格式，必须排除，否则会被当成元信息解析。
   */
  const isMeta = (p.file_hash ?? '').startsWith('meta:')
  const metaOf = (prefix: string) =>
    p.keywords.find((k) => k.startsWith(prefix))?.slice(prefix.length).trim() ?? ''

  return {
    paper_id: p.paper_id,
    // 标题为空时显示文件名，而不是空字符串——
    // 解析失败时用户至少要知道是哪个文件失败了
    title: p.title || p.file_name,
    authors: p.authors,
    year: p.year,
    venue: isMeta ? metaOf('venue:') : '',
    abstract: p.abstract || (isMeta ? metaOf('摘要：') : ''),
    keywords: p.keywords.filter((k) => !/^(摘要：|DOI:|引用数:|venue:|链接:|关键词:)/.test(k)),
    task: '',
    source: p.file_name,
    status: mapPaperStatus(p.status),
    evidence_count: p.evidence_count,
    method_ids: p.method_ids,
    related_paper_ids: [],
    sections: p.sections.map((s) => ({
      name: s.name,
      page: s.page,
      summary: s.summary,
    })),
    meta_only: isMeta,
    citation_count: isMeta ? Number(metaOf('引用数:')) || 0 : undefined,
    doi: isMeta ? metaOf('DOI:') || undefined : undefined,
    external_url: isMeta ? metaOf('链接:') || undefined : undefined,
  }
}

const PARADIGMS = new Set<string>([
  'Prompting',
  'Fine-tuning',
  'Agent',
  'Multi-Agent',
  'Tool-Augmented',
  'Neuro-Symbolic',
])

function mapMethod(m: ServerMethod): Method {
  return {
    method_id: m.method_id,
    name: m.name,
    name_zh: m.name_zh,
    /**
     * family_id 由阶段③ 的真实 LLM 分类写入（'F1'..'F5'），
     * 空字符串表示**分类跑过了、但判定为无法可靠归类**。
     * 这里一律照实传递，不做任何回填或猜测。
     *
     * classification 为 null 则是另一种情况：还没跑过分类。
     * 两者在界面上必须能区分（见 MethodsPage 的提示文案）。
     */
    family_id: m.family_id,
    classification: m.classification ?? null,
    task: m.task,
    paradigm: (PARADIGMS.has(m.paradigm) ? m.paradigm : 'Prompting') as MethodParadigm,
    year: m.year,
    core_idea: m.core_idea,
    modules: m.modules,
    inputs: m.inputs,
    outputs: m.outputs,
    capabilities: m.capabilities,
    advantages: m.advantages,
    limitations: m.limitations,
    paper_ids: m.paper_ids,
    evidence_ids: m.evidence_ids,
    layer: m.layer,
  }
}

function mapEvidence(e: ServerEvidence): Evidence {
  return {
    evidence_id: e.evidence_id,
    paper_id: e.paper_id,
    section: e.section,
    page: e.page,
    content: e.content,
    translation: e.translation,
    supports: e.supports as Evidence['supports'],
    confidence: e.confidence,
    method_ids: e.method_ids,
    gap_ids: e.gap_ids,
    direction_ids: e.direction_ids,
  }
}

/* ------------------------------------------------------------------ */
/* 加载                                                               */
/* ------------------------------------------------------------------ */

export interface LoadResult {
  dataset: ProjectDataset
  /** 真实项目里是否有可展示的 AI 产出（用于决定是否显示"分析中/无数据"空态） */
  hasLiveData: boolean
}

/**
 * 按 projectId 加载数据集。
 *
 * 这里有一条关键判断：**如果服务端有同名项目，就以它为准**，
 * 因为它一定是用户真实创建的（kind='uploaded'）。
 * 服务端不可能返回 kind='demo' 的项目——Mock 数据只在浏览器里，
 * 从不上传到服务端。所以"服务端能找到"本身就等价于"这是真实项目"。
 */
export async function loadDataset(projectId: string): Promise<LoadResult> {
  // Demo 项目走本地，不发请求：这样即使服务端没起来，Demo 依然可完整演示
  if (projectId === DEMO_PROJECT_ID) {
    return { dataset: demoDataset(), hasLiveData: true }
  }

  const bundle = await api.getProject(projectId)
  const dataset: ProjectDataset = {
    source: 'live',
    project: {
      id: bundle.project.id,
      name: bundle.project.name,
      subtitle: bundle.project.subtitle,
      description: bundle.project.description,
      domain: bundle.project.domain,
      goal: bundle.project.goal,
    },
    papers: bundle.papers.map(mapPaper),
    methods: bundle.methods.map(mapMethod),
    evidence: bundle.evidence.map(mapEvidence),
    // 阶段④⑤⑥（演进/空白/方向）仍是 MOCK。真实项目**不继承** Demo 的
    // 方法族归属/演进/空白/方向，否则演示数据会伪装成"对这篇论文的分析结论"。
    // 页面会显示 MOCK 提示。
    //
    // 注意：方法族**清单**走 FAMILY_TAXONOMY，不走这里。理由见其注释——
    // 清单是分类标尺（可复用），归属是结论（不可复用）。
    knowledgeBase: null,
    raw: {
      papers: bundle.papers,
      methods: bundle.methods,
      evidence: bundle.evidence,
    },
  }

  return {
    dataset,
    hasLiveData: bundle.papers.length > 0,
  }
}

/** 列出服务端上的真实项目（不含 Demo） */
export async function listLiveProjects(): Promise<ServerProject[]> {
  const list = await api.listProjects()
  // 防御：万一服务端也存了一个 demo 项目，不要在"我的项目"里重复展示
  return list.filter((p) => p.kind !== 'demo')
}

/* ------------------------------------------------------------------ */
/* 当前数据集注册表                                                   */
/* ------------------------------------------------------------------ */

/**
 * 为什么需要这个注册表？
 *
 * EvidenceDrawer 与 AIAssistant 挂在 <Routes> 之外（App.tsx 里是全局浮层），
 * 它们拿不到页面级的 dataset，只能按 evidence_id 反查。
 * 而 Demo 的 E001 和真实项目的 E001 是两个完全不同的东西——
 * 如果抽屉继续走浏览器内的 Mock 查询函数，
 * 点开真实项目的证据会显示一篇演示论文的原文，这是最恶劣的一种错误：
 * 看起来一切正常，实际张冠李戴。
 *
 * 所以页面加载完数据集后往这里注册一份，全局浮层优先从这里查。
 * 只保留"当前正在看的项目"，避免多个项目的数据在内存里互相污染。
 */
let currentDataset: ProjectDataset | null = null

/** 由页面在数据就绪后调用。Demo 项目也会注册（它同样不能被猜出来）。 */
export function registerDataset(d: ProjectDataset | null): void {
  currentDataset = d
}

export function getRegisteredDataset(): ProjectDataset | null {
  return currentDataset
}

/** 按 id 从已注册数据集里查找，找不到返回 undefined（而不是回落到 Demo 数据） */
export function findRegisteredEvidence(evidenceId: string) {
  return currentDataset?.evidence.find((e) => e.evidence_id === evidenceId)
}

export function findRegisteredMethod(methodId: string) {
  return currentDataset?.methods.find((m) => m.method_id === methodId)
}

export function findRegisteredPaper(paperId: string) {
  return currentDataset?.papers.find((p) => p.paper_id === paperId)
}

/** 真实项目里没有方法族/空白/方向——阶段③④⑤⑥仍是 MOCK，一律返回空 */
export function registeredFamilies() {
  return currentDataset?.knowledgeBase?.families ?? []
}

/**
 * 分类体系（5 个方法族）—— 供 **Live 项目** 的方法地图使用。
 *
 * ── 为什么真实项目可以用这 5 个族，而知识库里的其他东西不能 ──
 *
 * 这条边界必须说清楚，否则就成了"Demo 数据泄漏进真实项目"。
 *
 * 不能复用的：Demo 的 papers / methods / evidence / relations / gaps / directions。
 *   它们是**结论**——"M001 这个方法的证据是 E001""M005 演进到 M008"。
 *   把结论套到用户上传的论文上，就是编造。
 *
 * 可以复用的：方法族**清单本身**（有哪 5 个族、各自的判据是什么）。
 *   它是**分类标尺**，不是对某篇论文的结论。真实项目用同一把尺子
 *   去量自己的方法，恰恰是要求 1（使用现有 5 个 Method Family）的原话。
 *
 * 关键区别在于：族标签挂到哪个方法上，**完全由服务端的真实 LLM 分类决定**，
 * 与 Demo 里 M001..M019 的归属毫无关系。这里的 method_ids 一律清空，
 * 只是为了让 layout 拿到颜色和名字。
 */
export const FAMILY_TAXONOMY: MethodFamily[] = demoFamilies.map((f) => ({
  ...f,
  // 清空演示归属：真实方法谁属于哪个族，由服务端分类结果说了算
  method_ids: [],
}))

/** 一篇论文实际使用的抽取引擎。未记录时返回 null，调用方必须照实显示 */
export interface RegisteredEngine {
  provider: string
  model: string
  promptVersion: string
  /** 是否真实大模型产出。mock 表示服务端内置的确定性规则引擎 */
  real: boolean
}

/**
 * 反查某篇论文的抽取引擎。
 *
 * 必须读 `raw.papers` 而不是 `papers`：后者是给列表 UI 用的映射结果，
 * 映射时把 analyzed_with 丢掉了。这里宁可多绕一层，
 * 也不让"这个结论是谁算出来的"这条信息在传递中丢失。
 */
export function getRegisteredEngine(paperId: string): RegisteredEngine | null {
  const raw = currentDataset?.raw?.papers.find((p) => p.paper_id === paperId)
  const aw = raw?.analyzed_with
  if (!aw) return null
  return {
    provider: aw.provider,
    model: aw.model,
    promptVersion: aw.prompt_version,
    real: aw.provider !== 'mock',
  }
}

/* ------------------------------------------------------------------ */
/* 数据来源徽标                                                       */
/* ------------------------------------------------------------------ */

/**
 * 每个 Stage 的 LIVE / MOCK 标记（第 24/40 节）。
 *
 * 这是整个 UI 里最重要的诚实性声明。评委扫一眼就能看出
 * 哪些能力是真跑通的、哪些还是演示数据，而不是被"AI 生成"的
 * 字样误导。
 */
export type StageMode = 'LIVE' | 'MOCK'

export interface StageInfo {
  index: number
  key: string
  title: string
  desc: string
  mode: StageMode
  /** MOCK 的原因，直接显示给用户 */
  note: string
}

export function stageTable(opts: {
  source: DataSource
  aiReady: boolean
  aiProvider: string
  aiNote: string
}): StageInfo[] {
  const liveReady = opts.source === 'live' && opts.aiReady
  const whyMock =
    opts.source === 'demo'
      ? '当前是内置 Demo 项目，展示的是预置示例数据'
      : opts.aiNote || 'AI Provider 未就绪'

  /**
   * 阶段③ 的说明文案随 provider 变化。
   *
   * mock provider 是**故意不做分类**的（见 mockProvider.classifyMethods）：
   * 它会照常跑、照常记录、但每一条都返回"未分类"并说明原因。
   * 所以它的 note 不能说"未接入"——那是假话，分类确实跑了。
   * 也不能说"已接入"，那会让人以为拿到了真实归类。得说清是哪种"没结果"。
   */
  const classifyNote = !liveReady
    ? whyMock
    : opts.aiProvider === 'mock'
      ? '内置规则引擎不做语义归类，方法会如实标为「未分类」，不冒充分类结果'
      : `${opts.aiProvider} 基于已校验证据实时归类（证据不足时如实标为未分类）`

  return [
    {
      index: 1,
      key: 'parse',
      title: '文献解析',
      desc: 'PDF → 章节 / 页码 / 逐页原文',
      mode: liveReady ? 'LIVE' : 'MOCK',
      note: liveReady ? '服务端 PyMuPDF 实时解析' : whyMock,
    },
    {
      index: 2,
      key: 'extract',
      title: '方法抽取',
      desc: '正文 → Method 实体 + 原文证据',
      mode: liveReady ? 'LIVE' : 'MOCK',
      note: liveReady ? `${opts.aiProvider} 实时抽取并逐条校验证据` : whyMock,
    },
    {
      index: 3,
      key: 'classify',
      title: '方法分类',
      desc: 'Method → Method Family（基于已校验证据）',
      mode: liveReady ? 'LIVE' : 'MOCK',
      note: classifyNote,
    },
    {
      index: 4,
      key: 'evolution',
      title: '技术演进',
      desc: '跨论文对比重建演进链',
      mode: 'MOCK',
      note: '需要跨论文推理，本阶段未接入',
    },
    {
      index: 5,
      key: 'gaps',
      title: '研究空白',
      desc: '对比归因识别空白',
      mode: 'MOCK',
      note: '需要跨论文推理，本阶段未接入',
    },
    {
      index: 6,
      key: 'directions',
      title: '研究方向',
      desc: '基于空白生成候选方向',
      mode: 'MOCK',
      note: '需要跨论文推理，本阶段未接入',
    },
  ]
}
