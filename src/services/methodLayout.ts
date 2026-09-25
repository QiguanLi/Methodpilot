/**
 * 方法地图的布局与自测。
 *
 * 为什么把 layout 单独抽出来：
 *   它此前是 MethodsPage 里的一个内部函数，而它出过一个**不报错**的 bug——
 *   Live 模式下真实方法的 family_id 是空字符串，伪族的 id 却写成
 *   '__unclassified__'，filter 命中 0 条，于是画布一片空白，
 *   而页面徽标还理直气壮地写着「1 个方法」。
 *   TypeScript 查不出来（类型完全合法），浏览器也不报错，
 *   只有人工看图才发现。抽出来 + 自测是唯一能自动拦住它的办法。
 */

import type { Method, MethodFamily } from '@/types'

export const COL_W = 232
export const ROW_H = 78
export const PAD_X = 34
export const PAD_Y = 26
export const NODE_W = 196
export const NODE_H = 54

/**
 * 真实上传项目的「伪方法族」—— 未分类。
 *
 * 它的 id 必须是**空字符串**，与未分类真实方法的 family_id 严格对齐，
 * 否则 layout 的 filter 命中 0 条，画布一片空白而徽标还写着「N 个方法」。
 * 这个坑有专门的回归自测（selfTestLayout 第 2 条）。
 *
 * 注意语义随阶段③ 变了：以前它是"唯一的那一列，因为分类没接入"；
 * 现在是"确实判不出归属的那些方法的收容所"。前后都叫未分类，
 * 但前者是能力缺失，后者是**一个真实的判定结果**——
 * 所以 description 改写为描述判据，而不是描述系统状态。
 */
export const UNCLASSIFIED_FAMILY_ID = ''

export const UNCLASSIFIED_FAMILY: MethodFamily = {
  family_id: UNCLASSIFIED_FAMILY_ID,
  name: 'Unclassified',
  name_zh: '未分类',
  description: '证据不足以可靠归入任何方法族的真实方法。未分类是一个判定结果，不是失败',
  color: '#94a3b8',
  method_ids: [],
}

/**
 * 为 Live 项目构造方法族列。
 *
 * ── 这个函数在阶段③ 被完全重写，值得说明为什么 ──
 *
 * 旧版（阶段③ 之前）无条件把所有真实方法塞进**一个**「未分类」列：
 *
 *     return [{ ...UNCLASSIFIED_FAMILY, method_ids: methods.map(m => m.method_id) }]
 *
 * 那在当时是**唯一诚实**的写法——分类没接入，强行分成多个族就是编造。
 * 但阶段③ 接入真实分类之后，这个写法会变成一个更隐蔽的谎：
 * 方法明明已经被模型分到了 F3，界面却仍然把它们全画在「未分类」下，
 * 等于把真金白银算出来的结论藏起来。
 *
 * 新版的规则，三条：
 *   1. 逐个方法看它自己的 family_id。非空且是已知族 → 进那个族；空 → 进未分类。
 *   2. **空列不生成**。一个族如果一条方法都没落到，就不该在画布上留一个空标题。
 *   3. 未知的 family_id（理论上服务端已经拦掉了，但防御性处理）
 *      也进未分类列，而不是被静默丢弃——静默丢弃正是上一轮出过的 bug。
 *
 * 最后这句是重点：本函数**永远不会**让一个方法消失。
 * 凡是进不了已知族的方法，一定会出现在未分类列里。
 * 所以 layout() 的 orphanCount 在正常数据下必然是 0。
 */
export function liveFamilies(methods: Method[], taxonomy: MethodFamily[] = []): MethodFamily[] {
  if (methods.length === 0) return []

  const known = new Map(taxonomy.map((f) => [f.family_id, f]))

  // 按 taxonomy 的顺序建列，保证同一批方法每次渲染列顺序一致
  const buckets = new Map<string, string[]>()
  for (const f of taxonomy) buckets.set(f.family_id, [])
  buckets.set(UNCLASSIFIED_FAMILY_ID, [])

  for (const m of methods) {
    const fid = m.family_id
    const target = fid && known.has(fid) ? fid : UNCLASSIFIED_FAMILY_ID
    buckets.get(target)!.push(m.method_id)
  }

  const out: MethodFamily[] = []

  // 已知族：只保留非空的，颜色/名称一律取真实族的定义（不能自己编颜色）
  for (const f of taxonomy) {
    const ids = buckets.get(f.family_id)!
    if (ids.length === 0) continue
    out.push({ ...f, method_ids: ids })
  }

  // 未分类永远排在最后：它是个兜底桶，不该插在真实族中间
  const rest = buckets.get(UNCLASSIFIED_FAMILY_ID)!
  if (rest.length > 0) {
    out.push({ ...UNCLASSIFIED_FAMILY, method_ids: rest })
  }

  return out
}

