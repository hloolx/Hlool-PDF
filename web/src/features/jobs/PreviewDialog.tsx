import { useEffect, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import type { PDFDocumentProxy } from '../../lib/pdfjs'
import { Button } from '../../ui/Button'
import { Dialog, DialogContent } from '../../ui/Dialog'
import { usePdfDocument } from '../viewer/usePdfDocument'
import { useJobsUi } from './jobsUi'

const PREVIEW_WIDTH = 620
const MAX_PREVIEW_PAGES = 80

/** 生成结果的在线核对预览：下载前翻页确认。 */
export function PreviewDialog() {
  const previewJob = useJobsUi((state) => state.previewJob)
  const setPreviewJob = useJobsUi((state) => state.setPreviewJob)
  const { doc, error } = usePdfDocument(
    previewJob?.downloadUrl ? `${previewJob.downloadUrl}?inline=1` : null
  )

  return (
    <Dialog open={previewJob !== null} onOpenChange={(open) => !open && setPreviewJob(null)}>
      {previewJob && (
        <DialogContent title={`核对结果 · ${previewJob.outputName ?? previewJob.jobId}`} className="w-[700px] max-w-[94vw]">
          <div className="scroll-slim -mx-1 max-h-[72vh] overflow-y-auto px-1">
            {error && <p className="py-10 text-center text-sm text-accent">{error}</p>}
            {!doc && !error && <p className="py-10 text-center text-sm text-ink-muted">正在加载预览…</p>}
            {doc && (
              <div className="flex flex-col items-center gap-4 py-2">
                {Array.from({ length: Math.min(doc.numPages, MAX_PREVIEW_PAGES) }, (_, i) => (
                  <PreviewPage key={i + 1} doc={doc} pageNumber={i + 1} />
                ))}
                {doc.numPages > MAX_PREVIEW_PAGES && (
                  <p className="text-xs text-ink-muted">仅预览前 {MAX_PREVIEW_PAGES} 页，完整内容请下载查看。</p>
                )}
              </div>
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setPreviewJob(null)}>关闭</Button>
            <Button variant="primary" onClick={() => window.open(previewJob.downloadUrl, '_self')}>
              <Download size={16} />
              下载 PDF
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}

function PreviewPage({ doc, pageNumber }: { doc: PDFDocumentProxy; pageNumber: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [inView, setInView] = useState(pageNumber <= 3)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setInView(true)
        }
      },
      { rootMargin: '500px 0px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !inView) return
    let cancelled = false
    doc
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled || !ref.current) return
        const base = page.getViewport({ scale: 1 })
        const scale = (PREVIEW_WIDTH / base.width) * Math.min(window.devicePixelRatio || 1, 2)
        const viewport = page.getViewport({ scale })
        const target = ref.current
        const context = target.getContext('2d')
        if (!context) return
        target.width = Math.round(viewport.width)
        target.height = Math.round(viewport.height)
        page.render({ canvas: target, canvasContext: context, viewport }).promise.catch(() => {})
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [doc, pageNumber, inView])

  return (
    <div ref={wrapRef} className="w-full" style={{ maxWidth: PREVIEW_WIDTH }}>
      <div className="overflow-hidden rounded border border-line bg-white shadow-sm">
        <canvas ref={ref} className="block h-auto w-full" />
      </div>
      <p className="tnum mt-1 text-center text-xs text-ink-muted">{pageNumber}</p>
    </div>
  )
}
