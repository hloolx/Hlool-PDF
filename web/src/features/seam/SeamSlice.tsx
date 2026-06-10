import { memo, useEffect, useRef } from 'react'
import { clamp, type PageInfo, type SeamConfig, type StampAsset } from '../../lib/types'
import { cx } from '../../lib/cx'
import { useEditorStore } from '../../state/store'
import { useImage } from '../viewer/imageCache'
import { seamCrop, seamRectPt } from './slices'

type DragState = { startX: number; startY: number; position: number }

/** 页面边缘的真实骑缝切片：所见即输出。可沿边拖动调整位置。 */
export const SeamSliceView = memo(function SeamSliceView({
  seal,
  stamp,
  pageInfo,
  index,
  total,
  zoom,
  selected
}: {
  seal: SeamConfig
  stamp: StampAsset
  pageInfo: PageInfo
  index: number
  total: number
  zoom: number
  selected: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drag = useRef<DragState | null>(null)
  const img = useImage(stamp.url)
  const select = useEditorStore((state) => state.select)
  const setSeam = useEditorStore((state) => state.setSeam)

  const crop = seamCrop(stamp.widthPx, stamp.heightPx, index, total, seal.maxSlices, seal.side, seal.randomSeed)
  const rect = seamRectPt(pageInfo, crop, seal)
  const vertical = seal.side === 'left' || seal.side === 'right'

  const left = rect.xPt * zoom
  const top = (pageInfo.heightPt - rect.yPt - rect.heightPt) * zoom
  const width = Math.max(2, rect.widthPt * zoom)
  const height = Math.max(2, rect.heightPt * zoom)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !img) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height)
  }, [img, crop.sx, crop.sy, crop.sw, crop.sh, width, height])

  function onPointerDown(event: React.PointerEvent) {
    if (event.button !== 0) return
    event.stopPropagation()
    select({ kind: 'seam' })
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { startX: event.clientX, startY: event.clientY, position: seal.positionPercent }
  }

  function onPointerMove(event: React.PointerEvent) {
    const state = drag.current
    if (!state) return
    event.preventDefault()
    if (vertical) {
      const track = pageInfo.heightPt - rect.heightPt
      if (track <= 0) return
      const startY = (track * (100 - state.position)) / 100
      const deltaPt = (event.clientY - state.startY) / zoom
      const nextTop = clamp(startY + deltaPt, 0, track)
      setSeam({ positionPercent: Math.round((100 - (nextTop / track) * 100) * 10) / 10 })
    } else {
      const track = pageInfo.widthPt - rect.widthPt
      if (track <= 0) return
      const startX = (track * state.position) / 100
      const deltaPt = (event.clientX - state.startX) / zoom
      const nextLeft = clamp(startX + deltaPt, 0, track)
      setSeam({ positionPercent: Math.round((nextLeft / track) * 100 * 10) / 10 })
    }
  }

  function onPointerUp(event: React.PointerEvent) {
    if (!drag.current) return
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    drag.current = null
  }

  return (
    <div
      className={cx(
        'absolute touch-none select-none',
        vertical ? 'cursor-ns-resize' : 'cursor-ew-resize',
        selected ? 'z-10' : 'hover:outline-dashed hover:outline-1 hover:outline-accent/60'
      )}
      style={{
        left,
        top,
        width,
        height,
        opacity: seal.opacity,
        boxShadow: selected ? '0 0 0 1.5px var(--c-accent)' : undefined
      }}
      title={`骑缝章 第 ${index + 1}/${total} 片，拖动调整位置`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <canvas ref={canvasRef} className="h-full w-full" />
      {selected && (
        <span
          className={cx(
            'tnum pointer-events-none absolute whitespace-nowrap rounded bg-ink px-1.5 py-0.5 text-xs text-panel',
            vertical ? 'right-full top-1/2 mr-1.5 -translate-y-1/2' : 'bottom-full left-1/2 mb-1.5 -translate-x-1/2'
          )}
        >
          {index + 1} / {total} 片
        </span>
      )}
    </div>
  )
})
