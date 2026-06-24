import { create } from 'zustand'
import type { AuthUser } from '../../lib/types'
import { createGuest, fetchMe } from './api'

type AuthStatus = 'loading' | 'authed' | 'anon'

type AuthState = {
  status: AuthStatus
  user: AuthUser | null
  /** 已登录（含临时身份）时，仍想打开登录/注册界面（升级账号或换号登录）。 */
  promptLogin: boolean
  init: () => Promise<void>
  setAuthed: (user: AuthUser) => void
  setAnon: () => void
  setPromptLogin: (open: boolean) => void
}

export const useAuth = create<AuthState>((set) => ({
  status: 'loading',
  user: null,
  promptLogin: false,
  init: async () => {
    try {
      const user = await fetchMe()
      if (user) {
        set({ status: 'authed', user, promptLogin: false })
        return
      }
      // 没有会话：直接申领临时身份，零门槛进入工作区。
      const guest = await createGuest()
      set({ status: 'authed', user: guest, promptLogin: false })
    } catch {
      // 游客模式被关闭（403）或网络异常：回退到登录/注册界面。
      set({ status: 'anon', user: null })
    }
  },
  setAuthed: (user) => set({ status: 'authed', user, promptLogin: false }),
  setAnon: () => set({ status: 'anon', user: null, promptLogin: false }),
  setPromptLogin: (open) => set({ promptLogin: open })
}))

/** 会话失效（任何 API 返回 401）时调用：退回登录页。 */
export function requireReauth() {
  if (useAuth.getState().status === 'authed') {
    useAuth.getState().setAnon()
  }
}
