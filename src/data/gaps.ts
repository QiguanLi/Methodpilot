import type { ResearchDirection, ResearchGap } from '@/types'

/* ------------------------------------------------------------------ */
/* 研究空白 —— 5 个                                                    */
/* ------------------------------------------------------------------ */

export const gaps: ResearchGap[] = [
  {
    gap_id: 'G001',
    type: 'method',
    title: '长周期软件工程任务中的持续规划与记忆能力不足',
    description:
      '现有 Coding Agent 研究普遍以单个 Issue 为任务单元，轨迹长度在十余步量级。当任务需要数十步连续修改、测试与回滚时，Agent 会丢失早期目标与已确认的修改。',
    existing_work:
      'SWE-agent 通过 ACI 优化单轮交互质量；Reflexion 提供跨尝试的语言化反思；MemGPT 提供分页式上下文管理；Aider 用仓库图谱缓解 token 压力。但这些机制彼此独立，且都未针对"连续数十步的软件工程任务"这一场景做联合设计。',
    current_problem:
      '当任务跨越数十步时，上下文管理与长期规划仍存在明显研究空间：Agent 无法稳定区分哪些历史信息必须保留、哪些可以丢弃，也无法在步骤推进中持续校准任务目标。',
    supporting_papers: ['P001', 'P005', 'P009', 'P014', 'P015'],
    evidence_ids: ['E004', 'E011', 'E023', 'E024', 'E025', 'E038', 'E035'],
    potential_value:
      '若能将记忆、规划与仓库状态三者联合建模，有望把 Agent 可处理的工程任务长度提升一个数量级，是从"解决单个 Issue"走向"参与真实开发迭代"的关键一跳。',
    method_ids: ['M001', 'M002', 'M006', 'M015', 'M016'],
  },
  {
    gap_id: 'G002',
    type: 'method',
    title: '缺乏显式搜索的推理-行动循环容易陷入局部最优',
    description:
      '主流 Agent 框架采用线性轨迹推进，缺少对动作空间的前瞻与回溯，一旦在早期确定错误方案，后续步骤会持续放大该错误。',
    existing_work:
      'Tree of Thoughts 在纯推理任务上引入树搜索；ToolLLM 的 DFSDT 在工具调用空间上支持回溯。但这两者分别面向推理与工具调用，尚未系统迁移到需要真实环境反馈的软件工程任务上。',
    current_problem:
      '在仓库级任务中，搜索空间由文件定位、编辑方式、测试策略共同构成，规模远大于纯推理任务，直接套用现有搜索方法会带来不可接受的成本。',
    supporting_papers: ['P002', 'P004', 'P016'],
    evidence_ids: ['E007', 'E009', 'E026'],
    potential_value:
      '设计面向仓库级动作空间的高效搜索与剪枝策略，可能在有限预算下显著提升复杂任务成功率。',
    method_ids: ['M003', 'M005', 'M017'],
  },
  {
    gap_id: 'G003',
    type: 'evaluation',
    title: '评测体系无法衡量长周期任务中的能力退化',
    description:
      '现有基准以静态 Issue–PR 对为单元，只提供仓库的单一快照，无法回答"Agent 在连续任务中是否会越来越差"这一关键问题。',
    existing_work:
      'SWE-bench 建立了客观的单 Issue 解决率指标；AgentBench 扩展到 8 类交互环境。两者都在"单任务、可重置"的设定下评测，缺失任务间的连续性与状态累积。',
    current_problem:
      '评测指标仅衡量补丁能否通过隐藏测试，对代码可维护性、安全影响、仓库长期健康度均无信号，导致优化方向被单一指标牵引。',
    supporting_papers: ['P011', 'P013', 'P010'],
    evidence_ids: ['E019', 'E020', 'E028', 'E036', 'E030'],
    potential_value:
      '构建连续任务流基准与多维度评价体系，能揭示当前方法被掩盖的退化现象，并引导研究从"跑通一次"转向"稳定可用"。',
    method_ids: ['M012', 'M011'],
  },
  {
    gap_id: 'G004',
    type: 'method',
    title: '多 Agent 协作缺乏全局编排与错误纠偏机制',
    description:
      '多 Agent 方法依赖多轮对话完成分工，但对话轮数易失控、成本不可预测，且单个 Agent 的错误会在角色间无检查地传播。',
    existing_work:
      'AutoGen 提供可编程的对话编排，支持人类介入；ChatDev 用固定软件开发对话链与角色分工提升流程可控性。两者都未提供全局最优编排或系统性纠偏。',
    current_problem:
      '缺少原则性方法来判定多 Agent 对话应何时终止，也缺少在角色间传递状态时对错误进行拦截与修复的机制。',
    supporting_papers: ['P006', 'P009'],
    evidence_ids: ['E013', 'E016', 'E017', 'E037'],
    potential_value:
      '引入显式编排控制器与跨角色一致性校验，可同时降低成本并提升复杂工程任务的成功率。',
    method_ids: ['M007', 'M010'],
  },
  {
    gap_id: 'G005',
    type: 'application',
    title: '缺乏可靠外部信号时的自我改进边界不清',
    description:
      '自我反思类方法的有效性高度依赖可靠的外部反馈信号（如测试结果），在开放式、无标准答案的真实工程任务中，其收益边界尚不明确。',
    existing_work:
      'Reflexion 依赖二值或标量反馈；Self-Refine 完全不依赖外部信号，仅靠模型自我批判。二者在有无信号两端，但中间地带缺乏系统研究。',
    current_problem:
      '真实软件工程任务中，反馈信号往往稀疏、延迟且噪声大。此时自我反思可能强化错误归因，而非带来改进。',
    supporting_papers: ['P005', 'P007', 'P001'],
    evidence_ids: ['E011', 'E014', 'E004'],
    potential_value:
      '刻画自我改进方法的适用边界，并设计面向稀疏噪声反馈的鲁棒反思机制，可提升 Agent 在真实开发环境中的可用性。',
    method_ids: ['M006', 'M008'],
  },
]

