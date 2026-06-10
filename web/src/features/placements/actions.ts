import { clamp, type PageInfo, type Placement, type StampAsset } from '../../lib/types'
import { mmToPt } from '../../lib/units'
import { parsePageExpression } from '../../lib/pages'
import { activeFile, useEditorStore, MAX_PLACEMENTS_PER_JOB } from '../../state/store'
import { toast } from '../../state/toasts'
import { pageAtPoint } from '../viewer/pageRegistry'

export type NineAnchor =
  | 'topLeft'
  | 'top'
  | 'topRight'
  | 'left'
  | 'center'
  | 'right'
  | 'bottomLeft'
  | 'bottom'
  | 'bottomRight'

/** 期望尺寸（mm）换算到该页上的实际宽高，限制在页面一半以内。 */
export function stampSizePt(stamp: StampAsset, pageInfo: PageInfo, sizeMm: number) {
  const ratio = stamp.heightPx / Math.max(1, stamp.widthPx)
  const requestedWidthPt = mmToPt(clamp(sizeMm, 5, 150))
  const maxWidthPt = Math.max(24, pageInfo.widthPt * 0.5)
  const maxHeightPt = Math.max(24, pageInfo.heightPt * 0.5)
  let widthPt = clamp(requestedWidthPt, 12, maxWidthPt)
  let heightPt = widthPt * ratio
  if (heightPt > maxHeightPt) {
    heightPt = maxHeightPt
    widthPt = heightPt / Math.max(0.01, ratio)
  }
  return { widthPt, heightPt }
}

function defaultsForStamp(stampId: string) {
  const state = useEditorStore.getState()
  const sizeMm = state.stampMeta[stampId]?.sizeMm ?? state.stampDefaults.sizeMm
  return { sizeMm, opacity: state.stampDefaults.opacity, rotation: state.stampDefaults.rotation }
}

/** 以光标为中心生成一个放置（坐标为 PDF 坐标系）。 */
export function buildPlacementAt(
  stamp: StampAsset,
  pageInfo: PageInfo,
  centerXPt: number,
  centerTopPt: number
): Placement {
  const { sizeMm, opacity, rotation } = defaultsForStamp(stamp.stampId)
  const { widthPt, heightPt } = stampSizePt(stamp, pageInfo, sizeMm)
  const xPt = clamp(centerXPt - widthPt / 2, 0, Math.max(0, pageInfo.widthPt - widthPt))
  const yPt = clamp(pageInfo.heightPt - centerTopPt - heightPt / 2, 0, Math.max(0, pageInfo.heightPt - heightPt))
  return {
    id: crypto.randomUUID(),
    stampId: stamp.stampId,
    pageNumber: pageInfo.pageNumber,
    xPt,
    yPt,
    widthPt,
    heightPt,
    rotation,
    opacity
  }
}

/** 拖放 / 上膏点击的落点放置。返回是否成功。 */
export function placeAtClientPoint(stampId: string, clientX: number, clientY: number, options?: { select?: boolean }) {
  const state = useEditorStore.getState()
  const file = activeFile(state)
  const stamp = state.stamps.find((s) => s.stampId === stampId)
  if (!file || !stamp) return false
  const hit = pageAtPoint(clientX, clientY)
  if (!hit) return false
  const pageInfo = file.pages.find((p) => p.pageNumber === hit.pageNumber)
  if (!pageInfo) return false
  const zoom = state.zoom
  const centerXPt = (clientX - hit.rect.left) / zoom
  const centerTopPt = (clientY - hit.rect.top) / zoom
  if (state.configs[file.fileId] && state.configs[file.fileId].placements.length >= MAX_PLACEMENTS_PER_JOB) {
    toast(`普通章最多 ${MAX_PLACEMENTS_PER_JOB} 个。`, { kind: 'error' })
    return false
  }
  state.addPlacements([buildPlacementAt(stamp, pageInfo, centerXPt, centerTopPt)], options)
  return true
}

