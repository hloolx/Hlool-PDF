import { create } from 'zustand'
import type { PDFFile } from '../../lib/types'
import { activeFile, useEditorStore } from '../../state/store'
import { toast } from '../../state/toasts'

export const MAX_COMPOSE_PAGES = 2000

export type OrgItem = {
  /** 每个加入的页面实例都有独立 key（同一页可重复加入）。 */
  key: string
  fileId: string
  pageNumber: number
}

type OrganizeState = {
  open: boolean
  items: OrgItem[]
  name: string
  busy: boolean
  close: () => void
  setName: (name: string) => void
  setItems: (items: OrgItem[]) => void
  remove: (key: string) => void
  addFilePages: (file: PDFFile) => void
  setBusy: (busy: boolean) => void
}

export const useOrganize = create<OrganizeState>((set, get) => ({
  open: false,
  items: [],
  name: '',
  busy: false,
  close: () => set({ open: false, busy: false }),
  setName: (name) => set({ name }),
  setItems: (items) => set({ items }),
  remove: (key) => set((state) => ({ items: state.items.filter((item) => item.key !== key) })),
  addFilePages: (file) => {
    const current = get().items
    if (current.length + file.pageCount > MAX_COMPOSE_PAGES) {
      toast(`拼接最多 ${MAX_COMPOSE_PAGES} 页`, { kind: 'error' })
      return
    }
    const added = file.pages.map((page) => ({
      key: crypto.randomUUID(),
      fileId: file.fileId,
      pageNumber: page.pageNumber
    }))
    set({ items: [...current, ...added] })
  },
  setBusy: (busy) => set({ busy })
}))

/** 打开整理器：默认装入当前文件的全部页面。 */
export function openOrganizer() {
  const state = useEditorStore.getState()
  const file = activeFile(state)
  const items: OrgItem[] = file
    ? file.pages.map((page) => ({ key: crypto.randomUUID(), fileId: file.fileId, pageNumber: page.pageNumber }))
    : []
  const base = file ? file.name.replace(/\.pdf$/i, '') : '拼接文档'
  useOrganize.setState({ open: true, items, name: `${base}-整理`, busy: false })
}

/** 来源文件的徽标色（按文件在列表中的顺序取色）。 */
export const SOURCE_COLORS = ['#C8372D', '#1F6FB2', '#1B7F4D', '#B26A1F', '#7A4FB2', '#B21F6F']
