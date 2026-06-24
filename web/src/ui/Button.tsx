import { forwardRef, useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cx } from '../lib/cx'

type Variant = 'primary' | 'outline' | 'ghost' | 'danger'
type Size = 'md' | 'sm'

const variantClass: Record<Variant, string> = {
  primary: 'bg-accent text-white border border-transparent hover:bg-accent-hover',
  outline: 'bg-panel text-ink border border-line hover:bg-sunken',
  ghost: 'bg-transparent text-ink border border-transparent hover:bg-sunken',
  danger: 'bg-panel text-accent border border-line hover:bg-accent-soft'
}

const sizeClass: Record<Size, string> = {
  md: 'h-8 px-3 rounded-lg gap-1.5 text-[13px]',
  sm: 'h-7 px-2 rounded-md gap-1 text-xs'
}

/**
 * 图标按钮专用尺寸：固定正方形且不带水平 padding（不能复用 sizeClass 再叠 px-0 覆盖，
 * Tailwind v4 中 px-0 与 px-3 的层叠顺序由样式表决定，覆盖不可靠），
 * 并强制内部 svg 的尺寸与 shrink-0，避免被 flex 压缩。
 */
const iconSizeClass: Record<Size, string> = {
  md: 'size-8 rounded-lg [&_svg]:size-5 [&_svg]:shrink-0',
  sm: 'size-7 rounded-md [&_svg]:size-4 [&_svg]:shrink-0'
}

const baseClass =
  'inline-flex min-w-0 select-none items-center justify-center overflow-hidden whitespace-nowrap font-medium transition duration-150 ' +
  'active:scale-[0.97] ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60 ' +
  'disabled:pointer-events-none disabled:opacity-45'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  size?: Size
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'outline', size = 'md', className, type = 'button', ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(baseClass, variantClass[variant], sizeClass[size], className)}
      {...props}
    />
  )
})

export const IconButton = forwardRef<HTMLButtonElement, ButtonProps>(function IconButton(
  { variant = 'ghost', size = 'md', className, type = 'button', ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(baseClass, variantClass[variant], iconSizeClass[size], 'shrink-0', className)}
      {...props}
    />
  )
})

/**
 * 两段式确认按钮（替代 window.confirm）：
 * 第一次点击进入“待确认”态 —— 按钮原地变红并脉冲提示，2.6 秒内再点一次执行。
 * 图标专用（所有调用处都只放一个图标），尺寸与 IconButton 一致，不发生布局跳动。
 */
export function ConfirmButton({
  onConfirm,
  confirmLabel = '再点一次确认',
  children,
  className,
  size = 'sm',
  title
}: {
  onConfirm: () => void
  confirmLabel?: string
  children: ReactNode
  className?: string
  size?: Size
  title?: string
}) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 2600)
    return () => window.clearTimeout(timer)
  }, [armed])

  return (
    <button
      type="button"
      title={armed ? confirmLabel : title}
      aria-label={armed ? confirmLabel : title}
      className={cx(
        baseClass,
        variantClass.ghost,
        iconSizeClass[size],
        'shrink-0',
        className,
        armed ? 'anim-confirm' : 'text-ink-muted hover:text-accent'
      )}
      style={armed ? { background: 'var(--c-accent)', color: '#fff' } : undefined}
      onClick={(event) => {
        event.stopPropagation()
        if (armed) {
          setArmed(false)
          onConfirm()
        } else {
          setArmed(true)
        }
      }}
    >
      {children}
      <span role="status" aria-live="assertive" className="sr-only">
        {armed ? confirmLabel : ''}
      </span>
    </button>
  )
}
