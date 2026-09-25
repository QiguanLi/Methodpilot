import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/AppLayout'
import {
  Card,
  Chip,
  IconAlert,
  IconCheck,
  IconClose,
  IconRefresh,
  IconUpload,
  ModeBadge,
  ProgressBar,
  SectionTitle,
} from '@/components/ui'
import { useToast } from '@/context/AppContext'
import { ApiCallError, api, pollJob } from '@/services/api'
import type { ServerJob } from '@/services/api'

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

type FilePhase = 'queued' | 'uploading' | 'analyzing' | 'done' | 'failed'

interface FileTask {
  /** 本地唯一 id（同一个文件可能被重复选择） */
  key: string
  file: File
  phase: FilePhase
  /** 上传进度 0–100 */
  progress: number
  paper_id?: string
  job_id?: string
  /** 当前阶段文案，来自 job.stage */
  stage?: string
  error?: string
  /** 完成后的产出统计 */
  methods?: number
  evidences?: number
  rejected?: number
  pageOffset?: number
  notInPaper?: number
}

const MAX_FILES = 10
const MAX_BYTES = 40 * 1024 * 1024

const fmtSize = (n: number) =>
  n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

/* ------------------------------------------------------------------ */

/**
 * 上传论文页 —— 整个真实闭环的入口。
 *
 * 三条设计原则：
 *   1. **每个文件独立状态**。批量上传时一个 PDF 坏了，其余必须照常跑完
 *      （第 29 节）。所以状态存在 per-file 的数组里，不是一个全局 loading。
 *   2. **过程可见**。分析要跑一两分钟，期间必须让用户看到"现在在第几步"。
 *      这里的 stage 文案直接来自服务端的 Analysis Log，不是前端编的假进度。
 *   3. **失败要具体**。错误信息直接展示服务端返回的 message，
 *      而不是统一变成"上传失败，请重试"。
 */
