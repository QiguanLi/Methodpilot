import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { clsx } from 'clsx'
import { PageHeader } from '@/components/AppLayout'
import {
  Card,
  Chip,
  IconArrowRight,
  IconCheck,
  IconSparkles,
  IconUpload,
  SectionTitle,
} from '@/components/ui'
import { useToast } from '@/context/AppContext'
import { api } from '@/services/api'
import { DEMO_PROJECT_ID } from '@/services/projectData'

const DOMAINS = [
  { id: 'ai-coding', name: 'AI Coding Agent', desc: '代码生成、软件工程智能体、仓库级任务求解', papers: 18, ready: true },
  { id: 'rag', name: 'Retrieval-Augmented Generation', desc: '检索增强生成、向量检索、知识注入', papers: 0, ready: false },
  { id: 'multimodal', name: 'Multimodal LLM', desc: '视觉-语言模型、多模态理解与生成', papers: 0, ready: false },
  { id: 'rl-agent', name: 'Reinforcement Learning Agent', desc: '强化学习智能体、决策与规划', papers: 0, ready: false },
  { id: 'custom', name: '自定义领域', desc: '上传你自己的论文集合，由 Agent 自动构建领域结构', papers: 0, ready: false },
]

export function NewProjectPage() {
  const navigate = useNavigate()
  const { push } = useToast()
  const [name, setName] = useState('AI Coding Agent 方法演进研究')
  const [desc, setDesc] = useState(
    '聚焦 AI Coding Agent / Software Engineering Agent 细分领域，梳理关键方法、技术演进路径与尚未解决的研究空白。',
  )
  const [domain, setDomain] = useState('ai-coding')
  const [withDemo, setWithDemo] = useState(true)
  const [creating, setCreating] = useState(false)

  /**
   * 创建项目。
   *
   * Phase 2 之前这里是一个纯前端动画：等 900ms、弹个 Toast、
   * 然后**永远跳转到演示项目**。用户要求的闭环第一步是「新建项目」，
   * 那个假动作会让闭环在起点就断掉——新建完还是回到 Demo。
   *
   * 现在的规则：
   *   勾选"加载演示数据" → 这是想看 Demo，跳演示项目（保留原体验）。
   *   不勾选             → 这是要上传自己的论文，必须在服务端真的建一个项目，
   *                        然后跳它的上传页。
   * 不勾选时服务端不可用就直接报错，不静默降级到 Demo —
   * 否则用户以为在分析自己的论文，实际看到的是演示数据。
   */
  const create = async () => {
    if (!name.trim()) {
      push({ title: '项目名称不能为空', tone: 'warn' })
      return
    }

    if (withDemo) {
      setCreating(true)
      await new Promise((r) => setTimeout(r, 900))
      setCreating(false)
      push({
        title: '演示项目已就绪',
        description: '已加载预置演示论文，用于展示方法地图等能力',
        tone: 'success',
      })
      navigate(`/project/${DEMO_PROJECT_ID}/analysis`)
      return
    }

    setCreating(true)
    try {
      const project = await api.createProject({
        name: name.trim(),
        description: desc.trim(),
        domain,
      })
      push({
        title: '项目创建成功',
        description: '现在上传 PDF，服务端会解析并抽取方法',
        tone: 'success',
      })
      navigate(`/project/${project.id}/upload`)
    } catch (e: unknown) {
      // 不降级、不吞掉。让用户知道服务端没起来，而不是看到一个空项目
      push({
        title: '创建项目失败',
        description: `${e instanceof Error ? e.message : String(e)}。请确认分析服务已启动。`,
        tone: 'error',
      })
    } finally {
      setCreating(false)
    }
  }

  const selected = DOMAINS.find((d) => d.id === domain)

  return (
    <div className="mp-anim-fade-up space-y-5">
      <PageHeader
        title="创建研究项目"
        subtitle="选择一个细分领域或上传自己的论文集合，Agent 会自动解析并构建方法结构"
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          {/* 基本信息 */}
          <Card className="p-5">
            <SectionTitle title="基本信息" subtitle="项目名称会显示在顶部导航与生成的报告中" />
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium text-ink-700">
                  项目名称
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mp-input"
                  placeholder="例如：AI Coding Agent 方法演进研究"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium text-ink-700">
                  项目描述
                </label>
                <textarea
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  rows={3}
                  className="mp-input resize-none"
                  placeholder="简要说明本研究聚焦的问题与范围"
                />
              </div>
            </div>
          </Card>

          {/* 领域选择 */}
          <Card className="p-5">
            <SectionTitle
              title="选择细分领域"
              subtitle="Agent 会基于领域先验知识优化方法抽取与分类策略"
            />
            <div className="grid gap-2.5 sm:grid-cols-2">
              {DOMAINS.map((d) => (
                <button
                  key={d.id}
                  onClick={() => setDomain(d.id)}
                  className={clsx(
                    'rounded-xl border p-3.5 text-left transition',
                    domain === d.id
                      ? 'border-brand-400 bg-brand-50/60 shadow-[0_0_0_3px_var(--color-brand-50)]'
                      : 'border-ink-200 bg-white hover:border-brand-200',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[13px] font-semibold text-ink-800">{d.name}</p>
                    <span
                      className={clsx(
                        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                        domain === d.id
                          ? 'border-brand-500 bg-brand-500 text-white'
                          : 'border-ink-300',
                      )}
                    >
                      {domain === d.id && <IconCheck className="h-2.5 w-2.5" />}
                    </span>
                  </div>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-ink-500">{d.desc}</p>
                  {d.ready && (
                    <Chip tone="success" className="mt-2">
                      已有 {d.papers} 篇演示论文
                    </Chip>
                  )}
                </button>
              ))}
            </div>
          </Card>

          {/* 数据来源 */}
          <Card className="p-5">
            <SectionTitle title="数据来源" subtitle="演示数据与真实上传数据完全隔离，不会混在一起" />
            <div className="space-y-2.5">
              <button
                onClick={() => setWithDemo(true)}
                className={clsx(
                  'flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition',
                  withDemo
                    ? 'border-brand-400 bg-brand-50/60 shadow-[0_0_0_3px_var(--color-brand-50)]'
                    : 'border-ink-200 bg-white hover:border-brand-200',
                )}
              >
                <span
                  className={clsx(
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                    withDemo ? 'border-brand-500 bg-brand-500 text-white' : 'border-ink-300',
                  )}
                >
                  {withDemo && <IconCheck className="h-2.5 w-2.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-ink-800">
                    使用内置演示数据（推荐）
                  </p>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-ink-500">
                    加载 18 篇 AI Coding Agent 领域论文、19 个方法、5 项研究空白与 3 个研究方向，
                    以及 38 条锚定到章节的原文证据。可立即完整演示全流程。
                  </p>
                </div>
              </button>

              <button
                onClick={() => setWithDemo(false)}
                className={clsx(
                  'flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition',
                  !withDemo
                    ? 'border-brand-400 bg-brand-50/60 shadow-[0_0_0_3px_var(--color-brand-50)]'
                    : 'border-ink-200 bg-white hover:border-brand-200',
                )}
              >
                <span
                  className={clsx(
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                    !withDemo ? 'border-brand-500 bg-brand-500 text-white' : 'border-ink-300',
                  )}
                >
                  {!withDemo && <IconCheck className="h-2.5 w-2.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-ink-800">
                    上传自己的论文（PDF）
                  </p>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-ink-500">
                    在服务端创建一个空项目，跳转到上传页。真实 PDF 会被解析出章节与页码，
                    并抽取方法 + 原文证据，每条证据都逐字回验到具体页码。
                  </p>
                </div>
              </button>

              {!withDemo && (
                <div className="rounded-xl border border-dashed border-ink-300 bg-ink-50/60 px-4 py-8 text-center">
                  <IconUpload className="mx-auto h-6 w-6 text-ink-400" />
                  <p className="mt-2 text-[12.5px] font-medium text-ink-600">
                    创建后在下一步上传 PDF
                  </p>
                  <p className="mt-1 text-[11px] text-ink-400">
                    支持批量上传（最多 10 个）· 单文件不超过 40MB
                  </p>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* 右侧：预览与创建 */}
        <div className="space-y-4">
          <Card className="p-5">
            <SectionTitle title="项目预览" />
            <div className="rounded-xl border border-ink-200 bg-gradient-to-br from-brand-50 to-white p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-brand-600">
                MethodPilot
              </p>
              <p className="mt-2 text-[15px] font-semibold leading-snug text-ink-900">
                {name || '未命名项目'}
              </p>
              <p className="mt-1.5 line-clamp-3 text-[11.5px] leading-relaxed text-ink-500">
                {desc || '暂无描述'}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Chip tone="brand">{selected?.name ?? '未选择'}</Chip>
                <Chip tone={withDemo ? 'success' : 'neutral'}>
                  {withDemo ? '18 篇演示论文' : '空项目'}
                </Chip>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              {[
                { k: '创建后自动执行', v: withDemo ? '加载演示数据' : 'PDF 解析 → 方法抽取 → 证据校验' },
                { k: '预计耗时', v: withDemo ? '约 1 秒（本地数据）' : '每篇 1–3 分钟' },
                { k: '可随时重跑', v: '智能分析页面' },
              ].map((x) => (
                <div key={x.k} className="flex items-center justify-between">
                  <span className="text-[11.5px] text-ink-400">{x.k}</span>
                  <span className="text-[11.5px] font-medium text-ink-700">{x.v}</span>
                </div>
              ))}
            </div>

            <button
              className="mp-btn mp-btn-primary mt-4 w-full"
              onClick={create}
              disabled={creating}
            >
              {creating ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  正在创建…
                </>
              ) : (
                <>
                  <IconSparkles className="h-3.5 w-3.5" /> 创建并开始分析
                </>
              )}
            </button>
          </Card>

          <Card className="p-5">
            <SectionTitle title="Agent 将自动完成" />
            <div className="space-y-2.5">
              {[
                { n: '01', t: '批量文献解析', d: '切分章节，抽取摘要、方法与实验段落' },
                { n: '02', t: '方法自动分类', d: '按任务与范式聚类，归纳方法族' },
                { n: '03', t: '技术演进梳理', d: '重建方法间的继承、改进与组合关系' },
                { n: '04', t: '研究方向推导', d: '识别研究空白并生成可执行的候选方向' },
              ].map((x) => (
                <div key={x.n} className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-50 font-mono text-[10.5px] font-semibold text-brand-600">
                    {x.n}
                  </span>
                  <div className="min-w-0">
                    <p className="text-[12.5px] font-medium text-ink-800">{x.t}</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-ink-500">{x.d}</p>
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={() => navigate('/dashboard')}
              className="mt-4 flex w-full items-center justify-center gap-1 text-[12px] font-medium text-brand-600 transition hover:text-brand-700"
            >
              先看看已有项目的效果 <IconArrowRight className="h-3 w-3" />
            </button>
          </Card>
        </div>
      </div>
    </div>
  )
}
