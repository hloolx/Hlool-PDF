import { Suspense, lazy, useEffect, useState } from 'react'
import { AlertCircle, Loader2, RotateCcw } from 'lucide-react'
import { useEditorStore } from '../state/store'
import { Button } from '../ui/Button'
import { bootWorkspace } from '../features/workspace/boot'

// PDF 画布等重依赖随工作区按需加载。
const Workspace = lazy(() => import('./Workspace'))

function FullScreenLoader() {
  return (
    <div role="status" className="flex h-full items-center justify-center gap-2 bg-canvas text-sm text-ink-muted">
      <Loader2 size={22} className="animate-spin" aria-hidden />
      正在打开本地工作台…
    </div>
  )
}

export function App() {
  const theme = useEditorStore((state) => state.theme)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    let active = true
    setStatus('loading')
    setError('')
    void import('./Workspace').catch(() => { /* 由 Suspense 加载工作区时呈现结果。 */ })
    void bootWorkspace().then(
      () => { if (active) setStatus('ready') },
      (err: unknown) => {
        if (!active) return
        setError(err instanceof Error ? err.message : '浏览器未能读取本地资料。')
        setStatus('error')
      }
    )
    return () => { active = false }
  }, [attempt])

  if (status === 'loading') return <FullScreenLoader />

  if (status === 'error') {
    return (
      <main className="flex h-full flex-col overflow-y-auto bg-canvas px-6 py-6 text-center">
        <div className="my-auto flex shrink-0 flex-col items-center gap-4">
        <AlertCircle size={28} className="text-accent" aria-hidden />
        <h1 className="text-base font-semibold">无法打开本地资料</h1>
        <div role="alert" className="max-w-md space-y-2 text-sm leading-relaxed text-ink-muted">
          <p>印章库尚未加载。请允许此站点使用浏览器存储，然后重试；也可以使用普通浏览窗口重新打开。</p>
          <p className="break-words">{error}</p>
          <p>请不要清理站点数据，以免丢失已保存的印章和设置。</p>
          <p>如果已有资料备份，可在另一浏览器打开工作台，通过「本地资料 → 导入备份」恢复。</p>
        </div>
        <Button onClick={() => setAttempt((value) => value + 1)}>
          <RotateCcw size={16} aria-hidden />
          重新加载本地资料
        </Button>
        </div>
      </main>
    )
  }

  return (
    <Suspense fallback={<FullScreenLoader />}>
      <Workspace />
    </Suspense>
  )
}
