import { mmToPt } from './units'

export type Guide = {
  /** x = 垂直参考线（给定 x 坐标）；y = 水平参考线（给定 y 坐标，PDF 坐标系自下而上）。 */
  axis: 'x' | 'y'
  pt: number
}

export type RectPt = { xPt: number; yPt: number; widthPt: number; heightPt: number }

const MARGIN_PT = mmToPt(20)

type Candidate = { target: number; guide: number }

function pick(value: number, candidates: Candidate[], tolerance: number) {
  let best: { target: number; guide: number; dist: number } | null = null
  for (const c of candidates) {
    const dist = Math.abs(c.target - value)
    if (dist <= tolerance && (!best || dist < best.dist)) best = { ...c, dist }
  }
  return best
}

/**
 * 拖动吸附：页面中线、20mm 边距线、同页其他印章的边与中心。
 * 输入输出均为 PDF 坐标（pt，原点左下）。
 */
export function snapRect(
  rect: RectPt,
  page: { widthPt: number; heightPt: number },
  others: RectPt[],
  tolerancePt: number
): { xPt: number; yPt: number; guides: Guide[] } {
  const xCandidates: Candidate[] = []
  const yCandidates: Candidate[] = []

  const addX = (guide: number, anchor: 'start' | 'center' | 'end') => {
    const target = anchor === 'start' ? guide : anchor === 'center' ? guide - rect.widthPt / 2 : guide - rect.widthPt
    xCandidates.push({ target, guide })
  }
  const addY = (guide: number, anchor: 'start' | 'center' | 'end') => {
    const target = anchor === 'start' ? guide : anchor === 'center' ? guide - rect.heightPt / 2 : guide - rect.heightPt
    yCandidates.push({ target, guide })
  }

  addX(page.widthPt / 2, 'center')
  addY(page.heightPt / 2, 'center')
  addX(MARGIN_PT, 'start')
  addX(page.widthPt - MARGIN_PT, 'end')
  addY(MARGIN_PT, 'start')
  addY(page.heightPt - MARGIN_PT, 'end')

  for (const other of others) {
    addX(other.xPt, 'start')
    addX(other.xPt + other.widthPt / 2, 'center')
    addX(other.xPt + other.widthPt, 'end')
    addY(other.yPt, 'start')
    addY(other.yPt + other.heightPt / 2, 'center')
    addY(other.yPt + other.heightPt, 'end')
  }

  const bestX = pick(rect.xPt, xCandidates, tolerancePt)
  const bestY = pick(rect.yPt, yCandidates, tolerancePt)
  const guides: Guide[] = []
  if (bestX) guides.push({ axis: 'x', pt: bestX.guide })
  if (bestY) guides.push({ axis: 'y', pt: bestY.guide })
  return {
    xPt: bestX ? bestX.target : rect.xPt,
    yPt: bestY ? bestY.target : rect.yPt,
    guides
  }
}
