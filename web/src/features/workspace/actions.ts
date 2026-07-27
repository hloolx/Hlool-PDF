import { ApiError, deleteJSON, errorText, postFormBlob, upload } from '../../lib/api'
import { fileFingerprint } from '../../lib/fingerprint'
import { ensurePdfName, isPasswordException, makePdfFile, readPdfPages } from '../../lib/pdfDoc'
import { clamp, type PDFFile, type StampAsset } from '../../lib/types'
import { activeFile, hasConfig, switchFile, useEditorStore, withinLocalLimit } from '../../state/store'
import { toast } from '../../state/toasts'
import { prepareStamp } from '../stamps/importPipeline'
import { generateStampId } from '../stamps/persistence'
import { requireReauth } from '../auth/useAuth'
import { restoreConfigs } from './configVault'
import { askImportTarget } from './importPrompt'
import { askPassword } from './passwordPrompt'

export function isPDFFile(file: File) {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

/** 可导入的图片（印章或页面均可；WebP 在前端转码为 PNG 再上传）。 */
export function isImportableImage(file: File) {
  const name = file.name.toLowerCase()
  return ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || /\.(png|jpe?g|webp)$/.test(name)
}

function splitImportables(all: File[]) {
  const pdfs = all.filter(isPDFFile)
  const images = all.filter((f) => !isPDFFile(f) && isImportableImage(f))
  return { pdfs, images, ignored: all.length - pdfs.length - images.length }
}

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, '')
}

function toastIgnored(ignored: number) {
  if (ignored > 0) toast(`已忽略 ${ignored} 个不支持的文件（仅支持 PDF 与 PNG / JPG / WebP）`)
}

/* ---------------- stateless PDF ops (服务端无状态合成) ---------------- */

/** 一个输出页引用：来自第 file 个上传文件的 pageNumber 页，可选 rotate（顺时针度数，90 的倍数）。 */
export type ComposePageRef = { file: number; pageNumber: number; rotate?: number }

/**
 * 合并/重排/旋转：把多个源 PDF 的页按给定顺序拼成一个新 PDF（每页可带 90° 旋转，
 * 旋转烘进页面几何），返回字节。password 用于解密受保护的源（产物为明文）。
 * 本地优先：localCompose 引擎在浏览器完成（文件不上传），任何异常静默回退云端
 * /api/compose（行为与本地化前一致）。
 */
export async function composePdf(
  blobs: Blob[],
  pages: ComposePageRef[],
  name: string,
  password?: string
): Promise<Blob> {
  const state = useEditorStore.getState()
  const totalBytes = blobs.reduce((sum, blob) => sum + blob.size, 0)
  if (state.preferLocalProcessing && withinLocalLimit(state, totalBytes)) {
    try {
      const { composePdfLocally } = await import('../generate/localCompose')
      const bytes = await composePdfLocally(blobs, pages, password)
      return new Blob([bytes as BlobPart], { type: 'application/pdf' })
    } catch (err) {
      console.warn('[local-compose] 回退云端：', err)
    }
  }
  const form = new FormData()
  blobs.forEach((blob, i) => form.append('file', blob, `src_${i}.pdf`))
  form.append('params', JSON.stringify({ name, pages }))
  if (password) form.append('password', password)
  return postFormBlob('/api/compose', form)
}

/** 图片 → 单页 PDF（A4 等比居中）。本地优先，异常静默回退云端 /api/image-to-pdf。 */
async function imageToPdf(blob: Blob, name: string): Promise<Blob> {
  const state = useEditorStore.getState()
  if (state.preferLocalProcessing && withinLocalLimit(state, blob.size)) {
    try {
      const { imageToPdfLocally } = await import('../generate/localCompose')
      const bytes = await imageToPdfLocally(blob)
      return new Blob([bytes as BlobPart], { type: 'application/pdf' })
    } catch (err) {
      console.warn('[local-image-to-pdf] 回退云端：', err)
    }
  }
  const form = new FormData()
  form.append('file', blob, name)
  return postFormBlob('/api/image-to-pdf', form)
}

/** 用新字节重建文件但保留 fileId（合并/重排后配置得以延续）。 */
export async function rebuildFile(fileId: string, name: string, blob: Blob, password?: string): Promise<PDFFile> {
  const pages = await readPdfPages(blob, password)
  const normalizedName = ensurePdfName(name)
  const fingerprint = await fileFingerprint(normalizedName, blob).catch(() => undefined)
  return {
    fileId,
    name: normalizedName,
    size: blob.size,
    pageCount: pages.length,
    pages,
    createdAt: new Date().toISOString(),
    blob,
    password,
    fingerprint
  }
}

