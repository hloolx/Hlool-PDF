import { create } from 'zustand'
import { Dialog, DialogContent } from '../../ui/Dialog'

type HelpState = { open: boolean; setOpen: (open: boolean) => void; toggle: () => void }

/** 快捷键帮助浮层的开关（供 TopBar 按钮与全局 “?” 快捷键共用）。 */
export const useShortcutHelp = create<HelpState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open }))
}))

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: '编辑',
    rows: [
      ['Ctrl + Z', '撤销'],
      ['Ctrl + Shift + Z / Ctrl + Y', '重做'],
      ['Ctrl + D', '复制选中印章'],
      ['Delete / Backspace', '删除选中印章 / 关闭骑缝章'],
      ['Esc', '取消选中 / 退出连续盖章']
    ]
  },
  {
    title: '调整选中印章',
    rows: [
      ['方向键', '微移 0.5mm（Shift 为 5mm）'],
      ['+ / −', '等比放大 / 缩小（Shift 步进更大）'],
      ['[ / ]', '逆 / 顺时针旋转 1°（Shift 吸附 15°）']
    ]
  },
  {
    title: '浏览',
    rows: [
      ['Ctrl + 滚轮', '以光标为锚缩放'],
      ['PageUp / PageDown', '上一页 / 下一页'],
      ['Home / End', '首页 / 末页'],
      ['Ctrl + Enter', '生成当前文件'],
      ['?', '打开 / 关闭本帮助']
    ]
  }
]

export function ShortcutHelp() {
  const open = useShortcutHelp((state) => state.open)
  const setOpen = useShortcutHelp((state) => state.setOpen)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title="键盘快捷键" className="w-[420px] max-w-[calc(100vw-1.5rem)]">
        <div className="grid gap-4">
          {GROUPS.map((group) => (
            <section key={group.title} className="grid gap-1.5">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">{group.title}</h2>
              {group.rows.map(([keys, desc]) => (
                <div key={keys} className="flex items-center justify-between gap-3 text-[13px]">
                  <span className="text-ink-muted">{desc}</span>
                  <kbd className="tnum shrink-0 rounded-md border border-line bg-sunken px-2 py-0.5 text-xs text-ink">
                    {keys}
                  </kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
