import { create } from 'zustand'

type Pending = {
  fileName: string
  retry: boolean
  resolve: (password: string | null) => void
}

type PromptState = {
  pending: Pending | null
  answer: (password: string | null) => void
}

export const usePasswordPrompt = create<PromptState>((set, get) => ({
  pending: null,
  answer(password) {
    const pending = get().pending
    set({ pending: null })
    pending?.resolve(password)
  }
}))

/** 加密 PDF 上传被拒后，按需向用户索要密码（取消返回 null）。 */
export function askPassword(fileName: string, retry: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    usePasswordPrompt.setState({ pending: { fileName, retry, resolve } })
  })
}