/* ---------------- import ---------------- */

/** WebP 等非原生格式转码为 PNG，保证后端可解码。 */
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

/** 把一个 PDF 文件读入内存为工作区文件，按需索要打开密码。 */
async function loadPdfFromFile(file: File): Promise<PDFFile | null> {
  let password: string | undefined
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await makePdfFile(file, file.name, password)
    } catch (err) {
      if (isPasswordException(err)) {
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

/** 图片 → 单页 PDF（服务端用 pdfcpu 转换），读入内存为工作区文件。 */
async function imageFileToPdf(file: File): Promise<PDFFile | null> {
  try {
    const image = await asUploadableImage(file)
    const pdf = await imageToPdf(image.blob, image.name)
    return await makePdfFile(pdf, `${baseName(file.name) || '图片文档'}.pdf`)
  } catch (err) {
    toast(`${file.name}：${errorText(err)}`, { kind: 'error' })
    return null
  }
}

/** 启动引导：见 ./boot（独立成模块以便从入口包剥离 pdfjs）。 */
export { bootWorkspace } from './boot'

/** 作为新项目导入：每个 PDF 单独成项目；多张图片按顺序合成一个新文档。 */
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
      const loaded = await loadPdfFromFile(file)
      if (loaded) projects.push(loaded)
    }
    if (images.length > 0) {
      const parts: PDFFile[] = []
      for (const file of images) {
        const part = await imageFileToPdf(file)
        if (part) parts.push(part)
      }
      if (parts.length === 1) {
        projects.push(parts[0])
      } else if (parts.length > 1) {
        try {
          const name = `${baseName(images[0].name) || '图片文档'}.pdf`
          const blobs = parts.map((p) => p.blob)
          const pages = parts.flatMap((p, idx) => p.pages.map((pg) => ({ file: idx, pageNumber: pg.pageNumber })))
          const composed = await composePdf(blobs, pages, name)
          projects.push(await makePdfFile(composed, name))
        } catch (err) {
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
  // 同一文件重新导入时找回上次的盖章配置（配置防丢，切完文件再恢复以便可撤销）。
  restoreConfigs(projects)
}

/** 并入当前项目：新导入的页面追加到当前文件末尾，fileId 不变，配置保留。 */
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
  try {
    const added: PDFFile[] = []
    for (const file of importables) {
      const loaded = isPDFFile(file) ? await loadPdfFromFile(file) : await imageFileToPdf(file)
      if (loaded) added.push(loaded)
    }
    if (added.length === 0) return
    // 后端 compose 只接受一个统一的打开密码：把各源的已知密码传过去；
    // 多个不同密码的源没法一次并入，提前给出明确提示而不是让后端报错。
    const passwords = new Set(
      [current.password, ...added.map((f) => f.password)].filter((p): p is string => Boolean(p))
    )
    if (passwords.size > 1) {
      toast('这些 PDF 使用了不同的打开密码，暂不支持一次并入，请分批操作。', { kind: 'error' })
      return
    }
    const password = passwords.size === 1 ? [...passwords][0] : undefined
    const blobs = [current.blob, ...added.map((f) => f.blob)]
    const pages = [
      ...current.pages.map((pg) => ({ file: 0, pageNumber: pg.pageNumber })),
      ...added.flatMap((f, i) => f.pages.map((pg) => ({ file: i + 1, pageNumber: pg.pageNumber })))
    ]
    const composed = await composePdf(blobs, pages, current.name, password)
    const rebuilt = await rebuildFile(current.fileId, current.name, composed)
    const previous = current
    useEditorStore.getState().replaceFile(rebuilt)
    toast(`已并入 ${rebuilt.pageCount - previous.pageCount} 页到 ${rebuilt.name}`, {
      kind: 'success',
      action: { label: '撤销并入', onClick: () => useEditorStore.getState().replaceFile(previous) }
    })
  } catch (err) {
    toast(errorText(err), { kind: 'error' })
  } finally {
    useEditorStore.getState().setBusy('')
  }
  toastIgnored(ignored)
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

/* ---------------- stamps (server library) ---------------- */

export async function uploadStamps(files: File[]) {
  useEditorStore.getState().setBusy(files.length > 1 ? `正在导入 ${files.length} 个印章…` : '正在导入印章…')
  const uploaded: StampAsset[] = []
  const whitened: Array<{ asset: StampAsset; original: File }> = []
  try {
    for (const file of files) {
      try {
        const prepared = await prepareStamp(file)
        const asset = await upload<StampAsset>('/api/stamps', prepared.blob, prepared.name, { stampId: generateStampId() })
        uploaded.push(asset)
        if (prepared.whitened) whitened.push({ asset, original: file })
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          requireReauth()
          return
        }
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

/**
 * 用新图片字节替换一个已有印章（AI 抠图「替换原印章」等场景）。
 * 顺序必须是：先上传新章 → swapStamp 原位切换引用（已放置的章与骑缝配置保留）→
 * 再删旧章。先删后传会让 removeStamp 级联清掉页面上所有引用，且上传失败时印章直接丢失。
 */
export async function replaceStampImage(stamp: StampAsset, blob: Blob, name: string): Promise<boolean> {
  useEditorStore.getState().setBusy('正在替换印章…')
  try {
    const fresh = await upload<StampAsset>('/api/stamps', blob, name, { stampId: generateStampId() })
    useEditorStore.getState().upsertStamps([fresh])
    useEditorStore.getState().swapStamp(stamp.stampId, fresh.stampId)
    try {
      await deleteJSON(`/api/stamps/${stamp.stampId}`)
    } catch {
      toast('旧印章清理失败，可稍后在印章架手动删除。', { kind: 'error' })
    }
    return true
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) requireReauth()
    else toast(errorText(err), { kind: 'error' })
    return false
  } finally {
    useEditorStore.getState().setBusy('')
  }
}

async function revertWhiten(items: Array<{ asset: StampAsset; original: File }>) {
  for (const { asset, original } of items) {
    try {
      const prepared = await prepareStamp(original, { whiten: false })
      const fresh = await upload<StampAsset>('/api/stamps', prepared.blob, prepared.name, { stampId: generateStampId() })
      useEditorStore.getState().upsertStamps([fresh])
      useEditorStore.getState().swapStamp(asset.stampId, fresh.stampId)
      await deleteJSON(`/api/stamps/${asset.stampId}`)
    } catch (err) {
      toast(`恢复 ${original.name} 失败：${errorText(err)}`, { kind: 'error' })
      return
    }
  }
  toast('已恢复为原图', { kind: 'success' })
}

export function deleteFileAction(file: PDFFile) {
  useEditorStore.getState().removeFile(file.fileId)
  toast(`已移除 ${file.name}`)
}

export async function deleteStampAction(stamp: StampAsset) {
  try {
    await deleteJSON(`/api/stamps/${stamp.stampId}`)
    useEditorStore.getState().removeStamp(stamp.stampId)
    toast(`已删除印章 ${stamp.name}`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) requireReauth()
    else toast(errorText(err), { kind: 'error' })
  }
}

export async function deleteStampsAction(stamps: StampAsset[]) {
  const unique = Array.from(new Map(stamps.map((stamp) => [stamp.stampId, stamp])).values())
  if (unique.length === 0) return
  useEditorStore.getState().setBusy(unique.length > 1 ? `正在删除 ${unique.length} 个印章…` : '正在删除印章…')
  const deleted: string[] = []
  const failed: string[] = []
  try {
    for (const stamp of unique) {
      try {
        await deleteJSON(`/api/stamps/${stamp.stampId}`)
        deleted.push(stamp.stampId)
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          requireReauth()
          return
        }
        failed.push(stamp.name)
      }
    }
  } finally {
    useEditorStore.getState().setBusy('')
  }
  if (deleted.length > 0) {
    const deletedSet = new Set(deleted)
    const deletedStamps = unique.filter((stamp) => deletedSet.has(stamp.stampId))
    useEditorStore.getState().removeStamps(deleted)
    toast(deleted.length > 1 ? `已删除 ${deleted.length} 个印章` : `已删除印章 ${deletedStamps[0]?.name ?? ''}`, { kind: 'success' })
  }
  if (failed.length > 0) toast(`${failed.join('、')} 删除失败`, { kind: 'error' })
}

/** 把当前文件的盖章配置复制到其余所有文件（按页码对应，超出页数的跳过）。 */
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
      seam: { ...source.seam },
      // 扫描效果也算配置（hasConfig 把 scanEnabled 计入），一并复制，
      // 否则「只开了扫描」的配置应用到全部后什么都没带过去。
      scanEnabled: source.scanEnabled,
      scanConfig: source.scanConfig ? { ...source.scanConfig } : undefined
    })
    applied++
  }
  if (applied === 0) {
    toast('队列中没有其他文件。', { kind: 'error' })
    return
  }
  toast(`已把当前配置应用到另外 ${applied} 个文件 · 生成全部即可批量出件`, { kind: 'success' })
}
