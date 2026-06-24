import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RotateCcw, TriangleAlert } from 'lucide-react'
import { Button } from '../ui/Button'

type Props = { children: ReactNode }
type State = { error: Error | null }

/**
 * 顶层错误边界：任意子树渲染抛错时兜底，避免整页白屏。
 * 给出可读说明 + 重新加载入口，并把详情留在控制台供排查。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[hlool-pdf] 未捕获的渲染错误：', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full items-center justify-center bg-canvas px-4">
        <div className="w-full max-w-[400px] rounded-2xl border border-line bg-panel p-6 text-center shadow-pop">
          <span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <TriangleAlert size={24} />
          </span>
          <h1 className="text-sm font-semibold">界面遇到了点问题</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
            刷新页面通常即可恢复。你导入的 PDF 与印章不会上传保存，刷新后重新拖入即可。
          </p>
          <p className="mt-3 break-words rounded-lg bg-sunken px-3 py-2 text-left text-[11px] text-ink-muted">
            {this.state.error.message || '未知错误'}
          </p>
          <Button
            variant="primary"
            className="mt-4 h-10 w-full justify-center"
            onClick={() => window.location.reload()}
          >
            <RotateCcw size={16} />
            重新加载
          </Button>
        </div>
      </div>
    )
  }
}
