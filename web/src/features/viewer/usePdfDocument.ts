import { useEffect, useState } from 'react'
import { loadPdf, type PDFDocumentProxy } from '../../lib/pdfjs'
import { errorText } from '../../lib/errors'

/** 从浏览器内存里的 PDF 字节渲染（阅后即焚：不再走服务端文件地址）。 */
export function usePdfDocument(blob: Blob | null, password?: string) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setDoc(null)
    setError('')
    if (!blob) return
    let cancelled = false
    let loading: ReturnType<typeof loadPdf> | undefined
    blob
      .arrayBuffer()
      .then((data) => {
        if (cancelled) return
        loading = loadPdf(data, password)
        return loading.promise.then((d) => { if (!cancelled) setDoc(d) })
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err))
        if (loading) void loading.destroy().catch(() => {})
      })
    return () => {
      cancelled = true
      if (loading) void loading.destroy().catch(() => {})
    }
  }, [blob, password])

  return { doc, error }
}
