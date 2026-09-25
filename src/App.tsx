import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import type { ReactNode } from 'react'
import { AIAssistant } from '@/components/AIAssistant'
import { AppLayout } from '@/components/AppLayout'
import { EvidenceDrawer, ToastHost } from '@/components/EvidenceDrawer'
import { AppStateProvider, EvidenceDrawerProvider, ToastProvider } from '@/context/AppContext'
import { ProjectStatsProvider } from '@/context/ProjectStatsContext'
import { DashboardPage } from '@/pages/DashboardPage'
import { NewProjectPage } from '@/pages/NewProjectPage'
import { NotFoundPage } from '@/pages/NotFound'
import { AnalysisPage } from '@/pages/project/AnalysisPage'
import { DirectionsPage } from '@/pages/project/DirectionsPage'
import { EvolutionPage } from '@/pages/project/EvolutionPage'
import { ExplorerPage } from '@/pages/project/ExplorerPage'
import { GapsPage } from '@/pages/project/GapsPage'
import { MethodsPage } from '@/pages/project/MethodsPage'
import { PaperDetailPage } from '@/pages/project/PaperDetailPage'
import { PapersPage } from '@/pages/project/PapersPage'
import { ReportPage } from '@/pages/project/ReportPage'
import { S2PaperPage } from '@/pages/project/S2PaperPage'
import { UploadPage } from '@/pages/project/UploadPage'

const DEFAULT_PROJECT = 'proj-aicoding-agent'

/**
 * 页面外壳。
 *
 * 在这里挂 `ProjectStatsProvider`：它需要当前项目 id 才能加载统计，
 * 而 `AppLayout`（侧边栏）本身挂在 `<Routes>` 之外、拿不到路由参数。
 * 放在 Shell 里，Provider 与 Sidebar 就都在同一次渲染内，
 * 侧栏统计与页面正文必然看到**同一份数据**。
 */
function Shell({ children }: { children: ReactNode }) {
  const { id } = useParams()
  return (
    <ProjectStatsProvider projectId={id ?? DEFAULT_PROJECT}>
      <AppLayout>{children}</AppLayout>
    </ProjectStatsProvider>
  )
}

export default function App() {
  return (
    <ToastProvider>
      <EvidenceDrawerProvider>
        <AppStateProvider>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route
              path="/dashboard"
              element={
                <Shell>
                  <DashboardPage />
                </Shell>
              }
            />
            <Route
              path="/project/new"
              element={
                <Shell>
                  <NewProjectPage />
                </Shell>
              }
            />
            <Route
              path="/project/:id"
              element={<Navigate to={`/project/${DEFAULT_PROJECT}/papers`} replace />}
            />
            {/*
             * 论文探索（Phase 3B-2）。放在 /papers 之前，
             * 因为它是"往项目里找论文"的入口，逻辑上先于"看项目里有什么"。
             * 路径是静态段 "explorer"，与 /papers/:paperId 不冲突。
             */}
            <Route
              path="/project/:id/explorer"
              element={
                <Shell>
                  <ExplorerPage />
                </Shell>
              }
            />
            {/*
             * S2 论文引用关系页（Phase 3B-5）。
             * 放在 explorer 之后：它是 explorer 的下钻页面，
             * 路径更长更具体，读起来顺序自然。
             * 这条路由只依赖 Semantic Scholar，与 /papers/:paperId 无关
             * （那个查的是项目内部数据，S2 论文不在其中）。
             */}
            <Route
              path="/project/:id/explorer/paper/:paperId"
              element={
                <Shell>
                  <S2PaperPage />
                </Shell>
              }
            />
            <Route
              path="/project/:id/papers"
              element={
                <Shell>
                  <PapersPage />
                </Shell>
              }
            />
            {/*
             * 上传入口（Phase 2）。放在 /papers 之后、/papers/:paperId 之前，
             * 路由本身是静态段 "upload"，不会和动态段 ":paperId" 冲突，
             * 但保持这个顺序读起来更安全。
             */}
            <Route
              path="/project/:id/upload"
              element={
                <Shell>
                  <UploadPage />
                </Shell>
              }
            />
            <Route
              path="/project/:id/papers/:paperId"
              element={
                <Shell>
                  <PaperDetailPage />
                </Shell>
              }
            />
            <Route
              path="/project/:id/analysis"
              element={
                <Shell>
                  <AnalysisPage />
                </Shell>
              }
            />
            <Route
              path="/project/:id/methods"
              element={
                <Shell>
                  <MethodsPage />
                </Shell>
              }
            />
            <Route
              path="/project/:id/evolution"
              element={
                <Shell>
                  <EvolutionPage />
                </Shell>
              }
            />
            <Route
              path="/project/:id/gaps"
              element={
                <Shell>
                  <GapsPage />
                </Shell>
              }
            />
            <Route
              path="/project/:id/directions"
              element={
                <Shell>
                  <DirectionsPage />
                </Shell>
              }
            />
            <Route
              path="/project/:id/report"
              element={
                <Shell>
                  <ReportPage />
                </Shell>
              }
            />
            <Route
              path="*"
              element={
                <Shell>
                  <NotFoundPage />
                </Shell>
              }
            />
          </Routes>

          {/* 全局浮层：证据抽屉 / 通知 / AI 助手 */}
          <EvidenceDrawer />
          <ToastHost />
          <AIAssistant />
        </AppStateProvider>
      </EvidenceDrawerProvider>
    </ToastProvider>
  )
}
