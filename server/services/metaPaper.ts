/**
 * 把 Semantic Scholar 的论文元数据登记进项目。
 *
 * ── 这一步到底做了什么、没做什么 ──
 *
 * 做的是：把一条**元数据**写进项目的 papers.json，状态标为 `pending`（待分析）。
 *
 * 刻意不做的是：不下载 PDF、不解析、不抽取方法、不调用任何 LLM、不给 citationCount
 * 之外补任何东西。原因是这一刻我们手里**只有元数据**——标题、作者、年份、摘要、
 * DOI 都是 S2 给的，而方法、证据、章节结构这些必须从正文里来，正文还没拿到。
 *
 * 所以 `pending` 不是"排在队列里等着自动跑"，而是**诚实的"待你提供 PDF"**。
 * 如果这里擅自标成 analyzed，文献库里就会出现一篇没有章节、没有方法、
 * 证据数为 0 却写着"已分析"的论文——那是纯粹的谎报。
 *
 * ── 与上传路径的隔离 ──
 *
 * 上传路径的论文有 file_hash / file_size / page_count / sections，
 * 这里全部给空值/0，并且 file_name 用一个明确的占位标记。
 * 这样任何下游逻辑（复用缓存、找 PDF 文件、证据回验）在遇到这类论文时
 * 都会因为缺文件而自然地跳过，而不是拿一篇不存在的 PDF 去解析然后崩掉。
 */

import { store } from '../store/fileStore.ts'
import type { StoredPaper } from '../types.ts'

/**
 * 元数据论文的占位文件名。
 *
 * 用方括号前缀而不是编一个 "paper.pdf"：文献库那一列会直接显示 file_name，
 * 编一个假文件名等于告诉用户"我这儿有个文件"，而其实没有。
 * 方括号是社区里通用的"非真实值"记号，一眼能看出来这不是路径。
 */
export const META_FILE_NAME = '（仅元数据 · 无 PDF）'

/**
 * 元数据论文没有 PDF，但正文信息必须留下。
 *
 * 这里把 S2 给的 DOI / 链接 / 引用数 / venue 写进 `sections[0].content`，
 * 而不是往 StoredPaper 上加字段。
 *
 * 为什么是这个选择：
 *   服务端落盘的 papers.json 是**磁盘上的既有数据**，给 StoredPaper 加字段
 *   意味着所有已有项目文件都要迁移，而且每一处读 papers 的代码都要考虑
 *   "这个字段可能不存在"。写进 content 则完全复用已有结构，
 *   零迁移、零兼容分支。
 *
 *   代价是它读到的是一个拼好的字符串而不是结构化对象。可接受的原因：
 *   这些信息在界面上的用途只有一个——展示给用户看，
 *   而展示用的正是字符串。真正的结构化处理（引用关系、DOI 解析）
 *   属于后续阶段，到那时它有理由引入独立的元数据表，而不是挤在 papers 里。
 *
 * 不写进 abstract 的原因：abstract 有确定语义（论文摘要），
 * 混入 DOI 会让任何按 abstract 做展示或摘要的地方开始输出元信息。
 */
function buildMetaContent(input: AddMetaInput): string {
  const lines = ['【本论文仅登记元数据，未上传 PDF，正文未解析。以下信息来自 Semantic Scholar】']
  if (input.doi) lines.push(`DOI: ${input.doi}`)
  if (input.url) lines.push(`原文链接: ${input.url}`)
  lines.push(`引用数: ${input.citationCount}（Semantic Scholar 统计，时间点：${new Date().toISOString().slice(0, 10)}）`)
  if (input.venue) lines.push(`发表venue: ${input.venue}`)
  lines.push(`数据来源: ${input.source === 'live' ? 'Semantic Scholar 实时返回' : 'Semantic Scholar 不可达时的示例数据（不代表真实论文）'}`)
  return lines.join('\n')
}

/**
 * 摘要 / DOI / 引用数 / 链接 / venue 存进 keywords。
 *
 * 前缀必须与前端 projectData.ts 的 metaOf() **逐字一致**——
 * 两处对不上就会出现"服务端存了、前端读不出来"，
 * 表现为详情页标题下面空白一片，而要查很久才发现是前缀写错了一个字符。
 */
