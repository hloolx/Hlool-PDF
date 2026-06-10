import { errorText, postJSON } from '../../lib/api'
import type { PDFFile } from '../../lib/types'
import { normalizePageExpr, pagesToExpression, parsePageExpression } from '../../lib/pages'
import { useEditorStore } from '../../state/store'
import { toast } from '../../state/toasts'

/** 把显式页码表达式按 old→new 重映射；“全部 / all”原样保留。 */
function remapExpression(expr: string, mapTo: Map<number, number>, pageCount: number): string {
  if (normalizePageExpr(expr) === 'all') return expr
  const parsed = parsePageExpression(expr, pageCount)
  if (parsed.pages.length === 0) return expr
  const mapped = parsed.pages.map((page) => mapTo.get(page) ?? page)
  return pagesToExpression(mapped, pageCount) || expr
}

/**
 * 按新顺序原地重写当前文件（order 为按显示顺序排列的旧页码），
 * 并把所有跟随旧页码的状态迁移到新页码：印章 placements、骑缝章页面范围、
 * 目标页范围、当前页码 —— 印章始终跟着页面内容走。
 * 成功后清空撤销栈：页序已写入服务端，仅回退前端配置会与内容错位。
 */
export async function reorderPages(file: PDFFile, order: number[]): Promise<boolean> {
  useEditorStore.getState().setBusy('正在调整页序…')
  try {
    const updated = await postJSON<PDFFile>(`/api/files/${file.fileId}/rewrite`, {
      pages: order.map((pageNumber) => ({ fileId: file.fileId, pageNumber }))
    })
    const mapTo = new Map<number, number>()
    order.forEach((oldPage, index) => mapTo.set(oldPage, index + 1))

    const state = useEditorStore.getState()
    const config = state.configs[file.fileId]
    if (config) {
      state.setConfig(file.fileId, {
        ...config,
        placements: config.placements.map((placement) => ({
          ...placement,
          pageNumber: mapTo.get(placement.pageNumber) ?? placement.pageNumber
        })),
        seam: { ...config.seam, pages: remapExpression(config.seam.pages, mapTo, file.pageCount) }
      })
    }
    if (state.activeFileId === file.fileId) {
      state.setRangeText(remapExpression(state.rangeText, mapTo, file.pageCount))
      const mappedCurrent = mapTo.get(state.currentPage)
      state.replaceFile(updated)
      state.setCurrentPage(mappedCurrent ?? Math.min(state.currentPage, updated.pageCount))
    } else {
      state.replaceFile(updated)
    }
    useEditorStore.temporal.getState().clear()
    return true
  } catch (err) {
    toast(errorText(err), { kind: 'error' })
    return false
  } finally {
    useEditorStore.getState().setBusy('')
  }
}
