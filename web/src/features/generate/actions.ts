import { ApiError, errorText, postFormBlob } from '../../lib/api'
import { downloadBlob } from '../../lib/download'
import { normalizePageExpr, parsePageExpression } from '../../lib/pages'
import type { PDFFile } from '../../lib/types'
import { activeFile, configuredFiles, hasConfig, useEditorStore, type EditorState } from '../../state/store'
import { toast } from '../../state/toasts'
import { requireReauth } from '../auth/useAuth'

export function generationStatus(state: EditorState): { ok: boolean; hint: string } {
  const file = activeFile(state)
  if (!file) return { ok: false, hint: '请先导入 PDF' }
  const config = state.configs[file.fileId]
  const hasPlacements = (config?.placements.length ?? 0) > 0
  const seamOn = Boolean(config?.seamEnabled)
  // 没有任何印章：直接导出 / 拼接当前 PDF（仍可改名、加密）。
  if (!hasPlacements && !seamOn) {
    return { ok: true, hint: '导出 PDF（未盖章），原文件不受影响' }
  }
  if (config?.seamEnabled) {
    if (!config.seam.stampId) return { ok: false, hint: '骑缝章还未选择印章图片' }
    const expr = parsePageExpression(config.seam.pages, file.pageCount)
    if (expr.invalidParts.length > 0) return { ok: false, hint: `骑缝章页范围无效：${expr.invalidParts.join('、')}` }
    if (expr.pages.length < 2) return { ok: false, hint: '骑缝章至少需要 2 页' }
  }
  return { ok: true, hint: '生成新的 PDF，原文件不受影响' }
}

export function outputNameFor(state: EditorState, file: PDFFile) {
  const base = file.name.replace(/\.pdf$/i, '')
  // 未盖任何章时按原名导出，避免“-已盖章”后缀误导。
  if (!hasConfig(state.configs[file.fileId])) return `${base}.pdf`
  const template = state.outputNameTemplate.trim() || '{原名}-已盖章'
  const name = template.replaceAll('{原名}', base)
  return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`
}

function buildParams(state: EditorState, file: PDFFile) {
  const config = state.configs[file.fileId]
  const placements = (config?.placements ?? []).map(({ id: _id, sourceId: _sourceId, ...rest }) => rest)
  const seamSeals =
    config?.seamEnabled && config.seam.stampId
      ? [
          {
            stampId: config.seam.stampId,
            pages: normalizePageExpr(config.seam.pages),
            side: config.seam.side,
            sizePt: config.seam.sizePt,
            positionPercent: config.seam.positionPercent,
            marginPt: config.seam.marginPt,
            opacity: config.seam.opacity,
            maxSlices: config.seam.maxSlices,
            randomSeed: config.seam.randomSeed
          }
        ]
      : []
  return {
    placements,
    seamSeals,
    outputPassword: state.outputPassword,
    outputName: outputNameFor(state, file)
  }
}

/** 同步加工：把源 PDF + 参数发到 /api/process，拿回成品并触发下载。 */
export async function processFile(file: PDFFile): Promise<void> {
  const state = useEditorStore.getState()
  const params = buildParams(state, file)
  const form = new FormData()
  form.append('file', file.blob, file.name)
  form.append('params', JSON.stringify(params))
  if (file.password) form.append('password', file.password)
  const blob = await postFormBlob('/api/process', form)
  downloadBlob(blob, params.outputName)
}

export async function generateCurrent() {
  const state = useEditorStore.getState()
  const status = generationStatus(state)
  const file = activeFile(state)
  if (!status.ok || !file) {
    toast(status.hint, { kind: 'error' })
    return
  }
  useEditorStore.getState().setBusy('正在生成…')
  try {
    await processFile(file)
    toast('已生成，开始下载', { kind: 'success' })
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) requireReauth()
    else toast(errorText(err), { kind: 'error' })
  } finally {
    useEditorStore.getState().setBusy('')
  }
}

/** 批量：逐个文件调用 /api/process 并下载。 */
export async function generateAll() {
  const files = configuredFiles(useEditorStore.getState())
  if (files.length === 0) {
    toast('还没有任何文件配置了印章。', { kind: 'error' })
    return
  }
  let done = 0
  let failed = 0
  for (const file of files) {
    useEditorStore.getState().setBusy(`正在生成 ${done + failed + 1}/${files.length}…`)
    try {
      await processFile(file)
      done++
    } catch (err) {
      failed++
      if (err instanceof ApiError && err.status === 401) {
        requireReauth()
        break
      }
      toast(`${file.name}：${errorText(err)}`, { kind: 'error' })
    }
  }
  useEditorStore.getState().setBusy('')
  if (failed === 0) toast(`已生成 ${done} 个文件`, { kind: 'success' })
}
