import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { clsx } from 'clsx'
import { Chip, IconClose, IconQuote, IconSend, IconSparkles } from './ui'
import { useEvidenceDrawer } from '@/context/AppContext'
import {
  getEvidenceByIds,
  getFamilyDistribution,
  getGaps,
  getMethod,
  stats,
} from '@/services/selectors'

interface Msg {
  id: number
  role: 'user' | 'assistant'
  text: string
  /** 引用的 evidence ID */
  evidenceIds?: string[]
  /** 引用的实体链接 */
  links?: { label: string; to: string }[]
}

/** 建议问题 */
const SUGGESTIONS = [
  '目前最常见的方法是什么？',
  '技术演进有什么变化？',
  '为什么认为这是一个研究空白？',
  '这个结论来自哪篇论文？',
  '帮我解释 SWE-agent 这个方法',
]

/**
 * 本地知识库问答
 *
 * 当前为规则驱动：基于项目结构化数据生成回答，并强制附带 Evidence 引用。
 * 后续接入真实 AI 时，只需把 answerQuestion 换成 LLM 调用，
 * 但"必须返回 evidenceIds"这一契约应保持不变。
 */
function answerQuestion(q: string, projectId: string): Omit<Msg, 'id' | 'role'> {
  const text = q.trim()
  const pid = projectId

  if (/最常见|主流|最热|最常用|方法.*多/.test(text)) {
    const dist = [...getFamilyDistribution()].sort((a, b) => b.value - a.value)
    const top = dist[0]
    return {
      text: `当前项目中**方法最多的是「${top.name}」方法族**，共 ${top.value} 个方法。整体分布为：${dist
        .map((d) => `${d.name} ${d.value} 个`)
        .join('、')}。\n\n从时间上看，2023 年是方法爆发的一年——工具使用、搜索式规划、自我反思、多 Agent 对话在同一年密集涌现；2024 年则收敛到「软件工程智能体」这一具体场景。`,
      links: [
        { label: '查看方法地图', to: `/project/${pid}/methods` },
        { label: '查看技术演进', to: `/project/${pid}/evolution` },
      ],
      evidenceIds: ['E006', 'E001', 'E012'],
    }
  }

  if (/演进|发展|变化|历史|时间线/.test(text)) {
    return {
      text: `技术演进可概括为五个阶段：\n\n**① 2020 · 上下文学习** — 无需梯度更新即可适配新任务，成为所有后续方法的共同底座。\n\n**② 2022 · 推理显式化** — 思维链把推理过程显式化，ReAct 进一步把推理与动作交错，形成 Agent 循环雏形。\n\n**③ 2023 · 能力爆发** — 工具调用、搜索式规划、自我反思、多 Agent 对话密集出现，但各能力彼此孤立。\n\n**④ 2023 末 · 评测补齐** — SWE-bench 用真实 Issue–PR 对 + 隐藏测试建立客观指标，失败模式被系统化暴露。\n\n**⑤ 2024 · 场景收敛** — ACI 设计被确立为一等研究对象，SWE-bench 解决率从 3.80% 跃升至 12.50%。`,
      links: [{ label: '查看完整时间线', to: `/project/${pid}/evolution` }],
      evidenceIds: ['E027', 'E029', 'E006', 'E019', 'E003'],
    }
  }

  if (/空白|gap|为什么认为|依据/.test(text)) {
    const gaps = getGaps()
    const g = gaps[0]
    return {
      text: `以排名第一的空白为例：**${g.title}**（${g.type === 'method' ? '方法空白' : g.type}）。\n\n判定依据来自多个独立来源的交叉证据：\n\n- 方法本身承认局限（SWE-agent 明确提到长上下文任务表现挣扎）\n- 相关方法暴露同类问题（Reflexion 的记忆缓冲区无限增长；ChatDev 在 20 步以上任务中丢失早期需求）\n- 评测体系无法覆盖（SWE-bench 只测单 Issue，测不出长周期退化）\n\n**三类证据同时指向同一问题**，因此系统判定这是一个真实的研究空白，而非单一论文的个别现象。该空白由 ${g.supporting_papers.length} 篇论文、${g.evidence_ids.length} 条证据共同支撑。`,
      links: [
        { label: '查看全部研究空白', to: `/project/${pid}/gaps` },
        { label: '查看对应研究方向', to: `/project/${pid}/directions` },
      ],
      evidenceIds: g.evidence_ids.slice(0, 4),
    }
  }

  if (/来自哪|哪篇论文|出处|引用|证据|依据是什么/.test(text)) {
    return {
      text: `本项目所有关键结论都强制关联到原文证据。当前共锚定 **${stats.evidenceCount} 条 Evidence**，每条都记录了来源论文、章节、页码与原文片段。\n\n例如「SWE-agent 在 SWE-bench 上解决 12.50% 的 issue」这一结论，来自论文 Section 5 Results 第 7 页，置信度 0.98。\n\n你可以在任意卡片上点击「N Evidence」按钮，从右侧抽屉查看原文。`,
      links: [
        { label: '打开文献库', to: `/project/${pid}/papers` },
        { label: '查看方法地图', to: `/project/${pid}/methods` },
      ],
      evidenceIds: ['E003', 'E001', 'E020'],
    }
  }

  const m = /SWE-?agent|aci|接口/i.test(text)
    ? getMethod('M001')
    : /react/i.test(text)
      ? getMethod('M003')
      : /记忆|memory|memgpt/i.test(text)
        ? getMethod('M015')
        : /多\s*agent|multi-?agent|chatdev|autogen/i.test(text)
          ? getMethod('M010')
          : getMethod('M001')

  if (m) {
    return {
      text: `**${m.name}**（${m.name_zh}）\n\n所属方法族：${m.family_id} · ${m.paradigm} · 首次出现 ${m.year} 年\n\n**核心思想**：${m.core_idea}\n\n**关键模块**：${m.modules.join('、')}\n\n**主要优势**：${m.advantages[0]}。\n\n**主要局限**：${m.limitations.join('；')}。`,
      links: [
        { label: `在方法地图中查看`, to: `/project/${pid}/methods?focus=${m.method_id}` },
        { label: '查看相关论文', to: `/project/${pid}/papers/${m.paper_ids[0]}` },
      ],
      evidenceIds: m.evidence_ids.slice(0, 3),
    }
  }

  return {
    text: `我可以基于当前项目的 **${stats.paperCount} 篇论文 / ${stats.methodCount} 个方法 / ${stats.gapCount} 项空白** 回答方法、演进、空白与研究方向相关问题。\n\n所有回答都会附带原文证据。试试问我：「技术演进有什么变化？」或「为什么认为这是一个研究空白？」`,
    evidenceIds: [],
  }
}

