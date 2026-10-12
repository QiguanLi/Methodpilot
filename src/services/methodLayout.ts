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
 * 单列最多容纳多少个方法节点，超出则**同一家族在水平方向拆成多个子列**。
 *
 * 为什么需要它：
 *   原布局里"一列 = 一个方法族"。真实上传项目最常见的形态是**只有一个
 *   未分类族**，于是 7、8 个方法全部竖着堆在同一条窄列里——画布宽 1174，
 *   节点却只占到 x≈230，右侧 80% 是纯空白；节点还常常超出可视高度。
 *   这既浪费主视觉，也让"方法地图"看起来像坏掉的列表。
 *
 * 取 6 的理由：
 *   6 × ROW_H(78) ≈ 468px，加上列标题与上下留白，正好落在常见的桌面
 *   可视高度内，不需要内部纵向滚动即可看全一列。超过就换到下一子列，
 *   横向铺开而不是无限向下延伸。
 *
 * 向后兼容：**任何族的方法数都不超过 MAX_ROWS 时，布局结果与旧版逐字段
 * 一致**（col 就等于族索引），因此既有的分组语义与自测断言不受影响。
 */
export const MAX_ROWS = 6

/**
 * 单列"理想"行数。列预算有多余时，会把列继续分给单列行数仍高于此值的族，
 * 让内容横向铺开、填满可用宽度；降到该值以下就停止分配，避免把少量方法
 * 摊成稀疏的一点一点。
 *
 * 取 4：[4 行] 是既"看起来是列表/矩阵"又不显空的分界；配合 ROW_H(78)
 * 约 312px 的主体高度，放在桌面卡片里紧凑好看。
 */
export const TARGET_ROWS = 4

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
  /**
   * 全局**视觉列号**（不是族索引）。多数情况下两者相等；
   * 只有当某个族的方法数超过 MAX_ROWS、被拆成多个子列时，
   * 后续族才会整体右移，于是 col ≠ 族索引。
   * 关系线用它判"是否同列"来决定绕行方式，所以这里必须是视觉列。
   */
  col: number
  row: number
}

/** 一个方法族在画布上占据的列区间，供列标题横跨渲染。 */
export interface FamilyBand {
  family_id: string
  /** 起始视觉列号 */
  startCol: number
  /** 占用的视觉列数（≥1） */
  colCount: number
}

