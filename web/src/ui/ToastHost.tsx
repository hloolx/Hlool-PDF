import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { cx } from '../lib/cx'
import { useToasts } from '../state/toasts'

const icons = {
  info: <Info size={16} className="shrink-0 text-ink-muted" />,
  success: <CircleCheck size={16} className="shrink-0 text-ok" />,
  error: <CircleAlert size={16} className="shrink-0 text-accent" />
}

export function ToastHost() {
  const toasts = useToasts((state) => state.toasts)
  const dismiss = useToasts((state) => state.dismiss)
  if (toasts.length === 0) return null
  return (
    <div role="status" aria-live="polite" className="pointer-events-none flex w-80 flex-col items-stretch gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cx(
            'anim-rise pointer-events-auto flex items-center gap-2 rounded-xl border bg-panel px-3 py-2.5 text-[13px] shadow-pop',
            toast.kind === 'error' ? 'border-accent/40' : 'border-line',
            toast.closing && 'anim-toast-out'
          )}
        >
          {icons[toast.kind]}
          <span className="min-w-0 flex-1 break-words leading-snug">{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              className="shrink-0 font-medium text-accent hover:underline"
              onClick={() => {
                toast.action!.onClick()
                dismiss(toast.id)
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            className="shrink-0 text-ink-muted transition-colors hover:text-ink"
            onClick={() => dismiss(toast.id)}
            aria-label="关闭提示"
          >
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  )
}