export function AIAssistant() {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [messages, setMessages] = useState<Msg[]>([])
  const { id } = useParams()
  const pid = id ?? 'proj-aicoding-agent'
  const { open: openEvidence } = useEvidenceDrawer()
  const seq = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, thinking])

  const send = (raw?: string) => {
    const q = (raw ?? input).trim()
    if (!q || thinking) return
    setInput('')
    seq.current += 1
    const userMsg: Msg = { id: seq.current, role: 'user', text: q }
    setMessages((prev) => [...prev, userMsg])
    setThinking(true)

    setTimeout(() => {
      const ans = answerQuestion(q, pid)
      seq.current += 1
      setMessages((prev) => [...prev, { ...ans, id: seq.current, role: 'assistant' }])
      setThinking(false)
    }, 700)
  }

  const evidenceMap = useMemo(() => {
    const ids = [...new Set(messages.flatMap((m) => m.evidenceIds ?? []))]
    return getEvidenceByIds(ids)
  }, [messages])

  return (
    <>
      {/* 悬浮按钮 */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="mp-anim-pulse fixed bottom-5 right-5 z-40 flex h-11 items-center gap-2 rounded-full bg-gradient-to-br from-brand-500 to-brand-700 px-4 text-white shadow-xl transition hover:scale-[1.03] active:scale-95"
        >
          <IconSparkles className="h-4 w-4" />
          <span className="text-[13px] font-medium">问 MethodPilot</span>
        </button>
      )}

      {/* 面板 */}
      {open && (
        <div className="mp-anim-fade-up fixed bottom-5 right-5 z-40 flex h-[520px] w-[380px] flex-col overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-2xl">
          {/* 头部 */}
          <div className="flex items-center justify-between border-b border-ink-200 bg-gradient-to-r from-brand-50 to-white px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-white">
                <IconSparkles className="h-3.5 w-3.5" />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-ink-900">MethodPilot 助手</p>
                <p className="text-[10px] text-ink-400">回答基于项目数据与原文证据</p>
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="rounded-lg p-1.5 text-ink-400 transition hover:bg-white hover:text-ink-700"
            >
              <IconClose className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* 消息区 */}
          <div ref={scrollRef} className="mp-scroll-thin flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.length === 0 && (
              <div className="space-y-3">
                <p className="text-[12.5px] leading-relaxed text-ink-500">
                  你好，我是 MethodPilot。已加载{' '}
                  <span className="font-medium text-ink-700">{stats.paperCount} 篇论文</span>、
                  <span className="font-medium text-ink-700"> {stats.methodCount} 个方法</span> 与{' '}
                  <span className="font-medium text-ink-700">{stats.evidenceCount} 条证据</span>。
                  我的回答会尽可能标注出处。
                </p>
                <div className="space-y-1.5">
                  <p className="mp-label">试试问我</p>
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-left text-[12.5px] text-ink-600 transition hover:border-brand-200 hover:bg-brand-50/50 hover:text-brand-700"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) => (
              <div key={m.id} className={clsx('flex', m.role === 'user' && 'justify-end')}>
                <div
                  className={clsx(
                    'max-w-[88%] rounded-xl px-3 py-2',
                    m.role === 'user'
                      ? 'bg-brand-600 text-white'
                      : 'border border-ink-200 bg-ink-50/70 text-ink-700',
                  )}
                >
                  <div
                    className={clsx(
                      'whitespace-pre-wrap text-[12.5px] leading-relaxed',
                      m.role === 'assistant' && '[&_strong]:font-semibold [&_strong]:text-ink-900',
                    )}
                  >
                    {renderRich(m.text)}
                  </div>

                  {m.role === 'assistant' && m.links && m.links.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {m.links.map((l) => (
                        <Link
                          key={l.to}
                          to={l.to}
                          className="rounded-md border border-brand-200 bg-white px-2 py-0.5 text-[11px] font-medium text-brand-700 transition hover:bg-brand-50"
                        >
                          {l.label}
                        </Link>
                      ))}
                    </div>
                  )}

                  {m.role === 'assistant' && m.evidenceIds && m.evidenceIds.length > 0 && (
                    <div className="mt-2 border-t border-ink-200 pt-2">
                      <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                        <IconQuote className="h-2.5 w-2.5" /> 引用证据
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {m.evidenceIds.map((eid) => {
                          const ev = evidenceMap.find((e) => e.evidence_id === eid)
                          if (!ev) return null
                          return (
                            <button
                              key={eid}
                              onClick={() => openEvidence(eid)}
                              title={ev.content}
                              className="rounded border border-brand-200 bg-brand-50/70 px-1.5 py-0.5 font-mono text-[10px] text-brand-700 transition hover:bg-brand-100"
                            >
                              #{eid}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {thinking && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-xl border border-ink-200 bg-ink-50/70 px-3 py-2">
                  <span className="flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-400"
                        style={{ animationDelay: `${i * 120}ms` }}
                      />
                    ))}
                  </span>
                  <span className="text-[11.5px] text-ink-500">正在检索项目数据与证据…</span>
                </div>
              </div>
            )}
          </div>

          {/* 输入 */}
          <div className="border-t border-ink-200 p-3">
            <div className="flex items-center gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()}
                className="mp-input h-9 text-[12.5px]"
                placeholder="问点什么…（结论会附证据）"
              />
              <button
                onClick={() => send()}
                disabled={!input.trim() || thinking}
                className="mp-btn mp-btn-primary h-9 w-9 !px-0"
              >
                <IconSend className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              <Chip tone="neutral">{stats.paperCount} 论文</Chip>
              <Chip tone="neutral">{stats.methodCount} 方法</Chip>
              <Chip tone="neutral">{stats.evidenceCount} 证据</Chip>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** 极简 markdown 渲染：**粗体** 与换行 */
function renderRich(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? (
      <strong key={i}>{p.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{p}</span>
    ),
  )
}

export { SUGGESTIONS }
