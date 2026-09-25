import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { clsx } from 'clsx'
import {
  Chip,
  IconArrowRight,
  IconCheck,
  IconClose,
  IconLink,
  IconQuote,
  ModeBadge,
  ProgressBar,
  SourceBadge,
} from './ui'
import { useEvidenceDrawer, useToast } from '@/context/AppContext'
import { api } from '@/services/api'
import { findRegisteredEvidence, findRegisteredPaper, getRegisteredEngine } from '@/services/projectData'
import { getDirection, getEvidence, getGap, getMethod, getPaper } from '@/services/selectors'

/**
 * Evidence 证据抽屉
 *
 * 产品核心创新点：任何 AI 结论都可以展开看到它在原论文中的出处。
 * 数据结构上，Evidence 锚定 (paper_id, section, page, content)，
 * 因此后续接入真实解析时，只需填充这些字段即可，UI 无需改动。
 *
 * Phase 2 改动：真实上传项目的证据不再走浏览器内的 Mock 查询函数，
 * 而是走 findRegisteredEvidence()——由页面注册的当前数据集。
 * 原因见 projectData.ts：Demo 的 E001 与真实项目的 E001 是两条不同的证据，
 * 混用会让抽屉显示"另一个项目"的原文，且看不出错。
 */
export function EvidenceDrawer() {
  const { evidenceId, close } = useEvidenceDrawer()
  const { id: projectId } = useParams()
  const pid = projectId ?? 'proj-aicoding-agent'

  // ESC 关闭
  useEffect(() => {
    if (!evidenceId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [evidenceId, close])

  /**
   * 优先取当前已注册数据集（真实项目），取不到才回落 Demo。
   *
   * 这里刻意**不是**简单的 `live ?? demo`：真实项目里如果查不到这条证据，
   * 说明它是失效 ID，此时显示 Demo 数据是误导。所以下面用 isLive 区分，
   * live 查不到就直接渲染"证据不存在"。
   */
  const registered = evidenceId ? findRegisteredEvidence(evidenceId) : undefined
  const demoEv = evidenceId && !registered ? getEvidence(evidenceId) : undefined

  if (!evidenceId) return null

  const ev = registered ?? demoEv
  if (!ev) return null

  const isLiveEv = Boolean(registered) && !demoEv

  /**
   * 这条证据的抽取引擎是谁。
   *
   * 从注册的数据集里反查它所属论文的 analyzed_with。
   * 查不到就返回 null，界面上照实写「未记录」而不是替它编一个——
   * 把规则引擎的产出标成「AI 分析」是本项目最需要避免的误导。
   */
  const engine = isLiveEv ? getRegisteredEngine(ev.paper_id) : null

  const paper = isLiveEv
    ? null
    : getPaper(ev.paper_id)
  const methods = isLiveEv
    ? []
    : ev.method_ids.map((id) => getMethod(id)).filter(Boolean)
  const gapList = isLiveEv ? [] : ev.gap_ids.map((id) => getGap(id)).filter(Boolean)
  const directionList = isLiveEv
    ? []
    : ev.direction_ids.map((id) => getDirection(id)).filter(Boolean)

  const confidencePct = Math.round(ev.confidence * 100)

  return (
    /*
     * `data-evidence-drawer` 是给 UI 测试用的**作用域锚点**。
     *
     * 少了它，测试只能扫 `document.body.innerText` —— 而页面正文里
     * 恰好也有"长程任务"这类字眼（它来自 Gap 描述），于是
     * "抽屉里显示的是本项目原文"这条断言会在抽屉其实显示了
     * Demo 演示语料时**照样通过**。加一个锚点，断言就能只扫抽屉内部。
     */
    <div data-evidence-drawer="1" className="fixed inset-0 z-50 flex justify-end">
      {/* 遮罩 */}
      <button
        aria-label="关闭"
        onClick={close}
        className="absolute inset-0 bg-ink-900/25 backdrop-blur-[1px]"
      />

      {/* 抽屉 */}
      <div className="mp-anim-slide-right relative flex h-full w-full max-w-[520px] flex-col border-l border-ink-200 bg-white shadow-2xl">
        {/* 头部 */}
        <div className="flex items-start justify-between gap-3 border-b border-ink-200 px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-50 text-brand-600">
                <IconQuote className="h-3.5 w-3.5" />
              </span>
              <h3 className="font-mono text-[13px] font-semibold tracking-tight text-ink-900">
                Evidence #{ev.evidence_id}
              </h3>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Chip tone="brand">{ev.section}</Chip>
              <Chip tone="neutral">p.{ev.page}</Chip>
              <Chip tone={confidencePct >= 92 ? 'success' : confidencePct >= 85 ? 'info' : 'warn'}>
                置信度 {ev.confidence.toFixed(2)}
              </Chip>
            </div>
          </div>
          <button
            onClick={close}
            className="rounded-lg p-1.5 text-ink-400 transition hover:bg-ink-50 hover:text-ink-700"
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>

        {/* 内容 */}
        <div className="mp-scroll-thin flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* 来源论文 */}
          <section>
            <p className="mp-label mb-2">来源论文</p>
            {isLiveEv ? (
              /*
               * 真实项目的论文对象不在 Demo 知识库里，所以从数据集 raw 里取。
               * 这里直接用注册数据集反查，避免再发一次请求（抽屉打开要快）。
               */
              <LivePaperCard paperId={ev.paper_id} pid={pid} onNavigate={close} />
            ) : paper ? (
              <Link
                to={`/project/${pid}/papers/${paper.paper_id}`}
                onClick={close}
                className="mp-card mp-card-hover block p-3"
              >
                <p className="text-[13px] font-medium leading-snug text-ink-800">
                  {paper.title}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Chip tone="neutral">{paper.venue}</Chip>
                  <Chip tone="neutral">{paper.year}</Chip>
                  <span className="text-[11px] text-ink-400">
                    {paper.authors[0]}
                    {paper.authors.length > 1 ? ' 等' : ''}
                  </span>
                </div>
              </Link>
            ) : (
              <p className="text-xs text-ink-400">论文信息缺失</p>
            )}
          </section>

          {/* 原文证据 */}
          <section>
            <p className="mp-label mb-2">原文证据</p>
            <div className="rounded-xl border border-ink-200 bg-ink-50/70 p-3.5">
              <p className="font-serif text-[13.5px] italic leading-relaxed text-ink-700">
                “{ev.content}”
              </p>
            </div>
            <div className="mt-2 rounded-xl border border-brand-100 bg-brand-50/50 p-3.5">
              <p className="mp-label mb-1.5 text-brand-500">中文释义</p>
              <p className="text-[13px] leading-relaxed text-ink-700">
                {ev.translation || '（暂无译文，本阶段未接入翻译）'}
              </p>
            </div>

            {/*
             * 真实项目：给出 PDF 原文入口。
             * 这是本阶段最该被看见的一步——用户能直接对照 PDF 第 N 页核对原文，
             * 而不是只能相信系统说的"这句话来自 p.3"。
             */}
            {isLiveEv && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-ink-200 bg-white p-3">
                <a
                  href={api.pdfUrl(ev.paper_id, pid)}
                  target="_blank"
                  rel="noreferrer"
                  className="mp-btn mp-btn-primary"
                >
                  <IconLink className="h-3.5 w-3.5" /> 打开 PDF 第 {ev.page} 页
                </a>
                <p className="text-[11px] leading-relaxed text-ink-500">
                  服务端已逐字回验：该段文字确实出现在 <strong>第 {ev.page} 页</strong>、
                  <strong>{ev.section || '（未标注章节）'}</strong>。
                </p>
              </div>
            )}
          </section>

          {/* 溯源（真实项目专用：把 (paper_id, section, page) 三要素摊开） */}
          {isLiveEv && (
            <section>
              <p className="mp-label mb-2">证据溯源</p>
              <div className="rounded-xl border border-ink-200 bg-white p-3">
                <dl className="space-y-2">
                  {[
                    { k: '证据 ID', v: ev.evidence_id },
                    { k: '论文 ID', v: ev.paper_id },
                    { k: '章节', v: ev.section || '—' },
                    { k: '页码', v: `p.${ev.page}` },
                  ].map((x) => (
                    <div key={x.k} className="flex items-center justify-between gap-3">
                      <dt className="text-[11.5px] text-ink-400">{x.k}</dt>
                      <dd className="font-mono text-[11.5px] tabular-nums text-ink-700">{x.v}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-ink-100 pt-2.5">
                  <SourceBadge source="uploaded" />
                  <ModeBadge mode="LIVE" note="服务端逐字回验通过" />
                </div>
              </div>
            </section>
          )}

          {/* 置信度 */}
          <section>
            <div className="flex items-center justify-between">
              <p className="mp-label">抽取置信度</p>
              <span className="text-[11px] font-medium tabular-nums text-ink-600">
                {confidencePct}%
              </span>
            </div>
            <ProgressBar
              value={confidencePct}
              className="mt-2"
              color={
                confidencePct >= 92
                  ? 'var(--color-emerald-500)'
                  : confidencePct >= 85
                    ? 'var(--color-brand-500)'
                    : 'var(--color-amber-500)'
              }
            />
          </section>

          {/*
           * 标题不能一律写「AI 分析」。
           * 真实项目里 supports 字段可能是内置规则引擎产出的（provider=mock），
           * 把它标成 AI 分析就等于把规则挑的结果说成大模型读的——
           * 这正是本项目最要避免的误导。Demo 数据没有 provider 概念，
           * 保留原来的说法并不算错，因为整页都已经标了 MOCK。
           */}
          <section>
            <p className="mp-label mb-2">
              {isLiveEv
                ? engine
                  ? engine.real
                    ? `真实模型抽取 · ${engine.model} · 该证据支撑`
                    : '内置规则引擎抽取 · 该证据支撑'
                  : '抽取引擎未记录 · 该证据支撑'
                : 'AI 分析 · 该证据支撑'}
            </p>
            <div className="space-y-1.5">
              {ev.supports.map((s) => (
                <div
                  key={s}
                  className="flex items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50/60 px-2.5 py-1.5"
                >
                  <IconCheck className="h-3.5 w-3.5 text-emerald-600" />
                  <span className="text-[12.5px] font-medium text-emerald-800">{s}</span>
                </div>
              ))}
            </div>
          </section>

          {/* 关联方法 */}
          {methods.length > 0 && (
            <section>
              <p className="mp-label mb-2">关联方法</p>
              <div className="flex flex-wrap gap-1.5">
                {methods.map(
                  (m) =>
                    m && (
                      <Link
                        key={m.method_id}
                        to={`/project/${pid}/methods?focus=${m.method_id}`}
                        onClick={close}
                        className="mp-chip bg-sky-50 text-sky-700 transition hover:bg-sky-100"
                      >
                        {m.name}
                      </Link>
                    ),
                )}
              </div>
            </section>
          )}

          {/* 关联研究空白 */}
          {gapList.length > 0 && (
            <section>
              <p className="mp-label mb-2">关联研究空白</p>
              <div className="space-y-1.5">
                {gapList.map(
                  (g) =>
                    g && (
                      <Link
                        key={g.gap_id}
                        to={`/project/${pid}/gaps?focus=${g.gap_id}`}
                        onClick={close}
                        className="flex items-center justify-between gap-2 rounded-lg border border-ink-200 bg-white px-3 py-2 transition hover:border-brand-200 hover:bg-brand-50/40"
                      >
                        <span className="line-clamp-2 text-[12.5px] text-ink-700">{g.title}</span>
                        <IconArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-400" />
                      </Link>
                    ),
                )}
              </div>
            </section>
          )}

          {/* 关联研究方向 */}
          {directionList.length > 0 && (
            <section>
              <p className="mp-label mb-2">关联研究方向</p>
              <div className="space-y-1.5">
                {directionList.map(
                  (d) =>
                    d && (
                      <Link
                        key={d.direction_id}
                        to={`/project/${pid}/directions?focus=${d.direction_id}`}
                        onClick={close}
                        className="flex items-center justify-between gap-2 rounded-lg border border-ink-200 bg-white px-3 py-2 transition hover:border-brand-200 hover:bg-brand-50/40"
                      >
                        <span className="line-clamp-2 text-[12.5px] text-ink-700">{d.title}</span>
                        <IconArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-400" />
                      </Link>
                    ),
                )}
              </div>
            </section>
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center gap-2 border-t border-ink-200 px-5 py-3">
          {isLiveEv ? (
            <a
              href={api.pdfUrl(ev.paper_id, pid)}
              target="_blank"
              rel="noreferrer"
              className="mp-btn mp-btn-primary flex-1"
            >
              <IconLink className="h-3.5 w-3.5" /> 查看原论文 PDF
            </a>
          ) : paper ? (
            <a
              href={paper.source}
              target="_blank"
              rel="noreferrer"
              className="mp-btn mp-btn-primary flex-1"
            >
              <IconLink className="h-3.5 w-3.5" /> 查看原论文
            </a>
          ) : null}
          <Link
            to={`/project/${pid}/papers/${ev.paper_id}`}
            onClick={close}
            className="mp-btn mp-btn-ghost"
          >
            论文详情
          </Link>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 真实项目的论文卡片                                                  */
/* ------------------------------------------------------------------ */

/**
 * 真实上传项目里，来源论文不在 Demo 知识库中，
 * 所以从已注册数据集里反查——这些字段全部来自服务端解析结果。
 */
function LivePaperCard({
  paperId,
  pid,
  onNavigate,
}: {
  paperId: string
  pid: string
  onNavigate: () => void
}) {
  const paper = findRegisteredPaper(paperId)
  const [title, setTitle] = useState<string | null>(null)

  // 数据集里没有时（例如直接打开分享链接），补一次按需请求
  useEffect(() => {
    if (paper) return
    let alive = true
    api
      .getPaper(paperId, pid)
      .then((r) => {
        if (alive) setTitle(r.paper.title || r.paper.file_name)
      })
      .catch(() => {
        if (alive) setTitle(null)
      })
    return () => {
      alive = false
    }
  }, [paper, paperId, pid])

  const shown = paper?.title ?? title

  return (
    <Link
      to={`/project/${pid}/papers/${paperId}`}
      onClick={onNavigate}
      className="mp-card mp-card-hover block p-3"
    >
      <p className="text-[13px] font-medium leading-snug text-ink-800">
        {shown ?? (
          <span className="font-mono text-[12px] text-ink-400">论文 {paperId}</span>
        )}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <SourceBadge source="uploaded" />
        {paper && paper.year ? <Chip tone="neutral">{paper.year}</Chip> : null}
        {paper && paper.authors.length > 0 && (
          <span className="text-[11px] text-ink-400">
            {paper.authors[0]}
            {paper.authors.length > 1 ? ' 等' : ''}
          </span>
        )}
      </div>
    </Link>
  )
}

/* ------------------------------------------------------------------ */
/* Toast 容器                                                          */
/* ------------------------------------------------------------------ */

export function ToastHost() {
  const { toasts, dismiss } = useToast()

  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] flex w-full max-w-[380px] -translate-x-1/2 flex-col gap-2 px-4">
      {toasts.map((t) => {
        const tone = {
          success: 'border-emerald-200 bg-white',
          info: 'border-ink-200 bg-white',
          warn: 'border-amber-200 bg-white',
          error: 'border-rose-200 bg-white',
        }[t.tone]
        const bar = {
          success: 'bg-emerald-500',
          info: 'bg-brand-500',
          warn: 'bg-amber-500',
          error: 'bg-rose-500',
        }[t.tone]
        return (
          <button
            key={t.id}
            onClick={() => dismiss(t.id)}
            className={clsx(
              'mp-anim-fade-up pointer-events-auto flex w-full items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-left shadow-lg',
              tone,
            )}
          >
            <span className={clsx('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', bar)} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-ink-800">{t.title}</p>
              {t.description && (
                <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-500">
                  {t.description}
                </p>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
