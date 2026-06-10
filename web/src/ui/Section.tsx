import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cx } from '../lib/cx'

export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('text-[11px] font-semibold uppercase tracking-wider text-ink-muted', className)}>{children}</div>
  )
}

/** 检查器折叠区块。 */
export function Section({
  title,
  children,
  defaultOpen = true,
  badge
}: {
  title: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  badge?: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-line/70 py-1">
      <button
        type="button"
        className="flex h-9 w-full items-center gap-1.5 text-left"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight size={15} className={cx('text-ink-muted transition-transform duration-150', open && 'rotate-90')} />
        <SectionTitle className="flex-1">{title}</SectionTitle>
        {badge}
      </button>
      {open && <div className="grid gap-2.5 pb-3 pl-0.5 pr-0.5">{children}</div>}
    </div>
  )
}
