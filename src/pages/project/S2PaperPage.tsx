import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/AppLayout'
import {
  Card,
  Chip,
  EmptyState,
  ErrorState,
  IconArrowRight,
  IconExternalLink,
  IconLink,
  SectionTitle,
  SkeletonState,
} from '@/components/ui'
import { api, type S2GraphPage, type S2Paper } from '@/services/api'
import { DEMO_PROJECT_ID } from '@/services/projectData'

/**
 * 论文引用关系页（Phase 3B-5）。
 *
 * 承载两个方向，语义必须分清：
 *   references（参考文献）—— 这篇论文引用了谁，指向它的**过去/基础**
 *   citations （被引用论文）—— 谁引用了这篇论文，指向它的**影响/后续**
 * 这两者结论相反，混起来看会读错一篇论文在领域里的位置，所以分两个区块。
 *
 * 为什么单独开一个页面、而不是复用 /papers/:paperId：
 *   那个页面是查**项目数据集内部**论文的（方法/证据/实验/空白），
 *   而 S2 搜到的论文默认不在项目里，用它的 id 去查必然落到 undefined。
 *   本页只依赖 S2，因此任何一篇 S2 论文都能打开——
 *   包括引用列表里的那些，于是引用链可以一层层点下去。
 */

/* ------------------------------------------------------------------ */
/* 单条引用记录                                                        */
/* ------------------------------------------------------------------ */

/**
 * 引用列表的一行。
 *
 * 需求点名要显示四项：标题、作者、年份、引用数。
 * 整行可点进该论文自己的引用关系页 —— 这是"可探索的引用链"的关键，
 * 少了它用户查一层就到头了。
 */
function CitationRow({ paper, projectId }: { paper: S2Paper; projectId: string }) {
  const isMock = paper.source === 'mock'
  /*
   * 没有 paper_id 就没法继续下钻（S2 偶有条目缺 id）。
   * 这种情况不渲染成链接，而不是渲染一个点了没反应的链接——
   * 一个能点但什么也不发生的入口比没有入口更让人困惑。
   */
  const canOpen = Boolean(paper.paper_id)

  const body = (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start gap-2">
          <span className="min-w-0 flex-1 text-[13.5px] font-medium leading-snug text-ink-900">
            {paper.title || '（标题缺失）'}
          </span>
          {/* mock 条目标出来：它可能挂在一篇真实标题的论文下面 */}
          {isMock && <Chip tone="warn">示例数据</Chip>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-500">
          <span className="text-ink-600">{authorsLine(paper.authors)}</span>
          <span className="font-mono tabular-nums text-ink-400">
            {paper.year > 0 ? paper.year : '年份未知'}
          </span>
          <span className="font-mono tabular-nums text-ink-400">
            被引 {paper.citationCount}
          </span>
          {paper.venue && <span className="truncate">{paper.venue}</span>}
        </div>
      </div>
      {canOpen && (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-brand-600">
          <IconLink className="h-3 w-3" />
          查看引用关系
          <IconArrowRight className="h-3 w-3" />
        </span>
      )}
    </div>
  )

  if (!canOpen) {
    return (
      <div className={isMock ? 'rounded-lg bg-amber-50/40 px-3 py-2.5' : 'px-3 py-2.5'}>
        {body}
      </div>
    )
  }

  return (
    <Link
      to={`/project/${encodeURIComponent(projectId)}/explorer/paper/${encodeURIComponent(paper.paper_id)}`}
      className={
        isMock
          ? 'block rounded-lg bg-amber-50/40 px-3 py-2.5 transition hover:bg-amber-100/60'
          : 'block rounded-lg px-3 py-2.5 transition hover:bg-ink-50'
      }
    >
      {body}
    </Link>
  )
}

/** 作者列展示：超过 3 人折叠。与 ExplorerPage 的口径保持一致 */
function authorsLine(authors: string[]): string {
  if (!authors.length) return '（作者未知）'
  if (authors.length <= 3) return authors.join('、')
  return `${authors.slice(0, 3).join('、')} 等 ${authors.length} 人`
}

/* ------------------------------------------------------------------ */
/* 一个方向（参考文献 / 被引用论文）                                     */
/* ------------------------------------------------------------------ */

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'done'; page: S2GraphPage }

/**
 * 两个方向的文案必须分开写。
 *
 * 参考文献空 vs 施引为空，说明的问题完全不同：
 *   前者多半是 S2 没收录这篇论文的引文数据（或该论文本身不在库中）
 *   后者多半是论文太新、还没人引用
 * 共用一个"暂无数据"会让用户以为是同一回事，从而得出错误判断。
 */