/** 把一个印章按相同位置应用到一组页面（同源覆盖，旧逻辑保留）。 */
export function applyPlacementToPages(placement: Placement, pages: number[]) {
  const state = useEditorStore.getState()
  const file = activeFile(state)
  if (!file || pages.length === 0) return
  const sourceId = placement.sourceId ?? placement.id
  const clones: Placement[] = []
  for (const page of pages) {
    const pageInfo = file.pages.find((p) => p.pageNumber === page)
    if (!pageInfo) continue
    clones.push({
      ...placement,
      id: page === placement.pageNumber ? placement.id : crypto.randomUUID(),
      sourceId,
      pageNumber: page,
      xPt: clamp(placement.xPt, 0, Math.max(0, pageInfo.widthPt - placement.widthPt)),
      yPt: clamp(placement.yPt, 0, Math.max(0, pageInfo.heightPt - placement.heightPt))
    })
  }
  if (clones.length === 0) return
  const keepId = clones.find((c) => c.pageNumber === placement.pageNumber)?.id ?? clones[0].id
  state.replacePlacements(
    (p) => pages.includes(p.pageNumber) && (p.id === sourceId || p.sourceId === sourceId),
    clones,
    keepId
  )
  toast(`已应用到 ${clones.length} 页 · Ctrl+Z 可撤销`, { kind: 'success' })
}

export function duplicatePlacement(placement: Placement) {
  const state = useEditorStore.getState()
  const file = activeFile(state)
  const pageInfo = file?.pages.find((p) => p.pageNumber === placement.pageNumber)
  if (!pageInfo) return
  const offset = mmToPt(5)
  state.addPlacements([
    {
      ...placement,
      id: crypto.randomUUID(),
      sourceId: undefined,
      xPt: clamp(placement.xPt + offset, 0, Math.max(0, pageInfo.widthPt - placement.widthPt)),
      yPt: clamp(placement.yPt - offset, 0, Math.max(0, pageInfo.heightPt - placement.heightPt))
    }
  ])
}

export function centerPlacement(placement: Placement) {
  const state = useEditorStore.getState()
  const file = activeFile(state)
  const pageInfo = file?.pages.find((p) => p.pageNumber === placement.pageNumber)
  if (!pageInfo) return
  state.updatePlacement(placement.id, {
    xPt: Math.max(0, (pageInfo.widthPt - placement.widthPt) / 2),
    yPt: Math.max(0, (pageInfo.heightPt - placement.heightPt) / 2)
  })
}

export function nudgeSelected(dxPt: number, dyPt: number) {
  const state = useEditorStore.getState()
  const selection = state.selection
  if (selection?.kind !== 'placement') return false
  const file = activeFile(state)
  if (!file) return false
  const config = state.configs[file.fileId]
  const placement = config?.placements.find((p) => p.id === selection.id)
  const pageInfo = file.pages.find((p) => p.pageNumber === placement?.pageNumber)
  if (!placement || !pageInfo) return false
  state.updatePlacement(placement.id, {
    xPt: clamp(placement.xPt + dxPt, 0, Math.max(0, pageInfo.widthPt - placement.widthPt)),
    yPt: clamp(placement.yPt + dyPt, 0, Math.max(0, pageInfo.heightPt - placement.heightPt))
  })
  return true
}

/** 等比调整尺寸，保持中心不动并夹在页面内。 */
export function resizePlacement(placement: Placement, pageInfo: PageInfo, targetWidthPt: number) {
  const ratio = placement.heightPt / Math.max(0.01, placement.widthPt)
  let widthPt = clamp(targetWidthPt, mmToPt(5), Math.min(pageInfo.widthPt, mmToPt(150)))
  let heightPt = widthPt * ratio
  if (heightPt > pageInfo.heightPt) {
    heightPt = pageInfo.heightPt
    widthPt = heightPt / Math.max(0.01, ratio)
  }
  const centerX = placement.xPt + placement.widthPt / 2
  const centerY = placement.yPt + placement.heightPt / 2
  useEditorStore.getState().updatePlacement(placement.id, {
    widthPt,
    heightPt,
    xPt: clamp(centerX - widthPt / 2, 0, Math.max(0, pageInfo.widthPt - widthPt)),
    yPt: clamp(centerY - heightPt / 2, 0, Math.max(0, pageInfo.heightPt - heightPt))
  })
}

