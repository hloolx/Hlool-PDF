import { cx } from '../../lib/cx'
import type { NineAnchor } from '../placements/actions'

const ANCHORS: NineAnchor[] = ['topLeft', 'top', 'topRight', 'left', 'center', 'right', 'bottomLeft', 'bottom', 'bottomRight']

const LABELS: Record<NineAnchor, string> = {
  topLeft: '左上',
  top: '上中',
  topRight: '右上',
  left: '左中',
  center: '居中',
  right: '右中',
  bottomLeft: '左下',
  bottom: '下中',
  bottomRight: '右下'
}

/** 九宫格定位器：批量盖章的位置选择。 */
export function NineGrid({ value, onChange }: { value: NineAnchor; onChange: (anchor: NineAnchor) => void }) {
  return (
    <div className="grid w-fit grid-cols-3 gap-1 rounded-xl border border-line bg-sunken p-1.5">
      {ANCHORS.map((anchor) => (
        <button
          key={anchor}
          type="button"
          title={LABELS[anchor]}
          className={cx(
            'flex size-9 items-center justify-center rounded-lg transition-all duration-150',
            value === anchor ? 'bg-panel shadow-sm' : 'hover:bg-panel/70'
          )}
          onClick={() => onChange(anchor)}
        >
          <span
            className={cx(
              'rounded-full transition-all duration-150',
              value === anchor ? 'size-2.5 bg-accent' : 'size-1.5 bg-ink-muted/40'
            )}
          />
        </button>
      ))}
    </div>
  )
}

export { LABELS as ANCHOR_LABELS }
