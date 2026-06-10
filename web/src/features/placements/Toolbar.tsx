import { ChevronDown, Droplets, RotateCcw, Trash2 } from 'lucide-react'
import type { PageInfo, Placement } from '../../lib/types'
import { mmToPt, ptToMm } from '../../lib/units'
import { useEditorStore } from '../../state/store'
import { Button, IconButton } from '../../ui/Button'
import { NumberField } from '../../ui/Field'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../ui/Menu'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/Popover'
import { Slider } from '../../ui/Slider'
import { resizePlacement } from './actions'

const SIZE_PRESETS = [40, 42, 45]

/** 选中印章上方的浮动迷你工具条：覆盖 90% 的调整需求。 */
export function PlacementToolbar({
  placement,
  pageInfo,
  zoom
}: {
  placement: Placement
  pageInfo: PageInfo
  zoom: number
}) {
  const update = useEditorStore((state) => state.updatePlacement)
  const remove = useEditorStore((state) => state.removePlacement)

  const radians = (placement.rotation * Math.PI) / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))
  const extX = ((placement.widthPt * cos + placement.heightPt * sin) / 2) * zoom
  const extY = ((placement.widthPt * sin + placement.heightPt * cos) / 2) * zoom
  const centerX = (placement.xPt + placement.widthPt / 2) * zoom
  const centerYTop = (pageInfo.heightPt - placement.yPt - placement.heightPt / 2) * zoom
  const aboveTop = centerYTop - extY - 50
  const top = aboveTop >= 0 ? aboveTop : centerYTop + extY + 12

  return (
    <div
      className="anim-pop absolute z-20 flex items-center gap-1 rounded-xl border border-line bg-panel p-1 shadow-pop"
      style={{ left: centerX, top, transform: 'translateX(-50%)' }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <NumberField
        className="w-[78px]"
        value={ptToMm(placement.widthPt)}
        min={5}
        max={150}
        unit="mm"
        onChange={(mm) => resizePlacement(placement, pageInfo, mmToPt(mm))}
      />
      <Menu>
        <MenuTrigger asChild>
          <IconButton size="sm" title="常用尺寸">
            <ChevronDown size={15} />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="start" className="min-w-28">
          {SIZE_PRESETS.map((mm) => (
            <MenuItem key={mm} className="tnum" onSelect={() => resizePlacement(placement, pageInfo, mmToPt(mm))}>
              {mm} mm
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      <span className="mx-0.5 h-5 w-px bg-line" />
      <NumberField
        className="w-[70px]"
        value={placement.rotation}
        min={-180}
        max={180}
        unit="°"
        onChange={(rotation) => update(placement.id, { rotation })}
      />
      {placement.rotation !== 0 && (
        <IconButton size="sm" title="重置旋转" onClick={() => update(placement.id, { rotation: 0 })}>
          <RotateCcw size={15} />
        </IconButton>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant="ghost" className="tnum gap-1 px-1.5" title="不透明度">
            <Droplets size={15} />
            {Math.round(placement.opacity * 100)}%
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" className="w-44">
          <Slider
            value={Math.round(placement.opacity * 100)}
            min={10}
            max={100}
            onChange={(value) => update(placement.id, { opacity: value / 100 })}
          />
        </PopoverContent>
      </Popover>
      <span className="mx-0.5 h-5 w-px bg-line" />
      <IconButton
        size="sm"
        title="删除 (Del)"
        className="text-ink-muted hover:text-accent"
        onClick={() => remove(placement.id)}
      >
        <Trash2 size={15} />
      </IconButton>
    </div>
  )
}
