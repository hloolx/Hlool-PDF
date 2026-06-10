import { create } from 'zustand'

export type Toast = {
  id: string
  text: string
  kind: 'info' | 'success' | 'error'
  action?: { label: string; onClick: () => void }
  /** 正在播放退出动画（180ms 后真正移除）。 */
  closing?: boolean
}

type ToastState = {
  toasts: Toast[]
  push: (text: string, opts?: { kind?: Toast['kind']; action?: Toast['action']; ttlMs?: number }) => void
  dismiss: (id: string) => void
}

const EXIT_MS = 180

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(text, opts) {
    const id = crypto.randomUUID()
    const toast: Toast = { id, text, kind: opts?.kind ?? 'info', action: opts?.action }
    set((state) => ({ toasts: [...state.toasts.slice(-3), toast] }))
    const ttl = opts?.ttlMs ?? (toast.kind === 'error' || toast.action ? 6500 : 3200)
    window.setTimeout(() => get().dismiss(id), ttl)
  },
  dismiss(id) {
    const target = get().toasts.find((t) => t.id === id)
    if (!target || target.closing) return
    set((state) => ({ toasts: state.toasts.map((t) => (t.id === id ? { ...t, closing: true } : t)) }))
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
    }, EXIT_MS)
  }
}))

export function toast(text: string, opts?: { kind?: Toast['kind']; action?: Toast['action']; ttlMs?: number }) {
  useToasts.getState().push(text, opts)
}
