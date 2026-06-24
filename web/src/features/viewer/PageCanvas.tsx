import { memo, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from '../../lib/pdfjs'

/** 单页位图渲染：visible 时按 devicePixelRatio 渲染，移出视口后释放位图内存。 */
export const PageCanvas = memo(function PageCanvas({
  doc,
  pageNumber,
  zoom,
  visible
}: {
  doc: PDFDocumentProxy
  pageNumber: number
  zoom: number
  visible: boolean
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    if (!visible) {
      canvas.width = 0
      canvas.height = 0
      setReady(false)
      return
    }
    let cancelled = false
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null
    doc
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled || !ref.current) return
        const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
        const viewport = page.getViewport({ scale: zoom * dpr })
        const target = ref.current
        const context = target.getContext('2d')
        if (!context) return
        target.width = Math.round(viewport.width)
        target.height = Math.round(viewport.height)
        renderTask = page.render({ canvas: target, canvasContext: context, viewport })
        renderTask.promise.then(
          () => {
            if (!cancelled) setReady(true)
          },
          () => {
            /* 渲染取消是正常路径 */
          }
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [doc, pageNumber, zoom, visible])

  return (
    <>
      {!ready && (
        <div className="pulse-soft pointer-events-none absolute inset-0 bg-sunken" aria-hidden />
      )}
      <canvas ref={ref} className="absolute inset-0 h-full w-full" />
    </>
  )
})
