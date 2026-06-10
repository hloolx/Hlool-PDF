import type { SeamConfig, SeamSide } from '../../lib/types'

/**
 * 与后端 internal/pdf/pdf.go 完全一致的切片算法：
 * 选中页按 maxSlices 分组；组内默认等分，randomSeed 非 0 时用同种子的
 * mulberry32 在等分点附近做受限抖动（最小片宽为段宽 30%）。
 * 两端实现已用固定种子交叉验证逐位一致 —— 预览即产物。
 */
export type SeamCrop = { sx: number; sy: number; sw: number; sh: number }

function effectiveMaxSlices(maxSlices: number, axisPixels: number) {
  let limit = maxSlices > 0 ? maxSlices : 20
  if (limit > axisPixels) limit = axisPixels
  return Math.max(1, limit)
}

/** 与 Go mulberry32 逐位一致（uint32 回绕，Math.imul）。 */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function sliceBoundaries(axisPixels: number, groupSize: number, rng: (() => number) | null): number[] {
  const out = new Array<number>(groupSize + 1)
  if (!rng || groupSize <= 1) {
    for (let i = 0; i <= groupSize; i++) out[i] = Math.floor((axisPixels * i) / groupSize)
    return out
  }
  const segment = axisPixels / groupSize
  const minWidth = Math.max(2, segment * 0.3)
  let prev = 0
  for (let i = 1; i < groupSize; i++) {
    const even = (axisPixels * i) / groupSize
    const jitter = (rng() * 2 - 1) * segment * 0.35
    let raw = even + jitter
    const lo = prev + minWidth
    const hi = axisPixels - (groupSize - i) * minWidth
    if (raw < lo) raw = lo
    if (raw > hi) raw = hi
    out[i] = Math.floor(raw)
    prev = raw
  }
  out[0] = 0
  out[groupSize] = axisPixels
  return out
}

export function seamCrop(
  stampWidthPx: number,
  stampHeightPx: number,
  index: number,
  total: number,
  maxSlices: number,
  side: SeamSide,
  randomSeed: number
): SeamCrop {
  const axisPixels = side === 'top' || side === 'bottom' ? stampHeightPx : stampWidthPx
  const limit = effectiveMaxSlices(maxSlices, axisPixels)
  const groupStart = Math.floor(index / limit) * limit
  const groupSize = Math.min(limit, total - groupStart)
  const j = index - groupStart

  let rng: (() => number) | null = null
  if (randomSeed) {
    rng = mulberry32(randomSeed)
    // 后端的随机数流贯穿所有分组：之前的每个完整组各消耗 limit-1 个。
    const skip = (groupStart / limit) * (limit - 1)
    for (let k = 0; k < skip; k++) rng()
  }
  const cuts = sliceBoundaries(axisPixels, groupSize, rng)

  if (side === 'top' || side === 'bottom') {
    return { sx: 0, sy: cuts[j], sw: stampWidthPx, sh: Math.max(1, cuts[j + 1] - cuts[j]) }
  }
  return { sx: cuts[j], sy: 0, sw: Math.max(1, cuts[j + 1] - cuts[j]), sh: stampHeightPx }
}

/** 与后端 seamPlacement 一致的落位计算（PDF 坐标，原点左下）。 */
export function seamRectPt(
  page: { widthPt: number; heightPt: number },
  crop: SeamCrop,
  seal: SeamConfig
): { xPt: number; yPt: number; widthPt: number; heightPt: number } {
  if (seal.side === 'top' || seal.side === 'bottom') {
    const widthPt = seal.sizePt
    const heightPt = (widthPt * crop.sh) / crop.sw
    const xPt = ((page.widthPt - widthPt) * seal.positionPercent) / 100
    const yPt = seal.side === 'top' ? page.heightPt - heightPt - seal.marginPt : seal.marginPt
    return { xPt, yPt, widthPt, heightPt }
  }
  const heightPt = seal.sizePt
  const widthPt = (heightPt * crop.sw) / crop.sh
  const xPt = seal.side === 'left' ? seal.marginPt : page.widthPt - widthPt - seal.marginPt
  const yPt = ((page.heightPt - heightPt) * (100 - seal.positionPercent)) / 100
  return { xPt, yPt, widthPt, heightPt }
}