/**
 * Live 方法的族统计。与 Demo 的 getFamilyDistribution() 语义对齐，
 * 但数据源是本页已经映射好的 methods + families。
 *
 * 存在的理由：MethodsPage 里曾经直接写 `value: allMethods.length`，
 * 于是每个族的图例都显示同样的总数。只有一个伪族时看不出来，
 * 一旦分成多个真实族，每个族的数字就都变成"全部方法数"——明显是错的。
 */
export function liveFamilyDistribution(
  methods: Method[],
  families: MethodFamily[],
): { name: string; nameEn: string; value: number; color: string; family_id: string }[] {
  return families.map((f) => ({
    name: f.name_zh,
    nameEn: f.name,
    // 按 family_id 真实计数，而不是套用总数
    value: methods.filter((m) => m.family_id === f.family_id).length,
    color: f.color,
    family_id: f.family_id,
  }))
}

export interface Positioned {
  method: Method
  x: number
  y: number
  col: number
  row: number
}

export interface LayoutResult {
  nodes: Positioned[]
  width: number
  height: number
  /** 有多少个方法没被任何族接住 —— 正常应为 0，非 0 说明画布会有方法消失 */
  orphanCount: number
}

/**
 * 按方法族分列，族内按年份自上而下排列。
 *
 * ── 关于"一个方法算不算属于某族"的判定 ──
 *
 * 旧版只看 `m.family_id === family.family_id`。这在 Demo 数据下没问题
 * （Demo 的族和方法是手工对齐的），但阶段③ 引入真实分类后出现了一个漏洞：
 * 如果一个方法的 family_id 是**未知值**（比如模型返回了 F9，
 * 而服务端的合法性校验被绕过），liveFamilies() 会把它收进未分类列的
 * `method_ids` 里，可 layout() 却按 family_id 匹配——未分类列的 family_id 是 ''，
 * 跟 'F9' 不等，于是这个方法**既在未分类列的名单上、又画不出来**，
 * 只体现为 orphanCount+1。
 *
 * 修法：以 `family.method_ids` 为**权威成员名单**，family_id 相等作为兜底。
 *   - family_ids 由 liveFamilies()/知识库显式写出，是"谁属于这个族"的完整声明；
 *   - family_id 兜底让 Demo 路径（族的 method_ids 与方法的 family_id 一致）
 *     以及任何只填了 family_id 没填 method_ids 的调用方继续正常工作。
 *
 * 两者取并集之后，"家族声明包含它"和"它自报家门"这两条路径**都不会丢方法**，
 * orphanCount 才真正只在数据硬伤时才非 0。
 */
export function layout(methods: Method[], families: MethodFamily[]): LayoutResult {
  const positioned: Positioned[] = []
  let maxRow = 0
  const placed = new Set<string>()

  families.forEach((family, col) => {
    // 权威名单 + family_id 兜底，见上方注释
    const members = new Set(family.method_ids)
    const famMethods = methods
      .filter((m) => members.has(m.method_id) || m.family_id === family.family_id)
      .sort((a, b) => a.year - b.year)

    famMethods.forEach((m, row) => {
      positioned.push({
        method: m,
        x: PAD_X + col * COL_W,
        y: PAD_Y + row * ROW_H,
        col,
        row,
      })
      placed.add(m.method_id)
      maxRow = Math.max(maxRow, row)
    })
  })

  return {
    nodes: positioned,
    width: PAD_X * 2 + families.length * COL_W,
    height: PAD_Y * 2 + (maxRow + 1) * ROW_H,
    orphanCount: methods.filter((m) => !placed.has(m.method_id)).length,
  }
}

/* ------------------------------------------------------------------ */
/* 自测                                                               */
/* ------------------------------------------------------------------ */

export interface LayoutCheck {
  name: string
  ok: boolean
  detail?: string
}

function method(id: string, familyId: string, year = 2024): Method {
  return {
    method_id: id,
    name: id,
    name_zh: '',
    family_id: familyId,
    task: '',
    paradigm: 'Prompting',
    year,
    core_idea: '',
    modules: [],
    inputs: [],
    outputs: [],
    capabilities: [],
    advantages: [],
    limitations: [],
    paper_ids: [],
    evidence_ids: [],
    layer: 0,
  }
}

/**
 * 布局自测。检查列表刻意围绕"方法有没有被画出来"这一件事，
 * 因为那正是上一轮真实出过错的地方。
 */
