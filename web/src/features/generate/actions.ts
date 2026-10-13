import { downloadBlob } from '../../lib/download'
import { normalizePageExpr, parsePageExpression } from '../../lib/pages'
import { DEFAULT_SCAN, type PDFFile, type ScanConfig } from '../../lib/types'
// 仅类型引用：编译期擦除，不会把懒加载分包拉进静态依赖图（拆包约定见 workspace/boot.ts）。
import type { PlacementParam, SeamSealParam } from './localEngine'
import { activeFile, configuredFiles, hasConfig, useEditorStore, type EditorState } from '../../state/store'
import { toast } from '../../state/toasts'
import { beginOperation } from '../../state/operations'
import { readStampAssets } from '../library/storage'
import { runBrowserJob } from './browserWorker'
import { assertWithinLocalLimit, localProcessingError } from './localSafety'
import { safePdfBasename, uniqueZipName } from './outputNames'

export function generationStatus(state: EditorState, file = activeFile(state)): { ok: boolean; hint: string } {
  if (!file) return { ok: false, hint: '请先导入 PDF' }
  const config = state.configs[file.fileId]
  const hasPlacements = (config?.placements.length ?? 0) > 0
  const seamOn = Boolean(config?.seamEnabled)
  const scanOn = Boolean(config?.scanEnabled)
  // 没有任何印章：直接导出 / 拼接当前 PDF（仍可改名、加密、加扫描效果）。
  if (!hasPlacements && !seamOn) {
    return { ok: true, hint: scanOn ? '导出扫描效果 PDF，原文件不受影响' : '导出 PDF（未盖章），原文件不受影响' }
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
  if (!hasConfig(state.configs[file.fileId])) return safePdfBasename(file.name)
  const template = state.outputNameTemplate.trim() || '{原名}-已盖章'
  return safePdfBasename(template.replaceAll('{原名}', base))
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
    outputName: outputNameFor(state, file)
  }
}

/**
 * 唯一出件入口：文件、印章、扫描与密码处理全部留在浏览器。
 * 超出本地限额或处理失败时停止并说明原因，绝不上传文件。
 */
type StampAssets = Record<string, { blob: Blob; widthPx: number; heightPx: number }>
type ProcessOptions = {
  state?: EditorState
  assets?: StampAssets
  onProgress?: (label: string) => void
}

export async function processFile(file: PDFFile, busyPrefix = '', options: ProcessOptions = {}): Promise<{ blob: Blob; name: string }> {
  const state = options.state ?? useEditorStore.getState()
  const status = generationStatus(state, file)
  if (!status.ok) throw new Error(status.hint)
  const config = state.configs[file.fileId]
  const scanConfig = config?.scanEnabled ? (config.scanConfig ?? DEFAULT_SCAN) : null
  assertWithinLocalLimit(state, file.blob.size, file.name)
  try {
    return await processLocally(state, file, scanConfig, busyPrefix, options)
  } catch (err) {
    throw localProcessingError(err)
  }
}

/**
 * 本地管线：（可选 qpdf 解锁加密输入）→ localEngine 盖章 →（可选）本地扫描 →
 * （可选 qpdf AES-256 输出加密）。印章字节从本机 IndexedDB 读取，
 * PDF 本体全程不出浏览器。盖章与解锁/加密默认在 Web Worker 里跑（大文件不卡
 * UI），Worker 不可用时降级主线程同逻辑。
 */
async function processLocally(
  state: EditorState,
  file: PDFFile,
  scanConfig: ScanConfig | null,
  busyPrefix: string,
  options: ProcessOptions
): Promise<{ blob: Blob; name: string }> {
  const params = buildParams(state, file)
  const progress = options.onProgress ?? (() => {})
  progress(`${busyPrefix}本地处理中…`)

  const assets = options.assets ?? await readStampAssets([
    ...params.placements.map((p) => p.stampId),
    ...params.seamSeals.map((s) => s.stampId)
  ])

  // 开扫描时先不加密（扫描要读明文产物），扫完再补加密；未开扫描则一趟出加密件。
  const outputPassword = scanConfig ? '' : state.outputPassword
  const stamped = await runStampJob({
    pdf: file.blob,
    params,
    stamps: assets,
    password: file.password ?? '',
    outputPassword,
    outputOwnerPassword: ''
  })
  let blob = new Blob([stamped as BlobPart], { type: 'application/pdf' })

  if (scanConfig) {
    blob = await applyScan(blob, scanConfig, busyPrefix, progress)
    if (state.outputPassword) {
      assertWithinLocalLimit(state, blob.size, '扫描后的 PDF')
      blob = await encryptLocally(blob, state.outputPassword, busyPrefix, progress)
    }
  }
  return { blob, name: params.outputName }
}

/**
 * 本地盖章作业的输入（Worker 与主线程降级路径共用同一形状）。
 * 字节全部以 Blob 传递：结构化克隆对 Blob 是零拷贝引用，且没有 ArrayBuffer
 * transfer 后 detach 的问题 —— Worker 起不来时主线程降级仍能读到完整数据。
 */
export type StampJobInput = {
  pdf: Blob
  params: { placements: PlacementParam[]; seamSeals: SeamSealParam[] }
  stamps: Record<string, { blob: Blob; widthPx: number; heightPx: number }>
  /** 加密输入的打开密码（qpdf 解锁）。 */
  password: string
  /** 非空则产物本地 AES-256 加密（qpdf）。 */
  outputPassword: string
  outputOwnerPassword: string
}

