import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ImagePlus, Pencil, Trash2, X } from 'lucide-react'
import { cx } from '../../lib/cx'
import type { StampAsset } from '../../lib/types'
import { stampLabel, useEditorStore } from '../../state/store'
import { Button, ConfirmButton, IconButton } from '../../ui/Button'
import { Field, NumberField, TextInput } from '../../ui/Field'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/Popover'
import { SectionTitle } from '../../ui/Section'
import { useGhost } from '../placements/ghost'
import { placeAtClientPoint } from '../placements/actions'
import { deleteStampAction, deleteStampsAction, uploadStamps } from '../workspace/actions'

const SELECT_THRESHOLD = 5

type SelectBox = { left: number; top: number; width: number; height: number }
type SelectPress = { startX: number; startY: number; active: boolean }

function boxFromPoints(startX: number, startY: number, x: number, y: number): SelectBox {
  const left = Math.min(startX, x)
  const top = Math.min(startY, y)
  return { left, top, width: Math.abs(x - startX), height: Math.abs(y - startY) }
}

function intersects(box: SelectBox, rect: DOMRect) {
  return box.left <= rect.right && box.left + box.width >= rect.left && box.top <= rect.bottom && box.top + box.height >= rect.top
}

/** 左下角印章架：拖到页面即盖章；单击进入连续盖章模式。 */
export function StampShelf() {
  const stamps = useEditorStore((state) => state.stamps)
  const selectedIds = useEditorStore((state) => state.selectedStampIds)
  const selectedSet = new Set(selectedIds)
  const setSelectedStampIds = useEditorStore((state) => state.setSelectedStampIds)
  const clearBulkSelection = useEditorStore((state) => state.clearBulkSelection)
  const itemRefs = useRef(new Map<string, HTMLDivElement>())
  const press = useRef<SelectPress | null>(null)
  const [selectBox, setSelectBox] = useState<SelectBox | null>(null)

  function selectedStamps() {
    const ids = new Set(useEditorStore.getState().selectedStampIds)
    return useEditorStore.getState().stamps.filter((stamp) => ids.has(stamp.stampId))
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('[data-shelf-item]')) return
    event.currentTarget.setPointerCapture(event.pointerId)
    press.current = { startX: event.clientX, startY: event.clientY, active: false }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const state = press.current
    if (!state) return
    if (!state.active) {
      if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < SELECT_THRESHOLD) return
      state.active = true
    }
    const box = boxFromPoints(state.startX, state.startY, event.clientX, event.clientY)
    setSelectBox(box)
    const next: string[] = []
    for (const [stampId, el] of itemRefs.current) {
      if (intersects(box, el.getBoundingClientRect())) next.push(stampId)
    }
    setSelectedStampIds(next)
  }

  function finishSelection(event: React.PointerEvent<HTMLDivElement>) {
    const state = press.current
    press.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    setSelectBox(null)
    if (state && !state.active && useEditorStore.getState().selectedStampIds.length > 0) clearBulkSelection()
  }

  return (
    <div className="relative shrink-0 border-t border-line">
      <div className="flex items-center justify-between px-3 pt-2.5">
        <SectionTitle>印章架</SectionTitle>
        {stamps.length > 0 && <span className="text-[11px] text-ink-muted">拖到页面盖章</span>}
      </div>
      <div
        className={cx('scroll-slim grid max-h-[280px] grid-cols-2 gap-2 overflow-y-auto p-3', selectedIds.length > 0 && 'pb-14')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishSelection}
        onPointerCancel={finishSelection}
      >
        {stamps.map((stamp) => (
          <ShelfItem
            key={stamp.stampId}
            stamp={stamp}
            selected={selectedSet.has(stamp.stampId)}
            registerRef={(el) => {
              if (el) itemRefs.current.set(stamp.stampId, el)
              else itemRefs.current.delete(stamp.stampId)
            }}
          />
        ))}
        <ImportTile compact={stamps.length > 0} />
      </div>
      {selectBox && <SelectionBox box={selectBox} />}
      {selectedIds.length > 0 && (
        <BulkDeleteBar
          count={selectedIds.length}
          unit="个"
          deleteLabel="删除"
          onCancel={clearBulkSelection}
          onDelete={() => void deleteStampsAction(selectedStamps())}
        />
      )}
    </div>
  )
}

function ShelfItem({
  stamp,
  selected,
  registerRef
}: {
  stamp: StampAsset
  selected: boolean
  registerRef: (el: HTMLDivElement | null) => void
}) {
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
    <div ref={registerRef} data-shelf-item className="group relative">
      <button
        type="button"
        className={cx(
          'checker relative flex aspect-square w-full touch-none select-none items-center justify-center overflow-hidden rounded-lg border transition-all duration-150',
          armed
            ? 'border-accent ring-2 ring-accent/30'
            : selected
              ? 'border-accent ring-2 ring-accent/25'
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
        {selected && (
          <span className="absolute left-1 top-1 flex size-5 items-center justify-center rounded-full bg-accent text-white shadow-sm">
            <Check size={13} />
          </span>
        )}
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

function SelectionBox({ box }: { box: SelectBox }) {
  return createPortal(
    <div
      className="pointer-events-none fixed z-[130] rounded-sm border border-accent bg-accent/15"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    />,
    document.body
  )
}

function BulkDeleteBar({
  count,
  unit,
  deleteLabel,
  onCancel,
  onDelete
}: {
  count: number
  unit: string
  deleteLabel: string
  onCancel: () => void
  onDelete: () => void
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 2600)
    return () => window.clearTimeout(timer)
  }, [armed])

  return (
    <div className="absolute inset-x-2 bottom-2 z-20 flex items-center gap-1.5 rounded-lg border border-line bg-panel/95 px-2 py-1.5 shadow-pop backdrop-blur">
      <span className="tnum min-w-0 flex-1 truncate text-xs text-ink-muted">
        已选 {count} {unit}
      </span>
      <Button size="sm" variant="ghost" className="px-1.5" onClick={onCancel}>
        <X size={14} />
        取消
      </Button>
      <Button
        size="sm"
        variant="danger"
        className={cx(armed && 'anim-confirm bg-accent text-white hover:bg-accent-hover')}
        onClick={() => {
          if (armed) {
            setArmed(false)
            onDelete()
          } else {
            setArmed(true)
          }
        }}
      >
        <Trash2 size={14} />
        {armed ? '再点删除' : deleteLabel}
      </Button>
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
      data-shelf-item
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
