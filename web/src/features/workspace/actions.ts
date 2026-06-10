import { ApiError, deleteJSON, errorText, getJSON, postJSON, upload } from '../../lib/api'
import { clamp, type Job, type PDFFile, type StampAsset } from '../../lib/types'
import { activeFile, hasConfig, switchFile, useEditorStore } from '../../state/store'
import { toast } from '../../state/toasts'
import { prepareStamp } from '../stamps/importPipeline'
import { forgetStamp, generateStampId, persistStamp, rehydrateStamps } from '../stamps/persistence'
import { askImportTarget } from './importPrompt'
import { askPassword } from './passwordPrompt'

export function isPDFFile(file: File) {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

/** 可导入的图片（印章或页面均可；WebP 在前端转码为 PNG 再上传）。 */
export function isImportableImage(file: File) {
  const name = file.name.toLowerCase()
  return (
    ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
    /\.(png|jpe?g|webp)$/.test(name)
  )
}

function splitImportables(all: File[]) {
  const pdfs = all.filter(isPDFFile)
  const images = all.filter((f) => !isPDFFile(f) && isImportableImage(f))
  return { pdfs, images, ignored: all.length - pdfs.length - images.length }
}

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, '')
}

export async function refreshWorkspace() {
  try {
    const [files, stamps, jobs] = await Promise.all([
      getJSON<PDFFile[]>('/api/files'),
      getJSON<StampAsset[]>('/api/stamps'),
      getJSON<Job[]>('/api/jobs')
    ])
    useEditorStore.getState().setWorkspace(files ?? [], stamps ?? [], jobs ?? [])
  } catch (err) {
    toast(errorText(err), { kind: 'error' })
  }
}

let bootPromise: Promise<void> | null = null

/** 应用启动引导：拉取工作区 + 印章浏览器持久层重水化/迁移（StrictMode 双触发安全）。 */
export function bootstrapWorkspace(): Promise<void> {
  bootPromise ??= runBootstrap().catch((err) => {
    bootPromise = null
    toast(errorText(err), { kind: 'error' })
  })
  return bootPromise
}

async function runBootstrap() {
  const [files, stamps, jobs] = await Promise.all([
    getJSON<PDFFile[]>('/api/files'),
    getJSON<StampAsset[]>('/api/stamps'),
    getJSON<Job[]>('/api/jobs')
  ])
  const { stamps: merged, keepMetaIds, failed } = await rehydrateStamps(stamps ?? [])
  useEditorStore.getState().setWorkspace(files ?? [], merged, jobs ?? [])
  useEditorStore.getState().pruneStampMeta(keepMetaIds)
  if (failed > 0) {
    toast(`${failed} 个印章未能恢复，请检查网络后重试`, {
      kind: 'error',
      action: {
        label: '重试',
        onClick: () => {
          bootPromise = null
          void bootstrapWorkspace()
        }
      }
    })
  }
}

async function uploadOnePDF(file: File): Promise<PDFFile | null> {
  let password = ''
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await upload<PDFFile>('/api/files', file, file.name, password ? { password } : undefined)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'password_required') {
        const entered = await askPassword(file.name, attempt > 0)
        if (entered === null) {
          toast(`已跳过 ${file.name}`)
          return null
        }
        password = entered
        continue
      }
      toast(`${file.name}：${errorText(err)}`, { kind: 'error' })
      return null
    }
  }
  toast(`${file.name}：密码多次不正确，已跳过`, { kind: 'error' })
  return null
}

/** WebP 等非原生格式转码为 PNG，保证后端可解码为页面。 */
async function asUploadableImage(file: File): Promise<{ blob: Blob; name: string }> {
  if (file.type === 'image/png' || file.type === 'image/jpeg') return { blob: file, name: file.name }
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建画布')
    context.drawImage(bitmap, 0, 0)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('无法转码图片'))), 'image/png')
    })
    return { blob, name: `${baseName(file.name) || '图片'}.png` }
  } finally {
    bitmap.close()
  }
}

/** 上传单个 PDF / 图片为工作区文件（图片由后端转单页 PDF）；只上传，不动前端列表。 */
async function uploadOneAsset(file: File): Promise<PDFFile | null> {
  if (isPDFFile(file)) return uploadOnePDF(file)
  try {
    const image = await asUploadableImage(file)
    return await upload<PDFFile>('/api/files', image.blob, image.name)
  } catch (err) {
    toast(`${file.name}：${errorText(err)}`, { kind: 'error' })
    return null
  }
}

function toastIgnored(ignored: number) {
  if (ignored > 0) toast(`已忽略 ${ignored} 个不支持的文件（仅支持 PDF 与 PNG / JPG / WebP）`)
}

/**
 * 作为新项目导入：每个 PDF 单独成项目；多张图片按顺序合成一个新文档；
 * 完成后打开第一个新项目。
 */
