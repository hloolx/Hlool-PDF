import { useEffect, useRef, useState } from 'react'
import { pdfjsLib, type PDFDocumentProxy } from '../../lib/pdfjs'

type LoadingTask = ReturnType<typeof pdfjsLib.getDocument>

/**
 * 整理器内的多文档缓存：按需加载，组件卸载时统一销毁。
 * 任务以 `fileId@rev` 为键 —— 文件被原地并入（rev 递增）后旧任务作废、自动重载。
 */
export function useDocs(fileIds: string[], revs: Record<string, number> = {}): Map<string, PDFDocumentProxy> {
  const [docs, setDocs] = useState<Map<string, PDFDocumentProxy>>(() => new Map())
  const tasks = useRef(new Map<string, LoadingTask>())
  const keys = [...fileIds].sort().map((id) => `${id}@${revs[id] ?? 0}`)
  const keysJoined = keys.join(',')

  useEffect(() => {
    for (const key of keysJoined.split(',')) {
      const id = key.split('@')[0]
      if (!id || tasks.current.has(key)) continue
      for (const [staleKey, staleTask] of tasks.current) {
        if (staleKey.startsWith(`${id}@`)) {
          void staleTask.destroy()
          tasks.current.delete(staleKey)
        }
      }
      const rev = Number(key.split('@')[1]) || 0
      const task = pdfjsLib.getDocument(`/api/files/${id}/content${rev > 0 ? `?v=${rev}` : ''}`)
      tasks.current.set(key, task)
      task.promise
        .then((doc) => {
          if (!tasks.current.has(key)) {
            void doc.destroy()
            return
          }
          setDocs((prev) => new Map(prev).set(id, doc))
        })
        .catch(() => {})
    }
  }, [keysJoined])

  useEffect(() => {
    const current = tasks.current
    return () => {
      for (const task of current.values()) void task.destroy()
      current.clear()
    }
  }, [])

  return docs
}
