import { useEffect, useState } from 'react'
import { pdfjsLib, type PDFDocumentProxy } from '../../lib/pdfjs'
import { errorText } from '../../lib/api'

export function usePdfDocument(src: string | null) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setDoc(null)
    setError('')
    if (!src) return
    let cancelled = false
    const task = pdfjsLib.getDocument(src)
    task.promise
      .then((loaded) => {
        if (cancelled) {
          void loaded.destroy()
          return
        }
        setDoc(loaded)
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err))
      })
    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [src])

  return { doc, error }
}