export async function importAsNewProject(all: File[]) {
  const { pdfs, images, ignored } = splitImportables(all)
  if (pdfs.length === 0 && images.length === 0) {
    toast('请选择 PDF 文件或 PNG / JPG / WebP 图片。', { kind: 'error' })
    return
  }
  const total = pdfs.length + images.length
  useEditorStore.getState().setBusy(total > 1 ? `正在导入 ${total} 个文件…` : '正在导入…')
  const projects: PDFFile[] = []
  try {
    for (const file of pdfs) {
      const uploaded = await uploadOnePDF(file)
      if (uploaded) projects.push(uploaded)
    }
    if (images.length > 0) {
      const parts: PDFFile[] = []
      for (const file of images) {
        const uploaded = await uploadOneAsset(file)
        if (uploaded) parts.push(uploaded)
      }
      if (parts.length === 1) {
        projects.push(parts[0])
      } else if (parts.length > 1) {
        try {
          const composed = await postJSON<PDFFile>('/api/files/compose', {
            name: `${baseName(images[0].name) || '图片文档'}.pdf`,
            pages: parts.flatMap((part) => part.pages.map((p) => ({ fileId: part.fileId, pageNumber: p.pageNumber })))
          })
          projects.push(composed)
          for (const part of parts) void deleteJSON(`/api/files/${part.fileId}`).catch(() => {})
        } catch (err) {
          // 合并失败时保留为独立文件，内容不丢
          toast(`图片合并失败，已保留为独立文件：${errorText(err)}`, { kind: 'error' })
          projects.push(...parts)
        }
      }
    }
  } finally {
    useEditorStore.getState().setBusy('')
  }
  toastIgnored(ignored)
  if (projects.length === 0) return
  useEditorStore.getState().upsertFiles(projects)
  switchFile(projects[0].fileId)
  toast(
    projects.length > 1 ? `已导入 ${projects.length} 个项目，可在顶栏切换` : `已打开新项目 ${projects[0].name}`,
    { kind: 'success' }
  )
}

/**
 * 并入当前项目：新导入的 PDF / 图片页面追加到当前文件末尾。
 * fileId 不变，已有盖章配置原样保留；Toast 提供一键撤销（裁回原页数）。
 */
export async function importIntoCurrent(all: File[]) {
  const current = activeFile(useEditorStore.getState())
  if (!current) {
    await importAsNewProject(all)
    return
  }
  const { ignored } = splitImportables(all)
  const importables = all.filter((f) => isPDFFile(f) || isImportableImage(f))
  if (importables.length === 0) {
    toast('请选择 PDF 文件或 PNG / JPG / WebP 图片。', { kind: 'error' })
    return
  }
  useEditorStore.getState().setBusy(`正在并入 ${current.name}…`)
  const temps: PDFFile[] = []
  try {
    for (const file of importables) {
      const uploaded = await uploadOneAsset(file)
      if (uploaded) temps.push(uploaded)
    }
    if (temps.length === 0) return
    const prevPageCount = current.pageCount
    const pages = [
      ...current.pages.map((p) => ({ fileId: current.fileId, pageNumber: p.pageNumber })),
      ...temps.flatMap((t) => t.pages.map((p) => ({ fileId: t.fileId, pageNumber: p.pageNumber })))
    ]
    const updated = await postJSON<PDFFile>(`/api/files/${current.fileId}/rewrite`, { pages })
    useEditorStore.getState().replaceFile(updated)
    toast(`已并入 ${updated.pageCount - prevPageCount} 页到 ${updated.name}`, {
      kind: 'success',
      action: { label: '撤销并入', onClick: () => void undoMerge(current.fileId, prevPageCount) }
    })
  } catch (err) {
    toast(errorText(err), { kind: 'error' })
  } finally {
    useEditorStore.getState().setBusy('')
    for (const temp of temps) void deleteJSON(`/api/files/${temp.fileId}`).catch(() => {})
  }
  toastIgnored(ignored)
}

/** 撤销并入：把文件原地裁回并入前的页数。 */
async function undoMerge(fileId: string, pageCount: number) {
  try {
    const pages = Array.from({ length: pageCount }, (_, i) => ({ fileId, pageNumber: i + 1 }))
    const updated = await postJSON<PDFFile>(`/api/files/${fileId}/rewrite`, { pages })
    useEditorStore.getState().replaceFile(updated)
    toast('已撤销并入', { kind: 'success' })
  } catch (err) {
    toast(errorText(err), { kind: 'error' })
  }
}

/** 文件选择器导入入口：已有打开的项目时询问去向，否则直接作为新项目。 */
export async function importPicked(all: File[]) {
  const current = activeFile(useEditorStore.getState())
  if (!current) {
    await importAsNewProject(all)
    return
  }
  const target = await askImportTarget(all.length, current.name)
  if (target === null) return
  if (target === 'current') await importIntoCurrent(all)
  else await importAsNewProject(all)
}

