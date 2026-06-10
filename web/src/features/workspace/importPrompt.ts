import { create } from 'zustand'

export type ImportTarget = 'current' | 'new'

type Pending = {
  count: number
  currentName: string
  resolve: (target: ImportTarget | null) => void
}

type PromptState = {
  pending: Pending | null
  answer: (target: ImportTarget | null) => void
}

export const useImportPrompt = create<PromptState>((set, get) => ({
  pending: null,
  answer(target) {
    const pending = get().pending
    set({ pending: null })
    pending?.resolve(target)
  }
}))

/** 通过文件选择器导入且已有打开的项目时，询问导入去向（取消返回 null）。 */
export function askImportTarget(count: number, currentName: string): Promise<ImportTarget | null> {
  return new Promise((resolve) => {
    useImportPrompt.setState({ pending: { count, currentName, resolve } })
  })
}
