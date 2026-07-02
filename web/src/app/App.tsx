import { Suspense, lazy, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { useEditorStore } from '../state/store'
import { toast } from '../state/toasts'
import { TipProvider } from '../ui/Tooltip'
import { ToastHost } from '../ui/ToastHost'
import { bootWorkspace } from '../features/workspace/boot'
import { AuthScreen } from '../features/auth/AuthScreen'
import { useAuth } from '../features/auth/useAuth'

// 主工作区单独切包（pdfjs / 画布等重依赖随之离开入口包）。
const Workspace = lazy(() => import('./Workspace'))
// 管理台只有管理员访问 /admin 才需要,同样不进入口包。
const AdminPage = lazy(() => import('../features/admin/AdminPage').then((m) => ({ default: m.AdminPage })))

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

  // OAuth 回调失败会带 ?authError= 跳回来。放在 App 层:无论落到登录页还是
  // 游客工作区都能提示一次;长 TTL 撑过认证检查与分包加载。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const authError = params.get('authError')
    if (!authError) return
    toast(authError, { kind: 'error', ttlMs: 10000 })
    params.delete('authError')
    const qs = params.toString()
    window.history.replaceState(null, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname)
  }, [])

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
    if (user?.isAdmin) {
      return (
        <Suspense fallback={<FullScreenLoader />}>
          <AdminPage />
        </Suspense>
      )
    }
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
