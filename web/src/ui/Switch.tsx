import { Switch as RSwitch } from 'radix-ui'
import { cx } from '../lib/cx'

export function Switch({
  checked,
  onChange,
  disabled,
  className
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
}) {
  return (
    <RSwitch.Root
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      className={cx(
        'relative h-5 w-9 shrink-0 rounded-full bg-line transition-colors duration-150 data-[state=checked]:bg-accent',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60 disabled:opacity-40',
        className
      )}
    >
      <RSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform duration-150 data-[state=checked]:translate-x-[18px]" />
    </RSwitch.Root>
  )
}
