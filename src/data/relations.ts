import type { Evolution, MethodRelation } from '@/types'

/* ------------------------------------------------------------------ */
/* 方法关系 —— 每条关系必须挂载 Evidence，否则降级为 temporal/related   */
/* ------------------------------------------------------------------ */

export const relations: MethodRelation[] = [
  {
    relation_id: 'R001',
    source_method: 'M003',
    target_method: 'M001',
    relation_type: 'extends',
    description:
      'SWE-agent 将 ReAct 的推理-行动交错循环迁移到仓库级软件工程场景，并配套设计专用 ACI。',
    evidence_ids: ['E031', 'E006'],
  },
  {
    relation_id: 'R002',
    source_method: 'M006',
    target_method: 'M001',
    relation_type: 'extends',
    description: 'SWE-agent 借鉴 Reflexion 的语言化反思，用于跨尝试的策略修正。',
    evidence_ids: ['E031', 'E010'],
  },
  {
    relation_id: 'R003',
    source_method: 'M003',
    target_method: 'M017',
    relation_type: 'improves',
    description:
      'DFSDT 在 ReAct 的线性轨迹上引入回溯能力，解决陷入重复循环的问题。',
    evidence_ids: ['E026', 'E007'],
  },
  {
    relation_id: 'R004',
    source_method: 'M004',
    target_method: 'M017',
    relation_type: 'replaces',
    description:
      'DFSDT 用推理期搜索替代 Toolformer 的微调式工具学习，主干模型保持冻结。',
    evidence_ids: ['E033'],
  },
  {
    relation_id: 'R005',
    source_method: 'M007',
    target_method: 'M010',
    relation_type: 'extends',
    description:
      'ChatDev 沿用 AutoGen 的多 Agent 对话范式，并加入角色分配与固定软件开发对话链。',
    evidence_ids: ['E032'],
  },
  {
    relation_id: 'R006',
    source_method: 'M001',
    target_method: 'M013',
    relation_type: 'extends',
    description:
      'OpenHands 将 SWE-agent 面向单一任务的 ACI 泛化为可复用平台架构。',
    evidence_ids: ['E034'],
  },
  {
    relation_id: 'R007',
    source_method: 'M007',
    target_method: 'M013',
    relation_type: 'extends',
    description: 'OpenHands 用统一事件流泛化 AutoGen 的多 Agent 编排机制。',
    evidence_ids: ['E034'],
  },
  {
    relation_id: 'R008',
    source_method: 'M006',
    target_method: 'M015',
    relation_type: 'combines',
    description:
      'MemGPT 与 Reflexion 互补：Reflexion 决定存什么经验，MemGPT 决定经验存放在哪里。',
    evidence_ids: ['E035'],
  },
  {
    relation_id: 'R009',
    source_method: 'M005',
    target_method: 'M017',
    relation_type: 'parallel',
    description:
      '思维树搜索与 DFSDT 在同期独立地把搜索机制引入推理与工具调用，属于平行发展。',
    evidence_ids: ['E009', 'E026'],
  },
  {
    relation_id: 'R010',
    source_method: 'M006',
    target_method: 'M008',
    relation_type: 'parallel',
    description:
      'Reflexion 与 Self-Refine 同期提出自我改进机制，前者跨尝试、后者单次内迭代。',
    evidence_ids: ['E010', 'E014'],
  },
  {
    relation_id: 'R011',
    source_method: 'M002',
    target_method: 'M013',
    relation_type: 'combines',
    description:
      'OpenHands 将仓库级迭代修复循环与事件流架构、沙箱执行组合为统一平台。',
    evidence_ids: ['E021', 'E022', 'E002'],
  },
  {
    relation_id: 'R012',
    source_method: 'M001',
    target_method: 'M014',
    relation_type: 'combines',
    description:
      'SWE-agent 的 ACI 与沙箱化执行环境协同工作，构成完整的观察-执行闭环。',
    evidence_ids: ['E022', 'E005'],
  },
  {
    relation_id: 'R013',
    source_method: 'M014',
    target_method: 'M016',
    relation_type: 'parallel',
    description:
      '沙箱执行与仓库图谱编辑分别从"能执行"和"看得全"两个方向增强 Agent 的工程能力。',
    evidence_ids: ['E022', 'E025'],
  },
  {
    relation_id: 'R014',
    source_method: 'M012',
    target_method: 'M016',
    relation_type: 'related',
    description:
      '仓库级基准评测为仓库图谱编辑提供了间接的验证参考，但二者并非直接演进关系。',
    evidence_ids: ['E019', 'E025'],
  },
  {
    relation_id: 'R015',
    source_method: 'M018',
    target_method: 'M019',
    relation_type: 'extends',
    description: '思维链提示在上下文学习的基础上显式引入中间推理步骤。',
    evidence_ids: ['E027', 'E029'],
  },
  {
    relation_id: 'R016',
    source_method: 'M019',
    target_method: 'M005',
    relation_type: 'extends',
    description: '思维树把思维链的线性推理扩展为可搜索的树结构。',
    evidence_ids: ['E029', 'E009'],
  },
  {
    relation_id: 'R017',
    source_method: 'M019',
    target_method: 'M003',
    relation_type: 'combines',
    description: 'ReAct 把思维链的推理痕迹与动作执行结合，形成交错循环。',
    evidence_ids: ['E006', 'E029'],
  },
  {
    relation_id: 'R018',
    source_method: 'M009',
    target_method: 'M011',
    relation_type: 'temporal',
    description:
      '两者均属代码生成方向，年份相邻，但现有 Evidence 未显示直接继承或改进关系。',
    evidence_ids: [],
  },
  {
    relation_id: 'R019',
    source_method: 'M011',
    target_method: 'M012',
    relation_type: 'related',
    description:
      '采样-过滤-聚类流水线与仓库级基准评测关注点不同（生成 vs 评测），同属代码质量保障链条。',
    evidence_ids: ['E018', 'E019'],
  },
  {
    relation_id: 'R020',
    source_method: 'M002',
    target_method: 'M006',
    relation_type: 'combines',
    description: '仓库级迭代修复在长周期场景下与跨尝试反思机制组合使用。',
    evidence_ids: ['E002', 'E010', 'E038'],
  },
]