function buildMetaKeywords(input: AddMetaInput): string[] {
  const kws: string[] = []
  if (input.abstract) kws.push(`摘要：${input.abstract}`)
  if (input.doi) kws.push(`DOI:${input.doi}`)
  kws.push(`引用数:${input.citationCount}`)
  if (input.url) kws.push(`链接:${input.url}`)
  if (input.venue) kws.push(`venue:${input.venue}`)
  return kws
}

/** 去重用的哈希：以 s2:<paperId> 派生，保证同一篇论文重复加入不会产生两条 */
const metaHash = (s2PaperId: string) => `meta:${s2PaperId}`

export interface AddMetaInput {
  /** S2 的 paperId（原始 id，不带 mock: 前缀） */
  s2_paper_id: string
  title: string
  authors: string[]
  year: number
  abstract: string
  url: string
  doi: string
  citationCount: number
  venue: string
  /** 数据来源。mock 的论文**允许**加入（要求 8），但会被标记出来 */
  source: 'live' | 'mock'
}

export type AddMetaResult =
  | { ok: true; paper: StoredPaper; created: boolean }
  | { ok: false; code: string; message: string }

/** 生成元数据论文的 id。前缀 mp- 与上传路径的 P001 形态区分开，便于排查 */
function nextPaperId(existing: StoredPaper[]): string {
  let max = 0
  for (const p of existing) {
    const m = /^MP(\d+)$/.exec(p.paper_id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `MP${String(max + 1).padStart(3, '0')}`
}

export async function addMetaPaper(projectId: string, input: AddMetaInput): Promise<AddMetaResult> {
  const bundle = await store.getBundle(projectId)
  if (!bundle) {
    return { ok: false, code: 'PROJECT_NOT_FOUND', message: `项目 ${projectId} 不存在` }
  }

  const hash = metaHash(input.s2_paper_id)

  /**
   * 幂等：已经加过就返回原来那条，不新建。
   *
   * 界面上按钮会变成「已加入」挡住重复点击，但按钮状态是前端内存里的，
   * 刷新、开两个标签页、或者直接打接口都能绕过。所以去重必须落在服务端，
   * 否则同一篇论文能被加进去五次。
   */
  const dup = bundle.papers.find((p) => p.file_hash === hash)
  if (dup) return { ok: true, paper: dup, created: false }

  const now = new Date().toISOString()
  const paper: StoredPaper = {
    paper_id: nextPaperId(bundle.papers),
    project_id: projectId,
    file_name: META_FILE_NAME,
    file_hash: hash,
    file_size: 0,
    page_count: 0,
    title: input.title,
    authors: input.authors,
    // S2 拿不到年份时给 0，这里如实透传，**不用当前年份兜底**
    year: input.year,
    abstract: input.abstract,
    keywords: buildMetaKeywords(input),
    sections: [
      {
        // 用 "Metadata" 这种明确的名字，而不是 "Abstract" 之类的真章节名——
        // 后者会让下游的章节处理逻辑以为这是从 PDF 里切出来的一节
        name: '元数据',
        page: 0,
        pages: [],
        content: buildMetaContent(input),
        summary: input.abstract ? `${input.abstract.slice(0, 160)}${input.abstract.length > 160 ? '…' : ''}` : '',
      },
    ],
    status: 'pending',
    error: null,
    /*
     * source_type 标 'uploaded' 而不是新增一个类型。
     * 理由：它对下游的含义是"这篇是用户带来的、不是内置演示数据"，
     * 而这个语义对元数据论文同样成立。新增枚举值会波及所有
     * 已经 switch 过 source_type 的代码，收益却只是措辞更精确。
     */
    source_type: 'uploaded',
    analyzed_with: null,
    method_ids: [],
    evidence_count: 0,
    created_at: now,
    updated_at: now,
  }

  await store.savePapers(projectId, [...bundle.papers, paper])
  await store.saveProject(projectId, {
    ...bundle.project,
    paper_ids: [...bundle.project.paper_ids, paper.paper_id],
    updated_at: now,
  })

  /*
   * 溯源信息写进日志而不是塞进 paper 对象。
   * paper 的字段结构被 e2e 和前端多处依赖，为了记一条 DOI 去加字段
   * 会牵动一堆无关代码；而这行日志已经把"哪来的、什么引用数"记全了。
   */
  console.log(
    `[explorer] 加入元数据论文 ${paper.paper_id} ← ${input.source}:${input.s2_paper_id} ` +
      `(${input.year || '年份未知'}, cited=${input.citationCount}${input.doi ? ', doi=' + input.doi : ''})`,
  )

  return { ok: true, paper, created: true }
}
