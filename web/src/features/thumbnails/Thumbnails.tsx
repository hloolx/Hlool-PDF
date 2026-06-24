import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, FileUp, RotateCcw, RotateCw, Trash2, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { PDFDocumentProxy } from '../../lib/pdfjs'
import type { PageInfo, SeamSide } from '../../lib/types'
import { cx } from '../../lib/cx'
import { pagesToExpression, parsePageExpression } from '../../lib/pages'
import { activeConfig, activeFile, useEditorStore } from '../../state/store'
import { Button } from '../../ui/Button'
import { importAsNewProject } from '../workspace/actions'
import { scrollToPage } from '../viewer/pageRegistry'
import { deletePage, deletePages, reorderPages, rotatePage } from './reorder'

const THUMB_WIDTH = 124
/** 超过该位移（px）才视为拖拽，否则按点击处理。 */
const DRAG_THRESHOLD = 5
const SELECT_THRESHOLD = 5

type Press = {
  page: number
  startX: number
  startY: number
  grabDX: number
  grabDY: number
  w: number
  h: number
  active: boolean
}

type Ghost = { page: number; x: number; y: number; w: number; h: number; snapshot: string | null }
type SelectBox = { left: number; top: number; width: number; height: number }
type SelectPress = { startX: number; startY: number; active: boolean }

function boxFromPoints(startX: number, startY: number, x: number, y: number): SelectBox {
  const left = Math.min(startX, x)
  const top = Math.min(startY, y)
  return { left, top, width: Math.abs(x - startX), height: Math.abs(y - startY) }
}

function intersects(box: SelectBox, rect: DOMRect) {
  return box.left <= rect.right && box.left + box.width >= rect.left && box.top <= rect.bottom && box.top + box.height >= rect.top
}

/** 元素的布局视口坐标（扣除正在进行的 FLIP transform，避免命中测试读到动画中的瞬时位置）。 */
function layoutTop(el: HTMLElement) {
  let top = el.getBoundingClientRect().top
  const transform = getComputedStyle(el).transform
  if (transform && transform !== 'none') {
    top -= new DOMMatrixReadOnly(transform).m42
  }
  return top
}

/**
 * 页面缩略图栏：点击跳页；Ctrl/Shift 多选页面 ⇄ 范围表达式双向同步；
 * 角标显示该页印章数，骑缝章以边缘色带表示。
 * 直接拖动缩略图可调整页序（原地 rewrite，印章等配置随页面内容迁移）。
 */
