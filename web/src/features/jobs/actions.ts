import { ApiError, errorText, postJSON } from '../../lib/api'
import { normalizePageExpr, parsePageExpression } from '../../lib/pages'
import type { Job, PDFFile } from '../../lib/types'
import { activeFile, configuredFiles, useEditorStore, type EditorState } from '../../state/store'
import { toast } from '../../state/toasts'
import { useJobsUi } from './jobsUi'

export function generationStatus(state: EditorState): { ok: boolean; hint: string } {
  const file = activeFile(state)
  if (!file) return { ok: false, hint: '请先导入 PDF' }
  if (state.stamps.length === 0) return { ok: false, hint: '请先导入印章图片' }
  const config = state.configs[file.fileId]
  const hasPlacements = (config?.placements.length ?? 0) > 0
  const seamOn = Boolean(config?.seamEnabled)
  if (!hasPlacements && !seamOn) return { ok: false, hint: '先把印章拖到页面上，或启用骑缝章' }
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
  const template = state.outputNameTemplate.trim() || '{原名}-已盖章'
  const name = template.replaceAll('{原名}', base)
  return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`
}

export async function createJobForFile(fileId: string): Promise<Job | null> {
  const state = useEditorStore.getState()
  const file = state.files.find((f) => f.fileId === fileId)
  const config = state.configs[fileId]
  if (!file || !config) return null
  const placements = config.placements.map(({ id: _id, sourceId: _sourceId, ...rest }) => rest)
  const seamSeals =
    config.seamEnabled && config.seam.stampId
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
  const job = await postJSON<Job>('/api/jobs', {
    fileId,
    placements,
    seamSeals,
    outputPassword: state.outputPassword,
    outputName: outputNameFor(state, file)
  })
  useEditorStore.getState().upsertJob(job)
  useJobsUi.getState().markSession(job.jobId)
  return job
}

export async function generateCurrent() {
  const state = useEditorStore.getState()
  const status = generationStatus(state)
  if (!status.ok || !state.activeFileId) {
    toast(status.hint, { kind: 'error' })
    return
  }
  try {
    await createJobForFile(state.activeFileId)
  } catch (err) {
    toast(errorText(err), { kind: 'error' })
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** 顺序提交所有已配置文件；任务槽满（429）时客户端自动排队重试。 */
export async function generateAll() {
  const state = useEditorStore.getState()
  const files = configuredFiles(state)
  if (files.length === 0) {
    toast('还没有任何文件配置了印章。', { kind: 'error' })
    return
  }
  useJobsUi.getState().setBatch({ total: files.length, submitted: 0 })
  let failed = 0
  for (const file of files) {
    let created = false
    for (let attempt = 0; attempt < 120 && !created; attempt++) {
      try {
        await createJobForFile(file.fileId)
        created = true
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) {
          await sleep(1200)
          continue
        }
        toast(`${file.name}：${errorText(err)}`, { kind: 'error' })
        failed++
        break
      }
    }
    if (!created && failed === 0) {
      toast(`${file.name}：排队超时，已跳过`, { kind: 'error' })
      failed++
    }
    useJobsUi.getState().bumpBatch()
  }
  useJobsUi.getState().setBatch(null)
  if (failed === 0) toast(`已提交 ${files.length} 个生成任务`, { kind: 'success' })
}

export async function retryJob(job: Job) {
  useJobsUi.getState().dismiss(job.jobId)
  try {
    await createJobForFile(job.fileId)
  } catch (err) {
    toast(errorText(err), { kind: 'error' })
  }
}
