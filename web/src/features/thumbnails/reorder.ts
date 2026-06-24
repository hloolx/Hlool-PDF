import { errorText } from '../../lib/api'
import type { FileConfig, PDFFile } from '../../lib/types'
import { emptyConfig } from '../../lib/types'
import { normalizePageExpr, pagesToExpression, parsePageExpression } from '../../lib/pages'
import { switchFile, useEditorStore } from '../../state/store'
import { toast } from '../../state/toasts'
import { composePdf, rebuildFile, type ComposePageRef } from '../workspace/actions'
import { rotatePlacementOnPage } from '../placements/actions'

/** 一个输出页：来自当前文件的 src 旧页码，按 rotate（顺时针度数，0/90/180/270）旋转。 */
export type OutPage = { src: number; rotate?: number }

/** 把显式页码表达式按 old→new 重映射；不在 mapTo 中的页（被删除）丢弃；“全部 / all”原样保留。 */
function remapExpression(expr: string, mapTo: Map<number, number>, newPageCount: number): string {
  if (normalizePageExpr(expr) === 'all') return expr
  const parsed = parsePageExpression(expr, Number.MAX_SAFE_INTEGER)
  const mapped = parsed.pages.flatMap((page) => {
    const next = mapTo.get(page)
    return next ? [next] : []
  })
  // 空串会被 normalizePageExpr 视作“全部”，正是范围被删空后的合理回退。
  return pagesToExpression(mapped, newPageCount)
}

type Snapshot = {
  file: PDFFile
  config: FileConfig | undefined
  rangeText: string
  currentPage: number
  wasActive: boolean
}

/**
 * 按一组输出页就地重建当前文件（重排 / 删除 / 旋转的统一底座）：用服务端无状态
 * 合成生成新字节并原位替换（fileId 不变），所有跟随旧页码的状态迁移到新页码——
 * 印章 placements（旋转页上的随纸张一起变换坐标）、骑缝章页面范围、目标页范围、当前页码。
 * 返回是否成功及一个 restore（把文件与配置还原到操作前，供“撤销”用）。
 */
async function recompose(
  file: PDFFile,
  outPages: OutPage[],
  busy: string
): Promise<{ ok: boolean; restore: () => void }> {
  const before = useEditorStore.getState()
  const snapshot: Snapshot = {
    file,
    config: before.configs[file.fileId],
    rangeText: before.rangeText,
    currentPage: before.currentPage,
    wasActive: before.activeFileId === file.fileId
  }
  const restore = () => {
    const state = useEditorStore.getState()
    state.replaceFile(snapshot.file)
    state.setConfig(snapshot.file.fileId, snapshot.config ?? emptyConfig())
    if (snapshot.wasActive) {
      state.setRangeText(snapshot.rangeText)
      state.setCurrentPage(Math.min(snapshot.currentPage, snapshot.file.pageCount))
    }
    useEditorStore.temporal.getState().clear()
    toast(`已撤销 · ${snapshot.file.name}`)
  }

  useEditorStore.getState().setBusy(busy)
  try {
    const refs: ComposePageRef[] = outPages.map((o) => ({ file: 0, pageNumber: o.src, rotate: o.rotate ?? 0 }))
    const composed = await composePdf([file.blob], refs, file.name, file.password)
    const updated = await rebuildFile(file.fileId, file.name, composed)

    const newCount = outPages.length
    const mapTo = new Map<number, number>()
    const rotateOf = new Map<number, number>()
    outPages.forEach((o, index) => {
      mapTo.set(o.src, index + 1)
      const r = ((o.rotate ?? 0) % 360 + 360) % 360
      if (r !== 0) rotateOf.set(o.src, r)
    })
    const oldPageByNumber = new Map(file.pages.map((p) => [p.pageNumber, p]))

    const state = useEditorStore.getState()
    const config = state.configs[file.fileId]
    if (config) {
      state.setConfig(file.fileId, {
        ...config,
        placements: config.placements.flatMap((placement) => {
          const newPage = mapTo.get(placement.pageNumber)
          if (!newPage) return [] // 该页被删除：丢弃其上的印章
          const deg = rotateOf.get(placement.pageNumber)
          const oldPage = deg ? oldPageByNumber.get(placement.pageNumber) : undefined
          const moved = deg && oldPage ? rotatePlacementOnPage(placement, oldPage, deg) : placement
          return [{ ...moved, pageNumber: newPage }]
        }),
        seam: { ...config.seam, pages: remapExpression(config.seam.pages, mapTo, newCount) }
      })
    }
    if (snapshot.wasActive) {
      state.setRangeText(remapExpression(state.rangeText, mapTo, newCount))
      const mappedCurrent = mapTo.get(state.currentPage)
      state.replaceFile(updated)
      state.setCurrentPage(mappedCurrent ?? Math.min(state.currentPage, updated.pageCount))
    } else {
      state.replaceFile(updated)
    }
    useEditorStore.temporal.getState().clear()
    return { ok: true, restore }
  } catch (err) {
    toast(errorText(err), { kind: 'error' })
    return { ok: false, restore }
  } finally {
    useEditorStore.getState().setBusy('')
  }
}

