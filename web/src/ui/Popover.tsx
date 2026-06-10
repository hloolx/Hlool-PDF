import { Popover as RPopover } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cx } from '../lib/cx'

export const Popover = RPopover.Root
export const PopoverTrigger = RPopover.Trigger
export const PopoverAnchor = RPopover.Anchor

export function PopoverContent({ className, children, ...props }: ComponentProps<typeof RPopover.Content>) {
  return (
    <RPopover.Portal>
      <RPopover.Content
        sideOffset={6}
        collisionPadding={8}
        className={cx('anim-pop z-50 rounded-xl border border-line bg-panel p-3 shadow-pop outline-none', className)}
        {...props}
      >
        {children}
      </RPopover.Content>
    </RPopover.Portal>
  )
}
