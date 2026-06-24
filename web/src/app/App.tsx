import { Suspense, lazy, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { useEditorStore } from '../state/store'
import { TipProvider } from '../ui/Tooltip'
import { ToastHost } from '../ui/ToastHost'
import { bootWorkspace } from '../features/workspace/boot'
import { AuthScreen } from '../features/auth/AuthScreen'
import { useAuth } from '../features/auth/useAuth'

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

  return (
    <Suspense fallback={<FullScreenLoader />}>
      <Workspace />
    </Suspense>
  )
}