function randomDelta(maxAbs: number) {
  if (!Number.isFinite(maxAbs) || maxAbs <= 0) return 0
  return (Math.random() * 2 - 1) * maxAbs
}

export type BatchOptions = {
  stampId: string
  rangeText: string
  anchor: NineAnchor
  marginXPt: number
  marginYPt: number
  randomEnabled: boolean
  randomOffsetPt: number
  randomRotationDeg: number
}

function anchorPosition(
  pageInfo: PageInfo,
  widthPt: number,
  heightPt: number,
  anchor: NineAnchor,
  marginX: number,
  marginY: number
) {
  const centerX = (pageInfo.widthPt - widthPt) / 2
  const centerY = (pageInfo.heightPt - heightPt) / 2
  const left = marginX
  const right = pageInfo.widthPt - widthPt - marginX
  const top = pageInfo.heightPt - heightPt - marginY
  const bottom = marginY
  const map: Record<NineAnchor, { x: number; y: number }> = {
    topLeft: { x: left, y: top },
    top: { x: centerX, y: top },
    topRight: { x: right, y: top },
    left: { x: left, y: centerY },
    center: { x: centerX, y: centerY },
    right: { x: right, y: centerY },
    bottomLeft: { x: left, y: bottom },
    bottom: { x: centerX, y: bottom },
    bottomRight: { x: right, y: bottom }
  }
  return map[anchor]
}

/** 九宫格批量盖章：直接写入（可 Ctrl+Z），返回新增数量；范围无效返回 -1。 */
export function batchStamp(options: BatchOptions): number {
  const state = useEditorStore.getState()
  const file = activeFile(state)
  const stamp = state.stamps.find((s) => s.stampId === options.stampId)
  if (!file || !stamp) return 0
  const expr = parsePageExpression(options.rangeText, file.pageCount)
  if (expr.invalidParts.length > 0) {
    toast(`页码范围无效：${expr.invalidParts.join('、')}`, { kind: 'error' })
    return -1
  }
  if (expr.pages.length === 0) {
    toast('目标页为空。', { kind: 'error' })
    return -1
  }
  const existing = state.configs[file.fileId]?.placements.length ?? 0
  if (existing + expr.pages.length > MAX_PLACEMENTS_PER_JOB) {
    toast(`批量后普通章会超过 ${MAX_PLACEMENTS_PER_JOB} 个，请缩小范围。`, { kind: 'error' })
    return -1
  }
  const placements: Placement[] = []
  for (const page of expr.pages) {
    const pageInfo = file.pages.find((p) => p.pageNumber === page)
    if (!pageInfo) continue
    const { sizeMm, opacity, rotation } = defaultsForStamp(stamp.stampId)
    const { widthPt, heightPt } = stampSizePt(stamp, pageInfo, sizeMm)
    const pos = anchorPosition(pageInfo, widthPt, heightPt, options.anchor, options.marginXPt, options.marginYPt)
    const dx = options.randomEnabled ? randomDelta(options.randomOffsetPt) : 0
    const dy = options.randomEnabled ? randomDelta(options.randomOffsetPt) : 0
    const dr = options.randomEnabled ? randomDelta(options.randomRotationDeg) : 0
    placements.push({
      id: crypto.randomUUID(),
      stampId: stamp.stampId,
      pageNumber: page,
      xPt: clamp(pos.x + dx, 0, Math.max(0, pageInfo.widthPt - widthPt)),
      yPt: clamp(pos.y + dy, 0, Math.max(0, pageInfo.heightPt - heightPt)),
      widthPt,
      heightPt,
      rotation: clamp(rotation + dr, -180, 180),
      opacity
    })
  }
  if (placements.length === 0) return 0
  useEditorStore.getState().addPlacements(placements, { select: false })
  toast(`已批量添加 ${placements.length} 个印章 · Ctrl+Z 可撤销`, { kind: 'success' })
  return placements.length
}