/** 按新顺序重排当前文件（order 为按显示顺序排列的旧页码）。用于缩略图拖拽，无提示。 */
export async function reorderPages(file: PDFFile, order: number[]): Promise<boolean> {
  const { ok } = await recompose(file, order.map((src) => ({ src })), '正在调整页序…')
  return ok
}

/**
 * 删除当前文件的一页。删到只剩它一页时，整份文件移出工作区（等于文件级删除）；
 * 否则就地重排去掉该页。两者都给“撤销”提示。
 */
export async function deletePage(file: PDFFile, pageNumber: number): Promise<void> {
  if (file.pageCount <= 1) {
    const state = useEditorStore.getState()
    const wasActive = state.activeFileId === file.fileId
    const prevConfig = state.configs[file.fileId]
    state.removeFile(file.fileId)
    toast(`已移除 ${file.name}`, {
      action: {
        label: '撤销',
        onClick: () => {
          const s = useEditorStore.getState()
          s.upsertFiles([file])
          if (prevConfig) s.setConfig(file.fileId, prevConfig)
          if (wasActive) switchFile(file.fileId)
        }
      }
    })
    return
  }
  const order = file.pages.map((p) => p.pageNumber).filter((p) => p !== pageNumber)
  const { ok, restore } = await recompose(file, order.map((src) => ({ src })), '正在删除页面…')
  if (ok) toast(`已删除第 ${pageNumber} 页`, { action: { label: '撤销', onClick: restore } })
}

/** 一次性删除当前文件的多页。批量场景必须一次 recompose，避免页码连续重映射。 */
export async function deletePages(file: PDFFile, pageNumbers: number[]): Promise<void> {
  const selected = new Set(pageNumbers.filter((page) => page >= 1 && page <= file.pageCount))
  if (selected.size === 0) return
  if (selected.size >= file.pageCount) {
    const state = useEditorStore.getState()
    const wasActive = state.activeFileId === file.fileId
    const prevConfig = state.configs[file.fileId]
    state.removeFile(file.fileId)
    toast(`已移除 ${file.name}`, {
      action: {
        label: '撤销',
        onClick: () => {
          const s = useEditorStore.getState()
          s.upsertFiles([file])
          if (prevConfig) s.setConfig(file.fileId, prevConfig)
          if (wasActive) switchFile(file.fileId)
        }
      }
    })
    return
  }
  const order = file.pages.map((p) => p.pageNumber).filter((page) => !selected.has(page))
  const { ok, restore } = await recompose(file, order.map((src) => ({ src })), `正在删除 ${selected.size} 页…`)
  if (ok) toast(`已删除 ${selected.size} 页`, { action: { label: '撤销', onClick: restore } })
}

/** 把当前文件的某一页顺时针旋转 deg（90 的倍数，可为负），其余页保持不变。 */
export async function rotatePage(file: PDFFile, pageNumber: number, deg: number): Promise<void> {
  const order: OutPage[] = file.pages.map((p) => ({
    src: p.pageNumber,
    rotate: p.pageNumber === pageNumber ? deg : 0
  }))
  await recompose(file, order, '正在旋转页面…')
}