export function selfTestLayout(): LayoutCheck[] {
  const checks: LayoutCheck[] = []
  const push = (name: string, ok: boolean, detail?: string) =>
    checks.push({ name, ok, ...(detail ? { detail } : {}) })

  /* 1. Live：空 family_id 的方法必须落进伪族，且一个都不能丢 */
  {
    const ms = [method('M001', ''), method('M002', '')]
    const fams = liveFamilies(ms, TAXONOMY)
    const r = layout(ms, fams)
    push(
      'Live 方法（family_id 为空）全部被绘制',
      r.nodes.length === ms.length,
      `节点 ${r.nodes.length}/${ms.length}`,
    )
    push('Live 布局没有孤儿方法', r.orphanCount === 0, `orphan=${r.orphanCount}`)
  }

  /* 2. 回归：伪族 id 若与真实 family_id 不一致，必须报出孤儿 */
  {
    const ms = [method('M001', '')]
    const wrongFam: MethodFamily = { ...UNCLASSIFIED_FAMILY, family_id: '__unclassified__' }
    const r = layout(ms, [wrongFam])
    push(
      '伪族 id 写错时 orphanCount 会暴露问题（回归防护）',
      r.nodes.length === 0 && r.orphanCount === 1,
      `节点 ${r.nodes.length}, orphan ${r.orphanCount}`,
    )
  }

  /* 3. 空输入不炸，且不产生垃圾节点 */
  {
    const r = layout([], [])
    push('空方法列表不产生节点且不报错', r.nodes.length === 0 && r.orphanCount === 0)
  }

  /* 4. Demo 路径不受影响：多族分组各归其位 */
  {
    const ms = [method('A', 'F1', 2022), method('B', 'F1', 2023), method('C', 'F2', 2024)]
    const fams: MethodFamily[] = [
      { family_id: 'F1', name: 'F1', name_zh: '族一', description: '', color: '#000', method_ids: ['A', 'B'] },
      { family_id: 'F2', name: 'F2', name_zh: '族二', description: '', color: '#111', method_ids: ['C'] },
    ]
    const r = layout(ms, fams)
    const a = r.nodes.find((n) => n.method.method_id === 'A')
    const b = r.nodes.find((n) => n.method.method_id === 'B')
    const c = r.nodes.find((n) => n.method.method_id === 'C')
    push('多族布局：各方法落在正确的列', a?.col === 0 && b?.col === 0 && c?.col === 1)
    push(
      '多族布局：族内按年份升序',
      Boolean(a && b) && a!.row === 0 && b!.row === 1,
      `A.row=${a?.row} B.row=${b?.row}`,
    )
    push('多族布局：无孤儿', r.orphanCount === 0)
  }

  /* 5. 空方法列表不生成伪族（避免画出一个空列标题） */
  {
    push('无方法时不生成伪族列', liveFamilies([], TAXONOMY).length === 0)
  }

  /* ---------------------------------------------------------------- */
  /* 以下为阶段③「真实分类」新增：分类接进来了，布局必须跟得上          */
  /* ---------------------------------------------------------------- */

  /* 6. 核心：分类后，方法必须落进对应真实族，且不再全挤在未分类里 */
  {
    const ms = [method('M001', 'F3'), method('M002', 'F3'), method('M003', 'F1')]
    const fams = liveFamilies(ms, TAXONOMY)
    const r = layout(ms, fams)

    const fam1 = fams.find((f) => f.family_id === 'F1')
    const fam3 = fams.find((f) => f.family_id === 'F3')
    const uncls = fams.find((f) => f.family_id === UNCLASSIFIED_FAMILY_ID)

    push(
      '分类后方法进入对应的真实族',
      fam3?.method_ids.length === 2 && fam1?.method_ids.length === 1,
      `F3=${fam3?.method_ids.length}, F1=${fam1?.method_ids.length}`,
    )
    push(
      '分类后不再全部显示未分类',
      fams.length > 1 && !uncls,
      `列数 ${fams.length}，未分类列 ${uncls ? '存在' : '不存在'}`,
    )
    push('分类后布局无孤儿', r.orphanCount === 0, `orphan=${r.orphanCount}`)
    push('分类后全部方法都被绘制', r.nodes.length === ms.length, `${r.nodes.length}/${ms.length}`)
    push(
      '分类后的列颜色取自真实族定义（不是自编的灰色）',
      fam3?.color === TAXONOMY.find((f) => f.family_id === 'F3')?.color,
    )
  }

  /* 7. 空列不生成 —— 只用了 F1，就不该画出 F2/F3/F4/F5 四个空标题 */
  {
    const ms = [method('M001', 'F1')]
    const fams = liveFamilies(ms, TAXONOMY)
    push(
      '没有方法的族不生成空列',
      fams.length === 1 && fams[0].family_id === 'F1',
      `列数 ${fams.length}: ${fams.map((f) => f.family_id).join(',')}`,
    )
  }

  /* 8. 混合场景：分类成功 + 未分类并存，两类都必须被画出来 */
  {
    const ms = [method('M001', 'F2'), method('M002', ''), method('M003', 'F5')]
    const fams = liveFamilies(ms, TAXONOMY)
    const r = layout(ms, fams)
    const uncls = fams.find((f) => f.family_id === UNCLASSIFIED_FAMILY_ID)
    push(
      '已分类与未分类可以并存，未分类保留自己的列',
      Boolean(uncls) && uncls!.method_ids.length === 1 && uncls!.method_ids[0] === 'M002',
      `未分类列=${JSON.stringify(uncls?.method_ids)}`,
    )
    push('混合场景无孤儿（未分类的方法不能被丢掉）', r.orphanCount === 0, `orphan=${r.orphanCount}`)
    push('混合场景全部方法都被绘制', r.nodes.length === 3, `${r.nodes.length}/3`)
  }

  /* 9. 防御：未知 family_id 不能被静默丢弃，必须收进未分类列 */
  {
    const ms = [method('M001', 'F9-不存在'), method('M002', 'F1')]
    const fams = liveFamilies(ms, TAXONOMY)
    const r = layout(ms, fams)
    const uncls = fams.find((f) => f.family_id === UNCLASSIFIED_FAMILY_ID)
    push(
      '未知 family_id 被收进未分类列而不是丢弃',
      Boolean(uncls) && uncls!.method_ids.includes('M001'),
      `未分类列=${JSON.stringify(uncls?.method_ids)}`,
    )
    push('未知 family_id 不产生孤儿', r.orphanCount === 0, `orphan=${r.orphanCount}`)
  }

  /* 10. 未分类列永远排在最后 */
  {
    const ms = [method('M001', 'F1'), method('M002', '')]
    const fams = liveFamilies(ms, TAXONOMY)
    push(
      '未分类列排在所有真实族之后',
      fams[fams.length - 1].family_id === UNCLASSIFIED_FAMILY_ID,
      fams.map((f) => f.family_id).join(','),
    )
  }

  /* 11. 族分布计数：每个族只数自己那份，不能都是总数 */
  {
    const ms = [method('M001', 'F1'), method('M002', 'F1'), method('M003', '')]
    const fams = liveFamilies(ms, TAXONOMY)
    const dist = liveFamilyDistribution(ms, fams)
    const d1 = dist.find((d) => d.family_id === 'F1')
    const d0 = dist.find((d) => d.family_id === UNCLASSIFIED_FAMILY_ID)
    push(
      '族分布按 family_id 分别计数（不是每个族都显示总数）',
      d1?.value === 2 && d0?.value === 1,
      `F1=${d1?.value}, 未分类=${d0?.value}, 总数=${ms.length}`,
    )
  }

  return checks
}