/* ------------------------------------------------------------------ */
/* 技术演进 —— 9 个节点，2019 → 2025                                  */
/* ------------------------------------------------------------------ */

export const evolutions: Evolution[] = [
  {
    evolution_id: 'EV01',
    year: 2019,
    method_id: 'M018',
    stage_title: 'Prompting 时代前夜',
    change: '规模化预训练让"提示即编程"成为可能，任务适配不再依赖梯度更新。',
    improvement: '无需针对每个任务重新训练模型，任务切换成本大幅降低。',
    limitation: '模型与外部世界完全隔离，无法执行动作，也无法获取实时信息。',
    evidence_ids: ['E027'],
    relation_from_prev: null,
  },
  {
    evolution_id: 'EV02',
    year: 2020,
    method_id: 'M003',
    stage_title: 'In-Context Learning 确立',
    change: '少样本上下文学习被系统验证，成为后续所有 Agent 方法的共同底座。',
    improvement: '提示中给出少量示例即可完成新任务，泛化能力显著提升。',
    limitation: '面对需要多步推理与外部交互的任务仍然力不从心。',
    evidence_ids: ['E027'],
    relation_from_prev: 'extends',
  },
  {
    evolution_id: 'EV03',
    year: 2021,
    method_id: 'M009',
    stage_title: '代码专用预训练模型',
    change: '针对代码语料设计的编码器-解码器架构，让标识符语义被显式建模。',
    improvement: '代码理解与生成统一在一个模型中，代码补全质量明显提升。',
    limitation: '依赖有监督微调，缺乏与环境交互和自主决策的能力。',
    evidence_ids: ['E015'],
    relation_from_prev: 'parallel',
  },
  {
    evolution_id: 'EV04',
    year: 2022,
    method_id: 'M003',
    stage_title: '推理显式化：CoT → ReAct',
    change:
      '思维链提示把推理过程显式化；ReAct 进一步把推理与动作交错，形成 Agent 循环雏形。',
    improvement: '从"只会回答问题"跃迁到"能调用工具、根据反馈调整计划"。',
    limitation: '缺少显式搜索，Agent 容易陷入重复循环，一旦走错难以恢复。',
    evidence_ids: ['E029', 'E006', 'E007'],
    relation_from_prev: 'extends',
  },
  {
    evolution_id: 'EV05',
    year: 2022,
    method_id: 'M011',
    stage_title: '大规模采样与筛选',
    change: '以海量采样 + 测试过滤 + 聚类排序替代单次生成。',
    improvement: '在竞赛级编程任务上逼近人类水平，且无需改动模型本身。',
    limitation: '极度依赖测试用例质量，采样成本极高，无法处理开放式任务。',
    evidence_ids: ['E018'],
    relation_from_prev: 'parallel',
  },
  {
    evolution_id: 'EV06',
    year: 2023,
    method_id: 'M007',
    stage_title: '工具使用与规划方法爆发',
    change:
      '工具调用（Toolformer / ToolLLM）、搜索式规划（ToT）、自我反思（Reflexion / Self-Refine）、多 Agent 对话（AutoGen / ChatDev）密集涌现。',
    improvement: 'Agent 从单一动作循环扩展为可规划、可反思、可分工的复杂系统。',
    limitation: '各能力彼此孤立；长轨迹成本失控；多 Agent 错误会跨角色传播。',
    evidence_ids: ['E008', 'E009', 'E010', 'E014', 'E012', 'E026'],
    relation_from_prev: 'combines',
  },
  {
    evolution_id: 'EV07',
    year: 2023,
    method_id: 'M015',
    stage_title: '记忆与上下文管理被正视',
    change: '虚拟上下文管理把上下文窗口当作内存、外部存储当作磁盘，Agent 自主分页。',
    improvement: '突破上下文窗口硬限制，可处理长文档与长对话。',
    limitation: '分页策略隐式学得，错误分页会永久丢失关键信息。',
    evidence_ids: ['E023', 'E024'],
    relation_from_prev: 'parallel',
  },
  {
    evolution_id: 'EV08',
    year: 2023,
    method_id: 'M012',
    stage_title: '评测体系补齐',
    change:
      'SWE-bench 以真实 Issue–PR 对 + 隐藏测试建立客观评测；AgentBench 覆盖 8 类交互环境。',
    improvement: '解决率成为可复现的硬指标，失败模式被系统化暴露。',
    limitation: '仅覆盖 Python 少数仓库；只测单 issue，无法反映长周期任务退化。',
    evidence_ids: ['E019', 'E020', 'E030', 'E028'],
    relation_from_prev: 'extends',
  },
  {
    evolution_id: 'EV09',
    year: 2024,
    method_id: 'M001',
    stage_title: 'Software Engineering Agent 成形',
    change:
      'ACI 设计被确立为一等研究对象（SWE-agent），平台化架构与沙箱执行环境出现（OpenHands）。',
    improvement:
      'SWE-bench 解决率从 3.80% 跃升至 12.50%，Agent 具备真实的仓库级修改能力。',
    limitation:
      '长周期任务稳定性、上下文管理与成本仍是主要瓶颈；定位错误成为首要失败模式。',
    evidence_ids: ['E001', 'E003', 'E004', 'E021', 'E022'],
    relation_from_prev: 'combines',
  },
  {
    evolution_id: 'EV10',
    year: 2025,
    method_id: 'M015',
    stage_title: '待解决的下一跳（AI 推断）',
    change:
      '领域正朝向长周期持续规划、结构化记忆与自监督评测演进，但尚无被广泛验证的代表方法。',
    improvement: '预期收益：Agent 在数十步以上的工程任务中保持目标一致与经验复用。',
    limitation: '当前无公开方法可同时解决记忆衰减、成本控制与评测缺位三个问题。',
    evidence_ids: ['E004', 'E011', 'E020', 'E036', 'E037', 'E038'],
    relation_from_prev: 'temporal',
  },
]
