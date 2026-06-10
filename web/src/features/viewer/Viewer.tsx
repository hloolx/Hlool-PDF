import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { FileUp } from 'lucide-react'
import type { PDFDocumentProxy } from '../../lib/pdfjs'
import { clamp, type PageInfo } from '../../lib/types'
import { parsePageExpression } from '../../lib/pages'
import { activeConfig, activeFile, MAX_ZOOM, MIN_ZOOM, useEditorStore } from '../../state/store'
import { PageOverlay } from '../placements/PageOverlay'
import { PageCanvas } from './PageCanvas'
import { clearPageRegistry, getPageEl, registerPage } from './pageRegistry'

/** 中央画布：连续滚动页面流 + 直接操作层。 */
export function Viewer({ doc, error }: { doc: PDFDocumentProxy | null; error: string }) {
  const file = useEditorStore(activeFile)
  const zoom = useEditorStore((state) => state.zoom)
  const zoomPreset = useEditorStore((state) => state.zoomPreset)
  const setCurrentPage = useEditorStore((state) => state.setCurrentPage)
  const seamEnabled = useEditorStore((state) => activeConfig(state).seamEnabled)
  const seamPagesExpr = useEditorStore((state) => activeConfig(state).seam.pages)
  const placementCount = useEditorStore((state) => activeConfig(state).placements.length)
  const hasStamps = useEditorStore((state) => state.stamps.length > 0)
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  const seamIndexByPage = useMemo(() => {
    const map = new Map<number, number>()
    if (file && seamEnabled) {
      const pages = parsePageExpression(seamPagesExpr, file.pageCount).pages
      pages.forEach((page, index) => map.set(page, index))
    }
    return map
  }, [file, seamEnabled, seamPagesExpr])

  useEffect(() => {
    return () => clearPageRegistry()
  }, [file?.fileId])

  /* 适合宽度 */
  useEffect(() => {
    if (zoomPreset !== 'fit' || !file) return
    const scroller = scrollerRef.current
    if (!scroller) return
    const apply = () => {
      const maxWidthPt = Math.max(...file.pages.map((p) => p.widthPt))
      if (!Number.isFinite(maxWidthPt) || maxWidthPt <= 0) return
      const next = clamp((scroller.clientWidth - 112) / maxWidthPt, MIN_ZOOM, MAX_ZOOM)
      useEditorStore.getState().setZoom(next, 'fit')
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [file, zoomPreset])

  /* Ctrl+滚轮缩放（以光标为锚点） */
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const state = useEditorStore.getState()
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1
      const next = clamp(state.zoom * factor, MIN_ZOOM, MAX_ZOOM)
      const realFactor = next / state.zoom
      if (realFactor === 1) return
      const rect = scroller.getBoundingClientRect()
      const anchorX = event.clientX - rect.left
      const anchorY = event.clientY - rect.top
      const scrollLeft = scroller.scrollLeft
      const scrollTop = scroller.scrollTop
      state.setZoom(next, 'custom')
      requestAnimationFrame(() => {
        scroller.scrollLeft = (scrollLeft + anchorX) * realFactor - anchorX
        scroller.scrollTop = (scrollTop + anchorY) * realFactor - anchorY
      })
    }
    scroller.addEventListener('wheel', onWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', onWheel)
  }, [])

  /* 滚动跟踪当前页 */
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !file) return
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const rect = scroller.getBoundingClientRect()
        const anchorY = rect.top + Math.min(rect.height / 2, 420)
        let best = 0
        let bestDist = Infinity
        for (const page of file.pages) {
          const el = getPageEl(page.pageNumber)
          if (!el) continue
          const r = el.getBoundingClientRect()
          if (r.bottom < rect.top || r.top > rect.bottom) continue
          const dist = Math.abs((r.top + r.bottom) / 2 - anchorY)
          if (dist < bestDist) {
            bestDist = dist
            best = page.pageNumber
          }
        }
        if (best) setCurrentPage(best)
      })
    }
    onScroll()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      scroller.removeEventListener('scroll', onScroll)
    }
  }, [file, setCurrentPage])

  if (!file) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center bg-canvas">
        <div className="anim-rise flex flex-col items-center gap-3 text-ink-muted">
          <div className="flex size-16 items-center justify-center rounded-2xl border border-dashed border-ink-muted/40">
            <FileUp size={26} />
          </div>
          <div className="text-center leading-relaxed">
            <p className="text-sm font-medium text-ink">把 PDF / 图片拖进窗口开始</p>
            <p className="mt-1 text-xs">松手前选择落点：上方 = 导入为项目 · 底部 = 加入印章架</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div ref={scrollerRef} className="scroll-slim relative min-w-0 flex-1 overflow-auto bg-canvas">
      {error ? (
        <div className="p-8 text-center text-sm text-accent">{error}</div>
      ) : (
        <div className="mx-auto flex w-max min-w-full flex-col items-center gap-7 px-14 py-10">
          {placementCount === 0 && !seamEnabled && hasStamps && (
            <p className="anim-fade -mb-2 text-xs text-ink-muted">
              从左下角印章架把章拖到页面上，或单击印章后在页面上连续盖章
            </p>
          )}
          {file.pages.map((pageInfo) => (
            <PageFrame
              key={pageInfo.pageNumber}
              pageInfo={pageInfo}
              doc={doc}
              zoom={zoom}
              scrollerRef={scrollerRef}
              seamIndex={seamIndexByPage.get(pageInfo.pageNumber) ?? -1}
              seamTotal={seamIndexByPage.size}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const PageFrame = memo(function PageFrame({
  pageInfo,
  doc,
  zoom,
  scrollerRef,
  seamIndex,
  seamTotal
}: {
  pageInfo: PageInfo
  doc: PDFDocumentProxy | null
  zoom: number
  scrollerRef: RefObject<HTMLDivElement | null>
  seamIndex: number
  seamTotal: number
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [inView, setInView] = useState(pageInfo.pageNumber <= 2)

  useEffect(() => {
    registerPage(pageInfo.pageNumber, ref.current)
    return () => registerPage(pageInfo.pageNumber, null)
  }, [pageInfo.pageNumber])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setInView(entry.isIntersecting)
      },
      { root: scrollerRef.current, rootMargin: '600px 0px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [scrollerRef])

  const width = pageInfo.widthPt * zoom
  const height = pageInfo.heightPt * zoom

  return (
    <div>
      <div
        ref={ref}
        data-page={pageInfo.pageNumber}
        className="relative rounded-[3px] bg-white shadow-page"
        style={{ width, height }}
      >
        {doc && <PageCanvas doc={doc} pageNumber={pageInfo.pageNumber} zoom={zoom} visible={inView} />}
        <PageOverlay pageInfo={pageInfo} zoom={zoom} seamIndex={seamIndex} seamTotal={seamTotal} />
      </div>
      <div className="tnum mt-1.5 text-center text-xs text-ink-muted/80">{pageInfo.pageNumber}</div>
    </div>
  )
})
