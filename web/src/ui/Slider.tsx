import { Slider as RSlider } from 'radix-ui'
import { cx } from '../lib/cx'

export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  className,
  disabled
}: {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step?: number
  className?: string
  disabled?: boolean
}) {
  return (
    <RSlider.Root
      className={cx('relative flex h-5 w-full touch-none select-none items-center', className)}
      value={[value]}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={(values) => onChange(values[0])}
    >
      <RSlider.Track className="relative h-1 grow rounded-full bg-line">
        <RSlider.Range className="absolute h-full rounded-full bg-accent" />
      </RSlider.Track>
      <RSlider.Thumb className="block size-3.5 rounded-full border border-line bg-panel shadow-sm transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-accent/60" />
    </RSlider.Root>
  )
}