export function Thumbnails({ doc }: { doc: PDFDocumentProxy | null }) {
  const file = useEditorStore(activeFile)
  const currentPage = useEditorStore((state) => state.currentPage)
  const rangeText = useEditorStore((state) => state.rangeText)
  const setRangeText = useEditorStore((state) => state.setRangeText)
  const setCurrentPage = useEditorStore((state) => state.setCurrentPage)
  const selectedPageNumbers = useEditorStore((state) => state.selectedPageNumbers)
  const selectedPageSet = new Set(selectedPageNumbers)
  const setSelectedPageNumbers = useEditorStore((state) => state.setSelectedPageNumbers)
  const clearBulkSelection = useEditorStore((state) => state.clearBulkSelection)
  const countsByPage = useEditorStore(
    useShallow((state) => {
      const counts: Record<number, number> = {}
      for (const p of activeConfig(state).placements) counts[p.pageNumber] = (counts[p.pageNumber] ?? 0) + 1
      return counts
    })
  )
  const seamEnabled = useEditorStore((state) => activeConfig(state).seamEnabled)
  const seamSide = useEditorStore((state) => activeConfig(state).seam.side)
  const seamPagesExpr = useEditorStore((state) => activeConfig(state).seam.pages)
  const anchor = useRef<number | null>(null)

  /* ---- 拖拽重排状态 ----
   * drag.order 是按显示顺序排列的“旧页码”，绑定 fileId+rev：
   * rewrite 成功后 rev 递增，旧的 order 自动失效，显示无缝切换到新文件的自然顺序。 */
  const rev = useEditorStore((state) => (file ? (state.fileRevs[file.fileId] ?? 0) : 0))
  const dragKey = file ? `${file.fileId}:${rev}` : ''
  const [drag, setDrag] = useState<{ key: string; order: number[] } | null>(null)
  const [ghost, setGhost] = useState<Ghost | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef(new Map<number, HTMLButtonElement>())
  const prevTops = useRef(new Map<number, number>())
  const press = useRef<Press | null>(null)
  const selectPress = useRef<SelectPress | null>(null)
  const raf = useRef(0)
  const suppressClick = useRef(false)
  const pending = useRef(false)
  const [selectBox, setSelectBox] = useState<SelectBox | null>(null)

  const order = useMemo(() => {
    if (!file) return []
    const natural = file.pages.map((p) => p.pageNumber)
    if (drag && drag.key === dragKey && drag.order.length === natural.length) return drag.order
    return natural
  }, [file, drag, dragKey])
  const orderRef = useRef(order)
  orderRef.current = order
  const dragKeyRef = useRef(dragKey)
  dragKeyRef.current = dragKey

  const seamPages = useMemo(() => {
    if (!file || !seamEnabled) return new Set<number>()
    return new Set(parsePageExpression(seamPagesExpr, file.pageCount).pages)
  }, [file, seamEnabled, seamPagesExpr])

  const rangePages = useMemo(() => {
    if (!file) return new Set<number>()
    const pages = new Set(parsePageExpression(rangeText, file.pageCount).pages)
    // “全部”是默认范围，无须在缩略图上逐页高亮
    return pages.size === file.pageCount ? new Set<number>() : pages
  }, [file, rangeText])

  /* FLIP：仅在显示顺序变化时，把位置变化的缩略图从旧槽位补间到新槽位。
   * 用容器文档坐标 + 布局位置（扣除滚动与正在进行的 transform），
   * ghost 跟随渲染与自动滚动都不会触发或污染补间。 */
  const orderKey = order.join(',')
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!ghost || !container) {
      prevTops.current.clear()
      return
    }
    const base = container.getBoundingClientRect().top - container.scrollTop
    for (const [page, el] of itemRefs.current) {
      const top = layoutTop(el) - base
      const prev = prevTops.current.get(page)
      if (prev !== undefined && Math.abs(prev - top) > 2) {
        el.animate([{ transform: `translateY(${prev - top}px)` }, { transform: 'none' }], {
          duration: 200,
          easing: 'cubic-bezier(0.2, 0, 0, 1)'
        })
      }
      prevTops.current.set(page, top)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey, ghost === null])

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  if (!file) {
    return (
      <div className="flex-1 p-3">
        <label className="flex h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line text-ink-muted transition-colors hover:border-accent hover:text-accent">
          <FileUp size={20} />
          <span className="text-xs font-medium">导入 PDF / 图片</span>
          <span className="px-3 text-center text-[11px] leading-relaxed text-ink-muted">
            或直接拖进窗口任意位置
          </span>
          <input
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/webp"
            multiple
            className="hidden"
            onChange={(event) => {
              const picked = Array.from(event.currentTarget.files ?? [])
              event.currentTarget.value = ''
              if (picked.length > 0) void importAsNewProject(picked)
            }}
          />
        </label>
      </div>
    )
  }

  function handleClick(event: React.MouseEvent, page: number) {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(rangePages)
      if (next.has(page)) next.delete(page)
      else next.add(page)
      setRangeText(pagesToExpression(next, file!.pageCount) || String(page))
      anchor.current = page
      return
    }
    if (event.shiftKey && anchor.current !== null) {
      const start = Math.min(anchor.current, page)
      const end = Math.max(anchor.current, page)
      const next = new Set<number>()
      for (let p = start; p <= end; p++) next.add(p)
      setRangeText(pagesToExpression(next, file!.pageCount))
      return
    }
    anchor.current = page
    setCurrentPage(page)
    scrollToPage(page, 'smooth')
  }

  function onThumbPointerDown(event: React.PointerEvent, page: number) {
    if (event.button !== 0 || !file || file.pageCount < 2) return
    if (pending.current || press.current) return
    // 多选手势不进入拖拽，交给 click 处理
    if (event.ctrlKey || event.metaKey || event.shiftKey) return
    suppressClick.current = false
    const el = itemRefs.current.get(page)
    const box = el?.querySelector('[data-thumb-box]') as HTMLElement | null
    if (!el || !box) return
    const rect = box.getBoundingClientRect()
    event.currentTarget.setPointerCapture(event.pointerId)
    press.current = {
      page,
      startX: event.clientX,
      startY: event.clientY,
      grabDX: event.clientX - rect.left,
      grabDY: event.clientY - rect.top,
      w: rect.width,
      h: rect.height,
      active: false
    }
  }

  function onThumbPointerMove(event: React.PointerEvent) {
    const state = press.current
    if (!state) return
    if (!state.active) {
      if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < DRAG_THRESHOLD) return
      state.active = true
      suppressClick.current = true
      const el = itemRefs.current.get(state.page)
      const canvas = el?.querySelector('canvas') as HTMLCanvasElement | null
      let snapshot: string | null = null
      if (canvas && canvas.width > 0) {
        try {
          snapshot = canvas.toDataURL()
        } catch {
          snapshot = null
        }
      }
      setDrag({ key: dragKeyRef.current, order: orderRef.current })
      setGhost({
        page: state.page,
        x: event.clientX - state.grabDX,
        y: event.clientY - state.grabDY,
        w: state.w,
        h: state.h,
        snapshot
      })
    }
    const { clientX, clientY } = event
    setGhost((g) => (g ? { ...g, x: clientX - state.grabDX, y: clientY - state.grabDY } : g))
    scheduleReorder(clientY)
    autoScroll(clientY)
  }

  function scheduleReorder(clientY: number) {
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      const state = press.current
      if (!state?.active) return
      const current = orderRef.current
      const from = current.indexOf(state.page)
      if (from < 0) return
      // 目标位置 = 中线在指针上方的其他缩略图数量（按布局位置，忽略动画瞬时坐标）
      let to = 0
      for (const page of current) {
        if (page === state.page) continue
        const el = itemRefs.current.get(page)
        if (!el) continue
        if (clientY > layoutTop(el) + el.offsetHeight / 2) to++
      }
      if (to === from) return
      const next = current.filter((p) => p !== state.page)
      next.splice(to, 0, state.page)
      setDrag({ key: dragKeyRef.current, order: next })
    })
  }

  function autoScroll(clientY: number) {
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    if (clientY < rect.top + 32) container.scrollTop -= 12
    else if (clientY > rect.bottom - 32) container.scrollTop += 12
  }

  function onThumbPointerUp(event: React.PointerEvent) {
    const state = press.current
    if (!state) return
    press.current = null
    cancelAnimationFrame(raf.current)
    ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
    if (!state.active || !file) return
    setGhost(null)
    const next = orderRef.current
    if (next.every((page, index) => page === index + 1)) {
      setDrag(null)
      return
    }
    pending.current = true
    void reorderPages(file, next).finally(() => {
      pending.current = false
      setDrag(null)
    })
  }

  function onThumbPointerCancel() {
    press.current = null
    suppressClick.current = false
    cancelAnimationFrame(raf.current)
    setGhost(null)
    if (!pending.current) setDrag(null)
  }

  function onBlankPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !file) return
    if ((event.target as HTMLElement).closest('[data-thumb-item]')) return
    event.currentTarget.setPointerCapture(event.pointerId)
    selectPress.current = { startX: event.clientX, startY: event.clientY, active: false }
  }

  function onBlankPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const state = selectPress.current
    if (!state) return
    if (!state.active) {
      if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < SELECT_THRESHOLD) return
      state.active = true
    }
    const box = boxFromPoints(state.startX, state.startY, event.clientX, event.clientY)
    setSelectBox(box)
    const next: number[] = []
    for (const [page, el] of itemRefs.current) {
      if (intersects(box, el.getBoundingClientRect())) next.push(page)
    }
    setSelectedPageNumbers(next.sort((a, b) => a - b))
  }

  function finishBlankSelection(event: React.PointerEvent<HTMLDivElement>) {
    const state = selectPress.current
    selectPress.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    setSelectBox(null)
    if (state && !state.active && useEditorStore.getState().selectedPageNumbers.length > 0) clearBulkSelection()
  }

  // 旋转 / 删除：操作进行中（busy）或拖拽未结束时忽略，避免叠加多次服务端合成。
  function handleRotate(page: number, deg: number) {
    if (!file || pending.current || useEditorStore.getState().busy) return
    void rotatePage(file, page, deg)
  }
  function handleDelete(page: number) {
    if (!file || pending.current || useEditorStore.getState().busy) return
    void deletePage(file, page)
  }

  const pageByNumber = new Map(file.pages.map((p) => [p.pageNumber, p]))

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={containerRef}
        className={cx('scroll-slim h-full overflow-y-auto p-3', selectedPageNumbers.length > 0 && 'pb-14')}
        onPointerDown={onBlankPointerDown}
        onPointerMove={onBlankPointerMove}
        onPointerUp={finishBlankSelection}
        onPointerCancel={finishBlankSelection}
      >
        <div className="grid gap-2.5">
          {order.map((pageNumber, index) => {
            const pageInfo = pageByNumber.get(pageNumber)
            if (!pageInfo) return null
            return (
              <ThumbItem
                key={pageNumber}
                doc={doc}
                pageInfo={pageInfo}
                displayNumber={index + 1}
                current={pageNumber === currentPage}
                inRange={rangePages.has(pageNumber)}
                bulkSelected={selectedPageSet.has(pageNumber)}
                stampCount={countsByPage[pageNumber] ?? 0}
                seamSide={seamPages.has(pageNumber) ? seamSide : null}
                dragging={ghost?.page === pageNumber}
                draggable={file.pageCount > 1}
                registerRef={(el) => {
                  if (el) itemRefs.current.set(pageNumber, el)
                  else itemRefs.current.delete(pageNumber)
                }}
                onClick={handleClick}
                onPointerDown={onThumbPointerDown}
                onPointerMove={onThumbPointerMove}
                onPointerUp={onThumbPointerUp}
                onPointerCancel={onThumbPointerCancel}
                onRotate={handleRotate}
                onDelete={handleDelete}
              />
            )
          })}
        </div>
        {ghost &&
          createPortal(
            <div
              className="pointer-events-none fixed z-[120] rotate-2 opacity-95"
              style={{ left: ghost.x, top: ghost.y, width: ghost.w }}
            >
              <span className="block overflow-hidden rounded-md border border-accent bg-white shadow-pop">
                {ghost.snapshot ? (
                  <img src={ghost.snapshot} alt="" draggable={false} className="block w-full" />
                ) : (
                  <span className="block" style={{ height: ghost.h }} />
                )}
              </span>
            </div>,
            document.body
          )}
      </div>
      {selectBox && <SelectionBox box={selectBox} />}
      {selectedPageNumbers.length > 0 && (
        <BulkDeleteBar
          count={selectedPageNumbers.length}
          unit="页"
          deleteLabel={selectedPageNumbers.length >= file.pageCount ? '移除文件' : '删除'}
          onCancel={clearBulkSelection}
          onDelete={() => {
            const pages = useEditorStore.getState().selectedPageNumbers
            clearBulkSelection()
            void deletePages(file, pages)
          }}
        />
      )}
    </div>
  )
}

