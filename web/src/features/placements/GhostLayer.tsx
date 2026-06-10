import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { mmToPt } from '../../lib/units'
import { useEditorStore } from '../../state/store'
import { useGhost } from './ghost'

/** 拖拽 / 连续盖章时跟随光标的印章影像。 */
export function GhostLayer() {
  const drag = useGhost()
  const armedStampId = useEditorStore((state) => state.armedStampId)
  const stamps = useEditorStore((state) => state.stamps)
  const zoom = useEditorStore((state) => state.zoom)
  const defaults = useEditorStore((state) => state.stampDefaults)
  const stampMeta = useEditorStore((state) => state.stampMeta)

  const activeId = drag.dragStampId ?? armedStampId
  const stamp = stamps.find((s) => s.stampId === activeId) ?? null

  useEffect(() => {
    if (!armedStampId) return
    useGhost.setState({ tracked: false })
    const onMove = (event: PointerEvent) => {
      if (!useGhost.getState().dragStampId) useGhost.getState().move(event.clientX, event.clientY)
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [armedStampId])

  if (!stamp || !drag.tracked) return null

  const sizeMm = stampMeta[stamp.stampId]?.sizeMm ?? defaults.sizeMm
  const width = mmToPt(sizeMm) * zoom
  const height = (width * stamp.heightPx) / Math.max(1, stamp.widthPx)

  return createPortal(
    <div
      className="pointer-events-none fixed z-50"
      style={{
        left: drag.x - width / 2,
        top: drag.y - height / 2,
        width,
        height,
        opacity: 0.55,
        transform: `rotate(${defaults.rotation}deg)`
      }}
    >
      <img src={stamp.url} alt="" className="h-full w-full" />
      <span className="absolute left-1/2 top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-accent" />
      <span className="absolute left-1/2 top-1/2 h-px w-3 -translate-x-1/2 -translate-y-1/2 bg-accent" />
    </div>,
    document.body
  )
}