export async function uploadStamps(files: File[]) {
  const state = useEditorStore.getState()
  state.setBusy(files.length > 1 ? `正在导入 ${files.length} 个印章…` : '正在导入印章…')
  const uploaded: StampAsset[] = []
  const whitened: Array<{ asset: StampAsset; original: File }> = []
  try {
    for (const file of files) {
      try {
        const prepared = await prepareStamp(file)
        const asset = await upload<StampAsset>('/api/stamps', prepared.blob, prepared.name, {
          stampId: generateStampId()
        })
        uploaded.push(asset)
        void persistStamp(asset, prepared.blob)
        if (prepared.whitened) whitened.push({ asset, original: file })
      } catch (err) {
        toast(`${file.name}：${errorText(err)}`, { kind: 'error' })
      }
    }
  } finally {
    useEditorStore.getState().setBusy('')
  }
  if (uploaded.length === 0) return
  useEditorStore.getState().upsertStamps(uploaded)
  if (whitened.length > 0) {
    toast(`已导入 ${uploaded.length} 个印章 · 自动去除了白底`, {
      kind: 'success',
      action: { label: '撤销去底', onClick: () => void revertWhiten(whitened) }
    })
  } else {
    toast(`已导入 ${uploaded.length} 个印章`, { kind: 'success' })
  }
}

async function revertWhiten(items: Array<{ asset: StampAsset; original: File }>) {
  for (const { asset, original } of items) {
    try {
      const prepared = await prepareStamp(original, { whiten: false })
      const fresh = await upload<StampAsset>('/api/stamps', prepared.blob, prepared.name, {
        stampId: generateStampId()
      })
      void persistStamp(fresh, prepared.blob)
      useEditorStore.getState().upsertStamps([fresh])
      useEditorStore.getState().swapStamp(asset.stampId, fresh.stampId)
      await deleteJSON(`/api/stamps/${asset.stampId}`)
      void forgetStamp(asset.stampId)
    } catch (err) {
      toast(`恢复 ${original.name} 失败：${errorText(err)}`, { kind: 'error' })
      return
    }
  }
  toast('已恢复为原图', { kind: 'success' })
}

export async function deleteFileAction(file: PDFFile) {
  try {
    await deleteJSON(`/api/files/${file.fileId}`)
    useEditorStore.getState().removeFile(file.fileId)
    toast(`已删除 ${file.name}`)
  } catch (err) {
    toast(errorText(err), { kind: 'error' })
  }
}

export async function deleteStampAction(stamp: StampAsset) {
  try {
    await deleteJSON(`/api/stamps/${stamp.stampId}`)
    void forgetStamp(stamp.stampId)
    useEditorStore.getState().removeStamp(stamp.stampId)
    toast(`已删除印章 ${stamp.name}`)
  } catch (err) {
    toast(errorText(err), { kind: 'error' })
  }
}

export async function deleteJobAction(job: Job) {
  try {
    await deleteJSON(`/api/jobs/${job.jobId}`)
    useEditorStore.getState().removeJob(job.jobId)
  } catch (err) {
    toast(errorText(err), { kind: 'error' })
  }
}

/** 把当前文件的盖章配置复制到队列中其余所有文件（按页码对应，超出页数的跳过）。 */
export function applyConfigToAllFiles() {
  const state = useEditorStore.getState()
  const current = activeFile(state)
  const source = current ? state.configs[current.fileId] : undefined
  if (!current || !source || !hasConfig(source)) {
    toast('当前文件还没有配置印章。', { kind: 'error' })
    return
  }
  let applied = 0
  for (const target of state.files) {
    if (target.fileId === current.fileId) continue
    const placements = source.placements.flatMap((placement) => {
      const pageInfo = target.pages.find((p) => p.pageNumber === placement.pageNumber)
      if (!pageInfo) return []
      return [
        {
          ...placement,
          id: crypto.randomUUID(),
          sourceId: undefined,
          xPt: clamp(placement.xPt, 0, Math.max(0, pageInfo.widthPt - placement.widthPt)),
          yPt: clamp(placement.yPt, 0, Math.max(0, pageInfo.heightPt - placement.heightPt))
        }
      ]
    })
    useEditorStore.getState().setConfig(target.fileId, {
      placements,
      seamEnabled: source.seamEnabled,
      seam: { ...source.seam }
    })
    applied++
  }
  if (applied === 0) {
    toast('队列中没有其他文件。', { kind: 'error' })
    return
  }
  toast(`已把当前配置应用到另外 ${applied} 个文件 · 生成全部即可批量出件`, { kind: 'success' })
}
