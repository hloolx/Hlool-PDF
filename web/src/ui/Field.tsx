import { forwardRef, useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { cx } from '../lib/cx'
import { clamp } from '../lib/types'

export const inputClass =
  'h-8 w-full rounded-lg border border-line bg-panel px-2.5 text-[13px] text-ink transition-colors ' +
  'placeholder:text-ink-muted/60 hover:border-ink-muted/40 focus-visible:outline-2 focus-visible:outline-accent/50'

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(
  { className, ...props },
  ref
) {
  return <input ref={ref} className={cx(inputClass, className)} {...props} />
})

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs text-ink-muted">{label}</span>
      {children}
      {hint && <span className="text-xs leading-relaxed text-ink-muted/80">{hint}</span>}
    </label>
  )
}

function formatNumber(value: number) {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** 数字输入：允许临时清空，失焦/输入时按 [min,max] 提交，可带单位后缀。 */
export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  className,
  disabled
}: {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step?: number
  unit?: string
  className?: string
  disabled?: boolean
}) {
  const [text, setText] = useState(() => formatNumber(value))
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) setText(formatNumber(value))
  }, [value, focused])

  function commit(raw: string) {
    if (raw.trim() === '') return
    const next = Number(raw)
    if (Number.isFinite(next)) onChange(clamp(next, min, max))
  }

  return (
    <span className={cx('relative inline-flex items-center', className)}>
      <input
        type="number"
        inputMode="decimal"
        className={cx(inputClass, 'tnum', unit && 'pr-9')}
        value={text}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          setFocused(false)
          commit(event.currentTarget.value)
        }}
        onChange={(event) => {
          setText(event.currentTarget.value)
          commit(event.currentTarget.value)
        }}
      />
      {unit && (
        <span className="pointer-events-none absolute right-2.5 text-xs text-ink-muted">{unit}</span>
      )}
    </span>
  )
}
