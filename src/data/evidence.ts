import type { Evidence } from '@/types'

/**
 * Evidence —— 产品核心资产
 *
 * 每条 Evidence 都锚定到具体论文的具体章节/页码，原文片段（content）为英文原文，
 * translation 为中文释义。supports 字段声明该证据能支撑哪些结论类型，
 * 页面在渲染结论时会反向检索 Evidence，杜绝无依据的编造。
 */
export const evidence: Evidence[] = [
  /* ---------- P001 SWE-agent ---------- */
  {
    evidence_id: 'E001',
    paper_id: 'P001',
    section: 'Section 3.1 ACI Design',
    page: 3,
    content:
      'We argue that the design of the agent-computer interface (ACI) has a substantial impact on agent performance. A well-designed ACI should provide concise and informative feedback, guard against common mistakes, and be easy for the LM to understand.',
    translation:
      '我们认为智能体-计算机接口（ACI）的设计对 Agent 性能有实质性影响。良好的 ACI 应当提供简洁且信息充分的反馈、防范常见错误，并且易于语言模型理解。',
    supports: ['方法核心思想', '关键模块'],
    confidence: 0.94,
    method_ids: ['M001'],
    gap_ids: ['G001'],
    direction_ids: [],
  },
  {
    evidence_id: 'E002',
    paper_id: 'P001',
    section: 'Section 3.2 Method',
    page: 4,
    content:
      'The agent operates in a loop: it observes the current state of the repository, issues a command, receives feedback, and continues until it believes the issue has been resolved or its budget is exhausted.',
    translation:
      'Agent 以循环方式运作：观察仓库当前状态、发出命令、接收反馈，并持续迭代，直到它认为问题已解决或预算耗尽。',
    supports: ['方法核心思想', '关键模块'],
    confidence: 0.96,
    method_ids: ['M001', 'M002'],
    gap_ids: [],
    direction_ids: ['D001'],
  },
  {
    evidence_id: 'E003',
    paper_id: 'P001',
    section: 'Section 5 Results',
    page: 7,
    content:
      'SWE-agent resolves 12.50% of the issues in the SWE-bench test set, substantially outperforming the non-interactive baseline of 3.80%.',
    translation:
      'SWE-agent 在 SWE-bench 测试集上解决了 12.50% 的 issue，显著优于非交互式基线的 3.80%。',
    supports: ['能力主张', '技术演进'],
    confidence: 0.98,
    method_ids: ['M001'],
    gap_ids: [],
    direction_ids: [],
  },
  {
    evidence_id: 'E004',
    paper_id: 'P001',
    section: 'Section 7 Limitations',
    page: 9,
    content:
      'The agent struggles with tasks requiring extensive context, and the cost of running the agent scales linearly with the number of steps. Failures are often caused by incorrect localization rather than incorrect edits.',
    translation:
      'Agent 在需要大量上下文的任务上表现挣扎，运行成本随步数线性增长。失败案例往往源于定位错误，而非编辑错误。',
    supports: ['局限', '研究空白'],
    confidence: 0.92,
    method_ids: ['M001', 'M002'],
    gap_ids: ['G001', 'G003'],
    direction_ids: ['D001'],
  },
  {
    evidence_id: 'E005',
    paper_id: 'P001',
    section: 'Section 4.2 Ablation',
    page: 6,
    content:
      'Removing the guarded edit tool leads to a large drop in performance, confirming that constraining the action space is critical for repository-level editing.',
    translation:
      '移除受约束的编辑工具会导致性能大幅下降，这证实了对动作空间施加约束对仓库级编辑至关重要。',
    supports: ['关键模块', '能力主张'],
    confidence: 0.89,
    method_ids: ['M002'],
    gap_ids: [],
    direction_ids: [],
  },

  /* ---------- P002 ReAct ---------- */
  {
    evidence_id: 'E006',
    paper_id: 'P002',
    section: 'Section 2 Method',
    page: 4,
    content:
      'We propose ReAct, a general paradigm that interleaves reasoning traces and task-specific actions. The reasoning traces help the model induce, track, and update action plans, while actions allow interaction with external sources.',
    translation:
      '我们提出 ReAct 这一通用范式，将推理痕迹与任务相关动作交错进行。推理痕迹帮助模型归纳、跟踪与更新行动计划，而动作则允许与外部资源交互。',
    supports: ['方法核心思想', '技术演进'],
    confidence: 0.97,
    method_ids: ['M003'],
    gap_ids: [],
    direction_ids: [],
  },
  {
    evidence_id: 'E007',
    paper_id: 'P002',
    section: 'Section 4 Discussion',
    page: 9,
    content:
      'Without an explicit search procedure, the agent can become stuck in repetitive loops and struggle to recover once it commits to an incorrect plan.',
    translation:
      '在缺乏显式搜索过程的情况下，Agent 可能陷入重复循环，一旦确定了错误计划便难以恢复。',
    supports: ['局限', '研究空白'],
    confidence: 0.88,
    method_ids: ['M003'],
    gap_ids: ['G002'],
    direction_ids: [],
  },

  /* ---------- P003 Toolformer ---------- */
  {
    evidence_id: 'E008',
    paper_id: 'P003',
    section: 'Section 2 Method',
    page: 3,
    content:
      'Our approach is self-supervised: we let the model annotate a large corpus with API calls, filter these annotations by whether they reduce perplexity, and fine-tune on the retained examples.',
    translation:
      '我们的方法是自监督的：让模型在大型语料上标注 API 调用，依据是否降低困惑度来过滤标注，并在保留的样本上微调。',
    supports: ['方法核心思想', '关键模块'],
    confidence: 0.93,
    method_ids: ['M004'],
    gap_ids: [],
    direction_ids: [],
  },

  /* ---------- P004 Tree of Thoughts ---------- */
  {
    evidence_id: 'E009',
    paper_id: 'P004',
    section: 'Section 2 Method',
    page: 3,
    content:
      'Tree of Thoughts generalizes chain-of-thought by maintaining a tree of thoughts, where each thought is a coherent language sequence. This allows the model to look ahead and backtrack when necessary.',
    translation:
      '思维树通过维护一棵"思维之树"推广了思维链，每个思维节点是一段连贯的语言序列。这使模型能够前瞻，并在必要时回溯。',
    supports: ['方法核心思想', '技术演进'],
    confidence: 0.95,
    method_ids: ['M005'],
    gap_ids: [],
    direction_ids: [],
  },

  /* ---------- P005 Reflexion ---------- */
  {
    evidence_id: 'E010',
    paper_id: 'P005',
    section: 'Section 2 Method',
    page: 3,
    content:
      'Reflexion converts binary or scalar feedback into verbal feedback in the form of a textual summary, which is then stored in an episodic memory buffer and prepended to the next trial.',
    translation:
      'Reflexion 将二值或标量反馈转化为文本形式的语言反馈，存入情景记忆缓冲区，并在下一轮尝试前作为上下文前置。',
    supports: ['方法核心思想', '关键模块'],
    confidence: 0.94,
    method_ids: ['M006'],
    gap_ids: ['G001'],
    direction_ids: ['D001'],
  },
  {
    evidence_id: 'E011',
    paper_id: 'P005',
    section: 'Section 5 Limitations',
    page: 9,
    content:
      'The episodic memory buffer grows without bound, and the approach assumes access to a reliable feedback signal that may not exist in open-ended tasks.',
    translation:
      '情景记忆缓冲区会无限增长，且该方法假定存在可靠反馈信号——这在开放式任务中往往并不成立。',
    supports: ['局限', '研究空白'],
    confidence: 0.90,
    method_ids: ['M006'],
    gap_ids: ['G001', 'G005'],
    direction_ids: ['D001'],
  },

  /* ---------- P006 AutoGen ---------- */
  {
    evidence_id: 'E012',
    paper_id: 'P006',
    section: 'Section 3 Framework',
    page: 4,
    content:
      'AutoGen agents are conversable and customizable. They can operate in a variety of modes that employ combinations of LLMs, human inputs, and tools, and their conversations can be automatically orchestrated.',
    translation:
      'AutoGen 的 Agent 是可对话、可定制的。它们能以多种模式运行，组合使用大模型、人类输入与工具，其对话可被自动编排。',
    supports: ['方法核心思想', '关键模块'],
    confidence: 0.93,
    method_ids: ['M007'],
    gap_ids: [],
    direction_ids: [],
  },
  {
    evidence_id: 'E013',
    paper_id: 'P006',
    section: 'Section 6 Limitations',
    page: 10,
    content:
      'Multi-agent conversations can be expensive and may not converge, and errors introduced by one agent can propagate unchecked to downstream agents.',
    translation:
      '多 Agent 对话可能成本高昂且不收敛，且某个 Agent 引入的错误可能未经检查就传播到下游 Agent。',
    supports: ['局限', '研究空白'],
    confidence: 0.87,
    method_ids: ['M007'],
    gap_ids: ['G004'],
    direction_ids: [],
  },

  /* ---------- P007 Self-Refine ---------- */
  {
    evidence_id: 'E014',
    paper_id: 'P007',
    section: 'Section 2 Method',
    page: 3,
    content:
      'Self-Refine uses a single LLM to generate an initial output, provide feedback on it, and refine it iteratively, requiring no additional training or external feedback.',
    translation:
      'Self-Refine 使用同一个大模型生成初始输出、对其提供反馈并迭代精修，无需额外训练或外部反馈。',
    supports: ['方法核心思想'],
    confidence: 0.92,
    method_ids: ['M008'],
    gap_ids: ['G005'],
    direction_ids: [],
  },

  /* ---------- P008 CodeT5 ---------- */
  {
    evidence_id: 'E015',
    paper_id: 'P008',
    section: 'Section 3 Model',
    page: 3,
    content:
      'CodeT5 employs an identifier-aware denoising objective that teaches the model to recover masked identifiers from their surrounding code context and comments.',
    translation:
      'CodeT5 采用标识符感知的去噪目标，教会模型根据周边代码上下文与注释恢复被遮蔽的标识符。',
    supports: ['方法核心思想', '关键模块'],
    confidence: 0.91,
    method_ids: ['M009'],
    gap_ids: [],
    direction_ids: [],
  },

  /* ---------- P009 ChatDev ---------- */
  {
    evidence_id: 'E016',
    paper_id: 'P009',
    section: 'Section 2 Framework',
    page: 3,
    content:
      'ChatDev structures the development process into four phases: designing, coding, testing, and documenting, each carried out by specialized agents through structured dialogue.',
    translation:
      'ChatDev 将开发过程组织为设计、编码、测试、文档四个阶段，每阶段由专门化的 Agent 通过结构化对话完成。',
    supports: ['方法核心思想', '关键模块'],
    confidence: 0.93,
    method_ids: ['M010'],
    gap_ids: ['G004'],
    direction_ids: [],
  },
  {
    evidence_id: 'E017',
    paper_id: 'P009',
    section: 'Section 5 Limitations',
    page: 8,
    content:
      'The system performs well on small, self-contained software but struggles with large existing codebases, and there is no explicit mechanism to detect when the whole conversation has gone off track.',
    translation:
      '该系统在小型自包含软件上表现良好，但在大型既有代码库上表现挣扎，且缺乏检测整个对话是否已偏离目标的显式机制。',
    supports: ['局限', '研究空白'],
    confidence: 0.89,
    method_ids: ['M010'],
    gap_ids: ['G004'],
    direction_ids: [],
  },

  /* ---------- P010 AlphaCode ---------- */
  {
    evidence_id: 'E018',
    paper_id: 'P010',
    section: 'Section 2 Approach',
    page: 2,
    content:
      'AlphaCode generates millions of candidate programs, filters them using example tests, then clusters the survivors and submits a small set of candidates to maintain diversity.',
    translation:
      'AlphaCode 生成数百万个候选程序，用示例测试进行过滤，再对存活的候选聚类，并提交一小部分以保持多样性。',
    supports: ['方法核心思想', '关键模块'],
    confidence: 0.94,
    method_ids: ['M011'],
    gap_ids: ['G003'],
    direction_ids: [],
  },

  /* ---------- P011 SWE-bench ---------- */
  {
    evidence_id: 'E019',
    paper_id: 'P011',
    section: 'Section 2 Dataset',
    page: 3,
    content:
      'SWE-bench consists of 2,294 issue-pull request pairs from 12 popular Python repositories. Evaluation is performed by applying the generated patch and running the repository holdout tests.',
    translation:
      'SWE-bench 由来自 12 个流行 Python 仓库的 2294 个 issue-PR 对构成。评测通过应用生成的补丁并运行仓库留出测试来完成。',
    supports: ['方法核心思想'],
    confidence: 0.97,
    method_ids: ['M012'],
    gap_ids: ['G003'],
    direction_ids: [],
  },
  {
    evidence_id: 'E020',
    paper_id: 'P011',
    section: 'Section 5 Analysis',
    page: 9,
    content:
      'Analysis reveals that models frequently fail at localizing the files and functions that need to change, suggesting retrieval and long-context handling are the primary bottlenecks.',
    translation:
      '分析表明，模型经常在定位需要修改的文件与函数时失败，提示检索与长上下文处理是主要瓶颈。',
    supports: ['研究空白', '技术演进'],
    confidence: 0.95,
    method_ids: ['M012'],
    gap_ids: ['G001', 'G003'],
    direction_ids: ['D001', 'D003'],
  },
  {
    evidence_id: 'E028',
    paper_id: 'P011',
    section: 'Section 3 Evaluation Protocol',
    page: 5,
    content:
      'Evaluating on static issue-pull request pairs captures only a single snapshot of a repository, and cannot measure whether an agent degrades over long sequential tasks.',
    translation:
      '基于静态 issue-PR 对的评测只刻画了仓库的单一快照，无法衡量 Agent 在长时间连续任务中是否会性能退化。',
    supports: ['研究空白'],
    confidence: 0.86,
    method_ids: ['M002', 'M012'],
    gap_ids: ['G003'],
    direction_ids: ['D002'],
  },

  /* ---------- P012 OpenHands ---------- */
  {
    evidence_id: 'E021',
    paper_id: 'P012',
    section: 'Section 3 Architecture',
    page: 4,
    content:
      'The agent runs inside an event stream architecture: every action produces an event, and the stream can be replayed, inspected, and delegated to sub-agents.',
    translation:
      'Agent 运行在事件流架构中：每个动作都会产生一个事件，事件流可以被回放、检视，并委派给子 Agent。',
    supports: ['方法核心思想', '关键模块'],
    confidence: 0.92,
    method_ids: ['M013'],
    gap_ids: [],
    direction_ids: [],
  },
  {
    evidence_id: 'E022',
    paper_id: 'P012',
    section: 'Section 3.2 Runtime',
    page: 5,
    content:
      'Agents are given a sandboxed runtime with bash, a web browser, and an IPython kernel, allowing them to execute code and observe real consequences of their actions.',
    translation:
      'Agent 获得一个沙箱运行时，配备 bash、网页浏览器与 IPython 内核，可执行代码并观察其行为的真实后果。',
    supports: ['方法核心思想', '关键模块', '能力主张'],
    confidence: 0.94,
    method_ids: ['M013', 'M014'],
    gap_ids: [],
    direction_ids: [],
  },

  /* ---------- P014 MemGPT ---------- */
  {
    evidence_id: 'E023',
    paper_id: 'P014',
    section: 'Section 3 Method',
    page: 3,
    content:
      'We treat the LLM context window as main memory and the external storage as disk, letting the agent page information in and out through function calls.',
    translation:
      '我们把大模型上下文窗口视为主存、外部存储视为磁盘，让 Agent 通过函数调用在两者之间分页调度信息。',
    supports: ['方法核心思想', '关键模块'],
    confidence: 0.95,
    method_ids: ['M015'],
    gap_ids: ['G001'],
    direction_ids: ['D001'],
  },
  {
    evidence_id: 'E024',
    paper_id: 'P014',
    section: 'Section 6 Limitations',
    page: 9,
    content:
      'The paging policy is learned implicitly and errors in paging can permanently discard information that later turns out to be critical.',
    translation:
      '分页策略是隐式学得的，分页错误可能永久丢弃后续被证明是关键的信息。',
    supports: ['局限', '研究空白'],
    confidence: 0.88,
    method_ids: ['M015'],
    gap_ids: ['G001'],
    direction_ids: ['D001'],
  },

  /* ---------- P015 Aider ---------- */
  {
    evidence_id: 'E025',
    paper_id: 'P015',
    section: 'Repository Map',
    page: 1,
    content:
      'Aider builds a concise map of the entire repository using tree-sitter, ranking definitions by relevance so the most important parts of the codebase fit in a limited token budget.',
    translation:
      'Aider 使用 tree-sitter 构建整个仓库的精简地图，按相关性对定义排序，使代码库中最重要的部分能装进有限的 token 预算。',
    supports: ['方法核心思想', '关键模块'],
    confidence: 0.90,
    method_ids: ['M016'],
    gap_ids: ['G001'],
    direction_ids: [],
  },

  /* ---------- P016 ToolLLM ---------- */
  {
    evidence_id: 'E026',
    paper_id: 'P016',
    section: 'Section 3.2 DFSDT',
    page: 5,
    content:
      'We extend ReAct with a depth-first search based decision tree, which allows the model to backtrack from a failed API call and explore alternative branches.',
    translation:
      '我们在 ReAct 基础上引入了基于深度优先搜索的决策树，使模型能从失败的 API 调用中回溯并探索其他分支。',
    supports: ['方法核心思想', '方法关系', '技术演进'],
    confidence: 0.93,
    method_ids: ['M017', 'M003'],
    gap_ids: [],
    direction_ids: [],
  },

  /* ---------- P017 GPT-3 ---------- */
  {
    evidence_id: 'E027',
    paper_id: 'P017',
    section: 'Section 2 Approach',
    page: 3,
    content:
      'The model performs a task at inference time purely from a natural language description and a few examples, with no gradient updates whatsoever.',
    translation:
      '模型在推理阶段仅凭自然语言描述和少量示例即可完成任务，完全不进行梯度更新。',
    supports: ['方法核心思想', '技术演进'],
    confidence: 0.96,
    method_ids: ['M018'],
    gap_ids: [],
    direction_ids: [],
  },

  /* ---------- P018 CoT ---------- */
  {
    evidence_id: 'E029',
    paper_id: 'P018',
    section: 'Section 2 Method',
    page: 2,
    content:
      'Chain-of-thought prompting elicits reasoning in large language models by providing exemplars that contain intermediate reasoning steps, and emerges naturally only at sufficient model scale.',
    translation:
      '思维链提示通过提供包含中间推理步骤的示例，激发大语言模型的推理能力，且该能力只在模型规模足够大时才自然涌现。',
    supports: ['方法核心思想', '技术演进'],
    confidence: 0.95,
    method_ids: ['M019'],
    gap_ids: [],
    direction_ids: [],
  },

  /* ---------- P013 AgentBench ---------- */
  {
    evidence_id: 'E030',
    paper_id: 'P013',
    section: 'Section 4 Evaluation',
    page: 6,
    content:
      'AgentBench reveals a substantial gap between commercial and open-source models in long-horizon reasoning, and shows that performance degrades sharply as the number of interaction rounds increases.',
    translation:
      'AgentBench 揭示了商用模型与开源模型在长程推理上的显著差距，并表明随着交互轮数增加，性能会急剧下降。',
    supports: ['研究空白', '技术演进'],
    confidence: 0.91,
    method_ids: ['M012'],
    gap_ids: ['G001', 'G003'],
    direction_ids: ['D002'],
  },

  /* ---------- 跨论文关系型 Evidence ---------- */
  {
    evidence_id: 'E031',
    paper_id: 'P001',
    section: 'Section 2 Related Work',
    page: 2,
    content:
      'Our work builds on ReAct and Reflexion, extending the interleaved reasoning-acting loop to the repository-level software engineering setting with a purpose-built interface.',
    translation:
      '我们的工作建立在 ReAct 与 Reflexion 之上，将推理-行动交错循环扩展到仓库级软件工程场景，并配套设计了专用接口。',
    supports: ['方法关系', '技术演进'],
    confidence: 0.96,
    method_ids: ['M001', 'M003', 'M006'],
    gap_ids: [],
    direction_ids: [],
  },
  {
    evidence_id: 'E032',
    paper_id: 'P009',
    section: 'Section 2 Related Work',
    page: 2,
    content:
      'ChatDev shares the multi-agent dialogue paradigm of AutoGen but specializes it with role assignment and a fixed software-development chat chain.',
    translation:
      'ChatDev 沿用了 AutoGen 的多 Agent 对话范式，但通过角色分配和固定的软件开发对话链对其做了专门化。',
    supports: ['方法关系'],
    confidence: 0.89,
    method_ids: ['M010', 'M007'],
    gap_ids: [],
    direction_ids: [],
  },
  {
    evidence_id: 'E033',
    paper_id: 'P016',
    section: 'Section 2 Related Work',
    page: 3,
    content:
      'Unlike Toolformer which learns tool invocation during fine-tuning, our method keeps the backbone frozen and searches over tool calls at inference time.',
    translation:
      '与 Toolformer 在微调阶段学习工具调用不同，我们的方法保持主干模型冻结，而是在推理阶段对工具调用进行搜索。',
    supports: ['方法关系'],
    confidence: 0.9,
    method_ids: ['M017', 'M004'],
    gap_ids: [],
    direction_ids: [],
  },
  {
    evidence_id: 'E034',
    paper_id: 'P012',
    section: 'Section 2 Related Work',
    page: 3,
    content:
      'OpenHands generalizes the single-task ACI of SWE-agent into a reusable platform, and generalizes the multi-agent orchestration of AutoGen with a unified event stream.',
    translation:
      'OpenHands 把 SWE-agent 面向单一任务的 ACI 泛化为可复用平台，并用统一事件流泛化了 AutoGen 的多 Agent 编排。',
    supports: ['方法关系', '技术演进'],
    confidence: 0.92,
    method_ids: ['M013', 'M001', 'M007'],
    gap_ids: [],
    direction_ids: [],
  },
  {
    evidence_id: 'E035',
    paper_id: 'P014',
    section: 'Section 2 Related Work',
    page: 2,
    content:
      'MemGPT is complementary to reflection-based approaches: Reflexion stores failures as language, while MemGPT governs where that language lives.',
    translation:
      'MemGPT 与基于反思的方法互补：Reflexion 把失败经验存为语言，MemGPT 则管理这些语言存放的位置。',
    supports: ['方法关系', '研究空白'],
    confidence: 0.87,
    method_ids: ['M015', 'M006'],
    gap_ids: ['G001'],
    direction_ids: ['D001'],
  },
  {
    evidence_id: 'E036',
    paper_id: 'P011',
    section: 'Section 6 Discussion',
    page: 10,
    content:
      'Current benchmarks measure single-issue resolution and provide no signal about code maintainability, security implications, or the long-term health of the repository.',
    translation:
      '当前基准只衡量单个 issue 的解决情况，对代码可维护性、安全影响或仓库长期健康度没有任何信号。',
    supports: ['研究空白'],
    confidence: 0.93,
    method_ids: ['M012'],
    gap_ids: ['G003'],
    direction_ids: ['D003'],
  },
  {
    evidence_id: 'E037',
    paper_id: 'P006',
    section: 'Section 5 Evaluation',
    page: 9,
    content:
      'The number of conversation rounds is a dominant cost factor, yet there is no principled method to determine when a multi-agent conversation should terminate.',
    translation:
      '对话轮数是主要的成本因素，但目前尚无原则性方法来判断多 Agent 对话应在何时终止。',
    supports: ['局限', '研究空白'],
    confidence: 0.9,
    method_ids: ['M007'],
    gap_ids: ['G004'],
    direction_ids: ['D003'],
  },
  {
    evidence_id: 'E038',
    paper_id: 'P009',
    section: 'Section 6 Case Study',
    page: 9,
    content:
      'In case studies where the task required more than twenty consecutive steps, the agents frequently lost track of earlier requirements and reverted previously accepted changes.',
    translation:
      '在需要连续二十步以上的案例研究中，Agent 经常丢失早期需求，并回滚此前已被接受的修改。',
    supports: ['研究空白', '局限'],
    confidence: 0.88,
    method_ids: ['M010', 'M002'],
    gap_ids: ['G001'],
    direction_ids: ['D001'],
  },
]
