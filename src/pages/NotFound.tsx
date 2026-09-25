import { Link } from 'react-router-dom'
import { Card, IconArrowRight } from '@/components/ui'

export function NotFoundPage() {
  return (
    <div className="mp-anim-fade-up flex min-h-[60vh] items-center justify-center">
      <Card className="max-w-md p-8 text-center">
        <p className="font-mono text-[44px] font-semibold leading-none text-brand-500">404</p>
        <h1 className="mt-3 text-[17px] font-semibold text-ink-900">页面不存在</h1>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-500">
          你访问的路径不在 MethodPilot 的路由表中。可能是链接有误，或该资源已被移除。
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link to="/dashboard" className="mp-btn mp-btn-primary">
            回到工作台
          </Link>
          <Link to="/project/proj-aicoding-agent/papers" className="mp-btn mp-btn-ghost">
            进入文献库 <IconArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </Card>
    </div>
  )
}
