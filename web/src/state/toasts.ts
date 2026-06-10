import { create } from 'zustand'

export type Toast = {
  id: string
  text: string
  kind: 'info' | 'success' | 'error'
  action?: { label: string; onClick: () => void }
}

type ToastState = {
  toasts: Toast[]
  push: (text: string, opts?: { kind?: Toast['kind']; action?: Toast['action']; ttlMs?: number }) => void
  dismiss: (id: string) => void
}

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push(text, opts) {
    const id = crypto.randomUUID()
    const toast: Toast = { id, text, kind: opts?.kind ?? 'info', action: opts?.action }
    set((state) => ({ toasts: [...state.toasts.slice(-3), toast] }))
    const ttl = opts?.ttlMs ?? (toast.kind === 'error' || toast.action ? 6500 : 3200)
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
    }, ttl)
  },
  dismiss(id) {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
  }
}))

export function toast(text: string, opts?: { kind?: Toast['kind']; action?: Toast['action']; ttlMs?: number }) {
  useToasts.getState().push(text, opts)
}
