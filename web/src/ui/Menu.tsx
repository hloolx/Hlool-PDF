import { DropdownMenu as RMenu } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cx } from '../lib/cx'

export const Menu = RMenu.Root
export const MenuTrigger = RMenu.Trigger

export function MenuContent({ className, align = 'end', children, ...props }: ComponentProps<typeof RMenu.Content>) {
  return (
    <RMenu.Portal>
      <RMenu.Content
        align={align}
        sideOffset={6}
        collisionPadding={8}
        className={cx('anim-pop z-50 min-w-44 rounded-xl border border-line bg-panel p-1 shadow-pop', className)}
        {...props}
      >
        {children}
      </RMenu.Content>
    </RMenu.Portal>
  )
}

export const menuItemClass =
  'flex h-8 cursor-default select-none items-center gap-2 rounded-lg px-2.5 text-[13px] outline-none ' +
  'data-[highlighted]:bg-sunken data-[disabled]:pointer-events-none data-[disabled]:opacity-40'

export function MenuItem({ className, ...props }: ComponentProps<typeof RMenu.Item>) {
  return <RMenu.Item className={cx(menuItemClass, className)} {...props} />
}

export function MenuSeparator() {
  return <RMenu.Separator className="my-1 h-px bg-line" />
}

export function MenuLabel({ className, ...props }: ComponentProps<typeof RMenu.Label>) {
  return <RMenu.Label className={cx('px-2.5 py-1.5 text-xs text-ink-muted', className)} {...props} />
}
