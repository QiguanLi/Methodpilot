/**
 * 方法族分类体系（阶段③）。
 *
 * 为什么单独一个文件，而不是直接从 `src/data/methods.ts` import：
 *   服务端跑在 Node 的 type-stripping 模式下，**不能**解析前端路径别名 `@/`，
 *   也不该反向依赖浏览器侧的构建产物。两边共享的是"分类体系"这个**契约**，
 *   不是那几个方法族对象本身。
 *
 * 代价：这里的 5 个族与 `src/data/methods.ts` 的 5 个族是两份声明，
 * 改了一边必须改另一边。这个代价是**被接受的**，因为它换来一件更重要的事——
 * 服务端可以独立于前端知识库做真实分类，而 Demo 数据保持一字不动（要求 7）。
 *
 * 为了不让两份声明悄悄漂移，`familyIds()` 会按固定顺序输出这 5 个 id，
 * 且 `scripts/verify-data.mjs` 会比对两边是否一致。
 *
 * ── 关于「分类体系本身是不是 Mock」这个容易混淆的点 ──
 * 分类体系（有哪几个族、每个族的定义）是**知识**，不是**结论**。
 * 它是本题（AI Coding 智能体）的方法论切分方式，与 Demo 项目里的
 * 19 个示例方法是两回事。真实项目复用它，不代表真实项目"继承"了演示数据：
 * 真正决定一条分类真假的，是 LLM 给出的 family_id + reason + evidence_ids，
 * 而那些全部由真实方法、真实证据推导，逐条可核。
 */

export interface FamilySpec {
  family_id: string
  name: string
  name_zh: string
  /** 给模型看的判据。必须能支撑"归入/不归入"的判断，不能只是口号 */
  description: string
}

/**
 * 5 个方法族。
 *
 * description 与 `src/data/methods.ts` 保持一致——它就是送给 LLM 的判据文本，
 * 所以措辞要能区分彼此，不能两个族读起来差不多。
 */
export const FAMILY_SPECS: FamilySpec[] = [
  {
    family_id: 'F1',
    name: 'Software Engineering Agent',
    name_zh: '软件工程智能体',
    description: '面向真实代码仓库的端到端问题求解，覆盖定位、编辑、测试、迭代修复全流程。',
  },
  {
    family_id: 'F2',
    name: 'Tool-Using Agent',
    name_zh: '工具调用智能体',
    description: '让模型自主决定何时、如何调用外部工具与 API，把推理能力延伸到外部世界。',
  },
  {
    family_id: 'F3',
    name: 'Planning & Reflection',
    name_zh: '规划与反思',
    description: '通过搜索式规划、自我批判与语言化反思，提升长程决策质量。',
  },
  {
    family_id: 'F4',
    name: 'Multi-Agent Collaboration',
    name_zh: '多智能体协作',
    description: '多个角色化 Agent 通过结构化对话分工协作，完成单 Agent 难以覆盖的复杂工程任务。',
  },
  {
    family_id: 'F5',
    name: 'Code Generation & Evaluation',
    name_zh: '代码生成与评测',
    description: '大规模代码生成、筛选排序方法，以及支撑整个领域评测的基准体系。',
  },
]

export const FAMILY_IDS: string[] = FAMILY_SPECS.map((f) => f.family_id)

const BY_ID = new Map(FAMILY_SPECS.map((f) => [f.family_id, f]))

export const isKnownFamilyId = (id: string): boolean => BY_ID.has(id)

export const familySpec = (id: string): FamilySpec | undefined => BY_ID.get(id)

/** 传给模型的族清单文本。模型只能从这 5 个 id 里选，或返回 null */
export function familyMenuText(): string {
  return FAMILY_SPECS.map(
    (f) => `  ${f.family_id}  ${f.name} / ${f.name_zh}\n       判据：${f.description}`,
  ).join('\n')
}