export function UploadPage() {
  const { id } = useParams<{ id: string }>()
  const projectId = id ?? ''
  const navigate = useNavigate()
  const { push } = useToast()

  const [tasks, setTasks] = useState<FileTask[]>([])
  const [dragging, setDragging] = useState(false)
  const [aiInfo, setAiInfo] = useState<{
    provider: string
    model: string
    ready: boolean
    reason: string
  } | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  /* ---------------- 探测服务端与 AI 状态 ---------------- */
  useEffect(() => {
    let alive = true
    api
      .health(true)
      .then((h) => {
        if (!alive) return
        setServerError(null)
        setAiInfo({
          provider: h.ai.provider,
          model: h.ai.model,
          ready: h.ai.ready,
          reason: h.ai.reason,
        })
      })
      .catch((e: unknown) => {
        if (!alive) return
        setServerError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [])

  /* ---------------- 文件加入队列 ---------------- */

  const update = useCallback((key: string, patch: Partial<FileTask>) => {
    setTasks((prev) => prev.map((t) => (t.key === key ? { ...t, ...patch } : t)))
  }, [])

  const addFiles = useCallback(
    (incoming: File[]) => {
      const accepted: FileTask[] = []
      const problems: string[] = []

      for (const f of incoming) {
        // 前端先做一轮明显错误的拦截，让用户立刻得到反馈，
        // 不必等上传完再由服务端告诉他"这不是 PDF"
        const looksPdf = /\.pdf$/i.test(f.name)
        if (!looksPdf) {
          problems.push(`「${f.name}」不是 .pdf 文件，已跳过`)
          continue
        }
        if (f.size === 0) {
          problems.push(`「${f.name}」是空文件，已跳过`)
          continue
        }
        if (f.size > MAX_BYTES) {
          problems.push(`「${f.name}」${fmtSize(f.size)} 超出 ${MAX_BYTES / 1048576}MB 上限，已跳过`)
          continue
        }
        accepted.push({
          key: `${f.name}-${f.size}-${f.lastModified}-${Math.random().toString(36).slice(2, 7)}`,
          file: f,
          phase: 'queued',
          progress: 0,
        })
      }

      setTasks((prev) => {
        const room = MAX_FILES - prev.length
        if (accepted.length > room) {
          problems.push(`单次最多 ${MAX_FILES} 个文件，超出部分已忽略`)
        }
        return [...prev, ...accepted.slice(0, Math.max(0, room))]
      })

      for (const p of problems) push({ title: '文件已跳过', description: p, tone: 'warn' })
    },
    [push],
  )

  /* ---------------- 开始分析 ---------------- */

  const startAnalysis = useCallback(async () => {
    const pending = tasks.filter((t) => t.phase === 'queued')
    if (!pending.length) return

    abortRef.current = new AbortController()

    for (const t of pending) {
      update(t.key, { phase: 'uploading', progress: 0 })
      try {
        const res = await api.upload(projectId, [t.file], {
          force: true,
          signal: abortRef.current.signal,
          onProgress: (loaded, total) =>
            update(t.key, { progress: Math.round((loaded / total) * 100) }),
        })

        const rej = res.rejected?.[0]
        if (rej) {
          update(t.key, { phase: 'failed', error: rej.message })
          continue
        }
        const item = res.accepted?.[0]
        if (!item) {
          update(t.key, { phase: 'failed', error: '服务端未返回论文信息' })
          continue
        }

        update(t.key, { phase: 'analyzing', progress: 100, paper_id: item.paper_id, job_id: item.job_id })

        // 轮询这个文件自己的任务，不阻塞其他文件
        const job: ServerJob = await pollJob(item.job_id, {
          signal: abortRef.current.signal,
          onTick: (j) => update(t.key, { stage: j.stage }),
        })

        if (job.state === 'completed') {
          update(t.key, {
            phase: 'done',
            methods: job.methods,
            evidences: job.evidences,
            rejected: job.validation?.evidenceRejected ?? 0,
            pageOffset: job.validation?.pageOffset ?? 0,
            notInPaper: job.validation?.notInPaper ?? 0,
          })
        } else {
          update(t.key, { phase: 'failed', error: job.error ?? '分析失败' })
        }
      } catch (e) {
        const msg =
          e instanceof ApiCallError ? e.message : e instanceof Error ? e.message : String(e)
        update(t.key, { phase: 'failed', error: msg })
      }
    }

    push({
      title: '本轮分析结束',
      description: '可查看下方每个文件的处理结果',
      tone: 'info',
    })
  }, [projectId, tasks, update, push])

  const retry = async (key: string) => {
    update(key, { phase: 'queued', progress: 0, error: undefined, stage: undefined })
    await startAnalysis()
  }

  /* ---------------- 统计 ---------------- */

  const queuedCount = tasks.filter((t) => t.phase === 'queued').length
  const running = tasks.some((t) => t.phase === 'uploading' || t.phase === 'analyzing')
  const doneCount = tasks.filter((t) => t.phase === 'done').length
  const failedCount = tasks.filter((t) => t.phase === 'failed').length

  /* ---------------- 渲染 ---------------- */

  return (
    <>
      <PageHeader
        title="上传论文"
        subtitle="上传真实 PDF，系统将解析章节、抽取方法并逐条校验原文证据"
      />

      <div className="space-y-4">
        {/* AI 状态横幅：这一条决定了后面的流程能不能算 LIVE */}
        {serverError ? (
          <Card className="border-rose-200 bg-rose-50/60 p-4">
            <div className="flex items-start gap-2.5">
              <IconAlert className="mt-0.5 h-4 w-4 text-rose-600" />
              <div className="text-sm">
                <p className="font-semibold text-rose-800">无法连接分析服务</p>
                <p className="mt-1 text-rose-700">{serverError}</p>
                <p className="mt-1.5 text-xs text-rose-600">
                  请先在项目根目录运行 <code className="rounded bg-white/70 px-1">pnpm server</code>，
                  或使用 <code className="rounded bg-white/70 px-1">pnpm dev:all</code> 同时启动前后端。
                </p>
              </div>
            </div>
          </Card>
        ) : aiInfo ? (
          <Card
            className={
              aiInfo.ready
                ? 'border-emerald-200 bg-emerald-50/50 p-4'
                : 'border-amber-200 bg-amber-50/60 p-4'
            }
          >
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <ModeBadge mode={aiInfo.ready ? 'LIVE' : 'MOCK'} />
              <span className="font-semibold text-ink-800">
                {aiInfo.ready ? '真实分析链路已就绪' : '真实分析链路未就绪'}
              </span>
              <Chip tone="neutral">{aiInfo.provider}</Chip>
              <Chip tone="neutral">{aiInfo.model}</Chip>
            </div>
            <p className="mt-1.5 text-xs text-ink-600">
              {aiInfo.ready
                ? '上传的 PDF 将由服务端实时解析，并由模型抽取方法 + 原文证据；每条证据都会在服务端逐字校验，无法在指定页码找到原文的证据将被拒绝并记录。'
                : `${aiInfo.reason}。仍可上传并完成 PDF 解析，但方法抽取阶段会明确报错而不会伪造结果。`}
            </p>
          </Card>
        ) : null}

        {/* 拖拽区 */}
        <Card className="p-5">
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              addFiles(Array.from(e.dataTransfer.files))
            }}
            onClick={() => inputRef.current?.click()}
            className={[
              'flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors',
              dragging
                ? 'border-brand-400 bg-brand-50/60'
                : 'border-ink-200 bg-ink-50/40 hover:border-brand-300 hover:bg-brand-50/30',
            ].join(' ')}
          >
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-brand-100 text-brand-600">
              <IconUpload className="h-5 w-5" />
            </div>
            <p className="text-sm font-semibold text-ink-800">
              把 PDF 拖到这里，或点击选择文件
            </p>
            <p className="mt-1 text-xs text-ink-500">
              支持批量选择（最多 {MAX_FILES} 个），单文件不超过 {MAX_BYTES / 1048576}MB
            </p>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []))
                e.target.value = ''
              }}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-ink-500">
              {tasks.length > 0 && (
                <>
                  <span>共 {tasks.length} 个文件</span>
                  {doneCount > 0 && <Chip tone="success">完成 {doneCount}</Chip>}
                  {failedCount > 0 && <Chip tone="danger">失败 {failedCount}</Chip>}
                  {queuedCount > 0 && <Chip tone="neutral">待分析 {queuedCount}</Chip>}
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              {tasks.length > 0 && !running && (
                <button
                  type="button"
                  onClick={() => setTasks([])}
                  className="rounded-lg px-3 py-2 text-sm text-ink-500 hover:bg-ink-100"
                >
                  清空列表
                </button>
              )}
              <button
                type="button"
                disabled={!queuedCount || running || Boolean(serverError)}
                onClick={() => void startAnalysis()}
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-ink-200 disabled:text-ink-400"
              >
                {running ? '分析中…' : `开始分析${queuedCount ? `（${queuedCount}）` : ''}`}
              </button>
            </div>
          </div>
        </Card>

        {/* 文件列表 */}
        {tasks.length > 0 && (
          <Card className="p-5">
            <SectionTitle
              title="处理进度"
              subtitle="每个文件独立处理：单个失败不影响其他文件"
            />
            <ul className="space-y-2.5">
              {tasks.map((t) => (
                <FileRow
                  key={t.key}
                  task={t}
                  onRetry={() => void retry(t.key)}
                  onRemove={() => setTasks((prev) => prev.filter((x) => x.key !== t.key))}
                  onOpen={
                    t.paper_id
                      ? () => navigate(`/project/${projectId}/papers/${t.paper_id}`)
                      : undefined
                  }
                />
              ))}
            </ul>
          </Card>
        )}

        {/* 完成后的下一步 */}
        {doneCount > 0 && !running && (
          <Card className="border-brand-200 bg-brand-50/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm">
                <p className="font-semibold text-ink-800">
                  {doneCount} 篇论文已完成方法抽取与证据校验
                </p>
                <p className="mt-0.5 text-xs text-ink-600">
                  下一步：进入方法地图查看抽取出的方法，点击任一方法可看到它来自哪篇论文、哪一页、哪段原文。
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => navigate(`/project/${projectId}/papers`)}
                  className="rounded-lg border border-ink-200 bg-white px-3.5 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
                >
                  查看论文列表
                </button>
                <button
                  type="button"
                  onClick={() => navigate(`/project/${projectId}/methods`)}
                  className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-700"
                >
                  进入方法地图
                </button>
              </div>
            </div>
          </Card>
        )}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */

function FileRow({
  task,
  onRetry,
  onRemove,
  onOpen,
}: {
  task: FileTask
  onRetry: () => void
  onRemove: () => void
  onOpen?: () => void
}) {
  const phaseText: Record<FilePhase, string> = {
    queued: '待分析',
    uploading: `上传中 ${task.progress}%`,
    analyzing: task.stage ?? '分析中',
    done: '已完成',
    failed: '失败',
  }

  const tone =
    task.phase === 'done'
      ? 'text-emerald-600'
      : task.phase === 'failed'
        ? 'text-rose-600'
        : 'text-ink-500'

  return (
    <li className="rounded-lg border border-ink-100 bg-white p-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5">
          {task.phase === 'done' ? (
            <IconCheck className="h-4 w-4 text-emerald-600" />
          ) : task.phase === 'failed' ? (
            <IconAlert className="h-4 w-4 text-rose-600" />
          ) : (
            <span className="block h-4 w-4 rounded-full border-2 border-ink-200 border-t-brand-500 motion-safe:animate-spin" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="truncate text-sm font-medium text-ink-800">{task.file.name}</span>
            <span className="text-[11px] text-ink-400">{fmtSize(task.file.size)}</span>
          </div>

          <p className={`mt-0.5 text-xs ${tone}`}>{phaseText[task.phase]}</p>

          {(task.phase === 'uploading' || task.phase === 'analyzing') && (
            <ProgressBar
              value={task.phase === 'analyzing' ? 100 : task.progress}
              className="mt-2"
            />
          )}

          {task.phase === 'done' && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Chip tone="success">方法 {task.methods ?? 0}</Chip>
              <Chip tone="info">证据 {task.evidences ?? 0}</Chip>
              {/* 被拒证据必须展示：这是"系统没有偷偷放行"的证据 */}
              {task.rejected ? (
                <Chip tone="warn">
                  拒绝证据 {task.rejected}
                  {task.pageOffset
                    ? `（其中 ${task.pageOffset} 条仅页码有偏差）`
                    : ''}
                  {task.notInPaper ? `，${task.notInPaper} 条全文均无` : ''}
                </Chip>
              ) : null}
            </div>
          )}

          {task.phase === 'failed' && task.error && (
            <p className="mt-1.5 rounded-md bg-rose-50 px-2 py-1.5 text-xs leading-relaxed text-rose-700">
              {task.error}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {task.phase === 'done' && onOpen && (
            <button
              type="button"
              onClick={onOpen}
              className="rounded-md px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50"
            >
              查看
            </button>
          )}
          {task.phase === 'failed' && (
            <button
              type="button"
              onClick={onRetry}
              title="重试"
              className="rounded-md p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
            >
              <IconRefresh className="h-3.5 w-3.5" />
            </button>
          )}
          {task.phase !== 'uploading' && task.phase !== 'analyzing' && (
            <button
              type="button"
              onClick={onRemove}
              title="移除"
              className="rounded-md p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
            >
              <IconClose className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </li>
  )
}
