import type { PipelineStage } from '@/types'

export const pipelineStages: PipelineStage[] = [
  {
    id: 'S1',
    index: 1,
    name: '文献解析',
    name_en: 'Paper Parsing',
    description: '解析 PDF 结构，切分章节，抽取摘要、方法与实验段落。',
    status: 'done',
    progress: { done: 18, total: 18 },
  },
  {
    id: 'S2',
    index: 2,
    name: '方法抽取',
    name_en: 'Method Extraction',
    description: '从正文中识别方法实体，抽取核心思想、关键模块与输入输出。',
    status: 'done',
    progress: { done: 18, total: 18 },
  },
  {
    id: 'S3',
    index: 3,
    name: '方法分类',
    name_en: 'Method Classification',
    description: '按研究任务与方法范式聚类，归纳方法族。',
    status: 'running',
    progress: { done: 8, total: 18 },
  },
  {
    id: 'S4',
    index: 4,
    name: '技术关系分析',
    name_en: 'Relation Analysis',
    description: '判定方法之间的继承、改进、组合、替代与并行关系。',
    status: 'waiting',
    progress: { done: 0, total: 20 },
  },
  {
    id: 'S5',
    index: 5,
    name: '研究空白发现',
    name_en: 'Gap Detection',
    description: '对跨论文证据做对比归因，识别方法、数据、评测与应用层面的空白。',
    status: 'waiting',
    progress: { done: 0, total: 5 },
  },
  {
    id: 'S6',
    index: 6,
    name: '研究方向推导',
    name_en: 'Direction Generation',
    description: '基于空白与证据生成候选研究方向，并给出实验设计与风险分析。',
    status: 'waiting',
    progress: { done: 0, total: 3 },
  },
]

/** AI 分析日志（模拟运行中的 Agent 输出） */
export const analysisLogs = [
  { time: '14:32:18', message: '开始批量解析，共 18 篇论文入队', level: 'info' as const },
  { time: '14:32:21', message: '正在分析 SWE-agent: Agent-Computer Interfaces…', level: 'info' as const, ref: { type: 'paper' as const, id: 'P001' } },
  { time: '14:32:24', message: '发现方法：Agent-Computer Interface', level: 'success' as const, ref: { type: 'method' as const, id: 'M001' } },
  { time: '14:32:25', message: '关联技术：Tool Use / Repository-Level Editing', level: 'info' as const },
  { time: '14:32:27', message: '发现潜在改进：Context Management', level: 'warn' as const },
  { time: '14:32:29', message: '建立 Evidence #E001（Section 3.1, p.3, confidence 0.94）', level: 'evidence' as const, ref: { type: 'evidence' as const, id: 'E001' } },
  { time: '14:32:31', message: '建立 Evidence #E002（Section 3.2, p.4, confidence 0.96）', level: 'evidence' as const, ref: { type: 'evidence' as const, id: 'E002' } },
  { time: '14:32:35', message: '正在分析 ReAct: Synergizing Reasoning and Acting…', level: 'info' as const, ref: { type: 'paper' as const, id: 'P002' } },
  { time: '14:32:37', message: '发现方法：ReAct Loop', level: 'success' as const, ref: { type: 'method' as const, id: 'M003' } },
  { time: '14:32:39', message: '判定关系：M001 extends M003（证据 E031, E006）', level: 'success' as const },
  { time: '14:32:42', message: '建立 Evidence #E006（Section 2, p.4, confidence 0.97）', level: 'evidence' as const, ref: { type: 'evidence' as const, id: 'E006' } },
  { time: '14:32:46', message: '正在分析 Reflexion: Language Agents with Verbal RL…', level: 'info' as const, ref: { type: 'paper' as const, id: 'P005' } },
  { time: '14:32:48', message: '发现方法：Verbal Reinforcement Learning', level: 'success' as const, ref: { type: 'method' as const, id: 'M006' } },
  { time: '14:32:50', message: '警告：情景记忆无限增长，标记为潜在研究空白', level: 'warn' as const, ref: { type: 'evidence' as const, id: 'E011' } },
  { time: '14:32:53', message: '正在分析 MemGPT: Towards LLMs as Operating Systems…', level: 'info' as const, ref: { type: 'paper' as const, id: 'P014' } },
  { time: '14:32:55', message: '发现方法：Virtual Context Management', level: 'success' as const, ref: { type: 'method' as const, id: 'M015' } },
  { time: '14:32:57', message: '建立跨论文关系：M006 combines M015（证据 E035）', level: 'success' as const },
  { time: '14:33:02', message: '方法分类进行中：已归类 8/18 篇', level: 'info' as const },
  { time: '14:33:05', message: '聚类得到 5 个方法族：SE Agent / Tool-Using / Planning / Multi-Agent / CodeGen', level: 'success' as const },
  { time: '14:33:09', message: 'Evidence 覆盖检查：36 条证据中 34 条已锚定到具体章节', level: 'evidence' as const },
  { time: '14:33:12', message: '等待第 3 阶段完成，后续阶段将自动触发…', level: 'info' as const },
]

/** Dashboard 统计卡 */
export const dashboardStats = [
  { key: 'papers', label: '已分析论文', value: 18, unit: '篇', accent: '#6d5cf0' },
  { key: 'methods', label: '识别方法', value: 19, unit: '个', accent: '#0ea5e9' },
  { key: 'families', label: '方法族', value: 5, unit: '个', accent: '#10b981' },
  { key: 'evolution', label: '技术演进节点', value: 10, unit: '个', accent: '#f59e0b' },
  { key: 'gaps', label: '研究空白', value: 5, unit: '个', accent: '#ec4899' },
  { key: 'directions', label: '候选研究方向', value: 3, unit: '个', accent: '#8b5cf6' },
]

/** AI 分析流水线各阶段的模拟耗时（毫秒），用于演示动画节奏 */
export const stageDuration: Record<string, number> = {
  S1: 1400,
  S2: 1800,
  S3: 2200,
  S4: 2000,
  S5: 2400,
  S6: 2000,
}
