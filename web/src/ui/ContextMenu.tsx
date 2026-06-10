import { ContextMenu as RContext } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cx } from '../lib/cx'
import { menuItemClass } from './Menu'

export const ContextMenu = RContext.Root
export const ContextMenuTrigger = RContext.Trigger

export function ContextMenuContent({ className, children, ...props }: ComponentProps<typeof RContext.Content>) {
  return (
    <RContext.Portal>
      <RContext.Content
        collisionPadding={8}
        className={cx('anim-pop z-50 min-w-44 rounded-xl border border-line bg-panel p-1 shadow-pop', className)}
        {...props}
      >
        {children}
      </RContext.Content>
    </RContext.Portal>
  )
}

export function ContextMenuItem({ className, ...props }: ComponentProps<typeof RContext.Item>) {
  return <RContext.Item className={cx(menuItemClass, className)} {...props} />
}

export function ContextMenuSeparator() {
  return <RContext.Separator className="my-1 h-px bg-line" />
}
