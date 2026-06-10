import { useRef, useState } from 'react'
import { ImagePlus, Pencil, Trash2 } from 'lucide-react'
import { cx } from '../../lib/cx'
import type { StampAsset } from '../../lib/types'
import { stampLabel, useEditorStore } from '../../state/store'
import { ConfirmButton, IconButton } from '../../ui/Button'
import { Field, NumberField, TextInput } from '../../ui/Field'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/Popover'
import { SectionTitle } from '../../ui/Section'
import { useGhost } from '../placements/ghost'
import { placeAtClientPoint } from '../placements/actions'
import { deleteStampAction, uploadStamps } from '../workspace/actions'

/** 左下角印章架：拖到页面即盖章；单击进入连续盖章模式。 */
export function StampShelf() {
  const stamps = useEditorStore((state) => state.stamps)
  return (
    <div className="shrink-0 border-t border-line">
      <div className="flex items-center justify-between px-3 pt-2.5">
        <SectionTitle>印章架</SectionTitle>
        {stamps.length > 0 && <span className="text-[11px] text-ink-muted">拖到页面盖章</span>}
      </div>
      <div className="scroll-slim grid max-h-[280px] grid-cols-2 gap-2 overflow-y-auto p-3">
        {stamps.map((stamp) => (
          <ShelfItem key={stamp.stampId} stamp={stamp} />
        ))}
        <ImportTile compact={stamps.length > 0} />
      </div>
    </div>
  )
}

function ShelfItem({ stamp }: { stamp: StampAsset }) {
  const armed = useEditorStore((state) => state.armedStampId === stamp.stampId)
  const alias = useEditorStore((state) => stampLabel(state, stamp))
  const pressed = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  function onPointerDown(event: React.PointerEvent) {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    pressed.current = { x: event.clientX, y: event.clientY, moved: false }
  }

  function onPointerMove(event: React.PointerEvent) {
    const state = pressed.current
    if (!state) return
    if (!state.moved) {
      if (Math.hypot(event.clientX - state.x, event.clientY - state.y) < 5) return
      state.moved = true
      useGhost.getState().startDrag(stamp.stampId, event.clientX, event.clientY)
    } else {
      useGhost.getState().move(event.clientX, event.clientY)
    }
  }

  function onPointerUp(event: React.PointerEvent) {
    const state = pressed.current
    pressed.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (state?.moved) {
      useGhost.getState().endDrag()
      placeAtClientPoint(stamp.stampId, event.clientX, event.clientY)
      return
    }
    const editor = useEditorStore.getState()
    editor.arm(editor.armedStampId === stamp.stampId ? null : stamp.stampId)
  }

  return (
    <div className="group relative">
      <button
        type="button"
        className={cx(
          'checker relative flex aspect-square w-full touch-none select-none items-center justify-center overflow-hidden rounded-lg border transition-all duration-150',
          armed
            ? 'border-accent ring-2 ring-accent/30'
            : 'border-line hover:border-ink-muted/50 hover:shadow-sm'
        )}
        title={armed ? `${alias} · 连续盖章中，Esc 退出` : `${alias} · 拖到页面或单击连续盖章`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          pressed.current = null
          useGhost.getState().endDrag()
        }}
      >
        <img src={stamp.url} alt={alias} draggable={false} className="max-h-full max-w-full p-1.5" />
        {armed && (
          <span className="absolute inset-x-0 bottom-0 bg-accent py-0.5 text-center text-[10px] font-medium text-white">
            连续盖章中
          </span>
        )}
      </button>
      <div className="mt-1 truncate text-center text-[11px] text-ink-muted" title={alias}>
        {alias}
      </div>
      <div className="absolute right-1 top-1 hidden gap-0.5 group-hover:flex">
        <StampEditPopover stamp={stamp} />
        <ConfirmButton
          size="sm"
          className="bg-panel/95 shadow-sm"
          title="删除印章"
          confirmLabel="再点一次删除"
          onConfirm={() => void deleteStampAction(stamp)}
        >
          <Trash2 size={15} />
        </ConfirmButton>
      </div>
    </div>
  )
}

function StampEditPopover({ stamp }: { stamp: StampAsset }) {
  const meta = useEditorStore((state) => state.stampMeta[stamp.stampId])
  const defaults = useEditorStore((state) => state.stampDefaults)
  const setStampMeta = useEditorStore((state) => state.setStampMeta)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton size="sm" className="bg-panel/95 shadow-sm" title="别名与默认尺寸">
          <Pencil size={15} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-56 gap-3">
        <Field label="显示名称">
          <TextInput
            defaultValue={meta?.alias ?? ''}
            placeholder={stamp.name}
            onChange={(event) => setStampMeta(stamp.stampId, { alias: event.currentTarget.value || undefined })}
          />
        </Field>
        <Field label="默认尺寸" hint="新放置时使用；已放置的印章不受影响。">
          <NumberField
            value={meta?.sizeMm ?? defaults.sizeMm}
            min={5}
            max={150}
            unit="mm"
            onChange={(sizeMm) => setStampMeta(stamp.stampId, { sizeMm })}
          />
        </Field>
      </PopoverContent>
    </Popover>
  )
}

function ImportTile({ compact }: { compact: boolean }) {
  const [hover, setHover] = useState(false)
  return (
    <label
      className={cx(
        'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-ink-muted transition-colors',
        compact ? 'aspect-square' : 'col-span-2 py-6',
        hover ? 'border-accent text-accent' : 'border-line hover:border-ink-muted/60'
      )}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <ImagePlus size={20} />
      <span className="text-[11px]">导入印章</span>
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ''
          if (files.length > 0) void uploadStamps(files)
        }}
      />
    </label>
  )
}
