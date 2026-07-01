import { Suspense, lazy, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { useEditorStore } from '../state/store'
import { TipProvider } from '../ui/Tooltip'
import { ToastHost } from '../ui/ToastHost'
import { bootWorkspace } from '../features/workspace/boot'
import { AuthScreen } from '../features/auth/AuthScreen'
import { useAuth } from '../features/auth/useAuth'
import { AdminPage } from '../features/admin/AdminPage'

// 主工作区单独切包（pdfjs / 画布等重依赖随之离开入口包）。
const Workspace = lazy(() => import('./Workspace'))

function FullScreenLoader() {
  return (
    <div className="flex h-full items-center justify-center bg-canvas text-ink-muted">
      <Loader2 size={22} className="animate-spin" />
    </div>
  )
}

export function App() {
  const theme = useEditorStore((state) => state.theme)
  const status = useAuth((state) => state.status)
  const user = useAuth((state) => state.user)
  const promptLogin = useAuth((state) => state.promptLogin)
  const init = useAuth((state) => state.init)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    void init()
    // 认证检查进行时就预取工作区分包，登录完成时通常已就绪，避免出现额外的加载闪烁。
    void import('./Workspace')
  }, [init])

  // Boot the library once a session is confirmed (guest, fresh login or cookie).
  useEffect(() => {
    if (status === 'authed') void bootWorkspace()
  }, [status])

  if (status === 'loading') {
    return <FullScreenLoader />
  }

  // 'anon' = 游客模式被关闭，必须登录；promptLogin = 已登录用户主动打开登录/注册。
  if (status === 'anon' || promptLogin) {
    return (
      <TipProvider>
        <AuthScreen />
        <div className="fixed bottom-4 right-4 z-[60]">
          <ToastHost />
        </div>
      </TipProvider>
    )
  }

  if (window.location.pathname === '/admin') {
    if (user?.isAdmin) return <AdminPage />
    return (
      <TipProvider>
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas px-4 text-center">
          <p className="text-base font-semibold">需要管理员权限</p>
          <p className="max-w-[360px] text-sm text-ink-muted">当前账号不能访问后台。</p>
          <button
            type="button"
            className="h-8 rounded-lg border border-line bg-panel px-3 text-[13px] font-medium hover:bg-sunken"
            onClick={() => (window.location.href = '/')}
          >
            返回工作区
          </button>
        </div>
      </TipProvider>
    )
  }

  return (
    <Suspense fallback={<FullScreenLoader />}>
      <Workspace />
    </Suspense>
  )
}
