export const PT_PER_MM = 72 / 25.4

export function mmToPt(mm: number) {
  return mm * PT_PER_MM
}

export function ptToMm(pt: number) {
  return pt / PT_PER_MM
}

/** 用于界面展示的毫米值（整数毫米，小于 10mm 时保留一位小数）。 */
export function fmtMm(pt: number) {
  const mm = ptToMm(pt)
  return mm < 10 ? mm.toFixed(1) : String(Math.round(mm))
}
