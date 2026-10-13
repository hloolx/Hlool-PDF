export type PageExpression = {
  pages: number[]
  invalidParts: string[]
}

/** Bound expansion even for malformed imported metadata or enormous user-entered ranges. */
export const MAX_PAGE_SELECTION = 100_000

export function emptyPageExpression(): PageExpression {
  return { pages: [], invalidParts: [] }
}

export function normalizePageExpr(value: string) {
  // 中文输入法默认打全角逗号「，」：后端解析器只认半角，发送前统一归一，
  // 否则会出现「前端校验通过、后端 400」的两层语义。
  const text = value.replace(/，/g, ',').trim()
  return text === '' || text === '全部' || text.toLowerCase() === 'all' ? 'all' : text
}

/** 解析 `1,3-5` / `全部` 形式的页码表达式。 */
export function parsePageExpression(text: string, pageCount: number): PageExpression {
  const normalized = normalizePageExpr(text)
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    return { pages: [], invalidParts: [normalized] }
  }
  if (normalized === 'all') {
    if (pageCount > MAX_PAGE_SELECTION) return { pages: [], invalidParts: [`全部（最多 ${MAX_PAGE_SELECTION} 页）`] }
    return { pages: Array.from({ length: pageCount }, (_, i) => i + 1), invalidParts: [] }
  }
  const pages = new Set<number>()
  const invalidParts: string[] = []
  for (const raw of normalized.split(/[,，]/)) {
    const part = raw.trim()
    if (!part) continue
    if (!/^\d+(?:\s*-\s*\d+)?$/.test(part)) {
      invalidParts.push(part)
      continue
    }
    if (part.includes('-')) {
      const [a, b] = part.split('-').map((v) => Number(v.trim()))
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
        invalidParts.push(part)
        continue
      }
      const start = Math.min(a, b)
      const end = Math.max(a, b)
      if (start < 1 || end > pageCount || end - start + 1 > MAX_PAGE_SELECTION) {
        invalidParts.push(part)
        continue
      }
      for (let p = start; p <= end; p++) {
        if (pages.size >= MAX_PAGE_SELECTION && !pages.has(p)) {
          invalidParts.push(part)
          break
        }
        pages.add(p)
      }
    } else {
      const p = Number(part)
      if (Number.isSafeInteger(p) && p >= 1 && p <= pageCount && (pages.size < MAX_PAGE_SELECTION || pages.has(p))) {
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
