import type { ReactNode } from 'react'
import { cx } from '../lib/cx'

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className
}: {
  value: T
  onChange: (value: T) => void
  options: Array<{ value: T; label: ReactNode; title?: string; disabled?: boolean }>
  className?: string
}) {
  return (
    <div
      className={cx('grid gap-0.5 rounded-lg border border-line/70 bg-sunken p-0.5', className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            title={option.title}
            aria-label={option.title}
            disabled={option.disabled}
            className={cx(
              'flex h-7 min-w-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-md px-1 text-xs transition-colors duration-150',
              '[&_svg]:shrink-0 disabled:pointer-events-none disabled:opacity-40',
              active ? 'bg-panel font-medium text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