/* ------------------------------------------------------------------ */
/* 研究方向 —— 3 个候选                                                */
/* ------------------------------------------------------------------ */

export const directions: ResearchDirection[] = [
  {
    direction_id: 'D001',
    title: '面向长周期软件任务的持续记忆 Agent',
    research_question:
      '如何让 Agent 在跨数十步的软件工程任务中，稳定保持任务目标、已确认的历史修改与失败经验，并在上下文预算受限时做出正确的记忆取舍？',
    existing_work:
      'Reflexion 证明语言化反思可以跨尝试复用经验；MemGPT 证明上下文可以像虚拟内存一样分页调度；Aider 证明用仓库图谱能在有限 token 内提供全局视野。但三者分别在"跨尝试"、"跨文档"、"跨文件"三个不同维度上工作，尚未有工作把它们统一到"单个长周期任务内部"的记忆调度上。',
    gap_ids: ['G001', 'G005'],
    possible_method: [
      '分层记忆结构：工作记忆（当前 3-5 步）+ 任务记忆（目标与约束）+ 情景记忆（失败经验与修复历史）',
      '记忆写入与驱逐策略：以"是否影响后续测试通过率"为信号学习取舍，而非仅按时间或相关性',
      '仓库状态感知的检索：将文件依赖图与记忆条目关联，按修改影响域召回相关历史',
      '目标一致性校验：每 N 步回读原始 Issue 描述，显式检查是否发生目标漂移',
    ],
    experiment_design:
      '构造长周期任务流：从 SWE-bench 中筛选需要多文件、多轮修改的 Issue 并串联为 20–50 步的连续任务链，在同一仓库状态上连续执行多个任务，观察性能随步数推移的变化曲线。对照组包括：(a) 无记忆基线，(b) 纯 Reflexion 记忆，(c) 纯 MemGPT 分页，(d) 本文提出的分层记忆。',
    baselines: ['SWE-agent (无持久记忆)', 'Reflexion', 'MemGPT', 'Aider (仓库图谱 + 全量历史)'],
    metrics: [
      'Task Success Rate（整体解决率）',
      'Success Rate Decay（随步数推移的成功率衰减斜率）',
      'Goal Drift Rate（目标漂移发生率）',
      'Memory Precision / Recall（记忆条目召回的精度与召回率）',
      'Token Cost per Resolved Issue（单 Issue 解决成本）',
    ],
    risk: '分层记忆的额外写入与检索会带来 20%–40% 的 token 开销，且记忆策略本身可能过拟合到特定仓库结构，在跨语言、跨项目场景下收益衰减。',
    risk_mitigation:
      '引入成本归一化指标（每解决一个 Issue 的总 token 消耗）而非绝对性能；在 Python 之外补充 Java / TypeScript 仓库做跨语言验证；对记忆策略做消融实验，确认各层独立贡献。',
    evidence_ids: ['E002', 'E004', 'E010', 'E011', 'E023', 'E024', 'E025', 'E038'],
    paper_ids: ['P001', 'P005', 'P009', 'P014', 'P015'],
    feasibility: 78,
    novelty: 84,
  },
  {
    direction_id: 'D002',
    title: '连续任务流下的 Agent 能力退化评测框架',
    research_question:
      '如何设计一套评测协议，能够量化 Agent 在连续、有状态累积的软件工程任务序列中，能力随任务推进而发生的退化？',
    existing_work:
      'SWE-bench 提供了客观的单任务解决率；AgentBench 揭示了长程推理中商用与开源模型的差距，并观察到性能随交互轮数增加而急剧下降。但二者都在"任务间可重置"的设定下评测，无法捕捉状态累积导致的退化。',
    gap_ids: ['G003'],
    possible_method: [
      '任务链构造：基于同一仓库构造有依赖关系的 Issue 序列，后序任务依赖前序修改',
      '退化指标族：定义成功率衰减斜率、回归引入率、上下文污染度等指标',
      '干扰注入：主动引入错误修改或无关变更，测试 Agent 的恢复能力',
      '多维度评价：在解决率之外，增加代码可维护性、安全影响与变更可解释性维度',
    ],
    experiment_design:
      '选取 10 个活跃 Python 仓库，为每个仓库构造 15–30 个有依赖关系的 Issue 链。对每个被测 Agent 执行完整任务链，记录每个任务的成功与否、引入的回归数量、以及上下文中错误信息的累积量。通过对比任务链前 20% 与后 20% 的表现差异量化退化程度。',
    baselines: ['SWE-bench 静态评测协议', 'AgentBench 多环境评测', '随机任务顺序对照组'],
    metrics: [
      'Success Rate Decay Slope（成功率衰减斜率）',
      'Regression Introduction Rate（回归引入率）',
      'Context Contamination Index（上下文污染指数）',
      'Recovery Rate after Injected Failure（注入失败后的恢复率）',
      'Evaluation Reproducibility（跨运行方差）',
    ],
    risk: '构建有依赖关系的 Issue 链需要大量人工标注与验证，成本高；且不同仓库的依赖强度差异大，可能导致结论难以泛化。',
    risk_mitigation:
      '先用自动化方法（PR 引用关系、文件重叠度）构建候选任务链，再人工抽检；分仓库类型（库、应用、工具）分别报告结果；开源基准与标注流程以促进社区复现。',
    evidence_ids: ['E019', 'E020', 'E028', 'E030', 'E036'],
    paper_ids: ['P011', 'P013'],
    feasibility: 85,
    novelty: 72,
  },
  {
    direction_id: 'D003',
    title: '资源感知的多 Agent 编排与一致性校验',
    research_question:
      '如何在多 Agent 协作中引入资源感知的全局编排与跨角色一致性校验，在显著降低对话轮数与成本的同时，阻止错误在角色间传播？',
    existing_work:
      'AutoGen 提供可编程的对话编排并支持人类介入，但未解决终止判定与错误传播；ChatDev 用固定软件开发对话链提升可控性，但在大型既有代码库上表现下降；DFSDT 证明回溯机制在单 Agent 动作空间中有效。',
    gap_ids: ['G004', 'G002'],
    possible_method: [
      '编排控制器：将多 Agent 对话建模为带预算约束的规划问题，由独立控制器决定下一轮发言者与终止时机',
      '一致性校验层：在角色间传递产物时，用轻量验证器（测试、类型检查、静态分析）拦截明显错误',
      '按需激活：仅当任务复杂度超过阈值时才启用多 Agent，简单任务退回单 Agent 执行',
      '搜索增强：在多 Agent 的方案选择阶段引入受限回溯，避免过早收敛到错误方案',
    ],
    experiment_design:
      '在 ChatDev 与 AutoGen 的代码生成/修改任务上加入编排控制器与一致性校验层，对比轮数、成本、任务成功率与错误传播率。同时在 SWE-bench 的子集上测试多 Agent 方案相对单 Agent 的净收益，识别多 Agent 真正占优的任务特征。',
    baselines: ['AutoGen (默认编排)', 'ChatDev (固定对话链)', 'SWE-agent (单 Agent)', 'Group Chat 循环终止策略'],
    metrics: [
      'Task Success Rate（任务成功率）',
      'Conversation Rounds（对话轮数）',
      'Error Propagation Rate（错误跨角色传播率）',
      'Cost per Successful Task（单成功任务成本）',
      'Termination Precision（终止判定的准确率）',
    ],
    risk: '一致性问题在软件工程场景中可被测试部分捕获，但在需求分析、架构设计等早期阶段缺少自动校验手段，校验层可能只在流程后半段生效。',
    risk_mitigation:
      '分层设计校验层，早期阶段用结构化模板与约束表达替代自动校验；明确论文的适用范围为编码与测试阶段；报告各阶段的收益分解而非仅给总体数字。',
    evidence_ids: ['E013', 'E016', 'E017', 'E026', 'E037'],
    paper_ids: ['P006', 'P009', 'P016'],
    feasibility: 70,
    novelty: 76,
  },
]