/** 优先把盖章作业交给 Web Worker；Worker 起不来（老浏览器/CSP）降级主线程同逻辑。 */
async function runStampJob(job: StampJobInput): Promise<Uint8Array> {
  const inline = async (input: StampJobInput) => {
    const { runStampJobInline } = await import('./stampJob')
    return runStampJobInline(input)
  }
  // 不支持离屏画布的浏览器仍可在主线程用 DOM Canvas 裁切骑缝章。
  if (job.params.seamSeals.length > 0 && typeof OffscreenCanvas === 'undefined') return inline(job)
  return runBrowserJob(
    () => new Worker(new URL('./stampWorker.ts', import.meta.url), { type: 'module' }),
    job,
    inline
  )
}

/** 本地 AES-256 加密（qpdf-wasm 懒加载）。 */
async function encryptLocally(blob: Blob, outputPassword: string, busyPrefix: string, progress: (label: string) => void): Promise<Blob> {
  progress(`${busyPrefix}正在加密…`)
  const bytes = await runStampJob({
    pdf: blob,
    params: { placements: [], seamSeals: [] },
    stamps: {},
    password: '',
    outputPassword,
    outputOwnerPassword: ''
  })
  return new Blob([bytes as BlobPart], { type: 'application/pdf' })
}

/**
 * 游离 PDF（不在工作区、页码已重映射）的本地盖章/加密，供单页导出复用。
 */
export async function processDetachedPdf(
  blob: Blob,
  placements: PlacementParam[],
  outputPassword: string,
  outputName: string,
  options: ProcessOptions = {}
): Promise<Blob> {
  const state = options.state ?? useEditorStore.getState()
  const placementSnapshot = placements.map((placement) => ({ ...placement }))
  assertWithinLocalLimit(state, blob.size, outputName)
  try {
    const assets = options.assets ?? await readStampAssets(placementSnapshot.map((p) => p.stampId))
    const bytes = await runStampJob({
      pdf: blob,
      params: { placements: placementSnapshot, seamSeals: [] },
      stamps: assets,
      password: '',
      outputPassword,
      outputOwnerPassword: ''
    })
    return new Blob([bytes as BlobPart], { type: 'application/pdf' })
  } catch (err) {
    throw localProcessingError(err)
  }
}

async function applyScan(blob: Blob, scanConfig: ScanConfig, busyPrefix: string, progress: (label: string) => void): Promise<Blob> {
  // 动态加载：pdfjs 与 pdf-lib 都很重，严禁静态引入（否则会进入口包，拆包约定见 boot.ts）。
  const { processPDFWithScan } = await import('../scan/processor')
  return processPDFWithScan(blob, scanConfig, {
    onProgress: (current, total) => progress(`${busyPrefix}扫描处理 ${current}/${total} 页…`)
  })
}

export async function generateCurrent() {
  const state = useEditorStore.getState()
  const status = generationStatus(state)
  const file = activeFile(state)
  if (!status.ok || !file) {
    toast(status.hint, { kind: 'error' })
    return
  }
  const operation = beginOperation('正在生成…')
  if (!operation) return
  try {
    // 前缀保证内部各阶段（本地盖章/扫描/加密）的 busy 文案都以「正在生成」开头，
    // TopBar 以此前缀判定生成中状态。
    const output = await processFile(file, '正在生成：', { state, onProgress: operation.setBusy })
    downloadBlob(output.blob, output.name)
    toast('已生成，开始下载', { kind: 'success' })
  } catch (err) {
    toast(localProcessingError(err).message, { kind: 'error' })
  } finally {
    operation.end()
  }
}

function zipFileName(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `盖章文件-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`
}

/** 批量：逐个文件在本机处理；多个成品打包为 ZIP 单次下载。 */
export async function generateAll() {
  const state = useEditorStore.getState()
  const files = configuredFiles(state)
  if (files.length === 0) {
    toast('还没有任何文件配置了印章。', { kind: 'error' })
    return
  }
  const outputs: Array<{ blob: Blob; name: string }> = []
  const operation = beginOperation('正在准备批量生成…')
  if (!operation) return
  let failed = 0
  try {
    // All documents use one configuration/password and one atomic image snapshot.
    const stampIds = files.flatMap((file) => {
      const params = buildParams(state, file)
      return [...params.placements.map((p) => p.stampId), ...params.seamSeals.map((s) => s.stampId)]
    })
    const assets = await readStampAssets(stampIds)
    let outputBytes = 0
    for (const file of files) {
      const prefix = `正在生成 ${outputs.length + failed + 1}/${files.length}：`
      operation.setBusy(`${prefix}处理中…`)
      try {
        const output = await processFile(file, prefix, { state, assets, onProgress: operation.setBusy })
        assertWithinLocalLimit(state, outputBytes + output.blob.size, '批量输出总大小')
        outputBytes += output.blob.size
        outputs.push(output)
      } catch (err) {
        failed++
        toast(`${file.name}：${localProcessingError(err).message}`, { kind: 'error' })
      }
    }
    if (outputs.length === 0) return
    if (outputs.length === 1) {
      downloadBlob(outputs[0].blob, outputs[0].name)
    } else {
      operation.setBusy('正在打包 ZIP…')
      // 动态加载：jszip 只在批量出件时用到，不进入口包。
      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      const used = new Set<string>()
      for (const output of outputs) {
        zip.file(uniqueZipName(output.name, used), output.blob)
      }
      // PDF 本身已压缩，STORE 打包速度快且体积几乎不变。
      const bundle = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
      downloadBlob(bundle, zipFileName())
    }
  } catch (err) {
    toast(localProcessingError(err).message, { kind: 'error' })
    return
  } finally {
    operation.end()
  }
  if (failed === 0) {
    toast(outputs.length > 1 ? `已生成 ${outputs.length} 个文件，打包为 ZIP 下载` : '已生成，开始下载', { kind: 'success' })
  } else if (outputs.length > 0) {
    toast(`已生成 ${outputs.length} 个，失败 ${failed} 个`, { kind: 'error' })
  }
}
