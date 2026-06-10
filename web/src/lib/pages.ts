export type PageExpression = {
  pages: number[]
  invalidParts: string[]
}

export function emptyPageExpression(): PageExpression {
  return { pages: [], invalidParts: [] }
}

export function normalizePageExpr(value: string) {
  const text = value.trim()
  return text === '' || text === '全部' || text.toLowerCase() === 'all' ? 'all' : text
}

/** 解析 `1,3-5` / `全部` 形式的页码表达式。 */
export function parsePageExpression(text: string, pageCount: number): PageExpression {
  const normalized = normalizePageExpr(text)
  if (normalized === 'all') {
    return { pages: Array.from({ length: pageCount }, (_, i) => i + 1), invalidParts: [] }
  }
  const pages = new Set<number>()
  const invalidParts: string[] = []
  for (const raw of normalized.split(/[,，]/)) {
    const part = raw.trim()
    if (!part) continue
    if (part.includes('-')) {
      const [a, b] = part.split('-').map((v) => Number(v.trim()))
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        invalidParts.push(part)
        continue
      }
      const start = Math.min(a, b)
      const end = Math.max(a, b)
      if (start < 1 || end > pageCount) {
        invalidParts.push(part)
        continue
      }
      for (let p = start; p <= end; p++) pages.add(p)
    } else {
      const p = Number(part)
      if (Number.isInteger(p) && p >= 1 && p <= pageCount) {
        pages.add(p)
      } else {
        invalidParts.push(part)
      }
    }
  }
  return { pages: [...pages].sort((a, b) => a - b), invalidParts }
}

/** 把页码列表压缩为 `1-3,5` 表达式（与 parsePageExpression 互逆）。 */
export function pagesToExpression(pages: Iterable<number>, pageCount: number): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  if (sorted.length === 0) return ''
  if (pageCount > 0 && sorted.length === pageCount) return '全部'
  const ranges: string[] = []
  let start = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i <= sorted.length; i++) {
    const page = sorted[i]
    if (page === prev + 1) {
      prev = page
      continue
    }
    ranges.push(start === prev ? String(start) : `${start}-${prev}`)
    start = page
    prev = page
  }
  return ranges.join(',')
}

export function summarizePages(pages: number[], pageCount: number) {
  if (pages.length === 0) return '未选择目标页面'
  if (pageCount > 0 && pages.length === pageCount) return `全部 ${pageCount} 页`
  const expr = pagesToExpression(pages, pageCount)
  const preview = expr.split(',').slice(0, 4).join(',')
  return `第 ${preview}${expr.split(',').length > 4 ? ',…' : ''} 页（共 ${pages.length} 页）`
}
