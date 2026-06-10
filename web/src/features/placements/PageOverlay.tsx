import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Guide } from '../../lib/geometry'
import type { PageInfo } from '../../lib/types'
import { cx } from '../../lib/cx'
import { activeConfig, useEditorStore } from '../../state/store'
import { SeamSliceView } from '../seam/SeamSlice'
import { StampBox } from './StampBox'
import { PlacementToolbar } from './Toolbar'
import { placeAtClientPoint } from './actions'

/** 单页覆盖层：印章、骑缝切片、参考线、浮动工具条与点击放置都在这里。 */
export function PageOverlay({
  pageInfo,
  zoom,
  seamIndex,
  seamTotal
}: {
  pageInfo: PageInfo
  zoom: number
  seamIndex: number
  seamTotal: number
}) {
  const placements = useEditorStore(
    useShallow((state) => activeConfig(state).placements.filter((p) => p.pageNumber === pageInfo.pageNumber))
  )
  const stamps = useEditorStore((state) => state.stamps)
  const selection = useEditorStore((state) => state.selection)
  const armedStampId = useEditorStore((state) => state.armedStampId)
  const lastAddedId = useEditorStore((state) => state.lastAddedId)
  const seamEnabled = useEditorStore((state) => activeConfig(state).seamEnabled)
  const seam = useEditorStore((state) => activeConfig(state).seam)
  const select = useEditorStore((state) => state.select)
  const [guides, setGuides] = useState<Guide[] | null>(null)

  const stampMap = useMemo(() => new Map(stamps.map((s) => [s.stampId, s])), [stamps])
  const seamStamp = seam.stampId ? stampMap.get(seam.stampId) : undefined
  const selectedHere =
    selection?.kind === 'placement' ? placements.find((p) => p.id === selection.id) : undefined

  function handlePointerDown(event: React.PointerEvent) {
    if (armedStampId && event.button === 0) {
      event.preventDefault()
      placeAtClientPoint(armedStampId, event.clientX, event.clientY, { select: false })
      return
    }
    if (event.target === event.currentTarget) select(null)
  }

  return (
    <div className={cx('absolute inset-0', armedStampId && 'cursor-crosshair')} onPointerDown={handlePointerDown}>
      {placements.map((placement) => {
        const stamp = stampMap.get(placement.stampId)
        if (!stamp) return null
        return (
          <StampBox
            key={placement.id}
            placement={placement}
            stamp={stamp}
            pageInfo={pageInfo}
            zoom={zoom}
            selected={selection?.kind === 'placement' && selection.id === placement.id}
            justAdded={placement.id === lastAddedId}
            siblings={placements.filter((p) => p.id !== placement.id)}
            onGuides={setGuides}
          />
        )
      })}
      {seamEnabled && seamStamp && seamIndex >= 0 && (
        <SeamSliceView
          seal={seam}
          stamp={seamStamp}
          pageInfo={pageInfo}
          index={seamIndex}
          total={seamTotal}
          zoom={zoom}
          selected={selection?.kind === 'seam'}
        />
      )}
      {guides?.map((guide, i) =>
        guide.axis === 'x' ? (
          <div
            key={i}
            className="pointer-events-none absolute bottom-0 top-0 w-px bg-accent/70"
            style={{ left: guide.pt * zoom }}
          />
        ) : (
          <div
            key={i}
            className="pointer-events-none absolute left-0 right-0 h-px bg-accent/70"
            style={{ top: (pageInfo.heightPt - guide.pt) * zoom }}
          />
        )
      )}
      {selectedHere && !armedStampId && (
        <PlacementToolbar placement={selectedHere} pageInfo={pageInfo} zoom={zoom} />
      )}
    </div>
  )
}
