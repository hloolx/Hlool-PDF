import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import {
  AlignCenter,
  Copy,
  FileDown,
  FileUp,
  Layers,
  Redo2,
  RotateCcw,
  RotateCw,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import type { PDFDocumentProxy } from '../../lib/pdfjs'
import { clamp, type PageInfo } from '../../lib/types'
import { isEditingField } from '../../lib/dom'
import { parsePageExpression } from '../../lib/pages'
import { activeConfig, activeFile, MAX_ZOOM, MIN_ZOOM, redo, undo, useEditorStore, useTemporal } from '../../state/store'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '../../ui/ContextMenu'
import { applyPlacementToPages, centerPlacement, duplicatePlacement } from '../placements/actions'
import { PageOverlay } from '../placements/PageOverlay'
import { rotatePage } from '../thumbnails/reorder'
import { PageCanvas } from './PageCanvas'
import { clearPageRegistry, getPageEl, registerPage } from './pageRegistry'
import { copyPageAsPng, exportPagePdf } from './pageActions'

type ViewerMenuContext =
  | { kind: 'placement'; placementId: string }
  | { kind: 'page'; pageNumber: number }
  | { kind: 'canvas' }

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
  const [menuContext, setMenuContext] = useState<ViewerMenuContext>({ kind: 'canvas' })

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

  /* 适合宽度：仅随窗口尺寸变化重算；面板伸缩不触发，故缩放保持不变 */
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
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
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

  function handleContextMenuCapture(event: React.MouseEvent) {
    const target = event.target
    if (!(target instanceof Element)) return
    if (isEditingField(target) || target.closest('[data-native-context-menu]')) {
      event.stopPropagation()
      return
    }

    const state = useEditorStore.getState()
    const placementEl = target.closest<HTMLElement>('[data-placement-id]')
    const pageEl = target.closest<HTMLElement>('[data-page]')
    const pageNumber = Number(pageEl?.dataset.page)
    let next: ViewerMenuContext = { kind: 'canvas' }

    if (placementEl?.dataset.placementId) {
      const placementId = placementEl.dataset.placementId
      const placement = activeConfig(state).placements.find((item) => item.id === placementId)
      if (placement) {
        next = { kind: 'placement', placementId }
        state.select({ kind: 'placement', id: placementId })
        state.arm(null)
        state.setCurrentPage(placement.pageNumber)
      } else if (Number.isInteger(pageNumber) && pageNumber > 0) {
        next = { kind: 'page', pageNumber }
        state.select(null)
        state.arm(null)
        state.setCurrentPage(pageNumber)
      }
    } else if (Number.isInteger(pageNumber) && pageNumber > 0) {
      next = { kind: 'page', pageNumber }
      state.select(null)
      state.arm(null)
      state.setCurrentPage(pageNumber)
    } else {
      state.select(null)
      state.arm(null)
    }

    flushSync(() => setMenuContext(next))
  }

  if (!file) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="flex min-w-0 flex-1 items-center justify-center bg-canvas"
            onContextMenuCapture={handleContextMenuCapture}
          >
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
        </ContextMenuTrigger>
        <ViewerContextMenuContent context={menuContext} doc={doc} file={file} />
      </ContextMenu>
    )
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={scrollerRef}
          className="scroll-slim relative min-w-0 flex-1 overflow-auto bg-canvas"
          onContextMenuCapture={handleContextMenuCapture}
        >
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
                  key={`${file.fileId}:${pageInfo.pageNumber}`}
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
      </ContextMenuTrigger>
      <ViewerContextMenuContent context={menuContext} doc={doc} file={file} />
    </ContextMenu>
  )
}

function ViewerContextMenuContent({
  context,
  doc,
  file
}: {
  context: ViewerMenuContext
  doc: PDFDocumentProxy | null
  file: ReturnType<typeof activeFile>
}) {
  const zoom = useEditorStore((state) => state.zoom)
  const setZoom = useEditorStore((state) => state.setZoom)
  const busy = useEditorStore((state) => state.busy)
  const rangeText = useEditorStore((state) => state.rangeText)
  const config = useEditorStore(activeConfig)
  const { pastStates, futureStates } = useTemporal()

  function zoomBy(factor: number) {
    const state = useEditorStore.getState()
    state.setZoom(clamp(state.zoom * factor, MIN_ZOOM, MAX_ZOOM), 'custom')
  }

  if (context.kind === 'placement' && file) {
    const placement = config.placements.find((item) => item.id === context.placementId)
    const rangePages = parsePageExpression(rangeText, file.pageCount).pages
    const allPages = file.pages.map((page) => page.pageNumber)
    if (placement) {
      return (
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => applyPlacementToPages(placement, allPages)}>
            <Layers size={16} />
            应用到全部页
          </ContextMenuItem>
          <ContextMenuItem disabled={rangePages.length === 0} onSelect={() => applyPlacementToPages(placement, rangePages)}>
            <Layers size={16} />
            应用到所选范围
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => centerPlacement(placement)}>
            <AlignCenter size={16} />
            页面居中
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => duplicatePlacement(placement)}>
            <Copy size={16} />
            复制 <span className="ml-auto text-xs text-ink-muted">Ctrl+D</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem className="text-accent" onSelect={() => useEditorStore.getState().removePlacement(placement.id)}>
            <Trash2 size={16} />
            删除 <span className="ml-auto text-xs text-ink-muted">Del</span>
          </ContextMenuItem>
        </ContextMenuContent>
      )
    }
  }

  if (context.kind === 'page' && file) {
    const pageInfo = file.pages.find((page) => page.pageNumber === context.pageNumber)
    if (pageInfo) {
      return (
        <ContextMenuContent className="min-w-48">
          <ContextMenuItem disabled={Boolean(busy)} onSelect={() => void rotatePage(file, pageInfo.pageNumber, -90)}>
            <RotateCcw size={16} />
            向左旋转 90°
          </ContextMenuItem>
          <ContextMenuItem disabled={Boolean(busy)} onSelect={() => void rotatePage(file, pageInfo.pageNumber, 90)}>
            <RotateCw size={16} />
            向右旋转 90°
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={Boolean(busy) || !doc} onSelect={() => void copyPageAsPng(doc, file, pageInfo)}>
            <Copy size={16} />
            复制此页为 PNG
          </ContextMenuItem>
          <ContextMenuItem disabled={Boolean(busy)} onSelect={() => void exportPagePdf(doc, file, pageInfo)}>
            <FileDown size={16} />
            导出此页 PDF
          </ContextMenuItem>
        </ContextMenuContent>
      )
    }
  }

  return (
    <ContextMenuContent className="min-w-40">
      <ContextMenuItem disabled={zoom >= MAX_ZOOM} onSelect={() => zoomBy(1.1)}>
        <ZoomIn size={16} />
        放大
      </ContextMenuItem>
      <ContextMenuItem disabled={zoom <= MIN_ZOOM} onSelect={() => zoomBy(1 / 1.1)}>
        <ZoomOut size={16} />
        缩小
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => setZoom(zoom, 'fit')}>
        <AlignCenter size={16} />
        适合宽度
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={pastStates.length === 0} onSelect={() => undo()}>
        <Undo2 size={16} />
        撤销 <span className="ml-auto text-xs text-ink-muted">Ctrl+Z</span>
      </ContextMenuItem>
      <ContextMenuItem disabled={futureStates.length === 0} onSelect={() => redo()}>
        <Redo2 size={16} />
        重做 <span className="ml-auto text-xs text-ink-muted">Ctrl+Shift+Z</span>
      </ContextMenuItem>
    </ContextMenuContent>
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