const ThumbItem = memo(function ThumbItem({
  doc,
  pageInfo,
  displayNumber,
  current,
  inRange,
  bulkSelected,
  stampCount,
  seamSide,
  dragging,
  draggable,
  registerRef,
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onRotate,
  onDelete
}: {
  doc: PDFDocumentProxy | null
  pageInfo: PageInfo
  displayNumber: number
  current: boolean
  inRange: boolean
  bulkSelected: boolean
  stampCount: number
  seamSide: SeamSide | null
  dragging: boolean
  draggable: boolean
  registerRef: (el: HTMLButtonElement | null) => void
  onClick: (event: React.MouseEvent, page: number) => void
  onPointerDown: (event: React.PointerEvent, page: number) => void
  onPointerMove: (event: React.PointerEvent) => void
  onPointerUp: (event: React.PointerEvent) => void
  onPointerCancel: () => void
  onRotate: (page: number, deg: number) => void
  onDelete: (page: number) => void
}) {
  const ref = useRef<HTMLButtonElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [inView, setInView] = useState(pageInfo.pageNumber <= 12)
  const height = Math.round((THUMB_WIDTH * pageInfo.heightPt) / Math.max(1, pageInfo.widthPt))

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setInView(true)
        }
      },
      { rootMargin: '400px 0px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !doc || !inView) return
    let cancelled = false
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null
    doc
      .getPage(pageInfo.pageNumber)
      .then((page) => {
        if (cancelled || !canvasRef.current) return
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const scale = (THUMB_WIDTH / pageInfo.widthPt) * dpr
        const viewport = page.getViewport({ scale })
        const target = canvasRef.current
        const context = target.getContext('2d')
        if (!context) return
        target.width = Math.round(viewport.width)
        target.height = Math.round(viewport.height)
        renderTask = page.render({ canvas: target, canvasContext: context, viewport })
        renderTask.promise.catch(() => {})
      })
      .catch(() => {})
    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [doc, inView, pageInfo.pageNumber, pageInfo.widthPt])

  const seamBand =
    seamSide === 'left'
      ? 'left-0 top-0 h-full w-1'
      : seamSide === 'right'
        ? 'right-0 top-0 h-full w-1'
        : seamSide === 'top'
          ? 'left-0 top-0 h-1 w-full'
          : seamSide === 'bottom'
            ? 'bottom-0 left-0 h-1 w-full'
            : null

  return (
    <div className="group relative w-full">
      <button
        data-thumb-item
        ref={(el) => {
          ref.current = el
          registerRef(el)
        }}
        type="button"
        className={cx(
          'mx-auto grid w-[124px] touch-none select-none justify-items-center gap-1 outline-none',
          draggable && !dragging && 'cursor-grab active:cursor-grabbing'
        )}
        onClick={(event) => onClick(event, pageInfo.pageNumber)}
        onPointerDown={(event) => onPointerDown(event, pageInfo.pageNumber)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        title={`第 ${displayNumber} 页${stampCount > 0 ? ` · ${stampCount} 个印章` : ''}（拖动调整页序，Ctrl/Shift 点选页面范围）`}
      >
        <span
          data-thumb-box
          className={cx(
            'relative block overflow-hidden rounded-md border bg-white shadow-sm transition-all duration-150',
            dragging
              ? 'border-dashed border-accent/70 opacity-35'
              : bulkSelected
                ? 'border-accent ring-2 ring-accent/30'
                : current
                ? 'border-accent ring-2 ring-accent/30'
                : 'border-line group-hover:border-ink-muted/50',
            !dragging && inRange && !current && !bulkSelected && 'border-accent/70 ring-2 ring-accent/20'
          )}
          style={{ width: THUMB_WIDTH, height }}
        >
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
          {bulkSelected && (
            <span className="absolute left-1 top-1 flex size-5 items-center justify-center rounded-full bg-accent text-white shadow-sm">
              <Check size={13} />
            </span>
          )}
          {stampCount > 0 && (
            <span className="tnum absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-medium text-white">
              {stampCount}
            </span>
          )}
          {seamBand && <span className={cx('absolute bg-accent/75', seamBand)} />}
          {inRange && <span className="absolute bottom-1 left-1 size-1.5 rounded-full bg-accent" />}
        </span>
        <span className={cx('tnum text-[11px]', current ? 'font-semibold text-accent' : 'text-ink-muted')}>
          {displayNumber}
        </span>
      </button>
      {/* 悬停操作：左转 / 右转 / 删除该页。容器不拦截指针（不影响拖拽），按钮各自启用。 */}
      {!dragging && (
        <div className="pointer-events-none absolute inset-x-0 top-1 flex justify-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
          <ThumbAction title="向左旋转 90°" onClick={() => onRotate(pageInfo.pageNumber, -90)}>
            <RotateCcw />
          </ThumbAction>
          <ThumbAction title="向右旋转 90°" onClick={() => onRotate(pageInfo.pageNumber, 90)}>
            <RotateCw />
          </ThumbAction>
          <ThumbAction title="删除此页" danger onClick={() => onDelete(pageInfo.pageNumber)}>
            <Trash2 />
          </ThumbAction>
        </div>
      )}
    </div>
  )
})

