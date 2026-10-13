/** Shared output/preview canvas limit: 4000px per edge and 16M pixels. */
export function clampScanScale(scale: number, widthPt: number, heightPt: number): number {
  if (![scale, widthPt, heightPt].every(Number.isFinite) || widthPt <= 0 || heightPt <= 0) throw new Error('扫描页面尺寸或清晰度无效，请检查 PDF 与扫描设置。')
  let s = Math.min(Math.max(scale, 0.5), 3)
  const longEdge = Math.max(widthPt, heightPt)
  if (longEdge * s > 4000) s = 4000 / longEdge
  if (widthPt * heightPt * s * s > 16_000_000) s = Math.sqrt(16_000_000 / (widthPt * heightPt))
  return s
}
