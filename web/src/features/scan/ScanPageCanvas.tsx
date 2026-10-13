import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PDFDocumentProxy } from '../../lib/pdfjs'
import { DEFAULT_SCAN, type PDFFile, type PageInfo } from '../../lib/types'
import { errorText } from '../../lib/errors'
import { activeConfig, useEditorStore } from '../../state/store'
import { Button } from '../../ui/Button'
import { pageSnapshotSize, renderPagePreview } from '../viewer/pageActions'
import { applyScanEffect } from './canvas'
import { clampScanScale } from './renderScale'

/** Central scan preview: compose PDF + stamps first, then apply the output effect. */
export function ScanPageCanvas({ doc, file, pageInfo, visible, onPageSize }: {
  doc: PDFDocumentProxy
  file: PDFFile
  pageInfo: PageInfo
  visible: boolean
  onPageSize: (width: number, height: number) => void
}) {
  const config = useEditorStore((state) => activeConfig(state).scanConfig ?? DEFAULT_SCAN)
  const placements = useEditorStore(useShallow((state) => activeConfig(state).placements.filter((placement) => placement.pageNumber === pageInfo.pageNumber)))
  const seam = useEditorStore((state) => activeConfig(state).seam)
  const seamEnabled = useEditorStore((state) => activeConfig(state).seamEnabled)
  const stamps = useEditorStore((state) => state.stamps)
  // Zoom only changes the existing page frame: effect strength stays tied to
  // output resolution and does not change as the user zooms or flips pages.
  const sourceKey = useMemo(() => ({}), [doc, file, pageInfo, placements, seam, seamEnabled, stamps, config.scale])
  const [retry, setRetry] = useState(0)
  const requestKey = useMemo(() => ({}), [sourceKey, config, visible, retry])
  const source = useRef<{ key: object; canvas: HTMLCanvasElement } | null>(null)
  const holder = useRef<HTMLDivElement>(null)
  const [result, setResult] = useState<{ key: object; error: string } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const releaseSource = () => {
      if (source.current) source.current.canvas.width = source.current.canvas.height = 0
      source.current = null
    }
    if (!visible || source.current?.key !== sourceKey) releaseSource()
    if (!visible) return
    let processed: HTMLCanvasElement | undefined
    // Coalesce slider changes. Cleanup cancels PDF rendering and stale work can
    // never replace a newer frame; the old frame is hidden while updating.
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          if (!source.current) {
            const page = await doc.getPage(pageInfo.pageNumber)
            controller.signal.throwIfAborted()
            const viewport = page.getViewport({ scale: 1 })
            onPageSize(viewport.width, viewport.height)
            const scale = clampScanScale(config.scale, viewport.width, viewport.height)
            const canvas = await renderPagePreview(doc, file, pageInfo, useEditorStore.getState(), scale, controller.signal)
            if (controller.signal.aborted) { canvas.width = canvas.height = 0; return }
            const size = pageSnapshotSize(canvas)
            if (size) onPageSize(size.widthPt, size.heightPt)
            source.current = { key: sourceKey, canvas }
          }
          controller.signal.throwIfAborted()
          processed = applyScanEffect(source.current.canvas, config, { randomize: false })
          processed.className = 'block h-full w-full'
          processed.setAttribute('aria-label', `第 ${pageInfo.pageNumber} 页扫描效果预览`)
          processed.dataset.scanCanvas = String(pageInfo.pageNumber)
          holder.current?.replaceChildren(processed)
          setResult({ key: requestKey, error: '' })
        } catch (error) {
          if (!controller.signal.aborted) setResult({ key: requestKey, error: `扫描预览失败：${errorText(error)}` })
        }
      })()
    }, 150)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
      if (processed) processed.width = processed.height = 0
    }
  }, [requestKey, sourceKey, config, doc, file, pageInfo, visible, onPageSize])

  useEffect(() => () => {
    if (source.current) source.current.canvas.width = source.current.canvas.height = 0
    source.current = null
  }, [])

  const current = result?.key === requestKey
  const ready = current && !result.error
  return (
    <div className="absolute inset-0" data-testid="scan-page-preview" aria-busy={!ready && !(current && result.error)}>
      <div ref={holder} className="h-full w-full" style={{ visibility: ready ? 'visible' : 'hidden' }} />
      {!ready && visible && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-panel p-4 text-center text-xs text-ink-muted">
          {current && result.error ? (
            <>
              <p role="alert" className="max-w-72 break-words">{result.error}</p>
              <Button size="sm" onClick={() => setRetry((value) => value + 1)}>重新预览</Button>
            </>
          ) : <p role="status">正在更新扫描预览…</p>}
        </div>
      )}
    </div>
  )
}
