import { Dialog as RDialog } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { X } from 'lucide-react'
import { cx } from '../lib/cx'
import { IconButton } from './Button'

export const Dialog = RDialog.Root
export const DialogTrigger = RDialog.Trigger
export const DialogClose = RDialog.Close
export const DialogTitle = RDialog.Title

/** 近全屏工作面板（页面整理器等）。标题与操作区由调用方自行布局。 */
export function FullDialogContent({ className, children, ...props }: ComponentProps<typeof RDialog.Content>) {
  return (
    <RDialog.Portal>
      <RDialog.Overlay className="anim-fade fixed inset-0 z-40 bg-black/45" />
      <RDialog.Content
        className={cx(
          'anim-pop fixed inset-3 z-50 flex flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-pop outline-none',
          className
        )}
        {...props}
      >
        {children}
      </RDialog.Content>
    </RDialog.Portal>
  )
}

export function DialogContent({
  title,
  className,
  children,
  ...props
}: ComponentProps<typeof RDialog.Content> & { title: ReactNode }) {
  return (
    <RDialog.Portal>
      <RDialog.Overlay className="anim-fade fixed inset-0 z-40 bg-black/40" />
      <RDialog.Content
        className={cx(
          'anim-pop fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-panel p-5 shadow-pop outline-none',
          className
        )}
        {...props}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <RDialog.Title className="text-sm font-semibold">{title}</RDialog.Title>
          <RDialog.Close asChild>
            <IconButton size="sm" aria-label="关闭">
              <X size={16} />
            </IconButton>
          </RDialog.Close>
        </div>
        {children}
      </RDialog.Content>
    </RDialog.Portal>
  )
}

/** 右侧滑出抽屉（任务历史等次级内容）。 */
export function DrawerContent({
  title,
  className,
  children,
  actions,
  ...props
}: ComponentProps<typeof RDialog.Content> & { title: ReactNode; actions?: ReactNode }) {
  return (
    <RDialog.Portal>
      <RDialog.Overlay className="anim-fade fixed inset-0 z-40 bg-black/25" />
      <RDialog.Content
        className={cx(
          'anim-drawer fixed bottom-0 right-0 top-0 z-50 flex w-[380px] max-w-[92vw] flex-col border-l border-line bg-panel shadow-pop outline-none',
          className
        )}
        {...props}
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
          <RDialog.Title className="text-sm font-semibold">{title}</RDialog.Title>
          <div className="flex items-center gap-1">
            {actions}
            <RDialog.Close asChild>
              <IconButton size="sm" aria-label="关闭">
                <X size={16} />
              </IconButton>
            </RDialog.Close>
          </div>
        </div>
        <div className="scroll-slim min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </RDialog.Content>
    </RDialog.Portal>
  )
}
