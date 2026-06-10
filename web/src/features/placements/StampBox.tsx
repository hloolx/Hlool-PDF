import { memo, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import type { Guide, RectPt } from '../../lib/geometry'
import { snapRect } from '../../lib/geometry'
import { clamp, type PageInfo, type Placement, type StampAsset } from '../../lib/types'
import { fmtMm, mmToPt } from '../../lib/units'
import { parsePageExpression } from '../../lib/pages'
import { cx } from '../../lib/cx'
import { activeFile, useEditorStore } from '../../state/store'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '../../ui/ContextMenu'
import { applyPlacementToPages, centerPlacement, duplicatePlacement } from './actions'

type DragState =
  | { kind: 'move'; startX: number; startY: number; xPt: number; yPt: number }
  | { kind: 'resize'; centerX: number; centerY: number; ratio: number }
  | { kind: 'rotate'; centerClientX: number; centerClientY: number }

const HANDLES = [
  { key: 'nw', className: '-left-1 -top-1 cursor-nwse-resize' },
  { key: 'ne', className: '-right-1 -top-1 cursor-nesw-resize' },
  { key: 'sw', className: '-left-1 -bottom-1 cursor-nesw-resize' },
  { key: 'se', className: '-right-1 -bottom-1 cursor-nwse-resize' }
]

export const StampBox = memo(function StampBox({
  placement,
  stamp,
  pageInfo,
  zoom,
  selected,
  justAdded,
  siblings,
  onGuides
}: {
  placement: Placement
  stamp: StampAsset
  pageInfo: PageInfo
  zoom: number
  selected: boolean
  justAdded: boolean
  siblings: RectPt[]
  onGuides: (guides: Guide[] | null) => void
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<DragState | null>(null)
  const [label, setLabel] = useState<string | null>(null)
  const update = useEditorStore((state) => state.updatePlacement)
  const remove = useEditorStore((state) => state.removePlacement)
  const select = useEditorStore((state) => state.select)
  const clearLastAdded = useEditorStore((state) => state.clearLastAdded)

  const left = placement.xPt * zoom
  const top = (pageInfo.heightPt - placement.yPt - placement.heightPt) * zoom
  const width = placement.widthPt * zoom
  const height = placement.heightPt * zoom

  function capture(event: React.PointerEvent) {
    rootRef.current?.setPointerCapture(event.pointerId)
  }

  function beginMove(event: React.PointerEvent) {
    if (event.button !== 0) return
    event.stopPropagation()
    select({ kind: 'placement', id: placement.id })
    capture(event)
    drag.current = { kind: 'move', startX: event.clientX, startY: event.clientY, xPt: placement.xPt, yPt: placement.yPt }
  }

  function beginResize(event: React.PointerEvent) {
    if (event.button !== 0) return
    event.stopPropagation()
    capture(event)
    drag.current = {
      kind: 'resize',
      centerX: placement.xPt + placement.widthPt / 2,
      centerY: placement.yPt + placement.heightPt / 2,
      ratio: placement.heightPt / Math.max(0.01, placement.widthPt)
    }
  }

  function beginRotate(event: React.PointerEvent) {
    if (event.button !== 0) return
    event.stopPropagation()
    capture(event)
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return
    drag.current = { kind: 'rotate', centerClientX: rect.left + rect.width / 2, centerClientY: rect.top + rect.height / 2 }
  }

  function onPointerMove(event: React.PointerEvent) {
    const state = drag.current
    if (!state) return
    event.preventDefault()
    if (state.kind === 'move') {
      const dx = (event.clientX - state.startX) / zoom
      const dy = (event.clientY - state.startY) / zoom
      let x = state.xPt + dx
      let y = state.yPt - dy
      if (event.altKey) {
        onGuides([])
      } else {
        const snapped = snapRect(
          { xPt: x, yPt: y, widthPt: placement.widthPt, heightPt: placement.heightPt },
          pageInfo,
          siblings,
          6 / zoom
        )
        x = snapped.xPt
        y = snapped.yPt
        onGuides(snapped.guides)
      }
      update(placement.id, {
        xPt: clamp(x, 0, Math.max(0, pageInfo.widthPt - placement.widthPt)),
        yPt: clamp(y, 0, Math.max(0, pageInfo.heightPt - placement.heightPt))
      })
      return
    }
    if (state.kind === 'resize') {
      const pageEl = rootRef.current?.closest('[data-page]') as HTMLElement | null
      const rect = pageEl?.getBoundingClientRect()
      if (!rect) return
      const px = (event.clientX - rect.left) / zoom
      const py = pageInfo.heightPt - (event.clientY - rect.top) / zoom
      const dx = Math.abs(px - state.centerX)
      const dy = Math.abs(py - state.centerY)
      let widthPt = Math.max(dx * 2, (dy * 2) / Math.max(0.01, state.ratio))
      const maxWidth = Math.min(pageInfo.widthPt, mmToPt(150), pageInfo.heightPt / Math.max(0.01, state.ratio))
      widthPt = clamp(widthPt, mmToPt(5), maxWidth)
      const heightPt = widthPt * state.ratio
      update(placement.id, {
        widthPt,
        heightPt,
        xPt: clamp(state.centerX - widthPt / 2, 0, Math.max(0, pageInfo.widthPt - widthPt)),
        yPt: clamp(state.centerY - heightPt / 2, 0, Math.max(0, pageInfo.heightPt - heightPt))
      })
      setLabel(`${fmtMm(widthPt)} mm`)
      return
    }
    // 手柄位于印章正下方：rotation=0 时光标在中心正下方（atan2 = +90°）。
    const degrees = (Math.atan2(event.clientY - state.centerClientY, event.clientX - state.centerClientX) * 180) / Math.PI - 90
    let rotation = event.shiftKey ? Math.round(degrees / 15) * 15 : Math.round(degrees * 10) / 10
    rotation = ((rotation + 540) % 360) - 180
    update(placement.id, { rotation })
    setLabel(`${Math.round(rotation)}°`)
  }

  function onPointerUp(event: React.PointerEvent) {
    if (!drag.current) return
    rootRef.current?.releasePointerCapture?.(event.pointerId)
    drag.current = null
    setLabel(null)
    onGuides(null)
  }

  const file = useEditorStore(activeFile)
  const rangeText = useEditorStore((state) => state.rangeText)
  const rangePages = file ? parsePageExpression(rangeText, file.pageCount).pages : []
  const allPages = file ? file.pages.map((p) => p.pageNumber) : []

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={rootRef}
          className={cx(
            'absolute touch-none select-none',
            selected
              ? 'z-10 cursor-grab active:cursor-grabbing'
              : 'cursor-pointer hover:outline-dashed hover:outline-1 hover:outline-accent/60',
            justAdded && 'anim-stamp-press'
          )}
          style={{
            left,
            top,
            width,
            height,
            opacity: placement.opacity,
            transform: `rotate(${placement.rotation}deg)`,
            boxShadow: selected ? '0 0 0 1.5px var(--c-accent)' : undefined
          }}
          onPointerDown={beginMove}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={() => select({ kind: 'placement', id: placement.id })}
          onAnimationEnd={() => justAdded && clearLastAdded()}
        >
          <img src={stamp.url} alt="" draggable={false} className="pointer-events-none h-full w-full" />
          {selected && (
            <>
              {HANDLES.map((handle) => (
                <span
                  key={handle.key}
                  className={cx(
                    'absolute size-2.5 rounded-full border-[1.5px] border-accent bg-panel shadow-sm transition-transform hover:scale-125',
                    handle.className
                  )}
                  onPointerDown={beginResize}
                />
              ))}
              {/* 旋转手柄放在印章下方，避免被上方浮动工具条遮挡 */}
              <span
                className="absolute bottom-[-22px] left-1/2 h-[16px] w-px -translate-x-1/2 bg-accent/70"
                aria-hidden
              />
              <span
                className="absolute bottom-[-42px] left-1/2 flex size-5 -translate-x-1/2 cursor-grab items-center justify-center rounded-full border-[1.5px] border-accent bg-panel shadow-sm transition-transform hover:scale-110 active:cursor-grabbing"
                title="拖动旋转，按住 Shift 吸附 15°"
                onPointerDown={beginRotate}
              >
                <RotateCw size={13} className="pointer-events-none text-accent" />
              </span>
              {label && (
                <span
                  className="tnum pointer-events-none absolute -top-7 left-full ml-1 whitespace-nowrap rounded bg-ink px-1.5 py-0.5 text-xs text-panel"
                  style={{ transform: `rotate(${-placement.rotation}deg)` }}
                >
                  {label}
                </span>
              )}
            </>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => applyPlacementToPages(placement, allPages)}>应用到全部页</ContextMenuItem>
        <ContextMenuItem disabled={rangePages.length === 0} onSelect={() => applyPlacementToPages(placement, rangePages)}>
          应用到所选范围
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => centerPlacement(placement)}>页面居中</ContextMenuItem>
        <ContextMenuItem onSelect={() => duplicatePlacement(placement)}>
          复制 <span className="ml-auto text-xs text-ink-muted">Ctrl+D</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-accent" onSelect={() => remove(placement.id)}>
          删除 <span className="ml-auto text-xs text-ink-muted">Del</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})
