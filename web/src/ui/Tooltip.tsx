import { Tooltip as RTooltip } from 'radix-ui'
import type { ReactElement, ReactNode } from 'react'

export function TipProvider({ children }: { children: ReactNode }) {
  return (
    <RTooltip.Provider delayDuration={350} skipDelayDuration={200}>
      {children}
    </RTooltip.Provider>
  )
}

export function Tip({
  label,
  side = 'bottom',
  children
}: {
  label?: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactElement
}) {
  if (!label) return children
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="anim-pop z-50 max-w-64 rounded-md bg-ink px-2 py-1 text-xs text-panel shadow-pop"
        >
          {label}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}
