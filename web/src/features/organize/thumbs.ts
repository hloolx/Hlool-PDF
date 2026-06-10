import { useEffect, useState } from 'react'
import type { PDFDocumentProxy } from '../../lib/pdfjs'

const cache = new Map<string, string>()
const pending = new Map<string, Promise<string>>()

function renderThumb(doc: PDFDocumentProxy, pageNumber: number): Promise<string> {
  return doc.getPage(pageNumber).then((page) => {
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: 256 / base.width })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建画布')
    return page.render({ canvas, canvasContext: context, viewport }).promise.then(
      () =>
        new Promise<string>((resolve, reject) => {
          canvas.toBlob(
            (blob) => (blob ? resolve(URL.createObjectURL(blob)) : reject(new Error('无法导出缩略图'))),
            'image/jpeg',
            0.82
          )
        })
    )
  })
}

/** 整理器页面卡缩略图：渲染一次后整个会话复用（拖动重排零渲染开销）。 */
export function useOrgThumb(doc: PDFDocumentProxy | undefined, fileId: string, pageNumber: number): string | null {
  const key = `${fileId}:${pageNumber}`
  const [url, setUrl] = useState<string | null>(() => cache.get(key) ?? null)

  useEffect(() => {
    if (cache.has(key)) {
      setUrl(cache.get(key)!)
      return
    }
    if (!doc) return
    let cancelled = false
    let task = pending.get(key)
    if (!task) {
      task = renderThumb(doc, pageNumber).then((result) => {
        cache.set(key, result)
        pending.delete(key)
        return result
      })
      pending.set(key, task)
    }
    task
      .then((result) => {
        if (!cancelled) setUrl(result)
      })
      .catch(() => pending.delete(key))
    return () => {
      cancelled = true
    }
  }, [doc, key, pageNumber])

  return url
}
