import { useEffect, useState } from 'react'
import { pdfjsLib, type PDFDocumentProxy } from '../../lib/pdfjs'
import { errorText } from '../../lib/api'

/** 从浏览器内存里的 PDF 字节渲染（阅后即焚：不再走服务端文件地址）。 */
export function usePdfDocument(blob: Blob | null, password?: string) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setDoc(null)
    setError('')
    if (!blob) return
    let cancelled = false
    let loaded: PDFDocumentProxy | null = null
    blob
      .arrayBuffer()
      .then((data) => {
        if (cancelled) return
        return pdfjsLib
          .getDocument({ data, password })
          .promise.then((d) => {
            if (cancelled) {
              void d.destroy()
              return
            }
            loaded = d
            setDoc(d)
          })
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err))
      })
    return () => {
      cancelled = true
      if (loaded) void loaded.destroy()
    }
  }, [blob, password])

  return { doc, error }
}
