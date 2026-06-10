/** 画布中每页 DOM 节点的注册表：拖放落点检测与跳页滚动都从这里查。 */
const pageEls = new Map<number, HTMLDivElement>()

export function registerPage(pageNumber: number, el: HTMLDivElement | null) {
  if (el) {
    pageEls.set(pageNumber, el)
  } else {
    pageEls.delete(pageNumber)
  }
}

export function clearPageRegistry() {
  pageEls.clear()
}

export function getPageEl(pageNumber: number) {
  return pageEls.get(pageNumber) ?? null
}

export function pageAtPoint(clientX: number, clientY: number): { pageNumber: number; rect: DOMRect } | null {
  for (const [pageNumber, el] of pageEls) {
    const rect = el.getBoundingClientRect()
    if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
      return { pageNumber, rect }
    }
  }
  return null
}

export function scrollToPage(pageNumber: number, behavior: ScrollBehavior = 'auto') {
  const el = pageEls.get(pageNumber)
  el?.scrollIntoView({ behavior, block: 'start' })
}