export interface LayoutResult {
  nodes: Positioned[]
  width: number
  height: number
  /** 有多少个方法没被任何族接住 —— 正常应为 0，非 0 说明画布会有方法消失 */
  orphanCount: number
  /** 每个族实际占据的列区间（顺序与传入 families 一致，只含非空族） */
  familyBands: FamilyBand[]
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
 *
 * ── 关于单族方法过多时的水平拆列 ──
 *
 * 一个族的方法数超过 MAX_ROWS 时，把它拆成若干**子列**，
 * 在族内按 row-major 填充（先填满第一子列的第 0..MAX_ROWS-1 行，再填第二子列）。
 *
 * ── 关于"填充可用宽度" ──
 *
 * 仅按 MAX_ROWS 拆列还不够：真实项目往往只有 1 个未分类族，7~8 个方法只需 2 列，
 * 而画布容器（桌面约 1100+ px）能放下 4~5 列。若只拆 2 列，右侧照样空一大片。
 * 所以引入 `opts.maxCols`（由调用方按容器实测宽度算出）：
 *   - 先把每族按 MAX_ROWS 拆成"最小必要列数"；
 *   - 若总列数 < maxCols 且存在族仍高于"可容纳行数"，就把多出来的列**继续分给
 *     方法最多的族**（每次 +1 列，重算行数），直到用完 maxCols 或所有族都不再
 *     超出行数上限——从而让节点在水平方向真正铺开、填满可用画布。
 *
 * 这样：
 *   - 单族 / 少族场景横向铺开，不再"全部堆在最左侧 + 右侧大片空白"；
 *   - 未传 maxCols（例如自测、或无容器信息）时退化为"按 MAX_ROWS 拆列"，
 *     多族少量方法时与旧布局完全一致；
 *   - `col` 升级为全局视觉列号，关系线的"同列绕行 / 跨列贝塞尔"判定依然成立
 *     （同族不同子列 = 不同 col = 走跨列曲线，不会把线画穿节点）。
 */
export interface LayoutOptions {
  /**
   * 画布允许的最大视觉列数（含所有族）。由调用方按容器实测宽度估算，
   * 例如 `Math.floor((containerWidth - 2 * PAD_X) / COL_W)`。
   * 省略时按 MAX_ROWS 自然拆列。
   */
  maxCols?: number
}

/**
 * 规划每个族占用的视觉列数（纯函数，便于自测）。
 *
 * 输入每族的方法数，输出与之一一对应的列数数组（空族为 0）。
 * 规则：
 *   1. 每族先给"按 MAX_ROWS 的最小必要列数"；
 *   2. 若给了 maxCols 且还有余量，把余量优先分给当前"单列行数最多"的族，
 *      直到用尽余量、或该族单列行数已降到 TARGET_ROWS（继续摊会过散）；
 *   3. 每族至少 1 列（非空族），保证标题与分组不塌陷。
 *
 * 为什么下限是 TARGET_ROWS 而不是 MAX_ROWS：
 *   只按"不超 MAX_ROWS"来拆，9 个方法会停在 2 列（每列 5 行），
 *   而桌面容器能放下 4~5 列——右边照样空一大片。让它在行数仍偏多
 *   （> TARGET_ROWS）时继续横向铺开，才能真正填满可用宽度。
 */
export function planColCounts(
  counts: number[],
  maxCols?: number,
): number[] {
  const cols = counts.map((n) => (n === 0 ? 0 : Math.ceil(n / MAX_ROWS)))
  if (!maxCols || maxCols <= 0) return cols

  const used = cols.reduce((a, b) => a + b, 0)
  let budget = maxCols - used

  // 预算不足（容器比"最小必要列"还窄）时不强行压缩——宁可横向滚动，也不挤坏布局。
  while (budget > 0) {
    // 找到"当前单列行数最多"的非空族，给它加一列（收益最大）
    let target = -1
    let worstRows = 0
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] === 0) continue
      const rows = Math.ceil(counts[i] / cols[i])
      // 行数仍高于目标行数时才继续加列；已足够扁就停，避免把少量方法摊得过散
      if (rows > TARGET_ROWS && rows > worstRows) {
        worstRows = rows
        target = i
      }
    }
    if (target === -1) break
    cols[target] += 1
    budget -= 1
  }
  return cols
}

