import { Link } from 'react-router-dom'
import { Chip, IconArrowRight, IconLayers, ModeBadge, SourceBadge } from '@/components/ui'
import { useEvidenceDrawer } from '@/context/AppContext'
import {
  findRegisteredPaper,
  findRegisteredEvidence,
} from '@/services/projectData'
import {
  getFamily,
  getMethod,
  getPapersOfMethod,
  getRelationsOfMethod,
  getSiblingMethods,
  relationLabel,
} from '@/services/selectors'
import type { Method } from '@/types'

/**
 * 方法卡片（右侧面板）
 *
 * 展示单个方法的完整画像：核心思想、模块、能力、局限、关联论文与证据。
 * 所有可跳转的地方都做成链接，让用户能沿着知识链继续探索。
 *
 * Phase 2：新增 live 开关。
 * live=true 时**不再**调用 getFamily/getPapersOfMethod/getRelationsOfMethod/
 * getSiblingMethods 这些 Demo 知识库查询函数——因为在真实项目里它们会返回
 * 演示论文与演示关系，把 Mock 数据伪装成"对这篇论文的分析"。
 * 真实方法只展示服务端确实给到的东西：原文证据 + 来源论文。
 */
export function MethodCard({
  method,
  projectId,
  onSelectMethod,
  live = false,
}: {
  method: Method
  projectId: string
  onSelectMethod?: (id: string) => void
  live?: boolean
}) {
  const { open: openEvidence } = useEvidenceDrawer()

  // Live 模式下全部走"当前数据集"，Demo 模式下才查知识库
  const family = live ? undefined : getFamily(method.family_id)
  const papers = live
    ? method.paper_ids
        .map((pid) => findRegisteredPaper(pid))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .map((p) => ({ paper_id: p.paper_id, title: p.title, year: p.year }))
    : getPapersOfMethod(method.method_id)
  const relations = live ? [] : getRelationsOfMethod(method.method_id)
  const siblings = live ? [] : getSiblingMethods(method.method_id)

  /** Live 模式下按 evidence_ids 直接反查真实证据（含页码/章节），用于展示溯源 */
  const liveEvidence = live
    ? method.evidence_ids
        .map((eid) => findRegisteredEvidence(eid))
        .filter((e): e is NonNullable<typeof e> => Boolean(e))
    : []

  return (
    <div className="mp-scroll-thin h-full space-y-4 overflow-y-auto p-4">
      {/* 头部 */}
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-[17px] font-semibold leading-tight tracking-tight text-ink-900">
              {method.name}
            </h3>
            <p className="mt-0.5 text-[12.5px] text-ink-500">{method.name_zh}</p>
          </div>
          <span className="shrink-0 rounded-lg bg-ink-100 px-2 py-1 font-mono text-[11px] font-semibold tabular-nums text-ink-600">
            {method.year}
          </span>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {family && (
            <span
              className="mp-chip text-white"
              style={{ background: family.color }}
            >
              {family.name_zh}
            </span>
          )}
          <Chip tone="brand">{method.paradigm}</Chip>
          {method.task ? <Chip tone="neutral">{method.task}</Chip> : null}
          {live && <ModeBadge mode="LIVE" />}
        </div>
      </div>

      {/* 核心思想 */}
      <div className="rounded-xl border border-brand-100 bg-brand-50/50 p-3.5">
        <p className="mp-label mb-1.5 text-brand-500">核心思想</p>
        <p className="text-[12.5px] leading-relaxed text-ink-700">{method.core_idea}</p>
      </div>

      {/* 关键模块 */}
      <div>
        <p className="mp-label mb-2">关键模块</p>
        <div className="flex flex-wrap gap-1.5">
          {method.modules.map((m) => (
            <span
              key={m}
              className="rounded-md border border-ink-200 bg-ink-50 px-2 py-1 font-mono text-[11px] text-ink-600"
            >
              {m}
            </span>
          ))}
        </div>
      </div>

      {/* 输入 / 输出 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-ink-200 bg-white p-3">
          <p className="mp-label mb-1.5">输入</p>
          <ul className="space-y-1">
            {method.inputs.map((x) => (
              <li key={x} className="text-[11.5px] leading-relaxed text-ink-600">
                · {x}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-ink-200 bg-white p-3">
          <p className="mp-label mb-1.5">输出</p>
          <ul className="space-y-1">
            {method.outputs.map((x) => (
              <li key={x} className="text-[11.5px] leading-relaxed text-ink-600">
                · {x}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* 能力 / 局限 */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="mp-label mb-2">主要能力</p>
          <ul className="space-y-1">
            {method.capabilities.map((c) => (
              <li key={c} className="flex items-start gap-1.5">
                <span className="mt-[5px] flex h-3 w-3 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[8px] font-bold text-emerald-600">
                  ✓
                </span>
                <span className="text-[12px] leading-relaxed text-ink-600">{c}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="mp-label mb-2">主要局限</p>
          <ul className="space-y-1">
            {method.limitations.map((c) => (
              <li key={c} className="flex items-start gap-1.5">
                <span className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                <span className="text-[12px] leading-relaxed text-ink-600">{c}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* 优势 */}
      <div>
        <p className="mp-label mb-2">方法优势</p>
        <ul className="space-y-1">
          {method.advantages.map((a) => (
            <li
              key={a}
              className="rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-[12px] leading-relaxed text-ink-600"
            >
              {a}
            </li>
          ))}
        </ul>
      </div>

      {/* 方法关系 */}
      {relations.length > 0 && (
        <div>
          <p className="mp-label mb-2">方法关系（{relations.length}）</p>
          <div className="space-y-1.5">
            {relations.map((r) => {
              const isSource = r.source_method === method.method_id
              const otherId = isSource ? r.target_method : r.source_method
              const other = getMethod(otherId)
              if (!other) return null
              return (
                <div
                  key={r.relation_id}
                  className="rounded-lg border border-ink-200 bg-white px-2.5 py-2"
                >
                  <div className="flex items-center gap-1.5">
                    <Chip tone={isSource ? 'brand' : 'info'}>
                      {isSource ? '→' : '←'} {relationLabel(r.relation_type)}
                    </Chip>
                    {onSelectMethod ? (
                      <button
                        onClick={() => onSelectMethod(otherId)}
                        className="min-w-0 flex-1 truncate text-left text-[12px] font-medium text-brand-700 hover:underline"
                      >
                        {other.name}
                      </button>
                    ) : (
                      <Link
                        to={`/project/${projectId}/methods?focus=${otherId}`}
                        className="min-w-0 flex-1 truncate text-[12px] font-medium text-brand-700 hover:underline"
                      >
                        {other.name}
                      </Link>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-500">{r.description}</p>
                  {r.evidence_ids.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {r.evidence_ids.map((eid) => (
                        <button
                          key={eid}
                          onClick={() => openEvidence(eid)}
                          className="rounded border border-brand-200 bg-brand-50/70 px-1.5 py-0.5 font-mono text-[10px] text-brand-700 transition hover:bg-brand-100"
                        >
                          #{eid}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1.5 text-[10.5px] italic text-amber-600">
                      无直接证据 · 已降级为「{relationLabel(r.relation_type)}」
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 相关论文 */}
      <div>
        <p className="mp-label mb-2">相关论文（{papers.length}）</p>
        <div className="space-y-1.5">
          {papers.map((p) => (
            <Link
              key={p.paper_id}
              to={`/project/${projectId}/papers/${p.paper_id}`}
              className="flex items-center gap-2 rounded-lg border border-ink-200 bg-white px-2.5 py-2 transition hover:border-brand-200 hover:bg-brand-50/40"
            >
              <span className="w-9 shrink-0 font-mono text-[11px] font-semibold tabular-nums text-ink-400">
                {p.year}
              </span>
              <span className="min-w-0 flex-1 line-clamp-2 text-[12px] leading-snug text-ink-700">
                {p.title}
              </span>
              <IconArrowRight className="h-3 w-3 shrink-0 text-ink-300" />
            </Link>
          ))}
        </div>
      </div>

      {/* 同族方法 */}
      {siblings.length > 0 && (
        <div>
          <p className="mp-label mb-2">同族方法</p>
          <div className="flex flex-wrap gap-1.5">
            {siblings.map((s) =>
              onSelectMethod ? (
                <button
                  key={s.method_id}
                  onClick={() => onSelectMethod(s.method_id)}
                  className="mp-chip bg-ink-100 text-ink-600 transition hover:bg-ink-200"
                >
                  {s.name}
                </button>
              ) : (
                <Link
                  key={s.method_id}
                  to={`/project/${projectId}/methods?focus=${s.method_id}`}
                  className="mp-chip bg-ink-100 text-ink-600 transition hover:bg-ink-200"
                >
                  {s.name}
                </Link>
              ),
            )}
          </div>
        </div>
      )}

      {/* Evidence */}
      <div className="rounded-xl border border-brand-200 bg-gradient-to-br from-brand-50 to-white p-3.5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[12.5px] font-semibold text-brand-800">支撑证据</p>
            <p className="mt-0.5 text-[11px] text-ink-500">
              {method.evidence_ids.length} 条原文证据锚定至此方法
            </p>
          </div>
          <span className="font-mono text-[20px] font-semibold tabular-nums text-brand-600">
            {method.evidence_ids.length}
          </span>
        </div>

        {/*
         * Live 模式：把「哪篇论文 / 哪一章节 / 哪一页 / 哪段原文」四要素直接摊在这里。
         * 这是本阶段的核心交付——用户点开一个方法，不需要再点两层才能看到出处。
         */}
        {live && liveEvidence.length > 0 && (
          <div className="mt-2.5 space-y-2">
            {liveEvidence.map((ev) => (
              <button
                key={ev.evidence_id}
                onClick={() => openEvidence(ev.evidence_id)}
                className="block w-full rounded-lg border border-ink-200 bg-white p-2.5 text-left transition hover:border-brand-300"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[10.5px] font-semibold text-brand-600">
                    #{ev.evidence_id}
                  </span>
                  <Chip tone="neutral">p.{ev.page}</Chip>
                  <Chip tone="neutral">{ev.section || '未标注章节'}</Chip>
                  <SourceBadge source="uploaded" />
                </div>
                <p className="mt-1.5 line-clamp-3 font-serif text-[11.5px] italic leading-relaxed text-ink-600">
                  “{ev.content}”
                </p>
              </button>
            ))}
          </div>
        )}

        <div className="mt-2.5 flex flex-wrap gap-1">
          {method.evidence_ids.map((eid) => (
            <button
              key={eid}
              onClick={() => openEvidence(eid)}
              className="rounded border border-brand-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-brand-700 transition hover:bg-brand-50"
            >
              #{eid}
            </button>
          ))}
        </div>
      </div>

      {/* 操作 */}
      <div className="flex items-center gap-2 border-t border-ink-200 pt-3">
        <Link
          to={`/project/${projectId}/papers/${method.paper_ids[0]}`}
          className="mp-btn mp-btn-primary flex-1"
        >
          查看论文
        </Link>
        <button
          className="mp-btn mp-btn-ghost"
          onClick={() => method.evidence_ids[0] && openEvidence(method.evidence_ids[0])}
        >
          查看 Evidence
        </button>
      </div>

      {/* 分类状态：Live 模式如实展示分类结果与依据，未分类时给出模型给的理由 */}
      <div className="space-y-1.5 pb-2">
        {live ? (
          <>
            <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-ink-400">
              <IconLayers className="mt-px h-3 w-3 shrink-0" />
              {method.classification ? (
                <>
                  方法族归属：
                  <strong className="text-ink-600">
                    {method.classification.family_id || '未分类'}
                  </strong>
                  {method.classification.family_id
                    ? ` · 由 ${method.classification.provider}/${method.classification.model} 结合已校验证据判定`
                    : ' · 分类已运行，但判定为无法可靠归类'}
                  {' '}（prompt {method.classification.prompt_version}）
                </>
              ) : (
                <>
                  方法族归属：尚未分类 · 该方法由服务端从 PDF 正文抽取，
                  支撑证据已逐字回验到具体页码
                </>
              )}
            </p>

            {method.classification && (
              <div className="rounded-lg border border-ink-200 bg-ink-50/60 px-3 py-2">
                <p className="text-[10.5px] font-medium text-ink-500">
                  {method.classification.family_id ? '归类理由' : '未归类原因'}
                </p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-700">
                  {method.classification.reason}
                </p>
                {method.classification.evidence_ids.length > 0 && (
                  <p className="mt-1.5 text-[10.5px] text-ink-500">
                    依据证据：
                    {method.classification.evidence_ids.map((eid) => (
                      <button
                        key={eid}
                        onClick={() => openEvidence(eid)}
                        className="ml-1 font-mono text-brand-600 hover:underline"
                      >
                        #{eid}
                      </button>
                    ))}
                  </p>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-ink-400">
            <IconLayers className="mt-px h-3 w-3 shrink-0" />
            方法族归属：{family?.name ?? '未分类'} · 该族共 {family?.method_ids.length ?? 0} 个方法
          </p>
        )}
      </div>
    </div>
  )
}