const COPY = {
  references: {
    title: '参考文献',
    countLabel: (n: number) => `这篇论文引用了 ${n} 篇`,
    emptyTitle: '没有参考文献记录',
    emptyDesc:
      'Semantic Scholar 没有返回这篇论文的引文数据。可能是它未收录这篇论文的参考文献，也可能是该论文本身不在库中。',
  },
  citations: {
    title: '被引用论文',
    countLabel: (n: number) => `引用这篇论文的有 ${n} 篇`,
    emptyTitle: '暂无被引用记录',
    emptyDesc:
      'Semantic Scholar 没有返回施引这篇论文的文献。常见原因是论文比较新、还没有被引用，或数据库尚未收录。',
  },
} as const

function GraphSection({
  kind,
  state,
  projectId,
  onRetry,
}: {
  kind: 'references' | 'citations'
  state: LoadState
  projectId: string
  onRetry: () => void
}) {
  const copy = COPY[kind]

  return (
    <section className="mt-6">
      <SectionTitle
        title={copy.title}
        subtitle={
          state.phase === 'done' && state.page.count > 0
            ? copy.countLabel(state.page.count)
            : undefined
        }
      />

      {/* loading —— 需求点名的第一种状态 */}
      {state.phase === 'loading' && (
        <Card className="mt-3 p-4">
          <SkeletonState rows={4} />
        </Card>
      )}

      {/*
        error —— 需求只点名了 loading/empty/mock 三种，但这个态不能省。
        把"请求失败"显示成"这篇论文没有被引用"是个**假结论**：
        用户会据此认为这篇论文无人问津，而真相只是网络没通。
        所以失败与空必须用完全不同的视觉与文案。
      */}
      {state.phase === 'error' && (
        <ErrorState
          title={`${copy.title}加载失败`}
          description={state.message}
          onRetry={onRetry}
        />
      )}

      {state.phase === 'done' && (
        <>
          {/*
            mock —— 需求点名的第三种状态。
            三层标注：本横幅 + 每行的「示例数据」徽标 + note 里的原始原因。
            这一层在引用页尤其重要：占位数据会显示在**一篇真实标题的论文下面**，
            只标一次很容易被当成真的引用关系读进去。
          */}
          {state.page.source === 'mock' && (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-2.5">
              <p className="text-[12px] font-medium text-amber-800">
                以下为示例数据，不代表真实引用关系
              </p>
              {state.page.note && (
                <p className="mt-0.5 text-[11.5px] leading-relaxed text-amber-700">
                  {state.page.note}
                </p>
              )}
            </div>
          )}

          {/* empty —— 需求点名的第二种状态 */}
          {state.page.papers.length === 0 ? (
            <div className="mt-3">
              <EmptyState
                title={copy.emptyTitle}
                description={
                  state.page.source === 'mock' && state.page.note
                    ? state.page.note
                    : copy.emptyDesc
                }
                icon={<IconLink className="h-5 w-5" />}
              />
            </div>
          ) : (
            <Card className="mt-3 divide-y divide-ink-100 p-1.5">
              {state.page.papers.map((p, i) => (
                <CitationRow
                  key={p.paper_id || `${kind}-${i}`}
                  paper={p}
                  projectId={projectId}
                />
              ))}
            </Card>
          )}
        </>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

export function S2PaperPage() {
  const { id, paperId } = useParams()
  const pid = id ?? DEMO_PROJECT_ID
  const navigate = useNavigate()

  /*
   * useParams 给到的已经是解码后的值（React Router 会解码）。
   * 但 S2 的 id 里可能带 `%` 或 `+` 这类字符，二次解码会出错，
   * 所以这里**只用它做展示与请求参数**，不再手动 decode。
   */
  const currentId = paperId ?? ''

  const [refs, setRefs] = useState<LoadState>({ phase: 'loading' })
  const [cites, setCites] = useState<LoadState>({ phase: 'loading' })

  const loadRefs = useCallback(async () => {
    setRefs({ phase: 'loading' })
    try {
      setRefs({ phase: 'done', page: await api.s2References(currentId) })
    } catch (e: unknown) {
      setRefs({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }, [currentId])

  const loadCites = useCallback(async () => {
    setCites({ phase: 'loading' })
    try {
      setCites({ phase: 'done', page: await api.s2Citations(currentId) })
    } catch (e: unknown) {
      setCites({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }, [currentId])

  /*
   * 两个方向**各自独立加载**，不合并成一个 Promise.all。
   *
   * 合并的话，任意一侧失败会把另一侧一起打成错误态——
   * 而 references 和 citations 在 S2 那边是两个独立接口，
   * 速率限制下经常一个通、一个 429。让它们各管各的，
   * 用户至少能看到拿到的那一半。
   */
  /*
   * 两个请求都在 effect 里发起，但**异步地**发。
   *
   * `void loadRefs()` 是同步调用，其中第一句就是 setState（切到 loading），
   * 于是它变成"在 effect 里同步 setState"，会触发级联渲染告警。
   * 包一层 Promise.resolve().then 让首次 setState 落到微任务里，
   * 语义完全不变（用户看到的还是先 loading 再出结果），
   * 但不再是同步调用 —— 这个写法与 PaperDetailPage 保持一致。
   */
  useEffect(() => {
    void Promise.resolve().then(() => {
      void loadRefs()
    })
  }, [loadRefs])

  useEffect(() => {
    void Promise.resolve().then(() => {
      void loadCites()
    })
  }, [loadCites])

  /*
   * 当前论文自身的元信息，从已加载的引用关系里**顺带取**。
   *
   * 不单独调 /api/s2/paper/:id 的原因：那个端点在沙箱下持续 429
   * （实测），单独调会让页面顶部永远空着。而引用关系接口能通，
   * 且它返回的条目本身携带完整元信息。
   * 拿不到就先不显示标题——只显示 id，比显示"加载中"更诚实。
   */
  const selfMeta = firstSelfMeta(refs, cites, currentId)

  return (
    <>
      <PageHeader
        title={selfMeta?.title || currentId || '论文引用关系'}
        subtitle={
          selfMeta
            ? authorsLine(selfMeta.authors)
            : 'Semantic Scholar 论文引用关系'
        }
        meta={
          <>
            <span className="mp-chip bg-ink-100 font-mono text-ink-700">{currentId}</span>
            {selfMeta && selfMeta.year > 0 && (
              <span className="mp-chip bg-ink-100 font-mono text-ink-700">
                {selfMeta.year}
              </span>
            )}
            {selfMeta && (
              <span className="mp-chip bg-ink-100 font-mono text-ink-700">
                被引 {selfMeta.citationCount}
              </span>
            )}
          </>
        }
        actions={
          <>
            <button
              className="mp-btn mp-btn-ghost"
              onClick={() => navigate(`/project/${pid}/explorer`)}
            >
              返回论文探索
            </button>
            {selfMeta?.url && (
              <a
                href={selfMeta.url}
                target="_blank"
                rel="noreferrer noopener"
                className="mp-btn mp-btn-soft"
              >
                <IconExternalLink className="h-3.5 w-3.5" />
                在 Semantic Scholar 打开
              </a>
            )}
          </>
        }
      />

      {/*
        方向说明。两个区块的差别（指向过去 vs 指向未来）不是自明的，
        写一句话比让用户自己猜要好。
      */}
      <Card className="border-ink-100 bg-ink-50/50 px-4 py-3">
        <p className="text-[12px] leading-relaxed text-ink-600">
          <strong className="font-medium text-ink-800">参考文献</strong>
          是这篇论文引用的工作（它的基础），
          <strong className="font-medium text-ink-800">被引用论文</strong>
          是引用了这篇论文的工作（它的影响）。
          点击任意一条可继续查看该论文的引用关系。
        </p>
      </Card>

      <GraphSection kind="references" state={refs} projectId={pid} onRetry={() => void loadRefs()} />
      <GraphSection kind="citations" state={cites} projectId={pid} onRetry={() => void loadCites()} />
    </>
  )
}

/**
 * 从两个方向的返回里挑出当前论文自己的元信息。
 *
 * 为什么不直接显示"当前论文"：这两个接口返回的是**引用者/被引用者**，
 * 不是当前论文本身。所以只能做一次保守匹配——
 * 找到 paperId 与本页 id 相等的条目才用它，否则返回 null。
 *
 * 宁可顶部只显示 id，也不猜一个标题填上去：填错了会让用户
 * 以为自己在看另一篇论文，而这一页的所有内容都会跟着被误读。
 */
function firstSelfMeta(
  refs: LoadState,
  cites: LoadState,
  currentId: string,
): S2Paper | null {
  for (const s of [refs, cites]) {
    if (s.phase !== 'done') continue
    const hit = s.page.papers.find((p) => p.paper_id === currentId)
    if (hit) return hit
  }
  return null
}