/**
 * 自测专用的方法族清单。
 *
 * 刻意**不从** `src/data/methods.ts` import 真实的 5 个族：
 *   那个模块还带着 19 个演示方法与证据，import 进来会让这个模块的依赖变重，
 *   而且一旦 Demo 数据调整（比如加一个族），布局自测的结果就会跟着变——
 *   自测应该测的是**布局逻辑**，不是 Demo 数据的快照。
 *
 * 代价：这里的 F1..F5 与真实族的 id 是重复书写的。
 * 但 id 是契约（服务端 taxonomy.ts 里也是这 5 个），重复的是**标识符**而非**定义**，
 * 而且一旦不一致，第 6 条自测会立刻抓到"颜色/名称取不到"。
 */
const TAXONOMY: MethodFamily[] = [
  { family_id: 'F1', name: 'Software Engineering Agent', name_zh: '软件工程智能体', description: '', color: '#6d5cf0', method_ids: [] },
  { family_id: 'F2', name: 'Tool-Using Agent', name_zh: '工具调用智能体', description: '', color: '#0ea5e9', method_ids: [] },
  { family_id: 'F3', name: 'Planning & Reflection', name_zh: '规划与反思', description: '', color: '#f59e0b', method_ids: [] },
  { family_id: 'F4', name: 'Multi-Agent Collaboration', name_zh: '多智能体协作', description: '', color: '#10b981', method_ids: [] },
  { family_id: 'F5', name: 'Code Generation & Evaluation', name_zh: '代码生成与评测', description: '', color: '#ec4899', method_ids: [] },
]