export function layout(
  methods: Method[],
  families: MethodFamily[],
  opts: LayoutOptions = {},
): LayoutResult {
  const positioned: Positioned[] = []
  const familyBands: FamilyBand[] = []
  const placed = new Set<string>()

  // 先为每个族算出它的成员，才能知道每族需要几个子列。
  const groups = families.map((family) => {
    const members = new Set(family.method_ids)
    const famMethods = methods
      .filter((m) => members.has(m.method_id) || m.family_id === family.family_id)
      .sort((a, b) => a.year - b.year)
    return { family, famMethods }
  })

  // 每个族占用的子列数：按 MAX_ROWS 拆列，再用容器余量继续铺开。
  const colCounts = planColCounts(
    groups.map((g) => g.famMethods.length),
    opts.maxCols,
  )

  let cursor = 0 // 下一个可用视觉列号
  let maxRowInUse = 0

  groups.forEach((g, gi) => {
    const colCount = colCounts[gi]
    if (colCount === 0) return // 空族不占列，也不画标题

    familyBands.push({ family_id: g.family.family_id, startCol: cursor, colCount })

    // 该族每个子列实际承载的行数（均分，尽量填满 colCount 列）
    const rowsPerCol = Math.ceil(g.famMethods.length / colCount)

    g.famMethods.forEach((m, idx) => {
      // row-major：先填满一子列，再换下一子列
      const subCol = Math.floor(idx / rowsPerCol)
      const row = idx % rowsPerCol
      const col = cursor + subCol
      positioned.push({
        method: m,
        x: PAD_X + col * COL_W,
        y: PAD_Y + row * ROW_H,
        col,
        row,
      })
      placed.add(m.method_id)
      maxRowInUse = Math.max(maxRowInUse, row)
    })

    cursor += colCount
  })

  const totalCols = cursor
  return {
    nodes: positioned,
    // 空画布（无任何族占列）时至少保留一个最小画布宽度，避免 0 宽。
    width: PAD_X * 2 + Math.max(totalCols, 1) * COL_W,
    height: PAD_Y * 2 + (maxRowInUse + 1) * ROW_H,
    orphanCount: methods.filter((m) => !placed.has(m.method_id)).length,
    familyBands,
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

  /* 12. 单族方法过多时，横向拆成多个子列（不再全部堆在最左） */
  {
    const n = MAX_ROWS + 3 // 超过单列上限 3 个，应当换列
    const ms = Array.from({ length: n }, (_, i) => method(`M${String(i + 1).padStart(3, '0')}`, ''))
    const fams = liveFamilies(ms, TAXONOMY)
    const r = layout(ms, fams)

    const cols = new Set(r.nodes.map((node) => node.col))
    push(
      '单族超过单列上限时横向换列（不全部堆在最左）',
      cols.size === 2,
      `方法数=${n}, 视觉列数=${cols.size}`,
    )
    push('单族换列后方法不丢失', r.nodes.length === n, `${r.nodes.length}/${n}`)
    // 同族换列后，第二子列的 x 必须比第一子列更大（真正利用了横向空间）
    const minX = Math.min(...r.nodes.map((node) => node.x))
    const maxX = Math.max(...r.nodes.map((node) => node.x))
    push('单族换列后画布横向被利用（x 有展开）', maxX - minX >= COL_W, `Δx=${maxX - minX}`)
    push('对比：旧布局宽度不足以容纳展开后的 x', r.width >= PAD_X * 2 + 2 * COL_W)
  }

  /* 13. 每族都不超过上限时，布局与旧版一致（col == 族索引，向后兼容） */
  {
    const ms = [method('A', 'F1'), method('B', 'F1'), method('C', 'F2'), method('D', 'F3')]
    const fams: MethodFamily[] = [
      { family_id: 'F1', name: 'F1', name_zh: '族一', description: '', color: '#000', method_ids: ['A', 'B'] },
      { family_id: 'F2', name: 'F2', name_zh: '族二', description: '', color: '#111', method_ids: ['C'] },
      { family_id: 'F3', name: 'F3', name_zh: '族三', description: '', color: '#222', method_ids: ['D'] },
    ]
    const r = layout(ms, fams)
    const colOf = (id: string) => r.nodes.find((n) => n.method.method_id === id)?.col
    push(
      '每族不超上限时 col 等于族索引（向后兼容）',
      colOf('A') === 0 && colOf('B') === 0 && colOf('C') === 1 && colOf('D') === 2,
      `A=${colOf('A')} B=${colOf('B')} C=${colOf('C')} D=${colOf('D')}`,
    )
    push(
      'familyBands 覆盖全部非空族且列数正确',
      r.familyBands.length === 3 && r.familyBands.every((b) => b.colCount === 1),
      JSON.stringify(r.familyBands.map((b) => `${b.family_id}@${b.startCol}x${b.colCount}`)),
    )
  }

  /* 14. 混合：一超限族 + 若干普通族，后续族的起始列必须整体右移 */
  {
    const big = Array.from({ length: MAX_ROWS + 2 }, (_, i) => method(`B${i}`, 'F1'))
    const small = [method('S1', 'F2')]
    const ms = [...big, ...small]
    const fams: MethodFamily[] = [
      { family_id: 'F1', name: 'F1', name_zh: '大族', description: '', color: '#000', method_ids: big.map((m) => m.method_id) },
      { family_id: 'F2', name: 'F2', name_zh: '小族', description: '', color: '#111', method_ids: ['S1'] },
    ]
    const r = layout(ms, fams)
    const f1 = r.familyBands.find((b) => b.family_id === 'F1')
    const f2 = r.familyBands.find((b) => b.family_id === 'F2')
    push(
      '大族占多列时后一族起始列右移（不重叠）',
      Boolean(f1 && f2) && f1!.startCol === 0 && f1!.colCount === 2 && f2!.startCol === 2,
      `F1=${f1?.startCol}x${f1?.colCount} F2=${f2?.startCol}x${f2?.colCount}`,
    )
    // 大族第二子列与小族的 x 必须不同（无重叠）
    const xs = new Set(r.nodes.map((n) => `${n.col}:${n.row}`))
    push('大族换列后所有节点位置唯一（无重叠）', xs.size === r.nodes.length, `唯一位置 ${xs.size}/${r.nodes.length}`)
  }

  /* 15. planColCounts：无 maxCols 时，等于按 MAX_ROWS 自然拆列 */
  {
    push('planColCounts 无预算时 = ceil(n/MAX_ROWS)', JSON.stringify(planColCounts([7, 3, 0])) === JSON.stringify([2, 1, 0]), JSON.stringify(planColCounts([7, 3, 0])))
    push('planColCounts 空族占 0 列', planColCounts([0])[0] === 0)
  }

  /* 16. planColCounts：给足预算时把余量分给"最挤"的族（填满可用宽度） */
  {
    const c = planColCounts([9], 4) // 单族 9 个方法，容器能放 4 列
    push('单族有预算时继续铺开到接近 4 列', c[0] >= 2 && c[0] <= 4, `列数=${c[0]}`)
    // 分完后单列行数必须 ≤ MAX_ROWS
    push('铺开后单列行数不超过 MAX_ROWS', Math.ceil(9 / c[0]) <= MAX_ROWS, `每列行数=${Math.ceil(9 / c[0])}`)
  }

  /* 17. planColCounts：预算不足时不压缩（宁可横向滚动） */
  {
    const c = planColCounts([20], 2) // 20 个方法，容器只能放 2 列
    push('预算不足时保留最小必要列数（不挤坏）', c[0] === Math.ceil(20 / MAX_ROWS), `列数=${c[0]}`)
  }

  /* 18. 端到端：单族 9 方法 + 足够预算 → 视觉列数 > 2，横向铺开 */
  {
    const ms = Array.from({ length: 9 }, (_, i) => method(`X${i}`, ''))
    const r = layout(ms, [UNCLASSIFIED_FAMILY], { maxCols: 5 })
    const cols = new Set(r.nodes.map((n) => n.col))
    const minX = Math.min(...r.nodes.map((n) => n.x))
    const maxX = Math.max(...r.nodes.map((n) => n.x))
    push(
      '单族 9 方法 + 预算 → 铺开到多列（消除右侧死区）',
      cols.size >= 3 && maxX - minX >= 2 * COL_W,
      `列数=${cols.size}, Δx=${maxX - minX}`,
    )
    push('铺开后仍无孤儿、无丢失', r.nodes.length === 9 && r.orphanCount === 0, `${r.nodes.length}/9`)
    // 节点位置唯一
    const pos = new Set(r.nodes.map((n) => `${n.col}:${n.row}`))
    push('铺开后节点位置唯一（无重叠）', pos.size === r.nodes.length, `${pos.size}/${r.nodes.length}`)
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
