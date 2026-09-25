import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/* ------------------------------------------------------------------ */
/* Toast                                                              */
/* ------------------------------------------------------------------ */

export type ToastTone = 'success' | 'info' | 'warn' | 'error'

export interface ToastItem {
  id: number
  title: string
  description?: string
  tone: ToastTone
}

interface ToastContextValue {
  toasts: ToastItem[]
  push: (t: Omit<ToastItem, 'id'>) => void
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const seq = useRef(0)

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (t: Omit<ToastItem, 'id'>) => {
      seq.current += 1
      const id = seq.current
      setToasts((prev) => [...prev, { ...t, id }])
      setTimeout(() => dismiss(id), 3600)
    },
    [dismiss],
  )

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss])

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}

/* ------------------------------------------------------------------ */
/* Evidence 抽屉                                                      */
/* ------------------------------------------------------------------ */

interface EvidenceDrawerContextValue {
  evidenceId: string | null
  open: (id: string) => void
  close: () => void
}

const EvidenceDrawerContext = createContext<EvidenceDrawerContextValue | null>(null)

export function EvidenceDrawerProvider({ children }: { children: ReactNode }) {
  const [evidenceId, setEvidenceId] = useState<string | null>(null)

  const value = useMemo<EvidenceDrawerContextValue>(
    () => ({
      evidenceId,
      open: (id: string) => setEvidenceId(id),
      close: () => setEvidenceId(null),
    }),
    [evidenceId],
  )

  return (
    <EvidenceDrawerContext.Provider value={value}>
      {children}
    </EvidenceDrawerContext.Provider>
  )
}

export function useEvidenceDrawer() {
  const ctx = useContext(EvidenceDrawerContext)
  if (!ctx) throw new Error('useEvidenceDrawer must be used within EvidenceDrawerProvider')
  return ctx
}

/* ------------------------------------------------------------------ */
/* 全局交互（Agent 运行状态、选中方法等）                              */
/* ------------------------------------------------------------------ */

interface AppStateValue {
  /** 是否已跑过一次完整分析 */
  hasRunAnalysis: boolean
  setHasRunAnalysis: (v: boolean) => void
  /** 方法地图中被选中的方法 */
  selectedMethodId: string | null
  setSelectedMethodId: (id: string | null) => void
}

const AppStateContext = createContext<AppStateValue | null>(null)

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [hasRunAnalysis, setHasRunAnalysis] = useState(true)
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>('M001')

  const value = useMemo(
    () => ({ hasRunAnalysis, setHasRunAnalysis, selectedMethodId, setSelectedMethodId }),
    [hasRunAnalysis, selectedMethodId],
  )

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}

export function useAppState() {
  const ctx = useContext(AppStateContext)
  if (!ctx) throw new Error('useAppState must be used within AppStateProvider')
  return ctx
}