function SelectionBox({ box }: { box: SelectBox }) {
  return createPortal(
    <div
      className="pointer-events-none fixed z-[130] rounded-sm border border-accent bg-accent/15"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    />,
    document.body
  )
}

function BulkDeleteBar({
  count,
  unit,
  deleteLabel,
  onCancel,
  onDelete
}: {
  count: number
  unit: string
  deleteLabel: string
  onCancel: () => void
  onDelete: () => void
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 2600)
    return () => window.clearTimeout(timer)
  }, [armed])

  return (
    <div className="absolute inset-x-2 bottom-2 z-20 flex items-center gap-1.5 rounded-lg border border-line bg-panel/95 px-2 py-1.5 shadow-pop backdrop-blur">
      <span className="tnum min-w-0 flex-1 truncate text-xs text-ink-muted">
        已选 {count} {unit}
      </span>
      <Button size="sm" variant="ghost" className="px-1.5" onClick={onCancel}>
        <X size={14} />
        取消
      </Button>
      <Button
        size="sm"
        variant="danger"
        className={cx(armed && 'anim-confirm bg-accent text-white hover:bg-accent-hover')}
        onClick={() => {
          if (armed) {
            setArmed(false)
            onDelete()
          } else {
            setArmed(true)
          }
        }}
      >
        <Trash2 size={14} />
        {armed ? '再点删除' : deleteLabel}
      </Button>
    </div>
  )
}

/** 缩略图上的悬停操作按钮：覆盖在页面预览顶部，自身可点击，不触发翻页 / 拖拽。 */
function ThumbAction({
  title,
  danger,
  onClick,
  children
}: {
  title: string
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={cx(
        'pointer-events-auto flex size-6 items-center justify-center rounded-md bg-ink/65 text-white shadow-sm backdrop-blur-[2px] transition hover:bg-ink/85 active:scale-95 [&_svg]:size-3.5 [&_svg]:shrink-0',
        danger && 'hover:bg-accent'
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}
